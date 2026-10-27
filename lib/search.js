// dsh-ctf-auto / lib/search.js —— 题板检索。
//
// 纯函数：在题板状态里搜 title/category/statement/facts/attempts/flags，返回带字段与片段的结果。
// 不读磁盘 notes.md（状态库以外的东西由工作台 read 接口负责）。

const FIELD_RANK = {
	title: 0,
	category: 6,
	statement: 1,
	facts: 2,
	attempts: 3,
	flags: 4
};

const FIELD_LABEL = {
	title: "题名",
	category: "模块",
	statement: "题面",
	facts: "事实",
	attempts: "尝试",
	flags: "Flag"
};

const MAX_PER_CHALLENGE = 4;

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function snippetAround(text, needle, radius = 70) {
	const source = String(text ?? "").replace(/\s+/g, " ").trim();
	if (!source) return "";
	const hay = source.toLowerCase();
	const at = hay.indexOf(needle);
	if (at < 0) return source.slice(0, radius * 2);
	const start = Math.max(0, at - radius);
	const end = Math.min(source.length, at + needle.length + radius);
	return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

/**
 * @param {object} state 题板状态（store.state）
 * @param {string} query 关键词（大小写不敏感，空格分词后为 AND）
 * @param {{limit?:number, maxPerChallenge?:number}} options
 * @returns {Array<{challengeId:string,title:string,category:string,status:string,field:string,fieldLabel:string,attempt?:number|null,snippet:string,at:number}>}
 */
export function searchBoard(state, query, options = {}) {
	const rawQuery = String(query ?? "").trim();
	if (!rawQuery) return [];
	const terms = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
	const maxPerChallenge = Math.max(1, Math.min(20, Number(options.maxPerChallenge) || MAX_PER_CHALLENGE));
	const challenges = isPlainObject(state) && isPlainObject(state.challenges) ? state.challenges : {};
	const order = isPlainObject(state) && Array.isArray(state.order) ? state.order : Object.keys(challenges);
	const results = [];

	const matchesAll = (text) => {
		const hay = String(text ?? "").toLowerCase();
		return terms.every((term) => hay.includes(term));
	};
	const push = (challenge, field, text, attempt, at) => {
		if (!matchesAll(text)) return;
		results.push({
			challengeId: String(challenge.id ?? ""),
			title: String(challenge.title ?? ""),
			category: String(challenge.category ?? ""),
			status: String(challenge.status ?? ""),
			field,
			fieldLabel: FIELD_LABEL[field] || field,
			attempt: attempt == null ? null : Number(attempt),
			snippet: snippetAround(text, terms[0]),
			at: Number(at) || 0,
			rank: FIELD_RANK[field] ?? 9
		});
	};

	for (const id of order) {
		const challenge = challenges[id];
		if (!isPlainObject(challenge)) continue;
		let count = 0;
		const pushCapped = (field, text, attempt, at) => {
			if (count >= maxPerChallenge) return;
			const before = results.length;
			push(challenge, field, text, attempt, at);
			if (results.length > before) count += 1;
		};

		pushCapped("title", challenge.title, null, challenge.updatedAt || challenge.createdAt || 0);
		pushCapped("statement", challenge.statement, null, challenge.createdAt || 0);
		pushCapped("category", challenge.category, null, challenge.createdAt || 0);

		for (const fact of Array.isArray(challenge.facts) ? challenge.facts : []) {
			if (!isPlainObject(fact)) continue;
			pushCapped("facts", fact.text, fact.attempt, fact.at);
		}
		for (const attempt of Array.isArray(challenge.attempts) ? challenge.attempts : []) {
			if (!isPlainObject(attempt)) continue;
			const parts = [attempt.summary, attempt.outputTail, attempt.error, ...(Array.isArray(attempt.failedPaths) ? attempt.failedPaths : [])];
			for (const part of parts) {
				if (!part) continue;
				pushCapped("attempts", part, attempt.n, attempt.endedAt || attempt.startedAt || 0);
			}
		}
		for (const flag of Array.isArray(challenge.flags) ? challenge.flags : []) {
			if (!isPlainObject(flag)) continue;
			pushCapped("flags", [flag.value, flag.evidence, flag.method].filter(Boolean).join(" "), flag.attempt, flag.recordedAt);
		}
	}

	results.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : (b.at || 0) - (a.at || 0)));
	return results.slice(0, limit).map(({ rank, ...rest }) => rest);
}