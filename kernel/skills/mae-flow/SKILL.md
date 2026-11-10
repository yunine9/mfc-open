---
name: mae-flow
description: 由状态机和工具门禁驱动的端到端需求交付工作流。仅当用户明确表达要交付/开发一个需求或修复一个缺陷时触发:给出了单号（DTS/REQ 开头）、提供了 SE 设计文档、明说"开始做这个需求/落地成代码提 MR",或明确要求使用"月光宝盒/moonlight"无人值守开发。用户仅输入 init、安装、环境等模糊词或意图不明时不要触发,先询问对方想做什么。即使用户贴出完整需求描述,也必须走完整流程,在走完配置确认与交付方式选择前不写代码。

---

# Mae-Flow(mae-flow 驱动)

**全程使用简体中文与用户交流**(代码、命令、报错原文除外)。
**用户话术封装**:上游术语不进用户视野——openspec/superpowers/brainstorming/ponytail/
archive/change/delta spec 不对用户说;统一说法:规格条目(=delta spec)、变更目录(=change)、
规格定稿(=archive)、方案讨论(=brainstorming)、代码精简(=ponytail review)、
开发方式=完整开发(full)/已定位问题修复(hotfix)/局部修改(tweak)/处理评审意见(review)。
内部命令、--choice 代号、路径、报错原文照旧;doctor/排障输出保留原词。

本流程**不由你解释和记忆**,由状态机工具驱动。你的职责只有一个循环:

```
python ".mae-flow-work/bin/mae-flow.py" current   # 拿当前步骤指令(用 python,不是 python3——Windows 无 python3 命令)
→ 严格按打印的指令执行
→ python ".mae-flow-work/bin/mae-flow.py" done [--ack|--choice|--set]   # 声明完成,工具校验证据后给出下一步
```

首次触发先执行 `python ".mae-flow-work/bin/mae-flow.py" init`(已有 `.mae-flow.json` 则直接
`current` 续跑)。转发壳由 Hook 在你发起交付时自动铺好——铺桥是机器的活,你不需要找、
也不需要传插件路径。它客观缺失时(Hook 会打一行降级提示),只用那行提示里给出的绝对路径,
禁止读环境变量、搜插件缓存或猜版本目录。`python` 命令不可用时立即停止流程,
告知用户先安装 Python 3,不做变通。

## 三个特殊入口(细节都在各自的权威处,不在本文)

- **月光宝盒**(用户消息明确含"月光宝盒"或"moonlight"):不走普通 init,直接执行
  `python ".mae-flow-work/bin/mae-flow.py" moonlight on --ack "月光宝盒"`(原文只有英文就传 moonlight)。
  之后仍是 current → 执行 → done 循环;**运行规则以 current 每回合打印的月光覆盖规则为准**
  (禁止 AskUserQuestion、禁止结束回复等待;defer/blocked/unlock-source 一律按 current 给出的命令执行)。
  底线不随模式改变:不许伪造 PASS/CLEAN、删除或缩小测试、自动豁免、强推。
- **用户主动退出**(优先级高于 current):用户明确表示"不想继续用流程、后面直接改代码"时,
  不要解释成 skip/goto/暂停,让用户发送 `/mae-flow:mae-flow exit`——Hook 直接授权退出,
  不再二次确认;后续按普通开发执行,不再 current/done。"能不能退出"只是询问,不触发。
  Hook 也坏时把 `python ".mae-flow-work/bin/mae-flow.py" exit --interactive --reason "切换为普通开发"`
  交用户在真实终端运行(Agent 的 Bash 管道会被拒)。其余分流细节按 /mae-flow:mae-flow 命令文档执行。
- **独立能力**(用户点名 ut/codecheck/grill):走 `python ".mae-flow-work/bin/mae-flow.py" action status`
  同族的 action 命令,**禁止 init**;范围确认、派发、收尾全按 `action start` 及后续输出执行。
  存在完整流程状态时不叠加,由用户先 exit。默认不 commit、不 push。

**插件安装不等于流程启用**:项目根没有 `.mae-flow.json` 时 Hook 完整旁路,
用户照常直接改码;只有用户明确发起交付才接管,禁止看见插件就 init。

## 铁律(工具管不了、必须你自己守的)

1. **🔴 STOP 只用于真正需要用户决策的事项**(模式/范围/豁免/风险裁决)。优先
   AskUserQuestion,不可用才结束回复等文本(月光宝盒运行期间不询问)。
   禁止代替用户做决定;点选后直接 `done --choice ...`,不得再让用户补输"确认××"。
   编译通过、检查完成等事实由机器证据判断,不为收尾索要确认。
   **等待不是决策**:后台子 Agent 没返回、编译还在跑、检查未出结果——直接结束回复等,
   不得用占位问题/进度同步占着提问位(实战里出现过"占位问题,请忽略此问")。
   **凡请用户检视或确认的内容(配置单/文档/diff),把关键内容和文件完整路径写进
   你的回复正文**——工具输出用户看不见;只给摘要不给路径,用户没法打开文件核对。
   豁免、改被测源码、承担风险、强制跳转等高影响动作:先 `messages` 取当前步骤
   真实回答 ID,再用 `--message-id <ID>` 验真;**伪造、猜测或跨步骤复用消息 ID 是最严重违规**。
2. **编码不拆流程批次**:分块写,块间不 done、不问用户。编译自检是自由不是批次:
   时机自定(随块编译或最后统编都行),失败当场修;编译结果只是你的自我反馈,
   不是证据——不得据此索要用户确认,也不得替代推送前验证与流水线的核销,
   编译事实的口径以 build 步出门清单为准。谁来写码由 build 步的「编码执行方式」
   决定(默认主 Agent 亲写;预设「新上下文」时主 Agent 只拆自包含工单与验收)。
   两种方式下子 Agent 产出都不免检、都不做 git,门禁与证据完全相同;
   delivery_review 按人选定的范围交付；代码与文档无需按阶段拆分提交。
3. **只执行 current 输出内的流程动作**,不预判、不提前做;独立任务只执行 action 输出的动作。
   唯一例外是用户主动退出。
4. 流程顺序和必要人工决定照常执行；质量检查不再拥有否决权。模板、子 Agent
   生命周期、归档凭证、提交格式等缺失时如实记录，作为检视提示继续当前流程，
   不为内部手续重复询问、不伪造通过。真实权限、用户拒绝、交付内容变化和远端
   推送/流水线事实仍要核对。命令失败先区分文件/权限故障和质量提示，不循环猜命令。

5. 意图不明的输入(单个词、无单号无文档):先问用户想做什么,不要 init。
6. 中断恢复:直接 `current` 回断点,只读它给出的最小恢复清单
   (本地 Spec → Story → 未提交 diff → 最近编译/检视记录),不回放完整会话;
   交付阶段与产物看 `spec show`;确需人工修复用 `goto <step> --force` 并告知用户。

子 Agent 契约在 `agents/` 定义。Hook 只观察 started/returned/interrupted/timeout 生命周期;
返回文字是任意自然语言,不得因缺少标记、令牌或固定格式而拒绝、重答或重启;
interrupted/timeout 如实留痕,禁止无限自动重启。
被 gate 拦到写入时**禁止换工具硬绕**(Write 被拦就改 bash 是最坏反应):先
`python ".mae-flow-work/bin/mae-flow.py" doctor` 看权限与在建区;连续三次拦截会给出
用户放行令与跳过通道,把风险交用户裁决。
子 Agent 是协作建议，主会话可以承担产出；记录真实执行者，不伪造子 Agent 返回或质量结果。
