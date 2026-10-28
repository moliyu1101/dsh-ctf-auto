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
	{ key: "board", label: "题板", icon: "board", desc: "管理题目、工作区与解题队列" },
	{ key: "platform", label: "平台", icon: "platform", desc: "CTFd / 通用 JSON 适配器与题目导入" },
	{ key: "schedule", label: "调度", icon: "schedule", desc: "并发、排队与最近 30 分钟节奏" },
	{ key: "ledger", label: "台账", icon: "ledger", desc: "flag、模块与状态分布" },
	{ key: "report", label: "复盘", icon: "report", desc: "Writeup 导出与经验沉淀" },
	{ key: "knowledge", label: "知识", icon: "knowledge", desc: "本地题解、笔记与模块卡检索" },
	{ key: "memory", label: "记忆", icon: "memory", desc: "跨会话打法、事实链与黑板书" },
	{ key: "settings", label: "设置", icon: "settings", desc: "运行时配置、预算与诊断" }
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
	if (c.status === "queued") return 0;
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
	"body{--dct-line:#2f6fe4;--dct-ink:#0d1b2e;--dct-ink-2:#1f3147;--dct-ink-3:#354a63;--dct-ink-4:#4c617b;--dct-ink-5:#657a93;--dct-ink-6:#8a99ab;--dct-accent:#2563eb;--dct-accent-2:#0ea5e9;--dct-on-accent:#ffffff;--dct-ok:#0f9f6e;--dct-ok-ink:#0b7a55;--dct-warn:#b45309;--dct-warn-ink:#92400e;--dct-danger:#dc2626;--dct-danger-ink:#b91c1c;--dct-queued:#6b7f97;--dct-run:#2563eb;--dct-muted:#8a97a8;--dct-panel:rgba(255,255,255,.9);--dct-card:rgba(255,255,255,.86);--dct-input:#ffffff;--dct-float:rgba(255,255,255,.98);--dct-root-bg:radial-gradient(1200px 520px at 78% -12%,color-mix(in srgb,var(--dct-accent) 9%,transparent),transparent 62%),linear-gradient(180deg,#f9fbff 0%,#eef4fb 100%);--dct-title-grad:linear-gradient(92deg,#1d4ed8,#0f172a 62%,#0284c7);--dct-glow:0 1px 2px rgba(15,35,70,.04),0 10px 30px -18px rgba(15,35,70,.18);--dct-shadow:0 18px 48px -12px rgba(15,35,70,.28);--dct-soft:color-mix(in srgb,var(--dct-line) 6%,transparent);--dct-soft-2:color-mix(in srgb,var(--dct-line) 14%,transparent);--dct-hover:color-mix(in srgb,var(--dct-line) 16%,transparent);--dct-border:#dbe6f3;--dct-border-strong:#c3d5e9;--dct-accent-soft:color-mix(in srgb,var(--dct-accent) 11%,transparent);--dct-radius:16px;--dct-radius-sm:10px;--dct-gap:12px;--dct-ring:0 0 0 3px color-mix(in srgb,var(--dct-accent) 16%,transparent);--dct-card-shadow:0 1px 1px rgba(15,35,70,.03),0 8px 24px -20px rgba(15,35,70,.24)}",
	"body[data-ds-dark-theme]{--dct-line:#4ea1ff;--dct-ink:#eaf4ff;--dct-ink-2:#d6e6f8;--dct-ink-3:#bdd2e8;--dct-ink-4:#a2bcd6;--dct-ink-5:#86a2c0;--dct-ink-6:#6f8caa;--dct-accent:#4a9bff;--dct-accent-2:#22d3ee;--dct-on-accent:#04101f;--dct-ok:#3ddc97;--dct-ok-ink:#7ff0bf;--dct-warn:#f5c542;--dct-warn-ink:#ffe9ad;--dct-danger:#ff7b7b;--dct-danger-ink:#ffc9c9;--dct-queued:#9db9d8;--dct-run:#5cb8ff;--dct-muted:#7d97b8;--dct-panel:rgba(9,24,44,.72);--dct-card:rgba(12,30,54,.8);--dct-input:rgba(8,22,42,.72);--dct-float:rgba(7,21,41,.98);--dct-root-bg:radial-gradient(1200px 520px at 78% -12%,rgba(38,105,185,.34),transparent 62%),linear-gradient(180deg,#07182d 0%,#050f1f 100%);--dct-title-grad:linear-gradient(92deg,#8fd3ff,#ffffff 58%,#67e8f9);--dct-glow:0 1px 0 rgba(255,255,255,.03),0 14px 34px -24px rgba(0,0,0,.75);--dct-shadow:0 20px 54px -14px rgba(0,0,0,.72);--dct-soft:color-mix(in srgb,var(--dct-line) 11%,transparent);--dct-soft-2:color-mix(in srgb,var(--dct-line) 19%,transparent);--dct-hover:rgba(74,155,255,.2);--dct-border:rgba(93,143,196,.24);--dct-border-strong:rgba(115,169,226,.38);--dct-accent-soft:color-mix(in srgb,var(--dct-accent) 16%,transparent);--dct-radius:16px;--dct-radius-sm:10px;--dct-gap:12px;--dct-ring:0 0 0 3px rgba(74,155,255,.24);--dct-card-shadow:0 1px 0 rgba(255,255,255,.02),0 12px 30px -24px rgba(0,0,0,.8)}",
	".dsh-ctf-root,.dsh-ctf-root *{box-sizing:border-box}",
	".dsh-ctf-root{display:flex;flex-direction:column;gap:14px;min-height:100%;padding:20px clamp(14px,2.4vw,30px) 48px;color:var(--dct-ink-2);background:var(--dct-root-bg);font-size:13px;line-height:1.55;font-family:var(--dsw-font-family,system-ui,-apple-system,'Segoe UI',sans-serif)}",
	".dsh-ctf-root.is-view{gap:12px;padding:14px clamp(12px,2vw,24px) 32px}",
	".dsh-ctf-root.is-view .dsh-ctf-title{font-size:18px;letter-spacing:.2px}",
	".dsh-ctf-panel{border:1px solid var(--dct-border);border-radius:var(--dct-radius);background:var(--dct-panel);box-shadow:var(--dct-glow);backdrop-filter:blur(12px)}",
	".dsh-ctf-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px 16px;padding:14px 18px}",
	".dsh-ctf-title{font-size:20px;font-weight:800;letter-spacing:.1px;line-height:1.25;background:var(--dct-title-grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}",
	".dsh-ctf-sub{font-size:11.5px;line-height:1.6;color:var(--dct-ink-5);margin-top:3px;max-width:780px}",
	".dsh-ctf-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
	".dsh-ctf-btn{border:1px solid var(--dct-border);border-radius:9px;padding:6px 14px;font-size:12.5px;line-height:1.5;color:var(--dct-ink-3);background:var(--dct-soft);cursor:pointer;transition:background .16s,border-color .16s,color .16s,box-shadow .16s,opacity .16s;white-space:nowrap;font-family:inherit;font-weight:500}",
	".dsh-ctf-btn:hover:not(:disabled){background:var(--dct-hover);border-color:var(--dct-border-strong);color:var(--dct-ink-2)}",
	".dsh-ctf-btn:disabled{opacity:.38;cursor:not-allowed}",
	".dsh-ctf-btn.is-primary{border-color:transparent;background:linear-gradient(135deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);font-weight:700;box-shadow:0 6px 16px -8px color-mix(in srgb,var(--dct-accent) 72%,transparent)}",
	".dsh-ctf-btn.is-danger{border-color:color-mix(in srgb,var(--dct-danger) 45%,transparent);color:var(--dct-danger-ink)}",
	".dsh-ctf-btn.is-ghost{border-color:transparent;background:transparent;color:var(--dct-ink-5)}",
	".dsh-ctf-btn.is-sm{padding:3px 10px;font-size:11.5px;border-radius:8px}",
	".dsh-ctf-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;border:1px solid color-mix(in srgb,var(--dct-danger) 45%,transparent);border-left-width:3px;border-radius:9px;background:color-mix(in srgb,var(--dct-danger) 8%,transparent);color:var(--dct-danger-ink);font-size:11.5px;line-height:1.6;word-break:break-word}",
	".dsh-ctf-error.is-inline{margin:2px 0 8px}",
	".dsh-ctf-error.is-warn{border-color:color-mix(in srgb,var(--dct-warn) 50%,transparent);background:color-mix(in srgb,var(--dct-warn) 9%,transparent);color:var(--dct-warn-ink)}",
	".dsh-ctf-statsbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--dct-soft-2)}",
	".dsh-ctf-stats{display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0}",
	".dsh-ctf-stat{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dct-soft-2);border-radius:999px;padding:4px 12px;background:var(--dct-soft);min-width:0;text-align:left;white-space:nowrap}",
	".dsh-ctf-stat b{display:inline-block;font-size:14px;line-height:1.2;font-weight:800;font-variant-numeric:tabular-nums;color:var(--dct-ink)}",
	".dsh-ctf-stat span{font-size:11px;color:var(--dct-ink-5);letter-spacing:.2px}",
	".dsh-ctf-stat.is-queued b{color:var(--dct-queued)}",
	".dsh-ctf-stat.is-run b{color:var(--dct-run)}",
	".dsh-ctf-stat.is-ok b{color:var(--dct-ok-ink)}",
	".dsh-ctf-stat.is-warn b{color:var(--dct-warn-ink)}",
	".dsh-ctf-stats-note{font-size:10.5px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums}",
	".dsh-ctf-formwrap{padding:16px 18px}",
	".dsh-ctf-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}",
	".dsh-ctf-field{display:flex;flex-direction:column;gap:5px;min-width:0}",
	".dsh-ctf-field.is-wide{grid-column:1/-1}",
	".dsh-ctf-field>span{font-size:11.5px;font-weight:700;letter-spacing:.3px;color:var(--dct-ink-4)}",
	".dsh-ctf-in{width:100%;border:1px solid var(--dct-border);border-radius:9px;background:var(--dct-input);color:var(--dct-ink-2);padding:7px 11px;font-size:12.5px;line-height:1.5;outline:none;font-family:inherit;transition:border-color .16s,box-shadow .16s}",
	".dsh-ctf-in:focus{border-color:var(--dct-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dct-accent) 14%,transparent)}",
	"textarea.dsh-ctf-in{resize:vertical;min-height:64px}",
	"select.dsh-ctf-in{appearance:auto}",
	".dsh-ctf-formfoot{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:2px}",
	".dsh-ctf-formnote{grid-column:1/-1;font-size:10.5px;color:var(--dct-ink-6);line-height:1.6}",
	".dsh-ctf-check{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dct-ink-4);cursor:pointer;user-select:none}",
	".dsh-ctf-check input{accent-color:var(--dct-accent);margin:0}",
	".dsh-ctf-list{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-card{border:1px solid var(--dct-border);border-left:3px solid transparent;border-radius:var(--dct-radius-sm);background:var(--dct-card);box-shadow:var(--dct-card-shadow);overflow:hidden;transition:border-color .16s,box-shadow .16s,transform .16s}",
	".dsh-ctf-card:hover{border-color:var(--dct-border-strong);border-left-color:var(--dct-soft-2);box-shadow:0 2px 4px rgba(15,35,70,.04),0 12px 28px -20px rgba(15,35,70,.28)}",
	".dsh-ctf-card.is-open{border-color:color-mix(in srgb,var(--dct-accent) 48%,var(--dct-border));border-left-color:var(--dct-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dct-accent) 18%,transparent),var(--dct-card-shadow)}",
	".dsh-ctf-card.is-solved{border-left-color:var(--dct-ok)}",
	".dsh-ctf-card.is-running{border-left-color:var(--dct-run)}",
	".dsh-ctf-card-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:10px 14px;padding:12px 14px 10px}",
	".dsh-ctf-card-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
	".dsh-ctf-card-title{font-size:14.5px;font-weight:700;line-height:1.45;color:var(--dct-ink);word-break:break-word}",
	".dsh-ctf-card-id{font-size:10.5px;color:var(--dct-ink-6);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}",
	".dsh-ctf-card-sub{font-size:10.5px;color:var(--dct-ink-6);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;padding:0 14px 10px;line-height:1.5}",
	".dsh-ctf-card-warn{font-size:11.5px;color:var(--dct-warn-ink);background:color-mix(in srgb,var(--dct-warn) 8%,transparent);border-top:1px dashed color-mix(in srgb,var(--dct-warn) 32%,transparent);padding:8px 14px;line-height:1.6}",
	".dsh-ctf-metric{font-size:11.5px;color:var(--dct-ink-5);white-space:nowrap}",
	".dsh-ctf-metric b{color:var(--dct-ink-3);font-variant-numeric:tabular-nums}",
	".dsh-ctf-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;line-height:17px;border:1px solid currentColor;white-space:nowrap}",
	".dsh-ctf-badge i{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}",
	".dsh-ctf-badge.is-queued{color:var(--dct-queued);background:color-mix(in srgb,var(--dct-queued) 9%,transparent)}",
	".dsh-ctf-badge.is-run{color:var(--dct-run);background:color-mix(in srgb,var(--dct-run) 9%,transparent)}",
	".dsh-ctf-badge.is-ok{color:var(--dct-ok-ink);background:color-mix(in srgb,var(--dct-ok) 11%,transparent)}",
	".dsh-ctf-badge.is-warn{color:var(--dct-warn-ink);background:color-mix(in srgb,var(--dct-warn) 10%,transparent)}",
	".dsh-ctf-badge.is-danger{color:var(--dct-danger-ink);background:color-mix(in srgb,var(--dct-danger) 9%,transparent)}",
	".dsh-ctf-badge.is-muted{color:var(--dct-muted);background:color-mix(in srgb,var(--dct-muted) 9%,transparent)}",
	".dsh-ctf-badge.is-run i{animation:dsh-ctf-pulse 1.5s ease-in-out infinite}",
	"@keyframes dsh-ctf-pulse{0%,100%{opacity:1}50%{opacity:.25}}",
	".dsh-ctf-chip{display:inline-block;padding:1px 7px;border:1px solid var(--dct-soft-2);border-radius:6px;font-size:10.5px;line-height:16px;color:var(--dct-ink-5);background:var(--dct-soft);letter-spacing:.2px;white-space:nowrap}",
	".dsh-ctf-chip.is-mine{color:var(--dct-accent);border-color:color-mix(in srgb,var(--dct-accent) 55%,transparent);background:color-mix(in srgb,var(--dct-accent) 12%,transparent);font-weight:700}",
	".dsh-ctf-btn.is-on{border-color:var(--dct-accent);background:color-mix(in srgb,var(--dct-accent) 14%,transparent);color:var(--dct-accent);font-weight:700}",
	".dsh-ctf-viewbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px}",
	".dsh-ctf-viewbar .dsh-ctf-muted{margin-right:auto}",
	".dsh-ctf-tag{display:inline-block;padding:0 7px;border-radius:5px;font-size:9.5px;line-height:16px;border:1px solid currentColor}",
	".dsh-ctf-tag.is-ok{color:var(--dct-ok-ink)}",
	".dsh-ctf-tag.is-warn{color:var(--dct-warn-ink)}",
	".dsh-ctf-tag.is-danger{color:var(--dct-danger-ink)}",
	".dsh-ctf-tag.is-run{color:var(--dct-run)}",
	".dsh-ctf-tag.is-muted{color:var(--dct-muted)}",
	".dsh-ctf-detail{border-top:1px solid var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 3%,transparent);padding:14px;display:flex;flex-direction:column;gap:12px}",
	".dsh-ctf-kv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px}",
	".dsh-ctf-kv{display:flex;flex-direction:column;gap:1px;min-width:0}",
	".dsh-ctf-kv>span{font-size:10.5px;color:var(--dct-ink-6);letter-spacing:.3px}",
	".dsh-ctf-kv>b{font-size:11.5px;font-weight:600;color:var(--dct-ink-3);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.5}",
	".dsh-ctf-statement{grid-column:1/-1;display:flex;flex-direction:column;gap:3px}",
	".dsh-ctf-statement>span{font-size:9.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-statement-body{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.75;color:var(--dct-ink-4);background:var(--dct-input);border:1px solid var(--dct-soft-2);border-radius:9px;padding:9px 11px;max-height:170px;overflow:auto}",
	".dsh-ctf-sec{display:flex;flex-direction:column;gap:6px}",
	".dsh-ctf-sec-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;letter-spacing:.4px;color:var(--dct-ink-3)}",
	".dsh-ctf-sec-count{font-size:10.5px;font-weight:700;padding:0 7px;border-radius:999px;background:var(--dct-soft-2);color:var(--dct-ink-4)}",
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
	".dsh-ctf-toast{position:fixed;right:20px;bottom:20px;z-index:80;max-width:380px;padding:11px 15px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dct-line) 50%,transparent);background:var(--dct-float);backdrop-filter:blur(14px);color:var(--dct-ink-3);font-size:12.5px;line-height:1.6;box-shadow:var(--dct-shadow)}",
	".dsh-ctf-toast.is-err{border-color:color-mix(in srgb,var(--dct-danger) 55%,transparent);color:var(--dct-danger-ink)}",
	".dsh-ctf-pad{padding:12px 16px;display:flex;flex-direction:column;gap:8px}",
	".dsh-ctf-filters{display:flex;flex-direction:column;gap:10px;padding:10px 14px 13px}",
	".dsh-ctf-frow{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}",
	".dsh-ctf-fchip{border:1px solid var(--dct-soft-2);border-radius:999px;padding:2px 11px;font-size:11.5px;line-height:19px;color:var(--dct-ink-4);background:var(--dct-soft);cursor:pointer;transition:background .15s,color .15s,border-color .15s;user-select:none;display:inline-flex;align-items:center;gap:6px;font-family:inherit;white-space:nowrap}",
	".dsh-ctf-fchip:hover{background:var(--dct-hover)}",
	".dsh-ctf-fchip.is-on{background:linear-gradient(135deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);border-color:transparent;font-weight:700;box-shadow:0 4px 12px -8px color-mix(in srgb,var(--dct-accent) 75%,transparent)}",
	".dsh-ctf-fchip i{font-style:normal;font-size:9.5px;opacity:.78;font-variant-numeric:tabular-nums}",
	".dsh-ctf-search{flex:1 1 220px;min-width:170px;max-width:360px}",
	".dsh-ctf-fselect{width:auto;min-width:112px;max-width:190px;flex:0 1 auto}",
	".dsh-ctf-fnote{font-size:11px;color:var(--dct-ink-6);margin-left:auto;font-variant-numeric:tabular-nums}",
	".dsh-ctf-fopt{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dct-ink-4);cursor:pointer;user-select:none;white-space:nowrap}",
	".dsh-ctf-fopt input{accent-color:var(--dct-accent);margin:0}",
	".dsh-ctf-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dct-muted);flex:none}",
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
	".dsh-ctf-svcard.is-current{border-color:color-mix(in srgb,var(--dct-accent) 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dct-accent) 24%,transparent),var(--dct-card-shadow)}",
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
	".dsh-ctf-lrow{border:1px solid var(--dct-border);border-radius:var(--dct-radius-sm);background:var(--dct-card);padding:8px 11px;display:flex;flex-direction:column;gap:5px;box-shadow:var(--dct-card-shadow)}",
	".dsh-ctf-lrow.is-unverified{border-left:3px solid var(--dct-warn);background:color-mix(in srgb,var(--dct-warn) 5%,var(--dct-card))}",
	".dsh-ctf-lmain{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-ltitle{font-size:12px;font-weight:700;color:var(--dct-ink-3);cursor:pointer;word-break:break-word}",
	".dsh-ctf-ltitle:hover{color:var(--dct-accent)}",
	".dsh-ctf-lflag{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dct-ok-ink);font-weight:700;word-break:break-all}",
	".dsh-ctf-lev{border-top:1px dashed var(--dct-soft-2);margin-top:3px;padding-top:5px;font-size:10.5px;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-word;line-height:1.6}",
	".dsh-ctf-lrow-detail{border-top:1px solid var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 4%,transparent);padding:9px 11px;margin-top:2px;border-radius:0 0 7px 7px}",
	".dsh-ctf-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--dct-border);border-radius:9px;background:var(--dct-input)}",
	".dsh-ctf-segbtn{border:0;border-radius:7px;background:transparent;color:var(--dct-ink-5);font:600 11.5px/1.5 inherit;padding:3px 10px;cursor:pointer;white-space:nowrap}",
	".dsh-ctf-segbtn:hover{background:var(--dct-hover)}",
	".dsh-ctf-segbtn.is-on{background:linear-gradient(135deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);font-weight:700}",
	".dsh-ctf-groups{display:flex;flex-direction:column;gap:12px}",
	".dsh-ctf-group{border:1px solid var(--dct-border);border-radius:var(--dct-radius);background:color-mix(in srgb,var(--dct-line) 2.5%,var(--dct-panel));box-shadow:var(--dct-glow);overflow:hidden}",
	".dsh-ctf-group.is-current{border-color:color-mix(in srgb,var(--dct-accent) 46%,var(--dct-border))}",
	".dsh-ctf-group.is-unassigned{border-style:dashed}",
	".dsh-ctf-grouphead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:color-mix(in srgb,var(--dct-line) 5%,transparent);border-bottom:1px solid var(--dct-soft-2)}",
	".dsh-ctf-grouptitle{font-size:13px;font-weight:700;color:var(--dct-ink);word-break:break-word}",
	".dsh-ctf-grouphead .dsh-ctf-count{font-size:9.5px}",
	".dsh-ctf-groupbody{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px}",
	".dsh-ctf-groupbody .dsh-ctf-card{background:var(--dct-card)}",
	".dsh-ctf-ledgerwrap{display:flex;flex-direction:column}",
	".dsh-ctf-ledgerhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px}",
	".dsh-ctf-ledgerhead .dsh-ctf-muted{margin-left:auto}",
	".dsh-ctf-ledgerbody{display:flex;flex-direction:column;gap:10px;padding:0 16px 14px}",
	".dsh-ctf-padsplit{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}",
	".dsh-ctf-wb{display:flex;flex-direction:column;gap:12px;padding-top:2px}",
	".dsh-ctf-wbtabs{display:flex;gap:4px;flex-wrap:nowrap;overflow-x:auto;border-bottom:1px solid var(--dct-soft-2);padding-bottom:0;scrollbar-width:none}",
	".dsh-ctf-wbtab{border:1px solid transparent;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:var(--dct-ink-5);font:600 11.5px/1.5 inherit;padding:5px 11px;cursor:pointer;white-space:nowrap}",
	".dsh-ctf-wbtab:hover{background:var(--dct-hover);color:var(--dct-ink-3)}",
	".dsh-ctf-wbtab.is-on{border-bottom-color:var(--dct-accent);background:var(--dct-accent-soft);color:var(--dct-accent);font-weight:700}",
	".dsh-ctf-wbbody{display:flex;flex-direction:column;gap:12px;padding-top:4px}",
	".dsh-ctf-wbnote{font-size:11px;color:var(--dct-ink-6);line-height:1.6}",
	".dsh-ctf-filelist{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow:auto}",
	".dsh-ctf-filerow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--dct-soft-2);border-radius:6px;transition:background .15s}",
	".dsh-ctf-filerow:last-child{border-bottom:0}",
	".dsh-ctf-filename{flex:1;min-width:150px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-3);word-break:break-all}",
	".dsh-ctf-filesize{font-size:9.5px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums}",
	".dsh-ctf-wbread{margin:0;max-height:200px;overflow:auto;padding:7px 9px;border-radius:6px;background:var(--dct-input);border:1px solid var(--dct-soft-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.55;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-all}",
	".dsh-ctf-notes textarea{width:100%;min-height:120px;border:1px solid var(--dct-soft-2);border-radius:8px;background:var(--dct-input);color:var(--dct-ink-2);padding:8px 10px;font:11.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none;resize:vertical}",
	".dsh-ctf-notes textarea:focus{border-color:var(--dct-accent)}",
	".dsh-ctf-wbactions{display:flex;flex-direction:column;align-items:stretch;gap:10px;border-top:1px solid var(--dct-soft-2);padding-top:12px}",
	".dsh-ctf-wbflag{display:flex;align-items:center;gap:7px;flex-wrap:wrap;flex:1;min-width:220px}",
	".dsh-ctf-wbflag .dsh-ctf-in{flex:1;min-width:150px}",
	".dsh-ctf-platformchip{border-style:dashed}",
	".dsh-ctf-platformchip.is-ok{color:var(--dct-ok-ink);border-color:color-mix(in srgb,var(--dct-ok) 50%,transparent)}",
	".dsh-ctf-platformchip.is-danger{color:var(--dct-danger-ink);border-color:color-mix(in srgb,var(--dct-danger) 50%,transparent)}",
	".dsh-ctf-plat{display:flex;flex-direction:column;gap:14px;padding:6px 18px 18px}",
	".dsh-ctf-platgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 14px}",
	".dsh-ctf-platrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-plist{display:flex;flex-direction:column;gap:3px;max-height:280px;overflow:auto;border:1px solid var(--dct-soft-2);border-radius:8px;padding:6px 9px;background:var(--dct-input)}",
	".dsh-ctf-prow{display:flex;align-items:center;gap:8px;font-size:11px;padding:2px 0;border-bottom:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-prow:last-child{border-bottom:0}",
	".dsh-ctf-prow input{accent-color:var(--dct-accent);margin:0;flex:none}",
	".dsh-ctf-prow b{font-weight:700;color:var(--dct-ink-3);word-break:break-word}",
	".dsh-ctf-platstatus{font-size:11.5px;color:var(--dct-ink-5);font-variant-numeric:tabular-nums;line-height:1.6}",
	".dsh-ctf-report{display:flex;flex-direction:column;gap:8px;padding:12px 16px}",
	".dsh-ctf-reporthead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--dct-ink-4)}",
	".dsh-ctf-reportpre{margin:0;max-height:260px;overflow:auto;padding:9px 11px;border-radius:8px;background:var(--dct-input);border:1px solid var(--dct-soft-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.6;color:var(--dct-ink-4);white-space:pre-wrap;word-break:break-word}",
	".dsh-ctf-tabs{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;overflow-x:auto;padding:2px;scrollbar-width:none;min-width:0}",
	".dsh-ctf-tab{border:1px solid transparent;background:transparent;color:var(--dct-ink-5);font:600 12px/1 inherit;padding:8px 14px;border-radius:9px;cursor:pointer;white-space:nowrap;transition:background .16s,color .16s,box-shadow .16s}",
	".dsh-ctf-tab:hover{background:var(--dct-hover);color:var(--dct-ink-3)}",
	".dsh-ctf-tab.is-on{background:var(--dct-card);border-color:var(--dct-border);color:var(--dct-accent);box-shadow:0 1px 2px rgba(15,35,70,.06)}",
	".dsh-ctf-page{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-countdown{color:var(--dct-accent);font-variant-numeric:tabular-nums}",
	".dsh-ctf-countdown.is-wrapup{color:var(--dct-warn-ink);font-weight:700}",
	".dsh-ctf-setgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 16px}",
	".dsh-ctf-setrow{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--dct-ink-5)}",
	".dsh-ctf-setrow .dsh-ctf-in{width:100%}",
	".dsh-ctf-diag{display:flex;flex-direction:column;gap:4px;font-size:11.5px;line-height:1.7;color:var(--dct-ink-4)}",
	".dsh-ctf-diag b{color:var(--dct-ink-2)}",
	".dsh-ctf-rrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:5px 0;border-bottom:1px dashed var(--dct-soft-2);font-size:11px}",
	".dsh-ctf-rrow:last-child{border-bottom:0}",
	".dsh-ctf-rname{flex:1;min-width:200px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-3);word-break:break-all}",
	".dsh-ctf-wbhead{display:flex;flex-direction:column;gap:6px;padding:0 2px 4px}",
	".dsh-ctf-wbtitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13.5px;min-width:0}",
	".dsh-ctf-wbmeta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dct-ink-5);min-width:0}",
	".dsh-ctf-wbdir{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-wbdir{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
	".dsh-ctf-btn.is-danger{color:var(--dct-danger-ink)}",
	".dsh-ctf-pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:2px 0}",
	".dsh-ctf-pagetitle{font-size:17px;font-weight:750;color:var(--dct-ink-2)}",
	".dsh-ctf-pagesub{font-size:11.5px;color:var(--dct-ink-6);margin-top:3px;line-height:1.6}",
	".dsh-ctf-sumrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px}",
	".dsh-ctf-sumrow .dsh-ctf-stat{flex:1;min-width:120px}",
	".dsh-ctf-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;align-items:start}",
	".dsh-ctf-setcard{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dct-border);border-radius:var(--dct-radius);background:var(--dct-panel);box-shadow:var(--dct-glow)}",
	".dsh-ctf-setlabel{font-size:11.5px;font-weight:600;color:var(--dct-ink-3)}",
	".dsh-ctf-sethint{font-size:11px;color:var(--dct-ink-6);line-height:1.6}",
	".dsh-ctf-switch{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dct-ink-4);cursor:pointer}",
	".dsh-ctf-switch input{accent-color:var(--dct-accent)}",
	".dsh-ctf-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:700;border:1px solid transparent}",
	".dsh-ctf-pill.is-ok{color:var(--dct-ok-ink);background:color-mix(in srgb,var(--dct-ok) 14%,transparent);border-color:color-mix(in srgb,var(--dct-ok) 40%,transparent)}",
	".dsh-ctf-pill.is-warn{color:var(--dct-warn-ink);background:color-mix(in srgb,var(--dct-warn) 14%,transparent);border-color:color-mix(in srgb,var(--dct-warn) 40%,transparent)}",
	".dsh-ctf-diaglist{display:flex;flex-direction:column;gap:0}",
	".dsh-ctf-diagrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed var(--dct-soft-2);font-size:11.5px}",
	".dsh-ctf-diagrow:last-child{border-bottom:0}",
	".dsh-ctf-diagrow b{color:var(--dct-ink-2);min-width:76px}",
	".dsh-ctf-diagval{color:var(--dct-ink-4);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px}",
	".dsh-ctf-previewcard{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-preview{display:flex;flex-direction:column;gap:9px;padding:13px 15px;border:1px solid var(--dct-border);border-radius:var(--dct-radius);background:var(--dct-panel);box-shadow:var(--dct-glow)}",
	".dsh-ctf-previewhead{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11.5px;color:var(--dct-ink-4)}",
	".dsh-ctf-path{flex:1;min-width:180px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:var(--dct-ink-5);word-break:break-all}",
	".dsh-ctf-empty.is-slim{padding:16px 12px}",
	".dsh-ctf-footer-note{padding:10px 14px}",
	".dsh-ctf-setstack{display:flex;flex-direction:column;gap:10px}",
	".dsh-ctf-root{min-width:0;overflow-x:hidden}",
	".dsh-ctf-head{flex-wrap:wrap;align-items:center;gap:10px}",
	".dsh-ctf-head-main{min-width:0;flex:1 1 220px}",
	".dsh-ctf-head-actions{flex-wrap:wrap;justify-content:flex-end}",
	".dsh-ctf-tabbar{display:flex;align-items:center;gap:8px;padding:4px;min-width:0;border:1px solid var(--dct-border);border-radius:13px;background:var(--dct-panel);box-shadow:var(--dct-glow);backdrop-filter:blur(12px)}",
	".dsh-ctf-tabbar .dsh-ctf-tabs{flex:1;min-width:0}",
	".dsh-ctf-sumrow .dsh-ctf-stat{flex:1 1 130px;min-width:110px;flex-direction:row;align-items:baseline;justify-content:center;gap:8px;padding:8px 12px;border:1px solid var(--dct-soft-2);border-radius:10px;background:var(--dct-panel)}",
	".dsh-ctf-sumrow .dsh-ctf-stat b{font-size:17px;line-height:1.2}",
	".dsh-ctf-sumrow .dsh-ctf-stat span{font-size:10.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-grid2 .dsh-ctf-ledger{max-height:420px;overflow:auto;padding-right:4px}",
	".dsh-ctf-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 18px;border-radius:var(--dct-radius);border:1px solid var(--dct-border);background:linear-gradient(135deg,color-mix(in srgb,var(--dct-accent) 10%,transparent),color-mix(in srgb,var(--dct-accent) 2%,transparent) 60%),var(--dct-panel);box-shadow:var(--dct-glow)}",
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
	".dsh-ctf-apphead{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 18px;background:linear-gradient(120deg,var(--dct-panel),color-mix(in srgb,var(--dct-accent) 5%,var(--dct-panel)))}",
	".dsh-ctf-brand{display:flex;align-items:center;gap:12px;min-width:0}",
	".dsh-ctf-brandmark{flex:none;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(140deg,var(--dct-accent),var(--dct-accent-2));color:var(--dct-on-accent);font:800 10.5px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.8px;box-shadow:0 8px 20px -10px color-mix(in srgb,var(--dct-accent) 70%,transparent),inset 0 1px 0 rgba(255,255,255,.32)}",
	".dsh-ctf-brandtext{min-width:0}",
	".dsh-ctf-brandline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}",
	".dsh-ctf-brandsub{font-size:11.5px;color:var(--dct-ink-5);margin-top:3px;letter-spacing:.2px}",
	".dsh-ctf-platform-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:1px solid var(--dct-soft-2);background:var(--dct-soft);color:var(--dct-ink-5);font-size:10.5px;font-weight:600;white-space:nowrap;cursor:pointer;font-family:inherit;transition:background .16s,border-color .16s,color .16s}",
	".dsh-ctf-platform-pill:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}",
	".dsh-ctf-platform-pill:hover{background:var(--dct-hover);border-color:var(--dct-border-strong)}",
	".dsh-ctf-platform-pill.is-ok{color:var(--dct-ok-ink);border-color:color-mix(in srgb,var(--dct-ok) 38%,var(--dct-border));background:color-mix(in srgb,var(--dct-ok) 9%,transparent)}",
	".dsh-ctf-platform-pill.is-danger{color:var(--dct-danger-ink);border-color:color-mix(in srgb,var(--dct-danger) 40%,var(--dct-border));background:color-mix(in srgb,var(--dct-danger) 8%,transparent)}",
	".dsh-ctf-overview{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 2%,transparent);border-radius:var(--dct-radius) var(--dct-radius) 0 0}",
	".dsh-ctf-overview .dsh-ctf-stats{flex:1 1 auto}",
	".dsh-ctf-overview-note{font-size:11px;color:var(--dct-ink-6);font-variant-numeric:tabular-nums;white-space:nowrap}",
	".dsh-ctf-stat i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dct-muted);flex:none}",
	".dsh-ctf-stat.is-queued i{background:var(--dct-queued)}",
	".dsh-ctf-stat.is-run i{background:var(--dct-run);box-shadow:0 0 0 3px color-mix(in srgb,var(--dct-run) 16%,transparent)}",
	".dsh-ctf-stat.is-ok i{background:var(--dct-ok)}",
	".dsh-ctf-stat.is-warn i{background:var(--dct-warn)}",
	".dsh-ctf-fchips{display:flex;align-items:center;gap:7px;min-width:0;overflow-x:auto;scrollbar-width:none;padding:1px 0}",
	".dsh-ctf-fchips::-webkit-scrollbar{display:none}",
	".dsh-ctf-frow.is-controls{gap:8px}",
	".dsh-ctf-toggle{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dct-border);border-radius:8px;background:var(--dct-input);font-size:11.5px;color:var(--dct-ink-4);cursor:pointer;user-select:none;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}",
	".dsh-ctf-toggle:hover{border-color:var(--dct-border-strong)}",
	".dsh-ctf-toggle.is-on{background:var(--dct-accent-soft);border-color:color-mix(in srgb,var(--dct-accent) 42%,var(--dct-border));color:var(--dct-accent);font-weight:600}",
	".dsh-ctf-toggle input{accent-color:var(--dct-accent);margin:0}",
	".dsh-ctf-card-main{min-width:0;display:flex;flex-direction:column;gap:7px}",
	".dsh-ctf-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
	".dsh-ctf-card-top .dsh-ctf-card-title{flex:0 1 auto;min-width:0}",
	".dsh-ctf-card-metrics{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0;font-variant-numeric:tabular-nums}",
	".dsh-ctf-card-metrics .dsh-ctf-metric{display:inline-flex;align-items:baseline;gap:4px}",
	".dsh-ctf-card-lastevent{flex:1 1 240px;min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dct-ink-6)}",
	".dsh-ctf-card-lastevent b{font-weight:500;color:var(--dct-ink-5)}",
	".dsh-ctf-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;padding-top:1px}",
	".dsh-ctf-card-more{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:9px 14px;border-top:1px dashed var(--dct-soft-2);background:color-mix(in srgb,var(--dct-line) 3%,transparent)}",
	".dsh-ctf-card-more-spacer{flex:1 1 auto}",
	".dsh-ctf-card.is-failed{border-left-color:var(--dct-danger)}",
	".dsh-ctf-card.is-stuck{border-left-color:var(--dct-warn)}",
	".dsh-ctf-card.is-queued{border-left-color:var(--dct-queued)}",
	".dsh-ctf-card.is-stopped{border-left-color:var(--dct-muted)}",
	".dsh-ctf-card-subline{display:flex;align-items:center;gap:8px;min-width:0}",
	".dsh-ctf-card-subline .dsh-ctf-card-sub{display:block;min-width:0;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}",
	".dsh-ctf-groupmain{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 280px;min-width:0}",
	".dsh-ctf-groupid{display:flex;flex-direction:column;gap:2px;min-width:0}",
	".dsh-ctf-groupsub{font-size:10px;color:var(--dct-ink-6);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;max-width:min(54vw,560px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-groupcounts{display:flex;align-items:center;gap:5px;flex-wrap:wrap}",
	".dsh-ctf-groupactions{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}",
	".dsh-ctf-detailbody{display:flex;flex-direction:column;gap:14px;min-width:0}",
	".dsh-ctf-dirline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dct-soft-2);border-radius:9px;background:var(--dct-input)}",
	".dsh-ctf-dirline>span{font-size:10px;font-weight:700;letter-spacing:.4px;color:var(--dct-ink-6);flex:none}",
	".dsh-ctf-dirline code{flex:1 1 220px;min-width:0;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-detailbody>.dsh-ctf-sec{border-top:1px solid var(--dct-soft-2);padding-top:12px}",
	".dsh-ctf-detailbody>.dsh-ctf-sec:first-of-type{border-top:0;padding-top:0}",
	".dsh-ctf-wbaction-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}",
	".dsh-ctf-wbmain-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
	".dsh-ctf-wbtools{display:flex;align-items:center;gap:4px;flex-wrap:wrap}",
	".dsh-ctf-wbflagrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:10px;border:1px dashed var(--dct-soft-2);border-radius:10px;background:var(--dct-input)}",
	".dsh-ctf-wbflagrow .dsh-ctf-wbflag{flex:1 1 240px;min-width:0}",
	".dsh-ctf-wblabel{font-size:9.5px;font-weight:800;letter-spacing:.7px;color:var(--dct-ink-6);text-transform:uppercase;flex:none}",
	".dsh-ctf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dct-ink-5);font-size:12.5px;line-height:1.7;padding:44px 22px;text-align:center;border:1px dashed var(--dct-border-strong);border-radius:var(--dct-radius);background:color-mix(in srgb,var(--dct-card) 70%,transparent)}",
	".dsh-ctf-empty-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:var(--dct-accent-soft);border:1px solid color-mix(in srgb,var(--dct-accent) 24%,transparent);color:var(--dct-accent);font-size:19px;line-height:1;margin-bottom:2px}",
	".dsh-ctf-empty-title{font-size:14px;font-weight:700;color:var(--dct-ink-2)}",
	".dsh-ctf-empty-desc{max-width:560px;font-size:12px;color:var(--dct-ink-5)}",
	".dsh-ctf-empty-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}",
	".dsh-ctf-empty .dsh-ctf-spin{margin-right:5px}",
	".dsh-ctf-tabs::-webkit-scrollbar,.dsh-ctf-wbtabs::-webkit-scrollbar{display:none}",
	".dsh-ctf-root button:focus-visible,.dsh-ctf-root input:focus-visible,.dsh-ctf-root select:focus-visible,.dsh-ctf-root textarea:focus-visible{outline:2px solid color-mix(in srgb,var(--dct-accent) 68%,transparent);outline-offset:2px}",
	".dsh-ctf-btn.is-primary:focus-visible{outline-color:var(--dct-on-accent)}",
	".dsh-ctf-muted{color:var(--dct-ink-5);font-size:11.5px;line-height:1.65}",
	"@media (max-width:900px){.dsh-ctf-root{padding-left:12px;padding-right:12px}.dsh-ctf-apphead{align-items:flex-start}.dsh-ctf-head-actions{width:100%;justify-content:flex-start}.dsh-ctf-card-head{grid-template-columns:minmax(0,1fr)}.dsh-ctf-card-actions{justify-content:flex-start;padding-top:2px}.dsh-ctf-padsplit,.dsh-ctf-grid2,.dsh-ctf-wugrid,.dsh-ctf-kbgrid{grid-template-columns:minmax(0,1fr)}.dsh-ctf-wugrid .dsh-ctf-sidecol{position:static}.dsh-ctf-search{max-width:none;flex-basis:100%}.dsh-ctf-fnote{margin-left:0}}",
	"@media (max-width:620px){.dsh-ctf-root{font-size:12.5px;padding-top:10px;padding-left:8px;padding-right:8px;gap:10px}.dsh-ctf-brandmark{width:34px;height:34px;border-radius:10px}.dsh-ctf-title{font-size:18px}.dsh-ctf-brandsub{font-size:11px}.dsh-ctf-head-actions .dsh-ctf-btn{flex:1 1 auto}.dsh-ctf-overview{padding:9px 10px}.dsh-ctf-stats{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;width:100%}.dsh-ctf-stats::-webkit-scrollbar{display:none}.dsh-ctf-stat{flex:none}.dsh-ctf-fselect{flex:1 1 46%;max-width:none}.dsh-ctf-fnote{width:100%}.dsh-ctf-grouphead{align-items:flex-start}.dsh-ctf-groupactions{width:100%;margin-left:0;justify-content:flex-end}.dsh-ctf-card-metrics{gap:9px}.dsh-ctf-card-lastevent{flex-basis:100%}.dsh-ctf-wbaction-row{align-items:flex-start}.dsh-ctf-wbflagrow .dsh-ctf-btn{flex:1 1 100%}.dsh-ctf-kv-grid{grid-template-columns:minmax(0,1fr)}.dsh-ctf-toast{left:12px;right:12px;bottom:12px;max-width:none}.dsh-ctf-tab{padding:7px 11px}}",
	"@media (prefers-reduced-motion:reduce){.dsh-ctf-root *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}",
	".dsh-ctf-card-top .dsh-ctf-card-title{flex:1 1 240px;min-width:160px}",
	".dsh-ctf-card-top .dsh-ctf-card-id{margin-left:auto;flex:none}",
	".dsh-ctf-wbmeta .dsh-ctf-wbdir{flex:1 1 260px}",
	".dsh-ctf-wbmeta .dsh-ctf-btn{margin-left:auto;flex:none}",
	".dsh-ctf-wbnote{font-size:10.5px;color:var(--dct-ink-6);line-height:1.6}",
	".dsh-ctf-card-more .dsh-ctf-wbnote{font-size:10.5px;opacity:.85}",
	".dsh-ctf-filters .dsh-ctf-search{min-height:31px}",
	".dsh-ctf-filters .dsh-ctf-fselect{min-height:31px}",
	".dsh-ctf-grouphead .dsh-ctf-count{font-size:10px;padding:1px 7px}",
	".dsh-ctf-page{gap:12px}",
	".dsh-ctf-groupactions .dsh-ctf-btn.is-danger{color:var(--dct-ink-5)}",
	".dsh-ctf-groupactions .dsh-ctf-btn.is-danger:hover{color:var(--dct-danger-ink);background:color-mix(in srgb,var(--dct-danger) 10%,transparent)}",
	"@media (max-width:620px){.dsh-ctf-card-top .dsh-ctf-card-id{display:none}.dsh-ctf-card-top .dsh-ctf-card-title{flex-basis:100%}.dsh-ctf-card-top .dsh-ctf-chip.is-mine{margin-left:auto}}",
	"@media (max-width:900px){.dsh-ctf-detailbody .dsh-ctf-kv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
	"@media (max-width:620px){.dsh-ctf-detailbody .dsh-ctf-kv-grid{grid-template-columns:minmax(0,1fr)}}",
	".dsh-ctf-wbtools .dsh-ctf-btn.is-danger{color:var(--dct-ink-5)}",
	".dsh-ctf-wbtools .dsh-ctf-btn.is-danger:hover{color:var(--dct-danger-ink);background:color-mix(in srgb,var(--dct-danger) 10%,transparent)}",
	"/* ---- 视觉 2.0：命令台外壳 ---- */",
	"body{--dct-accent:#3b6cff;--dct-accent-2:#00c2ff;--dct-ok:#00a870;--dct-ok-ink:#00805a;--dct-warn:#d97706;--dct-warn-ink:#b45309;--dct-danger:#ef4444;--dct-danger-ink:#dc2626;--dct-border:#d8e4f2;--dct-border-strong:#b9cde6;--dct-panel:rgba(255,255,255,.82);--dct-card:rgba(255,255,255,.9);--dct-glow:0 1px 2px rgba(16,38,74,.04),0 18px 44px -28px rgba(16,38,74,.3);--dct-card-shadow:0 1px 2px rgba(16,38,74,.04),0 10px 26px -22px rgba(16,38,74,.28)}",
	"body[data-ds-dark-theme]{--dct-accent:#5b9dff;--dct-accent-2:#22d3ee;--dct-ok:#3ddc97;--dct-warn:#f5c542;--dct-danger:#ff7b7b;--dct-border:rgba(99,152,210,.24);--dct-border-strong:rgba(119,177,240,.4);--dct-panel:rgba(9,23,42,.72);--dct-card:rgba(12,29,52,.86);--dct-glow:0 1px 0 rgba(255,255,255,.03),0 20px 44px -30px rgba(0,0,0,.85);--dct-card-shadow:0 1px 0 rgba(255,255,255,.02),0 12px 28px -24px rgba(0,0,0,.9)}",
	".dsh-ctf-root{position:relative;padding:16px clamp(12px,2vw,24px) 40px;font-size:13.5px;background:radial-gradient(900px 520px at 4% -8%,rgba(59,108,255,.13),transparent 60%),radial-gradient(760px 460px at 98% -2%,rgba(0,194,255,.11),transparent 58%),linear-gradient(rgba(22,48,88,.032) 1px,transparent 1px),linear-gradient(90deg,rgba(22,48,88,.032) 1px,transparent 1px),linear-gradient(180deg,#f7faff 0%,#edf3fb 100%);background-size:auto,auto,34px 34px,34px 34px,auto}",
	"body[data-ds-dark-theme] .dsh-ctf-root{background:radial-gradient(900px 520px at 4% -8%,rgba(47,112,220,.26),transparent 60%),radial-gradient(760px 460px at 98% -2%,rgba(0,194,255,.14),transparent 58%),linear-gradient(rgba(140,190,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(140,190,255,.035) 1px,transparent 1px),linear-gradient(180deg,#07162a 0%,#040c17 100%);background-size:auto,auto,34px 34px,34px 34px,auto}",
	".dsh-ctf-shell{display:flex;align-items:flex-start;gap:18px;min-height:100%;min-width:0}",
	".dsh-ctf-main{display:flex;flex-direction:column;gap:14px;flex:1;min-width:0}",
	".dsh-ctf-rail{position:sticky;top:12px;width:188px;flex:none;display:flex;flex-direction:column;gap:14px;min-height:calc(100vh - 130px);padding:12px;border:1px solid var(--dct-border);border-radius:20px;background:linear-gradient(180deg,color-mix(in srgb,var(--dct-panel) 94%,transparent),color-mix(in srgb,var(--dct-panel) 78%,transparent));box-shadow:var(--dct-glow),inset 0 1px 0 rgba(255,255,255,.5);backdrop-filter:blur(18px)}",
	"body[data-ds-dark-theme] .dsh-ctf-rail{box-shadow:var(--dct-glow),inset 0 1px 0 rgba(255,255,255,.035)}",
	".dsh-ctf-railbrand{display:flex;align-items:center;gap:10px;padding:2px 4px 8px}",
	".dsh-ctf-railmark{flex:none;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:13px;background:linear-gradient(140deg,var(--dct-accent),var(--dct-accent-2));color:#fff;box-shadow:0 10px 24px -12px color-mix(in srgb,var(--dct-accent) 80%,transparent),inset 0 1px 0 rgba(255,255,255,.35)}",
	".dsh-ctf-railname{display:flex;flex-direction:column;gap:1px;min-width:0}",
	".dsh-ctf-railname b{font-size:14px;font-weight:800;letter-spacing:.4px;color:var(--dct-ink)}",
	".dsh-ctf-railname span{font:700 8px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1.5px;color:var(--dct-ink-6)}",
	".dsh-ctf-railcap{padding:0 10px;font:700 8.5px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1.5px;text-transform:uppercase;color:var(--dct-ink-6)}",
	".dsh-ctf-railnav{display:flex;flex-direction:column;gap:3px;min-width:0}",
	".dsh-ctf-navitem{display:flex;align-items:center;gap:10px;width:100%;height:38px;padding:0 10px;border:1px solid transparent;border-radius:11px;background:transparent;color:var(--dct-ink-4);font:600 12.5px/1 var(--dsw-font-family,system-ui,sans-serif);text-align:left;cursor:pointer;transition:background .16s,color .16s,border-color .16s,transform .16s;white-space:nowrap}",
	".dsh-ctf-navitem .dsh-ctf-icon{flex:none;opacity:.72}",
	".dsh-ctf-navitem:hover{background:var(--dct-hover);color:var(--dct-ink-2)}",
	".dsh-ctf-navitem.is-on{background:linear-gradient(90deg,color-mix(in srgb,var(--dct-accent) 14%,transparent),transparent);border-color:color-mix(in srgb,var(--dct-accent) 24%,transparent);color:var(--dct-accent);box-shadow:inset 2px 0 0 var(--dct-accent)}",
	".dsh-ctf-navitem.is-on .dsh-ctf-icon{opacity:1}",
	".dsh-ctf-navlabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
	".dsh-ctf-navcount{flex:none;min-width:18px;padding:1px 5px;border-radius:999px;background:var(--dct-soft-2);color:var(--dct-ink-5);font:800 9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:center;font-style:normal}",
	".dsh-ctf-navitem.is-on .dsh-ctf-navcount{background:color-mix(in srgb,var(--dct-accent) 16%,transparent);color:var(--dct-accent)}",
	".dsh-ctf-railfoot{margin-top:auto;display:flex;flex-direction:column;gap:9px;padding-top:10px;border-top:1px solid var(--dct-soft-2)}",
	".dsh-ctf-railsession{display:flex;align-items:center;gap:8px;min-width:0;padding:2px 6px}",
	".dsh-ctf-raildot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dct-muted)}",
	".dsh-ctf-raildot.is-live{background:var(--dct-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--dct-ok) 16%,transparent);animation:dsh-ctf-pulse 2s ease-in-out infinite}",
	".dsh-ctf-railsession>div{display:flex;flex-direction:column;gap:1px;min-width:0}",
	".dsh-ctf-railsession b{font-size:11px;font-weight:700;color:var(--dct-ink-4)}",
	".dsh-ctf-railsession span{font:9px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-railmeta{display:flex;align-items:center;justify-content:space-between;padding:0 6px;font:700 8px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1px;color:var(--dct-ink-6)}",
	".dsh-ctf-topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:6px 2px 2px}",
	".dsh-ctf-topbar-main{min-width:0;flex:1 1 320px}",
	".dsh-ctf-eyebrow{display:flex;align-items:center;gap:7px;font:800 9.5px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1.8px;color:var(--dct-accent);text-transform:uppercase}",
	".dsh-ctf-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:var(--dct-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--dct-ok) 14%,transparent);animation:dsh-ctf-pulse 2.2s ease-in-out infinite}",
	".dsh-ctf-pagetitle{margin:5px 0 0;font-size:27px;font-weight:820;line-height:1.12;letter-spacing:-.5px;color:var(--dct-ink)}",
	".dsh-ctf-pagedesc{margin-top:4px;font-size:12px;line-height:1.6;color:var(--dct-ink-5)}",
	".dsh-ctf-topbar-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}",
	".dsh-ctf-topbar-actions .dsh-ctf-btn{height:32px;padding:0 12px;border-radius:9px;display:inline-flex;align-items:center;gap:6px}",
	".dsh-ctf-topbar-actions .dsh-ctf-platform-pill{height:28px;padding:0 10px;font-size:10.5px}",
	".dsh-ctf-panel{border-radius:18px;background:linear-gradient(180deg,color-mix(in srgb,var(--dct-panel) 98%,transparent),color-mix(in srgb,var(--dct-panel) 88%,transparent));box-shadow:var(--dct-glow),inset 0 1px 0 rgba(255,255,255,.45)}",
	"body[data-ds-dark-theme] .dsh-ctf-panel{box-shadow:var(--dct-glow),inset 0 1px 0 rgba(255,255,255,.03)}",
	"/* ---- 视觉 2.0：题板命令区 ---- */",
	".dsh-ctf-board-tools{display:flex;flex-direction:column;gap:12px;min-width:0}",
	".dsh-ctf-pinned{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dct-accent) 30%,var(--dct-border));background:linear-gradient(180deg,color-mix(in srgb,var(--dct-accent) 9%,var(--dct-panel)),var(--dct-panel))}",
	".dsh-ctf-pinned-head{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--dct-ink-2)}",
	".dsh-ctf-pinned-head b{font-size:13px;font-weight:800}",
	".dsh-ctf-pinned-head span{color:var(--dct-ink-5);font-size:11px}",
	".dsh-ctf-pinned-head em{margin-left:auto;font-style:normal;font-size:10px;color:var(--dct-ink-6)}",
	".dsh-ctf-pinned-dot{width:7px;height:7px;border-radius:50%;background:var(--dct-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--dct-ok) 18%,transparent)}",
	".dsh-ctf-command{position:relative;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px;overflow:hidden;border:1px solid var(--dct-border);background:linear-gradient(135deg,color-mix(in srgb,var(--dct-accent) 7%,var(--dct-panel)),var(--dct-panel) 62%)}",
	".dsh-ctf-command:before{content:'';position:absolute;width:220px;height:220px;right:-80px;top:-140px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dct-accent) 20%,transparent),transparent 68%);pointer-events:none}",
	".dsh-ctf-kpis{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;flex:1;min-width:0}",
	".dsh-ctf-kpi{--kpi-tone:var(--dct-accent);position:relative;display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:10px;min-width:0;min-height:56px;padding:9px 11px;border:1px solid var(--dct-border);border-radius:14px;background:color-mix(in srgb,var(--dct-input) 74%,transparent);overflow:hidden;transition:border-color .16s,transform .16s,box-shadow .16s}",
	".dsh-ctf-kpi:before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--kpi-tone)}",
	".dsh-ctf-kpi:hover{border-color:color-mix(in srgb,var(--kpi-tone) 38%,var(--dct-border));transform:translateY(-1px);box-shadow:0 8px 18px -16px color-mix(in srgb,var(--kpi-tone) 60%,transparent)}",
	".dsh-ctf-kpi.is-run{--kpi-tone:var(--dct-accent)}",
	".dsh-ctf-kpi.is-ok{--kpi-tone:var(--dct-ok)}",
	".dsh-ctf-kpi.is-warn{--kpi-tone:var(--dct-warn)}",
	".dsh-ctf-kpi-icon{flex:none;display:flex;align-items:center;justify-content:center;width:31px;height:31px;border-radius:10px;background:color-mix(in srgb,var(--kpi-tone) 12%,transparent);color:var(--kpi-tone)}",
	".dsh-ctf-kpi-main{display:flex;flex-direction:column;gap:1px;min-width:0}",
	".dsh-ctf-kpi-main span{font-size:10px;font-weight:700;letter-spacing:.3px;color:var(--dct-ink-5);white-space:nowrap}",
	".dsh-ctf-kpi-main b{font-size:23px;line-height:1.08;font-weight:800;font-variant-numeric:tabular-nums;color:var(--dct-ink)}",
	".dsh-ctf-kpi em{font-style:normal;margin-left:auto;align-self:center;font:9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-6);text-align:right;white-space:nowrap}",
	".dsh-ctf-command-progress{position:relative;display:flex;align-items:center;gap:11px;flex:none;min-width:166px;padding-left:18px;border-left:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-ring{--dct-pct:0%;position:relative;width:64px;height:64px;flex:none;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--dct-ok) var(--dct-pct),var(--dct-soft-2) 0)}",
	".dsh-ctf-ring:before{content:'';position:absolute;inset:6px;border-radius:50%;background:var(--dct-panel);box-shadow:inset 0 1px 3px rgba(16,38,74,.08)}",
	".dsh-ctf-ring span{position:relative;font:800 13px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dct-ink-2)}",
	".dsh-ctf-command-progress-text{display:flex;flex-direction:column;gap:2px}",
	".dsh-ctf-command-progress-text b{font-size:11.5px;color:var(--dct-ink-3)}",
	".dsh-ctf-command-progress-text span{font-size:10.5px;color:var(--dct-ink-5)}",
	".dsh-ctf-command-progress-text em{font:9px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;font-style:normal;color:var(--dct-ink-6)}",
	".dsh-ctf-filters{padding:9px 11px;border-radius:16px;gap:8px;background:color-mix(in srgb,var(--dct-float) 86%,transparent)}",
	".dsh-ctf-fchips{gap:6px}",
	".dsh-ctf-fchip{height:26px;padding:0 10px;border-radius:9px;background:var(--dct-input);font-size:11px;line-height:1;gap:6px}",
	".dsh-ctf-fchip i{min-width:15px;padding:0 4px;border-radius:999px;background:var(--dct-soft-2);font:800 9px/15px ui-monospace,SFMono-Regular,Consolas,monospace;text-align:center;font-style:normal;opacity:1}",
	".dsh-ctf-fchip.is-on{background:linear-gradient(135deg,var(--dct-accent),var(--dct-accent-2));border-color:transparent;box-shadow:0 6px 16px -10px color-mix(in srgb,var(--dct-accent) 70%,transparent)}",
	".dsh-ctf-fchip.is-on i{background:rgba(255,255,255,.22);color:inherit}",
	".dsh-ctf-frow.is-controls{gap:7px}",
	".dsh-ctf-searchwrap{position:relative;display:flex;align-items:center;flex:1 1 260px;max-width:380px;min-width:170px;color:var(--dct-ink-6)}",
	".dsh-ctf-searchwrap>.dsh-ctf-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:.75}",
	".dsh-ctf-searchwrap .dsh-ctf-search{max-width:none;min-width:0;flex:1;height:32px;padding-left:33px;border-radius:9px;font-size:11.5px}",
	".dsh-ctf-fselect{height:32px;border-radius:9px;font-size:11.5px;padding-top:3px;padding-bottom:3px}",
	".dsh-ctf-seg{height:32px;border-radius:9px;padding:2px}",
	".dsh-ctf-segbtn{height:26px;border-radius:7px;font-size:10.5px}",
	".dsh-ctf-toggle{height:32px;padding:0 9px;border-radius:9px;font-size:10.5px}",
	".dsh-ctf-fnote{font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
	"/* ---- 视觉 2.0：会话泳道 + 双列题卡 ---- */",
	".dsh-ctf-groups{gap:14px}",
	".dsh-ctf-group{position:relative;border-radius:18px;background:linear-gradient(180deg,color-mix(in srgb,var(--dct-line) 3%,var(--dct-panel)),color-mix(in srgb,var(--dct-panel) 88%,transparent));border:1px solid var(--dct-border);box-shadow:var(--dct-glow);overflow:hidden}",
	".dsh-ctf-group.is-current{border-color:color-mix(in srgb,var(--dct-accent) 36%,var(--dct-border))}",
	".dsh-ctf-group.is-current:before{content:'';position:absolute;left:0;top:14px;bottom:14px;width:2px;border-radius:2px;background:linear-gradient(180deg,var(--dct-accent),transparent)}",
	".dsh-ctf-grouphead{padding:11px 14px 9px;background:transparent;border-bottom:0;align-items:center}",
	".dsh-ctf-groupmain{gap:10px;flex:1 1 300px;min-width:0}",
	".dsh-ctf-groupavatar{flex:none;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:11px;background:linear-gradient(140deg,color-mix(in srgb,var(--dct-accent) 88%,#000),color-mix(in srgb,var(--dct-accent-2) 78%,#000));color:#fff;font:800 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.5px;box-shadow:0 7px 16px -10px color-mix(in srgb,var(--dct-accent) 70%,transparent)}",
	".dsh-ctf-groupavatar.is-unassigned{background:linear-gradient(140deg,#64748b,#475569);box-shadow:none}",
	".dsh-ctf-groupid{gap:2px;flex:1;min-width:0}",
	".dsh-ctf-grouptitle{font-size:13.5px;letter-spacing:-.1px}",
	".dsh-ctf-groupsub{font-size:9.5px;max-width:min(50vw,520px)}",
	".dsh-ctf-livepill{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dct-ok) 38%,transparent);background:color-mix(in srgb,var(--dct-ok) 8%,transparent);color:var(--dct-ok-ink);font:800 8px/15px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.8px}",
	".dsh-ctf-livepill span{width:5px;height:5px;border-radius:50%;background:currentColor;animation:dsh-ctf-pulse 1.6s ease-in-out infinite}",
	".dsh-ctf-groupcounts{gap:4px;margin-left:2px}",
	".dsh-ctf-grouphead .dsh-ctf-count{height:21px;padding:0 7px;border-radius:7px;background:var(--dct-input);font-size:9.5px;line-height:19px}",
	".dsh-ctf-groupactions{gap:2px;margin-left:auto}",
	".dsh-ctf-groupprogress{height:2px;margin:0 14px;border-radius:2px;background:var(--dct-soft-2);overflow:hidden}",
	".dsh-ctf-groupprogress i{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,var(--dct-ok),var(--dct-accent-2));transition:width .3s}",
	".dsh-ctf-groupbody{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px 14px 14px;align-items:stretch}",
	".dsh-ctf-groupbody>.dsh-ctf-card{height:100%}",
	".dsh-ctf-list{display:flex;flex-direction:column;gap:12px}",
	".dsh-ctf-card{position:relative;border-radius:15px;border:1px solid var(--dct-border);border-left:3px solid transparent;background:linear-gradient(180deg,color-mix(in srgb,var(--dct-card) 96%,transparent),var(--dct-card));box-shadow:var(--dct-card-shadow);overflow:hidden;transition:transform .18s,border-color .18s,box-shadow .18s}",
	".dsh-ctf-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dct-accent) 30%,var(--dct-border));box-shadow:0 16px 34px -26px rgba(16,38,74,.45)}",
	"body[data-ds-dark-theme] .dsh-ctf-card:hover{box-shadow:0 18px 36px -26px rgba(0,0,0,.95)}",
	".dsh-ctf-card.is-open{grid-column:1/-1;transform:none;border-color:color-mix(in srgb,var(--dct-accent) 48%,var(--dct-border));border-left-color:var(--dct-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dct-accent) 16%,transparent),var(--dct-glow)}",
	".dsh-ctf-card.is-running{border-left-color:var(--dct-run)}",
	".dsh-ctf-card.is-running:after{content:'';position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,var(--dct-accent),var(--dct-accent-2),transparent);background-size:200% 100%;animation:dsh-ctf-scan 2.6s linear infinite;pointer-events:none}",
	"@keyframes dsh-ctf-scan{0%{background-position:100% 0}100%{background-position:-100% 0}}",
	".dsh-ctf-card.is-solved{border-left-color:var(--dct-ok)}",
	".dsh-ctf-card.is-failed{border-left-color:var(--dct-danger)}",
	".dsh-ctf-card.is-stuck{border-left-color:var(--dct-warn)}",
	".dsh-ctf-card.is-queued{border-left-color:var(--dct-queued)}",
	".dsh-ctf-card.is-stopped{border-left-color:var(--dct-muted)}",
	".dsh-ctf-card-head{grid-template-columns:minmax(0,1fr) auto;gap:9px 10px;padding:11px 12px 10px;align-items:start}",
	".dsh-ctf-card-main{gap:6px}",
	".dsh-ctf-card-top{gap:6px}",
	".dsh-ctf-card-top .dsh-ctf-card-title{flex:none;min-width:0}",
	".dsh-ctf-card-title{display:block;font-size:14.5px;line-height:1.42;letter-spacing:-.15px;margin-top:1px;color:var(--dct-ink)}",
	".dsh-ctf-cat{background:color-mix(in srgb,var(--dct-accent) 8%,transparent);border-color:color-mix(in srgb,var(--dct-accent) 24%,var(--dct-border));color:color-mix(in srgb,var(--dct-accent) 78%,var(--dct-ink-3))}",
	".dsh-ctf-card-id{font-size:9px;padding:1px 5px;border-radius:5px;background:var(--dct-soft);border:1px solid var(--dct-soft-2);color:var(--dct-ink-6);margin-left:auto}",
	".dsh-ctf-card-metrics{gap:9px;font-size:10.5px;line-height:1.5}",
	".dsh-ctf-card-metrics .dsh-ctf-metric{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}",
	".dsh-ctf-card-metrics .dsh-ctf-icon{opacity:.55}",
	".dsh-ctf-card-metrics .dsh-ctf-metric b{font-size:11px;color:var(--dct-ink-3)}",
	".dsh-ctf-card-sub{padding:0;font-size:9.5px;line-height:1.45;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-card-event{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 8px;border-radius:8px;background:color-mix(in srgb,var(--dct-line) 5%,transparent);font-size:10px;line-height:1.45;color:var(--dct-ink-5)}",
	".dsh-ctf-card-event b{flex:none;font-size:9px;font-weight:800;letter-spacing:.3px;color:var(--dct-ink-4)}",
	".dsh-ctf-card-event span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-ctf-event-dot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--dct-accent)}",
	".dsh-ctf-card-event.k-flag .dsh-ctf-event-dot{background:var(--dct-ok)}",
	".dsh-ctf-card-event.k-flag b{color:var(--dct-ok-ink)}",
	".dsh-ctf-card-event.k-error .dsh-ctf-event-dot{background:var(--dct-danger)}",
	".dsh-ctf-card-event.k-error b{color:var(--dct-danger-ink)}",
	".dsh-ctf-card-event.k-stuck .dsh-ctf-event-dot{background:var(--dct-warn)}",
	".dsh-ctf-card-event.k-stuck b{color:var(--dct-warn-ink)}",
	".dsh-ctf-card-actions{align-items:flex-start;justify-content:flex-end;gap:4px;padding-top:1px;flex:none}",
	".dsh-ctf-card-actions .dsh-ctf-btn{height:27px;padding:0 9px;font-size:10.5px;border-radius:7px}",
	".dsh-ctf-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;padding:0;border-radius:8px;border:1px solid var(--dct-border);background:var(--dct-input);color:var(--dct-ink-5);cursor:pointer;transition:background .15s,color .15s,border-color .15s,transform .15s}",
	".dsh-ctf-iconbtn:hover{background:var(--dct-hover);border-color:var(--dct-border-strong);color:var(--dct-accent)}",
	".dsh-ctf-iconbtn.is-on{background:var(--dct-accent-soft);border-color:color-mix(in srgb,var(--dct-accent) 42%,var(--dct-border));color:var(--dct-accent)}",
	".dsh-ctf-iconbtn.is-danger:hover{color:var(--dct-danger-ink);border-color:color-mix(in srgb,var(--dct-danger) 36%,var(--dct-border));background:color-mix(in srgb,var(--dct-danger) 9%,transparent)}",
	".dsh-ctf-detailbtn .dsh-ctf-icon{transition:transform .18s}",
	".dsh-ctf-detailbtn .dsh-ctf-icon.is-open{transform:rotate(180deg)}",
	".dsh-ctf-groupactions .dsh-ctf-icon{transition:transform .18s}",
	".dsh-ctf-groupactions .dsh-ctf-iconbtn.is-collapsed .dsh-ctf-icon{transform:rotate(-90deg)}",
	".dsh-ctf-card-more{padding:8px 11px;background:color-mix(in srgb,var(--dct-line) 4%,transparent);border-top:1px dashed var(--dct-soft-2)}",
	".dsh-ctf-card-more .dsh-ctf-btn{height:26px;font-size:10.5px;padding:0 8px;border-radius:7px}",
	".dsh-ctf-card-warn{display:flex;align-items:flex-start;gap:6px;line-height:1.55;padding:7px 11px}",
	".dsh-ctf-card-warn .dsh-ctf-icon{flex:none;margin-top:1px}",
	"/* ---- 视觉 2.0：单题工作台 ---- */",
	".dsh-ctf-detail{padding:0;border-top:1px solid var(--dct-border);background:linear-gradient(180deg,color-mix(in srgb,var(--dct-line) 2%,transparent),transparent)}",
	".dsh-ctf-wb{gap:11px}",
	".dsh-ctf-wbhead{padding:0}",
	".dsh-ctf-wbmeta{gap:8px;min-height:34px;padding:6px 9px;border:1px solid var(--dct-soft-2);border-radius:10px;background:color-mix(in srgb,var(--dct-input) 76%,transparent)}",
	".dsh-ctf-wblabel{font-size:8.5px;letter-spacing:.9px}",
	".dsh-ctf-wbmeta .dsh-ctf-wbdir{font-size:10px;color:var(--dct-ink-6)}",
	".dsh-ctf-wbmeta .dsh-ctf-btn{margin-left:auto;height:25px;font-size:10px;padding:0 8px}",
	".dsh-ctf-wbtabs{gap:2px;padding:0 2px;border-bottom:1px solid var(--dct-soft-2)}",
	".dsh-ctf-wbtab{display:inline-flex;align-items:center;gap:6px;border-radius:8px 8px 0 0;padding:6px 11px;font-size:11px;color:var(--dct-ink-5)}",
	".dsh-ctf-wbtab .dsh-ctf-icon{opacity:.65}",
	".dsh-ctf-wbtab:hover{background:var(--dct-hover);color:var(--dct-ink-3)}",
	".dsh-ctf-wbtab.is-on{border-bottom-color:var(--dct-accent);background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--dct-accent) 9%,transparent));color:var(--dct-accent)}",
	".dsh-ctf-wbtab.is-on .dsh-ctf-icon{opacity:1}",
	".dsh-ctf-wbbody{padding-top:2px}",
	".dsh-ctf-detailbody{gap:11px}",
	".dsh-ctf-dirline{padding:7px 10px;background:color-mix(in srgb,var(--dct-input) 82%,transparent);gap:8px;color:var(--dct-ink-6)}",
	".dsh-ctf-dirline>span{font-size:9px;letter-spacing:.6px}",
	".dsh-ctf-dirline code{font-size:10px}",
	".dsh-ctf-detailgrid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(292px,.86fr);gap:12px;align-items:start}",
	".dsh-ctf-detailmain,.dsh-ctf-detailaside{display:flex;flex-direction:column;gap:10px;min-width:0}",
	".dsh-ctf-detailmain>.dsh-ctf-sec,.dsh-ctf-detailaside>.dsh-ctf-sec{padding:11px 12px;border:1px solid var(--dct-border);border-radius:13px;background:color-mix(in srgb,var(--dct-card) 82%,transparent);box-shadow:0 1px 1px rgba(16,38,74,.03)}",
	".dsh-ctf-detailmain>.dsh-ctf-sec:first-of-type,.dsh-ctf-detailaside>.dsh-ctf-sec:first-of-type{border-top:1px solid var(--dct-border);padding-top:11px}",
	".dsh-ctf-statement-card{padding:11px 12px;border:1px solid var(--dct-border);border-radius:13px;background:color-mix(in srgb,var(--dct-card) 82%,transparent);gap:8px}",
	".dsh-ctf-blockhead{display:flex;align-items:center;gap:7px;color:var(--dct-ink-6)}",
	".dsh-ctf-blockhead .dsh-ctf-icon{color:var(--dct-accent)}",
	".dsh-ctf-blockhead b{font-size:11.5px;color:var(--dct-ink-3)}",
	".dsh-ctf-blockhead span{margin-left:auto;font:700 8px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1.2px;color:var(--dct-ink-6)}",
	".dsh-ctf-statement-card .dsh-ctf-statement-body{max-height:250px;padding:9px 11px;border-radius:9px;font-size:12px;line-height:1.75}",
	".dsh-ctf-detailaside .dsh-ctf-kv-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 12px}",
	".dsh-ctf-detailaside .dsh-ctf-kv>span{font-size:9px}",
	".dsh-ctf-detailaside .dsh-ctf-kv>b{font-size:10px}",
	".dsh-ctf-detailmain .dsh-ctf-sec-title,.dsh-ctf-detailaside .dsh-ctf-sec-title{font-size:11px;letter-spacing:.2px;color:var(--dct-ink-3)}",
	".dsh-ctf-detailmain .dsh-ctf-sec-count,.dsh-ctf-detailaside .dsh-ctf-sec-count{font-size:9px}",
	".dsh-ctf-detailaside .dsh-ctf-facts,.dsh-ctf-detailmain .dsh-ctf-events{max-height:320px}",
	".dsh-ctf-att{padding:8px 10px;border-radius:9px;background:var(--dct-input)}",
	".dsh-ctf-att-sum{font-size:10.5px}",
	".dsh-ctf-flag{padding:7px 9px;border-radius:9px}",
	".dsh-ctf-fact{font-size:10.5px}",
	".dsh-ctf-event{font-size:10px}",
	".dsh-ctf-wbactions{gap:9px;border-top:1px solid var(--dct-soft-2);padding-top:11px}",
	".dsh-ctf-wbaction-row{gap:7px}",
	".dsh-ctf-wbflagrow{padding:9px 10px;border-radius:11px;background:color-mix(in srgb,var(--dct-input) 82%,transparent)}",
	".dsh-ctf-wbflagrow .dsh-ctf-in{height:31px;font-size:11px}",
	".dsh-ctf-wbflagrow .dsh-ctf-btn{height:29px;font-size:10.5px}",
	".dsh-ctf-wbtools{gap:3px}",
	".dsh-ctf-wbtools .dsh-ctf-btn{height:26px;font-size:10px;padding:0 7px}",
	"/* ---- 视觉 2.0：响应式 ---- */",
	"@media (max-width:1180px){.dsh-ctf-groupbody,.dsh-ctf-list{grid-template-columns:minmax(0,1fr)}.dsh-ctf-kpi em{display:none}}",
	"@media (max-width:1100px){.dsh-ctf-rail{width:64px;padding:8px;gap:10px;min-height:calc(100vh - 110px);align-items:center}.dsh-ctf-railbrand{justify-content:center;padding:0 0 6px}.dsh-ctf-railname,.dsh-ctf-railcap,.dsh-ctf-navlabel,.dsh-ctf-navcount,.dsh-ctf-railmeta,.dsh-ctf-railsession>div{display:none}.dsh-ctf-railnav{width:100%;align-items:center}.dsh-ctf-navitem{justify-content:center;width:44px;height:44px;padding:0}.dsh-ctf-railfoot{width:100%;align-items:center;padding-top:8px}.dsh-ctf-railsession{justify-content:center;padding:0}.dsh-ctf-detailgrid{grid-template-columns:minmax(0,1fr)}.dsh-ctf-detailaside .dsh-ctf-kv-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}",
	"@media (max-width:900px){.dsh-ctf-topbar{align-items:flex-start}.dsh-ctf-pagetitle{font-size:24px}.dsh-ctf-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-ctf-command{flex-direction:column;align-items:stretch}.dsh-ctf-command-progress{border-left:0;border-top:1px dashed var(--dct-soft-2);padding:10px 0 0;justify-content:flex-start}.dsh-ctf-detailaside .dsh-ctf-kv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-ctf-groupmain{flex-basis:100%}.dsh-ctf-card-head{grid-template-columns:minmax(0,1fr)}.dsh-ctf-card-actions{justify-content:flex-start;padding-top:3px}.dsh-ctf-card-actions .dsh-ctf-detailbtn{margin-left:auto}}",
	"@media (max-width:760px){.dsh-ctf-shell{flex-direction:column;gap:10px}.dsh-ctf-rail{position:static;width:100%;min-height:0;flex-direction:row;align-items:center;gap:4px;padding:5px;border-radius:14px;overflow-x:auto;scrollbar-width:none}.dsh-ctf-rail::-webkit-scrollbar{display:none}.dsh-ctf-railbrand,.dsh-ctf-railcap,.dsh-ctf-railfoot{display:none}.dsh-ctf-railnav{flex-direction:row;gap:3px;width:auto;min-width:max-content;align-items:center}.dsh-ctf-navitem{width:auto;height:34px;padding:0 10px;gap:6px}.dsh-ctf-navlabel{display:inline}.dsh-ctf-navcount{display:inline}.dsh-ctf-topbar-actions{width:100%;justify-content:flex-start}.dsh-ctf-topbar-actions .dsh-ctf-btn{flex:0 0 auto}.dsh-ctf-pagetitle{font-size:23px}.dsh-ctf-pagedesc{font-size:11.5px}.dsh-ctf-grouphead{align-items:flex-start}.dsh-ctf-groupcounts{order:5}.dsh-ctf-groupactions{width:auto;margin-left:auto}.dsh-ctf-wbmeta .dsh-ctf-wbdir{flex-basis:100%;white-space:normal;word-break:break-all;line-height:1.5}.dsh-ctf-wbmeta .dsh-ctf-btn{margin-left:auto}.dsh-ctf-wbaction-row{align-items:flex-start}.dsh-ctf-wbtools{width:100%;padding-top:4px}.dsh-ctf-detailmain>.dsh-ctf-sec,.dsh-ctf-detailaside>.dsh-ctf-sec,.dsh-ctf-statement-card{padding:10px}}",
	"@media (max-width:620px){.dsh-ctf-root{padding:8px 6px 28px}.dsh-ctf-rail{padding:4px}.dsh-ctf-navitem{height:32px;padding:0 8px;font-size:11px}.dsh-ctf-navitem .dsh-ctf-icon{width:14px;height:14px}.dsh-ctf-topbar{padding:2px 2px 0}.dsh-ctf-pagetitle{font-size:22px}.dsh-ctf-topbar-actions{gap:5px}.dsh-ctf-topbar-actions .dsh-ctf-btn{height:31px;padding:0 9px}.dsh-ctf-topbar-actions .dsh-ctf-btn-text{display:none}.dsh-ctf-topbar-actions .dsh-ctf-platform-pill span{display:none}.dsh-ctf-command{padding:10px}.dsh-ctf-kpis{gap:7px}.dsh-ctf-kpi{padding:8px 9px;gap:8px}.dsh-ctf-kpi-icon{width:27px;height:27px;border-radius:8px}.dsh-ctf-kpi-main b{font-size:20px}.dsh-ctf-kpi-main span{font-size:9.5px}.dsh-ctf-command-progress{min-width:0}.dsh-ctf-ring{width:54px;height:54px}.dsh-ctf-ring span{font-size:11px}.dsh-ctf-filters{padding:8px}.dsh-ctf-searchwrap{flex-basis:100%;max-width:none}.dsh-ctf-groupbody{padding:9px;gap:8px}.dsh-ctf-grouphead{padding:9px 10px 8px}.dsh-ctf-groupavatar{width:31px;height:31px;border-radius:9px}.dsh-ctf-card-head{padding:10px}.dsh-ctf-card-actions{justify-content:flex-start}.dsh-ctf-card-actions .dsh-ctf-detailbtn{margin-left:0}.dsh-ctf-card-id{display:none}.dsh-ctf-card-metrics{gap:8px}.dsh-ctf-detailaside .dsh-ctf-kv-grid{grid-template-columns:minmax(0,1fr)}.dsh-ctf-wbmeta{padding:6px 8px}.dsh-ctf-wbmeta .dsh-ctf-wbdir{display:none}.dsh-ctf-wbtab{padding:6px 8px;font-size:10.5px}.dsh-ctf-wbflagrow .dsh-ctf-btn{flex:1 1 100%}}",
	".dsh-ctf-flatlist{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:stretch}",
	".dsh-ctf-flatlist>.dsh-ctf-card.is-open{grid-column:1/-1}",
	".dsh-ctf-rail{min-height:520px;max-height:calc(100vh - 96px);overflow-y:auto;overflow-x:hidden;scrollbar-width:none}",
	".dsh-ctf-rail::-webkit-scrollbar{display:none}",
	"@media (max-width:1180px){.dsh-ctf-flatlist{grid-template-columns:minmax(0,1fr)}}",
	".dsh-ctf-groupbody>.dsh-ctf-card:last-child:nth-child(odd),.dsh-ctf-flatlist>.dsh-ctf-card:last-child:nth-child(odd){grid-column:1/-1}",
	"@media (max-width:760px){.dsh-ctf-rail{min-height:0!important;max-height:none;overflow-x:auto;overflow-y:hidden}.dsh-ctf-groupbody>.dsh-ctf-card:last-child:nth-child(odd),.dsh-ctf-flatlist>.dsh-ctf-card:last-child:nth-child(odd){grid-column:auto}}",
	".dsh-ctf-rail{height:min(620px,calc(100vh - 280px));min-height:480px;max-height:620px}",
	".dsh-ctf-card-event{align-self:flex-start;max-width:100%;width:fit-content}",
	"@media (max-width:760px){.dsh-ctf-rail{height:auto!important;min-height:0!important;max-height:none!important}}",
	".dsh-ctf-subhead-title{font-size:13.5px;font-weight:800;color:var(--dct-ink-2);letter-spacing:-.1px}",
	".dsh-ctf-pagehead{align-items:flex-end}",
	".dsh-ctf-main{container-type:inline-size;container-name:ctfmain}",
	"@container ctfmain (max-width:1080px){.dsh-ctf-groupbody,.dsh-ctf-flatlist{grid-template-columns:minmax(0,1fr)}.dsh-ctf-groupbody>.dsh-ctf-card:last-child:nth-child(odd),.dsh-ctf-flatlist>.dsh-ctf-card:last-child:nth-child(odd){grid-column:auto}}",
	".dsh-ctf-kpis-report{grid-template-columns:repeat(3,minmax(0,1fr))}",
	"@media (max-width:900px){.dsh-ctf-kpis-report{grid-template-columns:repeat(2,minmax(0,1fr))}}",
	".dsh-ctf-empty-extra{width:100%;max-width:760px;margin-top:6px}",
	".dsh-ctf-empty-hints{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;width:100%}",
	".dsh-ctf-empty-hint{display:flex;flex-direction:column;gap:2px;padding:9px 10px;border:1px solid var(--dct-border);border-radius:10px;background:color-mix(in srgb,var(--dct-input) 80%,transparent);text-align:left}",
	".dsh-ctf-empty-hint b{font:800 8.5px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1px;color:var(--dct-accent)}",
	".dsh-ctf-empty-hint span{font-size:11.5px;font-weight:700;color:var(--dct-ink-3)}",
	".dsh-ctf-empty-hint em{font-style:normal;font-size:10px;line-height:1.45;color:var(--dct-ink-6)}",
	".dsh-ctf-page,.dsh-ctf-wb{animation:dsh-ctf-rise .24s ease both}",
	"@keyframes dsh-ctf-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
	".dsh-ctf-root ::-webkit-scrollbar{width:8px;height:8px}",
	".dsh-ctf-root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dct-ink-6) 28%,transparent);border-radius:999px}",
	".dsh-ctf-root ::-webkit-scrollbar-track{background:transparent}",
	"@media (max-width:620px){.dsh-ctf-empty-hints{grid-template-columns:minmax(0,1fr)}}",
	".dsh-ctf-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px}",
	".dsh-ctf-btn.is-ghost.is-danger:hover{background:color-mix(in srgb,var(--dct-danger) 12%,transparent)}"
].join("\n");
function installStyles() {
	var style = document.createElement("style");
	style.id = "dsh-ctf-style";
	style.textContent = CSS;
	document.head.appendChild(style);
	return function () { style.remove(); };
}

