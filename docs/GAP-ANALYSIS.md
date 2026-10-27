# 六层能力对账：dsh-ctf-auto 现状 vs 目标（2026-10-26）

> 目标口径（用户）：常驻层（轻身份 + 判定/路由）｜题型层（12 套策略，按需加载）｜知识层（125 篇 MIT 模块卡 + 私有题解库检索）｜
> 角色层（解题/复核/信息搜集 3 张角色卡，多代理时全文注入）｜工具层（40 个自动化脚本）｜记忆层（跨会话/换目录不丢的持久黑板）。
>
> 本文只做盘点与优先级建议，不含实现。

## 0. 现状基线（已核实）

| 项 | 现状 |
|---|---|
| 宿主工具 | **18 个** `ctf_*` 工具（题板/平台/工作台/报告/Writeup/搜索/管理/诊断） |
| lib 模块 | 11 个（index/client/store/orchestrator/prompt/preset/ctfd/workbench/report/writeup/search） |
| 随包脚本 | **0 个**（`scripts/` 不存在；子代理靠 shell/python 现写） |
| 题型知识 | ctf-solver `refs/` **11 张 SKILL.md，共 190 KB**（crypto 42KB / forensics 37KB / misc 27KB…）+ `ctf-playbook` 18KB |
| 角色 | 1 个解题子代理（角度切换），无独立复核/侦察代理；`independent-review` 技能存在但编排器未调用 |
| 记忆 | 每工作区 `state.json`（题目/尝试/事实/事件/flag）+ campaign-memory（跨会话、模式作用域） |
| 平台 | CTFd 取题/导入/提交；**无重试 / 无 429 退避 / 无限速** |
| 环境工具 | python / pwsh / wsl(Ubuntu, Stopped) / gdb / docker 可用；`ida64` 缺失（IDA MCP wrapper 在 `C:\AI`，profile 未配 MCP 服务器） |

---

## 1. 常驻层 🧠 —— 缺「轻量判定/路由」，persona 过重

**有**：`ctf-auto` preset 常驻 persona（`lib/preset.js` 的 AUTO_PERSONA，约 4KB，含编排规范）；`ctf-solver` 模式 persona 更长。
**缺**：
- 没有「闲聊 vs CTF 题目」判定规则与非题目直接回复策略；也没写死「识别到题目立刻 `ctf_solve_start`」的触发链。
- persona 与编排/工具说明耦合，常驻上下文偏重（违背「简短身份设定，只做判定」）。
- 无「快答模式」：用户问一句概念时也会进解题编排语态。

**建议**：拆出 `resident.md`（≤600 字：身份 + 判定表 + 两种动作），persona 只保留主观念；模式 persona 里删掉工具细节，改由工具描述承担。

## 2. 题型层 📑 —— 12 类只覆盖 8~9 类，且无自动识别/加载证据

**有**：11 张卡 + playbook（数量接近 12）；`lib/prompt.js` 有「模块 → 技能名」映射与 playbook 回退；preset 注册了 `refs/` 技能目录（**待真实会话验证技能确实可见**——此前一次子代理反馈 `ctf-misc` 不可用，疑为 preset 继承问题）。
**缺**：
- **mobile / cloud / ad(域) / supply-chain** 无专属卡，只能回退 playbook；
- **无自动题型识别**：`category` 靠调用者/模型手填，无启发式分类（题面关键词、附件类型、目标端口）；
- **无「只加载对应策略」硬保证**：加载靠模型自觉，attempt 里没有「是否加载了模块技能」的记录；
- 无题型维度的效果统计（命中率/平均耗时/重试次数）。

**建议**：补 4 张卡或写死 playbook 路由；`ctf_solve_start` 增加自动分类；prompt 强制第一步 `skill(ctf-<module>)` 并把加载结果写进 attempt 事件。

## 3. 知识层 📚 —— 190KB 模块卡够用，但「125 篇」与「私有题解库检索」都缺

**有**：190KB 高质量模块卡（相当于 11 篇长卡）；campaign-memory 9 模式记忆（手工沉淀）；`ctf_search`（只搜题板状态）。
**缺**：
- 125 篇粒度的模块卡（当前是 11 篇大卡，检索粒度粗）；
- **私有题解库检索**：导出的 `writeups/*.md`、题目 `notes.md`、脚本没有建索引，无法按技法/题型/工具检索；
- 知识条目无来源/新鲜度标注（MIT 卡 vs 战队私有）；
- 无「失败知识」回灌（stuck 原因不进入知识库）。

**建议**：建本地知识索引（SQLite/JSON + 关键词/BM25），扫描 writeups + notes + campaign memory；新增 `ctf_kb_search`；导出 Writeup 时自动打标（模块/技法/工具），失败卡点也入库。

