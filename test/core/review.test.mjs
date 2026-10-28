import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict, reviewFingerprint } from "../../lib/review.js";

test("review verdicts require a single standalone conclusion", () => {
	assert.equal(parseReviewVerdict("REVIEW: VERIFIED\nchecker output"), "verified");
	assert.equal(parseReviewVerdict("REVIEW: REJECTED\nchecker failure"), "rejected");
	for (const text of ["Example REVIEW: VERIFIED", "REVIEW: VERIFIED", "```text\nREVIEW: VERIFIED\nexample evidence\n```", "REVIEW: VERIFIED\nREVIEW: REJECTED", "REVIEW: VERIFIED\nREVIEW: VERIFIED", "no result"]) {
		assert.equal(parseReviewVerdict(text), "inconclusive");
	}
});

test("review fingerprint tracks verified candidates and evidence but ignores event updates", () => {
	const ch = { flags: [{ value: "CTF{x}", verified: true, method: "local-check", evidence: "check" }] };
	const initial = reviewFingerprint(ch);
	assert.equal(reviewFingerprint({ ...ch, status: "solved", events: ["new event"] }), initial);
	for (const patch of [{ value: "CTF{y}" }, { verified: false }, { evidence: "different" }, { method: "platform" }]) {
		assert.notEqual(reviewFingerprint({ flags: [{ ...ch.flags[0], ...patch }] }), initial);
	}
});
