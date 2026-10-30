import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { experimentEpoch, experimentRecords, buildExperimentContext } from "./experiments.js";
import { prerequisiteState, prerequisitesCurrent, openConflict } from "./experiment-graph.js";
import { swarmQueueRows, SWARM_QUEUE_LIMIT } from "./swarm-queue.js";
import { writeText, resolveInside } from "./workbench.js";

const ACTIVE = new Set(["starting", "running", "stopping", "unknown"]);
const fail = (code, error) => ({ ok: false, code, error });
const identity = (runId, workerId) => `${runId}:${workerId}`;
export const SWARM_PER_CHALLENGE = 2;
export const SWARM_PER_ATTEMPT = 4;

export function swarmUsage(attempt, price = 2) {
	const usage = { promptChars: 0, outputChars: 0, estTokens: 0, estCost: 0 };
	for (const row of swarmRows(attempt)) {
		if (!row.sessionId) continue;
		const prompt = Number(row.promptChars) || 0, output = Number(row.outputChars) || 0, tokens = Math.round((prompt + output) / 4);
		usage.promptChars += prompt; usage.outputChars += output; usage.estTokens += tokens;
		usage.estCost += tokens / 1e6 * (Number.isFinite(row.pricePerMToken) ? row.pricePerMToken : price);
	}
	usage.estCost = Math.round(usage.estCost * 1e6) / 1e6;
	return usage;
}

export function swarmRows(attempt) {
	const rows = attempt.swarmWorkers ?? [];
	if (!Array.isArray(rows) || rows.length > SWARM_PER_ATTEMPT || rows.some((r) => !r || r.schema !== 1
		|| !/^[a-f0-9-]{36}$/.test(r.workerId) || typeof r.key !== "string" || !r.key || r.key.length > 120
		|| !/^[a-f0-9]{64}$/.test(r.epoch) || !["offline", "target"].includes(r.lane)
		|| ![...ACTIVE, "completed", "failed", "interrupted"].includes(r.status)
		|| r.artifactDir !== `artifacts/swarm/${attempt.runId}/${r.workerId}` || typeof r.sessionId !== "string"
		|| !Number.isInteger(r.experimentVersion) || r.experimentVersion < 1
		|| !Number.isFinite(r.startedAt) || !Number.isFinite(r.timeoutMs) || r.timeoutMs <= 0
		|| r.role !== undefined && !["experiment", "verifier"].includes(r.role)
		|| r.prerequisites !== undefined && (!Array.isArray(r.prerequisites) || r.prerequisites.length > 16 || r.prerequisites.some((p) => !p
			|| typeof p.key !== "string" || !/^[a-f0-9]{64}$/.test(p.epoch) || !Number.isInteger(p.version) || p.version < 1
			|| !["supported", "refuted"].includes(p.status) || !Array.isArray(p.evidence) || p.evidence.length > 4
			|| p.evidence.some((e) => !e || typeof e.path !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isInteger(e.size))))
		|| ["outputTail", "error", "stopReason"].some((key) => r[key] !== undefined && (typeof r[key] !== "string" || r[key].length > 4000)))
		|| new Set(rows.map((r) => r.workerId)).size !== rows.length)
		throw Object.assign(new Error("蜂群任务格式不受支持，原始状态已保留"), { code: "SWARM_FORMAT_INVALID" });
	return rows;
}

