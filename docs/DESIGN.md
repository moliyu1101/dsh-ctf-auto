# dsh-ctf-auto 设计契约（v0.1）

> 本插件为独立实现：题板 / 编排 / 工作台 / 平台 / 知识 / 记忆 / 调度一体化。
> 目标：DSH Desktop 宿主插件 —— 先把「CTF 解题」做成可自主运行、可观测、可重试的编排器；
> 平台取题/导入/提交由 CTFd 与通用 JSON adapter 提供；平台调用只在主会话或显式面板操作中执行。
>
> 本文件是唯一接口契约。实现方严格按此签名/字段名写，不要自行改名；需要变更先告诉 Lead。

---

## 1. 插件身份与文件所有权

| 文件 | 归属 | 说明 |
|---|---|---|
| `package.json` `cordis.patch.yml` `icon.svg` `locale/*.json` | Lead | 清单/加载/展示资源 |
| `assets/cards` `assets/roles` `assets/scripts` | Lead | 题型技能、角色卡、运行时脚本 |
| `lib/index.js` | Lead | Host 入口：Config、模型工具、Web 路由、子代理 spawn、事件钩子 |
| `lib/store.js` | solver-core | 题目状态库（JSON 持久化，纯 node） |
| `lib/prompt.js` | solver-core | 解题提示词构建 + flag 提取 + 结果分类（纯函数） |
| `lib/orchestrator.js` | solver-core | 队列/并发/超时/重试状态机（端口注入，不碰 DSH API） |
| `lib/client.js` | panel-ui | 设置页「CTF 自动解题」面板（浏览器模块） |
| `test/core/*.mjs` | solver-core | node:test 离线单测 |
| `test/run-tests.mjs` | Lead | 递归测试入口 |
| `docs/*` | 设计与运维说明 |

ESM，无构建步骤；运行时代码只允许 Node 内置模块。Host 可用 `@deepseek-ai/schemastery`、
`@deepseek-ai/dsh-tools`（`defineTool`）；Client 只 `require("react")`（模块表提供）。

---

## 2. 数据模型（store.js）

持久化：单文件 JSON，`statePath` 由 index.js 传入（默认 `~/.dsh/ctf-auto/state.json`）。
写盘：`tmp + rename` 原子替换；所有方法同步返回。

```js
// 挑战对象
{
  id: "c-<base36时间>-<3位随机>",   // 例：c-m1x2y3z-a7f
  slug: "web-easy-1a2b3c",          // 目录名：ASCII 化标题 + 6 位 hash，冲突加后缀
  title: "Fish Joy in HTML5",
  category: "web",                  // web/pwn/reverse/crypto/misc/forensics/mobile/cloud/ai/ad/supply/osint 或空
  statement: "题面纯文本（含提示/附件说明/目标地址）",
  target: "http://1.2.3.4:8080",    // 可选
  files: [{ name: "game.zip", path: "<绝对路径>", source: "user|url", url?: "..." }],
  dir: "<rootDir>/<slug>",          // 绝对路径，题目工作区
  platform: null,                   // 预留：{ kind:"ctfd", baseUrl, challengeId } 本版不实现
  status: "queued",                 // queued|running|solved|stuck|failed|stopped
  createdAt, startedAt, endedAt,    // epoch ms，可空
  stuckReason: "",                  // status=stuck/failed 时一句话
  attempts: [{
    n: 1,
    angle: "recon-first",           // 本次尝试角度（见 prompt.js ANGLES）
    sessionId: "sess-...",          // 子代理会话 id（spawn 返回；可空）
    label: "ctf-c-m1x2y3z-a7f#1",
    startedAt, endedAt,
    status: "running",              // running|completed|timeout|error|aborted
    stopReason: "",                 // completed/aborted/error/max-tokens/refusal/timeout
    summary: "",                    // 本次结论一句话（来自输出/flag 记录）
    failedPaths: [],                // 本次已失败/卡死的具体路径（禁止下一轮重复），≤30 条去重
    outputTail: "",                 // 输出尾部 ≤ 4000 字符（排障用）
    error: ""
  }],
  flags: [{ value: "flag{...}", verified: true, evidence: "check.py 输出 OK / 原版解码函数一致",
            method: "local-check|derivation|manual|platform", recordedAt, attempt: 1 }],
  facts: [{ at, text, source: "attempt#1", attempt: 1 }],   // 解题事实链（上限 120 条，超出丢最旧、同前缀去重）
  events: [{ at, kind: "queued|started|attempt-start|attempt-end|flag|stuck|stopped|error|note",
             text, attempt?: n, data?: {} }],                // 滚动保留最近 300 条
  budget: { maxAttempts: 3, timeBudgetMs: 1800000 } // timeBudgetMs 为单题总预算
}
```

`state` 顶层：

```js
{ version: 1, updatedAt, rootDir, challenges: { [id]: Challenge },
  order: [id...],                       // 创建顺序
  running: { [id]: true },              // 派生（不持久化也可，但写上更省心）
  stats: { total, queued, running, solved, stuck, failed, stopped }  // stats() 现算
}
```

API（导出名固定）：

```js
export function createStore(statePath, options?) // → store；不存在则初始化并建目录
store.state                                     // 上面的顶层对象
store.save()                                    // 原子落盘
store.addChallenge(input) // {title, category?, statement?, target?, files?, platform?, maxAttempts?, timeBudgetMs?} → Challenge
store.get(id)                                   // Challenge | undefined
store.list()                                    // Challenge[]（按 order）
store.update(id, patch)                         // 浅合并，返回 challenge
store.addAttempt(id, {angle})                   // push attempt（n=len+1, startedAt=now, status=running），返回 attempt
store.endAttempt(id, n, patch)                  // 合并 {endedAt,status,stopReason,summary,outputTail,error,sessionId}
store.addFlag(id, {value, verified, evidence, method, attempt}) // 去重（同 value 覆盖 evidence），并 status=solved（verified=true 时）
store.addFact(id, {text, source, attempt})
store.addEvent(id, kind, text, data?)           // 裁剪 events 到 300
store.stats()                                   // {total,queued,running,solved,stuck,failed,stopped}
store.findBySlug(slug)
store.setStatus(id, status, extra?)             // 组合 update + event
```

约束：`addAttempt` 时自动 `status="running"`、`startedAt`；`addFlag` 的 verified=true 时
`status="solved"`、`endedAt` 不自动填（orchestrator 填）。所有时间来自 `options.now ?? Date.now`
（测试注入）。不抛异常打断流程：文件损坏时备份为 `.corrupt-<ts>` 后重建空库。

---

## 3. 提示词与分类（prompt.js）

