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
import { createChallengeEditor, makeChallengeEvent, normalizeFailedPaths, EVENTS_LIMIT, OUTPUT_TAIL_LIMIT, FACTS_LIMIT, FAILED_PATHS_LIMIT, FLAGS_LIMIT, CHALLENGE_STATUSES } from "./challenge-editor.js";
import { readChallengeSnapshot, challengeRevision, applyChallengeDraft, freezeSnapshot } from "./state-snapshot.js";

export const STATE_VERSION = 1;
export { EVENTS_LIMIT, OUTPUT_TAIL_LIMIT, FACTS_LIMIT, FAILED_PATHS_LIMIT, FLAGS_LIMIT, CHALLENGE_STATUSES, TERMINAL_STATUSES } from "./challenge-editor.js";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIME_BUDGET_MS = 1800000;

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
	let persistence = { dirty: false, lastSavedAt: null, lastError: null, failures: 0 };
	function persistenceStatus() { return { ...persistence, lastError: persistence.lastError ? { ...persistence.lastError } : null }; }

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
	function save({ durable = false } = {}) {
		let tmpPath = "";
		try {
			ensureDir(path.dirname(resolvedStatePath));
			state.version = STATE_VERSION;
			state.updatedAt = now();
			state.rootDir = rootDir;
			state.running = compileRunning();
			state.stats = compileStats();
			tmpPath = `${resolvedStatePath}.tmp-${process.pid}-${Date.now().toString(36)}-${randomSuffix(6)}`;
			const fd = fs.openSync(tmpPath, "wx", 0o600);
			try {
				fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
				if (durable) fs.fsyncSync(fd);
			} finally { fs.closeSync(fd); }
			fs.renameSync(tmpPath, resolvedStatePath);
			if (durable && process.platform !== "win32") {
				const dirFd = fs.openSync(path.dirname(resolvedStatePath), "r");
				try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
			}
			try { fs.chmodSync(resolvedStatePath, 0o600); } catch { /* Windows/ACL 环境可能不支持 */ }
			persistence = { dirty: false, lastSavedAt: now(), lastError: null, failures: 0 };
			return true;
		} catch (error) {
			persistence = { ...persistence, dirty: true, failures: persistence.failures + 1, lastError: { code: String(error?.code || "WRITE_FAILED"), at: now() } };
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
			if (Number(parsed?.version) > STATE_VERSION) {
				const error = new Error("状态库版本高于当前程序支持的版本，已保留原文件");
				error.code = "UNSUPPORTED_STATE_VERSION";
				throw error;
			}
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
			persistence.lastSavedAt = state.updatedAt;
		} catch (error) {
			// I/O failures and newer formats are not corrupt JSON; never replace them.
			if (error?.code) throw error;
			if (!backupCorruptFile()) throw new Error("状态库损坏且无法备份，已保留原文件");
			resetState();
			save();
		}
	}

	function get(id) {
		if (typeof id !== "string") return undefined;
		return state.challenges[id];
	}

	function read(id) { return readChallengeSnapshot(get(id)); }

	// Work exclusively on a detached challenge. Promise callbacks cannot commit:
	// their later continuations only retain the discarded draft/editor.
	function transact(id, operation, { expectedRevision, durable = false } = {}) {
		const challenge = get(id);
		if (!challenge) return { ok: false, applied: false, code: "CHALLENGE_NOT_FOUND", error: "题目不存在" };
		if (persistence.dirty) return { ok: false, applied: false, code: "STATE_NOT_DURABLE", error: "状态库尚未保存，请先恢复持久化" };
		const revision = challengeRevision(challenge);
		if (expectedRevision != null && expectedRevision !== revision) return { ok: false, applied: false, code: "STATE_CONFLICT", error: "题目已变化，请重新读取后操作" };
		try {
			if (typeof operation !== "function") throw new TypeError("事务操作必须是同步函数");
			const draft = structuredClone(challenge);
			const value = operation(createChallengeEditor(draft, { now }), draft);
			if (value && typeof value.then === "function") {
				Promise.resolve(value).catch(() => {});
				return { ok: false, applied: false, code: "ASYNC_TRANSACTION", error: "事务中不能等待异步操作，请先读取数据再提交同步修改" };
			}
			if (value?.ok === false) return { ...value, applied: false };
			if (draft.id !== id || !CHALLENGE_STATUSES.includes(draft.status)) throw new Error("事务修改了题目标识或写入了无效状态");
			for (const field of ["files", "attempts", "flags", "facts", "events"]) if (!Array.isArray(draft[field])) throw new Error(`事务写入了无效的 ${field}`);
			if (!isPlainObject(draft.budget)) throw new Error("事务写入了无效的 budget");
			const result = structuredClone(value);
			// Validate serializability before changing any live field.
			const nextRevision = challengeRevision(draft);
			const snapshot = freezeSnapshot(structuredClone(draft));
			if (get(id) !== challenge || challengeRevision(challenge) !== revision) return { ok: false, applied: false, code: "STATE_CONFLICT", error: "事务期间题目已变化，请重新读取后操作" };
			const applied = applyChallengeDraft(challenge, draft);
			const saved = !applied || save({ durable });
			return { ok: saved, applied, value: result, revision: nextRevision, challenge: snapshot,
				...(saved ? {} : { code: "STATE_NOT_DURABLE", error: "修改已应用到内存但保存失败，请恢复持久化后继续", persistence: persistenceStatus() }) };
		} catch (error) {
			return { ok: false, applied: false, code: "TRANSACTION_FAILED", error: String(error?.message || error) };
		}
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

	function update(id, patch, saveOptions) {
		const challenge = get(id);
		if (!challenge) return undefined;
		if (isPlainObject(patch)) {
			for (const [key, value] of Object.entries(patch)) {
				if (key === "id") continue;
				challenge[key] = value;
			}
		}
		save(saveOptions);
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
		challenge.events.push(makeChallengeEvent("queued", `已入队：${title}`, undefined, now));
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
		const result = createChallengeEditor(challenge, { now }).addAttempt(input);
		if (result) save();
		return result;
	}

	function endAttempt(id, n, patch = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const result = createChallengeEditor(challenge, { now }).endAttempt(n, patch);
		if (result) save();
		return result;
	}

	function updateAttempt(id, n, patch = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const result = createChallengeEditor(challenge, { now }).updateAttempt(n, patch);
		if (result) save();
		return result;
	}

	function removeFlag(id, value) {
		const challenge = get(id);
		if (!challenge) return false;
		const result = createChallengeEditor(challenge, { now }).removeFlag(value);
		if (result !== undefined && result !== false) save();
		return result;
	}

	function addFlag(id, input = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const result = createChallengeEditor(challenge, { now }).addFlag(input);
		if (result !== undefined && result !== false) save();
		return result;
	}

	function addFact(id, input = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const result = createChallengeEditor(challenge, { now }).addFact(input);
		if (result !== undefined && result !== false) save();
		return result;
	}

	function addEvent(id, kind, text, data) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const result = createChallengeEditor(challenge, { now }).addEvent(kind, text, data);
		if (result !== undefined && result !== false) save();
		return result;
	}

	function stats() {
		state.stats = compileStats();
		return { ...state.stats };
	}

	function setStatus(id, status, extra = {}) {
		const challenge = get(id);
		if (!challenge) return undefined;
		const result = createChallengeEditor(challenge, { now }).setStatus(status, extra);
		if (result !== undefined && result !== false) save();
		return result;
	}

	const store = {
		state,
		statePath: resolvedStatePath,
		get rootDir() {
			return rootDir;
		},
		save,
		persistenceStatus,
		get,
		read,
		transact,
		list,
		addChallenge,
		remove,
		update,
		addAttempt,
		endAttempt,
		addFlag,
	removeFlag,
	updateAttempt,
		addFact,
		addEvent,
		stats,
		findBySlug,
		setStatus,
	};

	load();
	return store;
}
