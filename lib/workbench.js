/**
 * dsh-ctf-auto / lib/workbench.js
 * 单题工作台文件操作（纯 Node）：题目录内安全列目录 / 读文本 / 写文本。
 *
 * 契约：DESIGN.md §9
 * - 路径先 resolve 到 challenge.dir 内：拒绝绝对路径、`..`、跨目录（含符号链接逃逸）。
 * - 只读文本 ≤512KB；二进制返回 { ok:false, error:"binary" }。
 * - 不做删除、不执行任意命令。
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_TREE_ENTRIES = 200;
export const MAX_TREE_DEPTH = 2;

const BINARY_SAMPLE_BYTES = 8192;
const BINARY_CONTROL_RATIO = 0.3;

class WorkbenchPathError extends Error {
	constructor(message, code = "ESCAPE") {
		super(message);
		this.name = "WorkbenchPathError";
		this.code = code;
	}
}

function fail(message, extra) {
	return { ok: false, error: String(message), ...(extra || {}) };
}

function toPosix(relPath) {
	return relPath.split(path.sep).join("/");
}

function baseDirOf(challengeDir) {
	if (typeof challengeDir !== "string" || !challengeDir.trim()) {
		throw new WorkbenchPathError("题目目录为空", "EBADDIR");
	}
	return path.resolve(challengeDir);
}

/** 归一化相对路径：拒绝绝对路径、盘符、UNC、NUL 与 `..`；返回 "/" 分隔的相对路径（可为空）。 */
function normalizeRelPath(rel) {
	if (rel == null) return "";
	const value = String(rel);
	if (value.includes("\u0000")) throw new WorkbenchPathError("路径包含非法字符");
	const unixish = value.replace(/\\/g, "/");
	if (/^[a-zA-Z]:/.test(unixish)) throw new WorkbenchPathError("拒绝绝对路径");
	if (unixish.startsWith("//")) throw new WorkbenchPathError("拒绝绝对路径");
	if (unixish.startsWith("/")) throw new WorkbenchPathError("拒绝绝对路径");
	const segments = unixish.split("/").filter((segment) => segment && segment !== ".");
	if (segments.some((segment) => segment === "..")) {
		throw new WorkbenchPathError("路径越界（禁止 ..）");
	}
	return segments.join("/");
}

function resolveInfo(challengeDir, rel) {
	const base = baseDirOf(challengeDir);
	const relPath = normalizeRelPath(rel);
	const target = path.resolve(base, ...relPath.split("/").filter(Boolean));
	const relative = path.relative(base, target);
	if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
		throw new WorkbenchPathError("路径越界（跨出题目目录）");
	}
	return { base, target, relPath };
}

function realInside(base, target) {
	try {
		const realBase = fs.realpathSync(base);
		let probe = target;
		if (!fs.existsSync(probe)) probe = path.dirname(probe);
		const realProbe = fs.realpathSync(probe);
		const relative = path.relative(realBase, realProbe);
		return !(relative && (relative.startsWith("..") || path.isAbsolute(relative)));
	} catch {
		// 无法完成真实路径校验时拒绝写入，避免 fail-open 被符号链接绕过。
		return false;
	}
}

/**
 * 把相对路径解析为题目录内的绝对路径。
 * @param {string} challengeDir 题目工作目录（绝对路径）
 * @param {string} rel 相对路径（可含 "/" 或 "\\"）
 * @returns {string} 绝对路径
 * @throws {Error} 路径为空 / 绝对路径 / 含 `..` / 跨出题目录时抛出，error.code 为 ESCAPE
 */
export function resolveInside(challengeDir, rel) {
	return resolveInfo(challengeDir, rel).target;
}

function sortDirents(a, b) {
	const aDir = a.isDirectory() ? 1 : 0;
	const bDir = b.isDirectory() ? 1 : 0;
	if (aDir !== bDir) return bDir - aDir;
	return a.name.localeCompare(b.name, "en");
}

/**
 * 列出题目录树：深度 2、最多 200 条。
 * @param {string} challengeDir
 * @returns {{ok:true, dir:string, entries:Array<{path:string,kind:"file"|"dir",size:number,mtime:number}>, truncated:boolean}
 *           | {ok:false,error:string}}
 */
