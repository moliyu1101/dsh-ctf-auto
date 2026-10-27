# dsh-ctf-auto — CTF 自动解题编排器（DeepSeek Harness 插件）

一个跑在 DeepSeek Harness 桌面端的 CTF 自动解题插件：**平台取题 / 题面附件 → 每题独立工作区 → 子代理自主解题
（多轮换角度、事实链、卡点登记）→ flag 本地验证或平台提交回显 → 单界面题板 + 工作台 + 台账 + 知识 + 记忆 + 调度**。

> 平台接入已实现（CTFd：取题/导入/提交回显），并对本地 mock CTFd 做了端到端验证；
> 真实平台只需在面板「平台」里填 `baseUrl` + API Token。

---

## 它做什么

- **模式入口**：插件注册自己的 Agent 模式 `ctf-auto`
  （「CTF 自动解题」，order 85）。新建会话时在模式 chip 里选中它，即可直接开始对话；
  该模式的人设是「自动解题编排」——你贴题面/附件，它派子代理去解，进度回题板。
  （模式组成：persona/agent-instructions/shell/fs/skills/planning/compaction/delegation/
  ask-user/todo/web/scanner；技能目录包含题型卡、模块技能与共享技能。）
- **单标签 + 内部分页**：对话顶部只有「CTF 自动解题」一个标签，所有界面都收在里面做内部分页
  （设置列表里不再另开页面）：**题板 ｜ 平台 ｜ 调度 ｜ 台账 ｜ 复盘 ｜ 知识 ｜ 记忆 ｜ 设置**。
  - 公共头部：统计条、运行中**倒计时**与结算阶段、子代理/平台告警、刷新；
  - **题板**：状态/模块/搜索/排序筛选 + 分组方式（按会话·平铺）+ 仅本会话；按会话分组卡片（组头含
    短 id、当前会话、preset/cwd/live、计数、折叠）；卡片「详情」展开单题**工作台**
    （概览 attempts/facts/events/flags ｜附件｜笔记 notes.md 可编辑保存｜脚本｜产物 + 开始/停止/重试/显示目录/提交 flag）；
  - **平台**：CTFd 配置 + 测试连接 + 拉取题板 + 勾选导入 + 提交；
  - **台账**：合计 + 按模块/状态分布 + flag 台账（未验证标黄、证据展开）；
  - **复盘**：Hero 头 + 4 个 KPI + 模块覆盖 + 筛选工具条；左列「已解清单」富卡片（模块色头像 / flag 行 / 证据折叠 / 导出状态色条 /
    展开题面与尝试事实），右列 Markdown 预览 + Writeup 历史 + 复盘报告历史（MD 徽标卡，sticky）；支持批量导出 Writeup。
- **单题 Writeup**：只含「题目」（清洗后的题面，去掉方向建议/观测事实/工作区等辅助块）与「解题步骤」（notes.md 解题记录，剔除反注入/失败路径/建议等旁支）。
  - **管理**：卡片「删除」/ 组头「删除会话」（二次确认，默认只移出题板、保留工作目录）；
  - **设置**：三张配置卡（编排 / 预算结算 / 模型，带字段说明）+ 诊断卡（状态 pill）；页头有未保存标记、恢复默认与保存。
- **平台接入（CTFd）**：面板「平台」里填 `baseUrl` + API Token → 测试连接 → 拉取题板 → 勾选导入
  （题面/连接信息/附件自动下载）→ 解题 →「提交 flag」按平台回显自动置已解。模型侧对应
  `ctf_platform_status/import/submit` 三个工具。
- **复盘报告**：一键导出 Markdown（统计/模块分布/逐题 flag 与证据/attempts/未解卡点）到
  `<rootDir>/reports/`；面板「复盘」页可直接预览历史报告（`report.list/report.read`）。
- **预算结算**：单次尝试到预算 80%（可配 `wrapupRatio`）时向子代理注入收尾指令
  （先落盘事实/脚本、已验证 flag 立即登记），并给 `wrapupGraceMs` 宽限再中断；题板显示「结算中」倒计时。
- **模型升级**：第 2+ 次尝试可用 `escalateModel` 换更强模型重试。
- **题板检索**：`search.query` / `ctf_search` 跨题搜题名/题面/尝试输出/事实链/flag 证据。
- **常驻判定层**：ctf-auto 的常驻 persona 收敛为短指令——识别「是题目」就立刻派发（`ctf_solve_start`/`ctf_board_import`），
  非题目直接简短回答，不启动解题流水线；细节放在工具描述里，不再挤占常驻上下文。
