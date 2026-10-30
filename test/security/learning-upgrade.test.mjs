import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { host } from "../helpers/host.mjs";

async function until(fn) {
	for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 5)); }
	assert.fail("condition did not settle");
}
async function fixture(t) {
	const children = [];
	const h = await host(t, { autoRetry: false, autoDistill: false }, {
		agentPresets: { register: async () => () => {}, resolve: async () => {}, list: async () => [{ id: "ctf-auto" }] },
		subagents: { startActivation(args) { let finish; const result = new Promise((r) => { finish = r; }); const id = "learn-child-" + (children.length + 1);
			children.push({ id, args, finish: () => finish({ stopReason: "aborted", output: [] }) }); return { childId: id, result }; }, interrupt(id) { children.find((c) => c.id === id)?.finish(); } }
	});
	const source = await h.post("challenge.add", { title: "RSA common modulus source", category: "crypto", statement: "RSA common modulus using Bezout coefficients and modular inverse" });
	const detail = async (id = source.id) => (await h.post("challenge.get", { id })).challenge;
	const write = (id, file, text) => h.post("workbench.write", { id, path: file, text });
	await write(source.id, "notes.md", "# Speculation\nTry SSTI template injection, unconfirmed.\n```bash\ncurl https://old-target.example/unverified\n```\n");
	const proposed = await h.post("experiment.record", { id: source.id, key: "rsa:common-modulus", hypothesis: "RSA common modulus uses Bezout coefficients", scope: "the two given RSA ciphertexts and exponents", expectedResult: "plaintext is reconstructed and independently checked", command: "python3 scripts/common_modulus.py" });
	await write(source.id, "artifacts/decoded.txt", "independent exponentiation validates the recovered plaintext");
	await h.post("experiment.record", { id: source.id, key: "rsa:common-modulus", expectedVersion: 1, epoch: proposed.epoch, status: "supported",
		observedResult: "Independent exponentiation confirms the plaintext and original constraints", evidencePaths: ["artifacts/decoded.txt"] });
	await h.post("flag.record", { id: source.id, flag: "flag{historical-secret-value}", verified: true, method: "local-check", evidence: "checker reproduced flag{historical-secret-value} and verified constraints" });
	const distilled = await h.post("memory.distill", { id: source.id }); assert.equal(distilled.ok, true, JSON.stringify(distilled));
	async function target(start = false) {
		const target = await h.post("challenge.add", { title: "RSA common modulus next", category: "crypto", statement: "RSA shared modulus; recover the plaintext with Bezout coefficients" });
		if (start) { await h.post("challenge.start", { id: target.id }); await until(async () => (await detail(target.id)).attempts[0]?.sessionId); }
		return target;
	}
	const recall = (id) => h.tools.get("ctf_recall").execute({ id }, { agent: h.agents[0] });
	return { ...h, source, detail, write, distilled, children, target, recall };
}

test("distilled routes use supported evidence rather than speculative commands and omit raw historical flags", async (t) => {
	const h = await fixture(t), card = h.distilled.card;
	assert.deepEqual(card.commands, ["python3 scripts/common_modulus.py"]);
	assert.ok(card.tech.includes("rsa")); assert.ok(!card.tech.includes("ssti"));
	assert.equal(card.learning.routes.length, 1); assert.equal(card.learning.basis, "experiment-evidence");
	assert.ok(!JSON.stringify(card).includes("flag{historical-secret-value}"));
	const target = await h.target(); const pack = await h.recall(target.id);
	assert.equal(pack.memories.length, 1); assert.ok(pack.memories[0].revisionId);
});

test("changed notes and changed experimental evidence quarantine memories until explicitly rebuilt", async (t) => {
	const h = await fixture(t);
	await h.write(h.source.id, "notes.md", "# Corrected notes\nNew independent observations need to be distilled again.");
	const stale = await h.post("memory.cards"); assert.equal(stale.cards.length, 0); assert.equal(stale.quarantined.length, 1); assert.match(stale.quarantined[0].reason, /变化/);
	assert.equal((await h.post("memory.distill", { id: h.source.id })).ok, true);
	assert.equal((await h.post("memory.cards")).cards.length, 1);
	await h.write(h.source.id, "artifacts/decoded.txt", "unexpected different decoder output");
	const evidenceStale = await h.post("memory.cards"); assert.equal(evidenceStale.cards.length, 0); assert.match(evidenceStale.quarantined[0].reason, /证据/);
	assert.equal((await h.post("memory.distill", { id: h.source.id })).ok, false, "cannot bypass broken experiment evidence by downgrading to raw notes");
});

test("open experiment disputes immediately stop memory recall and prevent redistillation", async (t) => {
	const h = await fixture(t), source = await h.detail();
	await h.write(h.source.id, "artifacts/counter.txt", "counterexample indicates a disagreement with the original arithmetic");
	const row = source.experiments.find((r) => r.key === "rsa:common-modulus");
	const opened = await h.post("experiment.review.open", { id: h.source.id, key: row.key, epoch: row.epoch, expectedVersion: row.version,
		reason: "A counterexample contradicts the earlier modular exponentiation", evidencePaths: ["artifacts/counter.txt"] });
	assert.equal(opened.ok, true);
	assert.equal((await h.post("memory.cards")).cards.length, 0);
	assert.equal((await h.post("memory.distill", { id: h.source.id })).ok, false);
	assert.equal((await h.recall((await h.target()).id)).memories.length, 0);
});

