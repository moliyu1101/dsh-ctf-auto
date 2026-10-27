import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../../lib/store.js";
import { createOrchestrator } from "../../lib/orchestrator.js";

function tempStore(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-reliability-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return createStore(path.join(dir, "state.json"), { rootDir: dir });
}

async function waitFor(predicate, timeoutMs = 2000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor timeout");
}

test("recover: 重启遗留的 running attempt 会收口并重新入队", async (t) => {
	const store = tempStore(t);
	const challenge = store.addChallenge({ title: "stale" });
	store.addAttempt(challenge.id, { angle: "recon-first" });
	store.setStatus(challenge.id, "running");
	let spawns = 0;
	const orchestrator = createOrchestrator({
		store,
		config: { autoRetry: true, maxAttempts: 3, concurrency: 1 },
		spawn: () => {
			spawns += 1;
			return { done: new Promise(() => {}), interrupt() {} };
		}
	});
	const result = orchestrator.recover();
	assert.deepEqual(result.recovered, [challenge.id]);
	assert.deepEqual(result.requeued, [challenge.id]);
	assert.equal(store.get(challenge.id).status, "queued");
	assert.equal(store.get(challenge.id).attempts[0].status, "aborted");
	assert.equal(store.get(challenge.id).attempts[0].stopReason, "recovered");
	assert.equal(spawns, 0);
	orchestrator.pump();
	await waitFor(() => spawns === 1);
	orchestrator.close();
});

test("timeBudgetMs: 小于 timeoutMs 时真正限制本次尝试", async (t) => {
	const store = tempStore(t);
	const challenge = store.addChallenge({ title: "budget", timeBudgetMs: 60, maxAttempts: 1 });
	let spawnedRequest = null;
	const orchestrator = createOrchestrator({
		store,
		config: { timeoutMs: 10000, maxAttempts: 1, autoRetry: false },
		spawn: (request) => {
			spawnedRequest = request;
			return { done: new Promise(() => {}), interrupt() {} };
		}
	});
	orchestrator.start(challenge.id);
	await waitFor(() => store.get(challenge.id).status === "stuck");
	const attempt = store.get(challenge.id).attempts.at(-1);
	assert.ok(spawnedRequest);
	assert.ok(attempt.timeoutMs > 0 && attempt.timeoutMs <= 60, `effective timeout: ${attempt.timeoutMs}`);
	assert.equal(attempt.status, "timeout");
	assert.match(store.get(challenge.id).stuckReason, /超时|timeout/i);
	orchestrator.close();
});

test("已验证 flag 后中止子代理但保持 solved 收口", async (t) => {
	const store = tempStore(t);
	const challenge = store.addChallenge({ title: "solved", maxAttempts: 1 });
	let interrupted = 0;
	let spawned = false;
	const orchestrator = createOrchestrator({
		store,
		config: { timeoutMs: 10000, maxAttempts: 1, autoRetry: false },
		spawn: () => {
			spawned = true;
			return { done: new Promise(() => {}), interrupt() { interrupted += 1; } };
		}
	});
	orchestrator.start(challenge.id);
	await waitFor(() => spawned);
	store.addFlag(challenge.id, { value: "CTF{solved}", verified: true, evidence: "check output", method: "local-check", attempt: 1 });
	assert.equal(orchestrator.abortAfterVerifiedFlag(challenge.id), true);
	await waitFor(() => store.get(challenge.id).attempts.at(-1).status !== "running");
	assert.equal(store.get(challenge.id).status, "solved");
	assert.ok(interrupted >= 1);
	orchestrator.close();
});
