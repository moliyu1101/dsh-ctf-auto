import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStore } from "../../lib/store.js";
import { createExperiments, experimentEpoch } from "../../lib/experiments.js";
import { createExperimentReviews } from "../../lib/experiment-reviews.js";
import { createSwarm } from "../../lib/swarm.js";
import { prerequisiteState } from "../../lib/experiment-graph.js";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-experiment-graph-")), file = path.join(root, "state.json");
	const store = createStore(file, { rootDir: root }), added = store.addChallenge({ title: "Graph fixture", statement: "test-only local input" });
	fs.mkdirSync(path.join(added.dir, "artifacts"), { recursive: true });
	store.addAttempt(added.id, { runId: crypto.randomUUID() }); store.setStatus(added.id, "running");
	const experiments = createExperiments({ store }), reviews = createExperimentReviews({ store }), handles = [], config = { swarmEnabled: true, swarmConcurrency: 2, swarmWorkerTimeoutMs: 60000 };
	const ch = () => store.get(added.id), current = (key) => ch().experiments.find((r) => r.key === key && r.epoch === experimentEpoch(ch()));
	const swarm = createSwarm({ store, tasks: { list: () => [] }, timing: () => ({ runId: ch().attempts.at(-1).runId, remainingMs: 300000 }), config: () => config,
		spawn(request) { let finish; const h = { request, done: new Promise((r) => { finish = r; }), finish: () => finish({ stopReason: "completed", outputText: "done" }), interrupts: 0, interrupt() { this.interrupts++; }, send() {} }; handles.push(h); return h; } });
	swarm.wrap({ challenge: ch(), attempt: ch().attempts.at(-1), prompt: "coordinate tests", lease: { isCurrent: () => true } });
	t.after(() => { swarm.close(); for (const h of handles) h.finish(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
	const base = (key) => ({ id: added.id, key, epoch: experimentEpoch(ch()), expectedVersion: current(key)?.version || 0 });
	function propose(key, dependsOn = []) { return experiments.record({ ...base(key), hypothesis: `Hypothesis ${key}`, scope: `input ${key}`, expectedResult: "deterministic observable marker", dependsOn }); }
	function artifact(name, text = name + " independent output") { const rel = "artifacts/" + name; fs.writeFileSync(path.join(added.dir, rel), text); return rel; }
	function conclude(key, status = "supported", evidence = artifact(key + ".txt")) { return experiments.record({ ...base(key), status, evidencePaths: [evidence], observedResult: "Independent reproducible output for hypothesis " + key }); }
	const dispatchInput = (key) => ({ ...base(key), lane: "offline" });
	function open(key = "a") { return reviews.open({ ...base(key), reason: "Counterexample output contradicts this conclusion on the same input", evidencePaths: [artifact(key + "-counter.txt")] }); }
	function resolve(opened, reason = "Independent replay establishes the result and compares both earlier outputs") {
		return reviews.resolve({ ...base(opened.experiment.key), reviewKey: opened.review.key, expectedReviewVersion: current(opened.review.key).version, reason });
	}
	return { root, file, store, id: added.id, ch, current, experiments, reviews, swarm, handles, config, base, propose, artifact, conclude, dispatchInput, open, resolve };
}

test("experiment dependencies reject missing sources, self references and cycles", (t) => {
	const f = fixture(t); assert.equal(f.propose("a").ok, true);
	assert.equal(f.propose("b", [{ key: "a", status: "supported" }]).ok, true);
	assert.equal(f.experiments.record({ ...f.base("a"), dependsOn: [{ key: "b", status: "supported" }] }).code, "EXPERIMENT_GRAPH_INVALID");
	assert.equal(f.propose("self", [{ key: "self", status: "supported" }]).code, "EXPERIMENT_GRAPH_INVALID");
	assert.equal(f.propose("missing", [{ key: "old-epoch", status: "supported" }]).code, "EXPERIMENT_GRAPH_INVALID");
	assert.equal(f.ch().experiments.length, 2);
});

test("dependent conclusions and dispatch require matching outcomes and intact evidence", (t) => {
	const f = fixture(t); f.propose("a"); f.propose("b", [{ key: "a", status: "supported" }]);
	assert.equal(f.swarm.dispatch(f.dispatchInput("b")).code, "SWARM_PREREQUISITES_NOT_READY");
	assert.equal(f.conclude("b").code, "EXPERIMENT_PREREQUISITES_NOT_READY");
	assert.equal(f.conclude("a").ok, true);
	fs.writeFileSync(path.join(f.ch().dir, "artifacts/a.txt"), "modified upstream evidence");
	assert.equal(f.swarm.dispatch(f.dispatchInput("b")).code, "SWARM_PREREQUISITES_NOT_READY");
	assert.equal(f.experiments.record({ ...f.base("b"), status: "running" }).code, "EXPERIMENT_PREREQUISITES_NOT_READY");
});

test("ready queue dispatches once and snapshots the exact prerequisite versions and hashes", (t) => {
	const f = fixture(t); f.propose("a"); f.propose("b", [{ key: "a", status: "supported" }]);
	const queued = f.swarm.queue(f.dispatchInput("b")); assert.equal(queued.ok, true); assert.equal(f.handles.length, 1);
	assert.equal(f.swarm.queue(f.dispatchInput("b")).deduplicated, true);
	f.conclude("a"); f.swarm.tick(); assert.equal(f.handles.length, 2);
	f.swarm.tick(); assert.equal(f.handles.length, 2);
	const worker = f.swarm.status({ id: f.id }).rows[0]; assert.equal(worker.prerequisites[0].version, f.current("a").version);
	assert.equal(worker.prerequisites[0].evidence[0].sha256, f.current("a").evidence[0].sha256);
	assert.equal(f.swarm.status({ id: f.id }).queue[0].status, "dispatched");
	fs.writeFileSync(path.join(f.ch().dir, "artifacts/a.txt"), "changed after dependent started"); f.swarm.tick();
	assert.equal(f.handles[1].interrupts, 1);
	assert.equal(f.conclude("b").code, "EXPERIMENT_PREREQUISITES_NOT_READY");
});

test("queued definitions are version-bound and cancelled rather than revived after parent stops", (t) => {
	const f = fixture(t); f.propose("a"); f.propose("b", [{ key: "a", status: "supported" }]); f.swarm.queue(f.dispatchInput("b"));
	f.experiments.record({ ...f.base("b"), nextStep: "change the planned experiment before running" }); f.swarm.tick();
	assert.equal(f.swarm.status({ id: f.id }).queue[0].status, "invalidated");
	f.propose("c", [{ key: "a", status: "supported" }]); f.swarm.queue(f.dispatchInput("c"));
	f.store.setStatus(f.id, "stopped"); f.swarm.tick(); f.conclude("a"); f.swarm.tick();
	assert.equal(f.swarm.status({ id: f.id }).queue[1].status, "cancelled"); assert.equal(f.handles.length, 1);
});

test("a conflict requires new evidence, freezes the source and creates one independent review", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); f.propose("b", [{ key: "a", status: "supported" }]);
	assert.equal(f.reviews.open({ ...f.base("a"), reason: "A real discrepancy must have different evidence", evidencePaths: ["artifacts/a.txt"] }).code, "EXPERIMENT_REVIEW_EVIDENCE_REQUIRED");
	const opened = f.open(); assert.equal(opened.ok, true);
	assert.equal(f.open().deduplicated, true); assert.equal(f.ch().experiments.length, 3);
	assert.equal(f.experiments.record({ ...f.base("a"), nextStep: "bypass dispute" }).code, "EXPERIMENT_CONTESTED");
	assert.equal(prerequisiteState(f.ch(), f.current("b")).ready, false);
	const dispatched = f.swarm.dispatch(f.dispatchInput(opened.review.key)); assert.equal(dispatched.ok, true); assert.equal(dispatched.worker.role, "verifier");
	assert.match(f.handles[1].request.prompt, /不要照抄任何一方结论/);
});