// ---- 内联图标：避免额外依赖，统一线宽与视觉尺寸 ----
var ICON_DEFS = {
	target: [["circle", { cx: 12, cy: 12, r: 8 }], ["circle", { cx: 12, cy: 12, r: 3 }], ["path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3" }]],
	board: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.6 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.6 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.6 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.6 }]],
	platform: [["path", { d: "M9 7H7a5 5 0 0 0 0 10h2" }], ["path", { d: "M15 7h2a5 5 0 0 1 0 10h-2" }], ["path", { d: "M8 12h8" }]],
	schedule: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
	ledger: [["path", { d: "M5 6h14M5 12h14M5 18h9" }], ["circle", { cx: 18, cy: 18, r: 2.2 }]],
	report: [["path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" }], ["path", { d: "M14 3v6h6M8 13h8M8 17h6" }]],
	knowledge: [["path", { d: "M4 19.2A2.8 2.8 0 0 1 6.8 16.4H20" }], ["path", { d: "M6.8 2H20v20H6.8A2.8 2.8 0 0 1 4 19.2V4.8A2.8 2.8 0 0 1 6.8 2z" }], ["path", { d: "M8 6h8" }]],
	memory: [["ellipse", { cx: 12, cy: 5.5, rx: 7.5, ry: 3 }], ["path", { d: "M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" }], ["path", { d: "M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" }]],
	settings: [["path", { d: "M4 7h7M15 7h5M4 17h5M13 17h7" }], ["circle", { cx: 13, cy: 7, r: 2.2 }], ["circle", { cx: 11, cy: 17, r: 2.2 }]],
	refresh: [["path", { d: "M20 11a8 8 0 1 0-2.3 6.3" }], ["path", { d: "M20 4v7h-7" }]],
	plus: [["path", { d: "M12 5v14M5 12h14" }]],
	chevron: [["path", { d: "M6 9l6 6 6-6" }]],
	more: [["circle", { cx: 5, cy: 12, r: 1.5, fill: "currentColor", stroke: "none" }], ["circle", { cx: 12, cy: 12, r: 1.5, fill: "currentColor", stroke: "none" }], ["circle", { cx: 19, cy: 12, r: 1.5, fill: "currentColor", stroke: "none" }]],
	play: [["path", { d: "M8 5l11 7-11 7z", fill: "currentColor", stroke: "none" }]],
	stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: "currentColor", stroke: "none" }]],
	retry: [["path", { d: "M4 12a8 8 0 1 0 2.3-6.3" }], ["path", { d: "M4 4v7h7" }]],
	download: [["path", { d: "M12 3v12M7 10l5 5 5-5M5 21h14" }]],
	search: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "M16.5 16.5L21 21" }]],
	flag: [["path", { d: "M5 21V4M5 4h11l-2 4 2 4H5" }]],
	targetArrow: [["circle", { cx: 12, cy: 12, r: 8 }], ["path", { d: "M12 8v8M8 12h8" }]],
	alert: [["path", { d: "M12 3l9 16H3z" }], ["path", { d: "M12 9v4M12 16.5v.5" }]],
	folder: [["path", { d: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]],
	check: [["path", { d: "M20 6L9 17l-5-5" }]],
	clock: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]]
};
function Icon(props) {
	var name = props && props.name;
	var defs = ICON_DEFS[name] || ICON_DEFS.target;
	var size = props && props.size ? props.size : 16;
	return h("svg", {
		viewBox: "0 0 24 24", width: size, height: size, fill: "none",
		stroke: "currentColor", strokeWidth: props && props.strokeWidth ? props.strokeWidth : 1.7,
		strokeLinecap: "round", strokeLinejoin: "round",
		className: "dsh-ctf-icon" + (props && props.className ? " " + props.className : ""),
		"aria-hidden": "true", focusable: "false"
	}, defs.map(function (d, i) { var attrs = Object.assign({}, d[1]); attrs.key = "p-" + i; return h(d[0], attrs); }));
}

