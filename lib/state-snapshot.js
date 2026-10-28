import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export function freezeSnapshot(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) freezeSnapshot(item);
		Object.freeze(value);
	}
	return value;
}

// Content revisions also detect writes made through the legacy mutable API.
// They are process-local concurrency checks, not cross-process database locks.
export function challengeRevision(challenge) {
	return crypto.createHash("sha256").update(JSON.stringify(challenge)).digest("hex");
}

export function readChallengeSnapshot(challenge) {
	if (!challenge) return undefined;
	return Object.freeze({ revision: challengeRevision(challenge), challenge: freezeSnapshot(structuredClone(challenge)) });
}

export function applyChallengeDraft(challenge, draft) {
	// Clone everything that may be installed before touching the live object.
	const committed = structuredClone(draft);
	let changed = false;
	for (const key of Object.keys(challenge)) if (!Object.hasOwn(committed, key)) { delete challenge[key]; changed = true; }
	for (const [key, value] of Object.entries(committed)) {
		if (isDeepStrictEqual(challenge[key], value) && Object.hasOwn(challenge, key)) continue;
		Object.defineProperty(challenge, key, { value, writable: true, enumerable: true, configurable: true });
		changed = true;
	}
	return changed;
}
