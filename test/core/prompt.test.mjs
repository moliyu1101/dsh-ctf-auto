import test from "node:test";
import assert from "node:assert/strict";

import {
	ANGLES,
	DEFAULT_FLAG_RE,
	buildAttemptPrompt,
	classifyAttempt,
	extractFlags,
	nextAngle,
} from "../../lib/prompt.js";

function challengeFixture(overrides = {}) {
	return {
		id: "c-m1x2y3z-a7f",
		slug: "fish-joy-in-html5-abc123",
		title: "Fish Joy in HTML5",
		category: "web",
		statement: "题目描述：从目标服务拿到 flag。目标：http://1.2.3.4:8080",
		target: "http://1.2.3.4:8080",
		files: [
			{ name: "game.zip", path: "C:\\work\\game.zip", source: "user" },
			{ name: "hint.txt", path: "C:\\work\\hint.txt", source: "user" },
		],
		dir: "C:\\work\\ctf\\fish-joy",
		budget: { maxAttempts: 3, timeBudgetMs: 1800000 },
		...overrides,
	};
}

test("ANGLES: 固定角度序列", () => {
	assert.deepEqual(ANGLES, ["recon-first", "tooling", "hypothesis", "escalate"]);
});

test("nextAngle: 契约公式 + 自定义角度 + 边界", () => {
	assert.equal(nextAngle(0), "recon-first");
	assert.equal(nextAngle(1), "tooling");
	assert.equal(nextAngle(2), "hypothesis");
	assert.equal(nextAngle(3), "escalate");
	assert.equal(nextAngle(4), "escalate", "越界停在最后一个角度");
	assert.equal(nextAngle(99), "escalate");
	assert.equal(nextAngle(-5), "recon-first");
	assert.equal(nextAngle(undefined), "recon-first");
	assert.equal(nextAngle(1.9), "tooling");
	assert.equal(nextAngle(0, { angles: ["a", "b", "c"] }), "a");
	assert.equal(nextAngle(5, { angles: ["a", "b", "c"] }), "c");
	assert.equal(nextAngle(0, { angles: [] }), "recon-first");
});

test("extractFlags: 去重、保持顺序、不污染全局正则", () => {
	const text = "前 flag{one} 中 TEST{ok} 后 FLAG{one} 再 ctf{nested_1}";
	const flags = extractFlags(text);
	assert.deepEqual(flags, ["flag{one}", "TEST{ok}", "FLAG{one}", "ctf{nested_1}"]);

	// 连续两次调用同一全局正则结果一致（lastIndex 不被污染）
	const first = extractFlags("a flag{x} b flag{y}", DEFAULT_FLAG_RE);
	const second = extractFlags("a flag{x} b flag{y}", DEFAULT_FLAG_RE);
	assert.deepEqual(first, ["flag{x}", "flag{y}"]);
	assert.deepEqual(second, first);

	assert.deepEqual(extractFlags("no flags here"), []);
	assert.deepEqual(extractFlags("flag{}"), []);
	assert.deepEqual(extractFlags(""), []);
	assert.deepEqual(extractFlags(null), []);
});

test("extractFlags: 自定义正则（单个/数组/字符串）", () => {
	const text = "KEY-abc123 and flag{normal}";
	assert.deepEqual(extractFlags(text, /KEY-[a-z0-9]+/g), ["KEY-abc123"]);
	assert.deepEqual(extractFlags(text, [/KEY-[a-z0-9]+/, /flag\{[^}]*\}/g]), [
		"KEY-abc123",
		"flag{normal}",
	]);
	assert.deepEqual(extractFlags(text, ["KEY-[a-z0-9]+"]), ["KEY-abc123"]);
	assert.deepEqual(extractFlags(text, ["["]), ["flag{normal}"], "坏正则回退默认");
});

