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