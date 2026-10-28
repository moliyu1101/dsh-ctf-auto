import crypto from "node:crypto";
import { platformChallengeKey } from "./platform-identity.js";

// Submission state belongs here; adapters only translate protocol requests/results.
export function createPlatformSubmissions({ store, platforms, recordFlag, needsReview, autoSubmitEnabled, canAutoSubmit = () => true }) {
	const active = new Map(), queued = new Map(), solved = new Map(), pending = new Map();
	let closed = false;
	function remembered(key) {
		const at = solved.get(key);
		if (at && Date.now() - at < 5 * 60 * 1000) return true;
		solved.delete(key);
		return false;
	}
	function remember(key) {
		solved.set(key, Date.now());
		while (solved.size > 1000) solved.delete(solved.keys().next().value);
	}
	function persistResult(ch, flag, submissionId, result) {
		store.update(ch.id, { platformSubmit: {
			submissionId, status: result.status || "error", flag,
			message: String(result.message || result.error || ""), verified: result.verified === true,
			code: result.code || null, outcomeUnknown: result.outcomeUnknown === true, at: Date.now()
		} });
		return { ...result, submissionId };
	}
	async function execute(ch, flag, connection, options) {
		if (closed || store.get(ch.id) !== ch) return { ok: false, code: "SUBMISSION_CANCELLED", error: "提交已取消或题目已移除" };
		if (!options.manual && (!autoSubmitEnabled() || needsReview(ch) || !canAutoSubmit(ch, flag))) return { ok: false, code: "SUBMISSION_PAUSED", error: "自动提交已暂停或仍需复核" };
		const submissionId = crypto.randomUUID();
		const key = `${connection.sessionKey}:${platformChallengeKey(ch.platform)}`;
		store.update(ch.id, { platformSubmit: { submissionId, status: "pending", flag, at: Date.now() } });
		if (store.persistenceStatus().dirty) return persistResult(ch, flag, submissionId, { ok: false, code: "STATE_NOT_DURABLE", error: "提交记录尚未保存，未向平台发送请求" });
		try {
			let result;
			if (!options.manual) {
				if (remembered(key)) result = { ok: true, status: "already_solved", message: "skipped: platform already solved", skipped: true, verified: false };
				else {
					const detail = await connection.client.getChallenge(ch.platform.challengeId, ch.platform);
					if (detail.ok && detail.data?.solvedByMe) result = { ok: true, status: "already_solved", message: "skipped: platform is_solved", skipped: true, verified: false };
				}
			}
			if (closed || store.get(ch.id) !== ch) return { ok: false, code: "SUBMISSION_CANCELLED", error: "提交已取消或题目已移除" };
			if (!result) {
				if (!options.manual && !canAutoSubmit(ch, flag)) return persistResult(ch, flag, submissionId, { ok: false, code: "SUBMISSION_PAUSED", error: "候选或复核状态已变化，未发送提交" });
				const response = await connection.client.submit(ch.platform.challengeId, flag, ch.platform);
				if (!response.ok) result = { ok: false, error: response.error || "平台提交失败", code: response.code, httpStatus: response.httpStatus || response.status, outcomeUnknown: ["network", "timeout"].includes(response.code) || Number(response.httpStatus || response.status) >= 500 };
				else {
					const status = String(response.data?.status || response.status || "unknown");
					result = { ok: status === "correct" || status === "already_solved", status,
						message: String(response.data?.message || response.message || ""), verified: status === "correct" };
				}
			}
			// An unloaded instance must not overwrite state belonging to its replacement.
			if (closed || store.get(ch.id) !== ch) return { ...result, submissionId, recorded: false };
			if (result.status === "correct" || result.status === "already_solved") remember(key);
			if (result.verified) {
				recordFlag({ id: ch.id, flag, verified: true, evidence: `平台提交回显：correct ${result.message || ""}`.trim(), method: "platform" }, { allowPlatformVerification: true, suppressAutoSubmit: true });
			} else if (result.status === "already_solved") {
				recordFlag({ id: ch.id, flag, verified: false, evidence: "平台回显 already_solved（题目已解；本 flag 未经回显确认）", method: "platform" }, { suppressAutoSubmit: true });
				store.setStatus(ch.id, "solved", { stuckReason: "", endedAt: Date.now(), note: "平台已解（flag 未经回显确认）" });
			}
			store.addEvent(ch.id, result.ok ? "flag" : "note", `平台提交（${result.status || result.code || "error"}）：${result.message || result.error || ""}`.slice(0, 400));
			return persistResult(ch, flag, submissionId, result);
		} catch (error) {
			if (closed || store.get(ch.id) !== ch) return { ok: false, code: "SUBMISSION_CANCELLED", error: "提交服务已关闭或题目已移除", recorded: false };
			return persistResult(ch, flag, submissionId, { ok: false, code: error?.code || "PLATFORM_REQUEST_FAILED", error: String(error?.message || error) });
		}
	}
	async function submit(payload, options = {}) {
		if (closed) return { ok: false, error: "平台提交服务已关闭", code: "PLATFORM_CLOSED" };
		const ch = store.get(String(payload.id ?? "")), flag = String(payload.flag ?? "").trim();
		if (!ch) return { ok: false, error: "题目不存在" };
		if (!flag) return { ok: false, error: "flag 不能为空" };
		if (!ch.platform?.challengeId) return { ok: false, error: "该题没有平台信息，无法提交（需从平台导入的题目）" };
		let connection;
		try { connection = platforms.forChallenge(ch); }
		catch (error) { return persistResult(ch, flag, crypto.randomUUID(), { ok: false, code: "PLATFORM_CONFIG_INVALID", error: String(error?.message || error) }); }
		if (!connection.client) return persistResult(ch, flag, crypto.randomUUID(), { ok: false, error: connection.error, code: connection.code });
		const resource = `submission:${connection.sessionKey}:${platformChallengeKey(ch.platform)}`;
		const valueKey = crypto.createHash("sha256").update(flag).digest("hex");
		const operation = `${resource}:${ch.id}:${options.manual === true}:${valueKey}`;
		pending.set(ch.id, (pending.get(ch.id) || 0) + 1);
		try {
			return await platforms.operations.coalesced(resource, operation, () => execute(ch, flag, connection, options));
		} catch (error) { return { ok: false, code: error?.code || "PLATFORM_REQUEST_FAILED", error: String(error?.message || error) }; }
		finally {
			const remaining = (pending.get(ch.id) || 1) - 1;
			if (remaining) pending.set(ch.id, remaining); else pending.delete(ch.id);
		}
	}
	function automatic(id, flag) {
		const ch = store.get(String(id || ""));
		if (closed || !ch?.platform || !flag || !autoSubmitEnabled() || needsReview(ch) || !canAutoSubmit(ch, flag)) return Promise.resolve();
		if ((ch.flags || []).some((f) => f?.value === flag && f.verified && f.method === "platform")) return Promise.resolve();
		if (active.has(ch.id)) { queued.set(ch.id, flag); return active.get(ch.id); }
		if (ch.platformSubmit?.flag === flag && ["correct", "already_solved"].includes(ch.platformSubmit.status)) return Promise.resolve();
		const job = Promise.resolve().then(() => submit({ id: ch.id, flag })).catch((error) => {
			if (!closed && store.get(ch.id)) store.addEvent(ch.id, "error", "自动提交异常：" + String(error?.message || error).slice(0, 200));
			return { ok: false, code: "PLATFORM_REQUEST_FAILED", error: String(error?.message || error) };
		}).finally(() => {
			active.delete(ch.id);
			const next = queued.get(ch.id);
			queued.delete(ch.id);
			if (next && next !== flag && !closed) void automatic(ch.id, next);
		});
		active.set(ch.id, job);
		return job;
	}
	return { submit, automatic, isActive: (id) => active.has(id) || pending.has(id), close() { closed = true; queued.clear(); solved.clear(); } };
}
