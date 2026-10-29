import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireDirectory, syncDirectory } from "./challenge-statement.js";
import { platformChallengeKey } from "./platform-identity.js";

const rejected = (code, message) => Object.assign(new Error(message), { code });

export async function resolvePlatformAttachments({ platforms, connection, meta, detail, listedItem, check }) {
	check();
	if (detail.files != null) return detail.files;
	if (listedItem?.files != null) return listedItem.files;
	const listed = await connection.client.listChallenges();
	check();
	const item = listed.ok && Array.isArray(listed.data)
		? listed.data.find((row) => row && platformChallengeKey(platforms.metadata(connection, row)) === platformChallengeKey(meta)) : null;
	if (!Array.isArray(item?.files)) throw rejected("ATTACHMENT_MANIFEST_MISSING", "平台未返回可确认的附件列表，已保留未就绪状态");
	return structuredClone(item.files);
}

export function platformPreparationPatch(detail, { platformId, baseUrl, title = "", category = "", maxStatementBytes = 2 * 1024 * 1024 }) {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw rejected("PLATFORM_DETAIL_INVALID", "平台题面格式无效");
	if (detail.id != null && String(detail.id) && String(detail.id) !== String(platformId)) throw rejected("PLATFORM_DETAIL_MISMATCH", "平台返回的题目编号与请求不一致");
	const parts = [];
	if (detail.description) parts.push(String(detail.description));
	if (detail.connectionInfo) parts.push(`连接信息：${detail.connectionInfo}`);
	parts.push(`平台题号：${platformId}（${baseUrl}）`);
	const statement = parts.join("\n\n");
	if (Buffer.byteLength(statement, "utf8") > maxStatementBytes) throw rejected("STATEMENT_TOO_LARGE", "平台题面超过大小上限");
	return { title: String(detail.name || title || `challenge-${platformId}`), category: String(detail.category || category || ""), statement,
		target: String(detail.connectionInfo || ""), hasContainer: detail.hasContainer === true, requiresTarget: detail.requiresTarget === true };
}

// Both first import and explicit recovery use fresh URLs and new exclusive paths.
// Partial files are retained for inspection, never inferred to be complete inputs.
export async function downloadPlatformInputs({ challenge, connection, rawFiles, check }) {
	if (!Array.isArray(rawFiles) || rawFiles.length > 10) throw rejected("ATTACHMENT_LIMIT", "平台附件格式无效或数量超过 10 个");
	if (rawFiles.length && typeof connection.client.download !== "function") throw rejected("PLATFORM_UNSUPPORTED", "当前适配器不支持附件下载");
	const files = [], directory = path.join(challenge.dir, "files");
	let bytes = 0;
	check(); requireDirectory(directory);
	for (const entry of rawFiles) {
		const url = typeof entry === "string" ? entry : entry?.url;
		if (typeof url !== "string" || !url) throw rejected("ATTACHMENT_INVALID", "平台附件地址无效");
		check();
		const downloaded = await connection.client.download(url, { maxBytes: 20 * 1024 * 1024 });
		check(); requireDirectory(directory);
		if (!downloaded.ok || !(downloaded.bytes instanceof Uint8Array)) throw rejected(downloaded.code || "ATTACHMENT_DOWNLOAD_FAILED", "平台附件下载失败，题目没有进入可执行状态");
		bytes += downloaded.bytes.byteLength;
		if (downloaded.bytes.byteLength > 20 * 1024 * 1024 || bytes > 50 * 1024 * 1024) throw rejected("ATTACHMENT_TOO_LARGE", "平台附件超过单文件或总大小上限");
		const base = String(entry?.name || downloaded.filename || "file.bin").split(/[\\/]/).at(-1).replace(/[^\w.\-]+/g, "_").slice(0, 100);
		const name = base && !/^\.+$/.test(base) ? base : "file.bin", dest = path.join(directory, `platform-${crypto.randomUUID()}-${name}`);
		const fd = fs.openSync(dest, "wx", 0o600);
		try { fs.writeFileSync(fd, downloaded.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		files.push({ name, path: dest, source: "platform", url, size: downloaded.bytes.byteLength });
	}
	check(); syncDirectory(directory);
	return files;
}
