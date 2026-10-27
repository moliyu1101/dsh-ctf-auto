import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply } from "../../lib/index.js";

function makeBoard(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-index-scope-"));
	const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-ws-a-"));
	const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-ws-b-"));
	const tools = new Map();
	const disposers = [];
	const ctx = {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		webServer: { register() { return () => {}; } },
		tools: { register(tool) { tools.set(tool.name, tool); } }
	};
	apply(ctx, { rootDir: root, solverPreset: "ctf-solver" });
	t.after(() => {
		for (const dispose of disposers.reverse()) {
			try { dispose(); } catch { /* ignore */ }
		}
	});
	return { root, wsA, wsB, tools };
}

function execFor(cwd, id, origin = "root") {
	return { agent: { id, session: { header: { cwd, origin } } } };
}

test("子代理只能读取和登记自身题目的工作区与 flag", async (t) => {
	const { wsA, wsB, tools } = makeBoard(t);
	const mainA = execFor(wsA, "main-a");
	const mainB = execFor(wsB, "main-b");
	const startedA = await tools.get("ctf_solve_start").execute({ title: "A", statement: "A" }, { agent: mainA.agent });
	const startedB = await tools.get("ctf_solve_start").execute({ title: "B", statement: "B" }, { agent: mainB.agent });
	fs.writeFileSync(path.join(startedA.dir, "notes.md"), "A secret");
	const childA = execFor(startedA.dir, "child-a", "subagent");

	const readOwn = await tools.get("ctf_workbench_read").execute({ id: startedA.id, path: "notes.md" }, { agent: childA.agent });
	assert.equal(readOwn.ok, true);
	assert.equal(readOwn.text, "A secret");

	const readOther = await tools.get("ctf_workbench_read").execute({ id: startedB.id, path: "notes.md" }, { agent: childA.agent });
	assert.equal(readOther.ok, false);
	assert.match(readOther.error, /只能访问当前题目/);

	const readOtherNotes = await tools.get("ctf_workbench_read").execute({ id: startedA.id, path: "notes.md" }, { agent: childA.agent });
	assert.equal(readOtherNotes.ok, true);

	const crossFlag = await tools.get("ctf_flag_record").execute({ id: startedB.id, flag: "CTF{cross}", evidence: "x", verified: true, method: "platform" }, { agent: childA.agent });
	assert.equal(crossFlag.ok, false);
	assert.match(crossFlag.error, /只能访问当前题目/);
});

test("模型自报 platform 不能绕过宿主验证，主会话工具也做能力分级", async (t) => {
	const { wsA, tools } = makeBoard(t);
	const mainA = execFor(wsA, "main-a");
	const started = await tools.get("ctf_solve_start").execute({ title: "A", statement: "A" }, { agent: mainA.agent });
	const childA = execFor(started.dir, "child-a", "subagent");

	const ownFlag = await tools.get("ctf_flag_record").execute({ id: started.id, flag: "CTF{fake}", evidence: "x", verified: true, method: "platform" }, { agent: childA.agent });
	assert.equal(ownFlag.ok, true);
	assert.equal(ownFlag.verified, false);
	assert.equal(ownFlag.downgraded, true);

	const denied = await tools.get("ctf_platform_import").execute({ all: true }, { agent: childA.agent });
	assert.equal(denied.ok, false);
	assert.match(denied.error, /主会话/);
});
