import crypto from "node:crypto";
import { challengeResourceKey } from "./challenge-resources.js";
import { unresolvedSubmissions } from "./submission-journal.js";

const OPEN = new Set(["registered", "running", "cancel_requested", "unknown"]);
const PHASES = new Set([...OPEN, "settled", "cancelled", "acknowledged"]);
const KINDS = new Set(["solver", "review", "submission", "environment"]);
export function taskRecords(challenge) {
	if (challenge.taskJournal == null) return [];
	if (!Array.isArray(challenge.taskJournal) || challenge.taskJournal.some((row) => !row || row.version !== 1
		|| typeof row.taskId !== "string" || !row.taskId || typeof row.ownerId !== "string" || !row.ownerId || typeof row.resourceKey !== "string" || !row.resourceKey
		|| !KINDS.has(row.kind) || !PHASES.has(row.phase) || !["use", "cleanup"].includes(row.mode)
		|| [row.createdAt, row.heartbeatAt, row.expiresAt].some((at) => !Number.isFinite(at) || at < 0)
		|| row.startedAt != null && (!Number.isFinite(row.startedAt) || row.startedAt < 0)
		|| !Array.isArray(row.sessionIds) || row.sessionIds.some((id) => typeof id !== "string"))) throw new Error("任务流水格式不受支持，原状态文件已保留");
	return challenge.taskJournal;
}
export const unresolvedTasks = (challenge) => taskRecords(challenge).filter((row) => OPEN.has(row.phase));

