import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { host } from "../helpers/host.mjs";

async function fixture(t, config = {}, platform = false) {
	let settle, calls = 0, interrupted = 0;
	const services = {
		agentPresets: { register: async () => () => {}, resolve: async () => {}, list: async () => [{ id: "ctf-auto" }] },
		subagents: { startActivation() { calls++; return { childId: "review-child", result: new Promise((resolve) => { settle = resolve; }) }; }, interrupt() { interrupted++; } }
	};
	const h = await host(t, config, services);
	let added;
	if (platform) {
		h.setRemote((_url, init) => {
			const body = JSON.parse(init.body);
			const name = body.params?.name;
			const data = name === "ctf2_agent_next_challenges" ? { items: [{ id: "1", name: "Review fixture", practice_ground_id: "g" }] }
				: name === "ctf2_get_practice_challenge" ? { challenge: { id: "1", name: "Review fixture" } }
				: name === "ctf2_submit_flag" ? { correct: true }
				: { environment: { environment_id: "env", status: name?.includes("delete") ? "deleted" : "running" } };
			return new Response(JSON.stringify({ result: { structuredContent: data } }), { status: 200, headers: { "mcp-session-id": "s" } });
		});
		await h.post("platform.config.set", { kind: "dasctf", baseUrl: "", apiToken: "fixture" });
		const imported = await h.post("platform.import", { start: false });
		added = { id: imported.created[0].localId };
		assert.equal((await h.post("platform.env", { id: added.id, action: "start" })).ok, true);
	} else added = await h.post("challenge.add", { title: "Review fixture", statement: "fixture" });
	await h.post("flag.record", { id: added.id, flag: "CTF{candidate}", verified: true, method: "local-check", evidence: "fixture checker output CTF{candidate}" });
	const detail = async () => (await h.post("challenge.get", { id: added.id })).challenge;
	return { ...h, id: added.id, detail, calls: () => calls, interrupted: () => interrupted, finish(text, stopReason = "completed") { settle({ output: [{ type: "text", text }], stopReason }); } };
}
async function until(fn) {
	for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
	assert.fail("operation did not complete");
}

test("review rejection revokes local proof, flag file and previously distilled memory", async (t) => {
	const h = await fixture(t);
	assert.equal((await h.post("memory.distill", { id: h.id })).ok, true);
	const ch = await h.detail();
	assert.equal(fs.existsSync(path.join(ch.dir, "flag.json")), true);
	const review = h.post("flag.review", { id: h.id });
	await until(() => h.calls() === 1);
	const duplicate = h.post("flag.review", { id: h.id });
	await h.post("challenge.get", { id: h.id });
	h.finish("REVIEW: REJECTED\nchecker could not reproduce the output");
	assert.equal((await review).status, "rejected");
	assert.equal((await duplicate).status, "rejected");
	assert.equal(h.calls(), 1);
	const rejected = await h.detail();
	assert.equal(rejected.status, "stuck");
	assert.equal(rejected.flags[0].verified, false);
	assert.equal(rejected.review.status, "rejected");
	assert.equal(fs.existsSync(path.join(ch.dir, "flag.json")), false);
	assert.equal((await h.post("memory.cards")).cards.length, 0);
});

test("changed candidates invalidate an in-flight review rather than downgrading new proof", async (t) => {
	const h = await fixture(t);
	const review = h.post("flag.review", { id: h.id });
	await until(() => h.calls() === 1);
	await h.post("flag.record", { id: h.id, flag: "CTF{new}", verified: true, evidence: "new checker output CTF{new}" });
	h.finish("REVIEW: REJECTED\nold candidate is wrong");
	assert.equal((await review).status, "stale");
	const ch = await h.detail();
	assert.equal(ch.flags.find((f) => f.value === "CTF{new}").verified, true);
	assert.equal(ch.status, "solved");
	assert.equal(ch.review, null);
});

test("auto-review blocks memory and environment cleanup until a matching review passes", async (t) => {
	const h = await fixture(t, { reviewerEnabled: true, autoSubmitEnabled: false }, true);
	const deletions = () => h.requests.filter((r) => JSON.parse(r.init.body).params?.name?.includes("delete")).length;
	assert.equal((await h.post("memory.distill", { id: h.id })).ok, false);
	h.tick();
	await until(() => h.calls() === 1);
	h.tick();
	assert.equal(h.calls(), 1);
	assert.equal(deletions(), 0);
	assert.equal((await h.post("memory.cards")).cards.length, 0);
	h.finish("REVIEW: VERIFIED\nindependent checker reproduced candidate");
	await until(async () => (await h.detail()).review?.status === "verified");
	h.tick();
	assert.equal((await h.post("memory.cards")).cards.length, 1);
	await until(() => deletions() === 1);
	assert.equal(h.calls(), 1);
});

