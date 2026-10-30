import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply } from "../../lib/index.js";

export async function host(t, config = {}, services = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-pipeline-regression-"));
	const agents = ["a", "b"].map((id) => {
		const cwd = path.join(root, id);
		fs.mkdirSync(cwd);
		return { id, session: { header: { cwd, origin: "root" } } };
	});
	let handler, watchdog;
	const tools = new Map(), disposers = [], requests = [];
	const nativeFetch = globalThis.fetch;
	let remote = () => new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
	globalThis.fetch = async (url, init) => {
		if (String(url).startsWith("http://127.0.0.1:")) return nativeFetch(url, init);
		requests.push({ url: String(url), init });
		return remote(String(url), init);
	};
	apply({
		effect(fn, label) {
			let dispose;
			if (label === "dsh-ctf-auto: watchdog") {
				const interval = globalThis.setInterval;
				globalThis.setInterval = (callback) => { watchdog = callback; return { unref() {} }; };
				try { dispose = fn(); } finally { globalThis.setInterval = interval; }
			} else dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		tools: { register(tool) { tools.set(tool.name, tool); } },
		webServer: { register(row) { handler = row.handler; return () => {}; } },
		get(name) { if (services[name]) return services[name]; if (name === "agents") return { roots: () => agents, get: (id) => agents.find((a) => a.id === id) }; }
	}, { rootDir: path.join(root, "state"), ...config });
	const server = http.createServer((req, res) => handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const dispose = () => { for (const fn of disposers.splice(0).reverse()) fn(); };
	t.after(async () => {
		dispose();
		globalThis.fetch = nativeFetch;
		await new Promise((resolve) => server.close(resolve));
		fs.rmSync(root, { recursive: true, force: true });
	});
	const base = `http://127.0.0.1:${server.address().port}/dsh-ctf-auto`;
	const { token } = await (await nativeFetch(`${base}/csrf`)).json();
	const post = async (endpoint, body = {}) => (await nativeFetch(`${base}/${endpoint}`, {
		method: "POST", headers: { "content-type": "application/json", "x-dsh-csrf": token }, body: JSON.stringify({ sessionId: "a", ...body })
	})).json();
	return { post, rawPost: (endpoint, body = {}) => nativeFetch(`${base}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "x-dsh-csrf": token }, body: JSON.stringify({ sessionId: "a", ...body }) }), tools, requests, agents, root, dispose, tick() { watchdog(); }, setRemote(fn) { remote = fn; } };
}