## 4. 角色层 👥 —— 只有 solver 一个角色，复核/侦察未落地

**有**：解题子代理（按角度重试）；`shared/skills/independent-review` 复核员模板（未接线）。
**缺**：
- **复核角色**：flag 的 `verified` 目前靠子代理自证 + 平台回显，没有独立复核代理（双签/独立重算）；
- **信息搜集角色**：侦察混在 solver prompt 里，没有独立「只出事实清单」的侦察步骤；
- **角色卡文件**：`prompt.js` 只有通用角色段，没有 3 份可全文注入的角色卡。

**建议**：`roles/{solver,reviewer,recon}.md` 全文拼进 spawn prompt；orchestrator 在登记 verified flag 前派 reviewer（只给原始材料，独立重算，确认/挑战二选一）；attempt 0 先跑 recon。

## 5. 工具层 🛠️ —— 18 个宿主工具，40 个脚本一个都没有

**有**：题板/平台/工作台/报告/Writeup/搜索/管理/诊断共 18 个工具；`ctf_platform_submit` 可做平台回显验证。
**缺（按目标清单对照）**：

| 目标脚本 | 现状 | 缺口 |
|---|---|---|
| 附件分诊 | 仅复制到 `files/` | 无文件类型识别、解压、按类型路由 |
| 命令一键运行 | 子代理现写 shell | 无脚本注册/超时/输出落盘约定 |
| flag 校验 | 子代理自带 checker + 平台回显 | 无统一格式校验/本地 checker 注册表；`verified=true` 不校验格式 |
| WP 自动打包 | 仅导出 Markdown | 无 zip 打包（md + scripts + artifacts + 截图 + 索引） |
| IDA 联动 | `ida64` 缺失；MCP wrapper 在 `C:\AI` | profile 未配置 MCP 服务器，未接线 |
| WSL 工具转发 | WSL Ubuntu 可用 | 无 `wsl_run` 通道（pwn/逆向工具在 WSL 侧） |
| 任务限速 | 仅并发数 | 平台 API 无 retry/429 退避；目标请求无限速/白名单 |

**建议优先级**：`triage`（分诊）→ `flag_check`（格式+checker）→ `wp_pack` → `wsl_run` → `rate_limit`（平台退避 + 目标 QPS）→ IDA MCP。

## 6. 记忆层 🗒️ —— 工作区隔离 vs 跨目录不丢，二者当前冲突

**有**：每工作区 `state.json`（题目/尝试/事实/事件/flag，原子落盘、损坏自愈）；campaign-memory 跨会话；导出 report/writeup。
**缺**：
- **跨目录/跨会话台账**：为满足「工作区隔离」，题板已按 cwd 隔离——换目录/换工作区就看不到旧板，与「换目录不丢」冲突；
- 无全局索引（workspace → 题目摘要），无「全部工作区」只读视图；
- 黑板是扁平事实/事件，缺「假设/待办/结论/阻塞」分层与压缩策略；
- 多题并行没有跨工作区统一视图。

**建议**：保留按工作区隔离的写路径，新增全局只读索引 `~/.dsh/ctf-auto/index.json`（含题目/状态/flag/workspace），面板加「全部工作区」视图；黑板结构升级为 facts/hypotheses/todos/conclusions 四类。

## 7. 六层之外的缺口

- **平台**：hints 解锁、`solved_by` 回填、赛事/分值/难度、提交 429 退避、附件下载重试与校验。
- **复盘**：难度/耗时排名、成功率统计、失败知识回灌。
- **成本**：无 per-challenge token/耗时统计（只有事件与 outputTail）。
- **质量**：flag 假阳性无回归（`verified` 仅字符串声明）；无独立复核；缺「未验证候选 → 复核」队列。
- **合规/安全**：题目目标域名白名单、请求速率未强制。
- **测试**：无真实浏览器 UI 测试；平台仅本地 mock 验证。

---

## 8. 优先级建议

| 优先级 | 事项 | 落点 |
|---|---|---|
| **P0** | 常驻层拆分（resident.md 判定/快答） | `preset.js` persona + 新 `roles/resident.md` |
| **P0** | 题型自动识别 + 技能加载记录 | `prompt.js` / `ctf_solve_start` / attempt 事件 |
| **P0** | flag 格式校验 + `verified` 门槛收紧 | `ctf_flag_record` / `prompt.js` |
| **P0** | 平台 retry/429 退避 + 目标限速 | `lib/ctfd.js` + 新 `lib/ratelimit.js` |
| **P0** | 全局索引（解决换目录丢板） | 新 `lib/indexStore.js` + 面板「全部工作区」 |
| **P1** | 3 角色卡 + reviewer/recon 编排 | `roles/*.md` + `orchestrator.js` |
| **P1** | 知识索引 / 私有题解库检索 | 新 `lib/kb.js` + `ctf_kb_search` |
| **P1** | WP 打包（zip）+ 附件分诊 | 新 `lib/pack.js` / `lib/triage.js` |
| **P2** | 125 卡扩充、IDA MCP 接线、WSL 转发、成本统计、浏览器 UI 测试 | 分阶段 |

