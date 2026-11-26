import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../drizzle/0000_vault.sql',import.meta.url),'utf8'));
sqlite.exec(readFileSync(new URL('../drizzle/0001_shards.sql',import.meta.url),'utf8'));
const DB = {prepare(sql) {
  const wrap = (values=[]) => ({
    all: async () => ({results:sqlite.prepare(sql).all(...values)}),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    run: async () => ({meta:{changes:sqlite.prepare(sql).run(...values).changes}}),
    bind: (...bindings) => wrap(bindings)
  });
  return wrap();
}};
const authenticated = 'oai-authenticated-user-id';
async function send(path,body,owner='test-owner') {
  const headers={'content-type':'application/json'};
  if (owner) headers[authenticated]=owner;
  const request = new Request('https://noa.example'+path,{method:body === undefined ? 'GET' : 'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return worker.fetch(request,{DB,NOA_REPAIR_OWNER:'test-owner'});
}
const result = await send('/api/diagnostics',{});
const report = await result.json();
console.log(JSON.stringify(report,null,2));
assert.equal(result.status,200);
assert.equal(report.pass,true);
assert.equal((await send('/api/health',undefined,null)).status,401);
assert.equal((await send('/api/admin',{action:'overview'},null)).status,401);
const methods = async (method,params,owner) => (await send('/mcp',{jsonrpc:'2.0',id:1,method,params},owner)).json();
assert.equal((await methods('tools/list')).result.tools.length,20);
assert.equal((await methods('tools/call',{name:'state_read'},null)).error.code,-32001);
const consoleRequest={name:'state_read',arguments:{campaignId:'demo',worldlineId:'wl-main'}};
assert.equal((await send('/api/tools',consoleRequest,null)).status,401);
const consoleResponse=await send('/api/tools',consoleRequest);
assert.match(consoleResponse.headers.get('content-type'),/application\/json/);
assert.equal((await consoleResponse.json()).data.revision,7);
const consoleError=await (await send('/api/tools',{name:'unknown'})).json();
assert.equal(consoleError.code,'unknown_tool');
const before = await (await send('/api/admin',{action:'overview'})).json();
const fork = await send('/api/admin',{action:'fork',to:'wl-testing',expectedVersion:before.version});
assert.equal(fork.status,200,await fork.text());
const activation=await send('/api/admin',{action:'activate',worldlineId:'wl-testing',expectedVersion:before.version+1});
assert.equal(activation.status,200,await activation.text());
const backup=await (await send('/api/admin',{action:'backup'})).json();
const restore=await send('/api/admin',{action:'restore_backup',...backup,expectedVersion:backup.version});
assert.equal(restore.status,200,await restore.text());
const other = await (await send('/api/admin',{action:'overview'},'second-owner')).json();
assert.equal(other.active.worldlineId,'wl-main');
assert.deepEqual(other.campaigns[0].lines,['wl-main']);
const own = await (await send('/api/admin',{action:'overview'})).json();
assert.equal(own.active.worldlineId,'wl-testing');
assert.equal((await send('/api/admin',{action:'export'})).status,200);
console.log('Access, owner isolation, fork, activation, export, backup and restore passed.');

if (process.env.NOA_FORMAL_TEST_SOURCE) {
  const fixture = JSON.parse(readFileSync(process.env.NOA_FORMAL_TEST_SOURCE,'utf8'));
  const secret = crypto.randomUUID();
  const migration = async body => {
    const response = await worker.fetch(new Request('https://noa.example/api/migrate-save-481',{
      method:'POST',headers:{'content-type':'application/json','x-noa-migration-secret':secret},body:JSON.stringify(body)
    }),{DB,NOA_MIGRATION_SECRET:secret,NOA_MIGRATION_OWNER:'formal-test-owner'});
    const result = await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    return result;
  };
  const dry = await migration({...fixture,dryRun:true});
  assert.equal(dry.data.valid,true);
  const listed = await methods('tools/call',{name:'campaign_list'},'formal-test-owner');
  assert.deepEqual(JSON.parse(listed.result.content[0].text).data.campaigns.map(c=>c.id),['demo']);
  const applied = await migration({...fixture,dryRun:false});
  assert.equal(applied.data.receipt.status,'applied');
  const checks = await migration({verify:true});
  console.log('Formal checks:',checks);
  assert.equal(checks.pass,true);
}
