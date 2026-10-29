import { classifyAttempt } from "./prompt.js";
import { enqueueLearningUsage } from "./learning-usage.js";

export function attemptBudget(challenge, config) {
	const value = Number(challenge.budget?.maxAttempts);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : config.maxAttempts;
}

export function remainingBudgetTime(challenge, config, at) {
	const startedAt = Number(challenge.startedAt);
	const limit = Number(challenge.budget?.timeBudgetMs) > 0 ? Number(challenge.budget.timeBudgetMs) : config.timeBudgetMs;
	return Number.isFinite(startedAt) && startedAt > 0 ? startedAt + limit - at : null;
}

export function prepareManualQueue(edit, challenge, config, at, { extend = false, remainingMs = remainingBudgetTime(challenge, config, at), budgetClock } = {}) {
	const used = challenge.attempts.length;
	const budget = attemptBudget(challenge, config);
	if (remainingMs != null && remainingMs <= 0) edit.patch({ startedAt: at, endedAt: null });
	if (budgetClock && challenge.startedAt != null) edit.patch({ budgetClock });
	if (extend && used >= budget && used < 10) edit.patch({ budget: { ...challenge.budget, maxAttempts: used + 1 } });
}

export function settleAttempt(edit, challenge, plan, runtime) {
	const attempt = challenge.attempts.find((item) => item.n === plan.n);
	if (!attempt || attempt.runId !== plan.runId || challenge.attempts.at(-1)?.n !== plan.n) return { ignored: true };
	const effects = () => ({ solved: challenge.status === "solved" || challenge.flags.some((flag) => flag.verified),
		memories: (attempt.memories || []).map((item) => item?.id).filter(Boolean),
		knowledge: (attempt.knowledge || []).map((item) => item?.id).filter(Boolean) });
	// Retries after a failed save must not duplicate facts or overwrite manual state.
	if (attempt.finalizedAt != null) return effects();
	for (const value of plan.flags) {
		if (!challenge.flags.some((flag) => flag.value === value)) edit.addFlag({ value, verified: false,
			evidence: `第 ${plan.n} 次尝试输出自动提取（未验证，需人工复核）`, method: "manual", attempt: plan.n });
	}
	const verifiedFlag = challenge.flags.find((flag) => flag.verified)?.value || null;
	const classification = classifyAttempt({ stopReason: plan.stopReason, flags: challenge.flags, verifiedFlag });
	const solved = !!verifiedFlag || challenge.status === "solved" || classification.outcome === "solved";
	const tag = solved ? "[结论]" : plan.stopReason === "timeout" ? "[卡点]" : plan.stopReason === "aborted" ? "[中断]" : "[失败]";
	const summary = plan.fatal ? "编排器内部异常" : classification.summary;
	edit.addFact({ text: `${tag} 第 ${plan.n} 次尝试（角度 ${attempt.angle || "unknown"}）：${summary}`, source: `attempt#${plan.n}`, attempt: plan.n });
	const failedPaths = [...new Set([...(attempt.failedPaths || []), ...challenge.facts
		.filter((fact) => fact.attempt === plan.n && /^\[(失败|卡点)\]/.test(fact.text))
		.map((fact) => fact.text.replace(/^\[(失败|卡点)\]\s*/, ""))])].slice(-30);
	const tokens = Math.round(((Number(attempt.promptChars) || 0) + plan.outputChars) / 4);
	edit.endAttempt(plan.n, { endedAt: plan.endedAt, status: ({ timeout: "timeout", aborted: "aborted", error: "error", blocked: "error" })[plan.stopReason] || "completed",
		stopReason: plan.stopReason, summary, failedPaths, outputTail: plan.outputTail, outputChars: plan.outputChars,
		estTokens: tokens, estCost: Math.round(tokens / 1e6 * (Number(runtime.config.pricePerMToken) || 0) * 1e6) / 1e6,
		error: plan.error, sessionId: plan.sessionId || attempt.sessionId, ...(plan.elapsedMs != null ? { elapsedMs: plan.elapsedMs } : {}) });
	if (plan.budgetClock && challenge.budgetClock?.epochId === plan.budgetClock.epochId) edit.patch({ budgetClock: plan.budgetClock });
	edit.updateAttempt(plan.n, { finalizedAt: plan.endedAt });
	edit.addEvent("attempt-end", `第 ${plan.n} 次尝试结束：${summary}`, { attempt: plan.n });
	if (plan.fatal) edit.addEvent("error", `编排器内部异常：${plan.error}`, { attempt: plan.n });
	if (solved) {
		if (challenge.status !== "solved") edit.setStatus("solved", { endedAt: challenge.endedAt ?? plan.endedAt });
		else if (challenge.endedAt == null) edit.patch({ endedAt: plan.endedAt });
		edit.addEvent("note", `题目已解出${verifiedFlag ? `：${verifiedFlag}` : ""}`, { attempt: plan.n });
	} else if (runtime.retryRequested) {
		if (challenge.status !== "queued") edit.setStatus("queued", { endedAt: null });
	} else if (runtime.closed || runtime.userStopped || challenge.status === "stopped") {
		if (challenge.status !== "stopped") edit.setStatus("stopped", { endedAt: plan.endedAt });
	} else {
		const used = challenge.attempts.length, budget = attemptBudget(challenge, runtime.config);
		const remaining = Object.hasOwn(runtime, "remainingBudgetMs") ? runtime.remainingBudgetMs : remainingBudgetTime(challenge, runtime.config, plan.endedAt);
		if (!plan.fatal && runtime.config.autoRetry && plan.stopReason !== "aborted" && !runtime.budgetExhausted && (remaining == null || remaining > 0) && used < budget) {
			edit.setStatus("queued", { endedAt: null });
			edit.addEvent("note", `自动换角度重试（已用 ${used}/${budget} 次）`, { attempt: plan.n });
		} else edit.setStatus("stuck", { stuckReason: plan.error ? `${summary}（${plan.error.slice(-200)}）` : summary });
	}
	enqueueLearningUsage(edit, challenge, attempt, { solved, at: plan.endedAt });
	return effects();
}
