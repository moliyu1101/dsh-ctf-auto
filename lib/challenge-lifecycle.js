import { candidateFingerprint, reviewFingerprint } from "./review.js";
import { submissionRecords, unresolvedSubmissions } from "./submission-journal.js";
import { unresolvedEnvironmentOperations } from "./environment-journal.js";
import { pendingLearningUsage } from "./learning-usage.js";
import { unresolvedTasks } from "./task-registry.js";

export function pendingReviewCandidates(challenge) {
	const accepted = new Set(challenge.review?.verifiedFlags || []);
	return (challenge.flags || []).filter((flag) => flag?.verified && flag.method !== "platform" && !accepted.has(candidateFingerprint(flag)));
}

export function pendingFlagProjection(challenge) {
	return challenge.localProjection ? challenge.localProjection.pending === true && challenge.localProjection.flagPending !== false : challenge.review?.status === "rejected";
}

export function pendingInputProjection(challenge) {
	return pendingFlagProjection(challenge) || challenge.localProjection?.pending === true && challenge.localProjection.statementPending === true;
}

export function submissionState(challenge) {
	if (!challenge.platform) return "not_required";
	const unresolved = unresolvedSubmissions(challenge);
	if (unresolved.some((entry) => entry.phase === "unknown")) return "unknown";
	if (unresolved.length) return "pending";
	const record = challenge.platformSubmit;
	if (!record) return "not_started";
	if (record.status === "pending") return "pending";
	if (record.status === "correct") return "accepted";
	if (record.status === "already_solved") return "already_solved";
	if (record.outcomeUnknown === true) return "unknown";
	if (["incorrect", "wrong", "rejected"].includes(record.status)) return "rejected";
	if (record.outcomeUnknown !== false && ["network", "timeout", "PLATFORM_REQUEST_FAILED"].includes(record.code)) return "unknown";
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
	const recoveryPending = submissionRecords(challenge).some((entry) => entry.phase === "completed" && entry.applied === false);
	const environmentPending = unresolvedEnvironmentOperations(challenge, runtime.ignoreEnvironmentOperationId).length > 0 || runtime.resourceBlocked === true;
	const resourceBusy = runtime.resourceUsers > 0 || runtime.resourceCleanupActive === true;
	const localProjectionPending = challenge.localProjection?.pending === true || !challenge.localProjection && challenge.review?.status === "rejected";
	const learningUsagePending = pendingLearningUsage(challenge).length;
	const tasks = unresolvedTasks(challenge);
	// A live coordinator uses monotonic leases. Persisted wall timestamps are
	// only a conservative fallback when no runtime authority is available.
	const taskUncertain = typeof runtime.taskBlocked === "boolean" ? runtime.taskBlocked
		: tasks.some((row) => ["unknown", "cancel_requested"].includes(row.phase) || row.expiresAt <= Date.now());
	const blockers = [];
	if (runtime.reviewActive) blockers.push("review_active");
	if (needsReview) blockers.push("review_required");
	if (runtime.submissionActive) blockers.push("submission_active");
	if (["pending", "unknown"].includes(submission)) blockers.push("submission_unresolved");
	if (submission === "rejected") blockers.push("submission_rejected");
	if (recoveryPending) blockers.push("submission_local_recovery");
	if (environmentPending) blockers.push("environment_unresolved");
	if (runtime.environmentActive) blockers.push("environment_active");
	if (resourceBusy) blockers.push("resource_in_use");
	if (localProjectionPending) blockers.push("local_projection_pending");
	if (taskUncertain) blockers.push("task_unresolved");
	return {
		execution, verification, submission, submissionRecoveryPending: recoveryPending, localProjectionPending, learningUsagePending,
		taskUncertain, unresolvedTasks: tasks.length,
		unresolvedSubmissions: unresolvedSubmissions(challenge).length,
		environmentOperationPending: environmentPending,
		environment: challenge.environment?.status || "not_allocated",
		review: { required: needsReview, pendingCandidates: pending.length, active: !!runtime.reviewActive, exhausted: reviewExhausted },
		blockers,
		permissions: {
			remove: !tasks.length && !learningUsagePending && !localProjectionPending && !environmentPending && !runtime.environmentActive && !resourceBusy && !runtime.submissionActive && !recoveryPending && !["pending", "unknown"].includes(submission),
			start: !taskUncertain && !pendingInputProjection(challenge) && !["running", "completed"].includes(execution),
			retry: !taskUncertain && !pendingInputProjection(challenge) && execution !== "completed",
			distill: execution === "completed" && flags.length > 0 && blockers.length === 0,
			autoSubmit: !taskUncertain && !environmentPending && !runtime.resourceCleanupActive && !recoveryPending && runtime.autoSubmitEnabled !== false && !runtime.reviewActive && !needsReview && flags.length > 0 && !runtime.submissionActive && !["pending", "unknown"].includes(submission),
			enqueueSubmission: !taskUncertain && !environmentPending && !runtime.resourceCleanupActive && !recoveryPending && runtime.autoSubmitEnabled !== false && !runtime.reviewActive && !needsReview && flags.length > 0 && submission !== "unknown" && (submission !== "pending" || !!runtime.submissionActive),
			releaseEnvironment: !taskUncertain && !["queued", "running"].includes(execution) && !runtime.reviewActive && !runtime.submissionActive
				&& !environmentPending && !runtime.environmentActive && !resourceBusy && !recoveryPending && !["pending", "unknown"].includes(submission) && !(execution === "completed" && needsReview && !reviewExhausted)
		}
	};
}

export function canAutomaticallySubmit(challenge, flag, runtime) {
	return challengeLifecycle(challenge, runtime).permissions.enqueueSubmission
		&& (challenge.flags || []).some((candidate) => candidate?.verified && candidate.value === flag);
}
