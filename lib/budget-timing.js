import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

export function validateBudgetClock(clock) {
	if (clock == null) return;
	if (!clock || clock.version !== 1 || typeof clock.epochId !== "string" || !clock.epochId
		|| !Number.isFinite(clock.elapsedMs) || clock.elapsedMs < 0 || !Number.isFinite(clock.checkpointAt) || clock.checkpointAt < 0) {
		throw Object.assign(new Error("预算计时检查点格式不受支持，原状态已保留"), { code: "BUDGET_CHECKPOINT_INVALID" });
	}
}

// Wall time is consulted once per restored epoch, never to measure live work.
// Captures are prepared outside transactions; accept only an installed epoch.
export function createBudgetTiming({ now = Date.now, monotonicNow = () => performance.now() } = {}) {
	if (typeof now !== "function" || typeof monotonicNow !== "function") throw new TypeError("预算计时需要有效时钟");
	const anchors = new Map();
	let last = -Infinity, clockError = null;
	function sample() {
		try {
			const value = monotonicNow();
			if (!Number.isFinite(value) || value < 0 || value < last) throw new Error("单调时钟无效或回退，解题预算计时已暂停");
			last = value;
		} catch (error) { clockError ??= { code: "BUDGET_CLOCK_INVALID", message: String(error?.message || error) }; }
		return Number.isFinite(last) ? last : 0;
	}
	function capture(challenge, limit, { restart = false } = {}) {
		const mono = sample(), wall = now();
		validateBudgetClock(challenge.budgetClock);
		const hasStarted = Number.isFinite(challenge.startedAt) && challenge.startedAt >= 0;
		let anchor = restart ? null : anchors.get(challenge.id);
		if (anchor && (anchor.startedAt !== challenge.startedAt || (challenge.budgetClock ? anchor.epochId !== challenge.budgetClock.epochId : !anchor.legacy))) anchor = null;
		if (!anchor) {
			const saved = restart ? null : challenge.budgetClock;
			const elapsed = restart || !hasStarted ? 0 : saved
				? saved.elapsedMs + Math.max(0, wall - saved.checkpointAt)
				: Math.max(0, wall - challenge.startedAt);
			anchor = { startedAt: restart ? wall : challenge.startedAt, epochId: saved?.epochId || crypto.randomUUID(), legacy: !saved, mono, elapsed };
			if (!restart && hasStarted) anchors.set(challenge.id, anchor);
		}
		const elapsedMs = anchor.elapsed + Math.max(0, mono - anchor.mono);
		return { mono, wall, anchor, elapsedMs,
			remainingMs: clockError ? 0 : restart || hasStarted ? limit - elapsedMs : null,
			checkpoint: { version: 1, epochId: anchor.epochId, elapsedMs, checkpointAt: wall } };
	}
	function accept(challenge, capture) {
		if (challenge?.budgetClock?.epochId !== capture.anchor.epochId) return;
		anchors.set(challenge.id, { ...capture.anchor, startedAt: challenge.startedAt, legacy: false });
	}
	return { sample, capture, accept, status: () => ({ clock: "monotonic", clockError: clockError ? { ...clockError } : null }),
		prune(ids) { const keep = new Set(ids); for (const id of anchors.keys()) if (!keep.has(id)) anchors.delete(id); },
		close() { anchors.clear(); } };
}
