import crypto from "node:crypto";
import { checkEvidence } from "./experiment-evidence.js";

export const MAX_PREREQUISITES = 16;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (message) => { throw Object.assign(new Error(message), { code: "EXPERIMENT_GRAPH_INVALID" }); };
export const openConflict = (row) => (row.conflicts || []).some((c) => c.phase === "open");
export const conclusionFingerprint = (row) => hash([row.key, row.epoch, row.hypothesis, row.scope, row.expectedResult, row.status, row.observedResult, row.evidence, row.dependsOn || []]);

export function normalizeDependencies(value = []) {
	if (!Array.isArray(value) || value.length > 4) invalid("每项实验最多四个前置条件");
	const rows = value.map((r) => {
		if (!r || typeof r.key !== "string" || !r.key.trim() || r.key.length > 120 || !["supported", "refuted"].includes(r.status)
			|| r.version != null && (!Number.isInteger(r.version) || r.version < 1)) invalid("前置条件须指定 key、supported/refuted，可选固定版本 version");
		return { key: r.key.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(), status: r.status, ...(r.version != null ? { version: r.version } : {}) };
	});
	if (new Set(rows.map((r) => r.key)).size !== rows.length) invalid("不能重复声明相同前置条件");
	return rows;
}

export function validateExperimentGraph(rows) {
	const validRef = (ref) => ref && typeof ref.path === "string" && ref.path.length <= 300 && /^[a-f0-9]{64}$/.test(ref.sha256)
		&& Number.isInteger(ref.size) && ref.size >= 0 && ref.size <= 1024 * 1024;
	for (const row of rows) {
		normalizeDependencies(row.dependsOn);
		if (row.prerequisiteProof !== undefined && (!Array.isArray(row.prerequisiteProof) || row.prerequisiteProof.length > MAX_PREREQUISITES
			|| row.prerequisiteProof.some((r) => !r || typeof r.key !== "string" || !/^[a-f0-9]{64}$/.test(r.epoch)
				|| !Number.isInteger(r.version) || r.version < 1 || !["supported", "refuted"].includes(r.status)
				|| !Array.isArray(r.evidence) || r.evidence.length > 4 || !r.evidence.every(validRef)))) invalid("实验前置证据快照格式不受支持");
		if (row.conflicts !== undefined && (!Array.isArray(row.conflicts) || row.conflicts.length > 4 || row.conflicts.some((c) => !c
			|| !/^[a-f0-9-]{36}$/.test(c.id) || typeof c.reviewKey !== "string" || !["open", "resolved"].includes(c.phase)
			|| !Number.isFinite(c.createdAt)))) invalid("争议记录格式不受支持");
		if (row.reviewOf && (typeof row.reviewOf.key !== "string" || !/^[a-f0-9-]{36}$/.test(row.reviewOf.conflictId)
			|| !/^[a-f0-9]{64}$/.test(row.reviewOf.sourceFingerprint) || !["supported", "refuted"].includes(row.reviewOf.sourceStatus)
			|| typeof row.reviewOf.reason !== "string" || row.reviewOf.reason.length > 2000
			|| [row.reviewOf.sourceEvidence, row.reviewOf.counterEvidence].some((refs) => !Array.isArray(refs) || !refs.length || refs.length > 4 || !refs.every(validRef)))) invalid("复验任务格式不受支持");
		const byKey = new Map(rows.filter((r) => r.epoch === row.epoch).map((r) => [r.key, r]));
		const visiting = new Set(), visited = new Set();
		function visit(r) {
			if (visiting.has(r.key)) invalid("实验依赖不能形成环");
			if (visited.has(r.key)) return;
			visiting.add(r.key);
			for (const dep of r.dependsOn || []) {
				const parent = byKey.get(dep.key);
				if (!parent) invalid("前置实验不存在于同一材料/靶机范围：" + dep.key);
				visit(parent);
			}
			visiting.delete(r.key); visited.add(r.key);
			if (visited.size > MAX_PREREQUISITES + 1) invalid("单个实验的前置链不能超过 16 项");
		}
		visit(row);
		if (row.reviewOf) {
			const source = byKey.get(row.reviewOf.key);
			if (!source?.conflicts?.some((c) => c.id === row.reviewOf.conflictId && c.reviewKey === row.key)) invalid("复验任务缺少对应争议记录");
		}
		for (const conflict of row.conflicts || []) {
			const review = byKey.get(conflict.reviewKey);
			if (review?.reviewOf?.key !== row.key || review.reviewOf.conflictId !== conflict.id) invalid("争议记录缺少对应复验任务");
		}
	}
}

