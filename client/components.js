function installStyles() {
	var style = document.createElement("style");
	style.id = "dsh-ctf-style";
	style.textContent = CSS;
	document.head.appendChild(style);
	return function () { style.remove(); };
}

// ---- 内联图标：避免额外依赖，统一线宽与视觉尺寸 ----
var ICON_DEFS = {
	overview: [["path", { d: "M3 10l9-7 9 7M5 9v12h14V9M9 21v-8h6v8" }]],
	swarm: [["circle", { cx:12,cy:12,r:3 }], ["path", { d:"M12 3v6M12 15v6M3 12h6M15 12h6M5 5l5 5M14 14l5 5M5 19l5-5M14 10l5-5" }]],
	close: [["path",{d:"M6 6l12 12M6 18L18 6"}]],
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
		props.count == null || props.count === 0 ? null : h("span", { className: "dsh-ctf-sec-count" }, String(props.count)));
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
						h("span", { className: "dsh-ctf-tag " + (f.verified ? "is-ok" : "is-warn") }, f.rejected ? "平台已拒绝" : f.verified ? "已验证" : f.localVerified ? "本地校验，待提交" : "未验证")),
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
				var dur = a.elapsedMs == null ? (a.startedAt ? Math.max(0, (a.endedAt || Date.now()) - a.startedAt) : 0) : a.elapsedMs;
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
				var issue = r.budgetTiming && r.budgetTiming.clockError || memory.migrationError || memory.readError || memory.writeError || usage.readError || usage.writeError || (r.taskStorage && (r.taskStorage.clockError || r.taskStorage.lastTick && r.taskStorage.lastTick.error));
				setSnap(r);
				setErr(r.persistence && r.persistence.dirty ? r.persistence.lastError && r.persistence.lastError.message || "状态尚未保存到磁盘；请勿重复操作，后台正在重试保存。" : issue ? issue.message || "学习数据存储异常，原文件已保留。" : r.taskUncertain ? "有任务尚未确认结束，相关题目的重跑和环境清理已暂停，请在详情中核对任务。" : r.preparationPending ? "有 " + r.preparationPending + " 道题输入准备未完成，请在详情查看原因；完成前不会自动派发。" : r.localProjectionPending ? "有本地文件等待恢复同步，相关题目暂不能移除或沉淀。" : r.learningUsagePending ? "有 " + r.learningUsagePending + " 条使用统计等待恢复，相关题目暂不能移除。" : "");
				setUpdatedAt(Date.now());
			}
			else setErr((r && r.error) || "读取题板失败（宿主 Web 通道未就绪？）");
		});
	}
	useEffect(function () {
		var alive = true;
		setSnap(null); setErr(""); setUpdatedAt(0);
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
	return { expanded: expanded, open: function (id) { setExpanded(id); }, close: function () { setExpanded(""); }, toggle: toggle, detail: detail, detailErr: detailErr, loadDetail: loadDetail, expandedRef: expandedRef };
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
		o.actions && o.actions.length ? h("div", { className: "dsh-ctf-empty-actions" }, React.Children.toArray(o.actions)) : null,
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

function LearningFeedbackSection(props) {
	var ch = props.ch || {}, board = ch.learningFeedback || { entries: [] }, receipts = board.entries || [];
	var refs = [];
	(ch.attempts || []).forEach(function (a) { ["memory", "knowledge"].forEach(function (kind) {
		(kind === "memory" ? a.memories || [] : a.knowledge || []).forEach(function (r) { if (r.revisionId) refs.push({ kind: kind, ref: r, attempt: a.n, runId: a.runId }); });
	}); });
	var selectedS = useState(""), selected = selectedS[0], setSelected = selectedS[1];
	var verdictS = useState("helpful"), verdict = verdictS[0], setVerdict = verdictS[1];
	var reasonS = useState(""), reason = reasonS[0], setReason = reasonS[1];
	var pathsS = useState(""), paths = pathsS[0], setPaths = pathsS[1];
	var busyS = useState(false), busy = busyS[0], setBusy = busyS[1], currentId = useRef(ch.id); currentId.current = ch.id;
	useEffect(function () { setSelected(""); setReason(""); setPaths(""); setBusy(false); }, [ch.id]);
	if (!refs.length && !receipts.length && board.ok !== false) return emptyState({ title: "尚无可评价的资料", desc: "当本题尝试实际召回记忆或知识段落后，可在这里登记带证据的使用反馈。", icon: h(Icon, { name: "memory", size: 26 }) });
	var labels = { helpful: "实测有用", inapplicable: "范围不适用", contradicted: "结论矛盾" };
	function save() {
		var target = refs[Number(selected)];
		if (!target || selected === "" || busy || props.readOnly) return;
		var old = receipts.find(function (r) { return r.runId === target.runId && r.kind === target.kind && r.referenceId === target.ref.id && r.revisionId === target.ref.revisionId; });
		setBusy(true);
		request("learning.feedback", { id: ch.id, sessionId: props.sessionId || "", attempt: target.attempt, kind: target.kind,
			referenceId: target.ref.id, revisionId: target.ref.revisionId, verdict: verdict, reason: reason, expectedVersion: old ? old.version : 0,
			evidencePaths: paths.split(/\r?\n/).map(function (p) { return p.trim(); }).filter(Boolean) }).then(function (result) {
			if (currentId.current !== ch.id) return;
			setBusy(false);
			if (props.say) props.say(result && result.ok ? "反馈已保存；重复请求不会重复计数" : result && result.error || "反馈保存失败", !result || !result.ok);
			if (result && result.ok && props.onChanged) props.onChanged();
		});
	}
	return h("div", { className: "dsh-ctf-sec" }, h(SecTitle, { title: "历史资料的实测反馈", count: receipts.length }),
		h("div", { className: "dsh-ctf-muted" }, "题目解出不能证明每条召回资料都有效。反馈绑定这次尝试实际读取的版本，须引用本题产出。"),
		board.ok === false ? h("div", { className: "dsh-ctf-muted" }, board.error || "反馈库不可读取") : null,
		receipts.slice(-8).map(function (r) { return h("div", { key: r.runId + r.referenceId, className: "dsh-ctf-wufact" }, "尝试 #" + r.attempt + " · " + (labels[r.verdict] || r.verdict), h("div", null, r.reason)); }),
		props.readOnly || !refs.length ? null : h("div", { className: "dsh-ctf-form" },
			h("label", { className: "dsh-ctf-field is-wide" }, "选择本次尝试的资料", h("select", { className: "dsh-ctf-in", value: selected, disabled: busy, onChange: function (e) { setSelected(e.target.value); } },
				h("option", { value: "" }, "选择已召回的资料版本"), refs.map(function (r, i) { return h("option", { key: i, value: String(i) }, "#" + r.attempt + " · " + (r.kind === "memory" ? "记忆" : "知识") + " · " + r.ref.title); }))),
			h("label", { className: "dsh-ctf-field" }, "实测效果", h("select", { className: "dsh-ctf-in", value: verdict, disabled: busy, onChange: function (e) { setVerdict(e.target.value); } }, Object.keys(labels).map(function (v) { return h("option", { key: v, value: v }, labels[v]); }))),
			h("label", { className: "dsh-ctf-field is-wide" }, "判断依据（至少 12 字符）", h("textarea", { className: "dsh-ctf-in", rows: 2, value: reason, disabled: busy, onChange: function (e) { setReason(e.target.value); } })),
			h("label", { className: "dsh-ctf-field is-wide" }, "本题证据相对路径（每行一个，最多四个）", h("textarea", { className: "dsh-ctf-in", rows: 2, value: paths, disabled: busy, onChange: function (e) { setPaths(e.target.value); } })),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: busy || selected === "" || board.ok === false, onClick: save }, busy ? "保存中…" : "保存实测反馈")));
}

