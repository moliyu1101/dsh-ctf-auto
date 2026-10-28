import crypto from "node:crypto";

export function candidateFingerprint(flag) {
	return crypto.createHash("sha256").update(JSON.stringify([flag.value, flag.method, flag.evidence])).digest("hex");
}

// Bind review results to the exact candidate set and its supporting evidence.
export function reviewFingerprint(challenge) {
	const flags = (challenge?.flags || []).filter((flag) => flag?.verified)
		.map((flag) => [flag.value, flag.method, flag.evidence]);
	return crypto.createHash("sha256").update(JSON.stringify(flags)).digest("hex");
}

export function parseReviewVerdict(text) {
	let fenced = false;
	const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => {
		if (/^(```|~~~)/.test(line)) { fenced = !fenced; return false; }
		return !fenced;
	});
	const matches = lines.filter((line) => /^REVIEW:\s*(VERIFIED|REJECTED)$/i.test(line));
	if (matches.length !== 1 || !lines.slice(lines.indexOf(matches[0]) + 1).some(Boolean)) return "inconclusive";
	return /VERIFIED$/i.test(matches[0]) ? "verified" : "rejected";
}
