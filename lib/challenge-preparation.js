import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { challengeRevision, sameChallengeScope } from "./state-snapshot.js";
import { requireDirectory, requireOwnedDirectory, syncDirectory } from "./challenge-statement.js";

const PHASES = new Set(["preparing", "files_ready", "ready", "failed"]);
export function validatePreparation(value) {
	if (value == null) return;
	if (typeof value !== "object" || Array.isArray(value) || value.version !== 1 || typeof value.jobId !== "string" || !value.jobId || !PHASES.has(value.phase)
		|| !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.error != null && typeof value.error !== "string"
		|| value.directoryOwned != null && typeof value.directoryOwned !== "boolean"
		|| value.attemptId != null && (typeof value.attemptId !== "string" || !value.attemptId)
		|| value.inputKind != null && !["local", "platform"].includes(value.inputKind)
		|| value.inputs != null && (!Array.isArray(value.inputs) || value.inputs.length > 50 || value.inputs.some((entry) => typeof entry !== "string" || entry.length > 8192))
		|| [value.filesReadyAt, value.completedAt, value.failedAt, value.retriedAt].some((at) => at != null && (!Number.isFinite(at) || at < 0)))
		throw Object.assign(new Error("题目准备记录格式不受支持，原文件已保留"), { code: "PREPARATION_FORMAT_INVALID" });
}

