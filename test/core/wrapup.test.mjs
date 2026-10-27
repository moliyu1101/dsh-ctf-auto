import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../lib/store.js";
import { createOrchestrator } from "../../lib/orchestrator.js";

function tmpBoard() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ctf-wrapup-"));
	return { dir, store: createStore(path.join(dir, "state.json"), { rootDir: dir }) };
}

function waitFor(predicate, timeoutMs = 4000) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			let ok = false;
			try { ok = predicate(); } catch { ok = false; }
			if (ok) { clearInterval(timer); resolve(true); return; }
			if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timeout")); }
		}, 20);
	});
}

test("wrapup：到比例注入收尾消息、记 wrapupAt、宽限后 timeout 收口", async () => {
	const { store } = tmpBoard();
	const ch = store.addChallenge({ title: "Wrapup 冒烟", statement: "不会结束的题" });
	const sent = [];
	const interrupts = [];
	const orchestrator = createOrchestrator({
		store,
		concurrency: 1,
		config: { timeoutMs: 300, wrapupRatio: 0.5, wrapupGraceMs: 200, maxAttempts: 1, autoRetry: false },
		spawn: () => ({
			sessionId: "fake-child",
			done: new Promise(() => {}),
			interrupt: () => interrupts.push(Date.now()),
			send: (text) => { sent.push(String(text)); return Promise.resolve(true); }
		})
	});
	orchestrator.start(ch.id);
	await waitFor(() => sent.length > 0, 2000);
	const attempt = store.get(ch.id).attempts.at(-1);
	assert.equal(sent.length, 1, "只注入一次收尾消息");
	assert.match(sent[0], /预算结算/);
	assert.match(sent[0], /notes\.md/);
	assert.ok(typeof attempt.wrapupAt === "number", "attempt.wrapupAt 已记录");
	assert.equal(attempt.status, "running");
	// 宽限到期 → 中断 + timeout 收口
	await waitFor(() => store.get(ch.id).status === "timeout" || store.get(ch.id).status === "stuck" || store.get(ch.id).status === "failed", 3000);
	const final = store.get(ch.id).attempts.at(-1);
	assert.equal(final.status, "timeout");
	assert.equal(interrupts.length >= 1, true);
	orchestrator.close();
});

test("setConfig：运行时调整并发/超时后新尝试按新配置走", async () => {
	const { store } = tmpBoard();
	const ch = store.addChallenge({ title: "SetConfig 冒烟", statement: "x" });
	const spawned = [];
	const orchestrator = createOrchestrator({
		store,
		config: { timeoutMs: 10000, concurrency: 1, maxAttempts: 1, autoRetry: false },
		spawn: () => {
			spawned.push(Date.now());
			return { sessionId: "s", done: new Promise(() => {}), interrupt: () => {}, send: () => Promise.resolve(true) };
		}
	});
	orchestrator.start(ch.id);
	await waitFor(() => spawned.length === 1, 1000);
	const next = orchestrator.setConfig({ concurrency: 3, timeoutMs: 5000, maxAttempts: 2 });
	assert.equal(next.concurrency, 3);
	assert.equal(next.timeoutMs, 5000);
	assert.equal(next.maxAttempts, 2);
	assert.equal(orchestrator.config.concurrency, 3);
	orchestrator.close();
});