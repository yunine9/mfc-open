# 平台执行与交付约定

本包是随平台代码发版的内置领域萃取方法，在方法阅读页查看；维护本方法时修改仓库中的本包并随代码交付，不通过任务会话上传或替换方法。任务仍执行其固定版本，运行中任务不会因仓库文件修改而切换。业务资料上传属于来源输入，和方法维护不同。

本页的工具、来源、路径、版本和权限约定适用于所有模式。完整 current-plan、全量文稿清单、规划核查与全套产物验收用于首次 extract；mode=revise 时按本轮 business-docs-reviser 方法维护意见台账和受影响清单，新增或移除关联文稿也不要求重建原全量生成规划。

原模板中的多仓图用于说明逻辑关系；源码只读，文稿由平台保存到各自目标仓。包内文件用 extraction_skill 读取，工具参数以本轮实际定义为准。写作与评审均读取 [共同质量要求](document-quality.md)。

## 工具与原工作方式的对应

| 工作 | 平台操作 | 读到或保存什么 |
|------|----------|---------------|
| 读取提示词和模板 | extraction_skill，指定包内 path | 本次固定版本的完整 Markdown |
| 识别仓 | 上下文 repositories；knowledge_structure 不填 repository_id | 本次来源仓与用户限定范围 |
| 定位本业务目录与入口 | component_source list/search/read | 从浅层目录和业务线索定位，再读取相关入口及必要依赖 |
| 查看全仓构建候选 | knowledge_structure 指定 repository_id | 会解析该仓完整构建结构，不按业务目录限制；仅在确需全仓构建信息时使用 |
| 查看跨仓构建候选 | knowledge_structure 同时填 repository_id 与 include_dependencies=true | 会扫描全部关联仓；适用条件按源码研究范围方法，公共仓优先追踪具体调用 |
| 搜索和通读源码 | component_source search/read，指定 repository_id | 固定版本文件、实际返回的行号 |
| 保存 current-plan.md | knowledge_work save_document，id=current-plan | 完整规划过程文稿，不进入知识发布 |
| 登记完整输出清单 | knowledge_work plan，document_ids 与 work_document_id | 全部预期文稿编号，关联已保存规划正文 |
| 分页读取输出清单 | knowledge_work read_plan，start/limit | document_ids 分页、total、next_start 与排除说明 |
| 读取规划 | knowledge_work read_document，id=current-plan | 完整规划正文；不支持章节读取，本项必要字段由 step.instructions 提供 |
| 保存知识文稿 | knowledge_draft save | 指定目标中的草稿或修订建议 |
| 读已生成的文稿 | knowledge_draft read，指定 id | 当前正文、sources 与 revision |
| 定位检视意见涉及的文稿 | knowledge_draft search，query 或 keywords，start/limit | 本任务当前候选的匹配编号与有界摘录；按编号回读相关正文 |
| 读取集中提交的检视意见 | 本轮提供时用 knowledge_review_notes list/read | list 默认20条、最多50条，沿 next_start 读完本批摘要；read 按原意见 id 取完整意见、引用和上下文 |
| 独立分析、写作和核查 | 主会话 knowledge_work schedule/run | 独立上下文与持久结果 |
| 校验源码引用 | component_source read；全仓场景按研究范围方法使用 knowledge_source_check | 核对相关路径、行号与符号，结论仍需阅读源码；后者会扫描全部关联仓 |
| 校验 PlantUML | knowledge_diagram_check，document_id 或 work_document_id 二选一，可选 start/limit | 知识文稿或过程稿当前正文的真实渲染报告、图位置及错误；不判定业务语义 |
| 取得业务依据 | knowledge_material、business_knowledge、knowledge_evidence | 按 [来源方法](business-sources.md) 读取上传资料和无线背景，保存可回读的位置及适用范围 |

本平台不提供工作目录写文件、Shell 或 codebase_graph_explore。追踪调用链时用源码中的真实方法名继续 search/read，逐跳读入口、实现、参数、返回处理和异常分支。子步骤不再安排子步骤，文稿独立评审通过写作步骤的 review 配置执行。

## 保持有界上下文

