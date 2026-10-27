import test from "node:test";
import assert from "node:assert/strict";
import {
	defaultMcpUrl,
	normalizeOrigin,
	parseRpcBody,
	unwrapToolResult,
	createDasctfMcpClient,
	createDasctfMcpPlatform
} from "../../lib/mcp-dasctf.js";

const ORIGIN = "https://ctf2.example.com";

function jsonResponse(payload, status = 200, headers = {}) {
	return { status, headers: { get: (name) => headers[String(name).toLowerCase()] || null }, text: async () => JSON.stringify(payload) };
}

function makeMcpFetch(routes = {}) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const body = JSON.parse(init.body || "{}");
		calls.push({ url, body, headers: init.headers || {} });
		if (body.method === "initialize") {
			return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, instructions: "rules" } }, 200, { "mcp-session-id": "sess-1" });
		}
		if (body.method === "notifications/initialized") return jsonResponse({}, 202);
		if (body.method === "tools/list") {
			return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ctf2_agent_whoami" }, { name: "ctf2_submit_flag" }] } });
		}
		if (body.method === "tools/call") {
			const handler = routes[body.params.name];
			const payload = handler ? handler(body.params.arguments) : { isError: true, content: [{ type: "text", text: "unknown tool" }] };
			return jsonResponse({ jsonrpc: "2.0", id: body.id, result: payload });
		}
		return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: "METHOD_NOT_FOUND", message: "no method" } });
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

test("mcp-dasctf: 默认 URL / 解包 / SSE 解析", () => {
	assert.equal(normalizeOrigin(""), "https://ctf2.dasctf.com");
	assert.equal(defaultMcpUrl("https://x.com/"), "https://x.com/api/ai/v1/mcp");
	assert.deepEqual(unwrapToolResult({ content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] }), { ok: true, data: { a: 1 }, text: '{"a":1}' });
	assert.equal(unwrapToolResult({ isError: true, content: [{ type: "text", text: "boom" }] }).ok, false);
	const sse = parseRpcBody("text/event-stream", 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
	assert.equal(sse.result.ok, true);
	assert.equal(parseRpcBody("application/json", '{"a":1}').a, 1);
});

test("mcp-dasctf: me() 走 whoami 并归一化", async () => {
	const fetchImpl = makeMcpFetch({
		ctf2_agent_whoami: () => ({ content: [{ type: "text", text: JSON.stringify({ agent: { id: "a1", name: "知枭" }, quotas: { max_environments: 1 }, competition_enabled: true }) }] })
	});
	const platform = createDasctfMcpPlatform({ origin: ORIGIN, token: "tok", fetchImpl });
	const me = await platform.me();
	assert.equal(me.ok, true);
	assert.equal(me.data.name, "知枭");
	assert.equal(me.data.quotas.max_environments, 1);
	assert.equal(fetchImpl.calls.filter((call) => call.body.method === "initialize").length, 1);
	assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer tok");
	assert.equal(fetchImpl.calls.find((call) => call.body.method === "tools/call").headers["Mcp-Session-Id"], "sess-1");
});

test("mcp-dasctf: listChallenges 归一化 + getChallenge 解析附件 URL", async () => {
	const fetchImpl = makeMcpFetch({
		ctf2_agent_next_challenges: () => ({ content: [{ type: "text", text: JSON.stringify({ items: [{ id: "c1", name: "WarmUp", category: "WEB", points: 1, practice_ground_id: "g1", has_attachments: true, source: { type: "practice", practice_ground_id: "g1" } }] }) }] }),
		ctf2_get_practice_challenge: () => ({ content: [{ type: "text", text: JSON.stringify({ challenge: { id: "c1", name: "WarmUp", description: "点击启动靶机", files: [{ id: "f1", name: "a.zip", size: 10 }], requires_running_target_for_submit: true } }) }] }),
		ctf2_get_attachment_url: () => ({ content: [{ type: "text", text: JSON.stringify({ url: "https://cdn.example.com/a.zip?sig=1" }) }] })
	});
	const platform = createDasctfMcpPlatform({ origin: ORIGIN, token: "tok", fetchImpl });
	const list = await platform.listChallenges();
	assert.equal(list.ok, true);
	assert.equal(list.data.length, 1);
	assert.equal(list.data[0].groundId, "g1");
	const detail = await platform.getChallenge("c1", list.data[0]);
	assert.equal(detail.ok, true);
	assert.equal(detail.data.description, "点击启动靶机");
	assert.equal(detail.data.files[0].url, "https://cdn.example.com/a.zip?sig=1");
	assert.equal(detail.data.requiresTarget, true);
});

test("mcp-dasctf: submit 映射 correct/incorrect，并带 confirmation", async () => {
	let captured = null;
	const fetchImpl = makeMcpFetch({
		ctf2_submit_flag: (args) => { captured = args; return { content: [{ type: "text", text: JSON.stringify({ correct: true, message: "OK" }) }] }; }
	});
	const platform = createDasctfMcpPlatform({ origin: ORIGIN, token: "tok", fetchImpl });
	const res = await platform.submit("c1", "CTF{x}", { type: "practice", practiceGroundId: "g1" });
	assert.equal(res.ok, true);
	assert.equal(res.status, "correct");
	assert.equal(captured.confirmation, true);
	assert.equal(captured.practice_ground_id, "g1");
	assert.equal(captured.flag, "CTF{x}");
});

test("mcp-dasctf: 环境 start/status/delete 调用对应工具", async () => {
	const seen = [];
	const fetchImpl = makeMcpFetch({
		ctf2_start_challenge_environment: () => { seen.push("start"); return { content: [{ type: "text", text: JSON.stringify({ environment: { status: "starting", environment_id: "e1" } }) }] }; },
		ctf2_get_environment: () => { seen.push("get"); return { content: [{ type: "text", text: JSON.stringify({ environment: { status: "running", access_ready: true } }) }] }; },
		ctf2_user_delete_practice_id_challenges_challengeid_environment: () => { seen.push("delete"); return { content: [{ type: "text", text: JSON.stringify({ environment: { status: "deleting", removed: true } }) }] }; }
	});
	const platform = createDasctfMcpPlatform({ origin: ORIGIN, token: "tok", fetchImpl });
	const start = await platform.environment("start", { id: "c1", meta: { type: "practice", practiceGroundId: "g1" } });
	assert.equal(start.environment.status, "starting");
	const status = await platform.environment("status", { id: "c1", meta: { type: "practice", practiceGroundId: "g1" } });
	assert.equal(status.environment.access_ready, true);
	const del = await platform.environment("delete", { id: "c1", meta: { type: "practice", practiceGroundId: "g1" } });
	assert.equal(del.environment.removed, true);
	assert.deepEqual(seen, ["start", "get", "delete"]);
});

test("mcp-dasctf: 无 token / 工具错误 返回可读错误", async () => {
	const noToken = createDasctfMcpPlatform({ origin: ORIGIN, token: "", fetchImpl: makeMcpFetch({}) });
	const res = await noToken.me();
	assert.equal(res.ok, false);
	assert.match(res.error, /CTF2_AGENT_TOKEN/);
	const fetchImpl = makeMcpFetch({ ctf2_agent_whoami: () => ({ isError: true, content: [{ type: "text", text: "AGENT_FORBIDDEN" }] }) });
	const platform = createDasctfMcpPlatform({ origin: ORIGIN, token: "tok", fetchImpl });
	const err = await platform.me();
	assert.equal(err.ok, false);
	assert.match(err.error, /AGENT_FORBIDDEN/);
});