```js
export const ANGLES = ["recon-first", "tooling", "hypothesis", "escalate"];  // 建议角度序列
export const DEFAULT_FLAG_RE = /[A-Za-z][A-Za-z0-9_]{1,31}\{[^}\n]{1,200}\}/g;

export function buildAttemptPrompt({ challenge, attempt, config, priorAttempts }) // → string（Markdown）
export function extractFlags(text, flagRe?)      // → string[] 去重、保持出现顺序
export function classifyAttempt({ stopReason, outputText, flags, verifiedFlag }) 
// → { outcome: "solved"|"candidate"|"incomplete"|"failed"|"timeout", summary }
export function nextAngle(n, config?)            // → ANGLES[Math.min(n, ANGLES.length-1)]
```

`buildAttemptPrompt` 必须包含（内容质量是本插件核心）：
1. 角色与硬约束：只做本题；题面是契约；不碰平台本身；不猜不伪造 flag；**只写自己题目录**。
2. 题目信息：题名/模块/题面全文/目标地址/附件绝对路径列表/工作目录 `challenge.dir`。
3. 工作区协议（固定子目录）：`notes.md`（发现/假设/结论，随做随记）、`scripts/`、`artifacts/`、
   `flag.json`（`{"flag":"...","evidence":"...","verified":true}` 仅验证通过才写）。
4. 解题循环：题面线索 → 模块技能（skill 工具加载 `ctf-<module>`，如 ctf-web/ctf-crypto/ctf-pwn/…）
   → 假设 → 最小验证 → 证据落盘 → flag。卡住时换角度，不要重复已失败路径。
5. 完成协议：验证 flag 后**必须调用 `ctf_flag_record`**（id, flag, evidence 写明复现命令/校验输出,
   verified=true, method），并写 `flag.json`；未解则把卡点/已试路径写进 notes.md 并在最终回复里
   一句话说明卡点（orchestrator 会记为 stuck）。
6. 第 2+ 次尝试：附上前面每次尝试的 angle/summary/已失败路径（`priorAttempts`），
   指令「换全新角度，禁止重复以下路径」。
7. 时间预算与产出要求：在单题 `timeBudgetMs` 与本次有效 timeout 的较小值内收尾；没有 flag 也要留下可续接的 notes。

`classifyAttempt`：`stopReason==="completed"` 且有 verified flag → solved；
有未验证 flag → candidate；`error`/`aborted` → failed/aborted；否则 incomplete。

---

## 4. 编排状态机（orchestrator.js）

```js
export function createOrchestrator(deps)
// deps = { store, spawn, config, now?, logger? }
// config = { concurrency:2, timeoutMs:1800000, maxAttempts:3, autoRetry:true,
//            hints:[], extraFlagsRe:[], solverPreset:"ctf-solver" }
// hints：来自 retry/面板的附加提示，拼进 prompt 的「附加提示」段；同题 2+ 次 attempts 不复用 session
// spawn(request) → handle
//   request = { label, prompt, cwd, agentPreset, attempt, challenge, signal }
//   handle  = { sessionId?, done: Promise<{stopReason, outputText}> , interrupt(): void }
//   抛错/拒绝 = 本次尝试 failed（error 记入 attempt）

o.start(id, {agentPreset}?)   // 置 queued + pump()；返回 {ok, queued}
o.pump()                      // 并发驱动：running<concurrency 时取 queued 启动
o.stop(id)                    // interrupt + status=stopped + 事件
o.stopAll()
o.retry(id, hint?)            // 往队列重置：status=queued + 可选 hint 写 events
o.tick()                      // 超时看门狗（index.js 用 timer 每秒/10秒调）：超时 → interrupt + timeout 收口
o.isRunning(id)
o.close()                     // 取消所有 timer、interrupt 运行中
```

一次尝试流程（`runAttempt`）：
1. `store.addAttempt` → `store.addEvent("attempt-start")` → `spawn(...)`；
2. `await done`（内部已含 timeout），`interrupt()` 兜底；
3. flag 收集：`extractFlags(outputText)` + store 里该题已有 flag（子代理可能已调 `ctf_flag_record`）；
4. `classifyAttempt` → `endAttempt` + 事件；
5. 已 solved → status=solved；否则 attempts < maxAttempts && autoRetry → 自动下一角度排 queued；
   否则 status=stuck（附 stuckReason）。`pump()` 继续下一个。
6. 任何分支都 `store.save()`；异常全部捕获，绝不让状态机崩。

单元测试用 fake spawn（可手动 resolve/abort）+ fake now，覆盖：并发上限、超时、自动重试、
成功收口、stop、spawn 抛错、状态落盘（临时目录）。

---

## 5. Host 工具（index.js，模型侧）

工具名前缀固定 `ctf_`，全部只在 ctf-solver 模式/或任意模式可用（不做模式限制——模式判定不可靠）。
所有工具返回 `{ok:boolean, ...}` 且带 `render`。

| 工具 | 参数 | 行为 |
|---|---|---|
| `ctf_solve_start` | `title`(必), `category?`, `statement`(必), `target?`, `files?: string[]` (绝对路径或 URL), `maxAttempts?`, `timeBudgetMinutes?`, `preset?` | 建题目录+状态，入队并启动；立即返回 `{ok, id, slug, dir, status}` |
| `ctf_board_import` | `challenges: [{title, category?, statement?, target?, files?}]` | 批量建题入队，返回 id 列表 |
| `ctf_solve_status` | `id?`, `includeEvents?: boolean`, `limit?`（默认 20） | 无 id：题板摘要（含 stats）；有 id：单题详情（attempts/facts/flags/events） |
| `ctf_solve_stop` | `id` | 停止运行中的尝试并置 stopped |
| `ctf_solve_retry` | `id`, `hint?` | 重置为 queued，hint 写入事件并注入下次 prompt 的额外提示 |
| `ctf_flag_record` | `id`, `flag`, `evidence`, `verified`, `method?` | 子代理/主代理登记 flag；verified=true 才置 solved |
| `ctf_solve_log` | `id`, `limit?` | 返回该题事件/尝试轨迹文本（排障） |

`files` 处理：URL 不自动下载（本版不联网取附件）；路径存在则校验并在题目录建
`files/` 软链接或复制（小文件复制，>50MB 只记录路径）。附件目录约定见 prompt。

