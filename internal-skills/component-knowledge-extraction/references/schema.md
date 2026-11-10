# 字段格式与最终指南

## 保存章节

research_document section 接收 id、title、repository_ids、content、interfaces、integration、example、unit_tests、related_ids、paradigm。常规萃取的 id 等于当前 task.id；整体修订与补充遵循 [保存与修订](draft-contract.md) 的编号规则。title 使用开发者能识别的用途名称。sources 由平台保留追溯信息，不写入正文。

kind=paradigm、status=recommended 的 content 必须且仅按下列三级标题组织，各区块有实质内容：

```markdown
### 适用场景
具体需求、使用前提和适用范围。
### 使用步骤
按真实调用顺序说明操作。
### 使用约束
确定的行为边界、失败处理和资源责任。
```

有确证误用时在末尾追加“### 常见误用”，写清触发条件、后果和正确做法。细分内容可用四级及以下标题。

| 字段 | 内容 |
|---|---|
| interfaces | 关键接口、参数和返回行为 |
| integration | 已核对的依赖、导入、构建和配置；组件层由平台汇总相同配置 |
| example | 完整使用代码及语言代码围栏，说明文字分别写入对应内容字段 |
| unit_tests | 完整单元测试 Markdown，含测试代码、断言、fixture/mock、实际构建运行配置；推荐用法必填，内部研究项无需填写时显式填空串 |
| related_ids | 当前已有章节的稳定编号列表 |

推荐用法的 interfaces、integration、example、unit_tests 不重复一级至三级标题，平台插入“关键接口”“完整示例”“单元测试示例”等固定标题。unit_tests 可用四级标题区分测试准备、用例和执行配置。推荐用法的 example 与 unit_tests 各包含完整非空代码块。

unverified、legacy 以及 contracts、pitfalls、index 属于内部研究项：content 保存有实质内容的研究记录，仍提供完整结构化元数据与真实基础仓来源；interfaces、integration、example、unit_tests 可以显式留空。缺少测试依据时保留事实与缺口，不补造代码。这些研究项留在原任务中，不进入正式指南。

## 结构化依据

paradigm 字段全部提供，空集合用 []：

| 字段 | 要求 |
|---|---|
| kind | contracts / paradigm / pitfalls / index，与阶段一致 |
| component | task.component 的稳定编号 |
| language | 当前研究技术栈编号 |
| status | recommended / legacy / unverified，如实记录确认情况 |
| need | 使用方要完成的具体工作 |
| api | 真实关键符号；用法至少一项 |
| applicability | 已确认的适用范围、依赖和版本条件 |
| replaces | identifiers、imports、patterns 三个列表，仅记录有依据的替代主张 |
| evidence | 基础仓引用，字段为 repository_id、path、revision、start、end |
| usage_evidence | purpose="usage" 实际展开的 everycode-* 编号 |
| test_evidence | purpose="unit-test" 实际展开的 everycode-* 编号 |
| open_questions | 研究中尚未解决的问题，不写入指南正文 |

基础仓引用采用上下文固定版本和真实读取的行号；每个调用与测试编号都需当前会话回读。recommended 用法需有真实调用和测试证据。内部研究项的 usage_evidence、test_evidence 没有实际取得时填空数组。open_questions 与确认状态分别表达事实，记录其他问题不影响已经核实的用法。

## 保存概述

research_document overview 只包含两个二级区块，顺序固定、均有实际内容：

```markdown
## 组件用途
说明组件解决的问题及适用对象。
## 接入配置
列出真实依赖、构建目标、配置和初始化前提。
```

总标题与用法导航由平台生成。最终一组件一指南；每项用法按适用场景、关键接口、使用步骤、完整示例、单元测试示例、使用约束、可选常见误用的顺序组织。模板见 [指南结构](../assets/templates/guide.md) 和 [用法字段](../assets/templates/paradigm.md)。

## 正文与结构化导出

正式指南只采用已选择且完整的 recommended 用法，发布、阅读、下载与 Git 归档保持同一篇组件正文。证据编号、源码位置、研究过程、存疑状态和运行记录保存到平台元数据。

结构化下载包另保留每项内容及其 metadata.json、原始 everycode 证据和程序生成的目录、映射及规则候选。使用平台提供的导出与校验入口；模型只维护来源字段，不手工派生另一份文件。

规则候选记录精确替代关系和适用条件；正式知识发布与规则启用分别由用户决定。反例研究只提交核对结果，不修改用户的启用决定。
