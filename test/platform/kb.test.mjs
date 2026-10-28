import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildKnowledgeIndex, searchKnowledge, tokenize, rankKnowledge, buildKnowledgePromptSection } from "../../lib/kb.js";

function fixtures() {
	return buildKnowledgeIndex({
		writeups: [
			{
				name: "baby-python-writeup.md",
				path: "/w/baby-python-writeup.md",
				text: "# Baby Python\n\nzip 符号链接导致任意文件读取，用 unzip 保留 symlink + cat 跟随。flag: CTF2{x}",
				mtime: Date.now() - 3600_000
			},
			{
				name: "rot13-writeup.md",
				path: "/w/rot13-writeup.md",
				text: "# ROT13\n\n经典 ROT13 解码。",
				mtime: Date.now() - 86400000 * 3
			}
		],
		notes: [
			{
				challengeId: "c-1",
				title: "Fish Joy",
				category: "web",
				workspace: "C:/ws",
				path: "/ws/.ctf-auto/fish/notes.md",
				text: "## 侦察\n- 混淆块 decodeURIComponent + RC4\n- player.js 里有 base64 数组",
				mtime: Date.now() - 1000
			}
		]
	});
}

test("kb: 建索引包含 writeup 与笔记，字段齐全", () => {
	const entries = fixtures();
	assert.equal(entries.length, 3);
	const writeup = entries.find((e) => e.source === "writeup");
	assert.ok(writeup.title.includes("baby-python"));
	assert.ok(writeup.path.endsWith(".md"));
	const notes = entries.find((e) => e.source === "notes");
	assert.equal(notes.category, "web");
	assert.equal(notes.workspace, "C:/ws");
});

test("kb: 检索命中与排序（标题/分类加权）", () => {
	const entries = fixtures();
	const zip = searchKnowledge(entries, "zip symlink");
	assert.equal(zip.length, 1);
	assert.ok(zip[0].snippet.includes("symlink"));
	const rot = searchKnowledge(entries, "rot13");
	assert.equal(rot[0].title.includes("rot13"), true);
	const rc4 = searchKnowledge(entries, "rc4");
	assert.equal(rc4.length, 1);
	assert.equal(rc4[0].source, "notes");
	// AND 语义
	assert.deepEqual(searchKnowledge(entries, "zip nonexistent"), []);
});

test("kb: 空查询/限额/无命中", () => {
	const entries = fixtures();
	assert.deepEqual(searchKnowledge(entries, ""), []);
	assert.deepEqual(searchKnowledge(entries, "   "), []);
	assert.equal(searchKnowledge(entries, "的", { limit: 1 }).length <= 1, true);
});

test("kb: tokenize 小写与切分", () => {
	assert.deepEqual(tokenize("ZIP  Symlink  flag"), ["zip", "symlink", "flag"]);
});

test("kb: 空输入不抛错", () => {
	assert.deepEqual(buildKnowledgeIndex(), []);
	assert.deepEqual(searchKnowledge(null, "x"), []);
});
test("kb: rankKnowledge 相似题打分与排序", () => {
	const entries = fixtures();
	const ranked = rankKnowledge(entries, { title: "Baby Python zip symlink", statement: "flask upload zip 任意文件读取", category: "web" }, { limit: 2 });
	assert.ok(ranked.length >= 1);
	assert.ok(ranked[0].score > 0);
	assert.equal(ranked[0].source, "writeup");
	const unrelated = rankKnowledge(entries, { title: "RSA 签到", statement: "n e c 求明文", category: "crypto" }, { limit: 2 });
	assert.equal(unrelated.length, 0);
});
test("kb: buildKnowledgePromptSection 生成片段", () => {
	const section = buildKnowledgePromptSection([{ title: "baby-python", source: "writeup", sourceLabel: "Writeup", score: 0.62, text: "zip symlink 任意文件读取", path: "/w/a.md" }]);
	assert.match(section, /相关知识库片段/);
	assert.match(section, /Writeup/);
	assert.match(section, /0\.62/);
	assert.match(section, /结论必须自己在本题复现/);
	assert.equal(buildKnowledgePromptSection([]), "");
});

test("kb: Chinese paraphrases share technique terms without matching unrelated documents", () => {
	const entries = buildKnowledgeIndex({ imported: [
		{ name: "zip.md", text: "解压附件时保留符号链接，实现任意文件读取。" },
		{ name: "rsa.md", text: "使用模逆运算恢复RSA私钥，完成密文解密。" }
	] });
	const results = rankKnowledge(entries, { statement: "这个压缩包可否通过符号链接读取文件？" });
	assert.equal(results[0].id, "imported:zip.md");
	assert.ok(!results.some((entry) => entry.id === "imported:rsa.md"));
	assert.ok(tokenize("附件符号链接").includes("符号"));
});

test("kb: metadata-only search works and matching passages are injected instead of introductions", () => {
	const metadata = [{ id: "meta", title: "SQL injection", category: "web", tags: ["sqli"], text: "unrelated body", mtime: 0 }];
	assert.equal(searchKnowledge(metadata, "sqli").length, 1);
	const entries = [{ id: "long", title: "Long document", text: "Introduction filler. ".repeat(120) + "关键技法：使用共模攻击恢复RSA明文。" }];
	const ranked = rankKnowledge(entries, { title: "RSA", statement: "尝试共模攻击" });
	assert.equal(ranked.length, 1);
	assert.match(ranked[0].snippet, /共模攻击/);
	assert.match(buildKnowledgePromptSection(ranked), /共模攻击/);
	assert.equal(rankKnowledge([{ ...metadata[0], category: "web" }], { title: "totallydifferent", category: "web" }).length, 0);
});

test("kb: configured recall counts above three are retained in the prompt", () => {
	const section = buildKnowledgePromptSection(Array.from({ length: 5 }, (_, n) => ({ title: `entry-${n}`, text: "fixture", score: 0.5 })));
	assert.match(section, /entry-4/);
});

test("kb: cached passage tokens refresh when the source text changes", () => {
	const entry = { title: "fixture", text: "RSA 共模攻击解密" };
	assert.equal(rankKnowledge([entry], { title: "共模攻击" }).length, 1);
	entry.text = "PNG 图片隐写提取像素";
	assert.equal(rankKnowledge([entry], { title: "共模攻击" }).length, 0);
	assert.equal(rankKnowledge([entry], { title: "图片隐写" }).length, 1);
});
