import test from "node:test";
import assert from "node:assert/strict";
import { classifyChallenge, CATEGORIES } from "../../lib/classify.js";

test("classifyChallenge: 12 类关键词基本命中", () => {
	const cases = [
		[{ title: "heap 题目", statement: "libc 堆溢出，给了 elf 附件", files: ["chal.elf"] }, "pwn"],
		[{ title: "crackme", statement: "逆向分析，ollvm 混淆", files: ["crackme.exe"] }, "reverse"],
		[{ title: "RSA 签到", statement: "给 n e c 求明文", files: [] }, "crypto"],
		[{ title: "Baby SQL", statement: "http://t/login 有 sql 注入", target: "http://1.2.3.4:8080" }, "web"],
		[{ title: "流量分析", statement: "给了 pcap 抓包", files: ["traffic.pcap"] }, "forensics"],
		[{ title: "misc 签到", statement: "摩斯密码 + 二维码", files: ["qr.png"] }, "misc"],
		[{ title: "OSINT 找人", statement: "公开信息 地理位置", files: [] }, "osint"],
		[{ title: "样本分析", statement: "恶意样本 c2 beacon", files: [] }, "malware"],
		[{ title: "Android 逆向", statement: "apk 分析 安卓", files: ["app.apk"] }, "mobile"],
		[{ title: "S3 泄露", statement: "aws 元数据 容器", files: [] }, "cloud"],
		[{ title: "LLM 越狱", statement: "prompt 注入 大模型", files: [] }, "ai"],
		[{ title: "域渗透", statement: "kerberoast 域控", files: ["a.evtx"] }, "ad"],
		[{ title: "供应链投毒", statement: "npm 包 依赖投毒", files: [] }, "supply"]
	];
	for (const [input, expected] of cases) {
		const result = classifyChallenge(input);
		assert.equal(result.category, expected, JSON.stringify(input) + " => " + JSON.stringify(result));
		assert.ok(CATEGORIES.includes(result.category));
		assert.ok(result.reasons.length > 0);
	}
});

test("classifyChallenge: 端口/附件类型参与判定", () => {
	assert.equal(classifyChallenge({ title: "chal", target: "nc 1.2.3.4 1337" }).category, "pwn");
	assert.equal(classifyChallenge({ title: "chal", files: ["a.pcap"] }).category, "forensics");
	assert.equal(classifyChallenge({ title: "chal", target: "http://x:8080/" }).category, "web");
});

test("classifyChallenge: 无特征时回落 misc/low", () => {
	const result = classifyChallenge({ title: "签到", statement: "按提示操作" });
	assert.equal(result.category, "misc");
	assert.equal(result.confidence, "low");
});

test("classifyChallenge: 空输入不抛错", () => {
	const result = classifyChallenge();
	assert.equal(result.category, "misc");
	assert.ok(Array.isArray(result.reasons));
});