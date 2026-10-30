import test from "node:test";
import assert from "node:assert/strict";
import { getPath, normalizeGenericProfile, createGenericPlatformClient } from "../../lib/platform-generic.js";

test("generic: getPath 支持点号与数组下标", () => {
	const obj = { data: { data: [{ id: 1, name: "A" }] }, status: "ok" };
	assert.equal(getPath(obj, "data.data[0].id"), 1);
	assert.equal(getPath(obj, "data.data[0].name"), "A");
	assert.equal(getPath(obj, "status"), "ok");
	assert.equal(getPath(obj, "missing.path"), undefined);
	assert.equal(getPath(obj, ""), obj);
});

test("generic: normalizeGenericProfile 默认值", () => {
	const p = normalizeGenericProfile({ listPath: "/x" });
	assert.equal(p.listPath, "/x");
	assert.equal(p.detailPath, "/api/challenges/{id}");
	assert.equal(p.map.list.dataPath, "data");
	assert.deepEqual(p.map.submit.okStatuses, ["correct", "success", "accepted"]);
});

function fakeFetch(routes) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init });
		const key = Object.keys(routes).find((pattern) => url.includes(pattern));
		if (!key) return { status: 404, json: async () => ({ message: "not found" }) };
		return routes[key](url, init);
	};
	impl.calls = calls;
	return impl;
}

test("generic: listChallenges/getChallenge 字段映射", async () => {
	const fetchImpl = fakeFetch({
		"/api/challenges/2": () => ({ status: 200, json: async () => ({ success: true, data: { id: 2, name: "Crypto 101", category: "crypto", description: "desc", connection_info: "nc 1.2.3.4 1337", files: [{ name: "a.zip", url: "/f/a.zip" }] } }) }),
		"/api/challenges": () => ({ status: 200, json: async () => ({ success: true, data: { data: [{ id: 1, name: "Easy Web", category: "web", value: 100, files: ["/f/x.zip"] }] } } ) })
	});
	const client = createGenericPlatformClient({ baseUrl: "https://p.example.com", token: "tok", profile: { map: { list: { dataPath: "data.data" } } }, fetchImpl });
	const list = await client.listChallenges();
	assert.equal(list.ok, true);
	assert.equal(list.data.length, 1);
	assert.equal(list.data[0].name, "Easy Web");
	assert.equal(list.data[0].files[0].url, "/f/x.zip");
	assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer tok");
	const detail = await client.getChallenge(2);
	assert.equal(detail.ok, true);
	assert.equal(detail.data.description, "desc");
	assert.equal(detail.data.connectionInfo, "nc 1.2.3.4 1337");
	assert.equal(detail.data.files[0].name, "a.zip");
});

test("generic: submit 状态映射（correct/already/失败）", async () => {
	const routes = {
		"/submit-correct": () => ({ status: 200, json: async () => ({ data: { status: "success", message: "ok" } }) }),
		"/submit-already": () => ({ status: 200, json: async () => ({ data: { status: "already_solved" } }) }),
		"/submit-bad": () => ({ status: 200, json: async () => ({ data: { status: "wrong" } }) }),
		"/submit-err": () => ({ status: 500, json: async () => ({ message: "boom" }) })
	};
	const client = (suffix) => createGenericPlatformClient({ baseUrl: "https://x", profile: { submitPath: `/api/challenges/{id}/submit-${suffix}` }, fetchImpl: fakeFetch(routes) });
	assert.equal((await client("correct").submit(1, "CTF{x}")).status, "correct");
	assert.equal((await client("already").submit(1, "CTF{x}")).status, "already_solved");
	assert.equal((await client("bad").submit(1, "CTF{x}")).status, "wrong");
	const err = await client("err").submit(1, "CTF{x}");
	assert.equal(err.ok, false);
	assert.match(err.error, /HTTP 500/);
});

