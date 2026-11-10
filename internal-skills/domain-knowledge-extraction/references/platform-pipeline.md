# 平台工具接口

平台执行当前选用的 Skill，展示过程、草稿和结果，再由用户一键创建或更新归档 MR。平台不认识本方法中的模块、链路分段、阶段编号或文档标题；这些约定由本包的 SKILL.md 和 phase 文件决定。替换方法包可以改变研究顺序、文档目录和正文结构。

## 输入与资料

上下文提供 mode、scope、repositories、archive_targets、materials、已有文档摘要及用户反馈。单模块验证的 probe.module 是本次研究范围；仅研究它，依赖按需核对，不扩展为全领域。验证模式中平台屏蔽源码仓所有 docs/、AGENTS.md 和配置文档目录，本次上传资料和无线豆包继续可用。

- extraction_skill：省略 path 查看包内文件，指定 path 读方法或模板；文件名由 Skill 自己定义。
- component_source：按仓编号 list/search/read 固定版本源码；按需定位构建文件和调用，不要求宿主预扫描所有仓。
- knowledge_structure：按需查看指定仓的构建单元和依赖候选，候选关系仍需读取源码核实。
- knowledge_source_check：检查代码引用的路径、行号、符号是否存在；评审时调用并处理错误。结论是否成立仍需阅读源码和业务资料判断。
- knowledge_material：读取上传资料及章节、图片。
- business_knowledge：调用无线豆包查询基站、网管等无线业务背景，用法见平台系统提示。
- knowledge_evidence：搜索和回读已保存的原始资料与查询结果。
- knowledge_source_changes：更新时比较已固定的旧、新源码版本。
- knowledge_draft：read 查看文档；save 保存草稿或修订建议。使用 archive_targets 中的 id 和 docs_path；讨论及只读步骤不能写文档，不能直接发布或采纳。

## 自行安排独立步骤

knowledge_work 的 action：

- list：分页查看步骤状态，start 指定起点。
- schedule：保存 steps 数组。每项有 id、title、instructions、depends_on、readonly；编号由 Skill 选择，依赖须在已保存或同批步骤中。instructions 写具体问题、范围、应读的本包文件、输入编号和预期结果。不能覆盖已有步骤，需要返工时新建编号并附反馈。
- run：指定 id，在全新的独立会话执行该步骤并等待结果。已完成步骤返回原结果；中断或失败步骤可再次执行。平台不自动生成后续任务。
- read：指定 id 读取步骤详情与结果。不指定 id 读取当前执行记录。只展开需要的结果，避免把全部材料重复注入上下文。
- discard：指定 id、reason，明确记录不再需要执行的步骤；依赖它的步骤仍需另行处理。
- legacy：查看升级前保留的研究进度和结果。先对照已有文档与通过项，再安排未完成工作，不从头覆盖人工稿。

主会话按 SKILL.md 的研究方法逐步安排任务。phase-inventory.md 等文件约定的 modules、subfeatures、hops、cross_items 都属于本 Skill 的数据格式，放在结果的 data 中；主会话读取后自行安排下一步，平台不会解释这些字段。平台并不要求每个 Skill 使用这些字段或独立步骤，简单任务可以直接保存文档。

## 保存结果与评审

每个会话用 knowledge_work_result 提交 summary、document_ids、可选 data。中间发现、证据编号、待确认问题、阶段结果均可放 data；文档编号须对应已经保存的草稿。不能只用普通回复表示完成。

本方法的独立评审使用 readonly=true 的步骤。按 phase-review.md 读取待评审文档及原始依据，返回 data: {pass: true/false, feedback: "具体意见"}。主会话据此决定补充、返工或继续；评审不会被平台自动插入。

主会话结束时 status=complete；需要用户查看或补充信息时 status=paused，并在 summary 说明原因。所有已安排步骤需完成或明确放弃后才能结束；不完整工作应保存暂停结果，不能伪报完成。暂停不会因服务重启自动通过，用户明确接续后 continued 才增加。

正文通过 knowledge_draft 保存，不把日志或工作计划当作文档正文。最终报告写 summary，文档结构由本包方法决定。知识入库、索引和 MR 合入状态以平台事实为准。