test("knowledge search updates immediately, merges duplicate files and excludes unverified notes from auto-recall", async (t) => {
	const h = await fixture(t), doc = path.join(h.root, "reference.md"), renamed = path.join(h.root, "copy.md");
	fs.writeFileSync(doc, "# RSA reference\nRSA common modulus and Bezout coefficients provide the arithmetic method."); fs.copyFileSync(doc, renamed);
	assert.equal((await h.post("kb.import", { files: [doc, renamed] })).imported.length, 2);
	const manual = await h.post("kb.search", { q: "RSA reference" }); assert.equal(manual.results.length, 1); assert.equal(manual.results[0].duplicateSources.length, 1); assert.ok(manual.results[0].citation.contentHash);
	const importedPath = manual.results[0].path; fs.writeFileSync(importedPath, "PNG pixel analysis uses RGB channels");
	assert.equal((await h.post("kb.search", { q: "PNG pixel" })).results.length, 1);
	const working = await h.post("challenge.add", { title: "unverified technique", statement: "working notes" });
	await h.write(working.id, "notes.md", "unique-unconfirmed-mechanism only appears in this speculative working note");
	const target = await h.post("challenge.add", { title: "unique-unconfirmed-mechanism", statement: "unique-unconfirmed-mechanism" });
	assert.equal((await h.recall(target.id)).knowledge.length, 0);
	const workingResults = (await h.post("kb.search", { q: "unique-unconfirmed-mechanism" })).results;
	assert.ok(workingResults.some((r) => r.sourceChallengeId === working.id && r.allowAutomatic === false));
});

test("feedback references actual attempt revisions, deduplicates and quarantines contradicted recipe versions", async (t) => {
	const h = await fixture(t), target = await h.target(true), ch = await h.detail(target.id), ref = ch.attempts[0].memories[0];
	assert.ok(ref.revisionId); await h.write(target.id, "artifacts/feedback.txt", "independent replay disproves this recipe on the matching stated preconditions");
	const input = { id: target.id, attempt: 1, kind: "memory", referenceId: ref.id, revisionId: ref.revisionId, verdict: "contradicted",
		reason: "Independent replay contradicts the recipe under the same documented conditions", evidencePaths: ["artifacts/feedback.txt"] };
	assert.equal((await h.post("learning.feedback", input)).ok, true);
	assert.equal((await h.post("learning.feedback", input)).deduplicated, true);
	assert.equal((await h.post("learning.feedback.list", { id: target.id })).entries.length, 1);
	const library = await h.post("memory.cards"); assert.equal(library.cards.length, 0); assert.match(library.quarantined[0].reason, /矛盾反馈/);
	assert.equal((await h.recall(target.id)).memories.length, 0);
	const cross = await h.post("learning.feedback", { ...input, sessionId: "b" }); assert.equal(cross.ok, false);
	const child = { agent: { id: ch.attempts[0].sessionId, session: { header: { cwd: ch.dir, origin: "subagent" } } } };
	assert.equal((await h.tools.get("ctf_learning_feedback").execute(input, child)).ok, false);
});

test("unknown source versions cannot receive success credit and a solved attempt does not create explicit feedback", async (t) => {
	const h = await fixture(t), target = await h.target(true), ch = await h.detail(target.id), ref = ch.attempts[0].memories[0];
	await h.write(target.id, "artifacts/feedback.txt", "independent test output");
	const bad = await h.post("learning.feedback", { id: target.id, kind: "memory", referenceId: ref.id, revisionId: "f".repeat(64), verdict: "helpful", reason: "Pretend a different revision was the one used by this attempt", evidencePaths: ["artifacts/feedback.txt"] });
	assert.equal(bad.ok, false);
	await h.post("flag.record", { id: target.id, flag: "flag{new-output}", verified: true, method: "local-check", evidence: "original checker validates the new-output candidate independently" });
	await until(async () => (await h.detail(target.id)).attempts[0]?.finalizedAt);
	assert.equal((await h.post("learning.feedback.list", { id: target.id })).entries.length, 0);
});

test("a failed feedback file save cannot create success credit and retries commit only once", async (t) => {
	const h = await fixture(t), target = await h.target(true), ch = await h.detail(target.id), ref = ch.attempts[0].memories[0];
	await h.write(target.id, "artifacts/feedback.txt", "independently reproduced output from using the recalled method");
	const input = { id: target.id, kind: "memory", referenceId: ref.id, revisionId: ref.revisionId, verdict: "helpful", reason: "Independent replay confirms the recalled method is useful for these inputs", evidencePaths: ["artifacts/feedback.txt"] };
	const link = fs.linkSync, feedbackFile = path.join(h.root, "state", "learning-feedback.json"); let failing = true;
	t.mock.method(fs, "linkSync", (source, dest) => { if (String(dest) === feedbackFile && failing) throw Object.assign(new Error("full"), { code: "ENOSPC" }); return link(source, dest); });
	const failed = await h.post("learning.feedback", input); assert.equal(failed.ok, false); assert.equal(fs.existsSync(feedbackFile), false);
	failing = false; assert.equal((await h.post("learning.feedback", input)).ok, true);
	assert.equal((await h.post("learning.feedback", input)).deduplicated, true);
	assert.equal(Object.keys(JSON.parse(fs.readFileSync(feedbackFile)).entries).length, 1);
});