- **题型自动识别**：`ctf_solve_start` 未给 category 时按题名/题面/目标/附件名启发式分类（13 类），命中证据写进事件；
  attempt 记录对应模块技能（`attempt.skill`），便于核对「按题型加载策略」。
- **flag 质量门槛**：`verified=true` 前校验 flag 形态（可配置 `flagPatterns`）与 evidence（最短 `minEvidenceChars`、拒绝占位词）；
  不达标的 flag 自动降级为待验证并记事件；平台回显（method=platform）豁免形态校验。
- **平台类型自动探测**：贴一个网址 → `ctf_platform_detect` / 平台面板「自动探测平台」——先看首页 CTFd 指纹，再逐个候选路径试 JSON，
  命中「题目数组」就自动推断通用 profile 并可一键应用（`platform.detect apply=true`）。
- **比赛级调度视图**：新增「调度」页——并发占用、运行中题目（进度条/角度/角色/技能/靶机状态/停止）、排队队列、
  最近 30 分钟尝试/完成节奏条形图、最近完成（耗时/费用）；模型侧对应 `ctf_schedule` 工具（`schedule.summary` 端点）。

- **靶机与运行指标**：靶机就绪探测（URL→HTTP / host:port→TCP，写 targetStatus，watchdog 对运行中的题每 60s 自动探测，
  面板/详情可手动「探测目标」）；每题「当前动作」= 最新事件、耗时、估算 token/费用；复盘页累计费用 KPI，单价 `pricePerMToken` 可配。
- **多平台接入**：通用 JSON 适配器（`kind=generic` + profile 字段映射，任意 HTTP JSON 平台），并支持贴网址自动探测平台类型。
- **自动复盘/知识沉淀**：Writeup 导出、复盘报告、知识库导入与检索、跨会话打法卡沉淀与召回。

- **平台韧性**：CTFd 适配器带指数退避重试（429/5xx/网络错误、尊重 Retry-After）与请求间隔节流（`minIntervalMs`）。
- **全部工作区视图**：题板工具条可切「全部工作区」（只读聚合），跨目录也能看到各工作区题板；写操作仍按当前会话工作区。

- **角色分层**：3 张角色卡（`roles/recon|solver|reviewer.md`）全文注入——第 1 次尝试用 recon（只做侦察分诊），
  后续用 solver；`ctf_review_flag` 派独立 reviewer 复算（REJECTED 自动把 flag 降级并置 stuck）。
- **私有知识库**：导出的 Writeup + 各题 notes.md 建本地索引，`ctf_kb_search` / 复盘页「私有知识检索」按技法/题型/工具检索（跨工作区）。
- **工具层**：`ctf_triage`（附件魔数分诊 + 下一步提示，落盘 triage.json）、`ctf_writeup_pack`（writeup+脚本+产物打 tar.gz 交付包）。

- **常驻层完成**：常驻 persona 改为从 `roles/resident.md` 读取（轻量判定表：题目→立刻派发 / 闲聊→直接答 / 追问→查状态），
  文件可改、内置兜底；preset 注册时全文注入。
- **题型层完成**：13 类全覆盖——新增插件自带卡 `cards/ctf-mobile|cloud|ad|supply`（与 refs 11 卡并存，共 13 个技能目录），
  `prompt.js` 模块路由补齐 mobile/cloud/ad/supply，attempt 事件记录 `技能/角色`。
- **知识层导入 + 知识页**：导入卡带统计小块 / 虚线拖拽区（拖入路径即填入）/ 快速填入（知识目录、Writeup 目录）/ 导入回执（失败逐条）/
  已导入文件卡；检索卡带图标搜索框、分段式来源筛选（导入/Writeup/笔记 + 计数）、建议词 chips、命中计数、
  富结果卡（来源色块 + score + 命中词高亮 + 悬浮操作 + 相关度条）与 Markdown 预览；Hero 显示四类计数。
  `kb.stats` + `kb.read` 支撑统计与预览。

- **知识层导入 + 知识页 v2**：面板「知识」页改为双列工作台——左列导入（等宽路径输入、导入结果回执、已导入文件列表可预览/删除），
  右列检索（来源筛选 chips：导入/Writeup/笔记、命中分数条、点条目 Markdown 预览）；Hero 显示索引/导入/Writeup/题板笔记四类计数。
  `kb.stats` + `kb.read` 支撑统计与预览；导入/列表/删除/检索端点见下。

