import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../../lib/store.js";
import { createOrchestrator } from "../../lib/orchestrator.js";

const BASE_TIME = 1700000000000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label = "condition", timeoutMs = 3000) {
	const startedAt = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`waitFor timeout: ${label}`);
		}
		await sleep(5);
	}
}

function makeSpawn(onSpawn) {
	const calls = [];
	const handles = [];
	const spawn = (request) => {
		calls.push(request);
		let resolveDone;
		let rejectDone;
		const done = new Promise((resolve, reject) => {
			resolveDone = resolve;
			rejectDone = reject;
		});
		const handle = {
			sessionId: `sess-${calls.length}`,
			done,
			interrupted: false,
			interruptCount: 0,
			interrupt() {
				handle.interrupted = true;
				handle.interruptCount += 1;
			},
			resolve(value = { stopReason: "completed", outputText: "" }) {
				resolveDone(value);
			},
			reject(error) {
				rejectDone(error);
			},
			request,
		};
		handles.push(handle);
		if (onSpawn) onSpawn(handle, request);
		return handle;
	};
	return { spawn, calls, handles };
}

function makeOrch(t, options = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-orch-"));
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const clock = { t: BASE_TIME };
	const now = () => clock.t;
	const store = createStore(path.join(dir, "state.json"), {
		rootDir: path.join(dir, "root"),
		now,
	});
	const spawnApi = makeSpawn((handle, request) => {
		if (options.handler) options.handler(handle, request, store);
	});
	const logs = [];
	const logger = {
		info: (...args) => logs.push(["info", ...args]),
		warn: (...args) => logs.push(["warn", ...args]),
		error: (...args) => logs.push(["error", ...args]),
	};
	const orchestrator = createOrchestrator({
		store,
		spawn: spawnApi.spawn,
		config: {
			concurrency: 2,
			timeoutMs: 600000,
			maxAttempts: 3,
			autoRetry: false,
			...options.config,
		},
		now,
		logger,
	});
	const addChallenge = (overrides = {}) =>
		store.addChallenge({
			title: "Test Challenge",
			category: "web",
			statement: "运行 echo 后把 TEST{ok} 作为 flag 验证记录",
			...overrides,
		});
	return {
		dir,
		clock,
		now,
		store,
		spawn: spawnApi.spawn,
		calls: spawnApi.calls,
		handles: spawnApi.handles,
		orchestrator,
		logs,
		addChallenge,
		statePath: path.join(dir, "state.json"),
	};
}

test("并发上限：running 达到 concurrency 后排队，腾出槽位再启动", async (t) => {
	const ctx = makeOrch(t, { config: { concurrency: 2 } });
	const first = ctx.addChallenge({ title: "A" });
	const second = ctx.addChallenge({ title: "B" });
	const third = ctx.addChallenge({ title: "C" });

	const firstStart = ctx.orchestrator.start(first.id);
	assert.equal(firstStart.ok, true);
	assert.equal(firstStart.status, "queued");
	ctx.orchestrator.start(second.id);
	const thirdStart = ctx.orchestrator.start(third.id);
	assert.equal(thirdStart.ok, true);
	await waitFor(() => ctx.calls.length === 2, "前两个 spawn");
	assert.equal(ctx.orchestrator.runningCount(), 2);
	assert.equal(ctx.orchestrator.isRunning(first.id), true);
	assert.equal(ctx.orchestrator.isRunning(second.id), true);
	assert.equal(ctx.orchestrator.isRunning(third.id), false);
	assert.equal(ctx.calls[0].challenge.id, first.id);
	assert.equal(ctx.calls[1].challenge.id, second.id);

	ctx.handles[0].resolve();
	await waitFor(() => ctx.calls.length === 3, "第三个 spawn");
	assert.equal(ctx.calls[2].challenge.id, third.id);
	assert.equal(ctx.orchestrator.runningCount(), 2);

	ctx.handles[1].resolve();
	ctx.handles[2].resolve();
	await ctx.orchestrator.whenIdle();
	assert.equal(ctx.orchestrator.runningCount(), 0);
	for (const challenge of ctx.store.list()) {
		assert.equal(challenge.status, "stuck");
	}
});

