# 云端宿主适配层详细设计(语义事件 + Pi 适配器)

本文是 [2026-08-14-mae-flow-cloud-mvp-design.md](2026-08-14-mae-flow-cloud-mvp-design.md) §5.3/§5.4 的详细设计,覆盖整个迁移里最核心的一层:**Pi 事件流 → 语义事件 → 内核(门禁 / 证据 / 人工节点 / 子 Agent 生命周期)**。内核规则零改动是本设计的验收标准之一。

> **2026-08-14 实施定案**:实现落在独立仓 `mae-flow-cloud`(TypeScript,
> Pi 经 SDK 进程内嵌入),本文的语义模型、D1–D5 决定、验收判据全部照用;
> 具体机制按进程内形态映射——`tool_call` 钩子承担 §4 同步裁决,
> 自定义工具的未 resolve Promise 承担 §5 挂起,同进程平行 AgentSession
> 承担 §6。§7 的模块表对应 `src/*.ts`,证据裁判是内核仓契约
> (harness/verify_transcript.py 调 `mae_flow_core`,TS 不复刻判定)。
> 五问已全部实证为"是":同步拦截(tool_call 可 block,reason 即打回文案)、
> 结构化输入(自定义工具)、子会话(SDK 多 session)、工具流证据
> (tool_execution_* 事件)、恢复(SessionManager 持久化,首版未启用)。
> Python 版曾以「pi --mode rpc + HTTP 环回桥」全链验证(本仓历史
> 2add07b),进程内形态使桥与 RPC 解析两层消失,该版本已随仓库边界
> 调整移除。实战教训:环回流量必须直连(内网代理劫持 127.0.0.1);
> pi 只认 throw 作为工具失败信号;被打回的调用也必须登记 tool_use 行。

## 0. 设计总纲:冻结内核面向的接口,翻译只发生在一处

内核今天消费的东西盘点下来只有五样(见 §1),而且全部是**数据形状**,不是 Claude/CodeAgent 私有 API。因此适配层的总策略:

> **内核看到的世界不变**——同一套工具词汇表(Bash/Edit/Write/Task/AskUserQuestion/Skill)、同一种 transcript JSONL、同一个 `.mae-flow.json`。Pi 长什么样只有 `pi_event_map.py` 一个文件知道;Pi 私有对象不越过这个文件。

由此得出五个核心决定(D1–D5),后文逐个展开:

| # | 决定 | 换来的东西 |
|---|------|-----------|
| D1 | 语义事件是唯一接缝,Pi 私有对象不出翻译层 | 换 Runtime = 换一个映射文件 |
| D2 | 证据仍是 transcript 同形 JSONL,由云端 TranscriptStore 自己落盘 | quality 四个契约零改动 |
| D3 | 门禁从"子进程 exit 2"改为"进程内函数返回 Decision",纯逻辑全复用 | guard/ 与拦截语义零改动 |
| D4 | AskUserQuestion 在裁决通道拦下转 Web 待办,决定以工具结果回注 | 34 处步骤文档零改动 |
| D5 | 子 Agent 若 Pi 无原生支持,适配器用平行 Pi 会话模拟 Task 工具 | agent_kind/生命周期对账零改动 |

## 1. 现有接缝盘点(事实,2026-08-14 时点)

内核与宿主的全部接触面,按消费方列出。字段名是代码里的真实名字,云端语义事件必须能填出这些字段。

### 1.1 Hook 事件与 payload

`hooks/dispatch.py` 接收 stdin JSON,六种事件。内核实际消费的 payload 字段:

| 事件 | 消费字段 |
|------|----------|
| sessionstart | (触发注入即可) |
| userprompt | `prompt` |
| pretooluse | `tool_name`、`tool_input`(Bash 取 `.command`,Edit/Write 取 `.file_path`,Task 取 `.subagent_type/.description/.prompt`) |
| posttooluse | `tool_name`、`tool_input`、`tool_response`、`tool_use_id` |
| subagentstop | `agent_type`、`invocation_id`、最终文本 |
| stop | `stop_hook_active` |

输出语义:exit 2 = 拦截/打回(stderr 为打回文案),其余一律 0(fail-open);看门狗超时无条件放行。

### 1.2 证据输入(quality/tool_transcript.py)

`parse_transcript(lines)` 吃 JSONL 行,只认这些形状(已兼容多种别名):

- 消息行:`{"type": "user"|"assistant", "message": {"role", "content": [...]}}`
- 工具调用块:`{"type": "tool_use"|"tool_call", "id", "name", "input"}`
- 工具结果块:`{"type": "tool_result"|"tool_response", "tool_use_id", "is_error", "content"}`

产出 `ToolCall{call_id, name, input, result_seen, is_error, result}`。契约判定在此之上做:`XXX_RESULT:` 标记、`bash_call` 命令匹配、`call_failed` 退出码嗅探。**这是纯数据格式,与宿主无关**——D2 的依据。

