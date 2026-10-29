import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host } from "../helpers/host.mjs";
import { createStore } from "../../lib/store.js";
import { createPlatformOperations } from "../../lib/platform-operations.js";
import { createPlatformEnvironments } from "../../lib/platform-environments.js";
import { createChallengeResources, challengeResourceKey } from "../../lib/challenge-resources.js";
import { createTaskRegistry } from "../../lib/task-registry.js";
import { createOrchestrator } from "../../lib/orchestrator.js";
import { progressStamp, observeProgress } from "../../lib/progress-watchdog.js";
import { submissionStatus, submissionDiagnostic } from "../../lib/platform-result.js";
import { jsonOutput } from "../../lib/json-output.js";
import { buildAttemptPrompt } from "../../lib/prompt.js";
import { repairFlagHistory } from "../../lib/flag-recovery.js";
import { flagCandidates } from "../../lib/flag-candidates.js";

const json = (body) => new Response(JSON.stringify(body));
async function until(fn) {
	for (let n = 0; n < 150; n++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 10)); }
	assert.fail("operation did not finish");
}
async function platform(t, { wrapper, auto = true } = {}) {
	const h = await host(t, { autoSubmitEnabled: auto });
	let reply = () => ({ status: "incorrect" });
	h.setRemote((url, init) => {
		if (url.endsWith("/submit")) return json({ data: reply(JSON.parse(init.body).flag) });
		return json({ data: url.endsWith("/api/challenges") ? [{ id: "1", name: "snake" }] : { id: "1", name: "snake", description: "fixture" } });
	});
	await h.post("platform.config.set", { kind: "generic", baseUrl: "https://fixture.test", apiToken: "fixture", flagWrapper: wrapper });
	const id = (await h.post("platform.import", { ids: ["1"], start: false })).created[0].localId;
	return { ...h, id, detail: async () => (await h.post("challenge.get", { id })).challenge,
		setReply(fn) { reply = fn; }, submissions: () => h.requests.filter((r) => r.url.endsWith("/submit")).map((r) => JSON.parse(r.init.body).flag) };
}
const local = (id, flag = "CTF{serpent_cipher}") => ({ id, flag, verified: true, method: "local-check", evidence: "independent decrypt script output matches the candidate" });

test("A1/A3/C10: local platform proof is a candidate; incorrect revokes it and has a diagnostic", async (t) => {
	const h = await platform(t, { auto: false });
	const recorded = await h.post("flag.record", local(h.id));
	assert.equal(recorded.verified, false);
	assert.notEqual((await h.detail()).status, "solved");
	assert.equal(fs.existsSync(path.join((await h.detail()).dir, "flag.json")), false);
	const response = await h.post("platform.submit", { id: h.id, flag: "CTF{serpent_cipher}" });
	assert.equal(response.status, "incorrect");
	const ch = await h.detail();
	assert.notEqual(ch.status, "solved");
	assert.equal(ch.flags[0].rejected, true);
	assert.equal(ch.flags[0].verified, false);
	assert.ok(ch.events.some((event) => event.kind === "flag-rejected"));
	assert.ok(ch.events.some((event) => /平台提交（incorrect）：平台回显 incorrect/.test(event.text)));
	assert.equal(ch.submissionJournal[0].applied, true);
});

test("A2/A3: original then normalized wrapper succeeds, leaving one authoritative flag", async (t) => {
	const h = await platform(t, { wrapper: "flag" });
	h.setReply((flag) => ({ status: flag === "flag{serpent_cipher}" ? "correct" : "incorrect" }));
	await h.post("flag.record", local(h.id));
	await until(async () => (await h.detail()).platformSubmit?.status === "correct");
	const ch = await h.detail();
	assert.equal(ch.status, "solved");
	assert.deepEqual(h.submissions(), ["CTF{serpent_cipher}", "flag{serpent_cipher}"]);
	assert.equal(ch.flags.length, 1);
	assert.equal(ch.flags[0].value, "flag{serpent_cipher}");
	assert.equal(ch.flags[0].method, "platform");
	assert.equal(ch.flags[0].verified, true);
	assert.equal(ch.flags[0].rejected, false);
	assert.equal(ch.submissionJournal.length, 2);
	assert.ok(ch.submissionJournal.every((entry) => entry.applied));
});