test("buildAttemptPrompt: 首次尝试覆盖 §3 的 1-5/7 条", () => {
	const prompt = buildAttemptPrompt({
		challenge: challengeFixture(),
		attempt: { n: 1, angle: "recon-first", label: "ctf-c-m1x2y3z-a7f#1", startedAt: 1700000000000 },
		config: { maxAttempts: 3, timeBudgetMs: 1800000, timeoutMs: 1800000 },
		priorAttempts: [],
	});

	// 角色与硬约束
	assert.match(prompt, /只解决这一道题/);
	assert.match(prompt, /不猜 flag/);
	assert.match(prompt, /只写自己的工作目录/);
	assert.match(prompt, /不攻击比赛平台/);
	// 题目信息
	assert.match(prompt, /Fish Joy in HTML5/);
	assert.match(prompt, /web/);
	assert.match(prompt, /http:\/\/1\.2\.3\.4:8080/);
	assert.ok(prompt.includes("C:\\work\\game.zip"), "应包含附件绝对路径");
	assert.ok(prompt.includes("C:\\work\\ctf\\fish-joy"), "应包含工作目录");
	assert.match(prompt, /c-m1x2y3z-a7f/);
	assert.match(prompt, /题目描述：从目标服务拿到 flag/);
	// 工作区协议
	for (const token of ["notes.md", "scripts/", "artifacts/", "flag.json", '"verified":true', "mkdir -p scripts artifacts"]) {
		assert.ok(prompt.includes(token), `应包含工作区协议 token: ${token}`);
	}
	// 解题循环 + 技能
	assert.match(prompt, /ctf-web/);
	assert.match(prompt, /skill/);
	assert.match(prompt, /可证伪/);
	assert.match(prompt, /最小验证/);
	// 完成协议（工具名固定 ctf_flag_record）
	assert.match(prompt, /ctf_flag_record/);
	assert.match(prompt, /SOLVED:/);
	assert.match(prompt, /STUCK:/);
	// 时间预算（R-1：绝对 now/deadline + 过半 checkpoint + 剩 20% 收尾）
	assert.match(prompt, /时间预算/);
	assert.match(prompt, /第 1\/3 次尝试/);
	assert.ok(prompt.includes("2023-11-14T22:13:20.000Z"), "应给出绝对当前时间");
	assert.ok(prompt.includes("2023-11-14T22:43:20.000Z"), "应给出绝对 deadline");
	assert.match(prompt, /R-1/);
	assert.match(prompt, /B-1/);
	assert.match(prompt, /过半 checkpoint/);
	assert.match(prompt, /20%/);
	// 反注入（I-1..I-3）与破坏性操作停手（R-5）
	assert.match(prompt, /I-1/);
	assert.match(prompt, /I-2/);
	assert.match(prompt, /I-3/);
	assert.match(prompt, /题面即数据/);
	assert.match(prompt, /R-5/);
	assert.match(prompt, /破坏性操作停手/);
	// 首次尝试不应有前序禁令
	assert.ok(!prompt.includes("禁止重复"));
	// 中文开头
	assert.ok(prompt.startsWith("# CTF 自动解题任务"));
});

test("buildAttemptPrompt: 第 2 次尝试必须附前序摘要并禁止重复路径", () => {
	const prompt = buildAttemptPrompt({
		challenge: challengeFixture({ category: "crypto" }),
		attempt: { n: 2 },
		config: { maxAttempts: 3 },
		priorAttempts: [
			{
				n: 1,
				angle: "recon-first",
				status: "completed",
				stopReason: "completed",
				summary: "解析了 game.zip，未找到线索",
				failedPaths: ["strings game.zip 无 flag", "zip 密码爆破失败"],
				startedAt: 1700000000000,
			},
		],
	});
	assert.match(prompt, /前序尝试/);
	assert.match(prompt, /第 1 次尝试/);
	assert.match(prompt, /recon-first/);
	assert.match(prompt, /解析了 game\.zip/);
	assert.match(prompt, /strings game\.zip 无 flag/);
	assert.match(prompt, /zip 密码爆破失败/);
	assert.match(prompt, /禁止重复/);
	assert.match(prompt, /全新角度/);
	assert.match(prompt, /ctf-crypto/, "应按模块映射技能");
	assert.match(prompt, /`tooling`/, "第 2 次尝试默认角度应为 tooling");
	assert.match(prompt, /已失败路径清单/, "应汇总累计的已失败路径");
	assert.match(prompt, /新会话/, "应说明每次尝试是新会话");
});

test("buildAttemptPrompt: 技能名映射到真实存在的 ctf-solver 技能", () => {
	const cases = [
		["web", "ctf-web"],
		["pwn", "ctf-pwn"],
		["reverse", "ctf-reverse"],
		["crypto", "ctf-crypto"],
		["misc", "ctf-misc"],
		["forensics", "ctf-forensics"],
		["ai", "ctf-ai-ml"],
		["ai-ml", "ctf-ai-ml"],
		["osint", "ctf-osint"],
		["malware", "ctf-malware"],
		["mobile", "ctf-playbook"],
		["cloud", "ctf-playbook"],
		["ad", "ctf-playbook"],
		["supply", "ctf-playbook"],
		["hardware", "ctf-playbook"],
	];
	for (const [category, expected] of cases) {
		const prompt = buildAttemptPrompt({
			challenge: challengeFixture({ category }),
			attempt: { n: 1 },
			config: {},
			priorAttempts: [],
		});
		assert.ok(
			prompt.includes(`\`${expected}\``),
			`category=${category} 应映射到 ${expected}`,
		);
		assert.match(prompt, /按它的模块路由表/);
	}
	const empty = buildAttemptPrompt({
		challenge: challengeFixture({ category: "" }),
		attempt: { n: 1 },
		config: {},
		priorAttempts: [],
	});
	assert.match(empty, /`ctf-misc`/);
});