test("independent contrary evidence is adopted atomically without marking the challenge solved", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); const opened = f.open();
	assert.equal(f.conclude(opened.review.key, "refuted", f.artifact("third-party-replay.txt", "replay confirms the hypothesis does not hold")).ok, true);
	const accepted = f.resolve(opened); assert.equal(accepted.ok, true, JSON.stringify(accepted));
	assert.equal(f.current("a").status, "refuted"); assert.equal(f.current("a").conflicts[0].decision, "overturned");
	assert.equal(f.current("a").history.at(-1).status, "supported"); assert.equal(f.ch().flags.length, 0); assert.equal(f.ch().status, "running");
	assert.equal(f.resolve(opened).deduplicated, true);
	const disk = JSON.parse(fs.readFileSync(f.file)); assert.equal(disk.challenges[f.id].experiments.find((r) => r.key === "a").status, "refuted");
});

test("copied evidence and inconclusive results cannot clear a dispute", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); const opened = f.open();
	assert.equal(f.experiments.record({ ...f.base(opened.review.key), status: "blocked", observedResult: "Independent replay requires a missing local dependency" }).ok, true);
	assert.equal(f.resolve(opened).code, "EXPERIMENT_REVIEW_NOT_CONCLUSIVE");
	const copy = f.artifact("copied.txt", fs.readFileSync(path.join(f.ch().dir, "artifacts/a.txt"), "utf8"));
	assert.equal(f.experiments.record({ ...f.base(opened.review.key), status: "supported", reopenReason: "New environment provides the missing test dependency", observedResult: "Copied the earlier output without independent execution", evidencePaths: [copy] }).ok, true);
	assert.equal(f.resolve(opened).code, "EXPERIMENT_REVIEW_EVIDENCE_REQUIRED");
	assert.equal(f.current("a").conflicts[0].phase, "open");
});

