/**
 * dsh-ctf-auto / lib/ctfd.js
 * CTFd 平台客户端（纯 Node，可注入 fetchImpl 便于离线测试）。
 *
 * 契约：DESIGN.md §8
 *   normalizeBaseUrl(url) -> string
 *   createCtfdClient({ baseUrl, token, fetchImpl, timeoutMs })
 *     .me() / .listChallenges() / .getChallenge(id) / .submit(id, flag) / .download(url, {maxBytes})
 * 所有方法返回 { ok:true, data, status } | { ok:false, error, status?, code? }。
 * 鉴权头固定为 `Authorization: Token <token>`。
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const ERROR_TEXT_LIMIT = 500;

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function errorText(error) {
	if (!error) return "";
	if (typeof error === "string") return error;
	if (typeof error.message === "string" && error.message) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function truncateText(text, max = ERROR_TEXT_LIMIT) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function toNumberOrNull(value) {
	if (value == null || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function toNumberOrRaw(value) {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : value;
}

function asBool(value) {
	return value === true || value === "true" || value === 1;
}

/** 从任意跳转/绝对/相对地址解析出可下载 URL。 */
function resolveDownloadUrl(url, baseUrl) {
	const raw = typeof url === "string" ? url.trim() : "";
	if (!raw) return "";
	if (/^https?:\/\//i.test(raw)) return raw;
	if (raw.startsWith("//")) {
		try {
			return `${new URL(baseUrl).protocol}${raw}`;
		} catch {
			return `https:${raw}`;
		}
	}
	let origin = "";
	try {
		origin = new URL(baseUrl).origin;
	} catch {
		origin = "";
	}
	if (raw.startsWith("/")) return origin ? `${origin}${raw}` : `${baseUrl}${raw}`;
	return `${baseUrl}/${raw}`;
}

function safeFilename(name) {
	const value = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
	const base = value.split(/[\\/]/).filter(Boolean).pop() || "";
	return base.replace(/[:*?"<>|]/g, "_").trim() || "";
}

function filenameFromDisposition(headerValue) {
	if (!headerValue) return "";
	const encoded = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(headerValue);
	if (encoded && encoded[1]) {
		try {
			return safeFilename(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, "")));
		} catch {
			return safeFilename(encoded[1]);
		}
	}
	const plain = /filename=(?:"([^"]+)"|([^;]+))/i.exec(headerValue);
	if (plain) return safeFilename((plain[1] ?? plain[2] ?? "").trim());
	return "";
}

function filenameFromUrl(url) {
	if (!url) return "";
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
		try {
			return safeFilename(decodeURIComponent(last));
		} catch {
			return safeFilename(last);
		}
	} catch {
		return "";
	}
}

function extractErrorMessage(payload) {
	if (!isPlainObject(payload)) return "";
	const sources = [];
	if (payload.errors !== undefined) sources.push(payload.errors);
	if (isPlainObject(payload.data) && payload.data.errors !== undefined) {
		sources.push(payload.data.errors);
	}
	if (payload.error !== undefined) sources.push(payload.error);
	if (payload.message !== undefined) sources.push(payload.message);
	if (isPlainObject(payload.data) && payload.data.message !== undefined) {
		sources.push(payload.data.message);
	}
	for (const source of sources) {
		if (source == null) continue;
		if (typeof source === "string" && source.trim()) return truncateText(source);
		if (Array.isArray(source)) {
			const parts = source.map((item) => (typeof item === "string" ? item : errorText(item))).filter(Boolean);
			if (parts.length > 0) return truncateText(parts.join("；"));
		} else if (typeof source === "object") {
			const text = errorText(source);
			if (text && text !== "{}") return truncateText(text);
		}
	}
	return "";
}

/**
 * 归一化平台地址：去尾斜杠；缺协议时补 https://；非 http(s) 返回空串。
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
	if (typeof url !== "string") return "";
	let value = url.trim();
	if (!value) return "";
	if (value.startsWith("//")) value = `https:${value}`;
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return "";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
	if (!parsed.hostname) return "";
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

/**
 * @param {{baseUrl?: string, token?: string, fetchImpl?: Function, timeoutMs?: number}} [options]
 */
