import { openVault, transact } from './vault.js';
import { runTool } from './tools.js';

export async function verifyDemo(db,owner) {
  const fixture = owner + '/verify/' + crypto.randomUUID();
  const run = (name,args={}) => transact(db,fixture,doc=>runTool(doc,name,{campaignId:'demo',worldlineId:'wl-main',...args},owner));
  const checks = [];
  function assert(name,passed) { checks.push({name,passed:Boolean(passed)}); }
  try {
    const boot = await run('session_bootstrap');
    assert('冷启动读取 DEMO 与人格',boot.ok && boot.data.campaignId==='demo' && boot.data.persona?.id);
    const first = await run('state_read');
    const args={expectedRevision:first.data.revision,changes:{extension:{sitesDemoVerified:true}},idempotencyKey:'verify.commit'};
    const results = await Promise.all([run('state_commit',args),run('state_commit',args)]);
    assert('并发重复请求只应用一次',results.every(x=>x.ok) && results.filter(x=>x.data.receipt.duplicate).length===1);
    const persisted = await openVault(db,fixture);
    const next = await run('state_read');
    assert('新请求重新读取持久化状态',next.data.revision===first.data.revision+1 && next.data.state.extension.sitesDemoVerified && Object.keys(persisted.document.receipts).length===1);
    assert('过期 revision 被拒绝',(await run('state_commit',{...args,idempotencyKey:'verify.stale'})).code==='revision_conflict');
    assert('相同键不同内容被拒绝',(await run('state_commit',{...args,changes:{extension:{}}})).code==='idempotency_conflict');
    const record = await run('memory_record',{kind:'episode',idempotencyKey:'verify.memory',data:{title:'SitesVerifySecret',summary:'SitesVerifySecret',knownBy:['person.mira']}});
    const player = await run('memory_recall',{query:'SitesVerifySecret'});
    const mira = await run('memory_recall',{query:'SitesVerifySecret',viewer:'person.mira'});
    assert('认知权限过滤秘密记忆',record.ok && !player.data.hits.some(hit=>hit.id===record.data.id) && mira.data.hits.some(hit=>hit.id===record.data.id));
    const graph = await run('memory_traverse',{start:'person.player',hops:3});
    assert('图谱多跳与世界线隔离',graph.ok && graph.data.nodes.some(n=>n.depth>0) && graph.data.edges.every(edge=>edge.worldlineId==='wl-main'));
    const revise = await run('memory_revise',{kind:'episode',id:record.data.id,expectedRevision:record.data.receipt.memoryRevision,patch:{title:'SitesVerifyRevised'},idempotencyKey:'verify.revise'});
    assert('记忆修正及版本校验',revise.ok && revise.data.item.title==='SitesVerifyRevised');
    const roll = await run('runtime_execute',{skill:2,difficulty:1,idempotencyKey:'verify.roll'});
    const repeated = await run('runtime_execute',{skill:2,difficulty:1,idempotencyKey:'verify.roll'});
    assert('确定性检定及幂等回执',roll.ok && repeated.data.roll.value===roll.data.roll.value && repeated.data.receipt.duplicate);
    const cp = await run('save_checkpoint',{label:'验证',idempotencyKey:'verify.checkpoint'});
    assert('完整快照写入 D1',cp.ok && Object.values((await openVault(db,fixture)).document.checkpoints)[0]?.snapshot.state.rng.cursor===roll.data.roll.cursor+1);
  } catch(error) {
    checks.push({name:error.code ? error.message : '测试中断',passed:false});
    console.error('NOA demo check',error.message);
  } finally {
    await db.prepare('DELETE FROM noa_vault WHERE owner_id=?').bind(fixture).run();
  }
  return {pass:checks.every(check=>check.passed),checks};
}
