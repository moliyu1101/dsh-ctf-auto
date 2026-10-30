import crypto from "node:crypto";
import { captureEvidence, checkEvidence } from "./experiment-evidence.js";
import { experimentEpoch, experimentRecords, reviseExperiment, EXPERIMENT_LIMIT } from "./experiments.js";
import { conclusionFingerprint, openConflict, prerequisiteState, validateExperimentGraph } from "./experiment-graph.js";

const fail = (code, error) => ({ ok: false, code, error });
const intact = (ch, refs) => refs.some((r) => r.size > 0) && checkEvidence(ch.dir, refs).every((r) => r.integrity === "match");

// Review results are proposals. Only the coordinator can atomically adopt them.
export function createExperimentReviews({ store, now = Date.now }) {
	function perform(input, operation) {
		try {
			const snapshot = store.read(input.id), ch = snapshot?.challenge;
			if (!ch) return fail("CHALLENGE_NOT_FOUND", "题目不存在");
			if (ch.preparation && ch.preparation.phase !== "ready") return fail("CHALLENGE_NOT_READY", "输入尚未准备完成");
			if (input.epoch !== experimentEpoch(ch)) return fail("EXPERIMENT_EPOCH_CHANGED", "须指定当前材料/靶机范围");
			return operation(ch, snapshot);
		} catch (e) { return fail(e.code || "EXPERIMENT_REVIEW_INVALID", String(e.message || e)); }
	}
	function save(ch, snapshot, rows, value, message) {
		validateExperimentGraph(rows);
		const result = store.transact(ch.id, (edit) => {
			edit.patch({ experiments: rows }); edit.addEvent("experiment", message, { key: value.experiment.key, reviewKey: value.review.key });
		}, { expectedRevision: snapshot.revision, durable: true });
		return result.ok ? { ok: true, epoch: value.experiment.epoch, ...value } : { ok: false, code: result.code, error: result.error, applied: result.applied };
	}
	function open(input) {
		return perform(input, (ch, snapshot) => {
			const rows = experimentRecords(ch), source = rows.find((r) => r.key === input.key && r.epoch === input.epoch);
			if (!source || source.reviewOf || !["supported", "refuted"].includes(source.status)) return fail("EXPERIMENT_REVIEW_SOURCE_REQUIRED", "仅可对已有证据的普通支持/证伪结论发起独立复验");
			const reason = typeof input.reason === "string" ? input.reason.trim() : "";
			if (reason.length < 12 || reason.length > 2000) return fail("EXPERIMENT_REVIEW_REASON_REQUIRED", "须说明具体争议及可复验差异（12–2000 字符）");
			const counter = captureEvidence(ch.dir, input.evidencePaths);
			const seenEvidence = new Set(source.evidenceDigests || source.evidence.map((r) => r.sha256));
			if (!intact(ch, source.evidence) || !counter.some((r) => r.size > 0 && !seenEvidence.has(r.sha256))) return fail("EXPERIMENT_REVIEW_EVIDENCE_REQUIRED", "原证据须完整，争议须有不同字节的新证据文件；改名旧文件不足以发起复验");
			const conflict = source.conflicts?.find((c) => c.phase === "open");
			if (conflict) {
				const review = rows.find((r) => r.key === conflict.reviewKey && r.epoch === input.epoch);
				if (review.reviewOf.reason === reason && JSON.stringify(review.reviewOf.counterEvidence) === JSON.stringify(counter)) return { ok: true, deduplicated: true, experiment: source, review, epoch: input.epoch };
				return fail("EXPERIMENT_REVIEW_ALREADY_OPEN", "当前结论已有未决复验，请先收口该争议");
			}
			if (source.version !== input.expectedVersion) return fail("EXPERIMENT_VERSION_CONFLICT", "原结论版本已变化，请刷新");
			if (rows.length >= EXPERIMENT_LIMIT || (source.conflicts || []).length >= 4) return fail("EXPERIMENT_REVIEW_CAPACITY", "实验黑板或该结论的四次复验额度已满，不能覆盖旧记录");
			const id = crypto.randomUUID(), key = `review:${source.key.slice(0, 70)}:${id}`, at = now(), attempt = ch.attempts.at(-1);
			const next = reviseExperiment(source, source, { at, attempt, metadata: { conflicts: [...(source.conflicts || []), { id, reviewKey: key, phase: "open", createdAt: at }] } });
			const review = reviseExperiment(null, { key, epoch: input.epoch, hypothesis: source.hypothesis, scope: source.scope, expectedResult: source.expectedResult,
				status: "proposed", command: "", observedResult: "", nextStep: "独立运行最小实验；分别核对原证据与争议证据，保存自己的复现输出", evidence: [], dependsOn: source.dependsOn || [] },
			{ at, attempt, metadata: { reviewOf: { key: source.key, conflictId: id, sourceFingerprint: conclusionFingerprint(source), sourceStatus: source.status,
				reason, sourceEvidence: source.evidence, counterEvidence: counter } } });
			return save(ch, snapshot, [...rows.map((r) => r === source ? next : r), review], { experiment: next, review }, `结论待复验：${source.key}；后续依赖已暂停`);
		});
	}
	function resolve(input) {
		return perform(input, (ch, snapshot) => {
			const rows = experimentRecords(ch), source = rows.find((r) => r.key === input.key && r.epoch === input.epoch);
			const conflict = source?.conflicts?.find((c) => c.reviewKey === input.reviewKey), review = rows.find((r) => r.key === input.reviewKey && r.epoch === input.epoch);
			if (!conflict || !review?.reviewOf) return fail("EXPERIMENT_REVIEW_NOT_FOUND", "未找到该结论的独立复验");
			if (conflict.phase === "resolved" && conflict.reviewVersion === input.expectedReviewVersion) return { ok: true, deduplicated: true, experiment: source, review, epoch: input.epoch };
			if (source.version !== input.expectedVersion || review.version !== input.expectedReviewVersion) return fail("EXPERIMENT_VERSION_CONFLICT", "原结论或复验版本已变化，请重新读取");
			if (conclusionFingerprint(source) !== review.reviewOf.sourceFingerprint) return fail("EXPERIMENT_REVIEW_STALE", "原结论已变化，此复验不可直接采纳");
			if (!["supported", "refuted"].includes(review.status)) return fail("EXPERIMENT_REVIEW_NOT_CONCLUSIVE", "复验尚无支持/证伪结论；blocked 或执行端 completed 不能消除争议");
			const reason = typeof input.reason === "string" ? input.reason.trim() : "";
			if (reason.length < 12 || reason.length > 1000) return fail("EXPERIMENT_REVIEW_REASON_REQUIRED", "采纳须说明证据比较和判断依据（12–1000 字符）");
			const known = new Set([...(source.evidenceDigests || source.evidence.map((r) => r.sha256)), ...review.reviewOf.counterEvidence.map((r) => r.sha256)]);
			if (!intact(ch, review.evidence) || !intact(ch, review.reviewOf.sourceEvidence) || !intact(ch, review.reviewOf.counterEvidence)
				|| !review.evidence.some((r) => r.size > 0 && !known.has(r.sha256))) return fail("EXPERIMENT_REVIEW_EVIDENCE_REQUIRED", "复验须保存不同于两方旧证据的新输出，且三方引用文件仍须字节匹配");
			if (!prerequisiteState(ch, review, { verifyEvidence: true }).ready
				|| !prerequisiteState(ch, { ...source, conflicts: [], prerequisiteProof: review.prerequisiteProof || [] }, { verifyEvidence: true }).ready)
				return fail("EXPERIMENT_PREREQUISITES_NOT_READY", "复验引用的前置证据未就绪或已变化，不可采纳");
			const at = now(), decision = source.status === review.status ? "upheld" : "overturned";
			const next = reviseExperiment(source, { ...source, status: review.status, observedResult: review.observedResult, command: review.command, evidence: review.evidence, prerequisiteProof: review.prerequisiteProof || [] },
				{ at, attempt: ch.attempts.at(-1), reopenReason: reason, metadata: { conflicts: source.conflicts.map((c) => c.id === conflict.id ? { ...c, phase: "resolved", decision, resolvedAt: at, reviewVersion: review.version, reason } : c) } });
			return save(ch, snapshot, rows.map((r) => r === source ? next : r), { experiment: next, review }, `独立复验已采纳：${source.key}（${decision}）；flag 仍须单独核验`);
		});
	}
	return { open, resolve };
}
