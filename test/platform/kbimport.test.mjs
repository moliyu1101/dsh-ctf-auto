import test from "node:test";
import assert from "node:assert/strict";
import { parseImportInput, normalizeImportPath, safeKnowledgeName, ALLOWED_EXT } from "../../lib/kbimport.js";
import { classifyFactKind, groupFactsByKind, FACT_KINDS } from "../../lib/blackboard.js";

test("kbimport: parseImportInput 支持数组/换行/逗号/注释/去重", () => {
	assert.deepEqual(parseImportInput(["a.md", " b.txt ", "a.md"]), ["a.md", "b.txt"]);
	assert.deepEqual(parseImportInput("a.md\n# comment\nb.txt;c.md"), ["a.md", "b.txt", "c.md"]);
	assert.deepEqual(parseImportInput(""), []);
	assert.deepEqual(parseImportInput(null), []);
});

test("kbimport: normalizeImportPath 解析相对路径与扩展名校验", () => {
	const ok = normalizeImportPath("docs/a.md", { cwd: "C:/work" });
	assert.equal(ok.ok, true);
	assert.equal(ok.name, "a.md");
	assert.equal(normalizeImportPath("C:/x/b.txt").ok, true);
	const bad = normalizeImportPath("a.exe");
	assert.equal(bad.ok, false);
	assert.match(bad.error, /不支持的类型/);
	assert.ok(ALLOWED_EXT.includes(".md"));
});

test("kbimport: safeKnowledgeName 去路径/控制字符 + 重名后缀", () => {
	assert.equal(safeKnowledgeName("C:/a/../b.md"), "b.md");
	assert.equal(safeKnowledgeName("a<b>c.md"), "a_b_c.md");
	assert.equal(safeKnowledgeName("note.md", ["note.md"]), "note-1.md");
	assert.equal(safeKnowledgeName("note.md", ["Note.md", "note-1.md"]), "note-2.md");
	assert.match(safeKnowledgeName(""), /^imported-.*\.md$/);
});

test("blackboard: classifyFactKind 标签优先 + 关键词兜底", () => {
	assert.equal(classifyFactKind("[结论] 解出 flag"), "结论");
	assert.equal(classifyFactKind("[待办] 试一下上传"), "计划");
	assert.equal(classifyFactKind("[复核] 复核通过"), "复核");
	assert.equal(classifyFactKind("服务返回 200，Server: openresty"), "发现");
	assert.equal(classifyFactKind("假设：flag 在混淆块里"), "假设");
	assert.equal(classifyFactKind("爆破 5000 次全部失败"), "卡点");
	assert.equal(classifyFactKind("随手记一句"), "记录");
	assert.equal(classifyFactKind(""), "记录");
	assert.deepEqual(FACT_KINDS.slice(0, 3), ["结论", "发现", "假设"]);
});

test("blackboard: groupFactsByKind 分层与补齐 kind", () => {
	const { rows, byKind } = groupFactsByKind([
		{ text: "[结论] solved" },
		{ text: "假设：SSTI", kind: "假设" },
		{ text: "[卡点] WAF 拦截" }
	]);
	assert.equal(rows.length, 3);
	assert.equal(byKind.get("结论").length, 1);
	assert.equal(byKind.get("假设").length, 1);
	assert.equal(byKind.get("卡点").length, 1);
	assert.deepEqual(groupFactsByKind(null).rows, []);
});