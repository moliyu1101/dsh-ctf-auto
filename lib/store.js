/**
 * dsh-ctf-auto / lib/store.js
 * 题目状态库：单文件 JSON 原子持久化（tmp + rename）。
 * 纯 Node 内置模块，无任何 DSH / 第三方依赖。
 *
 * 契约：docs/DESIGN.md §2。所有方法同步返回；时间统一走 options.now（测试可注入）。
 * 文件损坏时：备份为 `<statePath>.corrupt-<ts>` 后重建空库，不抛异常打断流程。
 */
import fs from "node:fs";
import path from "node:path";
import { classifyFactKind } from "./blackboard.js";

export const STATE_VERSION = 1;
export const EVENTS_LIMIT = 300;
export const OUTPUT_TAIL_LIMIT = 4000;
export const FACTS_LIMIT = 120;
export const FAILED_PATHS_LIMIT = 30;
export const FLAGS_LIMIT = 100;
export const CHALLENGE_STATUSES = [
	"queued",
	"running",
	"solved",
	"stuck",
	"failed",
	"stopped",
];
export const TERMINAL_STATUSES = ["solved", "stuck", "failed", "stopped"];

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIME_BUDGET_MS = 1800000;

const STATUS_EVENT_KIND = {
	queued: "queued",
	running: "started",
	solved: "flag",
	stuck: "stuck",
	failed: "error",
	stopped: "stopped",
};

const STATUS_EVENT_TEXT = {
	queued: "题目已重新入队，等待调度",
	running: "题目开始运行",
	solved: "题目已解出",
	stuck: "未能解出，标记为 stuck",
	failed: "题目执行失败",
	stopped: "题目已停止",
};

