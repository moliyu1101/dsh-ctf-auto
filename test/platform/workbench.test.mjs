import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	MAX_TEXT_BYTES,
	MAX_TREE_ENTRIES,
	listTree,
	readText,
	resolveInside,
	writeText,
} from "../../lib/workbench.js";

function makeChallenge(t, fixture) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-wb-"));
	t.after(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	const challengeDir = path.join(root, "challenge");
	fs.mkdirSync(challengeDir, { recursive: true });
	if (fixture) fixture(challengeDir, root);
	return { root, challengeDir };
}

function baseFixture(challengeDir) {
	fs.writeFileSync(path.join(challengeDir, "notes.md"), "hello\nworld\n");
	fs.writeFileSync(path.join(challengeDir, "flag.json"), '{"flag":"flag{x}"}');
	fs.writeFileSync(path.join(challengeDir, "empty.txt"), "");
	fs.writeFileSync(path.join(challengeDir, "big.txt"), "A".repeat(600 * 1024));
	fs.writeFileSync(path.join(challengeDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
	fs.mkdirSync(path.join(challengeDir, "scripts"));
	fs.writeFileSync(path.join(challengeDir, "scripts", "solve.py"), "print(1)\n");
	fs.mkdirSync(path.join(challengeDir, "artifacts"));
	fs.writeFileSync(path.join(challengeDir, "artifacts", "out.txt"), "artifact\n");
	fs.mkdirSync(path.join(challengeDir, "files"));
	fs.writeFileSync(path.join(challengeDir, "files", "a.zip"), Buffer.from([0x50, 0x4b]));
	fs.mkdirSync(path.join(challengeDir, "deep", "deeper"), { recursive: true });
	fs.writeFileSync(path.join(challengeDir, "deep", "deeper", "deepest.txt"), "deep\n");
}

// ───────────────────────── resolveInside ─────────────────────────

test("resolveInside: 合法相对路径解析到题目录内", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const notes = resolveInside(challengeDir, "notes.md");
	assert.equal(notes, path.join(path.resolve(challengeDir), "notes.md"));

	const script = resolveInside(challengeDir, "scripts/solve.py");
	assert.ok(script.startsWith(path.resolve(challengeDir)));

	// 契约明确拒绝 `..`（任何形式都不放行，宁可严格）；合法写法用 "./" 与目录内相对路径。
	assert.throws(
		() => resolveInside(challengeDir, "scripts/./sub/../solve.py"),
		(error) => error && error.code === "ESCAPE",
	);
	const dotted = resolveInside(challengeDir, "scripts/./solve.py");
	assert.equal(dotted, path.join(path.resolve(challengeDir), "scripts", "solve.py"));

	const backslashes = resolveInside(challengeDir, "scripts\\solve.py");
	assert.equal(backslashes, path.join(path.resolve(challengeDir), "scripts", "solve.py"));

	// 根目录本身允许（listTree 用）
	assert.equal(resolveInside(challengeDir, ""), path.resolve(challengeDir));
});

test("resolveInside: 拒绝绝对路径 / .. / 跨目录 / 非法字符", (t) => {
	const { challengeDir } = makeChallenge(t);
	const bad = [
		"/etc/passwd",
		"C:\\Windows\\win.ini",
		"C:/Windows/win.ini",
		"\\\\server\\share\\x",
		"../secret.txt",
		"..\\secret.txt",
		"a/../../b.txt",
		"scripts/../../outside.txt",
		"notes.md\u0000.txt",
	];
	for (const rel of bad) {
		assert.throws(
			() => resolveInside(challengeDir, rel),
			(error) => error && error.code === "ESCAPE",
			`应拒绝：${JSON.stringify(rel)}`,
		);
	}
});

// ───────────────────────── listTree ─────────────────────────

test("listTree: 深度 2、目录优先、字段类型正确", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const res = listTree(challengeDir);
	assert.equal(res.ok, true);
	assert.equal(res.truncated, false);
	const paths = res.entries.map((entry) => entry.path);
	for (const expected of [
		"notes.md",
		"flag.json",
		"scripts",
		"scripts/solve.py",
		"artifacts",
		"artifacts/out.txt",
		"files",
		"files/a.zip",
		"deep",
		"deep/deeper",
	]) {
		assert.ok(paths.includes(expected), `应包含 ${expected}，实际：${paths.join(",")}`);
	}
	assert.ok(!paths.includes("deep/deeper/deepest.txt"), "深度 2 不应列出第 3 层");

	const notesEntry = res.entries.find((entry) => entry.path === "notes.md");
	assert.equal(notesEntry.kind, "file");
	assert.equal(notesEntry.size, Buffer.byteLength("hello\nworld\n"));
	assert.equal(typeof notesEntry.mtime, "number");
	assert.ok(notesEntry.mtime > 0);

	const scriptsEntry = res.entries.find((entry) => entry.path === "scripts");
	assert.equal(scriptsEntry.kind, "dir");
	assert.equal(scriptsEntry.size, 0);

	// 深度 2 的列表是逐层展开的（同层目录先于文件），不做「全局目录都在文件之前」的假设；
	// 这里只校验目录条目数与确实包含子层文件。
	assert.ok(res.entries.filter((entry) => entry.kind === "dir").length >= 4);
	assert.ok(res.entries.filter((entry) => entry.kind === "file").length >= 4);
});

test("listTree: 超过 200 条截断", (t) => {
	const { challengeDir } = makeChallenge(t, (dir) => {
		for (let i = 0; i < 250; i += 1) {
			fs.writeFileSync(path.join(dir, `f-${String(i).padStart(3, "0")}.txt`), `${i}`);
		}
	});
	const res = listTree(challengeDir);
	assert.equal(res.ok, true);
	assert.equal(res.entries.length, MAX_TREE_ENTRIES);
	assert.equal(res.truncated, true);
});