spawn 端口实现（index.js）：
```js
const parent = exec.agent;                 // 工具执行上下文里的调用者 Agent
const activation = await ctx.subagents.startActivation({
  provider: "spawn", label,
  request: { prompt: [{type:"text", text}], parent, cwd: challenge.dir,
             agentPreset: config.solverPreset },
  signal, delivery: "parent"
});
// activation.result → { output:[{type:"text",text}], stopReason }
// activation.childId → sessionId；interrupt：ctx.subagents.interrupt(childId, {kind:"ancestor", agent: parent})
```
若 `subagents` 服务/`spawn` provider 不可用：工具返回明确 diagnostic（不静默降级），
并在面板里标红。**首次安装后必须先跑通一次这种 spawn（spike）再扩展。**

父会话选择：按「显式调用者 > 上次成功 > ctf-auto 模式 > 最近更新的 live root 会话」排序；
若某父会话派发即返回 refusal/error/blocked 且无任何输出（陈旧会话），自动中断该子会话并换下一个父会话重派，
全部失败才以 error 收口（E2E-13 验证）。

---

## 6. Web 通道（Host route，面板用）

`ctx.webServer.register({kind:"prefix", path:"/dsh-ctf-auto", handler})`；同源栅栏 + CSRF
（照抄 `dsh-campaign-memory/lib/index.js` 的 `isTrustedRequest` / `checkCsrf` / `readBody` 模式）：
`GET /dsh-ctf-auto/csrf → {token}`；其余 `POST`，头 `x-dsh-csrf: <token>`，body JSON。

| endpoint | 入参 | 返回 |
|---|---|---|
| `state.get` | `{}` | `{ok, stats, config:{concurrency,timeoutMs,maxAttempts,autoRetry,solverPreset,rootDir}, subagents:{available,providers}, aggregates:{byStatus, byCategory:[{category,total,solved,running,queued,stuck,failed,stopped}], bySession:[{sessionId,total,solved,running,queued,stuck,failed,stopped,lastAt,live,preset,cwd,challenges:[{id,title,category,status,attempts,verified,createdAt,endedAt}]}], ledger:[{challengeId,title,category,flag,verified,evidence,method,attempt,at,sessionId}]}, challenges:[{id,slug,title,category,status,target,dir,driverSession,createdAt,startedAt,endedAt,attempts,lastAttemptStatus,lastAttemptAngle,flags,verified,stuckReason}]}` |
| `challenge.get` | `{id}` | `{ok, challenge}`（完整，含 events 最近 200、attempts、flags、facts） |
| `challenge.add` | `{title, category?, statement?, target?, files?, sessionId?}` | `{ok, id}` |
| `challenge.start` | `{id, sessionId?}` | `{ok, status}`（`sessionId` = 从会话视图发起时用该会话当父代理） |
| `challenge.stop` | `{id}` | `{ok, status}` |
| `challenge.retry` | `{id, hint?, sessionId?}` | `{ok, status}` |
| `flag.record` | `{id, flag, evidence, verified, method?}` | `{ok, status}` |

错误统一 `{ok:false, error:"..."}`，HTTP 200 返回业务结果；鉴权失败 403。

---

## 7. 面板（client.js）

- 注册：`ctx.slots.register({name:"settings.section", id:"ctf-auto", order:130, label:()=>"CTF 自动解题"}, Component)`
  （`ctx.slots.inject("settings.section", ...)` 包一层）。
- 浏览器模块格式：`window.__ModuleLoader__.load({ id:"@dsh-external/dsh-ctf-auto", factory:(require)=>{ ... return module.exports; } })`，
  末尾 `module.exports = { name, inject:["slots"], apply };`
- 数据：fetch `/dsh-ctf-auto/*`（先取 csrf，POST 带 `x-dsh-csrf`）；3s 轮询 `state.get`；展开单题时 `challenge.get`。
- UI 结构：标题/统计条（total/queued/running/solved/stuck）→ 新建题目折叠表单（title/category/statement/target/files 多行）
  → 题目卡片列表（状态徽标、模块、耗时、尝试数、flag 数、展开详情：attempts 时间线、facts、events 日志、
  开始/停止/重试按钮、flag 展示与证据）→ 轻量 toast。
- 样式：单文件内 `<style>` 注入（`ctx.effect` 返回清理），浅/深色两套 CSS 变量
  （`body[data-ds-dark-theme]` 覆盖），沿用 `dsh-campaign-memory/lib/client.js` 的视觉语言与类名前缀 `dsh-ctf-`。
- 不读别的插件的 DOM；不替换 root；文本中文（另有 `locale/en.json` 供展示元数据）。

### 7.1 会话视图（`conversation.view`，**只做一个，内部多标签分页**）

用户口径：**所有界面都在「CTF 自动解题」这一个标签下做内部分页**，不在插件/设置列表里另开页面
（`settings.section` 不再注册）；题板/会话/台账不再是独立 tab，而是同一个界面里的内部分区。

- 注册一个：`ctx.slots.inject("conversation.view", () => ctx.slots.register({name:"conversation.view", id:"ctf-auto", order:50, label:()=>"CTF 自动解题"}, Cmp))`。
- **内部标签栏**（组件内 state；默认「题板」）：`题板` ｜ `平台` ｜ `台账` ｜ `复盘` ｜ `设置`。
- 公共头部（所有内部分页共用）：标题 + 统计条（总/排队/运行/已解/卡住）+ 运行中倒计时/结算阶段 +
  子代理告警 + 平台状态 chip + 「刷新」。
- **题板**页：工具条（状态 chips / 模块 / 搜索（`search.query`，命中跳题）/ 排序 / 分组方式（按会话·平铺）/ 仅本会话）
  + 按会话分组的题目卡片（组头：短 id、当前会话、preset/cwd/live、计数、折叠）+ 卡片「详情」展开单题**工作台**
  （概览 attempts/facts/events/flags ｜附件｜笔记可编辑｜脚本｜产物 ｜ 操作：开始/停止/重试/显示目录/提交 flag）。
- **平台**页：CTFd 配置（baseUrl/token）+ 测试连接 + 拉取题板 + 勾选导入 + 平台题状态与提交记录。
- **台账**页：合计 + 按模块分布 + 按状态分布 + flag 台账（未验证标黄、证据展开）。
- **复盘**页（重设计 v2）：Hero 头部（标题/说明/状态标签 + 批量导出 Writeup / 导出复盘 / 刷新）→ 4 个 KPI 卡
  （已解 / Writeup / 复盘报告 / 未验证 flag）→ 模块覆盖条形 → 工具条（搜索 / 模块 / 排序 / 仅看已导出 / 筛选计数）→
  两列：左「已解清单」富卡片（已解 pill、题名、模块、耗时、尝试、复制 flag、导出/重新导出、展开；flag 行含验证方式/
  证据摘要/导出状态；展开显示题面、尝试、最近事实、目录+复制），右列（Markdown 预览卡（标题/路径/复制路径/关闭）→
  Writeup 历史 → 复盘报告历史）。Markdown 预览按标题/列表/引用/代码块轻量渲染，不再是纯 pre。
  列表与历史均为富卡片：已解卡带模块色头像、题名/耗时/尝试/相对完成时间、flag 行（FLAG 标签 + 等宽 flag + 一键复制 +
  验证/方式 pill）、证据 2 行折叠可展开、导出状态左侧色条；历史卡带 MD 徽标、文件名省略、大小/相对时间、预览与复制路径；右列 sticky。
  数据来自 `state.get`（challenges + aggregates.ledger/byCategory）与 `report.list/read`、`writeup.list/read/export`。