> 结论：骨架（编排/平台/题板/复盘/Workup/隔离/结算）已经成型；真正缺的是
> **常驻判定层、角色分层、脚本工具层、私有知识检索、跨目录台账**这五块，以及题型自动识别与 flag 校验两个质量闸门。

---

## 9. 本轮已落地（P0）

| 项 | 状态 | 落点 |
|---|---|---|
| 常驻层拆分（判定/快答） | ✅ 已实现 | `lib/preset.js` AUTO_PERSONA（752 字） |
| 题型自动识别 + 技能记录 | ✅ 已实现（13 类启发式） | `lib/classify.js`、`ctf_solve_start`、`attempt.skill` |
| flag 形态/证据门槛 | ✅ 已实现 | `lib/flagcheck.js`、`ctf_flag_record`、设置页「质量门槛」 |
| 平台 retry/429/限速 | ✅ 已实现（含 Retry-After / 节流） | `lib/ctfd.js` |
| 全局索引/全部工作区视图 | ✅ 已实现（`state.get scope=all` + byWorkspace + 工具条开关） | `lib/index.js`、`lib/client.js` |

剩余 P1/P2（角色卡、私有知识索引、WP 打包、分诊脚本、125 卡、IDA MCP、WSL 转发、成本统计）未动。

---

## 10. 本轮已落地（P1）

| 项 | 状态 | 落点 |
|---|---|---|
| 3 张角色卡 + recon/solver 按尝试注入 | ✅ 已实现 | `roles/*.md`、`lib/roles.js`、orchestrator、prompt.js |
| 独立复核（reviewer 子代理） | ✅ 已实现（端到端 VERIFIED 实测） | `ctf_review_flag` / `flag.review` / `buildReviewPrompt` |
| 私有知识库索引与检索 | ✅ 已实现（writeups + notes，跨工作区） | `lib/kb.js`、`ctf_kb_search`、复盘页检索框 |
| 附件分诊 | ✅ 已实现（魔数优先 + 下一步提示 + 去重） | `lib/triage.js`、`ctf_triage` |
| WP 打包 | ✅ 已实现（tar.gz，29 文件/9KB 实测） | `lib/pack.js`、`ctf_writeup_pack` |

剩余 P2：125 卡扩充、IDA MCP 接线、WSL 工具转发、成本/Token 统计、真实浏览器 UI 测试、平台 hints。

---

## 11. 本轮已落地（P2，MCP 除外）

| 项 | 状态 | 落点 |
|---|---|---|
| WSL 工具转发 | ✅ 已实现（真实 WSL 执行实测：uname/python3/exit 0） | `lib/wslrun.js`、`ctf_wsl_run`、`wsl.run`、doctor/设置诊断 |
| 平台 hints 列出/解锁 | ✅ 已实现（mock 单测；解锁内容入 facts/事件） | `lib/ctfd.js` hints/unlockHint、`ctf_platform_hints` |
| 耗时统计 | ✅ 已实现（attempts 聚合 + 复盘 KPI） | `aggregates.timing`、复盘页「平均尝试耗时」 |
| IDA MCP 接线 | ⏸ 按用户要求暂缓（本机 ida64 缺失、profile 未配 MCP） | — |
| 125 篇模块卡扩充 | ⏳ 未做（内容工程） | — |
| 真实浏览器 UI 自动化 | ⏳ 未做（现有 headless mini-React 冒烟） | — |

Token 级成本不可得：子代理 `startActivation` 的 done 只回 `{stopReason, outputText, sessionId}`，无 usage。

---

## 12. 本轮已落地（常驻/题型/知识导入/记忆页/其余层）