test("A2: normalization is bounded and stops on a rate limit or unknown response", async (t) => {
	for (const status of ["ratelimited", "unknown"]) {
		await t.test(status, async (t) => {
			const h = await platform(t, { wrapper: "flag", auto: false });
			h.setReply(() => ({ status }));
			const response = await h.post("platform.submit", { id: h.id, flag: "CTF{serpent_cipher}" });
			assert.equal(response.status, status);
			assert.equal(h.submissions().length, 1);
		});
	}
	assert.deepEqual(flagCandidates("flag{CTF{serpent_cipher}}", "flag"), ["flag{CTF{serpent_cipher}}", "flag{serpent_cipher}", "serpent_cipher"]);
});

test("A1: a platform rejection revokes even independently reviewed local proof", async (t) => {
	const services = { agentPresets: { register: async () => () => {}, resolve: async () => {}, list: async () => [{ id: "ctf-auto" }] },
		subagents: { startActivation() { return { childId: "review", result: Promise.resolve({ output: [{ type: "text", text: "REVIEW: VERIFIED\nchecker reproduced the candidate" }], stopReason: "completed" }) }; }, interrupt() {} } };
	// Use the shared host with an explicit review to test the real public command path.
	const h = await host(t, { autoSubmitEnabled: false }, services);
	h.setRemote((url) => json({ data: url.endsWith("/api/challenges") ? [{ id: "1", name: "snake" }] : url.endsWith("/submit") ? { status: "incorrect" } : { id: "1", name: "snake", description: "fixture" } }));
	await h.post("platform.config.set", { kind: "generic", baseUrl: "https://fixture.test", apiToken: "fixture" });
	const id = (await h.post("platform.import", { ids: ["1"], start: false })).created[0].localId;
	await h.post("flag.record", local(id));
	assert.equal((await h.post("flag.review", { id })).status, "verified");
	assert.equal((await h.post("challenge.get", { id })).challenge.status, "solved");
	await until(async () => !(await h.post("task.list", { id })).tasks.some((row) => row.unresolved));
	await h.post("platform.submit", { id, flag: "CTF{serpent_cipher}" });
	const ch = (await h.post("challenge.get", { id })).challenge;
	assert.equal(ch.status, "stuck");
	assert.equal(ch.flags[0].verified, false);
	assert.equal(fs.existsSync(path.join(ch.dir, "flag.json")), false);
});