- **设置**页（重设计）：页头（标题/说明 + 未保存标记 + 恢复默认 + 保存配置）→ 三张配置卡（编排 /
  预算结算 / 模型，字段带说明与单位）→ 诊断卡（每行状态 pill + label + 值，来自 `doctor`）。
  配置读写 `config.get/config.set`；恢复默认使用 `config.get` 返回的 `defaults`。
- **管理**：卡片「删除」（二次确认；challenge.remove，默认只从题板移除，工作目录保留）、组头「删除会话」
  （session.remove，移除该驱动会话下所有题目，目录保留）；详情底部另有「删除题目」。
- **单题 Writeup**：已解题在卡片/详情/复盘页可「导出 Writeup」（§16），复盘页同时展示 Writeup 历史与预览。
- 会话视图里写操作（add/start/retry/submit/config.set 等）payload 带 `sessionId`。
- 卡片展示：运行中显示「剩余 mm:ss · 结算中/正常」；stuck 显示卡点；solved 显示 flag 与验证方式。

### 7.2 模式入口（Agent 模式 / preset）

Host 半区（`lib/preset.js` + `lib/index.js`）注册 preset `ctf-auto`（名称「CTF 自动解题」，order 85，
组成：persona/agent-instructions/shell/fs/skills/planning/compaction/
delegation/ask-user/todo/web/scanner），使「新建会话」的模式 chip 出现该模式，选中即可直接发起对话。
注册失败不阻塞插件（`ctf_solve_doctor` 输出 `preset.registered/error/listed`）。子代理默认仍用
`ctf-solver` preset（`config.solverPreset`），不随模式改动。

---

## 8. 平台接入（CTFd / `lib/ctfd.js`）

平台配置持久化在 `<rootDir>/platform.json`：`{ kind:"ctfd", baseUrl, apiToken }`（本地库，明文）。
模块 API（纯 Node，可注入 `fetchImpl` 便于离线测）：

```js
export function normalizeBaseUrl(url)                      // 去尾斜杠；补 https?://
export function createCtfdClient({ baseUrl, token, fetchImpl = fetch })
// 全部返回 { ok:true, data } | { ok:false, error, status? }
  .me()                        // GET /api/v1/users/me
  .listChallenges()            // GET /api/v1/challenges → [{id,name,category,value,type,solvedByMe}]
  .getChallenge(id)            // GET /api/v1/challenges/{id} → {id,name,description,connectionInfo,category,value,type,solvedByMe,files:[{name,url}]}
  .submit(challengeId, flag)   // POST /api/v1/challenges/attempt → {status:"correct"|"incorrect"|"already_solved"|"ratelimited", message}
  .download(url, { maxBytes }) // 带 token 取附件 → {bytes:Uint8Array, filename}
```

鉴权头：`Authorization: Token <apiToken>`；`/api/v1/challenges` 结果字段随 CTFd 版本差异做容错
（`success/data` 缺失或 `solved_by_me` 缺省都不是错误）。

Host Web 端点：

| endpoint | 入参 | 返回 |
|---|---|---|
| `platform.status` | `{}` | `{ok, configured, kind, baseUrl, tokenSet, reachable, user?:{id,name}, error?}` |
| `platform.config.get` | `{}` | `{ok, platform:{kind, baseUrl, tokenSet, tokenHint}}`（tokenHint=尾 4 位） |
| `platform.config.set` | `{kind?, baseUrl?, apiToken?}` | `{ok, platform}`；省略 apiToken=保持，空串=清除 |
| `platform.challenges` | `{}` | `{ok, challenges:[...listChallenges], error?}` |
| `platform.import` | `{ids?:number[], all?:boolean, skipSolved?:boolean=true}` | `{ok, created:[{localId, platformId, title}], skipped, errors[]}` |
| `platform.submit` | `{id, flag}` | `{ok, status, message}` |

导入规则：`statement` = 题面描述 + `connection_info` + 平台题号；`category` 取平台 category（小写归一）；
`platform={kind,baseUrl,challengeId}` 写进 challenge；附件下载到题目录 `files/`（单文件 ≤20MB、≤10 个，
失败记 event 不阻塞）；已导入（baseUrl+challengeId 相同）跳过；`skipSolved` 默认跳过平台已解。

提交规则：只提交本地题（需有 `platform.challengeId`）；`correct` → `ctf_flag_record(verified=true,
method="platform", evidence="平台提交回显：…")` 自动置已解；`already_solved` → 同样按已验证收口并记事件；
`incorrect`/`ratelimited` → 记事件/fact，返回错误信息（不置解）。

模型工具：`ctf_platform_import`（参数同 `platform.import`）、`ctf_platform_submit`（参数同 `platform.submit`）、
`ctf_platform_status`。

## 9. 单题工作台（`lib/workbench.js` + 端点）

路径安全：所有 path 先 resolve 到 `challenge.dir` 内，拒绝绝对路径/`..`/跨目录；只读文本 ≤512KB。
不做删除、不执行任意命令。

| endpoint | 入参 | 返回 |
|---|---|---|
| `workbench.tree` | `{id}` | `{ok, dir, entries:[{path, kind:"file"|"dir", size, mtime}]}`（深度 2、≤200 条，含 statement.md/notes.md/flag.json/files/scripts/artifacts） |
| `workbench.read` | `{id, path, maxBytes?}` | `{ok, path, text, size, truncated}`；二进制返回 `{ok:false, error:"binary"}` |
| `workbench.write` | `{id, path, text}` | `{ok, path, bytes}`（自动建父目录；≤512KB；仅题目录内） |

模型工具：`ctf_workbench_list` / `ctf_workbench_read` / `ctf_workbench_write`。

## 10. 复盘报告（`lib/report.js` + 端点）

