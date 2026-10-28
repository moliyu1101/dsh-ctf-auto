import test from "node:test";
import assert from "node:assert/strict";
import { platformConnectionKey, platformChallengeKey } from "../../lib/platform-identity.js";

test("platform identities normalize URLs and distinguish source scopes without including secrets", () => {
	const meta = { kind: "dasctf", baseUrl: "https://ctf.example", challengeId: "1", competitionId: "c", stageId: "s" };
	assert.equal(platformConnectionKey(meta), platformConnectionKey({ ...meta, baseUrl: "https://CTF.example/", apiToken: "secret" }));
	assert.equal(platformConnectionKey({ kind: "dasctf" }), platformConnectionKey({ kind: "dasctf", baseUrl: "https://ctf2.dasctf.com" }));
	for (const patch of [{ competitionId: "other" }, { stageId: "other" }, { groundId: "other" }, { challengeId: "other" }, { baseUrl: "https://other.example" }, { mcpUrl: "https://ctf.example/custom" }]) {
		assert.notEqual(platformChallengeKey(meta), platformChallengeKey({ ...meta, ...patch }));
	}
});
