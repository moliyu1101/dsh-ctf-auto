// dsh-ctf-auto / lib/memory.js —— 记忆层：做题沉淀打法卡 + 相似题召回（纯函数）。
//
// 目标（用户口径）：每解出一题就把可复用的打法沉淀成一张「打法卡」（技法/入口/步骤/命令/坑），
// 下次遇到相似题时按相似度召回前 K 张，注入子代理提示词，让它优先走已验证过的快速路径。
// 本模块只做纯计算：抽取打法卡、相似度打分、排序、生成提示词片段。落盘与计数在宿主。

/** 技法词典：命中即作为打法卡的技术标签（按顺序匹配，去重）。 */
export const TECH_LEXICON = [
	{ tag: "zip-symlink", re: /符号链接|symlink|软链接|unzip/i },
	{ tag: "file-read", re: /任意文件读取|任意读|file read|路径穿越|\.\.\//i },
	{ tag: "flask-session", re: /flask|itsdangerous|session.*伪造|SECRET_KEY/i },
	{ tag: "ssti", re: /\bSSTI\b|模板注入|jinja2|twig/i },
	{ tag: "sql-injection", re: /\bSQL\s*注入|sqli|union\s+select|盲注/i },
	{ tag: "ssrf", re: /\bSSRF\b|服务端请求伪造/i },
	{ tag: "xxe", re: /\bXXE\b|外部实体/i },
	{ tag: "deserialization", re: /反序列化|unserialize|pickle|ysoserial|fastjson/i },
	{ tag: "jwt", re: /\bJWT\b|json web token|jku|kid/i },
	{ tag: "upload", re: /文件上传|upload.*绕过|content-type.*绕过/i },
	{ tag: "rsa", re: /\bRSA\b|小公钥|共模|广播攻击|coppersmith/i },
	{ tag: "aes", re: /\bAES\b|\bDES\b|分组密码|CBC|padding oracle/i },
	{ tag: "xor", re: /\bXOR\b|异或/i },
	{ tag: "base64", re: /base64/i },
	{ tag: "rc4", re: /\bRC4\b/i },
	{ tag: "morse", re: /摩斯|morse/i },
	{ tag: "lsb", re: /\bLSB\b|最低有效位|zsteg/i },
	{ tag: "stego", re: /隐写|steghide|binwalk|盲水印/i },
	{ tag: "pcap", re: /\bpcap\b|tshark|wireshark|流量分析/i },
	{ tag: "memory-forensics", re: /内存镜像|volatility|memdump/i },
	{ tag: "heap", re: /\bheap\b|堆溢出|uaf|use.after.free/i },
	{ tag: "rop", re: /\bROP\b|ret2|栈溢出|stack overflow|canary/i },
	{ tag: "format-string", re: /格式化字符串|format string/i },
	{ tag: "libc", re: /libc.*版本|libc-2|one_gadget/i },
	{ tag: "reverse", re: /逆向|反编译|ollvm|vmp|脱壳|jadx|ghidra|ida/i },
	{ tag: "android", re: /android|apk|frida|xposed|安卓/i },
	{ tag: "cloud", re: /\bS3\b|\bOSS\b|元数据|169\.254\.169\.254|iam|k8s|kubernetes/i },
	{ tag: "ad", re: /kerberos|kerberoast|ntlm|域控|domain controller|bloodhound/i },
	{ tag: "supply-chain", re: /供应链|依赖投毒|typosquat|postinstall|npm.*包/i },
	{ tag: "pyjail", re: /pyjail|python.*沙箱|sandbox.*escape/i },
	{ tag: "cicd", re: /github actions|workflow|ci\/cd|pull_request_target/i }
];

const STOPWORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "your", "have", "will", "flag", "ctf", "http", "https", "www", "com", "题目", "目标", "题名", "模块", "附件", "flag", "我们", "可以", "然后", "一个", "这个", "需要", "进行"]);

/** 轻量分词：ASCII 词 + 中文二元组（足够做相似度，不引入分词依赖）。 */
export function tokenize(text) {
	const value = String(text == null ? "" : text).toLowerCase();
	const tokens = new Set();
	for (const match of value.matchAll(/[a-z0-9_\-\.]{2,}/g)) {
		const token = match[0];
		if (!STOPWORDS.has(token)) tokens.add(token);
	}
	const han = value.replace(/[^\u4e00-\u9fff]+/g, " ").split(/\s+/).filter(Boolean);
	for (const chunk of han) {
		if (chunk.length === 1) tokens.add(chunk);
		for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.add(chunk.slice(i, i + 2));
	}
	return tokens;
}

