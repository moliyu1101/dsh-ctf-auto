function WorkbenchBody(props) {
	var id = props.id;
	var widgetId = useWidgetId("workbench");
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
	var readSeq = useRef(0);
	var readS = useState(null), read = readS[0], setRead = readS[1];
	var readErrS = useState(""), readErr = readErrS[0], setReadErr = readErrS[1];
	var flagS = useState(""), flag = flagS[0], setFlag = flagS[1];
	var submitBusyS = useState(false), submitBusy = submitBusyS[0], setSubmitBusy = submitBusyS[1];
	var retryRequiredS = useState(false), retryRequired = retryRequiredS[0], setRetryRequired = retryRequiredS[1];
	var allowRetryS = useState(false), allowRetry = allowRetryS[0], setAllowRetry = allowRetryS[1];
	var acceptEnvironmentS = useState(false), acceptEnvironment = acceptEnvironmentS[0], setAcceptEnvironment = acceptEnvironmentS[1];
	var unresolved = retryRequired || (ch.lifecycle && ch.lifecycle.submission === "unknown");

	useEffect(function () {
		if (props.onDirtyChange) props.onDirtyChange(notesDirty);
		return function () { if (props.onDirtyChange) props.onDirtyChange(false); };
	}, [notesDirty]);
	useEffect(function () {
		if (!notesDirty) return;
		function warn(e) { e.preventDefault(); e.returnValue = ""; }
		window.addEventListener("beforeunload", warn);
		return function () { window.removeEventListener("beforeunload", warn); };
	}, [notesDirty]);

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
			if (r && r.ok) { setNotes(r.text || ""); setNotesDirty(false); setNotesLoaded(true); }
			else { setNotesLoaded(false); setWbErr((r && r.error) || "读取笔记失败，请重试后编辑。"); }
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
		var seq = ++readSeq.current;
		setReadErr("");
		setRead({ path: path, text: "", loading: true });
		request("workbench.read", { id: id, path: path, sessionId: sessionId }).then(function (r) {
			if (readSeq.current !== seq) return;
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
			say(r && r.ok ? "本地数据已同步" : r && r.error || "同步仍未完成，请检查文件权限及格式", !r || !r.ok);
			onChanged();
		});
	}
	function retryPreparation() {
		if (readOnly || submitBusy) return;
		setSubmitBusy(true);
		request("challenge.prepare", { id: id, sessionId: sessionId }).then(function (r) {
			setSubmitBusy(false);
			say(r && r.ok ? "输入已准备完成，请显式开始解题" : r && r.error || "输入准备仍未完成，请检查失败原因", !r || !r.ok);
			if (r && r.ok) refreshTree();
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
		{ key: "overview", label: "题面与状态", icon: "board" },
		{ key: "experiments", label: "实验黑板", icon: "target" },
		{ key: "swarm", label: "蜂群协作", icon: "swarm" },
		{ key: "history", label: "尝试与事件", icon: "clock" },
		{ key: "learning", label: "学习反馈", icon: "memory" },
		{ key: "files", label: "附件 " + counts.files, icon: "folder" },
		{ key: "notes", label: "笔记", icon: "report" },
		{ key: "scripts", label: "脚本 " + counts.scripts, icon: "settings" },
		{ key: "artifacts", label: "产物 " + counts.artifacts, icon: "download" }
	];
	var body;
	if (tab === "overview") body = h(ChallengeDetailBody, { ch: ch, sessionId: sessionId, readOnly: readOnly, say: say, onChanged: onChanged });
	else if (tab === "experiments") body = h(ExperimentRecordsSection, { ch: ch, sessionId: sessionId, readOnly: readOnly, say: say, onChanged: onChanged });
	else if (tab === "swarm") body = h(SwarmRecordsSection, { ch: ch, sessionId: sessionId, readOnly: readOnly, say: say, onChanged: onChanged });
	else if (tab === "learning") body = h(LearningFeedbackSection, { ch: ch, sessionId: sessionId, readOnly: readOnly, say: say, onChanged: onChanged });
	else if (tab === "history") body = h("div", { className: "dsh-ctf-detailgrid" }, h("div", null, attemptsSection(ch.attempts || [])), h("div", null, eventsSection(ch.events || [])));
	else if (tab === "files") body = h("div", null, fileList(entriesUnder("files"), "附件目录为空（files/）。"), readPreview());
	else if (tab === "notes") {
		body = h("div", { className: "dsh-ctf-notes" },
			readOnly
				? h("pre", { className: "dsh-ctf-wbread" }, notes || "（notes.md 为空）")
				: h("textarea", {
					value: notes, "aria-label": "题目笔记", disabled: !notesLoaded || notesBusy,
					placeholder: "随做随记：发现 / 假设 / 验证 / 卡点…",
					onChange: function (e) { setNotes(e.target.value); setNotesDirty(true); }
				}),
			h("div", { className: "dsh-ctf-wbactions" },
				readOnly
					? h("span", { className: "dsh-ctf-wbnote" }, "设置页为只读工作台；请在会话视图编辑笔记。")
					: h("button", {
						type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: notesBusy || !notesLoaded || !notesDirty, onClick: saveNotes
					}, notesBusy ? "保存中…" : (notesDirty ? "保存笔记 *" : "保存笔记")),
				h("span", { className: "dsh-ctf-wbnote" }, "写入 notes.md（≤512KB，仅题目录内；保存后下次尝试会带上前序笔记）。")));
	} else {
		var entries = entriesUnder(tab === "scripts" ? "scripts" : "artifacts");
		body = h("div", null, fileList(entries, tab === "scripts" ? "脚本目录为空（scripts/）。" : "产物目录为空（artifacts/）。"), readPreview());
	}

	var wbPrimary = null;
	if (!readOnly) {
		if (ch.lifecycle && ch.lifecycle.permissions && ch.lifecycle.permissions.prepare) {
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: submitBusy, onClick: retryPreparation, title: "重新读取本地附件或重新下载平台附件，完成后保持停止" }, "重试输入准备");
		} else if (status === "running") {
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-danger", onClick: function () { onAction("stop"); } }, h(Icon, { name: "stop", size: 13 }), "停止");
		} else if (status === "solved") {
			wbPrimary = onWriteup ? h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", onClick: onWriteup }, h(Icon, { name: "download", size: 13 }), "导出 Writeup") : null;
		} else if (status === "queued" || (status === "stopped" && !(ch.attempts || []).length)) {
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: submitBusy || !!(ch.lifecycle && (ch.lifecycle.taskUncertain || ch.lifecycle.permissions && ch.lifecycle.permissions.start === false)), onClick: function () { onAction("start"); } }, h(Icon, { name: "play", size: 13 }), "开始解题");
		} else {
			var again = status === "stuck" ? "再试一次" : status === "stopped" ? "继续尝试" : "重试";
			wbPrimary = h("button", { type: "button", className: "dsh-ctf-btn is-sm is-primary", disabled: submitBusy || !!(ch.lifecycle && (ch.lifecycle.taskUncertain || ch.lifecycle.permissions && ch.lifecycle.permissions.retry === false)), onClick: function () { onAction("retry"); } }, h(Icon, { name: "retry", size: 13 }), again);
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
			h("button", { type: "button", className: "dsh-ctf-btn is-sm", onClick: function () { refreshTree(); if (!notesDirty) loadNotes(); } }, "重试")) : null,
		h("div", { className: "dsh-ctf-wbtabs", role: "tablist", "aria-label": "工作台分页", onKeyDown: tabKeyNavigation }, tabs.map(function (t) {
			return h("button", {
				key: t.key, type: "button", role: "tab",
				"aria-selected": tab === t.key, id: widgetId + "-" + t.key, "aria-controls": widgetId + "-body", tabIndex: tab === t.key ? 0 : -1,
				className: "dsh-ctf-wbtab" + (tab === t.key ? " is-on" : ""),
				onClick: function () { setTab(t.key); readSeq.current += 1; setRead(null); setReadErr(""); }
			}, h(Icon, { name: t.icon, size: 14 }), h("span", null, t.label));
		})),
		h("div", { className: "dsh-ctf-wbbody", role: "tabpanel", id: widgetId + "-body", "aria-labelledby": widgetId + "-" + tab, tabIndex: 0 }, body),
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
				!ch.lifecycle || !(ch.lifecycle.localProjectionPending || ch.lifecycle.learningUsagePending) ? null : h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: submitBusy, onClick: retryLocalSync }, "重试本地同步"),
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