function environmentFixture(t, respond) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-field-environment-"));
	const store = createStore(path.join(root, "state.json"), { rootDir: root });
	const ch = store.addChallenge({ title: "container", platform: { kind: "dasctf", baseUrl: "https://fixture.test", challengeId: "1" }, status: "stopped" });
	const tasks = createTaskRegistry({ store }); tasks.tick();
	const resources = createChallengeResources({ tasks, blocked: (ch) => ch.environmentJournal?.some((row) => ["prepared", "sending", "unknown"].includes(row.phase)) });
	const calls = [], operations = createPlatformOperations();
	const connection = { sessionKey: "fixture-session", credentialKey: "fixture-credential", capabilities: { environment: true }, client: { async environment(action) { calls.push(action); return respond(action); } } };
	const service = createPlatformEnvironments({ store, resources, platforms: { operations, forChallenge: () => connection }, canAutoCleanup: () => true });
	t.after(() => { service.close(); tasks.close(); resources.close(); operations.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
	function seed({ action = "start", phase = "unknown", sessionIds = [], completed = false, credential = connection.credentialKey } = {}) {
		const at = Date.now();
		store.update(ch.id, { taskJournal: [{ version: 1, taskId: "old-task", ownerId: "previous-instance", resourceKey: challengeResourceKey(ch), kind: "environment", mode: action === "delete" ? "cleanup" : "use", phase, createdAt: at, heartbeatAt: at, expiresAt: at, startedAt: at, sessionIds,
			reference: { operationId: "old-operation", action } }], environmentJournal: [{ operationId: "old-operation", taskId: "old-task", action, credentialKey: credential, phase: completed ? "completed" : "unknown",
			...(completed ? { resolution: { observed: action === "delete" ? "absent" : "present", at } } : {}) }] });
	}
	return { store, ch, tasks, resources, service, calls, seed };
}

test("B4/B5: startup automatically reconciles an old unknown start and releases its task fence", async (t) => {
	const f = environmentFixture(t, () => ({ ok: true, environment: { status: "running", environment_id: "env" } }));
	f.seed(); assert.equal(f.resources.acquire(f.store.get(f.ch.id), "submission").ok, false);
	f.service.recover();
	await until(() => f.store.get(f.ch.id).taskJournal[0].phase === "acknowledged");
	assert.equal(f.store.get(f.ch.id).environmentJournal[0].phase, "completed");
	assert.deepEqual(f.calls, ["status"]);
	const lease = f.resources.acquire(f.store.get(f.ch.id), "submission"); assert.equal(lease.ok, true); lease.release();
});

test("B5: repair a completed environment journal with a still-unknown task", (t) => {
	const f = environmentFixture(t, () => { throw new Error("must not issue a new remote operation"); });
	f.seed({ completed: true }); f.service.recover();
	assert.equal(f.store.get(f.ch.id).taskJournal[0].phase, "acknowledged");
	assert.deepEqual(f.calls, []);
});

test("B4: conflicting observation and mismatching credentials retain the resource fence", async (t) => {
	for (const options of [{}, { credential: "other-account" }, { sessionIds: ["still-needs-session-check"] }]) {
		await t.test(JSON.stringify(options), async (t) => {
			const f = environmentFixture(t, () => ({ ok: true, environment: { status: options.sessionIds ? "running" : "deleted" } }));
			f.seed(options);
			await f.service.operate({ id: f.ch.id, action: "status" });
			assert.equal(f.store.get(f.ch.id).taskJournal[0].phase, "unknown");
			assert.equal(f.resources.acquire(f.store.get(f.ch.id), "submission").ok, false);
		});
	}
});

test("B6: unknown delete is checked once and both journals settle when absence is observed", async (t) => {
	const f = environmentFixture(t, (action) => action === "delete" ? { ok: false, code: "timeout", outcomeUnknown: true } : { ok: true, environment: { status: "deleted" } });
	const result = await f.service.operate({ id: f.ch.id, action: "delete" });
	assert.equal(result.ok, true); assert.equal(result.reconciled, true);
	assert.deepEqual(f.calls, ["delete", "status"]);
	assert.equal(f.store.get(f.ch.id).environmentJournal[0].phase, "completed");
	assert.equal(f.tasks.list(f.ch.id)[0].unresolved, false);
	assert.equal(f.store.get(f.ch.id).environment.status, "deleted");
});

test("C9: JSON output preserves finite nested data and removes undefined/nonfinite values", () => {
	assert.deepEqual(jsonOutput({ remainingMs: Infinity, other: NaN, missing: undefined, items: [undefined, -Infinity, 5], big: 1n }), { remainingMs: null, other: null, items: [null, null, 5], big: "1" });
});

test("C11: watchdog ignores its own warning, observes notes/scripts and resets after progress", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-field-progress-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const ch = { dir: root, facts: [], events: [] }, state = { stamp: progressStamp(ch), lastProgressMono: 0 };
	assert.equal(observeProgress(state, progressStamp(ch), 300000, 300000), "warn");
	ch.events.push({ kind: "watchdog", at: 300000, text: "warning" });
	assert.equal(observeProgress(state, progressStamp(ch), 600000, 300000), "stop");
	fs.writeFileSync(path.join(root, "notes.md"), "new reproducible fact");
	assert.equal(observeProgress(state, progressStamp(ch), 600001, 300000), null);
	ch.facts.push({ at: 600002, text: "hypothesis disproved" });
	assert.equal(observeProgress(state, progressStamp(ch), 900001, 300000), null);
});

