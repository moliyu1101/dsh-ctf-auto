import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	EVENTS_LIMIT,
	FACTS_LIMIT,
	OUTPUT_TAIL_LIMIT,
	STATE_VERSION,
	createStore,
} from "../../lib/store.js";

function tempDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-store-"));
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function makeStore(t, options = {}) {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	const store = createStore(statePath, {
		rootDir: path.join(dir, "root"),
		...options,
	});
	return { dir, statePath, store };
}

function challengeInput(overrides = {}) {
	return {
		title: "Fish Joy in HTML5",
		category: "web",
		statement: "题面：找 flag。http://1.2.3.4:8080",
		target: "http://1.2.3.4:8080",
		files: [{ name: "game.zip", path: "/tmp/game.zip", source: "user" }],
		...overrides,
	};
}

// 与 lib/store.js 的 slug hash 算法一致（用于构造目录冲突场景）
function hash6(input) {
	let h = 2166136261 >>> 0;
	for (const ch of String(input ?? "")) {
		h ^= ch.codePointAt(0) >>> 0;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

test("createStore: 初始化空库并落盘", (t) => {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	const store = createStore(statePath, { rootDir: path.join(dir, "root"), now: () => 1234 });

	assert.equal(store.state.version, STATE_VERSION);
	assert.deepEqual(store.state.challenges, {});
	assert.deepEqual(store.state.order, []);
	assert.equal(store.state.rootDir, path.resolve(path.join(dir, "root")));
	assert.equal(store.list().length, 0);
	assert.deepEqual(store.stats(), {
		total: 0,
		queued: 0,
		running: 0,
		solved: 0,
		stuck: 0,
		failed: 0,
		stopped: 0,
	});
	assert.ok(fs.existsSync(statePath), "state.json 应被创建");
	const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
	assert.equal(parsed.version, STATE_VERSION);
});

test("addChallenge: id/slug/dir/子目录/事件/队列顺序", (t) => {
	const { store } = makeStore(t, { now: () => 1111 });
	const challenge = store.addChallenge(challengeInput());

	assert.match(challenge.id, /^c-[0-9a-z]+-[0-9a-z]{3}$/);
	assert.match(challenge.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{6}$/);
	assert.equal(challenge.title, "Fish Joy in HTML5");
	assert.equal(challenge.category, "web");
	assert.equal(challenge.status, "queued");
	assert.equal(challenge.createdAt, 1111);
	assert.equal(challenge.startedAt, null);
	assert.equal(challenge.endedAt, null);
	assert.equal(challenge.files.length, 1);
	assert.equal(challenge.files[0].name, "game.zip");
	assert.equal(challenge.files[0].source, "user");
	assert.equal(challenge.dir, path.join(store.state.rootDir, challenge.slug));
	assert.equal(challenge.budget.maxAttempts, 3);
	assert.equal(challenge.budget.timeBudgetMs, 1800000);
	assert.equal(challenge.events[0].kind, "queued");

	// 固定工作区子目录
	for (const sub of ["files", "scripts", "artifacts"]) {
		assert.ok(fs.existsSync(path.join(challenge.dir, sub)), `应创建子目录 ${sub}`);
	}

	assert.deepEqual(store.state.order, [challenge.id]);
	assert.equal(store.get(challenge.id), challenge);
	assert.equal(store.findBySlug(challenge.slug), challenge);
	assert.deepEqual(store.list(), [challenge]);

	const second = store.addChallenge(challengeInput({ title: "Another Web" }));
	assert.equal(store.list().length, 2);
	assert.deepEqual(store.state.order, [challenge.id, second.id]);
});

test("slug: 中文标题回退 challenge、同题不同 id 生成不同 slug、URL 附件规范化", (t) => {
	const { store } = makeStore(t);
	const a = store.addChallenge({ title: "中文题目", category: "misc" });
	const b = store.addChallenge({ title: "中文题目", category: "misc" });
	assert.match(a.slug, /^challenge-[0-9a-z]{6}$/);
	assert.match(b.slug, /^challenge-[0-9a-z]{6}$/);
	assert.notEqual(a.slug, b.slug, "id 派生 hash：同题不同 id 的 slug 不应相同");

	const withUrl = store.addChallenge({
		title: "Files Demo",
		files: ["https://example.com/att/a.zip", { url: "https://example.com/att/b.bin" }],
	});
	assert.equal(withUrl.files.length, 2);
	assert.equal(withUrl.files[0].source, "url");
	assert.equal(withUrl.files[0].path, "");
	assert.equal(withUrl.files[0].name, "a.zip");
	assert.equal(withUrl.files[1].source, "url");
});

test("slug: 目录已存在时冲突加 -2 后缀", (t) => {
	const dir = tempDir(t);
	const rootDir = path.join(dir, "root");
	const store = createStore(path.join(dir, "state.json"), {
		rootDir,
		now: () => 1111,
	});
	const originalRandom = Math.random;
	t.after(() => {
		Math.random = originalRandom;
	});
	Math.random = () => 0.5; // randomSuffix(3) => "iii"
	const expectedId = `c-${(1111).toString(36)}-iii`;
	const expectedSlug = `collide-${hash6(expectedId)}`;
	fs.mkdirSync(path.join(rootDir, expectedSlug), { recursive: true });

	const challenge = store.addChallenge({ title: "Collide" });
	assert.equal(challenge.slug, `${expectedSlug}-2`);
	Math.random = originalRandom;

	const next = store.addChallenge({ title: "Collide" });
	assert.notEqual(next.slug, challenge.slug);
	assert.notEqual(store.findBySlug(challenge.slug), next);
});

test("update: 浅合并并持久化", (t) => {
	const { store, statePath } = makeStore(t);
	const challenge = store.addChallenge(challengeInput());
	const updated = store.update(challenge.id, { target: "http://9.9.9.9", stuckReason: "note" });
	assert.equal(updated.target, "http://9.9.9.9");
	assert.equal(updated.stuckReason, "note");
	assert.equal(store.update("missing", { target: "x" }), undefined);
	const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
	assert.equal(parsed.challenges[challenge.id].target, "http://9.9.9.9");
});

test("addEvent: 滚动裁剪到最近 300 条", (t) => {
	const { store } = makeStore(t);
	const challenge = store.addChallenge(challengeInput());
	for (let i = 0; i < EVENTS_LIMIT + 8; i += 1) {
		store.addEvent(challenge.id, "note", `event-${i}`, { attempt: 1 });
	}
	const events = store.get(challenge.id).events;
	assert.equal(events.length, EVENTS_LIMIT);
	assert.equal(events[EVENTS_LIMIT - 1].text, `event-${EVENTS_LIMIT + 7}`);
	assert.equal(events[0].text, `event-${8}`);
	assert.equal(events[EVENTS_LIMIT - 1].attempt, 1);
	assert.equal(store.addEvent("missing", "note", "x"), undefined);
});

test("addAttempt/endAttempt: 状态流转与 outputTail 截断", (t) => {
	const clock = { t: 5000 };
	const { store } = makeStore(t, { now: () => clock.t });
	const challenge = store.addChallenge(challengeInput());
	store.setStatus(challenge.id, "stuck", { stuckReason: "先卡一下" });

	const attempt = store.addAttempt(challenge.id, { angle: "recon-first" });
	assert.equal(attempt.n, 1);
	assert.equal(attempt.angle, "recon-first");
	assert.equal(attempt.status, "running");
	assert.equal(attempt.startedAt, 5000);
	assert.equal(attempt.label, `ctf-${challenge.id}#1`);
	assert.deepEqual(attempt.failedPaths, []);
	const afterStart = store.get(challenge.id);
	assert.equal(afterStart.status, "running");
	assert.equal(afterStart.endedAt, null);
	assert.equal(afterStart.stuckReason, "");
	assert.equal(afterStart.startedAt, 5000);

	clock.t = 6000;
	const longOutput = "x".repeat(OUTPUT_TAIL_LIMIT + 500);
	const ended = store.endAttempt(challenge.id, 1, {
		status: "completed",
		stopReason: "completed",
		summary: "正常结束",
		outputTail: longOutput,
	});
	assert.equal(ended.endedAt, 6000);
	assert.equal(ended.outputTail.length, OUTPUT_TAIL_LIMIT);
	assert.ok(ended.outputTail.endsWith("x"));

	clock.t = 7000;
	const second = store.addAttempt(challenge.id, { angle: "tooling" });
	assert.equal(second.n, 2);
	assert.equal(store.get(challenge.id).attempts.length, 2);

	// failedPaths：去重、≤30 条
	const manyPaths = [];
	for (let i = 0; i < 35; i += 1) manyPaths.push(`path-${i}`);
	manyPaths.push("path-0");
	const endedSecond = store.endAttempt(challenge.id, 2, {
		status: "completed",
		failedPaths: manyPaths,
	});
	assert.equal(endedSecond.failedPaths.length, 30);
	assert.equal(new Set(endedSecond.failedPaths).size, 30);
	assert.equal(endedSecond.failedPaths[0], "path-0");
	assert.ok(!endedSecond.failedPaths.includes("path-30"));
	assert.equal(store.endAttempt(challenge.id, 99, {}), undefined);
});

test("addFlag: 去重、覆盖证据、verified 才 solved 且不自动填 endedAt", (t) => {
	const clock = { t: 100 };
	const { store } = makeStore(t, { now: () => clock.t });
	const challenge = store.addChallenge(challengeInput());

	const candidate = store.addFlag(challenge.id, {
		value: "flag{candidate}",
		verified: false,
		evidence: "第一版证据",
	});
	assert.equal(candidate.verified, false);
	assert.equal(store.get(challenge.id).status, "queued");

	const verified = store.addFlag(challenge.id, {
		value: "flag{candidate}",
		verified: true,
		evidence: "POC 复现 OK",
		method: "local-check",
		attempt: 1,
	});
	assert.equal(store.get(challenge.id).flags.length, 1, "同 value 不应重复登记");
	assert.equal(verified.evidence, "POC 复现 OK");
	assert.equal(verified.method, "local-check");
	assert.equal(store.get(challenge.id).status, "solved");
	assert.equal(store.get(challenge.id).endedAt, null, "addFlag 不自动填 endedAt");

	const lastEvent = store.get(challenge.id).events.at(-1);
	assert.equal(lastEvent.kind, "flag");
	assert.equal(store.get(challenge.id).flags[0].value, "flag{candidate}");

	// 未验证候选不改变 solved 状态
	const other = store.addChallenge({ title: "Other" });
	store.addFlag(other.id, { value: "flag{maybe}" });
	assert.equal(store.get(other.id).status, "queued");
	assert.equal(store.get(other.id).flags[0].verified, false);
	assert.equal(store.addFlag(other.id, { value: "   " }), undefined);
});

test("addFact: 事实链记录", (t) => {
	const clock = { t: 999 };
	const { store } = makeStore(t, { now: () => clock.t });
	const challenge = store.addChallenge(challengeInput());
	const fact = store.addFact(challenge.id, {
		text: "附件是 zip，内含 index.html",
		source: "attempt#1",
		attempt: 1,
	});
	assert.equal(fact.at, 999);
	assert.equal(fact.source, "attempt#1");
	assert.equal(fact.attempt, 1);
	assert.equal(store.get(challenge.id).facts.length, 1);
	assert.equal(store.addFact(challenge.id, { text: "" }), undefined);
});

test("addFact: 上限 120 条、超出丢最旧、同前缀去重", (t) => {
	const { store } = makeStore(t);
	const challenge = store.addChallenge(challengeInput());
	for (let i = 0; i < FACTS_LIMIT + 10; i += 1) {
		store.addFact(challenge.id, { text: `fact-${i}`, attempt: i });
	}
	const facts = store.get(challenge.id).facts;
	assert.equal(facts.length, FACTS_LIMIT);
	assert.equal(facts[0].text, "fact-10", "超出后应丢最旧");
	assert.equal(facts[FACTS_LIMIT - 1].text, `fact-${FACTS_LIMIT + 9}`);
	assert.equal(store.addFact(challenge.id, { text: "" }), undefined);

	// 同一 attempt + 相同 [标签] 前缀：只保留最新一条
	store.addFact(challenge.id, {
		text: "[失败] 第 1 次尝试（角度 recon-first）：路径 A 失败",
		source: "attempt#1",
		attempt: 1,
	});
	store.addFact(challenge.id, {
		text: "[失败] 第 1 次尝试（角度 recon-first）：路径 B 失败",
		source: "attempt#1",
		attempt: 1,
	});
	const after = store.get(challenge.id).facts;
	assert.equal(after.length, FACTS_LIMIT, "同前缀去重后条数不应增长");
	assert.ok(after.some((fact) => fact.text.includes("路径 B")));
	assert.ok(!after.some((fact) => fact.text.includes("路径 A")));

	// 不同 attempt 的 [失败] fact 不互覆盖
	store.addFact(challenge.id, {
		text: "[失败] 第 2 次尝试（角度 tooling）：路径 A 失败",
		source: "attempt#2",
		attempt: 2,
	});
	const crossAttempt = store.get(challenge.id).facts.filter((fact) => fact.text.includes("路径 A"));
	assert.equal(crossAttempt.length, 1);
	assert.equal(crossAttempt[0].attempt, 2);
});

test("stats: 按状态现算", (t) => {
	const { store } = makeStore(t);
	const a = store.addChallenge({ title: "A" });
	const b = store.addChallenge({ title: "B" });
	const c = store.addChallenge({ title: "C" });
	const d = store.addChallenge({ title: "D" });
	store.setStatus(a.id, "solved");
	store.setStatus(b.id, "running");
	store.setStatus(c.id, "stuck");
	store.setStatus(d.id, "stopped");
	const stats = store.stats();
	assert.deepEqual(stats, {
		total: 4,
		queued: 0,
		running: 1,
		solved: 1,
		stuck: 1,
		failed: 0,
		stopped: 1,
	});
	assert.deepEqual({ ...store.state.running }, { [b.id]: true });
});

test("setStatus: 终态自动 endedAt、事件 kind 与 stuckReason", (t) => {
	const clock = { t: 2000 };
	const { store } = makeStore(t, { now: () => clock.t });
	const challenge = store.addChallenge(challengeInput());

	clock.t = 3000;
	store.setStatus(challenge.id, "stuck", { stuckReason: "无思路" });
	const stuck = store.get(challenge.id);
	assert.equal(stuck.status, "stuck");
	assert.equal(stuck.stuckReason, "无思路");
	assert.equal(stuck.endedAt, 3000);
	assert.equal(stuck.events.at(-1).kind, "stuck");
	assert.match(stuck.events.at(-1).text, /无思路/);

	const solved = store.setStatus(challenge.id, "solved", { note: "手动确认" });
	assert.equal(solved.status, "solved");
	assert.equal(solved.stuckReason, "");
	assert.equal(solved.events.at(-1).kind, "flag");
	assert.equal(store.setStatus(challenge.id, "nonsense"), undefined);
});

test("持久化：重开 store 恢复挑战/尝试/flag/fact", (t) => {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	const rootDir = path.join(dir, "root");
	const store1 = createStore(statePath, { rootDir, now: () => 777 });
	const challenge = store1.addChallenge(challengeInput());
	store1.addAttempt(challenge.id, { angle: "hypothesis" });
	store1.endAttempt(challenge.id, 1, {
		status: "completed",
		stopReason: "completed",
		summary: "找到线索",
		outputTail: "tail-output",
	});
	store1.addFlag(challenge.id, {
		value: "flag{persisted}",
		verified: true,
		evidence: "证据",
		method: "derivation",
		attempt: 1,
	});
	store1.addFact(challenge.id, { text: "fact", source: "attempt#1", attempt: 1 });

	store1.close();
	const store2 = createStore(statePath, { rootDir });
	t.after(() => store2.close());
	const loaded = store2.get(challenge.id);
	assert.ok(loaded);
	assert.equal(loaded.title, "Fish Joy in HTML5");
	assert.equal(loaded.status, "solved");
	assert.equal(loaded.slug, challenge.slug);
	assert.equal(loaded.attempts.length, 1);
	assert.equal(loaded.attempts[0].angle, "hypothesis");
	assert.equal(loaded.attempts[0].status, "completed");
	assert.equal(loaded.attempts[0].outputTail, "tail-output");
	assert.equal(loaded.flags.length, 1);
	assert.equal(loaded.flags[0].value, "flag{persisted}");
	assert.equal(loaded.flags[0].verified, true);
	assert.equal(loaded.facts.length, 1);
	assert.equal(store2.findBySlug(challenge.slug).id, challenge.id);
	assert.deepEqual(store2.state.order, [challenge.id]);
});

test("损坏文件：备份 .corrupt-<ts> 后重建空库", (t) => {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	fs.writeFileSync(statePath, "{ this is not json", "utf8");

	const store = createStore(statePath, { rootDir: path.join(dir, "root"), now: () => 4242 });
	assert.deepEqual(store.state.challenges, {});
	assert.deepEqual(store.list(), []);
	const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
	assert.equal(backups.length, 1, `应生成备份: ${fs.readdirSync(dir).join(",")}`);

	// 重建后仍可正常使用
	const challenge = store.addChallenge(challengeInput());
	assert.equal(store.list().length, 1);
	const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
	assert.equal(parsed.challenges[challenge.id].title, "Fish Joy in HTML5");
});

test("形状损坏：challenges 非对象也按损坏处理", (t) => {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	fs.writeFileSync(statePath, JSON.stringify({ version: 1, challenges: [] }), "utf8");
	const store = createStore(statePath, { rootDir: path.join(dir, "root") });
	assert.deepEqual(store.state.challenges, {});
	const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
	assert.equal(backups.length, 1);
});

test("原子落盘：save 后不残留 tmp 文件", (t) => {
	const { dir, store } = makeStore(t);
	const challenge = store.addChallenge(challengeInput());
	store.addEvent(challenge.id, "note", "x");
	const files = fs.readdirSync(dir);
	assert.equal(
		files.filter((name) => name.includes(".tmp-")).length,
		0,
		`不应残留 tmp 文件: ${files.join(",")}`,
	);
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(path.join(dir, "state.json")).mode & 0o777, 0o600);
	}
});