function positiveInt(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function emptyStats() {
	return {
		total: 0,
		queued: 0,
		running: 0,
		solved: 0,
		stuck: 0,
		failed: 0,
		stopped: 0,
	};
}

function tailOf(text, max = OUTPUT_TAIL_LIMIT) {
	const value = typeof text === "string" ? text : String(text ?? "");
	return value.length > max ? value.slice(-max) : value;
}

function oneLine(text, max = 300) {
	const value = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** failedPaths：字符串数组，去重，≤30 条。 */
function normalizeFailedPaths(value, limit = FAILED_PATHS_LIMIT) {
	const out = [];
	if (!Array.isArray(value)) return out;
	for (const item of value) {
		const text = oneLine(item, 300);
		if (!text || out.includes(text)) continue;
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function hash6(input) {
	let h = 2166136261 >>> 0;
	for (const ch of String(input ?? "")) {
		h ^= ch.codePointAt(0) >>> 0;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

function asciiBase(input, fallback = "challenge") {
	const raw = String(input ?? "");
	const normalized = raw
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
	const ascii = normalized
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	if (ascii) return ascii;
	const fb = String(fallback ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return fb || "challenge";
}

function randomSuffix(len = 3) {
	let out = "";
	while (out.length < len) out += Math.random().toString(36).slice(2);
	return out.slice(0, len);
}

function normalizeFile(entry) {
	if (entry == null) return null;
	if (typeof entry === "string") {
		const value = entry.trim();
		if (!value) return null;
		if (/^https?:\/\//i.test(value)) {
			let name = value;
			try {
				const url = new URL(value);
				name = path.basename(url.pathname) || url.hostname;
			} catch {
				/* keep raw value as name */
			}
			return { name, path: "", source: "url", url: value };
		}
		return { name: path.basename(value), path: value, source: "user" };
	}
	if (!isPlainObject(entry)) return null;
	const hasUrl = typeof entry.url === "string" && entry.url;
	const hasPath = typeof entry.path === "string" && entry.path;
	const source =
		entry.source === "url" || entry.source === "user"
			? entry.source
			: hasUrl && !hasPath
				? "url"
				: "user";
	const fallbackName = hasPath
		? path.basename(entry.path)
		: hasUrl
			? entry.url
			: "attachment";
	const name = String(entry.name ?? fallbackName).trim() || "attachment";
	const file = {
		name,
		path: hasPath ? String(entry.path) : "",
		source,
	};
	if (hasUrl) file.url = String(entry.url);
	return file;
}

/**
 * 创建一个状态库。statePath 不存在时初始化并建目录。
 * options: { now?: () => number, rootDir?: string, defaultMaxAttempts?, defaultTimeBudgetMs? }
 */
export function createStore(statePath, options = {}) {
	if (typeof statePath !== "string" || !statePath.trim()) {
		throw new TypeError("createStore: statePath must be a non-empty string");
	}
	const resolvedStatePath = path.resolve(statePath);
	const opts = isPlainObject(options) ? options : {};
	const now = typeof opts.now === "function" ? opts.now : Date.now;
	const defaults = {
		maxAttempts: positiveInt(opts.defaultMaxAttempts, DEFAULT_MAX_ATTEMPTS),
		timeBudgetMs: positiveInt(opts.defaultTimeBudgetMs, DEFAULT_TIME_BUDGET_MS),
	};
	let rootDir = path.resolve(opts.rootDir || path.dirname(resolvedStatePath));
	let corruptCounter = 0;

	const state = {
		version: STATE_VERSION,
		updatedAt: now(),
		rootDir,
		challenges: {},
		order: [],
		running: {},
		stats: emptyStats(),
	};

	function ensureDir(dir) {
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			return true;
		} catch {
			return false;
		}
	}

	function compileStats() {
		const stats = emptyStats();
		for (const id of state.order) {
			const challenge = state.challenges[id];
			if (!challenge) continue;
			stats.total += 1;
			if (Object.prototype.hasOwnProperty.call(stats, challenge.status)) {
				stats[challenge.status] += 1;
			}
		}
		return stats;
	}

	function compileRunning() {
		const running = {};
		for (const id of state.order) {
			const challenge = state.challenges[id];
			if (challenge && challenge.status === "running") running[id] = true;
		}
		return running;
	}

	/** 原子落盘：tmp 文件 + rename。失败不抛异常（返回 false），避免打断状态机。 */
	function save() {
		let tmpPath = "";
		try {
			ensureDir(path.dirname(resolvedStatePath));
			state.version = STATE_VERSION;
			state.updatedAt = now();
			state.rootDir = rootDir;
			state.running = compileRunning();
			state.stats = compileStats();
			tmpPath = `${resolvedStatePath}.tmp-${process.pid}-${Date.now().toString(36)}-${randomSuffix(6)}`;
			fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			fs.renameSync(tmpPath, resolvedStatePath);
			try { fs.chmodSync(resolvedStatePath, 0o600); } catch { /* Windows/ACL 环境可能不支持 */ }
			return true;
		} catch {
			if (tmpPath) {
				try {
					fs.rmSync(tmpPath, { force: true });
				} catch {
					/* best effort cleanup */
				}
			}
			return false;
		}
	}

	function backupCorruptFile() {
		try {
			if (!fs.existsSync(resolvedStatePath)) return null;
			const stamp = `${now()}-${++corruptCounter}`;
			let target = `${resolvedStatePath}.corrupt-${stamp}`;
			let tries = 0;
			while (fs.existsSync(target) && tries < 50) {
				tries += 1;
				target = `${resolvedStatePath}.corrupt-${stamp}-${tries}`;
			}
			try {
				fs.renameSync(resolvedStatePath, target);
			} catch {
				fs.copyFileSync(resolvedStatePath, target);
				try {
					fs.rmSync(resolvedStatePath, { force: true });
				} catch {
					/* best effort */
				}
			}
			return target;
		} catch {
			return null;
		}
	}

	function resetState() {
		state.version = STATE_VERSION;
		state.updatedAt = now();
		state.rootDir = rootDir;
		state.challenges = {};
		state.order = [];
		state.running = {};
		state.stats = emptyStats();
	}

	function normalizeAttempt(raw) {
		const attempt = isPlainObject(raw) ? raw : {};
		attempt.n = positiveInt(attempt.n, 1);
		attempt.angle = typeof attempt.angle === "string" ? attempt.angle : "recon-first";
		attempt.sessionId = attempt.sessionId == null ? null : String(attempt.sessionId);
		attempt.label = typeof attempt.label === "string" ? attempt.label : "";
		attempt.startedAt = typeof attempt.startedAt === "number" ? attempt.startedAt : null;
		attempt.endedAt = typeof attempt.endedAt === "number" ? attempt.endedAt : null;
		attempt.status = [
			"running",
			"completed",
			"timeout",
			"error",
			"aborted",
		].includes(attempt.status)
			? attempt.status
			: "completed";
		attempt.stopReason = typeof attempt.stopReason === "string" ? attempt.stopReason : "";
		attempt.summary = typeof attempt.summary === "string" ? attempt.summary : "";
		attempt.failedPaths = normalizeFailedPaths(attempt.failedPaths);
		attempt.outputTail = tailOf(attempt.outputTail);
	for (const field of ["promptChars", "outputChars", "estTokens", "estCost"]) {
		if (attempt[field] != null && Number.isFinite(Number(attempt[field]))) attempt[field] = Number(attempt[field]);
	}
		attempt.error = typeof attempt.error === "string" ? attempt.error : "";
		return attempt;
	}

	function normalizeChallenge(id, raw) {
		if (!isPlainObject(raw)) return null;
		const challenge = raw;
		challenge.id = typeof challenge.id === "string" && challenge.id ? challenge.id : id;
		challenge.slug =
			typeof challenge.slug === "string" && challenge.slug ? challenge.slug : challenge.id;
		challenge.title =
			typeof challenge.title === "string" && challenge.title.trim()
				? challenge.title
				: "未命名题目";
		challenge.category = typeof challenge.category === "string" ? challenge.category : "";
		challenge.statement = typeof challenge.statement === "string" ? challenge.statement : "";
		challenge.target = challenge.target == null ? null : String(challenge.target);
		challenge.files = Array.isArray(challenge.files)
			? challenge.files.map(normalizeFile).filter(Boolean)
			: [];
		challenge.dir =
			typeof challenge.dir === "string" && challenge.dir
				? challenge.dir
				: path.join(rootDir, challenge.slug);
		challenge.platform = isPlainObject(challenge.platform) ? challenge.platform : null;
		challenge.status = CHALLENGE_STATUSES.includes(challenge.status)
			? challenge.status
			: "queued";
		challenge.createdAt = typeof challenge.createdAt === "number" ? challenge.createdAt : now();
		challenge.startedAt =
			typeof challenge.startedAt === "number" ? challenge.startedAt : null;
		challenge.endedAt = typeof challenge.endedAt === "number" ? challenge.endedAt : null;
		challenge.stuckReason = typeof challenge.stuckReason === "string" ? challenge.stuckReason : "";
		challenge.attempts = Array.isArray(challenge.attempts)
			? challenge.attempts.filter(isPlainObject).map(normalizeAttempt)
			: [];
		challenge.flags = Array.isArray(challenge.flags)
			? challenge.flags
					.filter(isPlainObject)
					.map((flag) => ({
						value: String(flag.value ?? ""),
						verified: !!flag.verified,
						evidence: typeof flag.evidence === "string" ? flag.evidence : "",
						method: typeof flag.method === "string" ? flag.method : "manual",
						recordedAt: typeof flag.recordedAt === "number" ? flag.recordedAt : now(),
						attempt: flag.attempt == null ? null : Number(flag.attempt),
					}))
					.filter((flag) => flag.value)
					.slice(-FLAGS_LIMIT)
			: [];
		challenge.facts = Array.isArray(challenge.facts)
			? challenge.facts
					.filter(isPlainObject)
					.map((fact) => ({
						at: typeof fact.at === "number" ? fact.at : now(),
						text: String(fact.text ?? ""),
				kind: typeof fact.kind === "string" && fact.kind ? fact.kind : classifyFactKind(String(fact.text ?? "")),
						source: typeof fact.source === "string" ? fact.source : "",
						attempt: fact.attempt == null ? null : Number(fact.attempt),
					}))
					.filter((fact) => fact.text)
					.slice(-FACTS_LIMIT)
			: [];
		challenge.events = Array.isArray(challenge.events)
			? challenge.events.filter(isPlainObject).slice(-EVENTS_LIMIT)
			: [];
		challenge.budget = {
			maxAttempts: positiveInt(challenge.budget?.maxAttempts, defaults.maxAttempts),
			timeBudgetMs: positiveInt(challenge.budget?.timeBudgetMs, defaults.timeBudgetMs),
		};
		return challenge;
	}

	function load() {
		let parsed = null;
		try {
			if (!fs.existsSync(resolvedStatePath)) {
				ensureDir(path.dirname(resolvedStatePath));
				resetState();
				save();
				return;
			}
			const raw = fs.readFileSync(resolvedStatePath, "utf8");
			parsed = JSON.parse(raw);
			if (!isPlainObject(parsed)) throw new Error("state root is not an object");
			if (!isPlainObject(parsed.challenges)) throw new Error("state.challenges is not an object");
			rootDir = opts.rootDir
				? path.resolve(opts.rootDir)
				: typeof parsed.rootDir === "string" && parsed.rootDir
					? path.resolve(parsed.rootDir)
					: rootDir;
			state.version = STATE_VERSION;
			state.rootDir = rootDir;
			state.updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : now();
			state.challenges = {};
			for (const [id, challenge] of Object.entries(parsed.challenges)) {
				const normalized = normalizeChallenge(id, challenge);
				if (normalized) state.challenges[id] = normalized;
			}
			const order = [];
			const seen = new Set();
			if (Array.isArray(parsed.order)) {
				for (const id of parsed.order) {
					if (typeof id === "string" && state.challenges[id] && !seen.has(id)) {
						seen.add(id);
						order.push(id);
					}
				}
			}
			for (const id of Object.keys(state.challenges)) {
				if (!seen.has(id)) {
					seen.add(id);
					order.push(id);
				}
			}
			state.order = order;
			state.running = compileRunning();
			state.stats = compileStats();
		} catch {
			backupCorruptFile();
			resetState();
			save();
		}
	}

	function makeEvent(kind, text, data) {
		const event = { at: now(), kind: String(kind || "note"), text: String(text ?? "") };
		if (isPlainObject(data)) {
			const extra = { ...data };
			if (extra.attempt != null) {
				event.attempt = Number(extra.attempt);
				delete extra.attempt;
			}
			if (Object.keys(extra).length > 0) event.data = extra;
		}
		return event;
	}

	function get(id) {
		if (typeof id !== "string") return undefined;
		return state.challenges[id];
	}

	function list() {
		const out = [];
		for (const id of state.order) {
			const challenge = state.challenges[id];
			if (challenge) out.push(challenge);
		}
		return out;
	}

	function findBySlug(slug) {
		if (typeof slug !== "string" || !slug) return undefined;
		for (const challenge of list()) {
			if (challenge.slug === slug) return challenge;
		}
		return undefined;
	}

	function uniqueId() {
		for (let i = 0; i < 50; i += 1) {
			const id = `c-${now().toString(36)}-${randomSuffix(3)}`;
			if (!state.challenges[id]) return id;
		}
		return `c-${now().toString(36)}-${randomSuffix(6)}`;
	}

	function uniqueSlug(title, id) {
		const base = asciiBase(title, "challenge");
		const hash = hash6(String(id ?? ""));
		let slug = `${base}-${hash}`;
		let attempt = 2;
		while (
			findBySlug(slug) ||
			(() => {
				try {
					return fs.existsSync(path.join(rootDir, slug));
				} catch {
					return false;
				}
			})()
		) {
			slug = `${base}-${hash}-${attempt}`;
			attempt += 1;
			if (attempt > 200) break;
		}
		return slug;
	}

	function update(id, patch) {
		const challenge = get(id);
		if (!challenge) return undefined;
		if (isPlainObject(patch)) {
			for (const [key, value] of Object.entries(patch)) {
				if (key === "id") continue;
				challenge[key] = value;
			}
		}
		save();
		return challenge;
	}

	/** 从题板移除一道题（只删状态，不动磁盘；文件清理由调用方决定）。 */
	function remove(id) {
		const key = String(id ?? "");
		const challenge = state.challenges[key];
		if (!challenge) return false;
		delete state.challenges[key];
		const index = state.order.indexOf(key);
		if (index >= 0) state.order.splice(index, 1);
		save();
		return true;
	}

	function addChallenge(input = {}) {
		const payload = isPlainObject(input) ? input : {};
		const title =
			typeof payload.title === "string" && payload.title.trim()
				? payload.title.trim().slice(0, 200)
				: "未命名题目";
		const category =
			typeof payload.category === "string" ? payload.category.trim().toLowerCase() : "";
		const id = uniqueId();
		const slug = uniqueSlug(title, id);
		const nowMs = now();
		// dirBase：题目工作区的父目录（编排层按驱动会话工作区传入，如 <session cwd>/.ctf-auto）；
		// 缺省用 store 的 rootDir。显式 dir 仍优先于 dirBase。
		const dirBase =
			typeof payload.dirBase === "string" && payload.dirBase
				? path.resolve(payload.dirBase)
				: rootDir;
		const challenge = {
			id,
			slug,
			title,
			category,
			statement: typeof payload.statement === "string" ? payload.statement : "",
			target: payload.target == null || payload.target === "" ? null : String(payload.target),
			files: Array.isArray(payload.files)
				? payload.files.map(normalizeFile).filter(Boolean)
				: [],
			dir:
				typeof payload.dir === "string" && payload.dir
					? path.resolve(payload.dir)
					: path.join(dirBase, slug),
			platform: isPlainObject(payload.platform) ? payload.platform : null,
			status: "queued",
			createdAt: nowMs,
			startedAt: null,
			endedAt: null,
			stuckReason: "",
			attempts: [],
			flags: [],
			facts: [],
			events: [],
			budget: {
				maxAttempts: positiveInt(payload.maxAttempts, defaults.maxAttempts),
				timeBudgetMs: positiveInt(payload.timeBudgetMs, defaults.timeBudgetMs),
			},
		};
		challenge.events.push(makeEvent("queued", `已入队：${title}`));
		state.challenges[id] = challenge;
		state.order.push(id);
		ensureDir(rootDir);
		ensureDir(challenge.dir);
		for (const sub of ["files", "scripts", "artifacts"]) {
			ensureDir(path.join(challenge.dir, sub));
		}
		save();
		return challenge;
	}

	function addAttempt(id, input = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const payload = isPlainObject(input) ? input : {};
		const angle =
			typeof payload.angle === "string" && payload.angle ? payload.angle : "recon-first";
		const n = challenge.attempts.length + 1;
		const startedAt = now();
		const attempt = {
			n,
			angle,
			sessionId: null,
			label: `ctf-${id}#${n}`,
			startedAt,
			endedAt: null,
			status: "running",
			stopReason: "",
			summary: "",
			failedPaths: [],
			outputTail: "",
			error: "",
		};
		challenge.attempts.push(attempt);
		challenge.status = "running";
		challenge.endedAt = null;
		challenge.stuckReason = "";
		if (typeof challenge.startedAt !== "number") challenge.startedAt = startedAt;
		save();
		return attempt;
	}

	function endAttempt(id, n, patch = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const attempt = challenge.attempts.find((item) => item.n === Number(n));
		if (!attempt) return undefined;
		const payload = isPlainObject(patch) ? patch : {};
		const fields = [
			"endedAt",
			"status",
			"stopReason",
			"summary",
			"failedPaths",
			"outputTail",
			"error",
			"sessionId",
			"promptChars",
			"outputChars",
			"estTokens",
			"estCost",
		];
		for (const field of fields) {
			if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
			const value = payload[field];
			if (field === "outputTail") attempt.outputTail = tailOf(value);
			else if (field === "failedPaths") attempt.failedPaths = normalizeFailedPaths(value);
			else if (field === "error") attempt.error = value == null ? "" : String(value);
			else if (field === "sessionId") attempt.sessionId = value == null ? null : String(value);
			else attempt[field] = value;
		}
		if (typeof attempt.endedAt !== "number") attempt.endedAt = now();
		if (!attempt.status || attempt.status === "running") attempt.status = "completed";
		save();
		return attempt;
	}

	function addFlag(id, input = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const payload = isPlainObject(input) ? input : {};
		const value = typeof payload.value === "string" ? payload.value.trim() : "";
		if (!value) return undefined;
		let flag = challenge.flags.find((item) => item && item.value === value);
		if (!flag) {
			if (challenge.flags.length >= FLAGS_LIMIT) return undefined;
			flag = {
				value,
				verified: false,
				evidence: "",
				method: "manual",
				recordedAt: now(),
				attempt: null,
			};
			challenge.flags.push(flag);
		}
		if (typeof payload.verified === "boolean") {
			if (!(flag.verified === true && payload.verified === false)) flag.verified = payload.verified;
		}
		if (payload.evidence != null) flag.evidence = String(payload.evidence);
		if (payload.method != null) flag.method = String(payload.method);
		if (payload.attempt != null) flag.attempt = Number(payload.attempt);
		if (typeof flag.recordedAt !== "number") flag.recordedAt = now();
		if (flag.verified) {
			challenge.status = "solved";
			challenge.stuckReason = "";
		}
		addEvent(
			id,
			"flag",
			flag.verified
				? `已记录并验证 flag：${value}`
				: `记录候选 flag（未验证）：${value}`,
			flag.attempt == null ? undefined : { attempt: flag.attempt },
		);
		save();
		return flag;
	}

	function addFact(id, input = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const payload = isPlainObject(input) ? input : {};
		const text = typeof payload.text === "string" ? payload.text.trim() : "";
		if (!text) return undefined;
		const fact = {
			at: now(),
			text,
			kind: typeof payload.kind === "string" && payload.kind ? payload.kind : classifyFactKind(text),
			source: typeof payload.source === "string" ? payload.source : "",
			attempt: payload.attempt == null ? null : Number(payload.attempt),
		};
		const tagMatch = /^\[([^\]]+)\]/.exec(text);
		let existing = challenge.facts.find((item) => item && item.text === text);
		// 「同前缀去重」：同一 attempt 内相同 [标签] 的 fact 视为重复，保留最新内容。
		if (!existing && tagMatch) {
			existing = challenge.facts.find((item) => {
				if (!item || item.attempt !== fact.attempt) return false;
				const itemTag = /^\[([^\]]+)\]/.exec(item.text || "");
				return !!itemTag && itemTag[1] === tagMatch[1];
			});
		}
		if (existing) {
			existing.at = fact.at;
			existing.text = fact.text;
			existing.source = fact.source;
			existing.attempt = fact.attempt;
			save();
			return existing;
		}
		challenge.facts.push(fact);
		if (challenge.facts.length > FACTS_LIMIT) {
			challenge.facts.splice(0, challenge.facts.length - FACTS_LIMIT);
		}
		save();
		return fact;
	}

	function addEvent(id, kind, text, data) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const event = makeEvent(kind, text, data);
		challenge.events.push(event);
		if (challenge.events.length > EVENTS_LIMIT) {
			challenge.events.splice(0, challenge.events.length - EVENTS_LIMIT);
		}
		save();
		return event;
	}

	function stats() {
		state.stats = compileStats();
		return { ...state.stats };
	}

	function setStatus(id, status, extra = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		if (!CHALLENGE_STATUSES.includes(status)) return undefined;
		const payload = isPlainObject(extra) ? extra : {};
		const { note, attempt: attemptRef, ...rest } = payload;
		const patch = { ...rest, status };
		if (status === "running") {
			if (typeof challenge.startedAt !== "number") patch.startedAt = now();
			patch.endedAt = null;
		}
		if (
			TERMINAL_STATUSES.includes(status) &&
			!Object.prototype.hasOwnProperty.call(patch, "endedAt")
		) {
			if (typeof challenge.endedAt !== "number") patch.endedAt = now();
		}
		if (status === "solved") patch.stuckReason = "";
		for (const [key, value] of Object.entries(patch)) challenge[key] = value;
		const kind = STATUS_EVENT_KIND[status] || "note";
		let text;
		if (typeof note === "string" && note) text = note;
		else if (status === "stuck" && challenge.stuckReason)
			text = `题目卡住：${challenge.stuckReason}`;
		else text = STATUS_EVENT_TEXT[status] || `状态切换为 ${status}`;
		addEvent(id, kind, text, attemptRef == null ? undefined : { attempt: attemptRef });
		save();
		return challenge;
	}

	const store = {
		state,
		statePath: resolvedStatePath,
		get rootDir() {
			return rootDir;
		},
		save,
		get,
		list,
		addChallenge,
		remove,
		update,
		addAttempt,
		endAttempt,
		addFlag,
		addFact,
		addEvent,
		stats,
		findBySlug,
		setStatus,
	};

	load();
	return store;
}
