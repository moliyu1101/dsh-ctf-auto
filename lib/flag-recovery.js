import { acceptedFlag, flagContent, usableCandidate } from "./flag-candidates.js";
import { candidateFingerprint } from "./review.js";

// Upgrade persisted evidence without treating a local claim or an alias as a
// remote acceptance. Repeated startup must leave already-repaired data alone.
export function repairFlagHistory(challenge) {
	let changed = false, downgraded = false, repairedAttempts = 0;
	for (const flag of challenge.flags || []) {
		if (challenge.platform && flag.verified && flag.method !== "platform" && !flag.reviewed) {
			if ((challenge.review?.verifiedFlags || []).includes(candidateFingerprint(flag))) flag.reviewed = true;
			else { flag.localVerified = true; flag.verified = false; downgraded = true; }
			changed = true;
		}
		const latest = (challenge.submissionJournal || []).filter((entry) => entry.flag === flag.value && entry.phase === "completed").at(-1);
		const response = latest ? latest.resolution || latest.result : challenge.platformSubmit?.flag === flag.value ? challenge.platformSubmit : null;
		if (response?.status === "correct" && response.verified === true && (flag.method !== "platform" || !flag.verified || flag.rejected)) {
			flag.method = "platform"; flag.verified = true; flag.rejected = false; flag.localVerified = false;
			flag.verifiedAt = latest?.updatedAt || challenge.platformSubmit?.at || null;
			flag.evidence = `平台提交回显：correct ${response.message || ""}`.trim();
			changed = true;
		}
		if (["incorrect", "wrong", "rejected"].includes(response?.status) && !flag.rejected) {
			flag.verified = false; flag.localVerified = false; flag.reviewed = false; flag.rejected = true;
			flag.rejectedAt = latest?.updatedAt || challenge.platformSubmit?.at || null;
			flag.rejectionReason = response.message || response.status;
			changed = downgraded = true;
		}
	}
	const score = (flag) => acceptedFlag(challenge, flag) ? 3 : usableCandidate(flag) ? 2 : flag.rejected ? 0 : 1;
	const unique = new Map();
	for (const flag of challenge.flags || []) {
		const key = flagContent(flag.value), previous = unique.get(key);
		if (!previous || score(flag) > score(previous)) unique.set(key, flag);
	}
	if (unique.size !== (challenge.flags || []).length) { challenge.flags = [...unique.values()]; changed = true; }
	const accepted = (challenge.flags || []).filter((flag) => acceptedFlag(challenge, flag));
	if (challenge.platform && challenge.status === "solved" && !accepted.length && !["correct", "already_solved"].includes(challenge.platformSubmit?.status)) {
		challenge.status = "stuck";
		challenge.stuckReason = "历史本地校验尚未获得平台确认，可提交候选或手动重试";
		changed = downgraded = true;
	}
	for (const attempt of challenge.attempts || []) {
		const flag = accepted.find((flag) => {
			const entry = (challenge.submissionJournal || []).filter((row) => row.flag === flag.value && (row.resolution || row.result)?.status === "correct").at(-1);
			const verifiedAt = flag.verifiedAt ?? entry?.updatedAt ?? (challenge.platformSubmit?.flag === flag.value && challenge.platformSubmit.status === "correct" ? challenge.platformSubmit.at : null);
			return flag.attempt === attempt.n && Number.isFinite(verifiedAt) && verifiedAt >= attempt.startedAt && verifiedAt <= attempt.endedAt;
		});
		if (!flag || !["aborted", "timeout"].includes(attempt.status)) continue;
		attempt.previousSummary = attempt.summary;
		attempt.status = "completed"; attempt.stopReason = "verified-stop"; attempt.summary = `已验证 flag：${flag.value}`;
		for (const event of challenge.events || []) if (event.kind === "attempt-end" && event.attempt === attempt.n) event.text = `第 ${attempt.n} 次尝试结束：${attempt.summary}`;
		for (const fact of challenge.facts || []) if (fact.attempt === attempt.n && fact.text?.startsWith(`[中断] 第 ${attempt.n} 次尝试`)) fact.text = `[结论] 第 ${attempt.n} 次尝试：${attempt.summary}`;
		changed = true; repairedAttempts++;
	}
	return { changed, downgraded, repairedAttempts };
}