```js
export function buildMarkdownReport(state, { generatedAt } = {}) // → string
```
内容：标题/生成时间/统计（总/排队/运行/已解/卡住）/按模块分布/**逐题**（题名、模块、状态、
flag（已验证/待验证）+ 验证方式 + 证据摘要、attempts 角度/状态/摘要、最近 3 条 facts、工作目录）/
未解卡点与已试路径。

端点 `report.export {}` → 写 `<rootDir>/reports/ctf-report-<ISO>.md`，返回
`{ok, path, bytes, markdown}`（markdown ≤4000 字符）。模型工具 `ctf_report_export`。

---

## 11. 运行时配置（`<rootDir>/config.json`，面板可改）

优先级：`cordis.patch.yml` 的 row config（默认值）< `<rootDir>/config.json`（运行时覆盖）。

| 键 | 默认 | 说明 |
|---|---|---|
| `concurrency` | 2 | 并发尝试上限（1..8） |
| `timeoutMs` | 1800000 | 单次尝试总预算（毫秒，60s..4h） |
| `maxAttempts` | 3 | 单题最多尝试次数（1..10） |
| `autoRetry` | true | 失败/卡住自动换角度重试 |
| `solverPreset` | ctf-auto | 子代理 preset |
| `solverModel` | "" | 首轮子代理模型（空=跟随默认） |
| `escalateModel` | "" | 第 2+ 次尝试使用的模型（空=不升级） |
| `wrapupRatio` | 0.8 | 预算结算触发比例（0.5..0.95） |
| `wrapupGraceMs` | 120000 | 结算宽限（毫秒，0..600000） |

端点：`config.get {}` → `{ok, config, defaults}`；`config.set {patch}` → `{ok, config}`（逐键 clamp/校验，
非法值忽略并返回 diagnostic）。`config.set` 生效方式：更新 live 配置 + `orchestrator.setConfig(patch)` +
并发提高时 `pump()`；模型字段在下一次 spawn 生效。

## 12. 预算结算（wrapup settlement）

每次尝试到 `wrapupRatio * timeoutMs` 时（只触发一次）：
1. `store` 记 `attempt.wrapupAt`、事件 `wrapup`；
2. 通过 spawn handle 的 `send(content)` 向运行中的子代理注入收尾消息：
   「预算到 80%：现在收尾——把已确认事实/半成品脚本写进 notes.md 与 artifacts/，已验证 flag 立即
   ctf_flag_record；然后一句话总结剩余卡点」；
3. deadline 顺延 `wrapupGraceMs`；到期仍未完成 → interrupt，`stopReason="timeout"`。
`state.get` 提供 `attempt.deadline/wrapupAt/phase`（`normal|wrapup`）与 `challenge.phase`，面板显示倒计时。

## 13. 检索（`lib/search.js`）

```js
export function searchBoard(state, query, options = {}) // → [{challengeId,title,category,status,field,attempt?,snippet}]
```
搜索范围：title、category、statement、attempts（angle/status/summary/outputTail/error/failedPaths）、
facts.text、flags（value/evidence/method）。结果按字段优先级（title > statement > facts > attempts > flags）排序，
`limit` 默认 50。端点 `search.query {q, limit}`；模型工具 `ctf_search`。

## 14. 复盘报告列表

`report.list {}` → `{ok, dir, reports:[{name, path, bytes, mtime}]}`（`<rootDir>/reports/` 下 `.md`，按 mtime 倒序 ≤50）。

---

## 16. 单题 Writeup 与题板管理

### 16.1 Writeup（`lib/writeup.js`）

```js
export function buildWriteup(challenge, { generatedAt, notes, files }) // → string（Markdown）
```
结构（用户口径）：**只有「题目」与「解题步骤」两节**。
- 题目：清洗后的题面——删除编排层注入的辅助块（解题方向建议 / 已观测事实 / 工作区 / 平台题号 / 建议方向）
  与重复元信息行（题名 / 模块 / 题目 id），保留目标地址等题目本身信息；超长截断并标注。
- 解题步骤：从 notes.md 按标题切分小节，剔除与解题无关的小节（反注入/注入观察、已失败路径、下一步建议、
  时间预算、工作区协议/完成协议、卡点/风险/备注、产物/事实链/复现、尝试记录）与「随做随记」占位；无 notes 时
  退化为一句「解出 flag：…（工作区未留下解題记录）」；超长截断并标注。
- 不写：Flag 独立小节、解题过程（attempts）、事实链、关键产物、复现与验证。

端点：

| endpoint | 入参 | 返回 |
|---|---|---|
| `writeup.export` | `{id}` | `{ok, id, path, bytes, markdown}`（落盘 `<rootDir>/writeups/<slug>-writeup.md`） |
| `writeup.list` | `{}` | `{ok, dir, writeups:[{name,path,bytes,mtime}]}`（≤100，按 mtime 倒序） |
| `writeup.read` | `{name}` | `{ok, name, path, markdown, bytes}`（≤8000 字预览） |

模型工具：`ctf_writeup_export`。

### 16.2 题板管理

| endpoint | 入参 | 返回 |
|---|---|---|
| `challenge.remove` | `{id, deleteFiles?}` | `{ok, id, filesRemoved}`（运行中先 stop） |
| `session.remove` | `{sessionId, deleteFiles?}` | `{ok, sessionId, removed, ids, filesRemoved}` |

`deleteFiles=true` 时删除题目目录，仅允许题板根目录内或任意 `<workspace>/.ctf-auto/` 下的目录（词法校验）；
默认保留磁盘产物。模型工具：`ctf_challenge_remove`。


1. `node --test test/core/` 全绿；`node --check` 所有 js。
2. `plugin_manager install_bundle` 后：宿主工具面出现 `ctf_solve_start` 等（`cordis_inspect_query Tool.listTools`）。
3. spike：对一道 trivial 题（题面写「运行 echo 后把 TEST{ok} 作为 flag 验证记录」）跑通
   start → 子代理解题 → `ctf_flag_record(verified:true)` → 状态 solved。
4. 真实验证：至少一道真实 CTF 题完整走完（题目自证）。
5. 面板：设置页出现「CTF 自动解题」，能新建/启动/停止/重试并实时看到状态（无浏览器控制时报告此局限）。
6. 文档：README（安装/使用/配置）、docs/DESIGN.md（接口契约）。

---

## 17. 工作区隔离（题板以工作区为单位）

题板/复盘/Writeup 都按**工作区**（驱动会话的 cwd）隔离：不同工作区的数据互不展示。

- `challenge.workspace`：建题时写入（`dirname(<workspace>/.ctf-auto)`）；旧数据按 `dir` 中的 `/.ctf-auto/` 反推，
  全局目录下的旧题在首次访问时按 `driverSession` 的会话 cwd 归位（一次性归位）。
- 可见性：`visibleChallenges(workspace)` 过滤 `challengeWorkspace(c)` 与请求工作区一致（路径归一、大小写不敏感）；
  `state.get` / `search.query` / `ctf_solve_status` / `ctf_search` / 复盘报告 / Writeup 列表全部走该过滤；
  `workspace` 为空（无会话上下文）时退化为全量（兼容旧行为）。
- 请求工作区来源：Web 端点用 `payload.sessionId` 对应会话的 cwd（无则回退最近一次工作区/面板会话）；
  模型工具用 `exec.agent` 的 cwd（子代理 cwd 在 `.ctf-auto/<slug>` 时回溯到工作区根）。
- 复盘报告落盘名带工作区键：`ctf-report-<wsKey>-<时间>.md`（`wsKey = ws + 路径 sha256 前 8 位`；全局为 `global`），
  列表/读取按当前工作区键过滤；Writeup 列表按当前工作区题目的 slug 过滤，跨工作区读取返回拒绝。
- 平台接入与运行时配置（`platform.json` / `config.json`）保持全局共享（基础设施配置，不随工作区隔离）。

---

## 18. P0 增强（常驻/题型/质量/韧性/全局视图）

- **常驻层**：`preset.js` 的 AUTO_PERSONA 改为短常驻指令（判定 → 题目立刻派发 / 非题目简短回答），工具细节留在工具描述里。
- **题型识别**：`lib/classify.js`（13 类启发式：关键词/附件扩展名/目标端口）→ `ctf_solve_start` 自动写 category，
  challenge 记 `categorySource:"auto"` / `categoryReasons`，事件「题型自动识别」；`prompt.js` 导出 `skillForCategory`，
  orchestrator 写入 `attempt.skill`。
- **flag 门槛**：`lib/flagcheck.js` 校验形态（`flagPatterns`，默认 `^[A-Za-z0-9_]{2,40}\{...\}$`）与 evidence
  （`minEvidenceChars` 默认 12、拒绝占位词）；`ctf_flag_record` 对 verified 不达标自动降级（verified=false + 事件），
  `method="platform"` 豁免形态校验。
- **平台韧性**：`lib/ctfd.js` 增加节流（`minIntervalMs`）与指数退避重试（`maxRetries` 默认 2、`retryBaseMs` 默认 400；
  429/500/502/503/504 与网络错误；尊重 `Retry-After`），`sleepImpl` 可注入便于离线测。
- **全局视图**：`state.get` 新增 `scope:"all"`（跨工作区聚合，challenge 摘要带 `workspace`）；题板工具条「全部工作区」开关；
  aggregates 新增 `byWorkspace`。
- **设置页**：新增「质量门槛」卡（最短 evidence 字符 / flag 格式正则多行）。

---

## 19. P1 增强（角色分层 / 私有知识 / 分诊 / 打包）

- **角色卡（3 张）**：`assets/roles/{solver,reviewer,recon}.md` 全文注入（`lib/roles.js` 读文件 + 内置回退）。
  orchestrator 按尝试选择角色：第 1 次 = `recon`（只做侦察与分诊），第 2+ 次 = `solver`；`attempt.role` 记录。
  `prompt.js` 接受 `roleText/roleName`，在提示词顶部插入「角色卡（全文载入）」段。
- **独立复核（reviewer）**：`ctf_review_flag` / `flag.review` —— 用 `buildReviewPrompt` 派 reviewer 子代理（只给原始材料、
  不采信主链结论、要求 `REVIEW: VERIFIED|REJECTED` + 复现命令）；REJECTED 时把已验证 flag 降级为待验证、置 stuck 并记事实；
  VERIFIED 时在 challenge 上写 `review:{status,at,summary}`。
- **私有知识库**：`lib/kb.js`（建索引 + AND 检索 + 标题/分类加权 + 摘录）；宿主扫描 `<rootDir>/writeups/*.md` 与各题
  `notes.md`（15s 缓存），端点 `kb.search`、工具 `ctf_kb_search`；跨工作区可检索。
- **附件分诊**：`lib/triage.js`（魔数优先 + 扩展名回退，覆盖 zip/png/jpeg/gif/pdf/elf/pe/pcap/gzip/7z/rar/sqlite/java/pyc/wasm），
  端点 `triage.run`、工具 `ctf_triage`，结果落盘 `artifacts/triage.json` 并给下一步提示；文件列表按路径去重。
- **WP 打包**：`lib/pack.js`（纯 Node 最小 ustar tar + gzip，无外部依赖）；端点 `writeup.pack`、工具 `ctf_writeup_pack`，
  打包 writeup.md + statement/flag + files/scripts/artifacts（单文件 ≤5MB、总量 ≤20MB、≤200 文件），落盘 `<rootDir>/packages/`。
- **面板**：复盘页新增「私有知识检索」；已解卡片/详情新增「复核」「打包」；详情动作条扩展。

---

## 20. P2 增强（WSL 转发 / 平台提示 / 耗时统计；MCP 暂缓）

- **WSL 工具转发**：`lib/wslrun.js` —— Windows 路径转 `/mnt/<drive>/...`、`bash -lc` 单引号安全拼装、
  可注入 execImpl 的执行封装（超时/输出截断）、发行版探测（`wsl -l -q` UTF-16 解析 + 绝对路径 + 默认发行版实际执行三级回退）。
  端点 `wsl.run`、工具 `ctf_wsl_run`（可带 challengeId 决定默认 cwd 并写事件）；doctor 回报 `wslDistros`，设置页诊断显示 WSL。
- **平台提示**：`lib/ctfd.js` 新增 `hints(challengeId)` / `unlockHint(hintId)`（GET `/challenges/{id}/hints`、
  POST `/hints/{id}/unlock`）；端点 `platform.hints`、工具 `ctf_platform_hints`（unlock=true 时逐个解锁并把内容落进本地题目的 facts/事件）。
- **耗时统计**：`aggregates.timing = {attempts,totalMs,avgMs,maxMs}`（由各次 attempt 的 startedAt/endedAt 计算）；
  复盘页新增 KPI「平均尝试耗时（N 次）」。Token 级成本暂不可得——子代理 done 只回 `{stopReason,outputText,sessionId}`，无 usage 字段。
- **暂缓项**：IDA/任意 MCP 接线按用户要求先不做（`ida64` 本机缺失、profile 未配 MCP 服务器）。
- **未做项**：125 篇模块卡扩充（内容工程）、真实浏览器 UI 自动化（当前为 headless mini-React 冒烟）。

---

## 21. 常驻/题型/知识导入/记忆页（本轮）

- **常驻层**：`assets/roles/resident.md`（判定表 + 短纪律），`preset.js` 用 `loadRoleText("resident")` 读取并注入 persona；
  读不到时用内置短兜底。常驻层只做判定/路由，工具细节在工具描述。
- **题型层**：插件自带 `assets/cards/ctf-{mobile,cloud,ad,supply}/SKILL.md`，`skillDirsOf` 恒加入 `<plugin>/assets/cards`（与 refs 并列，
  doctor 技能目录 13）；`MODULE_SKILLS` 补齐 4 类；`attempt.skill` / `attempt.role` 写入 attempt-start 事件。
- **知识层导入**：`lib/kbimport.js`（parse/normalize/safeName 纯函数）；宿主 `knowledgeDir()`=`<rootDir>/knowledge`，
  `kb.import` 复制文件（单文件≤2MB、单次≤50 个且总量≤20MB、去重后缀）、`kb.list`、`kb.delete`；`buildKnowledgeIndex` 新增 `imported` 源
  （sourceLabel=导入）；工具 `ctf_kb_import`；面板「知识」页（导入区 + 已导入列表 + 检索）。
- **记忆层页面**：`memory.summary` 汇总所有工作区（byWorkspace）、黑板事实流（跨题/跨工作区，limit）、totals/timing；
  `lib/blackboard.js` 做事实分层（标签优先 + 关键词兜底），`store.addFact` 落 `kind`；面板「记忆」页（工作区卡 + 分层筛选 + 事实流）。
- **自动复核**：配置 `reviewerEnabled`（默认 false），watchdog 每 5s 挑「solved + 有已验证 flag + 无 review」的题（每次≤2）
  调 `reviewFlag`，带 in-flight 去重；设置页「质量门槛」卡新增开关。
- **脚本库**：`assets/scripts/README.md` + `flag_check.py`/`triage.sh`/`unpack.sh`/`wsl_tool.sh`（只读、幂等、输出到 stdout）。
- **未做**：125 篇知识卡内容、真实浏览器 UI 自动化、IDA/MCP（按要求暂缓）。

---

## 22. 记忆层学习闭环（跨会话打法沉淀 + 相似题召回）

- **存储**：`<rootDir>/memory.json`（全局，跨会话/跨工作区）；`{version, cards:[...]}`，原子写（tmp+rename）。
  卡片字段：`id/title/category/tech/tags/entry/steps/commands/pitfalls/summary/flagPattern/flagLocation/sourceChallengeId/used/usedOk/lastUsedAt`。
- **沉淀（纯函数 `lib/memory.js::distillCard`）**：从 challenge + `notes.md` + 导出的 `writeup.md` 抽技法（32 项技法词典）、入口、
  步骤、可复用命令、失败坑、结论摘要、flag 形态（只存掩码，不存原始 flag）。
- **触发**：watchdog 每 5s 对「solved 且未沉淀」的题自动沉淀（每次≤2，受 `autoDistill` 控制）；
  端点 `memory.distill {id?|all}`、工具 `ctf_memory_distill`；`memory.cards` / 工具 `ctf_memory_list` 读取。
- **召回（`lib/memory.js::rankMemories`）**：词集重合（ASCII 词 + 中文二元组）+ 同模块加分 + 技法命中加分；阈值 `memoryMinScore`（默认 0.3）、
  条数 `memoryTopK`（默认 3）；orchestrator 通过注入端口 `recall(challenge)` 取得，写入 `attempt.memories` 并记事件「召回相似打法卡 N 张」。
- **注入**：`prompt.js` 在时间预算前插入「## 7. 相似题记忆」段（技法/入口/步骤/命令/坑），并明确「结论必须自己复现，不得直接采信历史 flag」。
- **计数**：尝试收口时回调 `onMemoriesUsed(ids, solved)` → `used++`；解出时 `usedOk++`（记忆页显示复用/成功率）。
- **面板**：「记忆」页新增「打法卡」面板（模块色头像、技法 chips、复用/成功计数、展开步骤/命令/坑），支持「沉淀全部已解题」；
  设置页「质量门槛」新增自动沉淀开关与召回条数。
- **配置**：`autoDistill`（默认 true）、`memoryTopK`（3）、`memoryMinScore`（0.3）。

---

## 23. 知识页 v2（双列工作台）

- 数据：`kb.stats`（索引总数/导入/Writeup/笔记）、`kb.list`、`kb.read`（导入文件预览，≤20k 字符截断）、
  `kb.search`、`kb.import`、`kb.delete`；`scanKnowledge` 15s 缓存，导入/删除后失效重建。
- 布局：Hero（4 类计数 + 刷新）→ 双列 `.dsh-ctf-kbgrid`：
  左列 = 导入卡（等宽 textarea 路径输入、导入/清空、最近导入回执含失败明细、已导入文件卡：MD 徽标/大小/相对时间/预览/删除）；
  右列 = 检索卡（关键词输入 + 来源筛选 chips + 命中卡：来源徽标/分类/score/摘录/分数条，点击预览）+ Markdown 预览卡（路径/复制/关闭）。
- 预览复用 `renderMarkdown`（标题/列表/引用/代码块轻量渲染）；预览对导入文件走 `kb.read`，对 Writeup 走 `writeup.read`，笔记类只展示摘录。
- **v3 视觉增强**：导入卡 = 4 个统计小块（已导入/占用空间/最近导入/支持格式）+ 虚线拖拽区（drag-over 高亮，拖入路径文本）+ 快速填入 chips
  （知识目录/Writeup 目录）+ 导入回执（失败逐条）+ 已导入文件卡片；检索卡 = 带图标搜索框（清空按钮）+ 分段控件式来源筛选（带计数）
  + 空闲建议词 chips（点击即搜）+ 命中计数 + 富结果卡（来源色块/技法分类/score pill/命中词高亮/路径/悬浮操作/底部相关度条）。
- 冒烟：知识页断言含导入区/检索区/已导入列表/预览渲染/建议词检索（`qa/ui-smoke.mjs`）。

---

## 24. 知识与记忆在解题时调用（联合召回 + 复用计数）

- **联合召回端口**：orchestrator 的 `recall(challenge)` 可返回数组（仅打法卡）或 `{memories, knowledge}`；
  attempt 记录 `attempt.memories` / `attempt.knowledge`，并分别记事件「召回相似打法卡 N 张」「召回知识片段 N 条」。
- **知识召回算法**：`lib/kb.js::rankKnowledge(entries, challenge, {limit,minScore})` —— 词集重合余弦 + 同模块加分；
  默认 `knowledgeTopK=3` / `knowledgeMinScore=0.08`（可在设置页调）。
- **提示词注入**：`prompt.js` 在时间预算前依次插入「§7 相似题记忆」「§8 相关知识库片段」（来源/标题/摘录/路径）；
  解题循环新增 2.5 步：先 `ctf_kb_search`（关键词=题名/技法/工具），卡住时 `ctf_recall` 一次拿回两层。
- **运行中召回工具**：`ctf_recall {id?|q?}` —— 给 id 按题目召回（打法卡+知识片段）；给 q 用关键词分别检索 memory 与知识库。
- **复用计数**：知识条目用量存 `<rootDir>/knowledge-usage.json`（按 entry id 记 used/usedOk/lastUsedAt），
  `onKnowledgeUsed(ids, solved)` 在尝试收口回调；`kb.stats.usage` 暴露总次数与逐条计数，知识页展示「复用次数」与文件/结果卡 chip。
- **越打越强闭环**：解出 → 自动沉淀打法卡（§22）→ 下次相似题召回并注入 → 复用/成功率计数 → 高成功率卡在排序中优先。
- 配置：`knowledgeTopK`、`knowledgeMinScore`；设置页「知识召回条数」。

---

## 25. 靶机探测 / 运行指标 / 多平台

> 说明：本节面向生产可观测性与多平台接入的能力补齐。

- **靶机就绪探测**：`lib/target.js` —— `parseTarget`（URL/host:port）、`probeHttp`（任意响应即就绪）、`probeTcp`（连接成功即就绪）。
  宿主 `probeChallengeTarget` 写 `challenge.targetStatus {state,ok,latencyMs,checkedAt,error,targetRaw}` 并记事件；
  watchdog 对 running/queued 且 60s 未探测的题自动探测（每轮≤2，in-flight 去重）；端点 `target.probe` / 工具 `ctf_target_probe`。
  面板卡片显示「靶机就绪 / 目标不可达」chip，详情动作条有「探测目标」。
- **主控台指标**：orchestrator 记录 `attempt.promptChars / outputChars / estTokens / estCost`（token≈字符/4，费用=token/1M×`pricePerMToken`）；
  `store.endAttempt` 允许落这几个字段；challenge 摘要带 `lastEvent`（最新事件文本）与 `estCost`；aggregates 新增 `usage`。
  面板：卡片指标行显示 靶机状态 / 费用 / 当前动作（running/queued/stuck），复盘页新增「累计费用估算（K tokens）」KPI，
  设置页「预算结算」新增 Token 单价。含义：费用为**估算**（子代理 API 不回 usage），用于趋势与对比，不是账单。
- **多平台接入**：`lib/platform-generic.js` —— 可配置 profile 适配任意 HTTP JSON 平台：`listPath/detailPath/submitPath`、
  `headers`、`map.list.{dataPath,id,name,category,value,description,files}`、`map.submit.{statusPath,messagePath,okStatuses,alreadyStatuses}`；
  `platform.json` 增加 `kind:"ctfd"|"generic"` 与 `profile`；`platform.config.set` 接受 kind/profile（profile 支持 JSON 字符串）；
  平台面板新增「适配器模式」下拉与 Profile JSON 编辑框；Token 以 Bearer 发送；通用适配器不支持附件自动下载（明确报错）。
  实测：本地 mock 平台（2 题）配置 generic 后 `platform.status` 连通、`platform.challenges` 拉到 2 题，随后复位为未配置。

---

## 26. 平台自动探测 + 比赛级调度视图

- **自动探测**：`lib/platform-detect.js` —— `detectPlatform({baseUrl, apiToken, fetchImpl})`：
  ① 首页 HTML 指纹（CTFd/NSSCTF 线索）；② 依次试 `/api/v1/challenges`、`/api/challenges`、`/api/v1/challenge/list` 等候选路径；
  ③ CTFd JSON 形如 `{success,data:[...]}` 直接判 ctfd；④ 其他 JSON 用 `guessChallengeArray` 找「题目数组」并反推
  `profile{listPath,detailPath,submitPath,map.list.*}`。返回 `{kind,confidence,evidence[],profile}`。
  宿主：端点 `platform.detect`（`apply=true` 时写 platform.json）、工具 `ctf_platform_detect`、平台面板「自动探测平台」按钮。
- **调度快照**：orchestrator 新增 `snapshot()` —— 运行中条目（attemptN/elapsedMs/timeoutMs/phase/angle/role/skill/target）、
  排队列表（position/id/title/category）、并发/timeout/maxAttempts/autoRetry；`runningCount`/`queuedCount` 保留。
- **调度视图**：端点 `schedule.summary` 组合快照 + 题板统计 + 30 分钟节奏（6 个 5 分钟桶：attempt-start 事件与 solved 完成）+
  最近完成（耗时/费用）+ 平台状态；工具 `ctf_schedule`。面板新增第 8 个标签「调度」：KPI（并发/排队/30min 尝试/完成）、
  运行中卡片（进度条 + 角度/角色/技能 chip + 停止）、排队卡片（位置 + 取消）、节奏条形图、最近完成列表。
  实测：mock CTFd 探测 kind=ctfd(high)、证据链完整；调度端点返回 6 桶节奏 + 最近完成 2 题。

---

## 27. DASCTF 开放 API（MCP 通道）接入

- 端点：默认 `https://ctf2.dasctf.com/api/ai/v1/mcp`，Bearer `CTF2_AGENT_TOKEN`；首包 `initialize` 取 `Mcp-Session-Id`，
  随后 `notifications/initialized`、`tools/list`、`tools/call`；兼容 JSON 与 `text/event-stream` 响应，429 按 `retry_after_ms` 重试一次。
- 适配器：`lib/mcp-dasctf.js` —— `me/listChallenges/getChallenge/submit/download` + `environment`；
  练习题走 `ctf2_get_practice_challenge` / `ctf2_submit_flag`，比赛题走 `ctf2_get_competition_challenge` /
  `ctf2_submit_competition_flag`（提交带 `confirmation:true`）；附件用 `ctf2_get_attachment_url` 换 5 分钟签名 URL。
- 平台配置：`kind:"dasctf"`、`apiToken`（或环境变量）、`baseUrl`（可空，默认 origin）、`mcpUrl`（可空，默认 `/api/ai/v1/mcp`）；
  面板 dasctf 模式显示 MCP 地址字段；「自动探测平台」用 whoami 验证并显示工具数。
- 靶机：`ctf_platform_env`（start/status/extend/delete）与端点 `platform.env`；环境状态写入 challenge.environment 与事件。
- 实测：真实 Token 下 `platform.status` 连通（agent 知枭）、`platform.challenges` 拉取 50 题、`platform.detect` 显示 24 个工具；
  环境 start→get→delete 已验证并清理。`lib/dasctf.js` 的 REST 客户端保留给只读调试用。