test("超时看门狗 tick：interrupt + timeout 收口", async (t) => {
	const ctx = makeOrch(t, { config: { timeoutMs: 60000, maxAttempts: 1 } });
	const challenge = ctx.addChallenge({ maxAttempts: 1 });
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");

	ctx.clock.t += 60001;
	const timedOut = ctx.orchestrator.tick();
	assert.deepEqual(timedOut, [challenge.id]);
	await waitFor(() => ctx.store.get(challenge.id).status === "stuck", "stuck 收口");
	const attempt = ctx.store.get(challenge.id).attempts[0];
	assert.equal(attempt.stopReason, "timeout");
	assert.equal(attempt.status, "timeout");
	assert.equal(ctx.handles[0].interrupted, true);
	assert.equal(ctx.orchestrator.isRunning(challenge.id), false);
	assert.deepEqual(ctx.orchestrator.tick(), [], "无运行中任务时 tick 返回空");
});

test("内部 timeout timer 也会收口（不依赖 tick）", async (t) => {
	const ctx = makeOrch(t, { config: { timeoutMs: 40, maxAttempts: 1 } });
	const challenge = ctx.addChallenge({ maxAttempts: 1 });
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");
	await waitFor(() => ctx.store.get(challenge.id).status === "stuck", "timer 超时收口");
	const attempt = ctx.store.get(challenge.id).attempts[0];
	assert.equal(attempt.stopReason, "timeout");
	assert.equal(ctx.handles[0].interrupted, true);
});

test("自动重试：换角度入队、facts/failedPaths 传递到下一次 prompt", async (t) => {
	const ctx = makeOrch(t, {
		config: { autoRetry: true, maxAttempts: 2 },
	});
	const challenge = ctx.addChallenge({ maxAttempts: 2 });
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "第一次 spawn");
	assert.equal(ctx.calls[0].attempt.angle, "recon-first");

	ctx.handles[0].resolve({ stopReason: "completed", outputText: "没有任何发现" });
	await waitFor(() => ctx.calls.length === 2, "第二次 spawn");
	assert.equal(ctx.calls[1].attempt.n, 2);
	assert.equal(ctx.calls[1].attempt.angle, "tooling");

	const firstAttempt = ctx.store.get(challenge.id).attempts[0];
	assert.equal(firstAttempt.status, "completed");
	assert.ok(firstAttempt.failedPaths.length > 0, "第一次失败路径应写入 attempt");
	assert.match(firstAttempt.failedPaths[0], /正常结束但未产出 flag/);
	assert.match(ctx.calls[1].prompt, /前序尝试/);
	assert.match(ctx.calls[1].prompt, /禁止重复/);
	assert.match(ctx.calls[1].prompt, /已失败路径清单/);
	assert.match(ctx.calls[1].prompt, /正常结束但未产出 flag/);
	assert.match(ctx.calls[1].prompt, /recon-first/);

	ctx.handles[1].resolve({ stopReason: "completed", outputText: "候选 flag{candidate}" });
	await ctx.orchestrator.whenIdle();
	const done = ctx.store.get(challenge.id);
	assert.equal(done.status, "stuck");
	assert.equal(done.attempts.length, 2);
	assert.ok(done.stuckReason.length > 0);
	assert.ok(done.flags.some((flag) => flag.value === "flag{candidate}" && !flag.verified));
	assert.ok(done.facts.some((fact) => fact.text.startsWith("[失败]")));
	assert.equal(ctx.calls.length, 2, "maxAttempts 用尽后不再重试");
});

