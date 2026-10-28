// dsh-ctf-auto / lib/kb.js —— 私有知识库（Writeup/笔记）索引与检索（纯函数）。
//
// 知识层目标：把导出的 Writeup 与各题 notes.md 建成可检索的本地库（按技法/题型/工具/关键词），
// 跨工作区可用。索引扫描由宿主完成（读文件/列题目），本模块只负责建索引、打分与摘录。

const SOURCE_LABEL = { writeup: "Writeup", notes: "笔记", imported: "导入" };

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function oneLine(value, max = 400) {
	const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
	return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Preserve identifiers and use Han bigrams so Chinese sentences can share terms. */
export function tokenize(query) {
	const parts = String(query ?? "").normalize("NFKC").toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+(?:[_.:-][a-z0-9]+)*/gu) || [];
	const tokens = [];
	for (const part of parts) {
		if (/^\p{Script=Han}+$/u.test(part) && part.length > 1) {
			for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2));
		} else tokens.push(part);
	}
	return [...new Set(tokens)];
}

/**
 * 建索引：输入宿主扫出来的原始资料，输出可检索条目。
 * @param {{writeups?: Array<{name:string,path:string,text:string,mtime?:number}>, notes?: Array<{challengeId:string,title:string,category?:string,workspace?:string,path:string,text:string,mtime?:number}>}} sources
 * @returns {Array<{id:string,source:string,sourceLabel:string,title:string,path:string,category:string,workspace:string,text:string,mtime:number,tags:string[]}>}
 */
export function buildKnowledgeIndex(sources = {}) {
	const raw = isPlainObject(sources) ? sources : {};
	const entries = [];
	for (const item of Array.isArray(raw.writeups) ? raw.writeups : []) {
		if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
		const name = String(item.name || item.path || "writeup");
		entries.push({
			id: `writeup:${name}`,
			source: "writeup",
			sourceLabel: SOURCE_LABEL.writeup,
			title: name.replace(/-writeup\.md$/i, "").replace(/\.md$/i, ""),
			path: String(item.path || ""),
			category: String(item.category || ""),
			workspace: String(item.workspace || ""),
			text: item.text,
			mtime: Number(item.mtime) || 0,
			tags: Array.isArray(item.tags) ? item.tags.map(String) : []
		});
	}
	for (const item of Array.isArray(raw.imported) ? raw.imported : []) {
		if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
		const name = String(item.name || item.path || "imported");
		entries.push({
			id: `imported:${name}`,
			source: "imported",
			sourceLabel: "导入",
			title: name.replace(/\.(md|markdown|txt)$/i, ""),
			path: String(item.path || ""),
			category: String(item.category || ""),
			workspace: "",
			text: item.text,
			mtime: Number(item.mtime) || 0,
			tags: Array.isArray(item.tags) ? item.tags.map(String) : []
		});
	}
	for (const item of Array.isArray(raw.notes) ? raw.notes : []) {
		if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
		entries.push({
			id: `notes:${String(item.challengeId || "")}`,
			source: "notes",
			sourceLabel: SOURCE_LABEL.notes,
			title: String(item.title || item.challengeId || "题目笔记"),
			path: String(item.path || ""),
			category: String(item.category || ""),
			workspace: String(item.workspace || ""),
			text: item.text,
			mtime: Number(item.mtime) || 0,
			tags: Array.isArray(item.tags) ? item.tags.map(String) : []
		});
	}
	entries.sort((a, b) => b.mtime - a.mtime);
	return entries;
}

