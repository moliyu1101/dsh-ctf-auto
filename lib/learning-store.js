import path from "node:path";
import { createJsonRepository } from "./json-repository.js";
import { normalizeCard } from "./memory.js";
import { validateMemoryEvidence } from "./learning-evidence.js";
import { validateFeedback } from "./learning-feedback.js";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function version(raw, max) {
	if (!object(raw)) throw new Error("根节点必须是对象，原文件已保留");
	if (raw.version != null && (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > max)) throw Object.assign(new Error("版本不受支持，原文件已保留"), { code: "JSON_UNSUPPORTED_VERSION" });
}
function validateReceipts(raw) {
	if (raw.usageReceipts == null) return;
	if (!object(raw.usageReceipts) || Object.values(raw.usageReceipts).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("使用统计去重进度无效，原文件已保留");
}
function memoryData(raw) {
	version(raw, 2);
	validateReceipts(raw);
	if (!Array.isArray(raw.cards)) throw new Error("cards 必须是数组，原文件已保留");
	const cards = raw.cards.map((card) => {
		if (!object(card) || !(card.id || card.sourceChallengeId || card.slug)) throw new Error("存在无法识别的打法卡，原文件已保留");
		version(card, 2);
		validateMemoryEvidence(card);
		const normalized = normalizeCard(card);
		return { ...card, ...normalized, verification: { ...card.verification, ...normalized.verification },
			metrics: { ...card.metrics, ...normalized.metrics }, links: { ...card.links, ...normalized.links } };
	});
	return { ...raw, version: 2, cards };
}
function usageData(raw) {
	version(raw, 1);
	validateReceipts(raw);
	if (!object(raw.entries) || Object.values(raw.entries).some((row) => !object(row))) throw new Error("entries 必须是使用记录对象，原文件已保留");
	if (Object.values(raw.entries).some((row) => ["used", "usedOk", "lastUsedAt"].some((key) => row[key] != null && (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0)))) throw new Error("使用记录包含无效计数，原文件已保留");
	return { ...raw, version: 1 };
}

export function createLearningStore({ memoryPath, legacyPaths, usagePath, feedbackPath = () => path.join(path.dirname(usagePath()), "learning-feedback.json") }) {
	const memories = new Map(), visited = new Set(), locations = new Set();
	let previous = "", migrationError = null;
	function repository(file) {
		const key = path.resolve(file);
		if (!memories.has(key)) memories.set(key, createJsonRepository({ file: key, label: "记忆库", empty: () => ({ version: 2, cards: [] }), normalize: memoryData }));
		return memories.get(key);
	}
	const usage = createJsonRepository({ file: usagePath(), label: "知识使用统计", empty: () => ({ version: 1, entries: {} }), normalize: usageData });
	const feedback = createJsonRepository({ file: feedbackPath(), label: "学习效果反馈", empty: () => ({ version: 1, entries: {} }), normalize: validateFeedback });
	function currentMemory() {
		const file = path.resolve(memoryPath()), target = repository(file);
		locations.add(file);
		if (visited.has(file)) return target;
		try {
			if (target.read().missing) {
				for (const source of [...new Set([previous, ...legacyPaths()].filter(Boolean).map((item) => path.resolve(item)))]) {
					if (source === file) continue;
					locations.add(source);
					const snapshot = repository(source).read();
					if (snapshot.missing) continue;
					target.commit(snapshot.value, "missing");
					break;
				}
			}
			visited.add(file); previous = file; migrationError = null;
			return target;
		} catch (error) { migrationError = { file, code: error.code, message: error.message, at: Date.now() }; throw error; }
	}
	function applyUsage(kind, event) {
		if (event.version !== 1 || typeof event.streamId !== "string" || !event.streamId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isFinite(event.at) || event.at < 0) throw new Error("使用统计事件格式无效");
		if (!["memory", "knowledge"].includes(kind)) throw new Error("未知的使用统计类型");
		const part = event[kind];
		if (!Array.isArray(part?.ids) || part.ids.some((id) => typeof id !== "string" || !id)) throw new Error("使用统计引用无效");
		if (kind === "memory" && (typeof part.file !== "string" || !path.isAbsolute(part.file))) throw new Error("使用统计缺少召回时的记忆库路径");
		const repo = kind === "memory" ? repository(part.file) : usage;
		if (kind === "memory") locations.add(path.resolve(part.file));
		return repo.update((data) => {
			const cursor = Object.hasOwn(data.usageReceipts || {}, event.streamId) ? data.usageReceipts[event.streamId] : 0;
			if (cursor >= event.sequence) return;
			const selected = new Set(part.ids);
			if (kind === "memory") {
				for (const card of data.cards) {
					if (!selected.has(String(card.id))) continue;
					card.used = (Number(card.used) || 0) + 1;
					card.usedOk = (Number(card.usedOk) || 0) + (event.solved ? 1 : 0);
					card.metrics = { ...card.metrics, used: card.used, usedOk: card.usedOk, successRate: Math.round(card.usedOk / card.used * 100) / 100 };
					card.lastUsedAt = Math.max(Number(card.lastUsedAt) || 0, event.at);
				}
			} else {
				for (const key of selected) {
					const row = Object.hasOwn(data.entries, key) ? data.entries[key] : { used: 0, usedOk: 0 };
					row.used = (Number(row.used) || 0) + 1;
					row.usedOk = (Number(row.usedOk) || 0) + (event.solved ? 1 : 0);
					row.lastUsedAt = Math.max(Number(row.lastUsedAt) || 0, event.at);
					Object.defineProperty(data.entries, key, { value: row, writable: true, enumerable: true, configurable: true });
				}
			}
			data.usageReceipts ??= {};
			Object.defineProperty(data.usageReceipts, event.streamId, { value: event.sequence, writable: true, enumerable: true, configurable: true });
		}, { requireExisting: kind === "memory" });
	}
	return {
		readMemory: () => currentMemory().read().value,
		updateMemory: (operation) => currentMemory().update(operation),
		readUsage: () => usage.read().value,
		updateUsage: (operation) => usage.update(operation),
		readFeedback: () => feedback.read().value,
		updateFeedback: (operation) => feedback.update(operation),
		applyUsage,
		memoryLocations: () => [...new Set([...locations, memoryPath(), ...legacyPaths()].map((file) => path.resolve(file)))],
		removeSource(file, id) {
			const repo = path.resolve(file) === path.resolve(memoryPath()) ? currentMemory() : repository(file);
			return repo.update((draft) => { draft.cards = draft.cards.filter((card) => card.sourceChallengeId !== id); });
		},
		status: () => ({ memory: { ...repository(memoryPath()).status(), migrationError: migrationError?.file === path.resolve(memoryPath()) ? migrationError : null }, knowledgeUsage: usage.status(), feedback: feedback.status() })
	};
}
