import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sameChallengeScope } from "./state-snapshot.js";
import { requireDirectory, requireOwnedDirectory, syncDirectory } from "./challenge-statement.js";

const PHASES = new Set(["preparing", "files_ready", "ready", "failed"]);
export function validatePreparation(value) {
	if (value == null) return;
	if (typeof value !== "object" || Array.isArray(value) || value.version !== 1 || typeof value.jobId !== "string" || !value.jobId || !PHASES.has(value.phase)
		|| !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.error != null && typeof value.error !== "string"
		|| value.directoryOwned != null && typeof value.directoryOwned !== "boolean"
		|| [value.filesReadyAt, value.completedAt, value.failedAt].some((at) => at != null && (!Number.isFinite(at) || at < 0)))
		throw Object.assign(new Error("题目准备记录格式不受支持，原文件已保留"), { code: "PREPARATION_FORMAT_INVALID" });
}

export function createChallengePreparation({ store, projections }) {
	const active = new Set();
	let closed = false;
	function fail(ch, error) {
		active.delete(ch.id);
		if (closed || !store.owns(ch) || !sameChallengeScope(ch, store.get(ch.id)) || store.persistenceStatus().dirty) return;
		return store.transact(ch.id, (edit, draft) => {
			if (draft.preparation?.jobId !== ch.preparation?.jobId || draft.preparation?.phase !== "preparing") return;
			edit.patch({ preparation: { ...draft.preparation, phase: "failed", error: String(error?.message || error).slice(0, 600), failedAt: Date.now() } });
			edit.setStatus("stopped", { note: "题目准备未完成，已暂停；请检查失败原因，移除后重新创建或导入" });
		}, { durable: true });
	}
	function begin(input) {
		if (closed) throw Object.assign(new Error("题目准备服务已关闭"), { code: "PREPARATION_CLOSED" });
		const ch = store.addChallenge({ ...input, initialStatus: "stopped", createDirectories: false,
			preparation: { version: 1, jobId: crypto.randomUUID(), phase: "preparing", createdAt: Date.now() } });
		active.add(ch.id);
		return ch;
	}
	function complete(ch, files) {
		try {
			const owned = check(ch);
			if (owned.preparation.directoryOwned !== true) throw Object.assign(new Error("题目目录尚未确认归属"), { code: "PREPARATION_DIRECTORY_UNKNOWN" });
			const saved = store.transact(ch.id, (edit, draft) => {
				if (draft.preparation?.jobId !== ch.preparation.jobId || draft.preparation.phase !== "preparing") return { ok: false, code: "STALE_PREPARATION", error: "题目准备记录已变化" };
				edit.patch({ files, preparation: { ...draft.preparation, phase: "files_ready", filesReadyAt: Date.now(), error: "" } });
				projections.enqueue(edit, draft, { statement: true, notes: true });
				edit.addEvent("note", "附件已准备，题面和笔记文件等待同步");
			}, { durable: true });
			if (!saved.ok) throw Object.assign(new Error(saved.error), { code: saved.code, applied: saved.applied, persistence: saved.persistence });
			projections.process(ch.id, { force: true });
			const current = store.get(ch.id);
			if (current?.preparation?.phase !== "ready" || store.persistenceStatus().dirty) throw Object.assign(new Error("题目状态已保存，输入文件尚未完成同步；请重试本地同步，完成后显式开始"), { code: "CHALLENGE_PREPARATION_PENDING", applied: true });
			return current;
		} finally { active.delete(ch.id); }
	}
	function claimDirectory(ch) {
		check(ch); requireDirectory(ch.dir);
		const fd = fs.openSync(path.join(ch.dir, ".ctf-owner.json"), "wx", 0o600);
		try { fs.writeFileSync(fd, JSON.stringify({ version: 1, id: ch.id, jobId: ch.preparation.jobId }) + "\n"); fs.fsyncSync(fd); }
		finally { fs.closeSync(fd); }
		syncDirectory(ch.dir); syncDirectory(path.dirname(ch.dir));
		const result = store.transact(ch.id, (edit, draft) => {
			if (draft.preparation?.jobId !== ch.preparation.jobId || draft.preparation.phase !== "preparing") return { ok: false, code: "STALE_PREPARATION", error: "目录归属记录已变化" };
			edit.patch({ preparation: { ...draft.preparation, directoryOwned: true } });
		}, { durable: true });
		if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code, applied: result.applied });
	}
	function check(ch) {
		const current = store.get(ch.id);
		if (closed || !active.has(ch.id) || !store.owns(ch) || !sameChallengeScope(ch, current) || current.status !== "stopped"
			|| current.preparation?.jobId !== ch.preparation?.jobId || current.preparation?.phase !== "preparing")
			throw Object.assign(new Error("题目归属或准备状态已变化，已停止旧准备过程"), { code: "STALE_PREPARATION" });
		const writable = store.checkWritable();
		if (!writable.ok || store.persistenceStatus().dirty) throw Object.assign(new Error(writable.error || "状态未保存，已暂停输入准备"), { code: writable.code || "STATE_NOT_DURABLE" });
		if (current.preparation.directoryOwned === true) {
			requireOwnedDirectory(current);
			requireDirectory(path.join(current.dir, "files"));
		}
		let statementExists = false;
		try { fs.lstatSync(path.join(ch.dir, "statement.md")); statementExists = true; }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		if (statementExists) throw Object.assign(new Error("准备期间题面文件被另行写入，已停止旧准备过程并保留文件"), { code: "PREPARATION_INPUT_CHANGED" });
		return current;
	}
	function recover({ limit = 20 } = {}) {
		if (closed || store.persistenceStatus().dirty) return;
		let count = 0;
		for (const ch of store.list()) {
			if (ch.preparation?.phase !== "preparing" || active.has(ch.id)) continue;
			fail(ch, new Error("准备过程在输入确认前中断；没有自动重新读取外部附件或重新下载，请移除后重新创建/导入"));
			if (++count >= limit || store.persistenceStatus().dirty) break;
		}
	}
	return { begin, complete, claimDirectory, check, fail, recover, isActive: (id) => active.has(id), close() { closed = true; active.clear(); } };
}
