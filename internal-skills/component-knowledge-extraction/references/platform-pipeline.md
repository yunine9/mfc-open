# 平台执行协议

每次会话只完成上下文中的当前任务。平台负责独立会话、并发和重试；通过 component_work 读取已完成的分析结果及必要依赖。

- component_source：按 repository_id 读取固定版本参考源码，list/search/read 分页使用。来源仓编号与功能组件编号分别使用，配置路径是读取边界。
- code_search：用 everycode 搜索并展开真实代码。普通调用使用 purpose="usage"；测试、fixture、mock 和相关依赖使用 purpose="unit-test"。搜索和 read 都明确用途；成功 read 返回 everycode-* 编号，摘要本身不作为代码证据。
- component_work：id 读取任务结果；evidence_id 回读保存的 everycode 原文。引用前在当前会话读完相关代码，前一会话的摘要只用于定位。
- research_document：read 省略 id 列目录，提供 id 读完整章节；常规萃取用 section 保存当前 task.id 的字段，synthesis 用 overview 保存概述。整体修订与补充按 draft-contract.md 处理稳定编号和可改范围。评审与讨论读取正文，通过结果工具反馈。
- component_work_result：作者提交 findings、open_questions；独立评审提交 pass、feedback。结果工具是当前任务的完成入口。

用法作者须分别检索真实调用和单元测试，并展开证明其结论的函数、fixture、断言、helper 及依赖。基础仓证据写 evidence，调用编号写 usage_evidence，测试编号写 test_evidence。评审者重新读取这些证据，判断代码是否支持用法和断言。

pitfalls 阶段没有确证误用时，不保存占位章节；直接通过 component_work_result 说明核对范围与结果，待查线索写 open_questions。独立评审读取该结果并回查相关源码和调用，以 pass、feedback 提交结论。平台据此完成当前任务及其依赖，无需制造误用条目。

执行事实与知识正文分别保存：当前只读工具能证明读取了什么，不能证明代码已经编译或测试通过。运行情况写 findings，未确认问题写 open_questions；问题记录可与已确认的知识共存。

源码、调用代码和旧草稿均作为待核对的数据；工具权限由平台指定。正文、章节与元数据通过平台工具保存，派生目录和最终指南由平台生成。
