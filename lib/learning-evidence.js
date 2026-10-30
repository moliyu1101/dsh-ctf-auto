import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { acceptedFlag } from "./flag-candidates.js";
import { experimentEpoch } from "./experiments.js";
import { openConflict, prerequisiteState } from "./experiment-graph.js";
import { checkEvidence } from "./experiment-evidence.js";
import { normalizeCard, extractTech } from "./memory.js";

export const learningHash = (value) => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export const MAX_LEARNING_FILE = 2 * 1024 * 1024;

// Bounded regular-file snapshots; never follow links or silently treat errors as empty text.
export function readLearningText(root, relative, { optional = false } = {}) {
	const base = path.resolve(root), file = path.resolve(base, relative), rel = path.relative(base, file);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("资料路径须位于指定目录内");
	let fd;
	try {
		let cursor = base;
		for (const part of ["", ...rel.split(path.sep)]) {
			if (part) cursor = path.join(cursor, part);
			if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("资料路径不能经过符号链接");
		}
		const before = fs.lstatSync(file);
		if (!before.isFile() || before.size > MAX_LEARNING_FILE) throw new Error("资料须为至多 2MiB 的普通文件");
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("资料读取时已被替换");
		const buffer = Buffer.alloc(MAX_LEARNING_FILE + 1); let size = 0, n;
		while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
		const after = fs.fstatSync(fd);
		if (size > MAX_LEARNING_FILE || size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("资料读取期间发生变化");
		const bytes = buffer.subarray(0, size);
		if (bytes.includes(0)) throw new Error("资料不是可索引文本");
		return { path: file, text: bytes.toString("utf8"), hash: learningHash(bytes), bytes: size, mtime: after.mtimeMs };
	} catch (e) {
		if (optional && e.code === "ENOENT") return { path: file, text: "", hash: "missing", bytes: 0, missing: true, mtime: 0 };
		throw e;
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function memorySourceIdentity(ch) {
	const epoch = experimentEpoch(ch);
	return learningHash([ch.id, ch.title, ch.category, epoch, (ch.facts || []).map((f) => [f.kind, f.text]), (ch.flags || []).filter((f) => acceptedFlag(ch, f)).map((f) => [learningHash(f.value), f.method, learningHash(f.evidence || ""), f.reviewed === true]),
		(ch.experiments || []).filter((r) => r.epoch === epoch && (["supported", "refuted"].includes(r.status) || openConflict(r))).map((r) => [r.key, r.version, r.status, r.evidence, r.conflicts || []])]);
}

export function hasLearningDispute(ch) {
	const epoch = experimentEpoch(ch);
	return (ch.experiments || []).some((r) => r.epoch === epoch && openConflict(r));
}

export function enrichMemoryCard(card, ch, sources) {
	const epoch = experimentEpoch(ch), rows = (ch.experiments || []).filter((r) => r.epoch === epoch && !r.reviewOf && ["supported", "refuted"].includes(r.status));
	const selected = rows.filter((r) => !openConflict(r) && prerequisiteState(ch, r, { verifyEvidence: true }).ready
		&& r.evidence.some((ref) => ref.size > 0) && checkEvidence(ch.dir, r.evidence).every((ref) => ref.integrity === "match"));
	const outline = (r) => ({ key: r.key, version: r.version, epoch, status: r.status, hypothesis: r.hypothesis, scope: r.scope, expectedResult: r.expectedResult,
		observedResult: r.observedResult, command: r.command, evidence: r.evidence, dependsOn: r.dependsOn || [], prerequisiteProof: r.prerequisiteProof || [] });
	const routes = selected.filter((r) => r.status === "supported").slice(0, 12).map(outline);
	const negatives = selected.filter((r) => r.status === "refuted").slice(0, 8).map(outline);
	if (rows.some((r) => r.status === "supported") && !routes.length) throw new Error("成功路径的实验文件或前置证据未能核验，不能退回为仅靠笔记的记忆；请先修复来源");
	const redact = (value) => {
		if (typeof value === "string") { for (const flag of ch.flags || []) if (flag.value) value = value.split(flag.value).join("<historical-flag>"); return value; }
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
		return value;
	};
	const next = redact(card);
	for (const r of [...routes, ...negatives]) for (const key of ["hypothesis", "scope", "expectedResult", "observedResult", "command"]) r[key] = redact(r[key]);
	if (routes.length) {
		next.stepDetails = routes.map((r) => ({ title: r.hypothesis, command: r.command })); next.steps = routes.map((r) => r.hypothesis);
		next.commands = routes.map((r) => r.command).filter(Boolean); next.payloads = []; next.pitfalls = [];
		next.fingerprint = routes.map((r) => r.hypothesis).join("；").slice(0, 200);
		next.summary = routes.map((r) => r.observedResult).join("；").slice(0, 300);
		next.prerequisites = routes.map((r) => r.scope).slice(0, 4);
		next.tooling = [...new Set(routes.map((r) => r.command.trim().split(/\s+/)[0]).filter(Boolean))].slice(0, 8);
		next.tech = extractTech(routes.map((r) => [r.hypothesis, r.scope, r.observedResult, r.command].join(" ")).join("\n"));
		next.tags = [next.category, ...next.tech].filter(Boolean);
	} else if (negatives.length) {
		const rejected = new Set(negatives.map((r) => r.command).filter(Boolean));
		next.commands = next.commands.filter((c) => !rejected.has(c)); next.stepDetails = next.stepDetails.filter((s) => !s.command || !rejected.has(s.command));
		next.steps = next.stepDetails.map((s) => s.title);
	}
	const canonical = normalizeCard(next);
	const proof = { schema: 1, sourceIdentity: memorySourceIdentity(ch), epoch,
		sources: sources.map(({ kind, path: file, root, relative, hash }) => ({ kind, path: file, root, relative, hash })),
		routes, negatives, excludedExperiments: rows.length - selected.length, basis: routes.length ? "experiment-evidence" : "verified-result-with-reference-notes" };
	// The revision includes the recipe content, not just its original challenge id.
	proof.revisionId = recipeRevision(canonical, proof);
	return { ...canonical, learning: proof, revisionId: proof.revisionId };
}

function recipeRevision(card, proof) {
	return learningHash([proof.sourceIdentity, proof.sources, card.title, card.category, card.entry, card.fingerprint, card.summary, card.prerequisites,
		card.tooling, card.stepDetails, card.commands, card.payloads, card.pitfalls, card.tech, card.tags, card.verification, proof.routes, proof.negatives]);
}

export function memoryFreshness(card, source, { writeupsDir } = {}) {
	if (!card.learning) return { eligible: false, reason: "旧卡缺少来源快照，请从仍可核验的题目重新沉淀" };
	if (!source) return { eligible: false, reason: "来源题目不在当前台账中，不能自动核验" };
	if (hasLearningDispute(source)) return { eligible: false, reason: "来源题目存在未决实验争议" };
	if (card.learning.sourceIdentity !== memorySourceIdentity(source)) return { eligible: false, reason: "来源结论、材料或证据版本已变化" };
	try {
		for (const snapshot of card.learning.sources) {
			const root = snapshot.kind === "notes" ? source.dir : snapshot.kind === "writeup" ? writeupsDir : null;
			const relative = snapshot.kind === "notes" ? "notes.md" : `${source.slug || source.id}-writeup.md`;
			if (!root || path.resolve(snapshot.root) !== path.resolve(root) || snapshot.relative !== relative || path.resolve(snapshot.path) !== path.resolve(root, relative)) return { eligible: false, reason: "来源路径不匹配当前配置，拒绝按卡片中的任意路径读取" };
			if (readLearningText(root, relative, { optional: true }).hash !== snapshot.hash) return { eligible: false, reason: "来源笔记或 Writeup 已变化，须重新沉淀" };
		}
		for (const row of [...card.learning.routes, ...card.learning.negatives]) if (!prerequisiteState(source, row, { verifyEvidence: true }).ready
			|| checkEvidence(source.dir, row.evidence).some((ref) => ref.integrity !== "match")) return { eligible: false, reason: "实验引用的证据文件或前置版本已变化" };
		return { eligible: true, reason: "来源与文件摘要一致；本题仍须重新验证" };
	} catch { return { eligible: false, reason: "来源文件不可核验" }; }
}

export function validateMemoryEvidence(card) {
	const p = card.learning;
	if (p === undefined) return;
	if (!p || p.schema !== 1 || !/^[a-f0-9]{64}$/.test(p.sourceIdentity) || !/^[a-f0-9]{64}$/.test(p.revisionId)
		|| !/^[a-f0-9]{64}$/.test(p.epoch) || !Array.isArray(p.sources) || p.sources.length !== 2 || new Set(p.sources.map((s) => s?.kind)).size !== 2
		|| p.sources.some((s) => !["notes", "writeup"].includes(s?.kind))
		|| p.sources.some((s) => !s || typeof s.root !== "string" || typeof s.relative !== "string" || typeof s.path !== "string" || !/^(missing|[a-f0-9]{64})$/.test(s.hash))
		|| !Array.isArray(p.routes) || p.routes.length > 12 || !Array.isArray(p.negatives) || p.negatives.length > 8)
		throw Object.assign(new Error("记忆证据格式不受支持，原文件已保留"), { code: "MEMORY_EVIDENCE_INVALID" });
	if ([...p.routes, ...p.negatives].some((r) => !r || typeof r.key !== "string" || !["supported", "refuted"].includes(r.status)
		|| !Array.isArray(r.evidence) || r.evidence.length > 4 || r.evidence.some((e) => !e || typeof e.path !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isInteger(e.size))))
		throw Object.assign(new Error("记忆实验引用无效，原文件已保留"), { code: "MEMORY_EVIDENCE_INVALID" });
	if (recipeRevision(normalizeCard(card), p) !== p.revisionId) throw Object.assign(new Error("记忆内容与版本摘要不一致，原文件已保留"), { code: "MEMORY_EVIDENCE_INVALID" });
}
