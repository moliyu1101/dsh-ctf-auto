// Browser fixtures only. The shipped UI always requests the real DSH API.
export function createFixture() {
  const now = Date.now();
  const definitions = [
    ['cipher','Serpent cipher','crypto','running'], ['vault','Archive vault','web','running'],
    ['world','另一个世界','misc','queued'], ['secret','泄漏的秘密','web','stuck'],
    ['echo','Echo protocol','pwn','solved'], ['image','Hidden in plain sight','forensics','solved'],
    ['rsa','RSA 的另一面','crypto','stopped'], ['sandbox','Sandbox escape','reverse','failed']
  ];
  const rows = definitions.map(([id,title,category,status],i) => ({id,title,category,status,dir:'/workspace/challenges/'+id,driverSession:'demo',workspace:'/workspace',createdAt:now-(i+1)*900000,startedAt:now-600000,endedAt:status==='solved'?now-120000:0,attempts:status==='stopped'?0:1,flags:status==='solved'?1:0,verified:status==='solved',remainingMs:900000,stuckReason:status==='stuck'?'环境状态待核对，请检查任务回执。':'',lastEvent:{kind:status==='solved'?'flag':'note',at:now-i*60000,text:status==='solved'?'平台已接受提交，开始整理证据。':'已登记实验，正在验证当前假设。'}}));
  const calls=[]; let failed=false, empty=false;
  const config={concurrency:2,timeoutMs:1800000,maxAttempts:3,autoRetry:true,swarmEnabled:true,swarmConcurrency:2,swarmWorkerTimeoutMs:180000,solverPreset:'ctf-auto',wrapupRatio:.85,wrapupGraceMs:60000,pricePerMToken:2,memoryEnabled:true,knowledgeEnabled:true};
  const card={id:'memory-1',title:'从压缩包证据验证路径行为',category:'web',kind:'technique',confidence:.8,tech:['zip-symlink'],summary:'读取归档结构，验证符号链接的实际路径。',steps:['检查目录结构','以隔离文件复验路径'],stepDetails:[{action:'检查归档结构',expected:'得到可复核的路径证据'}],learning:{routes:[],negatives:[]},metrics:{used:3,usedOk:1},verification:{verified:true,method:'platform'}};
  function stats(){const s={total:empty?0:rows.length,queued:0,running:0,solved:0,stuck:0,failed:0,stopped:0};if(!empty)rows.forEach(c=>s[c.status]++);return s;}
  function response(endpoint,p={}) {
    calls.push({endpoint,payload:p});
    if(endpoint==='state.get') return failed?{ok:false,error:'测试：连接已断开'}:{ok:true,stats:stats(),challenges:empty?[]:rows,config,aggregates:{byCategory:[],byStatus:stats()},ledger:[],subagents:{available:true,providers:['fixture']}};
    if(endpoint==='platform.status')return {ok:true,configured:true,reachable:true,kind:'ctfd',user:{name:'CTF Team'}};
    if(endpoint==='platform.config.get')return {ok:true,platform:{kind:'ctfd',baseUrl:'https://ctf.example.test',hasApiToken:true}};
    if(endpoint==='platform.challenges')return {ok:true,challenges:rows.map(c=>({...c,id:c.id,solved:c.status==='solved'}))};
    if(endpoint==='challenge.get') {
      const row=rows.find(c=>c.id===p.id)||rows[0];
      return {ok:true,challenge:{...row,statement:'这是浏览器验证用的题目。\n分析附件并记录可复现的实验，提交前核验证据。',facts:[{kind:'observation',text:'已识别输入格式；等待实验验证。',at:now}],attempts:row.attempts?[{n:1,runId:'run-demo',status:row.status==='running'?'running':'completed',startedAt:now-600000,summary:'已完成初步材料分析。',memories:[{id:card.id,title:card.title,revisionId:'rev-1'}]}]:[],flags:row.flags?[{value:'flag{browser_fixture}',verified:true,method:'platform'}]:[],events:[row.lastEvent],taskJournal:[],submissionJournal:[],environmentJournal:[],swarm:{enabled:true,concurrency:2,occupiedSlots:1,rows:[{workerId:'w1',runId:'run-demo',attempt:1,key:'cipher-map',lane:'offline',status:'running',artifactDir:'artifacts/swarm/demo/worker1'}],queue:[]},experimentBoard:{epoch:'epoch-demo',rows:[{key:'cipher-map',version:1,epoch:'epoch-demo',status:'proposed',hypothesis:'映射替换可否解释所有字符？',scope:'附件内容',expectedSignal:'可读文本',evidence:[],history:[],dependsOn:[]}]},experiments:[],learningFeedback:{ok:true,entries:[]}}};
    }
    if(endpoint==='workbench.tree')return {ok:true,dir:'/workspace/challenges/'+p.id,entries:[{path:'files/input.txt',name:'input.txt',size:128,type:'file'},{path:'notes.md',size:45,type:'file'}]};
    if(endpoint==='workbench.read')return {ok:true,path:p.path,text:'# 分析笔记\n先验证映射，再提交候选。',size:64};
    if(endpoint==='config.get')return {ok:true,config,defaults:config};
    if(endpoint==='config.set'){Object.assign(config,p.patch);return {ok:true,config};}
    if(endpoint==='doctor')return {ok:true,subagents:{available:true,providers:['fixture']},diagnostics:[]};
    if(endpoint==='schedule.summary')return {ok:true,config,queue:{running:rows.filter(c=>c.status==='running'),queued:rows.filter(c=>c.status==='queued').map((c,i)=>({...c,position:i+1,estimatedWaitMs:600000})),waitingForStop:[],concurrency:2,occupiedSlots:2},rate:{buckets:[],attempts30:3,solved30:2},recentSolved:rows.filter(c=>c.status==='solved')};
    if(endpoint==='memory.cards')return {ok:true,cards:[card]};
    if(endpoint==='memory.summary')return {ok:true,facts:[],totals:{challenges:8,solved:2},workspaces:[],memory:{quarantined:[{id:'old',title:'旧版经验卡',reason:'来源笔记已变化，等待核验。'}]}};
    if(endpoint==='kb.stats')return {ok:true,stats:{total:3,imported:2,writeups:1,notes:0},dir:'/workspace/knowledge',usage:{entries:{}}};
    if(endpoint==='kb.list')return {ok:true,files:[{name:'archive.md',bytes:2000,mtime:now}]};
    if(endpoint==='kb.search')return {ok:true,results:[{id:'kb-1',title:'ZIP 符号链接实验记录',score:1.2,source:'imported',sourceLabel:'导入资料',path:'/workspace/knowledge/archive.md',snippet:'使用 zip-symlink 路径验证归档行为，保存实验输出以供复核。',trust:'外部参考资料',citation:{startLine:8,endLine:14,contentHash:'a'.repeat(64),heading:'路径验证'}}]};
    if(endpoint==='kb.read')return {ok:true,name:p.name,text:'# ZIP 实验\n保存输入与输出证据。'};
    if(endpoint==='report.list')return {ok:true,reports:[]};
    if(endpoint==='writeup.list')return {ok:true,writeups:[]};
    if(endpoint==='challenge.stop'||endpoint==='challenge.retry'||endpoint==='challenge.start'){const row=rows.find(c=>c.id===p.id);if(row)row.status=endpoint==='challenge.stop'?'stopped':'queued';return {ok:true};}
    if(endpoint==='challenge.add'){rows.push({id:'new-challenge',title:p.title,category:p.category||'misc',status:'stopped',attempts:0,flags:0,createdAt:now,driverSession:'demo'});return {ok:true,id:'new-challenge'};}
    return {ok:true};
  }
  return {rows,calls,response,setFailed:v=>failed=v,setEmpty:v=>empty=v};
}
