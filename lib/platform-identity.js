import { DEFAULT_ORIGIN } from "./mcp-dasctf.js";

// Stable, non-secret identities shared by import, submission and environment operations.
function urlKey(value) {
	try { return new URL(String(value)).href.replace(/\/+$/, ""); }
	catch { return String(value || "").replace(/\/+$/, ""); }
}

export function platformConnectionKey(meta = {}) {
	const kind = String(meta.kind || "ctfd");
	const base = urlKey(meta.baseUrl || (kind === "dasctf" ? DEFAULT_ORIGIN : ""));
	return JSON.stringify([kind, base, kind === "dasctf" ? urlKey(meta.mcpUrl || `${base}/api/ai/v1/mcp`) : "", String(meta.platformSlug || "")]);
}

export function platformChallengeKey(meta = {}) {
	return JSON.stringify([
		platformConnectionKey(meta), String(meta.sourceType || meta.type || "practice"),
		String(meta.groundId || meta.practiceGroundId || ""),
		String(meta.competitionId || ""), String(meta.stageId || ""),
		String(meta.challengeId ?? meta.id ?? "")
	]);
}
