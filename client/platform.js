function PlatformPanel(props) {
	var say = props.say || function () {}, sessionId = String(props.sessionId || "");
	var cfgS = useState(null), cfg = cfgS[0], setCfg = cfgS[1];
	var draftS = useState({ kind: "ctfd", baseUrl: "", mcpUrl: "", profile: "", token: "" }), draft = draftS[0], setDraft = draftS[1];
	var dirtyS = useState(false), dirty = dirtyS[0], setDirty = dirtyS[1];
	var busyS = useState(""), busy = busyS[0], setBusy = busyS[1];
	var errorS = useState(""), error = errorS[0], setError = errorS[1];
	var connectionS = useState(null), connection = connectionS[0], setConnection = connectionS[1];
	var discoveryS = useState(null), discovery = discoveryS[0], setDiscovery = discoveryS[1];
	var selectedS = useState({}), selected = selectedS[0], setSelected = selectedS[1];
	var resultS = useState(null), result = resultS[0], setResult = resultS[1];
	var queryS = useState(""), query = queryS[0], setQuery = queryS[1];
	var statusS = useState("available"), statusFilter = statusS[0], setStatusFilter = statusS[1];
	var categoryS = useState(""), category = categoryS[0], setCategory = categoryS[1];
	var pageS = useState(0), page = pageS[0], setPage = pageS[1];
	var nowS = useState(Date.now()), now = nowS[0], setNow = nowS[1];
	var autoS = useState(true), autoStart = autoS[0], setAutoStart = autoS[1];
	var alive = useRef(true), busyRef = useRef(false);
	useEffect(function () { alive.current = true; load(); var timer = window.setInterval(function () { setNow(Date.now()); }, 10000); return function () { alive.current = false; window.clearInterval(timer); }; }, []);
	useEffect(function () { setPage(0); }, [query, statusFilter, category, discovery]);
	function adopt(config) {
		setCfg(config); setDraft({ kind: config.kind || "ctfd", baseUrl: config.baseUrl || "", mcpUrl: config.mcpUrl || "", token: "", profile: config.profile ? JSON.stringify(config.profile, null, 2) : "" }); setDirty(false);
	}
	async function perform(kind, operation) {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(kind); setError("");
		try { await operation(); } catch (e) { if (alive.current) setError(e.message || "操作失败"); }
		finally { busyRef.current = false; if (alive.current) setBusy(""); }
	}
	async function api(endpoint, input) {
		var r = await request(endpoint, Object.assign({ sessionId: sessionId }, input));
		if (!alive.current) throw new Error("页面已关闭");
		return r;
	}
	function requireOk(r) { if (!r || !r.ok) throw new Error(r && r.error || "请求失败"); return r; }
	function load() { if (dirty && !window.confirm("重新读取会丢弃未保存的连接修改，是否继续？")) return; return perform("load", async function () { var r = requireOk(await api("platform.config.get")); adopt(r.platform); setConnection(null); setDiscovery(null); setSelected({}); }); }
	function edit(key, value) {
		setDraft(Object.assign({}, draft, (function () { var patch = {}; patch[key] = value; return patch; })()));
		setDirty(true); setConnection(null); setDiscovery(null); setSelected({}); setResult(null);
	}
	async function check() {
		var r = requireOk(await api("platform.status")); setConnection(r); if (props.onStatus) props.onStatus(r);
		if (!r.configured || !r.reachable) throw new Error(r.error || "平台连接不可用，请检查地址与凭据");
		return r;
	}
	function save() { return perform("save", async function () {
		var payload = { kind: draft.kind, baseUrl: draft.baseUrl.trim(), mcpUrl: draft.mcpUrl.trim(), profile: null };
		if (draft.kind === "generic" && draft.profile.trim()) { try { payload.profile = JSON.parse(draft.profile); } catch (_) { throw new Error("通用平台配置不是有效的 JSON"); } }
		if (draft.token.trim()) payload.apiToken = draft.token.trim();
		else if (cfg && (cfg.kind !== draft.kind || cfg.baseUrl !== draft.baseUrl.trim())) payload.apiToken = "";
		var r = requireOk(await api("platform.config.set", payload)); adopt(r.platform); setDiscovery(null); setSelected({}); setResult(null);
		await check(); say("平台配置已保存，连接检查通过");
	}); }
	function discover() { return perform("discover", async function () {
		if (dirty) throw new Error("请先保存连接配置");
		setDiscovery(null); setSelected({}); setResult(null);
		var r = requireOk(await api("platform.challenges")); setDiscovery(r);
	}); }
	function importSelection() { return perform("import", async function () {
		if (!discovery || !discovery.snapshotId || dirty) throw new Error("请先重新发现题目");
		var keys = Object.keys(selected).filter(function (key) { return selected[key]; });
		if (!keys.length || keys.length > 50) throw new Error("每批请选择 1–50 道题目");
		var r = await api("platform.import", { snapshotId: discovery.snapshotId, sourceKeys: keys, start: autoStart });
		setResult(r); setSelected({}); setDiscovery(null);
		if (props.onImported) props.onImported();
		if (!r.ok) throw new Error(r.error || "部分题目处理失败，请查看逐题结果");
		say("已准备 " + (r.created || []).length + " 题，已入队 " + (r.started || []).length + " 题");
	}); }
	var rows = discovery && discovery.challenges || [];
	var available = rows.filter(function (c) { return !c.local && !c.solvedByMe; });
	var selectedRows = rows.filter(function (c) { return selected[c.sourceKey]; });
	var count = selectedRows.length;
	var expired = discovery && now >= discovery.expiresAt;
	var categories = Array.from(new Set(rows.map(function (c) { return c.category || ""; }).filter(Boolean))).sort();
	var filtered = rows.filter(function (c) {
		if (category && c.category !== category) return false;
		if (statusFilter === "available" && (c.local || c.solvedByMe)) return false;
		if (statusFilter === "imported" && !c.local) return false;
		if (statusFilter === "solved" && !c.solvedByMe) return false;
		if (statusFilter === "selected" && !selected[c.sourceKey]) return false;
		return !query || [c.name, c.id, c.category, c.groundName, c.groundId, c.competitionId].join(" ").toLowerCase().indexOf(query.toLowerCase()) >= 0;
	});
	var pageCount = Math.max(1, Math.ceil(filtered.length / 20)), safePage = Math.min(page, pageCount - 1);
	var visible = filtered.slice(safePage * 20, (safePage + 1) * 20);
	var platformNames = { ctfd: "CTFd", dasctf: "DASCTF", generic: "通用平台" };
	function selectOne(key, checked) {
		if (busy || expired) return;
		setSelected(function (previous) { var next = Object.assign({}, previous); if (checked) { if (Object.keys(next).length >= 50 && !next[key]) { say("每批最多选择 50 题", true); return previous; } next[key] = true; } else delete next[key]; return next; });
	}
	function selectFiltered() {
		var next = Object.assign({}, selected), slots = Math.max(0, 50 - count);
		filtered.filter(function (c) { return !c.local && !c.solvedByMe && !next[c.sourceKey]; }).slice(0, slots).forEach(function (c) { next[c.sourceKey] = true; }); setSelected(next);
	}
	function applyTemplate(kind) {
		var profile = { listPath: "/api/challenges", detailPath: "/api/challenges/{id}", submitPath: "/api/challenges/{id}/submit" };
		if (kind === "paged") profile.pagination = { pageParam: "page", sizeParam: "limit", pageSize: 50, startPage: 1, maxPages: 20 };
		if (kind === "root") profile.map = { list: { dataPath: "" }, detail: { dataPath: "" }, submit: { statusPath: "status", messagePath: "message" } };
		if (kind === "api-key") { profile.auth = { header: "X-API-Key", prefix: "" }; profile.submitBody = { challenge_id: "{id}", flag: "{flag}" }; }
		edit("profile", JSON.stringify(profile, null, 2));
	}
	function configField(label, key, type) { return field(label, h(type === "textarea" ? "textarea" : "input", { className: "dsh-ctf-in", "aria-label": label, type: type === "textarea" ? undefined : type || "text", value: draft[key], disabled: !!busy, rows: type === "textarea" ? 6 : undefined, autoComplete: key === "token" ? "new-password" : "off", placeholder: key === "baseUrl" ? "https://ctf.example.com" : key === "token" && cfg && cfg.tokenSet ? "已保存，留空保留" : undefined, onChange: function (e) { edit(key, e.target.value); } })); }
	function metric(label, value) { return h("div", { className: "dsh-ctf-connect-metric", key: label }, h("b", null, value), h("span", null, label)); }
	function step(num, title, description, active) { return h("div", { className: "dsh-ctf-connect-step" + (active ? " is-on" : "") }, h("i", null, num), h("span", null, h("b", null, title), h("small", null, description))); }
	function renderResults() {
		if (!result) return null;
		var entries = [].concat((result.created || []).map(function (r) { return { key: "created-" + r.localId, title: r.title || r.platformId, label: STATUS_LABEL[r.status] || r.status || "已准备", detail: r.localId, tone: "ok" }; }), (result.skipped || []).map(function (r, i) { return { key: "skip-" + i, title: "平台题 " + (r.platformId || r.localId || ""), label: "已跳过", detail: r.reason, tone: "muted" }; }), (result.errors || []).map(function (r, i) { return { key: "error-" + i, title: "平台题 " + (r.platformId || r.localId || ""), label: "处理失败", detail: r.error || r.reason, tone: "danger" }; }));
		return h("section", { className: "dsh-ctf-panel dsh-ctf-connect-results", "aria-label": "本批处理结果" }, h("div", { className: "dsh-ctf-connect-sectionhead" }, h("div", null, h("h2", null, "处理结果"), h("p", null, "准备和入队结果；解题进度在题目工作台继续。")), h("button", { type: "button", className: "dsh-ctf-btn", onClick: props.onClose }, "查看题目工作台")),
			h("div", { className: "dsh-ctf-connect-metrics" }, metric("已准备", (result.created || []).length), metric("已入队", (result.started || []).length), metric("已跳过", (result.skipped || []).length), metric("失败", (result.errors || []).length)),
			h("div", { className: "dsh-ctf-connect-receipts" }, entries.map(function (r) { return h("div", { key: r.key, className: "dsh-ctf-connect-receipt" }, h("span", { className: "dsh-ctf-pill is-" + r.tone }, r.label), h("b", null, r.title), h("span", null, r.detail)); })));
	}
	return h("div", { className: "dsh-ctf-page dsh-ctf-platform-workflow dsh-ctf-connect", "aria-busy": !!busy },
		h("section", { className: "dsh-ctf-connect-hero" }, h("div", { className: "dsh-ctf-connect-hero-main" }, h("span", { className: "dsh-ctf-eyebrow" }, "PLATFORM CONNECTION"), h("h2", null, "连接赛场，组织下一批解题。"), h("p", null, "先发现，再选择。题面和附件准备完成后，进入统一的解题队列。")), h("div", { className: "dsh-ctf-connect-status" }, h("span", { className: "dsh-ctf-raildot" + (connection && connection.reachable && !dirty ? " is-live" : "") }), dirty ? "有未保存修改" : connection && connection.reachable ? "连接已确认" : cfg && cfg.tokenSet ? "凭据已配置 · 待检查" : "等待配置连接")),
		h("div", { className: "dsh-ctf-connect-steps", "aria-label": "平台解题流程" }, step("01", "接入平台", "配置地址与凭据", !discovery && !result), step("02", "选择题目", "筛选并组成批次", !!discovery), step("03", "准备与派发", "下载附件并入队", busy === "import"), step("04", "核验与提交", "在题目工作台跟进", !!result)),
		error ? h("div", { className: "dsh-ctf-error", role: "alert" }, h(Icon, { name: "alert" }), error) : null,
		h("div", { className: "dsh-ctf-connect-layout" },
			h("aside", { className: "dsh-ctf-panel dsh-ctf-connect-config", "aria-label": "平台连接配置" },
				h("div", { className: "dsh-ctf-connect-sectionhead" }, h("h2", null, "连接配置"), h("span", { className: "dsh-ctf-chip" }, dirty ? "未保存" : "当前连接")),
				h("div", { className: "dsh-ctf-platform-options", role: "group", "aria-label": "平台类型" }, ["ctfd", "dasctf", "generic"].map(function (kind) { return h("button", { key: kind, type: "button", disabled: !!busy, "aria-pressed": draft.kind === kind, className: "dsh-ctf-platform-option" + (draft.kind === kind ? " is-on" : ""), onClick: function () { if (kind !== draft.kind) edit("kind", kind); } }, h(Icon, { name: kind === "dasctf" ? "target" : kind === "generic" ? "settings" : "platform", size: 18 }), platformNames[kind]); })),
				configField("平台地址", "baseUrl"),
				configField("API Token" + (cfg && cfg.tokenSet ? "（已设置，同一连接留空保留）" : ""), "token", "password"),
				draft.kind === "dasctf" ? h("p", { className: "dsh-ctf-muted" }, "可填写 CTF2_AGENT_TOKEN，或使用宿主已配置的环境凭据。") : null,
				draft.kind === "dasctf" || draft.kind === "generic" ? h("details", { className: "dsh-ctf-connect-advanced" }, h("summary", null, "高级适配设置"), draft.kind === "dasctf" ? configField("MCP 地址（留空使用默认）", "mcpUrl") : h("div", null, h("p", { className: "dsh-ctf-muted" }, "选择接口模板后按平台文档调整；模板会替换当前适配配置。"), h("div", { className: "dsh-ctf-toolbar", role: "group", "aria-label": "通用接口模板" }, [{ key: "paged", label: "分页列表模板" }, { key: "root", label: "根数组模板" }, { key: "api-key", label: "API Key 模板" }].map(function (template) { return h("button", { type: "button", key: template.key, className: "dsh-ctf-btn is-sm", disabled: !!busy, onClick: function () { applyTemplate(template.key); } }, template.label); })), configField("通用适配配置", "profile", "textarea"))) : null,
				h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: !!busy || !cfg, onClick: save }, busy === "save" ? "保存并检查中…" : "保存并检查连接"),
				h("div", { className: "dsh-ctf-connect-config-secondary" }, h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy || dirty || !cfg, onClick: function () { perform("check", check); } }, "检查已保存连接"), h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy, onClick: load }, "重新读取配置")),
				h("div", { className: "dsh-ctf-connect-config-note" }, h(Icon, { name: "check", size: 15 }), h("span", null, "连接变更后需重新发现题目。列表中的已导入状态仅对应当前工作区。"))),
			h("div", { className: "dsh-ctf-connect-main" },
				h("section", { className: "dsh-ctf-panel dsh-ctf-connect-catalog" },
					h("div", { className: "dsh-ctf-connect-sectionhead" }, h("div", null, h("h2", null, "平台题库"), h("p", null, discovery ? "题目列表已取得，可选择本批要处理的题目。" : "连接配置保存后，获取平台可见的题目列表。")), h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: !!busy || dirty || !cfg, onClick: discover }, h(Icon, { name: "refresh", size: 14 }), busy === "discover" ? "正在发现…" : "发现题目")),
					discovery ? h("div", { className: "dsh-ctf-connect-metrics" }, metric("平台返回", rows.length), metric("可导入", available.length), metric("本地已有", rows.filter(function (c) { return c.local; }).length), metric("已选择", count)) : null,
					discovery && discovery.possiblyTruncated ? h("div", { className: "dsh-ctf-error is-warn", role: "status" }, "平台返回达到上限，当前列表可能不完整。") : null,
					expired ? h("div", { className: "dsh-ctf-error is-warn", role: "status" }, "题目列表已过期，重新发现后才能导入。") : null,
					!discovery ? h("div", { className: "dsh-ctf-connect-empty", role: "status" }, h("div", { className: "dsh-ctf-connect-empty-icon" }, h(Icon, { name: "platform", size: 30 })), h("h3", null, busy === "discover" ? "正在获取平台题目…" : "准备好下一批题目"), h("p", null, dirty ? "先保存左侧连接配置，再发现题目。" : "点击“发现题目”查看题库。发现阶段不会启动解题。")) : h("div", null,
						h("div", { className: "dsh-ctf-connect-filters" }, h("div", { className: "dsh-ctf-seg", role: "group", "aria-label": "题库状态筛选" }, [{ key: "available", label: "可导入" }, { key: "all", label: "全部" }, { key: "imported", label: "本地已有" }, { key: "solved", label: "平台已解" }, { key: "selected", label: "已选择" }].map(function (filter) { return h("button", { key: filter.key, type: "button", className: "dsh-ctf-segbtn" + (statusFilter === filter.key ? " is-on" : ""), "aria-pressed": statusFilter === filter.key, onClick: function () { setStatusFilter(filter.key); } }, filter.label); })),
							h("div", { className: "dsh-ctf-connect-searchrow" }, h("div", { className: "dsh-ctf-searchwrap" }, h(Icon, { name: "search" }), h("input", { className: "dsh-ctf-in dsh-ctf-search", value: query, "aria-label": "筛选平台题目", placeholder: "搜索题名、ID 或来源", onChange: function (e) { setQuery(e.target.value); } })), h("select", { className: "dsh-ctf-in", value: category, "aria-label": "平台题目分类", onChange: function (e) { setCategory(e.target.value); } }, h("option", { value: "" }, "全部分类"), categories.map(function (key) { return h("option", { key: key, value: key }, catLabel(key)); })))),
						h("div", { className: "dsh-ctf-connect-listtools" }, h("span", null, "筛选结果 " + filtered.length + " 题"), h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy || expired || count >= 50, onClick: selectFiltered }, "选择当前结果（最多 50）")),
						visible.length ? h("div", { className: "dsh-ctf-connect-tablewrap", role: "region", "aria-label": "平台题目表格", tabIndex: 0 }, h("table", { className: "dsh-ctf-connect-table" }, h("caption", { className: "dsh-ctf-sr-only" }, "平台题目列表"), h("thead", null, h("tr", null, h("th", { scope: "col" }, "选择"), h("th", { scope: "col" }, "题目 / 来源"), h("th", { scope: "col" }, "分类"), h("th", { scope: "col" }, "状态"))), h("tbody", null, visible.map(function (c) { return h("tr", { key: c.sourceKey, className: "dsh-ctf-prow dsh-ctf-connect-row" + (selected[c.sourceKey] ? " is-selected" : "") }, h("td", null, h("input", { type: "checkbox", "aria-label": "选择题目：" + (c.name || c.id) + " · " + (c.groundName || c.groundId || c.competitionId || c.id), checked: !!selected[c.sourceKey], disabled: !!busy || expired || !!c.local || !!c.solvedByMe || count >= 50 && !selected[c.sourceKey], onChange: function (e) { selectOne(c.sourceKey, e.target.checked); } })), h("td", null, h("b", null, c.name || c.id), h("small", null, "#" + c.id + (c.groundName ? " · " + c.groundName : c.groundId ? " · " + c.groundId : "") + (c.competitionId ? " · 比赛 " + c.competitionId : "") + (c.stageId ? " · 阶段 " + c.stageId : ""))), h("td", null, h("span", { className: "dsh-ctf-chip" }, catLabel(c.category))), h("td", null, h("span", { className: "dsh-ctf-pill" + (c.solvedByMe ? " is-ok" : "") }, c.solvedByMe ? "平台已解" : c.local ? c.local.preparation !== "ready" ? "准备待恢复" : "本地 " + (STATUS_LABEL[c.local.status] || c.local.status) : "可导入"))); })))) : h("div", { className: "dsh-ctf-connect-empty is-slim" }, h(Icon, { name: "search", size: 24 }), h("h3", null, rows.length ? "没有匹配的题目" : "平台未返回题目"), h("p", null, rows.length ? "调整筛选条件或清空关键词。" : "检查平台账号权限及比赛可见范围。")),
						h("div", { className: "dsh-ctf-connect-pagination" }, h("span", null, "第 " + (safePage + 1) + " / " + pageCount + " 页 · 每页 20 题"), h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: !safePage, onClick: function () { setPage(safePage - 1); } }, "上一页"), h("button", { type: "button", className: "dsh-ctf-btn is-sm", disabled: safePage >= pageCount - 1, onClick: function () { setPage(safePage + 1); } }, "下一页")))),
				h("section", { className: "dsh-ctf-panel dsh-ctf-connect-batch", "aria-label": "本批次选择" }, h("div", { className: "dsh-ctf-connect-sectionhead" }, h("div", null, h("h2", null, "本批次", h("span", { className: "dsh-ctf-connect-count" }, count + " / 50")), h("p", null, "跨页选择会保留；附件准备完成后再按所选方式执行。")), h("button", { type: "button", className: "dsh-ctf-btn is-sm is-ghost", disabled: !!busy || !count, onClick: function () { setSelected({}); } }, "清空选择")),
					count ? h("div", { className: "dsh-ctf-connect-basket" }, selectedRows.map(function (c) { return h("span", { className: "dsh-ctf-connect-basketitem", key: c.sourceKey }, c.name || c.id, h("button", { type: "button", disabled: !!busy, "aria-label": "移除题目：" + (c.name || c.id), onClick: function () { selectOne(c.sourceKey, false); } }, h(Icon, { name: "close", size: 12 }))); })) : h("p", { className: "dsh-ctf-muted" }, "还未选择题目。可在上方题库逐题选择，或批量选择筛选结果。"),
					h("div", { className: "dsh-ctf-connect-batch-action" }, h("label", { className: "dsh-ctf-connect-mode" }, h("input", { type: "checkbox", checked: autoStart, disabled: !!busy, onChange: function (e) { setAutoStart(e.target.checked); } }), h("span", null, h("b", null, "附件准备完成后开始解题"), h("small", null, autoStart ? "题目进入调度队列，按并发与预算执行。" : "仅保存题面与附件，稍后在工作台开始。"))), h("button", { type: "button", className: "dsh-ctf-btn is-primary", disabled: !!busy || expired || !count || count > 50 || !discovery || !discovery.snapshotId, onClick: importSelection }, h(Icon, { name: autoStart ? "play" : "download", size: 14 }), busy === "import" ? "正在准备题目…" : autoStart ? "导入并开始所选题目" : "仅导入所选题目"))),
				renderResults())));
}
