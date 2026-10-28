// The command catalog is shared by tool and Web adapters. It contains no host APIs.
export const CHALLENGE_COMMANDS = Object.freeze([
	{ name: "challenge.start", tool: null },
	{ name: "challenge.stop", tool: "ctf_solve_stop" },
	{ name: "challenge.retry", tool: "ctf_solve_retry" },
	{ name: "flag.record", tool: "ctf_flag_record", allowSubagent: true },
	{ name: "platform.submit", tool: "ctf_platform_submit" },
	{ name: "platform.env", tool: "ctf_platform_env", allowSubagent: true },
	{ name: "workbench.write", tool: "ctf_workbench_write", allowSubagent: true },
	{ name: "triage.run", tool: "ctf_triage", allowSubagent: true },
	{ name: "writeup.pack", tool: "ctf_writeup_pack" },
	{ name: "flag.review", tool: "ctf_review_flag" },
	{ name: "target.probe", tool: "ctf_target_probe", allowSubagent: true },
	{ name: "challenge.removeFlag", tool: null },
	{ name: "challenge.remove", tool: "ctf_challenge_remove" },
	{ name: "writeup.export", tool: "ctf_writeup_export" }
].map((command) => Object.freeze({ scope: "challenge", mutates: true, ...command })));

export function createChallengeApplication({ repository, authorize, handlers, lifecycle }) {
	const commands = new Map(CHALLENGE_COMMANDS.map((command) => [command.name, command]));
	const tools = new Map(CHALLENGE_COMMANDS.filter((command) => command.tool).map((command) => [command.tool, command.name]));
	for (const name of commands.keys()) if (typeof handlers[name] !== "function") throw new Error(`Missing challenge handler: ${name}`);
	return {
		has: (name) => commands.has(name),
		commandForTool: (name) => tools.get(name),
		async execute(name, input = {}, context = {}) {
			const command = commands.get(name);
			if (!command) return { ok: false, code: "COMMAND_NOT_FOUND", error: "未知题目操作" };
			if (!["tool", "panel", "system"].includes(context.channel)) return { ok: false, code: "COMMAND_CONTEXT_REQUIRED", error: "缺少可信调用上下文" };
			const access = await authorize(command, input, context);
			if (access?.ok !== true) return access || { ok: false, code: "COMMAND_DENIED", error: "操作未获授权" };
			const id = String(access.id || input.id || "").trim();
			const challenge = repository.get(id);
			if (!challenge) return { ok: false, code: "CHALLENGE_NOT_FOUND", error: "题目不存在：" + id };
			const result = await handlers[name]({ id, input: { ...input, id }, context, challenge });
			const current = repository.get(id);
			return result?.ok ? { ...result, id: result.id || id, ...(current ? { lifecycle: lifecycle(current) } : {}) } : result;
		}
	};
}
