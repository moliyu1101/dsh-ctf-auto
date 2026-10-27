// dsh-ctf-auto / lib/platform-detect.js —— 平台类型自动探测（贴网址猜接口）。
//
// 设计目标：贴一个网址自动识别平台类型并推断接口：
//   1) 先看首页 HTML 指纹（CTFd / NSSCTF / 通用）;
//   2) 再按候选列表路径逐个试 JSON，能拿到「题目数组」就据此推断通用 profile;
//   3) 返回 kind、置信度、证据链与可直接保存的 profile。
// 只做只读探测，不提交、不登录。

const CTFD_HINTS = [/ctfd/i, /api\/v1\/challenges/];
const NSSCTF_HINTS = [/nssctf/i, /api\/challenge/i];

/** 在 JSON 里找第一个「像题目数组」的数组：返回 {dataPath, items}。 */
export function guessChallengeArray(payload) {
	const seen = new Set();
	function walk(node, path, depth) {
		if (depth > 4 || node == null) return null;
		if (Array.isArray(node)) {
			if (node.length === 0) return null;
			const first = node[0];
			if (first && typeof first === "object" && (first.id != null || first.name != null || first.title != null)) {
				return { dataPath: path, items: node };
			}
			return null;
		}
		if (typeof node !== "object") return null;
		if (seen.has(node)) return null;
		seen.add(node);
		for (const key of ["data", "data.data", "challenges", "list", "items", "result", "results"]) {
			const child = key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), node);
			if (child === undefined) continue;
			const found = walk(child, path ? `${path}.${key}` : key, depth + 1);
			if (found) return found;
		}
		for (const key of Object.keys(node)) {
			if (["data", "challenges", "list", "items", "result", "results"].includes(key)) continue;
			const found = walk(node[key], path ? `${path}.${key}` : key, depth + 1);
			if (found) return found;
		}
		return null;
	}
	return walk(payload, "", 0);
}

export const CANDIDATE_LIST_PATHS = ["/api/v1/challenges", "/api/challenges", "/api/v1/challenge/list", "/api/challenge/list", "/api/challenges/list", "/api/v1/challenges?limit=1"];

function normalizeBase(baseUrl) {
	return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/**
 * 探测平台类型。
 * @param {{baseUrl:string, apiToken?:string, fetchImpl?:Function, timeoutMs?:number, paths?:string[]}} options
 * @returns {Promise<{ok:boolean, kind:"ctfd"|"generic"|"unknown", baseUrl:string, confidence:"high"|"medium"|"low", profile?:object, evidence:Array, error?:string}>}
 */
export async function detectPlatform(options = {}) {
	const opts = options && typeof options === "object" ? options : {};
	const baseUrl = normalizeBase(opts.baseUrl);
	const token = String(opts.apiToken || "").trim();
	const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
	const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 8000);
	const paths = Array.isArray(opts.paths) && opts.paths.length ? opts.paths : CANDIDATE_LIST_PATHS;
	const evidence = [];
	const result = { ok: false, kind: "unknown", baseUrl, confidence: "low", evidence, error: "" };
	if (!baseUrl) { result.error = "baseUrl 为空"; return result; }
	if (!fetchImpl) { result.error = "当前环境没有可用的 fetch"; return result; }

	const headers = { Accept: "application/json, text/html" };
	if (token) headers.Authorization = `Bearer ${token}`;

	async function get(url, acceptJson = true) {
		const controller = new AbortController();
		const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		try {
			const response = await fetchImpl(url, { method: "GET", headers: { ...headers, Accept: acceptJson ? "application/json" : "text/html,application/json" }, redirect: "follow", signal: controller.signal });
			const status = Number(response && response.status) || 0;
			let text = "";
			try {
				text = typeof response.text === "function" ? await response.text() : String((response && response.text) || "");
			} catch (error) {
				text = typeof response.text === "string" ? response.text : "";
			}
			let json = null;
			try { json = JSON.parse(text); } catch { json = null; }
			return { status, text, json };
		} catch (error) {
			return { status: 0, text: "", json: null, error: String((error && error.message) || error) };
		} finally {
			clearTimeout(timer);
		}
	}

	// 1) 首页/根路径 HTML 指纹（同时探测 /api/v1/challenges 是否直接返回 JSON）
	const root = await get(baseUrl + "/", false);
	evidence.push({ step: "root", url: baseUrl + "/", status: root.status, note: root.error || (root.text ? `html ${root.text.length}B` : "空响应") });
	if (root.status === 200 && root.text) {
		if (CTFD_HINTS.some((re) => re.test(root.text))) {
			result.ok = true;
			result.kind = "ctfd";
			result.confidence = "high";
			evidence.push({ step: "fingerprint", note: "首页命中 CTFd 特征" });
			return result;
		}
		if (NSSCTF_HINTS.some((re) => re.test(root.text))) evidence.push({ step: "fingerprint", note: "首页疑似 NSSCTF 系（继续探测接口）" });
	}

	// 2) 逐个候选列表路径试 JSON
	for (const path of paths) {
		const url = baseUrl + path;
		const res = await get(url);
		if (res.error || res.status >= 500) {
			evidence.push({ step: "list", url, status: res.status, note: res.error || "不可用" });
			continue;
		}
		if (!res.json) {
			evidence.push({ step: "list", url, status: res.status, note: "不是 JSON" });
			continue;
		}
		// CTFd 特征：{success:true, data:[...]}
		if (res.json && typeof res.json === "object" && ("success" in res.json) && Array.isArray(res.json.data)) {
			result.ok = true;
			result.kind = "ctfd";
			result.confidence = "high";
			evidence.push({ step: "list", url, status: res.status, note: "JSON 形如 {success,data:[...]}（CTFd）" });
			return result;
		}
		const found = guessChallengeArray(res.json);
		if (found) {
			result.ok = true;
			result.kind = "generic";
			result.confidence = evidence.some((item) => /NSSCTF/.test(item.note || "")) ? "medium" : "medium";
			result.profile = {
				listPath: path,
				detailPath: path.replace(/\/?$/, "/{id}"),
				submitPath: path.replace(/\/?$/, "/{id}/submit"),
				map: {
					list: {
						dataPath: found.dataPath || "data",
						id: found.items[0] && found.items[0].id != null ? "id" : "id",
						name: found.items[0] && found.items[0].title != null ? "title" : "name",
						category: "category",
						value: "value",
						files: "files"
					}
				}
			};
			evidence.push({ step: "list", url, status: res.status, note: `找到题目数组 ${found.items.length} 条（dataPath=${found.dataPath || "data"}），推断 generic profile` });
			return result;
		}
		evidence.push({ step: "list", url, status: res.status, note: "JSON 结构里没有题目数组" });
	}

	result.error = "未能识别平台类型（可手动切换「通用 JSON」并填写 profile）";
	return result;
}

export default { detectPlatform, guessChallengeArray, CANDIDATE_LIST_PATHS };