- **知识层导入**：`ctf_kb_import` / 端点 `kb.import|list|delete` + 面板「知识」页——粘贴本地 md/txt（文件或目录）导入
  `<rootDir>/knowledge/` 并参与检索（内容按你说的先不填）。
- **知识与记忆在解题时自动调用（越打越强）**：每次尝试开始前，宿主按题目相似度同时召回「打法卡（memory.json）」与
  「知识片段（Writeup/笔记/导入资料）」，把技法/入口/步骤/命令/摘录注入子代理提示词（§7/§8 段）；解题循环新增 2.5 步：
  动手前先 `ctf_kb_search`，卡住时用 `ctf_recall` 一次召回两层；召回命中会记 used/usedOk，知识页与记忆页显示复用次数。

- **记忆层：跨会话打法沉淀（学习闭环）**——每解一题自动沉淀「打法卡」（技法/入口/步骤/命令/坑，`~/.dsh/ctf-auto/memory.json`）；
  新题开始时按相似度召回前 K 张注入子代理提示词（优先复用快速路径，但要求自己复现验证），并统计复用/成功次数。
  「记忆」页可查看打法卡、手动触发全量沉淀、按事实类型筛选黑板；设置页可调召回条数/阈值/自动沉淀开关。

- **记忆层独立页**：面板「记忆」页 + `memory.summary`——跨工作区工作区记忆、黑板事实按
  `结论/发现/假设/卡点/计划/复核/记录` 分层筛选（`lib/blackboard.js`，fact.kind 落库）。
- **角色层自动复核**：`reviewerEnabled` 开关（默认关）——开启后看门狗对「已解且验证」的题自动派 reviewer 复核。
- **工具层脚本库**：插件 `scripts/` 预置 `flag_check.py` / `triage.sh` / `unpack.sh` / `wsl_tool.sh`（有 README 登记约定）。

- **WSL 工具转发**：`ctf_wsl_run` 在 WSL 里跑命令（自动 Windows→/mnt 路径换算、发行版自动探测、超时/截断），
  pwn/逆向工具链在 Linux 侧时不用切终端；设置页诊断会显示检测到的 WSL 发行版。
- **平台提示**：`ctf_platform_hints` 列出/解锁 CTFd hints，解锁内容自动落进本地题目的 facts 与事件。
- **耗时统计**：复盘页新增「平均尝试耗时（N 次）」KPI（attempts 聚合 timing）；Token 级成本需子代理 API 提供 usage，暂缺。

- **工作区隔离**：题板 / 复盘 / Writeup 都按工作区（驱动会话 cwd）隔离——题板只显示当前工作区题目，
  复盘报告名带工作区键、Writeup 列表只列当前工作区的题；平台接入与运行时配置全局共享。
- **题目工作区**：每题一个目录（默认在驱动会话工作区的 `.ctf-auto/` 下），自动建
  `files/ scripts/ artifacts/ statement.md notes.md`，附件自动复制（≤50MB）。
- **子代理解题**：每次尝试派一个 DSH 子代理（`spawn` provider，默认 `ctf-auto` preset，
  `cwd` = 题目录），prompt 由 `lib/prompt.js` 生成：硬约束 + 题面契约 + 反注入纪律 + 工作区协议 +
  绝对截止时间 + 前序尝试摘要与「禁止重复已失败路径」。
- **多轮编排**：队列/并发（默认 2）/超时（默认 30 分钟）/自动换角度重试（默认 3 次），
  角度序列 `recon-first → tooling → hypothesis → escalate`；超时由内部 timer + 看门狗双保险。
- **flag 验证门槛**：子代理必须用本机证据验证（原版解码函数复现 / 本地 check 脚本 / 平台回显），
  调 `ctf_flag_record(verified=true, evidence=...)` 才置「已解」；从输出里顺手扫到的 flag 只记
  「待验证候选」，不置已解，也不伪造。
- **事实链与台账**：每次尝试收口写 fact（`[结论]/[失败]/[卡点]/[中断]`），失败/卡点路径进
  `attempt.failedPaths` 供下一轮避坑；`events` 保留最近 300 条。
- **Web 面板**：单标签内部分页——题板（筛选/分组/工作台）、平台、台账、复盘（报告+Writeup）、设置（运行时配置+诊断）。
  attempts 时间线、facts、events、flags+证据、开始/停止/带提示重试。

## 安装

将本目录作为 DSH bundle 安装到当前 profile；下面的路径是示意，请替换为你的实际绝对路径：

```text
plugin_manager action=install_bundle target=<absolute-path>/dsh-ctf-auto
```

