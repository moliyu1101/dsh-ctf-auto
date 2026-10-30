import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { host } from "../helpers/host.mjs";

async function until(fn) {
	for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 5)); }
	assert.fail("operation did not settle");
}
async function fixture(t, config = {}, options = {}) {
	const children = new Map(), interrupts = [], messages = [];
	const services = {
		agentPresets: { register: async (definition) => {
			if (definition.id === "ctf-auto-helper" && options.rejectHelperPreset) throw new Error("helper preset registration failed");
			return () => {};
		}, resolve: async () => {}, list: async () => [{ id: "ctf-auto" }] },
		subagents: {
			startActivation(args) {
				const id = `child-${children.size + 1}`; let finish, reject;
				const result = new Promise((r, j) => { finish = r; reject = j; });
				children.set(id, { id, args, finish: (stopReason = "completed", text = "") => finish({ stopReason, output: [{ type: "text", text }] }), reject });
				return { childId: id, result };
			},
			interrupt(id) { interrupts.push(id); },
			sendMessage(_parent, id, content) { messages.push({ id, content }); return Promise.resolve(); }
		}
	};
	const h = await host(t, { autoRetry: false, swarmEnabled: true, ...config }, services);
	t.after(() => { for (const c of children.values()) c.finish("aborted"); });
	const added = await h.post("challenge.add", { title: "Swarm fixture", statement: "Analyse only these test attachments" });
	const detail = async () => (await h.post("challenge.get", { id: added.id })).challenge;
	await h.post("challenge.start", { id: added.id });
	await until(async () => (await detail()).attempts[0]?.sessionId);
	const call = (name, args = {}, id = "child-1") => {
		const child = children.get(id);
		return h.tools.get(name).execute({ id: added.id, ...args }, { agent: { id, session: { header: { origin: "subagent", cwd: child?.args.request.cwd || h.agents[0].session.header.cwd } } } });
	};
	async function proposal(key = "metadata") {
		const recorded = await call("ctf_experiment_record", { key, hypothesis: `Check the ${key} hypothesis`, scope: `Only the ${key} file section`, expectedResult: "An independent deterministic marker appears" });
		assert.equal(recorded.ok, true, JSON.stringify(recorded));
		return { key, expectedVersion: recorded.experiment.version, epoch: recorded.epoch, lane: "offline" };
	}
	async function dispatch(input) {
		const result = await call("ctf_swarm_dispatch", input);
		if (result.ok && !result.deduplicated) await until(async () => (await detail()).swarm.rows.find((r) => r.workerId === result.worker.workerId)?.sessionId);
		return result;
	}
	return { ...h, id: added.id, children, interrupts, messages, detail, call, proposal, dispatch };
}

test("swarm is opt-in and settings persist bounded global capacity", async (t) => {
	const h = await fixture(t, { swarmEnabled: false });
	const input = await h.proposal();
	assert.equal((await h.dispatch(input)).code, "SWARM_DISABLED"); assert.equal(h.children.size, 1);
	const configured = await h.post("config.set", { patch: { swarmEnabled: true, swarmConcurrency: 99, swarmWorkerTimeoutMs: 5 } });
	assert.equal(configured.config.swarmConcurrency, 4); assert.equal(configured.config.swarmWorkerTimeoutMs, 30000);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, "state", "config.json"))).swarmEnabled, true);
	assert.equal((await h.dispatch(input)).ok, true);
});

test("coordinator dispatches distinct experiments, shares lease and preserves its own session", async (t) => {
	const h = await fixture(t), input = await h.proposal();
	assert.match(h.children.get("child-1").args.request.prompt[0].text, /按假设分工的蜂群/);
	const first = await h.dispatch(input); assert.equal(first.ok, true);
	const again = await h.dispatch(input); assert.equal(again.deduplicated, true); assert.equal(h.children.size, 2);
	const second = await h.dispatch(await h.proposal("header")); assert.equal(second.ok, true);
	assert.equal((await h.dispatch(await h.proposal("footer"))).code, "SWARM_CAPACITY");
	const ch = await h.detail(); assert.equal(ch.attempts[0].sessionId, "child-1");
	assert.deepEqual(ch.taskJournal.find((r) => r.kind === "solver").sessionIds.sort(), ["child-1", "child-2", "child-3"]);
	assert.equal(ch.swarm.occupiedSlots, 2);
	assert.equal(h.children.get("child-2").args.request.cwd, path.join(ch.dir, first.worker.artifactDir));
	assert.ok(fs.existsSync(path.join(ch.dir, first.worker.artifactDir, "assignment.txt")));
});

