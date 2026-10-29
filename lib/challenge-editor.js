// In-memory challenge edits shared by legacy store methods and detached transactions.
// This module performs no persistence, file access, network requests or host calls.
import { classifyFactKind } from "./blackboard.js";

export const EVENTS_LIMIT = 300;
export const OUTPUT_TAIL_LIMIT = 4000;
export const FACTS_LIMIT = 120;
export const FAILED_PATHS_LIMIT = 30;
export const FLAGS_LIMIT = 100;
export const CHALLENGE_STATUSES = [
	"queued",
	"running",
	"solved",
	"stuck",
	"failed",
	"stopped",
];
export const TERMINAL_STATUSES = ["solved", "stuck", "failed", "stopped"];

const STATUS_EVENT_KIND = {
	queued: "queued",
	running: "started",
	solved: "flag",
	stuck: "stuck",
	failed: "error",
	stopped: "stopped",
};

const STATUS_EVENT_TEXT = {
	queued: "题目已重新入队，等待调度",
	running: "题目开始运行",
	solved: "题目已解出",
	stuck: "未能解出，标记为 stuck",
	failed: "题目执行失败",
	stopped: "题目已停止",
};

function isPlainObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }

function oneLine(text, max = 300) {
	const value = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** failedPaths：字符串数组，去重，≤30 条。 */
export function normalizeFailedPaths(value, limit = FAILED_PATHS_LIMIT) {
	const out = [];
	if (!Array.isArray(value)) return out;
	for (const item of value) {
		const text = oneLine(item, 300);
		if (!text || out.includes(text)) continue;
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

export function makeChallengeEvent(kind, text, data, now = Date.now) {
	const event = { at: now(), kind: String(kind || "note"), text: String(text ?? "") };
	if (isPlainObject(data)) {
		const extra = { ...data };
		if (extra.attempt != null) {
			event.attempt = Number(extra.attempt);
			delete extra.attempt;
		}
		if (Object.keys(extra).length > 0) event.data = extra;
	}
	return event;
}

export function createChallengeEditor(challenge, { now = Date.now } = {}) {
	function addEvent(kind, text, data) {
		const event = makeChallengeEvent(kind, text, data, now);
		challenge.events.push(event);
		if (challenge.events.length > EVENTS_LIMIT) {
			challenge.events.splice(0, challenge.events.length - EVENTS_LIMIT);
		}
		return event;
	}

	function addFlag(input = {}) {
		const payload = isPlainObject(input) ? input : {};
		const value = typeof payload.value === "string" ? payload.value.trim() : "";
		if (!value) return undefined;
		let flag = challenge.flags.find((item) => item && item.value === value);
		if (!flag) {
			if (challenge.flags.length >= FLAGS_LIMIT) return undefined;
			flag = {
				value,
				verified: false,
				evidence: "",
				method: "manual",
				recordedAt: now(),
				attempt: null,
			};
			challenge.flags.push(flag);
		}
		// Candidate updates and local claims cannot overwrite stronger existing proof.
		const preserveProof = flag.verified === true && (payload.verified !== true || (flag.method === "platform" && payload.method !== "platform"));
		if (typeof payload.verified === "boolean") {
			if (!(flag.verified === true && payload.verified === false)) flag.verified = payload.verified;
		}
		if (!preserveProof) {
			if (payload.evidence != null) flag.evidence = String(payload.evidence);
			if (payload.method != null) flag.method = String(payload.method);
			if (payload.attempt != null) flag.attempt = Number(payload.attempt);
		}
		if (typeof flag.recordedAt !== "number") flag.recordedAt = now();
		if (flag.verified) {
			challenge.status = "solved";
			challenge.stuckReason = "";
		}
		addEvent(
			"flag",
			flag.verified
				? `已记录并验证 flag：${value}`
				: `记录候选 flag（未验证）：${value}`,
			flag.attempt == null ? undefined : { attempt: flag.attempt },
		);
		return flag;
	}

	function addFact(input = {}) {
		const payload = isPlainObject(input) ? input : {};
		const text = typeof payload.text === "string" ? payload.text.trim() : "";
		if (!text) return undefined;
		const fact = {
			at: now(),
			text,
			kind: typeof payload.kind === "string" && payload.kind ? payload.kind : classifyFactKind(text),
			source: typeof payload.source === "string" ? payload.source : "",
			attempt: payload.attempt == null ? null : Number(payload.attempt),
		};
		const tagMatch = /^\[([^\]]+)\]/.exec(text);
		let existing = challenge.facts.find((item) => item && item.text === text);
		// 「同前缀去重」：同一 attempt 内相同 [标签] 的 fact 视为重复，保留最新内容。
		if (!existing && tagMatch) {
			existing = challenge.facts.find((item) => {
				if (!item || item.attempt !== fact.attempt) return false;
				const itemTag = /^\[([^\]]+)\]/.exec(item.text || "");
				return !!itemTag && itemTag[1] === tagMatch[1];
			});
		}
		if (existing) {
			existing.at = fact.at;
			existing.text = fact.text;
			existing.source = fact.source;
			existing.attempt = fact.attempt;
			return existing;
		}
		challenge.facts.push(fact);
		if (challenge.facts.length > FACTS_LIMIT) {
			challenge.facts.splice(0, challenge.facts.length - FACTS_LIMIT);
		}
		return fact;
	}

	function removeFlag(value) {
		const target = String(value || "").trim();
		if (!target) return false;
		const before = challenge.flags.length;
		challenge.flags = challenge.flags.filter((item) => !(item && item.value === target));
		if (challenge.flags.length === before) return false;
		addEvent("note", `移除候选 flag：${target}`);
		return true;
	}

	function setStatus(status, extra = {}) {
		if (!CHALLENGE_STATUSES.includes(status)) return undefined;
		const payload = isPlainObject(extra) ? extra : {};
		const { note, attempt: attemptRef, ...rest } = payload;
		const patch = { ...rest, status };
		if (status === "running") {
			if (typeof challenge.startedAt !== "number") patch.startedAt = now();
			patch.endedAt = null;
		}
		if (
			TERMINAL_STATUSES.includes(status) &&
			!Object.prototype.hasOwnProperty.call(patch, "endedAt")
		) {
			if (typeof challenge.endedAt !== "number") patch.endedAt = now();
		}
		if (status === "solved") patch.stuckReason = "";
		for (const [key, value] of Object.entries(patch)) challenge[key] = value;
		const kind = STATUS_EVENT_KIND[status] || "note";
		let text;
		if (typeof note === "string" && note) text = note;
		else if (status === "stuck" && challenge.stuckReason)
			text = `题目卡住：${challenge.stuckReason}`;
		else text = STATUS_EVENT_TEXT[status] || `状态切换为 ${status}`;
		addEvent(kind, text, attemptRef == null ? undefined : { attempt: attemptRef });
		return challenge;
	}

	function addAttempt(input = {}) {
		const payload = isPlainObject(input) ? input : {};
		const angle =
			typeof payload.angle === "string" && payload.angle ? payload.angle : "recon-first";
		const n = challenge.attempts.reduce((max, item) => Math.max(max, Number(item.n) || 0), 0) + 1;
		const startedAt = now();
		const attempt = {
			n,
			...(payload.runId ? { runId: String(payload.runId) } : {}),
			angle,
			sessionId: null,
			label: `ctf-${challenge.id}#${n}`,
			startedAt,
			endedAt: null,
			status: "running",
			stopReason: "",
			summary: "",
			failedPaths: [],
			outputTail: "",
			error: "",
		};
		challenge.attempts.push(attempt);
		challenge.status = "running";
		challenge.endedAt = null;
		challenge.stuckReason = "";
		if (typeof challenge.startedAt !== "number") challenge.startedAt = startedAt;
		return attempt;
	}

	function endAttempt(n, patch = {}) {
		const attempt = challenge.attempts.find((item) => item.n === Number(n));
		if (!attempt) return undefined;
		const payload = isPlainObject(patch) ? patch : {};
		const fields = [
			"endedAt",
			"status",
			"stopReason",
			"summary",
			"failedPaths",
			"outputTail",
			"error",
			"sessionId",
			"promptChars",
			"outputChars",
			"estTokens",
			"estCost",
			"elapsedMs",
		];
		for (const field of fields) {
			if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
			const value = payload[field];
			if (field === "outputTail") attempt.outputTail = String(value ?? "").slice(-OUTPUT_TAIL_LIMIT);
			else if (field === "failedPaths") attempt.failedPaths = normalizeFailedPaths(value);
			else if (field === "error") attempt.error = value == null ? "" : String(value);
			else if (field === "sessionId") attempt.sessionId = value == null ? null : String(value);
			else attempt[field] = value;
		}
		if (typeof attempt.endedAt !== "number") attempt.endedAt = now();
		if (!attempt.status || attempt.status === "running") attempt.status = "completed";
		return attempt;
	}

	function updateAttempt(n, patch = {}) {
		const attempt = challenge.attempts.find((item) => item && item.n === Number(n));
		if (!attempt) return undefined;
		for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
			if (!["n", "runId"].includes(key)) attempt[key] = value;
		}
		return attempt;
	}

	function patch(input = {}) {
		if (!isPlainObject(input)) throw new TypeError("题目修改必须是对象");
		for (const [key, value] of Object.entries(input)) if (key !== "id") challenge[key] = value;
		return challenge;
	}
	return { patch, addEvent, addFlag, addFact, removeFlag, setStatus, addAttempt, updateAttempt, endAttempt };
}
