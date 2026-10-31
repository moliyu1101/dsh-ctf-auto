import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildTarGz } from './pack.js';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => !!a && !!b && path.resolve(a) === path.resolve(b);
const within = (file, dir) => { const rel = path.relative(path.resolve(dir), path.resolve(file)); return rel === '' || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
const json = value => JSON.stringify(value, (_key, item) => { if (typeof item === 'number' && !Number.isFinite(item)) throw Error('会话包含非有限数值，无法无损导出'); return item; });

// Export the canonical host event stream, not a reconstructed conversation.
export async function exportWorkspaceSessions({ workspace, currentSessionId, persistence, sessions, agents, attachments, challenges = [], outputDir, check = () => {} }) {
	check();
	if (!workspace || !path.isAbsolute(workspace)) throw Error('导出需要有效工作区');
	const startedAt = Date.now(), issues = [], files = [], records = [], media = new Map();
	let bytes = 0;
	const MAX_BYTES = 256 * 1024 * 1024;
	function add(name, data) {
		const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
		if (bytes + content.length > MAX_BYTES) throw Error('导出超过 256MiB 上限；未生成截断归档');
		bytes += content.length; files.push({ name, data: content });
		return { path: name, bytes: content.length, sha256: hash(content) };
	}
	const live = new Map();
	for (const session of sessions?.list?.() || []) if (session?.header?.id) live.set(String(session.header.id), session);
	for (const agent of agents?.roots?.() || []) if (agent?.session) live.set(String(agent.id), agent.session);
	const catalog = new Map();
	let catalogAvailable = false;
	if (persistence?.list) {
		try { for (const row of await persistence.list()) if (row?.header?.id) catalog.set(String(row.header.id), row.header); catalogAvailable = true; }
		catch { issues.push({ type: 'catalog', reason: '持久化会话目录读取失败，归档可能缺少历史会话' }); }
	}
	for (const [id, session] of live) if (session.header) catalog.set(id, session.header);
	if (!catalogAvailable) issues.push({ type: 'catalog', reason: '无法列出持久化历史会话，仅能发现当前内存会话' });
	if (!catalog.size) throw Error('宿主未提供可导出的会话；请检查 sessions/sessionPersistence 服务');
	const selected = new Set();
	for (const [id, header] of catalog) if (same(header.cwd, workspace)) selected.add(id);
	const expected = new Set([String(currentSessionId)]);
	for (const ch of challenges) {
		if (ch.driverSession) expected.add(String(ch.driverSession));
		for (const a of ch.attempts || []) {
			if (a.sessionId) expected.add(String(a.sessionId));
			for (const worker of a.swarmWorkers || []) if (worker.sessionId) expected.add(String(worker.sessionId));
		}
		if (ch.review?.sessionId) expected.add(String(ch.review.sessionId));
		for (const task of ch.taskJournal || []) for (const id of task.sessionIds || []) expected.add(String(id));
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [id, header] of catalog) if (!selected.has(id) && header.parentSession && selected.has(String(header.parentSession))) { selected.add(id); changed = true; }
	}
	for (const id of expected) {
		const header = catalog.get(id);
		if (header && (same(header.cwd, workspace) || header.cwd && challenges.some(ch => ch.dir && within(header.cwd, ch.dir)))) selected.add(id);
		if (!selected.has(id)) issues.push({ type: 'session', id, reason: '题目关联会话缺失或无法确认其工作区归属' });
	}
	if (selected.size > 1000) throw Error('工作区会话超过 1000 个，未生成不完整归档');
	// Resolve any newly selected indexed child's descendants as well.
	changed = true;
	while (changed) { changed = false; for (const [id, header] of catalog) if (!selected.has(id) && header.parentSession && selected.has(String(header.parentSession))) { selected.add(id); changed = true; } }
	if (selected.size > 1000) throw Error('工作区会话超过 1000 个，未生成不完整归档');
	// Force admitted live events through the official durability barrier first.
	if (sessions?.flush) for (const id of selected) if (live.has(id)) { try { await sessions.flush(live.get(id)); } catch { issues.push({ type: 'flush', id, reason: '宿主会话事件刷新失败' }); } }
	if (persistence?.flush) { try { await persistence.flush(); } catch { issues.push({ type: 'flush', reason: '会话持久化刷新失败，导出可能落后于当前对话' }); } }
	function scanMedia(events) {
		const pending = [events], seen = new Set(), ids = new Set();
		while (pending.length) {
			const value = pending.pop();
			if (!value || typeof value !== 'object' || seen.has(value)) continue;
			seen.add(value);
			if (seen.size > 1000000) throw Error('会话结构超过可检查上限');
			if (['image', 'file'].includes(value.type)) {
				const ref = value.attachment;
				if (ref?.attachmentId) { media.set(value.type + ':' + ref.attachmentId, { kind: value.type, ref }); ids.add(String(ref.attachmentId)); }
				else issues.push({ type: 'attachment', reason: '发现不支持的外部或旧格式附件引用，原引用已保留' });
			}
			if (value.type === 'image_url') issues.push({ type: 'attachment', reason: '外部图片引用仅保留在事件中，未联网下载' });
			for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
		}
		return [...ids];
	}
	for (const id of [...selected].sort()) {
		check(); let handle;
		try {
			let header, events, inheritedEventCount, source;
			if (persistence?.open) {
				handle = await persistence.open(id, 'read');
				const snapshot = await handle.read(0, 1000001);
				events = Array.isArray(snapshot) ? snapshot : snapshot?.events;
				header = handle.header; inheritedEventCount = handle.inheritedEventCount; source = 'sessionPersistence';
			} else {
				const session = live.get(id);
				if (typeof session?.snapshotEvents !== 'function') throw Error('会话完整事件读取接口不可用');
				events = session.snapshotEvents(); header = session.header; inheritedEventCount = session.inheritedEventCount; source = 'live-memory';
				issues.push({ type: 'session', id, reason: '仅导出内存事件，无法核对持久化记录' });
			}
			if (events?.length > 1000000) throw Error('会话事件超过 100 万条，未截断导出');
			if (!Array.isArray(events) || !header || String(header.id) !== id) throw Error('会话数据格式或身份不一致');
			for (let index = 0; index < events.length; index++) if (events[index].seq !== index) throw Error('会话事件序号不连续');
			const eventData = events.map(event => json(event)).join('\n') + (events.length ? '\n' : '');
			// Hold the bytes until the per-challenge layout is known: a session shared by
			// several challenges is written into each of those folders, never into a
			// shared side directory.
			const record = { id, parentSession: header.parentSession || null, cwd: header.cwd || null, source, eventCount: events.length,
				inheritedEventCount: inheritedEventCount ?? null, headerData: Buffer.from(json(header) + '\n'), eventData: Buffer.from(eventData), attachmentIds: [], copies: [] };
			record.attachmentIds = scanMedia(events).map(String); records.push(record);
			if (Number.isFinite(live.get(id)?.seq) && live.get(id).seq > events.length) issues.push({ type: 'session', id, reason: '导出期间会话仍有新事件，请结束解题后再次导出最终版本' });
		} catch (error) { issues.push({ type: 'session', id, reason: String(error.message || error) }); }
		finally { if (handle) await handle.close(); }
	}
	const attachmentRecords = [];
	for (const [id, { kind, ref }] of media) {
		check();
		try {
			if (!Number.isFinite(ref.bytes) || ref.bytes < 0 || ref.bytes > 64 * 1024 * 1024) throw Error('附件大小无效或超过 64MiB');
			let data;
			if (kind === 'image') data = Buffer.from((await attachments.readImage(ref)).data);
			else {
				const chunks = []; let length = 0;
				for await (const chunk of attachments.readFileStream(ref)) { length += chunk.length; if (length > ref.bytes || length > 64 * 1024 * 1024) throw Error('附件超出声明长度'); chunks.push(Buffer.from(chunk)); }
				data = Buffer.concat(chunks);
			}
			if (data.length !== ref.bytes) throw Error('附件字节长度与引用不一致');
			if (kind === 'file' && /^[a-f0-9]{64}$/i.test(String(ref.attachmentId)) && hash(data) !== ref.attachmentId.toLowerCase()) throw Error('附件摘要与引用不一致');
			const extension = kind === 'image' ? ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[ref.mediaType] || '.bin') : (/^\.[a-z0-9]{1,8}$/i.test(path.extname(ref.name || '')) ? path.extname(ref.name).toLowerCase() : '.bin');
			attachmentRecords.push({ attachmentId: String(ref.attachmentId), kind, originalName: ref.name || '', mediaType: ref.mediaType || '', extension, data, copies: [] });
		} catch { issues.push({ type: 'attachment', id: ref.attachmentId, reason: '附件无法读取、超限或完整性核验失败；原引用已保留' }); }
	}
	if (!records.length) throw Error('没有成功读取任何会话原始事件，未生成归档');
	if (challenges.some(ch => ch.status === 'running' || ch.status === 'queued')) issues.push({ type: 'active-run', reason: '工作区仍有运行或排队题目，当前导出只是时间点快照' });
	const safeName = value => String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '').slice(0, 45) || 'untitled';
	const rootName = 'workspace-' + safeName(path.basename(workspace)) + '-' + hash(workspace).slice(0, 8);
	const recordById = new Map(records.map(record => [record.id, record]));
	const attachmentById = new Map(attachmentRecords.map(record => [record.attachmentId, record]));
	const questionFolders = challenges.map(ch => ({ id: ch.id, title: ch.title || ch.id, folder: rootName + '/challenge-' + safeName(ch.title || ch.id) + '-' + hash(String(ch.id)).slice(0, 8), sessionIds: new Set() }));
	// Every challenge folder is self-contained: its own sessions, the ancestors that
	// produced them (usually the workspace main session) and the attachments those
	// sessions reference. A shared main session is copied per challenge on purpose.
	for (let index = 0; index < challenges.length; index++) {
		const ch = challenges[index], folder = questionFolders[index], seeds = new Set();
		for (const attempt of ch.attempts || []) { if (attempt.sessionId) seeds.add(String(attempt.sessionId)); for (const worker of attempt.swarmWorkers || []) if (worker.sessionId) seeds.add(String(worker.sessionId)); }
		if (ch.review?.sessionId) seeds.add(String(ch.review.sessionId));
		for (const task of ch.taskJournal || []) for (const id of task.sessionIds || []) seeds.add(String(id));
		for (const record of records) if (record.cwd && ch.dir && within(record.cwd, ch.dir)) seeds.add(record.id);
		for (const id of seeds) if (recordById.has(id)) folder.sessionIds.add(id);
		// Descendants first: a solver's own swarm workers belong to this challenge.
		// The driver session joins afterwards as an ancestor so that the shared main
		// session is copied in, without dragging every other challenge's subagents.
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const record of records) if (!folder.sessionIds.has(record.id) && record.parentSession && folder.sessionIds.has(String(record.parentSession))) { folder.sessionIds.add(record.id); expanded = true; }
		}
		if (ch.driverSession && recordById.has(String(ch.driverSession))) folder.sessionIds.add(String(ch.driverSession));
		expanded = true;
		while (expanded) {
			expanded = false;
			for (const id of [...folder.sessionIds]) {
				const parent = recordById.get(id)?.parentSession;
				if (parent && recordById.has(String(parent)) && !folder.sessionIds.has(String(parent))) { folder.sessionIds.add(String(parent)); expanded = true; }
			}
		}
	}
	const assigned = new Set();
	for (const folder of questionFolders) for (const id of folder.sessionIds) assigned.add(id);
	const unowned = records.filter(record => !assigned.has(record.id));
	function writeSessionCopy(record, directory, scope) {
		const stem = directory + '/sessions/' + hash(record.id).slice(0, 24);
		const copy = { scope, header: add(stem + '.header.json', record.headerData), events: add(stem + '.events.jsonl', record.eventData) };
		record.copies.push(copy);
		return copy;
	}
	function writeAttachmentCopies(ids, directory, scope) {
		for (const id of [...ids].sort()) {
			const attachment = attachmentById.get(id);
			if (!attachment || attachment.copies.some(copy => copy.scope === scope)) continue;
			try { attachment.copies.push({ scope, ...add(directory + '/attachments/' + hash(id) + attachment.extension, attachment.data) }); }
			catch (error) { issues.push({ type: 'attachment', id, reason: '附件写入归档失败：' + String(error.message || error) }); }
		}
	}
	for (let index = 0; index < questionFolders.length; index++) {
		const folder = questionFolders[index], ch = challenges[index], linked = [], mediaIds = new Set();
		for (const id of [...folder.sessionIds].sort()) {
			const record = recordById.get(id);
			const copy = writeSessionCopy(record, folder.folder, 'challenge:' + ch.id);
			linked.push({ id: record.id, parentSession: record.parentSession, eventCount: record.eventCount, header: copy.header, events: copy.events });
			for (const attachmentId of record.attachmentIds) mediaIds.add(attachmentId);
		}
		writeAttachmentCopies(mediaIds, folder.folder, 'challenge:' + ch.id);
		add(folder.folder + '/session-index.json', JSON.stringify({ challengeId: ch.id, title: folder.title, sessions: linked, note: '本题用到的会话与附件都在本目录内；跨题共用的主会话在各题目录各存一份，路径以归档根目录为基准。' }, null, 2) + '\n');
		add(folder.folder + '/challenge.json', json({ id: ch.id, title: ch.title, category: ch.category, status: ch.status, driverSession: ch.driverSession }) + '\n');
		if (ch.statement) add(folder.folder + '/statement.md', ch.statement);
	}
	if (unowned.length) {
		const mediaIds = new Set();
		for (const record of unowned) { writeSessionCopy(record, rootName, 'workspace'); for (const attachmentId of record.attachmentIds) mediaIds.add(attachmentId); }
		writeAttachmentCopies(mediaIds, rootName, 'workspace');
	}
	const manifest = { schema: 2, workspace, startedAt, exportedAt: Date.now(), scope: 'workspace-and-descendants', rootFolder: rootName, layout: 'self-contained-challenge-folders',
		challenges: questionFolders.map(({ sessionIds, ...folder }) => ({ ...folder, sessionIds: [...sessionIds].sort() })), complete: issues.length === 0,
		sessions: records.map(({ headerData, eventData, ...record }) => ({ ...record, header: record.copies[0]?.header ?? null, events: record.copies[0]?.events ?? null })),
		attachments: attachmentRecords.map(({ data, ...record }) => ({ ...record, path: record.copies[0]?.path ?? null, bytes: record.copies[0]?.bytes ?? null, sha256: record.copies[0]?.sha256 ?? null })),
		issues, rawEventsUnredacted: true };
	add(rootName + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
	add(rootName + '/README.txt', 'DSH 工作区 AI 对话证据归档\n每题一个 challenge- 目录，该题用到的会话（含跨题共用的主会话）与附件都保存在自己的目录内，不使用共享目录。\n每个会话保留独立 header.json 与原始 events.jsonl，未经摘要或脱敏。\nmanifest.json 记录会话关联、文件 SHA-256、附件和缺失说明。\ncomplete 仅表示此次发现与读取没有报告缺失，不保证赛方审核通过，也不能补回宿主未保存的内容。\n运行中的会话属于时间点快照，比赛结束后应再次导出最终版本。\n');
	check();
	// The destination is supplied by the host, never by the HTTP caller.
	const absolute = path.resolve(outputDir);
	fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
	const destination = fs.lstatSync(absolute);
	if (destination.isSymbolicLink() || !destination.isDirectory()) throw Error('导出目录包含符号链接或非目录');
	const filename = 'workspace-ai-sessions-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex') + '.tar.gz';
	const archive = buildTarGz(files), target = path.join(absolute, filename);
	const fd = fs.openSync(target, 'wx', 0o600);
	try { fs.writeFileSync(fd, archive); fs.fsyncSync(fd); } catch (error) { try { fs.unlinkSync(target); } catch {} throw error; } finally { fs.closeSync(fd); }
	return { archive, path: target, filename, complete: manifest.complete, sessionCount: records.length, attachmentCount: attachmentRecords.length, issues: issues.length };
}
