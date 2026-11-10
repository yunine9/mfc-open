---
name: component-knowledge-extraction
description: 按已确认的组件与场景规划，依据源码和 everycode 真实调用及单元测试，编写、修订和独立评审一组件一份的完整使用指南。
---

# 组件使用指南萃取

围绕分析结果中的功能组件编写指南。文件操作、数据库操作、P2P 等是能力粒度的例子；同一能力可跨仓实现，参考仓和构建目录用于核对代码与接入条件。

把已经规划的开发场景独立萃取为确定可用的知识，平台按技术栈组合各功能组件的用法。指南依次是组件用途、接入配置、用法导航；每项用法依次是适用场景、关键接口、使用步骤、完整示例、单元测试示例、使用约束。常见误用仅在有确证条目时出现。

## 开始当前任务

先读 [平台协议](references/platform-pipeline.md) 和 [字段格式](references/schema.md)，再根据当前会话选择入口：

- mode 为 discuss、rework、update 或 supplement 时，先读 [保存与修订](references/draft-contract.md)，再按涉及的章节种类读取阶段规则。task.id 为 whole-review 或 supplement 时，phase=inventory 表示平台的修订任务，不是重新盘点模块。
- 常规萃取按阶段读 [契约](references/phase-contracts.md)、[用法](references/phase-paradigm.md)、[误用](references/phase-pitfalls.md)、[导航](references/phase-index.md) 或 [汇总](references/phase-synthesis.md)。
- 独立评审只读 [评审标准](references/phase-review.md) 及对应阶段规则。

通过 component_work 读取当前场景及依赖结果，再按 [研究方法](references/component.md) 和 [接口边界](references/api-boundary.md) 核对源码、真实调用、测试与构建配置。模块盘点和场景规划已由独立分析 Skill 完成，本会话围绕当前任务深入核对。

## 完成一项用法

1. 确认适用需求、受支持入口及真实接入配置。完成条件是接口、依赖、版本前提和调用顺序都有实际代码支持。
2. 用 everycode 查找调用与单元测试，展开相关函数、fixture、mock、断言、helper 和依赖。完成条件是能解释使用代码的正常行为，以及本场景适用的边界、失败、异步和清理行为；具体方法见 [测试示例](references/unit-tests.md)。
3. 按 [正文模板](assets/templates/paradigm.md) 保存当前章节。使用示例只写正常接入代码，单元测试写入独立 unit_tests 字段。完成条件是读者能依据指南建立调用和测试，无需回到当前会话寻找缺失步骤。
4. 用 component_work_result 提交结论、证据缺口和执行情况。缺失依据的结论留在结构化问题记录中，正式指南只采用已确认内容。

## 正文与研究记录

正文写组件名称、具体用途、真实 API、依赖配置、操作步骤、完整代码和确定的使用约束。证据编号、源码位置与版本、研究过程、问题和验证状态分别保存到结构化字段及任务结果；它们不属于使用指南。

核对代码、编写示例和实际运行测试是不同事实。只在确实执行后记录运行命令及结果；没有执行时在任务结果如实记录。对无法确认的用法保留 open_questions 和 unverified 状态，避免为凑齐正文补造 API、测试或推荐结论。

## 修订与反例

讨论、修订、增量更新和补充遗漏能力遵循 [保存与修订](references/draft-contract.md)，保留人工已确认的内容与稳定编号。

收到反例研究任务时，独立核对当前替代主张和原生 API 的合法使用条件，用证据说明找到的反例或当前检索结论。结果提交到任务记录；规则启用和正式知识发布仍由用户决定。