function SwarmRecordsSection(props) {
	var ch = props.ch || {}, board = ch.swarm || {}, rows = board.rows || [];
	var busyS = useState(""), busy = busyS[0], setBusy = busyS[1];
	var currentId = useRef(ch.id); currentId.current = ch.id;
	useEffect(function () { setBusy(""); }, [ch.id]);
	var labels = { starting: "正在派发", running: "实验中", stopping: "等待退出回执", unknown: "执行端待核对", completed: "已退出，待核验证据", failed: "执行失败", interrupted: "已中断" };
	function command(endpoint, input) {
		if (busy || props.readOnly) return;
		setBusy(input.workerId || input.queueId || input.key);
		request(endpoint, Object.assign({ id: ch.id, sessionId: props.sessionId || "" }, input)).then(function (r) {
			if (currentId.current !== ch.id) return;
			setBusy("");
			if (props.say) props.say(r && r.ok ? endpoint === "swarm.dispatch" ? "派工已受理；请核对实验与证据后再采纳结果" : endpoint === "swarm.queue" ? "已登记待派，前置条件与槽位就绪后自动启动" : "停止或取消请求已受理" : r && r.error || "蜂群操作失败", !r || !r.ok);
			if (props.onChanged) props.onChanged();
		});
	}
	var attempt = (ch.attempts || []).slice(-1)[0] || {}, epoch = (ch.experimentBoard || {}).epoch;
	var ready = (ch.experiments || []).filter(function (r) { return !r.stale && ["proposed", "running"].indexOf(r.status) >= 0 && !rows.some(function (w) { return w.runId === attempt.runId && w.key === r.key && w.epoch === r.epoch; }); });
	if (!board.enabled && !rows.length && !(board.queue || []).length) return emptyState({ title: "蜂群协作尚未开启", desc: "在设置中启用蜂群后，协调者可按实验黑板中的假设派出辅助代理。", icon: h(Icon, { name: "swarm", size: 26 }) });
	return h("div", { className: "dsh-ctf-sec" }, h(SecTitle, { title: "蜂群派工", count: rows.length }),
		h("div", { className: "dsh-ctf-muted" }, (board.enabled ? "已开启" : "已关闭") + " · 全局辅助代理占用 " + (board.occupiedSlots || 0) + "/" + (board.concurrency || 2) + "；本题协调者统一核验、提交与收尾。"),
		h("div", { className: "dsh-ctf-swarm-summary" },
			h("div", null, h("span", null, "协调者"), h("b", null, "核验与提交")),
			h("div", null, h("span", null, "活跃辅助代理"), h("b", null, rows.filter(function (r) { return ["starting", "running", "stopping", "unknown"].indexOf(r.status) >= 0; }).length)),
			h("div", null, h("span", null, "等待前置与槽位"), h("b", null, (board.queue || []).filter(function (q) { return q.status === "queued"; }).length))),
		rows.slice(-12).reverse().map(function (r) { return h("div", { className: "dsh-ctf-worker", key: r.workerId },
			h("b", null, (r.role === "verifier" ? "独立复验 · " : "") + r.key), " · 尝试 #" + r.attempt + " · " + (r.lane === "target" ? "靶机实验" : "离线分析") + " · " + (labels[r.status] || r.status),
			h("div", null, h("code", null, r.artifactDir)),
			r.error ? h("div", null, r.error) : null,
			r.outputTail ? h("details", null, h("summary", null, "执行摘要（需核验证据）"), h("pre", { className: "dsh-ctf-pre" }, r.outputTail)) : null,
			!props.readOnly && ["starting", "running", "stopping"].indexOf(r.status) >= 0 ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy || r.status === "stopping", onClick: function () { command("swarm.cancel", { workerId: r.workerId }); } }, "停止此辅助代理") : null); }),
		(board.queue || []).slice(-12).map(function (q) { return h("div", { className: "dsh-ctf-wufact", key: q.queueId },
			h("b", null, q.key), " · " + ({ queued: "等待派工", dispatched: "已派工", cancelled: "已取消", invalidated: "规划已失效" }[q.status] || q.status),
			h("div", { className: "dsh-ctf-muted" }, q.reason || (q.blockers || []).map(function (b) { return b.key + "：" + b.reason; }).join("；") || (q.status === "queued" ? "等待预算与并发槽位" : "")),
			props.readOnly || q.status !== "queued" ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: function () { command("swarm.cancel", { queueId: q.queueId }); } }, "取消待派")); }),
		props.readOnly || !board.enabled || ch.status !== "running" || attempt.wrapupAt ? null : ready.slice(0, 6).map(function (r) { return h("div", { className: "dsh-ctf-histacts", key: r.key }, h("span", null, (r.reviewOf ? "独立复验：" : "") + r.hypothesis),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: function () { command("swarm.dispatch", { key: r.key, expectedVersion: r.version, epoch: epoch, lane: "offline" }); } }, "派工：离线分析"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: function () { command("swarm.dispatch", { key: r.key, expectedVersion: r.version, epoch: epoch, lane: "target" }); } }, "派工：当前靶机"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: function () { command("swarm.queue", { key: r.key, expectedVersion: r.version, epoch: epoch, lane: "offline" }); } }, "就绪后派：离线"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: function () { command("swarm.queue", { key: r.key, expectedVersion: r.version, epoch: epoch, lane: "target" }); } }, "就绪后派：靶机")); }));
}

