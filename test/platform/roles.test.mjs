import test from "node:test";
import assert from "node:assert/strict";
import { loadRoleText, rolePath, ROLE_NAMES } from "../../lib/roles.js";

test("roles: 三张角色卡可加载且内容可辨识", () => {
	assert.deepEqual(ROLE_NAMES.sort(), ["recon", "resident", "reviewer", "solver"]);
	const solver = loadRoleText("solver");
	const reviewer = loadRoleText("reviewer");
	const recon = loadRoleText("recon");
	assert.match(solver, /解题手/);
	assert.match(loadRoleText("resident"), /判定/);
	assert.match(reviewer, /REVIEW: VERIFIED/);
	assert.match(reviewer, /REVIEW: REJECTED/);
	assert.match(recon, /只做\*\*信息搜集与分诊\*\*|信息搜集/);
	for (const name of ROLE_NAMES) {
		assert.ok(rolePath(name).endsWith(".md"), name);
		assert.ok(loadRoleText(name).length > 80, name + " 太短");
	}
});

test("roles: 未知角色返回空、重复读取命中缓存", () => {
	assert.equal(loadRoleText("nope"), "");
	assert.equal(rolePath("nope"), "");
	const a = loadRoleText("solver");
	const b = loadRoleText("solver");
	assert.equal(a, b);
});