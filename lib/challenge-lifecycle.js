import { candidateFingerprint, reviewFingerprint } from "./review.js";

export function pendingReviewCandidates(challenge) {
	const accepted = new Set(challenge.review?.verifiedFlags || []);
	return (challenge.flags || []).filter((flag) => flag?.verified && flag.method !== "platform" && !accepted.has(candidateFingerprint(flag)));
}

export function submissionState(challenge) {
	if (!challenge.platform) return "not_required";
	const record = challenge.platformSubmit;
	if (!record) return "not_started";
	if (record.status === "pending") return "pending";
	if (record.status === "correct") return "accepted";
	if (record.status === "already_solved") return "already_solved";
	if (record.outcomeUnknown === true) return "unknown";
	if (["incorrect", "wrong", "rejected"].includes(record.status)) return "rejected";
	if (["network", "timeout", "PLATFORM_REQUEST_FAILED"].includes(record.code)) return "unknown";
	return "failed";
}

export function challengeLifecycle(challenge, runtime = {}) {
	const flags = (challenge.flags || []).filter((flag) => flag?.verified);
	const pending = pendingReviewCandidates(challenge);
	const needsReview = runtime.reviewerEnabled === true && pending.length > 0;
	const reviewExhausted = challenge.review?.fingerprint === reviewFingerprint(challenge) && Number(challenge.review.attempts) >= 3;
	let verification = "none";
	if ((challenge.flags || []).length) verification = "candidate";
	if (challenge.review?.status === "rejected" && !flags.length) verification = "rejected";
	if (flags.length) verification = "local";
	if (flags.length && !pending.length) verification = "reviewed";
	if (flags.some((flag) => flag.method === "platform")) verification = "platform";
	const execution = ({ queued: "queued", running: "running", stopped: "stopped", failed: "failed", stuck: "blocked", solved: "completed" })[challenge.status] || "unknown";
	const submission = submissionState(challenge);
	const blockers = [];
	if (runtime.reviewActive) blockers.push("review_active");
	if (needsReview) blockers.push("review_required");
	if (runtime.submissionActive) blockers.push("submission_active");
	if (["pending", "unknown"].includes(submission)) blockers.push("submission_unresolved");
	if (submission === "rejected") blockers.push("submission_rejected");
	return {
		execution, verification, submission,
		environment: challenge.environment?.status || "not_allocated",
		review: { required: needsReview, pendingCandidates: pending.length, active: !!runtime.reviewActive, exhausted: reviewExhausted },
		blockers,
		permissions: {
			start: !["running", "completed"].includes(execution),
			retry: execution !== "completed",
			distill: execution === "completed" && flags.length > 0 && blockers.length === 0,
			autoSubmit: runtime.autoSubmitEnabled !== false && !runtime.reviewActive && !needsReview && flags.length > 0 && !runtime.submissionActive && !["pending", "unknown"].includes(submission),
			enqueueSubmission: runtime.autoSubmitEnabled !== false && !runtime.reviewActive && !needsReview && flags.length > 0 && submission !== "unknown" && (submission !== "pending" || !!runtime.submissionActive),
			releaseEnvironment: !["queued", "running"].includes(execution) && !runtime.reviewActive && !runtime.submissionActive
				&& !["pending", "unknown"].includes(submission) && !(execution === "completed" && needsReview && !reviewExhausted)
		}
	};
}

export function canAutomaticallySubmit(challenge, flag, runtime) {
	return challengeLifecycle(challenge, runtime).permissions.enqueueSubmission
		&& (challenge.flags || []).some((candidate) => candidate?.verified && candidate.value === flag);
}
