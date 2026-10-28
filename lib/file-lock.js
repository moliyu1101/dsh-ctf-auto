import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const activeLocks = new Set();
process.once("exit", () => { for (const lock of activeLocks) { try { lock.release(); } catch { /* process is exiting */ } } });

// Resolve directory aliases without creating directories for read-only callers.
export function canonicalFilePath(file) {
	const resolved = path.resolve(file);
	let parent = path.dirname(resolved);
	const suffix = [path.basename(resolved)];
	for (;;) {
		try { return path.join(fs.realpathSync(parent), ...suffix); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			const next = path.dirname(parent);
			if (next === parent) throw error;
			suffix.unshift(path.basename(parent)); parent = next;
		}
	}
}

function ownerOf(file) {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
		return { pid: value.pid, hostname: String(value.hostname || "").replace(/[\r\n\t]/g, "").slice(0, 200), createdAt: value.createdAt };
	} catch { return null; }
}

// Cooperative exclusive lock. No TTL stealing: a paused owner remains a writer.
// A crash may leave the lock behind; recovery requires confirming all owners stopped.
export function acquireFileLock(file, { label = "数据文件" } = {}) {
	const target = canonicalFilePath(file), lockPath = `${target}.lock`;
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	let fd;
	try { fd = fs.openSync(lockPath, "wx", 0o600); }
	catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = ownerOf(lockPath);
		throw Object.assign(new Error(`${label}已有写入锁${owner ? `（${owner.hostname}，PID ${owner.pid}）` : "（持有者信息不可读）"}。请先停止占用实例；若实例已退出，确认没有写入者后再清理 ${lockPath}`),
			{ code: "FILE_LOCKED", lockPath, owner });
	}
	let identity;
	try { identity = fs.fstatSync(fd, { bigint: true }); }
	catch (error) { fs.closeSync(fd); throw error; }
	let closed = false;
	let lock;
	function assertOwned() {
		let current;
		try { if (!closed) current = fs.lstatSync(lockPath, { bigint: true }); } catch { /* ownership lost */ }
		if (closed || !current?.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
			throw Object.assign(new Error(`${label}写入锁已失效，已停止保存；请停止旧实例后重新加载`), { code: "FILE_LOCK_LOST", lockPath });
	}
	function release() {
		if (closed) return;
		try { assertOwned(); fs.unlinkSync(lockPath); }
		catch (error) {
			if (error.code === "FILE_LOCK_LOST") throw error;
			throw Object.assign(new Error(`${label}写入锁释放失败，请检查 ${lockPath}：${error.message || error}`), { code: "FILE_LOCK_RELEASE_FAILED", lockPath, cause: error });
		}
		finally { closed = true; activeLocks.delete(lock); fs.closeSync(fd); }
	}
	try {
		fs.writeFileSync(fd, JSON.stringify({ version: 1, token: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), createdAt: Date.now() }) + "\n", "utf8");
		fs.fsyncSync(fd);
	} catch (error) { try { release(); } catch { /* preserve original failure */ } throw error; }
	lock = { file: target, lockPath, assertOwned, release };
	activeLocks.add(lock);
	return lock;
}
