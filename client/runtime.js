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
var ATTEMPT_STATUS_LABEL = { running: "运行中", completed: "已完成", timeout: "超时", error: "异常", aborted: "已中止", stalled: "无产出收口" };
var ATTEMPT_TONE = { running: "run", completed: "ok", timeout: "warn", error: "danger", aborted: "muted", stalled: "warn" };
var STOP_REASON_LABEL = {
	completed: "完成", aborted: "中止", "verified-stop": "验证后结束", "stopped-by-user": "用户停止", stalled: "无产出收口", error: "异常", "max-tokens": "token 上限", refusal: "拒答", timeout: "超时"
};
var EVENT_LABEL = {
	queued: "入队", started: "启动", "attempt-start": "尝试开始", "attempt-end": "尝试结束",
	flag: "flag", "flag-rejected": "候选已拒绝", watchdog: "无产出提醒", experiment: "实验黑板", swarm: "蜂群", stuck: "卡住", stopped: "停止", error: "错误", note: "备注"
};
var METHOD_LABEL = { "local-check": "本地校验", derivation: "推导", manual: "人工", platform: "平台" };
// 单标签内部分页：所有界面都收在「CTF 自动解题」里
var TABS = [
	{ key: "overview", label: "总览", icon: "overview", desc: "关注比赛进度、执行状态与下一步工作" },
	{ key: "board", label: "题目工作台", icon: "board", desc: "管理题目、工作区与解题队列" },
	{ key: "platform", label: "平台接入", icon: "platform", desc: "CTFd / 通用 JSON 适配器与题目导入" },
	{ key: "schedule", label: "调度中心", icon: "schedule", desc: "并发、排队与最近 30 分钟节奏" },
	{ key: "ledger", label: "Flag 台账", icon: "ledger", desc: "flag、模块与状态分布" },
	{ key: "report", label: "复盘报告", icon: "report", desc: "Writeup 导出与经验沉淀" },
	{ key: "knowledge", label: "知识库", icon: "knowledge", desc: "本地题解、笔记与模块卡检索" },
	{ key: "memory", label: "经验记忆", icon: "memory", desc: "跨会话打法、事实链与黑板书" },
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
