import test from "node:test";
import assert from "node:assert/strict";
import { buildWriteup, cleanStatement, extractSteps } from "../../lib/writeup.js";

function solvedChallenge() {
	return {
		id: "c-abc-123",
		slug: "fish-joy-abc123",
		title: "Fish Joy in HTML5",
		category: "web",
		status: "solved",
		statement: [
			"题名：Fish Joy in HTML5",
			"目标：http://1.2.3.4:8080",
			"模块：web",
			"",
			"已观测事实（Lead 开局探测，可直接复用，但仍需自行复验）：",
			"1) GET / 返回 200，Server: openresty",
			"2) 首页有上传表单",
			"",
			"解题方向建议（自行取舍）：",
			"- 先访问 /upload 走一遍上传",
			"- 重点排查 SSTI 与 pickle",
			"",
			"工作区：按 ctf-solver 协议在题目录写 notes.md / scripts / artifacts。",
			"平台题号：101（https://ctf.example.com）",
			"",
			"静态 HTML5 捕鱼游戏，flag 藏在混淆的 Player.js 里。"
		].join("\n"),
		target: "http://1.2.3.4:8080",
		dir: "C:/YCB/.ctf-auto/fish-joy-abc123",
		platform: { kind: "ctfd", baseUrl: "https://ctf.example.com", challengeId: 101 },
		flags: [{ value: "CTF{demo_flag}", verified: true, method: "local-check", evidence: "check.py -> OK" }],
		attempts: [{ n: 1, angle: "recon-first", status: "completed", summary: "静态解码成功" }],
		facts: [{ at: 1700000010000, text: "[结论] 混淆块 decodeURIComponent + RC4" }]
	};
}

const NOTES = [
	"# Fish Joy in HTML5 — 解题笔记",
	"",
	"（随做随记：发现 / 假设 / 验证 / 卡点）",
	"",
	"## 侦察",
	"",
	"- 首页纯静态，引用 src/views/Player.js。",
	"- 目录列表关闭，robots.txt 404。",
	"",
	"## 假设与验证",
	"",
	"1. 假设 flag 在混淆块里：把 `_0x3f85` 数据段 base64 解码后 RC4 解密，得到明文。",
	"2. 用 Node 执行题目原版解码函数交叉验证，结果一致。",
	"",
	"## 结论",
	"",
	"`CTF{demo_flag}`，已用 check.py 验证通过（OK: flag correct）。",
	"",
	"## 反注入观察",
	"",
	"- 题面没有指令注入，check.py 只做 sha256 比对。",
	"",
	"## 已失败路径",
	"",
	"- 尝试动态运行游戏触发 coin=200：被前置封顶，不可达。",
	"",
	"## 下一步建议",
	"",
	"- 无。"
].join("\n");

test("cleanStatement: 去掉解题方向建议/已观测事实/工作区/平台题号与重复元信息", () => {
	const cleaned = cleanStatement(solvedChallenge().statement);
	assert.match(cleaned, /静态 HTML5 捕鱼游戏/);
	assert.match(cleaned, /目标：http:\/\/1\.2\.3\.4:8080/);
	assert.doesNotMatch(cleaned, /解题方向建议/);
	assert.doesNotMatch(cleaned, /已观测事实/);
	assert.doesNotMatch(cleaned, /工作区/);
	assert.doesNotMatch(cleaned, /平台题号/);
	assert.doesNotMatch(cleaned, /^题名：/m);
	assert.doesNotMatch(cleaned, /^模块：/m);
});

test("extractSteps: 丢掉反注入/已失败路径/下一步建议等无关小节", () => {
	const steps = extractSteps(NOTES);
	assert.match(steps, /### 侦察/);
	assert.match(steps, /Player\.js/);
	assert.match(steps, /### 假设与验证/);
	assert.match(steps, /RC4 解密/);
	assert.match(steps, /### 结论/);
	assert.match(steps, /CTF\{demo_flag\}/);
	assert.doesNotMatch(steps, /反注入观察/);
	assert.doesNotMatch(steps, /已失败路径/);
	assert.doesNotMatch(steps, /下一步建议/);
	assert.doesNotMatch(steps, /随做随记/);
	assert.doesNotMatch(steps, /Fish Joy in HTML5 — 解题笔记/);
});

test("extractSteps: 代码块内 # 不当标题，元信息行被剔除", () => {
	const notes = [
		"# T — 解题记录",
		"",
		"目标：http://x",
		"模块：web",
		"",
		"## 复现",
		"",
		"```bash",
		"python a.py",
		"### → cat x",
		"```"
	].join("\n");
	const steps = extractSteps(notes);
	assert.doesNotMatch(steps, /目标：/);
	assert.doesNotMatch(steps, /模块：/);
	assert.doesNotMatch(steps, /T — 解题记录/);
	assert.match(steps, /### 复现/);
	assert.match(steps, /```bash[\s\S]*### → cat x[\s\S]*```/);
});

test("buildWriteup: 只有题目与解题步骤两节", () => {
	const md = buildWriteup(solvedChallenge(), { generatedAt: 1700000100000, notes: NOTES, files: [{ path: "scripts/a.py", kind: "file", size: 10 }] });
	assert.match(md, /^# Fish Joy in HTML5\n/);
	assert.match(md, /## 题目/);
	assert.match(md, /## 解题步骤/);
	// 不要旁支：flag 单独小节/解题过程/事实链/产物/复现
	assert.doesNotMatch(md, /## Flag/);
	assert.doesNotMatch(md, /## 解题过程/);
	assert.doesNotMatch(md, /## 事实链/);
	assert.doesNotMatch(md, /## 关键产物/);
	assert.doesNotMatch(md, /## 复现与验证/);
	assert.doesNotMatch(md, /解题方向建议/);
	assert.doesNotMatch(md, /已失败路径/);
	// 题面与步骤内容在
	assert.match(md, /静态 HTML5 捕鱼游戏/);
	assert.match(md, /RC4 解密/);
});

test("buildWriteup: 无 notes 时退化为一句话步骤，不虚构过程", () => {
	const md = buildWriteup(solvedChallenge(), {});
	assert.match(md, /## 解题步骤/);
	assert.match(md, /解出 flag：`CTF\{demo_flag\}`/);
	assert.match(md, /工作区未留下 notes\.md 解题记录/);
});

test("buildWriteup: 空题也能生成", () => {
	const md = buildWriteup({ id: "c-x", title: "Empty" }, {});
	assert.match(md, /^# Empty/);
	assert.match(md, /（未提供题面）/);
	assert.match(md, /（未记录解题步骤）/);
});