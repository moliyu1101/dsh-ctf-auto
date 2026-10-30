// dsh-ctf-auto / lib/platform-generic.js —— 通用 JSON 平台适配器（多平台/新平台可接）。
//
// 用一个可配置 profile 适配任意 HTTP JSON 平台（字段路径 + 提交回显映射）：
//   {
//     listPath: "/api/challenges",
//     detailPath: "/api/challenges/{id}",
//     submitPath: "/api/challenges/{id}/submit",
//     submitMethod: "POST",
//     submitBodyField: "flag",
//     headers: { ... },
//     map: {
//       list: { dataPath: "data", id: "id", name: "name", category: "category", value: "value", description: "description", files: "files" },
//       detail: { dataPath: "data" },
//       submit: { statusPath: "data.status", messagePath: "data.message", okStatuses: ["correct","success"], alreadyStatuses: ["already_solved"] }
//     }
//   }
// 只做 GET 列表/详情 + POST 提交；附件自动下载不支持（返回明确错误，由面板/子代理手动处理）。

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 安全取嵌套路径：a.b[0].c / a.b.c；缺失返回 undefined。 */
export function getPath(obj, path) {
	const text = String(path == null ? "" : path).trim();
	if (!text) return obj;
	let cursor = obj;
	for (const part of text.split(".")) {
		if (cursor == null) return undefined;
		const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
		if (!match) return undefined;
		if (match[1]) cursor = cursor[match[1]];
		for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
			if (cursor == null) return undefined;
			cursor = cursor[Number(index[1])];
		}
	}
	return cursor;
}

/** 归一化 profile：补默认路径/映射，缺失字段用合理默认。 */
export function normalizeGenericProfile(raw) {
	const p = isPlainObject(raw) ? raw : {};
	const map = isPlainObject(p.map) ? p.map : {};
	const list = isPlainObject(map.list) ? map.list : {};
	const detail = isPlainObject(map.detail) ? map.detail : {};
	const submit = isPlainObject(map.submit) ? map.submit : {};
	const pagination = isPlainObject(p.pagination) ? p.pagination : null;
	const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(value) || fallback)));
	const auth = isPlainObject(p.auth) ? p.auth : {};
	if (auth.header && !/^[A-Za-z0-9-]+$/.test(String(auth.header))) throw new Error("鉴权头名称无效");
	if (/[\r\n]/.test(String(auth.prefix || ""))) throw new Error("鉴权前缀不能包含换行");
	return {
		listPath: String(p.listPath || "/api/challenges"),
		detailPath: String(p.detailPath || "/api/challenges/{id}"),
		submitPath: String(p.submitPath || "/api/challenges/{id}/submit"),
		submitMethod: String(p.submitMethod || "POST").toUpperCase(),
		submitBodyField: String(p.submitBodyField || "flag"),
		headers: isPlainObject(p.headers) ? p.headers : {},
		auth: { header: String(auth.header || "Authorization"), prefix: auth.prefix == null ? "Bearer " : String(auth.prefix) },
		pagination: pagination ? { pageParam: String(pagination.pageParam || "page"), sizeParam: String(pagination.sizeParam || "limit"), pageSize: integer(pagination.pageSize, 50, 1, 200), startPage: Number.isInteger(pagination.startPage) && pagination.startPage >= 0 ? pagination.startPage : 1, maxPages: integer(pagination.maxPages, 20, 1, 100), hasMorePath: String(pagination.hasMorePath || "") } : null,
		submitBody: isPlainObject(p.submitBody) ? p.submitBody : null,
		map: {
			list: {
				dataPath: String(list.dataPath == null ? "data" : list.dataPath),
				id: String(list.id || "id"),
				name: String(list.name || "name"),
				category: String(list.category || "category"),
				value: String(list.value || "value"),
				description: String(list.description || "description"),
				files: String(list.files || "files"),
				solvedByMe: String(list.solvedByMe || "solved_by_me")
			},
			detail: {
				dataPath: String(detail.dataPath == null ? "data" : detail.dataPath),
				description: String(detail.description || "description"),
				connectionInfo: String(detail.connectionInfo || "connection_info")
			},
			submit: {
				statusPath: String(submit.statusPath || "data.status"),
				messagePath: String(submit.messagePath || "data.message"),
				okStatuses: Array.isArray(submit.okStatuses) ? submit.okStatuses.map(String) : ["correct", "success", "accepted"],
				alreadyStatuses: Array.isArray(submit.alreadyStatuses) ? submit.alreadyStatuses.map(String) : ["already_solved", "alreadySolved"]
			}
		}
	};
}

