import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export function freezeSnapshot(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) freezeSnapshot(item);
		Object.freeze(value);
	}
	return value;
}

// Content revisions guard optimistic updates between detached reads and drafts.
// They are process-local concurrency checks, not cross-process database locks.
export function challengeRevision(challenge) {
	return crypto.createHash("sha256").update(JSON.stringify(challenge)).digest("hex");
}

export function readChallengeSnapshot(challenge) {
	if (!challenge) return undefined;
	return Object.freeze({ revision: challengeRevision(challenge), challenge: freezeSnapshot(structuredClone(challenge)) });
}

// A snapshot can still belong to the entity after edits, while its scope changed.
export function sameChallengeScope(left, right) {
	return !!left && !!right && left.id === right.id && left.dir === right.dir && left.workspace === right.workspace
		&& isDeepStrictEqual(left.platform, right.platform);
}

export function prepareChallengeDraft(challenge, draft) {
	// Clone everything that may be installed before touching the live object.
	const committed = structuredClone(draft);
	const removals = Object.keys(challenge).filter((key) => !Object.hasOwn(committed, key));
	const changes = [];
	for (const [key, value] of Object.entries(committed)) {
		if (isDeepStrictEqual(challenge[key], value) && Object.hasOwn(challenge, key)) continue;
		changes.push([key, value]);
	}
	function validate() {
		for (const key of [...removals, ...changes.map(([key]) => key)]) {
			const descriptor = Object.getOwnPropertyDescriptor(challenge, key);
			if (descriptor && (!descriptor.configurable || !Object.hasOwn(descriptor, "value"))) throw new Error("题目对象包含不可修改的字段，未安装事务草稿");
			if (!descriptor && !Object.isExtensible(challenge)) throw new Error("题目对象不可扩展，未安装事务草稿");
		}
	}
	validate();
	return { changed: removals.length > 0 || changes.length > 0, validate, apply() {
		for (const key of removals) delete challenge[key];
		for (const [key, value] of changes) Object.defineProperty(challenge, key, { value, writable: true, enumerable: true, configurable: true });
	} };
}

export function applyChallengeDraft(challenge, draft) {
	const prepared = prepareChallengeDraft(challenge, draft);
	prepared.apply();
	return prepared.changed;
}
