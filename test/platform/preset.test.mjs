import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildPresetDefinition, skillDirsOf } from "../../lib/preset.js";

test("preset: 外部技能源缺失时仍包含插件自带题型卡", () => {
	const dirs = skillDirsOf("");
	assert.equal(dirs.length, 1);
	assert.equal(path.basename(dirs[0]), "cards");
	const built = buildPresetDefinition({ skillSourceDir: "" });
	assert.ok(built.skillDirs.some((dir) => path.basename(dir) === "cards"));
});