| 层/项 | 状态 | 落点 |
|---|---|---|
| 常驻层 | ✅ 完成（文件化 + 判定表 + 兜底） | `roles/resident.md`、`preset.js` |
| 题型层 | ✅ 完成（13 类都有卡/策略，技能目录 13） | `cards/ctf-{mobile,cloud,ad,supply}`、`prompt.js`、doctor |
| 知识层导入 | ✅ 完成（导入/列表/删除/检索；内容未填） | `lib/kbimport.js`、`kb.*`、`ctf_kb_import`、知识页 |
| 记忆层页面 | ✅ 完成（跨工作区 + 黑板分层） | `memory.summary`、`lib/blackboard.js`、记忆页 |
| 角色层自动复核 | ✅ 完成（开关默认关） | `reviewerEnabled`、watchdog、设置页 |
| 工具层脚本库 | ✅ 完成（4 个脚本 + 约定） | `scripts/` |
| 125 篇知识卡内容 | ⏳ 按要求暂不填 | — |
| 真实浏览器 UI 测试 | ⏳ 未做 | — |
| IDA/MCP | ⏸ 按要求暂缓 | — |

当前：20 个 lib 模块 / 25 个模型工具 / 39 个面板端点 / 17 个测试文件 138 个单测；UI 冒烟覆盖 7 个标签页。

---

## 13. 记忆层学习闭环（本轮）

| 项 | 状态 | 落点 |
|---|---|---|
| 解出即沉淀打法卡（跨会话 memory.json） | ✅ 自动沉淀 2 张实测 | `lib/memory.js`、watchdog、`memory.distill` |
| 相似题召回并注入提示词 | ✅ 相似题召回 0.915 分实测 | `rankMemories`、`attempt.memories`、prompt §7 |
| 复用/成功计数 | ✅ used/usedOk 落盘 | `bumpMemoryUsage` |
| 记忆页打法卡 UI | ✅ 列表/展开/全量沉淀 | `lib/client.js` 记忆页 |
| 配置（条数/阈值/自动沉淀） | ✅ | `memoryTopK/memoryMinScore/autoDistill` |

当前测试：18 个测试文件 / 144 个单测；UI 冒烟 7 页通过。

---

## 14. 知识/记忆在解题时调用（本轮）

| 项 | 状态 | 落点 |
|---|---|---|
| 尝试开始联合召回（打法卡 + 知识片段） | ✅ 实测 attempt.memories + attempt.knowledge 注入 | `recallFor`、orchestrator、prompt §7/§8 |
| 提示词注入与解题循环指令 | ✅ 2.5 步 + `ctf_kb_search`/`ctf_recall` 指引 | `lib/prompt.js`、`lib/kb.js` |
| 运行中召回工具 | ✅ `ctf_recall`（id/q 双模式实测） | `lib/index.js` |
| 知识复用计数 | ✅ `knowledge-usage.json`（used/usedOk）+ kb.stats/知识页展示 | `bumpKnowledgeUsage` |
| 配置（知识召回条数/阈值） | ✅ | `knowledgeTopK/knowledgeMinScore` |

实测：相似题 attempt 召回打法卡 1 张（0.61）+ 知识片段 2 条（0.28/0.20），收口后知识 used 计数 +2；测试 147/147。

---

## 15. 靶机/运行指标/多平台补齐（本轮）

| 项 | 状态 | 落点 |
|---|---|---|
| 靶机就绪探测 + 自动巡检 | ✅（真实目标探测 73-121ms 就绪） | `lib/target.js`、`target.probe`、watchdog、卡片 chip |
| 主控台式指标（当前动作/耗时/费用估算） | ✅（`lastEvent`/`estCost`/`usage`） | orchestrator、store、aggregates、复盘 KPI、设置单价 |
| 多平台通用适配器（贴平台接新站） | ✅（mock 平台 E2E：拉 2 题） | `lib/platform-generic.js`、platform.json、平台面板 |
| 自动复盘 / 本地知识库复用 | ✅ 已有（§22-24） | memory.json、kb |
| 离线授权/客户端打包/13 平台预置 | ⏳ 不做（商业产品专属，与本插件定位不同） | — |

当前测试：27 个测试文件 / 174 个单测；UI 冒烟 8 页通过。

---

## 16. 平台自动探测 + 调度视图（本轮）

| 项 | 状态 | 落点 |
|---|---|---|
| 贴网址自动识别平台类型 | ✅（mock CTFd 探测 high） | `lib/platform-detect.js`、`platform.detect`、`ctf_platform_detect`、面板按钮 |
| 通用 profile 自动推断 | ✅（dataPath/name 字段自动猜） | `guessChallengeArray`、平台面板 Profile JSON |
| 调度快照/队列 | ✅ | `orchestrator.snapshot()`、`schedule.summary`、`ctf_schedule` |
| 调度页（并发/排队/节奏/最近完成） | ✅（第 8 个标签） | `lib/client.js` 调度页 + CSS |

当前：25 个模型工具 / 8 个面板标签 / 27 个测试文件 / 174 个单测。
