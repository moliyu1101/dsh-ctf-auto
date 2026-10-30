import { normalizeBaseUrl } from "./ctfd.js";
import { platformConnectionKey, platformChallengeKey } from "./platform-identity.js";
import { freezeSnapshot } from "./state-snapshot.js";
import { captureInputContext, inputError, requireInputOpen, requireInputWritable } from "./input-context.js";
import { downloadPlatformInputs, platformPreparationPatch, resolvePlatformAttachments } from "./platform-inputs.js";

// Host-independent import orchestration. The host supplies workspace visibility,
// a synchronous authorization guard, and an explicitly requested start action.
export function createPlatformImport({ store, platforms, inputs, preparation, visibleChallenges,
	maxChallenges = 100, maxStatementBytes = 2 * 1024 * 1024 }) {
	let closed = false;
	async function execute(request, connection, listedItems, context, startReady) {
		const sessionKey = connection.sessionKey;
		function check(challenge) {
			requireInputOpen(store, closed); context.check();
			if (challenge) preparation.check(challenge);
			else requireInputWritable(store, closed);
			if (platforms.current().sessionKey !== sessionKey) throw inputError("STALE_PLATFORM_CONNECTION", "平台连接已切换，已停止旧连接导入");
		}
		check();
		const list = listedItems == null ? await connection.client.listChallenges() : { ok: true, data: listedItems };
		check();
		if (!list.ok) throw inputError(list.code || "PLATFORM_LIST_FAILED", list.error || "平台题目列表查询失败");
		if (!Array.isArray(list.data)) throw inputError("PLATFORM_LIST_INVALID", "平台题目列表格式无效");
		if (listedItems == null && !request.all && request.ids.length) {
			const counts = new Map();
			for (const item of list.data) {
				if (!item || item.id == null) continue;
				const id = String(item.id);
				if (!request.ids.includes(id)) continue;
				const identities = counts.get(id) || new Set();
				identities.add(platformChallengeKey(platforms.metadata(connection, item)));
				counts.set(id, identities);
			}
			if ([...counts.values()].some((identities) => identities.size > 1)) throw inputError("AMBIGUOUS_PLATFORM_ID", "平台列表中有相同题目 ID 属于不同来源，无法按 ID 安全选择；请使用自动批次或按来源筛选");
		}
		const baseUrl = normalizeBaseUrl(connection.baseUrl || connection.cfg.baseUrl);
		const selected = structuredClone(list.data).filter((item) => item && typeof item === "object" && !Array.isArray(item)
			&& (request.all || !request.ids.length || request.ids.includes(String(item.id ?? "")))).slice(0, maxChallenges);
		const created = [], skipped = [], errors = [];
		let indexedVersion = -1, bySource = new Map();
		function duplicate(meta) {
			if (indexedVersion !== store.changeVersion) {
				bySource = new Map();
				for (const ch of visibleChallenges(context.workspace)) {
					if (!ch.platform) continue;
					const key = platformChallengeKey(ch.platform);
					if (!bySource.has(key)) bySource.set(key, ch);
				}
				indexedVersion = store.changeVersion;
			}
			return bySource.get(platformChallengeKey(meta));
		}
		for (const item of selected) {
			const platformId = String(item.id ?? "").trim();
			if (!platformId) continue;
			let creating = null;
			try {
				check();
				if (request.skipSolved && item.solvedByMe) { skipped.push({ platformId, reason: "平台已解" }); continue; }
				const meta = platforms.metadata(connection, item);
				const existing = duplicate(meta);
				if (existing) { skipped.push({ platformId, reason: "已导入（包含未完成准备的记录）", localId: existing.id }); continue; }
				const response = await connection.client.getChallenge(platformId, item);
				check();
				if (!response.ok) throw inputError(response.code || "PLATFORM_DETAIL_FAILED", response.error || "题面查询失败");
				const detail = structuredClone(response.data);
				const patch = platformPreparationPatch(detail, { platformId, baseUrl, title: item.name, category: item.category, maxStatementBytes });
				if (duplicate(meta)) { skipped.push({ platformId, reason: "查询期间已导入" }); continue; }
				const ch = inputs.create({ ...patch, platform: meta, files: [] }, { baseDir: context.baseDir, workspace: context.workspace, inputKind: "platform" });
				creating = ch;
				function checkPreparation() { check(ch); }
				const rawFiles = await resolvePlatformAttachments({ platforms, connection, meta, detail, listedItem: item, check: checkPreparation });
				const files = await downloadPlatformInputs({ challenge: ch, connection, rawFiles, check: checkPreparation });
				check();
				const ready = preparation.complete(ch, files);
				created.push({ localId: ready.id, platformId, title: ready.title, status: "stopped" });
				const saved = store.transact(ch.id, (edit) => {
					if (context.driverSession) edit.patch({ driverSession: context.driverSession });
					edit.addEvent("note", `从平台导入（${baseUrl} #${platformId}），输入已准备`);
				}, { durable: true });
				if (!saved.ok) throw inputError(saved.code, saved.error, { applied: saved.applied, persistence: saved.persistence });
				if (request.start) {
					check();
					const started = startReady(ch.id);
					if (!started.ok) errors.push({ platformId, localId: ch.id, code: started.code, error: started.error });
					else created.at(-1).status = started.status;
				}
			} catch (error) {
				if (creating) { try { preparation.fail(creating, error); } catch { /* preserve primary failure */ } }
				errors.push({ platformId, localId: creating?.id || error.id, code: error.code, error: String(error.message || error), applied: !!creating || error.applied === true });
				// Preserve partial results when authorization, connection, or storage fails.
				try { check(); } catch { break; }
			}
		}
		return { ok: errors.length === 0, created, skipped, errors, ...(errors.length ? { error: `${errors.length} 项导入或启动失败，请查看逐题结果` } : {}) };
	}
	async function importChallenges(payload = {}, { scope, connection, listedItems, startReady } = {}) {
		try {
			const context = captureInputContext(scope);
			requireInputWritable(store, closed); context.check();
			connection ||= platforms.current();
			if (!connection?.client) throw inputError(connection?.code || "PLATFORM_UNAVAILABLE", connection?.error || "平台未配置：请先填写 baseUrl 与 API Token");
			if (!context.baseDir) throw inputError("INPUT_DIRECTORY_REQUIRED", "平台导入缺少明确的目录上下文");
			const request = freezeSnapshot({ ids: Array.isArray(payload.ids) ? payload.ids.map((id) => String(id ?? "").trim()).filter(Boolean) : [],
				all: payload.all === true, skipSolved: payload.skipSolved !== false, start: payload.start === true });
			if (request.start && typeof startReady !== "function") throw inputError("IMPORT_START_REQUIRED", "导入开始操作缺少宿主执行上下文");
			const listed = Array.isArray(listedItems) ? freezeSnapshot(structuredClone(listedItems)) : null;
			return await platforms.operations.exclusive(`import:${platformConnectionKey(connection.cfg)}:${context.workspace}`,
				() => execute(request, connection, listed, context, startReady));
		} catch (error) {
			return { ok: false, code: error.code || "PLATFORM_IMPORT_FAILED", error: String(error.message || error),
				...(error.persistence ? { persistence: error.persistence } : {}) };
		}
	}
	return { importChallenges, close() { closed = true; } };
}
