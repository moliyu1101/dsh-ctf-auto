import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseTarget, probeTcp, probeHttp, probeTarget } from "../../lib/target.js";

test("target: parseTarget 支持 URL / host:port / 裸 host", () => {
	const url = parseTarget("http://1.2.3.4:8080/login?x=1");
	assert.equal(url.kind, "url");
	assert.equal(url.host, "1.2.3.4");
	assert.equal(url.port, 8080);
	assert.equal(url.path, "/login?x=1");
	const https = parseTarget("https://ctf.example.com");
	assert.equal(https.port, 443);
	const tcp = parseTarget("1.2.3.4:1337");
	assert.equal(tcp.kind, "tcp");
	assert.equal(parseTarget("1.2.3.4:31337").port, 31337);
	assert.equal(parseTarget("example.com").kind, "tcp");
	assert.equal(parseTarget("").kind, "none");
	assert.equal(parseTarget("not a target!").kind, "none");
});

test("target: probeTcp 就绪/错误/超时（注入 connectImpl）", async () => {
	const { EventEmitter } = await import("node:events");
	const ready = await probeTcp("127.0.0.1", 80, {
		connectImpl: () => { const socket = new EventEmitter(); socket.destroy = () => { }; setTimeout(() => socket.emit("connect"), 1); return socket; }
	});
	assert.equal(ready.ok, true);
	assert.equal(ready.state, "ready");
	const fail = await probeTcp("127.0.0.1", 80, {
		connectImpl: () => { const socket = new EventEmitter(); socket.destroy = () => { }; setTimeout(() => socket.emit("error", new Error("refused")), 1); return socket; }
	});
	assert.equal(fail.ok, false);
	assert.equal(fail.state, "unreachable");
	assert.match(fail.error, /refused/);
	const invalid = await probeTcp("", 0, {});
	assert.equal(invalid.state, "invalid");
});

test("target: probeHttp 任意响应即就绪、网络错误不可达、超时", async () => {
	const ok = await probeHttp("http://x/", { fetchImpl: async () => ({ status: 404 }) });
	assert.equal(ok.ok, true);
	assert.equal(ok.state, "ready");
	assert.equal(ok.status, 404);
	const failed = await probeHttp("http://x/", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
	assert.equal(failed.ok, false);
	assert.equal(failed.state, "unreachable");
	const aborted = await probeHttp("http://x/", { fetchImpl: async (_url, init) => { const error = new Error("aborted"); throw error; }, timeoutMs: 300 });
	assert.equal(aborted.state, "unreachable");
	const noFetch = await probeHttp("http://x/", { fetchImpl: null });
	assert.equal(noFetch.state, "unavailable");
});

test("target: probeTarget 分派 + 无效目标", async () => {
	const url = await probeTarget("http://127.0.0.1:8080/", { fetchImpl: async () => ({ status: 200 }) });
	assert.equal(url.ok, true);
	assert.equal(url.target.kind, "url");
	const tcp = await probeTarget("127.0.0.1:1337", {
		connectImpl: () => { const socket = new EventEmitter(); socket.destroy = () => { }; setTimeout(() => socket.emit("connect"), 1); return socket; }
	});
	assert.equal(tcp.ok, true);
	assert.equal(tcp.target.kind, "tcp");
	const none = await probeTarget("", {});
	assert.equal(none.ok, false);
	assert.equal(none.state, "invalid");
});