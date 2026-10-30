// 单入口：所有界面都在会话视图内做内部分页。
function sidOf(props) {
	return props && props.sessionId != null ? String(props.sessionId) : "";
}
function BoardViewPanel(props) {
	return h(Panel, { key: sidOf(props), variant: "view", sessionId: sidOf(props) });
}

function apply(ctx) {
	ctx.effect(function () { return installStyles(); }, "dsh-ctf-auto: styles");

	ctx.slots.inject("conversation.view", function () {
		return ctx.slots.register({
			name: "conversation.view",
			id: "ctf-auto",
			order: 50,
			label: function () { return "CTF 自动解题"; }
		}, BoardViewPanel);
	});
}

module.exports = { name: "dsh-ctf-auto-client", inject: ["slots"], apply: apply };
return module.exports; } });
