import crypto from "node:crypto";
import { submissionDiagnostic } from "./platform-result.js";
import { acceptedFlag, flagCandidates } from "./flag-candidates.js";
import { platformChallengeKey } from "./platform-identity.js";
import { createSubmissionJournal, submissionRecords, submissionResult, unresolvedSubmissions, SUBMISSION_HISTORY_LIMIT } from "./submission-journal.js";
import { taskRecords } from "./task-registry.js";
import { sameChallengeScope } from "./state-snapshot.js";

// Adapters translate protocols; this service owns durable submission decisions.
export function createPlatformSubmissions({ store, platforms, resources, recordFlag, needsReview, autoSubmitEnabled, canAutoSubmit = () => true, enqueueProjection = () => {}, onRejected = () => {} }) {
	const active = new Map(), queued = new Map(), solved = new Map(), pending = new Map();
	const journal = createSubmissionJournal(store);
	let closed = false;
	const isActive = (id) => active.has(id) || pending.has(id);
	const current = (ch) => !closed && store.owns(ch) && sameChallengeScope(ch, store.get(ch.id));
	const sameConnection = (ch, connection) => platforms.forChallenge(ch).sessionKey === connection.sessionKey;
	const failure = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
	const notDurable = () => failure("STATE_NOT_DURABLE", "提交记录尚未保存；请恢复状态保存后再操作");
	const resourceKey = (ch, connection) => `submission:${connection.credentialKey}:${platformChallengeKey(ch.platform)}`;
	function remembered(key) {
		const at = solved.get(key);
		if (at && Date.now() - at < 5 * 60 * 1000) return true;
		solved.delete(key);
		return false;
	}
	function remember(key) {
		solved.set(key, Date.now());
		while (solved.size > 1000) solved.delete(solved.keys().next().value);
	}
	function unresolvedFor(ch, connection) {
		return store.list().filter((item) => item.platform && platformChallengeKey(item.platform) === platformChallengeKey(ch.platform))
			.flatMap((item) => unresolvedSubmissions(item).filter((entry) => !entry.credentialKey || entry.credentialKey === connection.credentialKey));
	}
	function applyResult(ch, entry) {
		if (!current(ch)) return;
		ch = store.get(ch.id);
		entry = submissionRecords(ch).find((row) => row.submissionId === entry.submissionId);
		if (!entry || entry.phase !== "completed") return;
		const result = submissionResult(entry);
		if (!current(ch) || entry.applied !== false || !result || Number(entry.nextApplyAt) > Date.now()) return;
		try {
			if (result.verified === true && result.status === "correct") {
				const recorded = recordFlag({ id: ch.id, flag: entry.flag, verified: true, evidence: `平台提交回显：correct ${result.message || ""}`.trim(), method: "platform" }, { allowPlatformVerification: true, suppressAutoSubmit: true });
				if (!recorded?.ok) throw new Error(recorded?.error || "平台回显登记失败");
			} else if (result.status === "already_solved") {
				// A solved challenge does not prove this candidate was correct.
				if (entry.flag) {
					const recorded = recordFlag({ id: ch.id, flag: entry.flag, verified: false, evidence: "平台回显 already_solved（题目已解；本 flag 未经回显确认）", method: "platform" }, { suppressAutoSubmit: true });
					if (!recorded?.ok) throw new Error(recorded?.error || "平台解题状态登记失败");
				}
				store.setStatus(ch.id, "solved", { stuckReason: "", endedAt: Date.now(), note: "平台已解（flag 未经回显确认）" });
			}
			if (["incorrect", "wrong", "rejected"].includes(result.status)) {
				const revoked = store.transact(ch.id, (edit, draft) => {
					for (const flag of draft.flags || []) if (flag.value === entry.flag) {
						flag.verified = false; flag.localVerified = false; flag.reviewed = false;
						flag.rejected = true; flag.rejectedAt = Date.now(); flag.rejectionReason = result.message || result.status;
					}
					if (draft.status === "solved" && !(draft.flags || []).some((flag) => acceptedFlag(draft, flag))) {
						edit.setStatus(draft.attempts.some((attempt) => attempt.status === "running" && !attempt.finalizedAt) ? "running" : "stuck",
							{ stuckReason: "平台已拒绝候选 flag，请继续分析或手动重试", note: "平台拒绝候选，已撤销本地已解状态" });
					}
					edit.addEvent("flag-rejected", `平台已拒绝候选 ${entry.flag}：${result.message || result.status}`);
					enqueueProjection(edit, draft);
				}, { durable: true });
				if (!revoked.ok) throw new Error(revoked.error);
				onRejected(ch.id);
			}
			if (!store.persistenceStatus().dirty) journal.write(ch, { ...entry, applied: true, applyError: null, nextApplyAt: null });
		} catch (error) {
			// Local file/projection failures must preserve the known remote response.
			const attempts = (Number(entry.applyAttempts) || 0) + 1;
			journal.write(ch, { ...entry, applyAttempts: attempts, nextApplyAt: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)), applyError: String(error?.message || error).slice(0, 400) });
		}
	}
	function recover() {
		if (closed || store.persistenceStatus().dirty) return;
		for (let ch of store.list()) {
			// Also recover abandoned in-process phases after a failed save. A live
			// or queued operation owns its stages until its pending counter clears.
			if (!isActive(ch.id)) {
				journal.migrateLegacy(ch);
				ch = store.get(ch.id);
				for (const entry of submissionRecords(ch)) {
					const neverDispatched = entry.taskId && taskRecords(ch).some((task) => task.taskId === entry.taskId && task.phase === "cancelled" && task.startedAt == null);
					if (entry.phase === "prepared" || entry.phase === "sending" && neverDispatched) journal.write(ch, { ...entry, phase: "cancelled", applied: true,
						result: failure("SUBMISSION_NOT_SENT", "上次进程在发送前中断，请求未发出") });
					else if (entry.phase === "sending") journal.write(ch, { ...entry, phase: "unknown", applied: true,
						result: failure("SUBMISSION_INTERRUPTED", "上次进程在提交期间中断，平台结果待核对", { outcomeUnknown: true }) });
					if (store.persistenceStatus().dirty) return;
				}
			}
			ch = store.get(ch.id);
			for (const entry of submissionRecords(ch)) {
				if (entry.phase === "completed" && entry.applied === false) applyResult(ch, entry);
				if (store.persistenceStatus().dirty) return;
			}
		}
	}
	function complete(ch, entry, result, phase = result.outcomeUnknown ? "unknown" : "completed") {
		entry = journal.write(ch, { ...entry, phase, result, applied: !["correct", "already_solved", "incorrect", "wrong", "rejected"].includes(result.status) }, {
			event: { kind: result.ok ? "flag" : "note", text: `平台提交（${result.status || result.code || "error"}）：${result.message || result.error || result.code || result.status || "平台未提供说明"}`.slice(0, 400) }
		});
		if (!store.persistenceStatus().dirty) applyResult(ch, entry);
		if (!store.persistenceStatus().dirty && ["correct", "already_solved"].includes(result.status)) {
			for (const previous of submissionRecords(store.get(ch.id))) if ((entry.retryOf || []).includes(previous.submissionId) && ["prepared", "sending", "unknown"].includes(previous.phase)) {
				journal.write(ch, { ...previous, phase: "completed", applied: true,
					resolution: { ok: true, status: "already_solved", verified: false, message: "后续提交已确认题目已解；不代表该旧候选正确", resolvedBy: entry.submissionId } });
			}
		}
		return { ...result, submissionId: entry.submissionId, recorded: !store.persistenceStatus().dirty,
			...(submissionRecords(store.get(ch.id) || {}).find((item) => item.submissionId === entry.submissionId)?.applied === false ? { localRecoveryPending: true } : {}) };
	}
	async function execute(ch, flag, connection, options, lease) {
		if (!current(ch)) return failure("SUBMISSION_CANCELLED", "提交已取消或题目已移除");
		ch = store.get(ch.id);
		if (!sameConnection(ch, connection)) return failure("PLATFORM_CONNECTION_CHANGED", "排队期间平台连接已变化，未提交");
		if (lease?.isCurrent && !lease.isCurrent()) return failure("TASK_CANCELLED", "提交任务已取消或租约已失效，未发送请求");
		if (!options.manual && (!autoSubmitEnabled() || needsReview(ch) || !options.normalizationAuthorized && !canAutoSubmit(ch, flag))) return failure("SUBMISSION_PAUSED", "自动提交已暂停或仍需复核");
		const unresolved = unresolvedFor(ch, connection);
		if (unresolved.length && !(options.manual && options.retryUnknown === true)) return failure("SUBMISSION_UNRESOLVED", "存在结果未明的提交，请先核对平台状态；明确需要重复提交时使用 retryUnknown=true", { outcomeUnknown: true });
		if (submissionRecords(ch).filter((entry) => ["prepared", "sending", "unknown"].includes(entry.phase) || entry.applied === false).length >= SUBMISSION_HISTORY_LIMIT) return failure("SUBMISSION_HISTORY_FULL", "未决提交流水已达上限，请先处理结果未明的记录");
		let entry = journal.write(ch, {
			submissionId: crypto.randomUUID(), taskId: lease?.taskId, flag, phase: "prepared", createdAt: Date.now(), applied: true,
			credentialKey: connection.credentialKey, sourceKey: platformChallengeKey(ch.platform), manual: options.manual === true,
			retryOf: unresolved.map((item) => item.submissionId).filter(Boolean)
		}, { latest: true });
		if (store.persistenceStatus().dirty) return complete(ch, entry, notDurable(), "cancelled");
		const key = resourceKey(ch, connection);
		let sent = false, result;
		try {
			if (!options.manual) {
				if (remembered(key)) result = { ok: true, status: "already_solved", message: "skipped: platform already solved", skipped: true, verified: false };
				else {
					const detail = await connection.client.getChallenge(ch.platform.challengeId, ch.platform);
					if (detail.ok && detail.data?.solvedByMe === true) result = { ok: true, status: "already_solved", message: "skipped: platform is_solved", skipped: true, verified: false };
				}
			}
			if (!current(ch)) return failure("SUBMISSION_CANCELLED", "提交已取消或题目已移除");
			ch = store.get(ch.id);
			if (lease?.isCurrent && !lease.isCurrent()) return complete(ch, entry, failure("TASK_CANCELLED", "提交任务已取消，未发送请求"), "cancelled");
			if (!sameConnection(ch, connection)) return complete(ch, entry, failure("PLATFORM_CONNECTION_CHANGED", "查询期间平台连接已变化，未提交"), "cancelled");
			if (!result) {
				if (!options.manual && !options.normalizationAuthorized && !canAutoSubmit(ch, flag)) return complete(ch, entry, failure("SUBMISSION_PAUSED", "候选或复核状态已变化，未发送提交"), "cancelled");
				// Save the send boundary before the adapter can issue a remote write.
				entry = journal.write(ch, { ...entry, phase: "sending", sentAt: Date.now() });
				if (store.persistenceStatus().dirty) return complete(ch, entry, notDurable(), "cancelled");
				const admitted = lease?.start?.({ submissionId: entry.submissionId });
				if (admitted && !admitted.ok) return complete(ch, entry, failure(admitted.code, admitted.error), "cancelled");
				sent = true;
				const response = await connection.client.submit(ch.platform.challengeId, flag, ch.platform);
				if (!response.ok) {
					const httpStatus = Number(response.httpStatus || response.status) || 0;
					const outcomeUnknown = response.outcomeUnknown === true || ["network", "timeout"].includes(response.code) || httpStatus >= 500 || httpStatus === 408 || (httpStatus < 400 && response.outcomeUnknown !== false);
					result = failure(response.code || "PLATFORM_REQUEST_FAILED", response.error || "平台提交失败", { httpStatus, outcomeUnknown });
				} else {
					const status = String(response.data?.status || response.status || "unknown");
					const diagnostic = submissionDiagnostic(response);
					result = { ok: status === "correct" || status === "already_solved", status,
						message: String(response.data?.message || response.message || `平台回显 ${status}；原始回显 ${JSON.stringify(diagnostic)}`).slice(0, 400), diagnostic, verified: status === "correct",
						outcomeUnknown: !["correct", "already_solved", "incorrect", "wrong", "rejected", "ratelimited", "rate_limited", "too_fast", "paused"].includes(status) };
				}
			}
			if (!current(ch)) return { ...result, submissionId: entry.submissionId, recorded: false };
			if (result.outcomeUnknown) lease?.markUnknown?.("平台提交结果未明，请先核对提交流水及执行端");
			if (result.status === "correct" || result.status === "already_solved") remember(key);
			// Commit the response before updating flags, files or other projections.
			return complete(ch, entry, result);
		} catch (error) {
			if (!current(ch)) return failure("SUBMISSION_CANCELLED", "提交服务已关闭或题目已移除", { recorded: false });
			if (result) return { ...result, submissionId: entry.submissionId, recorded: false, localRecoveryPending: true };
			if (sent) lease?.markUnknown?.("平台提交期间异常，执行结果未明");
			return complete(ch, entry, failure(error?.code || "PLATFORM_REQUEST_FAILED", String(error?.message || error), { outcomeUnknown: sent }));
		}
	}
	function connectionFor(ch) {
		try {
			const connection = platforms.forChallenge(ch);
			return connection.client ? connection : { failure: failure(connection.code || "PLATFORM_CONFIG_INVALID", connection.error) };
		} catch (error) { return { failure: failure("PLATFORM_CONFIG_INVALID", String(error?.message || error)) }; }
	}
	async function submit(payload, options = {}) {
		if (closed) return failure("PLATFORM_CLOSED", "平台提交服务已关闭");
		recover();
		const ch = store.get(String(payload.id ?? "")), flag = String(payload.flag ?? "").trim();
		if (!ch) return failure("CHALLENGE_NOT_FOUND", "题目不存在");
		if (!flag || flag.length > 300) return failure("INVALID_FLAG", "flag 不能为空且不得超过 300 字符");
		if (!ch.platform?.challengeId) return failure("PLATFORM_REQUIRED", "该题没有平台信息，无法提交（需从平台导入的题目）");
		const connection = connectionFor(ch);
		if (connection.failure) return connection.failure; // Preflight errors never overwrite evidence.
		const resource = resourceKey(ch, connection);
		const valueKey = crypto.createHash("sha256").update(flag).digest("hex");
		const operation = `${resource}:${ch.id}:${options.manual === true}:${options.retryUnknown === true}:${valueKey}`;
		const lease = resources?.acquire(ch, "submission");
		if (lease && !lease.ok) return lease;
		pending.set(ch.id, (pending.get(ch.id) || 0) + 1);
		try { return await platforms.operations.coalesced(resource, operation, async () => {
			const candidates = flagCandidates(flag, connection.flagWrapper);
			const attempts = [];
			let result;
			for (const candidate of candidates) {
				// Every dispatched representation has its own durable send boundary.
				// Only a definite incorrect response permits another representation.
				result = await execute(ch, candidate, connection, { ...options, normalizationAuthorized: attempts.length > 0 }, lease);
				attempts.push({ flag: candidate, status: result.status || result.code, submissionId: result.submissionId });
				if (!result.recorded || result.localRecoveryPending || result.outcomeUnknown || !["incorrect", "wrong", "rejected"].includes(result.status)) break;
			}
			return { ...result, attempts };
		}); }
		catch (error) { return failure(error?.code || "PLATFORM_REQUEST_FAILED", String(error?.message || error)); }
		finally {
			lease?.release();
			const remaining = (pending.get(ch.id) || 1) - 1;
			if (remaining) pending.set(ch.id, remaining); else pending.delete(ch.id);
		}
	}
	async function reconcile(payload) {
		if (closed) return failure("PLATFORM_CLOSED", "平台提交服务已关闭");
		recover();
		let ch = store.get(String(payload.id ?? ""));
		if (!ch?.platform) return failure("PLATFORM_REQUIRED", "题目不存在或没有平台信息");
		const connection = connectionFor(ch);
		if (connection.failure) return connection.failure;
		const unresolved = unresolvedSubmissions(ch);
		if (unresolved.length && unresolved.every((entry) => entry.credentialKey && entry.credentialKey !== connection.credentialKey)) return failure("PLATFORM_ACCOUNT_MISMATCH", "未决流水属于另一套凭据或配置，请恢复原配置后核对");
		try {
			return await platforms.operations.coalesced(resourceKey(ch, connection), `reconcile:${ch.id}`, async () => {
				if (!current(ch)) return failure("SUBMISSION_CANCELLED", "题目已移除或服务已关闭");
				ch = store.get(ch.id);
				if (!sameConnection(ch, connection)) return failure("PLATFORM_CONNECTION_CHANGED", "排队期间平台连接已变化，未核对旧记录");
				const detail = await connection.client.getChallenge(ch.platform.challengeId, ch.platform);
				if (!current(ch)) return failure("SUBMISSION_CANCELLED", "题目已移除或服务已关闭");
				ch = store.get(ch.id);
				if (!sameConnection(ch, connection)) return failure("PLATFORM_CONNECTION_CHANGED", "查询期间平台连接已变化，未核对旧记录");
				if (!detail.ok) return failure(detail.code || "PLATFORM_READ_FAILED", detail.error || "平台状态读取失败");
				if (detail.data?.solvedByMe !== true) return { ok: true, resolved: false, status: "unknown", message: "平台未明确报告已解，保留未决记录；本次未重新提交 flag" };
				let count = 0;
				for (const entry of unresolvedSubmissions(ch)) {
					if (entry.credentialKey && entry.credentialKey !== connection.credentialKey) continue;
					const next = journal.write(ch, { ...entry, phase: "completed", applied: false,
						resolution: { ok: true, status: "already_solved", verified: false, message: "查询平台确认题目已解；未确认具体 flag", reconciledAt: Date.now() } });
					if (!store.persistenceStatus().dirty) applyResult(ch, next);
					count++;
					if (store.persistenceStatus().dirty) return failure("STATE_NOT_DURABLE", "核对结果已应用到内存，保存失败", { applied: true, count });
				}
				return { ok: true, resolved: count > 0, count, status: "already_solved", verified: false, message: "平台已解；没有将任何候选升级为平台验证" };
			});
		} catch (error) { return failure(error?.code || "PLATFORM_READ_FAILED", String(error?.message || error)); }
	}
	function automatic(id, flag) {
		const ch = store.get(String(id || ""));
		if (closed || !ch?.platform || !flag || !autoSubmitEnabled() || needsReview(ch) || !canAutoSubmit(ch, flag)) return Promise.resolve();
		if ((ch.flags || []).some((f) => f?.value === flag && f.verified && f.method === "platform")) return Promise.resolve();
		if ((ch.flags || []).some((item) => item.value === flag && item.rejected)) return Promise.resolve();
		if (active.has(ch.id)) { queued.set(ch.id, flag); return active.get(ch.id); }
		if (ch.platformSubmit?.flag === flag && ["correct", "already_solved"].includes(ch.platformSubmit.status)) return Promise.resolve();
		const job = Promise.resolve().then(() => submit({ id: ch.id, flag })).catch((error) => {
			if (!closed && store.get(ch.id)) store.addEvent(ch.id, "error", "自动提交异常：" + String(error?.message || error).slice(0, 200));
			return failure("PLATFORM_REQUEST_FAILED", String(error?.message || error));
		}).finally(() => {
			active.delete(ch.id);
			const next = queued.get(ch.id);
			queued.delete(ch.id);
			if (next && next !== flag && !closed) void automatic(ch.id, next);
		});
		active.set(ch.id, job);
		return job;
	}
	return { submit, automatic, reconcile, recover, isActive, close() { closed = true; queued.clear(); solved.clear(); } };
}
