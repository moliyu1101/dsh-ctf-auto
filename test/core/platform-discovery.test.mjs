import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformWorkflow } from '../../lib/platform-workflow.js';

test('discovery preserves distinct sources sharing a platform ID and marks them ambiguous', async () => {
 const connection = { sessionKey:'session', cfg:{}, client:{ listChallenges:async()=>({ok:true,data:[{id:'42',groundId:'one',name:'A'},{id:'42',groundId:'two',name:'B'}]}) } };
 const platforms = { current:()=>connection, metadata:(_c,item)=>({kind:'dasctf',baseUrl:'https://ctf.example',challengeId:item.id,groundId:item.groundId}) };
 const service=createPlatformWorkflow({platforms,workspaceForRequest:()=>'/tmp/a',agentOfSession:()=>({}),baseDirOf:()=>'/tmp/a',visibleChallenges:()=>[],importChallenges:async()=>({ok:true,created:[]}),getConfig:()=>({})});
 const result=await service.list({sessionId:'a'});
 assert.equal(result.challenges.length,2);
 assert.ok(result.challenges.every(item=>item.ambiguousId));
 assert.equal(Object.hasOwn(result,'connection'),false);
});

test('snapshot selection preserves source identity when two grounds use the same ID', async () => {
 const connection={sessionKey:'c',client:{listChallenges:async()=>({ok:true,data:[{id:'1',groundId:'g1'},{id:'1',groundId:'g2'}]})}};
 let received;
 const service=createPlatformWorkflow({platforms:{current:()=>connection,metadata:(_c,item)=>({kind:'dasctf',baseUrl:'https://ctf.example',challengeId:item.id,groundId:item.groundId})},workspaceForRequest:()=>'/tmp/a',agentOfSession:()=>({}),baseDirOf:()=>'/tmp/a',visibleChallenges:()=>[],getConfig:()=>({}),importChallenges:async(_p,_e,_c,items)=>{received=items;return {ok:true,created:[]};}});
 const list=await service.list({sessionId:'a'});
 assert.equal((await service.importSelected({sessionId:'a',snapshotId:list.snapshotId,sourceKeys:[list.challenges[1].sourceKey]})).ok,true);
 assert.deepEqual(received.map(c=>c.groundId),['g2']);
});