knowledge_work read 不带 id 只返回进度摘要与 plan 数量，不返回全部工作正文。需要具体结果时 read 指定步骤 id；完整计划编号用 read_plan 按 next_start 继续分页，排除说明也有自己的分页。knowledge_work list、read_document 不带 id，以及 knowledge_draft read 不带 id 均返回分页摘要，start 从 0 开始，limit 默认 30、最多 100；返回 next_start 时继续到末页，不能将第一页当作全部文稿。

主会话只保留范围、清单、短摘要和结果/证据编号。每个调查、写作或评审单元只接收自己的范围、方法入口与证据索引；开始时按 id 读取必要结果，并重新打开本项原始源码或资料。资料摘要中的章节/文档/图片/警告数量不是正文；已有相关资料编号与位置时直接读取，不要求每个单元重新列出全任务资料。业务来源的 data.source_index 与恢复方式见 [来源方法](business-sources.md#来源索引与独立会话交接)。共享结果是定位线索，不代替当前单元的原始依据。可写步骤需要保存过程文稿时，id 使用 `步骤编号--名称`；current-plan 由主会话维护。只读步骤将发现保存到自身 knowledge_work_result，不写过程文稿。

## 读取必须覆盖真实范围

component_source list/read 的 start/end 从 1 开始：list 默认当前目录层，recursive=true 才递归；read 用实际完整文件路径及行范围。收到续读或截断提示时从实际返回位置继续读取相关范围，默认首段不是全文。search 按每个仓执行，keywords 是多个字面词的任意命中，query 是完整字面短语，二者不作正则；搜索截断时缩小到具体目录或关键词，不假定 search 有列表分页参数。完整路径来自 list/search，不能只凭文件名猜测。沿每个功能入口读到实际处理终点，再核对定时任务、事件和配置分支。

公共仓或业务仅在部分目录时，按 [研究范围与范围纠正](research-scope.md) 用 component_source list/search/read 定位和核实相关代码。knowledge_structure 的 start/limit 只控制结果分页，不能限制其解析的源码范围；公共仓的目录调查不以该工具枚举全仓构建单元。

按研究范围方法确需 knowledge_structure 时，指定 repository_id，start 从 0 开始，按返回的 next_start 继续；目录、构建文件、构建单元和依赖候选各有数量及分页信息。带 *_preview 的字段只是预览，preview_complete=false 或 dependency_truncated=true 时按 source/from 读取与本业务相关的构建文件，不把预览当作全部依赖。include_dependencies=true 会扫描全部关联仓；默认单仓读取不能证明没有跨仓关系，公共仓可通过具体接口与调用双方核实关系。

knowledge_structure 只提供静态候选，不能据此断言没有跨仓关系。接口与调用双方、数据模型、状态变化和关键配置要回到源码确认。首次阅读记录文件与行范围；独立评审打开这些原文件，不能只看作者的摘要或路径清单。

## 规划与路径

规划使用 prompts/plan-template.md 的完整结构。正文清单记录全部预期产物；执行关联表把每项绑定到稳定 document_id、目标仓、写作步骤及最近通过的评审版本。保存正文后用 plan 操作登记全部文稿编号，宿主据此核对漏排或漏生成的文稿。步骤状态以 knowledge_work 实际记录为准，不能只修改规划表就声称完成。

先核对 module_id、scope、knowledge_layout 与 archive_targets；关联仓是源码来源，不代表本任务拥有整个仓的业务或公共文档。浅层盘点定位本业务入口后，仅深入本业务及解释完整链路所需的共享实现。其他业务作为有依据的边界或依赖记录，不为它们生成整套知识。模板中的“模块文档”按本业务内部功能划分，与稳定的 module_id 不是同一层级。

knowledge_layout 为 directory-v1 时，每个目标的 target.docs_path 是最终仓根相对目录。领域知识仓及正式分支由平台统一提供，业务模块只保存仓内路径，默认 `Function_Knowledge/Access Function/<模块名>`；读取和后续 MR 写入使用同一路径。新任务固定创建时的位置，运行中修改模块配置不改写已有任务。代码仓使用 `docs/` 下的业务目录。创建 MR 时平台展示目录和文件预览，Agent 直接使用平台当前返回的实际路径，不重新拼接模块名称或编号。

document.path 填目标仓根下的完整相对路径。例如 target.docs_path=`docs/产品管理` 时，入口是 `docs/产品管理/README.md`，索引是 `docs/产品管理/index.md`；代码仓的模块地图是 `docs/产品管理/module-map.md`。已包含该目录的 path 不再加一次 docs_path，工作区仓名不进入 path。领域与仓级知识分别保存到自己的 target_id，所有本任务文稿都收在各自的最终目录内。

module_id 只用于工具元数据中的业务归属；标题、导航标签和范围说明使用平台提供的业务名称。名称缺失时说明“业务名称未提供”，目录继续采用平台保存值。源码、日志或接口证据中的真实 ID 保持原样，不对正文执行全局 ID 替换。

下表用 D 表示领域 target.docs_path、R 表示相应代码仓 target.docs_path。保存时换成完整实际路径；模板文件名只用于选择写作方法。

| 模板 | 目标与 path |
|------|-------------|
| domain/root-agents.md | 领域目标，D/README.md：本业务领域入口 |
| domain/domain-agents.md | 领域目标，D/index.md：详细索引与维护说明 |
| 其他 domain/ 模板 | 领域目标，D/glossary.md、D/architecture.md、D/domains/、D/interfaces/、D/external/ 下实际文件 |
| repo/repo-agents.md | 对应代码仓目标，R/README.md：本业务在该仓的职责、命令与路由 |
| repo/module-map.md | 对应代码仓目标，R/module-map.md：本业务功能索引 |
| 其他 repo/ 模板 | 对应代码仓目标，R/rules/、R/modules/ 下实际文件；真实经验在对应功能的 experience/ 下 |

目标文件已被其他文稿占用时，平台添加稳定文稿 ID 后缀，必要时再加序号，并修正文稿间链接。沿用保存返回的实际 path 和可读导航，不改回重名文件或覆盖其他文稿。不同业务默认使用各自的可读目录，共仓不扩大本任务范围。

AGENTS.md 由平台按本次提交的文稿及仓内已有入口生成，不属于模型的 plan、expected_document_ids 或草稿。代码仓保留唯一根 AGENTS.md，提供各业务目录的统一导航；领域知识仓在领域 target.docs_path 内生成 AGENTS.md，导航只覆盖该目录。模型生成同目录 README.md、index.md 等普通文稿。平台生成的入口只提供可读路由、读取范围与维护约定，不写机器标记或复制业务正文。

已有 module-v1、repository-v1 或 legacy 任务接续时，Agent 使用当前保存的文稿位置及固定 Skill。提交 MR 前平台整理路径和相对链接，保留正文、编号、调查与历史，不调用模型重新研究。候选提交不会直接改变知识库；合入后才从正式分支同步。从旧 AGENTS.md 整理出的业务内容成为普通文稿，仅在其声明的业务范围内使用。历史 current-plan 和步骤结果保留原记录，后续研究以当前保存位置为准。

任务可以直接将当前候选提交 MR，无需先确认发布到平台。未合入时可在原任务开始检视并继续修订，平台更新原分支和 MR；正式知识库开始检视则创建新任务，固定远端文稿基线，结束检视后才调用修订 Agent。原任务 MR 已合入时，从正式知识库发起下一次检视，避免使用旧产物覆盖后续更新。已有失败批次按冻结文稿、目标路径和布局恢复，保留原推送和 MR 记录。Agent 完成候选与评审后结束，不等待合入，不自行关闭 MR 或删除分支。

同仓链接按文稿实际所在位置计算相对路径；跨仓引用明确写出仓名和包含 docs_path 的仓内路径，已知真实仓链接时可附链接。仓名只是跨仓定位，不是知识仓内真实存在的目录。全部路径占位符在产物中替换为实际值。

完整 current-plan 保存格式：

```json
{"action":"save_document","document":{"id":"current-plan","title":"文档生成规划","content":"完整 Markdown 规划正文"}}
```

随后登记完整清单，示例中的 document_ids 必须替换为本次全部规划文稿编号，不能只列最先生成的几篇：

登记前以 knowledge_diagram_check({work_document_id:"current-plan"}) 读取当前规划的全部图表报告；invalid 修正后保存/重查，unavailable 保留已保存规划并报告依赖问题。plan 登记和最终 complete 时宿主还会核对该过程稿，不需要另建知识文稿来校验。

```json
{"action":"plan","work_document_id":"current-plan","document_ids":["domain-readme","domain-index","glossary","architecture","import-domain"]}
```

新增文稿时先更新规划正文，再用 plan 提交包含原清单与新增编号的完整集合。确实不适用的原条目，通过 exclusions: [{document_id, reason}] 说明源码证据或用户范围变更，正文同步保留排除理由；不得以困难、失败或篇幅为由删掉必需产物。discard 只处理不再执行的步骤，不替代计划排除说明。

## 独立调查

主会话先看仓列表、浅层目录及与业务线索相关的入口、构建文件以划分工作，不在分工前通读全仓业务实现。公共仓调查按本业务目录/入口拆分，不能把“负责该仓”解释为调查该仓全部业务。多仓与大规模源码按业务入口和完整场景拆成只读调查单元；每个单元有独立 instructions、实际源码范围、相关资料编号/来源索引与具体问题。调查按来源方法回读相关资料，需要理解无线概念时先复用已有背景原文再补查。以下示例中的仓编号、路径及方法名应先用本次浅层盘点结果替换，不能把示例当成真实来源：

```json
{
  "action": "schedule",
  "steps": [
    {
      "id": "research-import-api",
      "title": "调查导入服务的业务入口与源码范围",
      "instructions": "按 prompts/plan.md 调查 repository_id=repo-api。已盘点入口 src/import/ImportController.java，构建 pom.xml。完整识别导入相关公开入口、定时任务和事件处理，沿调用读取实现、状态、配置与外部交互；区分单条与批量场景，返回各场景涉及文件/符号/行范围、下游仓及尚未确认的问题。这里只保存调查结果，不写知识文稿。用 knowledge_work_result 提交简短 summary、document_ids=[]，data 中保存范围、场景和证据索引；不复制源码全文。",
      "depends_on": [],
      "readonly": true
    },
    {
      "id": "research-import-worker",
      "title": "调查导入执行仓的业务入口与源码范围",
      "instructions": "按 prompts/plan.md 调查 repository_id=repo-worker。已盘点入口 src/import/ImportWorker.cpp，构建 CMakeLists.txt。从任务与消息入口追踪导入执行、结果返回、状态变化、存储和清理，识别全部相关场景及外部系统。独立回读原始代码，不等候另一仓的摘要。用 knowledge_work_result 提交简短 summary、document_ids=[]，data 中保存范围、场景、文件/符号/行范围及待核实跨仓调用；不复制源码全文。",
      "depends_on": [],
      "readonly": true
    }
  ]
}
```

```json
{"action":"run","concurrency":3}
```

每个调查会话在自身上下文使用实际源码工具完成读取，再通过 knowledge_work_result 保存结果。下面仅说明结果结构，字段值必须来自实际读取：

```json
{
  "summary": "已识别导入服务的单条与批量入口；批量结果如何通知调用方仍需核对执行仓。",
  "document_ids": [],
  "data": {
    "scope": {"repository_id":"repo-api","paths":["src/import/"]},
    "scenarios": [{"name":"批量导入","entry":"ImportController.importBatch","evidence_ids":["api-batch-entry"]}],
    "evidence_index": [{"id":"api-batch-entry","repository_id":"repo-api","path":"src/import/ImportController.java","symbol":"importBatch","start_line":40,"end_line":86,"finding":"入口与参数构造，行号须替换为实际返回位置"}],
    "open_questions": ["核对执行仓的完成事件与服务仓消费入口是否对应"]
  }
}
```

summary/data 随步骤结果持久保存；只读单元不能调用 save_document。涉及上传资料或无线背景时，在上述 data 中增加来源方法定义的 source_index、source_gaps 和 source_conflicts；它们与源码 evidence_index 分工，不把通用背景列为实现依据。步骤列表和默认工作摘要不带 data，主会话按 id 读取必要结果，只保留短摘要与引用，不把每份源码或完整发现附加到自己的长期上下文。需要继续核实的跨仓链路可单独登记只读步骤，depends_on 列出双方调查编号，instructions 只传待核实场景和证据索引；该步骤仍要打开调用两端原始代码。单元及后续写作开始时重新读取自身依据；无依赖单元并行，真实依赖先完成，本包不启动外部编排程序。

## 规划核查

区分两个位置的 review：

| 字段 | 谁填写、何时填写 | 含义 |
|------|------------------|------|
| knowledge_work schedule 中的 step.review.instructions | 主会话登记知识文稿步骤时 | 平台在本步提交文稿后另启独立会话，评审指定的知识文稿 |
| knowledge_work_result.review: {pass, feedback} | 当前核查/评审会话返回结果时 | 本次核查是否通过及具体依据；不会再启动一次评审 |

规划 current-plan 是过程文稿。主会话安排 readonly=true 的独立核查，省略 expected_document_ids 与 step.review；instructions 指向 current-plan、prompts/plan.md、prompts/plan-template.md 与调查结果索引。核查读取 read_plan 全部清单/排除分页、knowledge_diagram_check({work_document_id:"current-plan"}) 当前报告及真实入口，核对正文对应和全部适用产物。大范围可分仓或业务域核查。

下面是一对首次登记与子会话返回的示例。登记前规划已保存、相关调查已完成；有前序依赖时填实际步骤编号。已有核查步骤中断时按原编号 run，不为接续重新登记它。

主会话调用 knowledge_work：

```json
{
  "action": "schedule",
  "steps": [{
    "id": "review-plan",
    "title": "独立核查当前文档规划",
    "instructions": "按 prompts/verify-doc.md 的规划核查部分读取 current-plan、完整 read_plan 清单、当前过程稿图表报告及相关调查索引，回查业务入口与适用资料，判断覆盖是否完整。用 knowledge_work_result 返回 summary、document_ids=[]、work_document_ids=[current-plan] 和 review:{pass,feedback}；具体来源缺口放 data。这里只核查规划，不生成知识文稿。",
    "depends_on": [],
    "readonly": true
  }]
}
```

核查子会话调用 knowledge_work_result，反馈内容替换为实际发现：

```json
{
  "summary": "规划核查已完成；定时触发场景仍缺少对应文稿。",
  "document_ids": [],
  "work_document_ids": ["current-plan"],
  "review": {
    "pass": false,
    "feedback": "在实际入口及调查结果中发现的定时场景尚未对应到规划条目。请按所附原始位置补充场景与文稿清单，再核查受影响范围。"
  },
  "data": {"missing_scope": "实际遗漏范围及源码/资料位置"}
}
```

pass=false、图校验 invalid/unavailable 或来源缺口都是可以提交的核查结论，不需要生成知识文稿来提交，也不传 status=paused。没有问题时返回 pass=true 并说明实际核查范围。document_ids 保持空数组，过程稿仅放 work_document_ids；已有知识文稿的真正复核则走下一节的知识文稿步骤。

普通只读步骤的 done 只表示已提交结果，不等于结果的 review.pass=true。主会话读取各项结论并处理遗漏；规划实质修订后的新一轮核查使用新编号，中断或执行配置修正则接续原步骤。没有新证据或修订时不反复重建相同核查。仍有未调查范围或来源失败时不能宣布规划已穷尽。

## 每篇写作与评审

将规划中的每篇文档登记为带评审的步骤，说明具体范围和方法入口。示例：

```json
{
  "action": "schedule",
  "steps": [{
    "id": "write-import-domain-1",
    "title": "生成数据导入业务域文稿",
    "instructions": "本规划条目 import-domain：目标 domain，路径为该目标实际 docs_path 下的 domains/import.md（登记时替换为完整仓内路径），layer=domain，范围为本次 module_id 在 repo-api 与 repo-worker 的数据导入业务。按 prompts/generate-domain.md 和 templates/domain/domain.md 处理，读取 research-import-api、research-import-worker 的结果索引，重新打开两端真实入口、实现和配置，逐实际场景写作并保存完整候选。需要核对其他规划条目时再读 current-plan。",
    "depends_on": ["research-import-api", "research-import-worker"],
    "readonly": false,
    "expected_document_ids": ["import-domain"],
    "review": {
      "instructions": "按 prompts/verify-doc.md 对 templates/domain/domain.md 的专项规则评审。knowledge_draft read 文稿 import-domain，knowledge_diagram_check 读取当前完整图表报告，回读 sources 和本项调查索引指向的各仓源码及资料，逐场景核对真实调用、分支、状态、容量与清理策略，返回 review.pass 与具体 feedback。"
    }
  }]
}
```

示例中的业务、范围和路径由实际规划替换。instructions 带具体源码范围与待验证问题，不能只写“生成文档”或“核对质量”。依赖填确实需要先完成的步骤编号，编号与说明保存后不再改写。

对已经保存的知识文稿作只读复核，也可以登记 readonly=true、expected_document_ids=[实际知识文稿编号] 和 step.review.instructions。该步骤读取并返回已有文稿编号，由平台启动独立评审；反馈需要改稿时交回主会话安排可写步骤，保持当前只读权限。这与不产生知识文稿的规划核查不同，current-plan 不能填入 expected_document_ids。

登记完整清单后 knowledge_work 的 run 操作省略 id，本方法默认 concurrency=3，也可指定 1～4；填 id 则只运行该步骤。只有依赖满足且 expected_document_ids 写入集合不交叉的步骤才能并行，未声明写入范围的可写步骤串行执行。每篇候选保存后，宿主先做真实图表校验，再按 step.review.instructions 开只读会话；具体错误携带反馈修订，最多自动三轮。图校验 unavailable 保留候选、中断本项且不消耗修订次数，主会话继续其他独立工作后报告阻碍。

首次 extract 写作只修改 expected_document_ids 内的文稿。需要修改关联导航或发现新产物时交回主会话登记。revise 中该清单是初始分工，实际关联修改按修订方法协调，平台记录实际写入并全部交独立评审。需要读取其他步骤正在生成的文稿时等待其完成，并将对方写作步骤列入 depends_on；不能靠碰巧先执行来代替真实依赖。文档类型列表表示阅读层级，不要求把不相关文稿排成串行链。

最终导航同步单独登记带 review 的步骤，也可在相关文稿完成后直接首次生成最终导航，不要求先生成空初稿。directory-v1 布局下，领域 target.docs_path 内的 README.md 与 index.md 等待本业务全部实际路由目标；领域入口引用各仓业务 README.md 时也等待这些目标。代码仓 target.docs_path 内的 README.md 与 module-map.md 等待本业务在该仓的功能/规范文稿。平台生成的 AGENTS.md 不属于导航步骤的写入范围。旧任务按当前保存的实际文稿路径同步。depends_on 使用外部前序文稿的写作及最后修订步骤；已有导航初稿时还需等待初稿。

同一步同时写的导航文稿列入 expected_document_ids，不互相声明步骤依赖；相互引用的导航也不能排成循环，可合在一个明确写范围的同步步骤或由一次后续核查处理。只填导航的上次写作编号不足以保证路由目标完成。评审逐一回读全部改动导航及实际目标，核对路径、章节和覆盖。不同仓导航可并行；后续变化影响导航时再安排相关同步并复核。

写作者在 knowledge_draft save 后对每份候选调用 knowledge_diagram_check：参数 document_id，start 从 0 开始、limit 默认 10 且最多 20。读取 status、fingerprint、total、checked、diagrams，按 next_start 继续；各图 index 从 1 开始，line 定位正文，error 给实际诊断。invalid 修正后保存并重查当前版本；unavailable 记录依赖问题而不是删图或编造通过。按需读取 [PlantUML 指南](plantuml.md)，优先简单自包含写法，合法语法交给实际解析器判断；渲染器不访问文件或 URL 资源。

评审会话逐一 knowledge_draft read 全部 expected_document_ids，调用 knowledge_diagram_check 读取当前校验报告，并核对原始业务依据，再提交：

```json
{
  "summary": "已核对数据导入文稿，批量场景缺少错误传播说明",
  "document_ids": ["import-domain"],
  "review": {
    "pass": false,
    "feedback": "场景列表已列批量导入，但对应时序图缺少服务返回部分失败后上游的处理。回读批量实现和调用方，补充实际分支及引用后复核。"
  }
}
```

pass=true 时也简述实际检查范围及非阻塞未知；pass=false 时写具体位置、证据、影响与所需修订。工具调用成功、正文已保存、路径存在均不单独代表评审通过。候选随时保留，便于排查和恢复。

## 文稿与证据

knowledge_draft save 的 document 包含 id、title、target_id、path、layer、content、sources。领域层 layer=domain，仓级 layer=repository；sources 是字符串，不传对象或数组。content 是完整知识正文，sources 记录实际读取的仓编号、revision、文件/行范围、资料编号、章节和结论对应关系；执行过程留在工作记录。

正文按原模板保留必要的代码位置。提交 knowledge_source_check 时使用工具支持的 `仓编号:文件路径:起始行-末行` 或 `仓编号:文件路径#符号`，通过不代表结论正确。业务意图缺证据时明确未知，不把行业背景或代码推断写成历史决策。

修订保持稳定文稿编号。重读人工修改、最新用户检视意见及已有建议，按平台反馈产生可比较的建议，不绕过采纳流程。仅记录可证实的排查经验。

用户通过检视意见纠正公共仓范围时，按 [研究范围与范围纠正](research-scope.md) 在原任务处理受影响文稿：先复用已有正文和证据，只补查有争议的入口/调用；删除或收紧无关业务描述，保留真实共享依赖，并同步受影响的导航。当前用户要求优先于历史规划；必要时以范围变更理由调整对应规划条目，不重新执行整套调查、未受影响文稿或全套规划核查。仅因范围纠正不更换固定 Skill 版本、不重建任务；本轮通过标准只适用于实际修订范围。

## 恢复与完成

恢复时先用 knowledge_work read 取摘要，分页 list/read_plan，按步骤 id 读候选、结果与反馈，再按知识文稿 id 核对正文和版本；需要核对范围时读取 current-plan。done 的通过结果仅在对应正文未变化时复用，run 会重新核对版本。失败步骤在剩余预算内按原编号重试，实质新调查结论或工作说明改变时才创建新编号并记录替代关系。执行配置修正仍保留原步骤、依赖、调查和文稿；恢复不要求更换 Skill 版本或重做已完成工作。达到三轮上限且无新进展时保留阻碍，不靠换编号重复同一工作。discard 只适用于已有替代安排或确实超出本轮范围的步骤，不能用它消除未通过的必需文稿。

独立会话不能安排下一步或自行切换任务范围。调查返回明确未核实范围，规划核查用结果的 review.pass=false 表达缺口；写作保存已核实内容并在 summary/data 写出具体缺口，由独立评审判断能否通过。子会话正常结果省略 status，保存成功后结束；宿主报告当前步骤无法继续时保留错误与已有成果并结束本次回复，交回主会话，不反复提交被拒参数或补造文稿。主会话在 run 返回后先推进不依赖失败项的工作；只有实际来源/权限/模型服务问题或已用尽有效修订机会导致无法继续时，保存 paused 并说明条件。不会因固定篇数、普通反馈或文稿之间需要切换而主动暂停。

完成前核对全部清单行都有真实文稿、最新版本通过的独立评审、有效导航和完整场景。导航改动也用带 review 的步骤执行，expected_document_ids 覆盖每个改动文稿。阻塞条目保留为未完成，主会话保存 paused 并说明具体条件；中途不因达到固定文档数量暂停。

execution: reviewed-document-plan 只在 extract 要求登记完整 plan，并让全部必需文稿由带 expected_document_ids 与 review 的步骤生成且通过评审。文档类型、数量、模板、深度和范围由本包及用户要求决定；discuss/revise/update 保持本轮指定范围。