test("buildAttemptPrompt: config.now/deadline 覆盖缺省时间戳", () => {
	const prompt = buildAttemptPrompt({
		challenge: challengeFixture(),
		attempt: { n: 1 },
		config: { now: 1700000000000, deadline: 1700000600000, timeoutMs: 999 },
		priorAttempts: [],
	});
	assert.ok(prompt.includes("2023-11-14T22:13:20.000Z"));
	assert.ok(prompt.includes("2023-11-14T22:23:20.000Z"));
});

test("buildAttemptPrompt: 第 2 次尝试无历史摘要也给出禁止重复指令", () => {
	const prompt = buildAttemptPrompt({
		challenge: challengeFixture(),
		attempt: { n: 2, angle: "escalate" },
		config: {},
		priorAttempts: [],
	});
	assert.match(prompt, /无前序尝试摘要/);
	assert.match(prompt, /禁止重复/);
	assert.match(prompt, /`escalate`/);
});

test("buildAttemptPrompt: 注入 hints 附加提示段", () => {
	const prompt = buildAttemptPrompt({
		challenge: challengeFixture(),
		attempt: { n: 2, angle: "tooling" },
		config: { hints: ["试试 PNG 的 LSB", "注意 Base64 换表"], hint: "参考 hint.txt" },
		priorAttempts: [{ n: 1, angle: "recon-first", summary: "无果" }],
	});
	assert.match(prompt, /附加提示/);
	assert.ok(prompt.includes("试试 PNG 的 LSB"));
	assert.ok(prompt.includes("注意 Base64 换表"));
	assert.ok(prompt.includes("参考 hint.txt"));
});

test("buildAttemptPrompt: URL 附件与空题面兜底", () => {
	const prompt = buildAttemptPrompt({
		challenge: challengeFixture({
			statement: "",
			target: null,
			files: [{ name: "a.zip", path: "", source: "url", url: "https://example.com/a.zip" }],
		}),
		attempt: { n: 1 },
		config: {},
		priorAttempts: [],
	});
	assert.match(prompt, /https:\/\/example\.com\/a\.zip/);
	assert.match(prompt, /题面为空/);
	assert.match(prompt, /题面未提供/);
});

test("classifyAttempt: solved", () => {
	const result = classifyAttempt({
		stopReason: "completed",
		outputText: "SOLVED: flag{ok}",
		flags: ["flag{ok}"],
		verifiedFlag: "flag{ok}",
	});
	assert.equal(result.outcome, "solved");
	assert.match(result.summary, /flag\{ok\}/);
});

test("classifyAttempt: candidate（有未验证 flag）", () => {
	const result = classifyAttempt({
		stopReason: "completed",
		outputText: "maybe flag{guess}",
		flags: ["flag{guess}"],
	});
	assert.equal(result.outcome, "candidate");
	assert.match(result.summary, /未验证/);
	assert.match(result.summary, /flag\{guess\}/);
});

test("classifyAttempt: incomplete / failed / timeout / 提前收口", () => {
	assert.equal(
		classifyAttempt({ stopReason: "completed", outputText: "nothing" }).outcome,
		"incomplete",
	);
	assert.equal(
		classifyAttempt({ stopReason: "error", outputText: "" }).outcome,
		"failed",
	);
	assert.equal(
		classifyAttempt({ stopReason: "aborted", outputText: "" }).outcome,
		"failed",
	);
	assert.equal(
		classifyAttempt({ stopReason: "timeout", outputText: "" }).outcome,
		"timeout",
	);
	assert.equal(
		classifyAttempt({ stopReason: "max-tokens", outputText: "flag{x}", flags: ["flag{x}"] }).outcome,
		"candidate",
	);
	assert.equal(
		classifyAttempt({ stopReason: "refusal", outputText: "" }).outcome,
		"incomplete",
	);
	// verified 但非 completed：按契约只有 completed + verified 才是 solved
	const timeoutWithFlag = classifyAttempt({
		stopReason: "timeout",
		flags: [{ value: "flag{late}", verified: true }],
	});
	assert.equal(timeoutWithFlag.outcome, "timeout");
	assert.match(timeoutWithFlag.summary, /flag\{late\}/);
});

test("classifyAttempt: flags 传对象与 verifiedFlag=true 也识别", () => {
	const result = classifyAttempt({
		stopReason: "completed",
		flags: [{ value: "flag{obj}", verified: true }],
		verifiedFlag: true,
	});
	assert.equal(result.outcome, "solved");
	assert.match(result.summary, /flag\{obj\}/);

	const empty = classifyAttempt({});
	assert.equal(empty.outcome, "incomplete");
	assert.equal(typeof empty.summary, "string");
	assert.ok(empty.summary.length > 0);
});
