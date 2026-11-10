> 通过 step.instructions 与 knowledge_work 读取本步骤的范围、问题和已有结果；中间内容保存到 knowledge_work_result.data，最终文档通过 knowledge_draft 保存。下面的 knowledge/ 和 repos/ 是相对平台归档目标的文档组织，不是本机目录。工具参数见 [平台工具接口](platform-pipeline.md)。

# 组装阶段：把一个子功能的各跳整理成完整链路文档

## 输入

- 通过 knowledge_work read 读取本子功能各作者步骤的 data.section，顺序由步骤说明给出。
- `knowledge/chains/<模块>/common.md`：共用段已在那里写过。
- 通过 knowledge_work read 查阅作者 data.findings，再回读资料和代码。

## 步骤

1. 按 `hop_order` 通读各 section。
2. **不是拼接，而是整理**：
   - 某一跳的内容属于 common.md 中的共用段时，改为"见 common.md「Cx 标题」"，只保留本子功能特有的部分。
   - 相邻两跳对同一边界的描述重复时，合并。
   - 各跳之间说法矛盾时，打开代码核实；核实不了的写入存疑并追加待确认问题。
3. **提炼贯穿整条链路的约束**：单看某一跳看不出来、但串起来才显现的约束，例如端到端时序、跨多跳的一致性要求、失败时整条链路如何回退。这是组装阶段最有价值的新增内容，要认真找。
4. **汇总易错点**，去重并按严重程度排序。
5. 各跳代码依据去重后保存到 sources；正文只保留理解知识所需的位置和链接。

## 产出：`knowledge/chains/<模块>/<子功能>.md`

使用模板 `chain-subfeature.md`。"链路总览"表格让读者十秒内看清这条链路经过哪些仓、哪些边界。

## 质量要求

- 读完这一篇，一个新人应当知道：这条链路为什么存在、经过哪里、改动时必须遵守哪些约束、最容易在哪里出错。
- 所有代码引用沿用 section 中的，如有调整需亲自核对。
