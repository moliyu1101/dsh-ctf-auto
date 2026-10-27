/**
 * dsh-ctf-auto / lib/orchestrator.js
 * 队列 / 并发 / 超时 / 自动重试状态机。
 *
 * 设计要点（docs/DESIGN.md §4）：
 * - 端口注入：spawn(request) → { sessionId?, done: Promise<{stopReason, outputText, sessionId?}>, interrupt() }
 * - 不 import 任何 DSH API，纯 Node。
 * - 任何异常都被捕获：状态机不会崩，题目最终一定落到终态或重新入队。
 */
import { DEFAULT_FLAG_RE, buildAttemptPrompt, classifyAttempt, extractFlags, nextAngle, skillForCategory } from "./prompt.js";
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
};

const STOP_REASONS = ["completed", "aborted", "error", "max-tokens", "refusal", "timeout", "blocked"];
const ATTEMPT_STATUS_BY_STOP_REASON = {
	timeout: "timeout",
	aborted: "aborted",
	error: "error",
	blocked: "error",
};

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

function normalizeConfig(raw) {
	const merged = { ...DEFAULTS, ...(isPlainObject(raw) ? raw : {}) };
	const ratio = Number(merged.wrapupRatio);
	return {
		...merged,
		concurrency: Math.max(1, positiveInt(merged.concurrency, DEFAULTS.concurrency)),
		timeoutMs: positiveInt(merged.timeoutMs, DEFAULTS.timeoutMs),
		maxAttempts: positiveInt(merged.maxAttempts, DEFAULTS.maxAttempts),
		timeBudgetMs: positiveInt(merged.timeBudgetMs, DEFAULTS.timeBudgetMs),
		autoRetry: merged.autoRetry !== false,
		wrapupRatio: Number.isFinite(ratio) ? Math.min(0.95, Math.max(0.5, ratio)) : DEFAULTS.wrapupRatio,
		wrapupGraceMs: Math.max(0, Math.min(600000, positiveInt(merged.wrapupGraceMs, DEFAULTS.wrapupGraceMs))),
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

function attemptStatusFor(stopReason) {
	return ATTEMPT_STATUS_BY_STOP_REASON[stopReason] || "completed";
}

/**
 * @param {{store: object, spawn: Function, config?: object, now?: Function, logger?: object}} deps
 */
export function createOrchestrator(deps = {}) {
	const store = deps && deps.store;
	const spawn = deps && deps.spawn;
	if (!store || typeof store.get !== "function" || typeof store.list !== "function") {
		throw new TypeError("createOrchestrator: deps.store is required");
	}
	if (typeof spawn !== "function") {
		throw new TypeError("createOrchestrator: deps.spawn is required");
	}
	const now = typeof deps.now === "function" ? deps.now : Date.now;
	const logger = normalizeLogger(deps.logger);
	const config = normalizeConfig(deps.config);
	const recall = typeof deps.recall === "function" ? deps.recall : null;
	const onMemoriesUsed = typeof deps.onMemoriesUsed === "function" ? deps.onMemoriesUsed : null;
	const onKnowledgeUsed = typeof deps.onKnowledgeUsed === "function" ? deps.onKnowledgeUsed : null;

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
	let closed = false;
	let pumping = false;

	function safeSave(label) {
		try {
			if (typeof store.save === "function") store.save();
		} catch (error) {
			logger.error(`[ctf-auto] store.save failed (${label || "unknown"})`, error);
		}
	}

	function safeEvent(id, kind, text, data) {
		try {
			if (typeof store.addEvent === "function") store.addEvent(id, kind, text, data);
		} catch (error) {
			logger.warn("[ctf-auto] store.addEvent failed", error);
		}
	}

	function safeFact(id, input) {
		try {
			if (typeof store.addFact === "function") store.addFact(id, input);
		} catch (error) {
			logger.warn("[ctf-auto] store.addFact failed", error);
		}
	}

	function safeSetStatus(id, status, extra) {
		try {
			if (typeof store.setStatus === "function") return store.setStatus(id, status, extra);
			return undefined;
		} catch (error) {
			logger.warn("[ctf-auto] store.setStatus failed", error);
			return undefined;
		}
	}

	function attemptBudgetOf(challenge) {
		const value = Number(challenge && challenge.budget && challenge.budget.maxAttempts);
		if (Number.isFinite(value) && value > 0) return Math.floor(value);
		return config.maxAttempts;
	}

	function timeBudgetRemaining(challenge, at = now()) {
		const startedAt = Number(challenge && challenge.startedAt);
		const budget = positiveInt(challenge && challenge.budget && challenge.budget.timeBudgetMs, config.timeBudgetMs);
		if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
		return startedAt + budget - at;
	}

	/** 手动 start/retry 时，若历史尝试次数已用满预算，则放宽一次，保证手动重试真的会跑。 */
	function ensureAttemptBudget(challenge) {
		const used = Array.isArray(challenge.attempts) ? challenge.attempts.length : 0;
		const budget = attemptBudgetOf(challenge);
		if (used < budget) return budget;
		const nextBudget = {
			...(isPlainObject(challenge.budget) ? challenge.budget : {}),
			maxAttempts: used + 1,
			timeBudgetMs: positiveInt(challenge.budget && challenge.budget.timeBudgetMs, config.timeBudgetMs),
		};
		try {
			store.update(challenge.id, { budget: nextBudget });
		} catch (error) {
			logger.warn("[ctf-auto] store.update(budget) failed", error);
		}
		return nextBudget.maxAttempts;
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
		entry.timedOut = true;
		requestStop(entry, "timeout");
	}

	/** 预算结算：到 wrapupRatio 先注入收尾指令，再把 deadline 顺延 wrapupGraceMs。 */
	function onWrapup(entry) {
		if (!entry || entry.finalizing || entry.cancelled || entry.wrapupSent) return;
		entry.wrapupSent = true;
		// 没有结算注入通道（如测试/旧 provider）时不做结算，保持原 timeout 语义
		if (!entry.handle || typeof entry.handle.send !== "function") return;
		const id = entry.id;
		const n = entry.attemptN;
		const bonus = Math.max(0, Math.round(config.wrapupGraceMs));
		const ratioPct = Math.round(config.wrapupRatio * 100);
		const text = [
			`【预算结算】本次尝试已用到单次预算的 ${ratioPct}%（宽限约 ${Math.round(bonus / 60000)} 分钟）。`,
			"现在收尾，不要开新方向：",
			"1) 把已确认的事实、半成品脚本/命令写进 notes.md 与 artifacts/（上下文可能被中断，磁盘是唯一可靠介质）；",
			"2) 如果已经验证到 flag，立即调用 ctf_flag_record(id, flag, evidence, verified=true, method) 登记；",
			"3) 如果还没解出，用一句话写清卡点与已试路径到 notes.md，并在最终回复里总结卡点。",
			"收尾后停止继续探索。",
		].join("\n");
		try {
			if (id && n > 0) {
				const live = store.get(id);
				const attempt = live && Array.isArray(live.attempts) ? live.attempts.find((item) => item && item.n === n) : null;
				if (attempt) attempt.wrapupAt = now();
				safeSave("wrapup");
				safeEvent(id, "wrapup", `预算结算：已注入收尾指令（宽限 ${Math.round(bonus / 1000)}s）`, { attempt: n });
			}
			if (entry.handle && typeof entry.handle.send === "function") {
				try {
					const sent = entry.handle.send(text);
					if (sent && typeof sent.catch === "function") sent.catch(() => {});
				} catch (error) {
					logger.warn("[ctf-auto] handle.send(wrapup) failed", error);
				}
			}
			if (entry.timer) {
				clearTimeout(entry.timer);
				timers.delete(entry.timer);
			}
			entry.timer = setTimeout(() => {
				try {
					onTimeout(entry);
				} catch (error) {
					logger.error("[ctf-auto] timeout handler failed", error);
				}
			}, bonus);
			timers.add(entry.timer);
			if (typeof entry.timer.unref === "function") entry.timer.unref();
		} catch (error) {
			logger.warn("[ctf-auto] wrapup failed", error);
		}
	}

	function handleFatalError(entry, error) {
		const message = errorText(error) || "unknown error";
		logger.error(`[ctf-auto] attempt crashed for ${entry && entry.id}`, error);
		try {
			const id = entry.id;
			const challenge = store.get(id);
			if (!challenge) return;
			const n = entry.attemptN;
			if (n > 0) {
				try {
					try { attempt.outputChars = outputText.length; } catch { /* ignore */ }
					try { attempt.estTokens = Math.round(((Number(attempt.promptChars) || 0) + (Number(attempt.outputChars) || 0)) / 4); } catch { /* ignore */ }
					try { attempt.estCost = Math.round((Number(attempt.estTokens) || 0) / 1e6 * (Number(config.pricePerMToken) || 0) * 1e6) / 1e6; } catch { /* ignore */ }
					store.endAttempt(id, n, {
						endedAt: now(),
						status: "error",
						stopReason: "error",
						summary: "编排器内部异常",
						error: message,
					});
				} catch (endError) {
					logger.warn("[ctf-auto] endAttempt in fatal handler failed", endError);
				}
			}
			safeEvent(id, "error", `编排器内部异常：${message}`, n > 0 ? { attempt: n } : undefined);
			const current = store.get(id);
			if (current && current.status !== "solved") {
				safeSetStatus(id, "stuck", { stuckReason: `编排器内部异常：${tail(message, 200)}` });
			}
		} catch (fatal) {
			logger.error("[ctf-auto] fatal handler failed", fatal);
		} finally {
			safeSave("fatal");
		}
	}

	async function finalizeAttempt(entry, result, handle) {
		entry.finalizing = true;
		const id = entry.id;
		const payload = isPlainObject(result) ? result : {};
		let stopReason;
		if (entry.timedOut) stopReason = "timeout";
		else if (entry.userStopped || (entry.cancelled && entry.cancelKind === "aborted")) stopReason = "aborted";
		else if (payload.__error) stopReason = "error";
		else stopReason = normalizeStopReason(payload.stopReason);

		const outputText = typeof payload.outputText === "string" ? payload.outputText : "";
		const errorMessage = payload.__error
			? errorText(payload.__error)
			: stopReason === "error" && typeof payload.error === "string"
				? payload.error
				: "";
		const sessionId =
			payload.sessionId != null
				? String(payload.sessionId)
				: handle && handle.sessionId != null
					? String(handle.sessionId)
					: null;

		let challenge = store.get(id);
		if (!challenge) return;
		const n =
			entry.attemptN ||
			(challenge.attempts.length > 0
				? challenge.attempts[challenge.attempts.length - 1].n
				: 0);

		try {
			// 1) 输出里扫描到的 flag 先登记为「候选（未验证）」，子代理经 ctf_flag_record 登记的保留其 verified。
			if (n > 0) {
				for (const value of extractFlagsWithExtras(outputText, config.extraFlagsRe)) {
					try {
						const current = store.get(id);
						if (!current) continue;
						if ((current.flags || []).some((flag) => flag.value === value)) continue;
						store.addFlag(id, {
							value,
							verified: false,
							evidence: `第 ${n} 次尝试输出自动提取（未验证，需人工复核）`,
							method: "manual",
							attempt: n,
						});
					} catch (error) {
						logger.warn("[ctf-auto] addFlag(candidate) failed", error);
					}
				}
			}

			challenge = store.get(id) || challenge;
			const storeFlags = (challenge.flags || []).map((flag) => ({
				value: flag.value,
				verified: !!flag.verified,
			}));
			const outputFlags = extractFlagsWithExtras(outputText, config.extraFlagsRe).map((value) => ({
				value,
				verified: false,
			}));
			const flagsForClassify = storeFlags.length > 0 ? storeFlags : outputFlags;
			const verifiedFlag = storeFlags.find((flag) => flag.verified)?.value || null;
			const classification = classifyAttempt({
				stopReason,
				outputText,
				flags: flagsForClassify,
				verifiedFlag,
			});
			const summary = classification.summary;

			if (n > 0) {
				const currentAttempt = (challenge.attempts || []).find((item) => item.n === n);
				const attemptAngle =
					(currentAttempt && typeof currentAttempt.angle === "string" && currentAttempt.angle) ||
					"unknown";
				const solvedByFlagNow = (challenge.flags || []).some((flag) => flag.verified);
				const solvedNow =
					classification.outcome === "solved" ||
					solvedByFlagNow ||
					challenge.status === "solved";
				let factTag = "[失败]";
				if (solvedNow) factTag = "[结论]";
				else if (stopReason === "timeout") factTag = "[卡点]";
				else if (stopReason === "aborted") factTag = "[中断]";
				safeFact(id, {
					text: `${factTag} 第 ${n} 次尝试（角度 ${attemptAngle}）：${summary}`,
					source: `attempt#${n}`,
					attempt: n,
				});

				// failedPaths：本 attempt 的 [失败]/[卡点] fact + 已有 failedPaths，去重取最近 30 条
				const failedPaths = [];
				const pushPath = (value) => {
					const text = tail(value, 300).replace(/\s+/g, " ").trim();
					if (!text || failedPaths.includes(text)) return;
					failedPaths.push(text);
				};
				for (const pathText of Array.isArray(currentAttempt && currentAttempt.failedPaths)
					? currentAttempt.failedPaths
					: []) {
					pushPath(pathText);
				}
				const latestChallenge = store.get(id) || challenge;
				for (const fact of latestChallenge.facts || []) {
					if (!fact || fact.attempt !== n || typeof fact.text !== "string") continue;
					if (!fact.text.startsWith("[失败]") && !fact.text.startsWith("[卡点]")) continue;
					pushPath(fact.text.replace(/^\[(?:失败|卡点)\]\s*/, ""));
				}

				try {
					const __attemptRow = (store.get(id)?.attempts || []).find((item) => item && item.n === n) || null;
					const __outputChars = outputText.length;
					const __estTokens = Math.round(((Number(__attemptRow && __attemptRow.promptChars) || 0) + __outputChars) / 4);
					store.endAttempt(id, n, {
						endedAt: now(),
						status: attemptStatusFor(stopReason),
						outputChars: __outputChars,
						estTokens: __estTokens,
						estCost: Math.round(__estTokens / 1e6 * (Number(config.pricePerMToken) || 0) * 1e6) / 1e6,
						stopReason,
						summary,
						failedPaths: failedPaths.slice(-30),
						outputTail: tail(outputText),
						error: errorMessage,
						sessionId,
					});
				} catch (error) {
					logger.warn("[ctf-auto] endAttempt failed", error);
				}
				safeEvent(id, "attempt-end", `第 ${n} 次尝试结束：${summary}`, { attempt: n });
			}

			challenge = store.get(id) || challenge;
			const solvedByFlag = (challenge.flags || []).some((flag) => flag.verified);
			const solved =
				classification.outcome === "solved" || solvedByFlag || challenge.status === "solved";

			const recalledIds = ((store.get(id)?.attempts || []).find((item) => item && item.n === n)?.memories || []).map((item) => item && item.id).filter(Boolean);
			if (recalledIds.length > 0 && onMemoriesUsed) { try { onMemoriesUsed(recalledIds, solved); } catch (error) { logger.warn("[ctf-auto] memories used hook failed", error); } }
			const recalledKnowledgeIds = ((store.get(id)?.attempts || []).find((item) => item && item.n === n)?.knowledge || []).map((item) => item && item.id).filter(Boolean);
			if (recalledKnowledgeIds.length > 0 && onKnowledgeUsed) { try { onKnowledgeUsed(recalledKnowledgeIds, solved); } catch (error) { logger.warn("[ctf-auto] knowledge used hook failed", error); } }
			if (solved) {
				if (challenge.status !== "solved") {
					safeSetStatus(id, "solved", {
						endedAt: typeof challenge.endedAt === "number" ? challenge.endedAt : now(),
					});
				} else if (typeof challenge.endedAt !== "number") {
					try {
						store.update(id, { endedAt: now() });
					} catch (error) {
						logger.warn("[ctf-auto] update(endedAt) failed", error);
					}
				}
				safeEvent(id, "note", `题目已解出${verifiedFlag ? `：${verifiedFlag}` : ""}`, {
					attempt: n,
				});
			} else if (entry.retryRequested) {
				const current = store.get(id);
				if (!current || current.status !== "queued") safeSetStatus(id, "queued", {});
			} else if (closed) {
				safeSetStatus(id, "stopped", { endedAt: now() });
			} else if (entry.userStopped) {
				const current = store.get(id);
				if (!current || current.status !== "stopped") {
					safeSetStatus(id, "stopped", { endedAt: now() });
				}
			} else {
				const attemptsUsed = Array.isArray(challenge.attempts) ? challenge.attempts.length : 0;
				const budget = attemptBudgetOf(challenge);
				const totalBudgetExhausted = (() => {
					const remaining = timeBudgetRemaining(challenge, now());
					return remaining != null && remaining <= 0;
				})();
				const canRetry =
					config.autoRetry &&
					stopReason !== "aborted" &&
					!entry.budgetExhausted &&
					!totalBudgetExhausted &&
					attemptsUsed < budget;
				if (canRetry) {
					safeSetStatus(id, "queued", {});
					safeEvent(id, "note", `自动换角度重试（已用 ${attemptsUsed}/${budget} 次）`, {
						attempt: n,
					});
				} else {
					const reason = errorMessage
						? `${summary}（${tail(errorMessage, 200)}）`
						: summary;
					safeSetStatus(id, "stuck", { stuckReason: reason });
				}
			}
		} catch (error) {
			logger.error(`[ctf-auto] finalize attempt failed for ${id}`, error);
			try {
				const current = store.get(id);
				if (current && current.status !== "solved" && current.status !== "stopped") {
					safeSetStatus(id, "stuck", {
						stuckReason: `收口异常：${tail(errorText(error), 200)}`,
					});
				}
			} catch (fatal) {
				logger.error("[ctf-auto] finalize fallback failed", fatal);
			}
		} finally {
			safeSave("attempt-end");
		}
	}

	async function runAttempt(entry, agentPreset) {
		const id = entry.id;
		let challenge = store.get(id);
		if (!challenge) return;
		if (closed) {
			safeSetStatus(id, "stopped", { endedAt: now() });
			return;
		}
		if (challenge.status === "stopped" || challenge.status === "solved") return;

		const angle = nextAngle(challenge.attempts.length, config);
		let attempt;
		let roleName = "solver";
		let recalled = [];
		let recalledKnowledge = [];
		try {
			attempt = store.addAttempt(id, { angle });
			try { attempt.skill = skillForCategory(challenge.category); } catch { /* ignore */ }
			roleName = attempt.n === 1 ? "recon" : "solver";
			try { attempt.role = roleName; } catch { /* ignore */ }
			if (recall) {
				try {
					const pack = recall(challenge, { limit: 3 });
					if (Array.isArray(pack)) recalled = pack;
					else if (pack && typeof pack === "object") { recalled = Array.isArray(pack.memories) ? pack.memories : []; recalledKnowledge = Array.isArray(pack.knowledge) ? pack.knowledge : []; }
				} catch { recalled = []; recalledKnowledge = []; }
			}
			try { attempt.memories = recalled.map((item) => ({ id: String(item && item.id || ""), title: String(item && item.title || ""), score: Number(item && item.score) || 0 })); } catch { /* ignore */ }
			try { attempt.knowledge = recalledKnowledge.map((item) => ({ id: String(item && item.id || ""), title: String(item && item.title || ""), score: Number(item && item.score) || 0, source: String(item && item.source || "") })); } catch { /* ignore */ }
			if (recalled.length > 0) safeEvent(id, "note", `召回相似打法卡 ${recalled.length} 张：` + recalled.slice(0, 3).map((item) => `${item.title}（${(Number(item.score) || 0).toFixed(2)}）`).join("、"), { memories: recalled.map((item) => item.id) });
			if (recalledKnowledge.length > 0) safeEvent(id, "note", `召回知识片段 ${recalledKnowledge.length} 条：` + recalledKnowledge.slice(0, 3).map((item) => `${item.title}（${(Number(item.score) || 0).toFixed(2)}）`).join("、"), { knowledge: recalledKnowledge.map((item) => item.id) });
		} catch (error) {
			logger.error("[ctf-auto] addAttempt failed", error);
			return;
		}
		if (!attempt) return;
		entry.attemptN = attempt.n;
		safeEvent(id, "attempt-start", `第 ${attempt.n} 次尝试开始（角度 ${angle}${attempt.skill ? `，技能 ${attempt.skill}` : ""}${attempt.role ? `，角色 ${attempt.role}` : ""}）`, {
			attempt: attempt.n,
			skill: attempt.skill || "",
			role: attempt.role || "",
		});
		safeSave("attempt-start");

		challenge = store.get(id) || challenge;
		const consumedHints = consumeHints(id);
		const hintParts = [...normalizeHints(config.hints), ...consumedHints];
		const maxAttempts = attemptBudgetOf(challenge);
		const budgetTimeBudgetMs = positiveInt(
			challenge.budget && challenge.budget.timeBudgetMs,
			config.timeBudgetMs,
		);
		const attemptStartedAt =
			typeof attempt.startedAt === "number" ? attempt.startedAt : now();
		const remainingTotalMs = timeBudgetRemaining(challenge, attemptStartedAt);
		const effectiveTimeoutMs = remainingTotalMs == null
			? config.timeoutMs
			: Math.max(0, Math.min(config.timeoutMs, remainingTotalMs));
		entry.timeoutMs = effectiveTimeoutMs;
		entry.budgetExhausted = remainingTotalMs != null && remainingTotalMs <= 0;
		attempt.timeoutMs = effectiveTimeoutMs;
		const priorAttempts = challenge.attempts.filter((item) => item.n !== attempt.n);
		const controller = new AbortController();
		entry.controller = controller;

		let prompt;
		try {
			prompt = buildAttemptPrompt({
				challenge,
				attempt,
				roleName,
				roleText: loadRoleText(roleName),
				memories: recalled,
				knowledge: recalledKnowledge,
				config: {
					...config,
					id,
					maxAttempts,
					timeBudgetMs: budgetTimeBudgetMs,
					timeoutMs: effectiveTimeoutMs,
					hints: hintParts,
					now: attemptStartedAt,
					deadline: attemptStartedAt + effectiveTimeoutMs,
					totalDeadline:
						typeof challenge.startedAt === "number"
							? challenge.startedAt + budgetTimeBudgetMs
							: undefined,
				},
				priorAttempts,
			});
		} catch (error) {
			logger.error("[ctf-auto] buildAttemptPrompt failed, fallback used", error);
			prompt = `# CTF 解题任务\n\n题目：${challenge.title}\n\n题面：\n${challenge.statement || ""}\n\n工作目录：${challenge.dir}\n`;
		}
		try { attempt.promptChars = prompt ? prompt.length : 0; } catch { /* ignore */ }

		const request = {
			label: attempt.label,
			prompt,
			cwd: challenge.dir,
			agentPreset,
			attempt,
			challenge,
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
			handle = spawn(request);
			if (!handle || typeof handle !== "object") {
				throw new Error("spawn 返回了无效句柄");
			}
			entry.handle = handle;
			const donePromise =
				handle.done && typeof handle.done.then === "function"
					? handle.done
					: Promise.reject(new Error("spawn handle 缺少 done Promise"));
			// 避免 done 在 timeout/stop 后迟到 reject 造成 unhandledRejection
			donePromise.catch(() => {});
			entry.timer = setTimeout(() => {
				try {
					onTimeout(entry);
				} catch (error) {
					logger.error("[ctf-auto] timeout handler failed", error);
				}
			}, effectiveTimeoutMs);
			timers.add(entry.timer);
			if (typeof entry.timer.unref === "function") entry.timer.unref();
			const wrapupDelay = Math.max(0, Math.round(effectiveTimeoutMs * config.wrapupRatio));
			entry.wrapupTimer = setTimeout(() => {
				try {
					onWrapup(entry);
				} catch (error) {
					logger.error("[ctf-auto] wrapup handler failed", error);
				}
			}, wrapupDelay);
			timers.add(entry.wrapupTimer);
			if (typeof entry.wrapupTimer.unref === "function") entry.wrapupTimer.unref();
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
		const challenge = store.get(id);
		if (!challenge || challenge.status !== "queued" || running.has(id)) return false;
		const entry = {
			id,
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
		const agentPreset = presets.has(id) ? presets.get(id) : config.solverPreset;
		const job = Promise.resolve()
			.then(() => runAttempt(entry, agentPreset))
			.catch((error) => handleFatalError(entry, error))
			.finally(() => {
				running.delete(id);
				jobs.delete(id);
				safeSave("attempt-final");
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
		if (closed || pumping) return 0;
		pumping = true;
		let started = 0;
		try {
			for (;;) {
				if (running.size >= config.concurrency) break;
				let next;
				try {
					next = store
						.list()
						.find(
							(challenge) =>
								challenge &&
								challenge.status === "queued" &&
								!running.has(challenge.id),
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
		const challenge = store.get(id);
		if (!challenge) return { ok: false, error: "题目不存在" };
		if (running.has(id)) return { ok: false, error: "题目已在运行", status: challenge.status };
		if (challenge.status === "solved") {
			return { ok: false, error: "题目已解出", status: challenge.status };
		}
		if (typeof opts.agentPreset === "string" && opts.agentPreset) {
			presets.set(id, opts.agentPreset);
		} else {
			presets.delete(id);
		}
		if (opts.hint != null) pushHint(id, opts.hint);
		ensureAttemptBudget(challenge);
		safeSetStatus(id, "queued", { stuckReason: "", endedAt: null, note: "加入调度队列" });
		safeSave("start");
		const started = pump();
		return { ok: true, id, status: "queued", queued: countQueued(), started };
	}

	function stop(id) {
		const challenge = store.get(id);
		if (!challenge) return { ok: false, error: "题目不存在" };
		const entry = running.get(id);
		if (!entry) {
			if (challenge.status === "solved") {
				return { ok: false, error: "题目已解出", status: "solved" };
			}
			if (challenge.status === "stopped") return { ok: true, id, status: "stopped" };
			safeSetStatus(id, "stopped", { endedAt: now(), note: "用户停止" });
			safeSave("stop");
			return { ok: true, id, status: "stopped" };
		}
		entry.userStopped = true;
		requestStop(entry, "aborted");
		safeSetStatus(id, "stopped", { endedAt: now(), note: "用户停止" });
		safeSave("stop");
		return { ok: true, id, status: "stopped" };
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
		for (const id of ids) {
			try {
				stop(id);
			} catch (error) {
				logger.warn(`[ctf-auto] stop(${id}) failed in stopAll`, error);
			}
		}
		safeSave("stopAll");
		return { ok: true, stopped: ids };
	}

	/** 进程重启后的收口：把持久化中遗留的 running 尝试转为 aborted，并按预算决定是否重新入队。 */
	function recover() {
		const recovered = [];
		const requeued = [];
		const stuck = [];
		let challenges = [];
		try { challenges = store.list(); } catch (error) { logger.error("[ctf-auto] recover store.list failed", error); return { ok: false, recovered, requeued, stuck }; }
		for (const challenge of challenges) {
			if (!challenge || challenge.status !== "running" || running.has(challenge.id)) continue;
			const openAttempts = (Array.isArray(challenge.attempts) ? challenge.attempts : [])
				.filter((attempt) => attempt && attempt.status === "running");
			for (const attempt of openAttempts) {
				try {
					store.endAttempt(challenge.id, attempt.n, {
						endedAt: now(),
						status: "aborted",
						stopReason: "recovered",
						summary: "上次进程中断前未收口",
						error: "插件进程重启，未完成本次尝试",
					});
				} catch (error) {
					logger.warn(`[ctf-auto] recover endAttempt(${challenge.id}#${attempt.n}) failed`, error);
				}
			}
			recovered.push(challenge.id);
			safeEvent(challenge.id, "note", openAttempts.length > 0
				? "检测到上次进程中断，已收口遗留的 running 尝试"
				: "检测到上次进程中断，题目状态为 running 但无运行中的尝试");
			const used = Array.isArray(challenge.attempts) ? challenge.attempts.length : 0;
			const budget = attemptBudgetOf(challenge);
			if (config.autoRetry && used < budget) {
				safeSetStatus(challenge.id, "queued", {
					stuckReason: "",
					endedAt: null,
					note: "进程重启后重新入队",
				});
				requeued.push(challenge.id);
			} else {
				safeSetStatus(challenge.id, "stuck", {
					stuckReason: "进程重启后未自动重试（autoRetry=false 或尝试预算已用尽）",
				});
				stuck.push(challenge.id);
			}
		}
		safeSave("recover");
		return { ok: true, recovered, requeued, stuck };
	}

	function retry(id, hint) {
		if (closed) return { ok: false, error: "编排器已关闭" };
		const challenge = store.get(id);
		if (!challenge) return { ok: false, error: "题目不存在" };
		ensureAttemptBudget(challenge);
		const hintText = normalizeHint(hint);
		if (hintText) {
			pushHint(id, hintText);
			safeEvent(id, "note", `人工重试提示：${tail(hintText, 300)}`);
		}
		const entry = running.get(id);
		if (entry) {
			entry.retryRequested = true;
			requestStop(entry, "aborted");
		}
		safeSetStatus(id, "queued", {
			stuckReason: "",
			endedAt: null,
			note: hintText ? "手动重试：重新入队（已注入提示）" : "手动重试：重新入队",
		});
		safeSave("retry");
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
		try {
			for (const [id, entry] of running) {
				if (!entry || entry.finalizing || entry.cancelled) continue;
				if (typeof entry.startedAt !== "number") entry.startedAt = now();
				const timeoutMs = Number(entry.timeoutMs) > 0 ? Number(entry.timeoutMs) : config.timeoutMs;
				if (timeoutMs > 0 && now() - entry.startedAt >= timeoutMs) {
					try {
						entry.timedOut = true;
						requestStop(entry, "timeout");
						timedOut.push(id);
					} catch (error) {
						logger.warn(`[ctf-auto] timeout(${id}) failed in tick`, error);
					}
				}
			}
		} catch (error) {
			logger.error("[ctf-auto] tick failed", error);
		}
		return timedOut;
	}

	function isRunning(id) {
		return running.has(id);
	}

	function close() {
		if (closed) return { ok: true, stopped: [] };
		closed = true;
		const ids = [...running.keys()];
		for (const id of ids) {
			const entry = running.get(id);
			if (!entry) continue;
			entry.userStopped = true;
			requestStop(entry, "aborted");
			safeSetStatus(id, "stopped", { endedAt: now(), note: "编排器关闭" });
		}
		running.clear();
		for (const timer of timers) {
			try {
				clearTimeout(timer);
			} catch {
				/* ignore */
			}
		}
		timers.clear();
		safeSave("close");
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
	const runningList = [...running.values()].map((entry) => {
		const ch = store.get(entry.id) || {};
		const attempt = (ch.attempts || []).find((item) => item && item.n === entry.attemptN) || null;
		const startedAt = attempt && typeof attempt.startedAt === "number" ? attempt.startedAt : entry.startedAt;
		const timeoutMs = Number(attempt && attempt.timeoutMs) || Number(config.timeoutMs) || 0;
		return {
			id: entry.id,
			title: String(ch.title || ""),
			category: String(ch.category || ""),
			attemptN: entry.attemptN,
			startedAt,
			elapsedMs: Math.max(0, now() - startedAt),
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
		queuedCount: queued.length
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
		close,
		whenIdle,
		snapshot,
		runningCount: () => running.size,
		queuedCount: () => countQueued(),
	};
	return orchestrator;
}