test("generic: 无 fetch / 空 baseUrl / download 不支持", async () => {
	const noFetch = createGenericPlatformClient({ baseUrl: "https://x", fetchImpl: null });
	assert.equal((await noFetch.listChallenges()).ok, false);
	const noBase = createGenericPlatformClient({ baseUrl: "", fetchImpl: fakeFetch({}) });
	assert.equal((await noBase.listChallenges()).ok, false);
	const client = createGenericPlatformClient({ baseUrl: "https://x", fetchImpl: fakeFetch({}) });
	const download = await client.download("https://x/f.zip");
	assert.equal(download.ok, false);
	assert.match(download.error, /不支持自动下载/);
});
test('generic: invalid list mapping reports an error rather than an empty board', async () => {
 const client = createGenericPlatformClient({baseUrl:'https://p.example.com', fetchImpl: fakeFetch({'/api/challenges': () => ({status:200,json:async()=>({data:{items:[]}})})})});
 const result = await client.listChallenges();
 assert.equal(result.ok, false);
 assert.equal(result.code, 'PLATFORM_LIST_INVALID');
});

test('generic: custom solved field is honored in the list', async () => {
 const client = createGenericPlatformClient({baseUrl:'https://p.example.com', profile:{map:{list:{solvedByMe:'progress.solved'}}}, fetchImpl: fakeFetch({'/api/challenges': () => ({status:200,json:async()=>({data:[{id:'a',progress:{solved:true}},{id:'b',progress:{solved:false}}]})})})});
 assert.deepEqual((await client.listChallenges()).data.map(x=>x.solvedByMe), [true,false]);
});

test('generic pagination fetches all pages, deduplicates overlaps and preserves query parameters', async () => {
 const calls=[];
 const client=createGenericPlatformClient({baseUrl:'https://x',profile:{listPath:'/api/challenges?game=7',pagination:{pageSize:2,maxPages:5}},fetchImpl:async url=>{calls.push(url);const page=Number(new URL(url).searchParams.get('page'));return new Response(JSON.stringify({data:page===1?[{id:'1'},{id:'2'}]:[{id:'2'}]}),{status:200});}});
 const result=await client.listChallenges();assert.deepEqual(result.data.map(x=>x.id),['1','2']);assert.equal(calls.length,2);assert.ok(calls.every(url=>new URL(url).searchParams.get('game')==='7'));assert.equal(result.possiblyTruncated,false);
});

test('generic pagination reports repeated pages, partial failure, and malformed continuation', async () => {
 for(const variant of ['repeated','failure','malformed']) {
  let count=0;const client=createGenericPlatformClient({baseUrl:'https://x',profile:{pagination:{pageSize:1,hasMorePath:variant==='malformed'?'more':''}},fetchImpl:async()=>{count++;return new Response(JSON.stringify({data:[{id:'1'}],more:'yes'}),{status:variant==='failure'&&count===2?500:200});}});
  const result=await client.listChallenges();assert.equal(result.ok,false);assert.ok(count<=2);assert.equal(result.data,undefined);
 }
});

test('generic pagination signals truncation at a configured maximum', async () => {
 let count=0;const client=createGenericPlatformClient({baseUrl:'https://x',profile:{pagination:{pageSize:1,maxPages:2}},fetchImpl:async()=>new Response(JSON.stringify({data:[{id:String(++count)}]}),{status:200})});
 const result=await client.listChallenges();assert.equal(result.possiblyTruncated,true);assert.equal(result.data.length,2);assert.equal(count,2);
});

test('generic uses custom auth and body templates without interpolating flag content', async () => {
 let received;
 const client=createGenericPlatformClient({baseUrl:'https://x',token:'fixture-api-key',profile:{auth:{header:'X-API-Key',prefix:''},submitBody:{challenge:'{id}',answer:{value:'{flag}'},mode:'answer'}},fetchImpl:async(url,init)=>{received=init;return new Response(JSON.stringify({data:{status:'correct'}}),{status:200});}});
 assert.equal((await client.submit('uuid-7','flag{a"\\b}')).status,'correct');
 assert.equal(received.headers['X-API-Key'],'fixture-api-key');assert.equal(received.headers.Authorization,undefined);assert.equal(received.redirect,'error');assert.deepEqual(JSON.parse(received.body),{challenge:'uuid-7',answer:{value:'flag{a"\\b}'},mode:'answer'});
});
