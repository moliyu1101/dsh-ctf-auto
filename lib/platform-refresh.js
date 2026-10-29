import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pendingInputProjection } from "./challenge-lifecycle.js";
import { requireDirectory, syncDirectory, statementFileRevision } from "./challenge-statement.js";

const fingerprint = (ch) => JSON.stringify([ch.dir, ch.workspace, ch.platform, ch.title, ch.statement, ch.files,
	ch.category, ch.target, ch.hasContainer, ch.requiresTarget, ch.status, ch.taskJournal, ch.environment, ch.environmentJournal]);
const failure = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
function rejected(code, message) { return Object.assign(new Error(message), { code }); }
function attachmentName(value) {
	const base = String(value || "file.bin").split(/[\\/]/).at(-1).replace(/[^\w.\-]+/g, "_").slice(0, 100);
	return base && !/^\.+$/.test(base) ? base : "file.bin";
}

// Read-only remote work is staged before any visible challenge state is changed.
export function createPlatformRefresh({ store, platforms, projections, resourceStatus,
	maxStatementBytes = 2 * 1024 * 1024, maxFiles = 50, maxDownloads = 10,
	maxFileBytes = 20 * 1024 * 1024, maxTotalBytes = 50 * 1024 * 1024 }) {
	let closed = false;
	function available(ch) {
		const usage = resourceStatus(ch);
		if (["queued", "running"].includes(ch.status) || usage.users > 0 || usage.cleanup || usage.blocked || usage.taskBlocked || usage.taskRecoveryPending || pendingInputProjection(ch))
			throw rejected("CHALLENGE_REFRESH_BUSY", "题目正在排队、被使用或有未决任务/文件同步，请先停止并完成核对");
	}
	function writable() {
		if (closed || store.persistenceStatus().closed) throw rejected("REFRESH_CLOSED", "题面刷新服务已关闭");
		const result = store.checkWritable();
		if (!result.ok) throw rejected(result.code, result.error);
		if (store.persistenceStatus().dirty) throw rejected("STATE_NOT_DURABLE", "状态尚未保存，已暂停题面刷新");
	}
	async function execute(id, { onlyEmpty = true, scope } = {}) {
		writable();
		const original = store.read(id)?.challenge;
		if (!original) throw rejected("CHALLENGE_NOT_FOUND", "题目不存在");
		if (scope && (original.dir !== scope.dir || original.workspace !== scope.workspace)) throw rejected("STALE_REFRESH_SCOPE", "题目归属在排队期间已变化，请重新授权后刷新");
		if (!original.platform || original.platform.kind && original.platform.kind !== "dasctf") throw rejected("REFRESH_UNSUPPORTED", "当前刷新入口仅支持 DASCTF 题目");
		if (original.platform.challengeId == null || String(original.platform.challengeId) === "") throw rejected("PLATFORM_CHALLENGE_INVALID", "题目缺少平台编号");
		if (onlyEmpty && original.statement.length > 200 && original.files.length) return { ok: true, skipped: true, id };
		available(original);
		const connection = platforms.forChallenge(original);
		if (!connection.client) throw rejected(connection.code || "PLATFORM_UNAVAILABLE", connection.error);
		const base = fingerprint(original), meta = original.platform, statementRevision = statementFileRevision(original.dir);
		function current() {
			if (closed || store.persistenceStatus().closed) throw rejected("REFRESH_CLOSED", "实例已关闭，已忽略旧刷新结果");
			const ch = store.read(id)?.challenge;
			if (!ch || fingerprint(ch) !== base) throw rejected("STALE_CHALLENGE_REFRESH", "题面、附件、来源或题目状态已变化，已丢弃旧刷新结果");
			if (statementFileRevision(ch.dir) !== statementRevision) throw rejected("STALE_STATEMENT_FILE", "题面文件在刷新期间已变化，已丢弃旧刷新结果");
			available(ch);
			if (platforms.forChallenge(ch).sessionKey !== connection.sessionKey) throw rejected("STALE_PLATFORM_CONNECTION", "平台连接已切换，已丢弃旧刷新结果");
			return ch;
		}
		const response = await connection.client.getChallenge(meta.challengeId, { id: meta.challengeId, practice_ground_id: meta.groundId || "",
			source: { type: meta.sourceType || "practice", practice_ground_id: meta.groundId || "", competition_id: meta.competitionId || "", stage_id: meta.stageId || "" } });
		current();
		if (!response.ok) return failure(response.code || "PLATFORM_REFRESH_FAILED", response.error || "平台题面查询失败", { id });
		const detail = response.data;
		if (!detail || typeof detail !== "object" || Array.isArray(detail) || detail.files != null && !Array.isArray(detail.files)) throw rejected("PLATFORM_DETAIL_INVALID", "平台题目详情格式无效，未修改本地题目");
		const parts = [];
		if (detail.description) parts.push(String(detail.description));
		if (detail.connectionInfo) parts.push(`连接信息：${detail.connectionInfo}`);
		parts.push(`平台题号：${meta.challengeId}（${connection.baseUrl}）`);
		const statement = parts.join("\n\n");
		if (Buffer.byteLength(statement) > maxStatementBytes) throw rejected("STATEMENT_TOO_LARGE", "平台题面超过大小上限");
		const remoteFiles = detail.files || [];
		if (remoteFiles.length > maxDownloads) throw rejected("ATTACHMENT_LIMIT", "平台附件数量超过单次刷新上限");
		const downloads = [], seen = new Set();
		let totalBytes = 0;
		for (const remote of remoteFiles) {
			const url = typeof remote === "string" ? remote : remote?.url;
			if (typeof url !== "string" || !url) throw rejected("ATTACHMENT_INVALID", "平台附件缺少有效下载地址");
			if (seen.has(url)) continue;
			seen.add(url);
			const downloaded = await connection.client.download(url, { maxBytes: maxFileBytes });
			current();
			if (!downloaded.ok) throw rejected(downloaded.code || "ATTACHMENT_DOWNLOAD_FAILED", "平台附件下载失败，未更新题面和附件列表");
			if (!(downloaded.bytes instanceof Uint8Array)) throw rejected("ATTACHMENT_INVALID", "附件下载没有返回有效字节数据");
			totalBytes += downloaded.bytes.byteLength;
			if (downloaded.bytes.byteLength > maxFileBytes || totalBytes > maxTotalBytes) throw rejected("ATTACHMENT_TOO_LARGE", "附件超过单文件或单次刷新总大小上限");
			downloads.push({ url, name: attachmentName(remote?.name || downloaded.filename), bytes: downloaded.bytes });
		}
		current(); writable();
		const files = original.files.map((file) => ({ ...file }));
		const runId = crypto.randomUUID(), directory = path.join(original.dir, "files");
		// Preserve local and legacy attachments. A matching platform URL updates only its reference.
		for (const [index, item] of downloads.entries()) {
			const record = { name: item.name, path: `files/refresh-${runId}-${index + 1}-${item.name}`, size: item.bytes.byteLength, source: "platform", url: item.url };
			const previous = files.findIndex((file) => file.source === "platform" && file.url === item.url);
			if (previous < 0) files.push(record); else files[previous] = record;
		}
		if (files.length > maxFiles) throw rejected("ATTACHMENT_LIMIT", "合并后附件超过题目上限，旧附件已保留");
		requireDirectory(original.dir);
		if (downloads.length) {
			try { fs.mkdirSync(directory, { mode: 0o700 }); }
			catch (error) { if (error.code !== "EEXIST") throw error; }
			requireDirectory(directory);
			for (const [index, item] of downloads.entries()) {
				const file = path.join(directory, `refresh-${runId}-${index + 1}-${item.name}`);
				const fd = fs.openSync(file, "wx", 0o600);
				try { fs.writeFileSync(fd, item.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			}
			syncDirectory(directory); syncDirectory(original.dir);
		}
		current();
		const saved = store.transact(id, (edit, draft) => {
			if (closed || fingerprint(draft) !== base) return failure("STALE_CHALLENGE_REFRESH", "题目已变化，未安装刷新结果");
			available(draft);
			edit.patch({ statement, files, category: String(detail.category || original.category || ""), target: detail.connectionInfo ? String(detail.connectionInfo) : original.target,
				...(typeof detail.hasContainer === "boolean" ? { hasContainer: detail.hasContainer } : {}),
				...(typeof detail.requiresTarget === "boolean" ? { requiresTarget: detail.requiresTarget } : {}) });
			projections.enqueue(edit, draft, { statement: true });
			edit.addEvent("note", `已从平台刷新题面（新增或更新 ${downloads.length} 个附件，题面文件等待同步）`);
		}, { durable: true });
		if (!saved.ok) return failure(saved.code, saved.error, { id, applied: saved.applied, persistence: saved.persistence });
		let projection;
		try { projection = projections.process(id, { force: true }); }
		catch { projection = { pending: true }; }
		return { ok: true, id, title: saved.challenge.title, files: downloads.length, statementLength: statement.length, projectionPending: projection.pending,
			...(projection.pending ? { warning: "题面状态已保存，statement.md 等待恢复同步" } : {}) };
	}
	return {
		async refresh(id, options) {
			// One staging buffer set at a time; other platform operations use their own queues.
			try { return await platforms.operations.exclusive("refresh:files", () => execute(id, options)); }
			catch (error) { return failure(error.code || "CHALLENGE_REFRESH_FAILED", String(error.message || error), { id, applied: false }); }
		},
		close() { closed = true; }
	};
}
