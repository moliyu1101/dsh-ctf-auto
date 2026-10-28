import { platformChallengeKey } from "./platform-identity.js";

export function challengeResourceKey(challenge) {
	return challenge.platform ? `platform:${platformChallengeKey(challenge.platform)}` : `local:${challenge.id}`;
}

// Synchronous admission closes the gap between checking consumers and deletion.
// Persistent lease expiry fences work but never automatically releases a consumer.
export function createChallengeResources({ blocked = () => false, tasks, maxLeases = 1024 } = {}) {
	const groups = new Map();
	let closed = false, count = 0;
	function status(challenge) {
		const leases = [...(groups.get(challengeResourceKey(challenge)) || [])];
		return { users: leases.filter((lease) => lease.mode === "use").length, blocked: blocked(challenge), taskBlocked: tasks?.blocked(challenge, challengeResourceKey(challenge)) === true,
			taskRecoveryPending: tasks?.migrationPending(challenge) === true,
			cleanup: leases.some((lease) => lease.mode === "cleanup"), kinds: [...new Set(leases.map((lease) => lease.kind))] };
	}
	function canUse(challenge, kind = "consumer") {
		const leases = groups.get(challengeResourceKey(challenge));
		return !closed && count < maxLeases && !blocked(challenge) && !tasks?.blocked(challenge, challengeResourceKey(challenge)) && ![...(leases || [])].some((lease) => lease.mode === "cleanup"
			|| (["solver", "review"].includes(kind) && lease.kind === kind && lease.challengeId === challenge.id));
	}
	function acquire(challenge, kind, mode = "use") {
		const key = challengeResourceKey(challenge), leases = groups.get(key) || new Set();
		if (closed || count >= maxLeases || blocked(challenge) || tasks?.blocked(challenge, key) || (mode === "cleanup" ? leases.size > 0 : !canUse(challenge, kind))) {
			return { ok: false, code: closed ? "RESOURCES_CLOSED" : "RESOURCE_BUSY", error: "题目资源仍在使用、清理，或有任务/环境待核对，请稍后重试" };
		}
		const task = tasks?.register(challenge, { kind, mode, resourceKey: key });
		if (task && !task.ok) return task;
		const lease = { challengeId: challenge.id, kind, mode };
		leases.add(lease); groups.set(key, leases); count++;
		let released = false;
		return { ...task, ok: true, release() {
			if (released) return;
			task?.release();
			released = true; leases.delete(lease); count--;
			if (!leases.size) groups.delete(key);
		} };
	}
	function releaseWhen(lease, settled) {
		if (!lease?.ok) return;
		if (!settled) { lease.release(); return; }
		Promise.resolve(settled).then(() => lease.release(), () => lease.release());
	}
	return { acquire, canUse, status, releaseWhen, close() { closed = true; } };
}
