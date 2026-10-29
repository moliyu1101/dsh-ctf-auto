/**
 * dsh-ctf-auto / lib/orchestrator.js
 * 队列 / 并发 / 超时 / 自动重试状态机。
 *
 * 设计要点（docs/DESIGN.md §4）：
 * - 端口注入：spawn(request) → { sessionId?, done: Promise<{stopReason, outputText, sessionId?}>, interrupt() }
 * - 不 import 任何 DSH API，纯 Node。
 * - 任何异常都被捕获：状态机不会崩，题目最终一定落到终态或重新入队。
 */
import crypto from "node:crypto";
import { attemptBudget, prepareManualQueue, settleAttempt } from "./attempt-lifecycle.js";
import { createBudgetTiming } from "./budget-timing.js";
import { enqueueLearningUsage } from "./learning-usage.js";
import { DEFAULT_FLAG_RE, buildAttemptPrompt, extractFlags, nextAngle, skillForCategory } from "./prompt.js";
import { loadRoleText } from "./roles.js";

const DEFAULTS = {
	concurrency: 2,
	timeoutMs: 1800000,
	maxAttempts: 3,
	autoRetry: true,
	timeBudgetMs: 1800000,
	solverPreset: "ctf-solver",
	// 预算结算：到预算比例时先注入收尾指令，再给宽限时间
	wrapupRatio: 0.8,
	wrapupGraceMs: 120000,
	envSerial: true,
	envAutoClean: true,
	envReadyTimeoutMs: 180000,
};

const STOP_REASONS = ["completed", "aborted", "error", "max-tokens", "refusal", "timeout", "blocked"];

const OUTPUT_TAIL_LIMIT = 4000;
const HINT_LIMIT = 2000;

