import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInside } from "./workbench.js";

export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_FILES = 4;

// Only snapshot small regular files in this challenge. No execution, symlinks,
// partial-file digests, or unbounded reads from pipes/devices.
export function snapshotEvidence(dir, relative) {
	const root = path.resolve(dir), target = resolveInside(root, relative);
	const rel = path.relative(root, target);
	if (!rel || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("证据必须位于真实题目目录中的普通文件");
	let cursor = root;
	for (const part of rel.split(path.sep)) {
		cursor = path.join(cursor, part);
		if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("证据路径不能经过符号链接");
	}
	const before = fs.lstatSync(target);
	if (!before.isFile() || before.size > MAX_EVIDENCE_BYTES) throw new Error("证据必须是至多 1MiB 的普通文件");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("读取证据时文件已被替换");
		const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
		let size = 0, n;
		while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
		const after = fs.fstatSync(fd);
		if (size > MAX_EVIDENCE_BYTES || size !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("证据在读取期间变化，请保存文件后重试");
		return { path: rel.split(path.sep).join("/"), size, sha256: crypto.createHash("sha256").update(buffer.subarray(0, size)).digest("hex") };
	} finally { fs.closeSync(fd); }
}

export function captureEvidence(dir, paths = []) {
	if (!Array.isArray(paths) || paths.length > MAX_EVIDENCE_FILES || paths.some((value) => typeof value !== "string" || !value || value.length > 300)) throw new Error("证据路径须为至多 4 个题目内相对路径");
	const captured = [...new Set(paths)].map((file) => snapshotEvidence(dir, file));
	return [...new Map(captured.map((ref) => [ref.path, ref])).values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function checkEvidence(dir, evidence) {
	return evidence.map((stored) => {
		try {
			const current = snapshotEvidence(dir, stored.path);
			return { ...stored, integrity: current.sha256 === stored.sha256 ? "match" : "changed" };
		} catch { return { ...stored, integrity: "unavailable" }; }
	});
}
