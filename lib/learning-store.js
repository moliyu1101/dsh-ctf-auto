import path from "node:path";
import { createJsonRepository } from "./json-repository.js";
import { normalizeCard } from "./memory.js";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function version(raw, max) {
	if (!object(raw)) throw new Error("根节点必须是对象，原文件已保留");
	if (raw.version != null && (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > max)) throw Object.assign(new Error("版本不受支持，原文件已保留"), { code: "JSON_UNSUPPORTED_VERSION" });
}
function memoryData(raw) {
	version(raw, 2);
	if (!Array.isArray(raw.cards)) throw new Error("cards 必须是数组，原文件已保留");
	const cards = raw.cards.map((card) => {
		if (!object(card) || !(card.id || card.sourceChallengeId || card.slug)) throw new Error("存在无法识别的打法卡，原文件已保留");
		version(card, 2);
		const normalized = normalizeCard(card);
		return { ...card, ...normalized, verification: { ...card.verification, ...normalized.verification },
			metrics: { ...card.metrics, ...normalized.metrics }, links: { ...card.links, ...normalized.links } };
	});
	return { ...raw, version: 2, cards };
}
function usageData(raw) {
	version(raw, 1);
	if (!object(raw.entries) || Object.values(raw.entries).some((row) => !object(row))) throw new Error("entries 必须是使用记录对象，原文件已保留");
	if (Object.values(raw.entries).some((row) => ["used", "usedOk", "lastUsedAt"].some((key) => row[key] != null && (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0)))) throw new Error("使用记录包含无效计数，原文件已保留");
	return { ...raw, version: 1 };
}

export function createLearningStore({ memoryPath, legacyPaths, usagePath }) {
	const memories = new Map(), visited = new Set(), locations = new Set();
	let previous = "", migrationError = null;
	function repository(file) {
		const key = path.resolve(file);
		if (!memories.has(key)) memories.set(key, createJsonRepository({ file: key, label: "记忆库", empty: () => ({ version: 2, cards: [] }), normalize: memoryData }));
		return memories.get(key);
	}
	const usage = createJsonRepository({ file: usagePath(), label: "知识使用统计", empty: () => ({ version: 1, entries: {} }), normalize: usageData });
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
	return {
		readMemory: () => currentMemory().read().value,
		updateMemory: (operation) => currentMemory().update(operation),
		readUsage: () => usage.read().value,
		updateUsage: (operation) => usage.update(operation),
		memoryLocations: () => [...new Set([...locations, memoryPath(), ...legacyPaths()].map((file) => path.resolve(file)))],
		removeSource(file, id) {
			const repo = path.resolve(file) === path.resolve(memoryPath()) ? currentMemory() : repository(file);
			return repo.update((draft) => { draft.cards = draft.cards.filter((card) => card.sourceChallengeId !== id); });
		},
		status: () => ({ memory: { ...repository(memoryPath()).status(), migrationError: migrationError?.file === path.resolve(memoryPath()) ? migrationError : null }, knowledgeUsage: usage.status() })
	};
}