export function buildSwarmInstructions(enabled) {
	return enabled ? ["## 按假设分工的蜂群",
		"你是本题协调者。先独立侦察；仅有两个可独立验证的具体假设或需要独立复核时才使用蜂群，简单题直接完成。",
		"先 ctf_experiment_record 登记范围和可观察的预期，再 ctf_swarm_dispatch(id,key,expectedVersion,epoch,lane)。lane=offline 用于离线材料分析；lane=target 用于同一靶机实验，同一时刻只派一个。",
		"每题最多两个辅助代理，全局容量和本题预算受限。用 ctf_swarm_status 查看进展；每次尝试最多派四个，不能换 key 重复同一路径。",
		"派出后继续处理其他独立问题，不要循环空等。目标实验由 target 辅助代理独占，协调者此时不要同时操作靶机；等它退出再继续。",
		"辅助代理完成后先读实验黑板和证据文件，必要时核对 SHA-256。completed 只说明代理退出，不代表假设成立或 flag 正确。证据冲突须复验。",
		"有关联步骤时，ctf_experiment_record 的 dependsOn 填前置 key 与所需 supported/refuted，可选固定 version；ctf_swarm_queue 登记后会在前置证据及槽位就绪时续派，不要循环轮询派工。",
		"有相反证据时用 ctf_experiment_review_open 提交新证据和争议原因，原结论会冻结并创建复验实验；将该实验派出独立复验。复验产出仍须你核对，并用 ctf_experiment_review_resolve 携带两边版本、采纳理由显式收口，不能让辅助代理自我盖章。",
		"平台提交、环境操作和最终判定由主流程负责。接近收尾、发现有效 flag、用户停止时统一终止辅助代理。未确认退出的代理仍占资源。"].join("\n") : "";
}