test("helpers publish scoped evidence but cannot judge flags, change definitions, recurse or mutate environments", async (t) => {
	const h = await fixture(t), input = await h.proposal(), dispatched = await h.dispatch(input), prefix = dispatched.worker.artifactDir;
	for (const [name, args, code] of [
		["ctf_swarm_dispatch", input, "SWARM_TOOL_DENIED"],
		["ctf_platform_env", { action: "delete" }, "SWARM_TOOL_DENIED"],
		["ctf_flag_record", { flag: "flag{candidate}", verified: true, evidence: "independent result" }, "SWARM_CANDIDATE_ONLY"],
		["ctf_experiment_record", { key: "unassigned", observedResult: "Claim another task" }, "SWARM_SCOPE_DENIED"],
		["ctf_experiment_record", { key: input.key, hypothesis: "replace task" }, "SWARM_SCOPE_DENIED"],
		["ctf_workbench_write", { path: "notes.md", text: "overwrite shared notes" }, "SWARM_SCOPE_DENIED"],
		["ctf_workbench_write", { path: `${prefix}/../other.txt`, text: "escape" }, "SWARM_SCOPE_DENIED"]
	]) assert.equal((await h.call(name, args, "child-2")).code, code, name);
	assert.equal((await h.call("ctf_workbench_write", { path: `${prefix}/output.txt`, text: "Deterministic marker absent in metadata section" }, "child-2")).ok, true);
	const result = await h.call("ctf_experiment_record", { key: input.key, expectedVersion: 1, epoch: input.epoch, status: "refuted", observedResult: "The metadata section has no expected marker in this input", evidencePaths: [`${prefix}/output.txt`] }, "child-2");
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal((await h.call("ctf_flag_record", { flag: "flag{candidate}", verified: false, evidence: "unverified worker extraction" }, "child-2")).ok, true);
	assert.equal((await h.detail()).flags[0].verified, false);
	h.children.get("child-2").finish("completed", "No matching marker; see output.txt");
	await until(async () => (await h.detail()).swarm.rows[0].status === "completed");
	assert.equal((await h.detail()).status, "running");
	assert.equal((await h.call("ctf_experiment_record", { key: input.key }, "child-2")).code, "STALE_SWARM_WORKER");
	assert.ok(h.messages.some((m) => m.id === "child-1"));
});

test("cancel waits for an executor receipt and does not release the lane or resource early", async (t) => {
	const h = await fixture(t), input = { ...await h.proposal(), lane: "target" };
	const first = await h.dispatch(input);
	const second = { ...await h.proposal("different-path"), lane: "target" };
	assert.equal((await h.dispatch(second)).code, "SWARM_LANE_BUSY");
	await h.post("swarm.cancel", { id: h.id, workerId: first.worker.workerId });
	assert.ok(h.interrupts.includes("child-2"));
	assert.equal((await h.detail()).swarm.rows[0].status, "stopping");
	assert.equal((await h.dispatch(second)).code, "SWARM_LANE_BUSY");
	h.children.get("child-2").finish("aborted");
	await until(async () => (await h.detail()).swarm.occupiedSlots === 0);
	assert.equal((await h.dispatch(second)).ok, true);
	await h.post("challenge.stop", { id: h.id });
	await until(async () => (await h.detail()).attempts[0].finalizedAt);
	assert.equal((await h.detail()).resources.users, 1);
	h.children.get("child-1").finish("aborted");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal((await h.detail()).resources.users, 1, "helper still running after lead ended");
	h.children.get("child-3").finish("aborted");
	await until(async () => (await h.detail()).resources.users === 0);
});

test("coordinator completion stops all helpers; late output cannot write conclusions", async (t) => {
	const h = await fixture(t), input = await h.proposal(); await h.dispatch(input);
	h.children.get("child-1").finish("completed", "Need a new approach");
	await until(() => h.interrupts.includes("child-2"));
	const stale = await h.call("ctf_experiment_record", { key: input.key, expectedVersion: 1, status: "running" }, "child-2");
	assert.equal(stale.code, "STALE_SWARM_WORKER");
	h.children.get("child-2").finish("completed", "flag{late-untrusted-output}");
	await until(async () => (await h.detail()).resources.users === 0);
	const ch = await h.detail(); assert.equal(ch.flags.length, 0); assert.equal(ch.experiments[0].status, "proposed");
	assert.equal(ch.swarm.rows[0].status, "interrupted");
});

test("dispatch requires the live solver identity and rejects old epoch or version", async (t) => {
	const h = await fixture(t), input = await h.proposal();
	assert.equal((await h.dispatch({ ...input, expectedVersion: 99 })).code, "EXPERIMENT_VERSION_CONFLICT");
	assert.equal((await h.dispatch({ ...input, epoch: "old-input" })).code, "EXPERIMENT_EPOCH_CHANGED");
	assert.equal((await h.call("ctf_swarm_dispatch", input, "unbound-child")).code, "SWARM_COORDINATOR_REQUIRED");
	const other = await h.post("swarm.dispatch", { id: h.id, ...input, sessionId: "b" });
	assert.equal(other.ok, false); assert.equal(h.children.size, 1);
});