test("成功收口：ctf_flag_record 的 verified flag → solved + endedAt + sessionId", async (t) => {
	const ctx = makeOrch(t, {
		handler: (handle, request, store) => {
			store.addFlag(request.challenge.id, {
				value: "flag{real}",
				verified: true,
				evidence: "check.py 输出 OK",
				method: "local-check",
				attempt: request.attempt.n,
			});
			handle.resolve({
				stopReason: "completed",
				outputText: "SOLVED: flag{real}",
				sessionId: "sess-from-done",
			});
		},
		config: { autoRetry: true, maxAttempts: 3 },
	});
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id);
	await ctx.orchestrator.whenIdle();

	const solved = ctx.store.get(challenge.id);
	assert.equal(solved.status, "solved");
	assert.equal(typeof solved.endedAt, "number");
	assert.equal(solved.stuckReason, "");
	assert.equal(solved.flags.length, 1);
	assert.equal(solved.flags[0].verified, true);
	assert.equal(solved.attempts.length, 1, "已解出不应重试");
	const attempt = solved.attempts[0];
	assert.equal(attempt.status, "completed");
	assert.equal(attempt.stopReason, "completed");
	assert.equal(attempt.sessionId, "sess-from-done");
	assert.match(attempt.summary, /flag\{real\}/);
	assert.ok(solved.events.some((event) => event.kind === "flag"));
	assert.ok(solved.events.some((event) => event.kind === "attempt-end"));
	assert.equal(ctx.calls.length, 1);
	assert.equal(ctx.orchestrator.isRunning(challenge.id), false);

	// 落盘校验：重新打开状态库仍是 solved
	const reopened = createStore(ctx.statePath, { rootDir: ctx.store.state.rootDir });
	const persisted = reopened.get(challenge.id);
	assert.equal(persisted.status, "solved");
	assert.equal(persisted.flags[0].value, "flag{real}");
	assert.equal(persisted.attempts.length, 1);
});

test("stop：interrupt + status=stopped，且不自动重试", async (t) => {
	const ctx = makeOrch(t, { config: { autoRetry: true, maxAttempts: 3 } });
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");

	const result = ctx.orchestrator.stop(challenge.id);
	assert.equal(result.ok, true);
	assert.equal(result.status, "stopped");
	await waitFor(
		() =>
			ctx.store.get(challenge.id).status === "stopped" &&
			ctx.store.get(challenge.id).attempts[0].status === "aborted",
		"stop 收口",
	);
	await sleep(20);
	const stopped = ctx.store.get(challenge.id);
	assert.equal(stopped.status, "stopped");
	assert.equal(stopped.attempts.length, 1, "stop 后不应自动重试");
	assert.equal(stopped.attempts[0].stopReason, "aborted");
	assert.equal(stopped.attempts[0].status, "aborted");
	assert.equal(ctx.handles[0].interrupted, true);
	assert.ok(stopped.events.some((event) => event.kind === "stopped"));
});

test("spawn 抛错：本次 attempt error，最终 stuck，不崩状态机", async (t) => {
	const ctx = makeOrch(t, {
		handler: () => {
			throw new Error("boom-spawn");
		},
	});
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.store.get(challenge.id).status === "stuck", "stuck");
	const attempt = ctx.store.get(challenge.id).attempts[0];
	assert.equal(attempt.status, "error");
	assert.equal(attempt.stopReason, "error");
	assert.match(attempt.error, /boom-spawn/);
	assert.match(ctx.store.get(challenge.id).stuckReason, /boom-spawn/);
	assert.equal(ctx.orchestrator.isRunning(challenge.id), false);
	// 仍可对其它题继续调度
	const other = ctx.addChallenge({ title: "Next" });
	const started = ctx.orchestrator.start(other.id);
	assert.equal(started.ok, true);
	await waitFor(() => ctx.calls.length === 2, "下一题 spawn");
	ctx.handles[1].resolve();
	await ctx.orchestrator.whenIdle();
});

test("done reject：按 error 收口", async (t) => {
	const ctx = makeOrch(t, {
		handler: (handle) => {
			handle.reject(new Error("done-broken"));
		},
	});
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id);
	await ctx.orchestrator.whenIdle();
	const attempt = ctx.store.get(challenge.id).attempts[0];
	assert.equal(attempt.status, "error");
	assert.match(attempt.error, /done-broken/);
});