test("B7/C8/C11/D13: user stop, verified stop, idle retry and estimated queue use real lifecycle transitions", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-field-orch-"));
	let mono = 0;
	const store = createStore(path.join(root, "state.json"), { rootDir: root });
	const handles = [];
	const orch = createOrchestrator({ store, monotonicNow: () => mono, config: { concurrency: 1, idleTimeoutMs: 1000, timeoutMs: 100000, autoRetry: true, maxAttempts: 2 }, spawn() {
		let finish; const done = new Promise((resolve) => { finish = resolve; });
		const h = { done, send: () => Promise.resolve(true), interrupt: () => finish({ stopReason: "aborted" }) }; handles.push(h); return h;
	} });
	t.after(() => { orch.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
	const a = store.addChallenge({ title: "first" }), b = store.addChallenge({ title: "queued" });
	orch.start(a.id); await until(() => handles.length === 1); orch.start(b.id);
	assert.ok(orch.snapshot().queued[0].estimatedWaitMs > 0);
	assert.match(orch.stop(a.id).message, /可手动重试/);
	await until(() => store.get(a.id).attempts[0].finalizedAt != null);
	assert.equal(store.get(a.id).status, "stopped");
	assert.equal(store.get(a.id).attempts[0].stopReason, "stopped-by-user");
	await until(() => handles.length === 2);
	store.addFlag(b.id, { value: "CTF{confirmed}", verified: true, method: "platform" }); orch.abortAfterVerifiedFlag(b.id);
	await orch.whenIdle();
	assert.equal(store.get(b.id).attempts[0].status, "completed");
	assert.equal(store.get(b.id).attempts[0].stopReason, "verified-stop");
	assert.doesNotMatch(store.get(b.id).attempts[0].summary, /未取得/);
	const c = store.addChallenge({ title: "stalled" }); orch.start(c.id); await until(() => handles.length === 3);
	mono += 1100; orch.tick(); // first tick observes dispatch-side progress
	mono += 1100; orch.tick();
	assert.ok(store.get(c.id).events.some((event) => event.kind === "watchdog"));
	mono += 1100; orch.tick();
	await until(() => handles.length === 4);
	assert.equal(store.get(c.id).attempts[0].stopReason, "stalled");
	assert.match(store.get(c.id).attempts[0].error, /无事实/);
});


test("startup migration repairs old false solved flags and contradictory attempts without losing history", () => {
	const ch = { platform: {}, status: "solved", flags: [{ value: "CTF{wrong}", verified: true, method: "local-check", recordedAt: 15, attempt: 1 }],
		attempts: [], events: [], facts: [], platformSubmit: { flag: "CTF{wrong}", status: "incorrect", at: 20 } };
	assert.equal(repairFlagHistory(ch).downgraded, true);
	assert.equal(ch.status, "stuck"); assert.equal(ch.flags[0].verified, false); assert.equal(ch.flags[0].rejected, true);
	assert.equal(repairFlagHistory(ch).changed, false);
	ch.flags.push({ value: "flag{wrong}", verified: true, method: "platform", recordedAt: 30, verifiedAt: 30, attempt: 2 });
	ch.attempts.push({ n: 2, startedAt: 25, endedAt: 35, status: "aborted", summary: "本次尝试被中止，未取得可验证结果" });
	ch.events.push({ kind: "attempt-end", attempt: 2, text: "未取得可验证结果" });
	assert.equal(repairFlagHistory(ch).repairedAttempts, 1);
	assert.equal(ch.flags.length, 1); assert.equal(ch.flags[0].method, "platform");
	assert.equal(ch.attempts[0].status, "completed"); assert.match(ch.attempts[0].summary, /已验证/);
	assert.doesNotMatch(ch.events[0].text, /未取得/);
	assert.equal(repairFlagHistory(ch).changed, false);
});

test("D12: retry prompt explicitly carries prior candidates, rejection responses and notes-first instructions", () => {
	const prompt = buildAttemptPrompt({ challenge: { title: "snake", flags: [{ value: "CTF{rejected}", rejected: true, rejectionReason: "incorrect" }],
		submissionJournal: [{ flag: "CTF{rejected}", result: { status: "incorrect", message: "bad wrapper" } }] }, attempt: { n: 2 }, priorAttempts: [{ n: 1, summary: "candidate rejected" }] });
	assert.match(prompt, /必须先读 `notes.md`/); assert.match(prompt, /CTF\{rejected\}/); assert.match(prompt, /平台已拒绝/); assert.match(prompt, /bad wrapper/);
});

test("flag proof metadata and stalled attempts survive a store restart", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-field-restart-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const file = path.join(root, "state.json");
	const first = createStore(file, { rootDir: root });
	const ch = first.addChallenge({ title: "restart" });
	first.transact(ch.id, (edit) => { edit.addFlag({ value: "CTF{candidate}", verified: false, localVerified: true }); edit.addAttempt(); edit.endAttempt(1, { status: "stalled", stopReason: "stalled" }); });
	first.close();
	const second = createStore(file, { rootDir: root }); t.after(() => second.close());
	assert.equal(second.get(ch.id).flags[0].localVerified, true);
	assert.equal(second.get(ch.id).attempts[0].status, "stalled");
});


