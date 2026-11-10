# 变更：legacy-tasks-encoding

# 为什么

旧布局在途单的 tasks.md 若含非 UTF-8 字节（Windows 记事本 GBK 另存是高频来源），
specengine 的 legacy 读取分支只捕获 OSError，UnicodeDecodeError 会穿透——
spec show / archive 直接 traceback，违背核心原则（流畅易用，不能因证据卡死）。
v5 路径（change.md 坏编码）已在 v5 单收口，本单补齐 legacy 对称面。
目标：引擎收口为带 UTF-8 指引的 SpecEngineError；非目标：不改计数正则语义、
不动 CLI 宽容展示语义（archive 任务计数 try/catch 静默与上游 CLI 一致）。

# 规格条目：evidence

## ADDED Requirements

### Requirement: Legacy tasks source encoding resilience
The system SHALL surface a readable UTF-8 remediation error instead of a raw
traceback when the legacy tasks.md of a change is not valid UTF-8.

#### Scenario: Corrupt legacy tasks.md rejected with guidance
- **WHEN** a legacy-layout change's tasks.md contains non-UTF-8 bytes
- **THEN** engine task-source reads raise a spec engine error mentioning UTF-8
- **AND** done evidence reports a retryable rejection instead of crashing

#### Scenario: Archive task counting stays tolerant
- **WHEN** archiving a legacy change whose tasks.md is not valid UTF-8
- **THEN** the task progress counter SHALL degrade to zero counts without failing the archive

# 实现清单

- [x] 1. specengine.tasks_source legacy 分支：UnicodeDecodeError 收口为 SpecEngineError（带 UTF-8 指引）
- [x] 2. specengine._count_tasks legacy 分支：捕获 (OSError, UnicodeDecodeError) 保持宽容 0/0
- [x] 3. test_specengine 新增 legacy 坏编码两用例（tasks_source 报错含 UTF-8；_count_tasks 宽容）
