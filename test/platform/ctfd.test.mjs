import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createCtfdClient, normalizeBaseUrl } from "../../lib/ctfd.js";

function withServer(options, fn) {
	return new Promise((resolve, reject) => {
		const mock = startMock(options);
		const maybe = mock && typeof mock.then === "function" ? mock : Promise.resolve(mock);
		maybe.then(async (handle) => {
			try { await fn(handle); resolve(); } catch (e) { reject(e); } finally { try { handle.close(); } catch { /* ignore */ } }
		}).catch(reject);
	});
}

test("hints: 列表归一（content/cost，双层 data 容错）", async () => {
	await withServer({
		handle: ({ pathname, sendJson }) => {
			if (pathname === "/api/v1/challenges/2/hints") {
				sendJson(200, { success: true, data: { data: [
					{ id: 9, challenge_id: 2, content: "看响应头", cost: 0 },
					{ id: 10, challenge_id: 2, content: null, cost: 50 }
				] } });
				return true;
			}
			return false;
		}
	}, async ({ baseUrl }) => {
		const client = createCtfdClient({ baseUrl, token: "t" });
		const res = await client.hints(2);
		assert.equal(res.ok, true);
		assert.equal(res.data.length, 2);
		assert.equal(res.data[0].content, "看响应头");
		assert.equal(res.data[1].content, "");
		assert.equal(res.data[1].cost, 50);
	});
});

test("hints: unlockHint POST /hints/{id}/unlock 返回内容", async () => {
	await withServer({
		handle: ({ pathname, req, sendJson }) => {
			if (pathname === "/api/v1/hints/10/unlock") {
				if (req.method !== "POST") { sendJson(405, { success: false }); return true; }
				sendJson(200, { success: true, data: { content: "试试 /admin", cost: 50 } });
				return true;
			}
			return false;
		}
	}, async ({ baseUrl }) => {
		const client = createCtfdClient({ baseUrl, token: "t" });
		const res = await client.unlockHint(10);
		assert.equal(res.ok, true);
		assert.equal(res.data.content, "试试 /admin");
		assert.equal(res.data.cost, 50);
	});
});

test("retry: 429 后自动重试并成功（backoff 可注入）", async () => {
	let hits = 0;
	await withServer({
		handle: ({ pathname, sendJson }) => {
			if (pathname === "/api/v1/challenges") {
				hits += 1;
				if (hits === 1) { sendJson(429, { success: false, errors: ["rate limited"] }); return true; }
			}
			return false;
		}
	}, async ({ baseUrl }) => {
		const sleeps = [];
		const client = createCtfdClient({ baseUrl, token: "t", maxRetries: 2, retryBaseMs: 10, sleepImpl: async (ms) => { sleeps.push(ms); } });
		const res = await client.listChallenges();
		assert.equal(res.ok, true);
		assert.equal(hits, 2);
		assert.ok(sleeps.length >= 1, "应发生退避等待");
	});
});

test("retry: Retry-After 秒数被尊重", async () => {
	let hits = 0;
	await withServer({
		handle: ({ pathname, res }) => {
			if (pathname === "/api/v1/challenges") {
				hits += 1;
				if (hits === 1) { res.writeHead(429, { "content-type": "application/json", "retry-after": "2" }); res.end(JSON.stringify({ success: false })); return true; }
			}
			return false;
		}
	}, async ({ baseUrl }) => {
		const sleeps = [];
		const client = createCtfdClient({ baseUrl, token: "t", maxRetries: 1, retryBaseMs: 5, sleepImpl: async (ms) => { sleeps.push(ms); } });
		const res = await client.listChallenges();
		assert.equal(res.ok, true);
		assert.ok(sleeps.some((ms) => ms >= 2000), "Retry-After 应覆盖为 ≥2000ms，实际：" + JSON.stringify(sleeps));
	});
});

test("throttle: minIntervalMs 生效于请求间隔", async () => {
	await withServer({}, async ({ baseUrl }) => {
		const sleeps = [];
		const client = createCtfdClient({ baseUrl, token: "t", minIntervalMs: 50, sleepImpl: async (ms) => { sleeps.push(ms); } });
		await client.me();
		await client.me();
		assert.ok(sleeps.length >= 1, "第二次请求应等待最小间隔");
		assert.ok(sleeps[0] >= 1, "等待时长应为正数");
	});
});


// ───────────────────────── mock CTFd ─────────────────────────

const ZIP_BYTES = [0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02];

