// dsh-ctf-auto / lib/dasctf.js —— DASCTF 开放 API（Agent REST 通道）适配器。
//
// 接入方式：自研框架直接调用 REST，请求头 `Authorization: Bearer $CTF2_AGENT_TOKEN`；
// 基础地址 `https://ctf2.dasctf.com/api/open/v1/user`，示例 `GET /agent/me/{platform}`。
// 由于不同赛事/平台的 endpoint 可能微调，这里所有路径都做成模板（{platform}/{id} 占位），
// 可通过 profile.paths 覆盖；并提供 discover() 用真实 token 自动探测可用路径。

import { submissionStatus } from "./platform-result.js";

export const DASCTF_DEFAULT_BASE = "https://ctf2.dasctf.com/api/open/v1/user";

const DEFAULT_PATHS = {
	me: "/agent/me/{platform}",
	list: "/agent/challenges/{platform}",
	detail: "/agent/challenge/{platform}/{id}",
	submit: "/agent/challenge/{platform}/{id}/submit",
	instance: "/agent/challenge/{platform}/{id}/instance"
};

/** 候选路径（discover 用）：按优先级尝试，命中即返回。 */
export const CANDIDATE_PATHS = {
	me: ["/agent/me/{platform}", "/agent/me", "/agent/{platform}/me"],
	list: [
		"/agent/challenges/{platform}",
		"/agent/challenge/list/{platform}",
		"/agent/{platform}/challenges",
		"/agent/challenges",
		"/challenges"
	],
	detail: ["/agent/challenge/{platform}/{id}", "/agent/challenges/{platform}/{id}", "/agent/challenge/{id}", "/challenges/{id}"],
	submit: [
		"/agent/challenge/{platform}/{id}/submit",
		"/agent/challenges/{platform}/{id}/submit",
		"/agent/challenge/{id}/submit",
		"/challenges/{id}/submit"
	]
};

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeDasctfBase(baseUrl) {
	const raw = String(baseUrl || "").trim();
	const fallback = DASCTF_DEFAULT_BASE;
	const value = raw || fallback;
	return value.replace(/\/+$/, "");
}

/** 填充 `{platform}` / `{id}` 占位（未给 platform 时去掉该段并清理双斜杠）。 */
export function fillPathTemplate(template, vars = {}) {
	let path = String(template == null ? "" : template);
	const platform = vars.platform == null ? "" : String(vars.platform);
	const id = vars.id == null ? "" : String(vars.id);
	path = path.replace(/\{platform\}/g, platform).replace(/\{id\}/g, encodeURIComponent(id));
	if (!platform) path = path.replace(/\/+/g, "/");
	return path.startsWith("/") ? path : `/${path}`;
}

/** 把响应体归一为 {ok,data,status,error}：兼容 {success,data} / {code,data} / 裸对象 / 裸数组。 */
export function unwrapDasctfPayload(payload) {
	if (isPlainObject(payload)) {
		if (payload.success === false) {
			const error = isPlainObject(payload.error) ? payload.error : {};
			return { ok: false, error: String(error.message || error.code || payload.message || "平台返回失败") };
		}
		if (payload.success === true && "data" in payload) return { ok: true, data: payload.data };
		if ("data" in payload) return { ok: true, data: payload.data };
		if (typeof payload.code === "number" && payload.code >= 400) return { ok: false, error: String(payload.message || payload.code) };
		return { ok: true, data: payload };
	}
	if (Array.isArray(payload)) return { ok: true, data: payload };
	return { ok: true, data: payload == null ? null : payload };
}

function normalizeFiles(files) {
	if (!Array.isArray(files)) return [];
	return files
		.map((item) => {
			if (typeof item === "string") return { name: item.split("/").pop() || "file.bin", url: item };
			if (!isPlainObject(item)) return null;
			const url = String(item.url || item.path || item.download_url || "");
			if (!url) return null;
			return { name: String(item.name || url.split("/").pop() || "file.bin"), url };
		})
		.filter(Boolean);
}

