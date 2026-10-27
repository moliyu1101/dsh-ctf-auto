window.__ModuleLoader__.load({ id: "@dsh-external/dsh-ctf-auto", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-ctf-auto client — 设置页「CTF 自动解题」：题板 + 自动解题编排面板。
// 通道：同源 GET /dsh-ctf-auto/csrf 取 token；业务请求 POST /dsh-ctf-auto/<endpoint>，头 x-dsh-csrf。
// 数据：页面可见时每 3 秒轮询 state.get；展开单题时轮询 challenge.get；请求失败显示错误条不白屏。
"use strict";
var React = require("react");
var h = React.createElement;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;

var API_BASE = "/dsh-ctf-auto";
var POLL_MS = 3000;
var TOAST_MS = 3200;

var CATEGORIES = ["web", "pwn", "reverse", "crypto", "misc", "forensics", "mobile", "cloud", "ai", "ad", "supply", "osint"];
var CATEGORY_LABEL = {
	web: "Web", pwn: "Pwn", reverse: "逆向", crypto: "密码", misc: "杂项", forensics: "取证",
	mobile: "移动", cloud: "云", ai: "AI", ad: "AD", supply: "供应链", osint: "OSINT"
};
var STATUS_LABEL = { queued: "排队中", running: "运行中", solved: "已解", stuck: "卡住", failed: "失败", stopped: "已停止" };
var STATUS_TONE = { queued: "queued", running: "run", solved: "ok", stuck: "warn", failed: "danger", stopped: "muted" };
var ATTEMPT_STATUS_LABEL = { running: "运行中", completed: "已完成", timeout: "超时", error: "异常", aborted: "已中止" };
var ATTEMPT_TONE = { running: "run", completed: "ok", timeout: "warn", error: "danger", aborted: "muted" };
var STOP_REASON_LABEL = {
	completed: "完成", aborted: "中止", error: "异常", "max-tokens": "token 上限", refusal: "拒答", timeout: "超时"
};
var EVENT_LABEL = {
	queued: "入队", started: "启动", "attempt-start": "尝试开始", "attempt-end": "尝试结束",
	flag: "flag", stuck: "卡住", stopped: "停止", error: "错误", note: "备注"
};
var METHOD_LABEL = { "local-check": "本地校验", derivation: "推导", manual: "人工", platform: "平台" };
// 单标签内部分页：所有界面都收在「CTF 自动解题」里
var TABS = [
	{ key: "board", label: "题板" },
	{ key: "platform", label: "平台" },
	{ key: "schedule", label: "调度" },
	{ key: "ledger", label: "台账" },
	{ key: "report", label: "复盘" },
	{ key: "knowledge", label: "知识" },
	{ key: "memory", label: "记忆" },
	{ key: "settings", label: "设置" }
];

// ---- 通道：csrf token 懒加载 + 403 自动重取一次（宿主重启轮换 token 后已开页面自愈）----
var csrfCache = {};
function csrfOf() {
	if (!csrfCache[API_BASE]) {
		csrfCache[API_BASE] = fetch(API_BASE + "/csrf")
			.then(function (r) { return r.json(); })
			.then(function (r) { return r && r.token ? r.token : ""; })
			.catch(function () { return ""; });
	}
	return csrfCache[API_BASE];
}
function sendPost(tok, endpoint, payload) {
	var headers = { "content-type": "application/json" };
	if (tok) headers["x-dsh-csrf"] = tok;
	return fetch(API_BASE + "/" + endpoint, {
		method: "POST",
		headers: headers,
		body: JSON.stringify(payload || {})
	});
}
/** 永不 reject：网络/解析/业务错误统一归一为 {ok:false,error}，调用方只处理数据。 */
function request(endpoint, payload) {
	return csrfOf()
		.then(function (tok) { return sendPost(tok, endpoint, payload); })
		.then(function (res) {
			if (res.status === 403) {
				delete csrfCache[API_BASE];
				return csrfOf().then(function (tok2) { return sendPost(tok2, endpoint, payload); });
			}
			return res;
		})
		.then(function (res) {
			return res.json().then(function (body) {
				if (body && typeof body === "object") return body;
				return { ok: false, error: "响应格式异常" };
			}, function () {
				return { ok: false, error: "响应解析失败（HTTP " + res.status + "）" };
			});
		})
		.catch(function (err) {
			return { ok: false, error: "通道不可达：" + (err && err.message ? err.message : "请求失败") };
		});
}

// ---- 格式化 ----
function pad2(n) { return n < 10 ? "0" + n : String(n); }
function fmtTime(ms) {
	if (!ms) return "—";
	var d = new Date(ms);
	return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function fmtClock(ms) {
	if (!ms) return "--:--:--";
	var d = new Date(ms);
	return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function fmtDur(ms) {
	if (!ms || ms < 0) return "—";
	var s = Math.floor(ms / 1000);
	if (s < 60) return s + "s";
	var m = Math.floor(s / 60);
	if (m < 60) return m + "m" + (s % 60 ? String(s % 60) + "s" : "");
	var hh = Math.floor(m / 60);
	return hh + "h" + (m % 60 ? String(m % 60) + "m" : "");
}
function elapsedOf(c) {
	if (!c.startedAt) return 0;
	return (c.endedAt || Date.now()) - c.startedAt;
}
function shortSession(id) {
	var s = String(id || "");
	if (s.length <= 20) return s;
	return s.slice(0, 8) + "…" + s.slice(-6);
}
function configText(cfg) {
	if (!cfg) return "";
	var parts = [];
	if (cfg.concurrency != null) parts.push("并发 " + cfg.concurrency);
	if (cfg.timeoutMs) parts.push("超时 " + fmtDur(cfg.timeoutMs));
	if (cfg.maxAttempts != null) parts.push("最多 " + cfg.maxAttempts + " 次");
	if (cfg.autoRetry != null) parts.push("自动重试 " + (cfg.autoRetry ? "开" : "关"));
	if (cfg.solverPreset) parts.push("预设 " + cfg.solverPreset);
	return parts.length ? " · " + parts.join(" · ") : "";
}

// ---- 样式：单文件 <style> 注入，ctx.effect 返回清理；浅/深色两套 CSS 变量 ----
var CSS = [
	"body{--dct-line:#3b7ddd;--dct-ink:#12233a;--dct-ink-2:#2b3e57;--dct-ink-3:#3d5273;--dct-ink-4:#556b86;--dct-ink-5:#6b7f97;--dct-ink-6:#7d8ea3;--dct-accent:#2f6fe4;--dct-accent-2:#38a4f7;--dct-on-accent:#ffffff;--dct-ok:#1a9c63;--dct-ok-ink:#0f7a4c;--dct-warn:#b07800;--dct-warn-ink:#8a5d00;--dct-danger:#e03131;--dct-danger-ink:#c92a2a;--dct-queued:#6b7f97;--dct-run:#2f6fe4;--dct-muted:#8a97a8;--dct-panel:rgba(255,255,255,.82);--dct-card:rgba(255,255,255,.7);--dct-input:#ffffff;--dct-float:rgba(255,255,255,.97);--dct-root-bg:radial-gradient(1100px 460px at 76% -10%,color-mix(in srgb,var(--dct-line) 8%,transparent),transparent 60%),linear-gradient(180deg,#f8fbff 0%,#edf3fb 100%);--dct-title-grad:linear-gradient(90deg,#2f6fe4,#12233a,#2f6fe4);--dct-glow:0 4px 14px rgba(20,40,80,.07);--dct-shadow:0 8px 28px rgba(20,40,80,.18);--dct-soft:color-mix(in srgb,var(--dct-line) 8%,transparent);--dct-soft-2:color-mix(in srgb,var(--dct-line) 15%,transparent);--dct-hover:color-mix(in srgb,var(--dct-line) 18%,transparent)}",
	"body[data-ds-dark-theme]{--dct-line:#3a9dff;--dct-ink:#e8f3ff;--dct-ink-2:#d7e7f8;--dct-ink-3:#c6dcf2;--dct-ink-4:#b2cbe6;--dct-ink-5:#97b4d4;--dct-ink-6:#8aa7c7;--dct-accent:#3f8ef7;--dct-accent-2:#38d4ff;--dct-on-accent:#04101f;--dct-ok:#3ddc97;--dct-ok-ink:#7ff0bf;--dct-warn:#f5c542;--dct-warn-ink:#ffe9ad;--dct-danger:#ff7878;--dct-danger-ink:#ffc9c9;--dct-queued:#9db9d8;--dct-run:#5cb8ff;--dct-muted:#7d97b8;--dct-panel:rgba(10,28,52,.55);--dct-card:rgba(12,32,60,.62);--dct-input:rgba(10,30,60,.6);--dct-float:rgba(8,24,46,.95);--dct-root-bg:radial-gradient(1100px 460px at 76% -10%,rgba(35,90,160,.35),transparent 60%),linear-gradient(180deg,#081b33 0%,#061225 100%);--dct-title-grad:linear-gradient(90deg,#7cc8ff,#ffffff,#7cc8ff);--dct-glow:0 0 15px rgba(58,157,255,.1);--dct-shadow:0 8px 28px rgba(2,8,20,.55);--dct-soft:color-mix(in srgb,var(--dct-line) 14%,transparent);--dct-soft-2:color-mix(in srgb,var(--dct-line) 22%,transparent);--dct-hover:rgba(58,157,255,.2)}",
	".dsh-ctf-root,.dsh-ctf-root *{box-sizing:border-box}",
	".dsh-ctf-root{display:flex;flex-direction:column;gap:12px;min-height:100%;padding:18px clamp(14px,2.6vw,32px) 48px;color:var(--dct-ink-2);background:var(--dct-root-bg);font-size:12px;font-family:var(--dsw-font-family,system-ui,-apple-system,'Segoe UI',sans-serif)}",
	".dsh-ctf-root.is-view{gap:10px;padding:12px clamp(12px,2.2vw,26px) 32px}",
	".dsh-ctf-root.is-view .dsh-ctf-title{font-size:17px;letter-spacing:1px}",
	".dsh-ctf-panel{border:1px solid var(--dct-soft-2);border-radius:12px;background:var(--dct-panel);box-shadow:var(--dct-glow);backdrop-filter:blur(10px)}",
	".dsh-ctf-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;padding:12px 18px}",
	".dsh-ctf-title{font-size:19px;font-weight:800;letter-spacing:1.5px;line-height:1.35;background:var(--dct-title-grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}",
	".dsh-ctf-sub{font-size:11px;line-height:1.7;color:var(--dct-ink-5);margin-top:2px;max-width:780px}",
	".dsh-ctf-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
	".dsh-ctf-btn{border:1px solid var(--dct-soft-2);border-radius:8px;padding:5px 13px;font-size:12px;line-height:1.5;color:var(--dct-ink-3);background:var(--dct-soft);cursor:pointer;transition:background .15s,border-color .15s,color .15s,opacity .15s;white-space:nowrap;font-family:inherit}",
	".dsh-ctf-btn:hover:not(:disabled){background:var(--dct-hover)}",
	".dsh-ctf-btn:disabled{opacity:.38;cursor:not-allowed}",
	".dsh-ctf-btn.is-primary{border-color:var(--dct-accent);background:linear-gradient(90deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);font-weight:700}",
	".dsh-ctf-btn.is-danger{border-color:color-mix(in srgb,var(--dct-danger) 45%,transparent);color:var(--dct-danger-ink)}",
	".dsh-ctf-btn.is-ghost{border-color:transparent;background:transparent;color:var(--dct-ink-5)}",
	".dsh-ctf-btn.is-sm{padding:2px 9px;font-size:11px;border-radius:6px}",
	".dsh-ctf-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;border:1px solid color-mix(in srgb,var(--dct-danger) 45%,transparent);border-left-width:3px;border-radius:9px;background:color-mix(in srgb,var(--dct-danger) 8%,transparent);color:var(--dct-danger-ink);font-size:11.5px;line-height:1.6;word-break:break-word}",
	".dsh-ctf-error.is-inline{margin:2px 0 8px}",
	".dsh-ctf-error.is-warn{border-color:color-mix(in srgb,var(--dct-warn) 50%,transparent);background:color-mix(in srgb,var(--dct-warn) 9%,transparent);color:var(--dct-warn-ink)}",
	".dsh-ctf-statsbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 16px}",
	".dsh-ctf-stats{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
	".dsh-ctf-stat{border:1px solid var(--dct-soft-2);border-radius:9px;padding:4px 12px;background:var(--dct-soft);min-width:62px;text-align:center}",
	".dsh-ctf-stat b{display:block;font-size:17px;line-height:1.25;font-weight:800;font-variant-numeric:tabular-nums;color:var(--dct-ink)}",
	".dsh-ctf-stat span{font-size:10px;color:var(--dct-ink-5);letter-spacing:.4px}",
	".dsh-ctf-stat.is-queued b{color:var(--dct-queued)}",
	".dsh-ctf-stat.is-run b{color:var(--dct-run)}",
	".dsh-ctf-stat.is-ok b{color:var(--dct-ok-ink)}",
	".dsh-ctf-stat.is-warn b{color:var(--dct-warn-ink)}",
	".dsh-ctf-stats-note{font-size:10.5px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums}",
	".dsh-ctf-formwrap{padding:14px 18px}",
	".dsh-ctf-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}",
	".dsh-ctf-field{display:flex;flex-direction:column;gap:5px;min-width:0}",
	".dsh-ctf-field.is-wide{grid-column:1/-1}",
	".dsh-ctf-field>span{font-size:10.5px;font-weight:700;letter-spacing:.4px;color:var(--dct-ink-4)}",
	".dsh-ctf-in{width:100%;border:1px solid var(--dct-soft-2);border-radius:8px;background:var(--dct-input);color:var(--dct-ink-2);padding:6px 10px;font-size:12px;line-height:1.55;outline:none;font-family:inherit;transition:border-color .15s,box-shadow .15s}",
	".dsh-ctf-in:focus{border-color:var(--dct-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dct-accent) 14%,transparent)}",
	"textarea.dsh-ctf-in{resize:vertical;min-height:64px}",
	"select.dsh-ctf-in{appearance:auto}",
	".dsh-ctf-formfoot{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:2px}",
	".dsh-ctf-formnote{grid-column:1/-1;font-size:10.5px;color:var(--dct-ink-6);line-height:1.6}",
	".dsh-ctf-check{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dct-ink-4);cursor:pointer;user-select:none}",
	".dsh-ctf-check input{accent-color:var(--dct-accent);margin:0}",
	".dsh-ctf-list{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-card{border:1px solid var(--dct-soft-2);border-radius:11px;background:var(--dct-card);box-shadow:var(--dct-glow);overflow:hidden;transition:border-color .15s}",
	".dsh-ctf-card:hover{border-color:color-mix(in srgb,var(--dct-line) 45%,transparent)}",
	".dsh-ctf-card.is-open{border-color:color-mix(in srgb,var(--dct-line) 55%,transparent)}",
	".dsh-ctf-card.is-solved{border-left:3px solid var(--dct-ok)}",
	".dsh-ctf-card.is-running{border-left:3px solid var(--dct-run)}",
	".dsh-ctf-card-head{display:flex;flex-direction:column;gap:7px;padding:10px 14px}",
	".dsh-ctf-card-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-card-title{font-size:13.5px;font-weight:700;line-height:1.45;color:var(--dct-ink);word-break:break-word}",
	".dsh-ctf-card-id{font-size:10px;color:var(--dct-ink-6);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}",
	".dsh-ctf-card-sub{font-size:10.5px;color:var(--dct-ink-6);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;padding:0 14px 8px}",
	".dsh-ctf-card-warn{font-size:11px;color:var(--dct-warn-ink);background:color-mix(in srgb,var(--dct-warn) 8%,transparent);border-top:1px dashed color-mix(in srgb,var(--dct-warn) 30%,transparent);padding:6px 14px}",
	".dsh-ctf-metric{font-size:10.5px;color:var(--dct-ink-5)}",
	".dsh-ctf-metric b{color:var(--dct-ink-3);font-variant-numeric:tabular-nums}",
	".dsh-ctf-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border-radius:999px;font-size:10.5px;font-weight:700;line-height:17px;border:1px solid currentColor;white-space:nowrap}",
	".dsh-ctf-badge i{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}",
	".dsh-ctf-badge.is-queued{color:var(--dct-queued);background:color-mix(in srgb,var(--dct-queued) 9%,transparent)}",
	".dsh-ctf-badge.is-run{color:var(--dct-run);background:color-mix(in srgb,var(--dct-run) 9%,transparent)}",
	".dsh-ctf-badge.is-ok{color:var(--dct-ok-ink);background:color-mix(in srgb,var(--dct-ok) 11%,transparent)}",
	".dsh-ctf-badge.is-warn{color:var(--dct-warn-ink);background:color-mix(in srgb,var(--dct-warn) 10%,transparent)}",
	".dsh-ctf-badge.is-danger{color:var(--dct-danger-ink);background:color-mix(in srgb,var(--dct-danger) 9%,transparent)}",
	".dsh-ctf-badge.is-muted{color:var(--dct-muted);background:color-mix(in srgb,var(--dct-muted) 9%,transparent)}",
	".dsh-ctf-badge.is-run i{animation:dsh-ctf-pulse 1.5s ease-in-out infinite}",
	"@keyframes dsh-ctf-pulse{0%,100%{opacity:1}50%{opacity:.25}}",
	".dsh-ctf-chip{display:inline-block;padding:0 7px;border:1px solid var(--dct-soft-2);border-radius:5px;font-size:9.5px;line-height:16px;color:var(--dct-ink-5);background:var(--dct-soft);letter-spacing:.3px}",
	".dsh-ctf-chip.is-mine{color:var(--dct-accent);border-color:color-mix(in srgb,var(--dct-accent) 55%,transparent);background:color-mix(in srgb,var(--dct-accent) 12%,transparent);font-weight:700}",
	".dsh-ctf-btn.is-on{border-color:var(--dct-accent);background:color-mix(in srgb,var(--dct-accent) 14%,transparent);color:var(--dct-accent);font-weight:700}",
	".dsh-ctf-viewbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 16px}",
	".dsh-ctf-viewbar .dsh-ctf-muted{margin-right:auto}",
	".dsh-ctf-tag{display:inline-block;padding:0 7px;border-radius:5px;font-size:9.5px;line-height:16px;border:1px solid currentColor}",
	".dsh-ctf-tag.is-ok{color:var(--dct-ok-ink)}",
	".dsh-ctf-tag.is-warn{color:var(--dct-warn-ink)}",
	".dsh-ctf-tag.is-danger{color:var(--dct-danger-ink)}",
	".dsh-ctf-tag.is-run{color:var(--dct-run)}",
	".dsh-ctf-tag.is-muted{color:var(--dct-muted)}",
	".dsh-ctf-detail{border-top:1px solid var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 4%,transparent);padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px 14px}",
	".dsh-ctf-kv{display:flex;flex-direction:column;gap:1px;min-width:0}",
	".dsh-ctf-kv>span{font-size:9.5px;color:var(--dct-ink-6);letter-spacing:.4px}",
	".dsh-ctf-kv>b{font-size:10.5px;font-weight:600;color:var(--dct-ink-3);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
	".dsh-ctf-statement{grid-column:1/-1;display:flex;flex-direction:column;gap:3px}",
	".dsh-ctf-statement>span{font-size:9.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-statement-body{white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.7;color:var(--dct-ink-4);background:var(--dct-input);border:1px solid var(--dct-soft-2);border-radius:7px;padding:7px 10px;max-height:150px;overflow:auto}",
	".dsh-ctf-sec{display:flex;flex-direction:column;gap:6px}",
	".dsh-ctf-sec-title{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:800;letter-spacing:.6px;color:var(--dct-ink-3)}",
	".dsh-ctf-sec-count{font-size:9.5px;font-weight:700;padding:0 7px;border-radius:999px;background:var(--dct-soft-2);color:var(--dct-ink-4)}",
	".dsh-ctf-flags{display:flex;flex-direction:column;gap:6px}",
	".dsh-ctf-flag{border:1px solid color-mix(in srgb,var(--dct-ok) 30%,transparent);border-radius:8px;padding:6px 10px;background:color-mix(in srgb,var(--dct-ok) 5%,transparent);display:flex;flex-direction:column;gap:3px}",
	".dsh-ctf-flag-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-flag-ev{font-size:10.5px;color:var(--dct-ink-4);word-break:break-word;line-height:1.6}",
	".dsh-ctf-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;word-break:break-all;color:var(--dct-ok-ink);font-weight:700}",
	".dsh-ctf-att{border:1px solid var(--dct-soft-2);border-radius:8px;padding:6px 10px;background:var(--dct-input);display:flex;flex-direction:column;gap:4px}",
	".dsh-ctf-att-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
	".dsh-ctf-att-head>b{font-size:11px;color:var(--dct-ink-3)}",
	".dsh-ctf-att-sum{font-size:11px;color:var(--dct-ink-4);line-height:1.6;word-break:break-word}",
	".dsh-ctf-att-err{font-size:10.5px;color:var(--dct-danger-ink);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-word}",
	".dsh-ctf-pre{margin:0;max-height:170px;overflow:auto;padding:7px 9px;border-radius:6px;background:color-mix(in srgb,var(--dct-ink) 5%,transparent);border:1px solid var(--dct-soft-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.55;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-all}",
	".dsh-ctf-facts{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}",
	".dsh-ctf-fact{display:flex;gap:8px;align-items:baseline;font-size:11px;line-height:1.6;border-bottom:1px dashed var(--dct-soft-2);padding-bottom:3px}",
	".dsh-ctf-fact-time{flex:none;font-size:10px;color:var(--dct-ink-6);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
	".dsh-ctf-fact-text{flex:1;min-width:0;color:var(--dct-ink-3);word-break:break-word}",
	".dsh-ctf-fact-src{flex:none;font-size:9.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-events{display:flex;flex-direction:column;gap:3px;max-height:260px;overflow:auto;padding-right:4px}",
	".dsh-ctf-event{display:flex;gap:8px;align-items:baseline;font-size:10.5px;line-height:1.6}",
	".dsh-ctf-ev-time{flex:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-6);font-size:10px}",
	".dsh-ctf-ev-kind{flex:none;min-width:62px;text-align:center;padding:0 6px;border-radius:4px;border:1px solid var(--dct-soft-2);color:var(--dct-ink-4);font-size:9.5px;line-height:15px}",
	".dsh-ctf-ev-kind.k-flag{color:var(--dct-ok-ink);border-color:color-mix(in srgb,var(--dct-ok) 40%,transparent)}",
	".dsh-ctf-ev-kind.k-error{color:var(--dct-danger-ink);border-color:color-mix(in srgb,var(--dct-danger) 40%,transparent)}",
	".dsh-ctf-ev-kind.k-stuck{color:var(--dct-warn-ink);border-color:color-mix(in srgb,var(--dct-warn) 40%,transparent)}",
	".dsh-ctf-ev-kind.k-stopped{color:var(--dct-muted)}",
	".dsh-ctf-ev-text{flex:1;min-width:0;color:var(--dct-ink-4);word-break:break-word}",
	".dsh-ctf-retryrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px dashed var(--dct-soft-2);padding-top:9px}",
	".dsh-ctf-retryrow .dsh-ctf-in{flex:1;min-width:180px}",
	".dsh-ctf-empty{color:var(--dct-ink-5);font-size:12px;line-height:2;padding:34px 20px;text-align:center;border:1px dashed var(--dct-soft-2);border-radius:11px;background:var(--dct-card)}",
	".dsh-ctf-empty b{display:block;font-size:13px;color:var(--dct-ink-3);margin-bottom:4px}",
	".dsh-ctf-muted{font-size:10.5px;color:var(--dct-ink-6);line-height:1.7}",
	".dsh-ctf-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dct-soft-2);border-top-color:var(--dct-accent);border-radius:50%;animation:dsh-ctf-spin .8s linear infinite;vertical-align:-1px}",
	"@keyframes dsh-ctf-spin{to{transform:rotate(360deg)}}",
	".dsh-ctf-toast{position:fixed;right:20px;bottom:20px;z-index:80;max-width:380px;padding:10px 14px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dct-line) 50%,transparent);background:var(--dct-float);backdrop-filter:blur(12px);color:var(--dct-ink-3);font-size:12px;line-height:1.6;box-shadow:var(--dct-shadow)}",
	".dsh-ctf-toast.is-err{border-color:color-mix(in srgb,var(--dct-danger) 55%,transparent);color:var(--dct-danger-ink)}",
	".dsh-ctf-pad{padding:12px 16px;display:flex;flex-direction:column;gap:8px}",
	".dsh-ctf-filters{display:flex;flex-direction:column;gap:9px;padding:10px 16px}",
	".dsh-ctf-frow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
	".dsh-ctf-fchip{border:1px solid var(--dct-soft-2);border-radius:999px;padding:1px 11px;font-size:11px;line-height:19px;color:var(--dct-ink-4);background:var(--dct-soft);cursor:pointer;transition:background .15s,color .15s,border-color .15s;user-select:none;display:inline-flex;align-items:center;gap:5px;font-family:inherit}",
	".dsh-ctf-fchip:hover{background:var(--dct-hover)}",
	".dsh-ctf-fchip.is-on{background:linear-gradient(90deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);border-color:var(--dct-accent-2);font-weight:700}",
	".dsh-ctf-fchip i{font-style:normal;font-size:9.5px;opacity:.78;font-variant-numeric:tabular-nums}",
	".dsh-ctf-search{flex:1;min-width:170px;max-width:340px}",
	".dsh-ctf-fselect{width:auto;min-width:116px;max-width:190px}",
	".dsh-ctf-fnote{font-size:10.5px;color:var(--dct-ink-6);margin-left:auto;font-variant-numeric:tabular-nums}",
	".dsh-ctf-fopt{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dct-ink-4);cursor:pointer;user-select:none}",
	".dsh-ctf-fopt input{accent-color:var(--dct-accent);margin:0}",
	".dsh-ctf-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dct-muted);flex:none}",
	".dsh-ctf-dot.is-live{background:var(--dct-ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--dct-ok) 22%,transparent);animation:dsh-ctf-pulse 2s ease-in-out infinite}",
	".dsh-ctf-dot.tone-queued{background:var(--dct-queued)}",
	".dsh-ctf-dot.tone-run{background:var(--dct-run)}",
	".dsh-ctf-dot.tone-ok{background:var(--dct-ok)}",
	".dsh-ctf-dot.tone-warn{background:var(--dct-warn)}",
	".dsh-ctf-dot.tone-danger{background:var(--dct-danger)}",
	".dsh-ctf-dot.tone-muted{background:var(--dct-muted)}",
	".dsh-ctf-svlist{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-svcard{border:1px solid var(--dct-soft-2);border-radius:11px;background:var(--dct-card);box-shadow:var(--dct-glow);overflow:hidden;transition:border-color .15s}",
	".dsh-ctf-svcard:hover{border-color:color-mix(in srgb,var(--dct-line) 45%,transparent)}",
	".dsh-ctf-svcard.is-current{border-color:color-mix(in srgb,var(--dct-accent) 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dct-accent) 26%,transparent),var(--dct-glow)}",
	".dsh-ctf-svcard.is-unassigned{border-style:dashed;opacity:.95}",
	".dsh-ctf-svhead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:11px 14px 6px}",
	".dsh-ctf-svmain{flex:1;min-width:210px;display:flex;flex-direction:column;gap:4px}",
	".dsh-ctf-svtitle-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-svtitle{font-size:13.5px;font-weight:700;color:var(--dct-ink);word-break:break-word}",
	".dsh-ctf-svid{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;color:var(--dct-ink-6);word-break:break-all}",
	".dsh-ctf-svmeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--dct-ink-6)}",
	".dsh-ctf-svcwd{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;max-width:100%}",
	".dsh-ctf-svcounts{display:flex;gap:6px;flex-wrap:wrap;padding:4px 14px 8px}",
	".dsh-ctf-count{border:1px solid var(--dct-soft-2);border-radius:6px;padding:1px 8px;background:var(--dct-soft);font-size:10px;color:var(--dct-ink-5);font-variant-numeric:tabular-nums}",
	".dsh-ctf-count b{color:var(--dct-ink-3);margin-left:3px}",
	".dsh-ctf-progress{height:7px;border-radius:999px;background:var(--dct-soft-2);overflow:hidden;margin:0 14px 6px}",
	".dsh-ctf-progress>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dct-ok),var(--dct-accent-2));transition:width .3s}",
	".dsh-ctf-svfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:0 14px 10px;font-size:10.5px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums}",
	".dsh-ctf-minilist{border-top:1px solid var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 4%,transparent);padding:8px 14px 10px;display:flex;flex-direction:column;gap:2px}",
	".dsh-ctf-miniblk{display:flex;flex-direction:column;gap:3px;padding:3px 0;border-bottom:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-miniblk:last-child{border-bottom:0}",
	".dsh-ctf-minirow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px}",
	".dsh-ctf-mini-title{flex:1;min-width:140px;color:var(--dct-ink-3);word-break:break-word}",
	".dsh-ctf-mini-meta{font-size:9.5px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums}",
	".dsh-ctf-totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px}",
	".dsh-ctf-total{border:1px solid var(--dct-soft-2);border-radius:11px;background:var(--dct-panel);padding:10px 14px;box-shadow:var(--dct-glow)}",
	".dsh-ctf-total span{display:block;font-size:10px;color:var(--dct-ink-5);letter-spacing:.4px}",
	".dsh-ctf-total b{display:block;margin-top:2px;font-size:21px;line-height:1.25;font-weight:800;font-variant-numeric:tabular-nums;color:var(--dct-ink)}",
	".dsh-ctf-total.is-ok b{color:var(--dct-ok-ink)}",
	".dsh-ctf-total.is-run b{color:var(--dct-run)}",
	".dsh-ctf-total.is-warn b{color:var(--dct-warn-ink)}",
	".dsh-ctf-total.is-danger b{color:var(--dct-danger-ink)}",
	".dsh-ctf-bars{display:flex;flex-direction:column;gap:6px}",
	".dsh-ctf-bar{display:grid;grid-template-columns:78px 1fr 104px;align-items:center;gap:10px;font-size:10.5px;color:var(--dct-ink-4)}",
	".dsh-ctf-bar-label{font-weight:700;color:var(--dct-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-bar-track{height:9px;border-radius:999px;background:var(--dct-soft-2);overflow:hidden;min-width:40px}",
	".dsh-ctf-bar-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dct-accent),var(--dct-accent-2));min-width:2px;transition:width .3s}",
	".dsh-ctf-bar-val{text-align:right;font-variant-numeric:tabular-nums;color:var(--dct-ink-5)}",
	".dsh-ctf-bar-val b{color:var(--dct-ink-3)}",
	".dsh-ctf-statusgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:7px 16px}",
	".dsh-ctf-srow{display:flex;align-items:center;gap:8px;font-size:11px}",
	".dsh-ctf-srow .dsh-ctf-bar-track{flex:1}",
	".dsh-ctf-srow .dsh-ctf-bar-val{min-width:34px}",
	".dsh-ctf-ledger{display:flex;flex-direction:column;gap:6px}",
	".dsh-ctf-lrow{border:1px solid var(--dct-soft-2);border-radius:9px;background:var(--dct-card);padding:7px 11px;display:flex;flex-direction:column;gap:4px}",
	".dsh-ctf-lrow.is-unverified{border-left:3px solid var(--dct-warn);background:color-mix(in srgb,var(--dct-warn) 5%,var(--dct-card))}",
	".dsh-ctf-lmain{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-ltitle{font-size:12px;font-weight:700;color:var(--dct-ink-3);cursor:pointer;word-break:break-word}",
	".dsh-ctf-ltitle:hover{color:var(--dct-accent)}",
	".dsh-ctf-lflag{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dct-ok-ink);font-weight:700;word-break:break-all}",
	".dsh-ctf-lev{border-top:1px dashed var(--dct-soft-2);margin-top:3px;padding-top:5px;font-size:10.5px;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-word;line-height:1.6}",
	".dsh-ctf-lrow-detail{border-top:1px solid var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 4%,transparent);padding:9px 11px;margin-top:2px;border-radius:0 0 7px 7px}",
	".dsh-ctf-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--dct-soft-2);border-radius:8px;background:var(--dct-input)}",
	".dsh-ctf-segbtn{border:0;border-radius:6px;background:transparent;color:var(--dct-ink-5);font:600 11px/1.5 inherit;padding:3px 10px;cursor:pointer;white-space:nowrap}",
	".dsh-ctf-segbtn:hover{background:var(--dct-hover)}",
	".dsh-ctf-segbtn.is-on{background:linear-gradient(90deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);font-weight:700}",
	".dsh-ctf-groups{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-group{border:1px solid var(--dct-soft-2);border-radius:12px;background:color-mix(in srgb,var(--dct-line) 3%,var(--dct-panel));box-shadow:var(--dct-glow);overflow:hidden}",
	".dsh-ctf-group.is-current{border-color:color-mix(in srgb,var(--dct-accent) 55%,transparent)}",
	".dsh-ctf-group.is-unassigned{border-style:dashed}",
	".dsh-ctf-grouphead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;background:color-mix(in srgb,var(--dct-line) 6%,transparent);border-bottom:1px solid var(--dct-soft-2)}",
	".dsh-ctf-grouptitle{font-size:12.5px;font-weight:700;color:var(--dct-ink);word-break:break-word}",
	".dsh-ctf-grouphead .dsh-ctf-count{font-size:9.5px}",
	".dsh-ctf-groupbody{display:flex;flex-direction:column;gap:8px;padding:10px 12px}",
	".dsh-ctf-groupbody .dsh-ctf-card{background:var(--dct-card)}",
	".dsh-ctf-ledgerwrap{display:flex;flex-direction:column}",
	".dsh-ctf-ledgerhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px}",
	".dsh-ctf-ledgerhead .dsh-ctf-muted{margin-left:auto}",
	".dsh-ctf-ledgerbody{display:flex;flex-direction:column;gap:10px;padding:0 16px 14px}",
	".dsh-ctf-padsplit{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}",
	".dsh-ctf-wb{display:flex;flex-direction:column;gap:0}",
	".dsh-ctf-wbtabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--dct-soft-2);padding-bottom:8px}",
	".dsh-ctf-wbtab{border:1px solid var(--dct-soft-2);border-radius:7px;background:var(--dct-soft);color:var(--dct-ink-4);font:600 11px/1.5 inherit;padding:3px 10px;cursor:pointer}",
	".dsh-ctf-wbtab:hover{background:var(--dct-hover)}",
	".dsh-ctf-wbtab.is-on{border-color:var(--dct-accent);background:color-mix(in srgb,var(--dct-accent) 16%,transparent);color:var(--dct-accent);font-weight:700}",
	".dsh-ctf-wbbody{display:flex;flex-direction:column;gap:8px;padding-top:10px}",
	".dsh-ctf-wbnote{font-size:10px;color:var(--dct-ink-6);line-height:1.6}",
	".dsh-ctf-filelist{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow:auto}",
	".dsh-ctf-filerow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;padding:2px 0;border-bottom:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-filerow:last-child{border-bottom:0}",
	".dsh-ctf-filename{flex:1;min-width:150px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-3);word-break:break-all}",
	".dsh-ctf-filesize{font-size:9.5px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums}",
	".dsh-ctf-wbread{margin:0;max-height:200px;overflow:auto;padding:7px 9px;border-radius:6px;background:var(--dct-input);border:1px solid var(--dct-soft-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.55;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-all}",
	".dsh-ctf-notes textarea{width:100%;min-height:120px;border:1px solid var(--dct-soft-2);border-radius:8px;background:var(--dct-input);color:var(--dct-ink-2);padding:8px 10px;font:11.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none;resize:vertical}",
	".dsh-ctf-notes textarea:focus{border-color:var(--dct-accent)}",
	".dsh-ctf-wbactions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;border-top:1px dashed var(--dct-soft-2);padding-top:9px}",
	".dsh-ctf-wbflag{display:flex;align-items:center;gap:7px;flex-wrap:wrap;flex:1;min-width:220px}",
	".dsh-ctf-wbflag .dsh-ctf-in{flex:1;min-width:150px}",
	".dsh-ctf-platformchip{border-style:dashed}",
	".dsh-ctf-platformchip.is-ok{color:var(--dct-ok-ink);border-color:color-mix(in srgb,var(--dct-ok) 50%,transparent)}",
	".dsh-ctf-platformchip.is-danger{color:var(--dct-danger-ink);border-color:color-mix(in srgb,var(--dct-danger) 50%,transparent)}",
	".dsh-ctf-plat{display:flex;flex-direction:column;gap:10px;padding:12px 16px}",
	".dsh-ctf-platgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 14px}",
	".dsh-ctf-platrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-plist{display:flex;flex-direction:column;gap:3px;max-height:280px;overflow:auto;border:1px solid var(--dct-soft-2);border-radius:8px;padding:6px 9px;background:var(--dct-input)}",
	".dsh-ctf-prow{display:flex;align-items:center;gap:8px;font-size:11px;padding:2px 0;border-bottom:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-prow:last-child{border-bottom:0}",
	".dsh-ctf-prow input{accent-color:var(--dct-accent);margin:0;flex:none}",
	".dsh-ctf-prow b{font-weight:700;color:var(--dct-ink-3);word-break:break-word}",
	".dsh-ctf-platstatus{font-size:10.5px;color:var(--dct-ink-5);font-variant-numeric:tabular-nums}",
	".dsh-ctf-report{display:flex;flex-direction:column;gap:8px;padding:12px 16px}",
	".dsh-ctf-reporthead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--dct-ink-4)}",
	".dsh-ctf-reportpre{margin:0;max-height:260px;overflow:auto;padding:9px 11px;border-radius:8px;background:var(--dct-input);border:1px solid var(--dct-soft-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.6;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-word}",
	".dsh-ctf-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:2px 2px 0}",
	".dsh-ctf-tab{border:1px solid transparent;border-bottom:none;background:transparent;color:var(--dct-ink-5);font:600 11.5px/1 inherit;padding:7px 13px;border-radius:8px 8px 0 0;cursor:pointer}",
	".dsh-ctf-tab:hover{background:color-mix(in srgb,var(--dct-accent) 10%,transparent)}",
	".dsh-ctf-tab.is-on{background:var(--dct-panel);border-color:var(--dct-soft-2);color:var(--dct-ink-2);box-shadow:0 -2px 0 var(--dct-accent) inset}",
	".dsh-ctf-page{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-countdown{color:var(--dct-accent);font-variant-numeric:tabular-nums}",
	".dsh-ctf-countdown.is-wrapup{color:var(--dct-warn-ink);font-weight:700}",
	".dsh-ctf-setgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 16px}",
	".dsh-ctf-setrow{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dct-ink-5)}",
	".dsh-ctf-setrow .dsh-ctf-in{width:100%}",
	".dsh-ctf-diag{display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.7;color:var(--dct-ink-4)}",
	".dsh-ctf-diag b{color:var(--dct-ink-2)}",
	".dsh-ctf-rrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:5px 0;border-bottom:1px dashed var(--dct-soft-2);font-size:11px}",
	".dsh-ctf-rrow:last-child{border-bottom:0}",
	".dsh-ctf-rname{flex:1;min-width:200px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-3);word-break:break-all}",
	".dsh-ctf-wbhead{display:flex;flex-direction:column;gap:6px;padding:4px 2px 10px;border-bottom:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-wbtitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}",
	".dsh-ctf-wbtitle b{font-weight:700;color:var(--dct-ink-2)}",
	".dsh-ctf-wbmeta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--dct-ink-5)}",
	".dsh-ctf-wbdir{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
	".dsh-ctf-btn.is-danger{color:var(--dct-danger-ink)}",
	".dsh-ctf-pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}",
	".dsh-ctf-pagetitle{font-size:15px;font-weight:700;color:var(--dct-ink-2)}",
	".dsh-ctf-pagesub{font-size:10.5px;color:var(--dct-ink-6);margin-top:2px;line-height:1.6}",
	".dsh-ctf-sumrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px}",
	".dsh-ctf-sumrow .dsh-ctf-stat{flex:1;min-width:120px}",
	".dsh-ctf-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;align-items:start}",
	".dsh-ctf-setcard{display:flex;flex-direction:column;gap:10px;padding:12px 16px;border:1px solid var(--dct-soft-2);border-radius:12px;background:var(--dct-panel)}",
	".dsh-ctf-setlabel{font-size:11.5px;font-weight:600;color:var(--dct-ink-3)}",
	".dsh-ctf-sethint{font-size:10px;color:var(--dct-ink-6);line-height:1.5}",
	".dsh-ctf-switch{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dct-ink-4);cursor:pointer}",
	".dsh-ctf-switch input{accent-color:var(--dct-accent)}",
	".dsh-ctf-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:10px;font-weight:700;border:1px solid transparent}",
	".dsh-ctf-pill.is-ok{color:var(--dct-ok-ink);background:color-mix(in srgb,var(--dct-ok) 14%,transparent);border-color:color-mix(in srgb,var(--dct-ok) 40%,transparent)}",
	".dsh-ctf-pill.is-warn{color:var(--dct-warn-ink);background:color-mix(in srgb,var(--dct-warn) 14%,transparent);border-color:color-mix(in srgb,var(--dct-warn) 40%,transparent)}",
	".dsh-ctf-diaglist{display:flex;flex-direction:column;gap:0}",
	".dsh-ctf-diagrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed var(--dct-soft-2);font-size:11.5px}",
	".dsh-ctf-diagrow:last-child{border-bottom:0}",
	".dsh-ctf-diagrow b{color:var(--dct-ink-2);min-width:76px}",
	".dsh-ctf-diagval{color:var(--dct-ink-4);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px}",
	".dsh-ctf-previewcard{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-preview{display:flex;flex-direction:column;gap:7px;padding:11px 14px;border:1px solid var(--dct-soft-2);border-radius:12px;background:var(--dct-panel)}",
	".dsh-ctf-previewhead{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11.5px;color:var(--dct-ink-4)}",
	".dsh-ctf-path{flex:1;min-width:180px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:var(--dct-ink-5);word-break:break-all}",
	".dsh-ctf-empty.is-slim{padding:16px 12px}",
	".dsh-ctf-footer-note{padding:10px 14px}",
	".dsh-ctf-setstack{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-root{min-width:0;overflow-x:hidden}",
	".dsh-ctf-head{flex-wrap:wrap;align-items:center;gap:10px}",
	".dsh-ctf-head-main{min-width:0;flex:1 1 220px}",
	".dsh-ctf-head-actions{flex-wrap:wrap;justify-content:flex-end}",
	".dsh-ctf-tabbar{display:flex;align-items:center;gap:8px;padding:0 2px;min-width:0}",
	".dsh-ctf-tabbar .dsh-ctf-tabs{flex:1;min-width:0}",
	".dsh-ctf-sumrow .dsh-ctf-stat{flex:1 1 130px;min-width:110px;flex-direction:row;align-items:baseline;justify-content:center;gap:8px;padding:8px 12px;border:1px solid var(--dct-soft-2);border-radius:10px;background:var(--dct-panel)}",
	".dsh-ctf-sumrow .dsh-ctf-stat b{font-size:17px;line-height:1.2}",
	".dsh-ctf-sumrow .dsh-ctf-stat span{font-size:10.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-grid2 .dsh-ctf-ledger{max-height:420px;overflow:auto;padding-right:4px}",
	".dsh-ctf-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 18px;border-radius:14px;border:1px solid var(--dct-soft-2);background:linear-gradient(135deg,color-mix(in srgb,var(--dct-accent) 12%,transparent),color-mix(in srgb,var(--dct-accent) 2%,transparent) 60%),var(--dct-panel)}",
	".dsh-ctf-hero-main{min-width:0;flex:1 1 320px}",
	".dsh-ctf-hero-title{font-size:17px;font-weight:800;letter-spacing:.2px;color:var(--dct-ink-2)}",
	".dsh-ctf-hero-sub{font-size:11px;color:var(--dct-ink-5);margin-top:5px;line-height:1.65}",
	".dsh-ctf-hero-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px}",
	".dsh-ctf-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}",
	".dsh-ctf-kpi{display:flex;flex-direction:column;gap:2px;padding:10px 14px;border-radius:12px;border:1px solid var(--dct-soft-2);background:var(--dct-panel)}",
	".dsh-ctf-kpi b{font-size:20px;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--dct-ink-2)}",
	".dsh-ctf-kpi span{font-size:10px;letter-spacing:.4px;color:var(--dct-ink-6)}",
	".dsh-ctf-kpi.is-ok b{color:var(--dct-ok-ink)}",
	".dsh-ctf-kpi.is-warn b{color:var(--dct-warn-ink)}",
	".dsh-ctf-cover{display:flex;flex-direction:column;gap:8px;padding:12px 16px}",
	".dsh-ctf-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-radius:12px;border:1px solid var(--dct-soft-2);background:var(--dct-panel)}",
	".dsh-ctf-wugrid{align-items:start}",
	".dsh-ctf-wulistwrap{min-width:0}",
	".dsh-ctf-wucards{display:flex;flex-direction:column;gap:9px;max-height:560px;overflow:auto;padding-right:4px}",
	".dsh-ctf-wucard{display:flex;flex-direction:column;gap:8px;padding:11px 13px;border-radius:12px;border:1px solid var(--dct-soft-2);background:var(--dct-panel);transition:border-color .15s ease}",
	".dsh-ctf-wucard:hover{border-color:color-mix(in srgb,var(--dct-accent) 45%,var(--dct-soft-2))}",
	".dsh-ctf-wucard.is-open{border-color:color-mix(in srgb,var(--dct-accent) 60%,var(--dct-soft-2))}",
	".dsh-ctf-wuhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
	".dsh-ctf-wutitle{font-size:12.5px;font-weight:700;color:var(--dct-ink-2);min-width:0;flex:1 1 160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-wuacts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}",
	".dsh-ctf-wuflag{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-radius:9px;border:1px dashed var(--dct-soft-2);background:var(--dct-input)}",
	".dsh-ctf-wuflag code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dct-ok-ink);word-break:break-all}",
	".dsh-ctf-wuev{flex-basis:100%;font-size:10px;line-height:1.55;color:var(--dct-ink-6)}",
	".dsh-ctf-wubody{display:flex;flex-direction:column;gap:9px;border-top:1px dashed var(--dct-soft-2);padding-top:9px}",
	".dsh-ctf-wutext{font-size:11px;line-height:1.7;color:var(--dct-ink-4);white-space:pre-wrap}",
	".dsh-ctf-wulist{display:flex;flex-direction:column;gap:4px}",
	".dsh-ctf-wuattempt,.dsh-ctf-wufact{font-size:10.5px;line-height:1.6;color:var(--dct-ink-5);padding-left:10px;position:relative}",
	".dsh-ctf-wuattempt:before,.dsh-ctf-wufact:before{content:'•';position:absolute;left:1px;color:var(--dct-accent)}",
	".dsh-ctf-wudir{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-wudir code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;color:var(--dct-ink-6);word-break:break-all;flex:1 1 200px}",
	".dsh-ctf-preview{display:flex;flex-direction:column;gap:9px;padding:11px 13px}",
	".dsh-ctf-prevblock{display:flex;flex-direction:column;gap:6px}",
	".dsh-ctf-prevhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;color:var(--dct-ink-6);word-break:break-all}",
	".dsh-ctf-md{max-height:360px;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dct-soft-2);background:var(--dct-input)}",
	".dsh-ctf-mdh{font-weight:700;color:var(--dct-ink-2);margin:7px 0 4px}",
	".dsh-ctf-mdh.is-h1{font-size:14px}",
	".dsh-ctf-mdh.is-h2{font-size:12.5px}",
	".dsh-ctf-mdh.is-h3{font-size:11.5px}",
	".dsh-ctf-mdp{font-size:11px;line-height:1.7;color:var(--dct-ink-4);margin:2px 0}",
	".dsh-ctf-mdli{font-size:11px;line-height:1.7;color:var(--dct-ink-4);padding-left:12px;position:relative}",
	".dsh-ctf-mdli:before{content:'•';position:absolute;left:2px;color:var(--dct-accent)}",
	".dsh-ctf-mdbq{border-left:2px solid var(--dct-accent);padding:2px 8px;margin:3px 0;font-size:10.5px;line-height:1.6;color:var(--dct-ink-5)}",
	".dsh-ctf-mdcode{margin:4px 0;padding:8px;border-radius:8px;background:color-mix(in srgb,var(--dct-ink-2) 6%,transparent);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.55;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-all}",
	".dsh-ctf-wugrid{grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr)}",
	".dsh-ctf-wugrid .dsh-ctf-sidecol{position:sticky;top:8px}",
	".dsh-ctf-panelhead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-wucards{display:flex;flex-direction:column;gap:10px;max-height:620px;overflow:auto;padding-right:4px}",
	".dsh-ctf-wucard{display:flex;flex-direction:column;gap:9px;padding:12px 14px;border-radius:13px;border:1px solid var(--dct-soft-2);background:var(--dct-panel);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}",
	".dsh-ctf-wucard:hover{border-color:color-mix(in srgb,var(--dct-accent) 42%,var(--dct-soft-2));box-shadow:0 4px 14px rgba(20,40,80,.07)}",
	".dsh-ctf-wucard.is-open{border-color:color-mix(in srgb,var(--dct-accent) 62%,var(--dct-soft-2))}",
	".dsh-ctf-wucard.is-exported{border-left:3px solid color-mix(in srgb,var(--dct-ok) 65%,transparent)}",
	".dsh-ctf-wurow{display:flex;align-items:flex-start;gap:11px;min-width:0}",
	".dsh-ctf-wuavatar{flex:none;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;background:var(--dct-accent);box-shadow:0 1px 3px rgba(0,0,0,.12)}",
	".dsh-ctf-wuavatar.tone-c0{background:#3b82f6}",
	".dsh-ctf-wuavatar.tone-c1{background:#8b5cf6}",
	".dsh-ctf-wuavatar.tone-c2{background:#ef4444}",
	".dsh-ctf-wuavatar.tone-c3{background:#f97316}",
	".dsh-ctf-wuavatar.tone-c4{background:#64748b}",
	".dsh-ctf-wuavatar.tone-c5{background:#14b8a6}",
	".dsh-ctf-wuavatar.tone-c6{background:#0ea5e9}",
	".dsh-ctf-wuavatar.tone-c7{background:#22c55e}",
	".dsh-ctf-wumain{min-width:0;flex:1 1 220px;display:flex;flex-direction:column;gap:5px}",
	".dsh-ctf-wutop{display:flex;align-items:center;gap:8px;min-width:0}",
	".dsh-ctf-wutitle{font-size:13px;font-weight:700;color:var(--dct-ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-wumeta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:10.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-wumetric b{color:var(--dct-ink-4);font-weight:700}",
	".dsh-ctf-wuacts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}",
	".dsh-ctf-wuflag{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:9px;border:1px dashed var(--dct-soft-2);background:var(--dct-input)}",
	".dsh-ctf-wuflagtag{font-size:9px;font-weight:800;letter-spacing:.8px;color:var(--dct-ink-6);border:1px solid var(--dct-soft-2);border-radius:5px;padding:1px 5px}",
	".dsh-ctf-wuflag code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--dct-ok-ink);word-break:break-all;flex:1 1 180px;min-width:0}",
	".dsh-ctf-iconbtn{flex:none;width:22px;height:22px;border-radius:6px;border:1px solid var(--dct-soft-2);background:transparent;color:var(--dct-ink-5);cursor:pointer;font-size:12px;line-height:1}",
	".dsh-ctf-iconbtn:hover{color:var(--dct-accent);border-color:color-mix(in srgb,var(--dct-accent) 50%,var(--dct-soft-2))}",
	".dsh-ctf-wuevwrap{display:flex;flex-direction:column;gap:4px}",
	".dsh-ctf-wuev{font-size:10.5px;line-height:1.6;color:var(--dct-ink-6);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
	".dsh-ctf-wuev.is-open{display:block;overflow:visible;white-space:pre-wrap}",
	".dsh-ctf-linkbtn{align-self:flex-start;border:0;background:transparent;color:var(--dct-accent);font-size:10.5px;cursor:pointer;padding:0}",
	".dsh-ctf-linkbtn:hover{text-decoration:underline}",
	".dsh-ctf-wubody{display:flex;flex-direction:column;gap:9px;border-top:1px dashed var(--dct-soft-2);padding-top:9px}",
	".dsh-ctf-kbgrid{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,1fr);gap:10px;align-items:start}",
	".dsh-ctf-pathbox{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.6;resize:vertical}",
	".dsh-ctf-srcchips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0 4px}",
	".dsh-ctf-scorebar{height:3px;border-radius:2px;background:color-mix(in srgb,var(--dct-ink-6) 18%,transparent);margin-top:5px;overflow:hidden}",
	".dsh-ctf-progress{height:4px;border-radius:2px;background:color-mix(in srgb,var(--dct-ink-6) 18%,transparent);overflow:hidden;margin-top:6px}",
	".dsh-ctf-progress i{display:block;height:100%;border-radius:2px;background:var(--dct-accent)}",
	".dsh-ctf-spark{display:flex;align-items:flex-end;gap:6px;height:56px;padding:4px 2px 0}",
	".dsh-ctf-sparkcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px;height:100%}",
	".dsh-ctf-sparkcol i{display:block;width:100%;border-radius:2px;min-height:2px}",
	".dsh-ctf-sparkcol i.is-attempt{background:color-mix(in srgb,var(--dct-accent) 65%,transparent)}",
	".dsh-ctf-sparkcol i.is-solved{background:color-mix(in srgb,var(--dct-ok) 75%,transparent)}",
	".dsh-ctf-sparkcol span{font-size:8px;color:var(--dct-ink-6);white-space:nowrap}",
	".dsh-ctf-kbimport,.dsh-ctf-kbsearch{padding:13px 15px}",
	".dsh-ctf-minigrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:10px 0 11px}",
	".dsh-ctf-minicard{display:flex;flex-direction:column;gap:1px;padding:8px 9px;border-radius:9px;border:1px solid var(--dct-soft-2);background:var(--dct-input)}",
	".dsh-ctf-minicard b{font-size:14px;line-height:1.15;color:var(--dct-ink-2);font-variant-numeric:tabular-nums}",
	".dsh-ctf-minicard span{font-size:9.5px;letter-spacing:.3px;color:var(--dct-ink-6)}",
	".dsh-ctf-minicard i{font-style:normal;font-size:9px;color:var(--dct-ink-6);opacity:.8}",
	".dsh-ctf-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;margin:9px 0;padding:16px 12px;border-radius:11px;border:1.5px dashed color-mix(in srgb,var(--dct-accent) 38%,var(--dct-soft-2));background:color-mix(in srgb,var(--dct-accent) 4%,transparent);text-align:center;transition:border-color .15s ease,background .15s ease}",
	".dsh-ctf-drop b{font-size:11.5px;color:var(--dct-ink-3)}",
	".dsh-ctf-drop.is-over{border-color:var(--dct-accent);background:color-mix(in srgb,var(--dct-accent) 12%,transparent)}",
	".dsh-ctf-dropicon{font-size:20px;line-height:1;color:var(--dct-accent);opacity:.85}",
	".dsh-ctf-empty.is-hero{padding:22px 14px;gap:6px}",
	".dsh-ctf-quickpaths{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:7px 0 2px}",
	".dsh-ctf-chip.is-clickable{cursor:pointer}",
	".dsh-ctf-chip.is-clickable:hover{color:var(--dct-accent);border-color:color-mix(in srgb,var(--dct-accent) 50%,var(--dct-soft-2))}",
	".dsh-ctf-inputwrap{display:flex;align-items:center;gap:7px;position:relative;margin-bottom:2px}",
	".dsh-ctf-inputicon{position:absolute;left:10px;font-size:14px;color:var(--dct-ink-6);pointer-events:none}",
	".dsh-ctf-search.is-icon{padding-left:30px;flex:1}",
	".dsh-ctf-inputclear{position:absolute;right:66px;width:18px;height:18px;border-radius:50%;border:0;background:transparent;color:var(--dct-ink-6);cursor:pointer;font-size:13px;line-height:1}",
	".dsh-ctf-inputclear:hover{color:var(--dct-accent)}",
	".dsh-ctf-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;margin:9px 0 8px;border-radius:9px;background:var(--dct-input);border:1px solid var(--dct-soft-2)}",
	".dsh-ctf-segbtn{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:0;border-radius:7px;background:transparent;color:var(--dct-ink-5);font-size:10.5px;cursor:pointer}",
	".dsh-ctf-segbtn i{font-style:normal;font-size:9.5px;opacity:.75}",
	".dsh-ctf-segbtn.is-active{background:var(--dct-panel);color:var(--dct-ink-2);box-shadow:0 1px 3px rgba(20,40,80,.12)}",
	".dsh-ctf-suggest{display:flex;flex-direction:column;gap:7px;padding:12px 2px}",
	".dsh-ctf-suggest-title{font-size:10px;letter-spacing:.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-suggest-chips{display:flex;flex-wrap:wrap;gap:6px}",
	".dsh-ctf-resultcount{font-size:10px;color:var(--dct-ink-6);padding:2px 1px 5px}",
	".dsh-ctf-kblist{display:flex;flex-direction:column;gap:8px;max-height:560px;overflow:auto;padding-right:3px}",
	".dsh-ctf-kbresult{position:relative;display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border-radius:11px;border:1px solid var(--dct-soft-2);background:var(--dct-panel);cursor:pointer;overflow:hidden;transition:border-color .15s ease,box-shadow .15s ease}",
	".dsh-ctf-kbresult:hover{border-color:color-mix(in srgb,var(--dct-accent) 45%,var(--dct-soft-2));box-shadow:0 3px 10px rgba(20,40,80,.07)}",
	".dsh-ctf-kbsrc{flex:none;width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:8.5px;font-weight:800;letter-spacing:.4px;color:#fff;background:var(--dct-accent)}",
	".dsh-ctf-kbsrc.is-imported{background:#8b5cf6}",
	".dsh-ctf-kbsrc.is-writeup{background:#0ea5e9}",
	".dsh-ctf-kbsrc.is-notes{background:#64748b}",
	".dsh-ctf-kbmain{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}",
	".dsh-ctf-kbtop{display:flex;align-items:center;gap:8px;min-width:0}",
	".dsh-ctf-kbtitle{font-size:12px;font-weight:700;color:var(--dct-ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-scorepill{margin-left:auto;flex:none;font-size:9.5px;color:var(--dct-ink-6);border:1px solid var(--dct-soft-2);border-radius:6px;padding:1px 5px;font-variant-numeric:tabular-nums}",
	".dsh-ctf-kbmeta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:9.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-kbtag{font-size:9px;font-weight:700;letter-spacing:.3px;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--dct-accent) 12%,transparent);color:var(--dct-accent)}",
	".dsh-ctf-kbpath{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}",
	".dsh-ctf-kbsnippet{font-size:10.5px;line-height:1.6;color:var(--dct-ink-5);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
	".dsh-ctf-mark{background:color-mix(in srgb,var(--dct-warn) 35%,transparent);color:var(--dct-ink-2);padding:0 1px;border-radius:2px}",
	".dsh-ctf-kbacts{display:none;align-items:center;gap:5px;margin-top:2px}",
	".dsh-ctf-kbresult:hover .dsh-ctf-kbacts{display:flex}",
	".dsh-ctf-kbbar{position:absolute;left:0;right:0;bottom:0;height:2px;background:color-mix(in srgb,var(--dct-ink-6) 12%,transparent)}",
	".dsh-ctf-kbbar i{display:block;height:100%;background:color-mix(in srgb,var(--dct-accent) 70%,transparent)}",
	".dsh-ctf-scorebar i{display:block;height:100%;border-radius:2px;background:var(--dct-accent)}",
	".dsh-ctf-impres{display:flex;flex-direction:column;gap:4px;margin:8px 0;padding:9px 11px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dct-ok) 35%,var(--dct-soft-2));background:color-mix(in srgb,var(--dct-ok) 7%,transparent)}",
	".dsh-ctf-impres.is-warn{border-color:color-mix(in srgb,var(--dct-warn) 40%,var(--dct-soft-2));background:color-mix(in srgb,var(--dct-warn) 8%,transparent)}",
	".dsh-ctf-impres-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--dct-ink-4)}",
	".dsh-ctf-histcard.is-clickable{cursor:pointer}",
	".dsh-ctf-histlist{display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto;padding-right:4px}",
	".dsh-ctf-histcard{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:11px;border:1px solid var(--dct-soft-2);background:var(--dct-panel);transition:border-color .15s ease}",
	".dsh-ctf-histcard:hover{border-color:color-mix(in srgb,var(--dct-accent) 42%,var(--dct-soft-2))}",
	".dsh-ctf-histbadge{flex:none;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:800;letter-spacing:.5px;color:var(--dct-accent);background:color-mix(in srgb,var(--dct-accent) 14%,transparent);border:1px solid color-mix(in srgb,var(--dct-accent) 30%,transparent)}",
	".dsh-ctf-histmain{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}",
	".dsh-ctf-histname{font-size:11.5px;color:var(--dct-ink-3);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-histmeta{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--dct-ink-6)}",
	".dsh-ctf-dotsep{width:3px;height:3px;border-radius:50%;background:var(--dct-ink-6);opacity:.6}",
	".dsh-ctf-histacts{display:flex;align-items:center;gap:5px;flex:none}",
	".dsh-ctf-mdsp{height:5px}",
	".dsh-ctf-sidecol{display:flex;flex-direction:column;gap:10px;min-width:0}",
	".dsh-ctf-rrow .dsh-ctf-rname{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;word-break:normal}",
	".dsh-ctf-rrow{flex-wrap:wrap}",
	".dsh-ctf-rrow .dsh-ctf-chip,.dsh-ctf-rrow .dsh-ctf-mini-meta{flex:none}",
	".dsh-ctf-btn.is-danger.is-on{background:color-mix(in srgb,var(--dct-danger) 16%,transparent);border-color:var(--dct-danger)}",
	".dsh-ctf-btn.is-ghost.is-danger:hover{background:color-mix(in srgb,var(--dct-danger) 12%,transparent)}"
].join("\n");
function installStyles() {
	var style = document.createElement("style");
	style.id = "dsh-ctf-style";
	style.textContent = CSS;
	document.head.appendChild(style);
	return function () { style.remove(); };
}

// ---- 小组件（无 hook，纯渲染）----
function Stat(props) {
	return h("div", { className: "dsh-ctf-stat" + (props.tone ? " is-" + props.tone : "") },
		h("b", null, String(props.value == null ? 0 : props.value)),
		h("span", null, props.label));
}
function Badge(props) {
	var status = props.status || "queued";
	return h("span", { className: "dsh-ctf-badge is-" + (STATUS_TONE[status] || "queued") },
		h("i", null), STATUS_LABEL[status] || status);
}
function KV(props) {
	return h("div", { className: "dsh-ctf-kv" },
		h("span", null, props.k),
		h("b", { title: props.v || "" }, props.v || "—"));
}
function SecTitle(props) {
	return h("div", { className: "dsh-ctf-sec-title" },
		props.title,
		h("span", { className: "dsh-ctf-sec-count" }, String(props.count == null ? 0 : props.count)));
}
function field(label, control, wide) {
	return h("label", { className: "dsh-ctf-field" + (wide ? " is-wide" : "") },
		h("span", null, label), control);
}

function flagsSection(flags) {
	return h("div", { className: "dsh-ctf-sec" },
		h(SecTitle, { title: "Flags", count: flags.length }),
		flags.length === 0
			? h("div", { className: "dsh-ctf-muted" }, "尚未记录 flag（子代理验证后经 ctf_flag_record 登记）。")
			: h("div", { className: "dsh-ctf-flags" }, flags.map(function (f, i) {
				var meta = [];
				if (f.method) meta.push("方式 " + (METHOD_LABEL[f.method] || f.method));
				if (f.attempt) meta.push("尝试 #" + f.attempt);
				if (f.recordedAt) meta.push(fmtTime(f.recordedAt));
				return h("div", { key: "flag-" + i, className: "dsh-ctf-flag" },
					h("div", { className: "dsh-ctf-flag-head" },
						h("code", { className: "dsh-ctf-mono" }, f.value || ""),
						h("span", { className: "dsh-ctf-tag " + (f.verified ? "is-ok" : "is-warn") }, f.verified ? "已验证" : "未验证")),
					meta.length ? h("div", { className: "dsh-ctf-muted" }, meta.join(" · ")) : null,
					f.evidence ? h("div", { className: "dsh-ctf-flag-ev" }, "证据：" + f.evidence) : null);
			})));
}

function attemptsSection(attempts) {
	return h("div", { className: "dsh-ctf-sec" },
		h(SecTitle, { title: "Attempts 时间线", count: attempts.length }),
		attempts.length === 0
			? h("div", { className: "dsh-ctf-muted" }, "还没有尝试记录。")
			: attempts.map(function (a, i) {
				var n = a.n || i + 1;
				var status = a.status || "running";
				var dur = a.startedAt ? (a.endedAt || Date.now()) - a.startedAt : 0;
				return h("div", { key: "att-" + n, className: "dsh-ctf-att" },
					h("div", { className: "dsh-ctf-att-head" },
						h("b", null, "#" + n),
						a.angle ? h("span", { className: "dsh-ctf-chip" }, a.angle) : null,
						h("span", { className: "dsh-ctf-tag is-" + (ATTEMPT_TONE[status] || "muted") }, ATTEMPT_STATUS_LABEL[status] || status),
						dur ? h("span", { className: "dsh-ctf-muted" }, "耗时 " + fmtDur(dur)) : null,
						a.stopReason ? h("span", { className: "dsh-ctf-muted" }, "收口 " + (STOP_REASON_LABEL[a.stopReason] || a.stopReason)) : null,
						a.sessionId ? h("span", { className: "dsh-ctf-card-id" }, a.sessionId) : null),
					a.summary ? h("div", { className: "dsh-ctf-att-sum" }, a.summary) : null,
					a.error ? h("div", { className: "dsh-ctf-att-err" }, a.error) : null,
					a.outputTail ? h("pre", { className: "dsh-ctf-pre", title: "输出尾部" }, a.outputTail) : null);
			}));
}

function factsSection(facts) {
	return h("div", { className: "dsh-ctf-sec" },
		h(SecTitle, { title: "Facts 事实链", count: facts.length }),
		facts.length === 0
			? h("div", { className: "dsh-ctf-muted" }, "还没有事实记录。")
			: h("div", { className: "dsh-ctf-facts" }, facts.map(function (f, i) {
				return h("div", { key: "fact-" + i, className: "dsh-ctf-fact" },
					h("span", { className: "dsh-ctf-fact-time" }, fmtTime(f.at)),
					h("span", { className: "dsh-ctf-fact-text" }, f.text || ""),
					f.source ? h("span", { className: "dsh-ctf-fact-src" }, String(f.source)) : null);
			})));
}

function eventsSection(events) {
	var list = events.slice().reverse();
	return h("div", { className: "dsh-ctf-sec" },
		h(SecTitle, { title: "Events 日志", count: events.length }),
		list.length === 0
			? h("div", { className: "dsh-ctf-muted" }, "还没有事件。")
			: h("div", { className: "dsh-ctf-events" }, list.map(function (ev, i) {
				var kind = ev.kind || "note";
				return h("div", { key: "ev-" + i, className: "dsh-ctf-event" },
					h("span", { className: "dsh-ctf-ev-time" }, fmtClock(ev.at)),
					h("span", { className: "dsh-ctf-ev-kind k-" + kind }, EVENT_LABEL[kind] || kind),
					h("span", { className: "dsh-ctf-ev-text" }, ev.text || ""));
			})));
}

// ---- 多视图共用：常量 / 工具 / 数据 hook / 详情体 ----
var STATUS_RANK = { running: 0, queued: 1, stuck: 2, failed: 3, stopped: 4, solved: 5 };
var SORT_OPTIONS = [{ key: "new", label: "最新" }, { key: "duration", label: "耗时" }, { key: "status", label: "状态" }];
var SORT_LABEL = { new: "最新", duration: "耗时", status: "状态" };
var STATUS_CHIPS = [
	{ key: "all", label: "全部" },
	{ key: "queued", label: "排队" },
	{ key: "running", label: "运行" },
	{ key: "solved", label: "已解" },
	{ key: "stuck", label: "卡住" },
	{ key: "failed", label: "失败" },
	{ key: "stopped", label: "停止" }
];

function pct(a, b) {
	if (!b) return 0;
	return Math.max(0, Math.min(100, Math.round((a / b) * 100)));
}
function catLabel(c) {
	if (!c) return "未分类";
	return CATEGORY_LABEL[c] || String(c);
}
function fmtShortId(id) {
	var s = String(id || "");
	if (!s) return "未归属会话";
	if (s.length <= 14) return s;
	return s.slice(0, 8) + "…" + s.slice(-4);
}
function countChip(label, value) {
	return h("span", { className: "dsh-ctf-count" }, label, h("b", null, String(value == null ? 0 : value)));
}
function warningOf(snap) {
	var sub = snap && snap.subagents;
	if (!sub || sub.available !== false) return "";
	return "子代理编排不可用（providers：" + ((sub.providers || []).join(", ") || "无") + "）：启动解题会失败，请检查宿主子代理服务及其 spawn provider。";
}
function renderBanners(err, warning, onRetry) {
	var out = [];
	if (err) {
		out.push(h("div", { key: "banner-err", className: "dsh-ctf-error" },
			h("span", null, err),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: onRetry }, "重试")));
	}
	if (warning) {
		out.push(h("div", { key: "banner-warn", className: "dsh-ctf-error is-warn" },
			h("span", null, warning),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: onRetry }, "重新检测")));
	}
	return out;
}

