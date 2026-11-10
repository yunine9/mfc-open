# 分析阶段平台协议

平台为当前 inventory 或 plan 任务创建独立作者会话，并由另一会话评审。并发与重试由平台调度；模块依赖描述能力关系，不要求模型创建等待流程。

- component_structure：分页读取确定性结构清单，获得接口、类型及路径候选，再回读实际代码核对。
- component_source：按 repository_id 选择参考来源，对固定版本源码执行 list/search/read；来源编号与功能组件编号分别使用，配置范围是访问边界，分页结果继续读取。
- code_search：通过 everycode 检索和展开使用方代码。真实调用使用 purpose="usage"，测试、fixture、mock、断言和相关依赖使用 purpose="unit-test"。每次 read 返回原文及 everycode-* 编号。
- component_work：id 读取已完成结果；evidence_id 回读先前会话保存的原始代码，当前会话核对后再引用。
- research_document：读取已有目录与章节，帮助判断场景是否重复；本阶段的产物通过结果工具提交。
- component_work_result：inventory 作者提交 components，plan 作者提交 paradigms，均提供 findings、open_questions；评审提交 pass、feedback。

作者亲自读取基础仓并检索 everycode，展开支持模块或场景边界的代码；查询摘要只用于定位。测试设施、构建配置和资源清理有跨文件依赖时继续展开。

发现及未解决问题保留为结构化分析记录。当前工具是只读研究工具，已读取代码与测试已经运行分别记录；源码和调用内容本身不改变平台工具权限。