test("review adoption rejects stale versions and changed evidence", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); const opened = f.open();
	f.conclude(opened.review.key, "supported", f.artifact("independent.txt"));
	const stale = f.reviews.resolve({ ...f.base("a"), expectedVersion: 1, reviewKey: opened.review.key, expectedReviewVersion: 2, reason: "Independent output validates the earlier claim" });
	assert.equal(stale.code, "EXPERIMENT_VERSION_CONFLICT");
	fs.writeFileSync(path.join(f.ch().dir, "artifacts/independent.txt"), "modified");
	assert.equal(f.resolve(opened).code, "EXPERIMENT_REVIEW_EVIDENCE_REQUIRED");
	assert.equal(f.current("a").conflicts[0].phase, "open");
});

test("dependency pins and transitive prerequisites remain enforced", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); const version = f.current("a").version;
	f.propose("b", [{ key: "a", status: "supported", version }]); f.conclude("b");
	f.propose("c", [{ key: "b", status: "supported" }]);
	f.experiments.record({ ...f.base("a"), nextStep: "new checkpoint changes the referenced version" });
	assert.equal(f.swarm.dispatch(f.dispatchInput("c")).code, "SWARM_PREREQUISITES_NOT_READY");
});

test("unpinned downstream conclusions still preserve the versions used to produce their evidence", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); f.propose("b", [{ key: "a", status: "supported" }]); f.conclude("b");
	f.propose("c", [{ key: "b", status: "supported" }]);
	f.experiments.record({ ...f.base("a"), nextStep: "this source has advanced to a new version" });
	assert.equal(f.swarm.dispatch(f.dispatchInput("c")).code, "SWARM_PREREQUISITES_NOT_READY");
	assert.equal(f.conclude("b", "supported", f.artifact("new-b.txt")).code, "EXPERIMENT_NEW_EVIDENCE_REQUIRED");
	const replay = f.experiments.record({ ...f.base("b"), status: "supported", observedResult: "Fresh replay against the latest upstream checkpoint establishes the same result", evidencePaths: ["artifacts/new-b.txt"], reopenReason: "The upstream checkpoint changed; reran the dependent step with new evidence" });
	assert.equal(replay.ok, true); assert.equal(f.swarm.dispatch(f.dispatchInput("c")).ok, true);
});