// UI reads only metadata. Dispatch and result writes explicitly verify file bytes.
export function prerequisiteState(challenge, row, { verifyEvidence = false } = {}) {
	const byKey = new Map((challenge.experiments || []).filter((r) => r.epoch === row.epoch).map((r) => [r.key, r]));
	const blockers = [], snapshots = [], seen = new Set();
	const proofCurrent = (r) => (r.prerequisiteProof || []).every((saved) => {
		const parent = byKey.get(saved.key);
		return parent && parent.epoch === saved.epoch && parent.version === saved.version && parent.status === saved.status && !openConflict(parent)
			&& JSON.stringify(parent.evidence) === JSON.stringify(saved.evidence);
	});
	if (!proofCurrent(row)) blockers.push({ key: row.key, reason: "结论引用的前置版本已变化，须补新证据复验" });
	if (openConflict(row)) blockers.push({ key: row.key, reason: "争议待复核" });
	if (row.reviewOf) {
		const source = byKey.get(row.reviewOf.key);
		if (!source || conclusionFingerprint(source) !== row.reviewOf.sourceFingerprint || !source.conflicts?.some((c) => c.id === row.reviewOf.conflictId && c.phase === "open"))
			blockers.push({ key: row.reviewOf.key, reason: "复验源结论已变化或争议已收口" });
		if (verifyEvidence && [row.reviewOf.sourceEvidence, row.reviewOf.counterEvidence].some((refs) => checkEvidence(challenge.dir, refs).some((ref) => ref.integrity !== "match")))
			blockers.push({ key: row.reviewOf.key, reason: "复验引用的原证据或争议证据已变化" });
	}
	function visit(r) {
		for (const dep of r.dependsOn || []) {
			const parent = byKey.get(dep.key);
			if (!parent) { blockers.push({ key: dep.key, reason: "前置实验不存在" }); continue; }
			if (parent.status !== dep.status || dep.version != null && parent.version !== dep.version || openConflict(parent))
				blockers.push({ key: dep.key, reason: openConflict(parent) ? "前置结论存在争议" : `需要 ${dep.status}${dep.version ? " v" + dep.version : ""}，当前 ${parent.status} v${parent.version}` });
			if (!proofCurrent(parent)) blockers.push({ key: parent.key, reason: "前置结论基于旧版本证据，须先复验" });
			if (seen.has(parent.key)) continue;
			seen.add(parent.key);
			if (seen.size > MAX_PREREQUISITES) { blockers.push({ key: dep.key, reason: "前置链超过上限" }); return; }
			if (!parent.evidence?.some((ref) => ref.size > 0) || verifyEvidence && checkEvidence(challenge.dir, parent.evidence).some((ref) => ref.integrity !== "match"))
				blockers.push({ key: dep.key, reason: "前置证据缺失或字节已变化" });
			snapshots.push({ key: parent.key, version: parent.version, status: parent.status, evidence: parent.evidence }); visit(parent);
		}
	}
	visit(row);
	return { ready: blockers.length === 0, blockers, snapshots, evidenceChecked: verifyEvidence };
}

export function prerequisitesCurrent(challenge, snapshots = []) {
	for (const saved of snapshots) {
		const row = challenge.experiments.find((r) => r.epoch === saved.epoch && r.key === saved.key);
		if (!row || row.version !== saved.version || row.status !== saved.status || openConflict(row)
			|| JSON.stringify(row.evidence) !== JSON.stringify(saved.evidence)
			|| checkEvidence(challenge.dir, saved.evidence).some((ref) => ref.integrity !== "match")) return false;
	}
	return true;
}