test("spawn 返回无效句柄：按 error 收口", async (t) => {
	const ctx = makeOrch(t);
	const challenge = ctx.addChallenge();
	// 直接替换 spawn 实现
	const orchestrator = createOrchestrator({
		store: ctx.store,
		spawn: () => null,
		config: { concurrency: 1, timeoutMs: 600000, maxAttempts: 1, autoRetry: false },
		now: ctx.now,
		logger: { info() {}, warn() {}, error() {} },
	});
	orchestrator.start(challenge.id);
	await orchestrator.whenIdle();
	const attempt = ctx.store.get(challenge.id).attempts[0];
	assert.equal(attempt.status, "error");
	assert.match(attempt.error, /无效句柄/);
});

test("stopAll：只停止运行中的尝试，排队中的保持 queued（dispose 安全）", async (t) => {
	const ctx = makeOrch(t, { config: { concurrency: 1 } });
	const first = ctx.addChallenge({ title: "A" });
	const second = ctx.addChallenge({ title: "B" });
	ctx.orchestrator.start(first.id);
	ctx.orchestrator.start(second.id);
	await waitFor(() => ctx.calls.length === 1, "第一个 spawn");

	const result = ctx.orchestrator.stopAll();
	assert.deepEqual(result.stopped, [first.id]);
	assert.equal(ctx.store.get(first.id).status, "stopped");
	assert.equal(ctx.store.get(second.id).status, "queued", "排队题目不应被 dispose 误置 stopped");
	await waitFor(() => ctx.store.get(first.id).attempts[0].status === "aborted", "abort");
	assert.equal(ctx.handles[0].interrupted, true);
});

test("retry：重新入队、注入 hint 到下一次 prompt、放宽已用尽预算", async (t) => {
	const ctx = makeOrch(t, { config: { autoRetry: true, maxAttempts: 1 } });
	const challenge = ctx.addChallenge({ maxAttempts: 1 });
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");
	ctx.handles[0].resolve({ stopReason: "completed", outputText: "" });
	await waitFor(() => ctx.store.get(challenge.id).status === "stuck", "stuck");

	const retried = ctx.orchestrator.retry(challenge.id, "试试 PNG 的 LSB 隐写");
	assert.equal(retried.ok, true);
	assert.equal(retried.status, "queued");
	await waitFor(() => ctx.calls.length === 2, "重试 spawn");
	assert.equal(ctx.calls[1].attempt.angle, "tooling");
	assert.match(ctx.calls[1].prompt, /试试 PNG 的 LSB 隐写/);
	assert.match(ctx.calls[1].prompt, /附加提示/);
	assert.equal(ctx.store.get(challenge.id).attempts.length, 2);
	assert.equal(ctx.store.get(challenge.id).budget.maxAttempts, 2, "手动重试应放宽预算");
	assert.ok(
		ctx.store.get(challenge.id).events.some(
			(event) =>
				event.kind === "note" && event.text.includes("人工重试提示"),
		),
	);

	ctx.handles[1].resolve({ stopReason: "completed", outputText: "" });
	await ctx.orchestrator.whenIdle();
	assert.equal(ctx.store.get(challenge.id).status, "stuck");
});

test("spawn request 契约：字段齐全、agentPreset 默认 ctf-solver、prompt 含绝对时间", async (t) => {
	const ctx = makeOrch(t);
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");
	const request = ctx.calls[0];

	assert.equal(request.label, `ctf-${challenge.id}#1`);
	assert.equal(request.cwd, challenge.dir);
	assert.equal(request.agentPreset, "ctf-solver");
	assert.equal(request.attempt.n, 1);
	assert.equal(request.challenge.id, challenge.id);
	assert.ok(request.signal instanceof AbortSignal, "应提供 AbortSignal");
	assert.match(request.prompt, /Test Challenge/);
	assert.match(request.prompt, /运行 echo 后把 TEST\{ok\} 作为 flag 验证记录/);
	assert.ok(request.prompt.includes("2023-11-14T22:13:20.000Z"), "now 绝对时间");
	assert.ok(request.prompt.includes("2023-11-14T22:23:20.000Z"), "deadline 绝对时间");
	assert.match(request.prompt, /本次尝试截止/);
	assert.match(request.prompt, /R-1/);

	ctx.handles[0].resolve();
	await ctx.orchestrator.whenIdle();
});

