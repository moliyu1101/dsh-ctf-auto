import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireFileLock } from "./file-lock.js";

const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");

// Synchronous JSON repository: missing is a valid state; unreadable/invalid is not.
export function createJsonRepository({ file, label, empty, normalize }) {
	const target = path.resolve(file);
	let readError = null, writeError = null, lastReadAt = null, lastWrittenAt = null;
	function problem(code, message, cause) {
		return Object.assign(new Error(`${label}：${message}（${target}）`), { code, causeCode: cause?.code || null });
	}
	function inspect() {
		try {
			let stat;
			try { stat = fs.lstatSync(target); }
			catch (error) { if (error?.code === "ENOENT") return { value: empty(), revision: "missing", missing: true }; throw error; }
			if (!stat.isFile() || stat.isSymbolicLink()) throw problem("JSON_FILE_TYPE", "路径不是普通文件，原文件已保留");
			const text = fs.readFileSync(target, "utf8");
			let raw;
			try { raw = JSON.parse(text); } catch (error) { throw problem("JSON_INVALID", "JSON 损坏，原文件已保留", error); }
			let value;
			try { value = normalize(raw); } catch (error) { throw problem(error?.code || "JSON_SCHEMA_INVALID", error?.message || "格式不受支持，原文件已保留", error); }
			return { value, revision: digest(text), missing: false };
		} catch (error) { throw error?.causeCode !== undefined ? error : problem("JSON_READ_FAILED", "读取失败，拒绝将故障视为空库", error); }
	}
	function read() {
		try { const snapshot = inspect(); readError = null; lastReadAt = Date.now(); return snapshot; }
		catch (error) { readError = { code: error.code, causeCode: error.causeCode, message: error.message, at: Date.now() }; throw error; }
	}
	function commit(value, expectedRevision) {
		let temporary = "", installed = false;
		let writer = null;
		try {
			writer = acquireFileLock(target, { label });
			const normalized = normalize(structuredClone(value));
			const text = JSON.stringify(normalized, null, 2) + "\n";
			if (read().revision !== expectedRevision) throw problem("JSON_CONFLICT", "文件已变化，请重新读取后操作");
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
			const fd = fs.openSync(temporary, "wx", 0o600);
			try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			if (read().revision !== expectedRevision) throw problem("JSON_CONFLICT", "保存前文件已变化，未覆盖新内容");
			writer.assertOwned();
			if (expectedRevision === "missing") { fs.linkSync(temporary, target); installed = true; fs.unlinkSync(temporary); }
			else { fs.renameSync(temporary, target); installed = true; }
			temporary = "";
			if (process.platform !== "win32") {
				const dirFd = fs.openSync(path.dirname(target), "r");
				try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
			}
			writer.release(); writer = null;
			writeError = null; lastWrittenAt = Date.now();
			return { value: normalized, revision: digest(text) };
		} catch (error) {
			const failure = error?.causeCode !== undefined ? error : problem(error?.code?.startsWith("FILE_LOCK") ? error.code : "JSON_WRITE_FAILED", error?.code?.startsWith("FILE_LOCK") ? error.message : "保存失败，请检查存储状态后重试", error);
			failure.applied = installed;
			writeError = { code: failure.code, causeCode: failure.causeCode, message: failure.message, at: Date.now(), applied: installed };
			throw failure;
		} finally {
			if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch { /* preserve primary error */ } }
			if (writer) { try { writer.release(); } catch (error) { writeError = { code: error.code || "FILE_UNLOCK_FAILED", message: String(error.message || error), at: Date.now(), applied: installed }; } }
		}
	}
	function update(operation, { requireExisting = false } = {}) {
		const snapshot = read(), draft = structuredClone(snapshot.value);
		if (requireExisting && snapshot.missing) throw problem("JSON_FILE_MISSING", "待更新的文件已不存在，请恢复原文件后重试");
		const result = operation(draft);
		if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); throw problem("ASYNC_JSON_UPDATE", "更新必须是同步操作"); }
		// A previous rename may have succeeded before fsync failed. Replay must
		// retry durable installation even when the receipt is already visible.
		if (isDeepStrictEqual(snapshot.value, draft) && !writeError) return { changed: false, value: draft, result };
		return { ...commit(draft, snapshot.revision), changed: true, result };
	}
	return { file: target, read, update, commit, status: () => ({ file: target, readError, writeError, lastReadAt, lastWrittenAt }) };
}
