// dsh-ctf-auto / lib/mcp-dasctf.js —— DASCTF 开放 API 的 MCP（HTTP JSON-RPC）适配器。
//
// 接入方式：自研框架直接连 MCP 端点 `https://ctf2.dasctf.com/api/ai/v1/mcp`，
// 请求头带 `Authorization: Bearer $CTF2_AGENT_TOKEN`，首包 initialize 后拿 `Mcp-Session-Id`，
// 其余请求复用该 session；工具调用走 JSON-RPC `tools/call`（也兼容 text/event-stream 响应）。
// 覆盖：whoami / 练习赛题列表与详情 / 附件签名 URL / 提交 flag / 靶机环境 start-get-extend-delete。

import { submissionStatus } from "./platform-result.js";

export const DEFAULT_ORIGIN = "https://ctf2.dasctf.com";

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOrigin(origin) {
	const raw = String(origin || "").trim() || DEFAULT_ORIGIN;
	return raw.replace(/\/+$/, "");
}

export function defaultMcpUrl(origin) {
	return `${normalizeOrigin(origin)}/api/ai/v1/mcp`;
}

/** 解析工具调用结果（content[0].text 可能是 JSON 字符串）。 */
export function unwrapToolResult(result) {
	if (!isPlainObject(result)) return { ok: false, error: "工具结果为空" };
	if (result.isError === true) {
		const text = Array.isArray(result.content) ? result.content.map((item) => (isPlainObject(item) ? item.text : "")).filter(Boolean).join("\n") : "";
		return { ok: false, error: text || "工具调用失败" };
	}
	const structured = isPlainObject(result.structuredContent) ? result.structuredContent : null;
	const text = Array.isArray(result.content) ? result.content.map((item) => (isPlainObject(item) ? item.text : "")).filter(Boolean).join("\n") : "";
	let data = structured;
	if (!data && text) {
		try { data = JSON.parse(text); } catch { data = { text }; }
	}
	return { ok: true, data: data || {}, text };
}

/** 解析 SSE 或 JSON 响应体。 */
export function parseRpcBody(contentType, text) {
	const type = String(contentType || "").toLowerCase();
	if (type.includes("text/event-stream")) {
		const dataLines = String(text || "")
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter(Boolean);
		for (const line of dataLines) {
			try {
				const obj = JSON.parse(line);
				if (obj && (obj.result !== undefined || obj.error !== undefined || obj.id !== undefined)) return obj;
			} catch { /* 跳过非 JSON data 行 */ }
		}
		return null;
	}
	try { return JSON.parse(text); } catch { return null; }
}

/**
 * 创建 DASCTF MCP 客户端。
 * @param {{mcpUrl?:string, origin?:string, token:string, fetchImpl?:Function, timeoutMs?:number, sleepImpl?:Function, clientInfo?:object}} options
 */
