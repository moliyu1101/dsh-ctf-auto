import fs from "node:fs";
import path from "node:path";
import { buildKnowledgeIndex } from "./kb.js";
import { readLearningText } from "./learning-evidence.js";

export function createKnowledgeCatalog({ challenges, writeupsDir, knowledgeDir, sourceEligible }) {
	const cache = new Map(); let diagnostics = {};
	function scan() {
		const all = challenges(), candidates = [], skipped = [];
		function directory(root, source) {
			try {
				if (fs.lstatSync(root).isSymbolicLink()) throw new Error("目录不能为符号链接");
				for (const name of fs.readdirSync(root).filter((n) => /\.(md|markdown|txt)$/i.test(n)).sort().slice(0, 500)) {
					const owner = source === "writeup" ? all.find((ch) => `${ch.slug || ch.id}-writeup.md` === name) : null;
					candidates.push({ root, relative: name, source, owner });
				}
			} catch (e) { if (e.code !== "ENOENT") skipped.push({ path: root, reason: "目录不可安全读取" }); }
		}
		directory(writeupsDir(), "writeup"); directory(knowledgeDir(), "imported");
		for (const ch of all) candidates.push({ root: ch.dir, relative: "notes.md", source: "notes", owner: ch });
		candidates.sort((a, b) => Number(a.source === "notes") - Number(b.source === "notes") || path.join(a.root, a.relative).localeCompare(path.join(b.root, b.relative)));
		const gathered = { writeups: [], notes: [], imported: [] }; let bytes = 0, read = 0;
		for (const item of candidates) {
			if (read >= 500 || bytes >= 32 * 1024 * 1024) { skipped.push({ path: item.root, reason: "本次索引已达 500 文件或 32MiB 上限" }); continue; }
			try {
				const snapshot = readLearningText(item.root, item.relative, { optional: true });
				if (snapshot.missing || !snapshot.text.trim()) continue;
				if (bytes + snapshot.bytes > 32 * 1024 * 1024) { skipped.push({ path: snapshot.path, reason: "总大小上限" }); continue; }
				bytes += snapshot.bytes; read++;
				const eligible = item.owner ? sourceEligible(item.owner) : true;
				const source = { name: item.relative, path: snapshot.path, text: snapshot.text, mtime: snapshot.mtime,
					category: item.owner?.category || "", workspace: item.owner?.workspace || "", challengeId: item.owner?.id || "",
					sourceChallengeId: item.owner?.id || "", title: item.owner?.title || item.relative,
					allowAutomatic: eligible && item.source !== "notes", trust: item.source === "notes" ? "原始笔记，仅供手动检索；可复用步骤由证据记忆提供"
						: item.owner ? eligible ? "已核验题目的原始资料，段落仍须复验" : "待复核来源，仅供手动检索" : "外部参考，内容未经验证" };
				gathered[item.source === "writeup" ? "writeups" : item.source === "notes" ? "notes" : "imported"].push(source);
			} catch { skipped.push({ path: path.join(item.root, item.relative), reason: "非普通文本、符号链接、过大或读取期间变化" }); }
		}
		const entries = buildKnowledgeIndex(gathered), seen = new Set();
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i], old = cache.get(entry.path); seen.add(entry.path);
			if (old && old.contentHash === entry.contentHash) { Object.assign(old, entry); entries[i] = old; } else cache.set(entry.path, entry);
		}
		for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
		diagnostics = { documents: entries.length, bytes, skipped: skipped.length, issues: skipped.slice(0, 20), freshness: "每次检索重新核对文件字节" };
		return entries;
	}
	return { scan, status: () => diagnostics };
}
