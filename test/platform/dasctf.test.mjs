import test from "node:test";
import assert from "node:assert/strict";
import {
	DASCTF_DEFAULT_BASE,
	normalizeDasctfBase,
	fillPathTemplate,
	unwrapDasctfPayload,
	normalizeChallenge,
	createDasctfClient
} from "../../lib/dasctf.js";

test("dasctf: base 规范化与路径模板", () => {
	assert.equal(normalizeDasctfBase(""), DASCTF_DEFAULT_BASE);
	assert.equal(normalizeDasctfBase("https://x/api/open/v1/user/"), "https://x/api/open/v1/user");
	assert.equal(fillPathTemplate("/agent/me/{platform}", { platform: "dasctf" }), "/agent/me/dasctf");
	assert.equal(fillPathTemplate("/agent/challenge/{platform}/{id}", { platform: "d", id: "a b" }), "/agent/challenge/d/a%20b");
	assert.equal(fillPathTemplate("/agent/{platform}/x", {}), "/agent/x");
});

test("dasctf: 响应解包兼容 success/data 与裸对象", () => {
	assert.deepEqual(unwrapDasctfPayload({ success: true, data: { id: 1 } }), { ok: true, data: { id: 1 } });
	assert.equal(unwrapDasctfPayload({ success: false, error: { message: "bad" } }).ok, false);
	assert.deepEqual(unwrapDasctfPayload([{ id: 1 }]), { ok: true, data: [{ id: 1 }] });
	assert.deepEqual(unwrapDasctfPayload({ name: "u" }), { ok: true, data: { name: "u" } });
});

test("dasctf: normalizeChallenge 多字段别名", () => {
	const ch = normalizeChallenge({ challenge_id: "c1", title: "T", type: "web", score: 100, description: "d", attachments: ["https://x/a.zip"] });
	assert.equal(ch.id, "c1");
	assert.equal(ch.name, "T");
	assert.equal(ch.category, "web");
	assert.equal(ch.value, 100);
	assert.equal(ch.files[0].url, "https://x/a.zip");
});

function fakeFetch(routes) {
	const calls = [];
	const impl = async (url, init = {}) => {
		calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body });
		const key = Object.keys(routes).find((pattern) => url.includes(pattern));
		if (!key) return { status: 404, text: async () => JSON.stringify({ success: false, error: { message: "not found" } }) };
		const result = routes[key](url, init);
		return { status: result.status || 200, text: async () => JSON.stringify(result.payload ?? {}) };
	};
	impl.calls = calls;
	return impl;
}

test("dasctf: me/list 走 Bearer + 默认路径", async () => {
	const fetchImpl = fakeFetch({
		"/agent/me/dasctf": () => ({ payload: { success: true, data: { id: 7, name: "alice" } } }),
		"/agent/challenges/dasctf": () => ({ payload: { success: true, data: { list: [{ id: 1, name: "Easy Web", category: "web", value: 100 }] } } })
	});
	const client = createDasctfClient({ token: "tok", platform: "dasctf", fetchImpl });
	const me = await client.me();
	assert.equal(me.ok, true);
	assert.equal(me.data.name, "alice");
	assert.match(fetchImpl.calls[0].url, /\/agent\/me\/dasctf$/);
	assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer tok");
	const list = await client.listChallenges();
	assert.equal(list.ok, true);
	assert.equal(list.data.length, 1);
	assert.equal(list.data[0].name, "Easy Web");
});

test("dasctf: 无 token 直接报错不请求", async () => {
	const fetchImpl = fakeFetch({});
	const client = createDasctfClient({ token: "", fetchImpl });
	const res = await client.me();
	assert.equal(res.ok, false);
	assert.match(res.error, /CTF2_AGENT_TOKEN/);
	assert.equal(fetchImpl.calls.length, 0);
});

test("dasctf: 401 给出鉴权错误、404 回退候选路径", async () => {
	const fetchImpl = fakeFetch({
		"/agent/me": () => ({ status: 401, payload: { success: false } }),
		"/agent/challenge/list/dasctf": () => ({ payload: { success: true, data: [{ id: 3, name: "C3" }] } })
	});
	const client = createDasctfClient({ token: "tok", platform: "dasctf", fetchImpl });
	const me = await client.me();
	assert.equal(me.ok, false);
	assert.match(me.error, /鉴权失败/);
	const list = await client.listChallenges();
	assert.equal(list.ok, true);
	assert.equal(list.path, "/agent/challenge/list/dasctf");
});

test("dasctf: submit 用 POST 并映射 correct/wrong", async () => {
	const fetchImpl = fakeFetch({
		"/agent/challenge/dasctf/1/submit": (_u, init) => {
			assert.equal(init.method, "POST");
			return { payload: { success: true, data: { status: "correct", message: "ok" } } };
		}
	});
	const client = createDasctfClient({ token: "tok", platform: "dasctf", fetchImpl });
	const res = await client.submit(1, "CTF{x}");
	assert.equal(res.ok, true);
	assert.equal(res.status, "correct");
	assert.equal(res.path, "/agent/challenge/dasctf/1/submit");
});

test("dasctf: discover 汇总试过的路径", async () => {
	const fetchImpl = fakeFetch({
		"/agent/me/dasctf": () => ({ payload: { success: true, data: { id: 1, name: "u" } } }),
		"/agent/challenges/dasctf": () => ({ payload: { success: true, data: [] } })
	});
	const client = createDasctfClient({ token: "tok", platform: "dasctf", fetchImpl });
	const report = await client.discover();
	assert.equal(report.ok, true);
	assert.equal(report.paths.me, "/agent/me/dasctf");
	assert.ok(report.tried.length >= 2);
});
test("dasctf: incorrect status and transport success do not verify a flag", async () => {
	for (const data of [{ status: "incorrect" }, { status: "wrong" }, { correct: false, status: "correct" }, { success: true }]) {
		const fetchImpl = fakeFetch({ "/agent/challenge/dasctf/1/submit": () => ({ payload: { success: true, data } }) });
		const client = createDasctfClient({ token: "fixture", platform: "dasctf", fetchImpl });
		assert.notEqual((await client.submit(1, "CTF{wrong}")).status, "correct", JSON.stringify(data));
	}
});