### 1.3 门禁裁决(guard/ + adapters/hook_runtime_contracts.py)

PreToolUse 裁决是纯函数:`active_pretool_decision(tool, tool_input, moonlight)` → `allow | agent | gate-edit | gate-bash | block-question`。拦截落地方式(exit 2)是宿主机制,裁决逻辑本身与宿主无关——D3 的依据。

### 1.4 人工节点(AskUserQuestion)

34 处步骤文档 + flow.json 引用 AskUserQuestion。内核在 posttooluse 捕获 `tool_response` 的文本作为用户决定。**内核不关心问题怎么呈现给人,只关心结构化答案以工具结果形式回来**——D4 的依据。

### 1.5 子 Agent 生命周期(adapters/hook_agent_lifecycle.py)

Task/Agent 派发时按 `subagent_type/description/prompt` 推 `agent_kind`(COMPILE/CODECHECK/UT/STORY/…),记 started 观察;结束时用 `tool_use_id` / `agentId` 对账,记 returned/interrupted。消费的只是**派发意图 + 结束信号 + 最终文本**——D5 的依据。

## 2. 语义事件模型(D1)

云端唯一事件入口。所有 Pi 回调先翻译成下表事件,再进内核;人工决定从 Web 进来,也走同一入口。

```
SemanticEvent
  event_id      # 单调递增,任务内唯一;恢复与幂等的锚
  task_id
  session_id    # Pi 会话;子 Agent 会话有自己的 session_id
  ts
  kind          # 见下表
  payload       # 按 kind 定形
```

| kind | payload | 对应旧 Hook 事件 |
|------|---------|------------------|
| `session_started` | `{resume: bool}` | sessionstart |
| `user_message` | `{text}` | userprompt |
| `assistant_message` | `{text}` | (transcript assistant 行) |
| `tool_requested` | `{call_id, name, input}` **同步,须应答** | pretooluse |
| `tool_finished` | `{call_id, name, input, is_error, result}` | posttooluse |
| `agent_spawned` | `{call_id, agent_type, description, prompt, child_session_id}` | pretooluse(Task) |
| `agent_finished` | `{call_id, child_session_id, lifecycle: returned\|interrupted, final_text}` | subagentstop / posttool agentId |
| `turn_finished` | `{reason: end_turn\|error\|killed}` | stop |
| `session_ended` | `{reason: completed\|failed\|cancelled, detail}` | (Pi 生命周期) |
| `human_decision` | `{waiting_id, state_version, decision, notes}` **来自 Web,非 Pi** | posttooluse(AskUserQuestion) |

约束:

- `tool_requested` 是**同步事件**:适配器必须拿到裁决应答(§4)才放行 Pi 继续,这是五问第 1 问的落点;
- 事件按 `event_id` 追加写入任务事件日志(PostgreSQL 投影的来源),同一 `event_id` 重放幂等;
- Pi 私有字段在 `pi_event_map.py` 内消化,不进 payload。

## 3. 证据源:TranscriptStore(D2)

**不让契约学新格式,让云端把事件流写成契约已认识的格式。**

TranscriptStore 订阅语义事件,在任务工作区落 `transcript.jsonl`:

- `user_message` → user 消息行;
- `assistant_message` → assistant 消息行;
- `tool_requested` → assistant 行内 `tool_use` 块(`id=call_id`);
- `tool_finished` → user 行内 `tool_result` 块(`tool_use_id=call_id`, `is_error`, `content`);
- 子 Agent 会话各写各的 `transcript-<child_session_id>.jsonl`,对齐现有"每个子 Agent 有自己 transcript"的查证据路径。

验收:把云端 transcript 喂给现有 `parse_transcript` + 四个契约,与 CLI 版行为一致(§7 契约测试)。`hook_transcript_paths.py` 增加云端布局的路径解析分支,这是唯一允许改的内核文件。

关键语义保持:

- `result` 必须是宿主真实回传的工具输出(含退出码文本),不能是 Agent 复述——`call_failed` 靠它嗅探失败;
- `XXX_RESULT:` 标记判定作用在 `final_text` / assistant 文本上,回注时不得截断首行。

## 4. 门禁执行点:GateService(D3)

`tool_requested` 的同步处理者。**复用,不重写**:

```
GateService.decide(task, event) -> Decision(allow | deny(reason) | transform)
```

- 内部直接调用现有纯逻辑:`active_pretool_decision`、guard/ 的 gate-edit/gate-bash 契约、模板校验、agent 范围检查——即今天 dispatch.py pretooluse 路径背后的同一批函数,只是从"子进程 + stdin + exit code"换成进程内调用;
- **fail-open 语义保留**:GateService 自身异常或超时(对齐看门狗精神,建议 15s)= 放行 + 记日志。门禁不许因为自己坏了卡死交付;
- `deny.reason` 即打回文案,经 Pi 以工具错误结果回给 Agent(等价于今天的 exit 2 + stderr);
- posttool 侧契约(证据登记、Agent 生命周期对账)同理挂在 `tool_finished` / `agent_finished` 上。