发布包可用 `npm pack` 生成 `.tgz`。`cards/`、`roles/` 和 `scripts/` 都是运行时资源，已包含在 package `files` 中；CTF 模块技能仍需要本机可用的 `ctf-solver` 技能目录（见快速诊断中的 `skillSourceDir`）。

- 首次安装即生效（宿主 HMR 激活）；**改宿主代码后需要重新加载**：
  `remove_bundle` → `install_bundle`（同一版本不能重复 install）。
- 表单 `plugin_manager` 会改动 desktop profile 的 `package.json` / bundle 列表（本机已完成）。

## 配置（`cordis.patch.yml` 的 row config）

| 键 | 默认 | 说明 |
|---|---|---|
| `concurrency` | `2` | 同时运行的解题子代理上限 |
| `timeoutMs` | `1800000` | 单次尝试超时（毫秒），超时中断并收口为 `timeout` |
| `maxAttempts` | `3` | 单题最多尝试次数（含首次） |
| `ctf_solve_start.timeBudgetMinutes` | 不设置 | 单题总预算；从第一次尝试开始计时，并受 `timeoutMs` 单次上限约束 |
| `autoRetry` | `true` | 失败/卡住后自动换角度重试 |
| `solverPreset` | `ctf-auto` | 解题子代理使用的 agent preset（本插件注册的模式；也可填 `ctf-solver`） |
| `solverModel` | `""` | 可选：子代理模型（空=跟随默认） |
| `rootDir` | `""` | 题板状态根目录（空=`~/.dsh/ctf-auto`；题目录默认在会话工作区 `.ctf-auto/`） |
| `escalateModel` | `""` | 第 2+ 次尝试使用的模型（空=不升级） |
| `wrapupRatio` | `0.8` | 预算结算触发比例（0.5-0.95） |
| `wrapupGraceMs` | `120000` | 结算宽限（毫秒） |

以上可在**面板「设置」页**运行时修改（写入 `<rootDir>/config.json`，覆盖 patch row 默认值，
立即对后续尝试生效）。

## 使用（两种入口）

1. **模式入口**：新建会话 → 模式选择 chip → 「CTF 自动解题」→ 直接开始对话（贴题面/附件路径）。
   该模式的人设会引导用 `ctf_solve_start` / `ctf_board_import` 派发子代理，并盯题板进度。
2. **会话视图（单界面）**：任意对话顶部标签栏（chat / trajectory 旁）→「CTF 自动解题」：
   统计/筛选/按会话分组的题板 + 下方台账区块；点卡片「详情」进单题工作台（笔记可编辑、附件/脚本/产物可读）；
   头部「平台」面板做 CTFd 连接/取题/导入，「导出复盘」下载 Markdown 报告。
   「仅本会话」只看当前会话发起的题；从这里开始/重试会用当前会话当父代理。
3. **设置页**：设置 →「CTF 自动解题」——不分会话的全局题板（含配置摘要）。

## 模型工具（主会话，或任意会话）

| 工具 | 用途 |
|---|---|
| `ctf_solve_start` | 登记题面/附件并派发自主解题（返回 id/slug/目录） |
| `ctf_board_import` | 批量导入整板题目并全部入队 |
| `ctf_solve_status` | 题板摘要 / 单题详情（attempts、facts、flags、events） |
| `ctf_solve_stop` | 停止运行中的尝试 |
| `ctf_solve_retry` | 重新入队，可带 `hint`（下一轮附加提示） |
| `ctf_flag_record` | 登记 flag（`verified=true` 才置已解；子代理必调） |
| `ctf_solve_log` | 事件/尝试轨迹文本 |
| `ctf_solve_doctor` | 安装后自检：子代理 provider、模式注册、平台接入、目录、配置、题板统计 |
| `ctf_platform_status` | 平台（CTFd）接入状态：是否配置、能否连通、当前账号 |
| `ctf_platform_import` | 从平台取题并导入（`ids`/`all`/`skipSolved`/`start`），附件自动下载 |
| `ctf_platform_submit` | 提交 flag 到平台，按回显自动登记 verified（correct/already_solved） |
| `ctf_workbench_list` / `ctf_workbench_read` / `ctf_workbench_write` | 单题工作台文件查看/读取/写入（题目录内、≤512KB） |
| `ctf_report_export` | 导出 Markdown 复盘报告到 `<rootDir>/reports/` |
| `ctf_search` | 跨题检索（题名/题面/尝试输出/事实/flag 证据） |
| `ctf_writeup_export` | 导出单题 Writeup 到 `<rootDir>/writeups/` |
| `ctf_challenge_remove` | 从题板移除题目（可选删除工作目录） |