test("a queued task already dispatched must be cancelled through its actual worker identity", (t) => {
	const f = fixture(t); f.propose("a"); const queued = f.swarm.queue(f.dispatchInput("a"));
	assert.equal(queued.queued.status, "dispatched");
	const result = f.swarm.cancel({ id: f.id, queueId: queued.queued.queueId });
	assert.equal(result.code, "SWARM_QUEUE_ALREADY_DISPATCHED"); assert.ok(result.workerId);
	assert.equal(f.handles[1].interrupts, 0);
	assert.equal(f.swarm.cancel({ id: f.id, workerId: result.workerId }).ok, true); assert.equal(f.handles[1].interrupts, 1);
});

test("review adoption uses its freshly reproduced prerequisite proof after an upstream version advances", (t) => {
	const f = fixture(t); f.propose("parent"); f.conclude("parent"); f.propose("a", [{ key: "parent", status: "supported" }]); f.conclude("a");
	const opened = f.open();
	f.experiments.record({ ...f.base("parent"), nextStep: "an additional upstream checkpoint was saved" });
	assert.equal(f.conclude(opened.review.key, "supported", f.artifact("fresh-current-proof.txt")).ok, true);
	assert.equal(f.resolve(opened).ok, true);
	assert.equal(f.current("a").prerequisiteProof[0].version, f.current("parent").version);
});

test("review creation is one durable transaction even if saving the state fails", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a");
	const rename = fs.renameSync; let failing = true;
	t.mock.method(fs, "renameSync", (from, to) => { if (String(to) === f.file && failing) throw Object.assign(new Error("full"), { code: "ENOSPC" }); return rename(from, to); });
	const result = f.open(); assert.equal(result.ok, false); assert.equal(result.applied, true);
	assert.equal(f.current("a").conflicts.length, 1); assert.equal(f.ch().experiments.length, 2);
	let disk = JSON.parse(fs.readFileSync(f.file)); assert.equal(disk.challenges[f.id].experiments.length, 1);
	failing = false; assert.equal(f.store.save(), true);
	disk = JSON.parse(fs.readFileSync(f.file)); assert.equal(disk.challenges[f.id].experiments.length, 2);
	assert.equal(disk.challenges[f.id].experiments[0].conflicts[0].reviewKey, disk.challenges[f.id].experiments[1].key);
});

test("restart preserves disputes and dependencies but never resumes an old queued intent", (t) => {
	const f = fixture(t); f.propose("a"); f.conclude("a"); const opened = f.open();
	f.propose("b", [{ key: "a", status: "supported" }]); f.swarm.queue(f.dispatchInput("b"));
	f.store.close(); const loaded = createStore(f.file, { rootDir: f.root }); t.after(() => loaded.close());
	const restored = createSwarm({ store: loaded, spawn() { assert.fail("old queues must not spawn on restart"); }, timing: () => null, config: () => f.config, tasks: { list: () => [] } });
	t.after(() => restored.close());
	const source = loaded.get(f.id).experiments.find((r) => r.key === "a"); assert.equal(source.conflicts[0].phase, "open");
	assert.ok(loaded.get(f.id).experiments.some((r) => r.key === opened.review.key));
	assert.equal(restored.status({ id: f.id }).queue[0].status, "cancelled"); restored.tick();
});

test("a malformed persisted dependency graph is preserved for repair rather than reset", (t) => {
	const f = fixture(t); f.propose("a"); f.swarm.close(); f.store.close();
	const data = JSON.parse(fs.readFileSync(f.file)); data.challenges[f.id].experiments[0].dependsOn = [{ key: "a", status: "supported" }];
	const exact = JSON.stringify(data); fs.writeFileSync(f.file, exact);
	assert.throws(() => createStore(f.file), { code: "EXPERIMENT_GRAPH_INVALID" });
	assert.equal(fs.readFileSync(f.file, "utf8"), exact);
});
