import test from "node:test";
import assert from "node:assert/strict";
import { host } from "../helpers/host.mjs";

const json = (body) => new Response(JSON.stringify(body), { status: 200 });
function genericRemote(url) {
	if (url.endsWith("/api/challenges")) return json({ data: [{ id: "1", name: "Warmup" }] });
	if (url.endsWith("/submit")) return json({ data: { status: "correct", message: "accepted" } });
	return json({ data: { id: "1", name: "Warmup", description: "fixture", solved_by_me: false } });
}
async function importGeneric(h, baseUrl = "https://platform-a.test", sessionId = "a") {
	await h.post("platform.config.set", { kind: "generic", baseUrl, apiToken: "fixture-token", profile: null });
	return h.post("platform.import", { ids: ["1"], start: false, sessionId });
}
async function until(fn) {
	for (let n = 0; n < 100; n++) {
		const result = await fn();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Expected async operation to finish");
}

test("verified flag is submitted automatically, confirmed by platform, and not submitted twice", async (t) => {
	const h = await host(t); h.setRemote(genericRemote);
	const imported = await importGeneric(h);
	assert.equal(imported.created.length, 1);
	const id = imported.created[0].localId;
	const flag = { id, flag: "CTF{regression}", verified: true, method: "local-check", evidence: "checker output: CTF{regression}" };
	assert.equal((await h.post("flag.record", flag)).verified, false);
	await until(async () => {
		const r = await h.post("challenge.get", { id });
		return r.challenge?.platformSubmit?.status === "correct";
	});
	const detail = await h.post("challenge.get", { id });
	assert.equal(detail.challenge.flags[0].method, "platform");
	await h.post("flag.record", flag);
	assert.equal(h.requests.filter((r) => r.url.endsWith("/submit")).length, 1);
});

test("platform imports and pipeline distinguish platforms, workspaces and same-name challenges", async (t) => {
	const h = await host(t); h.setRemote(genericRemote);
	assert.equal((await importGeneric(h)).created.length, 1);
	assert.equal((await importGeneric(h)).skipped.length, 1);
	assert.equal((await importGeneric(h, "https://platform-a.test", "b")).created.length, 1);
	await h.post("platform.config.set", { baseUrl: "https://platform-b.test" });
	const plan = await h.post("pipeline.run", { dryRun: true });
	assert.equal(plan.candidates.length, 1);
	assert.equal((await h.post("platform.import", { ids: ["1"], start: false })).created.length, 1);
});

test("switching platform cannot send current credentials to an old challenge or manage its environment", async (t) => {
	const h = await host(t); h.setRemote(genericRemote);
	const id = (await importGeneric(h)).created[0].localId;
	await h.post("platform.config.set", { baseUrl: "https://platform-b.test", apiToken: "different-fixture-token" });
	const before = h.requests.length;
	for (const endpoint of ["platform.submit", "platform.env"]) {
		const r = await h.post(endpoint, { id, flag: "CTF{x}", action: "start" });
		assert.equal(r.ok, false);
		assert.match(r.error, /平台连接不一致/);
	}
	assert.equal(h.requests.length, before);
});

test("cross-workspace mutations are denied before deleting flags, refreshing files or starting environments", async (t) => {
	const h = await host(t); h.setRemote(genericRemote);
	const id = (await importGeneric(h)).created[0].localId;
	await h.post("flag.record", { id, flag: "CTF{candidate}", verified: false });
	const before = h.requests.length;
	const operations = ["challenge.start", "challenge.stop", "challenge.retry", "flag.record", "platform.submit",
		"workbench.write", "triage.run", "writeup.pack", "flag.review", "target.probe", "platform.env",
		"challenge.removeFlag", "challenge.remove", "writeup.export"];
	for (const [endpoint, payload] of [
		...operations.map((endpoint) => [endpoint, { id, flag: "CTF{candidate}", action: "start" }]),
		["challenge.refresh", { ids: [id], onlyEmpty: false }]
	]) {
		const r = await h.post(endpoint, { ...payload, sessionId: "b" });
		assert.equal(r.ok, false);
		assert.match(r.error, /不属于当前工作区/);
	}
	assert.equal(h.requests.length, before);
	const detail = await h.post("challenge.get", { id });
	assert.equal(detail.challenge.flags.length, 1);
	assert.equal((await h.post("challenge.removeFlag", { id, flag: "CTF{candidate}" })).removed, true);
});

test("DASCTF environment-only token works for importing and submitting", async (t) => {
	const previous = process.env.CTF2_AGENT_TOKEN;
	process.env.CTF2_AGENT_TOKEN = "fixture-environment-token";
	t.after(() => { if (previous === undefined) delete process.env.CTF2_AGENT_TOKEN; else process.env.CTF2_AGENT_TOKEN = previous; });
	const h = await host(t);
	h.setRemote((url, init) => {
		assert.equal(url, "https://ctf2.dasctf.com/api/ai/v1/mcp");
		const body = JSON.parse(init.body);
		const response = (result, status = 200) => new Response(JSON.stringify({ result }), { status, headers: { "mcp-session-id": "fixture-session" } });
		if (body.method === "initialize") return response({});
		if (body.method === "notifications/initialized") return response({}, 202);
		const name = body.params?.name;
		const data = name === "ctf2_agent_next_challenges" ? { items: [{ id: "1", name: "Fixture", practice_ground_id: "g" }] }
			: name === "ctf2_submit_flag" ? { correct: true } : { challenge: { id: "1", name: "Fixture" } };
		return response({ structuredContent: data });
	});
	await h.post("platform.config.set", { kind: "dasctf", baseUrl: "", apiToken: "" });
	const imported = await h.post("platform.import", { ids: ["1"], start: false });
	assert.equal(imported.created.length, 1);
	const result = await h.tools.get("ctf_platform_submit").execute({ id: imported.created[0].localId, flag: "CTF{x}" }, { agent: h.agents[0] });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.verified, true);
});

