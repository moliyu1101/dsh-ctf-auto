// dsh-ctf-auto / lib/flagcheck.js —— flag 格式/证据校验（纯函数），用于收紧 verified 门槛。
//
// verified=true 之前必须过两道闸：flag 形态像 flag（可配置正则）+ evidence 非空且不是占位词。
// 只做「形态与证据文本」校验，绝不代替真实复现；真实复现仍由子代理/平台回显完成。

export const DEFAULT_FLAG_PATTERNS = [
	"^[A-Za-z0-9_]{2,40}\\{[^}\\n]{1,200}\\}$"
];

const PLACEHOLDER_EVIDENCE = [
	"todo", "tbd", "待补", "待验证", "猜测", "应该", "可能", "大概", "推测", "无", "none", "n/a", "na", "-", "——"
];

function asList(value, fallback) {
	if (Array.isArray(value)) {
		const list = value.map((item) => String(item || "").trim()).filter(Boolean);
		if (list.length > 0) return list;
	}
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return fallback.slice();
}

/** 编译正则列表；坏正则忽略并记入 invalid。 */
export function compilePatterns(patterns) {
	const sources = asList(patterns, DEFAULT_FLAG_PATTERNS);
	const compiled = [];
	const invalid = [];
	for (const source of sources) {
		try {
			compiled.push(new RegExp(source));
		} catch {
			invalid.push(source);
		}
	}
	return { compiled, invalid };
}

/**
 * 校验一条 flag 是否满足 verified 门槛。
 * @param {string} flag
 * @param {{patterns?:string[], evidence?:string, minEvidenceChars?:number}} options
 * @returns {{ok:boolean, code:"ok"|"empty"|"format"|"multi-line"|"evidence"|"placeholder-evidence", message:string}}
 */
export function validateVerifiedFlag(flag, options = {}) {
	const opts = options && typeof options === "object" ? options : {};
	const value = String(flag == null ? "" : flag).trim();
	if (!value) return { ok: false, code: "empty", message: "flag 为空" };
	if (/[\r\n]/.test(value)) return { ok: false, code: "multi-line", message: "flag 不能包含换行" };
	if (value.length > 300) return { ok: false, code: "format", message: "flag 过长（>300 字符）" };
	const { compiled } = compilePatterns(opts.patterns);
	const matched = compiled.some((re) => re.test(value));
	if (!matched) return { ok: false, code: "format", message: "flag 不符合配置的格式（flagPatterns）" };
	const evidence = String(opts.evidence == null ? "" : opts.evidence).trim();
	const minChars = Math.max(0, Number(opts.minEvidenceChars) || 12);
	const lower = evidence.toLowerCase();
	if (PLACEHOLDER_EVIDENCE.includes(lower)) {
		return { ok: false, code: "placeholder-evidence", message: "evidence 是占位词，需要真实复现命令/输出" };
	}
	if (evidence.length < minChars) {
		return { ok: false, code: "evidence", message: `evidence 太短（至少 ${minChars} 字符，写复现命令+关键输出）` };
	}
	return { ok: true, code: "ok", message: "flag 形态与证据通过门槛" };
}

export default { DEFAULT_FLAG_PATTERNS, compilePatterns, validateVerifiedFlag };