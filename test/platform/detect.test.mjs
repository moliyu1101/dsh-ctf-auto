import test from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, guessChallengeArray } from "../../lib/platform-detect.js";

const json = (payload, status = 200) => ({ status, text: JSON.stringify(payload), json: payload });
const html = (body, status = 200) => ({ status, text: body, json: null });

function fakeFetch(map) {
	const keys = Object.keys(map).sort((a, b) => b.length - a.length);
	const impl = async (url) => {
		const key = keys.find((pattern) => url === pattern) || keys.find((pattern) => url.startsWith(pattern));
		return key ? map[key] : { status: 404, text: "", json: null };
	};
	return impl;
}

test("detect: guessChallengeArray 找 data/data.data/challenges", () => {
	assert.equal(guessChallengeArray({ data: [{ id: 1, name: "a" }] }).dataPath, "data");
	assert.equal(guessChallengeArray({ data: { data: [{ id: 2, title: "b" }] } }).dataPath, "data.data");
	assert.equal(guessChallengeArray({ list: [{ id: 3 }] }).dataPath, "list");
	assert.equal(guessChallengeArray({ no: "array" }), null);
});

test("detect: CTFd 首页指纹直接判定", async () => {
	const result = await detectPlatform({
		baseUrl: "https://ctf.example.com",
		fetchImpl: fakeFetch({ "https://ctf.example.com/": html("<html><title>CTFd</title></html>") })
	});
	assert.equal(result.ok, true);
	assert.equal(result.kind, "ctfd");
	assert.equal(result.confidence, "high");
});

test("detect: CTFd JSON 签名（success/data）", async () => {
	const result = await detectPlatform({
		baseUrl: "https://api.example.com",
		fetchImpl: fakeFetch({
			"https://api.example.com/": html("<html>hello</html>"),
			"https://api.example.com/api/v1/challenges": json({ success: true, data: [{ id: 1, name: "A" }] })
		})
	});
	assert.equal(result.ok, true);
	assert.equal(result.kind, "ctfd");
	assert.ok(result.evidence.some((item) => /CTFd/.test(item.note || "")));
});

test("detect: 通用 JSON 平台推断 profile", async () => {
	const result = await detectPlatform({
		baseUrl: "https://g.example.com",
		fetchImpl: fakeFetch({
			"https://g.example.com/": html("<html>game</html>"),
			"https://g.example.com/api/challenges": json({ data: { list: [{ id: 7, title: "T7", category: "web" }, { id: 8, title: "T8" }] } })
		})
	});
	assert.equal(result.ok, true);
	assert.equal(result.kind, "generic");
	assert.equal(result.profile.listPath, "/api/challenges");
	assert.equal(result.profile.map.list.dataPath, "data.list");
	assert.equal(result.profile.map.list.name, "title");
});

test("detect: 未识别 / 空 baseUrl / 网络错误", async () => {
	const unknown = await detectPlatform({ baseUrl: "https://none.example.com", fetchImpl: fakeFetch({}) });
	assert.equal(unknown.ok, false);
	assert.equal(unknown.kind, "unknown");
	assert.match(unknown.error, /未能识别/);
	const empty = await detectPlatform({ baseUrl: "" });
	assert.equal(empty.ok, false);
	assert.match(empty.error, /baseUrl/);
	const netErr = await detectPlatform({ baseUrl: "https://x", fetchImpl: async () => { throw new Error("boom"); } });
	assert.equal(netErr.ok, false);
	assert.equal(netErr.kind, "unknown");
});