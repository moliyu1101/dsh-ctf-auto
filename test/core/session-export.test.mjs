import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { exportWorkspaceSessions } from '../../lib/session-export.js';

function fixture(t, additions = []) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctf-session-export-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const logs=[{header:{id:'main',cwd:workspace},events:[{seq:0,type:'message/user',content:'完整提问'},{seq:1,type:'message/assistant',content:[{type:'tool-call',id:'call',name:'shell',arguments:'{"cmd":"echo hello"}'}]},{seq:2,type:'message/tool',toolCallId:'call',content:'完整工具输出'}]}, {header:{id:'child',parentSession:'main',cwd:path.join(workspace,'.ctf-auto','one')},events:[{seq:0,type:'message/user',content:'child'}]}, {header:{id:'other',cwd:path.join(root,'other')},events:[{seq:0,type:'message/user',content:'private other workspace'}]},...additions];
 let closed=0,flushed=false;
 const persistence={list:async()=>logs.map(row=>({header:row.header})),flush:async()=>{flushed=true;},open:async(id,access)=>{assert.equal(access,'read');assert.ok(flushed);const log=logs.find(row=>row.header.id===id);return {header:log.header,inheritedEventCount:0,read:async()=>({events:log.events}),close:async()=>{closed++;}};}};
 return {root,workspace,logs,persistence,closed:()=>closed,options:{workspace,currentSessionId:'main',persistence,outputDir:path.join(root,'exports')}};
}
function extract(result,root){execFileSync('tar',['-xzf',result.path,'-C',root]);const folder=fs.readdirSync(root).find(name=>name.startsWith('workspace-')&&fs.statSync(path.join(root,name)).isDirectory());return JSON.parse(fs.readFileSync(path.join(root,folder,'manifest.json'),'utf8'));}

test('session export preserves raw messages/tools, historical children, hashes and workspace isolation',async t=>{
 const f=fixture(t);const result=await exportWorkspaceSessions(f.options);const m=extract(result,f.root);
 assert.equal(m.complete,true);assert.deepEqual(m.sessions.map(s=>s.id),['child','main']);assert.equal(f.closed(),2);
 const main=m.sessions.find(s=>s.id==='main');const bytes=fs.readFileSync(path.join(f.root,main.events.path));
 assert.deepEqual(bytes.toString().trim().split('\n').map(JSON.parse),f.logs[0].events);
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),main.events.sha256);assert.ok(!result.archive.includes(Buffer.from('private other workspace')));
 assert.equal(fs.statSync(result.path).mode&0o777,0o600);
});

test('session export packages host-managed image and file bytes without following filesystem paths',async t=>{
 const f=fixture(t);const image=Buffer.from('image-fixture'),file=Buffer.from('file-fixture');const fileId=crypto.createHash('sha256').update(file).digest('hex');
 f.logs[0].events.push({seq:3,type:'message/user',content:[{type:'image',attachment:{attachmentId:'image-id',bytes:image.length,mediaType:'image/png'}},{type:'file',attachment:{attachmentId:fileId,bytes:file.length,name:'../../report.txt'}}]});
 const result=await exportWorkspaceSessions({...f.options,attachments:{readImage:async()=>({data:image}),async *readFileStream(){yield file;}}});const m=extract(result,f.root);
 assert.equal(m.complete,true);assert.equal(m.attachments.length,2);for(const ref of m.attachments)assert.ok(fs.existsSync(path.join(f.root,ref.path)));
 assert.deepEqual(fs.readFileSync(path.join(f.root,m.attachments.find(a=>a.kind==='file').path)),file);
});

test('missing sessions or attachment bytes produce an explicit incomplete manifest',async t=>{
 const f=fixture(t);f.logs[0].events.push({seq:3,type:'message/user',content:[{type:'image',attachment:{attachmentId:'missing-image',bytes:1}}]});
 const result=await exportWorkspaceSessions({...f.options,challenges:[{driverSession:'main',attempts:[{sessionId:'gone'}]}]});const m=extract(result,f.root);
 assert.equal(result.complete,false);assert.ok(m.issues.some(x=>x.id==='gone'));assert.ok(m.issues.some(x=>x.type==='attachment'));assert.equal(m.sessions.length,2);
});

test('failed session reads close handles and do not mark export complete',async t=>{
 const f=fixture(t);const open=f.persistence.open;f.persistence.open=async(id,mode)=>{const handle=await open(id,mode);if(id==='child')handle.read=async()=>{throw Error('corrupt session');};return handle;};
 const result=await exportWorkspaceSessions(f.options);const m=extract(result,f.root);assert.equal(f.closed(),2);assert.equal(m.complete,false);assert.ok(m.issues.some(x=>x.id==='child'));
});

test('export refuses a symlink destination and rejects an authorization change before writing',async t=>{
 const f=fixture(t);const link=path.join(f.root,'linked');fs.symlinkSync(f.workspace,link);
 await assert.rejects(exportWorkspaceSessions({...f.options,outputDir:link}),/符号链接/);
 let count=0;await assert.rejects(exportWorkspaceSessions({...f.options,check:()=>{if(++count>=2)throw Error('scope changed');}}),/scope changed/);
 assert.ok(!fs.existsSync(f.options.outputDir));
});

test('archive has one workspace root and separate challenge folders with shared main-session links',async t=>{
 const f=fixture(t);f.logs.push({header:{id:'child-two',parentSession:'main',cwd:path.join(f.workspace,'.ctf-auto','two')},events:[{seq:0,type:'message/assistant',content:'第二题推理全文'}]});
 const challenges=[{id:'one',title:'第一题 / cipher',dir:path.join(f.workspace,'.ctf-auto','one'),driverSession:'main',statement:'第一题题面',attempts:[{sessionId:'child'}]},{id:'two',title:'第二题',dir:path.join(f.workspace,'.ctf-auto','two'),driverSession:'main',statement:'第二题题面',attempts:[{sessionId:'child-two'}]}];
 const result=await exportWorkspaceSessions({...f.options,challenges});const m=extract(result,f.root);
 assert.equal(m.complete,true);assert.equal(m.challenges.length,2);assert.ok(m.sessions.find(r=>r.id==='main').events.path.startsWith(m.rootFolder+'/_shared/sessions/'));
 for(const question of m.challenges){assert.ok(fs.statSync(path.join(f.root,question.folder)).isDirectory());const index=JSON.parse(fs.readFileSync(path.join(f.root,question.folder,'session-index.json'),'utf8'));assert.ok(index.sessions.some(r=>r.id==='main'));const child=m.sessions.find(r=>r.id===(question.id==='one'?'child':'child-two'));assert.ok(child.events.path.startsWith(question.folder+'/sessions/'));assert.ok(fs.existsSync(path.join(f.root,question.folder,'statement.md')));}
});