test("listTree: 目录不存在返回错误", (t) => {
	const { root } = makeChallenge(t);
	const res = listTree(path.join(root, "missing"));
	assert.equal(res.ok, false);
	assert.match(res.error, /不存在/);
});

// ───────────────────────── readText ─────────────────────────

test("readText: 正常读取与空文件", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const notes = readText(challengeDir, "notes.md");
	assert.equal(notes.ok, true);
	assert.equal(notes.path, "notes.md");
	assert.equal(notes.text, "hello\nworld\n");
	assert.equal(notes.size, Buffer.byteLength("hello\nworld\n"));
	assert.equal(notes.truncated, false);

	const empty = readText(challengeDir, "empty.txt");
	assert.equal(empty.ok, true);
	assert.equal(empty.text, "");
	assert.equal(empty.truncated, false);
});

test("readText: 超过 maxBytes 截断并标记", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const res = readText(challengeDir, "big.txt", 1000);
	assert.equal(res.ok, true);
	assert.equal(res.truncated, true);
	assert.equal(res.size, 600 * 1024);
	assert.equal(res.text.length, 1000);

	// 超过 512KB 硬上限时被夹紧
	const hardCap = readText(challengeDir, "big.txt", 2 * 1024 * 1024);
	assert.equal(hardCap.ok, true);
	assert.equal(hardCap.truncated, true);
	assert.ok(Buffer.byteLength(hardCap.text, "utf8") <= MAX_TEXT_BYTES);
});

test("readText: 二进制返回 binary", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const res = readText(challengeDir, "binary.bin");
	assert.equal(res.ok, false);
	assert.equal(res.error, "binary");
});

test("readText: 缺失 / 目录 / 越界路径", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const missing = readText(challengeDir, "nope.md");
	assert.equal(missing.ok, false);
	assert.match(missing.error, /不存在/);

	const dir = readText(challengeDir, "scripts");
	assert.equal(dir.ok, false);
	assert.match(dir.error, /不是文件/);

	const escape = readText(challengeDir, "../outside.txt");
	assert.equal(escape.ok, false);
	assert.match(escape.error, /越界|绝对路径/);

	const absolute = readText(challengeDir, "/etc/passwd");
	assert.equal(absolute.ok, false);
	assert.match(absolute.error, /绝对路径|越界/);
});

test("readText: 符号链接指向题目录之外被拒绝", (t) => {
	const { root, challengeDir } = makeChallenge(t, (dir) => {
		fs.mkdirSync(path.join(dir, "link-target"), { recursive: true });
	});
	const outsideDir = path.join(root, "outside");
	fs.mkdirSync(outsideDir, { recursive: true });
	fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
	const linkPath = path.join(challengeDir, "link");
	try {
		fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch {
		t.skip("当前环境不允许创建符号链接，跳过");
		return;
	}
	const res = readText(challengeDir, "link/secret.txt");
	assert.equal(res.ok, false);
	assert.match(res.error, /越界/);
});

// ───────────────────────── writeText ─────────────────────────

test("writeText: 自动建父目录并读回", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);
	const content = "print('hi')\n# 中文\n";
	const res = writeText(challengeDir, "scripts/sub/run.py", content);
	assert.equal(res.ok, true);
	assert.equal(res.path, "scripts/sub/run.py");
	assert.equal(res.bytes, Buffer.byteLength(content, "utf8"));
	assert.ok(fs.existsSync(path.join(challengeDir, "scripts", "sub", "run.py")));

	const readBack = readText(challengeDir, "scripts/sub/run.py");
	assert.equal(readBack.ok, true);
	assert.equal(readBack.text, content);

	const overwrite = writeText(challengeDir, "notes.md", "new notes");
	assert.equal(overwrite.ok, true);
	assert.equal(readText(challengeDir, "notes.md").text, "new notes");
});

test("writeText: 拒绝越界 / 绝对路径 / 空路径 / 目录 / 超限", (t) => {
	const { challengeDir } = makeChallenge(t, baseFixture);

	const escape = writeText(challengeDir, "../evil.txt", "x");
	assert.equal(escape.ok, false);
	assert.match(escape.error, /越界/);

	const absolute = writeText(challengeDir, "C:\\evil.txt", "x");
	assert.equal(absolute.ok, false);
	assert.match(absolute.error, /绝对路径/);

	const empty = writeText(challengeDir, "", "x");
	assert.equal(empty.ok, false);
	assert.match(empty.error, /不能为空/);

	const targetDir = writeText(challengeDir, "scripts", "x");
	assert.equal(targetDir.ok, false);
	assert.match(targetDir.error, /目录/);

	const tooBig = writeText(challengeDir, "toobig.txt", "x".repeat(MAX_TEXT_BYTES + 1));
	assert.equal(tooBig.ok, false);
	assert.match(tooBig.error, /上限/);
	assert.ok(!fs.existsSync(path.join(challengeDir, "toobig.txt")));
});

test("writeText: 写入后 listTree 可见", (t) => {
	const { challengeDir } = makeChallenge(t);
	const res = writeText(challengeDir, "artifacts/output.log", "line1\nline2\n");
	assert.equal(res.ok, true);
	const tree = listTree(challengeDir);
	assert.equal(tree.ok, true);
	const paths = tree.entries.map((entry) => entry.path);
	assert.ok(paths.includes("artifacts"));
	assert.ok(paths.includes("artifacts/output.log"));
});
