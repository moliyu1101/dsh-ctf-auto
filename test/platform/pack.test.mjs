import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildTarGz, packFileName } from "../../lib/pack.js";

function gunzip(buf) {
	return zlib.gunzipSync(buf);
}

test("pack: tar.gz 可解压且包含文件名", () => {
	const buf = buildTarGz([
		{ name: "writeup.md", data: "# Writeup\n", mtime: 1700000000000 },
		{ name: "scripts/solve.py", data: "print('ok')\n", mtime: 1700000000000 },
		{ name: "artifacts/out.txt", data: "output", mtime: 1700000000000 }
	]);
	assert.ok(Buffer.isBuffer(buf));
	const tar = gunzip(buf);
	const text = tar.toString("latin1");
	assert.ok(text.includes("writeup.md"));
	assert.ok(text.includes("scripts/solve.py"));
	assert.ok(text.includes("artifacts/out.txt"));
	assert.ok(text.includes("ustar"));
	// 内容确实被打进去
	assert.ok(tar.includes(Buffer.from("# Writeup\n")));
	// 末尾至少两个零块
	assert.equal(tar.slice(-1024).equals(Buffer.alloc(1024, 0)), true);
});

test("pack: 空输入产出合法空 tar.gz", () => {
	const tar = gunzip(buildTarGz([]));
	assert.equal(tar.length, 1024);
	assert.equal(tar.equals(Buffer.alloc(1024, 0)), true);
});

test("pack: 文件名规范化（去掉绝对路径与 ..）", () => {
	const tar = gunzip(buildTarGz([{ name: "/etc/../passwd", data: "x" }]));
	const text = tar.toString("latin1");
	assert.ok(!text.includes("/etc/../passwd"));
	assert.ok(text.includes("etc/passwd") || text.includes("passwd"));
});

test("pack: 文件名含 slug 与时间", () => {
	const name = packFileName("baby-python", 1700000000000);
	assert.match(name, /^baby-python-wp-.*\.tar\.gz$/);
	assert.ok(name.includes("2023-11-14") || name.includes("1970"));
});