function normalizeFileList(files) {
	if (!Array.isArray(files)) return [];
	return files
		.map((item) => {
			if (typeof item === "string") return { name: item.split("/").pop() || "file.bin", url: item };
			if (!isPlainObject(item)) return null;
			const url = typeof item.url === "string" ? item.url : typeof item.path === "string" ? item.path : "";
			if (!url) return null;
			return { name: String(item.name || url.split("/").pop() || "file.bin"), url };
		})
		.filter(Boolean);
}

/**
 * 创建通用平台客户端（方法签名与 ctfd 适配器保持一致）。
 * @param {{baseUrl:string, token?:string, profile?:object, fetchImpl?:Function, timeoutMs?:number}} options
 */
export function createGenericPlatformClient(options = {}) {
	const opts = isPlainObject(options) ? options : {};
	const baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
	const token = typeof opts.token === "string" ? opts.token.trim() : "";
	const profile = normalizeGenericProfile(opts.profile);
	const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
	const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 15000);

	function authHeaders(extra) {
		const headers = { Accept: "application/json", ...(isPlainObject(profile.headers) ? profile.headers : {}), ...(isPlainObject(extra) ? extra : {}) };
		if (token && !Object.keys(headers).some(key => key.toLowerCase() === profile.auth.header.toLowerCase())) headers[profile.auth.header] = profile.auth.prefix + token;
		return headers;
	}

	async function request(pathname, init = {}) {
		if (!fetchImpl) return { ok: false, error: "当前环境没有可用的 fetch" };
		if (!baseUrl) return { ok: false, error: "平台地址为空" };
		const url = `${baseUrl}${pathname.startsWith("/") ? pathname : "/" + pathname}`;
		const controller = new AbortController();
		const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		try {
			const headers = authHeaders(init.headers);
			let body;
			if (init.body !== undefined) {
				body = JSON.stringify(init.body);
				headers["Content-Type"] = "application/json";
			}
			const response = await fetchImpl(url, { method: init.method || "GET", headers, body, redirect: "error", signal: controller.signal });
			const status = Number(response && response.status) || 0;
			let payload = null;
			try { payload = await response.json(); } catch { payload = null; }
			if (status < 200 || status >= 300) {
				const message = (isPlainObject(payload) && String(payload.message || payload.error || "")) || "";
				return { ok: false, error: `HTTP ${status}${message ? "：" + message : ""}`, status, payload };
			}
			return { ok: true, status, payload: payload == null ? {} : payload };
		} catch (error) {
			const aborted = controller.signal.aborted;
			return { ok: false, error: aborted ? `请求超时（${timeoutMs}ms）` : String((error && error.message) || error), code: aborted ? "timeout" : "network" };
		} finally {
			clearTimeout(timer);
		}
	}

	function normalizeSummary(raw) {
		const item = isPlainObject(raw) ? raw : {};
		const m = profile.map.list;
		return {
			id: getPath(item, m.id),
			name: String(getPath(item, m.name) ?? ""),
			category: String(getPath(item, m.category) ?? ""),
			value: Number.isFinite(Number(getPath(item, m.value))) ? Number(getPath(item, m.value)) : null,
			type: String(getPath(item, "type") ?? ""),
			solvedByMe: getPath(item, m.solvedByMe) === true,
			files: normalizeFileList(getPath(item, m.files))
		};
	}

	async function listChallenges() {
		const pagination = profile.pagination, data = [], ids = new Set(), pages = new Set();
		const maxPages = pagination ? pagination.maxPages : 1;
		for (let index = 0; index < maxPages; index++) {
			let pathname = profile.listPath;
			if (pagination) {
				const question = pathname.indexOf('?');
				const query = new URLSearchParams(question >= 0 ? pathname.slice(question + 1) : '');
				query.set(pagination.pageParam, String(pagination.startPage + index));
				query.set(pagination.sizeParam, String(pagination.pageSize));
				pathname = (question >= 0 ? pathname.slice(0, question) : pathname) + '?' + query;
			}
			const res = await request(pathname);
			if (!res.ok) return res;
			const items = getPath(res.payload, profile.map.list.dataPath);
			if (!Array.isArray(items)) return { ok: false, code: "PLATFORM_LIST_INVALID", error: `题目列表字段 ${profile.map.list.dataPath || "(根节点)"} 不是数组，请检查平台 Profile`, status: res.status };
			const normalized = items.filter(isPlainObject).map(normalizeSummary);
			const pageKey = JSON.stringify(normalized.map(item => item.id));
			if (pagination && items.length && pages.has(pageKey)) return { ok: false, code: 'PAGINATION_REPEATED', error: '平台重复返回同一页，请检查分页参数' };
			pages.add(pageKey);
			for (const item of normalized) {
				if (item.id == null || !String(item.id).trim() || ids.has(String(item.id))) continue;
				ids.add(String(item.id)); data.push(item);
			}
			if (!pagination) return { ok: true, status: res.status, data };
			const hasMore = pagination.hasMorePath ? getPath(res.payload, pagination.hasMorePath) : items.length >= pagination.pageSize;
			if (pagination.hasMorePath && typeof hasMore !== 'boolean') return { ok: false, code: 'PAGINATION_INVALID', error: '分页 hasMorePath 字段必须是布尔值' };
			if (!hasMore) return { ok: true, status: res.status, data, pages: index + 1, possiblyTruncated: false };
		}
		return { ok: true, data, pages: maxPages, possiblyTruncated: true };
	}

	async function getChallenge(id) {
		const pathname = profile.detailPath.replace(/\{id\}/g, encodeURIComponent(String(id ?? "")));
		const res = await request(pathname);
		if (!res.ok) return res;
		const raw = getPath(res.payload, profile.map.detail.dataPath);
		const item = isPlainObject(raw) ? raw : {};
		const summary = normalizeSummary(item);
		return {
			ok: true,
			status: res.status,
			data: {
				...summary,
				description: String(getPath(item, profile.map.detail.description) ?? ""),
				connectionInfo: String(getPath(item, profile.map.detail.connectionInfo) ?? ""),
				raw: item
			}
		};
	}

	function renderSubmitBody(value, id, flag) {
		if (value === '{id}') return String(id);
		if (value === '{flag}') return String(flag);
		if (Array.isArray(value)) return value.map(item => renderSubmitBody(item, id, flag));
		if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderSubmitBody(item, id, flag)]));
		return value;
	}
	async function submit(challengeId, flag) {
		const pathname = profile.submitPath.replace(/\{id\}/g, encodeURIComponent(String(challengeId ?? "")));
		const res = await request(pathname, { method: profile.submitMethod, body: profile.submitBody ? renderSubmitBody(profile.submitBody, challengeId, flag) : { [profile.submitBodyField]: String(flag ?? "") } });
		if (!res.ok) return res;
		const rawStatus = String(getPath(res.payload, profile.map.submit.statusPath) ?? "").trim();
		const message = String(getPath(res.payload, profile.map.submit.messagePath) ?? "");
		let status = rawStatus;
		if (profile.map.submit.alreadyStatuses.includes(rawStatus)) status = "already_solved";
		else if (profile.map.submit.okStatuses.includes(rawStatus)) status = "correct";
		return { ok: true, status, message, httpStatus: res.status, data: { status, message, rawStatus } };
	}

	async function download() {
		return { ok: false, error: "通用适配器不支持自动下载附件（请在题面/平台手动下载后作为附件登记）" };
	}

	async function me() {
		return { ok: false, error: "通用适配器无 users/me（用 listChallenges 连通性测试）" };
	}

	return { baseUrl, tokenSet: !!token, timeoutMs, mode: "generic", profile, me, listChallenges, getChallenge, hints: async () => ({ ok: false, error: "通用适配器不支持 hints" }), unlockHint: async () => ({ ok: false, error: "通用适配器不支持 hints" }), submit, download };
}

export default { getPath, normalizeGenericProfile, createGenericPlatformClient };