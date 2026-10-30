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

import { tokenize } from "./knowledge-tokens.js";
import { learningHash } from "./learning-evidence.js";
import { searchKnowledge, rankKnowledge, buildKnowledgePromptSection } from "./kb-retrieval.js";
export { tokenize, searchKnowledge, rankKnowledge, buildKnowledgePromptSection };

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
			contentHash: learningHash(item.text), sourceChallengeId: String(item.sourceChallengeId || item.challengeId || ""),
			trust: item.trust || "external-reference", allowAutomatic: item.allowAutomatic !== false,
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
			contentHash: learningHash(item.text), sourceChallengeId: String(item.sourceChallengeId || item.challengeId || ""),
			trust: item.trust || "external-reference", allowAutomatic: item.allowAutomatic !== false,
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
			contentHash: learningHash(item.text), sourceChallengeId: String(item.sourceChallengeId || item.challengeId || ""),
			trust: item.trust || "external-reference", allowAutomatic: item.allowAutomatic !== false,
			tags: Array.isArray(item.tags) ? item.tags.map(String) : []
		});
	}
	entries.sort((a, b) => b.mtime - a.mtime);
	return entries;
}

export default { buildKnowledgeIndex, searchKnowledge, rankKnowledge, buildKnowledgePromptSection, tokenize };
