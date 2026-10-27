import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { apply } from "../../lib/index.js";

test("Web 面板写操作拒绝跨工作区题目", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-panel-scope-"));
	const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-panel-a-"));
	const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-panel-b-"));
	const agentA = { id: "main-a", session: { header: { cwd: wsA, origin: "root" } } };
	const agentB = { id: "main-b", session: { header: { cwd: wsB, origin: "root" } } };
	const tools = new Map();
	const disposers = [];
	let handler = null;
	const ctx = {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		webServer: { register(row) { handler = row.handler; return () => {}; } },
		tools: { register(tool) { tools.set(tool.name, tool); } },
		get(name) {
			if (name !== "agents") return undefined;
			return {
				roots: () => [agentA, agentB],
				get: (id) => (id === agentA.id ? agentA : id === agentB.id ? agentB : undefined)
			};
		}
	};
	apply(ctx, { rootDir: root, solverPreset: "ctf-solver" });
	const started = await tools.get("ctf_solve_start").execute({ title: "A", statement: "A" }, { agent: agentA });
	const server = http.createServer((req, res) => handler(req, res));
	await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (err) => err ? reject(err) : resolve()));
	t.after(() => {
		server.close();
		for (const dispose of disposers.reverse()) {
			try { dispose(); } catch { /* ignore */ }
		}
	});
	const address = server.address();
	const base = `http://127.0.0.1:${address.port}/dsh-ctf-auto`;
	const csrf = await (await fetch(`${base}/csrf`)).json();
	const response = await fetch(`${base}/challenge.start`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-dsh-csrf": csrf.token },
		body: JSON.stringify({ id: started.id, sessionId: agentB.id })
	});
	const body = await response.json();
	assert.equal(response.status, 200);
	assert.equal(body.ok, false);
	assert.match(body.error, /不属于当前工作区|只允许只读/);
});
