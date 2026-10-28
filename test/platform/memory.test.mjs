import test from "node:test";
import assert from "node:assert/strict";
import { distillCard, normalizeCard, scoreMemory, rankMemories, buildMemoryPromptSection, tokenize, extractTech } from "../../lib/memory.js";

const NOTES = [
	"# Baby Python — 解题记录",
	"",
	"目标：http://1.2.3.4:8080/",
	"",
	"## 1. 侦察",
	"- 首页 openresty，flask session 三段式，提示 become admin。",
	"- POST /upload 需要 zip。",
	"",
	"## 2. 关键突破：zip 符号链接 → 任意文件读取",
	"构造 zip 里的 symlink 条目，目标端 unzip 保留符号链接，cat 跟随链接输出内容。",
	"",
	"```bash",
	"python scripts/readfile.py /proc/self/environ",
	"```",
	"",
	"## 3. 结论",
	"FLAG=CTF2{abc}",
	"",
	"## 已失败路径",
	"- 会话 SECRET_KEY 爆破未命中",
	"- 常见路径全 404"
].join("\n");

const CH = {
	id: "c-1",
	slug: "baby-python",
	title: "Baby Python",
	category: "web",
	statement: "flask 应用，有 /upload 上传 zip，需要 become admin",
	target: "http://1.2.3.4:8080/",
	workspace: "C:/ws",
	facts: [{ text: "[结论] zip 符号链接可任意文件读取" }],
	flags: [{ value: "CTF2{abc}", verified: true, method: "local-check" }]
};

test("memory: distillCard 抽出技法/入口/步骤/命令/坑", () => {
	const card = distillCard(CH, { notes: NOTES });
	assert.equal(card.title, "Baby Python");
	assert.ok(card.tech.includes("zip-symlink"), JSON.stringify(card.tech));
	assert.ok(card.tech.includes("file-read"));
	assert.ok(card.tech.includes("flask-session"));
	assert.equal(card.entry, "http://1.2.3.4:8080/");
	assert.ok(card.steps.length >= 2);
	assert.ok(card.commands.some((c) => c.startsWith("python scripts/readfile.py")));
	assert.ok(card.pitfalls.some((p) => p.includes("SECRET_KEY")));
	assert.equal(card.flagPattern.includes("{"), true);
	assert.ok(!card.flagPattern.includes("abc"), "打法卡不应存原始 flag");
	assert.equal(card.used, 0);
	assert.equal(card.usedOk, 0);
});

test("memory: scoreMemory 相似题高分、无关题低分", () => {
	const card = distillCard(CH, { notes: NOTES });
	const similar = scoreMemory(card, {
		id: "c-2",
		title: "Baby Flask Again",
		category: "web",
		statement: "flask upload zip symlink 任意文件读取，become admin"
	});
	const unrelated = scoreMemory(card, {
		id: "c-3",
		title: "RSA 签到",
		category: "crypto",
		statement: "给 n e c，求明文"
	});
	assert.ok(similar > 0.2, "similar=" + similar);
	assert.ok(similar > unrelated, similar + " vs " + unrelated);
});

test("memory: rankMemories 过滤自身/阈值/排序/limit", () => {
	const card = distillCard(CH, { notes: NOTES });
	const other = { ...card, id: "mem-other", sourceChallengeId: "c-9", title: "Unrelated", category: "crypto", tech: [], steps: [], commands: [], pitfalls: [], entry: "", summary: "" };
	const target = { id: "c-2", title: "Baby Flask", category: "web", statement: "flask zip symlink 任意文件读取" };
	const ranked = rankMemories([card, other], target, { limit: 2 });
	assert.equal(ranked.length, 1);
	assert.equal(ranked[0].sourceChallengeId, "c-1");
	const self = rankMemories([card], { ...target, id: "c-1" });
	assert.deepEqual(self, []);
});

test("memory: buildMemoryPromptSection 生成注入片段与告警", () => {
	const card = distillCard(CH, { notes: NOTES });
	const section = buildMemoryPromptSection([{ ...card, score: 0.62 }]);
	assert.match(section, /相似题记忆/);
	assert.match(section, /相似度 0\.62/);
	assert.match(section, /不得直接采信历史 flag/);
	assert.match(section, /zip-symlink/);
	assert.equal(buildMemoryPromptSection([]), "");
	assert.equal(buildMemoryPromptSection(null), "");
});

test("memory: tokenize/extractTech 基础行为", () => {
	assert.ok(tokenize("ZIP Symlink 任意文件读取").size > 3);
	assert.ok(extractTech("heap + libc + ROP + seccomp").includes("heap"));
	assert.deepEqual(extractTech(""), []);
});

test("memory v2: 结构化字段/置信度/前置/步骤命令", () => {
	const card = distillCard(CH, { notes: NOTES, notesPath: "C:/ws/notes.md" });
	assert.equal(card.version, 2);
	assert.ok(card.fingerprint.length > 0);
	assert.ok(card.stepDetails.length >= 2);
	assert.ok(card.stepDetails.some((step) => step.command.includes("readfile.py")));
	assert.ok(card.prerequisites.length >= 2);
	assert.ok(card.tooling.includes("unzip") || card.tooling.includes("curl"));
	assert.equal(card.verification.verified, true);
	assert.ok(card.confidence > 0.5);
	assert.equal(card.links.notesPath, "C:/ws/notes.md");
	assert.equal(card.metrics.attempts, 0);
});

test("memory v2: normalizeCard 兼容 v1 并补齐结构", () => {
	const legacy = { id: "mem-old", title: "Old", tech: ["pcap"], steps: ["解包", "重组"], used: 2, usedOk: 1 };
	const card = normalizeCard(legacy);
	assert.equal(card.version, 2);
	assert.equal(card.stepDetails.length, 2);
	assert.equal(card.metrics.successRate, 0.5);
	assert.equal(card.kind, "triage");
	assert.deepEqual(card.prerequisites, []);
});