test("start(agentPreset)：自定义 preset 透传到 spawn", async (t) => {
	const ctx = makeOrch(t);
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id, { agentPreset: "custom-solver" });
	await waitFor(() => ctx.calls.length === 1, "spawn");
	assert.equal(ctx.calls[0].agentPreset, "custom-solver");
	ctx.handles[0].resolve();
	await ctx.orchestrator.whenIdle();
});

test("start：重复启动/已解出/不存在 的返回值", async (t) => {
	const ctx = makeOrch(t);
	const challenge = ctx.addChallenge();
	assert.equal(ctx.orchestrator.start("missing").ok, false);
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");
	assert.equal(ctx.orchestrator.start(challenge.id).ok, false, "运行中也拒绝重复 start");
	ctx.handles[0].resolve();
	await ctx.orchestrator.whenIdle();
	ctx.store.setStatus(challenge.id, "solved");
	assert.equal(ctx.orchestrator.start(challenge.id).ok, false);
	assert.equal(ctx.orchestrator.start(challenge.id).error, "题目已解出");
});

test("close：取消 timer、interrupt 运行中、关闭后拒绝 start", async (t) => {
	const ctx = makeOrch(t);
	const challenge = ctx.addChallenge();
	ctx.orchestrator.start(challenge.id);
	await waitFor(() => ctx.calls.length === 1, "spawn");
	const result = ctx.orchestrator.close();
	assert.deepEqual(result.stopped, [challenge.id]);
	await waitFor(() => ctx.store.get(challenge.id).status === "stopped", "close 后 stopped");
	assert.equal(ctx.handles[0].interrupted, true);
	assert.equal(ctx.orchestrator.isRunning(challenge.id), false);
	const afterClose = ctx.orchestrator.start(challenge.id);
	assert.equal(afterClose.ok, false);
	assert.match(afterClose.error, /关闭/);
});

test("whenIdle：自动重试链全部跑完后才返回", async (t) => {
	const ctx = makeOrch(t, {
		config: { autoRetry: true, maxAttempts: 2 },
		handler: (handle) => {
			handle.resolve({ stopReason: "completed", outputText: "" });
		},
	});
	const challenge = ctx.addChallenge({ maxAttempts: 2 });
	ctx.orchestrator.start(challenge.id);
	await ctx.orchestrator.whenIdle();
	const challengeAfter = ctx.store.get(challenge.id);
	assert.equal(ctx.calls.length, 2);
	assert.equal(challengeAfter.attempts.length, 2);
	assert.equal(challengeAfter.status, "stuck");
});

test("store.save 抛错也不崩状态机", async (t) => {
	const ctx = makeOrch(t, {
		handler: (handle, request, store) => {
			store.addFlag(request.challenge.id, {
				value: "flag{diskless}",
				verified: true,
				evidence: "ok",
				method: "local-check",
			});
			handle.resolve({ stopReason: "completed", outputText: "" });
		},
	});
	const challenge = ctx.addChallenge();
	ctx.store.save = () => {
		throw new Error("disk full");
	};
	ctx.orchestrator.start(challenge.id);
	await ctx.orchestrator.whenIdle();
	assert.equal(ctx.store.get(challenge.id).status, "solved");
	assert.ok(
		ctx.logs.some((entry) => entry[0] === "error" && String(entry[1]).includes("store.save")),
		"应记录 save 失败日志",
	);
});

