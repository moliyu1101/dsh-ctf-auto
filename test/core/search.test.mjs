import test from "node:test";
import assert from "node:assert/strict";
import { searchBoard } from "../../lib/search.js";

function board() {
	return {
		order: ["a", "b", "c"],
		challenges: {
			a: {
				id: "a",
				title: "Fish Joy in HTML5",
				category: "web",
				status: "solved",
				statement: "静态 HTML5 捕鱼游戏，flag 在混淆的 Player.js 里",
				createdAt: 1000,
				updatedAt: 2000,
				facts: [
					{ at: 1100, text: "[结论] 混淆块 decodeURIComponent + RC4", attempt: 1 },
					{ at: 1200, text: "[失败] .DS_Store 是诱饵", attempt: 1 }
				],
				attempts: [
					{ n: 1, angle: "recon-first", status: "completed", summary: "解出 flag：静态解码", outputTail: "flag{DASCTF}", error: "", failedPaths: [] }
				],
				flags: [{ value: "flag{DASCTF}", verified: true, evidence: "原版解码函数一致", method: "local-check", attempt: 1, recordedAt: 1300 }]
			},
			b: {
				id: "b",
				title: "2048 小游戏",
				category: "web",
				status: "running",
				statement: "拿到 4096 方块得 flag",
				createdAt: 3000,
				facts: [],
				attempts: [{ n: 1, angle: "recon-first", status: "running", summary: "", outputTail: "", error: "", failedPaths: [] }],
				flags: []
			},
			c: {
				id: "c",
				title: "ROT13",
				category: "crypto",
				status: "stuck",
				statement: "经典 ROT13 编码",
				createdAt: 500,
				facts: [{ at: 600, text: "[卡点] 缺少字典", attempt: 2 }],
				attempts: [],
				flags: [{ value: "CTF{guess}", verified: false, evidence: "", method: "manual", attempt: null, recordedAt: 700 }]
			}
		}
	};
}

test("searchBoard: 空查询返回空", () => {
	assert.deepEqual(searchBoard(board(), ""), []);
	assert.deepEqual(searchBoard(board(), "   "), []);
	assert.deepEqual(searchBoard(null, "x"), []);
});

test("searchBoard: 标题命中排最前、带字段标签与片段", () => {
	const rows = searchBoard(board(), "fish");
	assert.ok(rows.length >= 1);
	assert.equal(rows[0].challengeId, "a");
	assert.equal(rows[0].field, "title");
	assert.equal(rows[0].fieldLabel, "题名");
	assert.equal(rows[0].title, "Fish Joy in HTML5");
	assert.ok(rows[0].snippet.toLowerCase().includes("fish"));
});

test("searchBoard: 搜事实/尝试/flag 证据", () => {
	assert.equal(searchBoard(board(), "rc4")[0].field, "facts");
	assert.equal(searchBoard(board(), "静态解码")[0].field, "attempts");
	assert.equal(searchBoard(board(), "原版解码")[0].field, "flags");
});

test("searchBoard: 多词 AND 过滤", () => {
	assert.equal(searchBoard(board(), "4096 flag").length, 1);
	assert.deepEqual(searchBoard(board(), "4096 不存在"), []);
});

test("searchBoard: 每题目结果上限与全局限额", () => {
	const many = {
		order: ["x"],
		challenges: {
			x: {
				id: "x", title: "same", category: "misc", status: "queued", statement: "same same same",
				createdAt: 1,
				facts: Array.from({ length: 10 }, (_, i) => ({ at: i, text: `same fact ${i}`, attempt: 1 })),
				attempts: [], flags: []
			}
		}
	};
	const perChallenge = searchBoard(many, "same", { maxPerChallenge: 2 });
	assert.ok(perChallenge.length <= 2);
	const limited = searchBoard(many, "same", { limit: 1 });
	assert.equal(limited.length, 1);
});