export function listTree(challengeDir) {
	let base;
	try {
		base = baseDirOf(challengeDir);
	} catch (error) {
		return fail(error.message);
	}
	let stat;
	try {
		stat = fs.statSync(base);
	} catch {
		return fail("题目目录不存在");
	}
	if (!stat.isDirectory()) return fail("不是目录");
	let realBase = base;
	try {
		realBase = fs.realpathSync(base);
	} catch {
		/* keep lexical base */
	}

	const entries = [];
	let truncated = false;
	const queue = [{ abs: realBase, rel: "", depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift();
		let dirents;
		try {
			dirents = fs.readdirSync(current.abs, { withFileTypes: true });
		} catch {
			continue;
		}
		dirents.sort(sortDirents);
		for (const dirent of dirents) {
			if (entries.length >= MAX_TREE_ENTRIES) {
				truncated = true;
				return { ok: true, dir: realBase, entries, truncated };
			}
			const abs = path.join(current.abs, dirent.name);
			const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
			let entryStat;
			try {
				entryStat = fs.lstatSync(abs);
			} catch {
				continue;
			}
			const kind = entryStat.isDirectory() ? "dir" : "file";
			entries.push({
				path: toPosix(rel),
				kind,
				size: kind === "dir" ? 0 : entryStat.size,
				mtime: Math.floor(entryStat.mtimeMs || 0),
			});
			if (kind === "dir" && current.depth + 1 < MAX_TREE_DEPTH) {
				queue.push({ abs, rel, depth: current.depth + 1 });
			}
		}
	}
	return { ok: true, dir: realBase, entries, truncated };
}

function looksBinary(sample) {
	if (sample.length === 0) return false;
	for (const byte of sample) {
		if (byte === 0) return true;
	}
	let control = 0;
	for (const byte of sample) {
		if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
	}
	return control / sample.length > BINARY_CONTROL_RATIO;
}

/**
 * 读取题目录内文本文件（≤512KB，超出截断并标记 truncated）。
 * 二进制返回 { ok:false, error:"binary" }。
 * @param {string} challengeDir
 * @param {string} rel
 * @param {number} [maxBytes] 读取上限（会被 512KB 硬上限夹紧）
 */
export function readText(challengeDir, rel, maxBytes) {
	let info;
	try {
		info = resolveInfo(challengeDir, rel);
	} catch (error) {
		return fail(error.message);
	}
	if (!info.relPath) return fail("路径不能为空（必须指向文件）");
	let stat;
	try {
		stat = fs.statSync(info.target);
	} catch (error) {
		if (error && error.code === "ENOENT") return fail("文件不存在");
		return fail(`读取失败：${error && error.message ? error.message : error}`);
	}
	if (!stat.isFile()) return fail("不是文件");
	if (!realInside(info.base, info.target)) return fail("路径越界（符号链接指向题目录之外）");

	const requested = Number(maxBytes);
	const cap =
		Number.isFinite(requested) && requested > 0
			? Math.min(Math.floor(requested), MAX_TEXT_BYTES)
			: MAX_TEXT_BYTES;
	const size = stat.size;
	const truncated = size > cap;
	let buffer;
	try {
		if (truncated) {
			buffer = Buffer.alloc(cap);
			const fd = fs.openSync(info.target, "r");
			try {
				const read = fs.readSync(fd, buffer, 0, cap, 0);
				buffer = buffer.subarray(0, read);
			} finally {
				fs.closeSync(fd);
			}
		} else {
			buffer = fs.readFileSync(info.target);
		}
	} catch (error) {
		return fail(`读取失败：${error && error.message ? error.message : error}`);
	}
	const sample = buffer.subarray(0, Math.min(BINARY_SAMPLE_BYTES, buffer.length));
	if (looksBinary(sample)) {
		return { ok: false, error: "binary", size, path: info.relPath };
	}
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
	} catch {
		text = buffer.toString("utf8");
	}
	return {
		ok: true,
		path: info.relPath,
		text,
		size,
		truncated,
		mtime: Math.floor(stat.mtimeMs || 0),
	};
}

/**
 * 写入题目录内文本文件（自动建父目录，≤512KB，仅题目录内）。
 * @param {string} challengeDir
 * @param {string} rel
 * @param {string} text
 * @returns {{ok:true,path:string,bytes:number}|{ok:false,error:string}}
 */
export function writeText(challengeDir, rel, text) {
	let info;
	try {
		info = resolveInfo(challengeDir, rel);
	} catch (error) {
		return fail(error.message);
	}
	if (!info.relPath) return fail("路径不能为空（必须指向文件）");
	const content = typeof text === "string" ? text : text == null ? "" : String(text);
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_TEXT_BYTES) {
		return fail(`内容超过上限（${bytes} > ${MAX_TEXT_BYTES} 字节）`);
	}
	let existing = null;
	try {
		existing = fs.lstatSync(info.target);
	} catch (error) {
		if (!error || error.code !== "ENOENT") {
			return fail(`写入失败：${error && error.message ? error.message : error}`);
		}
	}
	if (existing && existing.isDirectory()) return fail("目标是目录");
	if (existing && existing.isSymbolicLink()) return fail("拒绝写入符号链接");
	if (existing && !existing.isFile()) return fail("目标不是普通文件");
	const parent = path.dirname(info.target);
	try {
		fs.mkdirSync(parent, { recursive: true });
	} catch (error) {
		return fail(`无法创建父目录：${error && error.message ? error.message : error}`);
	}
	if (!realInside(info.base, parent)) {
		return fail("路径越界（父目录指向题目录之外）");
	}
	let fd = null;
	try {
		const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
		fd = fs.openSync(info.target, flags, 0o600);
		fs.writeFileSync(fd, content, "utf8");
	} catch (error) {
		return fail(`写入失败：${error && error.message ? error.message : error}`);
	} finally {
		if (fd != null) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
	return { ok: true, path: info.relPath, bytes };
}