// Expiration fences dispatch and publication; it never proves remote quiescence.
export function createTaskRegistry({ store, onSettled = () => {}, now = Date.now, leaseMs = 60000, heartbeatMs = 15000, maxTasks = 1024 }) {
	const ownerId = crypto.randomUUID(), live = new Map(), finishes = new Map();
	let closed = false, indexVersion = -1, indexDeadline = Infinity, blockedKeys = new Set(), tickCursor = 0;
	const failure = (code, error) => ({ ok: false, code, error });
	const find = (id, taskId) => taskRecords(store.get(id) || {}).find((row) => row.taskId === taskId);
	function write(id, operation) {
		if (closed) return failure("TASK_REGISTRY_CLOSED", "任务登记服务已关闭");
		const result = store.transact(id, (edit, draft) => {
			const rows = taskRecords(draft).map((row) => ({ ...row }));
			const value = operation(rows, edit);
			if (value?.ok === false) return value;
			const terminal = rows.filter((row) => !OPEN.has(row.phase)).sort((a, b) => (a.endedAt || a.createdAt) - (b.endedAt || b.createdAt)).slice(-50);
			const keep = new Set(terminal.map((row) => row.taskId));
			edit.patch({ taskJournal: rows.filter((row) => OPEN.has(row.phase) || keep.has(row.taskId)) });
			return value;
		}, { durable: true });
		return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.code, error: result.error, applied: result.applied };
	}
	function settled(id) { try { onSettled(id); } catch (error) { console.warn(`[dsh-ctf-auto] task settlement observer failed: ${error?.message || error}`); } }
	function uncertain(row) {
		const local = live.get(row.taskId);
		return OPEN.has(row.phase) && (["unknown", "cancel_requested"].includes(row.phase) || row.ownerId !== ownerId || !local || local.settled || local.controller.signal.aborted || row.expiresAt <= now());
	}
	function blocked(challenge, resourceKey) {
		if (indexVersion !== store.changeVersion || now() >= indexDeadline) {
			blockedKeys = new Set(); indexDeadline = Infinity;
			for (const ch of store.list()) {
				if (legacyPending(ch)) blockedKeys.add(challengeResourceKey(ch));
				for (const row of unresolvedTasks(ch)) {
					if (uncertain(row)) blockedKeys.add(row.resourceKey);
					if (row.expiresAt > now()) indexDeadline = Math.min(indexDeadline, row.expiresAt);
				}
			}
			indexVersion = store.changeVersion;
		}
		return blockedKeys.has(resourceKey) || legacyPending(challenge) || unresolvedTasks(challenge).some(uncertain);
	}
	function notify(entry) {
		indexVersion = -1;
		entry.controller.abort();
		try { entry.cancel?.(); return null; } catch (error) { return String(error.message || error); }
	}
	function markCancel(id, taskId, reason = "用户请求取消") {
		return write(id, (rows) => {
			const row = rows.find((item) => item.taskId === taskId);
			if (!row || !OPEN.has(row.phase)) return failure("TASK_NOT_ACTIVE", "任务已结束或不存在");
			if (row.cancelRequestedAt) return;
			row.cancelRequestedAt = now(); row.cancelReason = String(reason).slice(0, 300);
			if (row.phase !== "unknown") row.phase = "cancel_requested";
		});
	}
	function finish(id, taskId) {
		const local = live.get(taskId);
		if (!local) return { ok: true };
		local.settled = true; indexVersion = -1;
		finishes.set(taskId, id);
		const result = write(id, (rows) => {
			const row = rows.find((item) => item.taskId === taskId);
			// A previously applied terminal checkpoint can be pruned while its
			// durability retry is pending; confirmed quiescence still holds locally.
			if (!row && !local.quiescenceUnknown) return;
			if (!row || row.ownerId !== ownerId) return failure("STALE_TASK", "任务所有权已变化");
			row.phase = local.quiescenceUnknown ? "unknown" : row.startedAt == null ? "cancelled" : "settled";
			if (!local.quiescenceUnknown) row.endedAt = now();
		});
		if (result.ok) { finishes.delete(taskId); live.delete(taskId); indexVersion = -1; if (!local.quiescenceUnknown) settled(id); }
		return result;
	}
	function register(challenge, { kind, mode, resourceKey }) {
		if (!KINDS.has(kind)) return failure("TASK_KIND_INVALID", "不支持的任务类型");
		if (closed || live.size >= maxTasks) return failure("TASK_CAPACITY", "任务登记已关闭或达到上限");
		const taskId = crypto.randomUUID(), at = now();
		const row = { version: 1, taskId, ownerId, resourceKey, kind, mode, phase: "registered", createdAt: at,
			heartbeatAt: at, expiresAt: at + leaseMs, startedAt: null, sessionIds: [] };
		const saved = write(challenge.id, (rows) => {
			if (rows.filter((item) => OPEN.has(item.phase)).length >= 128) return failure("TASK_HISTORY_FULL", "未决任务已达上限");
			rows.push(row);
		});
		if (!saved.ok) return saved;
		const entry = { id: challenge.id, taskId, controller: new AbortController(), cancel: null, settled: false, expiresAt: row.expiresAt };
		live.set(taskId, entry); indexVersion = -1;
		const current = () => {
			const record = find(challenge.id, taskId);
			return !closed && !entry.settled && !entry.controller.signal.aborted && record?.ownerId === ownerId
				&& ["registered", "running"].includes(record.phase) && record.expiresAt > now();
		};
		return { ok: true, taskId, signal: entry.controller.signal, isCurrent: current,
			start(reference = {}) {
				if (!current()) return failure("TASK_NOT_CURRENT", "任务已取消、过期或被替换，未派发");
				return write(challenge.id, (rows) => {
					const record = rows.find((item) => item.taskId === taskId);
					if (record?.ownerId !== ownerId || !["registered", "running"].includes(record.phase) || record.expiresAt <= now()) return failure("STALE_TASK", "任务租约已失效");
					record.phase = "running"; record.startedAt ??= now();
					record.reference = Object.fromEntries(Object.entries(reference).filter(([key]) => ["attempt", "runId", "reviewJobId", "submissionId", "operationId", "action"].includes(key)));
				});
			},
			bindSession(sessionId) {
				return write(challenge.id, (rows) => {
					const record = rows.find((item) => item.taskId === taskId);
					if (entry.settled || record?.ownerId !== ownerId || !OPEN.has(record.phase)) return failure("STALE_TASK", "任务所有权已失效");
					record.sessionIds = [...new Set([...(record.sessionIds || []), String(sessionId)])].filter(Boolean).slice(-16);
				});
			},
			markUnknown(reason) {
				entry.quiescenceUnknown = true; indexVersion = -1;
				return write(challenge.id, (rows) => {
					const record = rows.find((item) => item.taskId === taskId);
					if (record?.ownerId !== ownerId || !OPEN.has(record.phase)) return failure("STALE_TASK", "任务所有权已变化");
					record.phase = "unknown"; record.recoveryReason = String(reason || "执行结果未明").slice(0, 500); record.recoveredAt = now();
				});
			},
			onCancel(callback) { entry.cancel = callback; if (entry.controller.signal.aborted) notify(entry); },
			markCancel(reason) { const result = markCancel(challenge.id, taskId, reason); entry.controller.abort(); indexVersion = -1; return result; },
			release: () => finish(challenge.id, taskId)
		};
	}
	function cancel(id, taskId, reason) {
		const row = find(id, taskId);
		if (!row || !OPEN.has(row.phase)) return failure("TASK_NOT_ACTIVE", "任务已结束或不存在");
		const saved = markCancel(id, taskId, reason), local = live.get(taskId);
		const error = local ? notify(local) : null;
		return { ...saved, taskId, interruptRequested: !!local?.cancel, remoteStopConfirmed: false, ...(error ? { interruptError: error } : {}) };
	}
	function acknowledge(id, taskId, { confirmStopped, note } = {}) {
		if (confirmStopped !== true || !String(note || "").trim()) return failure("TASK_CONFIRM_REQUIRED", "需明确确认旧任务已停止，并填写核对说明");
		if (live.has(taskId)) return failure("TASK_STILL_LOCAL", "本实例仍持有任务句柄，请先取消并等待执行端结束");
		const result = write(id, (rows, edit) => {
			const row = rows.find((item) => item.taskId === taskId);
			if (!row || row.phase !== "unknown") return failure("TASK_NOT_UNKNOWN", "只允许核对无法确认结束的旧任务");
			row.phase = "acknowledged"; row.endedAt = now(); row.resolution = { at: now(), note: String(note).trim().slice(0, 1000), confirmedStopped: true };
			edit.addEvent("note", `人工核对旧任务已停止：${row.kind} ${taskId}；${row.resolution.note}`);
		});
		if (result.ok) settled(id);
		return result;
	}
	function legacyPending(ch) {
		return (ch.attempts || []).some((row) => row.status === "running" && row.finalizedAt == null && !row.taskId)
			|| ch.review?.status === "pending" && !ch.review.taskId
			|| unresolvedSubmissions(ch).some((row) => ["sending", "unknown"].includes(row.phase) && !row.taskId)
			|| (ch.environmentJournal || []).some((row) => ["sending", "unknown"].includes(row.phase) && !row.taskId);
	}
	function bootstrapLegacy(ch) {
		return write(ch.id, (rows, edit) => {
			const at = now(), resourceKey = challengeResourceKey(ch);
			function append(kind, reference, sessionId, startedAt) {
				const taskId = crypto.randomUUID();
				const began = Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : at;
				rows.push({ version: 1, taskId, ownerId: "legacy", resourceKey, kind, mode: kind === "environment" && reference.action === "delete" ? "cleanup" : "use",
					phase: "unknown", createdAt: began, startedAt: began, heartbeatAt: began, expiresAt: Math.min(at, began + leaseMs),
					sessionIds: sessionId ? [String(sessionId)] : [], reference, recoveryReason: "旧版活动记录缺少持久化任务身份，需核对执行端", recoveredAt: at });
				return taskId;
			}
			for (const attempt of ch.attempts || []) if (attempt.status === "running" && attempt.finalizedAt == null && !attempt.taskId) {
				edit.updateAttempt(attempt.n, { taskId: append("solver", { attempt: attempt.n, runId: attempt.runId }, attempt.sessionId, attempt.startedAt) });
			}
			if (ch.review?.status === "pending" && !ch.review.taskId) edit.patch({ review: { ...ch.review, taskId: append("review", { reviewJobId: ch.review.jobId }, ch.review.sessionId, ch.review.at) } });
			if (!(ch.submissionJournal || []).length && unresolvedSubmissions(ch).length && !ch.platformSubmit?.taskId)
				edit.patch({ platformSubmit: { ...ch.platformSubmit, taskId: append("submission", { submissionId: ch.platformSubmit?.submissionId }, null, ch.platformSubmit?.at) } });
			for (const [key, kind, reference] of [["submissionJournal", "submission", "submissionId"], ["environmentJournal", "environment", "operationId"]]) {
				if (!(ch[key] || []).some((row) => ["sending", "unknown"].includes(row.phase) && !row.taskId)) continue;
				edit.patch({ [key]: ch[key].map((row) => !["sending", "unknown"].includes(row.phase) || row.taskId ? row : { ...row,
					taskId: append(kind, { [reference]: row[reference], ...(kind === "environment" ? { action: row.action } : {}) }, null, row.sentAt || row.createdAt) }) });
			}
		});
	}
	function tick({ limit = 20 } = {}) {
		if (closed || store.persistenceStatus().dirty) return;
		for (const [taskId, id] of [...finishes].slice(0, 20)) { finish(id, taskId); if (store.persistenceStatus().dirty) return; }
		let writes = 0;
		const all = store.list(), first = tickCursor % Math.max(1, all.length);
		for (let i = 0; i < all.length; i++) {
			const ch = all[(first + i) % all.length];
			tickCursor = (first + i + 1) % all.length;
			if (legacyPending(ch)) {
				bootstrapLegacy(ch);
				if (++writes >= limit || store.persistenceStatus().dirty) break;
				continue;
			}
			const at = now(), rows = unresolvedTasks(ch), cancelled = [];
			let safelyCancelled = false;
			if (!rows.some((row) => row.phase !== "unknown" && (row.ownerId !== ownerId || !live.has(row.taskId) || row.expiresAt <= at || at - row.heartbeatAt >= heartbeatMs))) continue;
			const result = write(ch.id, (draft) => {
				for (const row of draft.filter((item) => OPEN.has(item.phase))) {
					const entry = live.get(row.taskId);
					if (!entry || row.ownerId !== ownerId) {
						if (row.phase === "unknown") continue;
						row.phase = row.startedAt == null ? "cancelled" : "unknown";
						row.recoveryReason = "owner_missing"; row.recoveredAt = at;
						if (row.phase === "cancelled") { row.endedAt = at; safelyCancelled = true; }
					} else if (!entry.settled && row.phase !== "unknown") {
						if (row.expiresAt <= at) { row.phase = "unknown"; row.recoveryReason = "lease_expired"; row.recoveredAt = at; cancelled.push(entry); }
						else if (at - row.heartbeatAt >= heartbeatMs) { row.heartbeatAt = at; row.expiresAt = at + leaseMs; entry.expiresAt = row.expiresAt; }
					}
				}
			});
			if (result.ok || result.applied) for (const entry of cancelled) notify(entry);
			if (result.ok && safelyCancelled) settled(ch.id);
			if (++writes >= limit || store.persistenceStatus().dirty) break;
		}
	}
	function list(id) {
		return taskRecords(store.read(id)?.challenge || {}).map(({ ownerId: owner, resourceKey, ...row }) => ({ ...row,
			local: owner === ownerId && live.has(row.taskId), current: OPEN.has(row.phase) && owner === ownerId && !uncertain({ ...row, ownerId: owner }), unresolved: OPEN.has(row.phase) }));
	}
	function sessionCurrent(sessionId) {
		let known = false;
		for (const ch of store.list()) for (const row of taskRecords(ch)) if (row.sessionIds?.includes(sessionId)) {
			known = true;
			if (row.ownerId === ownerId && ["registered", "running"].includes(row.phase) && !uncertain(row) && !live.get(row.taskId)?.controller.signal.aborted) return true;
		}
		return known ? false : null;
	}
	return { register, blocked, cancel, acknowledge, tick, list, sessionCurrent, migrationPending: legacyPending,
		close() { if (closed) return; for (const entry of live.values()) { markCancel(entry.id, entry.taskId, "插件卸载"); notify(entry); } closed = true; }
	};
}
