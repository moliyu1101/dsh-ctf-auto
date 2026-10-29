import crypto from "node:crypto";
import { challengeResourceKey } from "./challenge-resources.js";
import { createEnvironmentJournal, environmentRecords, unresolvedEnvironmentOperations, observedEnvironment, ENVIRONMENT_HISTORY_LIMIT } from "./environment-journal.js";
import { taskRecords } from "./task-registry.js";
import { sameChallengeScope } from "./state-snapshot.js";

export function createPlatformEnvironments({ store, platforms, resources, canAutoCleanup }) {
	const journal = createEnvironmentJournal(store), active = new Map();
	let closed = false;
	const failure = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
	const current = (ch) => !closed && store.owns(ch) && sameChallengeScope(ch, store.get(ch.id));
	const peers = (ch) => store.list().filter((item) => challengeResourceKey(item) === challengeResourceKey(ch));
	const unresolved = (ch) => peers(ch).flatMap((item) => unresolvedEnvironmentOperations(item));
	function recover() {
		if (closed || store.persistenceStatus().dirty) return;
		for (const ch of store.list()) {
			if (active.has(ch.id)) continue;
			for (const entry of environmentRecords(ch)) {
				const neverDispatched = entry.taskId && taskRecords(ch).some((task) => task.taskId === entry.taskId && task.phase === "cancelled" && task.startedAt == null);
				if (entry.phase === "prepared" || entry.phase === "sending" && neverDispatched) journal.write(ch, { ...entry, phase: "cancelled", result: failure("ENVIRONMENT_NOT_SENT", "发送前中断，未执行远程环境操作") });
				else if (entry.phase === "sending") journal.write(ch, { ...entry, phase: "unknown", result: failure("ENVIRONMENT_INTERRUPTED", "操作期间中断，需要查询平台环境状态", { outcomeUnknown: true }) });
				if (store.persistenceStatus().dirty) return;
			}
		}
	}
	function sameConnection(ch, connection) {
		const latest = platforms.forChallenge(ch);
		return !!latest.client && latest.sessionKey === connection.sessionKey;
	}
	async function readStatus(ch, connection, acceptObservedState) {
		const response = await connection.client.environment("status", { id: ch.platform.challengeId, meta: ch.platform });
		if (!current(ch)) return failure("ENVIRONMENT_CANCELLED", "题目已移除或服务已关闭", { recorded: false });
		ch = store.get(ch.id);
		if (!response.ok) return response;
		if (!sameConnection(ch, connection)) return failure("PLATFORM_CONNECTION_CHANGED", "查询期间平台配置变化，未修改本地环境状态");
		const raw = response.environment && typeof response.environment === "object" && !Array.isArray(response.environment) ? response.environment : {};
		const observed = observedEnvironment(raw);
		const remoteId = raw.environment_id || raw.id, previousId = ch.environment?.environment_id || ch.environment?.id;
		const replaced = remoteId && previousId && String(remoteId) !== String(previousId);
		const environment = { ...(replaced ? {} : ch.environment || {}), ...raw, action: "status", at: Date.now(),
			...(observed === "absent" ? { status: "deleted", access_ready: false, removedAt: Date.now() } : {}),
			...(observed === "transitioning" || ["stopped", "expired"].includes(String(raw.status || "").toLowerCase()) ? { access_ready: false } : {}) };
		let resolved = 0;
		const records = unresolvedEnvironmentOperations(ch).filter((entry) => entry.credentialKey === connection.credentialKey);
		if (!records.length && unresolvedEnvironmentOperations(ch).length) return failure("ENVIRONMENT_ACCOUNT_MISMATCH", "未决环境操作属于另一套凭据或配置，请恢复原配置后核对", { environment: raw });
		for (const entry of records) {
			const matches = observed === "absent" && entry.action === "delete" || observed === "present" && entry.action === "start";
			if (!["present", "absent"].includes(observed) || (!matches && !acceptObservedState)) continue;
			journal.write(ch, { ...entry, phase: "completed", resolution: { observed, at: Date.now(), acknowledged: acceptObservedState === true } },
				{ environment, event: { text: `环境操作已核对：${entry.action}，当前平台状态 ${observed}${acceptObservedState ? "（人工接受当前观测）" : ""}` } });
			resolved++;
			if (store.persistenceStatus().dirty) break;
		}
		if (!resolved) {
			const saved = store.transact(ch.id, (edit) => { edit.patch({ environment }); });
			if (!saved.ok) return failure(saved.code, saved.error, { applied: saved.applied, environment });
		}
		return { ok: !store.persistenceStatus().dirty, id: ch.id, action: "status", environment, observed, resolved,
			unresolved: unresolved(ch).length, localUnresolved: unresolvedEnvironmentOperations(store.get(ch.id)).length,
			...(store.persistenceStatus().dirty ? { code: "STATE_NOT_DURABLE", error: "环境核对已应用到内存，保存失败", applied: true } : {}) };
	}
	async function mutate(ch, action, connection, options) {
		if (!current(ch)) return failure("ENVIRONMENT_CANCELLED", "题目归属已变化或服务已关闭");
		ch = store.get(ch.id);
		if (unresolved(ch).length) return failure("ENVIRONMENT_UNRESOLVED", "同一题目存在未决环境操作，请先查询核对，不能直接重放");
		if (options.automatic && peers(ch).some((item) => environmentRecords(item).some((entry) => entry.automatic && entry.action === "delete"
			&& entry.phase === "completed" && entry.result?.ok === false && Date.now() - entry.updatedAt < 60000))) return failure("ENVIRONMENT_CLEANUP_BACKOFF", "自动清理失败后稍后重试");
		if (environmentRecords(ch).filter((entry) => ["prepared", "sending", "unknown"].includes(entry.phase)).length >= ENVIRONMENT_HISTORY_LIMIT) return failure("ENVIRONMENT_HISTORY_FULL", "未决环境流水已达上限");
		const lease = resources.acquire(ch, "environment", action === "delete" ? "cleanup" : "use");
		if (!lease.ok) return lease;
		let entry, sent = false;
		try {
			if (options.automatic && !canAutoCleanup(ch)) return failure("ENVIRONMENT_IN_USE", "题目不再满足自动清理条件");
			if (!sameConnection(ch, connection)) return failure("PLATFORM_CONNECTION_CHANGED", "排队期间平台配置变化，请重试");
			entry = journal.write(ch, { operationId: crypto.randomUUID(), taskId: lease.taskId, action, phase: "prepared", createdAt: Date.now(),
				credentialKey: connection.credentialKey, sourceKey: challengeResourceKey(ch), automatic: options.automatic === true });
			if (store.persistenceStatus().dirty) return failure("STATE_NOT_DURABLE", "环境操作意图未保存，未发出请求");
			if (options.automatic && !canAutoCleanup(ch, entry.operationId)) {
				journal.write(ch, { ...entry, phase: "cancelled", result: failure("ENVIRONMENT_IN_USE", "发送前题目重新被使用，已取消清理") });
				return failure("ENVIRONMENT_IN_USE", "题目已重新被使用，已取消清理");
			}
			entry = journal.write(ch, { ...entry, phase: "sending", sentAt: Date.now() });
			if (store.persistenceStatus().dirty) return failure("STATE_NOT_DURABLE", "环境发送阶段未保存，未发出请求");
			const admitted = lease.start?.({ operationId: entry.operationId, action });
			if (admitted && !admitted.ok) {
				journal.write(ch, { ...entry, phase: "cancelled", result: failure(admitted.code, admitted.error) });
				return admitted;
			}
			sent = true;
			const response = await connection.client.environment(action, { id: ch.platform.challengeId, meta: ch.platform });
			if (!current(ch)) return { ...response, recorded: false, operationId: entry.operationId };
			ch = store.get(ch.id);
			const httpStatus = Number(response.httpStatus || response.status) || 0;
			const quotaRejected = !response.ok && /environment_limit/i.test(String(response.code || "") + " " + String(response.error || "")) && httpStatus < 500 && !["network", "timeout"].includes(response.code);
			const observed = observedEnvironment(response.environment);
			const unknown = !response.ok && !quotaRejected && (response.outcomeUnknown === true || ["network", "timeout"].includes(response.code) || httpStatus === 408 || httpStatus >= 500 || httpStatus < 400)
				|| response.ok && (observed === "transitioning" || action !== "delete" && observed === "unknown");
			const result = { ok: response.ok && !unknown, ...(response.ok ? {} : { error: String(response.error || "环境操作失败"), code: response.code || "ENVIRONMENT_FAILED" }),
				outcomeUnknown: unknown, httpStatus, ...(unknown ? { code: "ENVIRONMENT_OUTCOME_UNKNOWN", error: "平台环境结果未明，请先查询核对" } : {}), ...(quotaRejected ? { quotaRejected: true } : {}) };
			if (unknown) lease.markUnknown?.("平台环境操作结果未明，请先查询核对环境流水及执行端");
			const raw = response.environment && typeof response.environment === "object" && !Array.isArray(response.environment) ? response.environment : {};
			const environment = response.ok ? { ...(action === "start" ? {} : ch.environment || {}), ...raw, action, at: Date.now(),
				...(action === "delete" && !unknown ? { status: "deleted", access_ready: false, removedAt: Date.now() } : {}) } : undefined;
			journal.write(ch, { ...entry, phase: unknown ? "unknown" : "completed", result }, { environment,
				event: { kind: result.ok ? "note" : "error", text: `靶机环境 ${action}：${result.ok ? environment?.status || "完成" : result.error}`.slice(0, 400) } });
			return { ...result, id: ch.id, action, environment, operationId: entry.operationId,
				...(store.persistenceStatus().dirty ? { ok: false, code: "STATE_NOT_DURABLE", error: "平台结果已应用到内存但保存失败", applied: true } : {}) };
		} catch (error) {
			if (sent) lease.markUnknown?.("平台环境操作期间异常，执行结果未明");
			if (entry && current(ch) && !store.persistenceStatus().dirty) journal.write(ch, { ...entry, phase: sent ? "unknown" : "cancelled",
				result: failure(error?.code || "ENVIRONMENT_FAILED", String(error?.message || error), { outcomeUnknown: sent }) });
			return failure(error?.code || "ENVIRONMENT_FAILED", String(error?.message || error), { outcomeUnknown: sent });
		} finally { lease.release(); }
	}
	async function operate(payload, options = {}) {
		if (closed) return failure("ENVIRONMENT_CLOSED", "环境服务已关闭");
		try { recover(); } catch (error) { return failure(error?.code || "ENVIRONMENT_RECOVERY_FAILED", String(error?.message || error)); }
		const ch = store.get(String(payload.id || "")), action = String(payload.action || "status");
		if (!ch?.platform?.challengeId) return failure("PLATFORM_REQUIRED", "题目不存在或没有平台信息");
		if (!["start", "status", "extend", "delete"].includes(action)) return failure("ENVIRONMENT_ACTION_INVALID", "未知环境操作");
		let connection;
		try { connection = platforms.forChallenge(ch); } catch (error) { return failure("PLATFORM_CONFIG_INVALID", String(error?.message || error)); }
		if (!connection.client) return failure(connection.code || "PLATFORM_CONFIG_INVALID", connection.error);
		if (!connection.capabilities.environment) return failure("PLATFORM_UNSUPPORTED", "当前平台不支持环境操作");
		const resource = `environment-operation:${challengeResourceKey(ch)}`;
		active.set(ch.id, (active.get(ch.id) || 0) + 1);
		try {
			return await platforms.operations.coalesced(resource, `${ch.id}:${action}:${options.automatic === true}:${payload.acceptObservedState === true}`, async () => {
				if (!current(ch)) return failure("ENVIRONMENT_CANCELLED", "题目已移除或服务已关闭");
				const latest = store.get(ch.id);
				if (!sameConnection(latest, connection)) return failure("PLATFORM_CONNECTION_CHANGED", "排队期间平台连接已变化，请重试");
				return action === "status" ? readStatus(latest, connection, payload.acceptObservedState === true) : mutate(latest, action, connection, options);
			});
		} catch (error) { return failure(error?.code || "ENVIRONMENT_FAILED", String(error?.message || error)); }
		finally { const left = active.get(ch.id) - 1; if (left) active.set(ch.id, left); else active.delete(ch.id); }
	}
	return { operate, recover, isActive: (id) => active.has(id), close() { closed = true; } };
}
