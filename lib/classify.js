// dsh-ctf-auto / lib/classify.js —— 题型自动识别（纯函数）。
//
// 目标：ctf_solve_start 未给 category 时，根据题名/题面/目标/附件名做启发式分类，
// 供「题型层按需加载策略」使用；命中证据写入返回 reasons，便于面板/事件审计。

export const CATEGORIES = [
	"web", "pwn", "reverse", "crypto", "misc", "forensics",
	"osint", "malware", "mobile", "cloud", "ai", "ad", "supply"
];

const RULES = [
	{ category: "pwn", keywords: ["pwn", "heap", "rop", "uaf", "buffer overflow", "stack overflow", "format string", "libc", "seccomp", "shellcode", "canary", "溢出", "堆", "栈", "漏洞利用"], files: [".elf", ".so"], ports: [1337, 9999, 31337, 10000, 10001] },
	{ category: "reverse", keywords: ["reverse", "逆向", "crackme", "keygen", "unpack", "脱壳", "ollvm", "vmp", "smc", "apk", "jadx", "ida", "ghidra", "go 二进制", "固件"], files: [".exe", ".dll", ".apk", ".dmg", ".wasm", ".jar"] },
	{ category: "crypto", keywords: ["crypto", "密码", "rsa", "aes", "des", "ecc", "椭圆", "hash", "md5", "sha", "xor", "异或", "base64", "cipher", "密文", "lattice", "格", "coppersmith", "prng", "mt19937", "签名"], files: [".enc", ".pem", ".key", ".pub"] },
	{ category: "web", keywords: ["web", "http", "sql", "sqli", "xss", "ssti", "ssrf", "xxe", "csrf", "jwt", "cookie", "session", "flask", "django", "spring", "php", "upload", "反序列化", "注入", "越权", "upload", "openresty", "nginx", "tomcat"], files: [".html", ".php", ".jsp", ".har"] },
	{ category: "forensics", keywords: ["forensics", "取证", "pcap", "流量", "抓包", "内存镜像", "memory dump", "磁盘", "镜像", "stego", "隐写", "lsb", "wireshark", "tshark", "volatility", "misc 取证"], files: [".pcap", ".pcapng", ".raw", ".img", ".dd", ".vmem", ".e01", ".mem"] },
	{ category: "misc", keywords: ["misc", "杂项", "编码", "摩斯", "morse", "二维码", "qrcode", "音频", "频谱", "压缩包", "zip 密码", "pyjail", "bashjail", "沙箱逃逸", "游戏", "2048", "数独"], files: [".wav", ".mp3", ".png", ".jpg", ".zip", ".rar", ".7z", ".gif"] },
	{ category: "osint", keywords: ["osint", "社工", "情报", "地理位置", "geo", "社媒", "github 泄露", "公开信息", "whois"], files: [] },
	{ category: "malware", keywords: ["malware", "恶意", "样本分析", "c2", "beacon", "loader", "dropper", "shellcode 分析", "yara", "家族"], files: [] },
	{ category: "mobile", keywords: ["mobile", "android", "ios", "apk", "frida", "xposed", "ipa", "安卓", "移动"], files: [".apk", ".ipa", ".dex"] },
	{ category: "cloud", keywords: ["cloud", "aws", "azure", "gcp", "s3", "oss", "k8s", "kubernetes", "docker", "容器", "元数据", "iam"], files: [".tf", ".yaml", ".yml"] },
	{ category: "ai", keywords: ["ai", "llm", "prompt", "模型", "对抗样本", "adversarial", "embedding", "transformer", "大模型"], files: [".onnx", ".pt", ".pth", ".safetensors"] },
	{ category: "ad", keywords: ["active directory", "域", "kerberos", "kerberoast", "ntlm", "ldap", "域控", "dc", "bloodhound"], files: [".evtx", ".kirbi"] },
	{ category: "supply", keywords: ["supply", "供应链", "npm 包", "pypi", "依赖投毒", "typosquat", "构建链", "ci/cd"], files: [".tgz", ".whl"] }
];

const PORT_RULES = [
	{ category: "web", ports: [80, 443, 8080, 8000, 8888, 5000, 3000, 9000] },
	{ category: "pwn", ports: [1337, 9999, 31337, 10000, 10001, 10002] }
];

function safeString(value) {
	return String(value == null ? "" : value).toLowerCase();
}

/**
 * 题型启发式分类。
 * @param {{title?:string, statement?:string, target?:string, files?:Array<string|{name?:string}>}} challenge
 * @returns {{category:string, confidence:"high"|"medium"|"low", reasons:string[]}}
 */
export function classifyChallenge(challenge = {}) {
	const ch = challenge && typeof challenge === "object" ? challenge : {};
	const title = safeString(ch.title);
	const statement = safeString(ch.statement);
	const target = safeString(ch.target);
	const files = (Array.isArray(ch.files) ? ch.files : []).map((f) => safeString(typeof f === "string" ? f : f && f.name)).join(" ");
	const haystack = `${title}\n${statement}\n${target}\n${files}`;
	const port = (() => {
		const colon = /:(\d{2,5})(?:\/|$|\s)/.exec(target);
		if (colon) return Number(colon[1]);
		// nc/host 形式："nc 1.2.3.4 1337" / "host port"
		const trailing = /(?:^|[\s/])(\d{2,5})\s*$/.exec(target);
		return trailing ? Number(trailing[1]) : 0;
	})();

	const scores = [];
	for (const rule of RULES) {
		const reasons = [];
		let score = 0;
		for (const kw of rule.keywords) {
			if (kw && haystack.includes(kw)) {
				score += title.includes(kw) ? 3 : 1;
				reasons.push(`关键词「${kw}」`);
				if (reasons.length >= 4) break;
			}
		}
		for (const ext of rule.files) {
			if (ext && files.includes(ext)) {
				score += title.includes(ext) ? 3 : 2;
				reasons.push(`附件类型 ${ext}`);
			}
		}
		if (rule.ports && port && rule.ports.includes(port)) {
			score += 3;
			reasons.push(`目标端口 ${port}`);
		}
		if (score > 0) scores.push({ category: rule.category, score, reasons });
	}
	for (const rule of PORT_RULES) {
		if (port && rule.ports.includes(port)) {
			const existing = scores.find((item) => item.category === rule.category);
			if (existing) { existing.score += 1; existing.reasons.push(`端口 ${port} 佐证`); }
			else scores.push({ category: rule.category, score: 1, reasons: [`目标端口 ${port}`] });
		}
	}
	scores.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
	if (scores.length === 0) return { category: "misc", confidence: "low", reasons: ["未命中明确特征，归入 misc（通用）"] };
	const best = scores[0];
	const second = scores[1];
	const confidence = best.score >= 5 ? "high" : best.score >= 2 && (!second || best.score > second.score) ? "medium" : "low";
	return { category: best.category, confidence, reasons: best.reasons.slice(0, 5) };
}

export default { CATEGORIES, classifyChallenge };