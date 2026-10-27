import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildMarkdownReport } from "../../lib/report.js";
import { createStore } from "../../lib/store.js";

function makeBoard(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-report-"));
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const clock = { t: Date.UTC(2026, 0, 1, 0, 0, 0) };
	const store = createStore(path.join(dir, "state.json"), {
		rootDir: path.join(dir, "root"),
		now: () => clock.t,
	});
	return { dir, clock, store };
}

function seedBoard(store) {
	const easy = store.addChallenge({
		title: "Easy Web",
		category: "web",
		statement: "找 flag，目标 http://1.2.3.4",
		target: "http://1.2.3.4",
	});
	const easyAttempt = store.addAttempt(easy.id, { angle: "recon-first" });
	store.endAttempt(easy.id, easyAttempt.n, {
		status: "completed",
		stopReason: "completed",
		summary: "解析了前端 JS，发现 /api/flag",
		outputTail: "SOLVED: flag{web_ok}",
		sessionId: "sess-easy",
	});
	store.addFlag(easy.id, {
		value: "flag{web_ok}",
		verified: true,
		evidence: "curl http://1.2.3.4/api/flag 返回 flag{web_ok}",
		method: "local-check",
		attempt: 1,
	});
	for (let i = 0; i < 5; i += 1) {
		store.addFact(easy.id, { text: `发现 fact-${i}`, source: "attempt#1", attempt: 1 });
	}

	const hard = store.addChallenge({
		title: "Hard Pwn",
		category: "pwn",
		statement: "栈溢出拿 shell",
	});
	const hardAttempt = store.addAttempt(hard.id, { angle: "hypothesis" });
	store.endAttempt(hard.id, hardAttempt.n, {
		status: "completed",
		stopReason: "completed",
		summary: "栈溢出偏移未确定",
		failedPaths: ["offset=64 无响应", "cyclic 1000 无 crash"],
	});
	store.addFact(hard.id, {
		text: "[失败] 试了 cyclic 模式，未 crash",
		source: "attempt#1",
		attempt: 1,
	});
	store.setStatus(hard.id, "stuck", { stuckReason: "无法确定偏移" });

	store.addChallenge({ title: "Crypto 101", category: "", statement: "待做" });
	return { easy, hard };
}

test("buildMarkdownReport: 标题/生成时间/统计/模块分布", (t) => {
	const { store } = makeBoard(t);
	seedBoard(store);
	const generatedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
	const iso = new Date(generatedAt).toISOString();
	const md = buildMarkdownReport(store.state, { generatedAt });

	assert.ok(md.startsWith("# CTF 自动解题复盘报告"));
	assert.ok(md.includes(`- 生成时间：${iso}`));
	assert.ok(md.includes(store.state.rootDir));
	assert.ok(md.includes("统计：总 3 ｜ 排队 1 ｜ 运行 0 ｜ 已解 1 ｜ 卡住 1 ｜ 失败 0 ｜ 停止 0"));
	assert.ok(md.includes("## 按模块分布"));
	assert.ok(md.includes("| web | 1 | 1 | 0 | 0 | 0 |"), md);
	assert.ok(md.includes("| pwn | 1 | 0 | 0 | 1 | 0 |"), md);
	assert.ok(md.includes("| (未分类) | 1 | 0 | 0 | 0 | 0 |"), md);
	assert.ok(md.endsWith("\n"));
});

test("buildMarkdownReport: 逐题 flag 验证方式与证据摘要", (t) => {
	const { store } = makeBoard(t);
	seedBoard(store);
	const md = buildMarkdownReport(store.state, { generatedAt: 0 });

	assert.ok(md.includes("## 题目复盘"));
	assert.ok(md.includes("### 1. Easy Web"));
	assert.ok(md.includes("`flag{web_ok}`"));
	assert.ok(md.includes("已验证"));
	assert.ok(md.includes("方式：local-check"));
	assert.ok(md.includes("attempt #1"));
	assert.ok(md.includes("curl http://1.2.3.4/api/flag 返回 flag{web_ok}"));
	assert.ok(md.includes("工作目录："));
});

test("buildMarkdownReport: attempts 角度/状态/摘要 + 最近 3 条 facts", (t) => {
	const { store } = makeBoard(t);
	seedBoard(store);
	const md = buildMarkdownReport(store.state, { generatedAt: 0 });

	assert.ok(md.includes("第 1 次：角度 `recon-first` ｜ 状态 completed"));
	assert.ok(md.includes("解析了前端 JS，发现 /api/flag"));
	assert.ok(md.includes("最近 3 条"));
	assert.ok(md.includes("fact-2"), "应包含倒数第 3 条");
	assert.ok(md.includes("fact-3"));
	assert.ok(md.includes("fact-4"));
	assert.ok(!md.includes("fact-0"), "最近 3 条不应包含最旧 fact");
	assert.ok(!md.includes("fact-1"));
});

test("buildMarkdownReport: 未解卡点与已试路径", (t) => {
	const { store } = makeBoard(t);
	seedBoard(store);
	const md = buildMarkdownReport(store.state, { generatedAt: 0 });

	assert.ok(md.includes("未解卡点：无法确定偏移"));
	assert.ok(md.includes("已试路径"));
	assert.ok(md.includes("offset=64 无响应"));
	assert.ok(md.includes("cyclic 1000 无 crash"));
	assert.ok(md.includes("试了 cyclic 模式，未 crash"), "应从 [失败] fact 提取失败路径");
	assert.ok(md.includes("## 未解题目汇总"));
	assert.ok(md.includes("Hard Pwn（pwn）：stuck"));
	assert.ok(md.includes("Crypto 101（(未分类)）：queued"));
});

test("buildMarkdownReport: 待验证 flag / failed 统计 / 无卡点记录", () => {
	const state = {
		rootDir: "/tmp/board",
		order: ["x"],
		challenges: {
			x: {
				id: "x",
				title: "Guessy",
				category: "misc",
				status: "failed",
				dir: "/tmp/board/guessy",
				stuckReason: "",
				flags: [
					{
						value: "flag{guess}",
						verified: false,
						evidence: "",
						method: "manual",
						attempt: null,
					},
				],
				attempts: [
					{
						n: 1,
						angle: "tooling",
						status: "error",
						stopReason: "error",
						summary: "脚本崩了",
						failedPaths: [],
					},
				],
				facts: [],
			},
		},
	};
	const md = buildMarkdownReport(state, { generatedAt: 0 });
	assert.ok(md.includes("待验证"));
	assert.ok(md.includes("flag{guess}"));
	assert.ok(md.includes("失败 1"));
	assert.ok(md.includes("未解卡点：（无记录）"));
	assert.ok(md.includes("已试路径：（无记录）"));
	assert.ok(md.includes("错误："));
});

test("buildMarkdownReport: 空题板", (t) => {
	const { store } = makeBoard(t);
	const md = buildMarkdownReport(store.state, { generatedAt: Date.UTC(2026, 0, 2) });
	assert.ok(md.startsWith("# CTF 自动解题复盘报告"));
	assert.ok(md.includes("（暂无题目）"));
	assert.ok(md.includes("统计：总 0"));
	assert.ok(!md.includes("## 按模块分布"), "空题板不输出空表格");
});