test("failed review execution is recorded, and quoted or conflicting verdicts are inconclusive", async (t) => {
	const h = await fixture(t);
	let review = h.post("flag.review", { id: h.id });
	await until(() => h.calls() === 1);
	h.finish("REVIEW: VERIFIED\npartial output", "error");
	assert.equal((await review).ok, false);
	assert.equal((await h.detail()).review.status, "error");
	review = h.post("flag.review", { id: h.id });
	await until(() => h.calls() === 2);
	h.finish("Example REVIEW: VERIFIED\nno conclusion");
	assert.equal((await review).status, "inconclusive");
	assert.equal((await h.detail()).flags[0].verified, true);
});


test("automatic submission waits for review and resumes only after a verified result", async (t) => {
	const h = await fixture(t, { reviewerEnabled: true }, true);
	const submissions = () => h.requests.filter((r) => JSON.parse(r.init.body).params?.name === "ctf2_submit_flag").length;
	assert.equal(submissions(), 0);
	h.tick();
	await until(() => h.calls() === 1);
	assert.equal(submissions(), 0);
	h.finish("REVIEW: VERIFIED\nindependent checker output");
	await until(async () => (await h.detail()).platformSubmit?.status === "correct");
	assert.equal(submissions(), 1);
	assert.equal((await h.detail()).flags[0].method, "platform");
});

test("automatic review errors retry with backoff at most three times and do not create memory", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const h = await fixture(t, { reviewerEnabled: true, autoSubmitEnabled: false }, true);
	for (let attempt = 1; attempt <= 3; attempt++) {
		h.tick();
		await until(() => h.calls() === attempt);
		h.finish("provider failed", "error");
		await until(async () => (await h.detail()).review?.status === "error");
		h.tick();
		assert.equal(h.calls(), attempt);
		now += 120000;
	}
	h.tick();
	assert.equal(h.calls(), 3);
	assert.equal((await h.post("memory.cards")).cards.length, 0);
	await until(async () => (await h.detail()).environment.status === "deleted");
});

test("unloading the plugin cancels an in-flight reviewer and records the interruption", async (t) => {
	const h = await fixture(t);
	const review = h.post("flag.review", { id: h.id });
	await until(() => h.calls() === 1);
	h.dispose();
	const result = await review;
	assert.equal(result.ok, false);
	assert.match(result.error, /取消/);
	assert.ok(h.interrupted() > 0);
});

test("multiple candidates require separate reviews and rejection preserves the approved candidate", async (t) => {
	const h = await fixture(t, { reviewerEnabled: true });
	await h.post("flag.record", { id: h.id, flag: "CTF{second}", verified: true, evidence: "checker output for second candidate" });
	h.tick();
	await until(() => h.calls() === 1);
	h.finish("REVIEW: VERIFIED\nsecond candidate reproduced");
	await until(async () => (await h.detail()).review?.status === "verified");
	assert.equal((await h.post("memory.distill", { id: h.id })).ok, false);
	h.tick();
	await until(() => h.calls() === 2);
	h.finish("REVIEW: REJECTED\nfirst candidate failed reproduction");
	await until(async () => (await h.detail()).review?.status === "rejected");
	const ch = await h.detail();
	assert.equal(ch.flags.find((f) => f.value === "CTF{candidate}").verified, false);
	assert.equal(ch.flags.find((f) => f.value === "CTF{second}").verified, true);
	assert.equal(ch.status, "solved");
	assert.equal((await h.post("memory.distill", { id: h.id })).ok, true);
});

test("manual reviewer rejection cannot revoke platform-confirmed proof", async (t) => {
	const h = await fixture(t, {}, true);
	await until(async () => (await h.detail()).platformSubmit?.status === "correct");
	const review = h.post("flag.review", { id: h.id });
	await until(() => h.calls() === 1);
	h.finish("REVIEW: REJECTED\nreviewer could not reproduce");
	assert.equal((await review).status, "rejected");
	const ch = await h.detail();
	assert.equal(ch.status, "solved");
	assert.equal(ch.flags[0].method, "platform");
	assert.equal(ch.flags[0].verified, true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(ch.dir, "flag.json"), "utf8")).verified, true);
});