function startMock(options = {}) {
	const state = { requests: [] };
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const bodyText = Buffer.concat(chunks).toString("utf8");
			const entry = {
				method: req.method,
				url: req.url,
				headers: req.headers,
				body: bodyText,
			};
			state.requests.push(entry);
			const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			const sendJson = (status, payload) => {
				const text = typeof payload === "string" ? payload : JSON.stringify(payload);
				res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				res.end(text);
			};
			if (options.handle && options.handle({ pathname, req, res, entry, sendJson })) return;

			if (pathname === "/api/v1/users/me") {
				if (options.meStatus) return sendJson(options.meStatus, { success: false, errors: ["Unauthorized"] });
				const respond = () =>
					sendJson(200, { success: true, data: { id: 7, name: "alice", website: "https://x" } });
				if (options.meDelayMs) {
					const timer = setTimeout(respond, options.meDelayMs);
					if (typeof timer.unref === "function") timer.unref();
					return;
				}
				return respond();
			}

			if (pathname === "/api/v1/challenges") {
				if (options.challengesStatus) {
					return sendJson(options.challengesStatus, { success: false, errors: ["boom"] });
				}
				if (options.challengesInvalidJson) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end("<html>not json</html>");
					return;
				}
				return sendJson(200, {
					success: true,
					data: [
						{
							id: 1,
							name: "Easy Web",
							category: "web",
							value: 100,
							type: "standard",
							solved_by_me: true,
						},
						{
							id: 2,
							name: "Crypto 101",
							category: "crypto",
							value: 200,
							type: "dynamic",
						},
					],
				});
			}

			const detail = /^\/api\/v1\/challenges\/(\d+)$/.exec(pathname);
			if (detail) {
				const id = Number(detail[1]);
				if (id !== 2) return sendJson(404, { success: false, errors: ["not found"] });
				return sendJson(200, {
					success: true,
					data: {
						id: 2,
						name: "Crypto 101",
						description: "<p>decode me</p>",
						connection_info: "nc 1.2.3.4 9999",
						category: "crypto",
						value: 200,
						type: "dynamic",
						files: [
							{ name: "a.zip", url: "/files/a.zip" },
							{ url: "https://example.com/remote.bin" },
						],
					},
				});
			}

			if (pathname === "/api/v1/challenges/attempt" && req.method === "POST") {
				let payload = {};
				try {
					payload = JSON.parse(bodyText || "{}");
				} catch {
					return sendJson(400, { success: false, errors: ["bad json"] });
				}
				const statusByFlag = {
					"flag{correct}": "correct",
					"flag{wrong}": "incorrect",
					"flag{already}": "already_solved",
					"flag{slow}": "ratelimited",
				};
				const status = statusByFlag[payload.submission] ?? "incorrect";
				return sendJson(200, { success: true, data: { status, message: `mock ${status}` } });
			}

			if (pathname === "/files/a.zip") {
				const bytes = Buffer.from(ZIP_BYTES);
				res.writeHead(200, {
					"content-type": "application/zip",
					"content-length": String(bytes.length),
					"content-disposition": 'attachment; filename="a.zip"',
				});
				res.end(bytes);
				return;
			}

			if (pathname === "/files/big.bin") {
				const bytes = Buffer.alloc(options.bigSize ?? 2048, 0x41);
				res.writeHead(200, { "content-length": String(bytes.length) });
				res.end(bytes);
				return;
			}

			return sendJson(404, { success: false, errors: ["not found"] });
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				server,
				state,
				baseUrl: `http://127.0.0.1:${address.port}`,
				close: () =>
					new Promise((done) => {
						try {
							server.closeAllConnections?.();
						} catch {
							/* ignore */
						}
						server.close(() => done());
					}),
			});
		});
	});
}

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function clientFor(fetchImpl, extra = {}) {
	return createCtfdClient({
		baseUrl: "https://ctf.example.com/",
		token: "secret-token",
		fetchImpl,
		...extra,
	});
}

// ───────────────────────── normalizeBaseUrl ─────────────────────────

test("normalizeBaseUrl: 补协议、去尾斜杠、拒绝非法", () => {
	assert.equal(normalizeBaseUrl("https://ctf.example.com/"), "https://ctf.example.com");
	assert.equal(normalizeBaseUrl("http://1.2.3.4:8080///"), "http://1.2.3.4:8080");
	assert.equal(normalizeBaseUrl("ctf.example.com"), "https://ctf.example.com");
	assert.equal(normalizeBaseUrl("//ctf.example.com/"), "https://ctf.example.com");
	assert.equal(normalizeBaseUrl("  https://ctf.example.com/ctfd/  "), "https://ctf.example.com/ctfd");
	assert.equal(normalizeBaseUrl("http://1.2.3.4:8080/"), "http://1.2.3.4:8080");
	assert.equal(normalizeBaseUrl(""), "");
	assert.equal(normalizeBaseUrl("   "), "");
	assert.equal(normalizeBaseUrl(null), "");
	assert.equal(normalizeBaseUrl(undefined), "");
	assert.equal(normalizeBaseUrl("ftp://ctf.example.com"), "");
});

