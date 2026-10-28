import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { host } from "../helpers/host.mjs";

test("reports and writeups round-trip in a custom directory and preserve workspace ownership", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-reports-custom-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = await host(t, { reportDir: dir });
	const ch = await h.post("challenge.add", { title: "Report fixture", statement: "fixture" });
	await h.post("flag.record", { id: ch.id, flag: "CTF{x}", verified: true, evidence: "checker output CTF{x}" });
	for (const technical of [false, true]) {
		const exported = await h.post("report.export", { technical });
		assert.equal(exported.ok, true);
		const name = path.basename(exported.path);
		assert.equal(path.dirname(exported.path), dir);
		assert.ok((await h.post("report.list")).reports.some((r) => r.name === name));
		assert.equal((await h.post("report.read", { name })).ok, true);
		assert.equal((await h.post("report.read", { name, sessionId: "b" })).ok, false);
		assert.ok(!(await h.post("report.list", { sessionId: "b" })).reports.some((r) => r.name === name));
	}
	const wp = await h.post("writeup.export", { id: ch.id });
	assert.equal(wp.ok, true);
	const name = path.basename(wp.path);
	assert.equal((await h.post("writeup.read", { name })).ok, true);
	assert.equal((await h.post("writeup.read", { name, sessionId: "b" })).ok, false);
	assert.equal((await h.post("writeup.read", { name: name.replace(".md", "-other.md") })).ok, false);
});

test("writeup packaging does not follow a symlink used as a top-level attachments directory", async (t) => {
	const h = await host(t);
	const added = await h.post("challenge.add", { title: "Symlink archive", statement: "fixture" });
	const ch = (await h.post("challenge.get", { id: added.id })).challenge;
	const outside = path.join(h.root, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "private.txt"), "must not be archived");
	fs.rmSync(path.join(ch.dir, "files"), { recursive: true, force: true });
	fs.symlinkSync(outside, path.join(ch.dir, "files"), "dir");
	const packed = await h.post("writeup.pack", { id: added.id });
	assert.equal(packed.ok, true);
	const { execFileSync } = await import("node:child_process");
	const names = execFileSync("tar", ["-tzf", packed.path], { encoding: "utf8" });
	assert.ok(!names.includes("private.txt"));
});