function unique(list) {
	return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

/** 从解题记录/Writeup 里抽技术标签。 */
export function extractTech(text) {
	const value = String(text == null ? "" : text);
	const tags = [];
	for (const item of TECH_LEXICON) {
		if (item.re.test(value)) tags.push(item.tag);
	}
	return unique(tags);
}

function lines(text) {
	return String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
}

function extractSteps(notes) {
	const out = [];
	for (const line of lines(notes)) {
		const heading = /^#{2,4}\s+(.+)$/.exec(line.trim());
		if (heading) {
			const title = heading[1].replace(/^\d+[.、）)]\s*/, "").trim();
			if (title && !/已失败路径|下一步建议|反注入|时间预算|备注|产物/.test(title) && out.length < 6) out.push(title.slice(0, 60));
			continue;
		}
		const numbered = /^\d+[.、)]\s+(.{4,80})$/.exec(line.trim());
		if (numbered && out.length < 6 && !out.includes(numbered[1].trim())) out.push(numbered[1].trim());
	}
	return unique(out);
}

function extractCommands(text) {
	const out = [];
	let inCode = false;
	for (const line of lines(text)) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) { inCode = !inCode; continue; }
		if (!inCode) continue;
		if (/^(python3?|bash|sh|node|curl|nc|pwsh|.\/|nmap|sqlmap|gobuster|ffuf|jadx|frida|tshark|zsteg|binwalk|exiftool|sqlite3)\b/i.test(trimmed) && !trimmed.includes("<<") && out.length < 6) {
			const cleaned = trimmed.replace(/\s+#.*$/, "").slice(0, 140);
			if (!out.includes(cleaned)) out.push(cleaned);
		}
	}
	return out;
}

function extractPitfalls(notes) {
	const out = [];
	let capture = false;
	for (const line of lines(notes)) {
		const trimmed = line.trim();
		if (/^#{2,4}\s/.test(trimmed)) {
			capture = /已失败路径|坑|注意|卡点/.test(trimmed);
			continue;
		}
		if (capture && /^[-*]\s+/.test(trimmed)) {
			const text = trimmed.replace(/^[-*]\s+/, "").slice(0, 120);
			if (text && out.length < 5) out.push(text);
		}
	}
	return unique(out);
}

function firstMatch(text, re) {
	const match = re.exec(String(text == null ? "" : text));
	return match ? String(match[1] || match[0]).slice(0, 80) : "";
}

/**
 * 从一道已解的题沉淀打法卡。
 * @param {object} challenge store 里的 challenge（含 flags/attempts）
 * @param {{notes?:string, writeup?:string}} sources
 * @returns {object} card
 */
export function distillCard(challenge, sources = {}) {
	const ch = challenge && typeof challenge === "object" ? challenge : {};
	const notes = String(sources.notes || "");
	const writeup = String(sources.writeup || "");
	const corpus = `${ch.title || ""}\n${ch.statement || ""}\n${notes}\n${writeup}`;
	const tech = extractTech(corpus);
	const verified = (Array.isArray(ch.flags) ? ch.flags : []).find((f) => f && f.verified);
	const flagValue = verified && verified.value ? String(verified.value) : "";
	const flagPattern = flagValue
		? flagValue.replace(/[A-Za-z0-9]/g, "x").slice(0, 60)
		: "";
	const flagLocation = firstMatch(notes + "\n" + writeup, /(?:FLAG|flag)\s*[=:：]\s*(\S+)/) || "";
	const entry = firstMatch(notes + "\n" + writeup, /(?:目标|target|入口)[:：]?\s*(\S+)/i) || ch.target || "";
	const commands = extractCommands(`${notes}\n${writeup}`);
	const steps = extractSteps(notes);
	const pitfalls = extractPitfalls(notes);
	const summary = (() => {
		const fact = (Array.isArray(ch.facts) ? ch.facts : []).filter((f) => f && /结论/.test(String(f.text))).pop();
		if (fact) return String(fact.text).replace(/^\[[^\]]+\]\s*/, "").slice(0, 200);
		const line = lines(writeup).find((item) => item.trim() && !item.startsWith("#"));
		return line ? line.trim().slice(0, 200) : "";
	})();
	const tags = unique([ch.category || "", ...tech, ...(["web", "pwn", "reverse", "crypto", "misc", "forensics"].includes(String(ch.category)) ? [] : [])]);
	return {
		id: `mem-${String(ch.slug || ch.id || "challenge")}`,
		title: String(ch.title || "未命名题目"),
		category: String(ch.category || ""),
		tech,
		tags,
		entry,
		steps,
		commands,
		pitfalls,
		summary,
		flagPattern,
		flagLocation,
		sourceChallengeId: String(ch.id || ""),
		slug: String(ch.slug || ""),
		workspace: String(ch.workspace || ""),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		used: 0,
		usedOk: 0
	};
}

