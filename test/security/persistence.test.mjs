import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { host } from "../helpers/host.mjs";

function failStateWrites(t, statePath) {
	let failing = true;
	const rename = fs.renameSync;
	t.mock.method(fs, "renameSync", (source, destination) => {
		if (String(destination) === statePath && failing) throw Object.assign(new Error("private diagnostic details"), { code: "ENOSPC" });
		return rename(source, destination);
	});
	return () => { failing = false; };
}

test("Web mutations report unsaved state, block repeated actions and recover through an explicit flush", async (t) => {
	const h = await host(t);
	const statePath = path.join(h.root, "state", "state.json");
	const recover = failStateWrites(t, statePath);
	const added = await h.post("challenge.add", { title: "unsaved fixture", statement: "fixture" });
	assert.equal(added.ok, false);
	assert.equal(added.applied, true);
	assert.equal(added.persistence.dirty, true);
	assert.equal(added.persistence.lastError.code, "ENOSPC");
	assert.ok(!JSON.stringify(added).includes("private diagnostic"));
	const blocked = await h.post("challenge.add", { title: "must not duplicate", statement: "fixture" });
	assert.equal(blocked.ok, false);
	assert.equal(blocked.applied, false);
	const state = await h.post("state.get");
	assert.equal(state.ok, true);
	assert.equal(state.challenges.length, 1);
	assert.equal(state.persistence.dirty, true);
	assert.equal((await h.post("state.flush")).ok, false);
	recover();
	const flushed = await h.post("state.flush");
	assert.equal(flushed.ok, true);
	assert.equal(flushed.persistence.dirty, false);
	assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath)).challenges).length, 1);
});

test("model tools expose persistence failures and the watchdog retries without replaying the tool", async (t) => {
	const h = await host(t);
	const added = await h.post("challenge.add", { title: "tool fixture", statement: "fixture" });
	const statePath = path.join(h.root, "state", "state.json");
	const recover = failStateWrites(t, statePath);
	const result = await h.tools.get("ctf_flag_record").execute({ id: added.id, flag: "CTF{x}", evidence: "candidate output", verified: false }, { agent: h.agents[0] });
	assert.equal(result.ok, false);
	assert.equal(result.applied, true);
	assert.equal(result.persistence.dirty, true);
	recover();
	h.tick();
	assert.equal((await h.post("state.get")).persistence.dirty, false);
	const saved = JSON.parse(fs.readFileSync(statePath));
	assert.equal(saved.challenges[added.id].flags.length, 1);
});
