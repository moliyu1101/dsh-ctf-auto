import fs from "node:fs";
import path from "node:path";

// Bound the scan and never follow symlinks from untrusted challenge workspaces.
export function progressStamp(challenge = {}) {
	const facts = challenge.facts || [], events = (challenge.events || []).filter((event) => !["watchdog", "experiment", "swarm"].includes(event.kind));
	const stamp = [(challenge.experiments || []).map((row) => [row.key, row.epoch, row.status, row.observedResult, row.evidence?.map((ref) => ref.sha256)]), facts.length, facts.at(-1)?.at, facts.at(-1)?.text, events.at(-1)?.at, events.at(-1)?.text];
	let left = 256;
	function walk(file, depth) {
		if (left-- <= 0 || depth > 4) return;
		try {
			const stat = fs.lstatSync(file);
			if (stat.isSymbolicLink()) return;
			if (stat.isFile()) stamp.push(file, stat.size, stat.mtimeMs);
			else if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) { if (left <= 0) break; walk(path.join(file, name), depth + 1); }
		} catch { /* Missing outputs have no progress. */ }
	}
	let safeRoot = false;
	try { safeRoot = fs.lstatSync(challenge.dir).isDirectory() && !fs.lstatSync(challenge.dir).isSymbolicLink(); } catch { /* no workspace */ }
	if (safeRoot) for (const name of ["notes.md", "scripts", "artifacts"]) walk(path.join(challenge.dir, name), 0);
	return JSON.stringify(stamp);
}

export function observeProgress(state, stamp, mono, idleMs) {
	if (stamp !== state.stamp) { state.stamp = stamp; state.lastProgressMono = mono; state.warned = false; }
	if (!idleMs || mono - state.lastProgressMono < idleMs) return null;
	if (!state.warned) { state.warned = true; return "warn"; }
	return mono - state.lastProgressMono >= idleMs * 2 ? "stop" : null;
}
