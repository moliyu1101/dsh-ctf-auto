import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../lib/store.js";
import { createExperiments, buildExperimentContext, experimentEpoch } from "../../lib/experiments.js";
import { snapshotEvidence, MAX_EVIDENCE_BYTES } from "../../lib/experiment-evidence.js";
import { buildAttemptPrompt } from "../../lib/prompt.js";
import { progressStamp, observeProgress } from "../../lib/progress-watchdog.js";

const proposed = { key: "crypto:serpent", hypothesis: "数据可能使用 serpent 编码", scope: "题目附件 sample.txt 的首段密文", expectedResult: "使用原版解码器后得到符合题面约束的明文", command: "python3 scripts/decode.py", nextStep: "先检查输入字母表，再独立重算" };
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-experiments-"));
	const file = path.join(root, "state.json");
	let store = createStore(file, { rootDir: root }), at = 1000;
	const ch = store.addChallenge({ title: "snake", statement: "decode the attachment" });
	fs.mkdirSync(path.join(ch.dir, "artifacts"), { recursive: true });
	const api = () => createExperiments({ store, now: () => ++at });
	t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
	return { root, file, ch, get store() { return store; }, get service() { return api(); },
		record(input = {}) { return api().record({ id: ch.id, ...proposed, ...input }); },
		log(text = "decoder returned error: unknown alphabet") { fs.writeFileSync(path.join(ch.dir, "artifacts/check.txt"), text); return ["artifacts/check.txt"]; },
		reopen() { store.close(); store = createStore(file, { rootDir: root }); return store.get(ch.id); } };
}

test("proposals persist, duplicate retries are idempotent, and supported hypotheses never solve a challenge", (t) => {
	const f = fixture(t), created = f.record();
	assert.equal(created.ok, true); assert.equal(created.experiment.version, 1);
	const before = f.store.get(f.ch.id).events.length;
	assert.equal(f.record({ key: "  CRYPTO:SERPENT  " }).deduplicated, true);
	assert.equal(f.store.get(f.ch.id).events.length, before);
	const evidencePaths = f.log("independent decoder returned valid plaintext satisfying the constraints");
	const supported = f.record({ status: "supported", observedResult: "两份独立解码结果一致，已核对输出长度及字母表", evidencePaths, expectedVersion: 1 });
	assert.equal(supported.ok, true);
	assert.equal(supported.experiment.evidence[0].sha256.length, 64);
	assert.notEqual(f.store.get(f.ch.id).status, "solved");
	assert.equal(f.store.get(f.ch.id).flags.length, 0);
	const restored = f.reopen();
	assert.equal(restored.experiments[0].status, "supported");
	assert.equal(restored.experiments[0].history[0].status, "proposed");
});

test("terminal conclusions require a concrete result and a nonempty safe evidence file", (t) => {
	const f = fixture(t);
	assert.equal(f.record({ status: "refuted", observedResult: "解码器对全部输入均返回不支持的编码" }).code, "EXPERIMENT_EVIDENCE_REQUIRED");
	const evidencePaths = f.log("");
	assert.equal(f.record({ status: "supported", observedResult: "已经独立确认所有字节均符合预期", evidencePaths }).code, "EXPERIMENT_EVIDENCE_REQUIRED");
	assert.equal(f.record({ status: "blocked", observedResult: "卡住了" }).code, "EXPERIMENT_BLOCKER_REQUIRED");
	assert.equal(f.record({ status: "blocked", observedResult: "编译缺少 mhash.h；先检查已有解码器和包管理器" }).ok, true);
});

test("a refuted path cannot be reopened with renamed old evidence or a different key", (t) => {
	const f = fixture(t), evidencePaths = f.log();
	const refuted = f.record({ status: "refuted", observedResult: "原版解码器证实该编码不支持当前输入字母表", evidencePaths });
	assert.equal(refuted.ok, true);
	fs.copyFileSync(path.join(f.ch.dir, evidencePaths[0]), path.join(f.ch.dir, "artifacts/renamed.txt"));
	const retry = { expectedVersion: 1, status: "running", reopenReason: "新增了另一组输入参数，准备重新进行有界验证" };
	assert.equal(f.record({ ...retry, evidencePaths: ["artifacts/renamed.txt"] }).code, "EXPERIMENT_NEW_EVIDENCE_REQUIRED");
	assert.equal(f.record({ ...proposed, key: "crypto:renamed" }).code, "EXPERIMENT_DUPLICATE_SCOPE");
	const reopened = f.record({ ...retry, evidencePaths: f.log("new encoder documentation shows a second alphabet requiring normalization") });
	assert.equal(reopened.ok, true); assert.equal(reopened.experiment.version, 2);
	assert.equal(reopened.experiment.history[0].status, "refuted");
	assert.equal(reopened.experiment.history[0].evidence[0].sha256, refuted.experiment.evidence[0].sha256);
});