// 数据 hook：页面可见时每 3s 轮询 state.get（三视图共用同一实现/同一端点）。
function useBoardData(sessionId, scopeAll) {
	var snapS = useState(null), snap = snapS[0], setSnap = snapS[1];
	var errS = useState(""), err = errS[0], setErr = errS[1];
	var updatedS = useState(0), updatedAt = updatedS[0], setUpdatedAt = updatedS[1];
	var requestSeq = useRef(0);
	function reload() {
		var seq = ++requestSeq.current;
		request("state.get", { sessionId: sessionId || "", scope: scopeAll ? "all" : "" }).then(function (r) {
			if (seq !== requestSeq.current) return;
			if (r && r.ok) { setSnap(r); setErr(""); setUpdatedAt(Date.now()); }
			else setErr((r && r.error) || "读取题板失败（宿主 Web 通道未就绪？）");
		});
	}
	useEffect(function () {
		var alive = true;
		function tick() {
			if (!alive) return;
			var visible = true;
			try { visible = document.visibilityState !== "hidden"; } catch (e) { visible = true; }
			if (!visible) return;
			reload();
		}
		tick();
		var timer = window.setInterval(tick, POLL_MS);
		function onVis() { try { if (document.visibilityState === "visible") tick(); } catch (e) { /* ignore */ } }
		document.addEventListener("visibilitychange", onVis);
		return function () {
			alive = false;
			requestSeq.current += 1;
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [sessionId, scopeAll]);
	return { snap: snap, err: err, updatedAt: updatedAt, reload: reload, setErr: setErr };
}

// 单题详情 hook：展开时拉 challenge.get 并每 3s 静默刷新（可见时）。
function useChallengeDetail(sessionId) {
	var expandedS = useState(""), expanded = expandedS[0], setExpanded = expandedS[1];
	var detailS = useState(null), detail = detailS[0], setDetail = detailS[1];
	var detailErrS = useState(""), detailErr = detailErrS[0], setDetailErr = detailErrS[1];
	var expandedRef = useRef("");
	var requestSeq = useRef(0);
	function loadDetail(id) {
		var seq = ++requestSeq.current;
		request("challenge.get", { id: id, sessionId: sessionId || "" }).then(function (r) {
			if (seq !== requestSeq.current || expandedRef.current !== id) return;
			if (r && r.ok && r.challenge) { setDetail({ id: id, data: r.challenge }); setDetailErr(""); return; }
			setDetailErr((r && r.error) || "读取题目详情失败");
		});
	}
	function toggle(id) {
		setExpanded(function (current) { return current === id ? "" : id; });
	}
	useEffect(function () {
		var id = expanded;
		expandedRef.current = id || "";
		if (!id) { setDetail(null); setDetailErr(""); return; }
		setDetail(null);
		setDetailErr("");
		loadDetail(id);
		var timer = window.setInterval(function () {
			try { if (document.visibilityState === "hidden") return; } catch (e) { /* ignore */ }
			loadDetail(id);
		}, POLL_MS);
		return function () {
			requestSeq.current += 1;
			window.clearInterval(timer);
		};
	}, [expanded, sessionId]);
	return { expanded: expanded, toggle: toggle, detail: detail, detailErr: detailErr, loadDetail: loadDetail, expandedRef: expandedRef };
}

// 轻量 toast hook。
function useToast() {
	var toastS = useState(null), toast = toastS[0], setToast = toastS[1];
	var timer = useRef(0);
	function say(text, isErr) {
		setToast({ text: text, err: !!isErr });
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(function () { setToast(null); }, TOAST_MS);
	}
	useEffect(function () {
		return function () { window.clearTimeout(timer.current); };
	}, []);
	return { toast: toast, say: say };
}

// ---- 会话快照：优先 props.useSessions（形态未知，全部防御式读取；任何缺失不崩）----
function readSessionsSnapshot(props) {
	try {
		var us = props && props.useSessions;
		if (!us) return null;
		if (typeof us === "function") return us() || null;
		if (typeof us.getSnapshot === "function") return us.getSnapshot();
		return us;
	} catch (e) {
		return null;
	}
}
function sessionEntryFrom(snap, sid) {
	if (!snap || !sid) return null;
	try {
		if (snap.byId && snap.byId[sid]) return snap.byId[sid];
		if (typeof snap.get === "function") { var got = snap.get(sid); if (got) return got; }
		if (Array.isArray(snap.list)) {
			for (var i = 0; i < snap.list.length; i++) if (String(snap.list[i] && snap.list[i].id) === String(sid)) return snap.list[i];
		}
		if (Array.isArray(snap)) {
			for (var j = 0; j < snap.length; j++) if (String(snap[j] && snap[j].id) === String(sid)) return snap[j];
		}
		if (snap[sid]) return snap[sid];
	} catch (e) { /* ignore */ }
	return null;
}
function sessionTitleOf(snap, sid) {
	var entry = sessionEntryFrom(snap, sid);
	if (!entry) return "";
	var cand = entry.title || entry.name || "";
	if (!cand && entry.header) cand = entry.header.title || entry.header.name || "";
	if (!cand && entry.cwd) cand = entry.cwd;
	if (!cand && entry.header && entry.header.cwd) cand = entry.header.cwd;
	if (!cand && entry.agentPreset) cand = entry.agentPreset;
	return cand ? String(cand) : "";
}

// ---- 视图通用小件 ----
function StatusDot(props) {
	var status = props.status || "queued";
	return h("span", { className: "dsh-ctf-dot tone-" + (STATUS_TONE[status] || "queued"), title: STATUS_LABEL[status] || status });
}
function TotalCard(props) {
	return h("div", { className: "dsh-ctf-total" + (props.tone ? " is-" + props.tone : "") },
		h("span", null, props.label),
		h("b", null, String(props.value == null ? 0 : props.value)));
}
function CategoryBar(props) {
	var value = props.value == null ? 0 : props.value;
	return h("div", { className: "dsh-ctf-bar" },
		h("span", { className: "dsh-ctf-bar-label", title: catLabel(props.category) }, catLabel(props.category)),
		h("div", { className: "dsh-ctf-bar-track" }, h("i", { className: "dsh-ctf-bar-fill", style: { width: pct(value, props.max) + "%" } })),
		h("span", { className: "dsh-ctf-bar-val" }, h("b", null, String(value)), " · 已解 " + (props.solved || 0)));
}
function StatusRow(props) {
	var value = props.value == null ? 0 : props.value;
	return h("div", { className: "dsh-ctf-srow" },
		h(Badge, { status: props.status }),
		h("div", { className: "dsh-ctf-bar-track" }, h("i", { className: "dsh-ctf-bar-fill", style: { width: pct(value, props.max) + "%" } })),
		h("span", { className: "dsh-ctf-bar-val" }, h("b", null, String(value))));
}

// 单题详情主体（题板 / 会话 / 台账三视图共用）。
function ChallengeDetailBody(props) {
	var ch = props.ch || {};
	var flags = ch.flags || [];
	var facts = ch.facts || [];
	var attempts = ch.attempts || [];
	var events = ch.events || [];
	return h("div", null,
		h("div", { className: "dsh-ctf-kv-grid" },
			h(KV, { k: "工作目录", v: ch.dir }),
			h(KV, { k: "目标地址", v: ch.target }),
			h(KV, { k: "创建时间", v: fmtTime(ch.createdAt) }),
			h(KV, { k: "开始时间", v: fmtTime(ch.startedAt) }),
			h(KV, { k: "结束时间", v: fmtTime(ch.endedAt) }),
			h(KV, { k: "平台", v: ch.platform && ch.platform.kind ? ch.platform.kind : "（预留）" }),
			h(KV, { k: "发起会话", v: ch.driverSession || "" }),
			h(KV, { k: "预算", v: "尝试 " + ((ch.budget && ch.budget.maxAttempts) || "—") + " · 时长 " + fmtDur(ch.budget && ch.budget.timeBudgetMs) }),
			ch.stuckReason ? h(KV, { k: "卡住原因", v: ch.stuckReason }) : null,
			ch.statement ? h("div", { className: "dsh-ctf-statement" },
				h("span", null, "题面"),
				h("div", { className: "dsh-ctf-statement-body" }, ch.statement)) : null),
		flagsSection(flags),
		attemptsSection(attempts),
		factsSection(facts),
		eventsSection(events));
}

function fmtBytes(n) {
	var v = Number(n) || 0;
	if (v < 1024) return v + "B";
	if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "KB";
	return (v / (1024 * 1024)).toFixed(1) + "MB";
}

// ---- 单题工作台（卡片「详情」展开）：概览 / 附件 / 笔记 / 脚本 / 产物 + 操作 ----
function WorkbenchBody(props) {
	var id = props.id;
	var ch = props.ch || {};
	var readOnly = props.readOnly === true || props.variant === "settings";
	var sessionId = props.sessionId != null ? String(props.sessionId) : "";
	var say = typeof props.say === "function" ? props.say : function () { };
	var onAction = typeof props.onAction === "function" ? props.onAction : function () { };
	var onChanged = typeof props.onChanged === "function" ? props.onChanged : function () { };
	var onWriteup = typeof props.onWriteup === "function" ? props.onWriteup : null;
	var onDelete = typeof props.onDelete === "function" ? props.onDelete : null;
	var onReview = typeof props.onReview === "function" ? props.onReview : null;
	var onProbe = typeof props.onProbe === "function" ? props.onProbe : null;
	var onPack = typeof props.onPack === "function" ? props.onPack : null;
	var status = ch.status || "";
	var tabS = useState("overview"), tab = tabS[0], setTab = tabS[1];
	var treeS = useState(null), tree = treeS[0], setTree = treeS[1];
	var dirS = useState(""), dir = dirS[0], setDir = dirS[1];
	var wbErrS = useState(""), wbErr = wbErrS[0], setWbErr = wbErrS[1];
	var notesS = useState(""), notes = notesS[0], setNotes = notesS[1];
	var notesLoadedS = useState(false), notesLoaded = notesLoadedS[0], setNotesLoaded = notesLoadedS[1];
	var notesBusyS = useState(false), notesBusy = notesBusyS[0], setNotesBusy = notesBusyS[1];
	var notesDirtyS = useState(false), notesDirty = notesDirtyS[0], setNotesDirty = notesDirtyS[1];
	var readS = useState(null), read = readS[0], setRead = readS[1];
	var readErrS = useState(""), readErr = readErrS[0], setReadErr = readErrS[1];
	var flagS = useState(""), flag = flagS[0], setFlag = flagS[1];
	var submitBusyS = useState(false), submitBusy = submitBusyS[0], setSubmitBusy = submitBusyS[1];

	function refreshTree() {
		request("workbench.tree", { id: id, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) {
				setTree(r.entries || []);
				if (r.dir) setDir(String(r.dir));
				setWbErr("");
			} else setWbErr((r && r.error) || "读取工作台目录失败");
		});
	}
	function loadNotes() {
		request("workbench.read", { id: id, path: "notes.md", sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { setNotes(r.text || ""); setNotesDirty(false); }
			setNotesLoaded(true);
		});
	}
	useEffect(function () {
		setTab("overview");
		setTree(null);
		setWbErr("");
		setDir("");
		setNotes("");
		setNotesLoaded(false);
		setNotesDirty(false);
		setRead(null);
		setReadErr("");
		setFlag("");
		refreshTree();
		loadNotes();
	}, [id]);
	function readFile(path) {
		setReadErr("");
		setRead({ path: path, text: "", loading: true });
		request("workbench.read", { id: id, path: path, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) setRead({ path: path, text: r.text || "", truncated: !!r.truncated, loading: false, size: r.size });
			else { setRead(null); setReadErr((r && r.error) || "读取失败"); }
		});
	}
	function saveNotes() {
		if (readOnly) return;
		setNotesBusy(true);
		request("workbench.write", { id: id, path: "notes.md", text: notes, sessionId: sessionId }).then(function (r) {
			setNotesBusy(false);
			if (r && r.ok) {
				setNotesDirty(false);
				say("笔记已保存（" + fmtBytes(r.bytes || 0) + "）");
				onChanged();
			} else say((r && r.error) || "保存失败", true);
		});
	}
	function submitFlag() {
		if (readOnly) return;
		var v = flag.trim();
		if (!v) { say("请填写要提交的 flag", true); return; }
		setSubmitBusy(true);
		request("platform.submit", { id: id, flag: v, sessionId: sessionId }).then(function (r) {
			setSubmitBusy(false);
			if (r && r.ok) {
				setFlag("");
				say("平台提交：" + (r.status ? String(r.status) : "ok") + (r.message ? " · " + r.message : ""));
				onChanged();
			} else say((r && r.error) || "平台提交失败", true);
		});
	}
	function copyDir() {
		var d = dir || ch.dir || "";
		if (!d) { say("工作目录未知，请重新展开详情", true); return; }
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(d).then(function () { say("已复制目录：" + d); }, function () { say("工作目录：" + d); });
				return;
			}
		} catch (e) { /* ignore */ }
		say("工作目录：" + d);
	}
	function entriesUnder(prefix) {
		var list = tree || [];
		var out = [];
		for (var i = 0; i < list.length; i++) {
			var e = list[i];
			if (!e || !e.path) continue;
			var p = String(e.path);
			if (p === prefix || p.indexOf(prefix + "/") === 0) out.push(e);
		}
		return out;
	}
	function fileList(entries, emptyText) {
		if (!entries.length) return h("div", { className: "dsh-ctf-muted" }, emptyText);
		return h("div", { className: "dsh-ctf-filelist" }, entries.map(function (e, i) {
			var p = String(e.path || "");
			return h("div", { key: p + "-" + i, className: "dsh-ctf-filerow" },
				h("span", { className: "dsh-ctf-filename" }, p),
				e.kind === "dir" ? h("span", { className: "dsh-ctf-chip" }, "目录") : h("span", { className: "dsh-ctf-filesize" }, fmtBytes(e.size)),
				e.mtime ? h("span", { className: "dsh-ctf-filesize" }, fmtTime(e.mtime)) : null,
				e.kind === "dir" ? null : h("button", {
					type: "button", className: "dsh-ctf-btn is-sm is-ghost",
					onClick: function () { readFile(p); }
				}, "查看"));
		}));
	}
	function readPreview() {
		if (readErr) return h("div", { className: "dsh-ctf-error is-inline" }, h("span", null, readErr));
		if (!read) return null;
		if (read.loading) return h("div", { className: "dsh-ctf-muted" }, h("span", { className: "dsh-ctf-spin" }), " 读取中…");
		return h("div", { className: "dsh-ctf-sec" },
			h(SecTitle, { title: read.path, count: read.size ? fmtBytes(read.size) : 0 }),
			h("pre", { className: "dsh-ctf-wbread" }, read.text || ""),
			read.truncated ? h("div", { className: "dsh-ctf-wbnote" }, "文件较大，已截断显示（≤512KB）。") : null);
	}
	var counts = { files: entriesUnder("files").length, scripts: entriesUnder("scripts").length, artifacts: entriesUnder("artifacts").length };
	var tabs = [
		{ key: "overview", label: "概览" },
		{ key: "files", label: "附件 " + counts.files },
		{ key: "notes", label: "笔记" },
		{ key: "scripts", label: "脚本 " + counts.scripts },
		{ key: "artifacts", label: "产物 " + counts.artifacts }
	];
	var body;
	if (tab === "overview") body = h(ChallengeDetailBody, { ch: ch });
	else if (tab === "files") body = h("div", null, fileList(entriesUnder("files"), "附件目录为空（files/）。"), readPreview());
	else if (tab === "notes") {
		body = h("div", { className: "dsh-ctf-notes" },
			readOnly
				? h("pre", { className: "dsh-ctf-wbread" }, notes || "（notes.md 为空）")
				: h("textarea", {
					value: notes,
					placeholder: "随做随记：发现 / 假设 / 验证 / 卡点…",
					onChange: function (e) { setNotes(e.target.value); setNotesDirty(true); }
				}),
			h("div", { className: "dsh-ctf-wbactions" },
				readOnly
					? h("span", { className: "dsh-ctf-wbnote" }, "设置页为只读工作台；请在会话视图编辑笔记。")
					: h("button", {
						type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: notesBusy || !notesLoaded, onClick: saveNotes
					}, notesBusy ? "保存中…" : (notesDirty ? "保存笔记 *" : "保存笔记")),
				h("span", { className: "dsh-ctf-wbnote" }, "写入 notes.md（≤512KB，仅题目录内；保存后下次尝试会带上前序笔记）。")));
	} else {
		var entries = entriesUnder(tab === "scripts" ? "scripts" : "artifacts");
		body = h("div", null, fileList(entries, tab === "scripts" ? "脚本目录为空（scripts/）。" : "产物目录为空（artifacts/）。"), readPreview());
	}

	return h("div", { className: "dsh-ctf-wb" },
		h("div", { className: "dsh-ctf-wbhead" },
			h("div", { className: "dsh-ctf-wbtitle" },
				h(Badge, { status: status }),
				h("b", null, ch.title || "(未命名题目)"),
				ch.category ? h("span", { className: "dsh-ctf-chip" }, CATEGORY_LABEL[ch.category] || ch.category) : null,
				h("span", { className: "dsh-ctf-card-id" }, "ID " + id)),
			h("div", { className: "dsh-ctf-wbmeta" },
				h("span", null, "尝试 " + ((ch.attempts || []).length)),
				h("span", null, "flag " + ((ch.flags || []).length)),
				ch.target ? h("span", { className: "dsh-ctf-svcwd", title: String(ch.target) }, "目标 " + String(ch.target)) : null,
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: copyDir }, "复制目录")),
			h("div", { className: "dsh-ctf-wbnote dsh-ctf-wbdir" }, "目录：" + (dir || ch.dir || "—"))),
		wbErr ? h("div", { className: "dsh-ctf-error is-inline" },
			h("span", null, wbErr),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: refreshTree }, "重试")) : null,
		h("div", { className: "dsh-ctf-wbtabs" }, tabs.map(function (t) {
			return h("button", {
				key: t.key, type: "button",
				className: "dsh-ctf-wbtab" + (tab === t.key ? " is-on" : ""),
				onClick: function () { setTab(t.key); setRead(null); setReadErr(""); }
			}, t.label);
		})),
		h("div", { className: "dsh-ctf-wbbody" }, body),
		h("div", { className: "dsh-ctf-wbactions" },
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: readOnly || status === "running" || status === "solved", onClick: function () { onAction("start"); } }, "开始"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-danger", disabled: readOnly || status !== "running", onClick: function () { onAction("stop"); } }, "停止"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: readOnly || status === "running" || status === "solved", onClick: function () { onAction("retry"); } }, "重试"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: copyDir }, "复制目录"),
			readOnly || !onWriteup ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: status !== "solved", onClick: onWriteup, title: status === "solved" ? "导出该题 Writeup" : "解出后才能导出 Writeup" }, "导出 Writeup"),
		readOnly || !onProbe ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: onProbe, title: "探测靶机/目标是否就绪" }, "探测目标"),
		readOnly || !onReview ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: status !== "solved", onClick: onReview, title: "独立复核该题 flag" }, "复核"),
		readOnly || !onPack ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: status !== "solved", onClick: onPack, title: "打包 Writeup（tar.gz）" }, "打包 WP"),
		readOnly || !onDelete ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost is-danger", onClick: onDelete, title: "从题板移除（工作目录保留）" }, "删除题目"),
		readOnly ? null : h("div", { className: "dsh-ctf-wbflag" },
				h("input", {
					className: "dsh-ctf-in", placeholder: "提交 flag 到平台（需平台已配置且题目已导入）",
					value: flag, onChange: function (e) { setFlag(e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") submitFlag(); }
				}),
				h("button", {
					type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: submitBusy || !flag.trim(), onClick: submitFlag
				}, submitBusy ? "提交中…" : "提交 flag")),
			h("span", { className: "dsh-ctf-wbnote" }, "目录：" + (dir || ch.dir || "—"))));
}