// ───────────────────────── me / auth ─────────────────────────

test("me: Authorization Token 头 + 用户数据", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "secret-token" });
	const res = await client.me();
	assert.equal(res.ok, true);
	assert.equal(res.data.id, 7);
	assert.equal(res.data.name, "alice");
	const request = mock.state.requests[0];
	assert.equal(request.method, "GET");
	assert.equal(request.url, "/api/v1/users/me");
	assert.equal(request.headers.authorization, "Token secret-token");
});

test("me: 未配置 token 时不带 Authorization", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "" });
	const res = await client.me();
	assert.equal(res.ok, true);
	const request = mock.state.requests[0];
	assert.equal(request.headers.authorization, undefined);
});

// ───────────────────────── listChallenges ─────────────────────────

test("listChallenges: 字段归一，solved_by_me 缺省为 false", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "t" });
	const res = await client.listChallenges();
	assert.equal(res.ok, true);
	assert.equal(res.data.length, 2);
	assert.deepEqual(res.data[0], {
		id: 1,
		name: "Easy Web",
		category: "web",
		value: 100,
		type: "standard",
		solvedByMe: true,
		files: [],
	});
	assert.deepEqual(res.data[1], {
		id: 2,
		name: "Crypto 101",
		category: "crypto",
		value: 200,
		type: "dynamic",
		solvedByMe: false,
		files: [],
	});
});

test("listChallenges: success/data 缺失与双层包裹都容错", async () => {
	const noData = clientFor(async () => jsonResponse({ success: true }));
	const empty = await noData.listChallenges();
	assert.equal(empty.ok, true);
	assert.deepEqual(empty.data, []);

	const doubleWrapped = clientFor(async () =>
		jsonResponse({ success: true, data: { data: [{ id: 9, name: "Nested" }] } }),
	);
	const nested = await doubleWrapped.listChallenges();
	assert.equal(nested.ok, true);
	assert.equal(nested.data.length, 1);
	assert.equal(nested.data[0].id, 9);
	assert.equal(nested.data[0].solvedByMe, false);
});

// ───────────────────────── getChallenge ─────────────────────────

test("getChallenge: 详情归一（connection_info/files/description）", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "t" });
	const res = await client.getChallenge(2);
	assert.equal(res.ok, true);
	const data = res.data;
	assert.equal(data.id, 2);
	assert.equal(data.name, "Crypto 101");
	assert.equal(data.description, "<p>decode me</p>");
	assert.equal(data.connectionInfo, "nc 1.2.3.4 9999");
	assert.equal(data.category, "crypto");
	assert.equal(data.value, 200);
	assert.equal(data.solvedByMe, false);
	assert.deepEqual(data.files, [
		{ name: "a.zip", url: "/files/a.zip" },
		{ name: "remote.bin", url: "https://example.com/remote.bin" },
	]);

	const missing = await client.getChallenge(999);
	assert.equal(missing.ok, false);
	assert.equal(missing.status, 404);
	assert.match(missing.error, /HTTP 404/);
});

// ───────────────────────── submit ─────────────────────────

test("submit: correct / incorrect / already_solved / ratelimited 四种回显", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "t" });

	const cases = [
		["flag{correct}", "correct"],
		["flag{wrong}", "incorrect"],
		["flag{already}", "already_solved"],
		["flag{slow}", "ratelimited"],
	];
	for (const [flag, expected] of cases) {
		const res = await client.submit(2, flag);
		assert.equal(res.ok, true);
		assert.equal(res.data.status, expected);
		assert.equal(res.message, `mock ${expected}`);
	}
	const attemptRequests = mock.state.requests.filter(
		(request) => request.url === "/api/v1/challenges/attempt",
	);
	assert.equal(attemptRequests.length, 4);
	const body = JSON.parse(attemptRequests[0].body);
	assert.deepEqual(body, { challenge_id: 2, submission: "flag{correct}" });
	assert.equal(attemptRequests[0].method, "POST");
	assert.equal(attemptRequests[0].headers["content-type"], "application/json");
});

