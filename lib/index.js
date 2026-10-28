// dsh-ctf-auto —— CTF 自动解题编排器（Host 平面）。
//
// 自主推进骨架：题目 → 独立工作区 → 子代理解题 → 事实/尝试/flag 台账 → 面板与调度。
// 在 DSH 里换成更小的对应物：
//   engine 调度循环        → 本插件的 orchestrator（队列/并发/超时/自动换角度重试）
//   planner + 共享 todolist → 题目状态机（attempts 顺序推进，角度可续）
//   worker ×N              → DSH 子代理（provider spawn，ctf-solver preset，cwd=题目录）
//   双图（探索/资产）        → 每题目 facts 事实链 + flags + events 事件流
//   skills / 工具目录        → ctf-solver 模式自带技能与工具面（子代理直接用）
//   guard / intercept      → DSH 自己的审批与沙箱
//   平台取题/提交            → 数据模型留 platform 字段，adapter 契约见 docs/DESIGN.md
//
// 一个题目的生命周期：
//   ctf_solve_start(题面/附件) → 建题目录 + 状态库 → 入队
//   orchestrator.pump() → spawn 子代理（子代理读题面、干活、验证 flag）
//   子代理成功 → 调 ctf_flag_record(verified:true) → 状态 solved
//   子代理卡住/失败 → orchestrator 记 attempt 收口 → 自动换角度重试（上限 maxAttempts）→ stuck
//   面板 / 工具随时可见：题板、attempts 时间线、facts、events、flags。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createStore } from "./store.js";
import { createOrchestrator } from "./orchestrator.js";
import { buildPresetDefinition, PRESET_ID, PRESET_NAME, resolveSkillSourceDir } from "./preset.js";
import { createCtfdClient, normalizeBaseUrl } from "./ctfd.js";
import { createGenericPlatformClient, normalizeGenericProfile } from "./platform-generic.js";
import { detectPlatform } from "./platform-detect.js";
import { createDasctfClient, DASCTF_DEFAULT_BASE } from "./dasctf.js";
import { createDasctfMcpPlatform, defaultMcpUrl as dasctfDefaultMcpUrl } from "./mcp-dasctf.js";
import { buildMarkdownReport } from "./report.js";
import * as workbench from "./workbench.js";
import { searchBoard } from "./search.js";
import { buildWriteup } from "./writeup.js";
import { classifyChallenge } from "./classify.js";
import { buildKnowledgeIndex, searchKnowledge, rankKnowledge } from "./kb.js";
import { parseImportInput, normalizeImportPath, safeKnowledgeName, MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_IMPORT_TOTAL_BYTES } from "./kbimport.js";
import { classifyFactKind, FACT_KINDS } from "./blackboard.js";
import { distillCard, rankMemories, searchMemories } from "./memory.js";
import { triageFiles } from "./triage.js";
import { buildTarGz, packFileName } from "./pack.js";
import { buildReviewPrompt } from "./prompt.js";
import { loadRoleText } from "./roles.js";
import { runWslCommand, listDistros, toWslPath } from "./wslrun.js";
import { probeTarget, parseTarget } from "./target.js";
import { validateVerifiedFlag } from "./flagcheck.js";

const name = "dsh-ctf-auto";
// subagents 走 ctx.get 可选获取：缺失时不注册编排（工具返回明确 diagnostic），不静默降级。
const inject = ["tools", "webServer"];

export const DEFAULTS = {
	concurrency: 2,
	timeoutMs: 30 * 60 * 1000,
	maxAttempts: 3,
	autoRetry: true,
	solverPreset: "ctf-auto",
	solverModel: "",
	rootDir: "",
	maxFileCopyBytes: 50 * 1024 * 1024,
	flagReExtra: [],
	flagPatterns: [],
	minEvidenceChars: 12,
	reviewerEnabled: false,
	memoryTopK: 3,
	memoryMinScore: 0.3,
	knowledgeTopK: 3,
	knowledgeMinScore: 0.08,
	pricePerMToken: 2,
	autoFetchEnabled: false,
	autoFetchIntervalMs: 300000,
	autoFetchLimit: 5,
	autoSolveImported: true,
	autoSubmitEnabled: true,
	autoDistill: true
};

const ROUTE_PATH = "/dsh-ctf-auto";
const CSRF_TOKEN = crypto.randomBytes(24).toString("hex");
const MAX_BODY = 1024 * 1024;
const MAX_EVENT_TAIL = 200;
const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_CHALLENGE = 50;
const MAX_IMPORT_CHALLENGES = 100;
const MAX_FLAG_CHARS = 300;
const MAX_EVIDENCE_CHARS = 4000;
const MAX_WSL_OUTPUT = 1_000_000;
const MAX_WSL_TIMEOUT_MS = 30 * 60 * 1000;

//#region 通用小工具

const text = (t) => [{ type: "text", text: String(t) }];
const tail = (s, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s);

function validateArgs(schema, args) {
	const input = args && typeof args === "object" ? args : {};
	const out = { ...input };
	const problems = [];
	for (const key of schema.required ?? []) {
		const value = input[key];
		if (value === undefined || value === null || value === "") problems.push(`缺少必填参数 ${key}`);
	}
	return { args: out, problems };
}

/** 注册一个模型工具：参数用标准 JSON Schema（DSH 工具注册表直接接受），execute 自己做必填校验。 */
function defineToolLite({ name: toolName, description, parameters, outputSchema, render, execute, isConcurrencySafe }) {
	return {
		name: toolName,
		description,
		parameters,
		output: {
			schema: outputSchema ?? { type: "object", additionalProperties: true },
			render: (_args, value) => text(render(_args, value))
		},
		...(isConcurrencySafe ? { isConcurrencySafe: () => true } : {}),
		async execute(args, exec) {
			const { problems } = validateArgs(parameters, args);
			if (problems.length > 0) throw new Error(`${toolName}: ${problems.join("；")}`);
			return execute(args ?? {}, exec);
		}
	};
}

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const bool = (description) => ({ type: "boolean", description });

function objSchema(properties, required) {
	return { type: "object", properties, ...(required && required.length ? { required } : {}), additionalProperties: false };
}

/** 工具返回值不锁字段：编排层会随事件补字段，锁死会让工具在扩展时整体失败。 */
function outSchema(properties, required) {
	return { type: "object", properties: properties ?? {}, ...(required && required.length ? { required } : {}), additionalProperties: true };
}

//#endregion

//#region Web 面板通道（自注册路由 + 同源栅栏 + CSRF，模式与 dsh-campaign-memory 一致）

