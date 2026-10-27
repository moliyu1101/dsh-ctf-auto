import test from "node:test";
import assert from "node:assert/strict";
import { toWslPath, shellQuote, buildWslArgs, runWslCommand, listDistros } from "../../lib/wslrun.js";

test("wsl: Windows 路径换算", () => {
	assert.equal(toWslPath("C:\\Users\\a\\b"), "/mnt/c/Users/a/b");
	assert.equal(toWslPath("D:/work/x"), "/mnt/d/work/x");
	assert.equal(toWslPath("/mnt/c/already"), "/mnt/c/already");
	assert.equal(toWslPath("C:"), "/mnt/c");
	assert.equal(toWslPath(""), "");
});

test("wsl: shellQuote 处理单引号", () => {
	assert.equal(shellQuote("a b"), "'a b'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("wsl: 参数拼装带 cwd 与 distro", () => {
	const args = buildWslArgs({ distro: "kali", command: "ls -la", cwd: "C:\\work\\chal" });
	assert.deepEqual(args.slice(0, 4), ["-d", "kali", "--", "bash"]);
	assert.equal(args[4], "-lc");
	assert.match(args[5], /^cd '\/mnt\/c\/work\/chal' && ls -la$/);
	const noCwd = buildWslArgs({ command: "id" });
	assert.equal(noCwd[1], "Ubuntu");
	assert.equal(noCwd[5], "id");
});

test("wsl: runWslCommand 成功/失败/超时码/空命令（注入 execImpl）", async () => {
	const ok = await runWslCommand({
		command: "echo hi",
		execImpl: (_bin, _args, _opts, cb) => cb(null, "hi\n", "")
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.exitCode, 0);
	assert.equal(ok.stdout.trim(), "hi");
	assert.ok(ok.durationMs >= 0);
	assert.equal(ok.args[0], "-d");

	const fail = await runWslCommand({
		command: "false",
		execImpl: (_bin, _args, _opts, cb) => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "boom")
	});
	assert.equal(fail.ok, false);
	assert.equal(fail.exitCode, 1);
	assert.match(fail.stderr, /boom/);

	const killed = await runWslCommand({
		command: "sleep 999",
		execImpl: (_bin, _args, _opts, cb) => cb(Object.assign(new Error("killed"), { killed: true }), "", "")
	});
	assert.equal(killed.exitCode, 124);

	const empty = await runWslCommand({ command: "  " });
	assert.equal(empty.ok, false);
	assert.match(empty.stderr, /命令为空/);
});

test("wsl: 输出截断", async () => {
	const big = "x".repeat(5000);
	const result = await runWslCommand({
		command: "cat big",
		maxOutput: 1000,
		execImpl: (_bin, _args, _opts, cb) => cb(null, big, "")
	});
	assert.equal(result.truncated, true);
	assert.equal(result.stdout.length, 1000);
});

test("wsl: listDistros 解析 UTF-16 输出与失败回退", async () => {
	const utf16 = Buffer.from("\uFEFFUbuntu\r\nkali-linux\r\n", "utf16le");
	const distros = await listDistros({ execImpl: (_bin, _args, _opts, cb) => cb(null, utf16) });
	assert.ok(distros.includes("Ubuntu"), JSON.stringify(distros));
	assert.ok(distros.some((name) => name.startsWith("kali")), JSON.stringify(distros));
	const none = await listDistros({ execImpl: (_bin, _args, _opts, cb) => cb(new Error("no wsl")) });
	assert.deepEqual(none, []);
});