// ---- 小组件（无 hook，纯渲染）----
function Stat(props) {
	return h("div", { className: "dsh-ctf-stat" + (props.tone ? " is-" + props.tone : "") },
		h("i", { "aria-hidden": "true" }),
		h("b", null, String(props.value == null ? 0 : props.value)),
		h("span", null, props.label));
}
function Kpi(props) {
	var tone = props.tone ? " is-" + props.tone : "";
	return h("div", { className: "dsh-ctf-kpi" + tone },
		h("div", { className: "dsh-ctf-kpi-icon" }, h(Icon, { name: props.icon || "target", size: 15 })),
		h("div", { className: "dsh-ctf-kpi-main" },
			h("span", null, props.label),
			h("b", null, String(props.value == null ? 0 : props.value))),
		props.hint ? h("em", null, props.hint) : null);
}
function ProgressRing(props) {
	var value = Math.max(0, Math.min(100, Math.round(Number(props.value) || 0)));
	return h("div", { className: "dsh-ctf-ring", style: { "--dct-pct": value + "%" }, title: value + "%" },
		h("span", null, value + "%"));
}
function Badge(props) {
	var status = props.status || "queued";
	return h("span", { className: "dsh-ctf-badge is-" + (STATUS_TONE[status] || "queued") },
		h("i", null), props.label || STATUS_LABEL[status] || status);
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
	{ key: "unsolved", label: "未解" },
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
			if (r && r.ok) {
				var storage = r.storage || {}, memory = storage.memory || {}, usage = storage.knowledgeUsage || {};
				var issue = memory.migrationError || memory.readError || memory.writeError || usage.readError || usage.writeError;
				setSnap(r);
				setErr(r.persistence && r.persistence.dirty ? "状态尚未保存到磁盘；请勿重复操作，后台正在重试保存。" : issue ? issue.message || "学习数据存储异常，原文件已保留。" : r.localProjectionPending ? "有本地文件等待恢复同步，相关题目暂不能移除或沉淀。" : "");
				setUpdatedAt(Date.now());
			}
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

// 统一空状态：图标 + 标题 + 说明 + 可选操作。
function emptyState(opts) {
	var o = opts || {};
	return h("div", {
		className: "dsh-ctf-empty" + (o.slim ? " is-slim" : ""),
		role: o.role || undefined,
		"aria-live": o.live || undefined
	},
		h("div", { className: "dsh-ctf-empty-icon", "aria-hidden": "true" }, o.icon || "◇"),
		h("b", { className: "dsh-ctf-empty-title" }, o.title || ""),
		o.desc ? h("div", { className: "dsh-ctf-empty-desc" }, o.desc) : null,
		o.actions && o.actions.length ? h("div", { className: "dsh-ctf-empty-actions" }, o.actions) : null,
		o.extra ? h("div", { className: "dsh-ctf-empty-extra" }, o.extra) : null);
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
	var submissions = ch.submissionJournal || [];
	var environmentJournal = ch.environmentJournal || [];
	var budget = [];
	if (ch.budget && ch.budget.maxAttempts != null) budget.push("尝试 " + ch.budget.maxAttempts + " 次");
	if (ch.budget && ch.budget.timeBudgetMs) budget.push("时长 " + fmtDur(ch.budget.timeBudgetMs));
	var platform = "";
	if (ch.platform) platform = String(ch.platform.name || ch.platform.kind || "");
	if (platform && ch.platform.challengeId) platform += " #" + ch.platform.challengeId;
	return h("div", { className: "dsh-ctf-detailbody" },
		ch.lifecycle && ch.lifecycle.submission === "unknown" ? h("div", { className: "dsh-ctf-error is-inline is-warn" }, "有 " + (ch.lifecycle.unresolvedSubmissions || 1) + " 条提交结果待核对，自动提交与环境清理已暂停。") : null,
		ch.lifecycle && ch.lifecycle.environmentOperationPending ? h("div", { className: "dsh-ctf-error is-inline is-warn" }, "环境操作结果待核对，新的解题任务和环境清理已暂停。") : null,
		ch.lifecycle && ch.lifecycle.localProjectionPending ? h("div", { className: "dsh-ctf-error is-inline is-warn" },
			"本地文件等待恢复同步：" + ((ch.localProjection && ch.localProjection.errors) || []).map(function (error) { return error.message || error.code; }).join("；")) : null,
		ch.stuckReason ? h("div", { className: "dsh-ctf-error is-inline is-warn" },
			h(Icon, { name: "alert", size: 15 }),
			h("span", null, "卡点：" + ch.stuckReason)) : null,
		ch.dir ? h("div", { className: "dsh-ctf-dirline" },
			h(Icon, { name: "folder", size: 14 }),
			h("span", null, "工作目录"),
			h("code", { title: String(ch.dir) }, ch.dir)) : null,
		h("div", { className: "dsh-ctf-detailgrid" },
			h("div", { className: "dsh-ctf-detailmain" },
				ch.statement ? h("div", { className: "dsh-ctf-statement dsh-ctf-statement-card" },
					h("div", { className: "dsh-ctf-blockhead" },
						h(Icon, { name: "report", size: 15 }),
						h("b", null, "题面"),
						h("span", null, "STATEMENT")),
					h("div", { className: "dsh-ctf-statement-body" }, ch.statement)) : null,
				attemptsSection(attempts),
				eventsSection(events)),
			h("aside", { className: "dsh-ctf-detailaside" },
				flagsSection(flags),
				environmentJournal.length ? h("div", { className: "dsh-ctf-sec" },
					h(SecTitle, { title: "环境操作记录", count: environmentJournal.length }),
					environmentJournal.slice(-10).reverse().map(function (entry) {
						var result = entry.result || {};
						return h("div", { key: entry.operationId, className: "dsh-ctf-wufact" },
							h("b", null, entry.action + " · " + ({ prepared: "准备中", sending: "执行中", unknown: "待核对", completed: "已完成", cancelled: "未发送" }[entry.phase] || entry.phase)),
							h("div", null, fmtTime(entry.createdAt) + (entry.resolution ? " · 已按平台观测收口" : result.error ? " · " + result.error : "")));
					})) : null,
				submissions.length ? h("div", { className: "dsh-ctf-sec" },
					h(SecTitle, { title: "平台提交记录", count: submissions.length }),
					submissions.slice(-10).reverse().map(function (entry) {
						var result = entry.resolution || entry.result || {};
						var phase = { prepared: "准备中", sending: "提交中", unknown: "结果待核对", completed: "已完成", cancelled: "未发送" }[entry.phase] || entry.phase;
						return h("div", { key: entry.submissionId, className: "dsh-ctf-wufact" },
							h("b", null, phase + (result.status ? " · " + result.status : "")),
							h("div", null, fmtTime(entry.createdAt) + " · " + String(result.message || result.error || "")),
							entry.applied === false ? h("div", null, "本地状态待恢复" + (entry.applyError ? "：" + entry.applyError : "")) : null);
					})) : null,
				factsSection(facts),
				h("div", { className: "dsh-ctf-sec dsh-ctf-metasec" },
					h(SecTitle, { title: "元信息", count: 7 }),
					h("div", { className: "dsh-ctf-kv-grid" },
						h(KV, { k: "目标地址", v: ch.target }),
						h(KV, { k: "平台", v: platform || "（未接入）" }),
						h(KV, { k: "发起会话", v: ch.driverSession || "—" }),
						h(KV, { k: "预算", v: budget.join(" · ") || "—" }),
						h(KV, { k: "创建时间", v: fmtTime(ch.createdAt) }),
						h(KV, { k: "开始时间", v: fmtTime(ch.startedAt) }),
						h(KV, { k: "结束时间", v: fmtTime(ch.endedAt) }))))));
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
	var retryRequiredS = useState(false), retryRequired = retryRequiredS[0], setRetryRequired = retryRequiredS[1];
	var allowRetryS = useState(false), allowRetry = allowRetryS[0], setAllowRetry = allowRetryS[1];
	var acceptEnvironmentS = useState(false), acceptEnvironment = acceptEnvironmentS[0], setAcceptEnvironment = acceptEnvironmentS[1];
	var unresolved = retryRequired || (ch.lifecycle && ch.lifecycle.submission === "unknown");

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
		setRetryRequired(false);
		setAllowRetry(false);
		setAcceptEnvironment(false);
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
		if (readOnly || submitBusy) return;
		var v = flag.trim();
		if (!v) { say("请填写要提交的 flag", true); return; }
		if (unresolved && !allowRetry) { say("请先核对平台结果；仍需重提时勾选允许重复提交。", true); return; }
		setSubmitBusy(true);
		request("platform.submit", { id: id, flag: v, retryUnknown: allowRetry, sessionId: sessionId }).then(function (r) {
			setSubmitBusy(false);
			setAllowRetry(false);
			if (r && r.code === "SUBMISSION_UNRESOLVED") setRetryRequired(true);
			onChanged();
			if (r && r.ok) {
				setFlag("");
				say("平台提交：" + (r.status ? String(r.status) : "ok") + (r.message ? " · " + r.message : ""));
			} else say((r && r.error) || "平台提交失败", true);
		});
	}
	function reconcileSubmission() {
		if (readOnly || submitBusy) return;
		setSubmitBusy(true);
		request("platform.submission.reconcile", { id: id, sessionId: sessionId }).then(function (r) {
			setSubmitBusy(false);
			if (r && r.resolved) { setRetryRequired(false); setAllowRetry(false); }
			say((r && (r.message || r.error)) || "平台核对失败", !r || !r.ok);
			onChanged();
		});
	}
	function reconcileEnvironment() {
		if (readOnly || submitBusy) return;
		setSubmitBusy(true);
		request("platform.env", { id: id, action: "status", acceptObservedState: acceptEnvironment, sessionId: sessionId }).then(function (r) {
			setSubmitBusy(false); setAcceptEnvironment(false);
			say(r && r.ok ? "环境核对：" + (r.observed || "未知") + "，仍待核对 " + (r.unresolved || 0) + " 条" : r && r.error || "环境核对失败", !r || !r.ok);
			onChanged();
		});
	}
	function retryLocalSync() {
		if (readOnly || submitBusy) return;
		setSubmitBusy(true);
		request("challenge.sync", { id: id, sessionId: sessionId }).then(function (r) {
			setSubmitBusy(false);
			say(r && r.ok ? "本地文件已同步" : r && r.error || "同步仍未完成，请检查文件权限及格式", !r || !r.ok);
			onChanged();
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
		{ key: "overview", label: "概览", icon: "board" },
		{ key: "files", label: "附件 " + counts.files, icon: "folder" },
		{ key: "notes", label: "笔记", icon: "report" },
		{ key: "scripts", label: "脚本 " + counts.scripts, icon: "settings" },
		{ key: "artifacts", label: "产物 " + counts.artifacts, icon: "download" }
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

	var wbPrimary = null;
	if (!readOnly) {
		if (status === "running") {
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-danger", onClick: function () { onAction("stop"); } }, h(Icon, { name: "stop", size: 13 }), "停止");
		} else if (status === "solved") {
			wbPrimary = onWriteup ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", onClick: onWriteup }, h(Icon, { name: "download", size: 13 }), "导出 Writeup") : null;
		} else if (status === "queued" || (status === "stopped" && !(ch.attempts || []).length)) {
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", onClick: function () { onAction("start"); } }, h(Icon, { name: "play", size: 13 }), "开始解题");
		} else {
			var again = status === "stuck" ? "再试一次" : status === "stopped" ? "继续尝试" : "重试";
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", onClick: function () { onAction("retry"); } }, h(Icon, { name: "retry", size: 13 }), again);
		}
	}
	return h("div", { className: "dsh-ctf-wb" },
		h("div", { className: "dsh-ctf-wbhead" },
			h("div", { className: "dsh-ctf-wbmeta" },
				h("span", { className: "dsh-ctf-wblabel" }, "工作台"),
				ch.category ? h("span", { className: "dsh-ctf-chip" }, CATEGORY_LABEL[ch.category] || ch.category) : null,
				ch.target ? h("span", { className: "dsh-ctf-svcwd", title: String(ch.target) }, "目标 " + String(ch.target)) : null,
				h("span", { className: "dsh-ctf-wbdir", title: dir || ch.dir || "" }, "目录 " + (dir || ch.dir || "—")),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: copyDir, title: "复制工作目录路径" }, "复制目录"))),
		wbErr ? h("div", { className: "dsh-ctf-error is-inline" },
			h("span", null, wbErr),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: refreshTree }, "重试")) : null,
		h("div", { className: "dsh-ctf-wbtabs", role: "tablist", "aria-label": "工作台分页" }, tabs.map(function (t) {
			return h("button", {
				key: t.key, type: "button", role: "tab",
				"aria-selected": tab === t.key,
				className: "dsh-ctf-wbtab" + (tab === t.key ? " is-on" : ""),
				onClick: function () { setTab(t.key); setRead(null); setReadErr(""); }
			}, h(Icon, { name: t.icon, size: 14 }), h("span", null, t.label));
		})),
		h("div", { className: "dsh-ctf-wbbody" }, body),
		h("div", { className: "dsh-ctf-wbactions" },
			h("div", { className: "dsh-ctf-wbaction-row" },
				h("div", { className: "dsh-ctf-wbmain-actions" },
					wbPrimary,
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: copyDir }, h(Icon, { name: "folder", size: 14 }), "复制目录")),
				readOnly ? h("span", { className: "dsh-ctf-wbnote" }, "只读工作台：请在会话视图中开始解题或编辑笔记。") : h("div", { className: "dsh-ctf-wbtools" },
					h("span", { className: "dsh-ctf-wblabel" }, "工具"),
					!onWriteup ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: status !== "solved", onClick: onWriteup, title: status === "solved" ? "导出该题 Writeup" : "解出后才能导出 Writeup" }, h(Icon, { name: "download", size: 14 }), "导出 Writeup"),
					!onProbe ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: onProbe, title: "探测靶机/目标是否就绪" }, h(Icon, { name: "targetArrow", size: 14 }), "探测目标"),
					!onReview ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: status !== "solved", onClick: onReview, title: "独立复核该题 flag" }, h(Icon, { name: "check", size: 14 }), "复核"),
					!onPack ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: status !== "solved", onClick: onPack, title: "打包 Writeup（tar.gz）" }, h(Icon, { name: "download", size: 14 }), "打包 WP"),
					!onDelete ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost is-danger", onClick: onDelete, title: "从题板移除（工作目录保留）" }, h(Icon, { name: "alert", size: 14 }), "删除题目"))),
			readOnly ? null : h("div", { className: "dsh-ctf-wbflagrow" },
				h("span", { className: "dsh-ctf-wblabel" }, "提交 flag"),
				!ch.platform ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: submitBusy, onClick: reconcileSubmission }, "核对平台结果"),
				!ch.lifecycle || !ch.lifecycle.localProjectionPending ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: submitBusy, onClick: retryLocalSync }, "重试文件同步"),
				!ch.platform || ch.platform.kind !== "dasctf" ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: submitBusy, onClick: reconcileEnvironment }, "核对环境"),
				!ch.lifecycle || !ch.lifecycle.environmentOperationPending ? null : h("label", { className: "dsh-ctf-wbnote" },
					h("input", { type: "checkbox", checked: acceptEnvironment, onChange: function (e) { setAcceptEnvironment(e.target.checked); } }), "以平台当前状态收口待核对操作"),
				!unresolved ? null : h("label", { className: "dsh-ctf-wbnote" },
					h("input", { type: "checkbox", checked: allowRetry, onChange: function (e) { setAllowRetry(e.target.checked); } }), "允许重复提交（可能重复计次）"),
				h("div", { className: "dsh-ctf-wbflag" },
					h("input", {
						className: "dsh-ctf-in", placeholder: "需平台已配置且题目已导入",
						value: flag, onChange: function (e) { setFlag(e.target.value); setAllowRetry(false); },
						onKeyDown: function (e) { if (e.key === "Enter") submitFlag(); },
						"aria-label": "flag"
					}),
					h("button", {
						type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: submitBusy || !flag.trim(), onClick: submitFlag
					}, submitBusy ? "提交中…" : "提交到平台")))));

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
	var slugS = useState(""), platformSlug = slugS[0], setPlatformSlug = slugS[1];
	var mcpUrlS = useState(""), mcpUrl = mcpUrlS[0], setMcpUrl = mcpUrlS[1];
	var profileS = useState(""), profileText = profileS[0], setProfileText = profileS[1];
	var busyS = useState(""), busy = busyS[0], setBusy = busyS[1];
	var pulledS = useState(null), pulled = pulledS[0], setPulled = pulledS[1];
	var selectedS = useState({}), selected = selectedS[0], setSelected = selectedS[1];
	var resultS = useState(null), result = resultS[0], setResult = resultS[1];

	function loadConfig() {
		request("platform.config.get", {}).then(function (r) {
			if (r && r.ok && r.platform) { setCfg(r.platform); setBaseUrl(r.platform.baseUrl || ""); setKind(r.platform.kind || "ctfd"); setPlatformSlug(r.platform.platformSlug || ""); setMcpUrl(r.platform.mcpUrl || ""); setProfileText(r.platform.profile ? JSON.stringify(r.platform.profile, null, 2) : ""); }
			else say((r && r.error) || "读取平台配置失败", true);
		});
	}
	useEffect(function () { loadConfig(); }, []);
	function detectPlatformType() {
		setBusy("detect");
		request("platform.detect", { baseUrl: baseUrl.trim(), apiToken: token.trim() || undefined, platformSlug: platformSlug.trim() || undefined, mcpUrl: mcpUrl.trim() || undefined, apply: true }).then(function (r) {
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
		var payload = { kind: kind, platformSlug: platformSlug.trim(), mcpUrl: mcpUrl.trim() };
		payload.baseUrl = baseUrl.trim();
		if (token.trim()) payload.apiToken = token.trim();
		if (kind === "generic" || kind === "dasctf") {
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
	function fetchNextBatch() {
		setBusy("next");
		request("pipeline.run", { limit: (cfg && cfg.autoFetchLimit) || 5, start: true, sessionId: sessionId }).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				say("拉取下一批：新增 " + (r.imported || 0) + "，跳过 " + ((r.skipped || []).length) + (r.note ? "（" + r.note + "）" : ""));
				if (props.onImported) props.onImported();
				if ((r.imported || 0) === 0) setPulled({ challenges: [], error: "" });
			} else say((r && r.error) || "拉取下一批失败", true);
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
				h("div", { className: "dsh-ctf-subhead-title" }, "接入配置"),
				h("div", { className: "dsh-ctf-pagesub" },
					(kind === "dasctf" ? "DASCTF 开放 API（MCP/REST）" : kind === "generic" ? "通用 JSON 适配器" : "CTFd 标准 API") + " · " + statusLine + (cfg && cfg.tokenSet ? " · Token 已设置" + (cfg.tokenHint ? "（尾号 " + cfg.tokenHint + "）" : "") : " · Token 未设置"))),
			h("div", { className: "dsh-ctf-head-actions" },
				h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: !!busy, onClick: function () { testConnection(false); } }, busy === "test" ? "测试中…" : "测试连接"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: detectPlatformType }, busy === "detect" ? "探测中…" : "自动探测平台"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: props.onClose }, "收起"))),
		h("div", { className: "dsh-ctf-platgrid" },
			h("label", { className: "dsh-ctf-field" },
				h("span", null, "适配器模式"),
				h("select", { className: "dsh-ctf-in", value: kind, onChange: function (e) { setKind(e.target.value); } },
					h("option", { value: "ctfd" }, "CTFd（标准 API）"),
					h("option", { value: "generic" }, "通用 JSON（任意平台，需填 profile）"),
					h("option", { value: "dasctf" }, "DASCTF 开放 API（REST，Bearer Token）"))),
			h("label", { className: "dsh-ctf-field" },
				h("span", null, "平台地址（baseUrl）"),
				h("input", {
					className: "dsh-ctf-in", placeholder: "https://ctfd.example.com",
					value: baseUrl, onChange: function (e) { setBaseUrl(e.target.value); }
				})),
			kind !== "dasctf" ? null : h("label", { className: "dsh-ctf-field" },
				h("span", null, "MCP 地址（DASCTF，可留空用默认）"),
				h("input", {
					className: "dsh-ctf-in", placeholder: "https://ctf2.dasctf.com/api/ai/v1/mcp",
					value: mcpUrl, onChange: function (e) { setMcpUrl(e.target.value); }
				})),
			h("label", { className: "dsh-ctf-field" },
				h("span", null, (kind === "dasctf" ? "CTF2_AGENT_TOKEN" : "API Token") + (cfg && cfg.tokenSet ? "（已设置，留空保持不变）" : "")),
				h("input", {
					className: "dsh-ctf-in", type: "password", placeholder: cfg && cfg.tokenSet ? "已设置，输入新 token 可替换" : (kind === "dasctf" ? "粘贴 CTF2_AGENT_TOKEN（Bearer）" : "粘贴 CTFd API Token"),
					value: token, onChange: function (e) { setToken(e.target.value); }
				}))),
			(kind !== "generic") ? null : h("label", { className: "dsh-ctf-field" },
				h("span", null, kind === "dasctf" ? "路径覆盖 JSON（可选：{\"paths\":{\"me\":\"/agent/me/{platform}\",\"list\":\"/agent/challenges/{platform}\"}}）" : "Profile JSON（列表/详情/提交路径 + 字段映射）"),
				h("textarea", {
					className: "dsh-ctf-in dsh-ctf-pathbox", rows: 6, value: profileText,
					placeholder: '{"listPath":"/api/challenges","detailPath":"/api/challenges/{id}","submitPath":"/api/challenges/{id}/submit","map":{"list":{"dataPath":"data"},"submit":{"statusPath":"data.status","okStatuses":["correct"]}}}',
					onChange: function (e) { setProfileText(e.target.value); }
				}),
				h("span", { className: "dsh-ctf-muted" }, kind === "dasctf" ? "Bearer 鉴权；路径不确定可先点「自动探测平台」，探测结果的 paths 会自动填入。" : "Token 会以 Bearer 头发送；附件自动下载不支持，导入时请在题面/平台手动下载。")),
		h("div", { className: "dsh-ctf-platrow" },
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: !!busy, onClick: saveConfig }, busy === "save" ? "保存中…" : "保存配置"),
			cfg && cfg.tokenSet ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: clearToken }, "清除 Token") : null,
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: !!busy, onClick: pullChallenges }, busy === "pull" ? "拉取中…" : "拉取题板")),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: !!busy, onClick: fetchNextBatch }, busy === "next" ? "拉取中…" : "拉取下一批"),
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
	var groupModeS = useState("category"), groupMode = groupModeS[0], setGroupMode = groupModeS[1];
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
	var memTechS = useState(""), memTech = memTechS[0], setMemTech = memTechS[1];
	var schedDataS = useState(null), schedData = schedDataS[0], setSchedData = schedDataS[1];
	var kbStatsS = useState(null), kbStats = kbStatsS[0], setKbStats = kbStatsS[1];
	var kbPreviewS = useState(null), kbPreview = kbPreviewS[0], setKbPreview = kbPreviewS[1];
	var kbSourceS = useState(""), kbSource = kbSourceS[0], setKbSource = kbSourceS[1];
	var kbImpLogS = useState(null), kbImpLog = kbImpLogS[0], setKbImpLog = kbImpLogS[1];
	var kbDropOverS = useState(false), kbDropOver = kbDropOverS[0], setKbDropOver = kbDropOverS[1];
	var confirmS = useState(""), confirm = confirmS[0], setConfirm = confirmS[1];
	var moreCardS = useState(""), moreCard = moreCardS[0], setMoreCard = moreCardS[1];
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
		var solved = c.status === "solved";
		var isBusy = !!busy;
		var mine = !!(sessionId && c.driverSession === sessionId);
		var moreOpen = moreCard === c.id;
		var unstarted = c.status === "stopped" && !c.attempts;
		var sub = [c.slug ? "slug " + c.slug : "", c.target ? "目标 " + c.target : ""].filter(Boolean).join(" · ");
		function act(fn) {
			return function () { setMoreCard(""); fn(); };
		}
		function toggleMore() { setMoreCard(moreOpen ? "" : c.id); }
		var primary = null;
		if (!allScope) {
			if (running) {
				primary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-danger", disabled: isBusy, onClick: act(function () { doAction("stop", c); }) },
					h(Icon, { name: "stop", size: 13 }), "停止");
			} else if (solved) {
				primary = c.verified ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", onClick: act(function () { exportWriteup(c); }) },
					h(Icon, { name: "download", size: 13 }), "Writeup") : null;
			} else if (c.status === "queued" || unstarted) {
				primary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: isBusy, onClick: act(function () { doAction("start", c); }) },
					h(Icon, { name: "play", size: 13 }), "开始");
			} else {
				var retryLabel = c.status === "stuck" ? "再试一次" : c.status === "stopped" ? "继续" : "重试";
				primary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: isBusy, onClick: act(function () { doAction("retry", c); }) },
					h(Icon, { name: "retry", size: 13 }), retryLabel);
			}
		}
		var secondary = [];
		if (!allScope) {
			secondary.push(h("button", {
				type: "button", className: "dsh-ctf-btn is-sm is-ghost",
				onClick: act(function () { copyChallengeDir(c); }), title: "复制工作目录路径"
			}, h(Icon, { name: "folder", size: 14 }), "复制目录"));
			if (c.verified && solved && !primary) {
				secondary.push(h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: act(function () { exportWriteup(c); }) }, h(Icon, { name: "download", size: 14 }), "导出 Writeup"));
			}
			if (c.verified) {
				secondary.push(h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: act(function () { reviewChallenge(c); }), title: "独立复核该题 flag" }, h(Icon, { name: "check", size: 14 }), "复核 flag"));
				secondary.push(h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: act(function () { packChallenge(c); }), title: "打包 Writeup（tar.gz）" }, h(Icon, { name: "download", size: 14 }), "打包 WP"));
			}
			secondary.push(h("button", {
				type: "button", className: "dsh-ctf-btn is-sm is-ghost is-danger" + (confirm === "del:" + c.id ? " is-on" : ""),
				title: "从题板移除（工作目录保留）",
				onClick: function () { setMoreCard(c.id); deleteChallenge(c, false); }
			}, h(Icon, { name: "alert", size: 14 }), confirm === "del:" + c.id ? "确认删除" : "删除题目"));
		}
		var ev = c.lastEvent;
		return h("div", {
			key: c.id,
			className: "dsh-ctf-card" + (open ? " is-open" : "") + (c.status ? " is-" + c.status : "")
		},
			h("div", { className: "dsh-ctf-card-head" },
				h("div", { className: "dsh-ctf-card-main" },
					h("div", { className: "dsh-ctf-card-top" },
						h(Badge, { status: c.status, label: unstarted ? "未开始" : "" }),
						c.category ? h("span", { className: "dsh-ctf-chip dsh-ctf-cat" }, CATEGORY_LABEL[c.category] || c.category) : null,
						allScope && c.workspace ? h("span", { className: "dsh-ctf-chip", title: String(c.workspace) }, "工作区 " + String(c.workspace).split(/[\\/]/).pop()) : null,
						mine ? h("span", { className: "dsh-ctf-chip is-mine" }, "本会话") : null,
						h("span", { className: "dsh-ctf-card-id", title: "题目 ID " + c.id }, c.id)),
					h("b", { className: "dsh-ctf-card-title", title: c.title }, c.title || "(未命名)"),
					h("div", { className: "dsh-ctf-card-metrics" },
						h("span", { className: "dsh-ctf-metric" }, h(Icon, { name: "clock", size: 12 }), c.status === "queued" ? "排队中" : "耗时 ", c.status === "queued" ? null : h("b", null, fmtDur(elapsedOf(c)))),
						running && c.remainingMs != null
							? h("span", { className: "dsh-ctf-metric dsh-ctf-countdown" + (c.phase === "wrapup" ? " is-wrapup" : "") }, h(Icon, { name: "clock", size: 12 }), (c.phase === "wrapup" ? "结算中 " : "剩余 ") + fmtDur(c.remainingMs))
							: null,
						h("span", { className: "dsh-ctf-metric" }, "尝试 ", h("b", null, String(c.attempts || 0))),
						h("span", { className: "dsh-ctf-metric" }, "flag ", h("b", null, String(c.flags || 0))),
						c.targetStatus ? h("span", { className: "dsh-ctf-pill " + (c.targetStatus.ok ? "is-ok" : "is-warn"), title: c.targetStatus.error || "" }, c.targetStatus.ok ? "靶机就绪" : "目标" + c.targetStatus.state) : null,
						c.estCost > 0 ? h("span", { className: "dsh-ctf-metric" }, "费用 ", h("b", null, "¥" + Number(c.estCost).toFixed(3))) : null),
					sub ? h("div", { className: "dsh-ctf-card-sub" }, sub) : null,
					ev ? h("div", { className: "dsh-ctf-card-event k-" + (ev.kind || "note"), title: ev.text },
						h("span", { className: "dsh-ctf-event-dot" }),
						h("b", null, EVENT_LABEL[ev.kind] || ev.kind || "动作"),
						h("span", null, ev.text || "")) : null),
				h("div", { className: "dsh-ctf-card-actions" },
					primary,
					h("button", {
						type: "button", className: "dsh-ctf-iconbtn dsh-ctf-detailbtn",
						"aria-expanded": open, title: open ? "收起详情" : "展开详情", "aria-label": open ? "收起详情" : "展开详情",
						onClick: function () { toggle(c.id); }
					}, h(Icon, { name: "chevron", size: 17, className: open ? "is-open" : "" })),
					allScope ? null : h("button", {
						type: "button", className: "dsh-ctf-iconbtn" + (moreOpen ? " is-on" : ""),
						"aria-expanded": moreOpen, title: "更多操作", "aria-label": "更多操作",
						onClick: toggleMore
					}, h(Icon, { name: "more", size: 17 })))),
			moreOpen ? h("div", { className: "dsh-ctf-card-more" }, secondary) : null,
			c.stuckReason ? h("div", { className: "dsh-ctf-card-warn" }, h(Icon, { name: "alert", size: 14 }), "卡点：" + c.stuckReason) : null,
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
		if (statusFilter === "unsolved" ? c.status === "solved" : (statusFilter !== "all" && c.status !== statusFilter)) return false;
		if (catFilter && catLabel(c.category) !== catFilter) return false;
		if (needle) {
			var hay = (String(c.title || "") + " " + String(c.slug || "") + " " + String(c.target || "") + " " + String(c.id || "")).toLowerCase();
			if (hay.indexOf(needle) < 0) return false;
		}
		return true;
	});
	challenges = challenges.slice().sort(function (a, b) {
		// 运行中/排队中的题置顶（不受排序方式影响）
		var pa = a.status === "running" ? 0 : a.status === "queued" ? 1 : 2;
		var pb = b.status === "running" ? 0 : b.status === "queued" ? 1 : 2;
		if (pa !== pb) return pa - pb;
		if (sortKey === "duration") return elapsedOf(b) - elapsedOf(a);
		if (sortKey === "status") {
			var ra = STATUS_RANK[a.status] == null ? 9 : STATUS_RANK[a.status];
			var rb = STATUS_RANK[b.status] == null ? 9 : STATUS_RANK[b.status];
			if (ra !== rb) return ra - rb;
		}
		return (b.createdAt || 0) - (a.createdAt || 0);
	});
	// 运行中/排队中的题固定在最上方，剩余题进入分组/平铺列表
	var pinnedChallenges = challenges.filter(function (c) { return c.status === "running" || c.status === "queued"; });
	var pinnedIds = {};
	pinnedChallenges.forEach(function (c) { pinnedIds[c.id] = true; });
	var listChallenges = challenges.filter(function (c) { return !pinnedIds[c.id]; });
	var uncategorizedCount = allChallenges.filter(function (c) { return !String(c.category || "").trim(); }).length;

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
	listChallenges.forEach(function (c) {
		var sid = c.driverSession ? String(c.driverSession) : "";
		if (!groupOf[sid]) {
			groupOf[sid] = { sessionId: sid, challenges: [], agg: sessionAgg[sid] || null };
			groups.push(groupOf[sid]);
		}
		groupOf[sid].challenges.push(c);
	});
	groups.sort(function (a, b) {
		var groupPriority = function (g) {
			return g.challenges.some(function (c) { return c && c.status === "running"; }) ? 0
				: g.challenges.some(function (c) { return c && c.status === "queued"; }) ? 1 : 2;
		};
		var pa = groupPriority(a);
		var pb = groupPriority(b);
		if (pa !== pb) return pa - pb;
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
	var platformLabel = "平台未配置";
	if (platformStatus && platformStatus.configured !== false) {
		if (platformStatus.reachable) { platformTone = "is-ok"; platformLabel = "平台已连接"; }
		else { platformTone = "is-danger"; platformLabel = "平台连接异常"; }
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
	function copyChallengeDir(c) {
		var d = c && c.dir ? String(c.dir) : "";
		if (!d) { say("工作目录未知，请展开题目详情", true); return; }
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(d).then(function () { say("已复制目录：" + d); }, function () { say("工作目录：" + d); });
				return;
			}
		} catch (e) { /* ignore */ }
		say("工作目录：" + d);
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
			knowledgeMinScore: Number(c.knowledgeMinScore),
			autoFetchEnabled: !!c.autoFetchEnabled,
			autoFetchIntervalMs: Math.round(Number(c.autoFetchIntervalMs) || 300000),
			autoFetchLimit: Number(c.autoFetchLimit) || 5,
			autoSolveImported: c.autoSolveImported !== false,
			autoSubmitEnabled: c.autoSubmitEnabled !== false,
			memoryDir: String(c.memoryDir || ""),
			reportDir: String(c.reportDir || ""),
			envSerial: c.envSerial !== false,
			envAutoClean: c.envAutoClean !== false,
			envReadyTimeoutMs: Math.round(Number(c.envReadyTimeoutMs) || 180000)
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
				h("div", { className: "dsh-ctf-hero-title" }, "队列与节奏"),
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
				h(Kpi, { label: "并发占用", value: running.length + "/" + (queue.concurrency || cfg.concurrency || 1), tone: "ok", icon: "play", hint: "调度上限" }),
				h(Kpi, { label: "排队中", value: queued.length, icon: "schedule", hint: "等待槽位" }),
				h(Kpi, { label: "30min 尝试", value: rate.attempts30 || 0, icon: "retry", hint: "最近 30 分钟" }),
				h(Kpi, { label: "30min 完成", value: rate.solved30 || 0, tone: "ok", icon: "check", hint: "最近 30 分钟" })),
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
	var techOptions = [];
	var techSeen = {};
	(memCards || []).forEach(function (card) { (card.tech || []).forEach(function (tag) { if (!techSeen[tag]) { techSeen[tag] = true; techOptions.push(tag); } }); });
	var shownCards = memTech ? (memCards || []).filter(function (card) { return (card.tech || []).indexOf(memTech) >= 0; }) : (memCards || []);
	var KIND_LABEL = { exploit: "利用", triage: "取证分诊", crypto: "密码", generic: "通用" };
	var cardsPanel = h("div", { className: "dsh-ctf-panel" },
		h(SecTitle, { title: "打法卡（跨会话沉淀）", count: shownCards.length }),
		h("div", { className: "dsh-ctf-toolbar" },
			h("span", { className: "dsh-ctf-muted" }, "结构化打法卡：识别特征 / 前置 / 步骤命令 / 载荷 / 坑 / 验证；相似题自动召回并注入提示词。"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: distillAll }, "沉淀全部已解题")),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: rebuildMemories }, "重建全部（v2 结构化）"),
		techOptions.length ? h("div", { className: "dsh-ctf-toolbar" },
			h("button", { type: "button", className: "dsh-ctf-btn is-sm" + (!memTech ? " is-primary" : " is-ghost"), onClick: function () { setMemTech(""); } }, "全部 " + (memCards || []).length),
			techOptions.slice(0, 24).map(function (tag) {
				var count = (memCards || []).filter(function (card) { return (card.tech || []).indexOf(tag) >= 0; }).length;
				return h("button", { key: tag, type: "button", className: "dsh-ctf-btn is-sm" + (memTech === tag ? " is-primary" : " is-ghost"), onClick: function () { setMemTech(memTech === tag ? "" : tag); } }, tag + " " + count);
			})) : null,
		shownCards.length === 0
			? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "还没有打法卡"), h("div", null, "解出题目后会自动沉淀，或点上方按钮立即沉淀。"))
			: h("div", { className: "dsh-ctf-histlist" }, shownCards.slice(0, 80).map(function (card) {
				var open = memExpand === card.id;
				var meta = card.metrics || {};
				var rate = meta.used > 0 ? Math.round((meta.successRate || 0) * 100) + "%（" + (meta.usedOk || 0) + "/" + meta.used + "）" : "未复用";
				var detail = open ? h("div", { className: "dsh-ctf-wubody" },
					card.fingerprint ? h("div", { className: "dsh-ctf-wufact" }, "识别特征：" + card.fingerprint) : null,
					card.entry ? h("div", { className: "dsh-ctf-wufact" }, "入口：" + card.entry) : null,
					(card.prerequisites || []).length ? h("div", { className: "dsh-ctf-wufact" }, "前置：" + card.prerequisites.join("；")) : null,
					(card.tooling || []).length ? h("div", { className: "dsh-ctf-wufact" }, "工具：" + card.tooling.join("、")) : null,
					(card.stepDetails || []).length ? h("div", { className: "dsh-ctf-wulist" }, card.stepDetails.map(function (step, i) {
						return h("div", { key: "s" + i, className: "dsh-ctf-wuattempt" }, "步骤 " + (i + 1) + "：" + (step.title || "—") + (step.command ? "  " : ""), step.command ? h("code", null, step.command) : null);
					})) : null,
					(card.payloads || []).length ? h("div", { className: "dsh-ctf-wulist" }, card.payloads.map(function (payload, i) { return h("div", { key: "pl" + i, className: "dsh-ctf-wufact" }, h("code", null, payload)); })) : null,
					(card.pitfalls || []).length ? h("div", { className: "dsh-ctf-wulist" }, card.pitfalls.map(function (pit, i) { return h("div", { key: "p" + i, className: "dsh-ctf-wuattempt" }, "坑 " + (i + 1) + "：" + pit); })) : null,
					card.verification && card.verification.verified ? h("div", { className: "dsh-ctf-wufact" }, "验证：" + (card.verification.method || "已验证") + (card.verification.evidence ? "（" + card.verification.evidence.slice(0, 160) + "）" : "")) : null,
					card.links && card.links.notesPath ? h("div", { className: "dsh-ctf-wufact" }, "笔记：" + card.links.notesPath) : null,
					card.summary ? h("div", { className: "dsh-ctf-wutext" }, card.summary) : null) : null;
				return h("div", { key: card.id, className: "dsh-ctf-wucard" + (open ? " is-open" : "") },
					h("div", { className: "dsh-ctf-wurow" },
						h("span", { className: "dsh-ctf-wuavatar tone-" + catToneOf(card.category) }, catGlyphOf(card.category)),
						h("div", { className: "dsh-ctf-wumain" },
							h("div", { className: "dsh-ctf-wutop" },
								h("b", { className: "dsh-ctf-wutitle", title: card.title }, card.title),
								card.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(card.category)) : null,
								h("span", { className: "dsh-ctf-pill" }, KIND_LABEL[card.kind] || card.kind || "通用"),
								h("span", { className: "dsh-ctf-pill is-ok" }, "置信 " + Math.round((card.confidence || 0) * 100) + "%")),
							h("div", { className: "dsh-ctf-wumeta" },
								(card.tech || []).slice(0, 8).map(function (tag) { return h("span", { key: tag, className: "dsh-ctf-chip" }, tag); }),
								h("span", { className: "dsh-ctf-wumetric" }, "复用 " + rate))),
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
			var open = expanded === c.id;
			var det = detail && detail.id === c.id ? detail.data : null;
			var exported = hasWriteup(c);
			var evidence = String(f.evidence || "").trim();
			var evOpen = repEvOpen === c.id;
			var body = null;
			if (open) {
				var detailBlocks = [];
				if (detailErr) detailBlocks.push(h("div", { className: "dsh-ctf-error" }, detailErr));
				else if (!det) detailBlocks.push(h("div", { className: "dsh-ctf-muted" }, h("span", { className: "dsh-ctf-spin" }), " 加载题目详情…"));
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
						h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { toggleDetail(c.id); } }, open ? "收起" : "详情"))),
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
		var kpis = h("div", { className: "dsh-ctf-kpis dsh-ctf-kpis-report" },
			h(Kpi, { label: "已解题", value: solvedList.length, tone: "ok", icon: "check", hint: "完成率 " + pct(solvedList.length, stats.total || solvedList.length) + "%" }),
			h(Kpi, { label: "Writeup 文件", value: writeups.length, icon: "download", hint: "已导出" }),
			h(Kpi, { label: "复盘报告", value: reports.length, icon: "report", hint: "已生成" }),
			h(Kpi, { label: "未验证 flag", value: unverified, tone: "warn", icon: "alert", hint: "待复核" }),
			h(Kpi, { label: "平均尝试耗时", value: fmtDur(timing.avgMs), icon: "clock", hint: "尝试 " + (timing.attempts || 0) + " 次" }),
			h(Kpi, { label: "累计费用", value: "¥" + Number(usage.estCost || 0).toFixed(2), icon: "ledger", hint: Math.round((usage.estTokens || 0) / 1000) + "K tokens" }));

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
				h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: reportBusy, onClick: function () { exportReport(false); } }, reportBusy ? "导出中…" : "导出技术报告"),
				h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: reportBusy, onClick: function () { exportReport(true); } }, "完整复盘"),
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
			var card5 = h("div", { className: "dsh-ctf-setcard" },
				h(SecTitle, { title: "自动化", count: 0 }),
				h("div", { className: "dsh-ctf-setgrid" },
					renderSetting("周期自动拉题", "按间隔从平台拉取未解题并自动开始（无人值守）", h("input", {
						type: "checkbox", checked: !!c.autoFetchEnabled,
						onChange: function (e) { setCfgField("autoFetchEnabled", e.target.checked); }
					})),
					renderSetting("拉题间隔（分钟）", "autoFetchEnabled 开启时生效", numInput("autoFetchIntervalMs", Math.round((c.autoFetchIntervalMs || 300000) / 60000), 60000, 5, 1, 1440)),
					renderSetting("每轮题数", "一次最多导入/开始多少题（1-50）", numInput("autoFetchLimit", c.autoFetchLimit, 1, 5, 1, 50)),
					renderSetting("导入后自动开始", "导入完成立即入队派发子代理", h("input", {
						type: "checkbox", checked: c.autoSolveImported !== false,
						onChange: function (e) { setCfgField("autoSolveImported", e.target.checked); }
					})),
					renderSetting("解出后自动提交 flag", "本地 verified 后自动提交来源平台并记录回显（默认开）", h("input", {
						type: "checkbox", checked: c.autoSubmitEnabled !== false,
						onChange: function (e) { setCfgField("autoSubmitEnabled", e.target.checked); }
					}))));
			var card6 = h("div", { className: "dsh-ctf-setcard" },
				h(SecTitle, { title: "存储路径", count: 0 }),
				h("div", { className: "dsh-ctf-setgrid" },
					renderSetting("记忆目录", "memory.json 存放目录；默认 <rootDir>/memory，跨会话持久", textInput("memoryDir", c.memoryDir, "留空 = <rootDir>/memory")),
					renderSetting("复盘目录", "报告与 Writeup 存放目录；默认 <rootDir>/reports，跨会话持久", textInput("reportDir", c.reportDir, "留空 = <rootDir>/reports"))));
			var card7 = h("div", { className: "dsh-ctf-setcard" },
				h(SecTitle, { title: "靶机环境", count: 0 }),
				h("div", { className: "dsh-ctf-setgrid" },
					renderSetting("容器题串行执行", "同一时刻只跑一个需要靶机的题，避免并发抢配额（默认开）", h("input", {
						type: "checkbox", checked: c.envSerial !== false,
						onChange: function (e) { setCfgField("envSerial", e.target.checked); }
					})),
					renderSetting("解出/收口后自动销毁环境", "释放平台唯一配额，供下一题启动（默认开）", h("input", {
						type: "checkbox", checked: c.envAutoClean !== false,
						onChange: function (e) { setCfgField("envAutoClean", e.target.checked); }
					})),
					renderSetting("环境就绪超时（秒）", "启动后等待 access_ready 的上限", numInput("envReadyTimeoutMs", Math.round((c.envReadyTimeoutMs || 180000) / 1000), 1000, 180, 60, 900))));
			form = h("div", { className: "dsh-ctf-setstack" }, card1, card2, card3, card4, card5, card6);
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
						h("div", { className: "dsh-ctf-subhead-title" }, "运行时配置"),
						h("div", { className: "dsh-ctf-pagesub" }, "写入 " + ((c && c.rootDir) || "题板根目录") + "/config.json，保存后对后续尝试生效。")),
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
	function rebuildMemories() {
		request("memory.distill", { all: true, refresh: true, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已重建 " + (r.distilled || 0) + " 张打法卡"); loadMemory(); }
			else say((r && r.error) || "重建失败", true);
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
	function exportReport(full) {
		if (reportBusy) return;
		setReportBusy(true);
		request("report.export", { sessionId: sessionId, technical: full !== true }).then(function (r) {
			setReportBusy(false);
			if (r && r.ok) {
				setReport({ path: r.path || "", bytes: r.bytes || 0, markdown: r.markdown || "" });
				say((full === true ? "完整复盘已导出：" : "技术报告已导出：") + (r.path || ""));
			} else say((r && r.error) || "导出失败", true);
		});
	}
	function renderGroup(g) {
		var sid = g.sessionId;
		var unassigned = !sid;
		var agg = g.agg || {};
		var current = !!sessionId && sid === sessionId;
		var isCollapsed = !!collapsed[sid];
		var knownTitle = sessionTitleOf(sessionsSnap, sid);
		var title = knownTitle || (unassigned ? "未归属会话" : "会话 " + fmtShortId(sid));
		var counts = { total: g.challenges.length, solved: 0, running: 0, queued: 0, stuck: 0, failed: 0 };
		g.challenges.forEach(function (c) { if (c && counts[c.status] != null) counts[c.status] += 1; });
		var subParts = [];
		if (knownTitle && sid) subParts.push("会话 " + fmtShortId(sid));
		if (agg.preset) subParts.push(String(agg.preset));
		if (agg.cwd) subParts.push("cwd " + String(agg.cwd));
		if (unassigned) subParts.push("未绑定发起会话");
		var solvedPct = pct(counts.solved, counts.total);
		return h("div", {
			key: "grp-" + (sid || "__unassigned__"),
			className: "dsh-ctf-group" + (current ? " is-current" : "") + (unassigned ? " is-unassigned" : "")
		},
			h("div", { className: "dsh-ctf-grouphead" },
				h("div", { className: "dsh-ctf-groupmain" },
					h("div", { className: "dsh-ctf-groupavatar" + (unassigned ? " is-unassigned" : "") },
						unassigned ? h(Icon, { name: "folder", size: 17 }) : String(sid || "").slice(-2).toUpperCase()),
					h("div", { className: "dsh-ctf-groupid" },
						h("div", { className: "dsh-ctf-brandline" },
							h("b", { className: "dsh-ctf-grouptitle", title: sid || "" }, title),
							current ? h("span", { className: "dsh-ctf-chip is-mine" }, "当前会话") : null,
							agg.live ? h("span", { className: "dsh-ctf-livepill" }, h("span", null), "LIVE") : null),
						subParts.length ? h("span", { className: "dsh-ctf-groupsub", title: subParts.join(" · ") }, subParts.join(" · ")) : null),
					h("div", { className: "dsh-ctf-groupcounts" },
						countChip("总", counts.total),
						counts.solved ? countChip("已解", counts.solved) : null,
						counts.running ? countChip("运行", counts.running) : null,
						counts.stuck ? countChip("卡住", counts.stuck) : null)),
				h("div", { className: "dsh-ctf-groupactions" },
					h("button", {
						type: "button", className: "dsh-ctf-iconbtn" + (isCollapsed ? " is-collapsed" : ""),
						title: isCollapsed ? "展开本组" : "折叠本组", "aria-label": isCollapsed ? "展开本组" : "折叠本组",
						"aria-expanded": !isCollapsed,
						onClick: function () { toggleGroup(sid); }
					}, h(Icon, { name: "chevron", size: 17 })),
					h("button", {
						type: "button", className: "dsh-ctf-iconbtn is-danger" + (confirm === "del-session:" + (sid || "__unassigned__") ? " is-on" : ""),
						title: "移除该会话下的所有题目（工作目录保留）", "aria-label": "移除会话",
						onClick: function () { deleteSession(sid); }
					}, h(Icon, { name: "alert", size: 16 })))),
			h("div", { className: "dsh-ctf-groupprogress", title: "已解 " + counts.solved + " / " + counts.total },
				h("i", { style: { width: solvedPct + "%" } })),
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
				h("span", { className: "dsh-ctf-sec-title" }, "Flag 与分布"),
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
	function refreshCurrent() {
		reload();
		if (tab === "schedule") loadSchedule();
		else if (tab === "knowledge") loadKnowledge();
		else if (tab === "memory") loadMemory();
		else if (tab === "report") {
			request("report.list", {}).then(function (r) { if (r && r.ok) setReports(r.reports || []); });
			loadWriteups();
		} else if (tab === "platform") {
			request("platform.status", {}).then(function (r) { setPlatformStatus(r || null); });
		}
		say("已刷新");
	}
	function classifyUncategorized() {
		setBusy("classify");
		request("challenge.classify", { sessionId: sessionId }).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				say("已补全 " + ((r.updated || []).length) + " 道题分类");
				reload();
			} else say((r && r.error) || "分类失败", true);
		});
	}

	function startAllChallenges(list) {
		var cand = (list || []).filter(function (c) { return c && c.status !== "solved" && c.status !== "running"; });
		if (!cand.length) { say("没有可开始的题（已解/运行中会被跳过）", true); return; }
		setBusy("startAll");
		request("challenge.startAll", { ids: cand.map(function (c) { return c.id; }), sessionId: sessionId, onlyMine: true }).then(function (r) {
			setBusy("");
			if (r && r.ok) {
				var skipped = (r.skipped || []).length;
				var denied = (r.denied || []).length;
				say("已开始 " + (r.started || []).length + " 题" + (skipped ? "，跳过 " + skipped : "") + (denied ? "，越权 " + denied : ""));
				reload();
			} else say((r && r.error) || "批量开始失败", true);
		});
	}
	function stopAllChallenges(list) {
		var cand = (list || []).filter(function (c) { return c && (c.status === "running" || c.status === "queued"); });
		if (!cand.length) { say("没有运行/排队中的题", true); return; }
		setBusy("stopAll");
		request("challenge.stopAll", { ids: cand.map(function (c) { return c.id; }), sessionId: sessionId, onlyMine: true }).then(function (r) {
			setBusy("");
			if (r && r.ok) { say("已停止 " + (r.stopped || []).length + " 题"); reload(); }
			else say((r && r.error) || "批量停止失败", true);
		});
	}
	function renderTabs() {
		return TABS.map(function (t) {
			var count = t.key === "board" ? stats.total : (t.key === "schedule" ? stats.running : 0);
			return h("button", {
				key: t.key, type: "button", role: "tab",
				"aria-selected": tab === t.key,
				tabIndex: tab === t.key ? 0 : -1,
				title: t.desc,
				className: "dsh-ctf-navitem" + (tab === t.key ? " is-on" : ""),
				onClick: function () { setTab(t.key); }
			},
				h(Icon, { name: t.icon, size: 16 }),
				h("span", { className: "dsh-ctf-navlabel" }, t.label),
				count ? h("i", { className: "dsh-ctf-navcount" }, String(count)) : null);
		});
	}
	function renderFilters() {
		var pctSolved = pct(stats.solved, stats.total);
		var active = (stats.running || 0) + (stats.queued || 0);
		var attention = (stats.stuck || 0) + (stats.failed || 0);
		return h("div", { className: "dsh-ctf-board-tools" },
			h("div", { className: "dsh-ctf-panel dsh-ctf-command" },
				h("div", { className: "dsh-ctf-kpis" },
					h(Kpi, { label: "总题数", value: stats.total, icon: "board", hint: "全部工作区" }),
					h(Kpi, { label: "进行中", value: active, tone: "run", icon: "play", hint: "运行 " + (stats.running || 0) + " · 排队 " + (stats.queued || 0) }),
					h(Kpi, { label: "已解", value: stats.solved, tone: "ok", icon: "check", hint: "完成率 " + pctSolved + "%" }),
					h(Kpi, { label: "需关注", value: attention, tone: "warn", icon: "alert", hint: "卡住 " + (stats.stuck || 0) + " · 失败 " + (stats.failed || 0) })),
				h("div", { className: "dsh-ctf-command-progress" },
					h(ProgressRing, { value: pctSolved }),
					h("div", { className: "dsh-ctf-command-progress-text" },
						h("b", null, "解题进度"),
						h("span", null, (stats.solved || 0) + " / " + (stats.total || 0) + " 已解"),
						h("em", null, updatedAt ? "更新于 " + fmtClock(updatedAt) : "等待同步")))),
			h("div", { className: "dsh-ctf-panel dsh-ctf-filters" },
				h("div", { className: "dsh-ctf-fchips", role: "group", "aria-label": "按状态筛选" },
					STATUS_CHIPS.map(function (chip) {
							var count = chip.key === "all" ? allChallenges.length : chip.key === "unsolved" ? allChallenges.filter(function (c) { return c.status !== "solved"; }).length : (stats[chip.key] || 0);
						return h("button", {
							key: chip.key, type: "button",
							className: "dsh-ctf-fchip" + (statusFilter === chip.key ? " is-on" : ""),
							"aria-pressed": statusFilter === chip.key,
							onClick: function () { setStatusFilter(chip.key); }
						}, chip.label, h("i", null, String(count)));
					})),
				h("div", { className: "dsh-ctf-frow is-controls" },
						statusFilter === "unsolved" ? h("button", {
							type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: !!busy,
							title: "把当前未解筛选里的题全部入队",
							onClick: function () { startAllChallenges(challenges); }
						}, busy === "startAll" ? "启动中…" : "一键开始未解 (" + challenges.filter(function (c) { return c.status !== "solved" && c.status !== "running"; }).length + ")") : null,
					h("div", { className: "dsh-ctf-searchwrap" },
						h(Icon, { name: "search", size: 15 }),
						h("input", {
							className: "dsh-ctf-in dsh-ctf-search", placeholder: "搜索标题 / slug / 目标 / ID…",
							"aria-label": "搜索题目",
							value: query, onChange: function (e) { setQuery(e.target.value); }
						})),
					h("select", {
						className: "dsh-ctf-in dsh-ctf-fselect", value: catFilter, title: "模块筛选",
						"aria-label": "模块筛选",
						onChange: function (e) { setCatFilter(e.target.value); }
					},
						h("option", { value: "" }, "全部模块"),
						catOptions.map(function (o) { return h("option", { key: o.category, value: o.category }, catLabel(o.category) + " (" + (o.total || 0) + ")"); })),
					h("select", {
						className: "dsh-ctf-in dsh-ctf-fselect", value: sortKey, title: "排序",
						"aria-label": "排序方式",
						onChange: function (e) { setSortKey(e.target.value); }
					},
						SORT_OPTIONS.map(function (o) { return h("option", { key: o.key, value: o.key }, "排序：" + o.label); })),
					h("div", { className: "dsh-ctf-seg", role: "group", "aria-label": "分组方式" },
						h("button", {
							type: "button", className: "dsh-ctf-segbtn" + (groupMode === "session" ? " is-on" : ""),
							"aria-pressed": groupMode === "session",
							onClick: function () { setGroupMode("session"); }
						}, "按会话"),
						h("button", {
							type: "button", className: "dsh-ctf-segbtn" + (groupMode === "flat" ? " is-on" : ""),
							"aria-pressed": groupMode === "flat",
							onClick: function () { setGroupMode("flat"); }
						}, "平铺"),
						h("button", {
							type: "button", className: "dsh-ctf-segbtn" + (groupMode === "category" ? " is-on" : ""),
							"aria-pressed": groupMode === "category",
							onClick: function () { setGroupMode("category"); }
						}, "按分类")),
					sessionId ? h("label", { className: "dsh-ctf-toggle" + (allScope ? " is-on" : "") },
						h("input", {
							type: "checkbox", checked: allScope,
							onChange: function (e) { setAllScope(e.target.checked); }
						}), "全部工作区") : null,
					sessionId ? h("label", { className: "dsh-ctf-toggle" + (onlyMine ? " is-on" : "") },
						h("input", {
							type: "checkbox", checked: onlyMine,
							onChange: function (e) { setOnlyMine(e.target.checked); }
						}), "仅本会话") : null,
					uncategorizedCount > 0 ? h("button", {
						type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy,
						title: "按题名/题面/附件启发式补全未分类题",
						onClick: classifyUncategorized
					}, busy === "classify" ? "分类中…" : "补全分类 (" + uncategorizedCount + ")") : null,
					filterActive ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: clearFilters }, "清空筛选") : null,
					h("span", { className: "dsh-ctf-fnote" }, filterNote))));
	}
	var categoryGroups = [];
	if (groupMode === "category") {
		var catGroupMap = {};
		listChallenges.forEach(function (c) {
			var key = catLabel(c.category);
			if (!catGroupMap[key]) { catGroupMap[key] = { category: c.category || "", label: key, challenges: [] }; categoryGroups.push(catGroupMap[key]); }
			catGroupMap[key].challenges.push(c);
		});
		categoryGroups.sort(function (a, b) { return b.challenges.length - a.challenges.length || String(a.label).localeCompare(String(b.label)); });
	}
	function renderCategoryGroup(group) {
		return h("div", { className: "dsh-ctf-group" },
			h("div", { className: "dsh-ctf-grouphead" },
				h("b", null, group.label),
				h("span", { className: "dsh-ctf-groupmeta" }, group.challenges.length + " 题")),
			h("div", { className: "dsh-ctf-flatlist" }, group.challenges.map(renderCard)));
	}
	var pinnedBlock = pinnedChallenges.length
		? h("div", { className: "dsh-ctf-pinned" },
			h("div", { className: "dsh-ctf-pinned-head" },
				h("span", { className: "dsh-ctf-pinned-dot" }),
				h("b", null, "进行中"),
				h("span", null, pinnedChallenges.length + " 题"),
				h("em", null, "运行/排队自动置顶")),
			h("div", { className: "dsh-ctf-flatlist" }, pinnedChallenges.map(renderCard)))
		: null;

	var listBody;
	if (!snap && !err) {
		listBody = emptyState({
			icon: h("span", { className: "dsh-ctf-spin" }),
			title: "正在连接题板…",
			desc: "等待宿主 Web 通道响应，页面可见时会自动轮询。",
			role: "status", live: "polite"
		});
	} else if (challenges.length === 0) {
		if (filterActive) {
			listBody = emptyState({
				icon: "⌕",
				title: "没有匹配的题目",
				desc: "当前筛选条件下没有题目；可以清空筛选或换个关键词。",
				actions: [h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: clearFilters }, "清空筛选")]
			});
		} else if (isView && onlyMine) {
			listBody = emptyState({
				icon: "◫",
				title: "本会话暂无解题任务",
				desc: "关闭「仅本会话」可查看整个题板；右上角「＋ 新建题目」会以本会话为父代理派发解题子代理。",
				actions: [h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: function () { setOnlyMine(false); } }, "查看全部题板")]
			});
		} else {
			listBody = emptyState({
				icon: "＋",
				title: "题板还是空的",
				desc: "创建第一道题目，或让模型调用 ctf_solve_start 建题。题目创建后会进入队列，由子代理按角度自主解题。",
				actions: [h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", onClick: function () { setFormOpen(true); } }, h(Icon, { name: "plus", size: 14 }), "新建题目")],
				extra: h("div", { className: "dsh-ctf-empty-hints" },
					h("div", { className: "dsh-ctf-empty-hint" }, h("b", null, "01"), h("span", null, "手动建题"), h("em", null, "填写题面、附件路径与目标地址")),
					h("div", { className: "dsh-ctf-empty-hint" }, h("b", null, "02"), h("span", null, "平台导入"), h("em", null, "从 CTFd 或通用 JSON 拉取题板")),
					h("div", { className: "dsh-ctf-empty-hint" }, h("b", null, "03"), h("span", null, "模型建题"), h("em", null, "让模型调用 ctf_solve_start")))
			});
		}
	} else if (isView && groupMode === "category") {
		listBody = h("div", { className: "dsh-ctf-groups" }, categoryGroups.map(renderCategoryGroup));

	} else if (isView && groupMode === "session" && !allScope) {
		listBody = h("div", { className: "dsh-ctf-groups" }, groups.map(renderGroup));
	} else {
		listBody = h("div", { className: "dsh-ctf-flatlist" }, listChallenges.map(renderCard));
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
			h("div", { className: "dsh-ctf-list" }, pinnedBlock, listBody));
	}

	var formShown = tab === "board" && formOpen;
	function toggleForm() {
		if (tab !== "board") { setTab("board"); setFormOpen(true); return; }
		setFormOpen(!formOpen);
	}
	var currentTab = TABS.filter(function (x) { return x.key === tab; })[0] || TABS[0];
	var boardStartable = challenges.filter(function (c) { return c && c.status !== "solved" && c.status !== "running"; }).length;
	var boardActive = challenges.filter(function (c) { return c && (c.status === "running" || c.status === "queued"); }).length;

	return h("div", { className: "dsh-ctf-root" + (isView ? " is-view" : "") },
		h("div", { className: "dsh-ctf-shell" },
			h("aside", { className: "dsh-ctf-rail", "aria-label": "CTF 自动解题导航" },
				h("div", { className: "dsh-ctf-railbrand" },
					h("div", { className: "dsh-ctf-railmark" }, h(Icon, { name: "target", size: 21 })),
					h("div", { className: "dsh-ctf-railname" },
						h("b", null, "CTF"),
						h("span", null, "AUTO SOLVER"))),
				h("div", { className: "dsh-ctf-railcap" }, "控制台"),
				h("nav", { className: "dsh-ctf-railnav", role: "tablist", "aria-label": "CTF 自动解题页面" }, renderTabs()),
				h("div", { className: "dsh-ctf-railfoot" },
					h("div", { className: "dsh-ctf-railsession", title: sessionId || "无绑定会话" },
						h("span", { className: "dsh-ctf-raildot" + (isView && sessionId ? " is-live" : "") }),
						h("div", null,
							h("b", null, isView ? "会话已绑定" : "设置视图"),
							h("span", null, sessionId ? fmtShortId(sessionId) : "未绑定 session"))),
					h("div", { className: "dsh-ctf-railmeta" },
						h("span", null, "v0.1.0"),
						h("span", null, "LOCAL")))),
			h("main", { className: "dsh-ctf-main" },
				h("header", { className: "dsh-ctf-topbar" },
					h("div", { className: "dsh-ctf-topbar-main" },
						h("div", { className: "dsh-ctf-eyebrow" },
							h("span", { className: "dsh-ctf-eyebrow-dot" }),
							"CTF ORCHESTRATOR"),
						h("h1", { className: "dsh-ctf-pagetitle" }, currentTab.label),
						h("div", { className: "dsh-ctf-pagedesc" }, currentTab.desc)),
					h("div", { className: "dsh-ctf-topbar-actions" },
						isView ? h("button", {
							type: "button",
							className: "dsh-ctf-btn is-ghost dsh-ctf-platform-pill " + platformTone,
							title: "打开平台接入",
							onClick: function () { setTab("platform"); }
						}, h("span", null, platformLabel)) : null,
						isView ? h("button", {
							type: "button", className: "dsh-ctf-btn is-ghost", disabled: reportBusy,
							title: "导出复盘", "aria-label": "导出复盘",
							onClick: exportReport
						}, h(Icon, { name: "download", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, reportBusy ? "导出中…" : "导出复盘")) : null,
						isView && platformStatus && platformStatus.configured ? h("button", {
							type: "button", className: "dsh-ctf-btn is-ghost", disabled: !!busy,
							title: "自动拉取平台未解题 → 导入 → 立即开始（解出后按设置自动提交）", "aria-label": "全自动跑板",
							onClick: function () {
								setBusy("pipeline");
								request("pipeline.run", { sessionId: sessionId }).then(function (r) {
									setBusy("");
									if (r && r.ok) {
										say("全自动：导入 " + (r.imported || 0) + " 题" + ((r.started || []).length ? "，已开始 " + r.started.length : "") + (r.errors && r.errors.length ? "，错误 " + r.errors.length : ""));
										reload();
									} else say((r && r.error) || "全自动跑板失败", true);
								});
							}
						}, h(Icon, { name: "spark", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, busy === "pipeline" ? "拉取中…" : "全自动跑板")) : null,
						isView && boardStartable > 0 ? h("button", {
							type: "button", className: "dsh-ctf-btn is-primary", disabled: !!busy,
							title: "把当前题板所有未解题加入调度队列", "aria-label": "一键开始",
							onClick: function () { startAllChallenges(challenges); }
						}, h(Icon, { name: "play", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, busy === "startAll" ? "启动中…" : "一键开始 (" + boardStartable + ")")) : null,
						isView && boardActive > 0 ? h("button", {
							type: "button", className: "dsh-ctf-btn is-ghost", disabled: !!busy,
							title: "停止所有运行/排队中的题", "aria-label": "全部停止",
							onClick: function () { stopAllChallenges(challenges); }
						}, h(Icon, { name: "stop", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, busy === "stopAll" ? "停止中…" : "全部停止 (" + boardActive + ")")) : null,
						h("button", {
							type: "button", className: "dsh-ctf-btn is-ghost", disabled: !!busy,
							title: "刷新题板", "aria-label": "刷新题板",
							onClick: refreshCurrent
						}, h(Icon, { name: "refresh", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, busy ? "刷新中…" : "刷新")),
						h("button", {
							type: "button", className: "dsh-ctf-btn is-primary",
							"aria-expanded": formShown,
							onClick: toggleForm
						}, h(Icon, { name: "plus", size: 15 }), h("span", null, formShown ? "收起表单" : "新建题目")))),
				renderBanners(err, warning, reload),
				tabBody,
				toast ? h("div", {
					className: "dsh-ctf-toast" + (toast.err ? " is-err" : ""),
					role: toast.err ? "alert" : "status",
					"aria-live": toast.err ? "assertive" : "polite"
				}, toast.text) : null)));

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
