// dsh-ctf-auto / lib/memory.js —— 记忆层 v2：结构化打法卡 + 相似题召回（纯函数）。
//
// v2 目标：把「解出的一道题」沉淀成可执行的打法卡，而不是几条标签：
//   - 识别特征 fingerprint（下次看到什么信号该想起这张卡）
//   - 前置条件 prerequisites / 工具 tooling
//   - 分步步骤 stepDetails（标题 + 该步命令）与可复用命令 commands
//   - 载荷/注入串 payloads、已失败路径 pitfalls
//   - 验证方式与置信度 verification/confidence
//   - 复用效果 metrics（used/usedOk/successRate）驱动排序
// 本模块只做纯计算；落盘、计数与跨会话存储由宿主负责。

/** 技法词典：命中即作为打法卡的技术标签（按顺序匹配，去重）。 */
export const TECH_LEXICON = [
	{ tag: "zip-symlink", re: /符号链接|symlink|软链接|unzip/i },
	{ tag: "file-read", re: /任意文件读取|任意读|file read|路径穿越|\.\.\//i },
	{ tag: "flask-session", re: /flask|itsdangerous|session.*伪造|SECRET_KEY/i },
	{ tag: "ssti", re: /\bSSTI\b|模板注入|jinja2|twig/i },
	{ tag: "sql-injection", re: /\bSQL\s*注入|sqli|union\s+select|盲注|information_schema/i },
	{ tag: "ssrf", re: /\bSSRF\b|服务端请求伪造/i },
	{ tag: "xxe", re: /\bXXE\b|外部实体/i },
	{ tag: "deserialization", re: /反序列化|unserialize|pickle|ysoserial|fastjson|__wakeup/i },
	{ tag: "jwt", re: /\bJWT\b|json web token|jku|kid/i },
	{ tag: "upload", re: /文件上传|upload.*绕过|content-type.*绕过/i },
	{ tag: "command-injection", re: /命令注入|command injection|shell_exec|\$IFS|base64.*-d/i },
	{ tag: "lfi", re: /\bLFI\b|本地文件包含|include\s*\(\s*\$_(GET|POST)/i },
	{ tag: "rsa", re: /\bRSA\b|小公钥|共模|广播攻击|coppersmith/i },
	{ tag: "aes", re: /\bAES\b|\bDES\b|分组密码|CBC|padding oracle/i },
	{ tag: "xor", re: /\bXOR\b|异或/i },
	{ tag: "base64", re: /base64/i },
	{ tag: "rc4", re: /\bRC4\b/i },
	{ tag: "morse", re: /摩斯|morse/i },
	{ tag: "caesar", re: /凯撒|caesar|rot13|rot-?n|移位/i },
	{ tag: "lsb", re: /\bLSB\b|最低有效位|zsteg/i },
	{ tag: "stego", re: /隐写|steghide|binwalk|盲水印/i },
	{ tag: "pcap", re: /\bpcap\b|pcapng|tshark|wireshark|流量分析/i },
	{ tag: "memory-forensics", re: /内存镜像|volatility|memdump/i },
	{ tag: "disk-forensics", re: /磁盘镜像|取证|e01|vmdk|分区/i },
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

const TECH_PREREQUISITES = {
	"sql-injection": ["可访问的注入点（GET/POST/Header）", "能拿到回显或时间/布尔通道"],
	"command-injection": ["命令拼接入口（参数/表单）", "可用绕过字符过滤的编码链"],
	"deserialization": ["可传入序列化数据的参数", "目标类链/魔术方法已知"],
	"file-read": ["可控制文件路径的参数", "已知目标路径或可枚举"],
	"lfi": ["可控 include 路径", "可读日志/临时文件或 php://filter"],
	"ssti": ["模板表达式落点", "可读上下文/配置"],
	"upload": ["文件上传点", "可访问的上传目录/解析配置"],
	"pcap": ["pcap/pcapng 文件", "tshark/scapy 等解析工具"],
	"stego": ["图片/音频附件", "zsteg/binwalk/steghide 等"],
	"lsb": ["无损图片", "位平面/LSB 提取脚本"],
	"zip-symlink": ["ZIP 附件", "解压工具与符号链接环境"],
	"rsa": ["n/e/c 或公私钥参数", "大整数/格工具"],
	"aes": ["密文与分组模式线索", "密钥/IV 派生方式"],
	"xor": ["密文与明文格式线索", "密钥长度/频率分析"],
	"morse": ["音频或 0/1 序列", "摩斯解码脚本"],
	"caesar": ["可打印密文与格式线索", "移位/变种枚举"],
	"reverse": ["可执行文件/字节码", "反编译或动态调试工具"],
	"heap": ["远程服务与 libc", "堆利用脚本模板"],
	"rop": ["二进制与 libc", "ROPgadget/pwntools"],
	"cloud": ["云凭证或元数据入口", "云 CLI/HTTP 客户端"],
	"ad": ["域内凭据或入口", "impacket/bloodhound"],
	"memory-forensics": ["内存镜像", "volatility 2/3 符号表"],
	"disk-forensics": ["磁盘/分区镜像", "文件系统与取证工具"]
};

const TECH_TOOLING = {
	"pcap": ["tshark", "scapy"],
	"stego": ["binwalk", "zsteg", "exiftool"],
	"lsb": ["zsteg", "PIL"],
	"zip-symlink": ["unzip"],
	"sql-injection": ["sqlmap", "curl"],
	"command-injection": ["curl", "python"],
	"reverse": ["ida", "ghidra", "objdump"],
	"heap": ["pwntools", "gdb"],
	"rop": ["ROPgadget", "pwntools"],
	"rsa": ["python", "sage"],
	"morse": ["python"],
	"caesar": ["python"],
	"memory-forensics": ["volatility"],
	"disk-forensics": ["sleuthkit"]
};

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

function clip(text, max) {
	const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const FAILED_HEADING = /已失败路径|失败路径|坑|注意|卡点|负结果|排除/i;
const STEP_EXCLUDE = /下一步建议|反注入|时间预算|备注|产物|已失败/i;

function cleanStepTitle(title) {
	return String(title || "")
		.replace(/^\d+[.、）)]\s*/, "")
		.replace(/^[#\s]*/, "")
		.trim()
		.slice(0, 80);
}

function commandLine(line) {
	const trimmed = String(line || "").trim().replace(/^\$\s*/, "").replace(/^>\s*/, "");
	if (!trimmed) return "";
	if (!/^(python3?|bash|sh|node|curl|wget|nc|ncat|pwsh|powershell|\.\/|sqlmap|nmap|gobuster|ffuf|jadx|frida|apktool|tshark|tcpdump|zsteg|binwalk|steghide|exiftool|volatility|unrar|unzip|7z|openssl|hashcat|john|ROPgadget|checksec|readelf|objdump|strings|xxd|file|identify|ffmpeg|sage)\b/i.test(trimmed)) return "";
	return clip(trimmed.replace(/\s+#.*$/, ""), 160);
}

function extractStepDetails(notes) {
	const details = [];
	const seen = new Set();
	let current = "";
	let inCode = false;
	for (const raw of lines(notes)) {
		const trimmed = raw.trim();
		if (/^```/.test(trimmed)) { inCode = !inCode; continue; }
		if (inCode) {
			const command = commandLine(trimmed);
			if (command && details.length < 8 && !seen.has(command)) {
				seen.add(command);
				details.push({ title: current || `步骤 ${details.length + 1}`, command });
			}
			continue;
		}
		const heading = /^#{2,4}\s+(.+)$/.exec(trimmed);
		if (heading) {
			const title = cleanStepTitle(heading[1]);
			if (title && !FAILED_HEADING.test(title) && !STEP_EXCLUDE.test(title)) {
				current = title;
				if (!seen.has(title) && details.length < 8) { seen.add(title); details.push({ title, command: "" }); }
			}
			continue;
		}
		const numbered = /^\d+[.、)]\s+(.{4,120})$/.exec(trimmed);
		if (numbered && details.length < 8) {
			const title = clip(numbered[1], 90);
			if (!seen.has(title)) { seen.add(title); details.push({ title, command: "" }); }
		}
	}
	return details;
}

function extractCommands(text) {
	const out = [];
	let inCode = false;
	for (const line of lines(text)) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) { inCode = !inCode; continue; }
		const command = commandLine(trimmed);
		if (!command) continue;
		if (!inCode && !/^\$/.test(trimmed)) continue;
		if (!out.includes(command) && out.length < 8) out.push(command);
	}
	return out;
}

function extractPayloads(text, tech) {
	const corpus = String(text || "");
	const out = [];
	const push = (value) => {
		const v = clip(value, 160);
		if (v && !out.includes(v) && out.length < 6) out.push(v);
	};
	for (const match of corpus.matchAll(/O:\d+:"[^"]+":\d+:\{[^\n]{0,200}\}/g)) push(match[0]);
	for (const match of corpus.matchAll(/\{\{[^\n]{1,120}\}\}/g)) push(match[0]);
	for (const match of corpus.matchAll(/[?&][A-Za-z0-9_]{1,20}=[^\s&'"`]{2,120}/g)) push(match[0]);
	for (const match of corpus.matchAll(/select\s+[^\n]{4,160}?\s+from\s+[^\n]{1,80}/gi)) push(match[0]);
	for (const match of corpus.matchAll(/(?:GET|POST)\s+\/[^\s]{1,120}/g)) push(match[0]);
	for (const match of corpus.matchAll(/[A-Za-z0-9+/]{20,}={0,2}/g)) {
		const value = match[0];
		if (tech.includes("base64") || value.length >= 24) push(value);
	}
	return out;
}

function extractPitfalls(notes, challenge) {
	const out = [];
	for (const attempt of Array.isArray(challenge && challenge.attempts) ? challenge.attempts : []) {
		for (const item of Array.isArray(attempt && attempt.failedPaths) ? attempt.failedPaths : []) {
			const text = typeof item === "string" ? item : item && (item.path || item.reason || item.text);
			if (text) out.push(clip(text, 120));
		}
	}
	let capture = false;
	for (const line of lines(notes)) {
		const trimmed = line.trim();
		if (/^#{2,4}\s/.test(trimmed)) { capture = FAILED_HEADING.test(trimmed); continue; }
		if (capture && /^[-*]\s+/.test(trimmed)) out.push(clip(trimmed.replace(/^[-*]\s+/, ""), 120));
	}
	for (const fact of Array.isArray(challenge && challenge.facts) ? challenge.facts : []) {
		if (fact && fact.kind === "卡点") out.push(clip(fact.text, 120));
	}
	return unique(out).slice(0, 6);
}

function extractFingerprint(challenge, notes, tech) {
	const facts = Array.isArray(challenge && challenge.facts) ? challenge.facts : [];
	const clean = (text) => !/flag\{|flag\s*(待验证|已验证)|平台回显|already_solved|记录候选|已登记/i.test(String(text || ""));
	const conclusion = facts
		.filter((f) => f && /结论|发现/.test(String(f.kind || "")) && clean(f.text))
		.map((f) => f.text).pop();
	const statement = String(challenge && challenge.statement || "")
		.replace(/平台题号[:：][^\n]*/g, "")
		.replace(/附件[:：][\s\S]*/g, "")
		.trim();
	const firstNote = lines(notes).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !/^```/.test(line) && clean(line));
	const base = clip(conclusion || firstNote || statement, 140);
	const tags = tech.slice(0, 4).join(" / ");
	if (base && tags) return `[${tags}] ${base}`;
	if (base) return base;
	return tags || "";
}

function extractSummary(challenge, writeup) {
	const facts = Array.isArray(challenge && challenge.facts) ? challenge.facts : [];
	const fact = facts.filter((f) => f && /结论/.test(String(f.text))).pop();
	if (fact) return clip(fact.text.replace(/^\[[^\]]+\]\s*/, ""), 200);
	const line = lines(writeup).find((item) => item.trim() && !item.startsWith("#") && !/^```/.test(item.trim()));
	return line ? clip(line, 200) : "";
}

function kindOf(tech) {
	if (tech.some((tag) => ["pcap", "stego", "lsb", "memory-forensics", "disk-forensics"].includes(tag))) return "triage";
	if (tech.some((tag) => ["sql-injection", "command-injection", "deserialization", "ssti", "upload", "ssrf", "xxe", "lfi", "heap", "rop", "format-string"].includes(tag))) return "exploit";
	if (tech.some((tag) => ["rsa", "aes", "xor", "base64", "morse", "caesar", "rc4"].includes(tag))) return "crypto";
	return "generic";
}

function confidenceOf(challenge, tech, verification) {
	let confidence = verification && verification.verified ? 0.62 : 0.32;
	const evidence = String(verification && verification.evidence || "");
	if (evidence.length >= 80) confidence += 0.08;
	if (evidence.length >= 200) confidence += 0.06;
	if (tech.length >= 2) confidence += 0.05;
	const attempts = Array.isArray(challenge && challenge.attempts) ? challenge.attempts.length : 0;
	if (attempts > 2) confidence -= 0.05;
	return Math.round(Math.max(0.2, Math.min(0.98, confidence)) * 100) / 100;
}

/** 把任意旧版卡（v1）升级为 v2 结构，保证 UI/召回兼容。 */
export function normalizeCard(card) {
	const c = card && typeof card === "object" ? card : {};
	const steps = Array.isArray(c.steps) ? c.steps.map((s) => (typeof s === "string" ? s : String(s && s.title || ""))).filter(Boolean) : [];
	const stepDetails = Array.isArray(c.stepDetails) && c.stepDetails.length
		? c.stepDetails.filter((s) => s && (s.title || s.command)).map((s) => ({ title: String(s.title || ""), command: String(s.command || "") }))
		: steps.map((title) => ({ title, command: "" }));
	const used = Number(c.used) || 0;
	const usedOk = Number(c.usedOk) || 0;
	const tech = unique(Array.isArray(c.tech) ? c.tech.map(String) : []);
	const metrics = {
		attempts: Number(c.metrics && c.metrics.attempts) || 0,
		durationMs: Number(c.metrics && c.metrics.durationMs) || 0,
		estCost: Number(c.metrics && c.metrics.estCost) || 0,
		used,
		usedOk,
		successRate: used > 0 ? Math.round((usedOk / used) * 100) / 100 : 0
	};
	return {
		version: 2,
		id: String(c.id || `mem-${c.slug || c.sourceChallengeId || "unknown"}`),
		kind: String(c.kind || kindOf(tech)),
		title: String(c.title || "未命名题目"),
		category: String(c.category || ""),
		tech,
		tags: unique([String(c.category || ""), ...tech, ...(Array.isArray(c.tags) ? c.tags.map(String) : [])]),
		fingerprint: String(c.fingerprint || ""),
		summary: String(c.summary || ""),
		entry: String(c.entry || ""),
		prerequisites: unique(Array.isArray(c.prerequisites) ? c.prerequisites.map(String) : []),
		tooling: unique(Array.isArray(c.tooling) ? c.tooling.map(String) : []),
		steps,
		stepDetails,
		commands: unique(Array.isArray(c.commands) ? c.commands.map(String) : []),
		payloads: unique(Array.isArray(c.payloads) ? c.payloads.map(String) : []),
		pitfalls: unique(Array.isArray(c.pitfalls) ? c.pitfalls.map(String) : []),
		verification: {
			verified: !!(c.verification && c.verification.verified),
			method: String(c.verification && c.verification.method || c.method || ""),
			evidence: String(c.verification && c.verification.evidence || c.evidence || ""),
			flagPattern: String(c.verification && c.verification.flagPattern || c.flagPattern || ""),
			confidence: Number(c.verification && c.verification.confidence || c.confidence) || 0.3
		},
		confidence: Number(c.confidence) || Number(c.verification && c.verification.confidence) || 0.3,
		flagPattern: String(c.flagPattern || (c.verification && c.verification.flagPattern) || ""),
		flagLocation: String(c.flagLocation || ""),
		metrics,
		links: {
			sourceChallengeId: String(c.sourceChallengeId || ""),
			slug: String(c.slug || ""),
			workspace: String(c.workspace || ""),
			notesPath: String(c.links && c.links.notesPath || c.notesPath || ""),
			writeupPath: String(c.links && c.links.writeupPath || c.writeupPath || ""),
			artifacts: Array.isArray(c.links && c.links.artifacts) ? c.links.artifacts.map(String) : []
		},
		sourceChallengeId: String(c.sourceChallengeId || ""),
		slug: String(c.slug || ""),
		workspace: String(c.workspace || ""),
		createdAt: Number(c.createdAt) || Date.now(),
		updatedAt: Number(c.updatedAt) || Number(c.createdAt) || Date.now(),
		lastUsedAt: Number(c.lastUsedAt) || 0,
		score: Number(c.score) || 0,
		used,
		usedOk
	};
}

/**
 * 从一道已解的题沉淀结构化打法卡（v2）。
 * @param {object} challenge store 里的 challenge（含 flags/attempts/facts）
 * @param {{notes?:string, writeup?:string, notesPath?:string, writeupPath?:string}} sources
 * @returns {object} card
 */
export function distillCard(challenge, sources = {}) {
	const ch = challenge && typeof challenge === "object" ? challenge : {};
	const notes = String(sources.notes || "");
	const writeup = String(sources.writeup || "");
	const factsText = (Array.isArray(ch.facts) ? ch.facts : []).map((f) => String(f && f.text || "")).join("\n");
	const attemptsText = (Array.isArray(ch.attempts) ? ch.attempts : []).map((a) => `${a && a.angle || ""} ${a && a.summary || ""}`).join("\n");
	const corpus = `${ch.title || ""}\n${ch.statement || ""}\n${factsText}\n${attemptsText}\n${notes}\n${writeup}`;
	const tech = extractTech(corpus);
	const verified = (Array.isArray(ch.flags) ? ch.flags : []).find((f) => f && f.verified);
	const evidence = String(verified && verified.evidence || "");
	const flagValue = verified && verified.value ? String(verified.value) : "";
	const verification = {
		verified: !!verified,
		method: String(verified && verified.method || ""),
		evidence: clip(evidence, 300),
		flagPattern: flagValue ? flagValue.replace(/[A-Za-z0-9]/g, "x").slice(0, 60) : "",
		confidence: 0
	};
	const stepDetails = extractStepDetails(notes);
	const steps = stepDetails.map((step) => step.title).filter(Boolean).slice(0, 8);
	const commands = unique([...extractCommands(`${notes}\n${writeup}`), ...stepDetails.map((s) => s.command).filter(Boolean)]).slice(0, 8);
	const payloads = extractPayloads(`${notes}\n${writeup}\n${factsText}`, tech);
	const prerequisites = unique(tech.flatMap((tag) => TECH_PREREQUISITES[tag] || [])).slice(0, 8);
	const tooling = unique(tech.flatMap((tag) => TECH_TOOLING[tag] || [])).slice(0, 8);
	const pitfalls = extractPitfalls(notes, ch);
	const fingerprint = extractFingerprint(ch, notes, tech);
	const summary = extractSummary(ch, writeup);
	const attempts = Array.isArray(ch.attempts) ? ch.attempts : [];
	const metrics = {
		attempts: attempts.length,
		durationMs: attempts.reduce((sum, a) => sum + Math.max(0, (Number(a && a.endedAt) || 0) - (Number(a && a.startedAt) || 0)), 0),
		estCost: Math.round(attempts.reduce((sum, a) => sum + (Number(a && a.estCost) || 0), 0) * 1e6) / 1e6,
		used: 0,
		usedOk: 0,
		successRate: 0
	};
	const confidence = confidenceOf(ch, tech, verification);
	verification.confidence = confidence;
	return normalizeCard({
		version: 2,
		id: `mem-${String(ch.slug || ch.id || "challenge")}`,
		kind: kindOf(tech),
		title: String(ch.title || "未命名题目"),
		category: String(ch.category || ""),
		tech,
		tags: unique([String(ch.category || ""), ...tech]),
		fingerprint,
		summary,
		entry: String(ch.target || ""),
		prerequisites,
		tooling,
		steps,
		stepDetails,
		commands,
		payloads,
		pitfalls,
		verification,
		confidence,
		metrics,
		links: {
			sourceChallengeId: String(ch.id || ""),
			slug: String(ch.slug || ""),
			workspace: String(ch.workspace || ""),
			notesPath: String(sources.notesPath || ""),
			writeupPath: String(sources.writeupPath || ""),
			artifacts: []
		},
		sourceChallengeId: String(ch.id || ""),
		slug: String(ch.slug || ""),
		workspace: String(ch.workspace || ""),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		used: 0,
		usedOk: 0
	});
}

function entryKey(value) {
	const text = String(value || "");
	const host = /([a-z0-9.-]+\.[a-z]{2,})(?::(\d+))?/i.exec(text);
	return host ? `${host[1].toLowerCase()}${host[2] ? `:${host[2]}` : ""}` : "";
}

/** 相似度 v2：词集重合 + 模块 + 技法 + 识别特征 + 入口 + 历史成功率。 */
export function scoreMemory(card, challenge) {
	if (!card || !challenge) return 0;
	const q = tokenize(`${challenge.title || ""} ${challenge.statement || ""}`);
	if (q.size === 0) return 0;
	const cardText = [
		card.title, card.summary, card.fingerprint, card.entry,
		...(card.tech || []), ...(card.steps || []), ...(card.pitfalls || []),
		...(card.commands || []), ...(card.payloads || [])
	].join(" ");
	const c = tokenize(cardText);
	let overlap = 0;
	for (const token of q) if (c.has(token)) overlap += 1;
	let score = 0.6 * (overlap / Math.sqrt(Math.max(1, q.size) * Math.max(1, c.size)));
	if (challenge.category && card.category && String(challenge.category) === String(card.category)) score += 0.15;
	const challengeTech = extractTech(`${challenge.title || ""} ${challenge.statement || ""} ${(challenge.files || []).map((f) => (f && f.name) || f).join(" ")}`);
	const cardTech = new Set(card.tech || []);
	const techHits = challengeTech.filter((tag) => cardTech.has(tag)).length;
	if (techHits > 0) score += Math.min(0.3, techHits * 0.12);
	if (card.fingerprint) {
		const fp = tokenize(card.fingerprint);
		let fpOverlap = 0;
		for (const token of fp) if (q.has(token)) fpOverlap += 1;
		if (fpOverlap > 0) score += Math.min(0.15, 0.05 * fpOverlap);
	}
	if (entryKey(challenge.target) && entryKey(challenge.target) === entryKey(card.entry)) score += 0.08;
	const used = Number(card.used) || 0;
	const usedOk = Number(card.usedOk) || 0;
	score += 0.05 * ((usedOk + 1) / (used + 2));
	return Math.round(Math.min(1.5, score) * 1000) / 1000;
}

/** 召回：按相似度排序取前 limit 张（阈值默认 0.12）。 */
export function rankMemories(cards, challenge, options = {}) {
	const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
	const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 0.12;
	const scored = [];
	for (const raw of Array.isArray(cards) ? cards : []) {
		const card = normalizeCard(raw);
		if (!card || card.sourceChallengeId === challenge?.id) continue;
		const score = scoreMemory(card, challenge);
		if (score >= minScore) scored.push({ ...card, score });
	}
	scored.sort((a, b) => b.score - a.score || (b.usedOk || 0) - (a.usedOk || 0));
	return scored.slice(0, limit);
}

/** 生成注入子代理提示词的「相似题记忆」片段。 */
export function buildMemoryPromptSection(memories) {
	const list = Array.isArray(memories) ? memories.filter((m) => m && m.title).map(normalizeCard) : [];
	if (list.length === 0) return "";
	const out = [
		"## 7. 相似题记忆（历史沉淀，快速路径参考）",
		"",
		"> 这些是以前解过的相似题沉淀出的打法卡。优先复用其识别特征/入口/步骤/命令缩短路径；**结论必须自己在本题复现验证**，不得直接采信历史 flag。",
		""
	];
	for (const card of list.slice(0, 3)) {
		const score = Number(card.score) || 0;
		out.push(`### 卡片：「${card.title}」（${card.category || "未知模块"}，相似度 ${score.toFixed(2)}，置信度 ${Math.round((card.confidence || 0) * 100)}%）`);
		if (card.tech.length) out.push(`- 技法：${card.tech.slice(0, 8).join("、")}`);
		if (card.fingerprint) out.push(`- 识别特征：${card.fingerprint}`);
		if (card.entry) out.push(`- 入口：${card.entry}`);
		if (card.prerequisites.length) out.push(`- 前置：${card.prerequisites.slice(0, 4).join("；")}`);
		const steps = card.stepDetails.filter((s) => s.title || s.command).slice(0, 5);
		if (steps.length) {
			out.push("- 步骤：");
			steps.forEach((step, index) => {
				out.push(`  ${index + 1}. ${step.title || "步骤"}${step.command ? `：\`${clip(step.command, 120)}\`` : ""}`);
			});
		}
		if (card.payloads.length) out.push(`- 载荷：${card.payloads.slice(0, 2).join(" ； ")}`);
		if (card.pitfalls.length) out.push(`- 坑：${card.pitfalls.slice(0, 3).join("；")}`);
		if (card.verification.verified) out.push(`- 验证：${card.verification.method || "已验证"}${card.verification.evidence ? `（${clip(card.verification.evidence, 100)}）` : ""}`);
		const rate = card.metrics.used > 0 ? `${Math.round(card.metrics.successRate * 100)}%（${card.metrics.usedOk}/${card.metrics.used}）` : "未复用";
		out.push(`- 历史复用：${rate}`);
		out.push("");
	}
	out.push("");
	return out.join("\n");
}

/** 按关键词检索打法卡（用于 ctf_recall 的 q 模式）。 */
export function searchMemories(cards, query, options = {}) {
	const q = String(query == null ? "" : query).trim();
	if (!q) return [];
	const limit = Math.max(1, Math.min(20, Number(options.limit) || 3));
	const probe = { title: q, statement: q, category: "" };
	const queryTech = extractTech(q);
	const scored = [];
	for (const raw of Array.isArray(cards) ? cards : []) {
		const card = normalizeCard(raw);
		let score = scoreMemory(card, probe);
		const techHits = queryTech.filter((tag) => card.tech.includes(tag)).length;
		if (techHits > 0) score += Math.min(0.4, techHits * 0.2);
		const lower = q.toLowerCase();
		if (card.title.toLowerCase().includes(lower) || card.fingerprint.toLowerCase().includes(lower)) score += 0.25;
		if (score > 0) scored.push({ ...card, score: Math.round(Math.min(1.5, score) * 1000) / 1000 });
	}
	scored.sort((a, b) => b.score - a.score || (b.usedOk || 0) - (a.usedOk || 0));
	return scored.slice(0, limit);
}

export default {
	TECH_LEXICON,
	tokenize,
	extractTech,
	normalizeCard,
	distillCard,
	scoreMemory,
	rankMemories,
	buildMemoryPromptSection,
	searchMemories
};