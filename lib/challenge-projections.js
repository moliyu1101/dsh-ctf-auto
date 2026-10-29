import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { synchronizeStatement, synchronizeNotes, syncDirectory, requireOwnedDirectory } from "./challenge-statement.js";
function synchronizeFlag(challenge) {
	if (challenge.preparation) requireOwnedDirectory(challenge);
	const flags = challenge.flags.filter((flag) => flag.verified);
	const flag = flags.filter((item) => item.method === "platform").at(-1) || flags.at(-1);
	const file = path.join(challenge.dir, "flag.json");
	if (!flag) {
		try { fs.unlinkSync(file); syncDirectory(challenge.dir); }
		catch (error) { if (error?.code !== "ENOENT") throw error; }
		return;
	}
	const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		const fd = fs.openSync(temporary, "wx", 0o600);
		try {
			fs.writeFileSync(fd, JSON.stringify({ flag: flag.value, evidence: flag.evidence, method: flag.method, verified: true,
				at: new Date(flag.recordedAt || Date.now()).toISOString() }, null, 2) + "\n", "utf8");
			fs.fsyncSync(fd);
		} finally { fs.closeSync(fd); }
		fs.renameSync(temporary, file); syncDirectory(challenge.dir);
	} finally { try { fs.rmSync(temporary, { force: true }); } catch { /* preserve primary error */ } }
}

export function createChallengeProjections({ store, learning, onChanged = () => {} }) {
	let closed = false;
	function enqueue(edit, draft, { invalidateMemory = false, statement = false, notes = false } = {}) {
		const previous = draft.localProjection;
		const invalidate = invalidateMemory || !previous && draft.review?.status === "rejected" || previous?.pending && previous.invalidateMemory;
		edit.patch({ localProjection: { jobId: crypto.randomUUID(), pending: true,
			flagPending: !statement || !previous && draft.review?.status === "rejected" || previous?.pending === true && previous.flagPending !== false,
			statementPending: statement || previous?.pending === true && previous.statementPending === true,
			notesPending: notes || previous?.pending === true && previous.notesPending === true,
			invalidateMemory: !!invalidate, memoryPaths: invalidate ? [...new Set([...(previous?.memoryPaths || []), ...learning.memoryLocations()])] : [],
			attempts: 0, nextAttemptAt: 0, createdAt: Date.now(), errors: [] } });
	}
	function process(id, { force = false } = {}) {
		if (closed) return { ok: false, pending: true, code: "PROJECTIONS_CLOSED" };
		const ch = store.read(id)?.challenge, job = ch?.localProjection;
		if (!job?.pending) return { ok: true, pending: false };
		if (store.persistenceStatus().dirty) return { ok: false, pending: true, code: "STATE_NOT_DURABLE", error: "状态尚未保存，文件同步暂缓" };
		const writable = store.checkWritable();
		if (!writable.ok) return { ok: false, pending: true, code: writable.code, error: writable.error };
		if (!force && Number(job.nextAttemptAt) > Date.now()) return { ok: false, pending: true, code: "PROJECTION_BACKOFF" };
		const errors = [], failedPaths = [];
		let flagPending = job.flagPending === true;
		let statementPending = job.statementPending === true;
		let notesPending = job.notesPending === true;
		if (notesPending) {
			try { synchronizeNotes(ch); notesPending = false; }
			catch (error) { errors.push({ target: "notes.md", code: String(error.code || "NOTES_SYNC_FAILED"), message: String(error.message || error).slice(0, 500) }); }
		}
		if (statementPending) {
			try { synchronizeStatement(ch); statementPending = false; }
			catch (error) { errors.push({ target: "statement.md", code: String(error.code || "STATEMENT_SYNC_FAILED"), message: String(error.message || error).slice(0, 500) }); }
		}
		if (flagPending) {
			try { synchronizeFlag(ch); flagPending = false; }
			catch (error) { errors.push({ target: "flag.json", code: String(error.code || "FLAG_SYNC_FAILED"), message: String(error.message || error).slice(0, 500) }); }
		}
		if (job.invalidateMemory) {
			const paths = [...new Set([...(job.memoryPaths || []), ...learning.memoryLocations()])];
			for (const file of paths) {
				try { learning.removeSource(file, ch.id); }
				catch (error) { failedPaths.push(file); errors.push({ target: file, code: String(error.code || "MEMORY_SYNC_FAILED"), message: String(error.message || error).slice(0, 500) }); }
			}
		}
		const pending = flagPending || statementPending || notesPending || failedPaths.length > 0;
		const attempts = pending ? (Number(job.attempts) || 0) + 1 : Number(job.attempts) || 0;
		const saved = store.transact(id, (edit, draft) => {
			if (draft.localProjection?.jobId !== job.jobId) return { ok: false, code: "STALE_PROJECTION", error: "文件同步任务已更新" };
			edit.patch({ localProjection: { ...job, pending, flagPending, statementPending, notesPending, memoryPaths: failedPaths, attempts, errors,
				nextAttemptAt: pending ? Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)) : 0,
				...(pending ? {} : { completedAt: Date.now(), invalidateMemory: false }) } });
			if (!statementPending && !notesPending && draft.preparation?.phase === "files_ready") {
				edit.patch({ preparation: { ...draft.preparation, phase: "ready", completedAt: Date.now(), error: "" } });
				edit.setStatus("stopped", { note: "题目输入准备完成，等待显式开始" });
			}
			if (pending && !job.attempts) edit.addEvent("error", "本地文件同步未完成，已保留恢复任务");
			if (!pending && job.attempts) edit.addEvent("note", "本地文件已恢复同步");
		}, { durable: true });
		try { onChanged(); } catch { console.warn("[dsh-ctf-auto] local projection observer failed"); }
		return { ok: saved.ok && !pending, pending: pending || !saved.ok, ...(errors.length ? { errors } : {}),
			...(!saved.ok ? { code: saved.code, error: saved.error } : pending ? { code: "LOCAL_PROJECTION_PENDING", error: "状态已保存，本地文件待恢复同步" } : {}) };
	}
	function recover({ limit = 5 } = {}) {
		if (closed || store.persistenceStatus().dirty) return;
		let count = 0;
		for (let ch of store.list()) {
			if (!ch.localProjection && ch.review?.status === "rejected") {
				const queued = store.transact(ch.id, (edit, draft) => enqueue(edit, draft, { invalidateMemory: true }), { durable: true });
				if (!queued.ok) break;
				ch = store.get(ch.id);
			}
			if (!ch.localProjection?.pending || Number(ch.localProjection.nextAttemptAt) > Date.now()) continue;
			process(ch.id);
			if (++count >= limit || store.persistenceStatus().dirty) break;
		}
	}
	return { enqueue, process, recover, close() { closed = true; } };
}
