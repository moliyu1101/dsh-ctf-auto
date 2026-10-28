// Usage events belong to the attempt transaction; destination receipts make replay safe.
export function pendingLearningUsage(challenge) {
	return (challenge.attempts || []).filter((attempt) => attempt.usageEffect?.pending).sort((a, b) => a.n - b.n);
}

export function enqueueLearningUsage(edit, challenge, attempt, { solved, at }) {
	if (attempt.usageTrackingVersion !== 1 || attempt.usageEffect) return;
	const ids = (items) => [...new Set((items || []).map((item) => String(item?.id || "")).filter(Boolean))];
	const memories = ids(attempt.memories), knowledge = ids(attempt.knowledge);
	if (!memories.length && !knowledge.length) return;
	const streamId = challenge.learningUsageStreamId || attempt.runId;
	if (!streamId) throw new Error("使用统计缺少尝试标识");
	if (!challenge.learningUsageStreamId) edit.patch({ learningUsageStreamId: streamId });
	edit.updateAttempt(attempt.n, { usageEffect: { version: 1, streamId, sequence: attempt.n, at, solved: !!solved,
		memory: { file: attempt.memoryFile || null, ids: memories, pending: memories.length > 0 },
		knowledge: { ids: knowledge, pending: knowledge.length > 0 },
		pending: true, failures: 0, nextAttemptAt: 0, errors: [] } });
}

export function createLearningUsage({ store, learning }) {
	let closed = false;
	function process(id, { force = false } = {}) {
		if (closed) return { ok: false, pending: true, code: "LEARNING_USAGE_CLOSED" };
		if (store.persistenceStatus().dirty) return { ok: false, pending: true, code: "STATE_NOT_DURABLE", error: "状态尚未保存，使用统计暂缓" };
		const attempt = pendingLearningUsage(store.read(id)?.challenge || {})[0], job = attempt?.usageEffect;
		if (!job) return { ok: true, pending: false };
		if (!force && job.nextAttemptAt > Date.now()) return { ok: false, pending: true, code: "LEARNING_USAGE_BACKOFF" };
		const next = structuredClone(job), errors = [];
		for (const kind of ["memory", "knowledge"]) {
			if (!next[kind].pending) continue;
			try { learning.applyUsage(kind, job); next[kind].pending = false; }
			catch (error) { errors.push({ target: kind === "memory" ? job.memory.file : "knowledge-usage.json", code: String(error.code || "LEARNING_USAGE_FAILED"), message: String(error.message || error).slice(0, 600) }); }
		}
		next.pending = next.memory.pending || next.knowledge.pending;
		next.errors = errors;
		next.failures = (Number(job.failures) || 0) + (next.pending ? 1 : 0);
		next.nextAttemptAt = next.pending ? Date.now() + Math.min(300000, 5000 * 2 ** Math.min(next.failures, 6)) : 0;
		if (!next.pending) next.completedAt = Date.now();
		const saved = store.transact(id, (edit, challenge) => {
			const current = challenge.attempts.find((row) => row.n === attempt.n && row.runId === attempt.runId);
			if (!current?.usageEffect?.pending || current.usageEffect.streamId !== job.streamId || current.usageEffect.sequence !== job.sequence) return { ok: false, code: "STALE_USAGE_EFFECT", error: "使用统计待办已变化" };
			edit.updateAttempt(attempt.n, { usageEffect: next });
			if (next.pending && !job.failures) edit.addEvent("error", `第 ${attempt.n} 次尝试的使用统计待恢复`);
			if (!next.pending && job.failures) edit.addEvent("note", `第 ${attempt.n} 次尝试的使用统计已恢复`);
		}, { durable: true });
		const pending = !saved.ok || pendingLearningUsage(store.get(id) || {}).length > 0;
		return { ok: saved.ok && !pending, pending,
			...(errors.length ? { errors } : {}), ...(!saved.ok ? { code: saved.code, error: saved.error }
				: next.pending ? { code: "LEARNING_USAGE_PENDING", error: errors.map((error) => error.message).join("；") || "使用统计待恢复" } : {}) };
	}
	function retry(id, { limit = 5 } = {}) {
		let result;
		for (let count = 0; count < limit; count++) {
			result = process(id, { force: true });
			if (!result.pending || result.code) break;
		}
		return result;
	}
	function recover({ limit = 5 } = {}) {
		if (closed || store.persistenceStatus().dirty) return;
		let count = 0;
		for (const ch of store.list()) {
			const first = pendingLearningUsage(ch)[0];
			if (!first || first.usageEffect.nextAttemptAt > Date.now()) continue;
			process(ch.id);
			if (++count >= limit || store.persistenceStatus().dirty) break;
		}
	}
	return { process, retry, recover, close() { closed = true; } };
}