test("submit: 无 success 包裹的裸 {status,message} 也容错", async () => {
	let callCount = 0;
	const client = clientFor(async () => {
		callCount += 1;
		return jsonResponse({ status: "correct", message: "ok" });
	});
	const res = await client.submit(1, "flag{raw}");
	assert.equal(callCount, 1);
	assert.equal(res.ok, true);
	assert.equal(res.data.status, "correct");
	assert.equal(res.data.message, "ok");
});

test("submit: success=false 按错误返回", async () => {
	const client = clientFor(async () =>
		jsonResponse({ success: false, errors: ["challenge not found"] }),
	);
	const res = await client.submit(1, "flag{x}");
	assert.equal(res.ok, false);
	assert.match(res.error, /challenge not found/);
});

// ───────────────────────── 错误 / 超时 / 非法 JSON ─────────────────────────

test("HTTP 401/500 返回 ok:false + status", async (t) => {
	const mock401 = await startMock({ meStatus: 401 });
	t.after(() => mock401.close());
	const meRes = await createCtfdClient({ baseUrl: mock401.baseUrl, token: "bad" }).me();
	assert.equal(meRes.ok, false);
	assert.equal(meRes.status, 401);
	assert.match(meRes.error, /HTTP 401/);

	const mock500 = await startMock({ challengesStatus: 500 });
	t.after(() => mock500.close());
	const listRes = await createCtfdClient({ baseUrl: mock500.baseUrl, token: "t" }).listChallenges();
	assert.equal(listRes.ok, false);
	assert.equal(listRes.status, 500);
	assert.match(listRes.error, /HTTP 500/);
});

test("非法 JSON 响应容错", async (t) => {
	const mock = await startMock({ challengesInvalidJson: true });
	t.after(() => mock.close());
	const res = await createCtfdClient({ baseUrl: mock.baseUrl, token: "t" }).listChallenges();
	assert.equal(res.ok, false);
	assert.equal(res.status, 200);
	assert.match(res.error, /JSON/);
});

test("请求超时返回 code=timeout", async (t) => {
	const mock = await startMock({ meDelayMs: 400 });
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "t", timeoutMs: 60 });
	const startedAt = Date.now();
	const res = await client.me();
	assert.equal(res.ok, false);
	assert.equal(res.code, "timeout");
	assert.match(res.error, /超时/);
	assert.ok(Date.now() - startedAt < 350, "应在超时后尽快返回");
});

test("网络错误容错（fetch 抛错）", async () => {
	const client = clientFor(async () => {
		throw new Error("ECONNREFUSED");
	});
	const res = await client.me();
	assert.equal(res.ok, false);
	assert.equal(res.code, "network");
	assert.match(res.error, /ECONNREFUSED/);
});

test("平台地址为空时直接报错，不发起请求", async () => {
	let called = 0;
	const client = createCtfdClient({
		baseUrl: "",
		token: "t",
		fetchImpl: async () => {
			called += 1;
			return jsonResponse({});
		},
	});
	const res = await client.me();
	assert.equal(res.ok, false);
	assert.match(res.error, /地址为空/);
	assert.equal(called, 0);
});

// ───────────────────────── download ─────────────────────────

test("download: 相对路径拼接、带 token、字节与文件名", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "secret" });
	const res = await client.download("/files/a.zip");
	assert.equal(res.ok, true);
	assert.deepEqual([...res.bytes], ZIP_BYTES);
	assert.deepEqual([...res.data.bytes], ZIP_BYTES);
	assert.equal(res.filename, "a.zip");
	assert.equal(res.size, ZIP_BYTES.length);
	const fileRequest = mock.state.requests.find((request) => request.url === "/files/a.zip");
	assert.ok(fileRequest);
	assert.equal(fileRequest.headers.authorization, "Token secret");

	const absolute = await client.download(`${mock.baseUrl}/files/a.zip`);
	assert.equal(absolute.ok, true);
	assert.equal(absolute.filename, "a.zip");
});

test("download: maxBytes 上限拒绝", async (t) => {
	const mock = await startMock({ bigSize: 2048 });
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "t" });
	const tooBig = await client.download("/files/big.bin", { maxBytes: 100 });
	assert.equal(tooBig.ok, false);
	assert.equal(tooBig.code, "too-large");
	assert.match(tooBig.error, /上限/);

	const okBig = await client.download("/files/big.bin", { maxBytes: 4096 });
	assert.equal(okBig.ok, true);
	assert.equal(okBig.size, 2048);
});

test("download: HTTP 错误返回 status", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());
	const client = createCtfdClient({ baseUrl: mock.baseUrl, token: "t" });
	const res = await client.download("/files/missing.zip");
	assert.equal(res.ok, false);
	assert.equal(res.status, 404);
	assert.match(res.error, /HTTP 404/);
});
