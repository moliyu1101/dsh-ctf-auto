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
