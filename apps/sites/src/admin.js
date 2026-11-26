import { exportBundle, forkWorldline, restore } from './upstream/operations.ts';
import { isObject, newId, sha256 } from './upstream/util.ts';
import { VaultError, VaultRepository, campaignIdValid, worldlineIdValid, own, validateSnapshot, validateCheckpoint, validatePersona, validateVault } from './vault.js';

function require(value,message,status=400) {
  if (!value) throw new VaultError('invalid_request',message,status);
}

export function manage(document,version,input,actor) {
  const repo = new VaultRepository(document);
  const campaign = input.campaignId ?? document.active.campaignId;
  const line = input.worldlineId ?? document.active.worldlineId;
  if (input.action === 'overview') return {value:{
    version,active:document.active,persona:own(document.campaignPersonas ?? {},document.active.campaignId) ?? document.persona,campaigns:repo.listCampaigns().map(manifest=>({
      id:manifest.id,worldId:manifest.worldId,title:manifest.title,status:manifest.status,lines:repo.listWorldlines(manifest.id)
    })),events:document.events.slice(-30).reverse(),receipts:Object.values(document.receipts).slice(-30).reverse(),
    checkpoints:Object.values(document.checkpoints).map(({snapshot,...cp})=>cp)
  }};
  if (input.action === 'backup') return {value:{version,backup:document,hash:sha256(document)}};
  if (input.action === 'export') {
    const bundle = exportBundle(repo,{campaignId:campaign});
    require(bundle.ok,'Campaign 不存在',404);
    return {value:bundle.data};
  }
  require(input.expectedVersion === version,'后台档案已更新，请重新加载后重试',409);
  if (input.action === 'restore_backup') {
    require(input.backup && input.hash === sha256(input.backup),'备份哈希不匹配');
    validateVault(input.backup);
    const previous = document;
    document = input.backup;
    for (const [id,original] of Object.entries(previous.sourceArchives ?? {})) {
      require(!own(document.sourceArchives ?? {},id) || sha256(document.sourceArchives[id])===sha256(original),'备份中的原始导入档案与当前档案冲突',409);
    }
    document.sourceArchives={...document.sourceArchives,...previous.sourceArchives};
    // Preserve receipt deduplication and audit history across recovery.
    document.operations = {...document.operations,...previous.operations};
    document.receipts = {...document.receipts,...previous.receipts};
    document.events = [...new Map([...document.events,...previous.events].map(event=>[event.id ?? sha256(event),event])).values()];
    document.checkpoints = {...document.checkpoints,...Object.fromEntries(
      Object.entries(previous.checkpoints).filter(([,cp])=>own(document.campaigns,cp.campaignId)
        && own(document.campaigns[cp.campaignId].lines,cp.worldlineId))
    )};
    const at = new Date().toISOString();
    for (const [id,entry] of Object.entries(document.campaigns)) {
      for (const [worldline,snapshot] of Object.entries(entry.lines)) {
        const old = own(own(previous.campaigns,id)?.lines ?? {},worldline);
        if (!old) continue;
        snapshot.state.revision = Math.max(snapshot.state.revision,old.state.revision) + 1;
        snapshot.state.updatedAt = at;
        snapshot.working.memoryRevision = Math.max(snapshot.working.memoryRevision ?? 0,old.working.memoryRevision ?? 0) + 1;
      }
    }
  } else if (input.action === 'persona') {
    validatePersona(input.persona);
    const {hash:_,...profile} = input.persona;
    const saved = {...profile,hash:sha256(profile)};
    if (own(document.campaignPersonas ?? {},document.active.campaignId)) document.campaignPersonas[document.active.campaignId]=saved;
    else document.persona=saved;
  } else if (input.action === 'activate') {
    repo.read(campaign,line);
    document.active = {campaignId:campaign,worldlineId:line};
  } else if (input.action === 'fork') {
    require(worldlineIdValid(input.to),'目标世界线 ID 无效');
    const result = forkWorldline(repo,{campaignId:campaign,from:line,to:input.to,idempotencyKey:newId('admin'),actor});
    require(result.ok,result.message);
  } else if (input.action === 'restore_checkpoint') {
    const current = repo.read(campaign,line);
    const result = restore(repo,{campaignId:campaign,worldlineId:line,checkpointId:input.checkpointId,idempotencyKey:newId('admin'),actor});
    require(result.ok,result.message);
    // Keep the hosted revision monotonic so pre-restore writes cannot pass the lock.
    const restored = repo.read(campaign,line);
    restored.state.revision = current.state.revision + 1;
    restored.working.memoryRevision = (current.working.memoryRevision ?? 0) + 1;
    restored.state.updatedAt = new Date().toISOString();
    repo.write(campaign,line,restored);
  } else if (input.action === 'import') {
    const bundle = input.bundle;
    require(isObject(bundle) && bundle.format === 'noa-bundle' && bundle.version === 1
      && campaignIdValid(bundle.campaignId) && isObject(bundle.snapshots) && isObject(bundle.manifest),'需要 noa-bundle v1');
    require(!own(document.campaigns,bundle.campaignId),'已存在同名 Campaign，导入拒绝覆盖',409);
    require(own(bundle.snapshots,bundle.manifest.worldlineId),'导入包缺少默认世界线');
    for (const [worldline,snapshot] of Object.entries(bundle.snapshots)) {
      validateSnapshot(snapshot,bundle.campaignId,worldline);
      require(sha256(snapshot.manifest) === sha256(bundle.manifest),'Campaign manifest 不一致');
    }
    for (const cp of bundle.checkpoints ?? []) {
      validateCheckpoint(cp,bundle.campaignId);
      require(own(bundle.snapshots,cp.worldlineId),'快照归属无效');
      repo.saveCheckpoint(bundle.campaignId,cp);
    }
    document.campaigns[bundle.campaignId] = {manifest:bundle.manifest,lines:bundle.snapshots};
  } else {
    throw new VaultError('unknown_action','未知操作',404);
  }
  document.events.push({id:newId('evt'),at:new Date().toISOString(),actor,op:'admin.'+input.action,
    campaignId:input.bundle?.campaignId ?? campaign,worldlineId:line,previousVaultVersion:version,
    ...(input.action === 'restore_checkpoint' ? {checkpointId:input.checkpointId,appliedRevision:repo.read(campaign,line).state.revision} : {})});
  return {write:true,document,value:{ok:true,version:version+1}};
}
