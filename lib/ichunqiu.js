// Pre-opening protocol preparation. This is not a registered solve/submit adapter.
import crypto from 'node:crypto';

const API_ORIGIN = 'https://apiterminator.ichunqiu.com';
const SIGN_SUFFIX = '7637b08bdb0b29e08300a976b24ca672';
export function parseIchunqiuEntry(value) {
	const url = new URL(value);
	if (url.origin !== 'https://match.ichunqiu.com' || url.username || url.password) throw new Error('请使用 match.ichunqiu.com 的 HTTPS 比赛入口');
	const queryKey = url.searchParams.get('k');
	const key = queryKey || url.pathname.split('/').filter(Boolean)[0] || '';
	if (!key || !queryKey && ['index', 'login', 'page', 'topic', 'rankings'].includes(key)) throw new Error('入口缺少比赛标识');
	return { key, isEncrypt: queryKey ? 1 : 2 };
}

export function signIchunqiuRequest(fields, { key, token = '', stamp = Date.now(), nonce = crypto.randomBytes(16).toString('hex') }) {
	if (!key || !Number.isFinite(stamp) || !/^[a-f0-9]{32}$/i.test(nonce)) throw new Error('签名上下文无效');
	if (Object.keys(fields).some(name => ['k', 'token', 'stamp', 'rs'].includes(name))) throw new Error('业务参数不能覆盖签名上下文');
	if (Object.values(fields).some(value => value == null || typeof value === 'object')) throw new Error('当前只支持标量读取参数');
	const body = { ...fields, k: String(key), stamp, token: String(token), rs: nonce };
	const canonical = Object.keys(body).map(name => `${name}=${body[name]}`).sort().join('&') + '&' + SIGN_SUFFIX;
	const signature = crypto.createHash('sha1').update(canonical.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
	return { body, headers: { 'Content-Type': 'application/json', 'X-Lang': 'zh-cn', SIGN: signature } };
}

// Only a match metadata read is available until authenticated response contracts
// have been checked. No guessed list fields or flag-success mappings are used.
export function createIchunqiuPreflight({ entryUrl, token = '', fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
	const entry = parseIchunqiuEntry(entryUrl);
	async function inspect() {
		const controller = new AbortController();
		const duration = Math.max(1000, Math.min(30000, Number(timeoutMs) || 15000));
		const timer = setTimeout(() => controller.abort(), duration);
		timer.unref?.();
		try {
			const signed = signIchunqiuRequest({ url_key: entry.key, is_encrypt: entry.isEncrypt }, { key: entry.key, token });
			const response = await fetchImpl(API_ORIGIN + '/match/detail', { method: 'POST', headers: signed.headers, body: JSON.stringify(signed.body), signal: controller.signal, redirect: 'error' });
			if (!response.ok) return { ok: false, state: 'http-error', httpStatus: response.status, error: '比赛详情请求失败' };
			const payload = await response.json();
			if (!payload || typeof payload.code !== 'number') return { ok: false, state: 'invalid-response', error: '比赛详情响应结构尚未匹配' };
			const message = typeof payload.message === 'string' ? payload.message.slice(0, 300) : '';
			if ([112, 114, 130].includes(payload.code)) return { ok: false, state: 'authentication-required', code: payload.code, error: message || '平台要求登录或账号认证' };
			if (payload.code !== 0) return { ok: false, state: 'unavailable', code: payload.code, error: message || '当前无法获取比赛信息' };
			if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return { ok: false, state: 'invalid-response', error: '比赛详情响应结构尚未匹配' };
			if (payload.data.is_visit === false || payload.data.is_visit === 0) return { ok: false, state: 'restricted', code: 0, error: '平台当前禁止访问比赛' };
			return { ok: true, state: 'metadata-readable', title: String(payload.data.title || ''), competitionKey: String(payload.data.url_key || entry.key) };
		} catch { return { ok: false, state: controller.signal.aborted ? 'timeout' : 'request-error', error: '无法完成比赛详情检查' }; }
		finally { clearTimeout(timer); }
	}
	return { inspect };
}
