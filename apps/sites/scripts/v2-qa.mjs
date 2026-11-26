import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import worker from '../dist/server/index.js';

const tmp=mkdtempSync(join(tmpdir(),'noa-qa-'));
const path=join(tmp,'test.db');
let db=new DatabaseSync(path), interrupt=false;
const sha=value=>createHash('sha256').update(value).digest('hex');
const DB={
  prepare(sql) {
    const bind=(...args)=>({
      bind,first:async()=>db.prepare(sql).get(...args),
      all:async()=>({results:db.prepare(sql).all(...args)}),
      run:()=>({meta:{changes:Number(db.prepare(sql).run(...args).changes)}})
    });
    return bind();
  },
  async batch(list) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [index,statement] of list.entries()) {
        statement.run();
        if (interrupt && index===3) { interrupt=false; throw Error('simulated pre-commit worker loss'); }
      }
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
};
let id=0;
async function call(name,args={},actor='owner') {
  const req=new Request('https://localhost/mcp',{method:'POST',
    headers:{'content-type':'application/json','oai-authenticated-user-id':actor},
    body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})});
  const {result}=await (await worker.fetch(req,{DB,NOA_REPAIR_OWNER:'owner'})).json();
  return JSON.parse(result.content[0].text);
}
const scope={campaignId:'QA-V2',worldlineId:'wl-qa'};
function valid(result) { assert.equal(result.ok,true,JSON.stringify(result).slice(0,600));return result.data; }
const formal={campaignId:'SAVE-481',worldlineId:'wl-main'};
const event=(i,revision)=>({...scope,eventId:'event-'+i,idempotencyKey:'qa-'+i,expectedRevision:revision,statePatch:{resources:{gold:i}}});
try {
  for(const migration of ['0000_vault','0001_shards']) db.exec(readFileSync(new URL('../drizzle/'+migration+'.sql',import.meta.url),'utf8'));
  if(process.argv[2]) {
    const raw=readFileSync(process.argv[2],'utf8');
    db.prepare('INSERT INTO noa_vault VALUES(?,?,?)').run('owner',98,raw);
    const input={expectedVersion:98,expectedHash:sha(raw)};
    console.log('migration dry-run',valid(await call('vault_migrate',input)));
    assert.equal(valid(await call('vault_stats')).schemaVersion,1);
    const migration=valid(await call('vault_migrate',{...input,dryRun:false}));
    console.log('migration physical',migration.physicalShardCount,migration.shardBytes);
    assert.equal(db.prepare('SELECT document FROM noa_vault WHERE owner_id=?').get('owner').document,raw);
    const read=async section=>valid(await call('state_read',{...formal,...(section?{section}:{})}));
    assert.equal((await read('clock')).section.elapsedMinutes,207900);
    assert.equal((await read('research/AE3')).section.status,'completed');
    assert.equal((await read('research/OPHION')).section.id,'OPHION');
    assert.equal((await read('timeline')).section.three_year_promise_remaining_days,245.625);
    assert.equal((await read('economy')).section.industries[0].last_settled_batch,'FENG-012');
    assert.equal((await read('relationships/药尘')).section.realm,'斗尊巅峰');
    assert.equal((await read()).state.rng.cursor,26);
    assert.equal((await read()).state.resources.gold,1062625);
    for(const viewer of ['gm','xiao_yan']) {
      const boot=await call('session_bootstrap',{...formal,viewer,maxChars:1000});
      assert.ok(Buffer.byteLength(JSON.stringify(boot))<=1000);
      assert.equal(valid(boot).state.scene,'中州·星陨阁·待客别院');
      console.log("bootstrap",viewer,Buffer.byteLength(JSON.stringify(boot)),boot.data.memory.length);
      assert.ok(boot.data.memory.length>0);
    }
    for(const query of ['造化归圣','云岚宗插叙']) {
      assert.ok(valid(await call('memory_recall',{...formal,viewer:'gm',query})).hits.length);
    }
    const blocked=await call('memory_recall',{...formal,viewer:'gm',query:'造化归圣'},'other');
    assert.ok(['gm_forbidden','worldline_not_found'].includes(blocked.code));
    const original=JSON.parse(raw);
    for(const {receipt} of Object.values(original.receipts)) {
      if(receipt.campaignId!=='SAVE-481') continue;
      const checked=valid(await call('event_receipt',{...formal,lookup:receipt.id}));
      assert.deepEqual(checked.receipt,receipt);
    }
  }
  valid(await call('qa_create',scope));
  const a=await Promise.all([call('event_commit',event(1,0)),call('event_commit',event(2,0))]);
  assert.equal(a.filter(x=>x.ok).length,1);
  assert.equal(a.find(x=>!x.ok).code,'revision_conflict');
  const winner=a[0].ok?1:2;
  assert.equal(valid(await call('event_commit',event(winner,0))).receipt.duplicate,true);
  const roll={...scope,skill:55,difficulty:65,idempotencyKey:'qa-crash-roll'};
  interrupt=true;
  assert.equal((await call('runtime_execute',roll)).ok,false);
  assert.equal(valid(await call('state_read',scope)).state.rng.cursor,0);
  db.close();
  db=new DatabaseSync(path);
  assert.equal(valid(await call('state_read',scope)).state.rng.cursor,0);
  const applied=valid(await call('runtime_execute',roll));
  assert.equal(valid(await call('runtime_execute',roll)).receipt.hash,applied.receipt.hash);
  assert.equal(valid(await call('state_read',scope)).state.rng.cursor,1);
  const count=Number(process.env.NOA_QA_COMMITS ?? 200);
  let revision=valid(await call('state_read',scope)).revision;
  for(let i=0;i<count;i++) valid(await call('event_commit',event(100+i,revision++)));
  const stats=valid(await call('vault_stats',scope));
  const archive=valid(await call('archive_export',scope));
  const pages=[];
  for(let i=0;i<archive.pages;i++) {
    const page=valid(await call('archive_export',{...scope,cursor:i}));
    const bytes=Buffer.from(page.base64,'base64');
    assert.equal(sha(bytes),page.pageHash);
    pages.push(bytes);
  }
  const data=Buffer.concat(pages);
  assert.equal(sha(data),archive.sha256);
  assert.equal(Object.keys(JSON.parse(data).document.receipts).length,count+2);
  console.log({qaCommits:count,qaRevision:revision,shards:stats.physicalShardCount,bytes:stats.shardBytes,archiveBytes:data.length,passed:true});
} finally {db.close();rmSync(tmp,{recursive:true,force:true});}
