import './shared-hash.ts';
import { repairSave, verifyRepair } from './repair.js';
import { fail } from '../../../packages/core/shared.ts';
import { page } from './page.js';
import { exportPage } from './export.js';
import { tools, runTool } from './tools.js';
import { transact, VaultError } from './vault.js';
import { manage } from './admin.js';
import { verifyFormal } from './verify-formal.js';
import { verifyDemo } from './diagnostics.js';
import { verifyToolArguments } from './tools.js';
import { transactVault, storageStats, promoteVault, compactVault } from './storage-v2.js';
import { migrateProjections } from './projections-v2.js';
import { isQaId, qaSeed, useQaBusinessRules } from './qa-v2.js';
import { hasV3, documentV3, commitEventV3, eventReceiptV3, recoveryV3, bootstrapV3, checkpointV3, restoreCheckpointV3, runtimeExecuteV3, stateReadV3, memoryRecallV3, memoryTraverseV3, statsV3, personaLoadV3, campaignListV3, memoryLayersV3, archiveExportV3, archiveImportV3, authorityFrozen, memoryRecordV3, memoryReviseV3, memorySummarizeV3, todoStatusV3, runtimeInitV3 } from './storage-v3.js';

const release='2.2.4-storage-reliability';
const withRelease = data => ({release,...data});
const ok = data => ({ok:true,data});

const headers = { 'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'SAMEORIGIN' };
const json = (data,status=200) => Response.json(data,{status,headers});
const rpc = (id,result) => json({jsonrpc:'2.0',id,result});
const rpcError = (id,code,message) => json({jsonrpc:'2.0',id,error:{code,message}});
const toolResult = result => ({content:[{type:'text',text:JSON.stringify(result)}],isError:!result.ok});

async function payload(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new VaultError('invalid_content_type','需要 application/json',415);
  const reader = request.body?.getReader();
  if (!reader) throw new VaultError('invalid_json','缺少 JSON 请求体');
  let bytes = 0, body = '';
  const decoder = new TextDecoder();
  for (;;) {
    const {value,done} = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1_950_000) {
      await reader.cancel();
      throw new VaultError('too_large','请求体超过上限',413);
    }
    body += decoder.decode(value,{stream:true});
  }
  try { return JSON.parse(body + decoder.decode()); }
  catch { throw new VaultError('invalid_json','JSON 无效'); }
}

async function mcp(request,env,owner) {
  let message;
  try { message = await payload(request); }
  catch(error) { return rpcError(null,-32700,error.message); }
  const {id=null,method,params} = message ?? {};
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id,-32600,'无效的 JSON-RPC 请求');
  if (method==='server/discover') return rpc(id,{supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if (method==='initialize') return rpc(id,{protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'noa-library',version:release}});
  if (method==='notifications/initialized') return new Response(null,{status:202,headers});
  if (method==='ping') return rpc(id,{});
  if (method==='tools/list') return rpc(id,{tools});
  if (method!=='tools/call') return rpcError(id,-32601,'未知方法');
  if (!owner) return rpcError(id,-32001,'需要经过 Sites 验证的调用者身份');
  return rpc(id,toolResult(await executeTool(env,owner,params)));
}

