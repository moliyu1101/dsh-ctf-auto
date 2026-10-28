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
		const lease = { challengeId: challenge.id, taskId: task?.taskId || null, kind, mode };
		leases.add(lease); groups.set(key, leases); count++;
		let released = false;
		return { ...task, ok: true, release() {
			if (released) return;
			task?.release();
			released = true; leases.delete(lease); count--;
			if (!leases.size) groups.delete(key);
		} };
	}
	function reservations(kind) {
		const rows = tasks?.reservations?.(kind) || [], known = new Set(rows.map((row) => row.taskId).filter(Boolean));
		for (const leases of groups.values()) for (const lease of leases) {
			if (kind != null && lease.kind !== kind || lease.taskId && known.has(lease.taskId)) continue;
			rows.push({ challengeId: lease.challengeId, taskId: lease.taskId, kind: lease.kind, phase: "awaiting_release" });
			if (lease.taskId) known.add(lease.taskId);
		}
		return rows;
	}
	function releaseWhen(lease, settled, fallback) {
		if (!lease?.ok) return;
		const completions = [], seen = new Set();
		let releaseAllowed = true;
		const uncertain = () => {
			if (typeof lease.markUnknown !== "function") { releaseAllowed = false; return; }
			try { lease.markUnknown("执行端结束确认失败，不能据此认定远端任务已经停止"); }
			catch (error) { releaseAllowed = false; console.error(`[dsh-ctf-auto] task uncertainty checkpoint failed: ${error?.message || error}`); }
		};
		for (const source of [settled, fallback]) {
			try {
				const completion = typeof source === "function" ? source() : source;
				if (completion == null || seen.has(completion)) continue;
				seen.add(completion);
				if (typeof completion.then !== "function") { uncertain(); continue; }
				completions.push(Promise.resolve(completion).catch((error) => { uncertain(); throw error; }));
			} catch { uncertain(); }
		}
		if (!completions.length) { if (releaseAllowed) lease.release(); return; }
		Promise.allSettled(completions).then(() => { if (releaseAllowed) lease.release(); })
			.catch((error) => console.error(`[dsh-ctf-auto] task release failed: ${error?.message || error}`));
	}
	return { acquire, canUse, status, reservations, releaseWhen, close() { closed = true; } };
}
