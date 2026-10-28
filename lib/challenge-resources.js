import { platformChallengeKey } from "./platform-identity.js";

export function challengeResourceKey(challenge) {
	return challenge.platform ? `platform:${platformChallengeKey(challenge.platform)}` : `local:${challenge.id}`;
}

// Synchronous admission closes the gap between checking consumers and deletion.
// Leases have no automatic TTL: a timed-out request may still be executing remotely.
export function createChallengeResources({ blocked = () => false, maxLeases = 1024 } = {}) {
	const groups = new Map();
	let closed = false, count = 0;
	function status(challenge) {
		const leases = [...(groups.get(challengeResourceKey(challenge)) || [])];
		return { users: leases.filter((lease) => lease.mode === "use").length, blocked: blocked(challenge),
			cleanup: leases.some((lease) => lease.mode === "cleanup"), kinds: [...new Set(leases.map((lease) => lease.kind))] };
	}
	function canUse(challenge, kind = "consumer") {
		const leases = groups.get(challengeResourceKey(challenge));
		return !closed && count < maxLeases && !blocked(challenge) && ![...(leases || [])].some((lease) => lease.mode === "cleanup"
			|| (["solver", "review"].includes(kind) && lease.kind === kind && lease.challengeId === challenge.id));
	}
	function acquire(challenge, kind, mode = "use") {
		const key = challengeResourceKey(challenge), leases = groups.get(key) || new Set();
		if (closed || count >= maxLeases || blocked(challenge) || (mode === "cleanup" ? leases.size > 0 : !canUse(challenge, kind))) {
			return { ok: false, code: closed ? "RESOURCES_CLOSED" : "RESOURCE_BUSY", error: "题目资源仍在使用、清理或等待环境核对，请稍后重试" };
		}
		const lease = { challengeId: challenge.id, kind, mode };
		leases.add(lease); groups.set(key, leases); count++;
		let released = false;
		return { ok: true, release() {
			if (released) return;
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