export function createDasctfMcpClient(options = {}) {
	const opts = isPlainObject(options) ? options : {};
	const origin = normalizeOrigin(opts.origin);
	const mcpUrl = String(opts.mcpUrl || "").trim() || defaultMcpUrl(origin);
	const token = String(opts.token || "").trim();
	const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
	const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 30000);
	const sleep = typeof opts.sleepImpl === "function" ? opts.sleepImpl : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const clientInfo = isPlainObject(opts.clientInfo) ? opts.clientInfo : { name: "dsh-ctf-auto", version: "0.1.1" };
	let sessionId = "", initialized = false;
	let nextId = 1;
	let initPromise = null;
	let toolsCache = null;
	const log = [];

	async function rawPost(payload) {
		if (!fetchImpl) return { ok: false, error: "当前环境没有可用的 fetch" };
		if (!token) return { ok: false, error: "未配置 CTF2_AGENT_TOKEN" };
		const controller = new AbortController();
		const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		const headers = {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream"
		};
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		try {
			const response = await fetchImpl(mcpUrl, { method: "POST", headers, body: JSON.stringify(payload), redirect: "follow", signal: controller.signal });
			const status = Number(response && response.status) || 0;
			const sid = (() => { try { return response.headers && response.headers.get ? response.headers.get("mcp-session-id") || "" : ""; } catch { return ""; } })();
			if (sid) sessionId = sid;
			let text = "";
			try { text = typeof response.text === "function" ? await response.text() : String(response.text || ""); } catch { text = ""; }
			const contentType = (() => { try { return response.headers && response.headers.get ? response.headers.get("content-type") || "" : ""; } catch { return ""; } })();
			log.push({ method: payload.method, status, statusText: "" });
			if (log.length > 100) log.splice(0, log.length - 100);
			return { ok: status >= 200 && status < 300, status, text, contentType, sessionId: sid };
		} catch (error) {
			const aborted = controller.signal.aborted;
			return { ok: false, error: aborted ? `MCP 请求超时（${timeoutMs}ms）` : String((error && error.message) || error), code: aborted ? "timeout" : "network" };
		} finally {
			clearTimeout(timer);
		}
	}

	async function initialize() {
		if (initialized) return { ok: true, sessionId };
		if (initPromise) return initPromise;
		initPromise = (async () => {
			const res = await rawPost({
				jsonrpc: "2.0",
				id: nextId++,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo }
			});
			if (!res.ok) { sessionId = ""; return { ok: false, error: res.error || `MCP initialize 失败（HTTP ${res.status}）` }; }
			const body = parseRpcBody(res.contentType, res.text);
			if (!body) { sessionId = ""; return { ok: false, error: "MCP initialize 响应无法解析" }; }
			if (body.error) { sessionId = ""; return { ok: false, error: String(body.error.message || body.error.code || "initialize 错误") }; }
			// Complete the handshake before allowing concurrent tool requests.
			const notified = await rawPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
			if (!notified.ok) { sessionId = ""; return { ok: false, error: notified.error || "MCP 初始化通知失败" }; }
			initialized = true;
			return { ok: true, sessionId, instructions: body.result && body.result.instructions };
		})().finally(() => { initPromise = null; });
		return initPromise;
	}

	async function rpc(method, params, { retry = true, readOnly = false, renewSession = true } = {}) {
		const ready = await initialize();
		if (!ready.ok) return ready;
		const payload = { jsonrpc: "2.0", id: nextId++, method, params };
		let res = await rawPost(payload);
		if (res.status === 429 && retry) {
			const body = parseRpcBody(res.contentType, res.text);
			const retryMs = Number((body && body.error && body.error.data && body.error.data.retry_after_ms) || 1500);
			await sleep(Math.min(10000, Math.max(300, retryMs)));
			res = await rawPost(payload);
		}
		if (renewSession && sessionId && (res.status === 404 || res.status === 410)) {
			sessionId = ""; initialized = false; toolsCache = null;
			if (readOnly || method === "tools/list" || method === "ping") return rpc(method, params, { retry, readOnly, renewSession: false });
			return { ok: false, code: "MCP_SESSION_EXPIRED", status: res.status, error: "MCP 会话已过期，写操作未自动重放；请查询平台状态后重试" };
		}
		if (!res.ok) return { ok: false, error: res.error || `MCP 请求失败（HTTP ${res.status}）`, status: res.status };
		const body = parseRpcBody(res.contentType, res.text);
		if (!body) return { ok: false, error: "MCP 响应无法解析" };
		if (body.error) return { ok: false, error: String(body.error.message || body.error.code || "MCP 错误"), code: body.error.code, data: body.error.data };
		return { ok: true, result: body.result };
	}

	async function callTool(name, args = {}) {
		const readOnly = /^ctf2_(agent_(whoami|next_challenges)|get_(practice_challenge|competition_challenge|attachment_url|competition_attachment_url|environment|competition_environment))$/.test(name);
		const res = await rpc("tools/call", { name, arguments: args }, { readOnly });
		if (!res.ok) return res;
		const unwrapped = unwrapToolResult(res.result);
		if (!unwrapped.ok) return { ok: false, error: unwrapped.error };
		return { ok: true, data: unwrapped.data, text: unwrapped.text };
	}

	async function listTools() {
		if (toolsCache) return { ok: true, tools: toolsCache };
		const res = await rpc("tools/list", {});
		if (!res.ok) return res;
		toolsCache = Array.isArray(res.result && res.result.tools) ? res.result.tools : [];
		return { ok: true, tools: toolsCache };
	}

	async function ping() {
		const res = await rpc("ping", {});
		return { ok: res.ok, error: res.error || "" };
	}

	return { mcpUrl, origin, tokenSet: !!token, sessionId: () => sessionId, log, initialize, rpc, callTool, listTools, ping };
}