export function createCtfdClient(options = {}) {
	const opts = isPlainObject(options) ? options : {};
	const baseUrl = normalizeBaseUrl(opts.baseUrl);
	const token = typeof opts.token === "string" ? opts.token.trim() : "";
	const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
	const injectedFetch = typeof opts.fetchImpl === "function" ? opts.fetchImpl : null;
	const fetchImpl =
		injectedFetch || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
	const maxRetries = Math.max(0, Math.min(5, Number.isFinite(Number(opts.maxRetries)) ? Number(opts.maxRetries) : 2));
	const retryBaseMs = Math.max(0, Number.isFinite(Number(opts.retryBaseMs)) ? Number(opts.retryBaseMs) : 400);
	const minIntervalMs = Math.max(0, Number.isFinite(Number(opts.minIntervalMs)) ? Number(opts.minIntervalMs) : 0);
	const sleepImpl = typeof opts.sleepImpl === "function" ? opts.sleepImpl : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
	let lastRequestAt = 0;

	function authHeaders(extra) {
		const headers = { Accept: "application/json", ...(isPlainObject(extra) ? extra : {}) };
		if (token) headers.Authorization = `Token ${token}`;
		return headers;
	}

	async function fetchWithTimeout(url, init, timeout) {
		if (!fetchImpl) {
			return { ok: false, error: "当前环境没有可用的 fetch" };
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			try {
				controller.abort();
			} catch {
				/* ignore */
			}
		}, timeout);
		if (typeof timer.unref === "function") timer.unref();
		try {
			const response = await fetchImpl(url, { ...init, signal: controller.signal });
			return { ok: true, response };
		} catch (error) {
			if (controller.signal.aborted) {
				return { ok: false, error: `请求超时（${timeout}ms）`, code: "timeout" };
			}
			return { ok: false, error: errorText(error) || "网络请求失败", code: "network" };
		} finally {
			clearTimeout(timer);
		}
	}

	async function throttle() {
		if (minIntervalMs <= 0) return;
		const wait = minIntervalMs - (Date.now() - lastRequestAt);
		if (wait > 0) await sleepImpl(wait);
		lastRequestAt = Date.now();
	}

	/** 节流 + 指数退避重试（429/5xx/网络错误，尊重 Retry-After）；超时不重试。 */
	async function fetchWithRetry(url, init, timeout) {
		let attempt = 0;
		for (;;) {
			await throttle();
			const call = await fetchWithTimeout(url, init, timeout);
			if (call.ok) {
				const status = Number(call.response && call.response.status) || 0;
				if (RETRYABLE_STATUS.has(status) && attempt < maxRetries) {
					let delay = retryBaseMs * Math.pow(2, attempt);
					let retryAfter = 0;
					try {
						const header = call.response.headers && call.response.headers.get ? call.response.headers.get("retry-after") : null;
						retryAfter = Number(header) || 0;
					} catch { retryAfter = 0; }
					if (retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
					attempt += 1;
					try { if (call.response.body && typeof call.response.body.cancel === "function") await call.response.body.cancel(); } catch { /* ignore */ }
					await sleepImpl(delay);
					continue;
				}
				return call;
			}
			if (call.code !== "timeout" && attempt < maxRetries) {
				attempt += 1;
				await sleepImpl(retryBaseMs * Math.pow(2, attempt - 1));
				continue;
			}
			return call;
		}
	}

	function parseJson(text) {
		try {
			return { ok: true, value: JSON.parse(text) };
		} catch {
			return { ok: false };
		}
	}

	function unwrap(payload) {
		if (isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, "success")) {
			if (payload.success === false) {
				return { ok: false, error: extractErrorMessage(payload) || "平台返回 success=false" };
			}
			if (Object.prototype.hasOwnProperty.call(payload, "data")) {
				return { ok: true, data: payload.data };
			}
			return { ok: true, data: {} };
		}
		return { ok: true, data: payload ?? null };
	}

	/**
	 * 统一 JSON 请求：返回 {ok,data,status} / {ok:false,error,status?,code?}。
	 * status 为 HTTP 状态码；payload 为解包前原始响应体（供 submit 容错）。
	 */
	async function requestJson(pathname, init = {}) {
		if (!fetchImpl) return { ok: false, error: "当前环境没有可用的 fetch" };
		if (!baseUrl) return { ok: false, error: "平台地址为空" };
		const method = typeof init.method === "string" ? init.method : "GET";
		const url = `${baseUrl}/api/v1${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
		const headers = authHeaders(init.headers);
		let body;
		if (init.body !== undefined) {
			body = JSON.stringify(init.body);
			headers["Content-Type"] = "application/json";
		}
		const call = await fetchWithRetry(url, { method, headers, body, redirect: "follow" }, positiveInt(init.timeoutMs, timeoutMs));
		if (!call.ok) return call;
		const response = call.response;
		const httpStatus = Number(response && response.status) || 0;
		let text = "";
		try {
			text = await response.text();
		} catch (error) {
			if (response && response.body && response.body.aborted) {
				return { ok: false, error: `请求超时（${timeoutMs}ms）`, code: "timeout" };
			}
			return { ok: false, error: `读取响应失败：${errorText(error)}`, status: httpStatus };
		}
		const parsed = parseJson(text);
		if (!parsed.ok) {
			if (httpStatus < 200 || httpStatus >= 300) {
				return { ok: false, error: `HTTP ${httpStatus}`, status: httpStatus };
			}
			return { ok: false, error: "响应不是合法 JSON", status: httpStatus };
		}
		const payload = parsed.value;
		if (httpStatus < 200 || httpStatus >= 300) {
			const message = extractErrorMessage(payload);
			return {
				ok: false,
				error: message ? `HTTP ${httpStatus}：${message}` : `HTTP ${httpStatus}`,
				status: httpStatus,
				payload,
			};
		}
		const unwrapped = unwrap(payload);
		if (!unwrapped.ok) return { ok: false, error: unwrapped.error, status: httpStatus, payload };
		return { ok: true, data: unwrapped.data, status: httpStatus, payload };
	}

	function normalizeFileList(files) {
		if (!Array.isArray(files)) return [];
		const out = [];
		for (const item of files) {
			if (typeof item === "string") {
				const url = item.trim();
				if (url) out.push({ name: filenameFromUrl(url) || "file.bin", url });
				continue;
			}
			if (!isPlainObject(item)) continue;
			const url = typeof item.url === "string" ? item.url : typeof item.path === "string" ? item.path : "";
			if (!url) continue;
			const name =
				typeof item.name === "string" && item.name
					? safeFilename(item.name) || item.name
					: filenameFromUrl(url) || "file.bin";
			out.push({ name, url });
		}
		return out;
	}

	function normalizeConnectionInfo(value) {
		if (value == null) return "";
		if (typeof value === "string") return value.trim();
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	function normalizeChallengeSummary(raw) {
		const item = isPlainObject(raw) ? raw : {};
		return {
			id: toNumberOrRaw(item.id),
			name: String(item.name ?? item.title ?? ""),
			category: String(item.category ?? ""),
			value: toNumberOrNull(item.value),
			type: String(item.type ?? ""),
			solvedByMe: asBool(item.solved_by_me ?? item.solvedByMe),
			files: normalizeFileList(item.files),
		};
	}

	async function me() {
		const res = await requestJson("/users/me");
		if (!res.ok) return res;
		const raw = isPlainObject(res.data) ? res.data : {};
		return {
			ok: true,
			status: res.status,
			data: {
				...raw,
				id: raw.id ?? null,
				name: String(raw.name ?? raw.username ?? ""),
			},
		};
	}

	async function listChallenges() {
		const res = await requestJson("/challenges");
		if (!res.ok) return res;
		let items = res.data;
		// 容错：个别版本会再包一层 {success,data:{data:[...]}}
		if (isPlainObject(items) && Array.isArray(items.data)) items = items.data;
		if (!Array.isArray(items)) items = [];
		return {
			ok: true,
			status: res.status,
			data: items.filter(isPlainObject).map(normalizeChallengeSummary),
		};
	}

	async function getChallenge(id) {
		const res = await requestJson(`/challenges/${encodeURIComponent(String(id ?? ""))}`);
		if (!res.ok) return res;
		const raw = isPlainObject(res.data) ? res.data : {};
		return {
			ok: true,
			status: res.status,
			data: {
				id: toNumberOrRaw(raw.id ?? id),
				name: String(raw.name ?? raw.title ?? ""),
				description:
					typeof raw.description === "string"
						? raw.description
						: raw.description == null
							? ""
							: String(raw.description),
				connectionInfo: normalizeConnectionInfo(raw.connection_info ?? raw.connectionInfo),
				category: String(raw.category ?? ""),
				value: toNumberOrNull(raw.value),
				type: String(raw.type ?? ""),
				solvedByMe: asBool(raw.solved_by_me ?? raw.solvedByMe),
				files: normalizeFileList(raw.files),
				raw,
			},
		};
	}

	async function hints(challengeId) {
		const res = await requestJson(`/challenges/${encodeURIComponent(String(challengeId ?? ""))}/hints`);
		if (!res.ok) return res;
		let items = res.data;
		if (isPlainObject(items) && Array.isArray(items.data)) items = items.data;
		if (!Array.isArray(items)) items = [];
		return {
			ok: true,
			status: res.status,
			data: items.filter(isPlainObject).map((raw) => ({
				id: toNumberOrRaw(raw.id),
				challengeId: toNumberOrRaw(raw.challenge_id ?? raw.challengeId ?? challengeId),
				content: typeof raw.content === "string" ? raw.content : "",
				cost: toNumberOrNull(raw.cost),
			})),
		};
	}

	async function unlockHint(hintId) {
		const res = await requestJson(`/hints/${encodeURIComponent(String(hintId ?? ""))}/unlock`, { method: "POST", body: {} });
		if (!res.ok) return res;
		const data = isPlainObject(res.data) ? res.data : {};
		return {
			ok: true,
			status: res.status,
			data: {
				content: typeof data.content === "string" ? data.content : "",
				cost: toNumberOrNull(data.cost),
				raw: data,
			},
		};
	}

	async function submit(challengeId, flag) {
		const res = await requestJson("/challenges/attempt", {
			method: "POST",
			body: { challenge_id: toNumberOrRaw(challengeId), submission: String(flag ?? "") },
		});
		if (!res.ok) return res;
		const data = isPlainObject(res.data) ? res.data : {};
		let status = typeof data.status === "string" ? data.status : "";
		let message = typeof data.message === "string" ? data.message : "";
		const payload = isPlainObject(res.payload) ? res.payload : {};
		if (!status && typeof payload.status === "string") status = payload.status;
		if (!message && typeof payload.message === "string") message = payload.message;
		return {
			ok: true,
			data: { status: status.trim(), message },
			status: status.trim(),
			message,
			httpStatus: res.status,
		};
	}

	async function download(url, downloadOptions = {}) {
		if (!fetchImpl) return { ok: false, error: "当前环境没有可用的 fetch" };
		const target = resolveDownloadUrl(url, baseUrl);
		if (!target) return { ok: false, error: "下载地址为空" };
		const maxBytes = positiveInt(downloadOptions && downloadOptions.maxBytes, DEFAULT_MAX_DOWNLOAD_BYTES);
		const call = await fetchWithRetry(
			target,
			{
				method: "GET",
				headers: authHeaders({ Accept: "*/*" }),
				redirect: "follow",
			},
			positiveInt(downloadOptions && downloadOptions.timeoutMs, timeoutMs),
		);
		if (!call.ok) return call;
		const response = call.response;
		const httpStatus = Number(response && response.status) || 0;
		if (httpStatus < 200 || httpStatus >= 300) {
			return { ok: false, error: `HTTP ${httpStatus}`, status: httpStatus };
		}
		let contentLength = null;
		try {
			const header = response.headers && response.headers.get ? response.headers.get("content-length") : null;
			if (header != null && header !== "") {
				const parsed = Number(header);
				if (Number.isFinite(parsed) && parsed >= 0) contentLength = parsed;
			}
		} catch {
			contentLength = null;
		}
		if (contentLength != null && contentLength > maxBytes) {
			return {
				ok: false,
				error: `附件超过大小上限（${contentLength} > ${maxBytes} 字节）`,
				code: "too-large",
				size: contentLength,
				maxBytes,
			};
		}
		let bytes;
		try {
			const arrayBuffer = await response.arrayBuffer();
			bytes = new Uint8Array(arrayBuffer);
		} catch (error) {
			return { ok: false, error: `读取附件失败：${errorText(error)}`, status: httpStatus, code: "network" };
		}
		if (bytes.length > maxBytes) {
			return {
				ok: false,
				error: `附件超过大小上限（${bytes.length} > ${maxBytes} 字节）`,
				code: "too-large",
				size: bytes.length,
				maxBytes,
			};
		}
		let disposition = "";
		let contentType = "";
		try {
			disposition = response.headers.get("content-disposition") || "";
			contentType = response.headers.get("content-type") || "";
		} catch {
			/* ignore */
		}
		const filename =
			filenameFromDisposition(disposition) || filenameFromUrl(target) || "download.bin";
		return {
			ok: true,
			data: { bytes, filename, size: bytes.length, contentType },
			bytes,
			filename,
			size: bytes.length,
			contentType,
			status: httpStatus,
		};
	}

	return {
		baseUrl,
		tokenSet: !!token,
		timeoutMs,
		me,
		listChallenges,
		getChallenge,
		hints,
		unlockHint,
		submit,
		download,
	};
}
