import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStore } from "../../lib/store.js";
import { createExperiments } from "../../lib/experiments.js";
import { createSwarm, buildSwarmInstructions, swarmUsage } from "../../lib/swarm.js";
import { buildHelperPresetDefinition } from "../../lib/preset.js";

const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-swarm-")), statePath = path.join(root, "state.json");
	let store = createStore(statePath, { rootDir: root }), mono = 100, wall = 1700000000000, remaining = 20000;
	const config = { swarmEnabled: true, swarmConcurrency: 2, swarmWorkerTimeoutMs: 30000 }, children = [], taskRows = [];
	const tasks = { list: () => taskRows };
	function spawn(request) {
		let resolve, reject;
		const child = { request, done: new Promise((r, j) => { resolve = r; reject = j; }),
			finish: (result = {}) => resolve({ stopReason: "completed", outputText: "", ...result }), reject, interrupts: 0,
			interrupt() { this.interrupts++; }, send: () => Promise.resolve(true) };
		children.push(child); return child;
	}
	const swarm = createSwarm({ store, spawn, config: () => config, tasks, now: () => wall, mono: () => mono,
		timing: (id) => ({ runId: store.get(id)?.attempts.at(-1)?.runId, remainingMs: remaining }) });
	t.after(() => { swarm.close(); for (const c of children) c.finish({ stopReason: "aborted" }); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
	function add(title = "offline fixture") {
		const ch = store.addChallenge({ title, statement: "Read this local attachment" });
		fs.mkdirSync(ch.dir, { recursive: true });
		store.addAttempt(ch.id, { runId: crypto.randomUUID() }); store.setStatus(ch.id, "running");
		const attempt = store.get(ch.id).attempts.at(-1);
		const handle = swarm.wrap({ challenge: store.get(ch.id), attempt, prompt: "Solve this fixture", lease: { isCurrent: () => true } });
		return { id: ch.id, attempt, handle };
	}
	function proposal(id, key) {
		const record = createExperiments({ store }).record({ id, key, hypothesis: `Test ${key}`, scope: `Only input ${key}`, expectedResult: "A deterministic marker should appear" });
		assert.equal(record.ok, true, JSON.stringify(record));
		return { id, key, epoch: record.epoch, expectedVersion: record.experiment.version, lane: "offline" };
	}
	return { get store() { return store; }, statePath, config, children, swarm, taskRows, add, proposal,
		clock({ mono: m, wall: w, remaining: r } = {}) { if (m !== undefined) mono = m; if (w !== undefined) wall = w; if (r !== undefined) remaining = r; },
		reopen() { store.close(); store = createStore(statePath, { rootDir: root }); return store; } };
}

test("helpers use the parent remaining budget and monotonic expiry despite wall-clock jumps", async (t) => {
	const f = fixture(t), a = f.add(), input = f.proposal(a.id, "one"), dispatched = f.swarm.dispatch(input);
	assert.equal(dispatched.ok, true); assert.equal(dispatched.worker.timeoutMs, 20000);
	f.clock({ wall: 9000000000000, mono: 101 }); f.swarm.tick(); assert.equal(f.children[1].interrupts, 0);
	f.clock({ wall: 1, mono: 20101 }); f.swarm.tick(); assert.equal(f.children[1].interrupts, 1);
	assert.equal(f.swarm.isWorkerCurrent(a.id, a.attempt.runId, dispatched.worker.workerId), false);
	assert.equal(f.swarm.status({ id: a.id }).occupiedSlots, 1);
	f.children[1].finish(); await drain();
	assert.equal(f.swarm.status({ id: a.id }).occupiedSlots, 0);
});

test("global helper capacity applies across challenges and is reusable only after exit", async (t) => {
	const f = fixture(t), a = f.add("A"), b = f.add("B");
	f.swarm.dispatch(f.proposal(a.id, "a1")); f.swarm.dispatch(f.proposal(b.id, "b1"));
	const next = f.proposal(a.id, "a2");
	assert.equal(f.swarm.dispatch(next).code, "SWARM_CAPACITY");
	f.children[2].finish(); await drain();
	assert.equal(f.swarm.dispatch(next).ok, true);
});

test("four dispatches exhaust an attempt even if every earlier helper already exited", async (t) => {
	const f = fixture(t), a = f.add();
	for (let n = 0; n < 4; n++) {
		assert.equal(f.swarm.dispatch(f.proposal(a.id, `path-${n}`)).ok, true);
		f.children[n + 1].finish(); await drain();
	}
	assert.equal(f.swarm.dispatch(f.proposal(a.id, "excess")).code, "SWARM_ATTEMPT_LIMIT");
	assert.equal(f.children.length, 5);
});

test("input epoch and changed experiment definitions fence existing helpers", async (t) => {
	const f = fixture(t), a = f.add(), input = f.proposal(a.id, "one"), first = f.swarm.dispatch(input);
	assert.equal(f.swarm.isWorkerCurrent(a.id, a.attempt.runId, first.worker.workerId), true);
	const changed = createExperiments({ store: f.store }).record({ id: a.id, key: "one", expectedVersion: 1, scope: "different input section" });
	assert.equal(changed.ok, true);
	f.swarm.tick(); assert.equal(f.children[1].interrupts, 1);
	assert.equal(f.swarm.isWorkerCurrent(a.id, a.attempt.runId, first.worker.workerId), false);
	const second = f.swarm.dispatch(f.proposal(a.id, "two")); assert.equal(second.ok, true);
	f.store.update(a.id, { statement: "A completely new input set" }); f.swarm.tick();
	assert.equal(f.children[2].interrupts, 1);
	assert.equal(f.swarm.dispatch(input).code, "EXPERIMENT_EPOCH_CHANGED");
	assert.equal(f.store.get(a.id).flags.length, 0);
});

test("turning swarm off interrupts helpers but leaves the coordinator running", (t) => {
	const f = fixture(t), a = f.add(); f.swarm.dispatch(f.proposal(a.id, "one"));
	f.config.swarmEnabled = false; f.swarm.tick();
	assert.equal(f.children[1].interrupts, 1); assert.equal(f.children[0].interrupts, 0);
	assert.equal(f.swarm.dispatch(f.proposal(a.id, "two")).code, "SWARM_DISABLED");
});

test("reloaded helper records retain unresolved capacity and do not respawn", (t) => {
	const f = fixture(t), a = f.add(); f.swarm.dispatch(f.proposal(a.id, "one"));
	f.store.transact(a.id, (edit) => edit.updateAttempt(a.attempt.n, { taskId: "persistent-task" }));
	f.reopen(); f.taskRows.push({ taskId: "persistent-task", unresolved: true });
	const restored = createSwarm({ store: f.store, spawn() { assert.fail("must not automatically respawn"); }, timing: () => null, config: () => f.config, tasks: { list: () => f.taskRows } });
	t.after(() => restored.close());
	assert.equal(restored.status({ id: a.id }).rows[0].status, "unknown");
	assert.equal(restored.status({ id: a.id }).occupiedSlots, 1);
	f.taskRows[0].unresolved = false;
	assert.equal(restored.status({ id: a.id }).rows[0].status, "interrupted");
	assert.equal(restored.status({ id: a.id }).occupiedSlots, 0);
});

test("unsupported swarm schema preserves the original state file", (t) => {
	const f = fixture(t), a = f.add(); f.swarm.dispatch(f.proposal(a.id, "one"));
	f.swarm.close(); f.store.close();
	const data = JSON.parse(fs.readFileSync(f.statePath)); data.challenges[a.id].attempts[0].swarmWorkers[0].schema = 999;
	const exact = JSON.stringify(data); fs.writeFileSync(f.statePath, exact);
	assert.throws(() => createStore(f.statePath), { code: "SWARM_FORMAT_INVALID" });
	assert.equal(fs.readFileSync(f.statePath, "utf8"), exact);
});

test("the helper preset has execution tools but no resident dispatcher or native delegation", () => {
	const { definition } = buildHelperPresetDefinition();
	assert.equal(definition.id, "ctf-auto-helper");
	assert.equal(definition.plugins.some((r) => r.id === "delegation"), false);
	assert.equal(definition.plugins.some((r) => r.id === "tool-ask-user"), false);
	assert.ok(definition.plugins.some((r) => r.id === "tool-bash" || r.id === "tool-pwsh"));
	assert.match(definition.plugins.find((r) => r.id === "persona").config.prefix, /单假设/);
	assert.equal(buildSwarmInstructions(false), ""); assert.match(buildSwarmInstructions(true), /证据冲突须复验/);
});

test("a resolved local handler does not release a helper before the remote settlement receipt", async (t) => {
	const f = fixture(t), a = f.add(), input = f.proposal(a.id, "one"); f.swarm.dispatch(input);
	let remoteExit;
	f.children[1].whenSettled = () => new Promise((r) => { remoteExit = r; });
	f.children[1].finish({ stopReason: "error", error: "local session binding failed" }); await drain();
	assert.equal(f.swarm.status({ id: a.id }).rows[0].status, "stopping");
	assert.equal(f.swarm.status({ id: a.id }).occupiedSlots, 1);
	remoteExit(); await drain();
	assert.equal(f.swarm.status({ id: a.id }).rows[0].status, "failed");
	assert.equal(f.swarm.status({ id: a.id }).occupiedSlots, 0);
});

test("invalid coordinator handles retain the original executor uncertainty contract", (t) => {
	const f = fixture(t), a = f.add(); let unknown = 0;
	const bad = createSwarm({ store: f.store, spawn: () => ({}), timing: () => null, config: () => f.config, tasks: { list: () => [] } });
	t.after(() => bad.close());
	assert.throws(() => bad.wrap({ challenge: f.store.get(a.id), attempt: a.attempt, lease: { markUnknown() { unknown++; } } }), /有效完成 Promise/);
	assert.equal(unknown, 1);
});

test("initial config cannot silently remove helper caps or enable swarm with a string", (t) => {
	const f = fixture(t), a = f.add(), input = f.proposal(a.id, "one");
	f.config.swarmEnabled = "false"; assert.equal(f.swarm.dispatch(input).code, "SWARM_DISABLED");
	f.config.swarmEnabled = true; f.config.swarmConcurrency = Infinity; f.config.swarmWorkerTimeoutMs = Infinity;
	assert.equal(f.swarm.status({ id: a.id }).concurrency, 2);
	assert.equal(f.swarm.dispatch(input).worker.timeoutMs, 20000);
});

test("helper usage includes dispatched sessions exactly once and ignores a rejected preflight", () => {
	const runId = crypto.randomUUID(), workerId = crypto.randomUUID();
	const row = { schema: 1, workerId, key: "one", epoch: "a".repeat(64), lane: "offline", status: "completed", artifactDir: `artifacts/swarm/${runId}/${workerId}`,
		sessionId: "worker", experimentVersion: 1, startedAt: 1, timeoutMs: 30000, promptChars: 1200, outputChars: 800, pricePerMToken: 2 };
	assert.deepEqual(swarmUsage({ runId, swarmWorkers: [row] }), { promptChars: 1200, outputChars: 800, estTokens: 500, estCost: 0.001 });
	assert.equal(swarmUsage({ runId, swarmWorkers: [{ ...row, sessionId: "" }] }).estTokens, 0);
});