/** 相似度：挑战（标题+题面+模块）与打法卡（标题+技法+入口+步骤+坑）的加权词集重合。 */
export function scoreMemory(card, challenge) {
	if (!card || !challenge) return 0;
	const q = tokenize(`${challenge.title || ""} ${challenge.statement || ""}`);
	if (q.size === 0) return 0;
	const cardText = [card.title, card.summary, ...(card.tech || []), card.entry, ...(card.steps || []), ...(card.pitfalls || []), ...(card.commands || [])].join(" ");
	const c = tokenize(cardText);
	let overlap = 0;
	for (const token of q) {
		if (c.has(token)) overlap += 1;
	}
	let score = overlap / Math.sqrt(Math.max(1, q.size) * Math.max(1, c.size));
	if (challenge.category && card.category && String(challenge.category) === String(card.category)) score += 0.25;
	const challengeTech = extractTech(`${challenge.title || ""} ${challenge.statement || ""} ${(challenge.files || []).map((f) => (f && f.name) || f).join(" ")}`);
	const cardTech = new Set(card.tech || []);
	const techHits = challengeTech.filter((tag) => cardTech.has(tag)).length;
	if (techHits > 0) score += Math.min(0.5, techHits * 0.2);
	return Math.round(score * 1000) / 1000;
}

/** 召回：按相似度排序取前 limit 张（阈值默认 0.12）。 */
export function rankMemories(cards, challenge, options = {}) {
	const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
	const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 0.12;
	const scored = [];
	for (const card of Array.isArray(cards) ? cards : []) {
		if (!card || card.sourceChallengeId === challenge?.id) continue;
		const score = scoreMemory(card, challenge);
		if (score >= minScore) scored.push({ ...card, score });
	}
	scored.sort((a, b) => b.score - a.score || (b.usedOk || 0) - (a.usedOk || 0));
	return scored.slice(0, limit);
}

/** 生成注入子代理提示词的「相似题记忆」片段。 */
export function buildMemoryPromptSection(memories) {
	const list = Array.isArray(memories) ? memories.filter((m) => m && m.title) : [];
	if (list.length === 0) return "";
	const lines = [
		"## 7. 相似题记忆（历史沉淀，快速路径参考）",
		"",
		"> 这些是以前解过的相似题沉淀出的打法卡。优先尝试复用其入口/技法/命令来缩短路径；**结论必须自己在本题复现验证**，不得直接采信历史 flag。",
		""
	];
	for (const card of list.slice(0, 3)) {
		lines.push(`- [相似度 ${(card.score || 0).toFixed(2)}] 「${card.title}」（${card.category || "未知模块"}）`);
		if (card.tech && card.tech.length) lines.push(`  - 技法：${card.tech.slice(0, 6).join("、")}`);
		if (card.entry) lines.push(`  - 入口：${card.entry}`);
		if (card.steps && card.steps.length) lines.push(`  - 步骤：${card.steps.slice(0, 4).join(" → ")}`);
		if (card.commands && card.commands.length) lines.push(`  - 复用命令：${card.commands.slice(0, 3).join(" ； ")}`);
		if (card.pitfalls && card.pitfalls.length) lines.push(`  - 注意：${card.pitfalls.slice(0, 2).join("；")}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** 按关键词检索打法卡（用于 ctf_recall 的 q 模式）。 */
export function searchMemories(cards, query, options = {}) {
	const q = String(query == null ? "" : query).trim();
	if (!q) return [];
	const limit = Math.max(1, Math.min(20, Number(options.limit) || 3));
	const probe = { title: q, statement: q, category: "" };
	const scored = [];
	for (const card of Array.isArray(cards) ? cards : []) {
		if (!card) continue;
		const score = scoreMemory(card, probe);
		if (score > 0) scored.push({ ...card, score });
	}
	scored.sort((a, b) => b.score - a.score || (b.usedOk || 0) - (a.usedOk || 0));
	return scored.slice(0, limit);
}

export default { TECH_LEXICON, tokenize, extractTech, distillCard, scoreMemory, rankMemories, buildMemoryPromptSection, searchMemories };