function hostOf(headers) {
	const h = headers?.host;
	return typeof h === "string" ? h : "";
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
export function isTrustedRequest(req, trustedHosts) {
	const host = hostOf(req.headers);
	if (host === "") return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	const okHost = isLoopbackHostname(hostUrl.hostname) || (trustedHosts ?? []).some((t) => {
		try { return new URL(`http://${t}`).hostname === hostUrl.hostname; } catch { return false; }
	});
	if (!okHost) return false;
	const origin = req.headers?.origin;
	if (typeof origin === "string" && origin !== "null") {
		try {
			const originUrl = new URL(origin);
			if (originUrl.host !== hostUrl.host) return false;
		} catch { return false; }
	}
	return true;
}
export function checkCsrf(req, token) {
	return String(req?.headers?.["x-dsh-csrf"] ?? "") === String(token ?? "");
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

//#endregion

function apply(ctx, config) {
	const cfg = { ...DEFAULTS, ...(config ?? {}) };
	const rootDir = cfg.rootDir ? path.resolve(String(cfg.rootDir)) : path.join(os.homedir(), ".dsh", "ctf-auto");
	fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(rootDir, 0o700); } catch { /* Windows/ACL 环境可能不支持 */ }
	const statePath = path.join(rootDir, "state.json");

	function writePrivateJson(file, value) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			fs.renameSync(tmp, file);
			try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
		} catch (error) {
			try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
			throw error;
		}
		return value;
	}

	const store = createStore(statePath, { rootDir });
	if (store.state.rootDir !== rootDir) { store.state.rootDir = rootDir; store.save(); }

	// ── 平台接入配置（CTFd）：<rootDir>/platform.json 本地明文持久化 ─────────
	const platformPath = path.join(rootDir, "platform.json");
	function readPlatformConfig() {
		try {
			const raw = JSON.parse(fs.readFileSync(platformPath, "utf8"));
			return {
				kind: typeof raw.kind === "string" && raw.kind ? raw.kind : "ctfd",
				baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
				apiToken: typeof raw.apiToken === "string" ? raw.apiToken : "",
				mcpUrl: typeof raw.mcpUrl === "string" ? raw.mcpUrl : "",
				platformSlug: typeof raw.platformSlug === "string" ? raw.platformSlug : "",
				profile: raw.profile && typeof raw.profile === "object" ? raw.profile : null
			};
		} catch {
			return { kind: "ctfd", baseUrl: "", apiToken: "", platformSlug: "", mcpUrl: "", profile: null };
		}
	}
	function writePlatformConfig(next) {
		return writePrivateJson(platformPath, next);
	}
	function platformView(cfg) {
		return {
			kind: cfg.kind,
			baseUrl: cfg.baseUrl,
			platformSlug: cfg.platformSlug || "",
			mcpUrl: cfg.mcpUrl || "",
			tokenSet: !!cfg.apiToken,
			tokenHint: cfg.apiToken ? cfg.apiToken.slice(-4) : "",
			profile: cfg.profile || null
		};
	}
	/** 按 kind 构造平台客户端；dasctf 支持环境变量 CTF2_AGENT_TOKEN 与默认 base。 */
	function platformClientFromCfg(cfg) {
		const kind = String((cfg && cfg.kind) || "ctfd");
		const envToken = kind === "dasctf" ? String(process.env.CTF2_AGENT_TOKEN || "").trim() : "";
		const token = String((cfg && cfg.apiToken) || "").trim() || envToken;
		const rawBase = String((cfg && cfg.baseUrl) || "").trim() || (kind === "dasctf" ? DASCTF_DEFAULT_BASE : "");
		const baseUrl = kind === "dasctf" ? rawBase.replace(/\/+$/, "") : normalizeBaseUrl(rawBase);
		const platformSlug = String((cfg && cfg.platformSlug) || "").trim();
		const profile = cfg && cfg.profile && typeof cfg.profile === "object" ? cfg.profile : {};
		if (!token) return { kind, token: "", baseUrl, platformSlug, client: null, error: kind === "dasctf" ? "未配置 CTF2_AGENT_TOKEN" : "未配置 API Token" };
		if (!baseUrl) return { kind, token, baseUrl, platformSlug, client: null, error: "平台地址为空" };
		let client;
		if (kind === "dasctf") client = createDasctfMcpPlatform({ origin: baseUrl || DASCTF_DEFAULT_BASE, mcpUrl: String((cfg && cfg.mcpUrl) || "") || dasctfDefaultMcpUrl(baseUrl || DASCTF_DEFAULT_BASE), token, fetchImpl: globalThis.fetch });
		else if (kind === "generic") client = createGenericPlatformClient({ baseUrl, token, profile, fetchImpl: globalThis.fetch });
		else client = createCtfdClient({ baseUrl, token, fetchImpl: globalThis.fetch });
		return { kind, token, baseUrl, platformSlug, client, error: "" };
	}

	function platformClientOrNull() {
		const cfg = readPlatformConfig();
		const built = platformClientFromCfg(cfg);
		if (!built.client) return null;
		return { cfg, client: built.client, kind: built.kind, baseUrl: built.baseUrl };
	}

	// ── 运行时配置：<rootDir>/config.json 覆盖 patch row 默认值（面板「设置」页可改）──
	const configPath = path.join(rootDir, "config.json");
	const RUNTIME_KEYS = ["concurrency", "timeoutMs", "maxAttempts", "autoRetry", "solverPreset", "solverModel", "escalateModel", "wrapupRatio", "wrapupGraceMs", "flagPatterns", "minEvidenceChars", "reviewerEnabled", "memoryTopK", "memoryMinScore", "autoDistill", "knowledgeTopK", "knowledgeMinScore", "pricePerMToken", "autoFetchEnabled", "autoFetchIntervalMs", "autoFetchLimit", "autoSolveImported", "autoSubmitEnabled"];

	function clampRuntime(patch) {
		const out = {};
		const diagnostics = [];
		const p = patch && typeof patch === "object" ? patch : {};
		const int = (key, min, max) => {
			if (p[key] === undefined) return;
			const v = Number(p[key]);
			if (!Number.isFinite(v)) { diagnostics.push(key + " 非数字，已忽略"); return; }
			out[key] = Math.round(Math.min(max, Math.max(min, v)));
		};
		int("concurrency", 1, 8);
		int("timeoutMs", 60000, 4 * 60 * 60 * 1000);
		int("maxAttempts", 1, 10);
		int("wrapupGraceMs", 0, 600000);
		if (p.autoRetry !== undefined) out.autoRetry = !!p.autoRetry;
		for (const key of ["solverPreset", "solverModel", "escalateModel"]) {
			if (p[key] === undefined) continue;
			out[key] = String(p[key]).slice(0, 120);
		}
		if (p.wrapupRatio !== undefined) {
			const v = Number(p.wrapupRatio);
			if (Number.isFinite(v)) out.wrapupRatio = Math.min(0.95, Math.max(0.5, v));
			else diagnostics.push("wrapupRatio 非数字，已忽略");
		}
		int("minEvidenceChars", 0, 200);
		if (p.reviewerEnabled !== undefined) out.reviewerEnabled = !!p.reviewerEnabled;
		if (p.autoDistill !== undefined) out.autoDistill = !!p.autoDistill;
		int("memoryTopK", 1, 10);
		int("knowledgeTopK", 1, 10);
		int("autoFetchIntervalMs", 60000, 24 * 60 * 60 * 1000);
		int("autoFetchLimit", 1, 50);
		for (const key of ["autoFetchEnabled", "autoSolveImported", "autoSubmitEnabled"]) {
			if (p[key] !== undefined) out[key] = !!p[key];
		}
		if (p.pricePerMToken !== undefined) {
			const price = Number(p.pricePerMToken);
			if (Number.isFinite(price)) out.pricePerMToken = Math.min(1000, Math.max(0, price));
			else diagnostics.push("pricePerMToken 非数字，已忽略");
		}
			if (p.knowledgeMinScore !== undefined) {
				const kscore = Number(p.knowledgeMinScore);
				if (Number.isFinite(kscore)) out.knowledgeMinScore = Math.min(0.9, Math.max(0.01, kscore));
				else diagnostics.push("knowledgeMinScore 非数字，已忽略");
			}
			if (p.memoryMinScore !== undefined) {
			const score = Number(p.memoryMinScore);
			if (Number.isFinite(score)) out.memoryMinScore = Math.min(0.9, Math.max(0.01, score));
			else diagnostics.push("memoryMinScore 非数字，已忽略");
		}
		if (p.flagPatterns !== undefined) {
			if (Array.isArray(p.flagPatterns)) out.flagPatterns = p.flagPatterns.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
			else diagnostics.push("flagPatterns 需要字符串数组，已忽略");
		}
		return { next: out, diagnostics };
	}

	function readRuntimeConfig() {
		try {
			const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
			return clampRuntime(raw).next;
		} catch { return {}; }
	}

	function writeRuntimeConfig(patch) {
		const next = { ...readRuntimeConfig(), ...(patch && typeof patch === "object" ? patch : {}) };
		return writePrivateJson(configPath, next);
	}

	function configView() {
		return {
			concurrency: Number(cfg.concurrency),
			timeoutMs: Number(cfg.timeoutMs),
			maxAttempts: Number(cfg.maxAttempts),
			autoRetry: cfg.autoRetry !== false,
			solverPreset: String(cfg.solverPreset ?? ""),
			solverModel: String(cfg.solverModel ?? ""),
			escalateModel: String(cfg.escalateModel ?? ""),
			wrapupRatio: Number(cfg.wrapupRatio ?? 0.8),
			wrapupGraceMs: Number(cfg.wrapupGraceMs ?? 120000),
			flagPatterns: Array.isArray(cfg.flagPatterns) ? cfg.flagPatterns.slice(0, 20) : [],
			minEvidenceChars: Number(cfg.minEvidenceChars ?? 12),
			reviewerEnabled: cfg.reviewerEnabled === true,
			memoryTopK: Number(cfg.memoryTopK ?? 3),
			memoryMinScore: Number(cfg.memoryMinScore ?? 0.3),
			knowledgeTopK: Number(cfg.knowledgeTopK ?? 3),
			knowledgeMinScore: Number(cfg.knowledgeMinScore ?? 0.08),
			pricePerMToken: Number(cfg.pricePerMToken ?? 2),
			autoFetchEnabled: cfg.autoFetchEnabled === true,
			autoFetchIntervalMs: Number(cfg.autoFetchIntervalMs ?? 300000),
			autoFetchLimit: Number(cfg.autoFetchLimit ?? 5),
			autoSolveImported: cfg.autoSolveImported !== false,
			autoSubmitEnabled: cfg.autoSubmitEnabled !== false,
			autoDistill: cfg.autoDistill !== false,
			rootDir
		};
	}

	function applyRuntimeConfig(patch) {
		const { next, diagnostics } = clampRuntime(patch);
		Object.assign(cfg, next);
		writeRuntimeConfig(next);
		try {
			if (typeof orchestrator !== "undefined") orchestrator.setConfig(next);
		} catch (e) { diagnostics.push("应用编排配置失败：" + String((e && e.message) || e)); }
		return { ok: true, config: configView(), diagnostics };
	}

	// config.json 覆盖 row 默认值（rootDir 除外）
	Object.assign(cfg, readRuntimeConfig());

	// ── 注册本插件自己的 Agent 模式（preset）──────────────────────────────
	// 目标是模式入口体验：新建会话的模式 chip 里出现「CTF 自动解题」。
	// agentPresets 服务在 profile 装配期可能晚于本插件就绪，故立即尝试 + 短重试。
	const presetState = {
		id: PRESET_ID,
		name: PRESET_NAME,
		registered: false,
		error: "",
		skillDirs: 0,
		skillSourceDir: "",
		dispose: null
	};
	let presetAttempted = false;
	function tryRegisterPreset() {
		if (presetAttempted) return true;
		let presets;
		try { presets = ctx.get("agentPresets"); } catch { presets = undefined; }
		if (!presets || typeof presets.register !== "function") return false;
		presetAttempted = true;
		try {
			const skillSourceDir = resolveSkillSourceDir();
			presetState.skillSourceDir = skillSourceDir ?? "";
			const { definition, skillDirs } = buildPresetDefinition({ skillSourceDir });
			presetState.skillDirs = skillDirs.length;
			presets.register(definition).then((dispose) => {
				presetState.registered = true;
				presetState.dispose = dispose;
				try { console.error(`[dsh-ctf-auto] preset "${PRESET_ID}" registered（技能目录 ${skillDirs.length} 个）`); } catch { /* noop */ }
			}).catch((e) => {
				presetState.error = String(e?.message ?? e);
				try { console.error(`[dsh-ctf-auto] preset "${PRESET_ID}" 注册失败：${presetState.error}`); } catch { /* noop */ }
			});
		} catch (e) {
			presetState.error = String(e?.message ?? e);
		}
		return true;
	}
	tryRegisterPreset();
	ctx.effect(() => {
		const timer = setInterval(() => {
			if (!presetState.registered && !presetState.error && !tryRegisterPreset()) return;
			clearInterval(timer);
		}, 500);
		if (typeof timer.unref === "function") timer.unref();
		return () => {
			clearInterval(timer);
			try { presetState.dispose?.(); } catch { /* noop */ }
		};
	}, "dsh-ctf-auto: preset");

	// ── 子代理派发端口 ─────────────────────────────────────────────────────
	/** 题目 → 驱动 Agent（发起 ctf_solve_start 的会话；面板启动时退化为任意 live root）。 */
	const driverByChallenge = new Map();
	let lastDriver = null;
	// 最近一次带 sessionId 的面板请求所属会话（派发只允许该会话，见 A+B 隔离）
	let lastPanelSessionId = "";
	// 最近一次请求到的工作区（无 sessionId 的请求回退用）
	let lastWorkspace = "";

	const agentsService = () => { try { return ctx.get("agents"); } catch { return undefined; } };
	const subagentsService = () => { try { return ctx.get("subagents"); } catch { return undefined; } };
	const agentPresetsService = () => { try { return ctx.get("agentPresets"); } catch { return undefined; } };

	// 兼容旧数据：全局目录下、无 workspace 的题目，按驱动会话 cwd 归位到工作区（首次访问时归位一次）
	let legacyWorkspacesMigrated = false;
	function migrateLegacyWorkspaces() {
		if (legacyWorkspacesMigrated) return;
		legacyWorkspacesMigrated = true;
		try {
			for (const c of store.list()) {
				if (!c || c.workspace) continue;
				const wsFromDir = workspaceFromDir(c.dir);
				if (wsFromDir) { store.update(c.id, { workspace: wsFromDir }); continue; }
				const sid = c.driverSession ? String(c.driverSession) : "";
				if (!sid) continue;
				const agent = agentOfSession(sid);
				const cwd = agent ? normalizeWorkspace(agent?.session?.header?.cwd ?? "") : "";
				if (cwd) store.update(c.id, { workspace: cwd });
			}
		} catch { /* 归位失败不影响请求 */ }
	}

	function presetOf(agent) {
		try {
			const presets = agentPresetsService();
			const id = presets?.composedPreset?.(agent?.ctx);
			return typeof id === "string" ? id : "";
		} catch { return ""; }
	}

	/** 父会话候选排序：显式调用者 > 上次成功的 > ctf-auto 模式 > 最近更新的 live root 会话。 */
	function candidateParents(challenge) {
		const agents = agentsService();
		let roots = [];
		try { roots = agents?.roots?.() ?? []; } catch { roots = []; }
		const live = roots.filter((a) => {
			try { return !!agents?.get?.(a.id); } catch { return false; }
		});
		const score = (a) => {
			let t = 0;
			try { t = Number(a?.session?.header?.updatedAt ?? a?.session?.header?.createdAt ?? 0) || 0; } catch { t = 0; }
			let bonus = 0;
			try { if (presetOf(a) === "ctf-auto") bonus = 1e15; } catch { /* ignore */ }
			return bonus + t;
		};
		live.sort((a, b) => score(b) - score(a));
		const out = [];
		const push = (agent) => {
			if (!agent) return;
			try { if (out.some((item) => String(item.id) === String(agent.id))) return; } catch { return; }
			out.push(agent);
		};
		if (challenge) push(driverByChallenge.get(challenge.id));
		push(lastDriver);
		live.forEach(push);
		return out;
	}

	/** 面板/定时器没有 exec.agent：取候选里的第一个（live root 会话）。 */
	function pickPanelAgent() {
		return candidateParents()[0];
	}

	/** 题目归属会话的 Agent（优先 driverSession；不存在则视为无归属）。 */
	function ownerAgentOf(challenge) {
		const sid = String((challenge && challenge.driverSession) || "");
		if (!sid) return undefined;
		return agentOfSession(sid) ?? driverByChallenge.get(challenge.id);
	}

	/** 最近一次带 sessionId 的面板请求所属 Agent；没有则不回退其他会话。 */
	function panelSessionAgent() {
		if (!lastPanelSessionId) return undefined;
		return agentOfSession(lastPanelSessionId);
	}

	function agentOfSession(sessionId) {
		const sid = String(sessionId ?? "");
		if (!sid) return undefined;
		const agents = agentsService();
		try { return agents?.get?.(sid); } catch { return undefined; }
	}

	function driverOf(challengeId) {
		const candidates = candidateParents(store.get(challengeId) || null);
		const first = candidates[0];
		if (first) driverByChallenge.set(challengeId, first);
		return first;
	}

	function contentText(blocks) {
		if (!Array.isArray(blocks)) return "";
		return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
	}

	/**
	 * spawn 端口实现：把一次「尝试」派成 DSH 子代理。
	 * 父会话按候选顺序尝试：某些陈旧/失效的 root 会话会立刻返回 refusal（无任何输出），
	 * 此时自动换下一个父会话重派，而不是把整次尝试判死。
	 * 返回 handle：{ sessionId, done: Promise<{stopReason, outputText, sessionId, error?}>, interrupt(), send(content) }
	 */
	// 插件 reload 后 preset 注册是异步的：派发前等它就绪，避免 Unknown agent preset。
	function waitPresetReady(timeoutMs = 5000) {
		if (presetState.registered) return Promise.resolve(true);
		return new Promise((resolve) => {
			const startedAt = Date.now();
			const timer = setInterval(() => {
				if (presetState.registered || Date.now() - startedAt >= timeoutMs) {
					clearInterval(timer);
					resolve(presetState.registered);
				}
			}, 100);
			if (typeof timer.unref === "function") timer.unref();
		});
	}

	/** reload 竞态兜底：旧实例 disposer 可能删掉新注册的 preset，巡检发现缺失则重注册。 */
	async function ensurePresetPresence() {
		if (!presetState.registered) return;
		const svc = agentPresetsService();
		if (!svc || typeof svc.list !== "function") return;
		try {
			const list = await svc.list();
			if ((list || []).some((item) => String(item && item.id) === PRESET_ID)) return;
		} catch { return; }
		try { presetState.dispose?.(); } catch { /* ignore */ }
		presetState.registered = false;
		presetState.error = "";
		presetAttempted = false;
		tryRegisterPreset();
		try { store.addEvent("", "note", "preset 注册表丢失，已重新注册 ctf-auto"); } catch { /* ignore */ }
	}


	function spawnAttempt(request) {
		const sub = subagentsService();
		const challenge = request?.challenge;
		const allCandidates = challenge ? candidateParents(challenge) : candidateParents();
		const owner = challenge ? ownerAgentOf(challenge) : undefined;
		const panel = panelSessionAgent();
		const candidates = owner ? [owner] : (panel ? [panel] : []);
		let parent = candidates[0];
		let sessionId = "";
		let cancelled = false;
		let settled = false;

		const interruptChild = (reason) => {
			if (!sessionId) return;
			try { sub?.interrupt?.(sessionId, { kind: "ancestor", agent: parent }); } catch { /* 已结束/无权限 */ }
			if (challenge) store.addEvent(challenge.id, "note", `中断子代理（${reason}）`, { sessionId });
		};

		const handle = {
			sessionId: "",
			interrupt() { cancelled = true; interruptChild("interrupt"); }
		};
		// 预算结算：向运行中的子代理注入一条收尾消息（orchestrator 在 wrapup 阶段调用）
		handle.send = (content) => {
			try {
				const svc = subagentsService();
				if (!svc || typeof svc.sendMessage !== "function" || !sessionId || !parent) return Promise.resolve(false);
				const body = [{ type: "text", text: String(content ?? "") }];
				return Promise.resolve(svc.sendMessage(parent, sessionId, body, {})).then(() => true).catch(() => false);
			} catch { return Promise.resolve(false); }
		};

		handle.done = (async () => {
			await waitPresetReady(5000);
			if (!sub?.startActivation) {
				return { stopReason: "error", outputText: "", sessionId: "", error: "subagents 服务不可用：宿主未暴露子代理注册表" };
			}
			if (candidates.length === 0) {
				return { stopReason: "error", outputText: "", sessionId: "", error: "没有归属会话/当前会话可用于派发（已禁用跨会话借用）：请在该题所属会话中启动" };
			}
			const model = (() => {
				const n = request && request.attempt ? Number(request.attempt.n) : 0;
				return n >= 2 && cfg.escalateModel ? String(cfg.escalateModel) : (cfg.solverModel ? String(cfg.solverModel) : "");
			})();
			let lastError = "";
			for (let i = 0; i < candidates.length; i += 1) {
				const candidate = candidates[i];
				if (cancelled) return { stopReason: "aborted", outputText: "", sessionId, error: "已取消" };
				parent = candidate;
				try {
					const activationArgs = {
							provider: "spawn",
							label: request.label,
							request: {
								prompt: [{ type: "text", text: request.prompt }],
								parent: candidate,
								cwd: request.cwd,
								...(request.agentPreset ? { agentPreset: String(request.agentPreset) } : {}),
								...(model ? { agentOptions: { model } } : {})
							},
							signal: request.signal,
							delivery: "parent"
					};
					let activation;
					try {
						activation = await sub.startActivation(activationArgs);
					} catch (presetError) {
						const message = String((presetError && presetError.message) || presetError);
						if (!/unknown agent preset/i.test(message)) throw presetError;
						const available = (() => { try { return JSON.stringify(presetError?.data?.available ?? presetError?.context?.available ?? []); } catch { return "[]"; } })();
						if (challenge) store.addEvent(challenge.id, "note", `agent preset 未注册（available=${available}）：尝试重新注册后重派`, { sessionId });
						try { presetState.dispose?.(); } catch { /* ignore */ }
						presetState.registered = false;
						presetState.error = "";
						presetAttempted = false;
						tryRegisterPreset();
						const readyAgain = await waitPresetReady(3000);
						const fallbackArgs = { ...activationArgs, request: { ...activationArgs.request } };
						delete fallbackArgs.request.agentPreset;
						if (readyAgain) {
							try {
								activation = await sub.startActivation(activationArgs);
							} catch (retryError) {
								if (challenge) store.addEvent(challenge.id, "note", `重注册后仍失败（${String((retryError && retryError.message) || retryError)}），回退默认 preset`, { sessionId });
								activation = await sub.startActivation(fallbackArgs);
							}
						} else {
							if (challenge) store.addEvent(challenge.id, "note", "preset 重注册超时，回退默认 preset 派发", { sessionId });
							activation = await sub.startActivation(fallbackArgs);
						}
					}
					sessionId = String(activation?.childId ?? "");
					handle.sessionId = sessionId;
					if (challenge && sessionId) childSessionChallenge.set(String(sessionId), challenge.id);
					if (cancelled) interruptChild("cancelled-before-run");
					const result = await activation.result;
					settled = true;
					const outText = contentText(result?.output);
					const stopReason = String(result?.stopReason ?? "completed");
					const deadOnArrival = (stopReason === "refusal" || stopReason === "error" || stopReason === "blocked") && !outText;
					if (deadOnArrival && i < candidates.length - 1) {
						if (challenge) store.addEvent(challenge.id, "note", `父会话 ${String(candidate.id)} 派发即 ${stopReason}（无输出），换下一个父会话重试`, { sessionId });
						try { await sub.interrupt?.(sessionId, { kind: "ancestor", agent: candidate }); } catch { /* ignore */ }
						continue;
					}
					lastDriver = candidate;
					if (challenge) driverByChallenge.set(challenge.id, candidate);
					if (challenge && stopReason !== "completed" && outText) {
						store.addEvent(challenge.id, "note", `子代理结束：${stopReason}，输出 ${outText.length} 字符`, { sessionId });
					}
					return { stopReason, outputText: outText, sessionId, diagnostic: result?.diagnostic };
				} catch (e) {
					lastError = String((e && e.message) || e);
					if (cancelled) return { stopReason: "aborted", outputText: "", sessionId, error: lastError };
					if (challenge) store.addEvent(challenge.id, "error", `父会话 ${String(candidate.id)} 派发失败：${lastError.slice(0, 200)}`, { sessionId });
				}
			}
			return { stopReason: "error", outputText: "", sessionId, error: lastError || "所有父会话都无法派发子代理" };
		})();

		return handle;
	}

	// ── 编排器 ─────────────────────────────────────────────────────────────
	const orchestrator = createOrchestrator({
		store,
		spawn: spawnAttempt,
		config: {
			concurrency: Number(cfg.concurrency) || DEFAULTS.concurrency,
			timeoutMs: Number(cfg.timeoutMs) || DEFAULTS.timeoutMs,
			maxAttempts: Number(cfg.maxAttempts) || DEFAULTS.maxAttempts,
			autoRetry: cfg.autoRetry !== false,
			solverPreset: cfg.solverPreset,
			extraFlagsRe: cfg.flagReExtra,
			wrapupRatio: Number(cfg.wrapupRatio ?? 0.8),
			wrapupGraceMs: Number(cfg.wrapupGraceMs ?? 120000),
			pricePerMToken: Number(cfg.pricePerMToken ?? 2)
		},
		logger: (msg) => { try { console.error(`[dsh-ctf-auto] ${msg}`); } catch { /* noop */ } },
		recall: recallFor,
		onMemoriesUsed: bumpMemoryUsage,
		onKnowledgeUsed: bumpKnowledgeUsage
	});

	// 进程重启后先收口遗留任务；等 root session 可用时再恢复队列，避免在服务尚未装配时把子代理派发失败。
	let recoveryDone = false;
	function recoverScheduler() {
		if (recoveryDone) return null;
		const recovered = orchestrator.recover();
		const hasQueued = store.list().some((challenge) => challenge && challenge.status === "queued");
		if (recovered.recovered.length === 0 && !hasQueued) {
			recoveryDone = true;
			return recovered;
		}
		if (!subagentsService()?.startActivation) return recovered;
		if (candidateParents().length === 0) return recovered;
		recoveryDone = true;
		const started = orchestrator.pump();
		return { ...recovered, started };
	}
	try { recoverScheduler(); } catch (e) { console.error(`[dsh-ctf-auto] recovery failed: ${e?.message ?? e}`); }

	// ── 题目创建/启动/停止/重试 ──────────────────────────────────────────
	function statementMarkdown(ch) {
		const lines = [`# ${ch.title}`, ""];
		if (ch.category) lines.push(`- 模块：${ch.category}`);
		if (ch.target) lines.push(`- 目标：${ch.target}`);
		if (ch.platform) lines.push(`- 平台：${JSON.stringify(ch.platform)}`);
		lines.push("", "## 题面", "", ch.statement || "（未提供题面）", "");
		if (ch.files?.length) {
			lines.push("## 附件", "");
			for (const f of ch.files) lines.push(`- ${f.name}${f.path ? ` → \`${f.path}\`` : f.url ? ` → ${f.url}` : ""}`);
			lines.push("");
		}
		lines.push("## 工作区协议", "",
			"- 只在本题目录内读写：`notes.md`（发现/假设/结论随做随记）、`scripts/`、`artifacts/`、`files/`；",
			"- 验证通过的 flag 写 `flag.json`：`{\"flag\":\"...\",\"evidence\":\"...\",\"verified\":true}`；",
			"- 完成后必须调用 `ctf_flag_record`（id, flag, evidence, verified, method）登记；未解也要写清卡点与已试路径。", "");
		return lines.join("\n");
	}

	function prepareFiles(ch, rawFiles) {
		const kept = [];
		const dirs = ["files", "scripts", "artifacts"];
		for (const d of dirs) fs.mkdirSync(path.join(ch.dir, d), { recursive: true });
		for (const raw of rawFiles ?? []) {
			const value = String(raw ?? "").trim();
			if (!value) continue;
			if (/^https?:\/\//i.test(value)) {
				let base = value;
				try { base = path.basename(new URL(value).pathname) || value; } catch { /* keep */ }
				kept.push({ name: base, path: "", source: "url", url: value });
				continue;
			}
			const abs = path.resolve(value);
			try {
				const st = fs.statSync(abs);
				if (st.isFile() && st.size <= Number(cfg.maxFileCopyBytes)) {
					const dest = path.join(ch.dir, "files", path.basename(abs));
					fs.copyFileSync(abs, dest);
					try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
					kept.push({ name: path.basename(abs), path: dest, source: "user" });
				} else {
					kept.push({ name: path.basename(abs), path: abs, source: "user" });
				}
			} catch {
				kept.push({ name: path.basename(abs), path: abs, source: "user", missing: true });
			}
		}
		return kept;
	}

	function baseDirOf(exec) {
		let cwd = "";
		try { cwd = exec?.agent?.session?.header?.cwd ?? ""; } catch { cwd = ""; }
		if (!cwd) {
			const panelAgent = pickPanelAgent();
			try { cwd = panelAgent?.session?.header?.cwd ?? ""; } catch { cwd = ""; }
		}
		// 题目工作区放在「驱动会话所在工作区」的 .ctf-auto/ 下：子代理的写工具沙箱根与工作区一致，
		// 产物也跟随用户项目可见/可备份；没有可用会话时回落到全局 rootDir。
		return cwd ? path.join(cwd, ".ctf-auto") : rootDir;
	}

	// ── 工作区隔离：题板以工作区（会话 cwd）为单位，不同工作区数据不互通 ──────
	function normalizeWorkspace(value) {
		try { return value ? path.resolve(String(value)) : ""; } catch { return ""; }
	}
	function workspaceFromDir(dir) {
		const d = normalizeWorkspace(dir);
		if (!d) return "";
		const marker = path.sep + ".ctf-auto" + path.sep;
		const idx = d.indexOf(marker);
		return idx > 0 ? d.slice(0, idx) : "";
	}
	function challengeWorkspace(ch) {
		if (!ch) return "";
		const explicit = ch.workspace ? normalizeWorkspace(ch.workspace) : "";
		return explicit || workspaceFromDir(ch.dir);
	}
	function sameWorkspace(a, b) {
		const x = normalizeWorkspace(a).toLowerCase();
		const y = normalizeWorkspace(b).toLowerCase();
		return !!x && !!y && x === y;
	}
	function workspaceOfExec(exec) {
		try {
			const cwd = normalizeWorkspace(exec?.agent?.session?.header?.cwd ?? "");
			// 子代理 cwd 可能是题目录（工作区内 .ctf-auto/<slug>）：回溯到工作区根
			return workspaceFromDir(cwd) || cwd;
		} catch { return ""; }
	}
	function workspaceForRequest(payload) {
		const sid = payload && payload.sessionId ? String(payload.sessionId) : "";
		if (sid) {
			const agent = agentOfSession(sid);
			try { const cwd = normalizeWorkspace(agent?.session?.header?.cwd ?? ""); if (cwd) return cwd; } catch { /* ignore */ }
		}
		const last = lastWorkspace;
		if (last) return last;
		const panel = pickPanelAgent();
		try { return normalizeWorkspace(panel?.session?.header?.cwd ?? ""); } catch { return ""; }
	}
	function workspaceKey(workspace) {
		const ws = normalizeWorkspace(workspace);
		if (!ws) return "global";
		return "ws" + crypto.createHash("sha256").update(ws.toLowerCase()).digest("hex").slice(0, 8);
	}
	function visibleChallenges(workspace) {
		const all = store.list();
		const ws = normalizeWorkspace(workspace);
		if (!ws) return all;
		return all.filter((c) => sameWorkspace(challengeWorkspace(c), ws));
	}
	function panelWriteDenied(payload, id) {
		const ch = store.get(String(id ?? ""));
		if (!ch) return { ok: false, error: `题目不存在：${id ?? ""}` };
		const ws = workspaceForRequest(payload);
		if (!ws) return payload?.sessionId
			? { ok: false, error: "当前会话不存在或没有可用工作目录" }
			: null;
		if (!sameWorkspace(challengeWorkspace(ch), ws)) {
			return { ok: false, error: "该题目不属于当前工作区；全部工作区视图只允许只读查看" };
		}
		return null;
	}

	function addChallenge(input, baseDir) {
		const title = String(input?.title ?? "").trim();
		if (!title) throw new Error("title 必填");
		const statement = String(input.statement ?? "");
		if (Buffer.byteLength(statement, "utf8") > MAX_STATEMENT_BYTES) {
			throw new Error(`题面超过上限（${MAX_STATEMENT_BYTES} 字节）`);
		}
		const rawFiles = Array.isArray(input.files) ? input.files : [];
		if (rawFiles.length > MAX_FILES_PER_CHALLENGE) {
			throw new Error(`附件数量超过上限（${MAX_FILES_PER_CHALLENGE} 个）`);
		}
		const ch = store.addChallenge({
			title,
			category: input.category ? String(input.category) : "",
			statement,
			target: input.target ? String(input.target) : "",
			platform: input.platform ?? null,
			dirBase: baseDir || baseDirOf(),
			maxAttempts: Number(input.maxAttempts) > 0 ? Number(input.maxAttempts) : undefined,
			timeBudgetMs: Number(input.timeBudgetMinutes) > 0 ? Number(input.timeBudgetMinutes) * 60 * 1000 : undefined
		});
		const challengeRoot = baseDir ? path.dirname(path.resolve(baseDir)) : "";
		if (challengeRoot) store.update(ch.id, { workspace: challengeRoot });
		fs.mkdirSync(ch.dir, { recursive: true, mode: 0o700 });
		const autoRoot = path.dirname(ch.dir);
		if (path.basename(autoRoot) === ".ctf-auto") {
			const ignoreFile = path.join(autoRoot, ".gitignore");
			try { if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, "*\n", { encoding: "utf8", mode: 0o600 }); } catch { /* ignore */ }
		}
		const files = prepareFiles(ch, rawFiles);
		store.update(ch.id, { files });
		fs.writeFileSync(path.join(ch.dir, "statement.md"), statementMarkdown({ ...ch, files }), { encoding: "utf8", mode: 0o600 });
		fs.writeFileSync(path.join(ch.dir, "notes.md"), `# ${ch.title} — 解题笔记\n\n（随做随记：发现 / 假设 / 验证 / 卡点）\n`, { encoding: "utf8", mode: 0o600 });
		store.addEvent(ch.id, "queued", "题目已登记入队");
		return ch;
	}

	/** 一键开始：批量把当前题板（或指定 ids）的未解题加入调度队列；dryRun 只返回候选。 */
	function startChallenges(payload) {
		const parent = agentOfSession(payload.sessionId) ?? pickPanelAgent();
		const ws = workspaceForRequest(payload);
		const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => String(id ?? "")).filter(Boolean) : [];
		const pool = ids.length ? ids.map((id) => store.get(id)).filter(Boolean) : store.list();
		const onlyMine = payload.onlyMine === true;
		const mineSid = String(payload.sessionId ?? "");
		const candidates = pool.filter((ch) => {
			if (!ch || ch.status === "solved" || ch.status === "running") return false;
			if (onlyMine && mineSid && ch.driverSession && String(ch.driverSession) !== mineSid) return false;
			return true;
		});
		const denied = [];
		const skipped = [];
		const startable = [];
		for (const ch of candidates) {
			if (ws && !sameWorkspace(challengeWorkspace(ch), ws)) { denied.push({ id: ch.id, title: ch.title }); continue; }
			startable.push(ch);
		}
		if (payload.dryRun === true) return { ok: true, dryRun: true, candidates: startable.map((ch) => ({ id: ch.id, title: ch.title, status: ch.status })), denied, skipped };
		if (!parent) return { ok: false, error: "没有可用会话：请先打开/创建一个会话（解题子代理需要父会话）" };
		const started = [];
		for (const ch of startable) {
			try {
				if (payload.sessionId) store.update(ch.id, { driverSession: String(payload.sessionId) });
				const res = startChallenge(ch.id, parent);
				if (res.ok) started.push({ id: ch.id, title: ch.title, status: res.status });
				else skipped.push({ id: ch.id, title: ch.title, reason: res.error || "未开始" });
			} catch (e) { skipped.push({ id: ch.id, title: ch.title, reason: String((e && e.message) || e) }); }
		}
		return { ok: true, started, skipped, denied, candidates: candidates.length };
	}

	/** 一键停止：停止当前题板（或指定 ids）中运行/排队的题。 */
	function stopChallenges(payload) {
		const ws = workspaceForRequest(payload);
		const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => String(id ?? "")).filter(Boolean) : [];
		const pool = ids.length ? ids.map((id) => store.get(id)).filter(Boolean) : store.list();
		const onlyMine = payload.onlyMine === true;
		const mineSid = String(payload.sessionId ?? "");
		const targets = pool.filter((ch) => {
			if (!ch || (ch.status !== "running" && ch.status !== "queued")) return false;
			if (onlyMine && mineSid && ch.driverSession && String(ch.driverSession) !== mineSid) return false;
			return true;
		});
		const stopped = [];
		const denied = [];
		for (const ch of targets) {
			if (ws && !sameWorkspace(challengeWorkspace(ch), ws)) { denied.push({ id: ch.id, title: ch.title }); continue; }
			try { stopChallenge(ch.id); stopped.push({ id: ch.id, title: ch.title }); } catch { /* ignore */ }
		}
		return { ok: true, stopped, denied, candidates: targets.length };
	}

	function startChallenge(id, parentAgent) {
		const ch = store.get(id);
		if (!ch) return { ok: false, error: `题目不存在：${id}` };
		if (parentAgent) { driverByChallenge.set(ch.id, parentAgent); lastDriver = parentAgent; }
		if (ch.status === "running" && orchestrator.isRunning(ch.id)) return { ok: true, status: ch.status, note: "已在运行" };
		if (ch.status === "solved") return { ok: false, error: "该题已解（flag 已登记）" };
		orchestrator.start(ch.id, { agentPreset: cfg.solverPreset });
		return { ok: true, status: store.get(ch.id)?.status ?? "queued" };
	}

	function stopChallenge(id) {
		const ch = store.get(id);
		if (!ch) return { ok: false, error: `题目不存在：${id}` };
		orchestrator.stop(ch.id);
		return { ok: true, status: store.get(ch.id)?.status ?? ch.status };
	}

	function retryChallenge(id, hint) {
		const ch = store.get(id);
		if (!ch) return { ok: false, error: `题目不存在：${id}` };
		if (ch.status === "solved") return { ok: false, error: "该题已解，无需重试" };
		orchestrator.retry(ch.id, hint);
		return { ok: true, status: store.get(ch.id)?.status ?? "queued" };
	}

	function recordFlag(input, options = {}) {
		const id = String(input?.id ?? "").trim();
		const ch = id ? store.get(id) : undefined;
		if (!ch) return { ok: false, error: `题目不存在：${id || "(未提供 id)"}` };
		const value = String(input.flag ?? "").trim();
		if (!value) return { ok: false, error: "flag 不能为空" };
		if (value.length > MAX_FLAG_CHARS) return { ok: false, error: `flag 过长（>${MAX_FLAG_CHARS} 字符）` };
		const evidence = String(input.evidence ?? "");
		if (evidence.length > MAX_EVIDENCE_CHARS) return { ok: false, error: `evidence 过长（>${MAX_EVIDENCE_CHARS} 字符）` };
		const wantVerified = input.verified === true;
		const method = String(input.method ?? "manual");
		let verified = wantVerified;
		let downgrade = "";
		if (wantVerified && method === "platform" && options.allowPlatformVerification !== true) {
			verified = false;
			downgrade = "platform 验证只能由宿主平台提交回显产生";
		} else if (wantVerified && method !== "platform") {
			const check = validateVerifiedFlag(value, {
				patterns: Array.isArray(cfg.flagPatterns) ? cfg.flagPatterns : [],
				evidence,
				minEvidenceChars: Number(cfg.minEvidenceChars ?? 12)
			});
			if (!check.ok) { verified = false; downgrade = check.message; }
		}
		const runningAttempt = (ch.attempts ?? []).find((a) => a.status === "running");
		const flag = store.addFlag(ch.id, {
			value,
			verified,
			evidence,
			method,
			attempt: runningAttempt?.n ?? (ch.attempts?.length || undefined)
		});
		if (!flag) return { ok: false, error: "flag 数量已达上限，请先清理旧候选" };
		store.addFact(ch.id, { text: `flag ${verified ? "已验证" : "待验证"}：${value}${evidence ? `（${evidence.slice(0, 300)}）` : ""}`, source: `attempt#${flag.attempt ?? "?"}`, attempt: flag.attempt });
		if (downgrade) store.addEvent(ch.id, "note", "verified 门槛未通过，已降级为待验证：" + downgrade);
		if (verified) fs.writeFileSync(path.join(ch.dir, "flag.json"), JSON.stringify({ flag: value, evidence, method, verified: true, at: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
		if (verified) {
			if (!runningAttempt) store.update(ch.id, { endedAt: Date.now() });
			else {
				try { orchestrator.abortAfterVerifiedFlag(ch.id); } catch { /* 状态收口由 orchestrator 负责 */ }
			}
		}
		if (ch.platform && (verified || method === "platform")) { void autoSubmitFlag(ch.id, value); }

		return { ok: true, id: ch.id, status: store.get(ch.id)?.status, verified, flag: value, downgraded: !!downgrade, reason: downgrade };
	}

	function summaryOf(ch) {
		const last = (ch.attempts ?? []).at(-1);
		const runningAttempt = (ch.attempts ?? []).find((a) => a && a.status === "running") ?? null;
		const attemptTimeoutMs = Number(runningAttempt?.timeoutMs);
		const timeoutMs = Number.isFinite(attemptTimeoutMs) && attemptTimeoutMs > 0
			? attemptTimeoutMs
			: (Number(cfg.timeoutMs) || 1800000);
		const graceMs = Number(cfg.wrapupGraceMs) || 0;
		const deadline = ch.status === "running" && runningAttempt && runningAttempt.startedAt ? runningAttempt.startedAt + timeoutMs + (runningAttempt.wrapupAt ? graceMs : 0) : null;
		const phase = runningAttempt ? (runningAttempt.wrapupAt ? "wrapup" : "normal") : "";
		return {
			id: ch.id,
			slug: ch.slug,
			title: ch.title,
			category: ch.category,
			workspace: challengeWorkspace(ch),
			lastEvent: (() => { const last = (ch.events ?? []).at(-1); return last ? { kind: String(last.kind || ""), text: String(last.text || "").slice(0, 200), at: Number(last.at) || 0 } : null; })(),
			targetStatus: ch.targetStatus ? { state: String(ch.targetStatus.state || ""), ok: !!ch.targetStatus.ok, latencyMs: Number(ch.targetStatus.latencyMs) || 0, checkedAt: Number(ch.targetStatus.checkedAt) || 0, error: String(ch.targetStatus.error || "") } : null,
			estCost: (() => { let total = 0; for (const item of ch.attempts ?? []) total += Number(item && item.estCost) || 0; return Math.round(total * 1e6) / 1e6; })(),
			status: ch.status,
			target: ch.target,
			dir: ch.dir,
			driverSession: ch.driverSession ?? "",
			createdAt: ch.createdAt,
			startedAt: ch.startedAt,
			endedAt: ch.endedAt,
			attempts: (ch.attempts ?? []).length,
			lastAttemptStatus: last?.status ?? "",
			lastAttemptAngle: last?.angle ?? "",
			phase,
			deadline,
			remainingMs: deadline ? Math.max(0, deadline - Date.now()) : null,
			wrapupAt: runningAttempt?.wrapupAt ?? null,
			flags: (ch.flags ?? []).length,
			verified: (ch.flags ?? []).some((f) => f.verified),
			stuckReason: ch.stuckReason ?? ""
		};
	}

	function sessionInfoOf(sessionId) {
		if (!sessionId) return { sessionId: "", live: false, preset: "", cwd: "" };
		const agent = agentOfSession(sessionId);
		return {
			sessionId,
			live: !!agent,
			preset: agent ? presetOf(agent) : "",
			cwd: agent ? String(agent?.session?.header?.cwd ?? "") : ""
		};
	}

	/** 多视图聚合：按状态/模块/驱动会话 + flag 台账（供「题板 / 会话 / 台账」三个会话视图共用一次轮询）。 */
	function aggregatesOf(all) {
		const byStatus = { queued: 0, running: 0, solved: 0, stuck: 0, failed: 0, stopped: 0 };
		const catMap = new Map();
		const sesMap = new Map();
		const wsMap = new Map();
		const ledger = [];
		for (const c of all) {
			byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
			const cat = c.category || "未分类";
			const catRow = catMap.get(cat) ?? { category: cat, total: 0, solved: 0, running: 0, queued: 0, stuck: 0, failed: 0, stopped: 0 };
			catRow.total += 1;
			catRow[c.status] = (catRow[c.status] ?? 0) + 1;
			catMap.set(cat, catRow);

			const wsKey = challengeWorkspace(c) || "";
			const wsRow = wsMap.get(wsKey) ?? { workspace: wsKey, total: 0, solved: 0, running: 0, queued: 0, stuck: 0, failed: 0, stopped: 0, lastAt: 0 };
			wsRow.total += 1;
			wsRow[c.status] = (wsRow[c.status] ?? 0) + 1;
			wsRow.lastAt = Math.max(wsRow.lastAt, c.endedAt ?? c.startedAt ?? c.createdAt ?? 0);
			wsMap.set(wsKey, wsRow);

			const sid = c.driverSession ? String(c.driverSession) : "";
			const sesRow = sesMap.get(sid) ?? {
				sessionId: sid, total: 0, solved: 0, running: 0, queued: 0, stuck: 0, failed: 0, stopped: 0,
				lastAt: 0, challenges: []
			};
			sesRow.total += 1;
			sesRow[c.status] = (sesRow[c.status] ?? 0) + 1;
			sesRow.lastAt = Math.max(sesRow.lastAt, c.endedAt ?? c.startedAt ?? c.createdAt ?? 0);
			sesRow.challenges.push({
				id: c.id,
				title: c.title,
				category: c.category || "",
				status: c.status,
				attempts: (c.attempts ?? []).length,
				verified: (c.flags ?? []).some((f) => f.verified),
				createdAt: c.createdAt ?? 0,
				endedAt: c.endedAt ?? 0
			});
			sesMap.set(sid, sesRow);

			for (const f of c.flags ?? []) {
				ledger.push({
					challengeId: c.id,
					title: c.title,
					category: c.category || "",
					flag: f.value,
					verified: !!f.verified,
					evidence: String(f.evidence ?? ""),
					method: String(f.method ?? ""),
					attempt: f.attempt ?? null,
					at: f.recordedAt ?? 0,
					sessionId: sid
				});
			}
		}
		const bySession = [...sesMap.values()]
			.map((row) => ({ ...row, ...sessionInfoOf(row.sessionId) }))
			.sort((a, b) => b.lastAt - a.lastAt)
			.map((row) => ({ ...row, challenges: row.challenges.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 50) }));
		const byCategory = [...catMap.values()].sort((a, b) => b.total - a.total);
		const byWorkspace = [...wsMap.values()].sort((a, b) => b.lastAt - a.lastAt);
		const durations = [];
		for (const c of all) {
			for (const attempt of c.attempts ?? []) {
				if (attempt && typeof attempt.startedAt === "number" && typeof attempt.endedAt === "number" && attempt.endedAt >= attempt.startedAt) {
					durations.push(attempt.endedAt - attempt.startedAt);
				}
			}
		}
		const usage = { promptChars: 0, outputChars: 0, estTokens: 0, estCost: 0 };
		for (const c of all) {
			for (const attempt of c.attempts ?? []) {
				if (!attempt) continue;
				usage.promptChars += Number(attempt.promptChars) || 0;
				usage.outputChars += Number(attempt.outputChars) || 0;
				usage.estTokens += Number(attempt.estTokens) || 0;
				usage.estCost += Number(attempt.estCost) || 0;
			}
		}
		usage.estCost = Math.round(usage.estCost * 1e6) / 1e6;
		const timing = {
			attempts: durations.length,
			totalMs: durations.reduce((sum, value) => sum + value, 0),
			avgMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
			maxMs: durations.length ? Math.max(...durations) : 0
		};
		ledger.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
		return { byStatus, byCategory, bySession, byWorkspace, timing, usage, ledger: ledger.slice(0, 200) };
	}

	function stateSummary(workspace, scopeAll) {
		migrateLegacyWorkspaces();
		const __ws = normalizeWorkspace(workspace);
		if (__ws) lastWorkspace = __ws;
		const all = scopeAll === true ? store.list() : visibleChallenges(workspace);
		const challenges = all.map(summaryOf).reverse();
		const stats = { total: all.length, queued: 0, running: 0, solved: 0, stuck: 0, failed: 0, stopped: 0 };
		all.forEach((c) => { if (c && stats[c.status] != null) stats[c.status] += 1; });
		return {
			ok: true,
			workspace: normalizeWorkspace(workspace),
			stats,
			config: configView(),
			subagents: { available: !!subagentsService()?.startActivation, providers: (() => { try { return subagentsService()?.list?.() ?? []; } catch { return []; } })() },
			aggregates: aggregatesOf(all),
			challenges
		};
	}	function detailOf(id, includeEvents = true) {
		const ch = store.get(id);
		if (!ch) return { ok: false, error: `题目不存在：${id}` };
		return {
			ok: true,
			challenge: {
				...ch,
				events: includeEvents ? (ch.events ?? []).slice(-MAX_EVENT_TAIL) : undefined
			}
		};
	}

	// ── 模型工具 ──────────────────────────────────────────────────────────
	// 子代理会话 id → 题目 id（spawn 成功时登记；ctf_flag_record 据此定位当前题目）
	const childSessionChallenge = new Map();
	const isSubagentExec = (exec) => {
		try { return exec?.agent?.session?.header?.origin === "subagent"; } catch { return false; }
	};
	const orchestratorOnly = (toolName, exec) => {
		if (!isSubagentExec(exec)) return null;
		return { ok: false, error: `${toolName} 只允许主会话调用；解题子代理只能操作当前题目并登记候选/已验证结论` };
	};
	const sameScopePath = (a, b) => {
		try {
			const left = path.resolve(String(a ?? ""));
			const right = path.resolve(String(b ?? ""));
			return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
		} catch { return false; }
	};
	const pathInside = (parent, child) => {
		try {
			const p = path.resolve(String(parent ?? ""));
			const c = path.resolve(String(child ?? ""));
			const norm = process.platform === "win32" ? (x) => x.toLowerCase() : (x) => x;
			const pp = norm(p); const cc = norm(c);
			return cc === pp || cc.startsWith(pp.endsWith(path.sep) ? pp : pp + path.sep);
		} catch { return false; }
	};
	const ownChallengeOfExec = (exec) => {
		if (!isSubagentExec(exec)) return null;
		let cwd = "";
		let sessionId = "";
		try { cwd = String(exec?.agent?.session?.header?.cwd ?? ""); } catch { cwd = ""; }
		try {
			sessionId = String(exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? exec?.agent?.id ?? "");
		} catch { sessionId = ""; }
		const all = store.list();
		if (sessionId && childSessionChallenge.has(String(sessionId))) {
			const mapped = store.get(childSessionChallenge.get(String(sessionId)));
			if (mapped) return mapped;
		}
		if (sessionId) {
			const byDriver = all.find((ch) => ch && (ch.driverSession === sessionId || (Array.isArray(ch.attempts) && ch.attempts.some((a) => a && a.driverSession === sessionId && a.status === "running"))));
			if (byDriver) return byDriver;
		}
		if (!cwd) return null;
		const exact = all.find((ch) => ch && sameScopePath(ch.dir, cwd));
		if (exact) return exact;
		// 子代理 header.cwd 可能停在题板工作区根：用“挑战目录在 cwd 之下 + 正在运行/最近驱动”兜底
		const candidates = all.filter((ch) => ch && ch.dir && pathInside(cwd, ch.dir));
		if (candidates.length === 0) return null;
		const running = candidates.filter((ch) => ch.status === "running");
		if (running.length === 1) return running[0];
		if (sessionId) {
			const bySession = candidates.find((ch) => ch.driverSession === sessionId);
			if (bySession) return bySession;
		}
		return candidates.length === 1 ? candidates[0] : null;
	};
	/** 子代理只能操作 cwd 对应的题目；主会话保持原有管理能力。 */
	const scopeToolToOwnChallenge = (toolName, exec, requestedId = "") => {
		if (!isSubagentExec(exec)) return { ok: true, id: String(requestedId ?? "").trim(), challenge: null };
		const own = ownChallengeOfExec(exec);
		if (!own) {
			const requested = String(requestedId ?? "").trim();
			if (requested) {
				const target = store.get(requested);
				const active = target && (target.status === "running" || (Array.isArray(target.attempts) && target.attempts.some((a) => a && a.status === "running")));
				if (active) return { ok: true, id: target.id, challenge: target };
			}
		}
		if (!own) return { ok: false, error: `${toolName}: 无法根据子代理 cwd 定位当前题目` };
		const id = String(requestedId ?? "").trim();
		if (id && id !== own.id) {
			const target = store.get(id);
			if (!target || !sameScopePath(target.dir, own.dir)) {
				return { ok: false, error: `${toolName}: 解题子代理只能访问当前题目（${own.id}）` };
			}
		}
		return { ok: true, id: own.id, challenge: own };
	};
	const scopeToolToAccessibleChallenge = (toolName, exec, requestedId = "") => {
		if (isSubagentExec(exec)) return scopeToolToOwnChallenge(toolName, exec, requestedId);
		const id = String(requestedId ?? "").trim();
		if (!id) return { ok: true, id: "", challenge: null };
		const target = store.get(id);
		if (!target) return { ok: false, error: `${toolName}: 题目不存在（${id}）` };
		const workspace = workspaceOfExec(exec);
		if (workspace && challengeWorkspace(target) && !sameWorkspace(challengeWorkspace(target), workspace)) {
			return { ok: false, error: `${toolName}: 题目不属于当前工作区；请切换工作区后再操作` };
		}
		return { ok: true, id: target.id, challenge: target };
	};

	ctx.tools.register(defineToolLite({
		name: "ctf_solve_start",
		description: "启动一道 CTF 题的自主解题：登记题面/附件 → 建题目录与状态 → 派发 DSH 子代理（ctf-solver 模式）自主解题，子代理验证 flag 后调 ctf_flag_record 登记。支持多题并发（配置 concurrency）。返回题目 id/slug/目录，解题在后台推进，用 ctf_solve_status 查看。适用于用户给出题面文字、附件路径、目标 URL 的场景；平台题目可用 ctf_platform_import 导入。",
		parameters: objSchema({
			title: str("题名（必填）"),
			statement: str("题面全文（必填）：题目描述/提示/附件说明/目标地址等，子代理把它当唯一契约"),
			category: str("模块：web/pwn/reverse/crypto/misc/forensics/mobile/cloud/ai/ad/supply/osint，可留空由子代理判断"),
			target: str("目标地址（可选）：http(s) URL / host:port / 本地文件说明"),
			files: { type: "array", items: { type: "string" }, description: "附件：绝对路径或 http(s) URL 列表（小文件会复制到题目录 files/）" },
			maxAttempts: num("该题最多尝试次数（覆盖默认 maxAttempts，可选）"),
			timeBudgetMinutes: num("整题总时间预算（分钟，可选；从第一次尝试开始计，并受 timeoutMs 单次上限约束）")
		}, ["title", "statement"]),
		outputSchema: outSchema({ ok: bool("是否成功"), id: str("题目 id"), slug: str("题目 slug"), dir: str("题目工作区绝对路径"), status: str("状态") }, ["ok"]),
		render: (_a, v) => v.ok ? `已入队并派发：${v.title ?? ""}（id=${v.id}，status=${v.status}）\n工作区：${v.dir}` : `启动失败：${v.error}`,
		isConcurrencySafe: true,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_solve_start", exec);
			if (denied) return denied;
			try {
				let category = args.category ? String(args.category).trim().toLowerCase() : "";
				let categoryInfo = null;
				if (!category) {
					categoryInfo = classifyChallenge({ title: args.title, statement: args.statement, target: args.target, files: args.files });
					category = categoryInfo.category;
				}
				const ch = addChallenge({ ...args, category }, baseDirOf(exec));
				if (categoryInfo) {
					store.update(ch.id, { categorySource: "auto", categoryReasons: categoryInfo.reasons });
					store.addEvent(ch.id, "note", "题型自动识别：" + category + "（" + categoryInfo.confidence + "）" + (categoryInfo.reasons.length ? " — " + categoryInfo.reasons.join("；") : ""), { confidence: categoryInfo.confidence });
				}
				if (exec?.agent) {
					driverByChallenge.set(ch.id, exec.agent);
					lastDriver = exec.agent;
					store.update(ch.id, { driverSession: String(exec.agent.id) });
				}
				orchestrator.start(ch.id, { agentPreset: cfg.solverPreset });
				const current = store.get(ch.id) ?? ch;
				return { ok: true, id: current.id, slug: current.slug, dir: current.dir, title: current.title, status: current.status };
			} catch (e) {
				return { ok: false, error: String(e?.message ?? e) };
			}
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_board_import",
		description: "批量导入 CTF 题板：一次登记多道题（题面/附件/目标）并全部入队派发。用于用户贴来一整板题目时；平台自动取题本版未实现。返回每题 id 与状态。",
		parameters: objSchema({
			challenges: {
				type: "array",
				items: {
					type: "object",
					properties: {
						title: str("题名"),
						statement: str("题面全文"),
						category: str("模块"),
						target: str("目标地址"),
						files: { type: "array", items: { type: "string" }, description: "附件路径/URL 列表" }
					},
					required: ["title"],
					additionalProperties: false
				},
				description: "题目数组"
			}
		}, ["challenges"]),
		outputSchema: outSchema({ ok: bool("是否成功"), created: { type: "array", items: { type: "object", additionalProperties: true } }, errors: { type: "array", items: { type: "string" } } }, ["ok"]),
		render: (_a, v) => v.ok ? `批量导入完成：${v.created.length} 题入队${v.errors?.length ? `，${v.errors.length} 条失败` : ""}` : `导入失败：${v.error}`,
		isConcurrencySafe: true,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_board_import", exec);
			if (denied) return denied;
			const created = [];
			const errors = [];
			for (const item of (Array.isArray(args.challenges) ? args.challenges : []).slice(0, MAX_IMPORT_CHALLENGES)) {
				try {
					const ch = addChallenge(item, baseDirOf(exec));
					if (exec?.agent) {
						driverByChallenge.set(ch.id, exec.agent);
						lastDriver = exec.agent;
						store.update(ch.id, { driverSession: String(exec.agent.id) });
					}
					orchestrator.start(ch.id, { agentPreset: cfg.solverPreset });
					created.push({ id: ch.id, title: ch.title, status: store.get(ch.id)?.status ?? ch.status });
				} catch (e) { errors.push(`${item?.title ?? "?"}: ${String(e?.message ?? e)}`); }
			}
			return { ok: true, created, errors };
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_solve_status",
		description: "查看 CTF 题板与自动解题进度。不带 id：返回统计 + 每题摘要（状态/尝试数/最近尝试角度/flag 数/卡点）；带 id：返回该题完整详情（attempts 时间线、facts 事实链、flags、events 事件）。",
		parameters: objSchema({
			id: str("题目 id（可选；省略则返回题板摘要）"),
			includeEvents: bool("详情是否包含 events 事件（默认 true）"),
			limit: num("摘要最多返回题数（默认 50）")
		}),
		outputSchema: outSchema({ ok: bool("是否成功"), data: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return `查询失败：${v.error}`;
			const d = v.data ?? {};
			if (d.challenge) {
				const c = d.challenge;
				const lines = [`# ${c.title}（${c.id}） 状态=${c.status}${c.category ? ` 模块=${c.category}` : ""}`, `目录：${c.dir}`];
				if (c.stuckReason) lines.push(`卡点：${c.stuckReason}`);
				for (const f of c.flags ?? []) lines.push(`flag（${f.verified ? "已验证" : "待验证"}）：${f.value}  证据：${String(f.evidence ?? "").slice(0, 200)}`);
				lines.push("", "## 尝试");
				for (const a of c.attempts ?? []) lines.push(`- #${a.n} ${a.angle} → ${a.status}${a.stopReason ? `（${a.stopReason}）` : ""}${a.summary ? `：${a.summary}` : ""}`);
				lines.push("", "## 事实链");
				for (const f of c.facts ?? []) lines.push(`- ${f.text}`);
				if (c.events?.length) { lines.push("", "## 最近事件"); for (const e of c.events.slice(-20)) lines.push(`- [${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}: ${e.text}`); }
				return lines.join("\n");
			}
			const st = d.stats ?? {};
			const lines = [`CTF 题板：共 ${st.total ?? 0} 题 | 排队 ${st.queued ?? 0} · 运行 ${st.running ?? 0} · 已解 ${st.solved ?? 0} · 卡住 ${st.stuck ?? 0} · 失败 ${st.failed ?? 0}`];
			for (const c of (d.challenges ?? []).slice(0, Number(_a?.limit) > 0 ? Number(_a.limit) : 50)) {
				lines.push(`- [${c.status}] ${c.title}（${c.id}）${c.category ? ` · ${c.category}` : ""} · 尝试 ${c.attempts}${c.flags ? ` · flag ${c.flags}` : ""}${c.stuckReason ? ` · 卡点：${c.stuckReason}` : ""}`);
			}
			return lines.join("\n");
		},
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_solve_status", exec);
			if (denied) return denied;
			try {
				if (args?.id) return { ok: true, data: detailOf(String(args.id), args.includeEvents !== false) };
				const s = stateSummary(workspaceOfExec(exec));
				return { ok: true, data: { stats: s.stats, challenges: s.challenges.slice(0, Number(args?.limit) > 0 ? Number(args.limit) : 50) } };
			} catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_solve_stop",
		description: "停止某道题正在运行的自动解题（中断解题子代理并置 stopped）。已解题目不受影响。",
		parameters: objSchema({ id: str("题目 id") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), status: str("状态") }, ["ok"]),
		render: (_a, v) => v.ok ? `已停止：${v.id} → ${v.status}` : `停止失败：${v.error}`,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_solve_stop", exec);
			if (denied) return denied;
			const r = stopChallenge(String(args.id));
			return { ...r, id: args.id };
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_solve_retry",
		description: "重置某道未解题目并重新入队（可选 hint 作为下一轮附加提示，写进解题子代理的 prompt）。适合：前一轮卡住、用户给了新提示、想换角度再试。已解题目拒绝。",
		parameters: objSchema({ id: str("题目 id"), hint: str("附加提示（可选）：新的方向/线索/指定角度") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), status: str("状态") }, ["ok"]),
		render: (_a, v) => v.ok ? `已重新入队：${v.id} → ${v.status}` : `重试失败：${v.error}`,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_solve_retry", exec);
			if (denied) return denied;
			const r = retryChallenge(String(args.id), args.hint ? String(args.hint) : "");
			return { ...r, id: args.id };
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_flag_record",
		description: "登记一道题的 flag（解题子代理完成时必须调用；主会话也可代记）。verified=true 仅在 flag 已被本机证据验证后使用（原版解码函数复现 / 本地 check 脚本通过 / 平台回显通过），并写 evidence 说明复现命令与输出；verified=false 记为待验证候选、不置已解。禁止猜测或伪造。",
		parameters: objSchema({
			id: str("题目 id（子代理可省略：按工作目录自动定位）"),
			flag: str("flag 字符串"),
			evidence: str("验证证据（必填）：复现命令 + 输出摘要 / 校验脚本结果 / 平台回显"),
			verified: bool("是否已验证（true 才置已解）"),
			method: str("验证方式：local-check / derivation / platform / manual")
		}, ["flag", "evidence"]),
		outputSchema: outSchema({ ok: bool("是否成功"), id: str("题目 id"), status: str("状态"), verified: bool("是否已验证") }, ["ok"]),
		render: (_a, v) => v.ok ? `flag 已登记：${v.id}（${v.verified ? "已验证 → 已解" : "待验证"}，当前状态 ${v.status}）` : `登记失败：${v.error}`,
		execute(args, exec) {
			try {
				const scoped = scopeToolToAccessibleChallenge("ctf_flag_record", exec, args?.id);
				if (!scoped.ok) return scoped;
				let id = scoped.id;
				if (!id) {
					const cwd = exec?.agent?.session?.header?.cwd;
					const found = store.list().find((c) => cwd && path.resolve(c.dir) === path.resolve(String(cwd)));
					if (found) id = found.id;
				}
				if (!id) return { ok: false, error: "未提供 id，且无法按工作目录定位题目" };
				return recordFlag({ ...args, id });
			} catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_solve_log",
		description: "查看某题的事件/尝试轨迹文本（排障用）：attempts 每次收口、状态迁移、中断、错误。",
		parameters: objSchema({ id: str("题目 id"), limit: num("最多返回事件条数（默认 80）") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), log: str("日志文本") }, ["ok"]),
		render: (_a, v) => v.ok ? v.log : `读取失败：${v.error}`,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_solve_log", exec);
			if (denied) return denied;
			const ch = store.get(String(args.id));
			if (!ch) return { ok: false, error: `题目不存在：${args.id}` };
			const limit = Number(args.limit) > 0 ? Number(args.limit) : 80;
			const lines = [`# ${ch.title}（${ch.id}） status=${ch.status}`];
			for (const e of (ch.events ?? []).slice(-limit)) lines.push(`[${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}: ${e.text}`);
			return { ok: true, log: lines.join("\n") };
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_solve_doctor",
		description: "诊断 CTF 自动解题编排器：子代理服务与 provider 是否可用、题板根目录、并发/超时配置、题目数与最近错误。安装后首查用。",
		parameters: objSchema({}),
		outputSchema: outSchema({ ok: bool("是否成功"), data: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return `诊断失败：${v.error}`;
			const d = v.data ?? {};
			return [`## CTF 自动解题诊断`,
				`- 子代理编排：${d.subagents?.available ? "可用" : "不可用（无法派发解题子代理）"}`,
				`- 子代理 providers：${(d.subagents?.providers ?? []).join(", ") || "（无）"}`,
				`- 模式入口：${d.preset?.registered ? `${d.preset.id} / ${d.preset.name} 已注册` : `未注册${d.preset?.error ? `（${d.preset.error}）` : ""}`}${d.preset?.listed ? `；preset 列表可见（${d.preset.total} 个模式）` : "；preset 列表未见（可能仍在装配）"}${d.preset?.broken?.length ? `；异常 preset：${d.preset.broken.join("; ")}` : ""}`,
				`- 模式技能目录：${d.preset?.skillDirs ?? 0} 个（来源 ${d.preset?.skillSourceDir || "未找到技能来源目录"}）`,
				`- 平台接入：${d.platform?.configured ? `${d.platform.baseUrl}（${d.platform.reachable ? "连通" : `不可达：${d.platform.error}`}）` : "未配置（面板「平台」里填 baseUrl + API Token）"}`,
				`- 活跃会话：${(d.sessions ?? []).map((s) => `${s.id}${s.preset ? `(${s.preset})` : ""}`).join(", ") || "（无）"}`,
				`- 题板根目录：${d.config?.rootDir}`,
				`- 配置：并发 ${d.config?.concurrency} / 超时 ${Math.round((d.config?.timeoutMs ?? 0) / 60000)} 分钟 / 最多尝试 ${d.config?.maxAttempts} / 自动重试 ${d.config?.autoRetry ? "开" : "关"} / preset ${d.config?.solverPreset}`,
				`- 题板：${JSON.stringify(d.stats)}`].join("\n");
		},
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_solve_doctor", exec);
			if (denied) return denied;
			return (async () => {
				try {
					const sub = subagentsService();
					const s = stateSummary(workspaceOfExec(exec));
					let presets = [];
					let presetError = "";
					try {
						const svc = ctx.get("agentPresets");
						if (svc && typeof svc.list === "function") {
							const list = await svc.list();
							presets = (list ?? []).map((p) => ({ id: String(p.id ?? ""), name: p.name == null ? "" : String(p.name), broken: p.broken == null ? "" : String(p.broken), isDefault: !!p.isDefault }));
						}
					} catch (e) { presetError = String(e?.message ?? e); }
					const mine = presets.find((p) => p.id === presetState.id) ?? null;
					return {
						ok: true,
						data: {
							subagents: s.subagents,
							config: s.config,
							stats: s.stats,
							preset: {
								id: presetState.id,
								name: presetState.name,
								registered: presetState.registered,
								error: presetState.error,
								skillDirs: presetState.skillDirs,
								skillSourceDir: presetState.skillSourceDir,
								listed: mine,
								total: presets.length,
								broken: presets.filter((p) => p.broken).map((p) => `${p.id}: ${p.broken}`),
								all: presets.map((p) => p.id)
							},
							presetError,
							platform: await platformStatus(),
							wslDistros: await detectWslDistros(),
							sessions: (() => {
								try {
									const agents = agentsService();
									const roots = agents?.roots?.() ?? [];
									return roots.map((a) => ({ id: String(a.id), preset: presetOf(a), cwd: String(a?.session?.header?.cwd ?? "") }));
								} catch { return []; }
							})(),
							challenges: s.challenges.slice(0, 5)
						}
					};
				} catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
			})();
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_platform_status",
		description: "查看 CTF 平台（CTFd）接入状态：是否配置、能否连通、当前账号。平台配置在「CTF 自动解题」视图顶部的平台面板里填写（baseUrl + API Token）。",
		parameters: objSchema({}),
		outputSchema: outSchema({ ok: bool("是否成功"), data: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return `平台状态读取失败：${v.error}`;
			const d = v.data ?? {};
			return d.configured
				? `平台：${d.baseUrl} | ${d.reachable ? `连通${d.user && d.user.name ? `（${d.user.name}）` : ""}` : `不可达：${d.error}`}`
				: "平台未配置：在「CTF 自动解题」视图顶部点「平台」面板，填写 baseUrl 与 API Token";
		},
		execute(_args, exec) { const denied = orchestratorOnly("ctf_platform_status", exec); if (denied) return denied; return (async () => { try { return { ok: true, data: await platformStatus() }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } })(); }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_platform_import",
		description: "从已配置的 CTF 平台（CTFd 或通用 JSON）拉取题目并导入题板：默认导入所有未解且未导入过的题（题面/连接信息/附件下载齐全），可用 ids 指定或 all 全量；start=true 时导入后立即派发自动解题。导入后的题带平台信息，可用 ctf_platform_submit 提交 flag。",
		parameters: objSchema({
			ids: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] }, description: "平台题目 id 列表（字符串或数字；省略或空 = 全部）" },
			all: bool("导入全部（忽略 ids）"),
			skipSolved: bool("跳过平台上已解出的题（默认 true）"),
			start: bool("导入后立即派发自动解题（默认 false）")
		}),
		outputSchema: outSchema({
			ok: bool("是否成功"),
			created: { type: "array", items: { type: "object", additionalProperties: true } },
			skipped: { type: "array", items: { type: "object", additionalProperties: true } },
			errors: { type: "array", items: { type: "object", additionalProperties: true } }
		}, ["ok"]),
		render: (_a, v) => v.ok
			? `平台导入完成：新增 ${(v.created ?? []).length}，跳过 ${(v.skipped ?? []).length}，失败 ${(v.errors ?? []).length}${(v.created ?? []).length ? `\n- 新增：${v.created.map((c) => `${c.title}（${c.localId}）`).join("; ")}` : ""}`
			: `导入失败：${v.error}`,
		execute(args, exec) { const denied = orchestratorOnly("ctf_platform_import", exec); if (denied) return denied; return (async () => { try { return await platformImport(args, exec); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } })(); }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_platform_submit",
		description: "把某题的 flag 提交到 CTF 平台（CTFd）：correct / already_solved 会按平台回显自动登记为已验证并置已解；incorrect / ratelimited 只记事件并返回原因。仅平台导入的题目可提交。",
		parameters: objSchema({ id: str("本地题目 id"), flag: str("flag 字符串") }, ["id", "flag"]),
		outputSchema: outSchema({ ok: bool("是否被平台接受"), status: str("平台返回状态"), message: str("平台消息") }, ["ok"]),
		render: (_a, v) => v.status ? `平台提交：${v.status}${v.message ? `（${v.message}）` : ""}${v.ok ? " → 已按平台回显登记为已验证" : ""}` : `提交失败：${v.error}`,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_platform_submit", exec);
			if (denied) return denied;
			const scoped = scopeToolToAccessibleChallenge("ctf_platform_submit", exec, args?.id);
			if (!scoped.ok) return scoped;
			return (async () => { try { return await platformSubmit({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } })();
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_workbench_list",
		description: "列出某题工作区文件（题面/笔记/附件/脚本/产物，深度 2）：与面板单题工作台同源，供查看产物与排障。",
		parameters: objSchema({ id: str("题目 id") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), dir: str("题目录"), entries: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => v.ok ? [`目录：${v.dir}`, ...(v.entries ?? []).map((e) => `- ${e.kind === "dir" ? "[D]" : "[F]"} ${e.path}${e.kind === "file" ? ` (${e.size} B)` : ""}`)].join("\n") : `读取失败：${v.error}`,
		execute(args, exec) {
			const scoped = scopeToolToAccessibleChallenge("ctf_workbench_list", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return workbenchTree({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_workbench_read",
		description: "读取某题工作区内的文本文件（相对路径，如 notes.md、scripts/solve.py、artifacts/out.txt）。",
		parameters: objSchema({ id: str("题目 id"), path: str("相对路径"), maxBytes: num("最大读取字节（默认 512KB）") }, ["id", "path"]),
		outputSchema: outSchema({ ok: bool("是否成功"), path: str("相对路径"), text: str("文件内容"), size: num("字节数"), truncated: bool("是否截断") }, ["ok"]),
		render: (_a, v) => v.ok ? `## ${v.path}（${v.size} B${v.truncated ? "，已截断" : ""}）\n${v.text}` : `读取失败：${v.error}`,
		execute(args, exec) {
			const scoped = scopeToolToAccessibleChallenge("ctf_workbench_read", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return workbenchRead({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_workbench_write",
		description: "写入某题工作区内的文本文件（仅题目录内，自动建父目录，≤512KB）：用于补写 notes.md 或保存脚本/产物。",
		parameters: objSchema({ id: str("题目 id"), path: str("相对路径（如 notes.md）"), text: str("文件内容") }, ["id", "path", "text"]),
		outputSchema: outSchema({ ok: bool("是否成功"), path: str("相对路径"), bytes: num("写入字节") }, ["ok"]),
		render: (_a, v) => v.ok ? `已写入 ${v.path}（${v.bytes} 字节）` : `写入失败：${v.error}`,
		execute(args, exec) {
			const scoped = scopeToolToAccessibleChallenge("ctf_workbench_write", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return workbenchWrite({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_report_export",
		description: "导出当前题板的 Markdown 复盘报告（统计/模块分布/逐题 flag 与证据/attempts/未解卡点）到题板根目录 reports/，返回文件路径与预览。",
		parameters: objSchema({}),
		outputSchema: outSchema({ ok: bool("是否成功"), path: str("报告文件路径"), bytes: num("字节数"), markdown: str("Markdown 预览") }, ["ok"]),
		render: (_a, v) => v.ok ? `复盘报告已导出：${v.path}（${v.bytes} B）\n\n${v.markdown}` : `导出失败：${v.error}`,
		execute(args, exec) { const denied = orchestratorOnly("ctf_report_export", exec); if (denied) return denied; try { return reportExport(workspaceOfExec(exec)); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_search",
		description: "在题板里检索（题名/模块/题面/尝试摘要与输出/事实链/flag 证据），返回命中的题目与片段：用于找历史做法、卡点、旗标与可复用脚本线索。",
		parameters: objSchema({ q: str("关键词（空格分词 = AND）") , limit: num("最多返回条数（默认 50）") }, ["q"]),
		outputSchema: outSchema({ ok: bool("是否成功"), results: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "检索失败：" + v.error;
			const rows = v.results ?? [];
			if (rows.length === 0) return "没有命中（换关键词试试：题名/模块/flag 片段/卡点描述）。";
			return ["检索命中 " + rows.length + " 条：", ...rows.map((row) => "- [" + row.fieldLabel + "] " + row.title + "（" + row.challengeId + "）" + (row.attempt ? " 尝试#" + row.attempt : "") + "：" + row.snippet)].join("\n");
		},
		execute(args, exec) {
			try {
				const ws = workspaceOfExec(exec);
				const own = isSubagentExec(exec) ? ownChallengeOfExec(exec) : null;
				if (isSubagentExec(exec) && !own) return { ok: false, error: "ctf_search: 无法定位当前题目" };
				const list = own ? [own] : visibleChallenges(ws);
				const challenges = {};
				const order = [];
				for (const c of list) { challenges[c.id] = c; order.push(c.id); }
				return { ok: true, results: searchBoard({ ...store.state, challenges, order }, String(args.q ?? ""), { limit: args.limit }) };
			} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_writeup_export",
		description: "为某道题导出 Writeup（Markdown）：只含「题目」（清洗后的题面）与「解题步骤」（notes.md 的解题记录，剔除反注入/失败路径/建议/时间预算等旁支），落盘到 <rootDir>/writeups/。",
		parameters: objSchema({ id: str("题目 id") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), path: str("Writeup 文件路径"), bytes: num("字节数"), markdown: str("Markdown 预览") }, ["ok"]),
		render: (_a, v) => v.ok ? "Writeup 已导出：" + v.path + "（" + v.bytes + " B）\n\n" + v.markdown : "导出失败：" + v.error,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_writeup_export", exec);
			if (denied) return denied;
			const scoped = scopeToolToAccessibleChallenge("ctf_writeup_export", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return writeupExport({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_challenge_remove",
		description: "从题板移除一道题（停止运行中的尝试；可选 deleteFiles=true 同时删除题目工作目录，仅允许题板根目录或会话工作区 .ctf-auto 内的目录）。",
		parameters: objSchema({ id: str("题目 id"), deleteFiles: bool("是否同时删除题目工作目录（默认 false）") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), id: str("题目 id"), filesRemoved: bool("是否删除了目录") }, ["ok"]),
		render: (_a, v) => v.ok ? "已移除题目：" + v.id + (v.filesRemoved ? "（目录已删除）" : "（目录保留）") : "移除失败：" + v.error,
		isConcurrencySafe: true,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_challenge_remove", exec);
			if (denied) return denied;
			const scoped = scopeToolToAccessibleChallenge("ctf_challenge_remove", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return removeChallenge({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_kb_search",
		description: "检索本地私有知识库（导出的 Writeup + 各题 notes.md）：按技法/题型/工具/关键词找历史解法与踩坑记录，跨工作区可用。",
		parameters: objSchema({ q: str("关键词（空格分词 = AND）"), limit: num("最多返回条数（默认 10）") }, ["q"]),
		outputSchema: outSchema({ ok: bool("是否成功"), results: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "知识检索失败：" + v.error;
			const rows = v.results ?? [];
			if (rows.length === 0) return "知识库没有命中（换关键词：技法/题型/工具名/flag 片段）。";
			return ["知识库命中 " + rows.length + " 条：", ...rows.map((r) => "- [" + r.sourceLabel + "] " + r.title + (r.category ? "（" + r.category + "）" : "") + "：" + r.snippet)].join("\n");
		},
		execute(args) { try { return kbSearch(args); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_recall",
		description: "解题中召回历史打法：一次返回相似打法卡（memory.json）+ 私有知识片段（Writeup/笔记/导入资料）。给 id 按题目召回；卡住时用 q 按关键词召回。复用前先确认适用条件。",
		parameters: objSchema({ id: str("题目 id（可选：按该题召回）"), q: str("关键词（可选：技法/题型/工具）"), limit: num("最多条数（默认 3）") }, []),
		outputSchema: outSchema({ ok: bool("是否成功"), memories: { type: "array", items: { type: "object", additionalProperties: true } }, knowledge: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "召回失败：" + v.error;
			const lines = [];
			const memories = v.memories || [];
			const knowledge = v.knowledge || [];
			if (memories.length === 0 && knowledge.length === 0) return "没有召回结果（可先积累做法卡/导入题解，或换个关键词）。";
			if (memories.length) { lines.push("相似打法卡 " + memories.length + " 张："); for (const card of memories.slice(0, 3)) lines.push("- 「" + card.title + "」（" + (card.category || "?") + "）技法：" + (card.tech || []).slice(0, 4).join("、") + " score " + card.score); }
			if (knowledge.length) { lines.push("知识片段 " + knowledge.length + " 条："); for (const item of knowledge.slice(0, 3)) lines.push("- [" + (item.sourceLabel || item.source) + "] 「" + item.title + "」 score " + item.score); }
			return lines.join("\n");
		},
		execute(args) {
			try {
				const limit = Number(args && args.limit) || 3;
				const ch = args && args.id ? store.get(String(args.id)) : null;
				if (ch) { const pack = recallFor(ch, { limit, knowledgeLimit: limit }); return { ok: true, memories: pack.memories, knowledge: pack.knowledge }; }
				const q = String(args && args.q || "").trim();
				if (!q) return { ok: false, error: "需要 id 或 q" };
				const all = memoryCards();
				const memories = searchMemories(all.cards, q, { limit });
				const knowledge = kbSearch({ q, limit }).results || [];
				return { ok: true, memories, knowledge };
			} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_memory_list",
		description: "列出跨会话沉淀的打法卡（memory.json）：技法标签/入口/步骤/命令/坑/复用次数，用于判断是否有相似题可复用。",
		parameters: objSchema({ q: str("关键词过滤（可选：技法/题型/标题）"), limit: num("最多条数（默认 20）") }, []),
		outputSchema: outSchema({ ok: bool("是否成功"), cards: { type: "array", items: { type: "object", additionalProperties: true } }, stats: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "读取打法卡失败：" + v.error;
			const cards = v.cards || [];
			if (cards.length === 0) return "还没有沉淀过打法卡（解出题后会自动沉淀，或让宿主执行 memory.distill）。";
			const lines = ["打法卡 " + cards.length + " 张（复用 " + (v.stats && v.stats.used || 0) + " 次 / 成功 " + (v.stats && v.stats.usedOk || 0) + " 次）："];
			for (const card of cards.slice(0, 20)) lines.push("- 「" + card.title + "」（" + (card.category || "?") + "）技法：" + (card.tech || []).slice(0, 5).join("、") + "｜复用 " + (card.used || 0) + "/成功 " + (card.usedOk || 0));
			return lines.join("\n");
		},
		execute(args, exec) { const denied = orchestratorOnly("ctf_memory_list", exec); if (denied) return denied; try { const all = memoryCards(); const q = String(args && args.q || "").toLowerCase(); const cards = q ? all.cards.filter((c) => JSON.stringify(c).toLowerCase().includes(q)) : all.cards; return { ok: true, cards: cards.slice(0, Number(args && args.limit) || 20), stats: all.stats }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_memory_distill",
		description: "把已解题目沉淀成打法卡（技法/入口/步骤/命令/坑）写入跨会话 memory.json；id 留空则沉淀全部已解但未沉淀的题。",
		parameters: objSchema({ id: str("题目 id（可选）") }, []),
		outputSchema: outSchema({ ok: bool("是否成功"), distilled: num("沉淀数量"), cards: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => v.ok ? "打法卡沉淀完成：" + (v.distilled != null ? v.distilled : 1) + " 张" : "沉淀失败：" + v.error,
		execute(args, exec) { const denied = orchestratorOnly("ctf_memory_distill", exec); if (denied) return denied; try { return args && args.id ? (() => { const r = distillMemory(args.id); return r.ok ? { ok: true, distilled: 1, cards: [r.card] } : r; })() : distillAllSolved(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_kb_import",
		description: "把本地 md/txt 资料（题解/笔记/模块卡，一行一个路径，也可以是目录）导入私有知识库 <rootDir>/knowledge/，导入后即可用 ctf_kb_search 检索。",
		parameters: objSchema({ files: { type: "array", items: { type: "string" }, description: "文件或目录路径列表" }, text: str("路径列表文本（换行/逗号分隔，可选）"), cwd: str("相对路径的基准目录（可选）") }, []),
		outputSchema: outSchema({ ok: bool("是否成功"), imported: { type: "array", items: { type: "object", additionalProperties: true } }, errors: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "知识导入失败：" + v.error;
			const lines = ["已导入 " + (v.imported ? v.imported.length : 0) + " 个文件："];
			for (const item of (v.imported || []).slice(0, 20)) lines.push("- " + item.name + "（" + item.bytes + " B）");
			for (const item of (v.errors || []).slice(0, 10)) lines.push("- 失败 " + item.path + "：" + item.error);
			return lines.join("\n");
		},
		execute(args, exec) { const denied = orchestratorOnly("ctf_kb_import", exec); if (denied) return denied; try { return importKnowledge(args); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_triage",
		description: "对某题附件做分诊：按魔数/扩展名判定类型（zip/图片/ELF/PE/PCAP/镜像/字节码…），给出下一步处理提示，并落盘 artifacts/triage.json。",
		parameters: objSchema({ id: str("题目 id") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), triage: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "分诊失败：" + v.error;
			const t = v.triage || {};
			const lines = ["附件分诊（" + (t.files ? t.files.length : 0) + " 个）："];
			for (const f of (t.files || []).slice(0, 20)) lines.push("- " + f.name + " → " + f.label + "（" + f.via + "）");
			if ((t.nextSteps || []).length) lines.push("下一步：", ...t.nextSteps.map((s2) => "- " + s2));
			return lines.join("\n");
		},
		execute(args, exec) {
			const scoped = scopeToolToAccessibleChallenge("ctf_triage", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return triageChallenge({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_writeup_pack",
		description: "把某题的 Writeup 打包成 .tar.gz（writeup.md + statement/flag + files/scripts/artifacts），落盘 <rootDir>/packages/，用于交付归档。",
		parameters: objSchema({ id: str("题目 id") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), path: str("包路径"), bytes: num("字节数"), files: num("文件数") }, ["ok"]),
		render: (_a, v) => v.ok ? "WP 已打包：" + v.path + "（" + v.bytes + " B，" + v.files + " 个文件）" : "打包失败：" + v.error,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_writeup_pack", exec);
			if (denied) return denied;
			const scoped = scopeToolToAccessibleChallenge("ctf_writeup_pack", exec, args?.id);
			if (!scoped.ok) return scoped;
			try { return packWriteup({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_review_flag",
		description: "对某题已登记的验证 flag 做独立复核：派一个 reviewer 子代理（只给原始材料、独立重算），结论 VERIFIED 则记录复核通过、REJECTED 则把 flag 降级为待验证并置 stuck。",
		parameters: objSchema({ id: str("题目 id") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), status: str("verified/rejected/inconclusive"), summary: str("复核摘要") }, ["ok"]),
		render: (_a, v) => v.ok ? "复核结果：" + String(v.status || "").toUpperCase() + (v.summary ? "\n" + v.summary : "") : "复核失败：" + v.error,
		execute(args, exec) {
			const denied = orchestratorOnly("ctf_review_flag", exec);
			if (denied) return denied;
			const scoped = scopeToolToAccessibleChallenge("ctf_review_flag", exec, args?.id);
			if (!scoped.ok) return scoped;
			return (async () => { try { return await reviewFlag({ ...args, id: scoped.id }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })();
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_schedule",
		description: "查看比赛级调度状态：并发占用、运行中/排队中的题、最近 30 分钟尝试与完成节奏、最近完成题（耗时/费用）。",
		parameters: objSchema({}, []),
		outputSchema: outSchema({ ok: bool("是否成功"), queue: { type: "object", additionalProperties: true }, rate: { type: "object", additionalProperties: true }, recentSolved: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "读取调度状态失败：" + v.error;
			const queue = v.queue || {};
			const rate = v.rate || {};
			const lines = ["调度：并发 " + (queue.running || []).length + "/" + (queue.concurrency || 1) + " · 排队 " + (queue.queued || []).length + " · 30min 尝试 " + (rate.attempts30 || 0) + " · 完成 " + (rate.solved30 || 0)];
			for (const row of (queue.running || []).slice(0, 8)) lines.push("- 运行中：" + row.title + "（第 " + row.attemptN + " 次，" + Math.round((row.elapsedMs || 0) / 1000) + "s，角度 " + (row.angle || "?") + "，角色 " + (row.role || "?") + "）");
			for (const row of (queue.queued || []).slice(0, 8)) lines.push("- 排队 #" + row.position + "：" + row.title);
			for (const row of (v.recentSolved || []).slice(0, 5)) lines.push("- 最近完成：" + row.title + "（" + Math.round((row.durationMs || 0) / 1000) + "s，¥" + Number(row.estCost || 0).toFixed(3) + "）");
			return lines.join("\n");
		},
		execute(_args, exec) { const denied = orchestratorOnly("ctf_schedule", exec); if (denied) return denied; try { return scheduleSummary(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_platform_detect",
		description: "贴一个平台网址，自动探测平台类型（CTFd / 通用 JSON / DASCTF 开放 API）并推断 profile；apply=true 时直接写入平台配置。DASCTF 需要 Token 与平台标识。",
		parameters: objSchema({ baseUrl: str("平台地址（留空用已保存配置；DASCTF 可留空用默认）"), apiToken: str("API Token / CTF2_AGENT_TOKEN（可选）"), platformSlug: str("平台标识（DASCTF 必填，如 dasctf）"), kind: str("强制类型：ctfd / generic / dasctf（可选）"), apply: bool("是否直接应用探测结果") }, []),
		outputSchema: outSchema({ ok: bool("是否成功"), detection: { type: "object", additionalProperties: true }, applied: bool("是否已应用") }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "平台探测失败：" + v.error;
			const d = v.detection || {};
			const lines = ["平台探测：" + d.kind + "（置信度 " + d.confidence + (v.applied ? "，已应用" : "") + "）"];
			for (const item of (d.evidence || []).slice(-4)) lines.push("- " + item.step + "：" + (item.note || item.url || ""));
			if (d.profile) lines.push("- profile: " + JSON.stringify(d.profile).slice(0, 400));
			return lines.join("\n");
		},
		execute(args, exec) { const denied = orchestratorOnly("ctf_platform_detect", exec); if (denied) return denied; return (async () => { try { return await platformDetect(args || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })(); }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_platform_env",
		description: "管理题目靶机环境（DASCTF）：start 启动、status 查询（含 access_ready/剩余秒数）、extend 续期、delete 销毁；只对平台导入的容器题有效。",
		parameters: objSchema({ id: str("本地题目 id"), action: str("start | status | extend | delete（默认 status）") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), environment: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "环境操作失败：" + v.error;
			const env = v.environment || {};
			return "环境 " + v.action + "：status=" + (env.status || "?") + (env.access_ready ? " · access_ready" : "") + (env.remaining_seconds != null ? " · 剩余 " + env.remaining_seconds + "s" : "");
		},
		execute(args) { return (async () => { try { return await platformEnv(args || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })(); }
	}));


	ctx.tools.register(defineToolLite({
		name: "ctf_target_probe",
		description: "探测题目的靶机/目标是否就绪（URL 走 HTTP GET，host:port 走 TCP 连接），结果写入 challenge.targetStatus 并记事件；用于判断是否要等靶机、是否需要续期。",
		parameters: objSchema({ id: str("题目 id"), timeoutMs: num("超时毫秒（默认 4000）") }, ["id"]),
		outputSchema: outSchema({ ok: bool("是否成功"), targetStatus: { type: "object", additionalProperties: true } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "目标探测失败：" + v.error;
			const st = v.targetStatus || {};
			return "目标探测：" + (st.targetRaw || "") + " → " + (st.ok ? "就绪" : st.state) + (st.latencyMs ? "（" + st.latencyMs + "ms）" : "") + (st.error ? "\n" + st.error : "");
		},
		execute(args, exec) {
			const scoped = scopeToolToAccessibleChallenge("ctf_target_probe", exec, args?.id);
			if (!scoped.ok) return scoped;
			return (async () => { try { return await probeChallengeTarget({ ...(args || {}), id: scoped.id }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })();
		}
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_platform_hints",
		description: "查看/解锁 CTF 平台题目提示（CTFd hints）：列出提示，unlock=true 时逐个解锁并把内容落进本地题目的 facts/事件。",
		parameters: objSchema({ challengeId: num("平台题目 id"), unlock: bool("是否解锁（默认只看）"), hintId: num("只解锁指定 hint id（可选）") }, ["challengeId"]),
		outputSchema: outSchema({ ok: bool("是否成功"), hints: { type: "array", items: { type: "object", additionalProperties: true } }, unlocked: { type: "array", items: { type: "object", additionalProperties: true } } }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok) return "提示获取失败：" + v.error;
			const lines = ["平台提示（" + (v.hints ? v.hints.length : 0) + " 条）："];
			for (const hint of v.hints || []) lines.push("- #" + hint.id + (hint.cost != null ? "（" + hint.cost + " 分）" : "") + "：" + (hint.content ? hint.content.slice(0, 200) : "（未解锁）"));
			for (const item of v.unlocked || []) lines.push("- 解锁 #" + item.id + "：" + (item.content ? String(item.content).slice(0, 300) : "失败 " + (item.error || "")));
			return lines.join("\n");
		},
		execute(args, exec) { const denied = orchestratorOnly("ctf_platform_hints", exec); if (denied) return denied; return (async () => { try { return await platformHints(args); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })(); }
	}));

	ctx.tools.register(defineToolLite({
		name: "ctf_wsl_run",
		description: "在 WSL 发行版里执行命令（pwn/逆向工具链在 Linux 侧时用）：自动把 Windows 路径转 /mnt/...，可指定 distro/cwd/timeout。",
		parameters: objSchema({ command: str("要执行的 bash 命令"), distro: str("WSL 发行版（默认取第一个）"), cwd: str("工作目录（Windows 路径，默认当前题目目录）"), challengeId: str("题目 id（决定默认 cwd 与事件记录）"), timeoutMs: num("超时毫秒（默认 120000）") }, ["command"]),
		outputSchema: outSchema({ ok: bool("是否成功"), exitCode: num("退出码"), stdout: str("标准输出"), stderr: str("标准错误"), durationMs: num("耗时毫秒"), distro: str("发行版") }, ["ok"]),
		render: (_a, v) => {
			if (!v.ok && v.error) return "WSL 执行失败：" + v.error;
			const head = "WSL（" + (v.distro || "?") + "）exit " + v.exitCode + " · " + (v.durationMs || 0) + "ms";
			const out = [head, v.stdout ? "--- stdout ---\n" + v.stdout : "", v.stderr ? "--- stderr ---\n" + v.stderr : ""].filter(Boolean).join("\n");
			return out.slice(0, 6000);
		},
		execute(args, exec) {
			const scoped = scopeToolToAccessibleChallenge("ctf_wsl_run", exec, args?.challengeId);
			if (!scoped.ok) return scoped;
			const next = scoped.challenge
				? { ...(args || {}), challengeId: scoped.id, cwd: scoped.challenge.dir }
				: (args || {});
			return (async () => { try { return await runWsl(next); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })();
		}
	}));

	// ── 平台接入 / 工作台 / 复盘（面板端点与工具共用）──────────────────────
	function safeFileName(name) {
		const base = String(name ?? "").split(/[\\/]/).pop() || "file.bin";
		const cleaned = base.replace(/[^\w.\-]+/g, "_").slice(0, 120);
		return cleaned || `file-${Date.now()}.bin`;
	}

	/** 靶机环境操作（DASCTF MCP）：start / status / extend / delete。 */
	async function platformEnv(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: "题目不存在：" + payload.id };
		const meta = ch.platform;
		if (!meta || !meta.challengeId) return { ok: false, error: "该题没有平台信息（需从平台导入）" };
		const built = platformClientFromCfg(readPlatformConfig());
		if (!built.client) return { ok: false, error: built.error || "平台客户端不可用" };
		if (typeof built.client.environment !== "function") return { ok: false, error: "当前适配器不支持靶机环境操作" };
		const action = String(payload.action || "status");
		if (!["start", "status", "extend", "delete"].includes(action)) return { ok: false, error: "未知动作：" + action };
		const res = await built.client.environment(action, { id: meta.challengeId, meta });
		if (!res.ok) {
			store.addEvent(ch.id, "error", `靶机环境 ${action} 失败：${res.error || ""}`.slice(0, 300));
			return { ok: false, error: res.error || "环境操作失败" };
		}
		const environment = res.environment || {};
		try { store.update(ch.id, { environment: { action, at: Date.now(), ...environment } }); } catch { /* ignore */ }
		store.addEvent(ch.id, "note", `靶机环境 ${action}：` + (environment.status || "?") + (environment.access_ready ? "（access_ready）" : "") + (environment.remaining_seconds != null ? `，剩余 ${environment.remaining_seconds}s` : ""));
		return { ok: true, id: ch.id, action, environment };
	}


	/** 全自动跑板：拉取平台未解题 → 导入 → 入队开始（dryRun 只返回候选）。 */
	/** 重新从平台拉取题目详情，修复旧导入的空题面/缺失附件。 */
	async function refreshChallenge(payload = {}) {
		const pc = platformClientOrNull();
		if (!pc) return { ok: false, error: "平台未配置" };
		const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => String(id || "")).filter(Boolean) : [];
		const pool = ids.length ? ids.map((id) => store.get(id)).filter(Boolean) : store.list().filter((c) => c && c.platform && c.platform.challengeId);
		const refreshed = [];
		const errors = [];
		for (const ch of pool) {
			if (!ch.platform || !ch.platform.challengeId) continue;
			if (ch.platform.kind && ch.platform.kind !== "dasctf") continue;
			if (payload.onlyEmpty !== false && String(ch.statement || "").length > 200 && Array.isArray(ch.files) && ch.files.length > 0) continue;
			try {
				const meta = ch.platform;
				const detailRes = await pc.client.getChallenge(meta.challengeId, {
					id: meta.challengeId, practice_ground_id: meta.groundId || "",
					source: { type: meta.sourceType || "practice", practice_ground_id: meta.groundId || "", competition_id: meta.competitionId || "", stage_id: meta.stageId || "" }
				});
				if (!detailRes.ok) { errors.push({ id: ch.id, error: detailRes.error }); continue; }
				const detail = detailRes.data;
				const platformUrl = normalizeBaseUrl(pc.baseUrl || pc.cfg.baseUrl || "");
				const parts = [];
				if (detail.description) parts.push(String(detail.description));
				if (detail.connectionInfo) parts.push(`连接信息：${detail.connectionInfo}`);
				parts.push(`平台题号：${meta.challengeId}（${platformUrl}）`);
				const files = [];
				for (const f of (detail.files || []).slice(0, 5)) {
					if (!f || !f.url) continue;
					const dl = await pc.client.download(f.url, { maxBytes: 20 * 1024 * 1024 });
					if (!dl.ok) continue;
					const safeName = String(f.name || dl.filename || "file.bin").replace(/[\\/:*?"<>|]/g, "_");
					const dir = path.join(ch.dir, "files");
					try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
					const filePath = path.join(dir, safeName);
					try { fs.writeFileSync(filePath, dl.bytes); files.push({ name: safeName, path: path.relative(ch.dir, filePath), size: dl.size }); } catch { /* ignore */ }
				}
				if (files.length) parts.push("\n附件：\n" + files.map((f) => `- files/${f.name}（${f.size} B）`).join("\n"));
				store.update(ch.id, { statement: parts.join("\n\n"), files, category: String(detail.category || ch.category || ""), target: String(detail.connectionInfo || ch.target || "") });
				try { fs.writeFileSync(path.join(ch.dir, "statement.md"), parts.join("\n\n") + "\n"); } catch { /* ignore */ }
				store.addEvent(ch.id, "note", `已从平台刷新题面${files.length ? `并下载 ${files.length} 个附件` : ""}`);
				refreshed.push({ id: ch.id, title: ch.title, files: files.length, statementLength: parts.join("\n\n").length });
			} catch (e) { errors.push({ id: ch.id, error: String((e && e.message) || e) }); }
		}
		return { ok: true, refreshed, errors, scanned: pool.length };
	}

	async function pipelineRun(payload = {}) {
		const pc = platformClientOrNull();
		if (!pc) return { ok: false, error: "平台未配置：请先在平台面板填写 Token" };
		const limit = Math.max(1, Math.min(50, Number(payload.limit) || Number(cfg.autoFetchLimit) || 5));
		const listRes = await pc.client.listChallenges();
		if (!listRes.ok) return { ok: false, error: listRes.error };
		const baseUrl = normalizeBaseUrl(pc.baseUrl || pc.cfg.baseUrl);
		const existing = new Set(store.list().filter((c) => c && c.platform && normalizeBaseUrl(c.platform.baseUrl || "") === baseUrl).map((c) => String(c.platform.challengeId)));
		const candidates = (listRes.data || []).filter((c) => c && c.id != null && !c.solvedByMe && !existing.has(String(c.id))).slice(0, limit);
		if (payload.dryRun === true) return { ok: true, dryRun: true, limit, candidates: candidates.map((c) => ({ id: String(c.id), name: c.name || "", category: c.category || "", value: c.value == null ? null : c.value })) };
		if (candidates.length === 0) return { ok: true, imported: 0, started: [], candidates: 0, note: "没有新的未解题可导入" };
		const ids = candidates.map((c) => String(c.id));
		const imp = await platformImport({ ids, skipSolved: true, sessionId: payload.sessionId }, undefined);
		const createdIds = (imp.created || []).map((item) => item.id || item.localId).filter(Boolean);
		let started = [];
		if (payload.start !== false && cfg.autoSolveImported !== false && createdIds.length > 0) {
			const startRes = startChallenges({ ids: createdIds, sessionId: payload.sessionId });
			started = startRes.started || [];
		}
		return { ok: true, imported: createdIds.length, created: imp.created || [], started, skipped: imp.skipped || [], errors: imp.errors || [], candidates: candidates.length };
	}

	const autoSubmitInflight = new Set();
	/** 自动提交：本地 verified flag 登记后，自动提交到来源平台（每 flag 一次，需 autoSubmitEnabled）。 */
	async function autoSubmitFlag(id, flag) {
		const ch = store.get(String(id || ""));
		if (!ch || !ch.platform || !flag) return;
		if (cfg.autoSubmitEnabled === false) return;
		if (autoSubmitInflight.has(ch.id)) return;
		const prev = ch.platformSubmit || null;
		if (prev && prev.flag === flag && (prev.status === "correct" || prev.status === "already_solved" || prev.status === "pending")) return;
		autoSubmitInflight.add(ch.id);
		try {
			store.update(ch.id, { platformSubmit: { status: "pending", flag, at: Date.now() } });
			const res = await platformSubmit({ id: ch.id, flag });
			const status = res && res.ok ? String(res.status || "correct") : "error";
			store.update(ch.id, { platformSubmit: { status, flag, message: String((res && res.message) || (res && res.error) || ""), at: Date.now() } });
			store.addEvent(ch.id, res && res.ok ? "flag" : "error", `自动提交 flag：${status}` + (res && res.message ? `（${String(res.message).slice(0, 120)}）` : ""));
		} catch (e) {
			store.addEvent(ch.id, "error", "自动提交异常：" + String((e && e.message) || e).slice(0, 200));
		} finally {
			autoSubmitInflight.delete(ch.id);
		}
	}

	let lastAutoFetchAt = 0;
	/** 周期自动拉题（autoFetchEnabled 时由 watchdog 调用）。 */
	async function autoPipelineTick() {
		if (cfg.autoFetchEnabled !== true) return;
		const interval = Math.max(60000, Number(cfg.autoFetchIntervalMs) || 300000);
		if (Date.now() - lastAutoFetchAt < interval) return;
		lastAutoFetchAt = Date.now();
		try {
			const res = await pipelineRun({ limit: Number(cfg.autoFetchLimit) || 5 });
			if (res.ok && res.imported) console.log(`[ctf-auto] auto pipeline: imported ${res.imported}, started ${(res.started || []).length}`);
		} catch (e) { console.error("[ctf-auto] auto pipeline error: " + String((e && e.message) || e)); }
	}

	async function platformStatus() {
		const built = platformClientFromCfg(readPlatformConfig());
		if (!built.client) {
			return { ok: true, configured: false, kind: built.kind, baseUrl: built.baseUrl, platformSlug: built.platformSlug, tokenSet: !!built.token, reachable: false, error: built.error || "" };
		}
		const res = built.kind === "generic" ? await built.client.listChallenges() : await built.client.me();
		return {
			ok: true, configured: true, kind: built.kind, baseUrl: built.baseUrl, platformSlug: built.platformSlug, tokenSet: true,
			reachable: res.ok,
			user: !res.ok ? null : (built.kind === "generic" ? { name: "generic", challenges: (res.data || []).length } : res.data),
			paths: res.path || "",
			error: res.ok ? "" : res.error
		};
	}

	async function platformImport(payload, exec) {
		const pc = platformClientOrNull();
		if (!pc) return { ok: false, error: "平台未配置：请先在平台面板填写 baseUrl 与 API Token" };
		const ids = Array.isArray(payload.ids)
			? payload.ids.map((value) => String(value ?? "").trim()).filter(Boolean)
			: [];
		const wantAll = payload.all === true || ids.length === 0;
		const skipSolved = payload.skipSolved !== false;
		const startAfter = payload.start === true;
		const listRes = await pc.client.listChallenges();
		if (!listRes.ok) return { ok: false, error: listRes.error };
		const baseUrl = normalizeBaseUrl(pc.baseUrl || pc.cfg.baseUrl);
		let items = Array.isArray(listRes.data) ? listRes.data : [];
		if (!wantAll) items = items.filter((c) => ids.includes(String(c.id ?? "")));
		items = items.slice(0, MAX_IMPORT_CHALLENGES);
		const created = [];
		const skipped = [];
		const errors = [];
		const workspace = exec?.agent ? workspaceOfExec(exec) : workspaceForRequest(payload);
		const baseDir = exec?.agent ? baseDirOf(exec) : (workspace ? path.join(workspace, ".ctf-auto") : baseDirOf());
		for (const item of items) {
			const platformId = String(item.id ?? "").trim();
			if (!platformId) continue;
			if (skipSolved && item.solvedByMe) { skipped.push({ platformId, reason: "平台已解" }); continue; }
			const dup = store.list().find((c) => c.platform && String(c.platform.challengeId) === platformId && normalizeBaseUrl(c.platform.baseUrl || "") === baseUrl && (!workspace || sameWorkspace(challengeWorkspace(c), workspace)));
			if (dup) { skipped.push({ platformId, reason: "已导入", localId: dup.id }); continue; }
			try {
				const detailRes = await pc.client.getChallenge(platformId, item);
				const detail = detailRes.ok ? detailRes.data : item;
				const statementParts = [];
				if (detail.description) statementParts.push(String(detail.description));
				if (detail.connectionInfo) statementParts.push(`连接信息：${detail.connectionInfo}`);
				statementParts.push(`平台题号：${platformId}（${baseUrl}）`);
				const ch = addChallenge({
					title: String(detail.name || item.name || `challenge-${platformId}`),
					category: String(detail.category || item.category || ""),
					statement: statementParts.join("\n\n"),
					target: String(detail.connectionInfo || ""),
					platform: {
						kind: pc.cfg.kind,
						baseUrl,
						challengeId: platformId,
							platformSlug: String(pc.cfg.platformSlug || ""),
							mcpUrl: String(pc.cfg.mcpUrl || ""),
							groundId: String(item.groundId || ""),
							sourceType: String(item.type || "practice"),
							competitionId: String(item.competitionId || ""),
							stageId: String(item.stageId || ""),
							profile: (pc.cfg.kind === "generic" || pc.cfg.kind === "dasctf") ? pc.cfg.profile || null : null,
					},
					files: []
				}, baseDir);
				const files = [];
				const rawFiles = Array.isArray(detail.files) ? detail.files : (Array.isArray(item.files) ? item.files : []);
				for (const f of rawFiles.slice(0, 10)) {
					const url = typeof f === "string" ? f : f && f.url;
					if (!url) continue;
					const dl = await pc.client.download(url, { maxBytes: 20 * 1024 * 1024 });
					if (!dl.ok) { store.addEvent(ch.id, "error", `附件下载失败 ${url}：${dl.error}`); continue; }
					const name = safeFileName(dl.filename || (f && f.name) || "file.bin");
					const dest = path.join(ch.dir, "files", name);
					fs.mkdirSync(path.dirname(dest), { recursive: true });
					fs.writeFileSync(dest, Buffer.from(dl.bytes), { mode: 0o600 });
					try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
					files.push({ name, path: dest, source: "platform", url: String(url) });
				}
				if (files.length) store.update(ch.id, { files });
				if (exec && exec.agent) {
					driverByChallenge.set(ch.id, exec.agent);
					lastDriver = exec.agent;
					store.update(ch.id, { driverSession: String(exec.agent.id) });
				}
				store.addEvent(ch.id, "note", `从平台导入（${baseUrl} #${platformId}）`);
				if (!startAfter) store.setStatus(ch.id, "stopped", { note: "平台导入完成，等待手动开始" });
				created.push({ localId: ch.id, platformId, title: ch.title, status: store.get(ch.id)?.status ?? ch.status });
				if (startAfter) { try { orchestrator.start(ch.id, { agentPreset: cfg.solverPreset }); } catch { /* 单题启动失败不影响导入 */ } }
			} catch (e) {
				errors.push({ platformId, error: String((e && e.message) || e) });
			}
		}
		return { ok: true, created, skipped, errors };
	}

	async function platformSubmit(payload) {
		const id = String(payload.id ?? "");
		const ch = store.get(id);
		if (!ch) return { ok: false, error: `题目不存在：${id}` };
		const flag = String(payload.flag ?? "").trim();
		if (!flag) return { ok: false, error: "flag 不能为空" };
		const meta = ch.platform;
		if (!meta || !meta.challengeId) return { ok: false, error: "该题没有平台信息，无法提交（需从平台导入的题目）" };
		const cfg = readPlatformConfig();
		if (!cfg.apiToken) return { ok: false, error: "平台未配置：请先在平台面板填写 API Token" };
		const baseUrl = normalizeBaseUrl(meta.baseUrl || cfg.baseUrl);
		if (!baseUrl) return { ok: false, error: "平台地址为空" };
		const kind = meta.kind || cfg.kind;
		const profile = meta.profile || cfg.profile || {};
		const built = platformClientFromCfg({ ...cfg, kind: kind, baseUrl, profile });
		if (!built.client) return { ok: false, error: built.error || "平台客户端不可用" };
		const res = await built.client.submit(meta.challengeId, flag, meta);
		if (!res.ok) {
			store.addEvent(ch.id, "error", `平台提交失败：${res.error}`.slice(0, 300));
			return { ok: false, error: res.error };
		}
		const status = String((res.data && res.data.status) || "");
		const message = String((res.data && res.data.message) || "");
		const accepted = status === "correct" || status === "already_solved";
		store.addEvent(ch.id, accepted ? "flag" : "note", `平台提交（${status || "?"}）：${message}`.slice(0, 400));
		if (accepted) recordFlag(
			{ id: ch.id, flag, verified: true, evidence: `平台提交回显：${status}${message ? ` ${message}` : ""}`, method: "platform" },
			{ allowPlatformVerification: true },
		);
		return { ok: accepted, status, message };
	}

	function workbenchTree(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: `题目不存在：${payload.id}` };
		const res = workbench.listTree(ch.dir);
		if (!res || res.ok === false) return { ok: false, error: (res && res.error) || "读取目录失败" };
		return { ok: true, dir: ch.dir, entries: res.entries ?? res };
	}

	function workbenchRead(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: `题目不存在：${payload.id}` };
		const res = workbench.readText(ch.dir, String(payload.path ?? ""), Number(payload.maxBytes) > 0 ? Number(payload.maxBytes) : undefined);
		if (!res || res.ok === false) return { ok: false, error: (res && res.error) || "读取失败" };
		return { ok: true, path: res.path ?? String(payload.path ?? ""), text: res.text ?? "", size: res.size ?? Buffer.byteLength(String(res.text ?? "")), truncated: !!res.truncated };
	}

	function workbenchWrite(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: `题目不存在：${payload.id}` };
		const res = workbench.writeText(ch.dir, String(payload.path ?? ""), String(payload.text ?? ""));
		if (!res || res.ok === false) return { ok: false, error: (res && res.error) || "写入失败" };
		store.addEvent(ch.id, "note", `工作台写入 ${res.path ?? payload.path}（${res.bytes ?? Buffer.byteLength(String(payload.text ?? ""))} 字节）`);
		return { ok: true, path: res.path ?? String(payload.path ?? ""), bytes: res.bytes ?? Buffer.byteLength(String(payload.text ?? "")) };
	}

	/** 允许清理的目录：题板根目录内，或任意会话工作区的 .ctf-auto 下。 */
	function removableDir(dir) {
		try {
			const resolved = path.resolve(String(dir ?? ""));
			if (!resolved) return false;
			const rootResolved = path.resolve(rootDir);
			if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) return true;
			return resolved.includes(path.sep + ".ctf-auto" + path.sep);
		} catch { return false; }
	}

	function removeChallenge(payload) {
		const id = String(payload.id ?? "");
		const ch = store.get(id);
		if (!ch) return { ok: false, error: "题目不存在：" + id };
		if (orchestrator.isRunning(id)) { try { orchestrator.stop(id); } catch { /* ignore */ } }
		let filesRemoved = false;
		const wantFiles = payload.deleteFiles === true;
		const removed = store.remove(id);
		if (!removed) return { ok: false, error: "移除失败：" + id };
		if (wantFiles && removableDir(ch.dir)) {
			try { fs.rmSync(path.resolve(ch.dir), { recursive: true, force: true }); filesRemoved = true; } catch { /* 目录删不掉不影响从题板移除 */ }
		}
		return { ok: true, id, filesRemoved };
	}

	function removeSession(payload) {
		const sessionId = String(payload.sessionId ?? "");
		const matches = store.list().filter((c) => String(c.driverSession ?? "") === sessionId);
		const ids = [];
		let filesRemoved = 0;
		for (const ch of matches) {
			if (orchestrator.isRunning(ch.id)) { try { orchestrator.stop(ch.id); } catch { /* ignore */ } }
			if (store.remove(ch.id)) {
				ids.push(ch.id);
				if (payload.deleteFiles === true && removableDir(ch.dir)) {
					try { fs.rmSync(path.resolve(ch.dir), { recursive: true, force: true }); filesRemoved += 1; } catch { /* ignore */ }
				}
			}
		}
		return { ok: true, sessionId, removed: ids.length, ids, filesRemoved };
	}

	function writeupExport(payload) {
		const id = String(payload.id ?? "");
		const ch = store.get(id);
		if (!ch) return { ok: false, error: "题目不存在：" + id };
		try {
			let notes = "";
			try { notes = fs.readFileSync(path.join(ch.dir, "notes.md"), "utf8"); } catch { notes = ""; }
			let entries = [];
			try {
				const tree = workbench.listTree(ch.dir);
				if (tree && tree.ok !== false) entries = tree.entries ?? [];
			} catch { entries = []; }
			const markdown = buildWriteup(ch, { generatedAt: Date.now(), notes, files: entries });
			const dir = path.join(rootDir, "writeups");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, (ch.slug || ch.id) + "-writeup.md");
			fs.writeFileSync(file, markdown, { encoding: "utf8", mode: 0o600 });
			store.addEvent(ch.id, "note", "Writeup 已导出：" + file);
			return { ok: true, id: ch.id, path: file, bytes: Buffer.byteLength(markdown), markdown: markdown.slice(0, 4000) };
		} catch (e) {
			return { ok: false, error: String((e && e.message) || e) };
		}
	}

	function writeupList(workspace) {
		try {
			const dir = path.join(rootDir, "writeups");
			let names = [];
			try { names = fs.readdirSync(dir); } catch { names = []; }
			const ws = normalizeWorkspace(workspace);
			const allowed = ws
				? new Set(visibleChallenges(ws).map((c) => String(c.slug || c.id) + "-writeup.md"))
				: null;
			const writeups = names.filter((name) => /\.md$/i.test(name) && (!allowed || allowed.has(name))).map((name) => {
				const file = path.join(dir, name);
				try { const st = fs.statSync(file); return { name, path: file, bytes: st.size, mtime: st.mtimeMs }; } catch { return null; }
			}).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 100);
			return { ok: true, dir, workspace: ws, writeups };
		} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}	function writeupRead(payload, workspace) {
		try {
			const name = String(payload.name ?? "");
			if (!/^[\w.\-]+\.md$/i.test(name)) return { ok: false, error: "Writeup 名非法" };
			const ws = normalizeWorkspace(workspace);
			if (ws && !visibleChallenges(ws).some((c) => name.indexOf(String(c.slug || c.id) + "-writeup") === 0)) {
				return { ok: false, error: "该 Writeup 不属于当前工作区" };
			}
			const file = path.join(rootDir, "writeups", name);
			const text = fs.readFileSync(file, "utf8");
			return { ok: true, name, path: file, markdown: text.slice(0, 8000), bytes: Buffer.byteLength(text) };
		} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}	// ── P1：知识检索 / 附件分诊 / WP 打包 / 独立复核 ─────────────────────
	let kbCache = { at: 0, entries: [] };
	function scanKnowledge(force) {
		if (!force && kbCache.entries.length > 0 && Date.now() - kbCache.at < 15000) return kbCache.entries;
		const writeups = [];
		try {
			const dir = path.join(rootDir, "writeups");
			for (const name of fs.readdirSync(dir)) {
				if (!/\.md$/i.test(name)) continue;
				const file = path.join(dir, name);
				try {
					const st = fs.statSync(file);
					writeups.push({ name, path: file, text: fs.readFileSync(file, "utf8"), mtime: st.mtimeMs });
				} catch { /* 单个文件失败跳过 */ }
			}
		} catch { /* 目录不存在 */ }
		const notes = [];
		for (const ch of store.list()) {
			try {
				const file = path.join(ch.dir, "notes.md");
				const st = fs.statSync(file);
				notes.push({ challengeId: ch.id, title: ch.title, category: ch.category, workspace: challengeWorkspace(ch), path: file, text: fs.readFileSync(file, "utf8"), mtime: st.mtimeMs });
			} catch { /* 该题没有 notes */ }
		}
		const imported = [];
		try {
			const dir = knowledgeDir();
			for (const name of fs.readdirSync(dir)) {
				if (!/\.(md|markdown|txt)$/i.test(name)) continue;
				const file = path.join(dir, name);
				try {
					const st = fs.statSync(file);
					imported.push({ name, path: file, text: fs.readFileSync(file, "utf8"), mtime: st.mtimeMs });
				} catch { /* 单文件失败跳过 */ }
			}
		} catch { /* 没有 knowledge/ */ }
		const entries = buildKnowledgeIndex({ writeups, notes, imported });
		kbCache = { at: Date.now(), entries };
		return entries;
	}

	function kbSearch(payload) {
		const query = String(payload.q ?? "").trim();
		if (!query) return { ok: false, error: "检索词为空" };
		const entries = scanKnowledge(false);
		const limit = Math.max(1, Math.min(50, Number(payload.limit) || 10));
		const results = searchKnowledge(entries, query, { limit });
		return { ok: true, query, total: entries.length, results };
	}

	function knowledgeDir() { return path.join(rootDir, "knowledge"); }

	function kbStats() {
		const entries = scanKnowledge(false);
		const count = (source) => entries.filter((entry) => entry.source === source).length;
		return {
			ok: true,
			dir: knowledgeDir(),
			writeupsDir: path.join(rootDir, "writeups"),
			stats: {
				total: entries.length,
				imported: count("imported"),
				writeups: count("writeup"),
				notes: count("notes")
			},
			usage: knowledgeUsageStats()
		};
	}

	function readKnowledge(payload) {
		const name = String(payload.name ?? "");
		if (!/^[\w.\-]+\.(md|markdown|txt)$/i.test(name)) return { ok: false, error: "文件名非法" };
		const file = path.join(knowledgeDir(), name);
		try {
			const st = fs.statSync(file);
			if (st.size > 2 * 1024 * 1024) return { ok: false, error: "文件过大（>2MB）" };
			const text = fs.readFileSync(file, "utf8");
			return { ok: true, name, path: file, markdown: text.slice(0, 20000), bytes: st.size };
		} catch (e) { return { ok: false, error: "读取失败：" + String((e && e.message) || e) }; }
	}

	function listKnowledge() {
		const dir = knowledgeDir();
		let names = [];
		try { names = fs.readdirSync(dir); } catch { names = []; }
		const files = names.filter((name) => /\.(md|markdown|txt)$/i.test(name)).map((name) => {
			const file = path.join(dir, name);
			try { const st = fs.statSync(file); return { name, path: file, bytes: st.size, mtime: st.mtimeMs }; } catch { return null; }
		}).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
		return { ok: true, dir, files };
	}

	function importKnowledge(payload) {
		const raw = parseImportInput(payload.files ?? payload.paths ?? payload.text ?? []);
		if (raw.length === 0) return { ok: false, error: "没有可导入的路径（一行一个 md/txt 文件或目录）" };
		const cwd = payload.cwd ? String(payload.cwd) : (workspaceForRequest(payload) || process.cwd());
		const dir = knowledgeDir();
		const imported = [];
		const errors = [];
		let totalBytes = 0;
		fs.mkdirSync(dir, { recursive: true });
		const taken = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
		const importOne = (file, baseName) => {
			try {
				if (imported.length >= MAX_IMPORT_FILES) return;
				const st = fs.statSync(file);
				if (!st.isFile()) return;
				if (st.size > MAX_IMPORT_BYTES) { errors.push({ path: file, error: "超过单文件上限（2MB）" }); return; }
				if (totalBytes + st.size > MAX_IMPORT_TOTAL_BYTES) { errors.push({ path: file, error: "超过知识库单次总大小上限" }); return; }
				const name = safeKnowledgeName(baseName, taken.concat(imported.map((item) => item.name)));
				const dest = path.join(dir, name);
				fs.copyFileSync(file, dest);
				try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
				const copy = fs.statSync(dest);
				imported.push({ name, path: dest, bytes: copy.size, from: file });
				totalBytes += copy.size;
			} catch (e) { errors.push({ path: file, error: String((e && e.message) || e) }); }
		};
		for (const rawPath of raw.slice(0, MAX_IMPORT_FILES)) {
			const norm = normalizeImportPath(rawPath, { cwd });
			if (!norm.ok) { errors.push({ path: rawPath, error: norm.error }); continue; }
			try {
				const st = fs.statSync(norm.path);
				if (st.isDirectory()) {
					const names = fs.readdirSync(norm.path).filter((name) => /\.(md|markdown|txt)$/i.test(name)).slice(0, MAX_IMPORT_FILES);
					if (names.length === 0) errors.push({ path: norm.path, error: "目录下没有 md/txt" });
					for (const name of names) importOne(path.join(norm.path, name), name);
					continue;
				}
				importOne(norm.path, path.basename(norm.path));
			} catch (e) { errors.push({ path: rawPath, error: String((e && e.message) || e) }); }
		}
		kbCache = { at: 0, entries: [] };
		return { ok: true, dir, imported, errors };
	}

	function deleteKnowledge(payload) {
		const name = String(payload.name ?? "");
		if (!/^[\w.\-]+\.(md|markdown|txt)$/i.test(name)) return { ok: false, error: "文件名非法" };
		const file = path.join(knowledgeDir(), name);
		if (!fs.existsSync(file)) return { ok: false, error: "文件不存在：" + name };
		try {
			fs.unlinkSync(file);
			kbCache = { at: 0, entries: [] };
			return { ok: true, name };
		} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}

	function knowledgeUsagePath() { return path.join(rootDir, "knowledge-usage.json"); }

	function readKnowledgeUsage() {
		try {
			const raw = JSON.parse(fs.readFileSync(knowledgeUsagePath(), "utf8"));
			const map = raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
			return { version: 1, entries: map };
		} catch { return { version: 1, entries: {} }; }
	}

	function writeKnowledgeUsage(data) {
		try {
			fs.mkdirSync(rootDir, { recursive: true });
			const file = knowledgeUsagePath();
			const tmp = file + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
			fs.renameSync(tmp, file);
			try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
			return true;
		} catch { return false; }
	}

	function bumpKnowledgeUsage(ids, ok) {
		if (!Array.isArray(ids) || ids.length === 0) return;
		const data = readKnowledgeUsage();
		for (const id of ids) {
			const key = String(id || "");
			if (!key) continue;
			const row = data.entries[key] || { used: 0, usedOk: 0 };
			row.used = (Number(row.used) || 0) + 1;
			if (ok) row.usedOk = (Number(row.usedOk) || 0) + 1;
			row.lastUsedAt = Date.now();
			data.entries[key] = row;
		}
		writeKnowledgeUsage(data);
	}

	function knowledgeUsageStats() {
		const data = readKnowledgeUsage();
		let used = 0;
		let usedOk = 0;
		for (const row of Object.values(data.entries)) { used += Number(row.used) || 0; usedOk += Number(row.usedOk) || 0; }
		return { used, usedOk, entries: data.entries };
	}

	function recallKnowledgeFor(challenge, options = {}) {
		try {
			if (!challenge) return [];
			const entries = scanKnowledge(false);
			if (entries.length === 0) return [];
			const summary = { title: challenge.title, statement: challenge.statement, category: challenge.category, target: challenge.target };
			return rankKnowledge(entries, summary, {
				limit: Number(options && options.knowledgeLimit) || Number(cfg.knowledgeTopK) || 3,
				minScore: Number.isFinite(Number(cfg.knowledgeMinScore)) ? Number(cfg.knowledgeMinScore) : 0.08
			});
		} catch { return []; }
	}

	function recallFor(challenge, options = {}) {
		return {
			memories: recallMemoriesFor(challenge, options),
			knowledge: recallKnowledgeFor(challenge, options)
		};
	}

	function memoryPath() { return path.join(rootDir, "memory.json"); }

	function readMemoryStore() {
		try {
			const raw = JSON.parse(fs.readFileSync(memoryPath(), "utf8"));
			const cards = Array.isArray(raw && raw.cards) ? raw.cards.filter((card) => card && card.id) : [];
			return { version: 1, cards };
		} catch { return { version: 1, cards: [] }; }
	}

	function writeMemoryStore(storeNext) {
		try {
			fs.mkdirSync(rootDir, { recursive: true });
			const file = memoryPath();
			const tmp = file + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(storeNext, null, 2), { encoding: "utf8", mode: 0o600 });
			fs.renameSync(tmp, file);
			try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
			return true;
		} catch { return false; }
	}

	function memoryStatsOf(cards) {
		const list = Array.isArray(cards) ? cards : [];
		const tech = new Map();
		let used = 0;
		let usedOk = 0;
		for (const card of list) {
			for (const tag of card.tech || []) tech.set(tag, (tech.get(tag) || 0) + 1);
			used += Number(card.used) || 0;
			usedOk += Number(card.usedOk) || 0;
		}
		return {
			cards: list.length,
			used,
			usedOk,
			topTech: [...tech.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count }))
		};
	}

	function memoryCards() {
		const data = readMemoryStore();
		const cards = data.cards.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		return { ok: true, path: memoryPath(), cards, stats: memoryStatsOf(cards) };
	}

	function distillMemory(id) {
		const ch = store.get(String(id ?? ""));
		if (!ch) return { ok: false, error: "题目不存在：" + id };
		if (ch.status !== "solved") return { ok: false, error: "只有已解题目能沉淀打法卡" };
		try {
			let notes = "";
			try { notes = fs.readFileSync(path.join(ch.dir, "notes.md"), "utf8"); } catch { notes = ""; }
			let writeup = "";
			try { writeup = fs.readFileSync(path.join(rootDir, "writeups", String(ch.slug || ch.id) + "-writeup.md"), "utf8"); } catch { writeup = ""; }
			const card = distillCard(ch, { notes, writeup });
			const data = readMemoryStore();
			const index = data.cards.findIndex((item) => item && item.sourceChallengeId === ch.id);
			if (index >= 0) {
				const old = data.cards[index];
				card.id = old.id || card.id;
				card.createdAt = old.createdAt || card.createdAt;
				card.used = Number(old.used) || 0;
				card.usedOk = Number(old.usedOk) || 0;
				card.updatedAt = Date.now();
				data.cards[index] = card;
			} else {
				data.cards.push(card);
			}
			writeMemoryStore(data);
			store.addEvent(ch.id, "note", "打法卡已沉淀：" + (card.tech.length ? card.tech.slice(0, 4).join("、") : "通用记录"));
			return { ok: true, card, stats: memoryStatsOf(data.cards) };
		} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}

	function distillAllSolved() {
		const data = readMemoryStore();
		const have = new Set(data.cards.map((card) => card.sourceChallengeId));
		const todo = store.list().filter((ch) => ch && ch.status === "solved" && !have.has(ch.id)).slice(0, 20);
		const distilled = [];
		for (const ch of todo) {
			const result = distillMemory(ch.id);
			if (result.ok) distilled.push(result.card);
		}
		return { ok: true, distilled: distilled.length, cards: distilled, stats: memoryStatsOf(readMemoryStore().cards) };
	}

	function recallMemoriesFor(challenge, options = {}) {
		try {
			const cards = readMemoryStore().cards;
			if (cards.length === 0 || !challenge) return [];
			const summary = {
				id: challenge.id,
				title: challenge.title,
				statement: challenge.statement,
				category: challenge.category,
				target: challenge.target,
				files: challenge.files
			};
			return rankMemories(cards, summary, {
				limit: Number(options.limit) || Number(cfg.memoryTopK) || 3,
				minScore: Number.isFinite(Number(cfg.memoryMinScore)) ? Number(cfg.memoryMinScore) : 0.3
			});
		} catch { return []; }
	}

	function bumpMemoryUsage(ids, ok) {
		if (!Array.isArray(ids) || ids.length === 0) return;
		const idSet = new Set(ids.map((id) => String(id)));
		const data = readMemoryStore();
		let changed = false;
		for (const card of data.cards) {
			if (!card || !idSet.has(String(card.id))) continue;
			card.used = (Number(card.used) || 0) + 1;
			if (ok) card.usedOk = (Number(card.usedOk) || 0) + 1;
			card.lastUsedAt = Date.now();
			changed = true;
		}
		if (changed) writeMemoryStore(data);
	}

	function autoDistillTick() {
		if (cfg.autoDistill === false) return;
		try {
			const data = readMemoryStore();
			const have = new Set(data.cards.map((card) => card.sourceChallengeId));
			const todo = store.list().filter((ch) => ch && ch.status === "solved" && !have.has(ch.id)).slice(0, 2);
			for (const ch of todo) distillMemory(ch.id);
		} catch { /* 沉淀失败不影响主流程 */ }
	}

	function memorySummary(payload) {
		const all = store.list();
		const agg = aggregatesOf(all);
		const facts = [];
		for (const ch of all) {
			for (const fact of ch.facts ?? []) {
				facts.push({
					challengeId: ch.id,
					title: ch.title,
					category: ch.category || "",
					workspace: challengeWorkspace(ch),
					at: Number(fact.at) || 0,
					text: String(fact.text || ""),
					kind: fact.kind || classifyFactKind(fact.text)
				});
			}
		}
		facts.sort((a, b) => b.at - a.at);
		const limit = Math.max(1, Math.min(200, Number(payload.limit) || 80));
		return {
			ok: true,
			dir: rootDir,
			kinds: FACT_KINDS,
			workspaces: agg.byWorkspace,
			memory: (() => { const cards = readMemoryStore().cards; return { ...memoryStatsOf(cards), path: memoryPath(), recent: cards.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12) }; })(),
			timing: agg.timing,
			totals: {
				workspaces: agg.byWorkspace.length,
				challenges: all.length,
				solved: all.filter((ch) => ch.status === "solved").length,
				facts: facts.length,
				attempts: agg.timing.attempts
			},
			facts: facts.slice(0, limit)
		};
	}

	function readHead(file, bytes) {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(bytes);
			const read = fs.readSync(fd, buf, 0, bytes, 0);
			return buf.slice(0, read);
		} finally { fs.closeSync(fd); }
	}

	function triageChallenge(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: "题目不存在：" + payload.id };
		let files = [];
		for (const entry of Array.isArray(ch.files) ? ch.files : []) {
			if (!entry || !entry.path) continue;
			try { files.push({ name: entry.name || path.basename(entry.path), path: entry.path, size: fs.statSync(entry.path).size }); } catch { /* 文件缺失跳过 */ }
		}
		const filesDir = path.join(ch.dir, "files");
		try {
			for (const name of fs.readdirSync(filesDir)) {
				const file = path.join(filesDir, name);
				try { const st = fs.statSync(file); if (st.isFile()) files.push({ name, path: file, size: st.size }); } catch { /* ignore */ }
			}
		} catch { /* 没有 files/ */ }
		// 去重：challenge.files 与 files/ 目录可能指向同一份附件
		const seenFiles = new Set();
		files = files.filter((file) => {
			const key = (() => { try { return path.resolve(file.path).toLowerCase(); } catch { return String(file.path || "").toLowerCase(); } })();
			if (!key || seenFiles.has(key)) return false;
			seenFiles.add(key);
			return true;
		});
		const result = triageFiles(files, { readHead });
		try {
			fs.mkdirSync(path.join(ch.dir, "artifacts"), { recursive: true });
			fs.writeFileSync(path.join(ch.dir, "artifacts", "triage.json"), JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
		} catch { /* 落盘失败不影响返回 */ }
		store.addEvent(ch.id, "note", "附件分诊：" + files.length + " 个文件（" + Object.keys(result.counts).map((k) => k + "×" + result.counts[k]).join("、") + "）");
		return { ok: true, id: ch.id, triage: result };
	}

	function collectPackFiles(dir, rel, out, budget) {
		let names = [];
		try { names = fs.readdirSync(path.join(dir, rel)); } catch { return; }
		for (const name of names) {
			if (budget.count >= 200 || budget.bytes >= budget.maxBytes) return;
			const childRel = rel ? rel + "/" + name : name;
			const abs = path.join(dir, childRel);
			let st;
			try { st = fs.lstatSync(abs); } catch { continue; }
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) { collectPackFiles(dir, childRel, out, budget); continue; }
			if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
			if (budget.bytes + st.size > budget.maxBytes) continue;
			try {
				out.push({ name: childRel, data: fs.readFileSync(abs), mtime: st.mtimeMs });
				budget.count += 1;
				budget.bytes += st.size;
			} catch { /* ignore */ }
		}
	}

	function packWriteup(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: "题目不存在：" + payload.id };
		try {
			let notes = "";
			try {
				const notesPath = path.join(ch.dir, "notes.md");
				const notesStat = fs.lstatSync(notesPath);
				if (notesStat.isFile()) notes = fs.readFileSync(notesPath, "utf8");
			} catch { notes = ""; }
			const writeup = buildWriteup(ch, { generatedAt: Date.now(), notes });
			const entries = [{ name: "writeup.md", data: writeup, mtime: Date.now() }];
			const budget = { count: 0, bytes: 0, maxBytes: 20 * 1024 * 1024 };
			for (const sub of ["files", "scripts", "artifacts"]) collectPackFiles(ch.dir, sub, entries, budget);
			for (const rel of ["statement.md", "flag.json"]) {
				try {
					const file = path.join(ch.dir, rel);
					const st = fs.lstatSync(file);
					if (st.isSymbolicLink()) continue;
					if (st.size <= 5 * 1024 * 1024) entries.push({ name: rel, data: fs.readFileSync(file), mtime: st.mtimeMs });
				} catch { /* 不存在 */ }
			}
			const buf = buildTarGz(entries);
			const dir = path.join(rootDir, "packages");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, packFileName(ch.slug || ch.id));
			fs.writeFileSync(file, buf, { mode: 0o600 });
			store.addEvent(ch.id, "note", "WP 打包完成：" + file + "（" + entries.length + " 个文件）");
			return { ok: true, id: ch.id, path: file, bytes: buf.length, files: entries.length };
		} catch (e) {
			return { ok: false, error: String((e && e.message) || e) };
		}
	}

	function sleep(ms) { return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === "function") t.unref(); }); }

	async function reviewFlag(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: "题目不存在：" + payload.id };
		const verified = (Array.isArray(ch.flags) ? ch.flags : []).filter((f) => f && f.verified);
		if (verified.length === 0) return { ok: false, error: "该题没有已验证 flag 可复核" };
		const sub = subagentsService();
		if (!sub || typeof sub.startActivation !== "function") return { ok: false, error: "子代理服务不可用" };
		const flag = verified[0];
		const prompt = buildReviewPrompt({
			challenge: ch,
			flag: flag.value,
			evidence: String(flag.evidence ?? ""),
			roleText: loadRoleText("reviewer")
		});
		const controller = new AbortController();
		const handle = spawnAttempt({
			label: "review:" + ch.id,
			prompt,
			cwd: ch.dir,
			agentPreset: cfg.solverPreset,
			attempt: { n: 0, angle: "review", role: "reviewer" },
			challenge: ch,
			signal: controller.signal
		});
		const timeoutMs = 5 * 60 * 1000;
		let timer = null;
		const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs); if (typeof timer.unref === "function") timer.unref(); });
		const result = await Promise.race([handle.done, timeout]);
		if (timer) clearTimeout(timer);
		if (result && result.__timeout) {
			try { handle.interrupt(); } catch { /* ignore */ }
			return { ok: false, error: "复核超时（5 分钟）" };
		}
		const text = String(result && result.outputText ? result.outputText : "");
		const verdict = (/REVIEW:\s*REJECTED/i.test(text) ? "rejected" : /REVIEW:\s*VERIFIED/i.test(text) ? "verified" : "inconclusive");
		const summary = tail(text.replace(/\s+/g, " ").trim(), 400);
		if (verdict === "rejected") {
			for (const f of ch.flags || []) { if (f && f.verified) f.verified = false; }
			store.save();
			store.setStatus(ch.id, "stuck", { stuckReason: "独立复核未通过：" + summary });
			store.addEvent(ch.id, "note", "复核 REJECTED：" + summary);
			store.addFact(ch.id, { text: "[复核] 独立复核未通过：" + summary });
			return { ok: true, id: ch.id, status: "rejected", summary };
		}
		store.update(ch.id, { review: { status: verdict, at: Date.now(), summary } });
		store.addEvent(ch.id, "note", "复核 " + verdict.toUpperCase() + "：" + summary);
		if (verdict === "verified") store.addFact(ch.id, { text: "[复核] 独立复核通过：" + summary });
		return { ok: true, id: ch.id, status: verdict, summary };
	}

	async function platformHints(payload) {
		const pc = platformClientOrNull();
		if (!pc || !pc.client) return { ok: false, error: "平台未配置（面板「平台」里填 baseUrl + API Token）" };
		const challengeId = payload.challengeId ?? payload.id;
		if (challengeId == null || challengeId === "") return { ok: false, error: "缺少 platform challengeId" };
		const listed = await pc.client.hints(challengeId);
		if (!listed.ok) return listed;
		const hints = listed.data ?? [];
		const unlocked = [];
		const wantUnlock = payload.unlock === true;
		const onlyId = payload.hintId == null ? null : String(payload.hintId);
		if (wantUnlock) {
			for (const hint of hints) {
				if (onlyId && String(hint.id) !== onlyId) continue;
				if (hint.content) { unlocked.push({ id: hint.id, content: hint.content, cost: hint.cost, already: true }); continue; }
				const got = await pc.client.unlockHint(hint.id);
				if (got.ok) unlocked.push({ id: hint.id, content: got.data.content, cost: got.data.cost ?? hint.cost, already: false });
				else unlocked.push({ id: hint.id, error: got.error || "解锁失败" });
			}
			// 命中本地题目就落事实/事件
			const local = store.list().find((c) => c && c.platform && String(c.platform.challengeId) === String(challengeId));
			if (local) {
				for (const item of unlocked) {
					if (!item || !item.content) continue;
					store.addFact(local.id, { text: "[平台提示] " + String(item.content).slice(0, 300) });
					store.addEvent(local.id, "note", "解锁平台提示 #" + item.id + (item.cost ? "（" + item.cost + " 分）" : ""));
				}
			}
		}
		return { ok: true, challengeId, hints, unlocked };
	}

	function scheduleSummary() {
		const snap = typeof orchestrator.snapshot === "function" ? orchestrator.snapshot() : { running: [], queued: [], concurrency: 1, runningCount: 0, queuedCount: 0 };
		const all = store.list();
		const nowMs = Date.now();
		const windowMs = 30 * 60 * 1000;
		const bucketMs = 5 * 60 * 1000;
		const buckets = Array.from({ length: 6 }, (_, i) => ({ from: nowMs - windowMs + i * bucketMs, attempts: 0, solved: 0 }));
		let attempts30 = 0;
		let solved30 = 0;
		for (const ch of all) {
			for (const event of ch.events ?? []) {
				if (!event || event.kind !== "attempt-start" || typeof event.at !== "number") continue;
				if (nowMs - event.at > windowMs) continue;
				attempts30 += 1;
				const index = Math.min(5, Math.max(0, Math.floor((event.at - (nowMs - windowMs)) / bucketMs)));
				if (buckets[index]) buckets[index].attempts += 1;
			}
			if (typeof ch.endedAt === "number" && nowMs - ch.endedAt <= windowMs && ch.status === "solved") {
				solved30 += 1;
				const index = Math.min(5, Math.max(0, Math.floor((ch.endedAt - (nowMs - windowMs)) / bucketMs)));
				if (buckets[index]) buckets[index].solved += 1;
			}
		}
		const recentSolved = all.filter((ch) => ch && ch.status === "solved" && typeof ch.endedAt === "number").sort((a, b) => b.endedAt - a.endedAt).slice(0, 8).map((ch) => ({ id: ch.id, title: ch.title, category: ch.category || "", endedAt: ch.endedAt, durationMs: Math.max(0, (ch.endedAt || 0) - (ch.startedAt || ch.createdAt || 0)), estCost: (ch.attempts ?? []).reduce((sum, item) => sum + (Number(item && item.estCost) || 0), 0) }));
		let platformRate = { kind: "ctfd", configured: false };
		try { const cfg = readPlatformConfig(); platformRate = { kind: cfg.kind, configured: !!cfg.baseUrl && !!cfg.apiToken }; } catch { /* ignore */ }
		const config = configView();
		return {
			ok: true,
			snapshot: snap,
			stats: stateSummary(workspaceForRequest({})).stats,
			queue: { running: snap.running || [], queued: snap.queued || [], concurrency: snap.concurrency || 1 },
			rate: { windowMs, buckets, attempts30, solved30 },
			recentSolved,
			config: { concurrency: config.concurrency, timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts, autoRetry: config.autoRetry, pricePerMToken: config.pricePerMToken },
			platform: platformRate
		};
	}

	async function platformDetect(payload) {
		const cfg = readPlatformConfig();
		const kindHint = String(payload.kind || "").trim();
		const baseUrl = String(payload.baseUrl || cfg.baseUrl || (kindHint === "dasctf" || cfg.kind === "dasctf" ? DASCTF_DEFAULT_BASE : "")).trim();
		if (!baseUrl) return { ok: false, error: "请先填写平台地址" };
		const apiToken = payload.apiToken !== undefined ? String(payload.apiToken || "") : cfg.apiToken;
		const looksDasctf = /dasctf/i.test(baseUrl) || String(payload.kind || "") === "dasctf" || !!String(payload.platformSlug || "").trim();
		let detection;
		if (looksDasctf) {
			const cfg = readPlatformConfig();
			const token = String(payload.apiToken !== undefined ? payload.apiToken : (cfg.apiToken || process.env.CTF2_AGENT_TOKEN || ""));
			const origin = baseUrl || cfg.baseUrl || DASCTF_DEFAULT_BASE;
			const mcpUrl = String(payload.mcpUrl || cfg.mcpUrl || "") || dasctfDefaultMcpUrl(origin);
			const platformClient = createDasctfMcpPlatform({ origin, mcpUrl, token, fetchImpl: globalThis.fetch });
			const report = await platformClient.discover();
			detection = report.ok
				? { ok: true, kind: "dasctf", baseUrl: origin, mcpUrl: report.mcpUrl, confidence: "high", platformSlug: "", profile: null, evidence: [{ step: "mcp", note: "whoami 成功（" + ((report.user && report.user.name) || "agent") + "），tools " + ((report.tools || []).length) + " 个" }] }
				: { ok: false, kind: "dasctf", baseUrl: origin, mcpUrl, confidence: "low", error: report.error || "DASCTF MCP 连接失败", evidence: [] };
		} else {
			detection = await detectPlatform({ baseUrl, apiToken, fetchImpl: globalThis.fetch });
		}
		let applied = false;
		if (payload.apply === true && detection.ok) {
			const next = {
				kind: detection.kind,
				baseUrl: detection.kind === "dasctf" ? String(baseUrl || DASCTF_DEFAULT_BASE).replace(/\/+$/, "") : normalizeBaseUrl(baseUrl),
				apiToken: apiToken || String(process.env.CTF2_AGENT_TOKEN || ""),
				platformSlug: detection.platformSlug || String(payload.platformSlug || ""),
				mcpUrl: detection.mcpUrl || String(payload.mcpUrl || "") || (detection.kind === "dasctf" ? dasctfDefaultMcpUrl(baseUrl || DASCTF_DEFAULT_BASE) : ""),
				profile: detection.kind === "generic" ? detection.profile || null : null
			};
			writePlatformConfig(next);
			applied = true;
		}
		return { ok: detection.ok, detection, applied, platform: applied ? platformView(readPlatformConfig()) : undefined };
	}

	const targetProbeInFlight = new Set();

	async function probeChallengeTarget(payload) {
		const ch = store.get(String(payload.id ?? ""));
		if (!ch) return { ok: false, error: "题目不存在：" + payload.id };
		if (!ch.target) return { ok: false, error: "该题没有目标地址（target 为空）" };
		const targetStatus = await probeTarget(ch.target, { timeoutMs: Number(payload.timeoutMs) || 4000 });
		const record = { ...targetStatus, targetRaw: String(ch.target), checkedAt: Date.now() };
		try {
			const prev = ch.targetStatus || null;
			store.update(ch.id, { targetStatus: record });
			if (!prev || prev.state !== record.state) store.addEvent(ch.id, "note", "靶机探测：" + ch.target + " → " + record.state + (record.error ? "（" + record.error.slice(0, 120) + "）" : ""));
		} catch { /* ignore */ }
		return { ok: true, id: ch.id, target: ch.target, targetStatus: record };
	}

	function autoProbeTargets() {
		const nowMs = Date.now();
		const candidates = store.list().filter((ch) => {
			if (!ch || !ch.target) return false;
			if (ch.status !== "running" && ch.status !== "queued") return false;
			if (targetProbeInFlight.has(ch.id)) return false;
			return !ch.targetStatus || (nowMs - (Number(ch.targetStatus.checkedAt) || 0)) > 60000;
		}).slice(0, 2);
		for (const ch of candidates) {
			targetProbeInFlight.add(ch.id);
			probeChallengeTarget({ id: ch.id, timeoutMs: 3000 })
				.catch(() => null)
				.finally(() => targetProbeInFlight.delete(ch.id));
		}
	}

	async function detectWslDistros() {
		const listed = await listDistros();
		if (listed.length > 0) return listed;
		const probe = await runWslCommand({ distro: "Ubuntu", command: 'echo "$WSL_DISTRO_NAME"', timeoutMs: 20000 });
		const name = String(probe.stdout || "").replace(/\u0000/g, "").trim();
		return probe.ok && name ? [name] : [];
	}

	async function runWsl(payload) {
		const command = String(payload.command ?? "").trim();
		if (!command) return { ok: false, error: "command 不能为空" };
		let distro = String(payload.distro ?? "").trim();
		if (!distro) {
			const distros = await detectWslDistros();
			distro = distros[0] || "Ubuntu";
		}
		let cwd = String(payload.cwd ?? "").trim();
		if (!cwd && payload.challengeId) {
			const ch = store.get(String(payload.challengeId));
			if (ch) cwd = ch.dir;
		}
		const result = await runWslCommand({
			distro,
			command,
			cwd,
			timeoutMs: Math.min(MAX_WSL_TIMEOUT_MS, Math.max(1000, Number(payload.timeoutMs) || 120000)),
			maxOutput: Math.min(MAX_WSL_OUTPUT, Math.max(1000, Number(payload.maxOutput) || 200000))
		});
		try {
			const ch = payload.challengeId ? store.get(String(payload.challengeId)) : null;
			if (ch) store.addEvent(ch.id, "note", "WSL 执行（" + result.distro + "）：" + command.slice(0, 120) + " → exit " + result.exitCode);
		} catch { /* ignore */ }
		return { ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, truncated: result.truncated, distro: result.distro, cwd: cwd ? toWslPath(cwd) : "" };
	}

	const autoReviewInFlight = new Set();
	async function autoReviewTick() {
		if (cfg.reviewerEnabled !== true) return;
		const targets = store.list().filter((c) => c && c.status === "solved" && !c.review && !autoReviewInFlight.has(c.id) && (c.flags ?? []).some((f) => f && f.verified));
		for (const ch of targets.slice(0, 2)) {
			autoReviewInFlight.add(ch.id);
			try {
				const result = await reviewFlag({ id: ch.id });
				if (result && result.ok) console.log("[ctf-auto] auto-review " + ch.id + " → " + result.status);
			} catch (e) { console.log("[ctf-auto] auto-review error: " + String((e && e.message) || e)); }
			finally { autoReviewInFlight.delete(ch.id); }
		}
	}

	function reportList(workspace) {
		try {
			const dir = path.join(rootDir, "reports");
			let names = [];
			try { names = fs.readdirSync(dir); } catch { names = []; }
			const ws = normalizeWorkspace(workspace);
			const key = workspaceKey(ws);
			const reports = names
				.filter((name) => /\.md$/i.test(name) && (!ws || name.indexOf("-ctf-report-") >= 0 || name.indexOf("ctf-report-" + key + "-") === 0))
				.map((name) => {
					const file = path.join(dir, name);
					try { const st = fs.statSync(file); return { name, path: file, bytes: st.size, mtime: st.mtimeMs }; } catch { return null; }
				}).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 50);
			return { ok: true, dir, workspace: ws, reports };
		} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}	function reportRead(payload, workspace) {
		try {
			const name = String(payload.name ?? "");
			if (!/^[\w.\-]+\.md$/i.test(name)) return { ok: false, error: "报告名非法" };
			const ws = normalizeWorkspace(workspace);
			if (ws && name.indexOf("ctf-report-" + workspaceKey(ws) + "-") !== 0) {
				return { ok: false, error: "该报告不属于当前工作区" };
			}
			const file = path.join(rootDir, "reports", name);
			const text = fs.readFileSync(file, "utf8");
			return { ok: true, name, path: file, markdown: text.slice(0, 8000), bytes: Buffer.byteLength(text) };
		} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}	function reportExport(workspace) {
		try {
			const ws = normalizeWorkspace(workspace);
			const list = visibleChallenges(ws);
			const challenges = {};
			const order = [];
			for (const c of list) { challenges[c.id] = c; order.push(c.id); }
			const md = buildMarkdownReport({ ...store.state, challenges, order }, { generatedAt: Date.now() });
			const dir = path.join(rootDir, "reports");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, "ctf-report-" + workspaceKey(ws) + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md");
			fs.writeFileSync(file, md, { encoding: "utf8", mode: 0o600 });
			return { ok: true, path: file, bytes: Buffer.byteLength(md), workspace: ws, markdown: md.slice(0, 4000) };
		} catch (e) {
			return { ok: false, error: String((e && e.message) || e) };
		}
	}
	// ── Web 面板通道 ─────────────────────────────────────────────────────
	const trustedHosts = () => {
		try { return ctx.get("webRuntime")?.trustedHosts ?? []; } catch { return []; }
	};

	async function dispatchPanel(endpoint, payload) {
		const p = payload ?? {};
		if (p.sessionId) lastPanelSessionId = String(p.sessionId);
		if (endpoint === "state.get") return stateSummary(workspaceForRequest(p), p.scope === "all");
		if (endpoint === "challenge.get") return detailOf(String(p.id ?? ""));
		if (endpoint === "challenge.add") {
			try {
				const ws = workspaceForRequest(p);
				const baseDir = ws ? path.join(ws, ".ctf-auto") : baseDirOf();
				const ch = addChallenge(p, baseDir);
				if (p.sessionId) {
					store.update(ch.id, { driverSession: String(p.sessionId) });
					const agent = agentOfSession(p.sessionId);
					if (agent) { driverByChallenge.set(ch.id, agent); lastDriver = agent; }
				}
				// 面板新增题目由客户端随后显式调用 challenge.start；未勾选“创建后立即开始”时不要留下调度队列项。
				if (p.autoStart !== true) {
					store.setStatus(ch.id, "stopped", { note: "题目已创建，等待手动开始" });
				}
				return { ok: true, id: ch.id, status: store.get(ch.id)?.status ?? ch.status };
			} catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
		}
		if (endpoint === "challenge.start") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			const parent = agentOfSession(p.sessionId) ?? pickPanelAgent();
			if (!parent) return { ok: false, error: "没有可用会话：请先打开/创建一个会话（解题子代理需要父会话）" };
			if (p.sessionId) { const ch = store.get(String(p.id ?? "")); if (ch) store.update(ch.id, { driverSession: String(p.sessionId) }); }
			return startChallenge(String(p.id ?? ""), parent);
		}
		if (endpoint === "challenge.stop") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return stopChallenge(String(p.id ?? ""));
		}
		if (endpoint === "challenge.startAll") return startChallenges(p);
		if (endpoint === "challenge.stopAll") return stopChallenges(p);
		if (endpoint === "challenge.retry") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			if (p.sessionId) {
				const ch = store.get(String(p.id ?? ""));
				const agent = agentOfSession(p.sessionId);
				if (ch) store.update(ch.id, { driverSession: String(p.sessionId) });
				if (ch && agent) { driverByChallenge.set(ch.id, agent); lastDriver = agent; }
			}
			return retryChallenge(String(p.id ?? ""), p.hint ? String(p.hint) : "");
		}
		if (endpoint === "flag.record") {
			if (p.id != null) {
				const denied = panelWriteDenied(p, p.id);
				if (denied) return denied;
			}
			return recordFlag(p);
		}
		if (endpoint === "platform.status") return platformStatus();
		if (endpoint === "platform.config.get") { const cfg = readPlatformConfig(); return { ok: true, platform: platformView(cfg) }; }
		if (endpoint === "platform.config.set") {
			const cur = readPlatformConfig();
			let profile = cur.profile || null;
			if (p.profile !== undefined) {
				try { profile = p.profile == null ? null : (typeof p.profile === "string" ? normalizeGenericProfile(JSON.parse(p.profile)) : normalizeGenericProfile(p.profile)); }
				catch { return { ok: false, error: "profile 不是合法 JSON（或结构不对）" }; }
			}
			const next = {
				kind: p.kind ? String(p.kind) : cur.kind,
				baseUrl: p.baseUrl === undefined ? cur.baseUrl : normalizeBaseUrl(String(p.baseUrl ?? "")),
				platformSlug: p.platformSlug === undefined ? (cur.platformSlug || "") : String(p.platformSlug ?? "").trim(),
				mcpUrl: p.mcpUrl === undefined ? (cur.mcpUrl || "") : String(p.mcpUrl ?? "").trim(),
				apiToken: p.apiToken === undefined ? cur.apiToken : String(p.apiToken ?? ""),
				profile
			};
			writePlatformConfig(next);
			return { ok: true, platform: platformView(next) };
		}
		if (endpoint === "platform.challenges") {
			const pc = platformClientOrNull();
			if (!pc) return { ok: false, error: "平台未配置：请先在平台面板填写 baseUrl 与 API Token" };
			const r = await pc.client.listChallenges();
			return r.ok ? { ok: true, challenges: r.data } : { ok: false, error: r.error };
		}
		if (endpoint === "platform.import") return platformImport(p, undefined);
		if (endpoint === "platform.submit") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return platformSubmit(p);
		}
		if (endpoint === "workbench.tree") return workbenchTree(p);
		if (endpoint === "workbench.read") return workbenchRead(p);
		if (endpoint === "workbench.write") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return workbenchWrite(p);
		}
		if (endpoint === "report.export") return reportExport(workspaceForRequest(p));
		if (endpoint === "kb.search") return kbSearch(p);
		if (endpoint === "kb.list") return listKnowledge();
		if (endpoint === "kb.stats") return kbStats();
		if (endpoint === "kb.read") return readKnowledge(p);
		if (endpoint === "kb.import") return importKnowledge(p);
		if (endpoint === "kb.delete") return deleteKnowledge(p);
		if (endpoint === "memory.summary") return memorySummary(p);
		if (endpoint === "memory.cards") return memoryCards();
		if (endpoint === "memory.distill") return p && p.all ? distillAllSolved() : distillMemory(p && p.id);
		if (endpoint === "triage.run") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return triageChallenge(p);
		}
		if (endpoint === "writeup.pack") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return packWriteup(p);
		}
		if (endpoint === "flag.review") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return reviewFlag(p);
		}
		if (endpoint === "platform.hints") return platformHints(p);
		if (endpoint === "wsl.run") {
			if (p.challengeId != null) {
				const denied = panelWriteDenied(p, p.challengeId);
				if (denied) return denied;
			}
			return runWsl(p);
		}
		if (endpoint === "target.probe") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return probeChallengeTarget(p);
		}
		if (endpoint === "schedule.summary") return scheduleSummary();
		if (endpoint === "platform.detect") return platformDetect(p);
		if (endpoint === "platform.env") return platformEnv(p);
		if (endpoint === "pipeline.run") return pipelineRun(p);
		if (endpoint === "challenge.refresh") return refreshChallenge(p);
		if (endpoint === "challenge.remove") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return removeChallenge(p);
		}
		if (endpoint === "session.remove") return removeSession(p);
		if (endpoint === "writeup.export") {
			const denied = panelWriteDenied(p, p.id);
			if (denied) return denied;
			return writeupExport(p);
		}
		if (endpoint === "writeup.list") return writeupList(workspaceForRequest(p));
		if (endpoint === "writeup.read") return writeupRead(p, workspaceForRequest(p));
		if (endpoint === "report.list") return reportList(workspaceForRequest(p));
		if (endpoint === "report.read") return reportRead(p, workspaceForRequest(p));
		if (endpoint === "config.get") return { ok: true, config: configView(), defaults: DEFAULTS };
		if (endpoint === "config.set") return applyRuntimeConfig(p.patch ?? p);
		if (endpoint === "search.query") {
			try {
				const ws = workspaceForRequest(p);
				const list = visibleChallenges(ws);
				const challenges = {};
				const order = [];
				for (const c of list) { challenges[c.id] = c; order.push(c.id); }
				return { ok: true, query: String(p.q ?? ""), results: searchBoard({ ...store.state, challenges, order }, String(p.q ?? ""), { limit: p.limit }) };
			}
			catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
		if (endpoint === "doctor") {
			const sub = subagentsService();
			const s = stateSummary();
			const callerSid = p.sessionId ? String(p.sessionId) : "";
			let sessions = [];
			try {
				const agents = agentsService();
				sessions = (agents?.roots?.() ?? []).map((a) => ({ id: String(a.id), preset: presetOf(a), cwd: String(a?.session?.header?.cwd ?? "") }));
			} catch { sessions = []; }
			return {
				ok: true,
				subagents: { available: !!sub?.startActivation, providers: (() => { try { return sub?.list?.() ?? []; } catch { return []; } })() },
				preset: { id: presetState.id, name: presetState.name, registered: presetState.registered, error: presetState.error, skillDirs: presetState.skillDirs, skillSourceDir: presetState.skillSourceDir, listed: presetState.registered },
				platform: await platformStatus(),
				wslDistros: await detectWslDistros(),
				sessions,
				callerSession: callerSid,
				config: configView(),
				stats: s.stats,
				aggregates: { byStatus: s.aggregates.byStatus, byCategory: s.aggregates.byCategory }
			};
		}
		throw new Error(`unknown endpoint ${endpoint}`);
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const send = (code, body) => {
				const bodyText = JSON.stringify(body);
				res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(bodyText);
			};
			if (!isTrustedRequest(req, trustedHosts())) { res.writeHead(403); res.end("forbidden"); return; }
			let pathname = "";
			try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { pathname = ""; }
			if (req.method === "GET" && pathname === ROUTE_PATH + "/csrf") { send(200, { token: CSRF_TOKEN }); return; }
			if (req.method !== "POST") { res.writeHead(405); res.end("method not allowed"); return; }
			if (!checkCsrf(req, CSRF_TOKEN)) { res.writeHead(403); res.end("csrf token missing or invalid"); return; }
			let endpoint = "";
			try { endpoint = decodeURIComponent(pathname.slice(ROUTE_PATH.length)).replace(/^\/+/, ""); } catch { endpoint = ""; }
			if (endpoint === "") { res.writeHead(404); res.end("not found"); return; }
			try {
				const raw = await readBody(req);
				const payload = raw === "" ? {} : JSON.parse(raw);
				send(200, await dispatchPanel(endpoint, payload));
			} catch (e) {
				send(400, { ok: false, error: String(e?.message ?? e) });
			}
		}
	}), "dsh-ctf-auto: web route");

	// ── 超时看门狗 ───────────────────────────────────────────────────────
	ctx.effect(() => {
		const timer = setInterval(() => {
			try { recoverScheduler(); } catch (e) { console.error(`[dsh-ctf-auto] recovery tick error: ${e?.message ?? e}`); }
			try { orchestrator.tick(); } catch (e) { console.error(`[dsh-ctf-auto] tick error: ${e?.message ?? e}`); }
			void autoReviewTick();
			autoDistillTick();
			autoProbeTargets();
			void autoPipelineTick();
			void ensurePresetPresence();
		}, 5000);
		if (typeof timer.unref === "function") timer.unref();
		return () => clearInterval(timer);
	}, "dsh-ctf-auto: watchdog");

	// 插件卸载时中断所有在跑的子代理。
	ctx.effect(() => () => { try { orchestrator.stopAll(); } catch { /* noop */ } }, "dsh-ctf-auto: dispose");
}

export { name, inject, apply, ROUTE_PATH };