/** 归一化题目对象（字段名做多别名兼容）。 */
export function normalizeChallenge(raw, fallbackId) {
	const item = isPlainObject(raw) ? raw : {};
	const pick = (...keys) => {
		for (const key of keys) if (item[key] != null && item[key] !== "") return item[key];
		return undefined;
	};
	return {
		id: pick("id", "challenge_id", "challengeId", "uuid") ?? fallbackId,
		name: String(pick("name", "title", "challenge_name") ?? ""),
		category: String(pick("category", "type", "class") ?? ""),
		value: Number.isFinite(Number(pick("value", "score", "points"))) ? Number(pick("value", "score", "points")) : null,
		solvedByMe: !!(pick("solved", "solved_by_me", "solvedByMe") ?? false),
		description: String(pick("description", "desc", "content", "statement") ?? ""),
		connectionInfo: String(pick("connection_info", "connectionInfo", "target", "url") ?? ""),
		files: normalizeFiles(pick("files", "attachments") || []),
		raw: item
	};
}

/**
 * 创建 DASCTF REST 客户端（方法签名与 CTFd 适配器一致）。
 * @param {{baseUrl?:string, token?:string, platform?:string, paths?:object, fetchImpl?:Function, timeoutMs?:number}} options
 */
export function createDasctfClient(options = {}) {
	const opts = isPlainObject(options) ? options : {};
	const baseUrl = normalizeDasctfBase(opts.baseUrl);
	const token = typeof opts.token === "string" ? opts.token.trim() : "";
	const platform = String(opts.platform || opts.platformSlug || "").trim();
	const pathsInput = isPlainObject(opts.paths) ? opts.paths : {};
	const paths = { ...DEFAULT_PATHS, ...pathsInput };
	const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
	const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 15000);
	const debug = [];

	function urlFor(pathname) {
		return `${baseUrl}${pathname.startsWith("/") ? pathname : "/" + pathname}`;
	}

	async function request(pathname, init = {}) {
		if (!fetchImpl) return { ok: false, error: "当前环境没有可用的 fetch" };
		if (!baseUrl) return { ok: false, error: "平台地址为空" };
		if (!token) return { ok: false, error: "未配置 CTF2_AGENT_TOKEN（面板「平台」里填 API Token，或设置环境变量）" };
		const controller = new AbortController();
		const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		const url = urlFor(pathname);
		try {
			const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
			let body;
			if (init.body !== undefined) { body = JSON.stringify(init.body); headers["Content-Type"] = "application/json"; }
			const response = await fetchImpl(url, { method: init.method || "GET", headers, body, redirect: "follow", signal: controller.signal });
			const status = Number(response && response.status) || 0;
			let payload = null;
			let text = "";
			try {
				text = await response.text();
				payload = text ? JSON.parse(text) : null;
			} catch { payload = null; }
			debug.push({ method: init.method || "GET", url, status });
			if (status === 401 || status === 403) return { ok: false, status, error: `鉴权失败（HTTP ${status}）：请检查 CTF2_AGENT_TOKEN 是否有效/过期` };
			if (status === 404) return { ok: false, status, error: `HTTP 404：路径不存在（${pathname}，可在 profile.paths 里覆盖）` };
			if (status < 200 || status >= 300) {
				const message = isPlainObject(payload) && (payload.message || (payload.error && (payload.error.message || payload.error.code)));
				return { ok: false, status, error: `HTTP ${status}${message ? "：" + message : ""}`, payload };
			}
			const unwrapped = unwrapDasctfPayload(payload);
			if (!unwrapped.ok) return { ok: false, status, error: unwrapped.error, payload };
			return { ok: true, status, data: unwrapped.data, payload };
		} catch (error) {
			const aborted = controller.signal.aborted;
			return { ok: false, error: aborted ? `请求超时（${timeoutMs}ms）` : String((error && error.message) || error), code: aborted ? "timeout" : "network" };
		} finally {
			clearTimeout(timer);
		}
	}

	async function tryPaths(kind, vars) {
		const list = [paths[kind], ...(CANDIDATE_PATHS[kind] || [])].filter(Boolean);
		const tried = [];
		for (const template of Array.from(new Set(list))) {
			const pathname = fillPathTemplate(template, vars);
			const res = await request(pathname);
			tried.push({ path: pathname, status: res.status, ok: res.ok });
			if (res.ok) return { ...res, path: pathname, tried };
			if (res.status !== 404) return { ...res, tried };
		}
		return { ok: false, error: `所有候选路径都 404（${tried.map((item) => item.path).join(", ")}）`, tried };
	}

	async function me() {
		const res = await tryPaths("me", { platform });
		if (!res.ok) return res;
		const data = isPlainObject(res.data) ? res.data : {};
		return { ok: true, status: res.status, path: res.path, data: { ...data, name: String(data.name || data.username || data.nickname || ""), id: data.id ?? null } };
	}

	async function listChallenges() {
		const res = await tryPaths("list", { platform });
		if (!res.ok) return res;
		let items = res.data;
		if (isPlainObject(items)) items = items.list || items.challenges || items.items || items.rows || [];
		if (!Array.isArray(items)) items = [];
		return { ok: true, status: res.status, path: res.path, data: items.filter(isPlainObject).map((item) => normalizeChallenge(item)) };
	}

	async function getChallenge(id) {
		const res = await tryPaths("detail", { platform, id });
		if (!res.ok) return res;
		return { ok: true, status: res.status, path: res.path, data: normalizeChallenge(res.data, id) };
	}

	async function submit(challengeId, flag) {
		const candidates = Array.from(new Set([paths.submit, ...(CANDIDATE_PATHS.submit || [])].filter(Boolean)));
		const tried = [];
		for (const template of candidates) {
			const pathname = fillPathTemplate(template, { platform, id: challengeId });
			const posted = await request(pathname, { method: "POST", body: { flag: String(flag ?? "") } });
			tried.push({ path: pathname, status: posted.status, ok: posted.ok });
			if (!posted.ok) {
				if (posted.status === 404 || posted.status === 405) continue;
				return { ...posted, tried };
			}
			const data = isPlainObject(posted.data) ? posted.data : {};
			const rawStatus = String(data.status || data.result || data.message || "").trim();
			const status = submissionStatus(data);
			return { ok: true, status, message: rawStatus, data: { status, message: rawStatus, raw: data }, path: pathname, tried };
		}
		return { ok: false, error: "提交失败：所有候选路径都 404/405（可在 profile.paths.submit 覆盖）", tried };
	}

	async function download(url) {
		if (!fetchImpl) return { ok: false, error: "当前环境没有可用的 fetch" };
		if (!token) return { ok: false, error: "未配置 CTF2_AGENT_TOKEN" };
		try {
			const response = await fetchImpl(String(url), { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" });
			const status = Number(response && response.status) || 0;
			if (status < 200 || status >= 300) return { ok: false, status, error: `HTTP ${status}` };
			const buffer = new Uint8Array(await response.arrayBuffer());
			return { ok: true, bytes: buffer, size: buffer.length, filename: String(url).split("/").pop() || "file.bin" };
		} catch (error) {
			return { ok: false, error: String((error && error.message) || error) };
		}
	}

	/** 用真实 token 探测可用路径（面板「自动探测」/排障用）。 */
	async function discover() {
		const report = { ok: false, baseUrl, tokenSet: !!token, platform, tried: [], paths: {} };
		if (!token) return { ...report, error: "未配置 Token" };
		for (const kind of ["me", "list"]) {
			const res = await tryPaths(kind, { platform });
			report.tried.push(...(res.tried || []));
			if (res.ok) { report.paths[kind] = res.path; report.ok = true; }
		}
		report.debug = debug.slice(-12);
		return report;
	}

	return {
		baseUrl,
		tokenSet: !!token,
		platform,
		mode: "dasctf",
		paths,
		debug,
		me,
		listChallenges,
		getChallenge,
		submit,
		download,
		hints: async () => ({ ok: false, error: "DASCTF 开放 API 暂不支持 hints" }),
		unlockHint: async () => ({ ok: false, error: "DASCTF 开放 API 暂不支持 hints" }),
		discover
	};
}

export default { DASCTF_DEFAULT_BASE, CANDIDATE_PATHS, normalizeDasctfBase, fillPathTemplate, unwrapDasctfPayload, normalizeChallenge, createDasctfClient };
