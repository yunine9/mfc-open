# Review

Review is advisory evidence. Read the relevant Spec or Story, current code, and exact change before judging it.

- Verify the review claim against code and requirements before changing code. Clarify or reject an unsupported finding with technical evidence.
- Trace a confirmed defect to its root cause. Prefer the smallest correction that restores the approved behavior without unrelated cleanup.
- Review correctness, boundary behavior, dependency direction, reuse, naming, ownership, error handling, lifetime, concurrency, compatibility, and the planned test seam.
- Separate objective defects from valid design tradeoffs. Only a real unresolved tradeoff needs user judgment.

For final conformance, compare the final implementation and final diff with the confirmed Spec and confirmed Story:

- Completeness: required observable behaviors have implementation and coverage evidence.
- Correctness: behavior and accepted scenarios match the confirmed WHAT.
- Coherence: code structure and dependencies follow the reviewed design decisions, or an explicit deviation is surfaced.

The Design Reviewer runs exactly once per Full Story. When selected, the CODE Reviewer runs once before human review for a full review of the complete change plus direct integration boundaries. Accepted fixes do not restart a full CODE review. Focused design-to-implementation follow-up checks the original findings and repair impact using the protocol below.

Run an integration review only for cross-module coupling, shared state, interface change, or late design change. This choice is based on semantic risk, not file or line count.

## 设计与实现一致性检视

### 主 Agent 的组织方式

1. 本次实现与已有定向验证完成后，用现有通用子 Agent 独立检视相关设计。首审与定向复查均用 `subagent_type: design-consistency-review`，供交付报告识别本次设计检视意见。派发时设置 `read_only: true`、`timeout_seconds: 180`，需要更多时间时按任务剩余预算调整。遵守用户对检视的启停和范围决定，没有可核对的设计时说明缺口，继续既有流程。将下方“检视子 Agent 提示”全文及本轮输入放进派发任务说明，不使用已退役的 CODE 任务卡。
2. 首审输入包含相关 Story 的图与正文、用户最新确认的调整、实际 diff 正文或可读文件路径、直接集成范围、必要源码位置和已有验证结果；只给 Git 提交范围不够，只读检视者不执行 Git 命令。检视期间主 Agent 暂停修改同一代码现场；若本轮还有工程质量意见，一并汇总后集中处理，不按五个视角分别派 Agent。
3. 主 Agent 亲自核实意见并合并同根因问题。原需求范围内的明确缺陷直接修复并做定向验证；误报给出代码或设计依据。改变已确认行为或设计、接受风险或存在真实分歧时才交用户决定。已确认的设计调整可同步到 Story；不得改写预期来迁就错误实现。
4. 有修复或澄清需要核对时，用同一提示派发定向复查，携带旧问题、逐项处理理由、相关修复差异、必要源码及实际验证结果。复查只看旧问题和受影响范围，不重新做完整审查。新的子会话不会自动记得上一轮，相关上下文必须随任务说明提供；结果和理由保留在既有任务记录中。
5. 确认的问题已得到代码或验证证据支持的解决，就进入既有人工检视。同一意见反复出现且没有新依据、无法补齐关键证据或没有可执行的修法时，停止自动循环，保留未决事实和影响交责任人判断。遵守已有执行预算及用户停止、接管指令，不新增修复轮数、定时唤醒或审批条件。
6. 子 Agent 失败、取消或未返回有效结果时如实记录未完成，不自动反复重派。检视未完成或结论未通过不新增 done、推送或合入的阻断条件，沿既有流程继续并展示缺口；停止循环不表示问题已解决。不得用固定返回字样、审查收据、图数或额外确认证明质量通过。

### 检视子 Agent 提示

你是独立的设计与实现一致性检视者，只读本次设计、改动、相关源码和已有验证记录。你不修改文件、不运行测试或构建、不做 Git 写操作、不向用户提问，也不再派子 Agent；需要修改或补验证时说明依据，交主 Agent 处理。

- 依据用户最新确认的决定和相关 Story，核对本次涉及的 4+1：模块职责、接口与依赖、运行交互、部署关系、业务场景与实现是否一致。沿关键入口追到直接调用方及异常分支，不扩成全仓审计，不补造设计或重画整套图。
- 首审覆盖本次相关设计与实现；复查逐项核对旧问题的处理、修复代码和实际验证结果，并检查修复影响。新增问题须说明与原检视范围或本次修复的关系，不把无关建议加入本轮。
- 只报告有设计及代码依据、影响行为或边界的偏离，每项说明设计原文、实现位置、实际影响和最小修改建议。旧设计与最新明确决定冲突时按新决定判断，区分文档待同步与实现缺陷；图形布局或命名差异本身不算实现缺陷。
- 源码可确认的关系可以核对；并发效果、真实部署或外部系统行为需要相应运行证据，缺失时写未确认，不凭测试名称、整体绿灯或主 Agent 自述宣称已验证。材料不足时说明缺什么及其影响。
- 返回简洁的自然语言结果。首审说明发现的问题与未确认项；复查逐项说明已解决、仍存在、依据核实无需修改或证据不足，并引用本次读到的证据。没有发现偏离只代表本次检查范围内未发现，不代替测试、人审或发布授权。
