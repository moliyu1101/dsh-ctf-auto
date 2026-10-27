// dsh-ctf-auto / lib/blackboard.js —— 记忆层：黑板事实分层（纯函数）。
//
// 目标：把 notes/事实流按「结论 / 发现 / 假设 / 卡点 / 计划 / 复核 / 记录」分层，
// 供记忆页筛选与跨目录续接。只做文本启发式分类，不改写原文。

export const FACT_KINDS = ["结论", "发现", "假设", "卡点", "计划", "复核", "记录"];

const BRACKET_KINDS = ["结论", "发现", "假设", "卡点", "计划", "待办", "复核", "记录"];

const KEYWORD_RULES = [
	{ kind: "复核", test: /^\[复核\]|复核.*(通过|未通过|REJECTED|VERIFIED)/i },
	{ kind: "结论", test: /\[结论\]|^结论[:：]|解出|拿到\s*flag|flag\s*(已)?验证|SOLVED/i },
	{ kind: "卡点", test: /\[卡点\]|^卡点[:：]|失败|阻塞|卡住|未命中|行不通|不可达/i },
	{ kind: "假设", test: /\[假设\]|^假设[:：]|推测|怀疑|可能(是|由于)|如果.*则/i },
	{ kind: "计划", test: /\[(待办|计划)\]|^待办[:：]|下一步|TODO|待验证方向/i },
	{ kind: "发现", test: /\[发现\]|^发现[:：]|观察到|注意到|指纹|版本|响应头|返回\s*\d{3}/i }
];

/** 从文本判断事实类型；优先方括号标签。 */
export function classifyFactKind(text) {
	const value = String(text == null ? "" : text).trim();
	if (!value) return "记录";
	const bracket = /^\[([^\]]{1,6})\]/.exec(value);
	if (bracket) {
		const tag = bracket[1].trim();
		if (BRACKET_KINDS.includes(tag)) return tag === "待办" ? "计划" : tag;
	}
	for (const rule of KEYWORD_RULES) {
		if (rule.test.test(value)) return rule.kind;
	}
	return "记录";
}

/** 批量分层：返回 {byKind: Map, rows: [{kind, ...fact}]}。 */
export function groupFactsByKind(facts) {
	const rows = (Array.isArray(facts) ? facts : []).filter((f) => f && typeof f.text === "string").map((f) => ({ ...f, kind: f.kind || classifyFactKind(f.text) }));
	const byKind = new Map();
	for (const row of rows) {
		if (!byKind.has(row.kind)) byKind.set(row.kind, []);
		byKind.get(row.kind).push(row);
	}
	return { rows, byKind };
}

export default { FACT_KINDS, classifyFactKind, groupFactsByKind };