test("concurrent updates reject stale versions rather than overwriting a newer experiment", (t) => {
	const f = fixture(t); f.record();
	assert.equal(f.record({ status: "running", expectedVersion: 1 }).ok, true);
	const stale = f.record({ nextStep: "使用另一条路线继续分析", expectedVersion: 1 });
	assert.equal(stale.code, "EXPERIMENT_VERSION_CONFLICT"); assert.equal(stale.currentVersion, 2);
	assert.equal(f.service.list({ id: f.ch.id }).rows[0].status, "running");
});

test("evidence checks detect changes and missing files without mutating stored proof", (t) => {
	const f = fixture(t), evidencePaths = f.log();
	const saved = f.record({ status: "refuted", observedResult: "实际结果排除了当前输入范围内的 serpent 解码", evidencePaths });
	const request = { id: f.ch.id, key: proposed.key, verifyEvidence: true };
	assert.equal(f.service.list(request).rows[0].evidence[0].integrity, "match");
	f.log("the file now contains a different experiment result");
	assert.equal(f.service.list(request).rows[0].evidence[0].integrity, "changed");
	fs.unlinkSync(path.join(f.ch.dir, evidencePaths[0]));
	assert.equal(f.service.list(request).rows[0].evidence[0].integrity, "unavailable");
	assert.equal(f.store.get(f.ch.id).experiments[0].evidence[0].sha256, saved.experiment.evidence[0].sha256);
	assert.equal(f.service.list({ id: f.ch.id, verifyEvidence: true }).code, "EXPERIMENT_KEY_REQUIRED");
});

test("new input batches and target IDs isolate old dead ends; address changes alone do not", (t) => {
	const f = fixture(t); f.record({ status: "refuted", observedResult: "已测试范围内的输入字母表与该算法不相容", evidencePaths: f.log() });
	const epoch = experimentEpoch(f.store.get(f.ch.id));
	f.store.update(f.ch.id, { target: "http://new-address.example:1234" });
	assert.equal(experimentEpoch(f.store.get(f.ch.id)), epoch);
	f.store.update(f.ch.id, { environment: { environment_id: "new-instance", status: "running" } });
	const view = f.service.list({ id: f.ch.id });
	assert.equal(view.rows[0].stale, true); assert.equal(view.counts.refuted, 0);
	assert.equal(f.record({ epoch, expectedVersion: 1, status: "running" }).code, "EXPERIMENT_EPOCH_CHANGED");
	assert.equal(f.record({ expectedVersion: 0, epoch: view.epoch }).ok, true);
	assert.equal(f.service.list({ id: f.ch.id }).rows.length, 2);
	const context = buildExperimentContext(f.store.get(f.ch.id));
	assert.match(context, /旧材料或旧靶机范围/);
	assert.doesNotMatch(context, /\[refuted\]/);
});

test("parent symlinks, external paths, device files and oversized files are not evidence", (t) => {
	const f = fixture(t); f.log();
	assert.throws(() => snapshotEvidence(f.ch.dir, "../state.json"));
	assert.throws(() => snapshotEvidence(f.ch.dir, path.join(f.root, "state.json")));
	fs.symlinkSync(f.root, path.join(f.ch.dir, "outside"), "dir");
	assert.throws(() => snapshotEvidence(f.ch.dir, "outside/state.json"), /符号链接/);
	fs.symlinkSync(path.join(f.ch.dir, "artifacts"), path.join(f.ch.dir, "inside"), "dir");
	assert.throws(() => snapshotEvidence(f.ch.dir, "inside/check.txt"), /符号链接/);
	fs.writeFileSync(path.join(f.ch.dir, "artifacts/large"), Buffer.alloc(MAX_EVIDENCE_BYTES + 1));
	assert.throws(() => snapshotEvidence(f.ch.dir, "artifacts/large"), /1MiB/);
});

test("an evidence file swapped to a symlink at open is rejected", (t) => {
	const f = fixture(t); const paths = f.log();
	const target = path.join(f.ch.dir, paths[0]), external = path.join(f.root, "private");
	fs.writeFileSync(external, "private data must not become an evidence digest");
	const open = fs.openSync;
	t.mock.method(fs, "openSync", (file, ...args) => {
		if (file === target) { fs.unlinkSync(target); fs.symlinkSync(external, target); }
		return open(file, ...args);
	});
	assert.throws(() => snapshotEvidence(f.ch.dir, paths[0]));
});