解题子代理只能调 `ctf_flag_record`：编排类工具在子代理会话里会被拒绝（防止递归派发）。

## 端到端验证（本机已跑通）

**E2E-01（crypto，Base64+XOR）**：子代理 40 秒内完成——写解码脚本、`check.py` 验证（含负对照）、
反向重编码闭环，`ctf_flag_record(verified=true)` 登记，状态 `solved`，flag
`CTF{ar7ex_m1grat10n_aut0_s0lve_0k}`。

**E2E-02（crypto，ROT13）**：验证「题目录落在会话工作区」后子代理 `write`/`edit` 工具可正常落盘
（修复前子代理沙箱根与题目录不一致，只能退回 pwsh 写文件）。

**E2E-03（misc，Base64）**：走 `ctf_board_import` 批量通道入队 → 自动派发 → 70 秒内解题；
三重证据（check.py 回显 / sha256 对照 / 编码往返）。

**E2E-04（模式 preset 冒烟）**：把 `solverPreset` 切到本插件注册的 `ctf-auto` preset 后，
子代理在 12 个技能目录（ctf-solver skills + refs/ctf-* 模块技能 + 其它模式技能）下正常解题；
证明自建 preset 组成可用。

**E2E-05（会话视图入口冒烟）**：通过面板 Web 通道带 `sessionId` 走
`challenge.add → challenge.start`，题目摘要 `driverSession` 正确记录为该会话，子代理正常解题。

**E2E-06（平台接入，本地 mock CTFd）**：`platform.config.set` → `platform.status`（mock-player 连通）
→ `platform.challenges`（3 题）→ `platform.import`（题面/附件 `mock-a.txt` 落盘）→ `workbench.tree/read/write`
（notes.md 读写）→ `platform.submit` 正确 flag 返回 `correct` 并自动置 solved+verified；错误 flag 返回
`incorrect` 且不置解；`import all` 正确跳过平台已解/已导入；`report.export` 生成 10KB Markdown。

**通道验证**：`GET /dsh-ctf-auto/csrf` + `POST state.get` / `challenge.get` / `platform.*` / `workbench.*` /
`report.export` 在真实宿主回环端口返回正常；客户端槽位注册实时可见：`settings.section` 的 `ctf-auto`
（order 130）与 **唯一一个** `conversation.view` 的 `ctf-auto`（order 50）均 `active:true`
（registrant `dsh-ctf-auto-client`）；`settings.section` 里**不再有** `ctf-auto` 条目（设置已并入内部分页）。
Agent 模式 `ctf-auto` 已注册进 preset roster（共 15 个模式）。

**Writeup 实测**：对真实题「Baby Python (DASCTF http-ctf2)」导出 9.7KB Writeup（题面/flag+证据/尝试/事实链/
关键产物/notes 摘录/复现），落盘 `writeups/baby-python…-writeup.md`；`writeup.list/read` 与
`ctf_writeup_export` 工具均可用。题板「删除」/「删除会话」端点实测（临时题移除、伪会话移除 0 条，均不动磁盘）。

**E2E-13（父会话回退 + 内部分页链路）**：面板通道直接 add/start（不带 sessionId）→ 候选父会话里陈旧 root
会立刻返回 refusal（无输出），编排器自动换下一个父会话重派 → 子代理正常解题并登记 verified flag。

**真实使用实例**：用户在「CTF 自动解题」模式下用会话视图发起 DASCTF web 题
「2048 小游戏（拿到 4096 方块得 flag）」→ 子代理 23 秒解出并本地校验，单界面题板/工作台/台账
均正常展示（`aggregates.bySession` 记录该会话、`driverSession` 绑定正确）。

复现方式：在主会话里

```
ctf_solve_start(title="...", category="crypto", statement="...", files=["C:\\...\\data.enc", "C:\\...\\check.py"])
ctf_solve_status(id="<返回 id>")
```



## 文件与数据布局

