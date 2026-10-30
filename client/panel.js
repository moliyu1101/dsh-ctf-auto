function Panel(props) {
	var widgetId = useWidgetId("panel");
	var notesDirtyRef = useRef(false);
	var rootRef = useRef(null);
	var commandS = useState(false), commandOpen = commandS[0], setCommandOpen = commandS[1];
	var layoutS = useState("cards"), boardLayout = layoutS[0], setBoardLayout = layoutS[1];
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
	var groupModeS = useState("flat"), groupMode = groupModeS[0], setGroupMode = groupModeS[1];
	var collapsedS = useState({}), collapsed = collapsedS[0], setCollapsed = collapsedS[1];
	var ledgerOpenS = useState(false), ledgerOpen = ledgerOpenS[0], setLedgerOpen = ledgerOpenS[1];
	var ledgerEvS = useState(""), ledgerEv = ledgerEvS[0], setLedgerEv = ledgerEvS[1];
	var platformOpenS = useState(false), platformOpen = platformOpenS[0], setPlatformOpen = platformOpenS[1];
	var platformStatusS = useState(null), platformStatus = platformStatusS[0], setPlatformStatus = platformStatusS[1];
	var reportS = useState(null), report = reportS[0], setReport = reportS[1];
	var sessionExportS = useState(false), sessionExportBusy = sessionExportS[0], setSessionExportBusy = sessionExportS[1];
	var reportBusyS = useState(false), reportBusy = reportBusyS[0], setReportBusy = reportBusyS[1];
	var tabS = useState("overview"), tab = tabS[0];
	function mayLeave() { return !notesDirtyRef.current || window.confirm("题目笔记尚未保存。离开后将丢失这些修改，是否继续？"); }
	function setTab(next) { if (next === tab || !mayLeave() || (cfgDirty && tab === "settings" && !window.confirm("设置尚未保存，是否离开？"))) return; if (allScope && next !== "board" && next !== "overview") { setAllScope(false); challengeDetail.close(); } tabS[1](next); }
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
	var settingsSectionS = useState("execution"), settingsSection = settingsSectionS[0], setSettingsSection = settingsSectionS[1];
	var pagesS = useState({}), pages = pagesS[0], setPages = pagesS[1];
	var pageRequests = useRef({}), mounted = useRef(true), kbSearchSeq = useRef(0);
	useEffect(function () { mounted.current = true; return function () { mounted.current = false; kbSearchSeq.current += 1; }; }, []);
	function loadResources(key, specs) {
		var seq = (pageRequests.current[key] || 0) + 1; pageRequests.current[key] = seq;
		setPages(function (prev) { var next = Object.assign({}, prev); next[key] = Object.assign({}, prev[key], { loading: true, error: "" }); return next; });
		return Promise.all(specs.map(function (spec) { return request(spec.endpoint, Object.assign({ sessionId: sessionId }, spec.payload)); })).then(function (results) {
			if (!mounted.current || pageRequests.current[key] !== seq) return;
			var errors = [];
			results.forEach(function (result, index) { if (result && result.ok) specs[index].apply(result); else errors.push(result && result.error || "读取失败"); });
			setPages(function (prev) { var next = Object.assign({}, prev); next[key] = { loading: false, loaded: !errors.length || !!(prev[key] && prev[key].loaded), error: errors.join("；") }; return next; });
		});
	}
	function loadSettings() {
		return loadResources("settings", [{ endpoint: "config.get", apply: function (r) { if (r.config) { setRuntimeCfg(r.config); setCfgDefaults(r.defaults || null); setCfgDirty(false); } } }, { endpoint: "doctor", apply: setDoctor }]);
	}
	function loadReportPage() {
		return loadResources("report", [{ endpoint: "report.list", apply: function (r) { setReports(r.reports || []); } }, { endpoint: "writeup.list", apply: function (r) { setWriteups(r.writeups || []); } }]);
	}
	var sessionsSnap = isView ? readSessionsSnapshot(props) : null;
	useEffect(function () {
		if (!isView) return;
		request("platform.status", {}).then(function (r) { setPlatformStatus(r || null); });
	}, []);
	useEffect(function () {
		if (!isView) return;
		if (tab === "settings") loadSettings();
		if (tab === "report") loadReportPage();
		if (tab === "knowledge") loadKnowledge();
		if (tab === "memory") loadMemory();
		if (tab === "schedule") loadSchedule();
	}, [tab, isView, sessionId]);

	function resetForm() {
		setTitle(""); setCategory(""); setStatement(""); setTarget(""); setFilesText("");
	}
	function toggle(id) {
		if (mayLeave()) toggleDetail(id);
	}
	function openChallenge(c) {
		if (!mayLeave()) return;
		setStatusFilter("all"); setCatFilter(""); setQuery(""); setOnlyMine(false);
		tabS[1]("board"); challengeDetail.open(c.id);
	}
	function closeChallenge() { if (mayLeave()) challengeDetail.close(); }
	useEffect(function () {
		if (tab === "board" && expanded && rootRef.current) {
			var heading = rootRef.current.querySelector(".dsh-ctf-focushead");
			if (heading) heading.focus();
		}
	}, [expanded, tab]);
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
		if (busy || allScope) return;
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
					onDirtyChange: function (dirty) { notesDirtyRef.current = dirty; },
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
					h("button", { type: "button", className: "dsh-ctf-card-title", title: c.title, onClick: function () { openChallenge(c); }, "aria-label": "打开题目：" + c.title }, c.title || "(未命名)"),
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
						"aria-expanded": open, title: open ? "关闭工作台" : "打开工作台", "aria-label": open ? "关闭工作台" : "打开工作台",
						onClick: function () { toggle(c.id); }
					}, h(Icon, { name: "chevron", size: 17, className: open ? "is-open" : "" })),
					allScope ? null : h("button", {
						type: "button", className: "dsh-ctf-iconbtn" + (moreOpen ? " is-on" : ""),
						"aria-expanded": moreOpen, title: "更多操作", "aria-label": "更多操作",
						onClick: toggleMore
					}, h(Icon, { name: "more", size: 17 })))),
			moreOpen ? h("div", { className: "dsh-ctf-card-more" }, React.Children.toArray(secondary)) : null,
			c.stuckReason ? h("div", { className: "dsh-ctf-card-warn" }, h(Icon, { name: "alert", size: 14 }), "卡点：" + c.stuckReason) : null,
			null);
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
						}, busy === "add" ? "创建中…" : autoStart ? "创建并入队" : "创建题目")))));
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
					say(r.warning || "已移除题目：" + c.title, !!r.warning);
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
				if (r && r.ok) { say(r.warning || "已移除该会话的 " + (r.removed || 0) + " 道题", !!r.warning); reload(); }
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
			concurrency: Number(c.concurrency), timeoutMs: Number(c.timeoutMs),
			idleTimeoutMs: Number(c.idleTimeoutMs ?? 300000), maxAttempts: Number(c.maxAttempts),
			swarmEnabled: !!c.swarmEnabled, swarmConcurrency: Number(c.swarmConcurrency || 2), swarmWorkerTimeoutMs: Number(c.swarmWorkerTimeoutMs || 180000),
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
		var waitingForStop = queue.waitingForStop || [];
		var occupiedSlots = queue.occupiedSlots == null ? running.length : queue.occupiedSlots;
		var maxBar = Math.max(1, ...(rate.buckets || []).map(function (b) { return Math.max(b.attempts || 0, b.solved || 0); }));
		var hero = h("div", { className: "dsh-ctf-hero" },
			h("div", { className: "dsh-ctf-hero-main" },
				h("div", { className: "dsh-ctf-hero-title" }, "队列与节奏"),
				h("div", { className: "dsh-ctf-hero-sub" }, "比赛级队列：并发占用、运行中/排队中题目、最近 30 分钟节奏与最近完成（耗时/费用）。"),
				h("div", { className: "dsh-ctf-hero-tags" },
					h("span", { className: "dsh-ctf-pill " + (waitingForStop.length ? "is-warn" : "is-ok") }, "并发占用 " + occupiedSlots + "/" + (queue.concurrency || cfg.concurrency || 1)),
					waitingForStop.length ? h("span", { className: "dsh-ctf-chip" }, "待确认结束 " + waitingForStop.length) : null,
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
		var waitingPanel = waitingForStop.length ? h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "待确认结束", count: waitingForStop.length }),
			h("div", { className: "dsh-ctf-muted" }, "以下任务仍占用并发名额。请在题目详情的「任务与租约」中查看；旧任务需核实执行端停止后再收口。"),
			h("div", { className: "dsh-ctf-histlist" }, waitingForStop.map(function (row, index) {
				return h("div", { key: row.taskId || row.id + ":" + index, className: "dsh-ctf-histcard" },
					h("span", { className: "dsh-ctf-pill is-warn" }, "占用中"),
					h("div", { className: "dsh-ctf-histmain" },
						h("b", { className: "dsh-ctf-histname", title: row.title }, row.title),
						h("div", { className: "dsh-ctf-histmeta" },
							h("span", null, ({ registered: "已登记", running: "执行中", cancel_requested: "取消待确认", unknown: "待核对", awaiting_release: "等待释放" }[row.phase] || row.phase)),
							row.taskId ? h("code", null, row.taskId) : null)));
			}))) : null;
		var queuedPanel = h("div", { className: "dsh-ctf-panel" },
			h(SecTitle, { title: "排队中", count: queued.length }),
			queued.length === 0
				? h("div", { className: "dsh-ctf-empty is-slim" }, h("b", null, "队列为空"))
				: h("div", { className: "dsh-ctf-histlist" }, queued.map(function (row) {
					return h("div", { key: row.id, className: "dsh-ctf-histcard" },
						h("span", { className: "dsh-ctf-histbadge" }, "#" + (row.position || "?")),
						h("div", { className: "dsh-ctf-histmain" },
							h("b", { className: "dsh-ctf-histname", title: row.title }, row.title),
							h("div", { className: "dsh-ctf-histmeta" }, row.category ? h("span", { className: "dsh-ctf-chip" }, catLabel(row.category)) : null,
							h("span", { title: "估算仅供参考，实际受重试、任务恢复和靶机串行限制影响" }, row.estimatedWaitMs == null ? (row.waitReason || "等待时间待估算") : "预计等待约 " + fmtDur(row.estimatedWaitMs)))),
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
				h(Kpi, { label: "并发占用", value: occupiedSlots + "/" + (queue.concurrency || cfg.concurrency || 1), tone: waitingForStop.length ? "warn" : "ok", icon: "play", hint: "含待确认结束任务" }),
				h(Kpi, { label: "排队中", value: queued.length, icon: "schedule", hint: "等待槽位" }),
				h(Kpi, { label: "30min 尝试", value: rate.attempts30 || 0, icon: "retry", hint: "最近 30 分钟" }),
				h(Kpi, { label: "30min 完成", value: rate.solved30 || 0, tone: "ok", icon: "check", hint: "最近 30 分钟" })),
			runningPanel, waitingPanel, queuedPanel,
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
						return used && used.used ? h("span", { className: "dsh-ctf-kbtag" }, "召回 " + used.used + " / 召回后解出 " + (used.usedOk || 0)) : null;
					})()),
				h("div", { className: "dsh-ctf-kbsnippet" }, hlKb(row.snippet, kbQuery)),
				row.citation ? h("div", { className: "dsh-ctf-muted", title: "文件 SHA-256：" + row.citation.contentHash }, "引用行 " + row.citation.startLine + "–" + row.citation.endLine + (row.citation.heading ? " · " + row.citation.heading : "")) : null,
				row.trust ? h("div", { className: "dsh-ctf-muted" }, row.trust) : null,
				row.duplicateSources && row.duplicateSources.length ? h("div", { className: "dsh-ctf-muted" }, "已合并 " + row.duplicateSources.length + " 个重复来源") : null,
				row.feedback && row.feedback.contradicted ? h("div", { className: "dsh-ctf-muted" }, "该段落版本有矛盾反馈，已暂停自动召回") : null,
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
				h("button", { type: "button", className: "dsh-ctf-btn", onClick: function () { loadKnowledge(); } }, "刷新")));

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
				kbMini("召回观察", (kbStats && kbStats.usage ? (kbStats.usage.usedOk || 0) + "/" + (kbStats.usage.used || 0) : "0/0"), "召回后解出/总召回，不代表效果")),
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
					className: "dsh-ctf-in dsh-ctf-search is-icon", "aria-label": "检索知识库", placeholder: "搜技法 / 题型 / 工具 / flag 片段…（回车检索）",
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
				h("div", { className: "dsh-ctf-sidecol" }, searchCard, previewPanel),
				h("div", { className: "dsh-ctf-sidecol" }, importCard)));
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
			h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: rebuildMemories }, "重新核验并重建"),
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
					card.learning ? h("div", { className: "dsh-ctf-muted", title: card.revisionId }, card.learning.routes.length ? "步骤有实验文件证据，仍须在本题复验" : "题目最终结果经核验；笔记步骤仅供参考") : null,
					card.learning ? card.learning.negatives.map(function (r) { return h("div", { key: r.key, className: "dsh-ctf-wufact" }, "历史负结果范围：" + r.scope + "；" + r.observedResult + "。不能直接排除本题。"); }) : null,
					card.feedback ? h("div", { className: "dsh-ctf-muted" }, "带证据反馈：有用 " + card.feedback.helpful + " · 范围不适用 " + card.feedback.inapplicable + " · 矛盾 " + card.feedback.contradicted) : null,
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
								h("span", { className: "dsh-ctf-pill is-ok" }, "质量评分 " + Math.round((card.confidence || 0) * 100))),
							h("div", { className: "dsh-ctf-wumeta" },
								(card.tech || []).slice(0, 8).map(function (tag) { return h("span", { key: tag, className: "dsh-ctf-chip" }, tag); }),
								h("span", { className: "dsh-ctf-wumetric" }, "召回后解出 " + rate))),
						h("div", { className: "dsh-ctf-wuacts" },
							h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", onClick: function () { setMemExpand(open ? "" : card.id); } }, open ? "收起" : "展开"))),
					detail);
			})));
		var quarantine = mem.memory && mem.memory.quarantined || [];
		var quarantinePanel = !quarantine.length ? null : h("div", { className: "dsh-ctf-panel" }, h(SecTitle, { title: "暂停自动召回的记忆", count: quarantine.length }),
			h("div", { className: "dsh-ctf-muted" }, "旧数据保留。来源仍可核验时，可使用上方“重新核验并重建”更新；存在争议或证据损坏时须先修复。"),
			quarantine.slice(0, 30).map(function (r) { return h("div", { className: "dsh-ctf-wufact", key: r.id }, h("b", null, r.title), h("div", null, r.reason)); }));
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
		return h("div", { className: "dsh-ctf-page" }, hero, wsCards, cardsPanel, quarantinePanel, factsPanel);
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
				h("button", { type: "button", className: "dsh-ctf-btn", onClick: function () { loadReportPage(); } }, "刷新")));

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
				value: value == null || !Number.isFinite(Number(value)) ? "" : value,
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
						renderSetting("并发上限", "同时运行的题目数（1-8）；辅助代理另有全局上限", numInput("concurrency", c.concurrency, 1, 1, 1, 8)),
						renderSetting("单次预算（分钟）", "每次尝试的时间上限", numInput("timeoutMs", Math.round((c.timeoutMs || 0) / 60000), 60000, 1, 1, 240)),
						renderSetting("无产出提醒（分钟）", "无事实、事件或文件变化时提醒；再等待同样时长仍无产出则收口换方向，0 关闭", numInput("idleTimeoutMs", Number(c.idleTimeoutMs ?? 300000) / 60000, 60000, 1, 0, 60)),
						renderSetting("按假设派工的蜂群", "协调者按实验派工，默认关闭；启用后额外消耗模型额度", h("input", { type: "checkbox", checked: !!c.swarmEnabled, onChange: function (e) { setCfgField("swarmEnabled", e.target.checked); } })),
						renderSetting("全局辅助代理上限", "所有题目合计（1-4），每题最多两个；等待退出回执的仍占用", numInput("swarmConcurrency", c.swarmConcurrency || 2, 1, 1, 1, 4)),
						renderSetting("辅助代理预算（秒）", "受本题剩余预算限制（30-600）", numInput("swarmWorkerTimeoutMs", Number(c.swarmWorkerTimeoutMs || 180000) / 1000, 1000, 1, 30, 600)),
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
					renderSetting("解出后自动提交 flag", "本地候选提交到来源平台后，以平台回显确定结果", h("input", {
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
			form = h("div", { className: "dsh-ctf-setstack" },
				h("div", { className: "dsh-ctf-seg", role: "group", "aria-label": "设置分类" }, [{ key: "execution", label: "执行与蜂群" }, { key: "model", label: "模型与预算" }, { key: "learning", label: "验证与学习" }, { key: "platform", label: "平台与靶机" }, { key: "storage", label: "存储" }].map(function (section) { return h("button", { key: section.key, type: "button", className: "dsh-ctf-segbtn" + (settingsSection === section.key ? " is-on" : ""), "aria-pressed": settingsSection === section.key, onClick: function () { setSettingsSection(section.key); } }, section.label); })),
				settingsSection === "execution" ? card1 : settingsSection === "model" ? h("div", { className: "dsh-ctf-setstack" }, card3, card2) : settingsSection === "learning" ? card4 : settingsSection === "platform" ? h("div", { className: "dsh-ctf-setstack" }, card5, card7) : card6);
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
						h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: cfgBusy || !runtimeCfg || !cfgDirty, onClick: saveCfgForm }, cfgBusy ? "保存中…" : "保存配置"),
						cfgMsg ? h("span", { className: "dsh-ctf-muted" }, cfgMsg) : null)),
				form,
				h("div", { className: "dsh-ctf-setcard" },
					h(SecTitle, { title: "诊断", count: 0 }),
					diag),
				h("div", { className: "dsh-ctf-panel dsh-ctf-footer-note" },
					h("div", { className: "dsh-ctf-muted" }, "提示：并发提高后立即生效；预算与尝试次数对下一次尝试生效；模型字段留空表示沿用默认路由。")));
		}
	function loadKnowledge() {
		return loadResources("knowledge", [{ endpoint: "kb.list", apply: function (r) { setKbFiles(r.files || []); } }, { endpoint: "kb.stats", apply: setKbStats }]);
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
		return loadResources("schedule", [{ endpoint: "schedule.summary", apply: setSchedData }]);
	}
	function stopChallenge(c) {
		request("challenge.stop", { id: c.id, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已停止，可一键重试：" + (c.title || c.id)); loadSchedule(); reload(); }
			else say((r && r.error) || "停止失败", true);
		});
	}
	function loadMemory() {
		return loadResources("memory", [{ endpoint: "memory.summary", payload: { limit: 120 }, apply: setMemData }, { endpoint: "memory.cards", apply: function (r) { setMemCards(r.cards || []); } }]);
	}
	function distillAll() {
		request("memory.distill", { all: true, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已沉淀 " + (r.distilled || 0) + " 张打法卡"); loadMemory(); }
			else say((r && r.error) || "沉淀失败", true);
		});
	}
	function rebuildMemories() {
		request("memory.distill", { all: true, refresh: true, sessionId: sessionId }).then(function (r) {
			if (r && r.ok) { say("已核验并重建 " + (r.distilled || 0) + " 张打法卡" + (r.remaining ? "，仍有 " + r.remaining + " 张待重建，可继续本操作" : "")); loadMemory(); }
			else say((r && r.error) || "重建失败", true);
		});
	}
	function searchKb(queryOverride) {
		const q = String(queryOverride || kbQuery || "").trim();
		if (!q) { say("请输入检索词", true); return; }
		setKbBusy(true);
		var seq = ++kbSearchSeq.current;
		request("kb.search", { q, limit: 8, sessionId }).then(function (r) {
			if (!mounted.current || seq !== kbSearchSeq.current) return;
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
	async function exportWorkspaceConversation() {
		if (sessionExportBusy || !sessionId) return;
		setSessionExportBusy(true);
		try {
			var token = await csrfOf();
			var response = await sendPost(token, 'sessions.export.download', { sessionId: sessionId });
			if (response.status === 403) { delete csrfCache[API_BASE]; response = await sendPost(await csrfOf(), 'sessions.export.download', { sessionId: sessionId }); }
			if (!response.ok) { var failure = await response.json(); throw Error(failure.error || '会话导出失败'); }
			var blob = await response.blob();
			var link = document.createElement('a'), url = URL.createObjectURL(blob);
			link.href = url; link.download = (response.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'workspace-ai-sessions.tar.gz';
			document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
			var complete = response.headers.get('x-dsh-export-complete') === 'true';
			say('已导出 ' + response.headers.get('x-dsh-export-sessions') + ' 个会话' + (complete ? '；原始对话与附件清单已打包' : '；有 ' + response.headers.get('x-dsh-export-issues') + ' 项缺失或快照说明，请查看 manifest.json'), !complete);
		} catch (error) { say(error.message || '会话导出失败', true); }
		finally { setSessionExportBusy(false); }
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
		else if (tab === "report") loadReportPage();
		else if (tab === "settings" && !cfgDirty) loadSettings(); else if (tab === "platform") {
			request("platform.status", {}).then(function (r) { setPlatformStatus(r || null); });
		}
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
		if (allScope) return;
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
		if (allScope) return;
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
				key: t.key, type: "button", role: "tab", "aria-label": t.label, id: widgetId + "-nav-" + t.key, "aria-controls": widgetId + "-page",
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
					h(Kpi, { label: "总题数", value: stats.total, icon: "board", hint: allScope ? "全部工作区" : "当前工作区" }),
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
						!allScope && statusFilter === "unsolved" ? h("button", {
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
							onChange: function (e) { if (!mayLeave()) return; challengeDetail.close(); setAllScope(e.target.checked); }
						}), "全部工作区") : null,
					sessionId ? h("label", { className: "dsh-ctf-toggle" + (onlyMine ? " is-on" : "") },
						h("input", {
							type: "checkbox", checked: onlyMine, disabled: allScope,
							onChange: function (e) { setOnlyMine(e.target.checked); }
						}), "仅本会话") : null,
					!allScope && uncategorizedCount > 0 ? h("button", {
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
				actions: [h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: allScope, onClick: function () { setFormOpen(true); } }, h(Icon, { name: "plus", size: 14 }), "新建题目")],
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
	if (tab === "overview") {
		tabBody = h(OverviewPage, { snap: snap, error: err, challenges: allChallenges, stats: stats, onNavigate: setTab, onChallenge: openChallenge, onNew: function () { setTab("board"); setFormOpen(true); }, readOnly: allScope });
	} else if (tab === "platform") {
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
		tabBody = h("div", { className: "dsh-ctf-page dsh-ctf-board-" + boardLayout },
			renderFilters(),
			formOpen && !allScope ? renderForm() : null,
			h("div", { className: "dsh-ctf-boardmode" }, h("span", null, challenges.length + " 道题目 · 选择题目进入工作台"),
				h("div", { className: "dsh-ctf-seg", role: "group", "aria-label": "题板视图" }, [{ key: "cards", label: "卡片" }, { key: "list", label: "列表" }, { key: "kanban", label: "看板" }].map(function (mode) {
					return h("button", { key: mode.key, type: "button", className: "dsh-ctf-segbtn" + (boardLayout === mode.key ? " is-on" : ""), "aria-pressed": boardLayout === mode.key, onClick: function () { setBoardLayout(mode.key); } }, mode.label);
				}))),
			expanded && allChallenges.some(function (c) { return c.id === expanded; }) ? h("div", { className: "dsh-ctf-focus" },
				h("div", { className: "dsh-ctf-focushead", tabIndex: -1 }, h("h2", null, allChallenges.filter(function (c) { return c.id === expanded; })[0].title), h("button", { type: "button", className: "dsh-ctf-iconbtn", onClick: closeChallenge, "aria-label": "关闭题目工作台" }, h(Icon, { name: "close" }))),
				renderDetail(allChallenges.filter(function (c) { return c.id === expanded; })[0])) : null,
			boardLayout === "kanban" && challenges.length ? h("div", { className: "dsh-ctf-kanban", "aria-label": "按状态分栏的题目看板" }, [
				{ label: "待开始", statuses: ["queued", "stopped"] }, { label: "执行中", statuses: ["running"] }, { label: "待处理", statuses: ["stuck", "failed"] }, { label: "已解出", statuses: ["solved"] }
			].map(function (lane) { var rows = challenges.filter(function (c) { return lane.statuses.indexOf(c.status) >= 0; }); return h("section", { className: "dsh-ctf-lane", key: lane.label }, h("h2", null, lane.label, h("span", null, rows.length)), rows.length ? rows.map(renderCard) : h("div", { className: "dsh-ctf-muted" }, "暂无题目")); })) : h("div", { className: "dsh-ctf-list" }, pinnedBlock, listBody));
	}

	var pageState = pages[tab] || {};
	if (["settings", "report", "knowledge", "memory", "schedule"].indexOf(tab) >= 0 && !pageState.loaded) {
		tabBody = emptyState({ title: pageState.error ? "资料暂时不可用" : "正在载入…", desc: pageState.error || "读取当前工作区的数据。", icon: pageState.error ? "!" : h("span", { className: "dsh-ctf-spin" }), role: "status", live: "polite", actions: pageState.error ? [h("button", { type: "button", className: "dsh-ctf-btn", onClick: refreshCurrent }, "重新加载")] : [] });
	}
	var formShown = tab === "board" && formOpen;
	function toggleForm() {
		if (tab !== "board") { setTab("board"); setFormOpen(true); return; }
		setFormOpen(!formOpen);
	}
	var currentTab = TABS.filter(function (x) { return x.key === tab; })[0] || TABS[0];
	var boardStartable = challenges.filter(function (c) { return c && c.status !== "solved" && c.status !== "running"; }).length;
	var boardActive = challenges.filter(function (c) { return c && (c.status === "running" || c.status === "queued"); }).length;

	return h("div", { ref: rootRef, className: "dsh-ctf-root" + (isView ? " is-view" : ""), onKeyDown: function (e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen(true); } } },
		h("div", { className: "dsh-ctf-shell" },
			h("aside", { className: "dsh-ctf-rail", "aria-label": "CTF 自动解题导航" },
				h("div", { className: "dsh-ctf-railbrand" },
					h("div", { className: "dsh-ctf-railmark" }, h(Icon, { name: "target", size: 21 })),
					h("div", { className: "dsh-ctf-railname" },
						h("b", null, "CTF Workspace"),
						h("span", null, "AUTONOMOUS SOLVING"))),
				h("button", { type: "button", className: "dsh-ctf-launcher", onClick: function () { setCommandOpen(true); }, "aria-label": "快速查找", "aria-haspopup": "dialog" }, h(Icon, { name: "search", size: 16 }), h("span", null, "快速查找"), h("kbd", null, "⌘ K")),
			h("div", { className: "dsh-ctf-railcap" }, "工作空间"),
				h("nav", { className: "dsh-ctf-railnav", role: "tablist", "aria-label": "CTF 自动解题页面", "aria-orientation": "vertical", onKeyDown: tabKeyNavigation }, renderTabs()),
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
							"WORKSPACE / " + (tab === "overview" ? "OVERVIEW" : tab.toUpperCase())),
						h("h1", { className: "dsh-ctf-pagetitle" }, currentTab.label),
						h("div", { className: "dsh-ctf-pagedesc" }, currentTab.desc)),
					h("div", { className: "dsh-ctf-topbar-actions" },
						h("button", { type: "button", className: "dsh-ctf-btn", disabled: sessionExportBusy || !sessionId || allScope, title: "导出当前工作区主会话、子代理原始事件和关联附件，保留比赛 AI 使用记录", onClick: exportWorkspaceConversation }, h(Icon, { name: "download", size: 15 }), sessionExportBusy ? "正在导出会话…" : "导出工作区会话"),
						h("button", { type: "button", className: "dsh-ctf-iconbtn", onClick: function () { setCommandOpen(true); }, "aria-label": "快速查找", title: "查找页面或题目", "aria-haspopup": "dialog" }, h(Icon, { name: "search" })),
						isView ? h("button", {
							type: "button",
							className: "dsh-ctf-btn is-ghost dsh-ctf-platform-pill " + platformTone,
							title: "打开平台接入",
							onClick: function () { setTab("platform"); }
						}, h("span", null, platformLabel)) : null,
						isView && tab === "report" ? h("button", {
							type: "button", className: "dsh-ctf-btn is-ghost", disabled: reportBusy,
							title: "导出复盘", "aria-label": "导出复盘",
							onClick: exportReport
						}, h(Icon, { name: "download", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, reportBusy ? "导出中…" : "导出复盘")) : null,
						isView && !allScope && tab === "board" && boardStartable > 0 ? h("button", {
							type: "button", className: "dsh-ctf-btn is-primary", disabled: !!busy,
							title: "把当前题板所有未解题加入调度队列", "aria-label": "一键开始",
							onClick: function () { startAllChallenges(challenges); }
						}, h(Icon, { name: "play", size: 15 }), h("span", { className: "dsh-ctf-btn-text" }, busy === "startAll" ? "启动中…" : "一键开始 (" + boardStartable + ")")) : null,
						isView && !allScope && tab === "board" && boardActive > 0 ? h("button", {
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
							"aria-expanded": formShown, disabled: allScope,
							onClick: toggleForm
						}, h(Icon, { name: "plus", size: 15 }), h("span", null, formShown ? "收起表单" : "新建题目")))),
				renderBanners(err, warning, reload),
				allScope ? h("div", { className: "dsh-ctf-scopebanner" }, h("span", null, "全部工作区 · 只读浏览"), h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: function () { if (!mayLeave()) return; challengeDetail.close(); setAllScope(false); } }, "返回当前工作区")) : null,
				h("section", { id: widgetId + "-page", role: "tabpanel", "aria-labelledby": widgetId + "-nav-" + tab, tabIndex: 0, "aria-busy": !!pageState.loading }, pageState.loaded && pageState.error ? h("div", { className: "dsh-ctf-error", role: "alert" }, "刷新失败，保留上次数据：" + pageState.error) : null, tabBody),
				h("div", { className: "dsh-ctf-sync" + (err ? " is-error" : "") }, h("span", { className: "dsh-ctf-raildot" + (updatedAt && !err ? " is-live" : "") }), err ? "同步异常 · 当前显示最近一次数据" : updatedAt ? "已同步 " + fmtClock(updatedAt) + " · 页面可见时每 3 秒更新题目状态" : "正在连接工作区"),
				commandOpen ? h(CommandPalette, { challenges: allChallenges, onClose: function () { setCommandOpen(false); }, onNavigate: setTab, onChallenge: openChallenge }) : null,
				toast ? h("div", {
					className: "dsh-ctf-toast" + (toast.err ? " is-err" : ""),
					role: toast.err ? "alert" : "status",
					"aria-live": toast.err ? "assertive" : "polite"
				}, toast.text) : null)));

}