Pi 侧前提(五问第 1 问,一票否决):Pi 必须支持"工具调用先外呼、按应答放行/打回"。若 Pi 只有异步回调,本设计不成立,先向 Pi 提需求。

## 5. 人工节点:HumanGate(D4)

**AskUserQuestion 永不真实执行**。流转:

1. Agent 按步骤文档调用 AskUserQuestion(34 处文档原样生效);
2. GateService 拦下,HumanGate 据 `tool_input`(问题、选项)+ 当前步骤上下文创建 `WAITING_FOR_HUMAN` 记录(含状态版本),任务暂停,小鲁班通知;
3. Web 端提交决定 → `human_decision` 事件,校验状态版本,第一个匹配的生效;
4. 决定以 **AskUserQuestion 的工具结果**回注 Pi 会话(`call_id` 对上),Agent 视角与今天完全一致;同时 TranscriptStore 落 `tool_result` 块,posttool 捕获路径照旧工作。

回注形状:与 CodeAgent 的 AskUserQuestion tool_response 同形(选中项文本)。这样 `_text_of(tool_response)` 等既有捕获零改动。

暂停/恢复:等待期间 Pi 会话挂起(工具调用未应答)。若 Pi 不支持长挂起,降级方案 = 结束本轮会话、决定到达后按 `session_started{resume}` + 决定文本恢复——两种路线在阶段 0 实测后二选一,倾向挂起(上下文零损失)。

## 6. 子 Agent:AgentBridge(D5)

Agent 调 Task/Agent 工具时:

- **Pi 有原生子会话**:映射为 `agent_spawned`/`agent_finished`,`child_session_id` 绑 `call_id`(对齐今天 agentId↔tool_use_id 的别名对账);
- **Pi 没有**:AgentBridge 自己开一个平行 Pi 会话执行子任务,对主会话仍表现为 Task 工具调用+最终文本结果。内核的 `agent_kind` 推断、started/finished 观察、范围检查全部照旧,因为它们只看 `subagent_type/description/prompt` 和结束信号。

子 Agent 的 transcript 单独落盘(§3),编译/CodeCheck/UT 契约到子 transcript 里查证据的路径不变。

## 7. 模块规划与测试

新增 `scripts/mae_flow_core/adapters/cloud/`,旧 `hook_*` 一个不动:

```
adapters/cloud/
  semantic_events.py    # §2 事件定义与事件日志(追加写 + 幂等重放)
  pi_session.py         # 控制通道:创建/恢复/终止会话、发消息(五问 5)
  pi_event_map.py       # Pi 私有回调 → SemanticEvent,唯一知道 Pi 长相的文件
  transcript_store.py   # §3
  gate_service.py       # §4
  human_gate.py         # §5
  agent_bridge.py       # §6
```

测试(对齐主 spec §15.2 最后一条,这是本设计的核心验收):

1. **双适配器对拍**:同一语义事件序列分别喂旧 Hook 适配器(经 payload 还原)与云端适配器,`.mae-flow.json` 状态迁移逐事件一致;
2. **transcript 同形**:云端 TranscriptStore 产物直接过 `parse_transcript` + compile/codecheck/ut/grill 四契约,与手工构造的 CLI transcript 判定一致;
3. **HumanGate 并发**:两个 `human_decision` 争同一状态版本,后到者拒;
4. **fail-open**:GateService 抛异常/超时,工具放行且日志留痕;
5. **fake Pi**:桩实现 `pi_session`/`pi_event_map`,整链跑通一个最小步骤(参照 codespec 桩二进制钉测试的先例)。

## 8. 阶段 0 原型对本设计的验证点

明日原型脚本按本设计的接口切:

1. `pi_session.py` 真连 Pi:开会话、发消息、收事件——验证五问 2/5 与事件通道;
2. 在 `tool_requested` 上挂一个"永远 deny 第一条 Bash"的假 GateService——验证五问 1(一票否决);
3. 把收到的事件流经 `transcript_store.py` 落盘,喂 `parse_transcript` 打印 ToolCall——验证五问 4(一票否决)与 D2;
4. 若 Pi 有子会话 API,派一个;没有就记录事实,D5 走平行会话路线。

## 9. 开放问题(阶段 0 关账)

- Pi 工具外呼的同步应答形式(回调返回值?HTTP 应答?)与超时行为;
- Pi 会话可挂起的最长时间(决定 §5 的挂起 vs 重建);
- Pi 工具结果回注的形状(能否指定 `call_id`);
- Pi 的工具词汇表与 CodeAgent 的差异清单(名字、参数字段),差异全部在 `pi_event_map.py` 里抹平;
- Pi 会话事件里是否带 token/耗时统计(管理看板的 Agent 执行时间指标来源)。