function positiveInt(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorText(error) {
	if (!error) return "";
	if (typeof error === "string") return error;
	if (typeof error.message === "string" && error.message) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function tail(text, max = OUTPUT_TAIL_LIMIT) {
	const value = typeof text === "string" ? text : String(text ?? "");
	return value.length > max ? value.slice(-max) : value;
}

function normalizeHint(value) {
	if (Array.isArray(value)) {
		return value
			.map((item) => normalizeHint(item))
			.filter(Boolean)
			.join("\n")
			.slice(0, HINT_LIMIT);
	}
	if (typeof value !== "string") return "";
	return value.trim().slice(0, HINT_LIMIT);
}

function normalizeHints(value) {
	const out = [];
	const push = (item) => {
		const text = normalizeHint(item);
		if (text && !out.includes(text)) out.push(text);
	};
	if (Array.isArray(value)) value.forEach(push);
	else push(value);
	return out;
}

function normalizeLogger(logger) {
	const noop = () => {};
	if (typeof logger === "function") {
		const call = (...args) => {
			try {
				logger(...args);
			} catch {
				/* never let logging break the state machine */
			}
		};
		return { info: call, warn: call, error: call, debug: call };
	}
	const source = isPlainObject(logger) ? logger : {};
	const wrap = (name) => {
		const fn = source[name];
		if (typeof fn !== "function") return noop;
		return (...args) => {
			try {
				fn.apply(source, args);
			} catch {
				/* never let logging break the state machine */
			}
		};
	};
	return { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") };
}

function isContainerish(challenge) {
	if (!challenge) return false;
	return challenge.hasContainer === true
		|| challenge.requiresTarget === true
		|| !!(challenge.platform && challenge.platform.hasContainer === true);
}

function normalizeConfig(raw) {
	const merged = { ...DEFAULTS, ...(isPlainObject(raw) ? raw : {}) };
	const ratio = Number(merged.wrapupRatio);
	const grace = Number(merged.wrapupGraceMs);
	return {
		...merged,
		concurrency: Math.max(1, positiveInt(merged.concurrency, DEFAULTS.concurrency)),
		timeoutMs: positiveInt(merged.timeoutMs, DEFAULTS.timeoutMs),
		maxAttempts: positiveInt(merged.maxAttempts, DEFAULTS.maxAttempts),
		timeBudgetMs: positiveInt(merged.timeBudgetMs, DEFAULTS.timeBudgetMs),
		autoRetry: merged.autoRetry !== false,
		wrapupRatio: Number.isFinite(ratio) ? Math.min(0.95, Math.max(0.5, ratio)) : DEFAULTS.wrapupRatio,
		wrapupGraceMs: Number.isFinite(grace) ? Math.max(0, Math.min(600000, Math.floor(grace))) : DEFAULTS.wrapupGraceMs,
		envSerial: merged.envSerial !== false,
		envAutoClean: merged.envAutoClean !== false,
		envReadyTimeoutMs: positiveInt(merged.envReadyTimeoutMs, DEFAULTS.envReadyTimeoutMs),
		solverPreset:
			typeof merged.solverPreset === "string" && merged.solverPreset
				? merged.solverPreset
				: DEFAULTS.solverPreset,
	};
}

function normalizeStopReason(value) {
	if (value == null || value === "") return "completed";
	return typeof value === "string" && STOP_REASONS.includes(value) ? value : "error";
}


/**
 * @param {{store: object, spawn: Function, config?: object, now?: Function, logger?: object}} deps
 */
export function createOrchestrator(deps = {}) {
	const store = deps && deps.store;
	const spawn = deps && deps.spawn;
	if (!store || typeof store.read !== "function" || typeof store.transact !== "function" || typeof store.list !== "function" || typeof store.persistenceStatus !== "function") {
		throw new TypeError("createOrchestrator: deps.store must provide read, transact, list and persistenceStatus");
	}
	if (typeof spawn !== "function") {
		throw new TypeError("createOrchestrator: deps.spawn is required");
	}
	const now = typeof deps.now === "function" ? deps.now : Date.now;
	const logger = normalizeLogger(deps.logger);
	const config = normalizeConfig(deps.config);
	const budgetTiming = createBudgetTiming({ now, ...(deps.monotonicNow ? { monotonicNow: deps.monotonicNow } : {}) });
	const recall = typeof deps.recall === "function" ? deps.recall : null;
	const onMemoriesUsed = typeof deps.onMemoriesUsed === "function" ? deps.onMemoriesUsed : null;
	const onKnowledgeUsed = typeof deps.onKnowledgeUsed === "function" ? deps.onKnowledgeUsed : null;
	const onUsagePending = typeof deps.onUsagePending === "function" ? deps.onUsagePending : null;
	const resources = deps.resources;
	const canRun = (challenge) => (!challenge.preparation || challenge.preparation.phase === "ready")
		&& (typeof deps.canRun !== "function" || deps.canRun(challenge));

	/** id -> entry（正在运行的尝试） */
	const running = new Map();
	/** id -> Promise（用于测试/调用方等待空闲） */
	const jobs = new Map();
	/** id -> agentPreset */
	const presets = new Map();
	/** id -> [hint...]（下一次尝试注入） */
	const hints = new Map();
	/** 所有未清理的 timeout timer */
	const timers = new Set();
	const deferred = new Map();
	const pendingStops = new Set();
	const preparationErrors = new Map();
	const read = (id) => store.read(id)?.challenge;
	let closed = false, disposed = false;
	let pumping = false, schedulingEnabled = false;

	function commit(id, label, operation, options) {
		if (disposed) return { ok: false, applied: false, code: "SCHEDULER_CLOSED", error: "调度器已卸载" };
		const result = store.transact(id, operation, options);
		if (!result.ok) logger.warn(`[ctf-auto] ${label}: ${result.code || "STATE_FAILED"} ${result.error || ""}`);
		return result;
	}

	function stateError(result) {
		return { ok: false, code: result.code, error: result.error, applied: result.applied,
			...(result.persistence ? { persistence: result.persistence } : {}) };
	}

	const attemptBudgetOf = (challenge) => attemptBudget(challenge, config);
	const budgetLimit = (challenge) => Number(challenge.budget?.timeBudgetMs) > 0 ? Number(challenge.budget.timeBudgetMs) : config.timeBudgetMs;
	const captureBudget = (challenge, options) => budgetTiming.capture(challenge, budgetLimit(challenge), options);
	const clockFailure = () => budgetTiming.status().clockError;
	// Anchor restored budgets before any asynchronous session/preset discovery.
	for (const challenge of store.list()) if (challenge.startedAt != null) captureBudget(challenge);

	function queueTiming(challenge) {
		const current = captureBudget(challenge);
		return { remainingMs: current.remainingMs, next: current.remainingMs != null && current.remainingMs <= 0 ? captureBudget(challenge, { restart: true }) : current };
	}

	function executionOccupancy() {
		const reservations = resources?.reservations?.("solver") || [];
		const challenges = new Map(store.list().map((ch) => [ch.id, ch]));
		const represented = new Set(reservations.map((row) => row.taskId).filter(Boolean));
		for (const entry of running.values()) {
			if (entry.lease?.taskId ? represented.has(entry.lease.taskId) : reservations.some((row) => row.challengeId === entry.id && !row.taskId)) continue;
			reservations.push({ challengeId: entry.id, taskId: entry.lease?.taskId || null, phase: "preparing" });
		}
		const waitingForStop = reservations.filter((row) => {
			const entry = running.get(row.challengeId);
			return !entry || (row.taskId && entry.lease?.taskId !== row.taskId);
		}).map((row) => {
			const ch = challenges.get(row.challengeId) || {};
			return { id: row.challengeId, title: String(ch.title || ""), category: String(ch.category || ""), taskId: row.taskId, phase: row.phase };
		});
		return { occupiedSlots: reservations.length, availableSlots: Math.max(0, config.concurrency - reservations.length), waitingForStop,
			containerBusy: reservations.some((row) => isContainerish(challenges.get(row.challengeId))) };
	}

	function countQueued() {
		try {
			return store.list().filter((challenge) => challenge && challenge.status === "queued").length;
		} catch {
			return 0;
		}
	}

	function pushHint(id, hint) {
		const text = normalizeHint(hint);
		if (!text) return;
		const list = hints.get(id) || [];
		list.push(text);
		hints.set(id, list);
	}

	function consumeHints(id) {
		const list = hints.get(id) || [];
		hints.delete(id);
		return list;
	}

	function extractFlagsWithExtras(outputText, extraRegexSources) {
		const sources = [DEFAULT_FLAG_RE];
		if (Array.isArray(extraRegexSources)) {
			for (const source of extraRegexSources) {
				if (typeof source === "string" && source) sources.push(source);
			}
		}
		return extractFlags(outputText, sources);
	}

	function requestStop(entry, kind) {
		if (!entry || entry.finalizing) return false;
		entry.lease?.markCancel?.(kind === "timeout" ? "解题超时" : "解题取消");
		entry.cancelRequested = true;
		if (entry.cancelled) return false;
		entry.cancelled = true;
		entry.cancelKind = kind;
		const resolve = entry.resolveAbort;
		if (typeof resolve === "function") {
			try {
				resolve({ stopReason: kind, outputText: "", __cancelled: true });
			} catch (error) {
				logger.warn("[ctf-auto] resolveAbort failed", error);
			}
		}
		try {
			if (entry.controller) entry.controller.abort();
		} catch (error) {
			logger.warn("[ctf-auto] abort signal failed", error);
		}
		try {
			if (entry.handle && typeof entry.handle.interrupt === "function") entry.handle.interrupt();
		} catch (error) {
			logger.warn("[ctf-auto] handle.interrupt failed", error);
		}
		return true;
	}

	function onTimeout(entry) {
		if (!entry || entry.finalizing || entry.cancelled) return;
		const mono = budgetTiming.sample();
		if (!clockFailure() && mono < entry.deadlineMono) { armDeadline(entry); return; }
		entry.timedOut = true;
		requestStop(entry, "timeout");
	}

	function armDeadline(entry) {
		if (entry.timer) { clearTimeout(entry.timer); timers.delete(entry.timer); }
		const mono = budgetTiming.sample(), delay = clockFailure() ? 0 : Math.max(0, entry.deadlineMono - mono);
		entry.timer = setTimeout(() => {
			try { onTimeout(entry); } catch (error) { logger.error("[ctf-auto] timeout handler failed", error); }
		}, Math.min(delay, 2147483647));
		timers.add(entry.timer); entry.timer.unref?.();
	}

	/** 预算结算：到 wrapupRatio 先注入收尾指令，再把 deadline 顺延 wrapupGraceMs。 */
	function onWrapup(entry) {
		if (!entry || entry.finalizing || entry.cancelled || entry.wrapupSent || !entry.handle?.send) return;
		const challenge = read(entry.id);
		if (!challenge) return;
		const timing = captureBudget(challenge), oldDeadline = entry.deadlineMono;
		if (clockFailure() || timing.mono >= oldDeadline) { onTimeout(entry); return; }
		if (timing.mono < entry.wrapupMono) { armWrapup(entry); return; }
		const bonus = Math.max(0, Math.min(Math.round(config.wrapupGraceMs), timing.remainingMs ?? Infinity));
		const at = timing.wall, deadlineAt = at + bonus;
		const result = commit(entry.id, "wrapup", (edit, challenge) => {
			const attempt = challenge.attempts.find((item) => item.n === entry.attemptN && item.runId === entry.runId);
			if (!attempt || attempt.finalizedAt != null) return { ignored: true };
			edit.updateAttempt(entry.attemptN, { wrapupAt: at, deadlineAt });
			if (challenge.budgetClock?.epochId === timing.checkpoint.epochId) edit.patch({ budgetClock: timing.checkpoint });
			edit.addEvent("wrapup", `预算结算：尝试发送收尾指令（宽限 ${Math.round(bonus / 1000)}s）`, { attempt: entry.attemptN });
		});
		if (!result.ok || result.value?.ignored) return;
		budgetTiming.accept(result.challenge, timing);
		const committedMono = budgetTiming.sample();
		if (clockFailure() || committedMono >= oldDeadline || committedMono >= timing.mono + bonus) {
			entry.timedOut = true; requestStop(entry, "timeout"); return;
		}
		entry.wrapupSent = true;
		entry.deadlineAt = deadlineAt;
		entry.deadlineMono = timing.mono + bonus;
		const text = [`【预算结算】已到单次预算的 ${Math.round(config.wrapupRatio * 100)}%，请在约 ${Math.round(bonus / 1000)} 秒内收尾。`,
			"把已确认的事实、脚本和卡点写入 notes.md 与 artifacts/；已验证 flag 立即用 ctf_flag_record 登记。停止开启新方向。"].join("\n");
		try { Promise.resolve(entry.handle.send(text)).catch((error) => logger.warn("[ctf-auto] wrapup send failed", error)); }
		catch (error) { logger.warn("[ctf-auto] wrapup send failed", error); }
		armDeadline(entry);
	}

	function armWrapup(entry) {
		if (entry.wrapupTimer) { clearTimeout(entry.wrapupTimer); timers.delete(entry.wrapupTimer); }
		entry.wrapupTimer = setTimeout(() => {
			try { onWrapup(entry); } catch (error) { logger.error("[ctf-auto] wrapup handler failed", error); }
		}, Math.min(2147483647, Math.max(0, entry.wrapupMono - budgetTiming.sample())));
		timers.add(entry.wrapupTimer); entry.wrapupTimer.unref?.();
	}

	function deliverEffects(value) {
		if (!value || value.ignored) return;
		for (const [ids, hook] of [[value.memories, onMemoriesUsed], [value.knowledge, onKnowledgeUsed]]) {
			if (!hook || !ids?.length) continue;
			try { hook(ids, value.solved); } catch (error) { logger.warn("[ctf-auto] usage hook failed", error); }
		}
	}

	function saveCompletion(entry, plan) {
		if (disposed) return;
		const challenge = read(entry.id), timing = challenge ? captureBudget(challenge) : null;
		const checkpoint = timing?.checkpoint.epochId === plan.budgetClock?.epochId ? timing.checkpoint : plan.budgetClock;
		const result = commit(entry.id, "attempt completion", (edit, challenge) => settleAttempt(edit, challenge, { ...plan, budgetClock: checkpoint },
			{ ...entry, closed, config, remainingBudgetMs: timing?.remainingMs ?? null }), { durable: !!onUsagePending });
		if (result.applied && timing) budgetTiming.accept(result.challenge, timing);
		if (result.ok) {
			deferred.delete(entry.id);
			if (onUsagePending) {
				try { onUsagePending(entry.id); } catch (error) { logger.warn("[ctf-auto] usage recovery deferred", error); }
			} else deliverEffects(result.value);
		}
		else if (result.code === "STATE_NOT_DURABLE" || result.code === "STATE_CONFLICT") deferred.set(entry.id, { entry, plan });
		else deferred.delete(entry.id);
		return result;
	}

	function drainCompletions() {
		if (disposed || store.persistenceStatus().dirty) return;
		for (const id of [...pendingStops]) {
			const stopped = commit(id, "deferred stop", (edit, challenge) => {
				if (!["solved", "stopped"].includes(challenge.status)) edit.setStatus("stopped", { endedAt: now(), note: "用户停止（恢复保存后收口）" });
			});
			if (stopped.ok || stopped.code === "CHALLENGE_NOT_FOUND") pendingStops.delete(id);
			if (store.persistenceStatus().dirty) return;
		}
		for (const { entry, plan } of [...deferred.values()]) {
			saveCompletion(entry, plan);
			if (store.persistenceStatus().dirty) break;
		}
	}

	function handleFatalError(entry, error) {
		if (disposed) return;
		logger.error(`[ctf-auto] attempt crashed for ${entry.id}`, error);
		requestStop(entry, "error");
		if (entry.attemptN > 0) return finalizeAttempt(entry, { __error: error, fatal: true }, entry.handle);
		return commit(entry.id, "attempt preparation error", (edit, challenge) => {
			if (!["solved", "stopped"].includes(challenge.status)) edit.setStatus("stuck", { stuckReason: "尝试准备失败：" + tail(errorText(error), 200) });
		});
	}

	function finalizeAttempt(entry, result, handle) {
		entry.finalizing = true;
		if (!entry.attemptN) return;
		const payload = isPlainObject(result) ? result : {};
		const stopReason = entry.timedOut ? "timeout" : entry.userStopped || entry.cancelKind === "aborted" ? "aborted" : payload.__error ? "error" : normalizeStopReason(payload.stopReason);
		const output = typeof payload.outputText === "string" ? payload.outputText : "";
		const challenge = read(entry.id), timing = challenge ? captureBudget(challenge) : null;
		return saveCompletion(entry, { n: entry.attemptN, runId: entry.runId, endedAt: now(), stopReason,
			elapsedMs: entry.startedMono == null ? 0 : Math.max(0, budgetTiming.sample() - entry.startedMono), budgetClock: timing?.checkpoint,
			flags: extractFlagsWithExtras(output, config.extraFlagsRe).filter((flag) => flag.length <= 300).slice(0, 100), outputTail: tail(output), outputChars: output.length,
			error: tail(payload.__error ? errorText(payload.__error) : String(payload.error || ""), 2000),
			sessionId: payload.sessionId != null ? String(payload.sessionId) : handle?.sessionId ? String(handle.sessionId) : null, fatal: payload.fatal === true });
	}

	async function runAttempt(entry, agentPreset) {
		const id = entry.id;
		let challenge = read(id);
		if (!challenge) return;
		if (closed || entry.cancelRequested) {
			if (!entry.retryRequested && challenge.status !== "solved") commit(id, "closed before start", (edit, draft) => {
				if (draft.status !== "solved") edit.setStatus("stopped", { endedAt: now() });
			});
			return;
		}
		if (challenge.status === "stopped" || challenge.status === "solved") return;

		let recalled = [], recalledKnowledge = [], memoryFile = null;
		if (recall) {
			try {
				const pack = recall(challenge, { limit: 3 });
				if (Array.isArray(pack)) recalled = pack;
				else if (pack && typeof pack === "object") { recalled = Array.isArray(pack.memories) ? pack.memories : []; recalledKnowledge = Array.isArray(pack.knowledge) ? pack.knowledge : []; memoryFile = typeof pack.memoryFile === "string" ? pack.memoryFile : null; }
			} catch (error) { logger.warn("[ctf-auto] recall failed", error); }
		}
		const runId = crypto.randomUUID();
		const roleName = challenge.attempts.length === 0 ? "recon" : "solver";
		const roleText = loadRoleText(roleName);
		const consumedHints = hints.get(id) || [];
		challenge = read(id);
		if (!challenge) return;
		const timing = captureBudget(challenge);
		if (clockFailure()) { preparationErrors.set(id, clockFailure()); return; }
		const creation = commit(id, "attempt start", (edit, draft) => {
			if (draft.status !== "queued" || draft.attempts.some((item) => item.status === "running" && item.finalizedAt == null)) return { ok: false, code: "ATTEMPT_NOT_READY", error: "题目尚有未收口尝试" };
			if (draft.attempts.length >= attemptBudgetOf(draft)) return { ok: false, code: "ATTEMPT_BUDGET_EXHAUSTED", error: "尝试预算已用尽，请显式重试并调整预算" };
			const angle = nextAngle(draft.attempts.length, config);
			const attempt = edit.addAttempt({ angle, runId });
			attempt.skill = skillForCategory(draft.category);
			attempt.role = roleName;
			if (entry.lease?.taskId) attempt.taskId = entry.lease.taskId;
			attempt.memories = recalled.map((item) => ({ id: String(item?.id || ""), title: String(item?.title || ""), score: Number(item?.score) || 0 }));
			attempt.knowledge = recalledKnowledge.map((item) => ({ id: String(item?.id || ""), title: String(item?.title || ""), score: Number(item?.score) || 0, source: String(item?.source || "") }));
			if (onUsagePending) { attempt.usageTrackingVersion = 1; attempt.memoryFile = memoryFile; }
			const remaining = timing.remainingMs ?? budgetLimit(draft);
			edit.patch({ budgetClock: timing.checkpoint });
			const timeoutMs = remaining == null ? config.timeoutMs : Math.max(0, Math.min(config.timeoutMs, remaining));
			attempt.timeoutMs = timeoutMs;
			attempt.deadlineAt = timing.wall + timeoutMs;
			let prompt;
			try { prompt = buildAttemptPrompt({ challenge: draft, attempt, roleName: attempt.role, roleText, memories: recalled, knowledge: recalledKnowledge,
				config: { ...config, id, maxAttempts: attemptBudgetOf(draft), timeBudgetMs: draft.budget.timeBudgetMs, timeoutMs,
					hints: [...normalizeHints(config.hints), ...consumedHints], now: timing.wall, deadline: attempt.deadlineAt,
					totalDeadline: timing.wall + remaining }, priorAttempts: draft.attempts.filter((item) => item.n !== attempt.n) }); }
			catch { prompt = `# CTF 解题任务\n\n题目：${draft.title}\n\n题面：\n${draft.statement || ""}\n\n工作目录：${draft.dir}\n`; }
			attempt.promptChars = prompt.length;
			if (recalled.length) edit.addEvent("note", `召回相似打法卡 ${recalled.length} 张：` + recalled.slice(0, 3).map((item) => `${item.title}（${(Number(item.score) || 0).toFixed(2)}）`).join("、"), { memories: recalled.map((item) => item.id) });
			if (recalledKnowledge.length) edit.addEvent("note", `召回知识片段 ${recalledKnowledge.length} 条：` + recalledKnowledge.slice(0, 3).map((item) => `${item.title}（${(Number(item.score) || 0).toFixed(2)}）`).join("、"), { knowledge: recalledKnowledge.map((item) => item.id) });
			edit.addEvent("attempt-start", `第 ${attempt.n} 次尝试开始（角度 ${angle}，技能 ${attempt.skill}，角色 ${attempt.role}）`, { attempt: attempt.n, skill: attempt.skill, role: attempt.role });
			return { n: attempt.n, prompt, timeoutMs, budgetExhausted: remaining != null && remaining <= 0 };
		});
		if (creation.applied) { entry.attemptN = creation.value.n; entry.runId = runId; budgetTiming.accept(creation.challenge, timing); }
		if (!creation.ok) {
			if (creation.applied) finalizeAttempt(entry, { __error: new Error("尝试记录保存失败，未派发子代理") }, null);
			else if (creation.code !== "STATE_NOT_DURABLE") preparationErrors.set(id, { code: creation.code, error: creation.error });
			return;
		}
		consumeHints(id);
		challenge = creation.challenge;
		const attempt = challenge.attempts.find((item) => item.n === creation.value.n);
		const prompt = creation.value.prompt, effectiveTimeoutMs = creation.value.timeoutMs;
		entry.startedAt = attempt.startedAt;
		entry.startedMono = timing.mono;
		entry.timeoutMs = effectiveTimeoutMs;
		entry.deadlineAt = attempt.deadlineAt;
		entry.deadlineMono = timing.mono + effectiveTimeoutMs;
		entry.wrapupMono = timing.mono + Math.round(effectiveTimeoutMs * config.wrapupRatio);
		entry.budgetExhausted = creation.value.budgetExhausted;
		const controller = new AbortController();
		entry.controller = controller;

		const request = {
			label: attempt.label,
			prompt,
			cwd: challenge.dir,
			agentPreset,
			attempt,
			challenge,
			lease: entry.lease,
			signal: controller.signal,
		};

		if (effectiveTimeoutMs <= 0) {
			return finalizeAttempt(entry, {
				stopReason: "timeout",
				outputText: "",
				error: "单题时间预算已耗尽",
			}, null);
		}

		let handle = null;
		let result;
		try {
			const admitted = entry.lease?.start?.({ attempt: attempt.n, runId });
			if (admitted && !admitted.ok) throw Object.assign(new Error(admitted.error), { code: admitted.code });
			if (budgetTiming.sample() >= entry.deadlineMono || clockFailure()) {
				entry.timedOut = true;
				return finalizeAttempt(entry, { stopReason: "timeout", error: "保存派发边界期间预算耗尽或计时失效，未派发子代理" }, null);
			}
			try { handle = spawn(request); }
			catch (error) { entry.lease?.markUnknown?.("派发接口抛错，无法确认执行端是否已创建"); throw error; }
			if (!handle || typeof handle !== "object") {
				entry.lease?.markUnknown?.("派发接口未返回有效句柄，无法确认执行端是否结束");
				throw new Error("spawn 返回了无效句柄");
			}
			entry.handle = handle;
			let pending;
			try {
				pending = handle.done;
				if (!pending || typeof pending.then !== "function") throw new Error("spawn handle 缺少 done Promise");
			} catch (error) {
				entry.lease?.markUnknown?.("派发句柄缺少可观察的完成 Promise，无法确认执行端是否结束");
				try { if (typeof handle.sessionId === "string" && handle.sessionId) entry.lease?.bindSession?.(handle.sessionId); } catch { /* preserve primary failure */ }
				throw error;
			}
			const donePromise = Promise.resolve(pending).catch((error) => {
				entry.lease?.markUnknown?.("执行端完成等待失败，无法确认任务已经停止");
				throw error;
			});
			// 避免 done 在 timeout/stop 后迟到 reject 造成 unhandledRejection
			donePromise.catch(() => {});
			entry.providerDone = donePromise;
			armDeadline(entry);
			armWrapup(entry);
			const abortPromise = new Promise((resolve) => {
				entry.resolveAbort = resolve;
				if (entry.cancelRequested) {
					resolve({
						stopReason: entry.cancelKind || "aborted",
						outputText: "",
						__cancelled: true,
					});
				}
			});
			result = await Promise.race([donePromise, abortPromise]);
			// A resolved provider Promise can win the microtask race against a due timer.
			if (!entry.cancelled && (budgetTiming.sample() >= entry.deadlineMono || clockFailure())) {
				entry.timedOut = true; requestStop(entry, "timeout");
			}
		} catch (error) {
			result = { __error: error };
		} finally {
			if (entry.timer) {
				clearTimeout(entry.timer);
				timers.delete(entry.timer);
				entry.timer = null;
			}
			if (entry.wrapupTimer) {
				clearTimeout(entry.wrapupTimer);
				timers.delete(entry.wrapupTimer);
				entry.wrapupTimer = null;
			}
			entry.resolveAbort = null;
		}
		return finalizeAttempt(entry, result, handle);
	}

	function startRunning(id) {
		if (closed) return false;
		const challenge = read(id);
		if (!challenge || challenge.status !== "queued" || running.has(id) || !canRun(challenge)) return false;
		const occupancy = executionOccupancy();
		if (!occupancy.availableSlots || config.envSerial && occupancy.containerBusy && isContainerish(challenge)) return false;
		const lease = resources?.acquire(challenge, "solver");
		if (lease && !lease.ok) return false;
		const entry = {
			id,
			lease,
			startedAt: now(),
			attemptN: 0,
			handle: null,
			timer: null,
			controller: null,
			cancelled: false,
			cancelKind: null,
			cancelRequested: false,
			timedOut: false,
			userStopped: false,
			retryRequested: false,
			finalizing: false,
			resolveAbort: null,
			job: null,
		};
		running.set(id, entry);
		lease?.onCancel?.(() => {
			if (running.get(id) === entry) stop(id);
			else { entry.controller?.abort(); entry.handle?.interrupt?.(); }
		});
		const agentPreset = presets.has(id) ? presets.get(id) : config.solverPreset;
		const job = Promise.resolve()
			.then(() => runAttempt(entry, agentPreset))
			.catch((error) => handleFatalError(entry, error))
			.finally(() => {
				if (resources) resources.releaseWhen(lease, () => entry.handle?.whenSettled?.(), entry.providerDone);
				running.delete(id);
				jobs.delete(id);
				try {
					pump();
				} catch (error) {
					logger.error("[ctf-auto] pump after attempt failed", error);
				}
			});
		entry.job = job;
		jobs.set(id, job);
		return true;
	}

	function pump() {
		schedulingEnabled = true;
		budgetTiming.sample();
		if (closed || pumping || clockFailure() || store.persistenceStatus().dirty) return 0;
		pumping = true;
		let started = 0;
		try {
			for (;;) {
				const occupancy = executionOccupancy();
				if (!occupancy.availableSlots) break;
				let next;
				const containerBusy = config.envSerial !== false && occupancy.containerBusy;
				try {
					next = store
						.list()
						.find(
							(challenge) =>
								challenge &&
								challenge.status === "queued" &&
						canRun(challenge) &&
						!running.has(challenge.id) && !deferred.has(challenge.id) && !pendingStops.has(challenge.id) && !preparationErrors.has(challenge.id) &&
						(!resources || resources.canUse(challenge, "solver")) &&
						(!containerBusy || !isContainerish(challenge)),
						);
				} catch (error) {
					logger.error("[ctf-auto] store.list failed in pump", error);
					break;
				}
				if (!next) break;
				if (!startRunning(next.id)) break;
				started += 1;
			}
		} catch (error) {
			logger.error("[ctf-auto] pump failed", error);
		} finally {
			pumping = false;
		}
		return started;
	}

	function start(id, options = {}) {
		const opts = isPlainObject(options) ? options : {};
		if (closed) return { ok: false, error: "编排器已关闭" };
		if (running.has(id) || deferred.has(id) || pendingStops.has(id)) return { ok: false, error: "题目正在运行或等待收口保存" };
		const challenge = read(id);
		if (!challenge) return { ok: false, code: "CHALLENGE_NOT_FOUND", error: "题目不存在" };
		const timing = queueTiming(challenge);
		if (clockFailure()) return { ok: false, ...clockFailure(), error: clockFailure().message };
		const result = commit(id, "queue start", (edit, challenge) => {
			if (challenge.status === "solved") return { ok: false, error: "题目已解出", status: "solved" };
			prepareManualQueue(edit, challenge, config, timing.next.wall, { remainingMs: timing.remainingMs, budgetClock: timing.next.checkpoint });
			if (challenge.attempts.length >= attemptBudgetOf(challenge)) return { ok: false, code: "ATTEMPT_BUDGET_EXHAUSTED", error: "尝试预算已用尽，请使用重试操作" };
			edit.setStatus("queued", { stuckReason: "", endedAt: null, note: "加入调度队列" });
		});
		if (result.ok || result.applied) {
			budgetTiming.accept(result.challenge, timing.next);
			schedulingEnabled = true;
			preparationErrors.delete(id);
			if (typeof opts.agentPreset === "string" && opts.agentPreset) presets.set(id, opts.agentPreset); else presets.delete(id);
			if (opts.hint != null) pushHint(id, opts.hint);
		}
		if (!result.ok) return stateError(result);
		return { ok: true, id, status: "queued", queued: countQueued(), started: pump() };
	}

	function stop(id) {
		const challenge = read(id);
		if (!challenge) return { ok: false, error: "题目不存在" };
		const entry = running.get(id) || deferred.get(id)?.entry;
		if (!entry && challenge.status === "solved") return { ok: false, error: "题目已解出", status: "solved" };
		if (entry) { entry.retryRequested = false; entry.userStopped = true; requestStop(entry, "aborted"); }
		const result = commit(id, "stop", (edit, draft) => {
			if (!["solved", "stopped"].includes(draft.status)) edit.setStatus("stopped", { endedAt: now(), note: "用户停止" });
		});
		if (!result.ok && result.code === "STATE_NOT_DURABLE") pendingStops.add(id);
		if (!result.ok) return { ...stateError(result), interruptRequested: !!entry };
		pendingStops.delete(id);
		preparationErrors.delete(id);
		return { ok: true, id, status: read(id)?.status || "stopped" };
	}

	/**
	 * 停止所有「运行中」的尝试（interrupt + status=stopped）。
	 * 排队中的题目保持 queued：index.js 在插件 dispose 时调用本方法，不应把待跑队列误置 stopped。
	 */
	function stopAll() {
		let challenges = [];
		try {
			challenges = store.list();
		} catch (error) {
			logger.error("[ctf-auto] store.list failed in stopAll", error);
		}
		const ids = challenges
			.filter(
				(challenge) =>
					challenge &&
					(running.has(challenge.id) || challenge.status === "running") &&
					challenge.status !== "solved",
			)
			.map((challenge) => challenge.id);
		const stopped = [], errors = [];
		for (const id of ids) {
			try {
				const result = stop(id);
				if (result.ok) stopped.push(id); else errors.push({ id, ...result });
			} catch (error) {
				logger.warn(`[ctf-auto] stop(${id}) failed in stopAll`, error);
				errors.push({ id, error: errorText(error) });
			}
		}
		return { ok: errors.length === 0, stopped, errors };
	}

	/** 进程重启后的收口：把持久化中遗留的 running 尝试转为 aborted，并按预算决定是否重新入队。 */
	function recover() {
		const recovered = [], requeued = [], stuck = [], errors = [];
		if (disposed) return { ok: false, recovered, requeued, stuck, errors };
		drainCompletions();
		budgetTiming.prune(store.list().map((row) => row.id));
		for (const row of store.list()) {
			if (!row || running.has(row.id) || deferred.has(row.id) || pendingStops.has(row.id)) continue;
			if (resources?.status(row).taskRecoveryPending) continue;
			if (row.status !== "running" && !row.attempts.some((attempt) => attempt.status === "running" && attempt.finalizedAt == null)) continue;
			const timing = captureBudget(row);
			const result = commit(row.id, "recover", (edit, challenge) => {
				if (challenge.startedAt != null) edit.patch({ budgetClock: timing.checkpoint });
				let count = 0;
				for (const attempt of challenge.attempts) if (attempt.status === "running" && attempt.finalizedAt == null) {
					edit.endAttempt(attempt.n, { endedAt: now(), status: "aborted", stopReason: "recovered", summary: "上次进程中断前未收口", error: "插件进程重启，未完成本次尝试" });
					edit.updateAttempt(attempt.n, { finalizedAt: now() });
					enqueueLearningUsage(edit, challenge, attempt, { solved: challenge.status === "solved" || challenge.flags.some((flag) => flag.verified), at: now() });
					count++;
				}
				edit.addEvent("note", count ? "检测到进程中断，已收口遗留尝试" : "检测到 running 状态没有对应尝试");
				// Preserve explicit terminal states, including locally verified solved.
				if (challenge.status !== "running") return { status: challenge.status };
				if (challenge.flags.some((flag) => flag.verified)) edit.setStatus("solved", { endedAt: now() });
				else if (!clockFailure() && (timing.remainingMs == null || timing.remainingMs > 0) && config.autoRetry && challenge.attempts.length < attemptBudgetOf(challenge)) edit.setStatus("queued", { stuckReason: "", endedAt: null, note: "进程重启后重新入队" });
				else edit.setStatus("stuck", { stuckReason: "进程重启后未自动重试（autoRetry=false 或尝试预算已用尽）" });
				return { status: challenge.status };
			}, { durable: !!onUsagePending });
			if (result.applied) budgetTiming.accept(result.challenge, timing);
			if (!result.ok) { errors.push({ id: row.id, ...stateError(result) }); if (store.persistenceStatus().dirty) break; continue; }
			preparationErrors.delete(row.id);
			recovered.push(row.id);
			if (result.value.status === "queued") requeued.push(row.id);
			if (result.value.status === "stuck") stuck.push(row.id);
		}
		return { ok: errors.length === 0, recovered, requeued, stuck, errors };
	}

	function retry(id, hint) {
		if (closed) return { ok: false, error: "编排器已关闭" };
		const challenge = read(id);
		if (!challenge) return { ok: false, code: "CHALLENGE_NOT_FOUND", error: "题目不存在" };
		const timing = queueTiming(challenge);
		if (clockFailure()) return { ok: false, ...clockFailure(), error: clockFailure().message };
		const hintText = normalizeHint(hint);
		const result = commit(id, "retry", (edit, challenge) => {
			if (challenge.status === "solved") return { ok: false, error: "题目已解出", status: "solved" };
			prepareManualQueue(edit, challenge, config, timing.next.wall, { extend: true, remainingMs: timing.remainingMs, budgetClock: timing.next.checkpoint });
			if (challenge.attempts.length >= attemptBudgetOf(challenge)) return { ok: false, code: "ATTEMPT_BUDGET_EXHAUSTED", error: "已达到可扩展的尝试预算上限" };
			if (hintText) edit.addEvent("note", `人工重试提示：${tail(hintText, 300)}`);
			edit.setStatus("queued", { stuckReason: "", endedAt: null, note: hintText ? "手动重试：重新入队（已注入提示）" : "手动重试：重新入队" });
		});
		if (!result.ok && !result.applied) return stateError(result);
		budgetTiming.accept(result.challenge, timing.next);
		schedulingEnabled = true;
		pendingStops.delete(id);
		preparationErrors.delete(id);
		if (hintText) pushHint(id, hintText);
		const entry = running.get(id) || deferred.get(id)?.entry;
		if (entry) { entry.userStopped = false; entry.retryRequested = true; requestStop(entry, "aborted"); }
		if (!result.ok) return stateError(result);
		if (!entry) pump();
		return { ok: true, id, status: "queued" };
	}

	/** 已验证 flag 后尽快中断子代理，避免它继续消耗预算；最终由 finalizeAttempt 按 solved 收口。 */
	function abortAfterVerifiedFlag(id) {
		const entry = running.get(id);
		if (!entry || entry.finalizing) return false;
		requestStop(entry, "aborted");
		return true;
	}

	function tick() {
		const timedOut = [];
		if (closed) return timedOut;
		recover();
		try {
			for (const [id, entry] of running) {
				if (!entry || entry.finalizing || entry.cancelled) continue;
				const mono = budgetTiming.sample();
				if (clockFailure() || entry.deadlineMono != null && mono >= entry.deadlineMono) {
					try {
						entry.timedOut = true;
						requestStop(entry, "timeout");
						timedOut.push(id);
					} catch (error) {
						logger.warn(`[ctf-auto] timeout(${id}) failed in tick`, error);
					}
				} else if (entry.wrapupMono != null && mono >= entry.wrapupMono && !entry.wrapupSent) onWrapup(entry);
			}
		} catch (error) {
			logger.error("[ctf-auto] tick failed", error);
		}
		if (schedulingEnabled) pump();
		return timedOut;
	}

	function isRunning(id) {
		return running.has(id);
	}

	function close() {
		if (closed) return { ok: true, stopped: [] };
		drainCompletions();
		closed = true;
		const ids = [...running.keys()];
		for (const id of ids) {
			const entry = running.get(id);
			entry.userStopped = true;
			entry.retryRequested = false;
			requestStop(entry, "aborted");
			const current = read(id), timing = current ? captureBudget(current) : null;
			commit(id, "close", (edit, challenge) => {
				if (timing && challenge.startedAt != null) edit.patch({ budgetClock: timing.checkpoint });
				for (const attempt of challenge.attempts) if (attempt.status === "running" && attempt.finalizedAt == null) {
					edit.endAttempt(attempt.n, { endedAt: now(), status: "aborted", stopReason: "aborted", summary: "编排器关闭",
						...(attempt.runId === entry.runId && entry.startedMono != null ? { elapsedMs: Math.max(0, budgetTiming.sample() - entry.startedMono) } : {}) });
					edit.updateAttempt(attempt.n, { finalizedAt: now() });
					enqueueLearningUsage(edit, challenge, attempt, { solved: challenge.status === "solved" || challenge.flags.some((flag) => flag.verified), at: now() });
				}
				if (challenge.status !== "solved") edit.setStatus("stopped", { endedAt: now(), note: "编排器关闭" });
			}, { durable: !!onUsagePending });
		}
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		disposed = true; // Late completions from this instance must never write after unload.
		deferred.clear(); pendingStops.clear();
		preparationErrors.clear();
		budgetTiming.close();
		return { ok: true, stopped: ids };
	}

	async function whenIdle() {
		while (jobs.size > 0) {
			await Promise.all([...jobs.values()]);
		}
	}

	function setConfig(patch) {
		const next = normalizeConfig({ ...config, ...(isPlainObject(patch) ? patch : {}) });
		Object.assign(config, next);
		if (!closed) {
			try {
				pump();
			} catch (error) {
				logger.warn("[ctf-auto] pump after setConfig failed", error);
			}
		}
		return config;
	}

/** 调度快照：运行中/排队中的题与关键指标（面板「调度」页与工具用）。 */
function snapshot() {
	const occupancy = executionOccupancy();
	const mono = budgetTiming.sample();
	const runningList = [...running.values()].map((entry) => {
		const ch = read(entry.id) || {};
		const attempt = (ch.attempts || []).find((item) => item && item.n === entry.attemptN) || null;
		const startedAt = attempt && typeof attempt.startedAt === "number" ? attempt.startedAt : entry.startedAt;
		const timeoutMs = Number(attempt && attempt.timeoutMs) || Number(config.timeoutMs) || 0;
		return {
			id: entry.id,
			title: String(ch.title || ""),
			category: String(ch.category || ""),
			attemptN: entry.attemptN,
			runId: entry.runId || "",
			deadlineAt: entry.deadlineAt ?? null,
			startedAt,
			elapsedMs: entry.startedMono == null ? 0 : Math.max(0, mono - entry.startedMono),
			remainingMs: clockFailure() ? 0 : entry.deadlineMono == null ? null : Math.max(0, entry.deadlineMono - mono),
			timeoutMs,
			phase: attempt && attempt.wrapupAt ? "wrapup" : "normal",
			angle: attempt ? String(attempt.angle || "") : "",
			role: attempt ? String(attempt.role || "") : "",
			skill: attempt ? String(attempt.skill || "") : "",
			target: String(ch.target || "")
		};
	});
	let queued = [];
	try {
		queued = store.list().filter((ch) => ch && ch.status === "queued" && !running.has(ch.id)).map((ch, index) => ({ position: index + 1, id: ch.id, title: String(ch.title || ""), category: String(ch.category || ""), createdAt: Number(ch.createdAt) || 0 }));
	} catch { queued = []; }
	return {
		ok: true,
		concurrency: Math.max(1, Number(config.concurrency) || 1),
		timeoutMs: Number(config.timeoutMs) || 0,
		maxAttempts: Number(config.maxAttempts) || 0,
		autoRetry: config.autoRetry !== false,
		running: runningList,
		queued,
		runningCount: runningList.length,
		queuedCount: queued.length,
		occupiedSlots: occupancy.occupiedSlots, availableSlots: occupancy.availableSlots,
		waitingForStop: occupancy.waitingForStop, waitingForStopCount: occupancy.waitingForStop.length,
		containerBusy: occupancy.containerBusy,
		budgetTiming: budgetTiming.status(),
		pendingCompletions: deferred.size, pendingStops: pendingStops.size,
		preparationErrors: [...preparationErrors.entries()].map(([id, error]) => ({ id, ...error }))
	};
}

	const orchestrator = {
		config,
		start,
		setConfig,
		recover,
		pump,
		stop,
		stopAll,
		abortAfterVerifiedFlag,
		retry,
		tick,
		isRunning,
		timingStatus: () => budgetTiming.status(),
		timing(id) {
			const entry = running.get(id);
			if (!entry || entry.deadlineMono == null) return null;
			const mono = budgetTiming.sample();
			return { runId: entry.runId, remainingMs: clockFailure() ? 0 : Math.max(0, entry.deadlineMono - mono), elapsedMs: Math.max(0, mono - entry.startedMono) };
		},
		close,
		whenIdle,
		snapshot,
		runningCount: () => running.size,
		queuedCount: () => countQueued(),
	};
	return orchestrator;
}
