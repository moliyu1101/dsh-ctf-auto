import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply } from "../../lib/index.js";

test("generic 平台保留字符串 ID、元数据和导入工作区", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-platform-import-"));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-platform-ws-"));
	const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-platform-ws-other-"));
	fs.writeFileSync(path.join(root, "platform.json"), JSON.stringify({
		kind: "generic",
		baseUrl: "https://platform.test",
		apiToken: "token",
		profile: null
	}));
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
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const value = String(url);
		if (value.endsWith("/api/challenges")) {
			return new Response(JSON.stringify({ data: [{ id: "uuid-123", name: "UUID challenge", category: "web" }] }), { status: 200 });
		}
		if (value.endsWith("/api/challenges/uuid-123")) {
			return new Response(JSON.stringify({ data: { id: "uuid-123", name: "UUID challenge", category: "web", description: "body" } }), { status: 200 });
		}
		return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
	};
	try {
		apply(ctx, { rootDir: root, solverPreset: "ctf-solver" });
		const main = { id: "main", session: { header: { cwd: workspace, origin: "root" } } };
		const result = await tools.get("ctf_platform_import").execute({ ids: ["uuid-123"], start: false }, { agent: main });
		assert.equal(result.ok, true);
		assert.equal(result.created.length, 1);
		assert.equal(result.created[0].platformId, "uuid-123");
		assert.equal(result.created[0].status, "stopped");
		const detail = await tools.get("ctf_solve_status").execute({ id: result.created[0].localId }, { agent: main });
		assert.equal(detail.ok, true);
		assert.equal(detail.data.challenge.platform.kind, "generic");
		assert.equal(detail.data.challenge.platform.challengeId, "uuid-123");
		assert.equal(detail.data.challenge.workspace, workspace);
		const otherMain = { id: "main-other", session: { header: { cwd: otherWorkspace, origin: "root" } } };
		const crossRead = await tools.get("ctf_workbench_read").execute({ id: result.created[0].localId, path: "notes.md" }, { agent: otherMain });
		assert.equal(crossRead.ok, false);
		assert.match(crossRead.error, /不属于当前工作区/);
	} finally {
		globalThis.fetch = originalFetch;
		for (const dispose of disposers.reverse()) {
			try { dispose(); } catch { /* ignore */ }
		}
	}
});