export function createChallengePreparation({ store, projections }) {
	const active = new Map();
	let closed = false;
	const token = (ch) => ch.preparation?.attemptId || ch.preparation?.jobId;
	const fingerprint = (ch) => JSON.stringify([ch.title, ch.category, ch.statement, ch.target, ch.files, ch.hasContainer, ch.requiresTarget,
		ch.preparation?.inputKind, ch.preparation?.inputs]);
	const matches = (ch, current) => sameChallengeScope(ch, current) && current.preparation?.jobId === ch.preparation?.jobId && token(ch) === token(current);
	function release(ch) { if (active.get(ch.id)?.token === token(ch)) active.delete(ch.id); }
	function remember(ch) { active.set(ch.id, { token: token(ch), fingerprint: fingerprint(ch) }); return ch; }
	function savedOrThrow(result) {
		if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code, applied: result.applied, persistence: result.persistence });
	}
	function fail(ch, error) {
		if (active.has(ch.id) && active.get(ch.id).token !== token(ch)) return;
		release(ch);
		if (closed || !store.owns(ch) || !matches(ch, store.get(ch.id)) || store.persistenceStatus().dirty) return;
		return store.transact(ch.id, (edit, draft) => {
			if (!matches(ch, draft) || draft.preparation?.phase !== "preparing") return;
			edit.patch({ preparation: { ...draft.preparation, phase: "failed", error: String(error?.message || error).slice(0, 600), failedAt: Date.now() } });
			edit.setStatus("stopped", { note: "题目准备未完成，已暂停；请检查失败原因后显式重试输入准备" });
		}, { durable: true });
	}
	function begin(input, { inputKind = "local", inputs = [] } = {}) {
		if (closed) throw Object.assign(new Error("题目准备服务已关闭"), { code: "PREPARATION_CLOSED" });
		const ch = store.addChallenge({ ...input, initialStatus: "stopped", createDirectories: false,
			preparation: { version: 1, jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(), phase: "preparing", createdAt: Date.now(),
				inputKind, ...(inputKind === "local" ? { inputs } : {}) } });
		return remember(ch);
	}
	function resume(ch, { inputKind, inputs } = {}) {
		if (closed || !store.owns(ch) || !matches(ch, store.get(ch.id))) throw Object.assign(new Error("题目准备归属已变化"), { code: "STALE_PREPARATION" });
		if (active.has(ch.id)) throw Object.assign(new Error("本实例仍在准备该题输入，请等待当前操作结束"), { code: "PREPARATION_BUSY" });
		savedOrThrow(store.transact(ch.id, (edit, draft) => {
			if (draft.status !== "stopped" || !["failed", "preparing"].includes(draft.preparation?.phase) || draft.files?.length || draft.attempts?.length || draft.flags?.length || draft.localProjection?.pending)
				return { ok: false, code: "PREPARATION_NOT_RETRYABLE", error: "只允许恢复尚未确认输入、没有执行或验证记录的停止题目" };
			edit.patch({ preparation: { ...draft.preparation, attemptId: crypto.randomUUID(), phase: "preparing", retriedAt: Date.now(), error: "",
				inputKind: inputKind || draft.preparation.inputKind, ...(inputs == null ? {} : { inputs }) } });
			edit.addEvent("note", "显式重试输入准备；完成后保持停止，等待显式开始");
		}, { durable: true, expectedRevision: challengeRevision(ch) }));
		return remember(store.get(ch.id));
	}
	function complete(ch, files, patch = {}) {
		try {
			const owned = check(ch);
			if (owned.preparation.directoryOwned !== true) throw Object.assign(new Error("题目目录尚未确认归属"), { code: "PREPARATION_DIRECTORY_UNKNOWN" });
			const saved = store.transact(ch.id, (edit, draft) => {
				if (!matches(ch, draft) || draft.preparation.phase !== "preparing") return { ok: false, code: "STALE_PREPARATION", error: "题目准备记录已变化" };
				edit.patch({ ...patch, files, preparation: { ...draft.preparation, phase: "files_ready", filesReadyAt: Date.now(), error: "" } });
				projections.enqueue(edit, draft, { statement: true, notes: true });
				edit.addEvent("note", "附件已准备，题面和笔记文件等待同步");
			}, { durable: true });
			savedOrThrow(saved);
			projections.process(ch.id, { force: true });
			const current = store.get(ch.id);
			if (current?.preparation?.phase !== "ready" || store.persistenceStatus().dirty) throw Object.assign(new Error("题目状态已保存，输入文件尚未完成同步；请重试本地同步，完成后显式开始"), { code: "CHALLENGE_PREPARATION_PENDING", applied: true });
			return current;
		} finally { release(ch); }
	}
	function claimDirectory(ch, { reuse = false } = {}) {
		check(ch); requireDirectory(ch.dir);
		if (reuse) requireOwnedDirectory({ ...ch, preparation: { ...ch.preparation, directoryOwned: true } });
		else {
			const fd = fs.openSync(path.join(ch.dir, ".ctf-owner.json"), "wx", 0o600);
			try { fs.writeFileSync(fd, JSON.stringify({ version: 1, id: ch.id, jobId: ch.preparation.jobId }) + "\n"); fs.fsyncSync(fd); }
			finally { fs.closeSync(fd); }
		}
		for (const sub of ["files", "scripts", "artifacts"]) {
			const dir = path.join(ch.dir, sub);
			try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
			requireDirectory(dir);
		}
		syncDirectory(ch.dir); syncDirectory(path.dirname(ch.dir));
		const result = store.transact(ch.id, (edit, draft) => {
			if (!matches(ch, draft) || draft.preparation.phase !== "preparing") return { ok: false, code: "STALE_PREPARATION", error: "目录归属记录已变化" };
			edit.patch({ preparation: { ...draft.preparation, directoryOwned: true } });
		}, { durable: true });
		savedOrThrow(result);
	}
	function ensureDirectory(ch) {
		const current = check(ch);
		if (current.preparation.directoryOwned === true) return;
		let exists = false;
		try { fs.lstatSync(ch.dir); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (!exists) {
			fs.mkdirSync(path.dirname(ch.dir), { recursive: true, mode: 0o700 });
			fs.mkdirSync(ch.dir, { mode: 0o700 });
		}
		// An interrupted ownership checkpoint may be resumed only with its original marker.
		claimDirectory(ch, { reuse: exists });
	}
	function check(ch) {
		const current = store.get(ch.id);
		const actor = active.get(ch.id);
		if (closed || !actor || actor.token !== token(ch) || !store.owns(ch) || !matches(ch, current) || current.status !== "stopped"
			|| current.preparation?.phase !== "preparing" || actor.fingerprint !== fingerprint(current))
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
			fail(ch, new Error("准备过程在输入确认前中断；没有自动重新读取外部附件或下载，请显式重试输入准备"));
			if (++count >= limit || store.persistenceStatus().dirty) break;
		}
	}
	return { begin, resume, complete, ensureDirectory, claimDirectory, check, fail, recover, isActive: (id) => active.has(id), close() { closed = true; active.clear(); } };
}