function ExperimentRecordsSection(props) {
	var ch = props.ch || {}, board = ch.experimentBoard || { epoch: "", rows: [] }, rows = board.rows || [];
	var currentId = useRef(ch.id); currentId.current = ch.id;
	var draftS = useState(null), draft = draftS[0], setDraft = draftS[1];
	var busyS = useState(false), busy = busyS[0], setBusy = busyS[1];
	var checksS = useState({}), checks = checksS[0], setChecks = checksS[1];
	var allS = useState(false), all = allS[0], setAll = allS[1];
	useEffect(function () { setDraft(null); setBusy(false); setChecks({}); setAll(false); }, [ch.id]);
	var labels = { proposed: "待实验", running: "实验中", supported: "假设获支持", refuted: "已证伪", blocked: "条件阻塞" };
	function say(message, error) { if (props.say) props.say(message, error); }
	function edit(row) {
		if (props.readOnly || busy) return;
		setDraft({ key: row ? row.key : "", hypothesis: row ? row.hypothesis : "", scope: row ? row.scope : "", expectedResult: row ? row.expectedResult : "",
			command: row ? row.command : "", status: row && !row.stale ? row.status : "proposed", observedResult: row && !row.stale ? row.observedResult : "",
			nextStep: row ? row.nextStep : "", evidencePaths: row && !row.stale ? (row.evidence || []).map(function (ref) { return ref.path; }).join("\n") : "",
			expectedVersion: row && !row.stale ? row.version : 0, epoch: board.epoch, reopenReason: "", dependsOn: row && !row.stale ? (row.dependsOn || []).map(function (d) { return Object.assign({}, d); }) : [] });
	}
	function dependencyEditor() {
		var dependencies = draft.dependsOn || [];
		var candidates = rows.filter(function (r) { return !r.stale && r.key !== draft.key; });
		function update(index, patch) { var next = dependencies.map(function (d, i) { return i === index ? Object.assign({}, d, patch) : d; }); setDraft(Object.assign({}, draft, { dependsOn: next })); }
		var available = candidates.filter(function (r) { return !dependencies.some(function (d) { return d.key === r.key; }); });
		return h("div", { className: "dsh-ctf-dependencies dsh-ctf-field is-wide" }, h("span", null, "前置实验"),
			h("div", { className: "dsh-ctf-muted" }, "只有前置结论和证据仍然有效，后续实验才会进入可派工状态。最多 4 项。"),
			dependencies.map(function (dep, i) { var parent = candidates.find(function (r) { return r.key === dep.key; }); return h("div", { className: "dsh-ctf-dependency", key: i },
				h("select", { className: "dsh-ctf-in", "aria-label": "前置实验 " + (i + 1), value: dep.key, disabled: busy, onChange: function (e) { update(i, { key: e.target.value, version: undefined }); } }, !parent ? h("option", { value: dep.key }, dep.key + "（当前范围不可用）") : null, candidates.filter(function (r) { return r.key === dep.key || !dependencies.some(function (d) { return d.key === r.key; }); }).map(function (r) { return h("option", { key: r.key, value: r.key }, r.hypothesis + " · " + r.key); })),
				h("select", { className: "dsh-ctf-in", "aria-label": "前置结论 " + (i + 1), value: dep.status, disabled: busy, onChange: function (e) { update(i, { status: e.target.value }); } }, h("option", { value: "supported" }, "假设获支持"), h("option", { value: "refuted" }, "假设已证伪")),
				h("label", { className: "dsh-ctf-check" }, h("input", { type: "checkbox", checked: !!dep.version, disabled: busy || !parent, onChange: function (e) { update(i, { version: e.target.checked ? parent.version : undefined }); } }), "锁定版本" + (dep.version ? " v" + dep.version : "")),
				h("button", { type: "button", className: "dsh-ctf-iconbtn is-danger", "aria-label": "移除前置实验 " + (i + 1), disabled: busy, onClick: function () { setDraft(Object.assign({}, draft, { dependsOn: dependencies.filter(function (_, at) { return at !== i; }) })); } }, h(Icon, { name: "close" }))); }),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: busy || dependencies.length >= 4 || !available.length, onClick: function () { setDraft(Object.assign({}, draft, { dependsOn: dependencies.concat([{ key: available[0].key, status: "supported" }]) })); } }, h(Icon, { name: "plus", size: 14 }), "添加前置实验"));
	}
	function reviewDraft(row, review) {
		if (props.readOnly || busy) return;
		setDraft({ mode: review ? "review-resolve" : "review-open", key: row.key, expectedVersion: row.version, epoch: board.epoch,
			reviewKey: review ? review.key : "", expectedReviewVersion: review ? review.version : 0, reason: "", evidencePaths: "" });
	}
	function fieldInput(label, key, multiline) {
		return h("label", { className: "dsh-ctf-field" + (multiline ? " is-wide" : ""), key: key }, h("span", null, label),
			h(multiline ? "textarea" : "input", { className: "dsh-ctf-in", value: draft[key], rows: multiline ? 2 : undefined, disabled: busy || key === "key" && draft.expectedVersion > 0,
				onChange: function (event) { var next = Object.assign({}, draft); next[key] = event.target.value; setDraft(next); } }));
	}
	function save() {
		if (busy || props.readOnly) return;
		var endpoint = draft.mode === "review-open" ? "experiment.review.open" : draft.mode === "review-resolve" ? "experiment.review.resolve" : "experiment.record";
		var payload = Object.assign({}, draft, { id: ch.id, sessionId: props.sessionId || "",
			evidencePaths: String(draft.evidencePaths || "").split(/\r?\n/).map(function (file) { return file.trim(); }).filter(Boolean) });
		delete payload.mode;
		setBusy(true);
		request(endpoint, payload).then(function (result) {
			if (currentId.current !== ch.id) return;
			setBusy(false);
			if (result && result.ok) { setDraft(null); say("实验或复验已保存；flag 仍须单独核验"); }
			else say(result && result.error || "保存实验失败", true);
			if (props.onChanged) props.onChanged();
		});
	}
	function check(row) {
		if (busy) return;
		setBusy(true);
		request("experiment.list", { id: ch.id, key: row.key, epoch: row.epoch, verifyEvidence: true, sessionId: props.sessionId || "" }).then(function (result) {
			if (currentId.current !== ch.id) return;
			setBusy(false);
			if (!result || !result.ok) { say(result && result.error || "核对证据失败", true); return; }
			var current = (result.rows || [])[0];
			if (!current) { say("实验记录已变化，请刷新", true); return; }
			var next = Object.assign({}, checks);
			next[row.epoch + ":" + row.key + ":" + row.version] = { at: Date.now(), text: (current.evidence || []).map(function (ref) {
				return ref.path + "：" + ({ match: "字节匹配", changed: "文件内容已变化", unavailable: "文件不可读取" }[ref.integrity] || "未核对");
			}).join("；") };
			setChecks(next);
		});
	}
	var ordered = rows.slice().sort(function (a, b) { return Number(a.stale) - Number(b.stale) || b.updatedAt - a.updatedAt; });
	return h("div", { className: "dsh-ctf-sec" },
		h(SecTitle, { title: "实验黑板", count: rows.length }),
		h("div", { className: "dsh-ctf-muted" }, "假设 → 最小实验 → 实际结果 → 证据。已证伪结论仅适用于列出的范围；支持假设不等于 flag 正确。"),
		props.readOnly ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy, onClick: function () { edit(null); } }, "新建实验"),
		(all ? ordered : ordered.slice(0, 12)).map(function (row) {
			var checked = checks[row.epoch + ":" + row.key + ":" + row.version];
			return h("div", { key: row.epoch + ":" + row.key, className: "dsh-ctf-wufact" },
				h("b", null, row.hypothesis),
				h("div", null, h("span", { className: "dsh-ctf-tag " + (row.stale || row.status === "blocked" ? "is-warn" : "") }, row.stale ? "旧材料/靶机范围" : labels[row.status]), " · ", row.key),
				h("div", null, "测试范围：" + row.scope), h("div", null, "预期：" + row.expectedResult),
				row.reviewOf ? h("div", { className: "dsh-ctf-muted" }, "独立复验：" + row.reviewOf.key + "；争议：" + row.reviewOf.reason) : null,
				!(row.dependsOn || []).length ? null : h("div", null, "前置：" + row.dependsOn.map(function (d) { return d.key + "=" + d.status + (d.version ? " v" + d.version : ""); }).join("；")),
				!row.readiness || row.readiness.ready ? null : h("div", { className: "dsh-ctf-muted" }, "等待条件：" + row.readiness.blockers.map(function (b) { return b.key + "：" + b.reason; }).join("；")),
				(row.conflicts || []).map(function (c) {
					var review = rows.find(function (r) { return r.key === c.reviewKey && r.epoch === row.epoch; });
					return h("div", { key: c.id }, c.phase === "open" ? "争议待复核：" : "争议已收口：", c.reviewKey,
						props.readOnly || row.stale || c.phase !== "open" || !review || ["supported", "refuted"].indexOf(review.status) < 0 ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy, onClick: function () { reviewDraft(row, review); } }, "核对并采纳复验"));
				}),
				row.observedResult ? h("div", null, "实际：" + row.observedResult) : null,
				row.nextStep ? h("div", null, "下一步：" + row.nextStep) : null,
				(row.evidence || []).map(function (ref) { return h("div", { key: ref.path }, h("code", { title: "登记时 SHA-256：" + ref.sha256 }, ref.path)); }),
				checked ? h("div", { className: "dsh-ctf-muted" }, "上次核对（" + fmtTime(checked.at) + "，非实时）：" + checked.text) : null,
				props.readOnly ? null : h("div", { className: "dsh-ctf-histacts" },
					h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy || (row.conflicts || []).some(function (c) { return c.phase === "open"; }), onClick: function () { edit(row); } }, row.stale ? "在当前范围另建" : "记录进展"),
					row.stale || row.reviewOf || ["supported", "refuted"].indexOf(row.status) < 0 || (row.conflicts || []).some(function (c) { return c.phase === "open"; }) ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy, onClick: function () { reviewDraft(row); } }, "发起争议复验"),
					!(row.evidence || []).length ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy, onClick: function () { check(row); } }, "核对证据")));
		}),
		rows.length > 12 ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { setAll(!all); } }, all ? "收起历史" : "查看全部实验") : null,
		!rows.length ? h("div", { className: "dsh-ctf-muted" }, "尚无结构化实验。解题子代理可通过 ctf_experiment_record 登记，重试时自动继承。") : null,
		!draft ? null : draft.mode ? h("div", { className: "dsh-ctf-form" },
			h("b", null, draft.mode === "review-open" ? "提交新证据并冻结原结论：" + draft.key : "采纳独立复验：" + draft.reviewKey),
			fieldInput(draft.mode === "review-open" ? "具体争议与可复验差异" : "比较证据并说明采纳依据", "reason", true),
			draft.mode === "review-open" ? fieldInput("新争议证据相对路径（每行一个）", "evidencePaths", true) : null,
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: busy, onClick: save }, busy ? "保存中…" : draft.mode === "review-open" ? "创建独立复验任务" : "采纳复验结论"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy, onClick: function () { setDraft(null); } }, "取消")) : h("div", { className: "dsh-ctf-form" },
			fieldInput("稳定实验 key（同一路径沿用同一 key）", "key"), fieldInput("可证伪假设", "hypothesis"),
			fieldInput("测试范围", "scope"), fieldInput("可观察的预期", "expectedResult"), fieldInput("实际命令/方法（仅记录，不执行）", "command", true),
			h("label", { className: "dsh-ctf-field" }, "状态", h("select", { className: "dsh-ctf-in", value: draft.status, disabled: busy, onChange: function (event) { setDraft(Object.assign({}, draft, { status: event.target.value })); } },
				Object.keys(labels).map(function (status) { return h("option", { key: status, value: status }, labels[status]); }))),
			fieldInput("实际结果或阻塞原因", "observedResult", true), fieldInput("证据文件相对路径（每行一个，最多四个）", "evidencePaths", true),
			dependencyEditor(),
			fieldInput("下一步最小实验", "nextStep", true), fieldInput("重开已收口实验时：说明新增变量与新证据", "reopenReason", true),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: busy, onClick: save }, busy ? "保存中…" : "保存实验"),
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: busy, onClick: function () { setDraft(null); } }, "取消")));
}