test("记忆召回：相似打法卡注入 prompt、记录 attempt.memories、解出后记 usedOk", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-mem-"));
	const store = createStore(path.join(dir, "state.json"), { rootDir: dir });
	const ch = store.addChallenge({ title: "Baby Flask zip symlink", statement: "flask upload zip symlink 任意文件读取", category: "web" });
	const recalled = [
		{ id: "mem-baby-python", title: "Baby Python", category: "web", tech: ["zip-symlink", "file-read"], entry: "http://x", steps: ["构造 symlink zip"], commands: ["python readfile.py /proc/self/environ"], pitfalls: ["SECRET_KEY 爆破未命中"], score: 0.62 }
	];
	const usedCalls = [];
	const { spawn, calls } = makeSpawn((handle) => {
		setTimeout(() => {
			store.addFlag(ch.id, { value: "CTF{mem}", verified: true, evidence: "check.py OK exit 0", method: "local-check" });
			handle.resolve({ stopReason: "completed", outputText: "SOLVED: CTF{mem}" });
		}, 5);
	});
	const orchestrator = createOrchestrator({
		store, spawn,
		config: { maxAttempts: 1, autoRetry: false },
		recall: () => recalled,
		onMemoriesUsed: (ids, ok) => usedCalls.push({ ids, ok })
	});
	orchestrator.setConfig({ maxAttempts: 1, autoRetry: false });
	orchestrator.start(ch.id);
	await orchestrator.whenIdle();
	assert.equal(calls.length, 1);
	assert.match(calls[0].prompt, /相似题记忆/);
	assert.match(calls[0].prompt, /Baby Python/);
	assert.match(calls[0].prompt, /不得直接采信历史 flag/);
	const attempt = store.get(ch.id).attempts[0];
	assert.equal(attempt.memories.length, 1);
	assert.equal(attempt.memories[0].id, "mem-baby-python");
	assert.ok(usedCalls.some((call) => call.ok === true && call.ids.includes("mem-baby-python")));
	assert.equal(store.get(ch.id).status, "solved");
});

test("知识+记忆召回：pack 注入 prompt、attempt.knowledge 记录、onKnowledgeUsed 计数", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-pack-"));
	const store = createStore(path.join(dir, "state.json"), { rootDir: dir });
	const ch = store.addChallenge({ title: "Flask 任意文件读取", statement: "flask upload zip 任意文件读取", category: "web" });
	const memories = [{ id: "mem-1", title: "Baby Python", category: "web", tech: ["zip-symlink"], score: 0.9 }];
	const knowledge = [{ id: "writeup:a.md", title: "baby-python", source: "writeup", sourceLabel: "Writeup", score: 0.6, text: "zip symlink 读取", path: "/w/a.md" }];
	const kbCalls = [];
	const { spawn, calls } = makeSpawn((handle) => {
		setTimeout(() => handle.resolve({ stopReason: "completed", outputText: "STUCK: 未解" }), 5);
	});
	const orchestrator = createOrchestrator({
		store, spawn,
		config: { maxAttempts: 1, autoRetry: false },
		recall: () => ({ memories, knowledge }),
		onKnowledgeUsed: (ids, ok) => kbCalls.push({ ids, ok })
	});
	orchestrator.start(ch.id);
	await orchestrator.whenIdle();
	assert.match(calls[0].prompt, /相关知识库片段/);
	assert.match(calls[0].prompt, /ctf_kb_search/);
	const attempt = store.get(ch.id).attempts[0];
	assert.equal(attempt.knowledge.length, 1);
	assert.equal(attempt.knowledge[0].id, "writeup:a.md");
	assert.ok(kbCalls.some((call) => call.ids.includes("writeup:a.md") && call.ok === false));
});

test("成本估算：attempt 记录 promptChars/outputChars/estTokens/estCost", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-cost-"));
	const store = createStore(path.join(dir, "state.json"), { rootDir: dir });
	const ch = store.addChallenge({ title: "Cost", statement: "算一下用量", category: "misc" });
	const { spawn } = makeSpawn((handle) => {
		setTimeout(() => { store.addFlag(ch.id, { value: "CTF{cost}", verified: true, evidence: "check OK exit 0", method: "local-check" }); handle.resolve({ stopReason: "completed", outputText: "SOLVED: CTF{cost}\n" + "x".repeat(4000) }); }, 5);
	});
	const orchestrator = createOrchestrator({ store, spawn, config: { maxAttempts: 1, autoRetry: false, pricePerMToken: 2 } });
	orchestrator.start(ch.id);
	await orchestrator.whenIdle();
	const attempt = store.get(ch.id).attempts[0];
	assert.ok(attempt.promptChars > 100, "promptChars=" + attempt.promptChars);
	assert.ok(attempt.outputChars >= 4000, "outputChars=" + attempt.outputChars);
	assert.ok(attempt.estTokens > 0, "estTokens=" + attempt.estTokens);
	assert.ok(attempt.estCost >= 0, "estCost=" + attempt.estCost);
});
