/**
 * dsh-ctf-auto / lib/report.js
 * 复盘报告 Markdown 生成（纯函数，无 IO）。
 *
 * 契约：DESIGN.md §10
 *   buildMarkdownReport(state, { generatedAt }) -> string
 * 内容：标题/生成时间/统计/按模块分布/逐题（题名、模块、状态、flag 验证情况+方式+证据摘要、
 * attempts 角度/状态/摘要、最近 3 条 facts、工作目录）/未解卡点与已试路径。
 */

const RECENT_FACTS = 3;
const MAX_TEXT = 300;
const MAX_EVIDENCE = 240;
const MAX_FAILED_PATHS = 30;

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function oneLine(value, max = MAX_TEXT) {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function inlineCode(value, max = MAX_TEXT) {
	return `\`${oneLine(value, max).replace(/`/g, "'")}\``;
}

function formatTime(value) {
	if (value == null || value === "") return "—";
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toISOString();
}

function formatDuration(ms) {
	const value = Number(ms);
	if (!Number.isFinite(value) || value < 0) return "—";
	const totalSeconds = Math.round(value / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function challengesOf(state) {
	const map = isPlainObject(state) && isPlainObject(state.challenges) ? state.challenges : {};
	const out = [];
	const seen = new Set();
	const order = isPlainObject(state) && Array.isArray(state.order) ? state.order : [];
	for (const id of order) {
		const challenge = map[id];
		if (!challenge || !isPlainObject(challenge)) continue;
		const key = String(challenge.id ?? id);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(challenge);
	}
	for (const [id, challenge] of Object.entries(map)) {
		if (!challenge || !isPlainObject(challenge)) continue;
		const key = String(challenge.id ?? id);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(challenge);
	}
	return out;
}

function computeStats(challenges) {
	const stats = {
		total: challenges.length,
		queued: 0,
		running: 0,
		solved: 0,
		stuck: 0,
		failed: 0,
		stopped: 0,
	};
	for (const challenge of challenges) {
		const status = String(challenge.status ?? "");
		if (Object.prototype.hasOwnProperty.call(stats, status)) stats[status] += 1;
	}
	return stats;
}

function categoryName(challenge) {
	const category = oneLine(challenge.category ?? "", 60);
	return category || "(未分类)";
}

function groupByCategory(challenges) {
	const groups = new Map();
	for (const challenge of challenges) {
		const key = categoryName(challenge);
		if (!groups.has(key)) {
			groups.set(key, { category: key, total: 0, solved: 0, running: 0, stuck: 0, failed: 0 });
		}
		const group = groups.get(key);
		group.total += 1;
		const status = String(challenge.status ?? "");
		if (status === "solved") group.solved += 1;
		else if (status === "running") group.running += 1;
		else if (status === "stuck") group.stuck += 1;
		else if (status === "failed") group.failed += 1;
	}
	return [...groups.values()].sort((a, b) => b.total - a.total || a.category.localeCompare(b.category, "zh"));
}

function flagsOf(challenge) {
	return Array.isArray(challenge.flags) ? challenge.flags.filter(isPlainObject) : [];
}

function attemptsOf(challenge) {
	return Array.isArray(challenge.attempts) ? challenge.attempts.filter(isPlainObject) : [];
}

function factsOf(challenge) {
	return Array.isArray(challenge.facts) ? challenge.facts.filter(isPlainObject) : [];
}

function collectFailedPaths(challenge) {
	const out = [];
	const push = (value) => {
		const text = oneLine(value, 200);
		if (text && !out.includes(text)) out.push(text);
	};
	for (const attempt of attemptsOf(challenge)) {
		for (const failedPath of Array.isArray(attempt.failedPaths) ? attempt.failedPaths : []) {
			push(failedPath);
		}
	}
	for (const fact of factsOf(challenge)) {
		const match = /^\[(?:失败|卡点|证伪)\]\s*(.+)$/.exec(String(fact.text ?? ""));
		if (match) push(match[1]);
	}
	return out.slice(-MAX_FAILED_PATHS);
}

function flagLines(challenge) {
	const lines = [];
	const flags = flagsOf(challenge);
	if (flags.length === 0) {
		lines.push("- flag：（无）");
		return lines;
	}
	lines.push("- flag：");
	for (const flag of flags) {
		const value = inlineCode(flag.value ?? "", 120);
		const verified = flag.verified === true;
		const method = oneLine(flag.method ?? "manual", 40) || "manual";
		const attemptRef = flag.attempt == null ? "—" : `#${flag.attempt}`;
		lines.push(
			`  - ${value}（${verified ? "已验证" : "待验证"}；方式：${method}；attempt ${attemptRef}）`,
		);
		const evidence = oneLine(flag.evidence ?? "", MAX_EVIDENCE);
		lines.push(`    - 证据摘要：${evidence || "（未提供）"}`);
	}
	return lines;
}

function attemptLines(challenge) {
	const lines = [];
	const attempts = attemptsOf(challenge);
	if (attempts.length === 0) {
		lines.push("- 尝试：（无）");
		return lines;
	}
	lines.push("- 尝试：");
	for (const attempt of attempts) {
		const n = attempt.n == null ? "?" : attempt.n;
		const angle = oneLine(attempt.angle ?? "unknown", 40) || "unknown";
		const status = oneLine(attempt.status ?? "unknown", 40) || "unknown";
		const stopReason = oneLine(attempt.stopReason ?? "", 40);
		const summary = oneLine(attempt.summary ?? "", 240);
		lines.push(
			`  - 第 ${n} 次：角度 ${inlineCode(angle, 40)} ｜ 状态 ${status}${stopReason ? `（${stopReason}）` : ""} ｜ 摘要：${summary || "（无）"}`,
		);
		const failedPaths = Array.isArray(attempt.failedPaths)
			? attempt.failedPaths.map((item) => oneLine(item, 160)).filter(Boolean)
			: [];
		for (const failedPath of failedPaths) lines.push(`    - 已失败路径：${inlineCode(failedPath, 160)}`);
		// 错误：优先 attempt.error；异常/超时收口但未记 error 时用摘要兜底，保证复盘能看见失败原因
		const attemptError = attempt.error ? oneLine(attempt.error, 200) : "";
		const abnormal = status === "error" || status === "timeout";
		if (attemptError) lines.push(`    - 错误：${attemptError}`);
		else if (abnormal) lines.push(`    - 错误：${summary || status}`);
	}
	return lines;
}

function factLines(challenge) {
	const lines = [];
	const facts = factsOf(challenge).slice(-RECENT_FACTS);
	if (facts.length === 0) {
		lines.push("- 最近事实：（无）");
		return lines;
	}
	lines.push(`- 最近事实（最近 ${facts.length} 条）：`);
	for (const fact of facts) {
		const at = formatTime(fact.at);
		lines.push(`  - [${at}] ${oneLine(fact.text ?? "", 240) || "（空）"}`);
	}
	return lines;
}

function baseLines(challenge) {
	const lines = [];
	const status = oneLine(challenge.status ?? "unknown", 40) || "unknown";
	lines.push(
		`- 模块：${categoryName(challenge)} ｜ 状态：${status} ｜ 题目 ID：${inlineCode(challenge.id ?? "", 80)}`,
	);
	if (challenge.slug) lines.push(`- slug：${inlineCode(challenge.slug, 80)}`);
	lines.push(`- 工作目录：${inlineCode(challenge.dir ?? "", 300)}`);
	const platform = isPlainObject(challenge.platform) ? challenge.platform : null;
	if (platform && (platform.baseUrl || platform.challengeId != null)) {
		const baseUrl = oneLine(platform.baseUrl ?? "", 160);
		const challengeId = platform.challengeId == null ? "—" : String(platform.challengeId);
		lines.push(`- 平台：${baseUrl || "—"} #${challengeId}`);
	}
	if (typeof challenge.startedAt === "number" && typeof challenge.endedAt === "number") {
		lines.push(`- 耗时：${formatDuration(challenge.endedAt - challenge.startedAt)}`);
	}
	if (challenge.createdAt != null) lines.push(`- 创建时间：${formatTime(challenge.createdAt)}`);
	if (typeof challenge.endedAt === "number") lines.push(`- 结束时间：${formatTime(challenge.endedAt)}`);
	if (challenge.stuckReason) {
		lines.push(`- 卡点：${oneLine(challenge.stuckReason, MAX_EVIDENCE)}`);
	}
	return lines;
}

function challengeSection(challenge, index) {
	const title = oneLine(challenge.title ?? "", 160) || `(未命名题目 ${index + 1})`;
	const lines = [`### ${index + 1}. ${title}`, ""];
	lines.push(...baseLines(challenge));
	lines.push(...flagLines(challenge));
	lines.push(...attemptLines(challenge));
	lines.push(...factLines(challenge));
	if (String(challenge.status ?? "") !== "solved") {
		const failedPaths = collectFailedPaths(challenge);
		lines.push(`- 未解卡点：${oneLine(challenge.stuckReason ?? "", MAX_EVIDENCE) || "（无记录）"}`);
		if (failedPaths.length === 0) {
			lines.push("- 已试路径：（无记录）");
		} else {
			lines.push("- 已试路径：");
			for (const failedPath of failedPaths) {
				lines.push(`  - ${inlineCode(failedPath, 200)}`);
			}
		}
	}
	lines.push("");
	return lines;
}

/**
 * 生成复盘 Markdown。
 * @param {object} state store.state（含 challenges/order/stats/rootDir）
 * @param {{generatedAt?: number|string|Date}} [options]
 * @returns {string}
 */
export function buildMarkdownReport(state, options = {}) {
	const opts = isPlainObject(options) ? options : {};
	const challenges = challengesOf(state);
	const stats = computeStats(challenges);
	const rootDir = isPlainObject(state) && state.rootDir ? String(state.rootDir) : "";
	const generatedAt = formatTime(Object.prototype.hasOwnProperty.call(opts, "generatedAt") ? opts.generatedAt : Date.now());

	const lines = [];
	lines.push("# CTF 自动解题复盘报告");
	lines.push("");
	lines.push(`- 生成时间：${generatedAt}`);
	lines.push(`- 题板根目录：${rootDir ? inlineCode(rootDir, 300) : "—"}`);
	lines.push(
		`- 统计：总 ${stats.total} ｜ 排队 ${stats.queued} ｜ 运行 ${stats.running} ｜ 已解 ${stats.solved} ｜ 卡住 ${stats.stuck} ｜ 失败 ${stats.failed} ｜ 停止 ${stats.stopped}`,
	);
	lines.push("");

	if (challenges.length === 0) {
		lines.push("（暂无题目）");
		lines.push("");
		return `${lines.join("\n")}\n`;
	}

	lines.push("## 按模块分布");
	lines.push("");
	lines.push("| 模块 | 总数 | 已解 | 运行 | 卡住 | 失败 |");
	lines.push("|---|---|---|---|---|---|");
	for (const group of groupByCategory(challenges)) {
		lines.push(
			`| ${oneLine(group.category, 80)} | ${group.total} | ${group.solved} | ${group.running} | ${group.stuck} | ${group.failed} |`,
		);
	}
	lines.push("");

	lines.push("## 题目复盘");
	lines.push("");
	challenges.forEach((challenge, index) => {
		lines.push(...challengeSection(challenge, index));
	});

	const unsolved = challenges.filter((challenge) => String(challenge.status ?? "") !== "solved");
	if (unsolved.length > 0) {
		lines.push("## 未解题目汇总");
		lines.push("");
		for (const challenge of unsolved) {
			const title = oneLine(challenge.title ?? "", 120) || "(未命名题目)";
			const status = oneLine(challenge.status ?? "unknown", 40) || "unknown";
			const reason = oneLine(challenge.stuckReason ?? "", MAX_EVIDENCE) || "（无卡点记录）";
			lines.push(`- ${title}（${categoryName(challenge)}）：${status} ｜ 卡点：${reason}`);
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
