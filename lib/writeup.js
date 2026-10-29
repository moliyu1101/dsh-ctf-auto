import { acceptedFlag } from "./flag-candidates.js";
// dsh-ctf-auto / lib/writeup.js —— 单题 Writeup 生成（纯函数，无 IO）。
//
// 用户口径：Writeup 只写「题目」和「解题步骤」两块，不要解题方向建议、尝试过程、产物/事实链/复现等旁支。
//   - 题目：清洗题面里由编排层写进去的辅助块（解题方向建议/已观测事实/工作区协议/平台题号/题名等）；
//   - 解题步骤：取 notes.md 的解题记录，剔除反注入观察、已失败路径、下一步建议、时间预算等无关小节。
//
// 契约：docs/DESIGN.md §16.1。

const MAX_STATEMENT = 8000;
const MAX_STEPS = 12000;

/** 题面里需要整块删除的辅助段落（编排层/Lead 注入，不属于题目本身）。 */
const STATEMENT_BLOCK_NOISE = [
	/^解题方向建议/,
	/^已观测事实/,
	/^工作区[:：]/,
	/^平台题号[:：]/,
	/^解题路径建议/,
	/^建议方向/,
	/^提示[:：]\s*.*自行取舍/
];

/** 题面里需要删除的单行元信息（题名/模块/id 与标题重复；目标保留）。 */
const STATEMENT_LINE_NOISE = [
	/^题名[:：]/,
	/^模块[:：]/,
	/^题目\s*id[:：]/i,
	/^题目id[:：]/
];

/** notes.md 中与「解题步骤」无关的小节标题。 */
const NOTES_SECTION_NOISE = [
	/反注入/, /注入面观察/, /注入观察/,
	/已失败路径/, /失败路径/,
	/下一步建议/, /后续建议/, /续接提示/, /建议[:：]?$/,
	/时间预算/, /预算与产出/, /checkpoint/i,
	/工作区协议/, /完成协议/,
	/卡点/, /风险/, /备注[:：]?$/,
	/备用手段/, /辅助手段/,
	/^产物$/, /^关键产物$/, /^事实链$/, /^复现与验证$/,
	/^已尝试路径$/, /^尝试记录$/, /尝试/, /下一次/, /本次/, /前序/, /前两轮/, /历次/, /差异/, /遗留/, /反注入/, /补测/, /复盘/, /attempt/i,
	/失败/, /超时/, /中断/, /报错/, /异常/, /卡死/, /阻塞/, /配额/, /环境/,
	/子代理/, /编排/, /preset/i, /派发/, /预算/, /收口/, /复核/, /回顾/, /时间线/,
	/证据链/, /事实链/, /产物/, /交付/, /备查/, /备注/, /建议/
];

function stripNoiseBlocks(text, markers) {
	let out = String(text == null ? "" : text);
	for (const re of markers) {
		// 从命中行（可带前缀空行）删到下一个空行或文本末尾
		const pattern = new RegExp(`(?:^|\\n)[ \\t]*${re.source}[^\\n]*\\n?(?:(?!\\n[ \\t]*\\n)[\\s\\S])*`, "gim");
		out = out.replace(pattern, "\n");
	}
	return out;
}

/** 清洗题面：去掉编排层注入的辅助块与重复元信息行，压掉多余空行。 */
export function cleanStatement(statement) {
	let text = stripNoiseBlocks(statement, STATEMENT_BLOCK_NOISE);
	const lines = text.split(/\r?\n/);
	const kept = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (STATEMENT_LINE_NOISE.some((re) => re.test(trimmed))) continue;
		kept.push(line);
	}
	text = kept.join("\n");
	text = text.replace(/\n{3,}/g, "\n\n").trim();
	return text;
}

/**
 * 从 notes.md 提取解题步骤：按标题切分小节，丢弃与解题无关的小节；
 * 去掉笔记标题行与「随做随记」占位；压掉多余空行。
 */
