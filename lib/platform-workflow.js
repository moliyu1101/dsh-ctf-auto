import path from 'node:path';
import crypto from 'node:crypto';
import { platformChallengeKey } from './platform-identity.js';

// The workflow owns discovery and dispatch; platform operations own all remote
// mutations and their durable journals. No submission is retried here.
export function createPlatformWorkflow({ platforms, workspaceForRequest, agentOfSession, baseDirOf, visibleChallenges, importChallenges, getConfig, submissions }) {
	const snapshots = new Map();
	const ttlMs = 5 * 60 * 1000;
	async function status() {
		try {
			const connection = platforms.current();
			const base = { kind: connection.kind, baseUrl: connection.baseUrl, platformSlug: connection.platformSlug,
				tokenSet: !!connection.token, capabilities: connection.capabilities };
			if (!connection.client) return { ok: true, configured: false, ...base, reachable: false, error: connection.error || '' };
			const result = connection.kind === 'generic' ? await connection.client.listChallenges() : await connection.client.me();
			if (platforms.current().sessionKey !== connection.sessionKey) return { ok: false, code: 'STALE_PLATFORM_CONNECTION', error: '连接检查期间平台配置已变化，请重新检查' };
			return { ok: true, configured: true, ...base, operations: platforms.operations.snapshot(), reachable: result.ok,
				user: !result.ok ? null : connection.kind === 'generic' ? { name: 'generic', challenges: (result.data || []).length } : result.data,
				paths: result.path || '', error: result.ok ? '' : result.error };
		} catch (error) { return { ok: false, code: error.code || 'PLATFORM_STATUS_FAILED', error: String(error.message || error) }; }
	}
	function submit(input, options = {}) {
		return submissions.submit(input, { manual: true, retryUnknown: options.retryUnknown === true });
	}
	function reconcile(input) { return submissions.reconcile(input); }
	function automatic(id, flag) { return submissions.automatic(id, flag); }
	async function discover(payload = {}) {
		try {
			const connection = platforms.current();
			if (!connection.client) return { ok: false, code: 'PLATFORM_UNAVAILABLE', error: connection.error || '平台未配置' };
			const sessionId = payload.sessionId ? String(payload.sessionId) : '';
			if (sessionId && !agentOfSession(sessionId)) return { ok: false, code: 'PIPELINE_SESSION_UNAVAILABLE', error: '发起会话不可用，请在有效会话中重新运行' };
			const workspace = workspaceForRequest(payload);
			const list = await connection.client.listChallenges();
			if (platforms.current().sessionKey !== connection.sessionKey) return { ok: false, code: 'STALE_PLATFORM_CONNECTION', error: '拉题期间平台连接已变化，请重新运行' };
			if (sessionId && (!agentOfSession(sessionId) || workspaceForRequest(payload) !== workspace)) return { ok: false, code: 'PIPELINE_SESSION_CHANGED', error: '拉题期间会话或工作区已变化，请重新运行' };
			if (!list.ok) return { ok: false, code: list.code, error: list.error };
			if (!Array.isArray(list.data)) return { ok: false, code: 'PLATFORM_LIST_INVALID', error: '平台题目列表格式无效' };
			const existing = new Map();
			for (const item of visibleChallenges(workspace)) if (item.platform) existing.set(platformChallengeKey(item.platform), item);
			const seen = new Set(), challenges = [];
			for (const item of list.data) {
				if (!item || item.id == null || !String(item.id).trim()) continue;
				const sourceKey = platformChallengeKey(platforms.metadata(connection, item));
				if (seen.has(sourceKey)) continue;
				seen.add(sourceKey);
				const local = existing.get(sourceKey);
				challenges.push({ ...item, sourceKey, local: local ? { id: local.id, status: local.status, preparation: local.preparation?.phase || 'ready' } : null });
			}
			const counts = new Map();
			for (const item of challenges) counts.set(String(item.id), (counts.get(String(item.id)) || 0) + 1);
			for (const item of challenges) item.ambiguousId = counts.get(String(item.id)) > 1;
			return { ok: true, challenges, possiblyTruncated: !!list.possiblyTruncated, connection, workspace, sessionId };
		} catch (error) { return { ok: false, code: error.code || 'PLATFORM_DISCOVERY_FAILED', error: String(error.message || error) }; }
	}
	async function list(payload = {}) {
		const result = await discover(payload);
		if (!result.ok) return result;
		for (const [key, snapshot] of snapshots) if (snapshot.expiresAt <= Date.now()) snapshots.delete(key);
		const snapshotId = crypto.randomUUID(), expiresAt = Date.now() + ttlMs;
		snapshots.set(snapshotId, { ...result, challenges: structuredClone(result.challenges), expiresAt });
		while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
		return { ok: true, snapshotId, expiresAt, challenges: result.challenges, possiblyTruncated: result.possiblyTruncated };
	}
	async function importSelected(payload = {}) {
		const snapshot = snapshots.get(String(payload.snapshotId || ''));
		if (!snapshot || snapshot.expiresAt <= Date.now()) return { ok: false, code: 'DISCOVERY_EXPIRED', error: '题目列表已过期，请重新发现题目' };
		if (platforms.current().sessionKey !== snapshot.connection.sessionKey) return { ok: false, code: 'STALE_PLATFORM_CONNECTION', error: '平台连接已变化，请重新发现题目' };
		if (String(payload.sessionId || '') !== snapshot.sessionId || workspaceForRequest(payload) !== snapshot.workspace || snapshot.sessionId && !agentOfSession(snapshot.sessionId))
			return { ok: false, code: 'DISCOVERY_SCOPE_CHANGED', error: '列表所属会话或工作区已变化，请重新发现题目' };
		const keys = Array.isArray(payload.sourceKeys) ? [...new Set(payload.sourceKeys.map(String))] : [];
		if (!keys.length || keys.length > 50) return { ok: false, code: 'SELECTION_INVALID', error: '请选择 1–50 道题目' };
		const candidates = keys.map(key => snapshot.challenges.find(item => item.sourceKey === key));
		if (candidates.some(item => !item || item.solvedByMe || item.local)) return { ok: false, code: 'SELECTION_INVALID', error: '选择包含不可导入的题目，请重新发现题目' };
		const result = await importChallenges({ ids: candidates.map(c => String(c.id)), skipSolved: true, start: payload.start === true, sessionId: snapshot.sessionId }, undefined,
			snapshot.connection, structuredClone(candidates), { workspace: snapshot.workspace, baseDir: snapshot.workspace ? path.join(snapshot.workspace, '.ctf-auto') : baseDirOf() });
		return { ...result, imported: (result.created || []).length, started: (result.created || []).filter(c => ['queued', 'running'].includes(c.status)).map(c => ({ id: c.localId, title: c.title, status: c.status })) };
	}
	async function run(payload = {}) {
		try {
			const result = await discover(payload);
			if (!result.ok) return result;
			const { connection, workspace, sessionId } = result;
			const baseDir = workspace ? path.join(workspace, '.ctf-auto') : baseDirOf();
			const config = getConfig();
			const limit = Math.max(1, Math.min(50, Number(payload.limit) || Number(config.autoFetchLimit) || 5));
			const candidates = result.challenges.filter((c) => !c.solvedByMe && !c.local).slice(0, limit);
			const possiblyTruncated = result.possiblyTruncated;
			if (payload.dryRun === true) return { ok: true, dryRun: true, limit, possiblyTruncated, candidates: candidates.map((c) => ({ id: String(c.id), name: c.name || '', category: c.category || '', value: c.value == null ? null : c.value })) };
			if (!candidates.length) return { ok: true, imported: 0, started: [], candidates: 0, possiblyTruncated, note: possiblyTruncated ? '当前返回的题目已导入或已解；平台列表达到上限，可能还有未显示的题目' : '没有新的未解题可导入' };
			const start = payload.start === true || (payload.start !== false && config.autoSolveImported !== false);
			const imported = await importChallenges({ ids: candidates.map((c) => String(c.id)), skipSolved: true, start, sessionId }, undefined, connection, candidates, { workspace, baseDir });
			const created = imported.created || [];
			const started = created.filter((c) => c.status === 'queued' || c.status === 'running').map((c) => ({ id: c.localId, title: c.title, status: c.status }));
			return { ok: imported.ok, imported: created.length, created, started, skipped: imported.skipped || [], errors: imported.errors || [], candidates: candidates.length, possiblyTruncated,
				...(!imported.ok ? { error: imported.error || '部分题目导入或启动失败，请查看逐题结果' } : {}) };
		} catch (error) { return { ok: false, code: error.code || 'PIPELINE_FAILED', error: String(error.message || error) }; }
	}
	return { run, list, importSelected, status, submit, reconcile, automatic };
}