test("failed durable dispatch never creates an untracked helper", async (t) => {
	const h = await fixture(t), input = await h.proposal(), statePath = path.join(h.root, "state", "state.json");
	const rename = fs.renameSync; let failing = true;
	t.mock.method(fs, "renameSync", (source, destination) => {
		if (String(destination) === statePath && failing) throw Object.assign(new Error("full"), { code: "ENOSPC" });
		return rename(source, destination);
	});
	const result = await h.dispatch(input);
	assert.equal(result.ok, false); assert.equal(h.children.size, 1);
	failing = false; await h.post("state.flush"); h.tick();
	await until(async () => (await h.detail()).swarm.rows[0]?.status === "failed");
	assert.equal(h.children.size, 1);
});

test("unknown helper completion keeps ownership and capacity fenced", async (t) => {
	const h = await fixture(t), input = await h.proposal(); await h.dispatch(input);
	h.children.get("child-2").reject(new Error("provider disconnected"));
	await until(async () => (await h.detail()).swarm.rows[0].status === "unknown");
	const ch = await h.detail(); assert.equal(ch.swarm.occupiedSlots, 1);
	assert.ok(ch.taskJournal.some((r) => r.unresolved));
	assert.equal((await h.call("ctf_experiment_record", { key: input.key }, "child-2")).ok, false);
});

test("helper preset registration failure does not fall back to a full solver", async (t) => {
	const h = await fixture(t, {}, { rejectHelperPreset: true }), input = await h.proposal();
	const result = await h.call("ctf_swarm_dispatch", input); assert.equal(result.ok, true);
	await until(async () => (await h.detail()).swarm.rows[0].status === "failed");
	assert.equal(h.children.size, 1); assert.equal((await h.detail()).swarm.occupiedSlots, 0);
	assert.match((await h.detail()).swarm.rows[0].error, /helper preset registration failed/);
});

test("unbound children cannot use a helper directory to bypass tool permissions", async (t) => {
	const h = await fixture(t), input = await h.proposal(), assigned = await h.dispatch(input), ch = await h.detail();
	const child = { agent: { id: "not-the-assigned-child", session: { header: { origin: "subagent", cwd: path.join(ch.dir, assigned.worker.artifactDir) } } } };
	const result = await h.tools.get("ctf_flag_record").execute({ id: h.id, flag: "flag{wrong}", verified: true, evidence: "fake claim" }, child);
	assert.equal(result.code, "SWARM_WORKER_NOT_BOUND"); assert.equal((await h.detail()).flags.length, 0);
});

test("writeup packages include worker identities and their durable artifact paths", async (t) => {
	const h = await fixture(t), input = await h.proposal(), result = await h.dispatch(input);
	h.children.get("child-2").finish("completed", "See assigned evidence directory");
	await until(async () => (await h.detail()).swarm.rows[0].status === "completed");
	const packed = await h.post("writeup.pack", { id: h.id }); assert.equal(packed.ok, true);
	const exported = JSON.parse(execFileSync("tar", ["-xOzf", packed.path, "swarm.json"], { encoding: "utf8" }));
	assert.equal(exported.schema, 1); assert.equal(exported.rows[0].workerId, result.worker.workerId);
	assert.equal(exported.rows[0].sessionId, "child-2");
	const state = await h.post("state.get");
	assert.ok(state.aggregates.usage.promptChars > (await h.detail()).attempts[0].promptChars, "helper prompt contributes to usage");
});

test("dependency queue uses live evidence and invalidates helper writes after upstream changes", async (t) => {
	const h = await fixture(t), source = await h.proposal("source"); await h.proposal("dependent");
	const plan = await h.call("ctf_experiment_record", { key: "dependent", expectedVersion: 1, epoch: source.epoch, dependsOn: [{ key: "source", status: "supported" }] });
	assert.equal(plan.ok, true);
	const input = { key: "dependent", expectedVersion: plan.experiment.version, epoch: source.epoch, lane: "offline" };
	const queued = await h.call("ctf_swarm_queue", input); assert.equal(queued.ok, true);
	h.tick(); assert.equal(h.children.size, 1); assert.equal((await h.detail()).swarm.queue[0].status, "queued");
	await h.post("workbench.write", { id: h.id, path: "artifacts/source.txt", text: "source marker independently recovered from the original input" });
	const concluded = await h.call("ctf_experiment_record", { key: "source", expectedVersion: 1, epoch: source.epoch, status: "supported", observedResult: "A deterministic source marker has been independently recovered", evidencePaths: ["artifacts/source.txt"] });
	assert.equal(concluded.ok, true); h.tick();
	await until(async () => (await h.detail()).swarm.rows[0]?.sessionId);
	assert.equal(h.children.size, 2); assert.equal((await h.detail()).swarm.queue[0].status, "dispatched");
	await h.post("workbench.write", { id: h.id, path: "artifacts/source.txt", text: "unexpected alteration after dependent task started" });
	const late = await h.call("ctf_experiment_record", { key: "dependent", expectedVersion: plan.experiment.version, status: "running" }, "child-2");
	assert.equal(late.code, "STALE_SWARM_WORKER");
	h.tick(); assert.ok(h.interrupts.includes("child-2"));
});