test("knowledge feedback uses the cited attempt passage and renamed copies cannot bypass a contradiction", async (t) => {
	const h = await fixture(t), reference = path.join(h.root, "rsa-reference.md");
	fs.writeFileSync(reference, "# RSA common modulus\nBezout coefficients and modular inverse reconstruct the plaintext from two RSA exponents.");
	await h.post("kb.import", { files: [reference] });
	const target = await h.target(true), ch = await h.detail(target.id), ref = ch.attempts[0].knowledge[0];
	assert.ok(ref.revisionId); assert.ok(ref.citation.contentHash); assert.ok(ref.citation.startLine);
	await h.write(target.id, "artifacts/kb-counter.txt", "replay shows that the referenced arithmetic statement contradicts the supplied input constraints");
	const feedback = await h.post("learning.feedback", { id: target.id, kind: "knowledge", referenceId: ref.id, revisionId: ref.revisionId, verdict: "contradicted",
		reason: "Independent replay demonstrates a contradiction in this exact reference passage", evidencePaths: ["artifacts/kb-counter.txt"] });
	assert.equal(feedback.ok, true, JSON.stringify(feedback));
	const renamed = path.join(h.root, "renamed-reference.md"); fs.copyFileSync(reference, renamed); await h.post("kb.import", { files: [renamed] });
	assert.equal((await h.recall(target.id)).knowledge.length, 0);
	const manual = await h.post("kb.search", { q: "Bezout coefficients" });
	assert.equal(manual.results.length, 1); assert.equal(manual.results[0].feedback.contradicted, 1);
});

test("legacy cards remain on disk for explicit rebuilding and do not enter automatic context", async (t) => {
	const h = await fixture(t), file = path.join(h.root, "state", "memory", "memory.json");
	const legacy = JSON.stringify({ version: 2, cards: [{ id: "legacy-recipe", sourceChallengeId: h.source.id, title: "RSA old recipe", steps: ["old step"], used: 4, usedOk: 2 }] });
	fs.writeFileSync(file, legacy);
	const library = await h.post("memory.cards"); assert.equal(library.cards.length, 0); assert.equal(library.quarantined.length, 1);
	assert.equal(fs.readFileSync(file, "utf8"), legacy, "reading legacy data must not rewrite it");
	const rebuilt = await h.post("memory.distill", { id: h.source.id }); assert.equal(rebuilt.ok, true);
	const card = (await h.post("memory.cards")).cards[0]; assert.equal(card.id, "legacy-recipe"); assert.ok(card.revisionId);
	assert.equal(card.used, 4); assert.equal(card.metrics.used, 4); assert.equal(card.metrics.usedOk, 2);
});

test("modified recipe content is preserved as an error and automatic attempts expose degraded retrieval", async (t) => {
	const h = await fixture(t), file = path.join(h.root, "state", "memory", "memory.json"), data = JSON.parse(fs.readFileSync(file));
	data.cards[0].commands = ["unreviewed replacement command"]; const exact = JSON.stringify(data); fs.writeFileSync(file, exact);
	assert.equal((await h.post("memory.cards")).ok, false);
	assert.equal(fs.readFileSync(file, "utf8"), exact);
	const target = await h.target(true), ch = await h.detail(target.id);
	assert.equal(ch.attempts[0].memories.length, 0); assert.ok(ch.attempts[0].recallWarnings.length);
	assert.ok(ch.events.some((e) => /召回降级/.test(e.text)));
});

test("batch rebuilding advances past current cards rather than rewriting them before remaining legacy cards", async (t) => {
	const h = await fixture(t), file = path.join(h.root, "state", "memory", "memory.json"), data = JSON.parse(fs.readFileSync(file));
	for (let i = 0; i < 2; i++) {
		const old = await h.post("challenge.add", { title: "Legacy migration " + i, statement: "local fixture" });
		await h.post("flag.record", { id: old.id, flag: `flag{legacy-${i}}`, verified: true, method: "local-check", evidence: "independent fixture checker validates all output constraints" });
		data.cards.push({ id: "legacy-" + i, sourceChallengeId: old.id, title: "Legacy " + i, steps: ["old recipe"] });
	}
	fs.writeFileSync(file, JSON.stringify(data));
	const rebuilt = await h.post("memory.distill", { all: true, refresh: true });
	assert.equal(rebuilt.ok, true); assert.equal(rebuilt.distilled, 2); assert.equal(rebuilt.remaining, 0);
	const repeat = await h.post("memory.distill", { all: true, refresh: true }); assert.equal(repeat.distilled, 0);
	assert.equal((await h.post("memory.cards")).cards.length, 3);
});