async function executeTool(env,owner,params) {
  try {
    const name=params?.name;
    const args=params?.arguments ?? {};
    const invalid=verifyToolArguments(name,args);
    if (invalid) return invalid;
    // Sites authenticates this identity at the owner-only gateway. The configured
    // GM identity additionally ties privileged tools to the canonical owner.
    const allowGM=owner===(env.NOA_REPAIR_OWNER);
    const isQA=isQaId(args.campaignId);
    const vaultOwner=isQA?owner+'/qa/'+args.campaignId:owner;
    if (isQA && (args.worldlineId!==undefined && args.worldlineId!=='wl-qa')) {
      throw new VaultError('invalid_qa_scope','QA 仅支持 wl-qa');
    }
    const section=name==='state_read'?args.section:null;
    const legacyMigration=section?.match(/^storage\.migrate\.(dry-run|apply)\.([0-9]+)\.([a-f0-9]{64})$/);
    const qaCompat=name==='event_commit' && isQA && args.eventId==='qa-initialize'
      && args.expectedRevision===0 && args.idempotencyKey==='qa-initialize'
      && Object.keys(args).length===5;
    if (name==='campaign_import' && await hasV3(env.DB,vaultOwner) && env.NOA_ALLOW_LEGACY_GOVERNANCE!=='1') return fail('v3_governance_not_adapted','campaign_import 尚未完成 V3 权威适配，已默认禁用');
    const v3UnadaptedWrites = new Set(['vault_migrate','qa_create','vault_compact']);
    if (v3UnadaptedWrites.has(name) && await hasV3(env.DB,vaultOwner) && env.NOA_ALLOW_LEGACY_GOVERNANCE!=='1') {
      return fail('v3_governance_not_adapted', `${name} 尚未完成 V3 权威适配，已默认禁用`);
    }
    const privileged=qaCompat || ['vault_stats','vault_compact','vault_migrate','qa_create','archive_export','archive_import','save_restore'].includes(name)
      || section==='storage-stats' || section==='storage-compact-plan' || section==='manifest' || legacyMigration || section?.startsWith('archive_export.');
    if (privileged && !allowGM) throw new VaultError('forbidden','此操作需要所有者权限',403);
    if (name==='vault_migrate' || legacyMigration) {
      if (isQA) throw new VaultError('invalid_qa_scope','请使用 qa_create');
      const request=legacyMigration?{dryRun:legacyMigration[1]==='dry-run',
        expectedVersion:Number(legacyMigration[2]),expectedHash:legacyMigration[3]}:args;
      return ok(withRelease(await promoteVault(env.DB,owner,request,migrateProjections)));
    }
    if (name==='qa_create' || qaCompat) {
      const seed=qaSeed(args.campaignId,args.worldlineId);
      return ok(withRelease(await promoteVault(env.DB,vaultOwner,{dryRun:false},null,seed)));
    }
    if (name==='vault_stats' || section==='storage-stats') {
      const v2=await storageStats(env.DB,vaultOwner);
      const v3=await hasV3(env.DB,vaultOwner)?await statsV3(env.DB,vaultOwner):null;
      return ok(withRelease({...v2,v3}));
    }
    if (name==='vault_compact' || section==='storage-compact-plan') {
      return ok(withRelease(await compactVault(env.DB,vaultOwner,section==='storage-compact-plan' || args.dryRun!==false)));
    }
    // V2.2：常规 event_commit / event_receipt / session_recover / bootstrap 使用增量内核，
    // 不再 inflate/flatten 整个 Vault。
    if (await hasV3(env.DB,vaultOwner)) {
      if (new Set(['event_commit','state_commit','runtime_execute','memory_record','memory_revise','memory_summarize','todo_status','runtime_init']).has(name) && await authorityFrozen(env.DB,vaultOwner)) return fail('authority_frozen','V3 冒烟期业务写入已冻结，禁止新增业务数据');
      if (name==='archive_export') { const result=await archiveExportV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='archive_import') { const result=await archiveImportV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='persona_load') { const result=await personaLoadV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='campaign_list') { const result=await campaignListV3(env.DB,vaultOwner); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='memory_record') { const result=await memoryRecordV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='memory_revise') { const result=await memoryReviseV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='memory_summarize') { const result=await memorySummarizeV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='todo_status') { const result=await todoStatusV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='runtime_init') { const result=await runtimeInitV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='memory_layers') { const result=await memoryLayersV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='state_commit') { const result=await commitEventV3(env.DB,vaultOwner,{...args,eventId:`state-${args.idempotencyKey}`,statePatch:args.changes}); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='state_read') { const result=await stateReadV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='memory_recall') { const result=await memoryRecallV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='memory_traverse') { const result=await memoryTraverseV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='event_commit') { const result=await commitEventV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='event_receipt') { const result=await eventReceiptV3(env.DB,vaultOwner,args.lookup,args.worldlineId); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='session_recover') { const result=await recoveryV3(env.DB,vaultOwner,args.limit,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='session_bootstrap') { const result=await bootstrapV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='runtime_execute') { const result=await runtimeExecuteV3(env.DB,vaultOwner,args); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='save_checkpoint') { const result=await checkpointV3(env.DB,vaultOwner,{id:args.idempotencyKey,parentId:args.parentId,createdAt:args.at,label:args.label,campaignId:args.campaignId,worldlineId:args.worldlineId}); return result.ok?ok(withRelease(result.data)):result; }
      if (name==='save_restore') { const result=await restoreCheckpointV3(env.DB,vaultOwner,args.checkpointId,args); return result.ok?ok(withRelease(result.data)):result; }
    }
    const storage=privileged || isQA?await storageStats(env.DB,vaultOwner):null;
    if (isQA && storage?.schemaVersion!==2) throw new VaultError('qa_not_found','请先使用 qa_create',404);
    const readMode=name==='state_read' && !section?.startsWith('archive_export.')?(section?.split('/')[0]==='pendingHistory'?'pendingHistory':'state')
      : ['memory_recall','memory_traverse','session_bootstrap','persona_load','campaign_list'].includes(name)?'memory':undefined;
    return await transactVault(env.DB,vaultOwner,(doc,version,view)=>{
      if (isQA && name!=='archive_export' && !section?.startsWith('archive_export.')) useQaBusinessRules(doc,args.campaignId);
      return runTool(doc,name,args,owner,
        {allowGM,archiveManifest:view?withRelease({...view.migration,generation:view.epoch,storageVersion:version}):null});
    },readMode);
  } catch(error) {
    if (!(error instanceof VaultError)) console.error('NOA tool execution failed',error.name,error.stack ?? error.message);
    return {ok:false,code:error.code ?? 'service_error',message:error instanceof VaultError ? error.message : '服务端执行失败'};
  }
}

export default {
  async fetch(request,env) {
    const url = new URL(request.url);
    const owner = request.headers.get('oai-authenticated-user-id');
    try {
      if (request.method === 'POST' && request.headers.has('origin') && request.headers.get('origin') !== url.origin) {
        return json({error:'禁止跨站提交'},403);
      }
      if (url.pathname==='/mcp' && request.method==='POST') return await mcp(request,env,owner);
      // Sites' owner-only gateway also authenticates its service-access callers.
      // This path only operates on a disposable synthetic fixture.
      if (url.pathname==='/api/diagnostics' && request.method==='POST') {
        return json(await verifyDemo(env.DB,owner ?? 'sites-service'));
      }
      if (url.pathname==='/api/migrate-save-481' && request.method==='POST') {
        if (!env.NOA_MIGRATION_SECRET || request.headers.get('x-noa-migration-secret')!==env.NOA_MIGRATION_SECRET
          || !env.NOA_MIGRATION_OWNER || (owner && owner!==env.NOA_MIGRATION_OWNER)) return json({error:'禁止访问'},403);
        const migrationOwner=env.NOA_MIGRATION_OWNER;
        const input=await payload(request);
        if (input.verify!==true && await hasV3(env.DB,migrationOwner) && env.NOA_ALLOW_LEGACY_GOVERNANCE!=='1') return json({error:'campaign import 尚未完成 V3 权威适配，已默认禁用',code:'v3_governance_not_adapted'},409);
        if (input.verify===true) return json(await verifyFormal(env.DB,migrationOwner));
        const result=await transact(env.DB,migrationOwner,doc=>runTool(doc,'campaign_import',input,migrationOwner));
        return json(result,result.ok?200:400);
      }
      if (url.pathname==='/api/repair-authority' && request.method==='POST') {
        if (!env.NOA_REPAIR_SECRET || request.headers.get('x-noa-repair-secret')!==env.NOA_REPAIR_SECRET
          || !env.NOA_REPAIR_OWNER || (owner && owner!==env.NOA_REPAIR_OWNER)) return json({error:'禁止访问',code:'forbidden'},403);
        const input=await payload(request);
        if (input.action==='apply' && await hasV3(env.DB,env.NOA_REPAIR_OWNER) && env.NOA_ALLOW_LEGACY_GOVERNANCE!=='1') return json({error:'repair apply 尚未完成 V3 权威适配，已默认禁用',code:'v3_governance_not_adapted'},409);
        if (input.action==='apply') return json(await repairSave(env.DB,env.NOA_REPAIR_OWNER));
        if (input.action==='verify') return json(await verifyRepair(env.DB,env.NOA_REPAIR_OWNER));
        return json({error:'未知操作'},400);
      }
      if (!owner) return json({error:'需要 Sites 登录'},401);
      if (url.pathname==='/' && request.method==='GET') return new Response(page,{headers:{
        ...headers,'content-type':'text/html; charset=utf-8',
        'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self' https://chatgpt.com; base-uri 'none'; form-action 'none'"
      }});
      if (url.pathname==='/api/tools' && request.method==='POST') {
        return json(await executeTool(env,owner,await payload(request)));
      }
      if (url.pathname==='/api/health' && request.method==='GET') {
        const status=await env.DB.prepare('SELECT version FROM noa_vault WHERE owner_id=?').bind(owner).first();
        return json({worker:'ready',database:'ready',mcpProtocol:'2026-07-28',release,tools:tools.length,
          vault:status?'ready':'not_initialized',checkedAt:new Date().toISOString()});
      }
      if (url.pathname==='/api/admin' && request.method==='POST') {
        const input = await payload(request);
        return json(await transactVault(env.DB,owner,(document,version)=>manage(document,version,input ?? {},owner)));
      }
      return json({error:'找不到路径'},404);
    } catch(error) {
      if (!(error instanceof VaultError)) console.error('NOA worker failure',error.name,error.message);
      return json({error:error instanceof VaultError ? error.message : '服务端执行失败',code:error.code ?? 'service_error'},error.status ?? 500);
    }
  }
};
