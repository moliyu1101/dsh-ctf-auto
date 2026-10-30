# 实验黑板：参考 Muteki 的证据与交接设计

## 设计依据

本轮对照 [FishCodeTech/muteki](https://github.com/FishCodeTech/muteki) 的 `c60c8feeff69a64aa5abfbda113f3f33bff30af4`，重点看了：

| 参考设计 | 来源 | 在本插件中的落点 |
| --- | --- | --- |
| 事实、证据、假设和失败路径分别记录，结论绑定来源 | [graph_facts.py](https://github.com/FishCodeTech/muteki/blob/c60c8feeff69a64aa5abfbda113f3f33bff30af4/muteki/swarm/graph_facts.py) | 明确记录 hypothesis / scope / expectedResult / observedResult / evidence |
| 重用实时黑板，失败结论限定到测试范围；旧上下文不能当作当前事实 | [cli_board_context.py](https://github.com/FishCodeTech/muteki/blob/c60c8feeff69a64aa5abfbda113f3f33bff30af4/muteki/solver/cli_board_context.py) | 重试自动注入黑板摘要；提供实时读取与文件摘要核对工具；材料/靶机范围变化后标记旧记录 |
| 调度进展依据有实质意义的变化 | [coordinator_progress.py](https://github.com/FishCodeTech/muteki/blob/c60c8feeff69a64aa5abfbda113f3f33bff30af4/muteki/swarm/coordinator_progress.py) | 幂等请求不产生新进展；仅改计划文字或版本号不重置无产出计时 |

实现独立编写，未复制 Muteki 的代码、提示词或资源，也未引入其运行时或额外依赖。仍通过现有 DSH 子代理执行实验，本轮不增加模型调用。

## 从文字笔记到可交接实验

每项实验都有稳定 `key`，记录可证伪假设、测试范围、可观察预期、实际命令、实测结果、证据文件和下一步。命令只记账，不会由登记工具执行。

| 状态 | 含义 | 门槛 |
| --- | --- | --- |
| proposed | 已提出，等待最小实验 | 创建时填写 hypothesis、scope、expectedResult |
| running | 正在实验 | 沿用同一 key 更新，不重复建记录 |
| supported | 实验在列出的范围内支持假设 | 至少 12 字符实测结果、至少一个非空证据文件 |
| refuted | 实验在列出的范围内证伪假设 | 同上；不能据此排除未经测试的其他字段、参数或环境 |
| blocked | 缺工具、依赖、访问条件等 | 至少 12 字符的实际错误与阻塞原因，可填写下一步替代方案 |

`supported` 不会置为 `solved`，也不会生成已验证 flag。平台题仍须正确判题回显或显式独立复核，遵循现有 flag 验证规则。

## 模型工具

- `ctf_experiments`：读实时黑板；指定 `key` 与 `verifyEvidence=true` 核对当前文件；指定 `key` 与 `includeHistory=true` 读取版本历史。核对/历史读取默认只选当前范围；查询旧范围时显式传入其 `epoch`。
- `ctf_experiment_record`：创建或更新实验。子代理只可访问绑定题目目录或当前运行尝试；停止、失效或跨题的执行上下文不能补写结果。主会话/面板仍按工作区授权。

创建示例：

```json
{
  "id": "c-example",
  "key": "upload:filename-template",
  "hypothesis": "上传文件名可能经过模板求值",
  "scope": "POST /upload 的 filename 字段，单一无害表达式样本",
  "expectedResult": "表达式结果出现在响应正文而非保留字面量",
  "command": "python3 scripts/check_upload.py",
  "status": "proposed"
}
```

运行实际实验，并将真实输出保存到 `artifacts/` 后，携带返回的 `epoch` 和当前版本更新：

```json
{
  "id": "c-example",
  "key": "upload:filename-template",
  "epoch": "替换为读取到的范围标识",
  "expectedVersion": 1,
  "status": "refuted",
  "observedResult": "响应中表达式保留为字面量，未观察到当前字段发生服务端求值",
  "evidencePaths": ["artifacts/upload/check-v1.txt"],
  "nextStep": "只排除该字段与当前样本，接着检查服务端存储路径"
}
```

更新需要 `expectedVersion`，避免迟到的结果覆盖新记录。内容完全相同的请求幂等合并，不增版本、不增加事件。等价假设、范围和预期不能通过更换 key 重复建实验。

## 重开、范围与证据

重开 supported/refuted/blocked 路径或改变其测试定义时，必须提供至少 12 字符的 `reopenReason` 说明新增变量，以及此前未登记过的证据字节。复制文件、改文件名或重用旧输出不能重开。系统检查的是字节新旧，证据是否足以支持科学结论仍需解题者判断。

证据只能引用题目内普通文件，拒绝绝对路径、越界路径、符号链接、特殊文件和超大文件。读取有大小上限，并检查打开前后的文件身份及修改情况。每次保存记录文件相对路径、大小和 SHA-256；按 key 核对时返回 `match` / `changed` / `unavailable`。

摘要匹配只说明字节与登记时一致，不说明内容真实或 flag 正确。登记不备份原文件字节，建议每轮使用新的 `artifacts/<key>/check-vN.txt`，保留原始输出以便复核。

范围标识由题面、输入准备批次、已登记附件元信息和环境 ID 派生。环境 ID 或材料批次变化后，旧记录仍保留并显示“旧材料/靶机范围”，不能直接排除当前范围；仅访问地址变化不会自动抹掉已试路径。磁盘文件原地改写需要通过证据核对发现。

## 面板与重试交接

题目详情增加“实验黑板”：可新建实验、记录进展、查看旧范围记录、在当前范围另建实验和核对证据。核对结果标注时间，是一次观测而非持续保证。只读视图隐藏写操作。

新的尝试会收到未完成实验、当前范围的证伪/阻塞路径、支持结论、下一步及文件摘要。内联交接限制在约 8000 字符，省略数量明确显示，完整记录通过实时工具读取。不能把摘要中未出现的路径当成尚未尝试。

实验状态、实际结果或证据摘要变化可计为进展；仅编辑 nextStep 等计划文字，或重放同一请求，不会借黑板事件重置无产出看门狗。

## 存储、上限与导出

记录在现有题目状态库中，与事件在同一持久化事务保存。旧状态缺少实验字段时按空黑板兼容；不支持或损坏的实验格式会报错并保留原文件。写盘失败显式返回 applied/dirty，不会把失败说成已持久化。

每题最多 64 条记录，每条保留最近 8 个历史版本，额外保留最多 128 个不同证据摘要用于防止重放；每次最多引用 4 个文件、每文件 1MiB。达到上限返回明确错误，不自动驱逐未完成实验或删除旧摘要。

普通读请求省略历史，按 key 才能请求完整版本历史或读取文件。WP 包额外附带 `experiments.json`，包含状态、历史和证据引用。现有 flag 导出仍只采用可信台账。

## 验证范围

回归覆盖持久化/重启、证据门槛、字节核对、旧证据重放、旧范围隔离、版本冲突、容量上限、符号链接与文件替换、写盘失败、子代理题目/尝试隔离、交接预算以及 WP 导出。

测试使用本地服务与临时文件；真实 DSH Desktop 中的新增表单与实际赛事解题效果仍需重载插件后验证。


前置依赖、原结论争议冻结及独立复验的工具用法和边界见 [蜂群设计与使用](SWARM.md#前置依赖与就绪后续派)。前置快照只证明引用了哪个版本和文件摘要，不证明推理本身正确。
