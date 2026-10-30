import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { host } from "../helpers/host.mjs";

const proposal = { key: "web:upload-parse", hypothesis: "图片上传端点可能解析模板表达式", scope: "POST /upload 的 filename 字段", expectedResult: "无害表达式计算结果出现在响应正文", command: "python3 scripts/check_upload.py" };
async function fixture(t, config = {}, services = {}) {
	const h = await host(t, config, services);
	const a = await h.post("challenge.add", { title: "A", statement: "fixture A" });
	const b = await h.post("challenge.add", { title: "B", statement: "fixture B", sessionId: "b" });
	const detail = async (id = a.id) => (await h.post("challenge.get", { id })).challenge;
	return { ...h, a, b, detail };
}
async function until(fn) {
	for (let n = 0; n < 100; n++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 10)); }
	assert.fail("operation did not finish");
}

test("tool and panel share an evidence-backed experiment lifecycle and keep solved independent", async (t) => {
	const h = await fixture(t);
	const created = await h.tools.get("ctf_experiment_record").execute({ id: h.a.id, ...proposal }, { agent: h.agents[0] });
	assert.equal(created.ok, true);
	assert.equal((await h.post("workbench.write", { id: h.a.id, path: "artifacts/upload.txt", text: "expression marker remains literal; no evaluation observed" })).ok, true);
	const conclusion = await h.post("experiment.record", { id: h.a.id, key: proposal.key, status: "refuted", expectedVersion: 1, epoch: created.epoch,
		observedResult: "该字段在本次请求中保持字面量，未观察到表达式计算", evidencePaths: ["artifacts/upload.txt"], nextStep: "只排除 filename 字段；接着检查服务端存储路径" });
	assert.equal(conclusion.ok, true);
	const listed = await h.tools.get("ctf_experiments").execute({ id: h.a.id, key: proposal.key, verifyEvidence: true }, { agent: h.agents[0] });
	assert.equal(listed.rows[0].evidence[0].integrity, "match");
	assert.deepEqual(listed, JSON.parse(JSON.stringify(listed)));
	const ch = await h.detail();
	assert.equal(ch.status, "stopped"); assert.equal(ch.flags.length, 0);
	assert.equal(ch.experimentBoard.counts.refuted, 1);
	assert.equal(ch.events.filter((event) => event.kind === "experiment").length, 2);
});

test("experiment tools deny cross-workspace access and subagents can only edit their own challenge", async (t) => {
	const h = await fixture(t), owned = await h.detail();
	for (const endpoint of ["experiment.list", "experiment.record"]) {
		const denied = await h.post(endpoint, { id: h.a.id, ...proposal, sessionId: "b" });
		assert.equal(denied.ok, false); assert.match(denied.error, /不属于当前工作区/);
	}
	const child = { agent: { id: "new-child", session: { header: { cwd: owned.dir, origin: "subagent" } } } };
	assert.equal((await h.tools.get("ctf_experiment_record").execute({ id: h.a.id, ...proposal }, child)).ok, true);
	for (const name of ["ctf_experiments", "ctf_experiment_record"]) {
		const denied = await h.tools.get(name).execute({ id: h.b.id, ...(name.endsWith("record") ? proposal : {}) }, child);
		assert.equal(denied.ok, false); assert.match(denied.error, /只能访问当前题目/);
	}
	const unbound = { agent: { id: "unmapped-child", session: { header: { cwd: h.agents[0].session.header.cwd, origin: "subagent" } } } };
	for (const name of ["ctf_experiments", "ctf_experiment_record"]) {
		const denied = await h.tools.get(name).execute({ id: h.a.id, ...(name.endsWith("record") ? proposal : {}) }, unbound);
		assert.equal(denied.code, "EXPERIMENT_SCOPE_REQUIRED");
	}
	assert.equal((await h.detail(h.b.id)).experiments.length, 0);
});

test("an old solver cannot write experiment outcomes after its attempt has stopped", async (t) => {
	let finish;
	const services = { agentPresets: { register: async () => () => {}, resolve: async () => {}, list: async () => [{ id: "ctf-auto" }] },
		subagents: { startActivation() { return { childId: "tracked-child", result: new Promise((resolve) => { finish = resolve; }) }; },
			interrupt() { finish?.({ stopReason: "aborted", output: [] }); } } };
	const h = await fixture(t, { autoRetry: false }, services);
	await h.post("challenge.start", { id: h.a.id });
	await until(async () => (await h.detail()).attempts[0]?.sessionId === "tracked-child");
	const child = { agent: { id: "tracked-child", session: { header: { cwd: (await h.detail()).dir, origin: "subagent" } } } };
	assert.equal((await h.tools.get("ctf_experiment_record").execute({ id: h.a.id, ...proposal }, child)).ok, true);
	await h.post("challenge.stop", { id: h.a.id });
	const stale = await h.tools.get("ctf_experiment_record").execute({ id: h.a.id, key: proposal.key, expectedVersion: 1, status: "running" }, child);
	assert.equal(stale.ok, false); assert.match(stale.code, /STALE_TASK|STALE_ATTEMPT/);
	assert.equal((await h.detail()).experiments[0].status, "proposed");
});

test("a failed durable experiment save is reported and an identical retry cannot duplicate it", async (t) => {
	const h = await fixture(t), statePath = path.join(h.root, "state", "state.json");
	const rename = fs.renameSync; let failing = true;
	t.mock.method(fs, "renameSync", (source, destination) => {
		if (String(destination) === statePath && failing) throw Object.assign(new Error("full"), { code: "ENOSPC" });
		return rename(source, destination);
	});
	const result = await h.post("experiment.record", { id: h.a.id, ...proposal });
	assert.equal(result.ok, false); assert.equal(result.applied, true); assert.equal(result.persistence.dirty, true);
	failing = false;
	const retried = await h.post("experiment.record", { id: h.a.id, ...proposal });
	assert.equal(retried.ok, true); assert.equal(retried.deduplicated, true);
	const ch = await h.detail(); assert.equal(ch.experiments.length, 1); assert.equal(ch.experiments[0].version, 1);
	assert.equal(JSON.parse(fs.readFileSync(statePath)).challenges[h.a.id].experiments.length, 1);
});

test("writeup packages contain the durable experiment ledger and its evidence references", async (t) => {
	const h = await fixture(t);
	await h.post("experiment.record", { id: h.a.id, ...proposal });
	await h.post("workbench.write", { id: h.a.id, path: "artifacts/proof.txt", text: "literal expression marker returned with HTTP 200, no evaluation" });
	const closed = await h.post("experiment.record", { id: h.a.id, key: proposal.key, status: "refuted", expectedVersion: 1,
		observedResult: "当前测试中表达式保持字面量，没有发生服务端求值", evidencePaths: ["artifacts/proof.txt"] });
	assert.equal(closed.ok, true);
	const packed = await h.post("writeup.pack", { id: h.a.id }); assert.equal(packed.ok, true);
	const content = JSON.parse(execFileSync("tar", ["-xOzf", packed.path, "experiments.json"], { encoding: "utf8" }));
	assert.equal(content.schema, 1); assert.equal(content.rows[0].status, "refuted");
	assert.equal(content.rows[0].evidence[0].sha256, closed.experiment.evidence[0].sha256);
});
