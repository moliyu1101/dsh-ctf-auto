export const SWARM_QUEUE_LIMIT = 4;

export function swarmQueueRows(attempt) {
	const rows = attempt.swarmQueue || [];
	if (!Array.isArray(rows) || rows.length > SWARM_QUEUE_LIMIT || rows.some((r) => !r || r.schema !== 1
		|| !/^[a-f0-9-]{36}$/.test(r.queueId) || typeof r.key !== "string" || !r.key || r.key.length > 120
		|| !/^[a-f0-9]{64}$/.test(r.epoch) || !Number.isInteger(r.expectedVersion) || r.expectedVersion < 1
		|| !["offline", "target"].includes(r.lane) || !["queued", "dispatched", "cancelled", "invalidated"].includes(r.status)
		|| !Number.isFinite(r.createdAt)) || new Set(rows.map((r) => r.queueId)).size !== rows.length)
		throw Object.assign(new Error("蜂群等待队列格式不受支持，原状态已保留"), { code: "SWARM_QUEUE_FORMAT_INVALID" });
	return rows;
}
