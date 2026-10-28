// dsh-ctf-auto / lib/target.js —— 靶机/目标就绪探测（起靶机、等就绪、续期检查）。
//
// 只做「目标是否可达」的只读探测：URL → HTTP GET（任意响应即认为监听中）；host:port → TCP 连接。
// 不启动靶机（不同平台启动方式不同），但把探测结果写进 challenge.targetStatus，供面板与子代理参考。

import net from "node:net";

/** 解析题面里的目标：http(s) URL / host:port / host。 */
export function parseTarget(target) {
	const value = String(target == null ? "" : target).trim();
	if (!value) return { kind: "none", raw: "", host: "", port: 0, protocol: "", path: "" };
	if (/^https?:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			if (url.username || url.password || url.port === "0" || /\s/.test(value)) throw new Error("invalid URL");
			return { kind: "url", raw: value, protocol: url.protocol.slice(0, -1), host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search };
		} catch { return { kind: "none", raw: value, host: "", port: 0, protocol: "", path: "" }; }
	}
	const hostPort = /^(?:\[([0-9a-f:.]+)\]|([A-Za-z0-9_.\-]+)):(\d{1,5})$/i.exec(value);
	if (hostPort) {
		const port = Number(hostPort[3]);
		if (port > 0 && port <= 65535 && (!hostPort[1] || net.isIP(hostPort[1]) === 6)) return { kind: "tcp", raw: value, protocol: "", host: hostPort[1] || hostPort[2], port, path: "" };
	}
	const bareHost = /^([A-Za-z0-9_.\-]+)$/.exec(value);
	if (bareHost) return { kind: "tcp", raw: value, protocol: "", host: value, port: 0, path: "" };
	return { kind: "none", raw: value, host: "", port: 0, protocol: "", path: "" };
}

/** TCP 连接探测（默认 3s 超时）。 */
export function probeTcp(host, port, options = {}) {
	const timeoutMs = Math.max(200, Number(options.timeoutMs) || 3000);
	const connectImpl = typeof options.connectImpl === "function" ? options.connectImpl : net.connect;
	const started = Date.now();
	return new Promise((resolve) => {
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { resolve({ ok: false, state: "invalid", error: "host 为空或端口不在 1–65535 范围内", latencyMs: 0 }); return; }
		let settled = false, socket, timer;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			resolve({ ...payload, latencyMs: Date.now() - started });
		};
		try {
			socket = connectImpl({ host, port });
			timer = setTimeout(() => finish({ ok: false, state: "timeout", error: `连接超时（${timeoutMs}ms）` }), timeoutMs);
			if (typeof timer.unref === "function") timer.unref();
			socket.once("connect", () => { finish({ ok: true, state: "ready" }); });
			socket.once("error", (error) => { finish({ ok: false, state: "unreachable", error: String((error && error.message) || error) }); });
		} catch (error) {
			finish({ ok: false, state: "unreachable", error: String((error && error.message) || error) });
		}
	});
}

/** HTTP 探测：任意 HTTP 响应（含 4xx/5xx）都算「监听中」，网络错误算不可达。 */
export async function probeHttp(url, options = {}) {
	const timeoutMs = Math.max(300, Number(options.timeoutMs) || 3000);
	const explicit = !!options && Object.prototype.hasOwnProperty.call(options, "fetchImpl");
	const fetchImpl = explicit ? (typeof options.fetchImpl === "function" ? options.fetchImpl : null) : (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
	if (!fetchImpl) return { ok: false, state: "unavailable", error: "无 fetch 实现", latencyMs: 0 };
	const controller = new AbortController();
	const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
	const started = Date.now();
	try {
		const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
		const status = Number(response && response.status) || 0;
		// Headers are sufficient for reachability; release streaming response bodies.
		try { await response?.body?.cancel(); } catch { /* reachability already established */ }
		return { ok: true, state: "ready", status, latencyMs: Date.now() - started };
	} catch (error) {
		const aborted = controller.signal.aborted;
		return { ok: false, state: aborted ? "timeout" : "unreachable", error: aborted ? `请求超时（${timeoutMs}ms）` : String((error && error.message) || error), latencyMs: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}

/** 综合探测：URL 走 HTTP，host:port 走 TCP。 */
export async function probeTarget(target, options = {}) {
	const parsed = parseTarget(target);
	if (parsed.kind === "none") return { ok: false, state: "invalid", target: parsed, error: "没有可探测的目标", latencyMs: 0 };
	if (parsed.kind === "url") {
		const result = await probeHttp(parsed.raw, options);
		return { ...result, target: parsed };
	}
	const result = await probeTcp(parsed.host, parsed.port, options);
	return { ...result, target: parsed };
}

export default { parseTarget, probeTcp, probeHttp, probeTarget };