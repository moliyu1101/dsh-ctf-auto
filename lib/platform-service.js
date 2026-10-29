import crypto from "node:crypto";
import { createCtfdClient } from "./ctfd.js";
import { createGenericPlatformClient, normalizeGenericProfile } from "./platform-generic.js";
import { createDasctfMcpPlatform, DEFAULT_ORIGIN, defaultMcpUrl } from "./mcp-dasctf.js";
import { platformConnectionKey, platformChallengeKey } from "./platform-identity.js";
import { createPlatformOperations } from "./platform-operations.js";

const ADAPTERS = {
	ctfd: { create: (cfg, token, fetchImpl) => createCtfdClient({ baseUrl: cfg.baseUrl, token, fetchImpl }), capabilities: { account: true, challenges: true, submit: true, hints: true, download: true, environment: false } },
	generic: { create: (cfg, token, fetchImpl) => createGenericPlatformClient({ baseUrl: cfg.baseUrl, token, profile: cfg.profile, fetchImpl }), capabilities: { account: false, challenges: true, submit: true, hints: false, download: false, environment: false } },
	dasctf: { flagWrapper: "flag", create: (cfg, token, fetchImpl) => createDasctfMcpPlatform({ origin: cfg.baseUrl, mcpUrl: cfg.mcpUrl || defaultMcpUrl(cfg.baseUrl), token, fetchImpl }), capabilities: { account: true, challenges: true, submit: true, hints: false, download: true, environment: true } }
};

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	return value;
}
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function endpoint(value, label) {
	if (!value) return "";
	let raw = String(value).trim();
	if (raw.startsWith("//")) raw = `https:${raw}`;
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`;
	let url;
	try { url = new URL(raw); } catch { throw new Error(`${label}不是有效的 HTTP(S) 地址`); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${label}必须为不含凭据、查询或片段的 HTTP(S) 地址`);
	return url.href.replace(/\/+$/, "");
}

export function normalizePlatformConfig(raw = {}) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("平台配置必须是对象");
	const kind = String(raw.kind || "ctfd").trim();
	if (!Object.hasOwn(ADAPTERS, kind)) throw new Error("不支持的平台适配器类型");
	if (raw.profile != null && (typeof raw.profile !== "object" || Array.isArray(raw.profile))) throw new Error("平台 profile 必须是对象");
	if (raw.flagWrapper != null && raw.flagWrapper !== "" && !/^[A-Za-z][\w-]{0,63}$/.test(String(raw.flagWrapper))) throw new Error("flagWrapper 必须是 1–64 字符的前缀名称，或留空关闭归一化");
	return {
		kind, baseUrl: endpoint(raw.baseUrl || (kind === "dasctf" ? DEFAULT_ORIGIN : ""), "平台地址"),
		mcpUrl: endpoint(raw.mcpUrl || "", "MCP 地址"), platformSlug: String(raw.platformSlug || "").trim(),
		apiToken: String(raw.apiToken || "").trim(), profile: raw.profile || null,
		flagWrapper: raw.flagWrapper == null ? null : String(raw.flagWrapper).trim()
	};
}