test("independent verifier evidence needs explicit coordinator adoption and cannot change flag scoring", async (t) => {
	const h = await fixture(t), source = await h.proposal("claim");
	for (const [name, text] of [["original", "original run supports the hypothesis"], ["counter", "counter run contradicts the original result"]])
		await h.post("workbench.write", { id: h.id, path: `artifacts/${name}.txt`, text });
	const concluded = await h.call("ctf_experiment_record", { key: "claim", expectedVersion: 1, epoch: source.epoch, status: "supported", observedResult: "Original deterministic output supports the current hypothesis", evidencePaths: ["artifacts/original.txt"] });
	assert.equal(concluded.ok, true);
	const opened = await h.call("ctf_experiment_review_open", { key: "claim", expectedVersion: concluded.experiment.version, epoch: source.epoch,
		reason: "A counterexample on the same input contradicts the earlier marker", evidencePaths: ["artifacts/counter.txt"] });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((await h.call("ctf_experiment_record", { key: opened.review.key, expectedVersion: 1, status: "running" })).code, "EXPERIMENT_REVIEW_INDEPENDENT_REQUIRED");
	const worker = await h.dispatch({ key: opened.review.key, expectedVersion: 1, epoch: source.epoch, lane: "offline" });
	assert.equal(worker.worker.role, "verifier");
	const proof = worker.worker.artifactDir + "/replay.txt";
	await h.call("ctf_workbench_write", { path: proof, text: "fresh independent replay proves the marker is absent under original conditions" }, "child-2");
	const reviewResult = await h.call("ctf_experiment_record", { key: opened.review.key, expectedVersion: 1, epoch: source.epoch, status: "refuted",
		observedResult: "Independent fresh replay disproves the original marker hypothesis", evidencePaths: [proof] }, "child-2");
	assert.equal(reviewResult.ok, true, JSON.stringify(reviewResult));
	const resolveInput = { key: "claim", expectedVersion: opened.experiment.version, epoch: source.epoch, reviewKey: opened.review.key,
		expectedReviewVersion: reviewResult.experiment.version, reason: "Compared the independent output against both earlier runs and accept the counterexample" };
	assert.equal((await h.call("ctf_experiment_review_resolve", resolveInput, "child-2")).code, "SWARM_TOOL_DENIED");
	assert.equal((await h.detail()).experiments.find((r) => r.key === "claim").status, "supported");
	assert.equal((await h.call("ctf_experiment_review_resolve", resolveInput)).ok, true);
	const ch = await h.detail(); assert.equal(ch.experiments.find((r) => r.key === "claim").status, "refuted");
	assert.equal(ch.status, "running"); assert.equal(ch.flags.length, 0);
	h.tick(); assert.ok(h.interrupts.includes("child-2"));
});

test("only the bound coordinator can queue or initiate dispute review, and cancelled queues stay stopped", async (t) => {
	const h = await fixture(t), source = await h.proposal("source"); await h.proposal("later");
	const dep = await h.call("ctf_experiment_record", { key: "later", expectedVersion: 1, dependsOn: [{ key: "source", status: "supported" }] });
	const queuedInput = { key: "later", expectedVersion: dep.experiment.version, epoch: source.epoch, lane: "offline" };
	assert.equal((await h.call("ctf_swarm_queue", queuedInput, "unbound-child")).code, "SWARM_COORDINATOR_REQUIRED");
	const queued = await h.call("ctf_swarm_queue", queuedInput); assert.equal(queued.ok, true);
	const denied = await h.post("swarm.cancel", { id: h.id, queueId: queued.queued.queueId, sessionId: "b" }); assert.equal(denied.ok, false);
	assert.equal((await h.call("ctf_swarm_cancel", { queueId: queued.queued.queueId })).ok, true);
	h.tick(); assert.equal((await h.detail()).swarm.queue[0].status, "cancelled"); assert.equal(h.children.size, 1);
});