// ---- 平台面板（CTFd）：配置 / 测试连接 / 拉取题板 + 勾选导入 ----
function PlatformPanel(props) {
	var say = typeof props.say === "function" ? props.say : function () { };
	var onImported = typeof props.onImported === "function" ? props.onImported : function () { };
	var onStatus = typeof props.onStatus === "function" ? props.onStatus : function () { };
	var sessionId = props.sessionId != null ? String(props.sessionId) : "";
	var status = props.status || null;
	var cfgS = useState(null), cfg = cfgS[0], setCfg = cfgS[1];
	var baseS = useState(""), baseUrl = baseS[0], setBaseUrl = baseS[1];
	var tokenS = useState(""), token = tokenS[0], setToken = tokenS[1];
	var kindS = useState("ctfd"), kind = kindS[0], setKind = kindS[1];
	var profileS = useState(""), profileText = profileS[0], setProfileText = profileS[1];
	var busyS = useState(""), busy = busyS[0], setBusy = busyS[1];
	var pulledS = useState(null), pulled = pulledS[0], setPulled = pulledS[1];
	var selectedS = useState({}), selected = selectedS[0], setSelected = selectedS[1];
	var resultS = useState(null), result = resultS[0], setResult = resultS[1];

	function loadConfig() {
		request("platform.config.get", {}).then(function (r) {
			if (r && r.ok && r.platform) { setCfg(r.platform); setBaseUrl(r.platform.baseUrl || ""); setKind(r.platform.kind || "ctfd"); setProfileText(r.platform.profile ? JSON.stringify(r.platform.profile, null, 2) : ""); }
			else say((r && r.error) || "读取平台配置失败", true);
		});
	}
	useEffect(function () { loadConfig(); }, []);
	function detectPlatformType() {
		setBusy("detect");
		request("platform.detect", { baseUrl: baseUrl.trim(), apiToken: token.trim() || undefined, apply: true }).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				var d = r.detection || {};
				say("识别为 " + d.kind + "（" + (d.confidence || "?") + "）" + (r.applied ? "，已应用" : ""));
				loadConfig();
				testConnection(true);
			} else say((r && (r.error || (r.detection && r.detection.error))) || "未能识别平台类型", true);
		});
	}
	function testConnection(silent) {
		setBusy("test");
		request("platform.status", {}).then(function (r) {
			setBusy("");
			onStatus(r || null);
			if (!silent) {
				if (r && r.ok && r.reachable) say("平台连接成功" + (r.user && (r.user.name || r.user.id) ? "：" + (r.user.name || r.user.id) : ""));
				else say((r && r.error) || "平台连接失败", true);
			}
		});
	}
	function saveConfig() {
		var payload = { kind: kind };
		payload.baseUrl = baseUrl.trim();
		if (token.trim()) payload.apiToken = token.trim();
		if (kind === "generic") {
			if (profileText.trim()) {
				try { JSON.parse(profileText); } catch (e) { say("profile JSON 不合法：" + ((e && e.message) || e), true); return; }
				payload.profile = profileText.trim();
			} else payload.profile = null;
		}
		setBusy("save");
		request("platform.config.set", payload).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				if (r.platform) { setCfg(r.platform); setBaseUrl(r.platform.baseUrl || ""); }
				setToken("");
				say("平台配置已保存");
				testConnection(true);
			} else say((r && r.error) || "保存失败", true);
		});
	}
	function clearToken() {
		setBusy("clear");
		request("platform.config.set", { kind: kind, apiToken: "" }).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				if (r.platform) setCfg(r.platform);
				say("平台 Token 已清除");
				onStatus(null);
			} else say((r && r.error) || "清除失败", true);
		});
	}
	function pullChallenges() {
		setBusy("pull");
		request("platform.challenges", {}).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				var list = r.challenges || [];
				setPulled({ challenges: list, error: "" });
				var sel = {};
				list.forEach(function (c) { if (c && c.id != null && !c.solvedByMe) sel[String(c.id)] = true; });
				setSelected(sel);
				say("拉取到 " + list.length + " 道平台题");
			} else {
				setPulled({ challenges: [], error: (r && r.error) || "拉取失败" });
				say((r && r.error) || "拉取失败", true);
			}
		});
	}
	function toggleSelect(pid) {
		var next = Object.assign({}, selected);
		if (next[pid]) delete next[pid]; else next[pid] = true;
		setSelected(next);
	}
	function importSelected() {
		var ids = [];
		if (pulled) pulled.challenges.forEach(function (c) { if (c && c.id != null && selected[String(c.id)]) ids.push(String(c.id)); });
		if (!ids.length) { say("请先勾选要导入的平台题", true); return; }
		setBusy("import");
		request("platform.import", { ids: ids, skipSolved: true, sessionId: sessionId }).then(function (r) {
			setBusy("");
			setResult(r || null);
			if (r && r.ok) {
				say("已导入 " + ((r.created || []).length) + " 道（跳过 " + ((r.skipped || []).length) + "）");
				onImported();
				if (pulled) {
					var keep = {};
					pulled.challenges.forEach(function (c) { if (c && c.id != null) keep[String(c.id)] = !!selected[String(c.id)]; });
					setSelected(keep);
				}
			} else say((r && r.error) || "导入失败", true);
		});
	}
	var statusLine = "";
	if (status) {
		if (status.configured === false) statusLine = "未配置平台";
		else if (status.reachable) statusLine = "已连接" + (status.baseUrl ? " · " + status.baseUrl : "") + (status.user && (status.user.name || status.user.id) ? " · " + (status.user.name || status.user.id) : "");
		else statusLine = "连接异常" + (status.error ? "：" + status.error : "");
	}
	return h("div", { className: "dsh-ctf-panel dsh-ctf-plat" },
		h("div", { className: "dsh-ctf-head" },
			h("div", { className: "dsh-ctf-head-main" },
				h("div", { className: "dsh-ctf-sec-title" }, "平台接入（" + (kind === "generic" ? "通用 JSON 适配器" : "CTFd") + "）"),
				h("div", { className: "dsh-ctf-platstatus" },
					statusLine + (cfg && cfg.tokenSet ? " · Token 已设置" + (cfg.tokenHint ? "（尾号 " + cfg.tokenHint + "）" : "") : " · Token 未设置"))),
			h("div", { className: "dsh-ctf-head-actions" },
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: !!busy, onClick: function () { testConnection(false); } }, busy === "test" ? "测试中…" : "测试连接"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: detectPlatformType }, busy === "detect" ? "探测中…" : "自动探测平台"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: props.onClose }, "收起"))),
		h("div", { className: "dsh-ctf-platgrid" },
			h("label", { className: "dsh-ctf-field" },
				h("span", null, "适配器模式"),
				h("select", { className: "dsh-ctf-in", value: kind, onChange: function (e) { setKind(e.target.value); } },
					h("option", { value: "ctfd" }, "CTFd（标准 API）"),
					h("option", { value: "generic" }, "通用 JSON（任意平台，需填 profile）"))),
			h("label", { className: "dsh-ctf-field" },
				h("span", null, "平台地址（baseUrl）"),
				h("input", {
					className: "dsh-ctf-in", placeholder: "https://ctfd.example.com",
					value: baseUrl, onChange: function (e) { setBaseUrl(e.target.value); }
				})),
			h("label", { className: "dsh-ctf-field" },
				h("span", null, "API Token" + (cfg && cfg.tokenSet ? "（已设置，留空保持不变）" : "")),
				h("input", {
					className: "dsh-ctf-in", type: "password", placeholder: cfg && cfg.tokenSet ? "已设置，输入新 token 可替换" : "粘贴 CTFd API Token",
					value: token, onChange: function (e) { setToken(e.target.value); }
				}))),
			kind !== "generic" ? null : h("label", { className: "dsh-ctf-field" },
				h("span", null, "Profile JSON（列表/详情/提交路径 + 字段映射）"),
				h("textarea", {
					className: "dsh-ctf-in dsh-ctf-pathbox", rows: 6, value: profileText,
					placeholder: '{"listPath":"/api/challenges","detailPath":"/api/challenges/{id}","submitPath":"/api/challenges/{id}/submit","map":{"list":{"dataPath":"data"},"submit":{"statusPath":"data.status","okStatuses":["correct"]}}}',
					onChange: function (e) { setProfileText(e.target.value); }
				}),
				h("span", { className: "dsh-ctf-muted" }, "Token 会以 Bearer 头发送；附件自动下载不支持，导入时请在题面/平台手动下载。")),
		h("div", { className: "dsh-ctf-platrow" },
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: !!busy, onClick: saveConfig }, busy === "save" ? "保存中…" : "保存配置"),
			cfg && cfg.tokenSet ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: clearToken }, "清除 Token") : null,
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: !!busy, onClick: pullChallenges }, busy === "pull" ? "拉取中…" : "拉取题板")),
		pulled && pulled.error ? h("div", { className: "dsh-ctf-error is-inline" }, h("span", null, pulled.error)) : null,
		pulled && !pulled.error && pulled.challenges.length === 0 ? h("div", { className: "dsh-ctf-muted" }, "平台暂无题目。") : null,
		pulled && pulled.challenges.length ? h("div", null,
			h("div", { className: "dsh-ctf-platrow" },
				h("button", {
					type: "button", className: "dsh-ctf-btn is-sm is-ghost",
					onClick: function () { var next = {}; pulled.challenges.forEach(function (c) { if (c && c.id != null) next[String(c.id)] = true; }); setSelected(next); }
				}, "全选"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { setSelected({}); } }, "全不选"),
				h("span", { className: "dsh-ctf-platstatus" }, "已选 " + Object.keys(selected).length + " / " + pulled.challenges.length),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: !!busy || !Object.keys(selected).length, onClick: importSelected }, busy === "import" ? "导入中…" : "导入选中")),
			h("div", { className: "dsh-ctf-plist" }, pulled.challenges.map(function (c, i) {
				var pid = String(c.id);
				return h("label", { key: pid + "-" + i, className: "dsh-ctf-prow" },
					h("input", { type: "checkbox", checked: !!selected[pid], onChange: function () { toggleSelect(pid); } }),
					h("span", { className: "dsh-ctf-chip" }, catLabel(c.category)),
					h("b", null, c.name || ("#" + pid)),
					h("span", { className: "dsh-ctf-platstatus" }, "#" + pid + (c.value != null ? " · " + c.value + " 分" : "") + (c.type ? " · " + c.type : "")),
					c.solvedByMe ? h("span", { className: "dsh-ctf-tag is-ok" }, "平台已解") : null);
			}))) : null,
		result ? h("div", { className: "dsh-ctf-platstatus" },
			(result.ok
				? "导入结果：新建 " + ((result.created || []).length) + " · 跳过 " + ((result.skipped || []).length) + ((result.errors || []).length ? " · 错误 " + result.errors.length : "")
				: "导入失败：" + (result.error || ""))) : null,
		result && result.created && result.created.length ? h("div", { className: "dsh-ctf-muted" },
			result.created.map(function (c) { return (c.title || "") + "（" + c.localId + "）"; }).join(" · ")) : null);
}