export function createPlatformService({ readConfig, writeConfig, getFetch = () => globalThis.fetch, env = process.env }) {
	const operations = createPlatformOperations();
	const cache = new Map();
	let closed = false, generation = 0;
	function fromConfig(raw) {
		const cfg = normalizePlatformConfig(raw);
		const token = cfg.apiToken || (cfg.kind === "dasctf" ? String(env.CTF2_AGENT_TOKEN || "").trim() : "");
		const capabilities = { ...ADAPTERS[cfg.kind].capabilities };
		const base = { flagWrapper: cfg.flagWrapper ?? ADAPTERS[cfg.kind].flagWrapper ?? null, cfg, kind: cfg.kind, token, baseUrl: cfg.baseUrl, platformSlug: cfg.platformSlug, capabilities };
		if (closed) return { ...base, client: null, error: "平台服务已关闭" };
		if (!token) return { ...base, client: null, error: cfg.kind === "dasctf" ? "未配置 CTF2_AGENT_TOKEN" : "未配置 API Token" };
		if (!cfg.baseUrl) return { ...base, client: null, error: "平台地址为空" };
		// Recovery scope survives a restart/config save, but changes with credentials.
		const { flagWrapper, ...identityConfig } = cfg;
		const credentialKey = fingerprint({ ...identityConfig, apiToken: token });
		const sessionKey = `${generation}:${credentialKey}`;
		const fetchImpl = getFetch();
		const existing = cache.get(sessionKey);
		if (existing && existing.fetchImpl === fetchImpl) return existing.value;
		const rawClient = ADAPTERS[cfg.kind].create(cfg, token, fetchImpl);
		const client = { ...rawClient };
		for (const method of ["me", "listChallenges", "getChallenge", "hints"]) {
			if (typeof rawClient[method] !== "function") continue;
			client[method] = (...args) => {
				const key = `read:${sessionKey}:${method}:${fingerprint(args)}`;
				return operations.singleFlight(key, () => operations.exclusive(key, () => rawClient[method](...args)));
			};
		}
		const value = { ...base, sessionKey, credentialKey, client, error: "" };
		cache.set(sessionKey, { value, fetchImpl });
		while (cache.size > 8) cache.delete(cache.keys().next().value);
		return value;
	}
	function read() { return normalizePlatformConfig(readConfig()); }
	function current() { return fromConfig(read()); }
	function save(raw) {
		const cfg = normalizePlatformConfig(raw);
		writeConfig(cfg);
		generation++;
		cache.clear();
		return cfg;
	}
	function forChallenge(challenge) {
		const cfg = read();
		if (!challenge?.platform || platformConnectionKey(challenge.platform) !== platformConnectionKey(cfg)) {
			return { client: null, error: "题目来源与当前平台连接不一致，请切回原平台配置后重试", code: "PLATFORM_CONNECTION_MISMATCH" };
		}
		if (cfg.kind === "generic" && fingerprint(normalizeGenericProfile(challenge.platform.profile || {})) !== fingerprint(normalizeGenericProfile(cfg.profile || {}))) {
			return { client: null, error: "题目来源的适配配置已变化，请恢复原 profile 后重试", code: "PLATFORM_PROFILE_MISMATCH" };
		}
		return fromConfig(cfg);
	}
	function metadata(connection, item) {
		return {
			kind: connection.kind, baseUrl: connection.baseUrl, challengeId: String(item.id),
			platformSlug: connection.cfg.platformSlug, mcpUrl: connection.cfg.mcpUrl,
			groundId: String(item.groundId || item.practiceGroundId || ""), sourceType: String(item.sourceType || item.type || "practice"),
			competitionId: String(item.competitionId || ""), stageId: String(item.stageId || ""),
			profile: connection.kind === "generic" ? connection.cfg.profile : null
		};
	}
	function view(raw) {
		const cfg = normalizePlatformConfig(raw);
		return { kind: cfg.kind, baseUrl: cfg.baseUrl, mcpUrl: cfg.mcpUrl, platformSlug: cfg.platformSlug, profile: cfg.profile, flagWrapper: cfg.flagWrapper ?? ADAPTERS[cfg.kind].flagWrapper ?? null,
			tokenSet: !!(cfg.apiToken || (cfg.kind === "dasctf" && env.CTF2_AGENT_TOKEN)), tokenHint: cfg.apiToken ? cfg.apiToken.slice(-4) : "",
			capabilities: { ...ADAPTERS[cfg.kind].capabilities } };
	}
	async function environment(challenge, action) {
		const connection = forChallenge(challenge);
		if (!connection.client) return { ok: false, error: connection.error, code: connection.code };
		if (!connection.capabilities.environment) return { ok: false, error: "当前适配器不支持靶机环境操作", code: "PLATFORM_UNSUPPORTED" };
		const resource = `environment:${connection.sessionKey}:${platformChallengeKey(challenge.platform)}`;
		try {
			return await operations.coalesced(resource, action, () => connection.client.environment(action, { id: challenge.platform.challengeId, meta: challenge.platform }));
		} catch (error) { return { ok: false, code: error?.code || "PLATFORM_REQUEST_FAILED", error: String(error?.message || error) }; }
	}
	return { read, save, view, current, fromConfig, forChallenge, metadata, environment, operations,
		close() { closed = true; cache.clear(); operations.close(); } };
}