test("unknown submissions require explicit task confirmation before a deliberate retry", async (t) => {
	const h = await host(t);
	let healthy = false;
	h.setRemote((url) => url.endsWith("/submit") && !healthy ? new Response("unavailable", { status: 503 }) : genericRemote(url));
	const id = (await importGeneric(h)).created[0].localId;
	const flag = { id, flag: "CTF{retry}", verified: true, method: "local-check", evidence: "checker output: CTF{retry}" };
	await h.post("flag.record", flag);
	await until(async () => (await h.post("challenge.get", { id })).challenge?.platformSubmit?.status === "error");
	healthy = true;
	await h.post("flag.record", flag);
	assert.equal(h.requests.filter((r) => r.url.endsWith("/submit")).length, 1, "an unknown remote outcome must not be replayed automatically");
	const tasks = (await h.post("task.list", { id })).tasks;
	const task = tasks.find((task) => task.kind === "submission" && task.phase === "unknown");
	assert.ok(task);
	assert.equal((await h.post("task.resolve", { id, taskId: task.taskId, confirmStopped: true, note: "fixture request has completed; platform recovered" })).ok, true);
	const retried = await h.post("platform.submit", { id, flag: flag.flag, retryUnknown: true });
	assert.equal(retried.status, "correct");
	assert.equal((await h.post("challenge.get", { id })).challenge.lifecycle.submission, "accepted");
	assert.equal(h.requests.filter((r) => r.url.endsWith("/submit")).length, 2);
});

test("pipeline rejects a stale platform connection after an in-flight list request", async (t) => {
	const h = await host(t);
	let release, started;
	const waiting = new Promise((resolve) => { started = resolve; });
	h.setRemote(async (url) => {
		if (url.endsWith('/api/challenges')) { started(); await new Promise((resolve) => { release = resolve; }); }
		return genericRemote(url);
	});
	await h.post('platform.config.set', { kind: 'generic', baseUrl: 'https://platform-a.test', apiToken: 'fixture-token', profile: null });
	const run = h.post('pipeline.run', { dryRun: true });
	await waiting;
	await h.post('platform.config.set', { baseUrl: 'https://platform-b.test' });
	release();
	const result = await run;
	assert.equal(result.code, 'STALE_PLATFORM_CONNECTION');
	assert.equal((await h.post('state.get')).challenges.length, 0);
});

test("pipeline does not fall back to another workspace for an unavailable session", async (t) => {
	const h = await host(t); h.setRemote(genericRemote);
	await h.post('platform.config.set', { kind: 'generic', baseUrl: 'https://platform-a.test', apiToken: 'fixture-token', profile: null });
	const result = await h.post('pipeline.run', { sessionId: 'missing-session' });
	assert.equal(result.code, 'PIPELINE_SESSION_UNAVAILABLE');
	assert.equal(h.requests.length, 0);
});