test("C10/A2: preserve useful response codes and keep ambiguous DASCTF replies unknown", () => {
	assert.equal(submissionStatus({ success: true }), "unknown");
	assert.equal(submissionStatus({ status: "server_error" }), "server_error");
	assert.equal(submissionStatus({ correct: false }), "incorrect");
	const diagnostic = submissionDiagnostic({ data: { raw: { correct: false, code: "FLAG_FORMAT", token: "must-not-export", status: "incorrect" } }, httpStatus: 200 });
	assert.deepEqual(diagnostic, { httpStatus: 200, code: "FLAG_FORMAT", rawStatus: "incorrect", correct: false });
	assert.deepEqual(flagCandidates("team{cipher}", "team"), ["team{cipher}", "cipher"]);
});


test("history repair does not attribute a later platform acceptance to an earlier aborted attempt", () => {
	const ch = { platform: {}, status: "solved", flags: [{ value: "flag{late}", method: "platform", verified: true, recordedAt: 10, verifiedAt: 40, attempt: 1 }],
		attempts: [{ n: 1, status: "aborted", startedAt: 5, endedAt: 20, summary: "aborted" }] };
	assert.equal(repairFlagHistory(ch).repairedAttempts, 0);
	assert.equal(ch.attempts[0].status, "aborted");
});


test("B5: a crash after a definitive environment response also releases the old task", (t) => {
	const f = environmentFixture(t, () => { throw new Error("a definitive checkpoint needs no network replay"); });
	f.seed({ completed: true });
	f.store.transact(f.ch.id, (_edit, draft) => { delete draft.environmentJournal[0].resolution; draft.environmentJournal[0].result = { ok: true, outcomeUnknown: false }; });
	f.service.recover();
	assert.equal(f.store.get(f.ch.id).taskJournal[0].phase, "acknowledged");
	assert.deepEqual(f.calls, []);
});

test("A2/C10: DASCTF defaults to flag wrapper and retains boolean/code diagnostics", async (t) => {
	const h = await host(t);
	const submitted = [];
	h.setRemote((_url, init) => {
		const body = JSON.parse(init.body), name = body.params?.name;
		let data;
		if (name === "ctf2_agent_next_challenges") data = { items: [{ id: "1", name: "snake", practice_ground_id: "g" }] };
		else if (name === "ctf2_submit_flag") {
			const flag = body.params.arguments.flag; submitted.push(flag);
			data = { correct: flag === "flag{serpent_cipher}", code: "FLAG_CHECK" };
		} else data = { challenge: { id: "1", name: "snake", description: "fixture" } };
		return new Response(JSON.stringify({ result: { structuredContent: data } }), { headers: { "mcp-session-id": "fixture" } });
	});
	await h.post("platform.config.set", { kind: "dasctf", baseUrl: "", apiToken: "fixture" });
	const id = (await h.post("platform.import", { ids: ["1"], start: false })).created[0].localId;
	const recorded = await h.tools.get("ctf_flag_record").execute(local(id), { agent: h.agents[0] });
	assert.equal(recorded.verified, false);
	await until(async () => (await h.post("challenge.get", { id })).challenge.platformSubmit?.status === "correct");
	const ch = (await h.post("challenge.get", { id })).challenge;
	assert.deepEqual(submitted, ["CTF{serpent_cipher}", "flag{serpent_cipher}"]);
	assert.equal(ch.submissionJournal[0].result.diagnostic.correct, false);
	assert.equal(ch.submissionJournal[0].result.diagnostic.code, "FLAG_CHECK");
	assert.match(ch.events.find((event) => event.text.includes("平台提交（incorrect）")).text, /FLAG_CHECK/);
	const status = await h.tools.get("ctf_solve_status").execute({ id }, { agent: h.agents[0] });
	assert.deepEqual(status, JSON.parse(JSON.stringify(status)), "model tools return actual JSON without undefined properties");
});


