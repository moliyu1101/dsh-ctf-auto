// dsh-ctf-auto / lib/kbimport.js —— 知识层导入（纯函数：输入解析 / 路径规范化 / 文件名安全化）。
//
// 导入目标：把本地任意 md/txt 资料（题解、笔记、模块卡）拷进 <rootDir>/knowledge/ 并纳入检索。
// 只接受本地文件；拒绝目录穿越与超限；内容读取由宿主完成（本模块只做纯校验）。

import path from "node:path";

export const ALLOWED_EXT = [".md", ".markdown", ".txt"];
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_FILES = 50;
export const MAX_IMPORT_TOTAL_BYTES = 20 * 1024 * 1024;

/** 把 textarea/数组输入拆成路径列表（支持换行/逗号/分号分隔，忽略空行与注释）。 */
export function parseImportInput(input) {
	const raw = Array.isArray(input) ? input : String(input == null ? "" : input).split(/[\r\n,;]+/);
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		const text = String(item == null ? "" : item).trim();
		if (!text || text.startsWith("#")) continue;
		if (seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out.slice(0, MAX_IMPORT_FILES);
}

/** 规范化单个导入路径：相对路径按 cwd 解析；扩展名必须受支持。 */
export function normalizeImportPath(raw, options = {}) {
	const cwd = options.cwd ? path.resolve(String(options.cwd)) : process.cwd();
	const abs = path.isAbsolute(String(raw)) ? path.normalize(String(raw)) : path.resolve(cwd, String(raw));
	const ext = path.extname(abs).toLowerCase();
	if (!ALLOWED_EXT.includes(ext)) {
		return { ok: false, error: `不支持的类型 ${ext || "(无扩展名)"}（只支持 ${ALLOWED_EXT.join(" / ")}）`, path: abs };
	}
	return { ok: true, path: abs, name: path.basename(abs) };
}

/** 生成安全的落盘文件名：去路径/控制字符/..；重名自动加 -1/-2 后缀。 */
export function safeKnowledgeName(name, taken = []) {
	const base = String(name == null ? "" : name)
		.replace(/\\/g, "/")
		.split("/").pop()
		.replace(/[<>:"|?*\u0000-\u001f]/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 120);
	const fallback = `imported-${Date.now()}.md`;
	const candidate = base || fallback;
	const used = new Set((Array.isArray(taken) ? taken : []).map((item) => String(item || "").toLowerCase()));
	if (!used.has(candidate.toLowerCase())) return candidate;
	const ext = path.extname(candidate);
	const stem = candidate.slice(0, candidate.length - ext.length);
	let index = 1;
	while (used.has(`${stem}-${index}${ext}`.toLowerCase())) index += 1;
	return `${stem}-${index}${ext}`;
}

export default { ALLOWED_EXT, MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_IMPORT_TOTAL_BYTES, parseImportInput, normalizeImportPath, safeKnowledgeName };
