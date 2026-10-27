import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("包清单包含运行时资源和测试入口", () => {
	for (const entry of ["cards/", "roles/", "scripts/", "test/", "LICENSE"]) {
		assert.ok(pkg.files.includes(entry), `package files 缺少 ${entry}`);
	}
	assert.equal(pkg.scripts?.test, "node scripts/run-tests.mjs");
	assert.ok(fs.existsSync(path.join(root, "LICENSE")));
	assert.ok(fs.existsSync(path.join(root, "scripts", "run-tests.mjs")));
});