test("D12/A1: a finished local attempt waits for its platform submission before starting a retry", async (t) => {
	let releaseSubmit, calls = 0;
	const solvers = new Map();
	const services = { agentPresets: { register: async () => () => {}, resolve: async () => {}, list: async () => [{ id: "ctf-auto" }] },
		subagents: { startActivation() { const id = `child-${++calls}`; return { childId: id, result: new Promise((resolve) => solvers.set(id, resolve)) }; },
			interrupt(id) { solvers.get(id)?.({ output: [], stopReason: "aborted" }); } } };
	const h = await host(t, { autoRetry: true }, services);
	h.setRemote((url) => {
		if (url.endsWith("/submit")) return new Promise((resolve) => { releaseSubmit = () => resolve(json({ data: { status: "incorrect" } })); });
		return json({ data: url.endsWith("/api/challenges") ? [{ id: "1", name: "snake" }] : { id: "1", name: "snake", description: "fixture" } });
	});
	await h.post("platform.config.set", { kind: "generic", baseUrl: "https://fixture.test", apiToken: "fixture" });
	const id = (await h.post("platform.import", { ids: ["1"], start: false })).created[0].localId;
	assert.equal((await h.post("challenge.start", { id })).ok, true);
	await until(() => calls === 1);
	await h.post("flag.record", local(id));
	await until(() => releaseSubmit);
	solvers.get("child-1")({ output: [], stopReason: "completed" });
	await until(async () => (await h.post("challenge.get", { id })).challenge.attempts[0].finalizedAt != null);
	h.tick();
	assert.equal(calls, 1, "pending submission must hold the retry queue");
	releaseSubmit();
	await until(async () => (await h.post("challenge.get", { id })).challenge.platformSubmit?.status === "incorrect");
	h.tick();
	await until(() => calls === 2);
	assert.equal((await h.post("challenge.get", { id })).challenge.status, "running");
	await h.post("challenge.stop", { id });
});


test("A3: export packages omit unverified flag files and regenerate confirmed flags from the ledger", async (t) => {
	const h = await platform(t, { auto: false });
	await h.post("flag.record", local(h.id));
	const ch = await h.detail();
	const stale = path.join(ch.dir, "flag.json");
	fs.writeFileSync(stale, JSON.stringify({ flag: "CTF{forged}", verified: true }));
	const pending = await h.post("writeup.pack", { id: h.id });
	assert.equal(pending.ok, true);
	assert.ok(!execFileSync("tar", ["-tzf", pending.path], { encoding: "utf8" }).split("\n").includes("flag.json"));
	h.setReply(() => ({ status: "correct" }));
	assert.equal((await h.post("platform.submit", { id: h.id, flag: "CTF{serpent_cipher}" })).ok, true);
	fs.writeFileSync(stale, JSON.stringify({ flag: "CTF{forged}", verified: true }));
	const confirmed = await h.post("writeup.pack", { id: h.id });
	assert.equal(confirmed.ok, true);
	const flag = JSON.parse(execFileSync("tar", ["-xOzf", confirmed.path, "flag.json"], { encoding: "utf8" }));
	assert.equal(flag.flag, "CTF{serpent_cipher}");
	assert.equal(flag.method, "platform");
});