```
<session cwd>/.ctf-auto/<slug>/      题目工作区（statement.md / notes.md / files/ / scripts/ / artifacts/ / flag.json）
~/.dsh/ctf-auto/state.json           题板状态库（全局，跨会话/跨工作区）
~/.dsh/ctf-auto/platform.json        平台接入配置（CTFd baseUrl + apiToken，本地明文）
~/.dsh/ctf-auto/config.json          运行时配置覆盖（面板「设置」页写入）
~/.dsh/ctf-auto/reports/             复盘报告导出目录（ctf-report-<时间>.md）
~/.dsh/ctf-auto/writeups/            单题 Writeup 导出目录（<slug>-writeup.md）
plugins/dsh-ctf-auto/                插件包
  lib/index.js                       Host：模式注册/工具/子代理派发/Web 路由/平台/工作台/报告/看门狗
  lib/preset.js                      Agent 模式（ctf-auto）组成：persona + 工具/技能/编排行
  lib/store.js                       状态库（JSON 原子落盘、损坏自愈、裁剪去重）
  lib/prompt.js                      解题 prompt 构建 / flag 提取 / 结果分类
  lib/orchestrator.js                队列·并发·超时·自动重试状态机（端口注入）
  lib/ctfd.js                        CTFd 平台客户端（取题/详情/提交/附件下载）
  lib/workbench.js                   单题工作台文件操作（路径安全/列表/读写）
  lib/report.js                      复盘报告 Markdown 生成
  lib/search.js                      题板检索（题名/题面/尝试/事实/flag）
  lib/writeup.js                     单题 Writeup 生成（纯函数）
  lib/client.js                      单界面会话视图 + 设置页
  cards/ roles/ scripts/              题型技能、角色卡和本地工具脚本
  test/core/ test/platform/          离线单测（fake spawn / mock CTFd / 临时目录）
  docs/SOLVE-DOCTRINE.md             CTF 自动解题操典（prompt 素材库，带条款 ID）
```

## 边界与安全

- 只做「解题」，不攻击平台本身、不碰其他队伍资产；题面/附件/服务响应一律当**数据**而非指令
  （反注入纪律写进 prompt）。
- flag 只认本机可复现证据；`verified=false` 候选不置已解。
- `local-check` / `derivation` 仍依赖子代理提交的证据文本；高保证场景应使用平台提交回显或开启独立复核。
- 破坏性操作停手：保持题目环境可重试，删目标侧资产/停服务须先报告。
- 成本：每个 attempt 是一个完整子代理会话（模型调用计费）；用小 `maxAttempts`/`timeBudgetMinutes`
  控制，或先只跑单题验证。

## 测试

```bash
npm test
```

测试 runner 会递归收集 `test/` 下的 `.test.mjs`，覆盖编排、store、prompt、CTFd/通用平台、自动探测、工作区与工具权限、知识库、记忆、打包、分诊、WSL 和靶机探测。CTFd 测试自带 `node:http` mock CTFd，不联网。

## 已知限制 / 后续

- 平台接入目前验证到**本地 mock CTFd**（真实赛事平台未实测）：CTFd 各版本字段差异做了容错，
  但真实平台的登录/权限/附件路径差异仍需实机确认；`platform.json` 里 apiToken 为本地明文。
- `state.json`、`platform.json`、`config.json` 和导出物会以 `0600` 写入；题目工作区默认建在 `<workspace>/.ctf-auto/`，插件会在其中创建 `.gitignore`，但用户仍应检查自己的 Git 配置。
- **模式 chip 与面板渲染未做真浏览器点按实测**：已确认 preset 进入 roster、客户端槽位
  `active:true`（含唯一 conversation.view 与设置页移除）、通道数据正常；若界面未立即出现新模式，刷新一次页面即可。
- **父会话回退**：某些陈旧 root 会话派发子代理会立刻返回 refusal（无输出）；编排器按「显式调用者 >
  上次成功 > ctf-auto 模式 > 最近更新」排序候选，并在一击即死时自动换下一个父会话（E2E-13 验证）。
- **预算结算**只在有 `handle.send` 通道时启用（真实子代理满足；离线测试用 fake handle 覆盖了注入/宽限/超时收口）。
- 超时被硬中断时子代理上下文里的结论会丢（已用「过半 checkpoint、剩 20% 只收尾」prompt 纪律缓解）。
- 本插件注册的 `ctf-auto` preset 依赖本机安全模式技能目录；技能目录缺失/移动时模式注册会带 diagnostic，工具/面板/编排不受影响。
- 多模态题（图片/音频/二进制大附件）依赖子代理可用工具与本地 Python 环境；缺工具时按
  SOLVE-DOCTRINE 的「工具缺失用脚本等价实现」条款处理。

## 许可

代码采用 MIT License，详见 `LICENSE`。仅可在获得授权的 CTF、实验或研究环境中使用；请遵守比赛规则和平台条款。