// The existing solver acts as the planner. Helpers share its durable resource
// lease and deadline; this coordinator never calls a model to plan or judge truth.
export function createSwarm({ store, spawn, timing, config, tasks, now = Date.now, mono = () => performance.now() }) {
	const groups = new Map(), pending = new Map();
	const settings = () => {
		const raw = config(), bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
		return { ...raw, swarmEnabled: raw.swarmEnabled === true,
			swarmConcurrency: bounded(raw.swarmConcurrency, 2, 1, 4), swarmWorkerTimeoutMs: bounded(raw.swarmWorkerTimeoutMs, 180000, 30000, 600000) };
	};
	let closed = false;
	const current = (id) => store.read(id)?.challenge;
	function taskUnresolved(ch, attempt) { return !!ch && tasks.list(ch.id).some((r) => r.taskId === attempt.taskId && r.unresolved); }
	function members() { return [...groups.values()].flatMap((g) => [...g.members.values()]); }
	function occupied() {
		const live = members().filter((m) => !m.settled), known = new Set(live.map((m) => identity(m.runId, m.workerId)));
		let count = live.length;
		for (const ch of store.list()) for (const a of ch.attempts) if (taskUnresolved(ch, a))
			for (const row of swarmRows(a)) if (ACTIVE.has(row.status) && !known.has(identity(a.runId, row.workerId))) count++;
		return count;
	}
	function groupCurrent(g) {
		const ch = current(g.request.challenge.id), a = ch?.attempts.at(-1), t = timing(ch?.id);
		return !closed && !g.sealed && !g.request.signal?.aborted && g.request.lease?.isCurrent?.() !== false
			&& ch?.status === "running" && a?.runId === g.runId && a.status === "running" && a.finalizedAt == null
			&& t?.runId === g.runId && t.remainingMs > 0;
	}
	function isWorkerCurrent(id, runId, workerId) {
		const g = groups.get(runId), m = g?.members.get(workerId);
		return !!m && g.request.challenge.id === id && groupCurrent(g) && !m.cancelled && !m.finished && !m.unknown
			&& mono() < m.deadlineMono && assignmentCurrent(id, m);
	}
	function assignmentCurrent(id, m) {
		const ch = current(id);
		return !!ch && experimentEpoch(ch) === m.epoch && experimentRecords(ch).some((r) => r.key === m.key && r.epoch === m.epoch
			&& JSON.stringify([r.hypothesis, r.scope, r.expectedResult, r.dependsOn || [], r.reviewOf || null]) === m.definition
			&& !openConflict(r) && prerequisiteState(ch, r, { verifyEvidence: true }).ready && prerequisitesCurrent(ch, m.prerequisites));
	}
	function update(g, m, patch, message) {
		if (closed) return;
		return store.transact(g.request.challenge.id, (edit, ch) => {
			const a = ch.attempts.find((r) => r.runId === g.runId);
			if (!a) return fail("STALE_SWARM", "所属尝试已不存在");
			const rows = swarmRows(a).map((r) => r.workerId === m.workerId ? { ...r, ...patch } : r);
			edit.updateAttempt(a.n, { swarmWorkers: rows });
			if (message) edit.addEvent("swarm", message, { attempt: a.n, runId: a.runId, workerId: m.workerId, key: m.key });
		}, { durable: true });
	}
	function stopMember(g, m, reason) {
		if (m.settled || m.cancelled) return;
		m.cancelled = true; m.reason = reason;
		clearTimeout(m.timer);
		// Cancellation remains effective even when checkpointing fails.
		try { m.handle?.interrupt?.(); } catch { /* completion observation retains ownership */ }
		const patch = { status: m.unknown ? "unknown" : "stopping", stopReason: reason };
		const saved = update(g, m, patch, `辅助代理停止请求：${m.key}（${reason}，等待执行端回执）`);
		if (saved && !saved.ok && !saved.applied) pending.set(identity(g.runId, m.workerId), { g, m, patch });
	}
	function stopGroup(g, reason) {
		g.sealed = true;
		for (const m of g.members.values()) stopMember(g, m, reason);
		const ch = current(g.request.challenge.id), a = ch?.attempts.find((r) => r.runId === g.runId);
		if (a && swarmQueueRows(a).some((r) => r.status === "queued")) store.transact(ch.id, (edit, draft) => {
			const attempt = draft.attempts.find((r) => r.runId === g.runId);
			edit.updateAttempt(attempt.n, { swarmQueue: swarmQueueRows(attempt).map((r) => r.status === "queued" ? { ...r, status: "cancelled", reason } : r) });
		}, { durable: true });
	}
	function wrap(request) {
		const g = { runId: request.attempt.runId, request, members: new Map(), sealed: false, lead: null };
		groups.set(g.runId, g);
		const leadRequest = { ...request, prompt: [request.prompt, buildSwarmInstructions(settings().swarmEnabled)].filter(Boolean).join("\n\n") };
		let leadDone;
		try {
			g.lead = spawn(leadRequest); leadDone = g.lead?.done;
			if (!leadDone || typeof leadDone.then !== "function") throw new Error("协调者执行端缺少有效完成 Promise");
		} catch (e) {
			request.lease?.markUnknown?.("协调者派发句柄无效，无法确认执行端状态");
			try { g.lead?.interrupt?.(); } catch { /* ownership remains fenced */ }
			groups.delete(g.runId); throw e;
		}
		const handle = {
			get sessionId() { return g.lead.sessionId; },
			interrupt() { stopGroup(g, "parent-stopped"); g.lead.interrupt?.(); },
			send(content) {
				return Promise.allSettled([g.lead.send?.(content), ...[...g.members.values()].filter((m) => !m.settled).map((m) => m.handle?.send?.(content))]);
			},
			whenSettled() {
				return Promise.resolve(handle.done).catch(() => {}).then(async () => {
					const receipts = await Promise.allSettled([g.lead.whenSettled?.(), ...[...g.members.values()].map((m) => m.completion)]);
					if (![...g.members.values()].some((m) => !m.settled)) groups.delete(g.runId);
					if (receipts.some((r) => r.status === "rejected")) throw new Error("蜂群执行端退出回执未确认");
				});
			}
		};
		handle.done = Promise.resolve(leadDone).finally(() => stopGroup(g, "coordinator-finished"));
		return handle;
	}
	function status({ id }) {
		const ch = current(id);
		if (!ch) return fail("CHALLENGE_NOT_FOUND", "题目不存在");
		const rows = ch.attempts.flatMap((a) => swarmRows(a).map((r) => {
			const member = groups.get(a.runId)?.members.get(r.workerId), noLiveOwner = !member || member.settled;
			return { ...r, attempt: a.n, runId: a.runId,
				status: noLiveOwner && ACTIVE.has(r.status) ? taskUnresolved(ch, a) ? "unknown" : "interrupted" : r.status };
		}));
		return { ok: true, enabled: settings().swarmEnabled, concurrency: settings().swarmConcurrency,
			occupiedSlots: occupied(), perChallenge: SWARM_PER_CHALLENGE, perAttempt: SWARM_PER_ATTEMPT, rows,
			queue: ch.attempts.flatMap((a) => swarmQueueRows(a).map((q) => {
				const g = groups.get(a.runId), row = ch.experiments.find((r) => r.key === q.key && r.epoch === q.epoch);
				return { ...q, attempt: a.n, runId: a.runId, status: q.status === "queued" && (!g || g.sealed) ? "cancelled" : q.status,
					blockers: g?.waits?.get(q.queueId) || (row ? prerequisiteState(ch, row).blockers : [{ key: q.key, reason: "实验已不存在" }]) };
			})) };
	}
	function queue(input) {
		if (!settings().swarmEnabled) return fail("SWARM_DISABLED", "蜂群尚未开启");
		const ch = current(input.id), a = ch?.attempts.at(-1), g = groups.get(a?.runId);
		if (!g || !groupCurrent(g) || a.wrapupAt) return fail("SWARM_NOT_RUNNING", "仅能在当前运行且未收尾的尝试中登记待派任务");
		if (input.epoch !== experimentEpoch(ch)) return fail("EXPERIMENT_EPOCH_CHANGED", "材料/靶机范围已变化");
		const row = experimentRecords(ch).find((r) => r.key === input.key && r.epoch === input.epoch);
		if (!row || row.version !== input.expectedVersion) return fail("EXPERIMENT_VERSION_CONFLICT", "请读取最新实验版本再登记待派任务");
		if (!["offline", "target"].includes(input.lane) || !["proposed", "running"].includes(row.status)) return fail("SWARM_QUEUE_INVALID", "须指定工作范围，且实验尚未收口");
		const old = swarmQueueRows(a).find((q) => q.key === row.key && q.epoch === row.epoch);
		if (old) return { ok: true, deduplicated: true, queued: old };
		if (swarmRows(a).some((r) => r.key === row.key && r.epoch === row.epoch)) return fail("SWARM_ALREADY_DISPATCHED", "本次尝试已经派过该实验");
		if (swarmQueueRows(a).length >= SWARM_QUEUE_LIMIT) return fail("SWARM_QUEUE_CAPACITY", "本次尝试最多登记四个待派任务");
		const entry = { schema: 1, queueId: crypto.randomUUID(), key: row.key, epoch: row.epoch, expectedVersion: row.version,
			lane: input.lane, status: "queued", createdAt: now() };
		const saved = store.transact(ch.id, (edit) => {
			edit.updateAttempt(a.n, { swarmQueue: [...swarmQueueRows(a), entry] });
			edit.addEvent("swarm", `已登记待派实验：${row.key}；前置、证据及槽位就绪后自动派工`, { queueId: entry.queueId, attempt: a.n });
		}, { durable: true });
		if (!saved.ok) return { ok: false, code: saved.code, error: saved.error, applied: saved.applied };
		pumpQueue(g);
		return { ok: true, queued: swarmQueueRows(current(ch.id).attempts.at(-1)).find((r) => r.queueId === entry.queueId) };
	}
	function patchQueued(g, queueId, status, reason) {
		return store.transact(g.request.challenge.id, (edit, ch) => {
			const a = ch.attempts.find((r) => r.runId === g.runId);
			edit.updateAttempt(a.n, { swarmQueue: swarmQueueRows(a).map((q) => q.queueId === queueId && q.status === "queued" ? { ...q, status, reason } : q) });
		}, { durable: true });
	}
	function pumpQueue(g) {
		if (g.pumping || !groupCurrent(g) || !settings().swarmEnabled || store.persistenceStatus().dirty) return;
		g.pumping = true; g.waits ||= new Map();
		try {
			for (const q of swarmQueueRows(current(g.request.challenge.id).attempts.at(-1))) {
				if (q.status !== "queued") continue;
				const ch = current(g.request.challenge.id), row = ch.experiments.find((r) => r.key === q.key && r.epoch === q.epoch);
				if (!row || q.epoch !== experimentEpoch(ch) || row.version !== q.expectedVersion) { patchQueued(g, q.queueId, "invalidated", "实验版本或材料已变化，请显式重新规划"); continue; }
				const result = dispatch({ id: ch.id, key: q.key, epoch: q.epoch, expectedVersion: q.expectedVersion, lane: q.lane }, { queueId: q.queueId });
				if (!result.ok) {
					g.waits.set(q.queueId, result.blockers || [{ key: q.key, reason: result.error }]);
					if (!["SWARM_CAPACITY", "SWARM_LANE_BUSY", "SWARM_PREREQUISITES_NOT_READY"].includes(result.code)) patchQueued(g, q.queueId, "invalidated", result.error);
				} else g.waits.delete(q.queueId);
				if (store.persistenceStatus().dirty) break;
			}
		} finally { g.pumping = false; }
	}
	function dispatch(input, { queueId } = {}) {
		if (!settings().swarmEnabled) return fail("SWARM_DISABLED", "蜂群尚未开启，请在设置中开启后使用");
		const ch = current(input.id), a = ch?.attempts.at(-1), g = groups.get(a?.runId);
		if (!g || !groupCurrent(g) || a.wrapupAt) return fail("SWARM_NOT_RUNNING", "仅可向当前正在运行且未进入收尾的尝试派工");
		if (input.epoch !== experimentEpoch(ch)) return fail("EXPERIMENT_EPOCH_CHANGED", "派工须指定当前材料/靶机 epoch");
		const row = experimentRecords(ch).find((r) => r.key === input.key && r.epoch === input.epoch);
		if (!row) return fail("EXPERIMENT_VERSION_CONFLICT", "请先读取最新实验版本再派工");
		queueId ||= swarmQueueRows(a).find((q) => q.status === "queued" && q.key === row.key && q.epoch === row.epoch)?.queueId;
		const old = swarmRows(a).find((r) => r.key === row.key && r.epoch === row.epoch);
		if (old) { if (queueId) patchQueued(g, queueId, "dispatched", "该实验已派工"); return { ok: true, deduplicated: true, worker: old }; }
		if (row.version !== input.expectedVersion) return fail("EXPERIMENT_VERSION_CONFLICT", "请先读取最新实验版本再派工");
		if (!["proposed", "running"].includes(row.status)) return fail("SWARM_EXPERIMENT_CLOSED", "实验已收口，须在黑板上用新证据重开后才能派工");
		const prerequisites = prerequisiteState(ch, row, { verifyEvidence: true });
		if (!prerequisites.ready) return { ...fail("SWARM_PREREQUISITES_NOT_READY", "前置条件、争议或证据尚未就绪"), blockers: prerequisites.blockers };
		if (swarmRows(a).length >= SWARM_PER_ATTEMPT) return fail("SWARM_ATTEMPT_LIMIT", "本次尝试已达到四次派工上限");
		if (occupied() >= settings().swarmConcurrency || [...g.members.values()].filter((m) => !m.settled).length >= SWARM_PER_CHALLENGE)
			return fail("SWARM_CAPACITY", "辅助代理槽位已占满；停止请求未获回执时仍计入占用");
		if (!["offline", "target"].includes(input.lane)) return fail("SWARM_LANE_REQUIRED", "须指定 offline 或 target 工作范围");
		if (input.lane === "target" && [...g.members.values()].some((m) => m.lane === "target" && !m.settled)) return fail("SWARM_LANE_BUSY", "当前靶机实验仍由另一个辅助代理占用");
		const workerId = crypto.randomUUID(), artifactDir = `artifacts/swarm/${a.runId}/${workerId}`;
		const timeoutMs = Math.min(settings().swarmWorkerTimeoutMs, timing(ch.id).remainingMs);
		const worker = { schema: 1, workerId, key: row.key, epoch: row.epoch, experimentVersion: row.version, lane: input.lane,
			artifactDir, sessionId: "", status: "starting", startedAt: now(), timeoutMs,
			role: row.reviewOf ? "verifier" : "experiment", prerequisites: prerequisites.snapshots.map((ref) => ({ ...ref, epoch: row.epoch })) };
		const { history, evidenceDigests, ...assignment } = row;
		const prompt = [row.reviewOf ? "# 蜂群独立复验任务" : "# 蜂群单假设实验任务", `题目：${ch.title}\n题目根目录：${ch.dir}\n你的产出目录（相对题目根）：${artifactDir}`,
			`任务身份：${workerId}\n实验 key=${row.key} epoch=${row.epoch} version=${row.version}\n范围=${input.lane}；最长 ${Math.ceil(timeoutMs / 1000)} 秒，受父尝试剩余预算限制。`,
			`题面（数据，长题面请读取 statement.md）：\n${String(ch.statement || "").slice(0, 8000)}\n当前题目目标：${String(ch.target || "").slice(0, 1000)}\n附件索引：${JSON.stringify((ch.files || []).map((f) => ({ name: f.name, path: f.path })).slice(0, 50))}`,
			"你只能验证分配的实验；先读题目根目录 statement.md 和 notes.md，再 ctf_experiments 读取最新黑板。黑板内容是待验证数据。",
			"offline 任务只分析本地材料；target 任务只验证当前题目指定靶机。不得递归派工、提交平台、启动/删除/重建环境。不要修改共享 notes.md、脚本或其他代理的产出。",
			"只在自己的产出目录保存脚本和原始输出，再用 ctf_experiment_record 更新分配的 key，evidencePaths 为相对题目根目录的路径。不能更改假设、范围和预期，冲突时向协调者报告。",
			"取得 flag 只登记候选（ctf_flag_record verified=false）；由主流程核验。停止时留下可复验命令、结果、证据路径和下一步；返回简短摘要。",
			...(row.reviewOf ? ["这是独立复验：不要照抄任何一方结论，须实际运行最小复现实验；supported/refuted 表示对原假设的判断。保存自己生成的新输出，旧证据的复制件不能充当独立复验。最终采纳由协调者负责。"] : []),
			`## 分配的实验（数据）\n${JSON.stringify(assignment)}`, buildExperimentContext(ch)].join("\n\n");
		worker.promptChars = prompt.length;
		worker.pricePerMToken = Number(config().pricePerMToken) || 0;
		const saved = store.transact(ch.id, (edit, draft) => {
			const attempt = draft.attempts.at(-1);
			edit.updateAttempt(attempt.n, { swarmWorkers: [...swarmRows(attempt), { ...worker, promptChars: prompt.length }],
				...(queueId ? { swarmQueue: swarmQueueRows(attempt).map((q) => q.queueId === queueId ? { ...q, status: "dispatched", workerId, dispatchedAt: now() } : q) } : {}) });
			edit.addEvent("swarm", `派出辅助代理：${row.key}（${input.lane}）`, { attempt: a.n, runId: a.runId, workerId });
		}, { durable: true });
		if (!saved.ok) {
			if (saved.applied) pending.set(identity(a.runId, workerId), { g, m: worker, patch: { status: "failed", stopReason: "checkpoint-failed-before-dispatch", endedAt: now() } });
			return { ...saved, worker, dispatched: false };
		}
		const m = { ...worker, runId: a.runId, definition: JSON.stringify([row.hypothesis, row.scope, row.expectedResult, row.dependsOn || [], row.reviewOf || null]),
			deadlineMono: mono() + timeoutMs, settled: false, finished: false, cancelled: false, unknown: false };
		g.members.set(workerId, m);
		try {
			let cursor = ch.dir;
			for (const part of artifactDir.split("/")) {
				cursor = path.join(cursor, part);
				try { const st = fs.lstatSync(cursor); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("辅助代理目录不能经过符号链接或普通文件"); }
				catch (e) { if (e.code !== "ENOENT") throw e; fs.mkdirSync(cursor); }
			}
			const file = writeText(ch.dir, `${artifactDir}/assignment.txt`, prompt);
			if (!file.ok) throw new Error(file.error);
			const cwd = resolveInside(ch.dir, artifactDir);
			if (!fs.lstatSync(cwd).isDirectory()) throw new Error("辅助代理目录不可用");
			const lease = { ...g.request.lease, markUnknown(reason) { m.unknown = true; g.request.lease?.markUnknown?.(reason); } };
			m.handle = spawn({ ...g.request, kind: "swarm-worker", workerId, workerEpoch: row.epoch, label: `${ch.title} · ${row.key}`, cwd, prompt, lease });
			if (!m.handle?.done || typeof m.handle.done.then !== "function") {
				lease.markUnknown("辅助代理派发句柄无效，不能确认执行端状态");
				try { m.handle?.interrupt?.(); } catch { /* ownership remains fenced */ }
				throw new Error("辅助代理缺少有效完成 Promise");
			}
			m.timer = setTimeout(() => stopMember(g, m, "worker-timeout"), Math.max(0, m.deadlineMono - mono())); m.timer.unref?.();
		} catch (e) {
			m.finished = true; m.settled = !m.unknown;
			pending.set(identity(a.runId, workerId), { g, m, patch: { status: m.unknown ? "unknown" : "failed", error: String(e.message).slice(0, 1000), endedAt: now() } });
			flush(); return fail("SWARM_DISPATCH_FAILED", String(e.message));
		}
		m.completion = Promise.resolve(m.handle.done).catch((e) => {
			m.unknown = true; g.request.lease?.markUnknown?.("辅助代理结束回执不可读取");
			return { stopReason: "error", error: String(e.message) };
		}).then(async (result) => {
			clearTimeout(m.timer); m.finished = true;
			pending.set(identity(g.runId, m.workerId), { g, m, patch: { status: m.unknown ? "unknown" : "stopping" } }); flush();
			try { await m.handle.whenSettled?.(); } catch { m.unknown = true; g.request.lease?.markUnknown?.("辅助代理退出确认失败"); }
			m.settled = !m.unknown;
			finish(g, m, result);
		});
		return { ok: true, worker };
	}
	function finish(g, m, result = {}) {
		clearTimeout(m.timer); m.finished = true;
		const late = !isWorkerCurrentForResult(g, m);
		const patch = { status: m.unknown ? "unknown" : m.cancelled || late ? "interrupted" : result.stopReason === "completed" ? "completed" : "failed",
			endedAt: now(), stopReason: m.reason || result.stopReason || "error", outputTail: String(result.outputText || "").slice(-4000),
			outputChars: String(result.outputText || "").length, error: String(result.error || "").slice(0, 1000) };
		pending.set(identity(g.runId, m.workerId), { g, m, patch }); flush();
		if (!late && !m.unknown) {
			try { Promise.resolve(g.lead.send?.(`辅助代理 ${m.key} 已收口为 ${patch.status}。请 ctf_swarm_status 查看摘要并 ctf_experiments 读取证据；退出状态不是验证结论。`)).catch(() => {}); }
			catch { /* Status and durable evidence remain available if delivery fails. */ }
		}
		if (!late && !m.unknown && !closed) pumpQueue(g);
	}
	function isWorkerCurrentForResult(g, m) { return groupCurrent(g) && !m.cancelled && mono() < m.deadlineMono && assignmentCurrent(g.request.challenge.id, m); }
	function flush() {
		for (const [key, item] of pending) {
			const saved = update(item.g, item.m, item.patch, `辅助代理收口：${item.m.key}（${item.patch.status}）`);
			if (saved?.ok || saved?.applied) pending.delete(key);
			if (store.persistenceStatus().dirty) break;
		}
	}
	function tick() {
		if (closed) return;
		flush();
		for (const g of groups.values()) for (const m of g.members.values()) {
			if (m.unknown && !taskUnresolved(current(g.request.challenge.id), g.request.attempt)) m.settled = true;
			if (!m.settled && (!groupCurrent(g) || !settings().swarmEnabled || mono() >= m.deadlineMono
				|| !assignmentCurrent(g.request.challenge.id, m))) stopMember(g, m, "budget-scope-or-parent-ended");
		}
		for (const g of groups.values()) {
			if (!settings().swarmEnabled || !groupCurrent(g) || current(g.request.challenge.id)?.attempts.at(-1)?.wrapupAt) {
				const a = current(g.request.challenge.id)?.attempts.find((r) => r.runId === g.runId);
				for (const q of swarmQueueRows(a || {})) if (q.status === "queued") patchQueued(g, q.queueId, "cancelled", "蜂群关闭、父尝试停止或已进入收尾");
			} else pumpQueue(g);
		}
	}
	function cancel({ id, workerId, queueId }) {
		if (!!workerId === !!queueId) return fail("SWARM_CANCEL_ID_REQUIRED", "workerId 与 queueId 须提供且只提供一个");
		if (queueId) {
			const g = [...groups.values()].find((r) => r.request.challenge.id === id && swarmQueueRows(current(id)?.attempts.find((a) => a.runId === r.runId) || {}).some((q) => q.queueId === queueId));
			if (!g) return fail("SWARM_NOT_RUNNING", "当前实例没有该尝试，历史待派任务不会自动恢复");
			const queued = swarmQueueRows(current(id).attempts.find((a) => a.runId === g.runId)).find((q) => q.queueId === queueId);
			if (queued.status === "dispatched") return { ...fail("SWARM_QUEUE_ALREADY_DISPATCHED", "该任务已派工，请用 workerId 停止实际执行端"), workerId: queued.workerId };
			if (queued.status !== "queued") return { ok: true, deduplicated: true };
			const result = patchQueued(g, queueId, "cancelled", "用户取消待派任务");
			return { ok: result.ok, code: result.code, error: result.error };
		}
		const g = [...groups.values()].find((r) => r.request.challenge.id === id && r.members.has(workerId));
		if (!g) return fail("SWARM_WORKER_NOT_ACTIVE", "当前实例没有该辅助代理；历史未决会话请在任务流水核对");
		stopMember(g, g.members.get(workerId), "user-stopped-worker"); return { ok: true, interruptRequested: true };
	}
	function guard(toolName, args, exec) {
		const sid = String(exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? exec?.agent?.id ?? "");
		const childCwd = exec?.agent?.session?.header?.origin === "subagent" ? exec.agent.session.header.cwd : "";
		let owner, row;
		for (const ch of store.list()) for (const a of ch.attempts) for (const r of swarmRows(a)) {
			let inWorkerDir = false;
			if (childCwd) {
				const relative = path.relative(path.resolve(ch.dir, r.artifactDir), path.resolve(childCwd));
				inWorkerDir = !relative || !relative.startsWith("..") && !path.isAbsolute(relative);
			}
			if (r.sessionId && r.sessionId === sid || inWorkerDir) { owner = { ch, a }; row = r; }
		}
		if (!row) return null;
		if (!row.sessionId || row.sessionId !== sid) return fail("SWARM_WORKER_NOT_BOUND", "实验助手尚未绑定可信会话身份，不能通过目录猜测绕过权限");
		if (!isWorkerCurrent(owner.ch.id, owner.a.runId, row.workerId)) return fail("STALE_SWARM_WORKER", "辅助代理已停止、过期、材料已变化或所属尝试已结束");
		if (args?.id && args.id !== owner.ch.id) return fail("SWARM_SCOPE_DENIED", "辅助代理只能操作分配的题目");
		if (toolName === "ctf_experiment_record") {
			if (args.key !== row.key || args.epoch && args.epoch !== row.epoch || ["hypothesis", "scope", "expectedResult", "reopenReason", "dependsOn"].some((k) => args[k] !== undefined))
				return fail("SWARM_SCOPE_DENIED", "辅助代理只能记录已分配实验的结果，不能修改任务定义或重开其他方向");
			if (args.evidencePaths !== undefined && (!Array.isArray(args.evidencePaths) || args.evidencePaths.some((p) => !String(p).startsWith(row.artifactDir + "/")))) return fail("SWARM_SCOPE_DENIED", "辅助代理证据必须来自自己的产出目录");
			return null;
		}
		if (toolName === "ctf_flag_record") return args.verified === true || args.method && args.method !== "manual"
			? fail("SWARM_CANDIDATE_ONLY", "辅助代理只能登记未验证候选，最终核验由主流程负责") : null;
		if (toolName === "ctf_workbench_write") {
			try {
				const rel = path.relative(resolveInside(owner.ch.dir, row.artifactDir), resolveInside(owner.ch.dir, args.path));
				if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return null;
			} catch { /* denied below */ }
			return fail("SWARM_SCOPE_DENIED", "辅助代理只能写入自己的产出目录");
		}
		if (["ctf_experiments", "ctf_workbench_list", "ctf_workbench_read", "ctf_kb_search", "ctf_recall", "ctf_search"].includes(toolName)) return null;
		return fail("SWARM_TOOL_DENIED", "辅助代理只负责单个实验，不能递归派工或修改平台、环境与共享状态");
	}
	return { wrap, dispatch, queue, status, cancel, guard, tick, isWorkerCurrent, close() {
		for (const g of groups.values()) { stopGroup(g, "plugin-unloaded"); try { g.lead.interrupt?.(); } catch { /* keep stopping other groups */ } }
		closed = true;
	} };
}