function TaskRecordsSection(props) {
	var ch = props.ch || {}, rows = ch.taskJournal || [];
	var busyS = useState(""), busy = busyS[0], setBusy = busyS[1];
	var confirmedS = useState(false), confirmed = confirmedS[0], setConfirmed = confirmedS[1];
	var noteS = useState(""), note = noteS[0], setNote = noteS[1];
	useEffect(function () { setConfirmed(false); setNote(""); setBusy(""); }, [ch.id]);
	if (!rows.length) return null;
	var pending = rows.filter(function (row) { return row.unresolved; });
	var visible = pending.slice(0, 20).concat(rows.filter(function (row) { return !row.unresolved; }).slice(-5).reverse());
	var needConfirmation = pending.some(function (row) { return row.phase === "unknown" && !row.local; });
	function operate(endpoint, row) {
		if (props.readOnly || busy) return;
		setBusy(row.taskId);
		request(endpoint, { id: ch.id, taskId: row.taskId, sessionId: props.sessionId || "", confirmStopped: confirmed, note: note,
			reason: "用户在题目详情请求取消" }).then(function (result) {
			setBusy("");
			if (props.say) props.say(result && result.ok ? result.message || "任务核对已保存" : result && result.error || "任务操作失败", !result || !result.ok);
			if (result && result.ok && endpoint === "task.resolve") { setConfirmed(false); setNote(""); }
			if (props.onChanged) props.onChanged();
		});
	}
	return h("div", { className: "dsh-ctf-sec" },
		h(SecTitle, { title: "任务与租约", count: pending.length }),
		!needConfirmation || props.readOnly ? null : h("div", { className: "dsh-ctf-wufact" },
			h("label", { className: "dsh-ctf-wbnote" }, h("input", { type: "checkbox", checked: confirmed, onChange: function (event) { setConfirmed(event.target.checked); } }), "已核实旧执行端确实停止"),
			h("input", { type: "text", value: note, placeholder: "填写核对依据；平台操作还需核对对应流水", onChange: function (event) { setNote(event.target.value); } })),
		visible.map(function (row) {
			return h("div", { key: row.taskId, className: "dsh-ctf-wufact" },
				h("b", null, ({ solver: "解题", review: "复核", submission: "平台提交", environment: "环境操作" }[row.kind] || row.kind) + " · " +
					({ registered: "已登记", running: "执行中", cancel_requested: "取消待确认", unknown: "待核对", settled: "执行端已结束", cancelled: "未派发", acknowledged: "人工核对已收口" }[row.phase] || row.phase)),
				h("div", null, "心跳 " + fmtTime(row.heartbeatAt) + " · " + (row.remainingMs == null ? "记录截止 " + fmtTime(row.expiresAt) : "本实例租约剩余 " + fmtDur(row.remainingMs))),
				h("code", null, row.taskId),
				!(row.sessionIds || []).length ? null : h("div", null, "执行会话：" + row.sessionIds.join("、")),
				!row.recoveryReason ? null : h("div", null, row.recoveryReason),
				!row.resolution ? null : h("div", null, row.resolution.note),
				props.readOnly || !row.unresolved ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy,
					onClick: function () { operate("task.cancel", row); } }, "请求取消"),
				props.readOnly || row.phase !== "unknown" || row.local ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy || !confirmed || !note.trim(),
					onClick: function () { operate("task.resolve", row); } }, "确认旧任务已停止"));
		}), pending.length > 20 ? h("div", { className: "dsh-ctf-muted" }, "更多任务可通过 ctf_tasks 查看。") : null);
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
		ch.preparation && ch.preparation.phase !== "ready" ? h("div", { className: "dsh-ctf-error is-inline is-warn" },
			"输入准备未完成，解题与平台写操作已暂停。" + (ch.preparation.error || (ch.preparation.phase === "files_ready" ? "请重试本地同步；完成后再显式开始。" : "正在准备附件；失败或中断后可在原记录中重试输入准备。"))) : null,
		ch.lifecycle && ch.lifecycle.taskUncertain ? h("div", { className: "dsh-ctf-error is-inline is-warn" }, "当前题目或同一平台题目的副本仍有任务未确认结束，重跑和清理已暂停。取消请求不会直接释放远端占用。") : null,
		ch.lifecycle && ch.lifecycle.submission === "unknown" ? h("div", { className: "dsh-ctf-error is-inline is-warn" }, "有 " + (ch.lifecycle.unresolvedSubmissions || 1) + " 条提交结果待核对，自动提交与环境清理已暂停。") : null,
		ch.lifecycle && ch.lifecycle.environmentOperationPending ? h("div", { className: "dsh-ctf-error is-inline is-warn" }, "环境操作结果待核对，新的解题任务和环境清理已暂停。") : null,
		ch.lifecycle && ch.lifecycle.localProjectionPending ? h("div", { className: "dsh-ctf-error is-inline is-warn" },
			"本地文件等待恢复同步：" + ((ch.localProjection && ch.localProjection.errors) || []).map(function (error) { return error.message || error.code; }).join("；")) : null,
		ch.lifecycle && ch.lifecycle.learningUsagePending ? h("div", { className: "dsh-ctf-error is-inline is-warn" },
			"有 " + ch.lifecycle.learningUsagePending + " 条使用统计待恢复。" + attempts.filter(function (a) { return a.usageEffect && a.usageEffect.pending; }).map(function (a) {
				return (a.usageEffect.errors || []).map(function (error) { return error.message || error.code; }).join("；");
			}).filter(Boolean).join("；")) : null,
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
				factsSection(facts)),
			h("aside", { className: "dsh-ctf-detailaside" },
				h(TaskRecordsSection, { ch: ch, sessionId: props.sessionId, readOnly: props.readOnly, say: props.say, onChanged: props.onChanged }),
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

// Widget IDs stay unique when the host mounts more than one conversation view.
var widgetSerial = 0;
function useWidgetId(prefix) {
	var ref = useRef(null);
	if (!ref.current) ref.current = "ctf-" + prefix + "-" + (++widgetSerial);
	return ref.current;
}
function tabKeyNavigation(e) {
	var keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
	if (keys.indexOf(e.key) < 0) return;
	var tabs = Array.prototype.slice.call(e.currentTarget.querySelectorAll('[role="tab"]'));
	var at = tabs.indexOf(e.target);
	if (at < 0) return;
	e.preventDefault();
	var next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + tabs.length) % tabs.length;
	tabs[next].focus(); tabs[next].click();
}
function CommandPalette(props) {
	var queryS = useState(""), query = queryS[0], setQuery = queryS[1];
	var dialog = useRef(null), input = useRef(null);
	var id = useWidgetId("search");
	useEffect(function () {
		var previous = document.activeElement;
		if (input.current) input.current.focus();
		return function () { if (previous && previous.isConnected) previous.focus(); };
	}, []);
	var needle = query.trim().toLowerCase();
	var rows = TABS.filter(function (t) { return !needle || (t.label + " " + t.desc).toLowerCase().indexOf(needle) >= 0; }).map(function (t) {
		return { id: "page-" + t.key, label: t.label, desc: "页面 · " + t.desc, icon: t.icon, run: function () { props.onNavigate(t.key); } };
	}).concat((props.challenges || []).filter(function (c) { return !needle || (c.title + " " + c.id + " " + (c.category || "")).toLowerCase().indexOf(needle) >= 0; }).slice(0, 12).map(function (c) {
		return { id: "challenge-" + c.id, label: c.title, desc: (STATUS_LABEL[c.status] || c.status) + " · " + catLabel(c.category), icon: "flag", run: function () { props.onChallenge(c); } };
	}));
	function choose(row) { props.onClose(); row.run(); }
	function keydown(e) {
		if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); return; }
		var buttons = Array.prototype.slice.call(dialog.current.querySelectorAll(".dsh-ctf-commanditem"));
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault(); var at = buttons.indexOf(document.activeElement);
			if (buttons.length) buttons[(at + (e.key === "ArrowDown" ? 1 : buttons.length - 1) + buttons.length) % buttons.length].focus();
		} else if (e.key === "Enter" && e.target === input.current && rows.length) { e.preventDefault(); choose(rows[0]); }
		else if (e.key === "Tab") {
			var focusable = Array.prototype.slice.call(dialog.current.querySelectorAll("input,button"));
			var first = focusable[0], last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
	}
	return h("div", { className: "dsh-ctf-modal", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose(); } },
		h("div", { ref: dialog, className: "dsh-ctf-dialog", role: "dialog", "aria-modal": "true", "aria-label": "快速查找页面或题目", onKeyDown: keydown },
			h("div", { className: "dsh-ctf-dialoghead" }, h(Icon, { name: "search", size: 20 }), h("input", { ref: input, value: query, onChange: function (e) { setQuery(e.target.value); }, placeholder: "查找页面、题目或分类…", "aria-label": "快速查找关键词", "aria-controls": id, autoComplete: "off" }), h("button", { type: "button", className: "dsh-ctf-iconbtn", "aria-label": "关闭快速查找", onClick: props.onClose }, h(Icon, { name: "close" }))),
			h("div", { className: "dsh-ctf-commandlist", id: id }, rows.length ? rows.map(function (row) {
				return h("button", { type: "button", className: "dsh-ctf-commanditem", key: row.id, onClick: function () { choose(row); } }, h(Icon, { name: row.icon }), h("span", null, row.label, h("small", null, row.desc)));
			}) : h("div", { className: "dsh-ctf-empty is-slim", role: "status" }, "没有匹配的页面或题目")),
			h("div", { className: "dsh-ctf-dialogfoot" }, "↑ ↓ 选择 · Enter 打开 · Esc 关闭")));
}
function OverviewPage(props) {
	var stats = props.stats, rows = props.challenges || [], snap = props.snap;
	if (!snap) return emptyState({ title: props.error ? "工作区暂时不可用" : "正在连接工作区…", desc: props.error ? "可使用上方刷新按钮重新连接。" : "读取题目进度与执行状态。", icon: props.error ? "!" : h("span", { className: "dsh-ctf-spin" }), role: "status", live: "polite" });
	var active = rows.filter(function (c) { return c.status === "running" || c.status === "queued"; });
	var attention = rows.filter(function (c) { return c.status === "stuck" || c.status === "failed" || c.taskUncertain || c.lifecycle && (c.lifecycle.taskUncertain || c.lifecycle.environmentOperationPending || c.lifecycle.submission === "unknown"); });
	var recent = rows.filter(function (c) { return c.lastEvent; }).sort(function (a, b) { return (b.lastEvent.at || 0) - (a.lastEvent.at || 0); }).slice(0, 6);
	function item(c, activity) {
		return h("div", { className: "dsh-ctf-activity", key: c.id }, h("span", { className: "dsh-ctf-activity-icon" }, h(Icon, { name: c.status === "solved" ? "check" : c.status === "running" ? "play" : "clock" })),
			h("div", { className: "dsh-ctf-activity-main" }, h("button", { type: "button", className: "dsh-ctf-card-title", onClick: function () { props.onChallenge(c); } }, c.title), h("p", null, activity ? c.lastEvent.text || EVENT_LABEL[c.lastEvent.kind] : c.stuckReason || (catLabel(c.category) + " · " + (c.status === "queued" ? "等待调度" : "已尝试 " + (c.attempts || 0) + " 次")))),
			activity ? h("time", null, fmtClock(c.lastEvent.at)) : h(Badge, { status: c.status }));
	}
	return h("div", { className: "dsh-ctf-page" },
		h("div", { className: "dsh-ctf-welcome" }, h("div", null, h("div", { className: "dsh-ctf-eyebrow" }, "YOUR CTF WORKSPACE"), h("h2", null, stats.total ? "每一步验证，都有迹可循。" : "从第一道题，开始解题。"), h("p", null, stats.total ? "已解出 " + stats.solved + " / " + stats.total + " 道题。" + (active.length ? "当前 " + active.length + " 道题正在执行或等待调度。" : "当前没有正在执行的题目。") : "导入比赛题目，组织实验与蜂群协作，将已验证的解题路径沉淀为经验。"), h("div", { className: "dsh-ctf-hero-tags" }, h("button", { className: "dsh-ctf-btn is-primary", type: "button", onClick: function () { props.onNavigate("board"); } }, "进入题目工作台", h(Icon, { name: "play", size: 12 })), h("button", { className: "dsh-ctf-btn", type: "button", onClick: function () { props.onNavigate("platform"); } }, "平台接入"))), h(ProgressRing, { value: pct(stats.solved, stats.total) })),
		h("div", { className: "dsh-ctf-kpis" }, h(Kpi, { label: "题目总数", value: stats.total, icon: "board" }), h(Kpi, { label: "正在运行", value: stats.running, icon: "play" }), h(Kpi, { label: "已解出", value: stats.solved, icon: "check" }), h(Kpi, { label: "待处理", value: attention.length, icon: "alert" })),
		h("div", { className: "dsh-ctf-dashboard-grid" },
			h("section", { className: "dsh-ctf-panel" }, h("div", { className: "dsh-ctf-sectionhead" }, h("h2", null, "执行队列"), h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { props.onNavigate("schedule"); } }, "查看调度 →")), active.length ? active.slice(0, 6).map(function (c) { return item(c); }) : h("div", { className: "dsh-ctf-empty is-slim" }, "队列空闲", h("span", { className: "dsh-ctf-muted" }, "在题目工作台开始下一次尝试。"))),
			h("section", { className: "dsh-ctf-panel" }, h("div", { className: "dsh-ctf-sectionhead" }, h("h2", null, "待处理"), h("span", null, attention.length + " 题")), attention.length ? attention.slice(0, 5).map(function (c) { return item(c); }) : h("div", { className: "dsh-ctf-empty is-slim" }, h(Icon, { name: "check", size: 24 }), "没有需要处理的题目")),
			h("section", { className: "dsh-ctf-panel" }, h("div", { className: "dsh-ctf-sectionhead" }, h("h2", null, "最近活动"), h("span", null, "各题最新事件")), recent.length ? recent.map(function (c) { return item(c, true); }) : h("div", { className: "dsh-ctf-muted" }, "开始解题后，实验和验证记录会出现在这里。")),
			h("section", { className: "dsh-ctf-panel" }, h("div", { className: "dsh-ctf-sectionhead" }, h("h2", null, "积累与复用")), [
			{ key: "knowledge", title: "检索知识库", desc: "按段落查找资料，追溯原文与证据", icon: "knowledge" },
			{ key: "memory", title: "查看经验记忆", desc: "复用已验证步骤，检查暂停召回的经验", icon: "memory" },
			{ key: "report", title: "整理复盘报告", desc: "导出 Writeup 与本轮解题过程", icon: "report" }
		].map(function (link) { return h("button", { type: "button", className: "dsh-ctf-quicklink", key: link.key, onClick: function () { props.onNavigate(link.key); } }, h(Icon, { name: link.icon, size: 20 }), h("span", null, link.title, h("small", null, link.desc)), h("span", { style: { flex: "none" } }, "↗")); }))));
}
