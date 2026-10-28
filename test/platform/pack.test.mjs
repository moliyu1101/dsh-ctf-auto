import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

test("pack: 拒绝绝对路径、穿越路径和规范化后的重名", () => {
	for (const name of ["/etc/passwd", "../outside", "a/../b", "C:/outside", "a\u0000b"]) {
		assert.throws(() => buildTarGz([{ name, data: "x" }]), /路径不安全/);
	}
	assert.throws(() => buildTarGz([{ name: "a/b", data: "x" }, { name: "a/./b", data: "y" }]), /路径重复/);
});

test("pack: 文件名含 slug 与时间", () => {
	const name = packFileName("baby-python", 1700000000000);
	assert.match(name, /^baby-python-wp-.*\.tar\.gz$/);
	assert.ok(name.includes("2023-11-14") || name.includes("1970"));
});

test("pack: PAX preserves distinct long names and UTF-8 names through real tar extraction", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-pax-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const entries = [
		{ name: "scripts/" + "a".repeat(105) + "1.py", data: "first" },
		{ name: "scripts/" + "a".repeat(105) + "2.py", data: "second" },
		{ name: "artifacts/" + "中文".repeat(25) + ".txt", data: "中文内容" }
	];
	const archive = path.join(dir, "fixture.tar.gz");
	fs.writeFileSync(archive, buildTarGz(entries));
	execFileSync("tar", ["-xzf", archive, "-C", dir]);
	for (const entry of entries) assert.equal(fs.readFileSync(path.join(dir, entry.name), "utf8"), entry.data);
});