test("restart rejects unsupported experiment formats without resetting or rewriting the state file", (t) => {
	const f = fixture(t); f.record(); f.store.close();
	const data = JSON.parse(fs.readFileSync(f.file, "utf8")); data.challenges[f.ch.id].experiments[0].schema = 99;
	const raw = JSON.stringify(data); fs.writeFileSync(f.file, raw);
	assert.throws(() => createStore(f.file, { rootDir: f.root }), { code: "EXPERIMENT_FORMAT_INVALID" });
	assert.equal(fs.readFileSync(f.file, "utf8"), raw);
});

test("retry prompts carry scoped evidence and dead ends in a bounded handoff", (t) => {
	const f = fixture(t); f.record({ status: "refuted", observedResult: "对当前输入字母表运行原版脚本，返回格式不支持", evidencePaths: f.log() });
	const ch = f.store.get(f.ch.id);
	const prompt = buildAttemptPrompt({ challenge: ch, attempt: { n: 2 }, priorAttempts: [] });
	assert.match(prompt, /实验黑板交接/); assert.match(prompt, /crypto:serpent/); assert.match(prompt, /sha256=/); assert.match(prompt, /\[refuted\]/);
	const row = ch.experiments[0];
	const crowded = { ...ch, experiments: Array.from({ length: 64 }, (_, i) => ({ ...row, key: `path:${i}`, hypothesis: "长假设".repeat(160), observedResult: "结果".repeat(500) })) };
	const context = buildExperimentContext(crowded);
	assert.ok(context.length < 8000); assert.match(context, /不能把省略当作未尝试/);
});

test("editing a plan or polling a duplicate record does not reset the no-output watchdog", (t) => {
	const f = fixture(t); f.record(); const ch = structuredClone(f.store.get(f.ch.id));
	const state = { stamp: progressStamp(ch), lastProgressMono: 0 };
	ch.experiments[0].version++; ch.experiments[0].nextStep = "换一种文字描述计划";
	ch.events.push({ kind: "experiment", text: "计划已编辑" });
	assert.equal(observeProgress(state, progressStamp(ch), 300000, 300000), "warn");
	ch.experiments[0].observedResult = "刚完成一项实际测试，已记录输出";
	assert.equal(observeProgress(state, progressStamp(ch), 300001, 300000), null);
});


test("bounded revision history retains old evidence fingerprints so old bytes cannot reopen a path", (t) => {
	const f = fixture(t);
	const first = f.record({ status: "refuted", observedResult: "当前范围内的所有测试均未支持该假设", evidencePaths: f.log("original refutation result") });
	const reopened = f.record({ status: "running", expectedVersion: 1, reopenReason: "新文档表明需要先归一化另外一套输入字母表", evidencePaths: f.log("new documentation supplies a different input alphabet") });
	assert.equal(reopened.ok, true);
	let version = 2;
	for (let n = 0; n < 12; n++) assert.equal(f.record({ status: "running", expectedVersion: version++, nextStep: `第 ${n} 个后续验证说明` }).ok, true);
	const refuted = f.record({ status: "refuted", expectedVersion: version++, observedResult: "新增输入参数的实际测试仍然没有得到预期结果" });
	assert.equal(refuted.ok, true); assert.equal(refuted.experiment.history.length, 8);
	assert.ok(refuted.experiment.evidenceDigests.includes(first.experiment.evidence[0].sha256));
	const recycled = f.record({ status: "running", expectedVersion: version, reopenReason: "计划再次采用最早的一份输出作为重开依据", evidencePaths: f.log("original refutation result") });
	assert.equal(recycled.code, "EXPERIMENT_NEW_EVIDENCE_REQUIRED");
});

test("the ledger refuses to evict unresolved records when its capacity is reached", (t) => {
	const f = fixture(t); f.record(); const row = f.store.get(f.ch.id).experiments[0];
	f.store.transact(f.ch.id, (edit) => edit.patch({ experiments: Array.from({ length: 64 }, (_, n) => ({ ...row, key: `path:${n}`, scope: `fixture scope ${n}` })) }));
	const result = f.record({ key: "new-path", scope: "a completely distinct scope" });
	assert.equal(result.code, "EXPERIMENT_CAPACITY"); assert.equal(f.store.get(f.ch.id).experiments.length, 64);
});


test("live board reads omit history by default and historical reads are scoped to a single key", (t) => {
	const f = fixture(t); f.record(); f.record({ status: "running", expectedVersion: 1 });
	const live = f.service.list({ id: f.ch.id });
	assert.equal(live.rows[0].historyCount, 1); assert.equal(live.rows[0].history, undefined);
	assert.equal(f.service.list({ id: f.ch.id, includeHistory: true }).code, "EXPERIMENT_KEY_REQUIRED");
	const audit = f.service.list({ id: f.ch.id, key: proposed.key, includeHistory: true });
	assert.equal(audit.rows[0].history[0].status, "proposed");
});