export function extractSteps(notes) {
	const raw = String(notes == null ? "" : notes).replace(/\r\n/g, "\n");
	if (!raw.trim()) return "";
	const lines = raw.split("\n");
	const sections = [];
	let current = { heading: "", lines: [] };
	const flush = () => {
		if (current.heading || current.lines.length > 0) sections.push(current);
		current = { heading: "", lines: [] };
	};
	let inCode = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) { inCode = !inCode; current.lines.push(line); continue; }
		if (!inCode) {
			const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
			if (headingMatch) { flush(); current.heading = headingMatch[2].trim(); continue; }
		}
		current.lines.push(line);
	}
	flush();

	const isNoiseHeading = (heading) => {
		if (!heading) return false;
		return NOTES_SECTION_NOISE.some((re) => re.test(heading));
	};
	const kept = [];
	for (const section of sections) {
		if (isNoiseHeading(section.heading)) continue;

		const body = section.lines
			.map((line) => line.replace(/^[\s>-]*随做随记[：:].*$/, "").replace(/^（随做随记.*）$/, ""))
			.map((line) => line.replace(/\s+#.*(?:失败|尝试|重试|卡住|超时|中断).*$/i, ""))
			.filter((line) => !/^(?:题名|模块|题目\s*id|题目id|平台题号|目标|会话|难度|分值)[:：]\s*/i.test(line.trim()))
			.filter((line) => /^\s*(```|\$|python|node|curl|wget|nmap|sqlmap|bash|sh|\.\/|[\w.-]+\.(py|sh|mjs|js|c|cpp))/.test(line) || !/子代理|编排|preset|attempt|尝试|下一次|本次|前序|历次|时间预算|超时|中断|派发|session|失败|遗留|待验证|stopped|占用者|反注入|配额|环境被|异常结束/i.test(line))
			.filter((line, idx, arr) => !(idx === 0 && line.trim() === "" && arr.length > 1))
			.join("\n")
			.trim();
		// 空小节、笔记文件标题（<题名> — 解题记录/笔记）都不算步骤
		if (!body) continue;
		if (/解题笔记|解题记录|随做随记/.test(section.heading || "")) continue;
		if (!section.heading && /^（随做随记.*）$/.test(body)) continue;
		kept.push(section.heading ? `### ${section.heading}` + (body ? `\n\n${body}` : "") : body);
	}
	const text = kept.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
	return text;
}

/**
 * 生成单题 Writeup：只有「题目」和「解题步骤」两节。
 * @param {object} challenge
 * @param {{generatedAt?:number, notes?:string, files?:Array}} options
 * @returns {string}
 */
export function buildWriteup(challenge, options = {}) {
	const ch = challenge && typeof challenge === "object" ? challenge : {};
	const opts = options && typeof options === "object" ? options : {};
	const title = String(ch.title || "(未命名题目)").trim();
	const statement = cleanStatement(ch.statement);
	const statementClipped = statement.length > MAX_STATEMENT ? `${statement.slice(0, MAX_STATEMENT)}\n\n…（题面过长，已截断；完整题面见工作区 statement.md）` : statement;
	let steps = extractSteps(opts.notes);
	if (!steps) {
		const verified = (Array.isArray(ch.flags) ? ch.flags : []).find((flag) => acceptedFlag(ch, flag));
		steps = verified && verified.value ? `解出 flag：\`${verified.value}\`（工作区未留下 notes.md 解题记录）` : "（未记录解题步骤）";
	}
	if (steps.length > MAX_STEPS) steps = `${steps.slice(0, MAX_STEPS)}\n\n…（解题步骤过长，已截断；完整记录见工作区 notes.md）`;
	return [
		`# ${title}`,
		"",
		"## 题目",
		"",
		statementClipped || "（未提供题面）",
		"",
		"## 解题步骤",
		"",
		steps,
		""
	].join("\n");
}

/** 汇总技术报告：只含已解题目 + 解题步骤，不含 attempts/失败/子代理/时间线。 */
export function buildTechnicalReport(challenges, options = {}) {
	const opts = options && typeof options === "object" ? options : {};
	const list = (Array.isArray(challenges) ? challenges : []).filter((ch) => ch && String(ch.status || "") === "solved").sort((a, b) => String(a.category || "").localeCompare(String(b.category || "")) || String(a.title || "").localeCompare(String(b.title || "")));
	const generatedAt = Number(opts.generatedAt) || Date.now();
	const byCategory = new Map();
	for (const ch of list) { const key = String(ch.category || "未分类"); if (!byCategory.has(key)) byCategory.set(key, []); byCategory.get(key).push(ch); }
	const out = ["# CTF 技术报告", "", "- 生成时间：" + new Date(generatedAt).toISOString()];
	if (opts.workspace) out.push("- 工作区：" + opts.workspace);
	out.push("- 已解题目：" + list.length);
	out.push("- 模块分布：" + [...byCategory.entries()].map(([k, v]) => k + " " + v.length).join(" · "), "", "## 目录", "");
	list.forEach((ch, index) => out.push((index + 1) + ". " + ch.title + "（" + (ch.category || "未分类") + "）"));
	out.push("");
	for (const ch of list) {
		const notes = opts.notesById && opts.notesById[ch.id] ? opts.notesById[ch.id] : "";
		let body = buildWriteup(ch, { notes });
		body = body.replace(/^# .+\n/, "").replace(/^## /gm, "### ").trim();
		const verified = (Array.isArray(ch.flags) ? ch.flags : []).find((flag) => acceptedFlag(ch, flag));
		out.push("---", "", "## " + ch.title, "", "- 模块：" + (ch.category || "未分类"));
		if (ch.target) out.push("- 目标：" + ch.target);
		if (verified && verified.value) out.push("- Flag：`" + verified.value + "`");
		out.push("", body || "（未记录解题步骤）", "");
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
