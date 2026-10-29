import crypto from "node:crypto";
import { sameChallengeScope } from "./state-snapshot.js";

export const SUBMISSION_HISTORY_LIMIT = 100;
const UNRESOLVED = new Set(["prepared", "sending", "unknown"]);

export function submissionRecords(challenge) {
	return Array.isArray(challenge.submissionJournal) ? challenge.submissionJournal.filter((entry) => entry && typeof entry === "object") : [];
}

export function unresolvedSubmissions(challenge) {
	const records = submissionRecords(challenge);
	if (records.length) return records.filter((entry) => UNRESOLVED.has(entry.phase));
	const legacy = challenge.platformSubmit;
	return legacy && (legacy.status === "pending" || legacy.outcomeUnknown === true || (legacy.outcomeUnknown !== false && ["network", "timeout", "PLATFORM_REQUEST_FAILED"].includes(legacy.code)))
		? [{ ...legacy, phase: "unknown", legacy: true }] : [];
}

export function submissionResult(entry) { return entry.resolution || entry.result; }

function projection(entry) {
	const result = submissionResult(entry) || {};
	return {
		submissionId: entry.submissionId, taskId: entry.taskId, flag: entry.flag, phase: entry.phase,
		status: ["prepared", "sending"].includes(entry.phase) ? "pending" : result.status || "error",
		message: String(result.message || result.error || ""), verified: result.verified === true,
		code: result.code || null, outcomeUnknown: entry.phase === "unknown", at: entry.updatedAt
	};
}

// Both the journal and its backwards-compatible latest-result projection are
// written in one store update. Unresolved results are never evicted by the cap.
export function createSubmissionJournal(store) {
	function write(challenge, entry, { latest = false, event } = {}) {
		if (!store.owns(challenge) || !sameChallengeScope(challenge, store.get(challenge.id))) throw Object.assign(new Error("提交流水所属题目或来源已变化"), { code: "STATE_CONFLICT" });
		const snapshot = store.read(challenge.id);
		const records = [...submissionRecords(snapshot.challenge)];
		const next = { ...entry, updatedAt: Date.now() };
		const existing = records.findIndex((item) => item.submissionId === entry.submissionId);
		if (existing < 0) records.push(next); else records[existing] = next;
		while (records.length > SUBMISSION_HISTORY_LIMIT) {
			const index = records.findIndex((item) => !UNRESOLVED.has(item.phase) && item.applied !== false && item.submissionId !== next.submissionId);
			if (index < 0) break;
			records.splice(index, 1);
		}
		const patch = { submissionJournal: records };
		if (latest || !snapshot.challenge.platformSubmit || snapshot.challenge.platformSubmit.submissionId === entry.submissionId) patch.platformSubmit = projection(next);
		const transaction = store.transact(challenge.id, (edit) => {
			edit.patch(patch);
			if (event) edit.addEvent(event.kind, event.text, event.data);
		}, { expectedRevision: snapshot.revision, durable: true });
		if (!transaction.ok && !transaction.applied) throw Object.assign(new Error(transaction.error), { code: transaction.code });
		return next;
	}
	function migrateLegacy(challenge) {
		if (submissionRecords(challenge).length || !unresolvedSubmissions(challenge).length) return;
		const legacy = challenge.platformSubmit;
		write(challenge, {
			submissionId: legacy.submissionId || crypto.randomUUID(), taskId: legacy.taskId, flag: String(legacy.flag || ""),
			phase: "unknown", legacy: true, credentialKey: null, createdAt: legacy.at || Date.now(),
			result: { ok: false, code: "SUBMISSION_INTERRUPTED", error: "旧版本未决提交，无法确认是否已发送", outcomeUnknown: true }, applied: true
		}, { latest: true });
	}
	return { write, migrateLegacy };
}