function normalizeFiles(files) {
	if (!Array.isArray(files)) return [];
	return files
		.map((item) => {
			if (!isPlainObject(item)) return null;
			const id = item.id || item.file_id || item.fileId || "";
			const name = String(item.name || item.filename || item.file_name || "file.bin");
			const size = Number(item.size || item.file_size || 0) || 0;
			return { id: String(id), name, size, url: String(item.url || "") };
		})
		.filter((item) => item && item.id);
}

/**
 * 创建 DASCTF 平台客户端（CTFd 适配器同签名 + 靶机环境方法）。
 * @param {{origin?:string, mcpUrl?:string, token:string, fetchImpl?:Function, timeoutMs?:number}} options
 */
export function createDasctfMcpPlatform(options = {}) {
	const opts = isPlainObject(options) ? options : {};
	const origin = normalizeOrigin(opts.origin);
	const token = String(opts.token || "").trim();
	const mcp = createDasctfMcpClient({ ...opts, origin });
	const challengeIndex = new Map();

	function resolveSource(item, fallback) {
		const source = isPlainObject(item && item.source) ? item.source : {};
		const type = String(source.type || item?.sourceType || item?.type || (item?.competition_id ? "competition" : fallback.type || "practice")).toLowerCase();
		return {
			type,
			practiceGroundId: String(source.practice_ground_id || (item && (item.practice_ground_id || item.practiceGroundId || item.groundId)) || fallback.practiceGroundId || ""),
			competitionId: String(source.competition_id || (item && (item.competition_id || item.competitionId)) || fallback.competitionId || ""),
			stageId: String(source.stage_id || (item && (item.stage_id || item.stageId)) || fallback.stageId || "")
		};
	}

	function remember(item, extra = {}) {
		if (!item || item.id == null) return null;
		const source = resolveSource(item, extra);
		const record = { ...extra, ...source, id: String(item.id), raw: item };
		challengeIndex.set(String(item.id), record);
		return record;
	}

	function normalizeSummary(item) {
		const record = remember(item);
		return {
			id: String(item.id),
			name: String(item.name || ""),
			category: String(item.category || ""),
			value: Number.isFinite(Number(item.points)) ? Number(item.points) : null,
			type: String(item.source && item.source.type || "practice"),
			solvedByMe: !!item.is_solved,
			difficulty: String(item.difficulty || ""),
			friendlyId: String(item.friendly_id || ""),
			hasContainer: !!item.has_container,
			hasAttachments: !!item.has_attachments,
			solveCount: Number(item.solve_count || 0) || 0,
			groundId: record ? record.practiceGroundId : "",
			competitionId: record ? record.competitionId : "",
			stageId: record ? record.stageId : "",
			groundName: String(item.practice_ground_name || ""),
			files: []
		};
	}

	async function me() {
		const res = await mcp.callTool("ctf2_agent_whoami", {});
		if (!res.ok) return res;
		const data = res.data || {};
		const agent = isPlainObject(data.agent) ? data.agent : {};
		return {
			ok: true,
			data: {
				name: String(agent.name || data.name || ""),
				id: agent.id || data.id || null,
				agent,
				quotas: data.quotas || {},
				rules: data.rules || [],
				activeCompetitions: data.active_competitions || [],
				competitionEnabled: !!data.competition_enabled,
				stats: data.stats || {}
			}
		};
	}

	async function listChallenges() {
		const limit = 200;
		const res = await mcp.callTool("ctf2_agent_next_challenges", { limit });
		if (!res.ok) return res;
		const items = Array.isArray(res.data && res.data.items) ? res.data.items : Array.isArray(res.data) ? res.data : null;
		if (!items) return { ok: false, code: "PLATFORM_LIST_INVALID", error: "DASCTF 返回的题目列表不是数组" };
		return { ok: true, data: items.filter(isPlainObject).map(normalizeSummary), possiblyTruncated: items.length >= limit };
	}

	function argsFor(record, extra = {}) {
		const type = String(record.type || record.sourceType || "practice").toLowerCase();
		const ground = String(record.practiceGroundId || record.groundId || "");
		const challengeId = String(record.id || record.challengeId || "");
		const args = { challenge_id: challengeId, ...extra };
		if (type === "competition") {
			args.competition_id = String(record.competitionId || "");
			args.stage_id = String(record.stageId || "");
		} else {
			args.practice_ground_id = ground;
		}
		return args;
	}

	/** 旧导入数据可能缺 practice_ground_id：从平台列表按 id 反查补齐。 */
	async function ensureGround(record) {
		if (!record || String(record.type || record.sourceType || "practice") === "competition") return record;
		if (record.practiceGroundId || record.groundId) return record;
		try {
			const res = await mcp.callTool("ctf2_agent_next_challenges", { limit: 200 });
			if (res.ok) {
				const items = Array.isArray(res.data && res.data.items) ? res.data.items : [];
				const hit = items.find((item) => String(item && item.id) === String(record.id));
				if (hit && hit.practice_ground_id) {
					record.practiceGroundId = String(hit.practice_ground_id);
					challengeIndex.set(String(record.id), { ...record });
				}
			}
		} catch { /* 反查失败则继续用空 ground（会得到明确错误） */ }
		return record;
	}

	async function getChallenge(id, item) {
		const key = String(id);
		const record = remember(item && { ...item, id: key }) || challengeIndex.get(key) || { id: key, type: "practice", practiceGroundId: "", competitionId: "", stageId: "" };
		await ensureGround(record);
		const tool = record.type === "competition" ? "ctf2_get_competition_challenge" : "ctf2_get_practice_challenge";
		const res = await mcp.callTool(tool, argsFor(record));
		if (!res.ok) return res;
		const challenge = isPlainObject(res.data && res.data.challenge) ? res.data.challenge : res.data || {};
		const files = normalizeFiles(challenge.files);
		// 附件：逐个换取 5 分钟签名 URL（最多 5 个，失败不影响详情）
		const attachmentTool = record.type === "competition" ? "ctf2_get_competition_attachment_url" : "ctf2_get_attachment_url";
		for (const file of files.slice(0, 5)) {
			if (!file.id) continue;
			try {
				const urlRes = await mcp.callTool(attachmentTool, { ...argsFor(record), file_id: file.id });
				if (urlRes.ok) {
					const url = String((urlRes.data && (urlRes.data.url || urlRes.data.attachment_url || urlRes.data.download_url)) || (urlRes.data && urlRes.data.attachment && urlRes.data.attachment.url) || "");
					if (url) file.url = url;
				}
			} catch { /* 忽略单个附件失败 */ }
		}
		return {
			ok: true,
			data: {
				id: String(challenge.id || key),
				name: String(challenge.name || ""),
				category: String(challenge.category || ""),
				value: Number.isFinite(Number(challenge.points)) ? Number(challenge.points) : null,
				description: String(challenge.description || ""),
				connectionInfo: "",
				files,
				requiresTarget: !!challenge.requires_running_target_for_submit,
				hasContainer: !!challenge.has_container,
				solvedByMe: !!challenge.is_solved,
				platform: { ...record, raw: undefined }
			}
		};
	}

	async function submit(challengeId, flag, meta = {}) {
		const key = String(challengeId);
		const record = challengeIndex.get(key) || {};
		const recordWithMeta = { ...record, ...resolveSource(meta, record), id: key };
		await ensureGround(recordWithMeta);
		const tool = recordWithMeta.type === "competition" ? "ctf2_submit_competition_flag" : "ctf2_submit_flag";
		const args = { ...argsFor({ ...recordWithMeta, id: key }), flag: String(flag ?? ""), confirmation: true };
		const res = await mcp.callTool(tool, args);
		if (!res.ok) {
			const code = String((res && (res.code || "")) || "") + " " + String((res && res.error) || "");
			if (/ALREADY_SOLVED|already[ _-]?solved|已解/i.test(code)) {
				return { ok: true, status: "already_solved", flagConfirmed: false, message: String((res && res.error) || "already solved"), data: { status: "already_solved", message: "already solved", flagConfirmed: false } };
			}
			return res;
		}
		const data = res.data || {};
		const rawStatus = String(data.status || data.result || data.message || "").trim();
		const status = submissionStatus(data);
		return { ok: true, status, flagConfirmed: status === "correct", message: String(data.message || rawStatus), data: { status, message: String(data.message || rawStatus), flagConfirmed: status === "correct", raw: data } };
	}

	async function download(url) {
		const target = String(url || "");
		if (!target) return { ok: false, error: "附件 URL 为空" };
		const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
		if (typeof fetchImpl !== "function") return { ok: false, error: "当前环境没有可用的 fetch" };
		try {
			const response = await fetchImpl(target, { method: "GET", redirect: "follow" });
			const status = Number(response && response.status) || 0;
			if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}`, status };
			const bytes = new Uint8Array(await response.arrayBuffer());
			return { ok: true, bytes, size: bytes.length, filename: target.split("/").pop() || "file.bin" };
		} catch (error) {
			return { ok: false, error: String((error && error.message) || error) };
		}
	}

	// ── 靶机环境 ─────────────────────────────────────────────
	async function environment(action, { id, item, meta } = {}) {
		const key = String(id || "");
		const cached = challengeIndex.get(key) || {};
		const record = remember(item && { ...item, id: key }) || { ...cached, ...resolveSource(meta, cached), id: key };
		await ensureGround(record);
		const isCompetition = record.type === "competition";
		const tool = (() => {
			if (action === "start") return isCompetition ? "ctf2_start_competition_environment" : "ctf2_start_challenge_environment";
			if (action === "status") return isCompetition ? "ctf2_get_competition_environment" : "ctf2_get_environment";
			if (action === "extend") return isCompetition ? "ctf2_extend_competition_environment" : "ctf2_extend_environment";
			if (action === "delete") return isCompetition ? "ctf2_delete_competition_environment" : "ctf2_user_delete_practice_id_challenges_challengeid_environment";
			return "";
		})();
		if (!tool) return { ok: false, error: "未知环境操作：" + action };
		const res = await mcp.callTool(tool, argsFor(record));
		if (!res.ok) return res;
		const environment = isPlainObject(res.data && res.data.environment) ? res.data.environment : res.data || {};
		return { ok: true, environment };
	}

	async function discover() {
		const res = await me();
		if (!res.ok) return { ok: false, error: res.error, log: mcp.log.slice(-8) };
		const tools = await mcp.listTools();
		return {
			ok: true,
			baseUrl: origin,
			mcpUrl: mcp.mcpUrl,
			user: res.data,
			tools: tools.ok ? tools.tools.map((tool) => tool.name) : [],
			log: mcp.log.slice(-8)
		};
	}

	return {
		mode: "dasctf-mcp",
		origin,
		mcpUrl: mcp.mcpUrl,
		tokenSet: !!token,
		challengeIndex,
		me,
		listChallenges,
		getChallenge,
		submit,
		download,
		hints: async () => ({ ok: false, error: "DASCTF 开放 API 暂不支持 hints" }),
		unlockHint: async () => ({ ok: false, error: "DASCTF 开放 API 暂不支持 hints" }),
		environment,
		discover,
		mcp
	};
}

export default { DEFAULT_ORIGIN, normalizeOrigin, defaultMcpUrl, unwrapToolResult, parseRpcBody, createDasctfMcpClient, createDasctfMcpPlatform };
