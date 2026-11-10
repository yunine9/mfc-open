# 单项用法

读取当前规划、使用契约和对应源码，用 everycode 分别检索并展开真实调用与单元测试。比较有不同前提的变体，核对接口支持、调用顺序、失败行为和资源责任。

有充分使用与测试依据时，按 [用法模板](../assets/templates/paradigm.md) 保存 kind=paradigm、status=recommended 的当前章节。need 对应开发者要完成的工作；content 使用固定的场景、步骤、约束小标题；interfaces、integration、example、unit_tests 分别保存接口、接入配置、完整使用代码和完整 UT Markdown。

推荐用法依照 [测试示例](unit-tests.md) 给出真实项目的 fixture/mock、断言和构建运行配置。example 采用正常接入 API，测试专用入口留在 unit_tests。实际读取的调用和测试分别写 usage_evidence、test_evidence。

推荐用法的完成条件是充分代码依据、完整接入与测试示例。其他研究问题留在 open_questions，replaces 只记录有明确适用条件的替代关系。

未找到足够调用或测试依据时，将当前项保存为 unverified：content 记录已确认事实、已搜索范围与缺失依据，open_questions 记录待核对问题；interfaces、integration、example、unit_tests 可显式留空，保留真实基础仓引用。用研究记录提交本项结果，不为填满模板补造接口或测试代码。unverified 与 legacy 仅保留在任务内，正式指南只采用完整的 recommended 用法。
