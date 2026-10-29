import { taskRecords } from "./task-registry.js";
import { sameChallengeScope } from "./state-snapshot.js";

export const ENVIRONMENT_HISTORY_LIMIT = 100;
export function environmentRecords(challenge) { return Array.isArray(challenge.environmentJournal) ? challenge.environmentJournal.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : []; }
export function unresolvedEnvironmentOperations(challenge, ignoredId) {
	return environmentRecords(challenge).filter((entry) => entry.operationId !== ignoredId && ["prepared", "sending", "unknown"].includes(entry.phase));
}
export function observedEnvironment(environment = {}) {
	if (!environment || typeof environment !== "object" || Array.isArray(environment)) return "unknown";
	const status = String(environment.status || "").toLowerCase();
	if (["deleted", "absent", "not_found", "none"].includes(status)) return "absent";
	if (["starting", "creating", "deleting", "stopping", "terminating", "restarting"].includes(status)) return "transitioning";
	if (environment.environment_id || environment.id || environment.access_ready === true || ["running", "ready", "stopped", "expired"].includes(status)) return "present";
	return "unknown";
}

export function createEnvironmentJournal(store) {
	function write(challenge, record, { environment, event } = {}) {
		if (!store.owns(challenge) || !sameChallengeScope(challenge, store.get(challenge.id))) throw Object.assign(new Error("环境操作所属题目或来源已变化"), { code: "STATE_CONFLICT" });
		const snapshot = store.read(challenge.id);
		const records = [...environmentRecords(snapshot.challenge)];
		const entry = { ...record, updatedAt: Date.now() };
		const index = records.findIndex((item) => item.operationId === entry.operationId);
		if (index < 0) records.push(entry); else records[index] = entry;
		while (records.length > ENVIRONMENT_HISTORY_LIMIT) {
			const removable = records.findIndex((item) => ["completed", "cancelled"].includes(item.phase) && item.operationId !== entry.operationId);
			if (removable < 0) break;
			records.splice(removable, 1);
		}
		const result = store.transact(challenge.id, (edit) => {
			edit.patch({ environmentJournal: records });
			if (entry.phase === "completed" && (entry.resolution || entry.result?.outcomeUnknown === false) && entry.taskId) {
				const tasks = taskRecords(snapshot.challenge).map((task) => {
					if (task.taskId !== entry.taskId || task.kind !== "environment" || task.phase !== "unknown" || task.sessionIds.length
						|| task.reference?.operationId && task.reference.operationId !== entry.operationId) return task;
					return { ...task, phase: "acknowledged", endedAt: Date.now(), resolution: {
						at: Date.now(), observed: entry.resolution?.observed || observedEnvironment(environment || snapshot.challenge.environment), operationId: entry.operationId,
						note: "环境流水已确认对应操作结束", confirmedStopped: true } };
				});
				edit.patch({ taskJournal: tasks });
			}
			if (environment) edit.patch({ environment });
			if (event) edit.addEvent(event.kind || "note", event.text);
		}, { expectedRevision: snapshot.revision, durable: true });
		if (!result.ok && !result.applied) throw Object.assign(new Error(result.error), { code: result.code });
		return entry;
	}
	return { write };
}
