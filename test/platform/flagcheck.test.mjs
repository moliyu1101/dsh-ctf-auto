import test from "node:test";
import assert from "node:assert/strict";
import { validateVerifiedFlag, compilePatterns, DEFAULT_FLAG_PATTERNS } from "../../lib/flagcheck.js";

const GOOD_EVIDENCE = 'python check.py "CTF{x}" -> OK: flag correct (exit 0)';

test("validateVerifiedFlag: 正常 flag + 证据通过", () => {
	const result = validateVerifiedFlag("CTF{demo_flag}", { evidence: GOOD_EVIDENCE });
	assert.equal(result.ok, true);
	assert.equal(result.code, "ok");
});

test("validateVerifiedFlag: 格式不符/空/多行拒绝", () => {
	assert.equal(validateVerifiedFlag("", { evidence: GOOD_EVIDENCE }).code, "empty");
	assert.equal(validateVerifiedFlag("not-a-flag", { evidence: GOOD_EVIDENCE }).code, "format");
	assert.equal(validateVerifiedFlag("CTF{a\nb}", { evidence: GOOD_EVIDENCE }).code, "multi-line");
	assert.equal(validateVerifiedFlag("CTF{" + "x".repeat(400) + "}", { evidence: GOOD_EVIDENCE }).code, "format");
});

test("validateVerifiedFlag: 证据过短/占位词拒绝", () => {
	assert.equal(validateVerifiedFlag("CTF{x}", { evidence: "OK" }).code, "evidence");
	assert.equal(validateVerifiedFlag("CTF{x}", { evidence: "TODO" }).code, "placeholder-evidence");
	assert.equal(validateVerifiedFlag("CTF{x}", {}).code, "evidence");
});

test("validateVerifiedFlag: 自定义 patterns", () => {
	assert.equal(validateVerifiedFlag("flag-abc", { patterns: ["^flag-[a-z]+$"], evidence: GOOD_EVIDENCE }).ok, true);
	assert.equal(validateVerifiedFlag("CTF{x}", { patterns: ["^flag-[a-z]+$"], evidence: GOOD_EVIDENCE }).code, "format");
	// 空数组回落默认
	assert.equal(validateVerifiedFlag("CTF{x}", { patterns: [], evidence: GOOD_EVIDENCE }).ok, true);
});

test("compilePatterns: 坏正则被忽略", () => {
	const { compiled, invalid } = compilePatterns(["[", "^CTF\\{.*\\}$"]);
	assert.equal(invalid.length, 1);
	assert.equal(compiled.length, 1);
	assert.equal(compiled[0].test("CTF{x}"), true);
	assert.equal(compilePatterns(undefined).compiled.length, DEFAULT_FLAG_PATTERNS.length);
});