// ---- 主面板（设置页 variant="settings" / 会话视图 variant="view" 共用同一套组件）----
function Panel(props) {
	var variant = props && props.variant === "view" ? "view" : "settings";
	var isView = variant === "view";
	var sessionId = props && props.sessionId != null ? String(props.sessionId) : "";
	var allScopeS = useState(false), allScope = allScopeS[0], setAllScope = allScopeS[1];
	var live = useBoardData(sessionId, allScope);
	var snap = live.snap, err = live.err, updatedAt = live.updatedAt, reload = live.reload, setErr = live.setErr;
	var challengeDetail = useChallengeDetail(sessionId);
	var expanded = challengeDetail.expanded, detail = challengeDetail.detail, detailErr = challengeDetail.detailErr;
	var loadDetail = challengeDetail.loadDetail, expandedRef = challengeDetail.expandedRef, toggleDetail = challengeDetail.toggle;
	var toastApi = useToast();
	var toast = toastApi.toast, say = toastApi.say;

	var busyS = useState(""), busy = busyS[0], setBusy = busyS[1];
	var formOpenS = useState(false), formOpen = formOpenS[0], setFormOpen = formOpenS[1];
	var titleS = useState(""), title = titleS[0], setTitle = titleS[1];
	var categoryS = useState(""), category = categoryS[0], setCategory = categoryS[1];
	var statementS = useState(""), statement = statementS[0], setStatement = statementS[1];
	var targetS = useState(""), target = targetS[0], setTarget = targetS[1];
	var filesS = useState(""), filesText = filesS[0], setFilesText = filesS[1];
	var autoStartS = useState(true), autoStart = autoStartS[0], setAutoStart = autoStartS[1];
	var onlyMineS = useState(false), onlyMine = onlyMineS[0], setOnlyMine = onlyMineS[1];
	var statusFilterS = useState("all"), statusFilter = statusFilterS[0], setStatusFilter = statusFilterS[1];
	var catFilterS = useState(""), catFilter = catFilterS[0], setCatFilter = catFilterS[1];
	var queryS = useState(""), query = queryS[0], setQuery = queryS[1];
	var sortS = useState("new"), sortKey = sortS[0], setSortKey = sortS[1];
	var groupModeS = useState("session"), groupMode = groupModeS[0], setGroupMode = groupModeS[1];
	var collapsedS = useState({}), collapsed = collapsedS[0], setCollapsed = collapsedS[1];
	var ledgerOpenS = useState(false), ledgerOpen = ledgerOpenS[0], setLedgerOpen = ledgerOpenS[1];
	var ledgerEvS = useState(""), ledgerEv = ledgerEvS[0], setLedgerEv = ledgerEvS[1];
	var platformOpenS = useState(false), platformOpen = platformOpenS[0], setPlatformOpen = platformOpenS[1];
	var platformStatusS = useState(null), platformStatus = platformStatusS[0], setPlatformStatus = platformStatusS[1];
	var reportS = useState(null), report = reportS[0], setReport = reportS[1];
	var reportBusyS = useState(false), reportBusy = reportBusyS[0], setReportBusy = reportBusyS[1];
	var tabS = useState("board"), tab = tabS[0], setTab = tabS[1];
	var cfgS = useState(null), runtimeCfg = cfgS[0], setRuntimeCfg = cfgS[1];
	var cfgBusyS = useState(false), cfgBusy = cfgBusyS[0], setCfgBusy = cfgBusyS[1];
	var cfgMsgS = useState(""), cfgMsg = cfgMsgS[0], setCfgMsg = cfgMsgS[1];
	var docS = useState(null), doctor = docS[0], setDoctor = docS[1];
	var reportsS = useState([]), reports = reportsS[0], setReports = reportsS[1];
	var reportPrevS = useState(null), reportPrev = reportPrevS[0], setReportPrev = reportPrevS[1];
	var writeupsS = useState([]), writeups = writeupsS[0], setWriteups = writeupsS[1];
	var writeupPrevS = useState(null), writeupPrev = writeupPrevS[0], setWriteupPrev = writeupPrevS[1];
	var writeupAllS = useState(""), writeupAll = writeupAllS[0], setWriteupAll = writeupAllS[1];
	var repQueryS = useState(""), repQuery = repQueryS[0], setRepQuery = repQueryS[1];
	var repCatS = useState(""), repCat = repCatS[0], setRepCat = repCatS[1];
	var repSortS = useState("new"), repSort = repSortS[0], setRepSort = repSortS[1];
	var repOnlyWuS = useState(false), repOnlyWu = repOnlyWuS[0], setRepOnlyWu = repOnlyWuS[1];
	var repExpandS = useState(""), repExpand = repExpandS[0], setRepExpand = repExpandS[1];
	var repEvOpenS = useState(""), repEvOpen = repEvOpenS[0], setRepEvOpen = repEvOpenS[1];
	var kbQueryS = useState(""), kbQuery = kbQueryS[0], setKbQuery = kbQueryS[1];
	var kbRowsS = useState([]), kbRows = kbRowsS[0], setKbRows = kbRowsS[1];
	var kbBusyS = useState(false), kbBusy = kbBusyS[0], setKbBusy = kbBusyS[1];
	var kbFilesS = useState([]), kbFiles = kbFilesS[0], setKbFiles = kbFilesS[1];
	var kbImpTextS = useState(""), kbImpText = kbImpTextS[0], setKbImpText = kbImpTextS[1];
	var kbImpBusyS = useState(false), kbImpBusy = kbImpBusyS[0], setKbImpBusy = kbImpBusyS[1];
	var memDataS = useState(null), memData = memDataS[0], setMemData = memDataS[1];
	var memKindS = useState(""), memKind = memKindS[0], setMemKind = memKindS[1];
	var memCardsS = useState([]), memCards = memCardsS[0], setMemCards = memCardsS[1];
	var memExpandS = useState(""), memExpand = memExpandS[0], setMemExpand = memExpandS[1];
	var schedDataS = useState(null), schedData = schedDataS[0], setSchedData = schedDataS[1];
	var kbStatsS = useState(null), kbStats = kbStatsS[0], setKbStats = kbStatsS[1];
	var kbPreviewS = useState(null), kbPreview = kbPreviewS[0], setKbPreview = kbPreviewS[1];
	var kbSourceS = useState(""), kbSource = kbSourceS[0], setKbSource = kbSourceS[1];
	var kbImpLogS = useState(null), kbImpLog = kbImpLogS[0], setKbImpLog = kbImpLogS[1];
	var kbDropOverS = useState(false), kbDropOver = kbDropOverS[0], setKbDropOver = kbDropOverS[1];
	var confirmS = useState(""), confirm = confirmS[0], setConfirm = confirmS[1];
	var cfgDirtyS = useState(false), cfgDirty = cfgDirtyS[0], setCfgDirty = cfgDirtyS[1];
	var cfgDefaultsS = useState(null), cfgDefaults = cfgDefaultsS[0], setCfgDefaults = cfgDefaultsS[1];
	var sessionsSnap = isView ? readSessionsSnapshot(props) : null;
	useEffect(function () {
		if (!isView) return;
		request("platform.status", {}).then(function (r) { setPlatformStatus(r || null); });
	}, []);
	useEffect(function () {
		if (!isView) return;
		if (tab === "settings") {
			request("config.get", {}).then(function (r) {
				if (r && r.ok && r.config) { setRuntimeCfg(r.config); setCfgDefaults(r.defaults || null); setCfgDirty(false); }
			});
			request("doctor", { sessionId: sessionId }).then(function (r) { if (r) setDoctor(r); });
		}
		if (tab === "report") {
			request("report.list", {}).then(function (r) { if (r && r.ok) setReports(r.reports || []); });
			request("writeup.list", {}).then(function (r) { if (r && r.ok) setWriteups(r.writeups || []); });
		}
		if (tab === "knowledge") loadKnowledge();
		if (tab === "memory") loadMemory();
		if (tab === "schedule") loadSchedule();
	}, [tab, isView, sessionId]);

	function resetForm() {
		setTitle(""); setCategory(""); setStatement(""); setTarget(""); setFilesText("");
	}
	function toggle(id) {
		toggleDetail(id);
	}
	function clearFilters() {
		setStatusFilter("all");
		setCatFilter("");
		setQuery("");
	}
	function doAction(kind, c) {
		if (!c || busy) return;
		var endpoint = kind === "start" ? "challenge.start" : kind === "stop" ? "challenge.stop" : "challenge.retry";
		var payload = { id: c.id };
		if (sessionId) payload.sessionId = sessionId;
		setBusy(kind + ":" + c.id);
		request(endpoint, payload).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				if (kind === "start") say("已开始解题：" + c.title);
				else if (kind === "stop") say("已停止：" + c.title);
				else say("已重新排队：" + c.title);
				reload();
				if (expandedRef.current === c.id) loadDetail(c.id);
			} else {
				var msg = (r && r.error) || "操作失败";
				say(msg, true);
				setErr(msg);
			}
		});
	}
	function submitForm() {
		if (busy) return;
		var t = title.trim();
		var s = statement.trim();
		if (!t) { say("请填写题目名称", true); return; }
		if (!s) { say("请填写题面", true); return; }
		var fl = filesText.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
		var payload = { title: t, statement: s, autoStart: autoStart };
		if (sessionId) payload.sessionId = sessionId;
		if (category) payload.category = category;
		if (target.trim()) payload.target = target.trim();
		if (fl.length) payload.files = fl;
		setBusy("add");
		request("challenge.add", payload).then(function (r) {
			if (!r || !r.ok) {
				setBusy("");
				var msg = (r && r.error) || "创建失败";
				say(msg, true);
				setErr(msg);
				return;
			}
			var id = r.id;
			var shouldStart = autoStart && !!id;
			function done() {
				setBusy("");
				resetForm();
				setFormOpen(false);
				say(shouldStart ? "已创建题目并加入解题队列" : "已创建题目（未启动）");
				reload();
				if (expandedRef.current === id) loadDetail(id);
			}
			if (shouldStart) {
				var startPayload = { id: id };
				if (sessionId) startPayload.sessionId = sessionId;
				request("challenge.start", startPayload).then(function (r2) {
					if (r2 && !r2.ok) say((r2 && r2.error) || "启动失败", true);
					done();
				});
			} else done();
		});
	}
	function renderDetail(c) {
		var det = detail;
		var ready = det && det.id === c.id;
		return h("div", { className: "dsh-ctf-detail" },
			detailErr ? h("div", { className: "dsh-ctf-error is-inline" },
				h("span", null, detailErr),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: function () { loadDetail(c.id); } }, "重试")) : null,
			ready
				? h(WorkbenchBody, {
					key: c.id,
					id: c.id,
					ch: det.data,
					variant: variant,
					readOnly: allScope,
					sessionId: sessionId,
					dir: c.dir,
					say: say,
					onAction: function (kind) { doAction(kind, c); },
					onWriteup: function () { exportWriteup(c); },
					onProbe: function () { probeTargetOf(c); },
		onReview: function () { reviewChallenge(c); },
					onPack: function () { packChallenge(c); },
					onDelete: function () { deleteChallenge(c, false); },
					onChanged: function () { reload(); loadDetail(c.id); }
				})
				: h("div", { className: "dsh-ctf-muted" }, h("span", { className: "dsh-ctf-spin" }), " 加载工作台…"));
	}
	function renderCard(c) {
		var open = expanded === c.id;
		var running = c.status === "running";
		var isBusy = !!busy;
		var mine = !!(sessionId && c.driverSession === sessionId);
		var sub = [c.slug ? "slug " + c.slug : "", c.target ? "目标 " + c.target : ""].filter(Boolean).join(" · ");
		return h("div", {
			key: c.id,
			className: "dsh-ctf-card" + (open ? " is-open" : "") + (c.status === "solved" ? " is-solved" : "") + (running ? " is-running" : "")
		},
			h("div", { className: "dsh-ctf-card-head" },
				h("div", { className: "dsh-ctf-card-line" },
					h(Badge, { status: c.status }),
					h("b", { className: "dsh-ctf-card-title", title: c.title }, c.title || "(未命名)"),
					c.category ? h("span", { className: "dsh-ctf-chip" }, CATEGORY_LABEL[c.category] || c.category) : null,
					allScope && c.workspace ? h("span", { className: "dsh-ctf-chip", title: String(c.workspace) }, "工作区 " + String(c.workspace).split(/[\\/]/).pop()) : null,
					mine ? h("span", { className: "dsh-ctf-chip is-mine" }, "本会话") : null,
					h("span", { className: "dsh-ctf-card-id" }, "ID " + c.id)),
				h("div", { className: "dsh-ctf-card-line" },
					h("span", { className: "dsh-ctf-metric" }, "耗时 ", h("b", null, fmtDur(elapsedOf(c)))),
					c.status === "running" && c.remainingMs != null
						? h("span", { className: "dsh-ctf-metric dsh-ctf-countdown" + (c.phase === "wrapup" ? " is-wrapup" : "") }, (c.phase === "wrapup" ? "结算中 " : "剩余 ") + fmtDur(c.remainingMs))
						: null,
					h("span", { className: "dsh-ctf-metric" }, "尝试 ", h("b", null, String(c.attempts || 0))),
					h("span", { className: "dsh-ctf-metric" }, "flag ", h("b", null, String(c.flags || 0))),
					c.targetStatus ? h("span", { className: "dsh-ctf-pill " + (c.targetStatus.ok ? "is-ok" : "is-warn"), title: c.targetStatus.error || "" }, c.targetStatus.ok ? "靶机就绪" : "目标" + c.targetStatus.state) : null,
					c.estCost > 0 ? h("span", { className: "dsh-ctf-metric" }, "费用 ", h("b", null, "¥" + Number(c.estCost).toFixed(3))) : null,
					c.lastEvent && (c.status === "running" || c.status === "queued" || c.status === "stuck") ? h("span", { className: "dsh-ctf-metric dsh-ctf-lastevent", title: c.lastEvent.text }, "动作 ", h("b", null, String(c.lastEvent.text || "").slice(0, 30))) : null,
					h("button", {
							type: "button", className: "dsh-ctf-btn is-sm", disabled: allScope || isBusy || running || c.status === "solved",
						onClick: function () { doAction("start", c); }
					}, "开始"),
					h("button", {
							type: "button", className: "dsh-ctf-btn is-sm is-danger", disabled: allScope || isBusy || !running,
						onClick: function () { doAction("stop", c); }
					}, "停止"),
					h("button", {
							type: "button", className: "dsh-ctf-btn is-sm", disabled: allScope || isBusy || running || c.status === "solved",
						onClick: function () { doAction("retry", c); }
					}, "重试"),
						!allScope && c.verified ? h("button", {
						type: "button", className: "dsh-ctf-btn is-sm is-ghost", title: "导出该题 Writeup",
						onClick: function () { exportWriteup(c); }
					}, "Writeup") : null,
						allScope ? null : h("button", {
							type: "button", className: "dsh-ctf-btn is-sm is-ghost is-danger" + (confirm === "del:" + c.id ? " is-on" : ""),
							title: "从题板移除（工作目录保留）",
							onClick: function () { deleteChallenge(c, false); }
						}, confirm === "del:" + c.id ? "确认删除" : "删除"),
						!allScope && c.verified ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", title: "独立复核该题 flag", onClick: function () { reviewChallenge(c); } }, "复核") : null,
						!allScope && c.verified ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", title: "打包 Writeup（tar.gz）", onClick: function () { packChallenge(c); } }, "打包") : null,
					h("button", {
						type: "button", className: "dsh-ctf-btn is-sm is-ghost",
						onClick: function () { toggle(c.id); }
					}, open ? "收起" : "详情"))),
			sub ? h("div", { className: "dsh-ctf-card-sub" }, sub) : null,
			c.stuckReason ? h("div", { className: "dsh-ctf-card-warn" }, "卡点：" + c.stuckReason) : null,
			open ? renderDetail(c) : null);
	}
	function renderForm() {
		return h("div", { className: "dsh-ctf-panel dsh-ctf-formwrap" },
			h("div", { className: "dsh-ctf-form" },
				field("题目名称 *", h("input", {
					className: "dsh-ctf-in", placeholder: "如：Fish Joy in HTML5",
					value: title, onChange: function (e) { setTitle(e.target.value); }
				})),
				field("模块", h("select", {
					className: "dsh-ctf-in", value: category,
					onChange: function (e) { setCategory(e.target.value); }
				},
					h("option", { value: "" }, "（未指定）"),
					CATEGORIES.map(function (c) { return h("option", { key: c, value: c }, CATEGORY_LABEL[c] || c); }))),
				field("目标地址（可选）", h("input", {
					className: "dsh-ctf-in", placeholder: "http://1.2.3.4:8080",
					value: target, onChange: function (e) { setTarget(e.target.value); }
				})),
				field("题面 *", h("textarea", {
					className: "dsh-ctf-in", rows: 4,
					placeholder: "题面全文：提示 / 附件说明 / 目标地址…",
					value: statement, onChange: function (e) { setStatement(e.target.value); }
				}), true),
				field("附件路径（可选，每行一个）", h("textarea", {
					className: "dsh-ctf-in", rows: 3,
					placeholder: "C:\\chals\\game.zip\nhttps://example.com/hint.txt",
					value: filesText, onChange: function (e) { setFilesText(e.target.value); }
				}), true),
				sessionId
					? h("div", { className: "dsh-ctf-formnote" }, "将以当前会话 " + shortSession(sessionId) + " 作为父代理派发解题子代理。")
					: null,
				h("div", { className: "dsh-ctf-formfoot" },
					h("label", { className: "dsh-ctf-check" },
						h("input", {
							type: "checkbox", checked: autoStart,
							onChange: function (e) { setAutoStart(e.target.checked); }
						}),
						"创建后立即开始解题"),
					h("div", { className: "dsh-ctf-head-actions" },
						h("button", { type: "button", className: "dsh-ctf-btn is-ghost", onClick: resetForm }, "清空"),
						h("button", {
							type: "button", className: "dsh-ctf-btn is-primary", disabled: !!busy,
							onClick: submitForm
						}, busy === "add" ? "创建中…" : "创建并入队")))));
	}

	var stats = (snap && snap.stats) || { total: 0, queued: 0, running: 0, solved: 0, stuck: 0, failed: 0, stopped: 0 };
	var config = (snap && snap.config) || null;
	var warning = warningOf(snap);
	var allChallenges = (snap && snap.challenges) || [];
	var mineCount = sessionId ? allChallenges.filter(function (c) { return c.driverSession === sessionId; }).length : 0;
	var baseChallenges = isView && onlyMine && !allScope
		? allChallenges.filter(function (c) { return !!sessionId && c.driverSession === sessionId; })
		: allChallenges;
	var catOptions = [];
	var catSeen = {};
	((snap && snap.aggregates && snap.aggregates.byCategory) || []).forEach(function (row) {
		if (!row) return;
		var key = catLabel(row.category);
		if (catSeen[key]) return;
		catSeen[key] = true;
		catOptions.push({ category: key, total: row.total || 0 });
	});
	allChallenges.forEach(function (c) {
		var key = catLabel(c.category);
		if (catSeen[key]) return;
		catSeen[key] = true;
		catOptions.push({ category: key, total: 1 });
	});
	var needle = query.trim().toLowerCase();
	var challenges = baseChallenges.filter(function (c) {
		if (statusFilter !== "all" && c.status !== statusFilter) return false;
		if (catFilter && catLabel(c.category) !== catFilter) return false;
		if (needle) {
			var hay = (String(c.title || "") + " " + String(c.slug || "") + " " + String(c.target || "") + " " + String(c.id || "")).toLowerCase();
			if (hay.indexOf(needle) < 0) return false;
		}
		return true;
	});
	challenges = challenges.slice().sort(function (a, b) {
		if (sortKey === "duration") return elapsedOf(b) - elapsedOf(a);
		if (sortKey === "status") {
			var ra = STATUS_RANK[a.status] == null ? 9 : STATUS_RANK[a.status];
			var rb = STATUS_RANK[b.status] == null ? 9 : STATUS_RANK[b.status];
			if (ra !== rb) return ra - rb;
		}
		return (b.createdAt || 0) - (a.createdAt || 0);
	});
	var filterActive = statusFilter !== "all" || !!catFilter || !!needle;
	var sortNote = sortKey === "new" ? "" : " · 排序：" + SORT_LABEL[sortKey];
	var filterNote = "筛选 " + challenges.length + " / " + allChallenges.length + (isView && onlyMine ? "（仅本会话）" : "") + sortNote;
	var aggs = (snap && snap.aggregates) || {};
	var byCategory = aggs.byCategory || [];
	var byStatus = aggs.byStatus || {};
	var ledger = aggs.ledger || [];
	var sessionAgg = {};
	(aggs.bySession || []).forEach(function (row) {
		if (row && row.sessionId !== undefined) sessionAgg[String(row.sessionId || "")] = row;
	});
	var groups = [];
	var groupOf = {};
	challenges.forEach(function (c) {
		var sid = c.driverSession ? String(c.driverSession) : "";
		if (!groupOf[sid]) {
			groupOf[sid] = { sessionId: sid, challenges: [], agg: sessionAgg[sid] || null };
			groups.push(groupOf[sid]);
		}
		groupOf[sid].challenges.push(c);
	});
	groups.sort(function (a, b) {
		if (!a.sessionId) return 1;
		if (!b.sessionId) return -1;
		var la = a.agg ? (a.agg.lastAt || 0) : 0;
		var lb = b.agg ? (b.agg.lastAt || 0) : 0;
		if (lb !== la) return lb - la;
		return String(a.sessionId).localeCompare(String(b.sessionId));
	});
	var maxCat = 1;
	byCategory.forEach(function (row) { if (row && (row.total || 0) > maxCat) maxCat = row.total; });
	var statusOrder = ["running", "queued", "solved", "stuck", "failed", "stopped"];
	var maxStatus = 1;
	statusOrder.forEach(function (k) { if ((byStatus[k] || 0) > maxStatus) maxStatus = byStatus[k]; });
	var platformTone = "is-muted";
	var platformLabel = "平台：未配置";
	if (platformStatus && platformStatus.configured !== false) {
		if (platformStatus.reachable) { platformTone = "is-ok"; platformLabel = "平台：已连接"; }
		else { platformTone = "is-danger"; platformLabel = "平台：连接错误"; }
	}
	function toggleGroup(sid) {
		var next = Object.assign({}, collapsed);
		if (next[sid]) delete next[sid]; else next[sid] = true;
		setCollapsed(next);
	}
	function confirmOr(key, fn) {
		if (confirm === key) { setConfirm(""); fn(); return; }
		setConfirm(key);
		window.setTimeout(function () { setConfirm(""); }, 3200);
	}
	function deleteChallenge(c, withFiles) {
		confirmOr("del:" + c.id, function () {
			request("challenge.remove", { id: c.id, deleteFiles: !!withFiles, sessionId: sessionId }).then(function (r) {
				if (r && r.ok) {
					say("已移除题目：" + c.title);
					if (expandedRef.current === c.id) toggleDetail(c.id);
					reload();
				} else say((r && r.error) || "移除失败", true);
			});
		});
	}
	function deleteSession(sid) {
		var key = "del-session:" + (sid || "__unassigned__");
		confirmOr(key, function () {
			request("session.remove", { sessionId: sid || "" }).then(function (r) {
				if (r && r.ok) { say("已移除该会话的 " + (r.removed || 0) + " 道题"); reload(); }
				else say((r && r.error) || "移除失败", true);
			});
		});
	}
	function loadWriteups() {
		request("writeup.list", { sessionId: sessionId }).then(function (r) { if (r && r.ok) setWriteups(r.writeups || []); });
	}
	function exportWriteup(c) {
		request("writeup.export", { id: c.id, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) {
				setWriteupPrev({ name: String(r.path || "").split(/[\\/]/).pop(), path: r.path, markdown: r.markdown, bytes: r.bytes });
				say("Writeup 已导出：" + (r.path || ""));
				loadWriteups();
				setTab("report");
			} else say((r && r.error) || "导出 Writeup 失败", true);
		});
	}
	function previewWriteup(name) {
		request("writeup.read", { name: name, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) setWriteupPrev({ name: r.name, markdown: r.markdown, bytes: r.bytes });
			else say((r && r.error) || "读取 Writeup 失败", true);
		});
	}
	function exportAllWriteups(list) {
		if (writeupAll || !list || list.length === 0) return;
		var queue = list.slice();
		var doneCount = 0;
		var failed = 0;
		var total = queue.length;
		setWriteupAll("0/" + total);
		function next() {
			var c = queue.shift();
			if (!c) {
				setWriteupAll("");
				say("批量导出完成：" + doneCount + " 份" + (failed ? "，失败 " + failed : ""));
				loadWriteups();
				return;
			}
			request("writeup.export", { id: c.id, sessionId: sessionId }).then(function (r) {
				if (r && r.ok) doneCount += 1; else failed += 1;
				setWriteupAll((doneCount + failed) + "/" + total);
				next();
			});
		}
		next();
	}
	function saveRuntimeCfg(patch) {
		if (cfgBusy) return;
		setCfgBusy(true);
		request("config.set", { patch: patch }).then(function (r) {
			setCfgBusy(false);
			if (r && r.ok) {
				setRuntimeCfg(r.config || null);
				setCfgMsg("已保存" + ((r.diagnostics && r.diagnostics.length) ? "（" + r.diagnostics.join("；") + "）" : ""));
				setCfgDirty(false);
				say("运行时配置已更新");
				reload();
			} else {
				setCfgMsg((r && r.error) || "保存失败");
				say((r && r.error) || "保存失败", true);
			}
		});
	}
	function setCfgField(key, value) {
		var patch = {};
		patch[key] = value;
		setRuntimeCfg(Object.assign({}, runtimeCfg || {}, patch));
		setCfgDirty(true);
	}
	function saveCfgForm() {
		var c = runtimeCfg || {};
		saveRuntimeCfg({
			concurrency: Number(c.concurrency), timeoutMs: Number(c.timeoutMs), maxAttempts: Number(c.maxAttempts),
			autoRetry: !!c.autoRetry, solverPreset: String(c.solverPreset || ""),
			solverModel: String(c.solverModel || ""), escalateModel: String(c.escalateModel || ""),
			wrapupRatio: Number(c.wrapupRatio), wrapupGraceMs: Number(c.wrapupGraceMs),
			minEvidenceChars: Number(c.minEvidenceChars), flagPatterns: Array.isArray(c.flagPatterns) ? c.flagPatterns : [],
			reviewerEnabled: !!c.reviewerEnabled,
			autoDistill: c.autoDistill !== false,
			memoryTopK: Number(c.memoryTopK),
			memoryMinScore: Number(c.memoryMinScore),
			pricePerMToken: Number(c.pricePerMToken),
			knowledgeTopK: Number(c.knowledgeTopK),
			knowledgeMinScore: Number(c.knowledgeMinScore)
		});
	}
	function loadReports() {
		request("report.list", { sessionId: sessionId }).then(function (r) { if (r && r.ok) setReports(r.reports || []); });
	}
	function previewReport(name) {
		request("report.read", { name: name, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) setReportPrev({ name: r.name, markdown: r.markdown, bytes: r.bytes });
			else say((r && r.error) || "读取报告失败", true);
		});
	}
	function closePreview() { setReport(null); setReportPrev(null); setWriteupPrev(null); }
	function fileRow(name, mtime, bytes, onPreview) {
		return h("div", { key: name, className: "dsh-ctf-rrow" },
			h("b", { className: "dsh-ctf-rname", title: name }, name),
			h("span", { className: "dsh-ctf-mini-meta" }, fmtTime(mtime)),
			h("span", { className: "dsh-ctf-mini-meta" }, fmtBytes(bytes || 0)),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: onPreview }, "预览"));
	}
	function previewCards() {
		var items = [];
		var rp = reportPrev || report;
		if (rp) items.push({ key: "report", title: "复盘报告预览", path: rp.path || rp.name || "", bytes: rp.bytes || 0, markdown: rp.markdown || "" });
		if (writeupPrev) items.push({ key: "writeup", title: "Writeup 预览", path: writeupPrev.path || writeupPrev.name || "", bytes: writeupPrev.bytes || 0, markdown: writeupPrev.markdown || "" });
		if (items.length === 0) return null;
		return h("div", { className: "dsh-ctf-previewcard" }, items.map(function (it) {
			return h("div", { key: it.key, className: "dsh-ctf-preview" },
				h("div", { className: "dsh-ctf-previewhead" },
					h("b", null, it.title),
					h("code", { className: "dsh-ctf-path", title: it.path }, it.path),
					h("span", { className: "dsh-ctf-mini-meta" }, fmtBytes(it.bytes)),
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: closePreview }, "关闭")),
				h("pre", { className: "dsh-ctf-reportpre" }, it.markdown));
		}));
	}
	function closePreview() {
			setReport(null);
			setReportPrev(null);
			setWriteupPrev(null);
		}
		function fileRow(name, mtime, bytes, onPreview) {
			return h("div", { key: name, className: "dsh-ctf-rrow" },
				h("b", { className: "dsh-ctf-rname", title: name }, name),
				h("span", { className: "dsh-ctf-mini-meta" }, fmtTime(mtime)),
				h("span", { className: "dsh-ctf-mini-meta" }, fmtBytes(bytes || 0)),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: onPreview }, "预览"));
		}
		function previewCards() {
			var items = [];
			var rp = reportPrev || report;
			if (rp) items.push({ key: "report", title: "复盘报告预览", path: rp.path || rp.name || "", bytes: rp.bytes || 0, markdown: rp.markdown || "" });
			if (writeupPrev) items.push({ key: "writeup", title: "Writeup 预览", path: writeupPrev.path || writeupPrev.name || "", bytes: writeupPrev.bytes || 0, markdown: writeupPrev.markdown || "" });
			if (items.length === 0) return null;
			return h("div", { className: "dsh-ctf-previewcard" }, items.map(function (it) {
				return h("div", { key: it.key, className: "dsh-ctf-preview" },
					h("div", { className: "dsh-ctf-previewhead" },
						h("b", null, it.title),
						h("code", { className: "dsh-ctf-path", title: it.path }, it.path),
						h("span", { className: "dsh-ctf-mini-meta" }, fmtBytes(it.bytes)),
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: closePreview }, "关闭")),
					h("pre", { className: "dsh-ctf-reportpre" }, it.markdown));
			}));
		}
