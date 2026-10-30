import { captureEvidence } from "./experiment-evidence.js";
import { learningHash } from "./learning-evidence.js";

export const feedbackKey = (kind, referenceId, revisionId) => learningHash([kind, kind === "knowledge" ? "content" : referenceId, revisionId]);
export function feedbackLookup(data, kind) {
	const index = new Map();
	for (const row of Object.values(data.entries || {})) if (row.kind === kind) {
		const key = feedbackKey(kind, row.referenceId, row.revisionId), value = index.get(key) || { helpful: 0, inapplicable: 0, contradicted: 0, observations: 0 };
		value[row.verdict]++; value.observations++; index.set(key, value);
	}
	return (referenceId, revisionId) => index.get(feedbackKey(kind, referenceId, revisionId)) || { helpful: 0, inapplicable: 0, contradicted: 0, observations: 0 };
}

export function validateFeedback(raw) {
	const validRow = (r) => r && r.schema === 1 && ["memory", "knowledge"].includes(r.kind) && ["helpful", "inapplicable", "contradicted"].includes(r.verdict)
		&& /^[a-f0-9]{64}$/.test(r.revisionId) && typeof r.referenceId === "string" && r.referenceId.length > 0 && r.referenceId.length <= 1000
		&& typeof r.runId === "string" && typeof r.challengeId === "string" && Number.isInteger(r.attempt) && r.attempt >= 1
		&& Number.isInteger(r.version) && r.version >= 1 && Number.isFinite(r.updatedAt)
		&& typeof r.reason === "string" && r.reason.length >= 12 && r.reason.length <= 1000
		&& Array.isArray(r.evidence) && r.evidence.length > 0 && r.evidence.length <= 4 && r.evidence.every((e) => e && typeof e.path === "string" && e.path.length <= 300
			&& /^[a-f0-9]{64}$/.test(e.sha256) && Number.isInteger(e.size) && e.size >= 0 && e.size <= 1024 * 1024);
	if (!raw || raw.version !== 1 || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)
		|| Object.keys(raw.entries).length > 2000 || Object.values(raw.entries).some((r) => !validRow(r) || !Array.isArray(r.history) || r.history.length > 4 || !r.history.every(validRow)))
		throw Object.assign(new Error("学习反馈格式不受支持，原文件已保留"), { code: "LEARNING_FEEDBACK_INVALID" });
	return raw;
}

export function createLearningFeedback({ store, learning, now = Date.now }) {
	function record(input) {
		try {
			const ch = store.read(input.id)?.challenge;
			if (!ch) throw new Error("题目不存在");
			const attempt = input.attempt == null ? ch.attempts.at(-1) : ch.attempts.find((a) => a.n === input.attempt);
			if (!attempt?.runId || !["memory", "knowledge"].includes(input.kind)) throw new Error("须指定实际尝试和 memory/knowledge 类型");
			const ref = (input.kind === "memory" ? attempt.memories : attempt.knowledge)?.find((r) => r.id === input.referenceId && r.revisionId === input.revisionId);
			if (!ref || !/^[a-f0-9]{64}$/.test(ref.revisionId)) throw new Error("该资料版本未登记在这次尝试的召回快照中，不能凭 id 补记效果");
			if (!["helpful", "inapplicable", "contradicted"].includes(input.verdict) || typeof input.reason !== "string" || input.reason.trim().length < 12 || input.reason.length > 1000) throw new Error("反馈须有明确结论与至少 12 字符的依据");
			const evidence = captureEvidence(ch.dir, input.evidencePaths || []);
			if (!evidence.some((r) => r.size > 0)) throw new Error("效果反馈须引用本次题目中已保存的实测证据");
			const key = learningHash([ch.id, attempt.runId, input.kind, ref.id, ref.revisionId]);
			const body = { schema: 1, kind: input.kind, referenceId: ref.id, revisionId: ref.revisionId,
				challengeId: ch.id, attempt: attempt.n, runId: attempt.runId, verdict: input.verdict, reason: input.reason.trim(), evidence };
			const saved = learning.updateFeedback((data) => {
				const old = data.entries[key];
				if (old && Object.keys(body).every((k) => JSON.stringify(old[k]) === JSON.stringify(body[k]))) return;
				if (old && input.expectedVersion !== old.version) throw Object.assign(new Error("反馈已更新，请刷新后修改"), { code: "LEARNING_FEEDBACK_CONFLICT" });
				if (!old && input.expectedVersion != null && input.expectedVersion !== 0) throw new Error("该反馈版本不存在");
				if (!old && Object.keys(data.entries).length >= 2000) throw new Error("学习反馈已达 2000 条，不会覆盖旧证据");
				const { history, ...prior } = old || {};
				data.entries[key] = { ...body, version: (old?.version || 0) + 1, updatedAt: now(), history: old ? [...history, prior].slice(-4) : [] };
			});
			return { ok: true, feedback: saved.value.entries[key], deduplicated: !saved.changed };
		} catch (e) { return { ok: false, code: e.code || "LEARNING_FEEDBACK_INVALID", error: String(e.message || e), applied: e.applied }; }
	}
	return { record };
}