function snippetOf(text, terms, radius = 80) {
	const source = String(text || "").replace(/\s+/g, " ").trim();
	if (!source) return "";
	const hay = source.toLowerCase();
	let at = -1;
	for (const term of terms) {
		const idx = hay.indexOf(term);
		if (idx >= 0 && (at < 0 || idx < at)) at = idx;
	}
	if (at < 0) return source.slice(0, radius * 2);
	const start = Math.max(0, at - radius);
	const end = Math.min(source.length, at + radius);
	return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

/**
 * 检索知识条目：AND 关键词；标题/分类命中加权；返回按分排序并附摘录。
 * @param {Array} entries buildKnowledgeIndex 的输出
 * @param {string} query
 * @param {{limit?:number}} options
 */
export function searchKnowledge(entries, query, options = {}) {
	const terms = tokenize(query);
	if (terms.length === 0) return [];
	const limit = Math.max(1, Math.min(100, Number(options.limit) || 10));
	const results = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry.text !== "string") continue;
		const text = entry.text.toLowerCase();
		const title = String(entry.title || "").toLowerCase();
		const category = String(entry.category || "").toLowerCase();
		const tags = (entry.tags || []).join(" ").toLowerCase();
		let score = 0;
		let matchedAll = true;
		for (const term of terms) {
			const inText = [text, title, category, tags].some((field) => field.includes(term));
			if (!inText) { matchedAll = false; break; }
			score += 1;
			if (title.includes(term)) score += 4;
			if (category.includes(term)) score += 2;
			if (tags.includes(term)) score += 2;
		}
		if (!matchedAll) continue;
		// 近期条目略加权（30 天内）
		const ageDays = entry.mtime ? (Date.now() - entry.mtime) / 86400000 : 999;
		if (ageDays >= 0 && ageDays < 30) score += 1;
		results.push({
			id: entry.id,
			source: entry.source,
			sourceLabel: entry.sourceLabel,
			title: entry.title,
			category: entry.category,
			workspace: entry.workspace,
			path: entry.path,
			score,
			snippet: snippetOf(entry.text, terms)
		});
	}
	results.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
	return results.slice(0, limit).map((item) => ({ ...item, snippet: oneLine(item.snippet, 300) }));
}


const passageCache = new WeakMap();
function passagesFor(entry) {
	const title = entry.title || "", tags = (entry.tags || []).join(" ");
	const cached = passageCache.get(entry);
	if (cached && cached.text === entry.text && cached.title === title && cached.tags === tags) return cached.passages;
	const passages = [];
	for (let at = 0; at < Math.max(1, entry.text.length); at += 600) {
		const text = entry.text.slice(at, at + 800);
		passages.push({ text, tokens: new Set(tokenize(`${title} ${tags} ${text}`)) });
	}
	passageCache.set(entry, { text: entry.text, title, tags, passages });
	return passages;
}

/**
 * 知识层召回：按挑战文本与知识条目文本的词集重合度打分，取前 limit 条。
 * @param {Array} entries buildKnowledgeIndex 的输出
 * @param {{title?:string, statement?:string, category?:string, target?:string}} challenge
 * @param {{limit?:number, minScore?:number}} options
 */
export function rankKnowledge(entries, challenge, options = {}) {
	const ch = challenge && typeof challenge === "object" ? challenge : {};
	const q = new Set(tokenize(`${ch.title || ""} ${ch.statement || ""}`));
	if (q.size === 0) return [];
	const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
	const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 0.1;
	const scored = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry.text !== "string") continue;
		// Score overlapping passages so a relevant paragraph in a long document
		// can be selected and injected instead of the document introduction.
		const passages = passagesFor(entry);
		let best = null;
		for (const passage of passages) {
			const c = passage.tokens;
			let overlap = 0;
			for (const token of q) if (c.has(token)) overlap++;
			if (!overlap) continue;
			let score = overlap / Math.sqrt(Math.max(1, q.size) * Math.max(1, c.size));
			if (ch.category && entry.category && String(ch.category) === String(entry.category)) score += 0.2;
			if (!best || score > best.score) best = { score, snippet: snippetOf(passage.text, [...q], 130) };
		}
		if (best && best.score >= minScore) scored.push({ ...entry, snippet: best.snippet, score: Math.round(best.score * 1000) / 1000 });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/** 生成注入提示词的「相关知识库」片段。 */
export function buildKnowledgePromptSection(entries) {
	const list = Array.isArray(entries) ? entries.filter((item) => item && item.title) : [];
	if (list.length === 0) return "";
	const lines = [
		"## 8. 相关知识库片段（私有 Writeup / 题板笔记 / 导入资料）",
		"",
		"> 来自历史解题记录与导入资料。优先参考其中的入口/技法/命令；**结论必须自己在本题复现**。需要更多时调用 `ctf_kb_search` 或 `ctf_recall`。",
		""
	];
	for (const entry of list.slice(0, 10)) {
		lines.push(`- [${(entry.score || 0).toFixed(2)}｜${entry.sourceLabel || entry.source}] 「${entry.title}」`);
		const snippet = String(entry.snippet || entry.text || "").replace(/\s+/g, " ").trim().slice(0, 260);
		if (snippet) lines.push(`  - 摘录：${snippet}`);
		if (entry.path) lines.push(`  - 路径：${entry.path}`);
	}
	lines.push("");
	return lines.join("\n");
}

export default { buildKnowledgeIndex, searchKnowledge, rankKnowledge, buildKnowledgePromptSection, tokenize };
