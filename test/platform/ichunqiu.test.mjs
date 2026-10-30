import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIchunqiuEntry, signIchunqiuRequest, createIchunqiuPreflight } from '../../lib/ichunqiu.js';

test('i春秋入口区分短链接与 k 标识，拒绝其他域名', () => {
 assert.deepEqual(parseIchunqiuEntry('https://match.ichunqiu.com/2026qwb10'),{key:'2026qwb10',isEncrypt:2});
 assert.deepEqual(parseIchunqiuEntry('https://match.ichunqiu.com/index?k=match-key'),{key:'match-key',isEncrypt:1});
 for(const url of ['https://evil.test/2026qwb10','http://match.ichunqiu.com/2026qwb10','https://match.ichunqiu.com/index'])assert.throws(()=>parseIchunqiuEntry(url));
});

test('i春秋签名与独立生成的固定协议向量一致', () => {
 const request=signIchunqiuRequest({url_key:'2026qwb10',is_encrypt:2},{key:'2026qwb10',token:'fixture-token',stamp:1700000000000,nonce:'a'.repeat(32)});
 assert.equal(request.headers.SIGN,'bcb156a66cfd957b4757a3f3869ff9bf0527b49c');
 assert.equal(request.body.token,'fixture-token');assert.equal(request.headers.Authorization,undefined);
 assert.throws(()=>signIchunqiuRequest({token:'override'},{key:'x'}));
});

test('i春秋赛前 code 116 保留为 unavailable，不推断比赛不存在', async () => {
 const calls=[];
 const client=createIchunqiuPreflight({entryUrl:'https://match.ichunqiu.com/2026qwb10',fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({code:116,message:'暂无比赛信息'}));}});
 const result=await client.inspect();assert.equal(result.state,'unavailable');assert.equal(result.code,116);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://apiterminator.ichunqiu.com/match/detail');assert.equal(calls[0].init.redirect,'error');assert.equal(JSON.parse(calls[0].init.body).is_encrypt,2);
});

test('i春秋禁止访问和登录要求是独立状态', async () => {
 for(const [payload,state] of [[{code:0,data:{is_visit:0}},'restricted'],[{code:112,message:'请登录'},'authentication-required'],[{code:0,data:{is_visit:true,title:'Fixture',url_key:'k'}},'metadata-readable'],[{code:0},'invalid-response']]) {
  const client=createIchunqiuPreflight({entryUrl:'https://match.ichunqiu.com/2026qwb10',fetchImpl:async()=>new Response(JSON.stringify(payload))});
  assert.equal((await client.inspect()).state,state);
 }
});

test('i春秋请求错误不泄露凭据且不自动重试', async () => {
 let calls=0;const client=createIchunqiuPreflight({entryUrl:'https://match.ichunqiu.com/2026qwb10',token:'fixture-secret',fetchImpl:async()=>{calls++;throw Error('fixture-secret');}});
 const result=await client.inspect();assert.equal(result.state,'request-error');assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
