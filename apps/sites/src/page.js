export const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NOA Library · 阿卡夏图书馆</title>
<style>
:root{color-scheme:dark;--bg:#101315;--panel:#181d20;--line:#303a3e;--text:#eff0e8;--muted:#aebcb9;--accent:#dbcf99;--green:#a9d4bc;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.layout{max-width:1440px;margin:auto;display:grid;grid-template-columns:240px 1fr;min-height:100vh}aside{border-right:1px solid var(--line);padding:34px 22px;background:#121719}main{padding:42px clamp(20px,5vw,68px);min-width:0}.brand{font-family:Georgia,serif;font-size:24px;color:var(--accent);margin:0 0 5px;white-space:nowrap}.subtitle,.muted{color:var(--muted)}.subtitle{font-size:14px;margin:0 0 34px}nav{display:grid;gap:6px}button,select,input,textarea{font:inherit;color:inherit;background:#13181b;border:1px solid var(--line);border-radius:7px;padding:9px 12px;min-width:0}button{cursor:pointer;font-size:14px}button:hover,button:focus-visible,nav button[aria-selected=true]{border-color:#857954;color:var(--accent)}button.primary{background:var(--accent);color:#242117;border-color:var(--accent);font-weight:650}nav button{text-align:left;border-color:transparent;background:transparent}h1{margin:0;font-size:32px;font-weight:600;letter-spacing:.015em}h2{font-size:19px;margin:0 0 15px}h3{font-size:15px;margin:0 0 10px}.header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}.card{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:20px;margin-bottom:12px}.grid .card{margin:0}.value{color:var(--green);overflow-wrap:anywhere}.row{display:flex;flex-wrap:wrap;align-items:end;gap:10px;margin:12px 0}label{display:grid;gap:5px;color:var(--muted);font-size:14px}textarea{width:100%;min-height:260px;font-family:ui-monospace,monospace;font-size:14px}pre{padding:14px;background:#111618;border:1px solid var(--line);overflow:auto;max-height:500px;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}p{line-height:1.55}#notice{min-height:26px;margin:0 0 8px;color:var(--accent)}#notice.error{color:#ffabab}.tag{font-size:14px;color:var(--muted);margin-top:24px}.log{padding:8px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}summary{cursor:pointer}
@media(max-width:780px){.layout{display:block}aside{border-right:0;border-bottom:1px solid var(--line);padding:16px}.subtitle{margin-bottom:10px}nav{display:flex;flex-wrap:wrap}main{padding:22px 16px}.grid{grid-template-columns:1fr}.header{align-items:start}}
</style></head>
<body><div class="layout"><aside><p class="brand">NOA Library</p><p class="subtitle">阿卡夏图书馆</p><nav aria-label="管理功能">
<button data-tab="overview" aria-selected="true">当前存档</button><button data-tab="persona" aria-selected="false">开发者模式</button><button data-tab="campaign" aria-selected="false">Campaign 与世界线</button><button data-tab="graph" aria-selected="false">图谱记忆</button><button data-tab="logs" aria-selected="false">执行记录与回执</button><button data-tab="backup" aria-selected="false">导入、备份与恢复</button></nav><p class="tag">仅所有者可访问</p></aside>
<main><div class="header"><h1 id="title">当前存档</h1><button id="refresh">重新加载</button></div><div role="status" id="notice"></div><button id="copy-diagnostic" hidden>复制诊断</button> <a id="sign-in" href="/signin-with-chatgpt?return_to=%2F" target="_top" hidden>重新登录站点</a>
<section id="overview"><div class="grid"><article class="card"><h3>Worker</h3><div class="value" id="worker">检查中</div></article><article class="card"><h3>D1 数据库</h3><div class="value" id="database">检查中</div></article><article class="card"><h3>MCP</h3><div class="value" id="mcp">检查中</div></article></div><article class="card"><h2>当前存档</h2><p id="active" class="muted"></p><p id="revisions"></p></article><div class="grid" id="dashboard">
<article class="card"><h3>人物</h3><p id="dash-actor"></p></article>
<article class="card"><h3>记忆</h3><p id="dash-memory"></p><button data-go="graph">查询记忆</button></article>
<article class="card"><h3>认知图谱</h3><p id="dash-graph"></p><button data-go="graph">浏览关系</button></article>
<article class="card"><h3>科研</h3><p id="dash-research"></p></article>
<article class="card"><h3>时间轴</h3><p id="dash-clock"></p><button data-go="logs">查看事件</button></article>
<article class="card"><h3>存档管理</h3><p>切换 Campaign、世界线或保存快照。</p><button data-go="campaign">管理存档</button></article></div></section>
<section id="persona" hidden><article class="card"><h2>合成 DEMO 验证</h2><p class="muted">在独立的 D1 测试档案中验证读写、冲突、认知权限和回执。测试结束后清理测试档案。</p><button id="diagnostics" class="primary">运行验证</button><div id="checks"></div></article><article class="card"><h2>诺娅人格</h2><label>档案 JSON<textarea id="profile" spellcheck="false"></textarea></label><div class="row"><button class="primary" id="save-profile">保存档案</button></div></article><article class="card"><h2>事务提交</h2><p class="muted">使用存档管理中选中的 Campaign 和世界线。读取最新版本后为本次内容保留事务键，重试沿用原键。</p><label>事务 JSON<textarea id="transaction" spellcheck="false" placeholder='{"statePatch":{"research":{"active_count":1}}}'></textarea></label><button id="commit-transaction">提交事务</button><div id="transaction-result"></div></article></section>
<section id="campaign" hidden><article class="card"><h2>Campaign 与世界线</h2><div class="row"><label>世界<select id="world-id"></select></label><label>Campaign<select id="campaign-id"></select></label><label>世界线<select id="line-id"></select></label><button class="primary" id="activate">设为当前存档</button></div><div class="row"><label>目标世界线<input id="fork-id" placeholder="wl-alternate"></label><button id="fork">从所选世界线分叉</button></div></article><article class="card"><h2>世界线快照</h2><div class="row"><label>快照标签<input id="checkpoint-label" placeholder="分叉前"></label><button id="checkpoint">保存快照</button></div><div class="row"><label>选择快照<select id="checkpoint-id"></select></label><button id="restore-checkpoint">恢复所选快照</button></div></article></section>
<section id="graph" hidden><article class="card"><h2>记忆查询</h2><div class="row"><label>角色视角<input id="viewer" placeholder="自动选择主视角，或输入 gm"></label><label>查询模式<select id="mode"><option value="recall">检索</option><option value="traverse">多跳</option></select></label><label>关键词或起始实体<input id="query" placeholder="person.player"></label><label>跳数<input id="hops" type="number" min="1" max="4" value="2"></label><label><span>包含角色信念</span><input type="checkbox" id="belief"></label><button id="search" class="primary">查询</button></div><div id="graph-result"></div></article></section>
<section id="logs" hidden><article class="card"><h2>执行回执</h2><div id="receipts"></div></article><article class="card"><h2>审计记录</h2><div id="events"></div></article></section>
<section id="backup" hidden><article class="card"><h2>Campaign 存档</h2><p class="muted">导出当前 Campaign。导入支持 noa-bundle v1 JSON，以及逐行存放一个 noa-bundle 的 JSONL。</p><div class="row"><button id="export-json">导出 JSON</button><button id="export-jsonl">导出 JSONL</button></div><div class="row"><label>选择导入文件<input type="file" id="import-file" accept=".json,.jsonl"></label><button id="import">导入 Campaign</button></div></article><article class="card"><h2>全库备份</h2><p class="muted">包括人格、Campaign、世界线、快照、审计和回执。恢复会替换当前档案。</p><button id="backup-download">下载备份</button><div class="row"><label>备份文件<input type="file" id="backup-file" accept=".json"></label><button id="restore-backup">恢复备份</button></div></article></section>
</main></div><script>
const el=id=>document.getElementById(id);
const pretty=value=>JSON.stringify(value,null,2);
let data, lastDiagnostic, pendingTransaction;
async function fetchJson(path,body){
 const headers={accept:'application/json'};
 if(body!==undefined)headers['content-type']='application/json';
 const response=await fetch(path,{headers,credentials:'same-origin',redirect:'manual',
   ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
 const status=response.status;
 if(response.type==='opaqueredirect'||status===401||status===403){
   throw Object.assign(Error(status===403?'站点拒绝访问，请确认使用所有者账号。':'站点会话已失效，请重新登录。'),
     {code:status===403?'access_denied':'sign_in_required',status,path});
 }
 let result;
 try { result=await response.json(); }
 catch { throw Object.assign(Error('后台接口返回了无法解析的响应。'),{code:'invalid_response',status,path}); }
 if(!response.ok)throw Object.assign(Error(result.error||'请求失败'),{code:result.code,status,path});
 return result;
}
const admin=(action,params={})=>fetchJson('/api/admin',{action,...params});
async function tool(name,args={}){
 const reply=await fetchJson('/api/tools',{name,arguments:args});
 if(!reply.ok)throw Object.assign(Error(reply.message),{code:reply.code,details:reply.details,path:'/api/tools'});
 return reply.data;
}
function notice(message,error=false){el('notice').textContent=message;el('notice').className=error?'error':'';}
function showError(error){
 lastDiagnostic={time:new Date().toISOString(),code:error.code||'client_error',status:error.status,path:error.path,message:error.message,scope:data?.active,details:error.details};
 notice(error.message+' · '+lastDiagnostic.code,true);el('copy-diagnostic').hidden=false;el('sign-in').hidden=!['sign_in_required','access_denied'].includes(lastDiagnostic.code);
}
function click(id,fn){el(id).onclick=async()=>{el(id).disabled=true;notice('');try{await fn()}catch(error){showError(error)}finally{el(id).disabled=false}};}
function output(target,value){const pre=document.createElement('pre');pre.textContent=pretty(value);target.replaceChildren(pre);}
function options(id,items,selected){
 el(id).replaceChildren(...items.map(([value,label])=>new Option(label,value,false,value===selected)));
}
function selection(){return {campaignId:el('campaign-id').value,worldlineId:el('line-id').value}}
function checkpoints(){
 const {campaignId,worldlineId}=selection();
 options('checkpoint-id',data.checkpoints.filter(cp=>cp.campaignId===campaignId&&cp.worldlineId===worldlineId).map(cp=>[cp.id,cp.label+' · '+cp.createdAt]));
}
function worlds(){
 const active=data.campaigns.find(c=>c.id===data.active.campaignId);
 options('world-id',[...new Set(data.campaigns.map(c=>c.worldId))].map(world=>[world,world]),active?.worldId);
 campaigns();
}
function campaigns(){
 const entries=data.campaigns.filter(c=>c.worldId===el('world-id').value);
 options('campaign-id',entries.map(c=>[c.id,c.title+' · '+c.id]),data.active.campaignId);lines();
}
function lines(){
 const campaign=data.campaigns.find(item=>item.id===el('campaign-id').value);
 options('line-id',campaign.lines.map(line=>[line,line]),data.active.campaignId===campaign.id?data.active.worldlineId:campaign.lines[0]);checkpoints();
}
function logs(id,items,label){
 const target=el(id);target.replaceChildren();
 if(!items.length){target.textContent='暂无记录';return;}
 for(const row of items){const details=document.createElement('details');details.className='log';const summary=document.createElement('summary');summary.textContent=label(row);const pre=document.createElement('pre');pre.textContent=pretty(row);details.append(summary,pre);target.append(details)}
}
async function load(){
 const [health,overview,state]=await Promise.all([fetchJson('/api/health'),admin('overview'),tool('state_read')]);
 data=overview;
 el('worker').textContent=health.worker==='ready'?'正常':health.worker;
 el('database').textContent=health.database==='ready'?'已连接':health.database;
 el('mcp').textContent=health.tools+' 个工具 · '+health.mcpProtocol;
 el('active').textContent=data.active.campaignId+' / '+data.active.worldlineId;
 el('revisions').textContent='状态 revision '+state.revision+' · 记忆 revision '+state.memoryRevision+' · 档案版本 '+data.version;
 el('profile').value=pretty(data.persona);
 worlds();
 const actor=state.state.actors.xiao_yan??Object.values(state.state.actors)[0];
 const art=actor?.main_art;
 el('dash-actor').textContent=[actor?.name,actor?.realm?.stage,art?.mutations?.at(-1)?.name].filter(Boolean).join(' · ')||'暂无人物';
 el('dash-clock').textContent=state.state.clock.date??(state.state.clock.elapsedMinutes==null?'日期未定':'自 '+state.state.clock.anchor+' 起 '+state.state.clock.elapsedMinutes+' 分钟 · 绝对日期未定');
 const scope=data.active;
 const [boot,graph,research]=await Promise.allSettled([
   tool('session_bootstrap',scope),
   tool('memory_traverse',{...scope,start:actor?.id??Object.keys(state.state.actors)[0],viewer:'gm',hops:2}),
   tool('state_read',{...scope,section:'research'})
 ]);
 el('dash-memory').textContent=boot.value?.memory?.[0]?.title??'暂无近期记忆';
 el('dash-graph').textContent=graph.value?graph.value.nodes.length+' 个节点 · '+graph.value.edges.length+' 条关系':'查看图谱';
 const project=research.value?.section?.projects?.find(row=>row.id==='EVOLUTION');
 el('dash-research').textContent=project?project.name+' · '+(project.session_status??project.status):'暂无科研分片';
 logs('receipts',data.receipts,r=>r.receipt.op+' · '+r.receipt.id+' · '+r.receipt.status);
 logs('events',data.events,r=>(r.op||r.type||'事件')+' · '+(r.at||''));
}
async function update(action,params){await admin(action,{expectedVersion:data.version,...params});await load();notice('已保存至 D1。');}
function download(name,text,type){
 const url=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function file(id){const file=el(id).files[0];if(!file)throw Error('请先选择文件');return {name:file.name,text:await file.text()};}
document.querySelectorAll('nav button').forEach(button=>button.onclick=()=>{
 document.querySelectorAll('nav button').forEach(item=>{item.setAttribute('aria-selected',String(item===button));el(item.dataset.tab).hidden=item!==button});
 el('title').textContent=button.textContent;
});
document.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>document.querySelector('[data-tab="'+button.dataset.go+'"]').click());
el('world-id').onchange=campaigns;
el('campaign-id').onchange=lines;
el('line-id').onchange=checkpoints;
click('refresh',load);
click('copy-diagnostic',async()=>{await navigator.clipboard.writeText(pretty(lastDiagnostic));notice('诊断已复制。')});
click('commit-transaction',async()=>{
 const payload=JSON.parse(el('transaction').value);
 const scope=selection(),fingerprint=JSON.stringify([scope,payload]);
 if (pendingTransaction?.fingerprint!==fingerprint) {
   const state=await tool('state_read',scope),id=crypto.randomUUID();
   pendingTransaction={fingerprint,request:{...payload,...scope,eventId:payload.eventId??id,idempotencyKey:payload.idempotencyKey??id,expectedRevision:payload.expectedRevision??state.revision}};
 }
 try {
   const result=await tool('event_commit',pendingTransaction.request);pendingTransaction=null;
   await load();output(el('transaction-result'),result);notice('事务已归档。');
 } catch(error) {
   if (error.code==='revision_conflict') pendingTransaction=null;
   throw error;
 }
});
click('diagnostics',async()=>{el('checks').textContent='正在验证…';try{const result=await fetchJson('/api/diagnostics',{});el('checks').replaceChildren(...result.checks.map(check=>{const p=document.createElement('p');p.textContent=(check.passed?'通过 · ':'失败 · ')+check.name;return p}));notice(result.pass?'DEMO 验证全部通过。':'部分验证失败。',!result.pass)}catch(e){el('checks').replaceChildren();throw e}});
click('save-profile',()=>update('persona',{persona:JSON.parse(el('profile').value)}));
click('activate',()=>update('activate',selection()));
click('fork',()=>update('fork',{...selection(),to:el('fork-id').value}));
click('checkpoint',async()=>{await tool('save_checkpoint',{...selection(),label:el('checkpoint-label').value||'管理控制台快照',idempotencyKey:crypto.randomUUID()});await load();notice('快照已保存。')});
click('restore-checkpoint',async()=>{if(el('checkpoint-id').value&&confirm('恢复所选快照并替换此世界线的当前状态？'))await update('restore_checkpoint',{...selection(),checkpointId:el('checkpoint-id').value})});
click('search',async()=>{const traverse=el('mode').value==='traverse';const query=el('query').value;const result=await tool(traverse?'memory_traverse':'memory_recall',{...selection(),...(el('viewer').value?{viewer:el('viewer').value}:{}),includeBeliefs:el('belief').checked,...(traverse?{start:query,hops:Number(el('hops').value)}:{query})});logs('graph-result',traverse?result.edges:result.hits,row=>row.title??(row.subject+' · '+row.predicate+' · '+row.object))});
click('export-json',async()=>{const bundle=await admin('export');download(bundle.campaignId+'.json',pretty(bundle),'application/json')});
click('export-jsonl',async()=>{const bundle=await admin('export');download(bundle.campaignId+'.jsonl',JSON.stringify(bundle)+'\\n','application/x-ndjson')});
click('import',async()=>{const input=await file('import-file');const bundles=input.name.endsWith('.jsonl')?input.text.trim().split(/\\r?\\n/).filter(Boolean).map(line=>JSON.parse(line)):[JSON.parse(input.text)];if(bundles.length!==1)throw Error('每次导入一个 Campaign');await update('import',{bundle:bundles[0]})});
click('backup-download',async()=>download('noa-library-backup.json',pretty(await admin('backup')),'application/json'));
click('restore-backup',async()=>{const input=JSON.parse((await file('backup-file')).text);if(confirm('用备份替换当前全库档案？'))await update('restore_backup',{backup:input.backup,hash:input.hash})});
load().catch(showError);
</script></body></html>`;