test("store: persistence status reports a failed write and clears after a successful retry", (t) => {
	const { store, statePath } = makeStore(t);
	const saved = fs.readFileSync(statePath, "utf8");
	const rename = fs.renameSync;
	let failing = true;
	t.mock.method(fs, "renameSync", (source, destination) => {
		if (String(destination) === statePath && failing) throw Object.assign(new Error("full"), { code: "ENOSPC" });
		return rename(source, destination);
	});
	assert.throws(() => store.addChallenge(challengeInput()), { code: "STATE_NOT_DURABLE", applied: true });
	assert.equal(store.persistenceStatus().dirty, true);
	assert.equal(store.persistenceStatus().lastError.code, "ENOSPC");
	assert.equal(fs.readFileSync(statePath, "utf8"), saved);
	failing = false;
	assert.equal(store.save(), true);
	assert.equal(store.persistenceStatus().dirty, false);
	assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath)).challenges).length, 1);
});

test("store: newer formats and read errors preserve the original state instead of resetting it", (t) => {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	const future = JSON.stringify({ version: STATE_VERSION + 1, challenges: { future: {} } });
	fs.writeFileSync(statePath, future);
	assert.throws(() => createStore(statePath), { code: "UNSUPPORTED_STATE_VERSION" });
	assert.equal(fs.readFileSync(statePath, "utf8"), future);
	const read = fs.readFileSync;
	t.mock.method(fs, "readFileSync", (file, ...args) => {
		if (String(file) === statePath) throw Object.assign(new Error("denied"), { code: "EACCES" });
		return read(file, ...args);
	});
	assert.throws(() => createStore(statePath), { code: "EACCES" });
	assert.equal(read(statePath, "utf8"), future);
	assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".corrupt-")).length, 0);
});

test("store: corrupt files are never replaced when their preservation backup fails", (t) => {
	const dir = tempDir(t);
	const statePath = path.join(dir, "state.json");
	const original = "broken JSON that must be preserved";
	fs.writeFileSync(statePath, original);
	t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
	t.mock.method(fs, "copyFileSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
	assert.throws(() => createStore(statePath), /无法备份/);
	assert.equal(fs.readFileSync(statePath, "utf8"), original);
});
