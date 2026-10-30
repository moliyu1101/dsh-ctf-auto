import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { host } from '../helpers/host.mjs';

test('export endpoint downloads an archive and excludes other workspace conversations',async t=>{
 let h;
 const persistence={list:async()=>h.agents.map(agent=>({header:{...agent.session.header,id:agent.id}})),flush:async()=>{},open:async id=>({header:{...h.agents.find(a=>a.id===id).session.header,id},inheritedEventCount:0,read:async()=>({events:[{seq:0,type:'message/user',content:id==='a'?'workspace a':'workspace b'}]}),close:async()=>{}})};
 h=await host(t,{}, {sessionPersistence:persistence});
 const res=await h.rawPost('sessions.export.download');
 assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/gzip/);assert.equal(res.headers.get('x-dsh-export-sessions'),'1');assert.equal(res.headers.get('x-dsh-export-complete'),'true');
 const saved=decodeURIComponent(res.headers.get('x-dsh-export-path'));assert.ok(fs.existsSync(saved));assert.deepEqual(Buffer.from(await res.arrayBuffer()),fs.readFileSync(saved));
 const missing=await h.rawPost('sessions.export.download',{sessionId:'missing'});assert.equal(missing.status,400);assert.equal((await missing.json()).ok,false);
});

test('export requires a main session and rejects delegated callers',async t=>{
 const h=await host(t);h.agents[0].session.header.origin='subagent';
 const res=await h.rawPost('sessions.export.download');assert.equal(res.status,400);assert.match((await res.json()).error,/主会话/);
});