test("explicit pipeline start uses the requesting session even when automatic starts are disabled", async (t) => {
	const h = await host(t); h.setRemote(genericRemote);
	await h.post('platform.config.set', { kind: 'generic', baseUrl: 'https://platform-a.test', apiToken: 'fixture-token', profile: null });
	assert.equal((await h.post('config.set', { patch: { autoSolveImported: false } })).ok, true);
	const result = await h.post('pipeline.run', { start: true, sessionId: 'a' });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.imported, 1);
	assert.equal(result.started.length, 1);
	const detail = await h.post('challenge.get', { id: result.created[0].localId });
	assert.equal(detail.challenge.driverSession, 'a');
});

test('pipeline applies its batch limit after deduplicating platform identities', async (t) => {
 const h = await host(t);
 h.setRemote((url) => url.endsWith('/api/challenges') ? json({data:[{id:'1',name:'A'},{id:'1',name:'A duplicate'},{id:'2',name:'B'}]}) : genericRemote(url));
 await h.post('platform.config.set', {kind:'generic',baseUrl:'https://platform-a.test',apiToken:'fixture-token',profile:null});
 const result=await h.post('pipeline.run',{dryRun:true,limit:2});
 assert.deepEqual(result.candidates.map(x=>x.id),['1','2']);
});

test('platform discovery annotates imports only in the requesting workspace', async (t) => {
 const h = await host(t); h.setRemote(genericRemote);
 const imported = await importGeneric(h);
 const a = await h.post('platform.challenges', {sessionId:'a'});
 const b = await h.post('platform.challenges', {sessionId:'b'});
 assert.equal(a.challenges[0].local.id, imported.created[0].localId);
 assert.equal(b.challenges[0].local, null);
 assert.equal((await h.post('pipeline.run',{sessionId:'a',dryRun:true})).candidates.length,0);
 assert.equal((await h.post('pipeline.run',{sessionId:'b',dryRun:true})).candidates.length,1);
});

test('platform status does not present an old connection as current after config changes', async (t) => {
 const h=await host(t); let release,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 h.setRemote(async url=>{if(url.endsWith('/api/challenges')){started();await new Promise(resolve=>{release=resolve;});}return genericRemote(url);});
 await h.post('platform.config.set',{kind:'generic',baseUrl:'https://platform-a.test',apiToken:'fixture-token',profile:null});
 const check=h.post('platform.status'); await waiting;
 await h.post('platform.config.set',{baseUrl:'https://platform-b.test'});release();
 assert.equal((await check).code,'STALE_PLATFORM_CONNECTION');
});

test('discovery snapshot imports the selected source without fetching another list and replays safely', async (t) => {
 const h=await host(t);h.setRemote(genericRemote);
 await h.post('platform.config.set',{kind:'generic',baseUrl:'https://platform-a.test',apiToken:'fixture-token',profile:null});
 const list=await h.post('platform.challenges');
 assert.ok(list.snapshotId);
 const payload={snapshotId:list.snapshotId,sourceKeys:[list.challenges[0].sourceKey],start:false};
 const first=await h.post('platform.import',payload);
 assert.equal(first.created.length,1);
 assert.equal(h.requests.filter(r=>r.url.endsWith('/api/challenges')).length,1);
 const repeat=await h.post('platform.import',payload);
 assert.equal(repeat.created.length,0);assert.equal(repeat.skipped.length,1);
 assert.equal((await h.post('state.get')).challenges.length,1);
});

test('discovery selection is bound to its session and platform generation', async (t) => {
 const h=await host(t);h.setRemote(genericRemote);
 await h.post('platform.config.set',{kind:'generic',baseUrl:'https://platform-a.test',apiToken:'fixture-token',profile:null});
 const list=await h.post('platform.challenges');const payload={snapshotId:list.snapshotId,sourceKeys:[list.challenges[0].sourceKey]};
 assert.equal((await h.post('platform.import',{...payload,sessionId:'b'})).code,'DISCOVERY_SCOPE_CHANGED');
 assert.equal((await h.post('platform.import',{...payload,sourceKeys:['tampered']})).code,'SELECTION_INVALID');
 await h.post('platform.config.set',{baseUrl:'https://platform-b.test'});
 assert.equal((await h.post('platform.import',payload)).code,'STALE_PLATFORM_CONNECTION');
 assert.equal((await h.post('platform.import',{...payload,snapshotId:'old-instance'})).code,'DISCOVERY_EXPIRED');
 assert.equal((await h.post('state.get')).challenges.length,0);
});