function copyText(text, label) {
		var value = String(text == null ? "" : text);
		if (!value) { say("没有可复制的内容", true); return; }
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(value).then(function () { say("已复制" + (label || "")); }, function () { say(value); });
				return;
			}
		} catch (e) { /* ignore */ }
		say(value);
	}
	function oneLineText(value, max) {
		var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
		return text.length > (max || 200) ? text.slice(0, max || 200) + "…" : text;
	}
	function fmtAgo(ms) {
		var n = Number(ms);
		if (!n) return "—";
		var diff = Date.now() - n;
		if (diff < 60000) return "刚刚";
		if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
		if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
		if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + " 天前";
		return fmtTime(n);
	}
	function catToneOf(category) {
		var key = String(category || "").toLowerCase();
		var map = {
			web: "c0", crypto: "c1", pwn: "c2", reverse: "c3", misc: "c4",
			forensics: "c5", mobile: "c6", cloud: "c7", ai: "c1", "ai-ml": "c1",
			osint: "c0", malware: "c2", ad: "c3", supply: "c4"
		};
		return map[key] || "c4";
	}
	function catGlyphOf(category) {
		var label = catLabel(category);
		return label && label !== "未分类" ? String(label).slice(0, 1) : "题";
	}
	function renderMarkdown(md) {
		var lines = String(md || "").split(/\r?\n/);
		var out = [];
		var code = [];
		var inCode = false;
		function flushCode() {
			if (code.length === 0) return;
			out.push(h("pre", { key: "code-" + out.length, className: "dsh-ctf-mdcode" }, code.join("\n")));
			code = [];
		}
		for (var i = 0; i < lines.length; i += 1) {
			var line = lines[i];
			var trimmed = line.trim();
			if (/^```/.test(trimmed)) { inCode = !inCode; if (!inCode) flushCode(); continue; }
			if (inCode) { code.push(line); continue; }
			if (!trimmed) { out.push(h("div", { key: "sp-" + i, className: "dsh-ctf-mdsp" })); continue; }
			var heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
			if (heading) { out.push(h("div", { key: "h-" + i, className: "dsh-ctf-mdh is-h" + heading[1].length }, heading[2])); continue; }
			if (/^[-*]\s+/.test(trimmed)) { out.push(h("div", { key: "li-" + i, className: "dsh-ctf-mdli" }, trimmed.replace(/^[-*]\s+/, ""))); continue; }
			if (/^>\s?/.test(trimmed)) { out.push(h("div", { key: "bq-" + i, className: "dsh-ctf-mdbq" }, trimmed.replace(/^>\s?/, ""))); continue; }
			out.push(h("div", { key: "p-" + i, className: "dsh-ctf-mdp" }, trimmed));
		}
		if (inCode) flushCode();
		return h("div", { className: "dsh-ctf-md" }, out);
	}
	function renderHistList(items, onPreview, emptyTitle, emptyHint) {
		if (!items || items.length === 0) {
			return h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, emptyTitle), h("div", null, emptyHint));
		}
		return h("div", { className: "dsh-ctf-histlist" }, items.map(function (it) {
			return h("div", { key: it.name, className: "dsh-ctf-histcard" },
				h("span", { className: "dsh-ctf-histbadge" }, "MD"),
				h("div", { className: "dsh-ctf-histmain" },
					h("b", { className: "dsh-ctf-histname", title: it.name }, it.name),
					h("div", { className: "dsh-ctf-histmeta" },
						h("span", null, fmtBytes(it.bytes || 0)),
						h("span", { className: "dsh-ctf-dotsep" }),
						h("span", null, fmtAgo(it.mtime)))),
				h("div", { className: "dsh-ctf-histacts" },
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { onPreview(it.name); } }, "预览"),
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { copyText(it.path, "路径"); } }, "路径")));
		}));
	}
function hlKb(text, query) {
		var tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
		var value = String(text == null ? "" : text);
		if (tokens.length === 0) return [value];
		var lower = value.toLowerCase();
		var at = -1;
		var len = 0;
		for (var i = 0; i < tokens.length; i += 1) {
			var pos = lower.indexOf(tokens[i]);
			if (pos >= 0 && (at < 0 || pos < at)) { at = pos; len = tokens[i].length; }
		}
		if (at < 0) return [value];
		return [value.slice(0, at), h("mark", { key: "mark", className: "dsh-ctf-mark" }, value.slice(at, at + len)), value.slice(at + len)];
	}

	function kbMini(label, value, sub) {
		return h("div", { className: "dsh-ctf-minicard" },
			h("b", null, String(value)),
			h("span", null, label),
			sub ? h("i", null, sub) : null);
	}

	function renderSchedulePage() {
		var data = schedData || { queue: { running: [], queued: [], concurrency: 1 }, rate: { buckets: [], attempts30: 0, solved30: 0 }, recentSolved: [], config: {} };
		var queue = data.queue || { running: [], queued: [], concurrency: 1 };
		var rate = data.rate || { buckets: [], attempts30: 0, solved30: 0 };
		var cfg = data.config || {};
		var running = queue.running || [];
		var queued = queue.queued || [];
		var maxBar = Math.max(1, ...(rate.buckets || []).map(function (b) { return Math.max(b.attempts || 0, b.solved || 0); }));
		var hero = h("div", { className: "dsh-ctf-hero" },
			h("div", { className: "dsh-ctf-hero-main" },
				h("div", { className: "dsh-ctf-hero-title" }, "调度台"),
				h("div", { className: "dsh-ctf-hero-sub" }, "比赛级队列：并发占用、运行中/排队中题目、最近 30 分钟节奏与最近完成（耗时/费用）。"),
				h("div", { className: "dsh-ctf-hero-tags" },
					h("span", { className: "dsh-ctf-pill is-ok" }, "并发 " + running.length + "/" + (queue.concurrency || cfg.concurrency || 1)),
					h("span", { className: "dsh-ctf-chip" }, "排队 " + queued.length),
					h("span", { className: "dsh-ctf-chip" }, "自动重试 " + (cfg.autoRetry === false ? "关" : "开")),
					h("span", { className: "dsh-ctf-chip" }, "超时 " + Math.round((cfg.timeoutMs || 0) / 60000) + "min"))),
			h("div", { className: "dsh-ctf-head-actions" }, h("button", { type: "button", className: "dsh-ctf-btn", onClick: loadSchedule }, "刷新")));
		var runningPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "运行中", count: running.length }),
			running.length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "没有运行中的题"), h("div", null, "在题板点「开始」加入调度队列。"))
				: h("div", { className: "dsh-ctf-histlist" }, running.map(function (row) {
					var pct = row.timeoutMs ? Math.min(100, Math.round((row.elapsedMs || 0) / row.timeoutMs * 100)) : 0;
					return h("div", { key: row.id, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, "#" + (row.attemptN || 0)),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: row.title }, row.title),
							h("div", { className: "dsh-ctf-histmeta" },
								row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null,
								row.angle ? h("span", { className: "dsh-ctf-chip" }, "角度 " + row.angle) : null,
								row.role ? h("span", { className: "dsh-ctf-chip" }, "角色 " + row.role) : null,
								row.skill ? h("span", { className: "dsh-ctf-chip" }, "技能 " + row.skill) : null,
								row.phase === "wrapup" ? h("span", { className: "dsh-ctf-pill is-warn" }, "结算中") : null,
								h("span", null, fmtDur(row.elapsedMs || 0) + " / " + fmtDur(row.timeoutMs || 0))),
							h("div", { className: "dsh-ctf-progress" }, h("i", { style: { width: pct + "%" } }))),
						h("div", { className: "dsh-ctf-histacts" },
							h("button", { type: "button", className: "dsh-ctf-btn is-sm is-danger", onClick: function () { stopChallenge(row); } }, "停止")));
				})));
		var queuedPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "排队中", count: queued.length }),
			queued.length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "队列为空"))
				: h("div", { className: "dsh-ctf-histlist" }, queued.map(function (row) {
					return h("div", { key: row.id, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, "#" + (row.position || "?")),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: row.title }, row.title),
							h("div", { className: "dsh-ctf-histmeta" }, row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null)),
						h("div", { className: "dsh-ctf-histacts" },
							h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { stopChallenge(row); } }, "取消")));
				})));
		var ratePanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "最近 30 分钟节奏", count: rate.attempts30 || 0 }),
			h("div", { className: "dsh-ctf-spark" }, (rate.buckets || []).map(function (bucket, i) {
				var hA = Math.round(((bucket.attempts || 0) / maxBar) * 42);
				var hS = Math.round(((bucket.solved || 0) / maxBar) * 42);
				return h("div", { key: "b" + i, className: "dsh-ctf-sparkcol", title: ((bucket.attempts || 0) + " 尝试 / " + (bucket.solved || 0) + " 完成") },
					h("i", { className: "is-attempt", style: { height: hA + "px" } }),
					h("i", { className: "is-solved", style: { height: hS + "px" } }),
					h("span", null, fmtClock(bucket.from)));
			})),
			h("div", { className: "dsh-ctf-muted" }, "蓝=尝试开始，绿=完成；30min 尝试 " + (rate.attempts30 || 0) + " 次，完成 " + (rate.solved30 || 0) + " 题。"));
		var recentPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "最近完成", count: (data.recentSolved || []).length }),
			(data.recentSolved || []).length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "还没有完成记录"))
				: h("div", { className: "dsh-ctf-histlist" }, (data.recentSolved || []).map(function (row) {
					return h("div", { key: row.id, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, "OK"),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: row.title }, row.title),
							h("div", { className: "dsh-ctf-histmeta" },
								row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null,
								h("span", null, "耗时 " + fmtDur(row.durationMs || 0)),
								h("span", { className: "dsh-ctf-dotsep" }),
								h("span", null, "¥" + Number(row.estCost || 0).toFixed(3)))));
				})));
		return h("div", { className: "dsh-ctf-page" }, hero,
			h("div", { className: "dsh-ctf-kpis" },
				h("div", { className: "dsh-ctf-kpi is-ok" }, h("b", null, running.length + "/" + (queue.concurrency || cfg.concurrency || 1)), h("span", null, "并发占用")),
				h("div", { className: "dsh-ctf-kpi" }, h("b", null, String(queued.length)), h("span", null, "排队中")),
				h("div", { className: "dsh-ctf-kpi" }, h("b", null, String(rate.attempts30 || 0)), h("span", null, "30min 尝试")),
				h("div", { className: "dsh-ctf-kpi is-ok" }, h("b", null, String(rate.solved30 || 0)), h("span", null, "30min 完成"))),
			runningPanel, queuedPanel,
			h("div", { className: "dsh-ctf-grid2" }, ratePanel, recentPanel));
	}

	function renderKbResult(row) {
		var isWriteup = row.source === "writeup";
		var isImported = row.source === "imported";
		return h("div", { key: row.id, className: "dsh-ctf-kbresult is-" + (row.source || "notes"), onClick: function () { previewSearchResult(row); } },
			h("span", { className: "dsh-ctf-kbsrc is-" + (row.source || "notes") }, isWriteup ? "WP" : isImported ? "IM" : "NT"),
			h("div", { className: "dsh-ctf-kbmain" },
				h("div", { className: "dsh-ctf-kbtop" },
					h("b", { className: "dsh-ctf-kbtitle", title: row.title }, row.title),
					h("span", { className: "dsh-ctf-scorepill" }, "score " + row.score)),
				h("div", { className: "dsh-ctf-kbmeta" },
					h("span", { className: "dsh-ctf-kbtag" }, row.sourceLabel),
					row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null,
					row.path ? h("span", { className: "dsh-ctf-kbpath", title: row.path }, String(row.path).split(/[\\/]/).slice(-3).join("/")) : null,
					(function () {
						var used = kbStats && kbStats.usage && kbStats.usage.entries && kbStats.usage.entries[row.id];
						return used && used.used ? h("span", { className: "dsh-ctf-kbtag" }, "复用 " + used.used + "/" + (used.usedOk || 0)) : null;
					})()),
				h("div", { className: "dsh-ctf-kbsnippet" }, hlKb(row.snippet, kbQuery)),
				h("div", { className: "dsh-ctf-kbacts" },
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); previewSearchResult(row); } }, "预览"),
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); copyText(row.path || row.title, "路径"); } }, "复制路径"))),
			h("div", { className: "dsh-ctf-kbbar" }, h("i", { style: { width: Math.min(100, Math.round((row.score || 0) * 100)) + "%" } })));
	}

	function renderKnowledgePage() {
		var counts = (kbStats && kbStats.stats) || { total: 0, imported: 0, writeups: 0, notes: 0 };
		var filtered = kbRows.filter(function (row) { return !kbSource || row.source === kbSource; });
		var totalBytes = (kbFiles || []).reduce(function (sum, file) { return sum + (Number(file.bytes) || 0); }, 0);
		var latest = (kbFiles && kbFiles[0]) ? fmtAgo(kbFiles[0].mtime) : "—";
		var sources = [
			{ key: "", label: "全部", count: kbRows.length },
			{ key: "imported", label: "导入", count: kbRows.filter(function (r) { return r.source === "imported"; }).length },
			{ key: "writeup", label: "Writeup", count: kbRows.filter(function (r) { return r.source === "writeup"; }).length },
			{ key: "notes", label: "笔记", count: kbRows.filter(function (r) { return r.source === "notes"; }).length }
		];
		var suggestions = ["zip-symlink", "SSTI", "RSA", "LSB 隐写", "ROP", "符号链接"];
		var quickPaths = [];
		if (kbStats && kbStats.dir) quickPaths.push({ label: "知识目录", value: kbStats.dir });
		if (kbStats && kbStats.writeupsDir) quickPaths.push({ label: "Writeup 目录", value: kbStats.writeupsDir });

		var hero = h("div", { className: "dsh-ctf-hero" },
			h("div", { className: "dsh-ctf-hero-main" },
				h("div", { className: "dsh-ctf-hero-title" }, "知识库"),
				h("div", { className: "dsh-ctf-hero-sub" }, "把本地题解/笔记/模块卡导入，与已导出 Writeup、各题 notes.md 一起建索引；支持关键词检索、来源筛选与 Markdown 预览。"),
				h("div", { className: "dsh-ctf-hero-tags" },
					h("span", { className: "dsh-ctf-pill is-ok" }, "索引 " + (counts.total || 0)),
					h("span", { className: "dsh-ctf-chip" }, "导入 " + (counts.imported || 0)),
					h("span", { className: "dsh-ctf-chip" }, "Writeup " + (counts.writeups || 0)),
					h("span", { className: "dsh-ctf-chip" }, "题板笔记 " + (counts.notes || 0)))),
			h("div", { className: "dsh-ctf-head-actions" },
				h("button", { type: "button", className: "dsh-ctf-btn", onClick: function () { loadKnowledge(); say("已刷新知识库"); } }, "刷新")));

		var importLog = kbImpLog ? h("div", { className: "dsh-ctf-impres" + ((kbImpLog.errors || []).length ? " is-warn" : "") },
			h("div", { className: "dsh-ctf-impres-head" },
				h("b", null, "最近一次导入：成功 " + (kbImpLog.imported || 0) + " 个" + ((kbImpLog.errors || []).length ? "，失败 " + kbImpLog.errors.length + " 个" : "")),
				h("button", { type: "button", className: "dsh-ctf-linkbtn", onClick: function () { setKbImpLog(null); } }, "关闭")),
			(kbImpLog.errors || []).length ? h("div", { className: "dsh-ctf-wulist" }, kbImpLog.errors.slice(0, 8).map(function (err, i) {
				return h("div", { key: "e" + i, className: "dsh-ctf-wufact" }, "✗ " + err.path + "：" + err.error);
			})) : null) : null;

		var quickPathChips = quickPaths.length === 0 ? null : h("div", { className: "dsh-ctf-quickpaths" },
			h("span", { className: "dsh-ctf-muted" }, "快速填入："),
			quickPaths.map(function (item) {
				return h("button", { key: item.label, type: "button", className: "dsh-ctf-chip is-clickable", title: item.value, onClick: function () { setKbImpText((kbImpText ? kbImpText + "\n" : "") + item.value); } }, item.label);
			}));

		var importCard = h("div", { className: "dsh-ctf-panel dsh-ctf-kbimport" },
			h(SecTitle, { title: "导入资料", count: counts.imported || 0 }),
			h("div", { className: "dsh-ctf-minigrid" },
				kbMini("已导入", counts.imported || 0, "个文件"),
				kbMini("占用空间", fmtBytes(totalBytes), "本地副本"),
				kbMini("最近导入", latest, "相对时间"),
				kbMini("复用次数", (kbStats && kbStats.usage ? (kbStats.usage.usedOk || 0) + "/" + (kbStats.usage.used || 0) : "0/0"), "成功/总召回")),
			h("div", {
				className: "dsh-ctf-drop" + (kbDropOver ? " is-over" : ""),
				onDragOver: function (e) { if (e && e.preventDefault) e.preventDefault(); setKbDropOver(true); },
				onDragLeave: function () { setKbDropOver(false); },
				onDrop: function (e) {
					if (e && e.preventDefault) e.preventDefault();
					setKbDropOver(false);
					var text = "";
					try { text = (e.dataTransfer && e.dataTransfer.getData("text")) || ""; } catch { text = ""; }
					if (text) { setKbImpText((kbImpText ? kbImpText + "\n" : "") + text.trim()); say("已填入拖入的路径"); }
				}
			},
				h("div", { className: "dsh-ctf-dropicon" }, "⇪"),
				h("b", null, kbDropOver ? "松手填入路径" : "把路径拖到这里，或粘贴到下方"),
				h("div", { className: "dsh-ctf-muted" }, "一行一个文件/目录；相对路径按当前工作区解析；导入是复制进 knowledge/，不动原文件")),
			h("textarea", {
				className: "dsh-ctf-in dsh-ctf-pathbox", rows: 4, value: kbImpText,
				placeholder: "C:\\Users\\me\\writeups\\baby-python-writeup.md\nD:\\ctf-notes\\crypto\nE:\\资料\\web\\技巧.md",
				onChange: function (e) { setKbImpText(e.target.value); }
			}),
			quickPathChips,
			h("div", { className: "dsh-ctf-toolbar" },
				h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: kbImpBusy, onClick: importKnowledge }, kbImpBusy ? "导入中…" : "开始导入"),
				h("button", { type: "button", className: "dsh-ctf-btn is-ghost", onClick: function () { setKbImpText(""); setKbImpLog(null); } }, "清空"),
				h("span", { className: "dsh-ctf-muted" }, "重复文件名自动加 -1/-2 后缀")),
			importLog,
			(counts.imported || 0) === 0
				? h("div", { className: "dsh-ctf-empty is-hero" },
					h("div", { className: "dsh-ctf-dropicon" }, "◇"),
					h("b", null, "还没有导入资料"),
					h("div", null, "导入的 md/txt 会和 Writeup、题板笔记一起参与检索；先放几份题解试试。"))
				: h("div", { className: "dsh-ctf-histlist" }, kbFiles.map(function (file) {
					return h("div", { key: file.name, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, "MD"),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: file.path }, file.name),
							h("div", { className: "dsh-ctf-histmeta" },
								h("span", null, fmtBytes(file.bytes || 0)),
								h("span", { className: "dsh-ctf-dotsep" }),
								h("span", null, fmtAgo(file.mtime)),
								(function () {
									var row = kbStats && kbStats.usage && kbStats.usage.entries && kbStats.usage.entries["imported:" + file.name];
									return row && row.used ? h("span", { className: "dsh-ctf-chip" }, "复用 " + row.used) : null;
								})())),
						h("div", { className: "dsh-ctf-histacts" },
							h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { previewKbFile(file); } }, "预览"),
							h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost is-danger", onClick: function () { confirmOr("kb-" + file.name, "确认删除？", function () { deleteKbFile(file.name); }); } }, "删除")));
				})));

		var resultBlock;
		if (kbRows.length === 0) {
			resultBlock = h("div", { className: "dsh-ctf-suggest" },
				h("div", { className: "dsh-ctf-suggest-title" }, "试试这些关键词"),
				h("div", { className: "dsh-ctf-suggest-chips" }, suggestions.map(function (term) {
					return h("button", { key: term, type: "button", className: "dsh-ctf-chip is-clickable", onClick: function () { setKbQuery(term); searchKb(term); } }, term);
				})),
				h("div", { className: "dsh-ctf-muted" }, "空格分词 = AND；结果按相关度排序，点条目可预览。"));
		} else if (filtered.length === 0) {
			resultBlock = h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "该来源下没有命中"), h("div", null, "切回「全部」或换个关键词。"));
		} else {
			resultBlock = h("div", { className: "dsh-ctf-kblist" },
				h("div", { className: "dsh-ctf-resultcount" }, "命中 " + filtered.length + " 条 · 按相关度排序"),
				filtered.map(renderKbResult));
		}

		var searchCard = h("div", { className: "dsh-ctf-panel dsh-ctf-kbsearch" },
			h(SecTitle, { title: "知识检索", count: filtered.length }),
			h("div", { className: "dsh-ctf-inputwrap" },
				h("span", { className: "dsh-ctf-inputicon" }, "⌕"),
				h("input", {
					className: "dsh-ctf-in dsh-ctf-search is-icon", placeholder: "搜技法 / 题型 / 工具 / flag 片段…（回车检索）",
					value: kbQuery,
					onChange: function (e) { setKbQuery(e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") searchKb(); }
				}),
				kbQuery ? h("button", { type: "button", className: "dsh-ctf-inputclear", title: "清空", onClick: function () { setKbQuery(""); setKbRows([]); } }, "×") : null,
				h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: kbBusy, onClick: searchKb }, kbBusy ? "检索中…" : "检索")),
			h("div", { className: "dsh-ctf-seg" }, sources.map(function (src) {
				return h("button", {
					key: src.key || "all", type: "button",
					className: "dsh-ctf-segbtn" + (kbSource === src.key ? " is-active" : ""),
					onClick: function () { setKbSource(src.key); }
				}, src.label, h("i", null, String(src.count)));
			})),
			resultBlock);

		var previewPanel = kbPreview ? h("div", { className: "dsh-ctf-panel dsh-ctf-preview" },
			h("div", { className: "dsh-ctf-prevhead" },
				h("span", { className: "dsh-ctf-histbadge" }, "MD"),
				h("b", null, kbPreview.name),
				h("span", { className: "dsh-ctf-mini-meta" }, fmtBytes(kbPreview.bytes || 0)),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { copyText(kbPreview.path || kbPreview.name, "路径"); } }, "复制路径"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { setKbPreview(null); } }, "关闭")),
			h("code", { className: "dsh-ctf-path" }, kbPreview.path || ""),
			renderMarkdown(kbPreview.markdown || "")) : null;

		return h("div", { className: "dsh-ctf-page" },
			hero,
			h("div", { className: "dsh-ctf-kbgrid" },
				h("div", { className: "dsh-ctf-sidecol" }, importCard),
				h("div", { className: "dsh-ctf-sidecol" }, searchCard, previewPanel)));
	}


	function previewKbFile(file) {
		request("kb.read", { name: file.name }).then(function (r) {
			if (r && r.ok) setKbPreview({ name: r.name, path: r.path, markdown: r.markdown, bytes: r.bytes });
			else say((r && r.error) || "读取失败", true);
		});
	}

	function previewSearchResult(row) {
		if (!row) return;
		var base = String(row.path || "").split(/[\\/]/).pop();
		if (row.source === "imported" && base) { previewKbFile({ name: base, path: row.path }); return; }
		if (row.source === "writeup" && base) {
			request("writeup.read", { name: base, sessionId: sessionId }).then(function (r) {
				if (r && r.ok) setKbPreview({ name: r.name, path: r.path, markdown: r.markdown, bytes: r.bytes });
				else say((r && r.error) || "读取 Writeup 失败", true);
			});
			return;
		}
		setKbPreview({ name: row.title, path: row.path, markdown: row.snippet, bytes: 0 });
	}

	function renderMemoryPage() {
		var mem = memData || { workspaces: [], facts: [], totals: {}, kinds: [] };
		var kinds = ["", "结论", "发现", "假设", "卡点", "计划", "复核", "记录"];
		var facts = (mem.facts || []).filter(function (f) { return !memKind || f.kind === memKind; });
		var totals = mem.totals || {};
		var hero = h("div", { className: "dsh-ctf-hero" },
			h("div", { className: "dsh-ctf-hero-main" },
				h("div", { className: "dsh-ctf-hero-title" }, "记忆（跨会话台账）"),
				h("div", { className: "dsh-ctf-hero-sub" }, "所有工作区的题板记忆：黑板事实按 结论/发现/假设/卡点/计划/复核 分层；换目录也能看到历史任务与线索。"),
				h("div", { className: "dsh-ctf-hero-tags" },
					h("span", { className: "dsh-ctf-pill is-ok" }, "工作区 " + (totals.workspaces || 0)),
					h("span", { className: "dsh-ctf-chip" }, "题目 " + (totals.challenges || 0)),
					h("span", { className: "dsh-ctf-chip" }, "已解 " + (totals.solved || 0)),
					h("span", { className: "dsh-ctf-chip" }, "事实 " + (totals.facts || 0)))),
			h("div", { className: "dsh-ctf-head-actions" },
				h("button", { type: "button", className: "dsh-ctf-btn", onClick: loadMemory }, "刷新")));
		var wsCards = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "工作区记忆", count: (mem.workspaces || []).length }),
			(mem.workspaces || []).length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "还没有工作区记录"))
				: h("div", { className: "dsh-ctf-histlist" }, (mem.workspaces || []).map(function (row) {
					return h("div", { key: row.workspace || "global", className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, "WS"),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: row.workspace || "（未归属工作区）" }, String(row.workspace || "（未归属工作区）").split(/[\\/]/).pop() || "（未归属）"),
							h("div", { className: "dsh-ctf-histmeta" },
								h("span", null, "题目 " + (row.total || 0) + " · 已解 " + (row.solved || 0) + " · 运行 " + (row.running || 0)),
								h("span", { className: "dsh-ctf-dotsep" }),
								h("span", null, fmtAgo(row.lastAt)))),
						h("div", { className: "dsh-ctf-histacts" },
							h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { copyText(row.workspace || "", "路径"); } }, "复制路径")));
				})));
		var cardsPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "打法卡（跨会话沉淀）", count: (memCards || []).length }),
			h("div", { className: "dsh-ctf-toolbar" },
				h("span", { className: "dsh-ctf-muted" }, "每解一题自动沉淀「技法/入口/步骤/命令/坑」；遇到相似题会在子代理提示词里自动召回（跨会话、跨工作区）。"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: distillAll }, "沉淀全部已解题")),
			(memCards || []).length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "还没有打法卡"), h("div", null, "解出题目后会自动沉淀，或点上方按钮立即沉淀。"))
				: h("div", { className: "dsh-ctf-histlist" }, (memCards || []).slice(0, 50).map(function (card) {
					var open = memExpand === card.id;
					var detail = open ? h("div", { className: "dsh-ctf-wubody" },
						card.entry ? h("div", { className: "dsh-ctf-wufact" }, "入口：" + card.entry) : null,
						(card.steps || []).length ? h("div", { className: "dsh-ctf-wulist" }, card.steps.map(function (step, i) { return h("div", { key: "s" + i, className: "dsh-ctf-wuattempt" }, "步骤 " + (i + 1) + "：" + step); })) : null,
						(card.commands || []).length ? h("div", { className: "dsh-ctf-wulist" }, card.commands.map(function (cmd, i) { return h("div", { key: "c" + i, className: "dsh-ctf-wufact" }, h("code", null, cmd)); })) : null,
						(card.pitfalls || []).length ? h("div", { className: "dsh-ctf-wulist" }, card.pitfalls.map(function (pit, i) { return h("div", { key: "p" + i, className: "dsh-ctf-wuattempt" }, "注意：" + pit); })) : null,
						card.summary ? h("div", { className: "dsh-ctf-wutext" }, card.summary) : null) : null;
					return h("div", { key: card.id, className: "dsh-ctf-wucard" + (open ? " is-open" : "") },
						h("div", { className: "dsh-ctf-wurow" },
							h("span", { className: "dsh-ctf-wuavatar tone-" + catToneOf(card.category) }, catGlyphOf(card.category)),
							h("div", { className: "dsh-ctf-wumain" },
								h("div", { className: "dsh-ctf-wutop" },
									h("b", { className: "dsh-ctf-wutitle", title: card.title }, card.title),
									card.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(card.category)) : null),
								h("div", { className: "dsh-ctf-wumeta" },
									(card.tech || []).slice(0, 6).map(function (tag) { return h("span", { key: tag, className: "dsh-ctf-chip" }, tag); }),
									h("span", { className: "dsh-ctf-wumetric" }, "复用 ", h("b", null, String(card.used || 0)), " / 成功 ", h("b", null, String(card.usedOk || 0))))),
							h("div", { className: "dsh-ctf-wuacts" },
								h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { setMemExpand(open ? "" : card.id); } }, open ? "收起" : "展开"))),
						detail);
				})));
		var kindBar = h("div", { className: "dsh-ctf-toolbar" },
			kinds.map(function (kind) {
				var label = kind || "全部";
				var count = kind ? (mem.facts || []).filter(function (f) { return f.kind === kind; }).length : (mem.facts || []).length;
				return h("button", {
					key: label, type: "button",
					className: "dsh-ctf-btn is-sm" + (memKind === kind ? " is-primary" : " is-ghost"),
					onClick: function () { setMemKind(kind); }
				}, label + " " + count);
			}));
		var factsPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "黑板事实", count: facts.length }),
			kindBar,
			facts.length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "没有匹配的事实"))
				: h("div", { className: "dsh-ctf-histlist" }, facts.slice(0, 120).map(function (fact, idx) {
					return h("div", { key: "fact-" + idx, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, fact.kind || "记录"),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: fact.title }, fact.title),
							h("div", { className: "dsh-ctf-histmeta" },
								fact.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(fact.category)) : null,
								h("span", null, fmtAgo(fact.at))),
							h("div", { className: "dsh-ctf-wuev is-open" }, fact.text)));
				})));
		return h("div", { className: "dsh-ctf-page" }, hero, wsCards, cardsPanel, factsPanel);
	}

	function renderReportPage() {
		var solvedList = (snap && snap.challenges ? snap.challenges : []).filter(function (c) { return c && c.verified; });
		var ledger = (snap && snap.aggregates && snap.aggregates.ledger) || [];
		var unverified = 0;
		var flagOf = {};
		ledger.forEach(function (row) {
			if (!row) return;
			if (!row.verified) unverified += 1;
			var key = String(row.challengeId || "");
			if (!flagOf[key] || row.verified) flagOf[key] = row;
		});
		function hasWriteup(c) {
			var prefix = String(c.slug || c.id) + "-writeup";
			return writeups.some(function (w) { return w && String(w.name).indexOf(prefix) === 0; });
		}
		var q = String(repQuery || "").trim().toLowerCase();
		var list = solvedList.filter(function (c) {
			if (repCat && catLabel(c.category) !== repCat) return false;
			if (repOnlyWu && !hasWriteup(c)) return false;
			if (!q) return true;
			var f = flagOf[c.id] || {};
			var hay = (String(c.title) + " " + String(c.category) + " " + String(c.slug) + " " + String(f.flag || "")).toLowerCase();
			return hay.indexOf(q) >= 0;
		});
		list = list.slice().sort(function (a, b) {
			if (repSort === "name") return String(a.title).localeCompare(String(b.title), "zh");
			if (repSort === "duration") return elapsedOf(b) - elapsedOf(a);
			return (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0);
		});
		var catSeen = {};
		var catOptions = [];
		((snap && snap.aggregates && snap.aggregates.byCategory) || []).forEach(function (row) {
			if (!row) return;
			var label = catLabel(row.category);
			if (catSeen[label]) return;
			catSeen[label] = true;
			catOptions.push(label);
		});
		solvedList.forEach(function (c) {
			var label = catLabel(c.category);
			if (catSeen[label]) return;
			catSeen[label] = true;
			catOptions.push(label);
		});
		var byCategory = (snap && snap.aggregates && snap.aggregates.byCategory) || [];
		var maxCat = 1;
		byCategory.forEach(function (row) { if (row && (row.total || 0) > maxCat) maxCat = row.total; });

		function renderSolvedCard(c) {
			var f = flagOf[c.id] || {};
			var open = repExpand === c.id;
			var det = detail && detail.id === c.id ? detail.data : null;
			var exported = hasWriteup(c);
			var evidence = String(f.evidence || "").trim();
			var evOpen = repEvOpen === c.id;
			var body = null;
			if (open) {
				var detailBlocks = [];
				if (!det) detailBlocks.push(h("div", { className: "dsh-ctf-muted" }, h("span", { className: "dsh-ctf-spin" }), " 加载题目详情…"));
				else {
					if (det.statement) detailBlocks.push(h("div", { className: "dsh-ctf-sec" }, h(SecTitle, { title: "题面", count: 0 }), h("div", { className: "dsh-ctf-wutext" }, oneLineText(det.statement, 700))));
					var attempts = Array.isArray(det.attempts) ? det.attempts : [];
					if (attempts.length) detailBlocks.push(h("div", { className: "dsh-ctf-sec" }, h(SecTitle, { title: "尝试", count: attempts.length }), h("div", { className: "dsh-ctf-wulist" }, attempts.map(function (a, idx) {
						return h("div", { key: "a-" + idx, className: "dsh-ctf-wuattempt" }, "第 " + (a.n == null ? "?" : a.n) + " 次 · " + (a.angle || "unknown") + " · " + (a.status || "") + (a.summary ? " — " + oneLineText(a.summary, 160) : ""));
					}))));
					var facts = Array.isArray(det.facts) ? det.facts.slice(-5) : [];
					if (facts.length) detailBlocks.push(h("div", { className: "dsh-ctf-sec" }, h(SecTitle, { title: "最近事实", count: facts.length }), h("div", { className: "dsh-ctf-wulist" }, facts.map(function (fact, idx) {
						return h("div", { key: "f-" + idx, className: "dsh-ctf-wufact" }, oneLineText(fact.text || "", 200));
					}))));
					detailBlocks.push(h("div", { className: "dsh-ctf-wudir" },
						h("code", null, String(det.dir || c.dir || "")),
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { copyText(det.dir || c.dir || "", "目录"); } }, "复制目录")));
				}
				body = h("div", { className: "dsh-ctf-wubody" }, detailBlocks);
			}
			var evBlock = evidence ? h("div", { className: "dsh-ctf-wuevwrap" },
				h("div", { className: "dsh-ctf-wuev" + (evOpen ? " is-open" : "") }, evidence),
				evidence.length > 110 ? h("button", {
					type: "button", className: "dsh-ctf-linkbtn",
					onClick: function () { setRepEvOpen(evOpen ? "" : c.id); }
				}, evOpen ? "收起证据" : "展开证据") : null) : null;
			return h("div", { key: "wu-" + c.id, className: "dsh-ctf-wucard" + (open ? " is-open" : "") + (exported ? " is-exported" : "") },
				h("div", { className: "dsh-ctf-wurow" },
					h("span", { className: "dsh-ctf-wuavatar tone-" + catToneOf(c.category) }, catGlyphOf(c.category)),
					h("div", { className: "dsh-ctf-wumain" },
						h("div", { className: "dsh-ctf-wutop" },
							h("b", { className: "dsh-ctf-wutitle", title: c.title }, c.title),
							exported ? h("span", { className: "dsh-ctf-pill is-ok" }, "已导出") : null),
						h("div", { className: "dsh-ctf-wumeta" },
							c.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(c.category)) : null,
							h("span", { className: "dsh-ctf-wumetric" }, "耗时 ", h("b", null, fmtDur(elapsedOf(c)))),
							h("span", { className: "dsh-ctf-wumetric" }, "尝试 ", h("b", null, String(c.attempts || 0))),
							h("span", { className: "dsh-ctf-wumetric" }, "完成 ", fmtAgo(c.endedAt || c.startedAt || c.createdAt)))),
					h("div", { className: "dsh-ctf-wuacts" },
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { copyText(f.flag || "", " flag"); } }, "复制 flag"),
						h("button", { type: "button", className: "dsh-ctf-btn is-sm" + (exported ? " is-ghost" : " is-primary"), onClick: function () { exportWriteup(c); } }, exported ? "重新导出" : "导出 Writeup"),
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { setRepExpand(open ? "" : c.id); if (!open) loadDetail(c.id); } }, open ? "收起" : "详情"))),
				h("div", { className: "dsh-ctf-wuflag" },
					h("span", { className: "dsh-ctf-wuflagtag" }, "FLAG"),
					h("code", null, f.flag || "（未记录）"),
					h("button", { type: "button", className: "dsh-ctf-iconbtn", title: "复制 flag", onClick: function () { copyText(f.flag || "", " flag"); } }, "⧉"),
					f.verified ? h("span", { className: "dsh-ctf-pill is-ok" }, "已验证") : h("span", { className: "dsh-ctf-pill is-warn" }, "未验证"),
					f.method ? h("span", { className: "dsh-ctf-chip" }, METHOD_LABEL[f.method] || f.method) : null),
				evBlock,
				body);
		}

		var leftPanel = h("div", { className: "dsh-ctf-panel dsh-ctf-wulistwrap" },
			h("div", { className: "dsh-ctf-panelhead" },
				h(SecTitle, { title: "已解清单", count: list.length }),
				h("span", { className: "dsh-ctf-muted" }, solvedList.length + " 已解 · " + writeups.length + " 已导出")),
			list.length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" },
					h("b", null, solvedList.length === 0 ? "还没有已解题目" : "没有匹配的题目"),
					h("div", null, solvedList.length === 0 ? "解出后可在题板卡片、详情或这里导出 Writeup。" : "换个关键词或清空筛选。"))
				: h("div", { className: "dsh-ctf-wucards" }, list.map(renderSolvedCard)));

		var previewList = [];
		var rp = reportPrev || report;
		if (rp) previewList.push({ key: "report", title: "复盘报告", path: rp.path || rp.name || "", bytes: rp.bytes || 0, markdown: rp.markdown || "" });
		if (writeupPrev) previewList.push({ key: "writeup", title: "Writeup", path: writeupPrev.path || writeupPrev.name || "", bytes: writeupPrev.bytes || 0, markdown: writeupPrev.markdown || "" });
		var previewPanel = previewList.length === 0 ? null : h("div", { className: "dsh-ctf-panel dsh-ctf-preview" },
			previewList.map(function (it) {
				return h("div", { key: it.key, className: "dsh-ctf-prevblock" },
					h("div", { className: "dsh-ctf-prevhead" },
						h("span", { className: "dsh-ctf-histbadge" }, "MD"),
						h("b", null, it.title),
						h("span", { className: "dsh-ctf-mini-meta" }, fmtBytes(it.bytes)),
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { copyText(it.path, "路径"); } }, "复制路径"),
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: closePreview }, "关闭")),
					h("code", { className: "dsh-ctf-path" }, it.path),
					renderMarkdown(it.markdown));
			}));

		var sideCol = h("div", { className: "dsh-ctf-sidecol" },
			previewPanel,
			h("div", { className: "dsh-ctf-panel" },
				h("div", { className: "dsh-ctf-panelhead" }, h(SecTitle, { title: "Writeup 历史", count: writeups.length })),
				renderHistList(writeups, function (name) { previewWriteup(name); }, "还没有导出过 Writeup", "导出后会出现在这里，可随时预览。")),
			h("div", { className: "dsh-ctf-panel" },
				h("div", { className: "dsh-ctf-panelhead" }, h(SecTitle, { title: "复盘报告历史", count: reports.length })),
				renderHistList(reports, function (name) { previewReport(name); }, "还没有复盘报告", "点「导出复盘」生成整板复盘。")));

		var timing = (snap && snap.aggregates && snap.aggregates.timing) || { avgMs: 0, attempts: 0 };
		var usage = (snap && snap.aggregates && snap.aggregates.usage) || { estCost: 0, estTokens: 0 };
		var kpis = h("div", { className: "dsh-ctf-kpis" },
			h("div", { className: "dsh-ctf-kpi is-ok" }, h("b", null, String(solvedList.length)), h("span", null, "已解题")),
			h("div", { className: "dsh-ctf-kpi" }, h("b", null, String(writeups.length)), h("span", null, "Writeup 文件")),
			h("div", { className: "dsh-ctf-kpi" }, h("b", null, String(reports.length)), h("span", null, "复盘报告")),
			h("div", { className: "dsh-ctf-kpi is-warn" }, h("b", null, String(unverified)), h("span", null, "未验证 flag")),
			h("div", { className: "dsh-ctf-kpi" }, h("b", null, fmtDur(timing.avgMs)), h("span", null, "平均尝试耗时（" + (timing.attempts || 0) + " 次）")),
			h("div", { className: "dsh-ctf-kpi" }, h("b", null, "¥" + Number(usage.estCost || 0).toFixed(2)), h("span", null, "累计费用估算（" + Math.round((usage.estTokens || 0) / 1000) + "K tokens）")));

		var cover = byCategory.length === 0 ? null : h("div", { className: "dsh-ctf-panel dsh-ctf-cover" },
			h(SecTitle, { title: "模块覆盖", count: byCategory.length }),
			h("div", { className: "dsh-ctf-bars" }, byCategory.map(function (row, idx) {
				return h(CategoryBar, { key: String(row.category || "cat-" + idx), category: row.category, value: row.total, solved: row.solved, max: maxCat });
			})));

		var kbPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "私有知识检索", count: kbRows.length }),
			h("div", { className: "dsh-ctf-toolbar" },
				h("input", {
					className: "dsh-ctf-in dsh-ctf-search",
					placeholder: "搜 Writeup / 笔记里的技法、题型、工具…（回车检索）",
					value: kbQuery,
					onChange: function (e) { setKbQuery(e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") searchKb(); }
				}),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: kbBusy, onClick: searchKb }, kbBusy ? "检索中…" : "检索")),
			kbRows.length === 0
				? h("div", { className: "dsh-ctf-muted", style: { marginTop: "6px" } }, "知识库 = 已导出 Writeup + 各题 notes.md；检索词支持空格 AND。")
				: h("div", { className: "dsh-ctf-histlist" }, kbRows.map(function (row) {
					return h("div", { key: row.id, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, row.source === "writeup" ? "WP" : "NT"),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: row.title }, row.title),
							h("div", { className: "dsh-ctf-histmeta" },
								h("span", null, row.sourceLabel),
								row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null,
								h("span", { className: "dsh-ctf-dotsep" }),
								h("span", null, "score " + row.score)),
							h("div", { className: "dsh-ctf-wuev" }, row.snippet)));
				})));
		var toolbar = h("div", { className: "dsh-ctf-toolbar" },
			h("input", {
				className: "dsh-ctf-in dsh-ctf-search", placeholder: "搜索题名 / 模块 / flag…",
				value: repQuery, onChange: function (e) { setRepQuery(e.target.value); }
			}),
			h("select", {
				className: "dsh-ctf-in dsh-ctf-fselect", value: repCat, title: "模块筛选",
				onChange: function (e) { setRepCat(e.target.value); }
			}, h("option", { value: "" }, "全部模块"),
				catOptions.map(function (label) { return h("option", { key: label, value: label }, label); })),
			h("select", {
				className: "dsh-ctf-in dsh-ctf-fselect", value: repSort, title: "排序",
				onChange: function (e) { setRepSort(e.target.value); }
			},
				h("option", { value: "new" }, "排序：最新"),
				h("option", { value: "duration" }, "排序：耗时"),
				h("option", { value: "name" }, "排序：题名")),
			h("label", { className: "dsh-ctf-fopt" },
				h("input", { type: "checkbox", checked: repOnlyWu, onChange: function (e) { setRepOnlyWu(e.target.checked); } }),
				"仅看已导出"),
			h("span", { className: "dsh-ctf-fnote" }, "筛选 " + list.length + " / " + solvedList.length));

		var hero = h("div", { className: "dsh-ctf-hero" },
			h("div", { className: "dsh-ctf-hero-main" },
				h("div", { className: "dsh-ctf-hero-title" }, "复盘与 Writeup"),
				h("div", { className: "dsh-ctf-hero-sub" }, "把已解题沉淀成可交付 Writeup：flag 与证据、尝试过程、事实链、关键产物一键成文。"),
				h("div", { className: "dsh-ctf-hero-tags" },
					h("span", { className: "dsh-ctf-pill is-ok" }, "已验证 " + solvedList.length),
					unverified ? h("span", { className: "dsh-ctf-pill is-warn" }, "待验证 " + unverified) : null,
					h("span", { className: "dsh-ctf-chip" }, "Writeup " + writeups.length),
					h("span", { className: "dsh-ctf-chip" }, "报告 " + reports.length))),
			h("div", { className: "dsh-ctf-head-actions" },
				h("button", {
					type: "button", className: "dsh-ctf-btn",
					disabled: !!writeupAll || solvedList.length === 0,
					onClick: function () { exportAllWriteups(solvedList); }
				}, writeupAll ? "导出中 " + writeupAll : "批量导出 Writeup"),
				h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: reportBusy, onClick: exportReport }, reportBusy ? "导出中…" : "导出复盘"),
				h("button", { type: "button", className: "dsh-ctf-btn", onClick: function () { loadReports(); loadWriteups(); say("已刷新"); } }, "刷新")));

		return h("div", { className: "dsh-ctf-page" },
			hero,
			kpis,
			cover,
			toolbar,
			kbPanel,
			h("div", { className: "dsh-ctf-grid2 dsh-ctf-wugrid" }, leftPanel, sideCol));
	}

	function renderSetting(label, hint, control) {
			return h("label", { className: "dsh-ctf-setrow" },
				h("span", { className: "dsh-ctf-setlabel" }, label),
				control,
				hint ? h("span", { className: "dsh-ctf-sethint" }, hint) : null);
		}
		function numInput(key, value, scale, step, min, max) {
			return h("input", {
				className: "dsh-ctf-in", type: "number",
				step: step || 1, min: min, max: max,
				value: value,
				onChange: function (e) { setCfgField(key, Number(e.target.value) * (scale || 1)); }
			});
		}
		function textInput(key, value, placeholder) {
			return h("input", {
				className: "dsh-ctf-in", value: value || "", placeholder: placeholder || "",
				onChange: function (e) { setCfgField(key, e.target.value); }
			});
		}
		function renderSettingsPage() {
			var c = runtimeCfg;
			var form;
			if (!c) {
				form = h("div", { className: "dsh-ctf-muted" }, h("span", { className: "dsh-ctf-spin" }), " 读取运行时配置…");
			} else {
				var autoRetrySwitch = h("label", { className: "dsh-ctf-switch" },
					h("input", {
						type: "checkbox", checked: !!c.autoRetry,
						onChange: function (e) { setCfgField("autoRetry", e.target.checked); }
					}),
					h("span", null, c.autoRetry ? "已开启" : "已关闭"));
				var card1 = h("div", { className: "dsh-ctf-setcard" },
					h(SecTitle, { title: "编排", count: 0 }),
					h("div", { className: "dsh-ctf-setgrid" },
						renderSetting("并发上限", "同时运行的解题子代理数（1-8）", numInput("concurrency", c.concurrency, 1, 1, 1, 8)),
						renderSetting("单次预算（分钟）", "每次尝试的时间上限", numInput("timeoutMs", Math.round((c.timeoutMs || 0) / 60000), 60000, 1, 1, 240)),
						renderSetting("最多尝试次数", "单题上限（含首次）", numInput("maxAttempts", c.maxAttempts, 1, 1, 1, 10)),
						renderSetting("自动重试", "失败/卡住后换角度重试", autoRetrySwitch)));
				var card2 = h("div", { className: "dsh-ctf-setcard" },
					h(SecTitle, { title: "预算结算", count: 0 }),
					h("div", { className: "dsh-ctf-setgrid" },
						renderSetting("触发比例", "到预算该比例时注入收尾指令（0.5-0.95）", numInput("wrapupRatio", c.wrapupRatio, 1, 0.05, 0.5, 0.95)),
						renderSetting("宽限（秒）", "收尾指令后额外给的时间", numInput("wrapupGraceMs", Math.round((c.wrapupGraceMs || 0) / 1000), 1000, 1, 0, 600)),
					renderSetting("Token 单价（¥/M）", "费用估算用；按你的 DeepSeek 账单填", numInput("pricePerMToken", c.pricePerMToken, 0.1, 2, 0, 1000))));
				var card3 = h("div", { className: "dsh-ctf-setcard" },
					h(SecTitle, { title: "模型", count: 0 }),
					h("div", { className: "dsh-ctf-setgrid" },
						renderSetting("子代理 preset", "默认 ctf-auto", textInput("solverPreset", c.solverPreset, "ctf-auto")),
						renderSetting("首轮模型", "留空 = 跟随默认路由", textInput("solverModel", c.solverModel, "（默认）")),
						renderSetting("重试升级模型", "第 2+ 次尝试使用；留空 = 不升级", textInput("escalateModel", c.escalateModel, "（不升级）"))));
				var flagPatternsText = Array.isArray(c.flagPatterns) ? c.flagPatterns.join("\n") : "";
			var card4 = h("div", { className: "dsh-ctf-setcard" },
				h(SecTitle, { title: "质量门槛", count: 0 }),
				h("div", { className: "dsh-ctf-setgrid" },
					renderSetting("最短 evidence 字符", "verified 门槛：证据太短会被降级为待验证", numInput("minEvidenceChars", c.minEvidenceChars, 1, 1, 0, 200)),
					renderSetting("自动沉淀打法卡", "已解题自动沉淀到 memory.json，供相似题召回（默认开）", h("input", {
						type: "checkbox", checked: c.autoDistill !== false,
						onChange: function (e) { setCfgField("autoDistill", e.target.checked); }
					})),
					renderSetting("记忆召回条数", "每次尝试注入的相似打法卡数量（1-10）", numInput("memoryTopK", c.memoryTopK, 1, 3, 1, 10)),
					renderSetting("知识召回条数", "每次尝试注入的知识片段数量（1-10）", numInput("knowledgeTopK", c.knowledgeTopK, 1, 3, 1, 10)),
					renderSetting("自动复核已解题", "每道验证通过后自动派独立 reviewer 复核（消耗子代理额度，默认关）", h("input", {
						type: "checkbox", checked: !!c.reviewerEnabled,
						onChange: function (e) { setCfgField("reviewerEnabled", e.target.checked); }
					})),
					renderSetting("flag 格式（每行一个正则）", "留空=默认 [A-Za-z0-9_]{2,40}{...}；平台回显豁免", h("textarea", {
						className: "dsh-ctf-in", rows: 3, value: flagPatternsText,
						placeholder: "^[A-Za-z0-9_]{2,40}\\{[^}\\n]{1,200}\\}$",
						onChange: function (e) { setCfgField("flagPatterns", e.target.value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean)); }
					}))));
			form = h("div", { className: "dsh-ctf-setstack" }, card1, card2, card3, card4);
			}
			var diagItems = doctor ? [
				{ label: "子代理", ok: !!(doctor.subagents && doctor.subagents.available), value: (doctor.subagents && doctor.subagents.available) ? (doctor.subagents.providers || []).join(", ") : "不可用" },
				{ label: "模式入口", ok: !!(doctor.preset && doctor.preset.registered), value: doctor.preset ? (doctor.preset.registered ? doctor.preset.id + "（技能目录 " + (doctor.preset.skillDirs == null ? "?" : doctor.preset.skillDirs) + "）" : "未注册：" + (doctor.preset.error || "")) : "未知" },
				{ label: "平台", ok: !!(doctor.platform && doctor.platform.configured && doctor.platform.reachable), value: doctor.platform ? (doctor.platform.configured ? (doctor.platform.baseUrl + (doctor.platform.reachable ? " · 连通" : " · 不可达")) : "未配置（在「平台」页填写）") : "未知" },
				{ label: "活跃会话", ok: (doctor.sessions || []).length > 0, value: (doctor.sessions || []).length + " 个" },
				{ label: "题板根目录", ok: true, value: (doctor.config && doctor.config.rootDir) || "" },
				{ label: "WSL", ok: Array.isArray(doctor.wslDistros) && doctor.wslDistros.length > 0, value: (doctor.wslDistros || []).join(", ") || "未检测到" }
			] : [];
			var diag = doctor
				? h("div", { className: "dsh-ctf-diaglist" }, diagItems.map(function (it) {
					return h("div", { key: it.label, className: "dsh-ctf-diagrow" },
						h("span", { className: "dsh-ctf-pill " + (it.ok ? "is-ok" : "is-warn") }, it.ok ? "OK" : "注意"),
						h("b", null, it.label),
						h("span", { className: "dsh-ctf-diagval", title: it.value }, it.value));
				}))
				: h("div", { className: "dsh-ctf-muted" }, "读取诊断…");
			return h("div", { className: "dsh-ctf-page" },
				h("div", { className: "dsh-ctf-pagehead" },
					h("div", null,
						h("div", { className: "dsh-ctf-pagetitle" }, "设置"),
						h("div", { className: "dsh-ctf-pagesub" }, "运行时配置写入 " + ((c && c.rootDir) || "题板根目录") + "/config.json，保存后对后续尝试生效。")),
					h("div", { className: "dsh-ctf-head-actions" },
						cfgDirty ? h("span", { className: "dsh-ctf-pill is-warn" }, "有未保存改动") : null,
						h("button", {
							type: "button", className: "dsh-ctf-btn is-sm is-ghost",
							disabled: !cfgDefaults,
							onClick: function () { if (cfgDefaults) { setRuntimeCfg(Object.assign({}, cfgDefaults)); setCfgDirty(true); } }
						}, "恢复默认"),
						h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: cfgBusy, onClick: saveCfgForm }, cfgBusy ? "保存中…" : "保存配置"),
						cfgMsg ? h("span", { className: "dsh-ctf-muted" }, cfgMsg) : null)),
				form,
				h("div", { className: "dsh-ctf-setcard" },
					h(SecTitle, { title: "诊断", count: 0 }),
					diag),
				h("div", { className: "dsh-ctf-panel dsh-ctf-footer-note" },
					h("div", { className: "dsh-ctf-muted" }, "提示：并发提高后立即生效；预算与尝试次数对下一次尝试生效；模型字段留空表示沿用默认路由。")));
		}
	function loadKnowledge() {
		request("kb.list", {}).then(function (r) { if (r && r.ok) setKbFiles(r.files || []); });
		request("kb.stats", {}).then(function (r) { if (r && r.ok) setKbStats(r); });
	}
	function importKnowledge() {
		var text = String(kbImpText || "").trim();
		if (!text) { say("请输入文件/目录路径（一行一个）", true); return; }
		setKbImpBusy(true);
		request("kb.import", { files: text.split(/[\r\n,;]+/).map(function (x) { return x.trim(); }).filter(Boolean), sessionId: sessionId }).then(function (r) {
			setKbImpBusy(false);
			if (r && r.ok) {
				setKbImpText("");
				setKbImpLog({ imported: (r.imported || []).length, errors: r.errors || [] });
				loadKnowledge();
				var errs = (r.errors || []).length;
				say("已导入 " + (r.imported || []).length + " 个文件" + (errs ? "，失败 " + errs : ""));
				if (kbQuery) searchKb();
			} else say((r && r.error) || "导入失败", true);
		});
	}
	function deleteKbFile(name) {
		request("kb.delete", { name: name, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已删除 " + name); loadKnowledge(); if (kbQuery) searchKb(); }
			else say((r && r.error) || "删除失败", true);
		});
	}
	function loadSchedule() {
		request("schedule.summary", {}).then(function (r) { if (r && r.ok) setSchedData(r); });
	}
	function stopChallenge(c) {
		request("challenge.stop", { id: c.id, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已停止：" + (c.title || c.id)); loadSchedule(); reload(); }
			else say((r && r.error) || "停止失败", true);
		});
	}
	function loadMemory() {
		request("memory.summary", { sessionId: sessionId, limit: 120 }).then(function (r) { if (r && r.ok) setMemData(r); });
		request("memory.cards", {}).then(function (r) { if (r && r.ok) setMemCards(r.cards || []); });
	}
	function distillAll() {
		request("memory.distill", { all: true, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已沉淀 " + (r.distilled || 0) + " 张打法卡"); loadMemory(); }
			else say((r && r.error) || "沉淀失败", true);
		});
	}
	function searchKb(queryOverride) {
		const q = String(queryOverride || kbQuery || "").trim();
		if (!q) { say("请输入检索词", true); return; }
		setKbBusy(true);
		request("kb.search", { q, limit: 8, sessionId }).then(function (r) {
			setKbBusy(false);
			if (r && r.ok) { setKbRows(r.results || []); say("知识库命中 " + (r.results || []).length + " 条"); }
			else { setKbRows([]); say((r && r.error) || "知识检索失败", true); }
		});
	}
	function probeTargetOf(c) {
		request("target.probe", { id: c.id, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) {
				var st = r.targetStatus || {};
				say("目标探测：" + (st.ok ? "就绪" : st.state) + (st.latencyMs ? "（" + st.latencyMs + "ms）" : ""));
				reload();
				if (expandedRef.current === c.id) loadDetail(c.id);
			} else say((r && r.error) || "目标探测失败", true);
		});
	}
	function reviewChallenge(c) {
		request("flag.review", { id: c.id, sessionId }).then(function (r) {
			if (r && r.ok) {
				say("复核：" + String(r.status || "").toUpperCase());
				reload();
				if (expandedRef.current === c.id) loadDetail(c.id);
			} else say((r && r.error) || "复核失败", true);
		});
	}
	function packChallenge(c) {
		request("writeup.pack", { id: c.id, sessionId }).then(function (r) {
			if (r && r.ok) say("WP 已打包：" + (r.path || "") + "（" + fmtBytes(r.bytes || 0) + "）");
			else say((r && r.error) || "打包失败", true);
		});
	}
	function exportReport() {
		if (reportBusy) return;
		setReportBusy(true);
		request("report.export", { sessionId: sessionId }).then(function (r) {
			setReportBusy(false);
			if (r && r.ok) {
				setReport({ path: r.path || "", bytes: r.bytes || 0, markdown: r.markdown || "" });
				say("复盘已导出：" + (r.path || ""));
			} else say((r && r.error) || "导出复盘失败", true);
		});
	}
	function renderGroup(g) {
		var sid = g.sessionId;
		var unassigned = !sid;
		var agg = g.agg || {};
		var current = !!sessionId && sid === sessionId;
		var isCollapsed = !!collapsed[sid];
		var title = sessionTitleOf(sessionsSnap, sid) || (unassigned ? "未归属会话" : "会话 " + fmtShortId(sid));
		var counts = { total: g.challenges.length, solved: 0, running: 0, queued: 0, stuck: 0 };
		g.challenges.forEach(function (c) { if (c && counts[c.status] != null) counts[c.status] += 1; });
		return h("div", {
			key: "grp-" + (sid || "__unassigned__"),
			className: "dsh-ctf-group" + (current ? " is-current" : "") + (unassigned ? " is-unassigned" : "")
		},
			h("div", { className: "dsh-ctf-grouphead" },
				h("span", { className: "dsh-ctf-dot" + (agg.live ? " is-live" : "") }),
				h("b", { className: "dsh-ctf-grouptitle" }, title),
				unassigned ? h("span", { className: "dsh-ctf-chip" }, "未归属") : h("span", { className: "dsh-ctf-svid" }, fmtShortId(sid)),
				current ? h("span", { className: "dsh-ctf-chip is-mine" }, "当前会话") : null,
				agg.preset ? h("span", { className: "dsh-ctf-chip" }, String(agg.preset)) : null,
				agg.cwd ? h("span", { className: "dsh-ctf-svcwd", title: String(agg.cwd) }, "cwd " + String(agg.cwd)) : null,
				countChip("总", counts.total),
				counts.solved ? countChip("已解", counts.solved) : null,
				counts.running ? countChip("运行", counts.running) : null,
				counts.stuck ? countChip("卡住", counts.stuck) : null,
				h("button", {
					type: "button", className: "dsh-ctf-btn is-sm is-ghost is-danger" + (confirm === "del-session:" + (sid || "__unassigned__") ? " is-on" : ""),
					title: "移除该会话下的所有题目（工作目录保留）",
					onClick: function () { deleteSession(sid); }
				}, confirm === "del-session:" + (sid || "__unassigned__") ? "确认删除会话" : "删除会话"),
				h("button", {
					type: "button", className: "dsh-ctf-btn is-sm is-ghost",
					onClick: function () { toggleGroup(sid); }
				}, isCollapsed ? "展开" : "折叠")),
			isCollapsed ? null : h("div", { className: "dsh-ctf-groupbody" }, g.challenges.map(renderCard)));
	}
	function renderLedgerRow(row, idx) {
		var rowKey = String(row.challengeId || "") + "|" + String(row.flag || "") + "|" + idx;
		var unverified = !row.verified;
		var evShown = ledgerEv === rowKey;
		return h("div", { key: rowKey, className: "dsh-ctf-lrow" + (unverified ? " is-unverified" : "") },
			h("div", { className: "dsh-ctf-lmain" },
				h("b", { className: "dsh-ctf-ltitle" }, row.title || row.challengeId || "(未知题)"),
				row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null,
				h("span", { className: "dsh-ctf-tag " + (unverified ? "is-warn" : "is-ok") }, unverified ? "待验证" : "已验证"),
				row.method ? h("span", { className: "dsh-ctf-chip" }, METHOD_LABEL[row.method] || row.method) : null,
				row.attempt ? h("span", { className: "dsh-ctf-mini-meta" }, "尝试 #" + row.attempt) : null,
				h("span", { className: "dsh-ctf-mini-meta" }, fmtTime(row.at)),
				row.sessionId ? h("span", { className: "dsh-ctf-svid" }, fmtShortId(row.sessionId)) : null,
				row.evidence ? h("button", {
					type: "button", className: "dsh-ctf-btn is-sm is-ghost",
					onClick: function () { setLedgerEv(evShown ? "" : rowKey); }
				}, evShown ? "收起证据" : "证据") : null),
			h("div", { className: "dsh-ctf-lflag" }, row.flag || ""),
			evShown && row.evidence ? h("div", { className: "dsh-ctf-lev" }, String(row.evidence)) : null);
	}
	function renderLedgerBlock(forceOpen) {
		var open = forceOpen === true || ledgerOpen;
		var catPanel = byCategory.length === 0
			? h("div", { className: "dsh-ctf-muted" }, "还没有按模块统计（题板为空）。")
			: h("div", { className: "dsh-ctf-bars" }, byCategory.map(function (row, i) {
				return h(CategoryBar, {
					key: String(row.category || "cat-" + i),
					category: row.category, value: row.total, solved: row.solved, max: maxCat
				});
			}));
		var statusPanel = h("div", { className: "dsh-ctf-statusgrid" }, statusOrder.map(function (k) {
			return h(StatusRow, { key: k, status: k, value: byStatus[k] || 0, max: maxStatus });
		}));
		var ledgerPanel = ledger.length === 0
			? h("div", { className: "dsh-ctf-muted" }, "还没有登记 flag：子代理验证后经 ctf_flag_record 写入台账（未验证标黄）。")
			: h("div", { className: "dsh-ctf-ledger" }, ledger.map(renderLedgerRow));
		return h("div", { className: "dsh-ctf-panel dsh-ctf-ledgerwrap" },
			h("div", { className: "dsh-ctf-ledgerhead" },
				forceOpen ? null : h("button", {
					type: "button", className: "dsh-ctf-btn is-sm" + (open ? " is-on" : ""),
					onClick: function () { setLedgerOpen(!open); }
				}, open ? "收起台账" : "展开台账"),
				h("span", { className: "dsh-ctf-sec-title" }, "台账"),
				h("span", { className: "dsh-ctf-muted" },
					"flag " + ledger.length + " · 已解 " + stats.solved + " / " + stats.total + " · 模块 " + byCategory.length)),
			open ? h("div", { className: "dsh-ctf-ledgerbody" },
				h("div", { className: "dsh-ctf-totals" },
					h(TotalCard, { label: "总题数", value: stats.total }),
					h(TotalCard, { label: "已解", value: stats.solved, tone: "ok" }),
					h(TotalCard, { label: "运行中", value: stats.running, tone: "run" }),
					h(TotalCard, { label: "卡住", value: stats.stuck, tone: "warn" }),
					h(TotalCard, { label: "失败", value: stats.failed, tone: "danger" })),
				h("div", { className: "dsh-ctf-padsplit" },
					h("div", { className: "dsh-ctf-pad" },
						h(SecTitle, { title: "按模块分布", count: byCategory.length }),
						catPanel),
					h("div", { className: "dsh-ctf-pad" },
						h(SecTitle, { title: "按状态分布", count: statusOrder.length }),
						statusPanel)),
				h("div", { className: "dsh-ctf-pad" },
					h(SecTitle, { title: "Flag 台账", count: ledger.length }),
					ledgerPanel)) : null);
	}
	function renderTabs() {
		return TABS.map(function (t) {
			return h("button", {
				key: t.key, type: "button",
				className: "dsh-ctf-tab" + (tab === t.key ? " is-on" : ""),
				onClick: function () { setTab(t.key); }
			}, t.label);
		});
	}
	function renderFilters() {
		return h("div", { className: "dsh-ctf-panel dsh-ctf-filters" },
			h("div", { className: "dsh-ctf-frow" },
				STATUS_CHIPS.map(function (chip) {
					var count = chip.key === "all" ? allChallenges.length : (stats[chip.key] || 0);
					return h("button", {
						key: chip.key, type: "button",
						className: "dsh-ctf-fchip" + (statusFilter === chip.key ? " is-on" : ""),
						onClick: function () { setStatusFilter(chip.key); }
					}, chip.label, h("i", null, String(count)));
				})),
			h("div", { className: "dsh-ctf-frow" },
				h("input", {
					className: "dsh-ctf-in dsh-ctf-search", placeholder: "搜索标题 / slug / 目标 / ID…",
					value: query, onChange: function (e) { setQuery(e.target.value); }
				}),
				h("select", {
					className: "dsh-ctf-in dsh-ctf-fselect", value: catFilter, title: "模块筛选",
					onChange: function (e) { setCatFilter(e.target.value); }
				},
					h("option", { value: "" }, "全部模块"),
					catOptions.map(function (o) { return h("option", { key: o.category, value: o.category }, catLabel(o.category) + " (" + (o.total || 0) + ")"); })),
				h("select", {
					className: "dsh-ctf-in dsh-ctf-fselect", value: sortKey, title: "排序",
					onChange: function (e) { setSortKey(e.target.value); }
				},
					SORT_OPTIONS.map(function (o) { return h("option", { key: o.key, value: o.key }, "排序：" + o.label); })),
				h("div", { className: "dsh-ctf-seg" },
					h("button", {
						type: "button", className: "dsh-ctf-segbtn" + (groupMode === "session" ? " is-on" : ""),
						onClick: function () { setGroupMode("session"); }
					}, "按会话"),
					h("button", {
						type: "button", className: "dsh-ctf-segbtn" + (groupMode === "flat" ? " is-on" : ""),
						onClick: function () { setGroupMode("flat"); }
					}, "平铺")),
				sessionId ? h("label", { className: "dsh-ctf-fopt" },
					h("input", {
						type: "checkbox", checked: allScope,
						onChange: function (e) { setAllScope(e.target.checked); }
					}), "全部工作区") : null,
				sessionId ? h("label", { className: "dsh-ctf-fopt" },
					h("input", {
						type: "checkbox", checked: onlyMine,
						onChange: function (e) { setOnlyMine(e.target.checked); }
					}), "仅本会话") : null,
				filterActive ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: clearFilters }, "清空筛选") : null,
				h("span", { className: "dsh-ctf-fnote" }, filterNote),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: function () { reload(); say("已刷新"); } }, "刷新")));
	}
	var listBody;
	if (!snap && !err) {
		listBody = h("div", { className: "dsh-ctf-empty" },
			h("b", null, "正在连接题板…"),
			h("span", { className: "dsh-ctf-spin" }), " 等待宿主 Web 通道响应");
	} else if (challenges.length === 0) {
		if (filterActive) {
			listBody = h("div", { className: "dsh-ctf-empty" },
				h("b", null, "没有匹配的题目"),
				h("div", null, "当前筛选条件下没有题目；可清空筛选或换个关键词。"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: clearFilters }, "清空筛选"));
		} else if (isView && onlyMine) {
			listBody = h("div", { className: "dsh-ctf-empty" },
				h("b", null, "本会话暂无解题任务"),
				h("div", null, "关闭「仅本会话」可查看整个题板；右上角「＋ 新建题目」会以本会话为父代理派发解题子代理。"));
		} else {
			listBody = h("div", { className: "dsh-ctf-empty" },
				h("b", null, "题板还是空的"),
				h("div", null, "点右上角「＋ 新建题目」创建题目，或让模型调用 ctf_solve_start 建题。"),
				h("div", null, "题目创建后进入队列，由子代理按角度自主解题；所有尝试、事实、事件与 flag 证据都会显示在这里。"));
		}
	} else if (isView && groupMode === "session" && !allScope) {
		listBody = h("div", { className: "dsh-ctf-groups" }, groups.map(renderGroup));
	} else {
		listBody = challenges.map(renderCard);
	}

	var tabBody;
	if (tab === "platform") {
		tabBody = h(PlatformPanel, {
			status: platformStatus, say: say, onStatus: setPlatformStatus,
			sessionId: sessionId,
			onClose: function () { setTab("board"); }, onImported: function () { reload(); }
		});
	} else if (tab === "schedule") {
		tabBody = renderSchedulePage();
	} else if (tab === "ledger") {
		tabBody = renderLedgerBlock(true);
	} else if (tab === "report") {
		tabBody = renderReportPage();
	} else if (tab === "knowledge") {
		tabBody = renderKnowledgePage();
	} else if (tab === "memory") {
		tabBody = renderMemoryPage();
	} else if (tab === "settings") {
		tabBody = renderSettingsPage();
	} else {
		tabBody = h("div", { className: "dsh-ctf-page" },
			renderFilters(),
			formOpen ? renderForm() : null,
			h("div", { className: "dsh-ctf-list" }, listBody));
	}

	return h("div", { className: "dsh-ctf-root" + (isView ? " is-view" : "") },
		h("div", { className: "dsh-ctf-panel dsh-ctf-head" },
			h("div", { className: "dsh-ctf-head-main" },
				h("div", { className: "dsh-ctf-title" }, "CTF 自动解题")),
			h("div", { className: "dsh-ctf-head-actions" },
				isView ? h("button", {
					type: "button",
					className: "dsh-ctf-btn is-sm dsh-ctf-platformchip " + platformTone,
					onClick: function () { setTab("platform"); }
				}, platformLabel) : null,
				h("button", {
					type: "button", className: "dsh-ctf-btn",
					onClick: function () { setFormOpen(!formOpen); }
				}, formOpen ? "收起表单" : "＋ 新建题目"),
				isView ? h("button", {
					type: "button", className: "dsh-ctf-btn", disabled: reportBusy,
					onClick: exportReport
				}, reportBusy ? "导出中…" : "导出复盘") : null,
				h("button", {
					type: "button", className: "dsh-ctf-btn", disabled: !!busy,
					onClick: function () { reload(); say("已刷新"); }
				}, busy ? "刷新中…" : "刷新"))),
		h("div", { className: "dsh-ctf-tabbar" }, renderTabs()),
		renderBanners(err, warning, reload),


		tab === "board" ? h("div", { className: "dsh-ctf-panel dsh-ctf-statsbar" },
			h("div", { className: "dsh-ctf-stats" },
				h(Stat, { label: "总题数", value: stats.total }),
				h(Stat, { label: "排队", value: stats.queued, tone: "queued" }),
				h(Stat, { label: "运行中", value: stats.running, tone: "run" }),
				h(Stat, { label: "已解", value: stats.solved, tone: "ok" }),
				h(Stat, { label: "卡住", value: stats.stuck, tone: "warn" })),
			h("div", { className: "dsh-ctf-stats-note" },
				"失败 " + (stats.failed || 0) + " · 已停止 " + (stats.stopped || 0) + (updatedAt ? " · 更新于 " + fmtClock(updatedAt) : ""))) : null,
		tabBody,
		toast ? h("div", { className: "dsh-ctf-toast" + (toast.err ? " is-err" : "") }, toast.text) : null);
}

// 单入口：所有界面都在会话视图内做内部分页。
function sidOf(props) {
	return props && props.sessionId != null ? String(props.sessionId) : "";
}
function BoardViewPanel(props) {
	return h(Panel, { variant: "view", sessionId: sidOf(props) });
}

function apply(ctx) {
	ctx.effect(function () { return installStyles(); }, "dsh-ctf-auto: styles");

	ctx.slots.inject("conversation.view", function () {
		return ctx.slots.register({
			name: "conversation.view",
			id: "ctf-auto",
			order: 50,
			label: function () { return "CTF 自动解题"; }
		}, BoardViewPanel);
	});
}

module.exports = { name: "dsh-ctf-auto-client", inject: ["slots"], apply: apply };
return module.exports; } });
