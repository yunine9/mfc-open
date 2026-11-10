import { useEffect, useMemo, useState } from "react";
import type { AuthUser } from "./api";
import {
  canViewHelpItem,
  filterVisibleHelpItems,
  resolveVisibleHelpItem,
  visibleHelpItemsById,
  type HelpAudience,
} from "./helpAccess";
import { Markdown } from "./markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { XIcon, PlayIcon, ArrowUpRightIcon } from "lucide-react";
import { cn } from "cn";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type HelpGroup = "快速开始" | "需求与问题" | "团队协作" | "知识库与工作流" | "设置与排障";

export interface HelpScreenshot {
  src: string;
  alt: string;
  caption: string;
}

export interface HelpArticle {
  id: string;
  group: HelpGroup;
  title: string;
  summary: string;
  audience: HelpAudience;
  minutes: number;
  keywords: string[];
  steps: Array<{ title: string; detail: string }>;
  body: string;
  screenshots?: HelpScreenshot[];
  related?: string[];
}

const SHOT_ROOT = "/help";

/**
 * 帮助内容和页面骨架放在一起维护：新增功能时必须同时说明“入口、动作、
 * 后续行为、异常提示”，不能只写按钮说明。截图来自独立演示环境，不含
 * 生产任务、账号或代码内容。
 */
export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "getting-started",
    group: "快速开始",
    title: "先认识 Mae-Flow",
    summary: "两类工作、两种角色和一条最重要的使用原则。",
    audience: "所有人",
    minutes: 3,
    keywords: ["首页", "导航", "角色", "需求", "问题", "新手"],
    steps: [
      { title: "选对工作入口", detail: "要开发一个需求，就进“我的需求”；要查线上问题或 DTS 问题单，就进“问题处理”。" },
      { title: "先看待我处理", detail: "数字角标和顶部待办会把真正需要你行动的事项排在前面。" },
      { title: "不确定就看明确提示", detail: "Mae-Flow 不替你猜模糊决定；处理不了时会说明原因和下一步。" },
    ],
    body: `## Mae-Flow 是什么
Mae-Flow 是团队的软件交付工作台。开发助手写代码，平台盯住流程和质量，需要你拍板时再来找你。整个过程都能查到，不用在聊天记录里翻来翻去。

| 你要做的事 | 从哪里进入 | 平台负责什么 |
|---|---|---|
| 交付一个明确需求 | **我的需求** | 从澄清、实现、验证推进到交付与合入 |
| 研究一个现象或 DTS 问题单 | **问题处理** | 先查清原因，再判断要不要建单或改代码 |
| 修复已有 MR 的流水线失败 | **问题处理 → 流水线修复** | 读取失败日志、修复并验证，推送原分支后检查新提交的流水线 |
| 看团队需求全局 | **团队需求** | 汇总需求当前现场、阻塞、责任人与成果档案 |
| 看团队问题全局 | **团队DTS** | 问题会话概览、现场与闭环档案 |
| 沉淀可复用能力 | **知识库** | 研究和审查领域知识、组件知识与 Skill，查看团队经验；工作流在**配置中心** |

> 核心原则：遇到说不准的事，平台{{red|不会偷偷替你猜}}；做不了的事，也{{red|不会假装做完了}}。需要你决定、运行环境不可用或测试结果不够时，页面会直接告诉你哪里有问题、接下来能怎么做。

## 两种角色
- **开发成员**：发起自己的任务、处理待办、检视协作任务、维护个人接入。
- **管理员**：查看和兜底团队需求与问题，治理知识库、账号和运行设置。

## 状态怎么看
{{blue|“自动推进中”}}表示开发助手正在工作；{{blue|“待我核对”}}表示任务停在需要你确认的地方；{{red|“需要介入 / 已暂停”}}表示运行出了问题，或者你主动按了暂停；{{green|“待合入 / 完成”}}表示代码和测试结果已经准备好。`,
    screenshots: [{
      src: `${SHOT_ROOT}/01-overview.png`,
      alt: "Mae-Flow 开发成员首页，标注了我的需求、问题处理和待办入口",
      caption: "开发成员首页：①需求交付入口；②问题研究入口；③真正需要行动的待办。",
    }],
    related: ["launch-requirement", "handle-waiting"],
  },
  {
    id: "launch-requirement",
    group: "需求与问题",
    title: "发起一个需求任务",
    summary: "用尽量少的必填信息启动任务，知识自动匹配，工作流按需定制。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["发起", "需求", "代码仓", "模块", "语言", "知识", "工作流", "高级设置"],
    steps: [
      { title: "说清目标与代码仓", detail: "填写要解决的问题、验收预期，并选择本次涉及的代码仓。" },
      { title: "确认业务模块与技术语言", detail: "首次选择会保存在系统里；它们用于自动匹配团队知识。" },
      { title: "按需选择工作流", detail: "普通任务直接采用平台默认；明确知道阶段能力编排时再选择团队工作流。" },
      { title: "启动并等待现场形成", detail: "创建后进入“我的需求”，平台会克隆仓库、准备环境并开始推进。" },
    ],
    body: `## 必填信息为什么不折叠
任务目标和代码仓始终在主流程里展示。业务模块、技术语言、补充说明和工作流选择集中在“高级设置”；它们会直接影响知识匹配，平台会在发起前完成核对。

## 知识如何进入任务
团队知识{{blue|不需要手工一条条勾选}}。平台会按代码仓、业务模块、开发语言和所选工作流在服务端生成最终清单，发起人可以看到每项的版本与命中依据。点击任一项会打开它的全文；开发助手拿到的是同一份固定版本，{{green|页面所见与实际注入不会是两套名单}}。

任务创建后，这份知识名单就不再变化。以后恢复、重跑或拆分任务，仍用原来的名单，避免做到一半突然换了一套知识。

## 工作流什么时候选
- 不知道要怎么定制：直接用平台默认流程，它会保证基本步骤和质量检查都在。
- 团队已经有合适方案：直接选它。任务会记住你当时选的是哪个版本。
- 你很清楚每一步该怎么做：先复制一份方案，再安排每个阶段要用的提示、知识、工具和可直接执行的做法（Skill）。

> 工作流定制{{red|不能跳过}}必须做的步骤、真实测试和需要人确认的决定，也不能越过代码仓权限。`,
    screenshots: [{
      src: `${SHOT_ROOT}/02-launch.png`,
      alt: "发起新任务界面，标注需求信息、代码仓与自动知识匹配区域",
      caption: "发起任务：①描述目标；②选择真实代码仓；③确认匹配依据；④普通任务可直接启动。",
    }],
    related: ["knowledge-assets", "workflow-assets", "requirement-workspace"],
  },
  {
    id: "requirement-workspace",
    group: "需求与问题",
    title: "读懂需求任务工作台",
    summary: "在一个页面看进度、文档、代码、检视意见、测试和交付结果。",
    audience: "开发成员",
    minutes: 5,
    keywords: ["任务", "工作台", "进度", "材料", "代码", "diff", "暂停", "继续", "交付"],
    steps: [
      { title: "先看当前状态", detail: "页头说明现在进行到哪里，以及系统是在执行、等待你，还是需要介入。" },
      { title: "沿阶段轨迹定位", detail: "阶段轨迹展示已完成、当前和后续节点，不用翻聊天记录猜进度。" },
      { title: "在材料区做决定", detail: "方案、文档、代码差异、测试与交付清单都在同一工作台审阅。" },
      { title: "暂停后等明确回执", detail: "点击暂停会先显示“正在暂停”，服务端确认后显示“已暂停”，不会把等待误装成卡死。" },
    ],
    body: `## 工作台不是聊天窗口
聊天内容只是开发助手的过程说明。判断任务有没有真的做完，要看当前做到哪一步、页面里的文档和代码、真实测试结果以及你的批注。

## 你能在这里做什么
- 查看需求文档、方案、流程图、代码差异、测试结果和流水线状态。
- 对具体段落或代码行加批注，开发助手会知道你说的是哪一段、哪一行。
- 需要你确认时，可以选现成答案，也可以自己写清楚要求。
- 可以主动暂停、恢复、从头重跑，或邀请代码检视人帮你看。

## “继续”之后会怎样
确认没问题后，开发助手会进入下一步；如果你提交了批注或补充说明，它会先按意见修改，再把新结果交给你检查。最终要提交的文件发生变化时，平台会重新问你，不能拿之前的确认继续放行。

> 不要用“继续”表达新的修改意见。先写批注或补充说明再提交，页面会明确显示意见是否送达。`,
    screenshots: [{
      src: `${SHOT_ROOT}/03-task-workspace.png`,
      alt: "需求任务工作台，标注状态、阶段轨迹、材料页签和操作区",
      caption: "任务工作台：①当前状态；②阶段轨迹；③材料与检视；④暂停、继续和交付操作。",
    }],
    related: ["handle-waiting", "review-and-notify", "team-dashboard"],
  },
  {
    id: "handle-waiting",
    group: "需求与问题",
    title: "处理待办、批注与自由回复",
    summary: "明确区分选择、补充意见和模糊表达，保证决定真的生效。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["待办", "决定", "批注", "自由回复", "继续", "确认", "提交不了", "状态变化"],
    steps: [
      { title: "逐题检查待办", detail: "多项问题会完整展示并逐项收集答案，不会只提交第一题。" },
      { title: "选项不合适就自由回复", detail: "选择“自由回复”并写清具体答案或修改要求。" },
      { title: "有意见就先写清楚", detail: "批注和补充说明会先送给开发助手；它改完以后，再回来请你确认。管理员入口只对当前复检仍待闭环的他人意见开放，第一次点击只进入确认，第二次才执行。" },
      { title: "状态冲突时刷新事实", detail: "别人已经决定或任务已经推进时，页面会保留你的文字并说明最新状态，而不是吞掉提交。" },
    ],
    body: `## 选择和意见是两种不同动作
{{blue|选择}}决定任务接下来往哪走；{{blue|批注 / 补充说明}}是让开发助手修改当前结果。提交意见后，系统会先安排修改，{{green|不会把这次提交当成“确认通过”}}。

## 多个问题如何回答
页面逐题展示全部问题；小鲁班文本入口也会逐题收集，全部答完后一次提交。全是选项题时可按提示一次回复多个序号。

## 自由回复
当预设选项表达不了你的意思时，切换自由回复并写出明确结论。平台不会猜“差不多”“你看着办”等模糊表达；它会保留原话并提示怎样补充到可执行。

## 管理员什么时候能代办
只有任务正在等待当前工作区复检、且这条是本轮仍待闭环的他人已提交意见时，管理员才会看到“管理员代删”或“管理员代确认”。草稿、历史意见、已闭环意见和管理员自己的意见都不会显示入口。仅在意见作者不在场时使用：第一次点击只进入确认，第二次点击才执行；代确认后，批注会同时显示实际执行的管理员和原批注作者。

## 为什么会提示“任务状态已变化”
人工决定采用先到生效。若另一个页面、通知入口或协作者已经完成同一待办，旧页面不能覆盖新事实。刷新后会展示最新决定；尚未送达的补充意见会保留，允许按新的任务状态重新提交。`,
    screenshots: [{
      src: `${SHOT_ROOT}/04-decision.png`,
      alt: "人工决定卡片，标注问题列表、自由回复和提交区域",
      caption: "需要你确认时：①检查问题；②选择现成选项；③选项不合适就自己写；④提交这次决定。",
    }],
    related: ["review-and-notify", "requirement-workspace"],
  },
  {
    id: "issue-flow",
    group: "需求与问题",
    title: "处理问题与 DTS 问题单",
    summary: "先研究事实，再决定建单、修复或给出“不是问题”的结论。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["问题", "DTS", "日志", "定位", "固定流程"],
    steps: [
      { title: "选对发起入口", detail: "无单问题走手工登记，必选业务模块并自动带出绑定代码仓；已有 DTS 单据从独立的 DTS 列表筛选和勾选发起。" },
      { title: "按固定流程推进", detail: "平台按固定步骤查问题，在分析与结论等关键节点停下来等你确认；其余步骤自动推进，不需要你选排查方式。" },
      { title: "填齐真实现场", detail: "手工登记常开网管环境：从配置中心的环境管理选择环境 IP，自动使用已存后台密码；后台密码供抓日志与部署使用。" },
      { title: "接受诚实结论", detail: "定位结果可以是缺陷、配置、使用问题，也可以是证据表明“不是问题”。" },
    ],
    body: `## 它和需求交付有什么不同
需求通常从目标出发推进实现；问题处理从现象出发查清原因。Mae-Flow 不要求一开始就假定必须改代码，也不会为了“有结果”强行建问题单。

## 固定流程怎么走
平台按固定阶段推进：先拉取代码仓，再做问题分析；分析确认后进入修复，MR 跑绿后给出结论。在分析确认、结论确认等关键节点，页面会停下来等你拍板，其余步骤由开发助手自动推进。

## 无单和已有 DTS 分开登记
- **手工登记（无单）**：问题标题、现象、业务模块和网管环境都在同一张常开表单里填写。业务模块必选，代码仓只读展示并由模块绑定自动带出；要增删绑定，请到“配置中心 → 模块与代码仓”。
- **DTS 列表（已有单）**：搜索或筛选本人名下可处理单据；所属模块按单据特性名自动带出，没带出的在列上必选后才能勾选发起。想给个别单子定不同的介入节奏，打开列表右上「列」设置勾出「介入档位」列，发起前选好（发起后定格），不选就跟随个人设置。这里是独立入口，不在手工表单重复填写 DTS 单号。

## 已有 MR 的流水线修复
在「问题处理 → 流水线修复」粘贴 MR 链接，先拉取仓库和源分支，再检查报错、修复验证并推回原分支。工作台、代码差异、执行过程、人工接管和恢复复用已有能力，记录独立保存在本工具，不进入问题会话、团队 DTS、归档或交付统计。平台只自动处理编译、测试和代码质量失败，不推进检视意见、审批与合入。已由需求任务或问题会话管理的 MR，请回原任务或会话处理。

## 工具与权限
拉日志、构建部署、读取 DTS 和代码仓，都通过平台提供的专用工具完成。浏览器草稿不保存网管口令，服务端会加密保存；口令不会出现在会话列表、状态摘要或事件流中，但为了让 AI 抓日志和换库，会以明文进入{{red|当前问题的 AI 上下文}}。只填脱敏演示或现场专用口令，绝不要填写个人复用或生产口令。工具失败时，页面会显示真实原因，并告诉你还缺什么。`,
    screenshots: [{
      src: `${SHOT_ROOT}/05-issues.png`,
      alt: "问题处理页面，标注新建问题、会话列表和当前研究现场",
      caption: "问题处理：①发起研究；②从会话列表回到现场；③按事实补充材料或确认研究结论。",
    }],
    related: ["personal-settings", "troubleshooting"],
  },
  {
    id: "review-and-notify",
    group: "团队协作",
    title: "邀请检视与小鲁班通知",
    summary: "让意见可靠送达，让手机回复不会因为插件未激活而悄悄失效。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["检视", "review", "Committer", "小鲁班", "通知", "/mfc", "手机", "回复"],
    steps: [
      { title: "在任务中邀请检视", detail: "选择代码检视人后，任务会进入对方的“待我检视”，页面也会告诉你通知有没有送到。" },
      { title: "检视人提交意见", detail: "可以在具体内容上批注，也可以写一段整体意见；意见会先交给开发助手修改。" },
      { title: "手机先激活插件", detail: "每条通知都会提示先输入 /mfc 激活；未激活的普通回复不会进入 Mae-Flow。" },
      { title: "按上下文回复", detail: "唯一待办可直接回复；多项待办按通知中的审批码选择，模糊输入会得到明确提示。" },
    ],
    body: `## 检视闭环
责任人发出邀请后，代码检视人会在“我的需求 → 待我检视”看到任务。批注提前送达，或者在最终确认时又补了新意见，都能正常交给开发助手。即使原来的确认已经被别人点过，也不会因此把新意见丢掉。

## 小鲁班手机回复的前置条件
手机端{{red|必须先输入 /mfc}}激活 Mae-Flow 插件。通知正文固定包含这条提示；如果内网插件还没接通回复能力，通知只提供网页入口，{{green|不会谎称“回复 1 即可”}}。

## 多项待办和自由回复
- 只有一项待办：激活后可回复选项序号、确认语句或具体修改意见。
- 多项待办：先选择任务，或携带通知中的审批码。
- 多问题卡：逐题收集，全部答完后才提交。
- 选项不合适：回复通知提示中的“自由回复”格式。

> 无法唯一理解时，插件不会猜测或伪造成功，会明确列出仍缺什么。`,
    related: ["handle-waiting", "personal-settings"],
  },
  {
    id: "team-dashboard",
    group: "团队协作",
    title: "查看团队需求与成果档案",
    summary: "用当前现场管理行动，用成果档案回看结果。",
    audience: "所有人",
    minutes: 3,
    keywords: ["团队", "动态", "阶段", "筛选", "负责人", "档案", "MR"],
    steps: [
      { title: "当前现场看行动", detail: "优先关注等待决定、阻塞和异常任务，不把已完成记录铺满首页。" },
      { title: "点击阶段做筛选", detail: "阶段分布可以直接筛出对应任务，避免图表只看不能用。" },
      { title: "打开任务看详情", detail: "管理员可以进入任意任务帮忙处理；普通成员也能查看团队进展，但不能替别人做决定。" },
      { title: "成果档案看结果", detail: "等待合并、已经完成、失败和取消的任务集中放在这里，并保留合并申请和过程记录。" },
    ],
    body: `## 两个视图各回答一个问题
- **当前现场**：现在谁在做什么、哪里卡住、下一步谁行动。
- **成果档案**：最后交付了什么、测试和合并申请在哪里、为什么失败或取消。

首页不会平铺所有动态。阶段分布承担筛选入口，任务列表承担行动，档案承担追溯，三者避免重复展示同一份信息。团队问题会话的全景在「团队问题」页，不与需求混排。

## 权限
所有成员都可以了解团队需求；真正影响任务走向的决定，仍然只有责任人和管理员能提交。别人发给你一个任务链接，并不会让你突然拥有操作权限。`,
    screenshots: [{
      src: `${SHOT_ROOT}/06-team-dashboard.png`,
      alt: "团队需求页面，标注当前现场、阶段筛选和成果档案",
      caption: "团队需求：①当前现场；②阶段与行动筛选；③需要行动的任务；④成果档案。",
    }],
    related: ["requirement-workspace", "knowledge-assets"],
  },
  {
    id: "knowledge-assets",
    group: "知识库与工作流",
    title: "在知识库里生产知识",
    summary: "研究或导入 → 审查 → 发布到平台 → 需要时手动归档建 MR；团队经验也在知识库里看。",
    audience: "所有人",
    minutes: 4,
    keywords: ["知识", "知识库", "Skill", "领域", "组件", "研究", "审查", "发布", "归档", "MR", "单号", "经验"],
    steps: [
      { title: "发起研究或导入", detail: "知识库右上角「＋新增」：研究知识（领域、基础组件或制作 Skill），或导入 Skill 包。创建后直接进入这个任务。" },
      { title: "审查草稿", detail: "逐篇看正文、提意见；可以自己改，也可以把意见交给 Agent 修订。研究进行中也能提意见，本轮结束后再交给 Agent。" },
      { title: "发布到平台", detail: "勾选要发布的文稿后发布，平台上立即可读。还有没处理的意见不会拦住发布，意见会保留。" },
      { title: "需要时手动归档", detail: "任务里点「归档」，填写单号后创建 MR；创建成功即结束，之后的合入由代码平台上的人来审。" },
    ],
    body: `## 三类知识，同一条生产线
| 类型 | 是什么 | 谁来用 |
|---|---|---|
| 领域知识 | 业务上是什么、为什么 | 业务自己决定怎么用（写进自己仓的文档或 Skill） |
| 基础组件知识 | 自研组件怎么用、什么用法是错的 | 平台在需求单里提示开发助手 |
| Skill | 能直接交给开发助手照着做的做法 | 发布后按模块或语言自动供给需求单 |

## 归档就是建一个 MR
发布只写平台。要把文档交付到业务仓或知识仓时，在任务里点「归档」：确认要归档的文件和目标仓，填写单号（MR 必须关联单号），点「创建 MR」。成功后任务显示 MR 链接，平台不再跟踪它；以后出了新版本，再点一次归档就会开一个新的 MR。创建失败时页面会说明原因，改好后点「重试」。

## 「知识任务」里看进度
右上角的「知识任务」汇总所有研究、导入和归档。需要你处理的（待审查、归档失败、记录损坏等）排在最前面，每条都写明下一步。

## 团队经验
知识库右上角的「团队经验」列出交付复盘和对话中沉淀的经验，可以在那里审查、采纳或停用。

## 仓内知识不归平台管
业务仓里的 AGENTS.md、docs、.claude、.cac 等内容跟着代码仓自己管理，平台不扫描、不收录。`,
    related: ["launch-requirement", "workflow-assets"],
  },
  {
    id: "workflow-assets",
    group: "知识库与工作流",
    title: "创建、发布和复用工作流",
    summary: "平台默认流程保证基本质量；熟悉流程的人可以把每一步安排得更细。",
    audience: "所有人",
    minutes: 6,
    keywords: ["工作流", "定制", "复制", "保存", "发布", "删除", "归档", "阶段", "Skill", "工具"],
    steps: [
      { title: "从现有方案复制", detail: "优先复制平台或团队现有方案，再在自己的草稿里修改，不用从空白开始。" },
      { title: "把每一步安排清楚", detail: "明确这一阶段要用哪些提示、知识、工具和可直接执行的做法（Skill）。" },
      { title: "预览顺序和前后关系", detail: "编辑页先给你看大致结果；创建任务时，平台还会再做一次完整检查。" },
      { title: "检查后发布", detail: "发布过的版本不能覆盖；不用的方案可以归档，老任务仍然能查到它。" },
    ],
    body: `## 在哪里维护
工作流在**配置中心 → 团队工作流**里维护；发起需求时点「编辑工作流」也会直达这里对应的方案。

## 定制面向谁
普通用户不需要打开工作流编辑器，直接用默认流程就行。只有当你非常清楚每个阶段要做什么、用什么知识和工具时，才需要自己定制。

## 默认和定制如何相处
定制不会简单地和默认内容堆在一起，也不能把平台的基本流程换掉。必须经过哪些阶段、做到什么才算完成、要跑哪些真实检查、谁有权限做决定，这些底线不能改。你只能在允许的范围里安排每一步怎么做。两边有冲突时，页面会直接指出来。

## 一个方案有四种常见操作
- **保存草稿**：可以反复修改。两个页面同时编辑时，平台会阻止旧页面覆盖新内容。
- **发布版本**：发布后内容不再改变，新任务可以选择它。
- **复制方案**：完整复制出一份新草稿，同时记住它是从哪里复制来的。
- **归档方案**：新任务不再看到它，但老任务和历史版本仍然保留。

## 为什么没有直接删除已发布方案
已发布的工作流可能已经被任务用过。如果直接删掉，以后就说不清老任务当时按什么做的，所以页面提供“归档”。只有从未发布、也从未被任务使用的草稿，才适合彻底删除。`,
    screenshots: [{
      src: `${SHOT_ROOT}/08-workflows.png`,
      alt: "工作流页面，标注方案列表、复制编辑入口和发布状态",
      caption: "工作流：①搜索或选择方案；②复制成新草稿；③查看版本状态；④进入详情或编辑。",
    }, {
      src: `${SHOT_ROOT}/08-workflow-editor.png`,
      alt: "工作流编辑页面，标注阶段列表、阶段能力、顺序预览和保存发布操作",
      caption: "工作流编辑：①选择阶段；②安排本阶段要用的能力；③检查前后顺序；④保存草稿或发布版本。",
    }],
    related: ["launch-requirement", "knowledge-assets"],
  },
  {
    id: "wish-wall",
    group: "团队协作",
    title: "在许愿墙提出诉求或问题",
    summary: "让建议从“有人提过”走到接纳、实施和闭环。",
    audience: "所有人",
    minutes: 3,
    keywords: ["许愿墙", "问题", "诉求", "图片", "粘贴", "接纳", "闭环"],
    steps: [
      { title: "选择诉求或问题", detail: "先分类，便于维护者区分能力建议和真实使用故障。" },
      { title: "写清场景与影响", detail: "说明你当时要做什么、发生了什么、期望怎样。" },
      { title: "直接粘贴截图", detail: "在编辑区粘贴剪贴板图片，提交前可预览和移除。" },
      { title: "跟踪处理状态", detail: "待接纳、已接纳、已闭环和未接纳都会保留明确说明。" },
    ],
    body: `## 什么适合放在许愿墙
- 让工作更顺手的产品诉求。
- 遇到的错误、卡顿、提示不明确或流程割裂。
- 对任务执行安排的反馈；从任务工作台发起时，平台会自动带上当时使用的方案、阶段和版本。

## 好反馈的三个要素
1. 当时想完成什么。
2. 实际发生了什么，造成什么影响。
3. 你期待的行为是什么。

截图可以直接粘贴并预览。不要上传密码、访问凭据、客户数据或没有隐去敏感内容的生产日志。

## 状态不是装饰
{{blue|待接纳}}表示正在评估；{{blue|已接纳}}表示方向确认但未必已经上线；{{green|已闭环}}表示已经有可验证结果；{{red|未接纳}}必须附理由。评论和状态变化都会留在同一张卡片上。`,
    screenshots: [{
      src: `${SHOT_ROOT}/09-wish-wall.png`,
      alt: "许愿墙页面，标注创建入口、图片粘贴区和状态筛选",
      caption: "许愿墙：①选择诉求或问题；②写清场景、实际与期望；③粘贴截图；④按状态跟踪。",
    }],
    related: ["troubleshooting", "workflow-assets"],
  },
  {
    id: "personal-settings",
    group: "设置与排障",
    title: "配置个人接入与人工介入程度",
    summary: "一次设置好确认频率、代码仓身份和小鲁班通知。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["个人设置", "人工介入", "月光", "全自动", "Git", "CodeHub", "小鲁班", "Token"],
    steps: [
      { title: "选择人工介入程度", detail: "需求交付四档、问题处理三档,两条流分别设定、互不影响。" },
      { title: "配置代码身份", detail: "提交邮箱和 CodeHub 访问凭据用于拉代码、提交、创建合并申请和确认检视身份。" },
      { title: "配置小鲁班", detail: "保存个人通知凭据并测试送达;手机回复仍需先 /mfc 激活插件。" },
    ],
    body: `## 人工介入程度
设置页有两组旋钮:「需求交付」是四档(过程问你/推送问你两个开关的组合),「问题处理」是三档——全自动、优先报告(默认)、优先对齐。两边独立取值、互不带动。无论怎么选,流水线都必须检查当前这版代码,合并申请也仍然要由人来合并。"全自动"不会关掉这些基本检查。

问题处理三档的含义:**全自动**=AI 不再向你提问,一路跑到 MR 变绿(或办不了停下)才提醒你——只有人拿得到的事实照旧停,比如缺网管环境时向你举环境配置卡,等你补配或拒绝;**优先报告**=只在分析报告检视时停一次,你提意见(报告圈注或对话),AI 闭环重出直到你点确认,其余直达变绿;**优先对齐**=现象对齐、结论确认。任何档位下,分支推送都自动执行(推送不再单独过目);缺网管环境都会向你举环境配置卡,流水线红灯需要人在交付平台处理/豁免的卡都照常等真人——这些不是提问,是只有人办得到的事。

需求侧切换到自动时,默认只影响后续节点。若当前已有可处理待办,页面会明确询问是否一并处理;含检视意见的待办不会自动放行。问题侧的闸卡是即到即判,改档位只对之后的卡生效,已在等待的卡仍需你处理。

## 个人接入
- **CodeHub**：用于拉代码、提交、推送、创建合并申请和确认检视人；页面只会显示隐去敏感内容后的提示。
- **小鲁班**：用于待办与状态通知；测试通知只验证送达，不代表手机回复插件已经激活。

凭据保存失败、权限不足或服务端能力未配置时，发起入口会明确指出缺少哪一项，并提供返回个人设置的快捷入口。`,
    screenshots: [{
      src: `${SHOT_ROOT}/10-personal-settings.png`,
      alt: "个人设置页面，标注人工介入程度和个人接入",
      caption: "个人设置：①选择人工介入程度；②配置 CodeHub；③配置小鲁班通知。",
    }],
    related: ["review-and-notify", "troubleshooting"],
  },
  {
    id: "administration",
    group: "设置与排障",
    title: "管理账号与服务设置",
    summary: "管理员集中维护账号、模型、运行策略和能力自检。",
    audience: "管理员",
    minutes: 4,
    keywords: ["管理员", "账号", "密码", "模型", "服务设置", "图片识别", "部署", "团队约定"],
    steps: [
      { title: "账号管理", detail: "创建开发或管理员账号、重置密码，离职账号按提示安全移除。" },
      { title: "模型与图片识别", detail: "配置主模型和独立视觉模型后，用页面自检验证真实能力。" },
      { title: "团队运行策略", detail: "维护团队级执行约定、保留期、缓存与部署相关设置。" },
      { title: "先自检再开放", detail: "配置存在不等于能力可用，页面以真实探测结果决定是否就绪。" },
    ],
    body: `## 账号管理
管理员创建本地账号并分配角色。开发账号进入个人工作台；管理员进入团队全局。重置密码不要求旧密码，因此只应授予可信管理员。

## 服务设置
服务设置管的是整个平台，不管个人账号的访问凭据。主模型、图片识别模型、团队统一约定，以及任务文件保留多久，都在这里维护。页面会实际检查服务能不能用，不能只看“已经填了配置”。

## 设置的生效范围
页面会说明一项设置是立刻生效、只影响以后新建的任务，还是需要重启服务。已经进行中的任务尽量沿用创建时的设置，避免管理员改了全局配置后，任务做到一半突然换规则。`,
    screenshots: [{
      src: `${SHOT_ROOT}/11-administration.png`,
      alt: "管理员服务设置页面，标注模型能力自检、团队约定和文件保留设置",
      caption: "服务设置：①配置模型和图片识别；②用真实检查确认能用；③维护团队统一约定；④设置任务文件和构建缓存保留时间。",
    }],
    related: ["team-dashboard", "knowledge-assets"],
  },
  {
    id: "troubleshooting",
    group: "设置与排障",
    title: "常见问题与自助排障",
    summary: "先判断是在安全等待、环境失败，还是需要补充明确输入。",
    audience: "所有人",
    minutes: 5,
    keywords: ["FAQ", "排障", "卡死", "暂停", "超时", "编译", "编译超时", "知识", "回复", "流程图", "PlantUML"],
    steps: [
      { title: "先看页面写了什么", detail: "页面会分清正在处理、已经暂停、正在自动工作、等你确认和运行失败，不需要靠转圈动画猜。" },
      { title: "打开任务现场", detail: "查看最近事件、工具结果和明确错误，不把一条通知当完整诊断。" },
      { title: "按提示补充最小事实", detail: "缺仓库、模块、语言、日志或唯一决定时，只补它明确要求的内容。" },
      { title: "仍不合理就投许愿墙", detail: "带上任务链接、发生时间和脱敏截图，维护者可以追到同一现场。" },
    ],
    body: `## 点击暂停后像卡住了
点击暂停会立即停止当前会话。按钮先显示“正在暂停”，会话和容器清理完成后显示“已暂停”；如果暂停失败，页面会展示原因。

## C++ 全量编译超过 600 秒
这通常不是“服务器坏了”，而是给这次编译的时间不够。平台应该保留能继续使用的运行环境，并说明编译还在进行，还是已经超时。这个代码仓可以单独设置更长时间、只编译受影响模块，或提前把依赖下载好。只把报错写清楚，还不算解决问题。

## 团队知识没有自动匹配
检查这份知识是否已经发布、是否明确选了“业务”或“工程”、代码仓范围、业务模块或开发语言有没有填完整，以及任务选择能不能对上。也要检查所选工作流是否带入了额外知识。发起页会显示服务端最终清单、版本与具体命中依据；点击条目可查看全文。标签没补齐的知识不会参加匹配；任务开始后再改标签，也不会中途换掉它原来的知识名单。

## 小鲁班回复没有生效
先确认手机端已经输入 **/mfc** 激活插件，再检查是否有多个待办需要审批码。网页里查看决定是否已经由其他入口先提交；模糊回复不会被静默当成成功。

## PlantUML 显示语法不支持
活动图和用例图可能都包含 actor 等语句，不能只按关键字武断分类。页面会尝试受支持的 4+1 视图渲染；无法安全识别时保留源码并显示具体不支持的行，避免画错图。`,
    related: ["wish-wall", "personal-settings", "handle-waiting"],
  },
];

export function findHelpArticle(
  id: string | undefined,
  audience?: AuthUser["role"],
): HelpArticle {
  return resolveVisibleHelpItem(HELP_ARTICLES, id, audience) ?? HELP_ARTICLES[0];
}

export function filterHelpArticles(query: string, audience?: AuthUser["role"]): HelpArticle[] {
  const needle = query.trim().toLocaleLowerCase();
  return filterVisibleHelpItems(HELP_ARTICLES, audience).filter((article) => {
    if (!needle) return true;
    return [article.title, article.summary, article.group, article.body,
      ...article.keywords, ...article.steps.flatMap((step) => [step.title, step.detail])]
      .join("\n").toLocaleLowerCase().includes(needle);
  });
}

const GROUPS: HelpGroup[] = ["快速开始", "需求与问题", "团队协作", "知识库与工作流", "设置与排障"];

const QUICK_LINKS = [
  { id: "launch-requirement", title: "我要发起需求", detail: "从描述目标到启动任务" },
  { id: "handle-waiting", title: "我要处理待办", detail: "选择、批注与自由回复" },
  { id: "knowledge-assets", title: "我要治理资产", detail: "知识、模块与工作流" },
];

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden className="size-5 text-primary"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>;
}

function ArticleScreenshot({ shot }: { shot: HelpScreenshot }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  function hideOnError() {
    setExpanded(false);
    setFailed(true);
  }

  if (failed) return null;
  return <>
    <figure className="help-shot m-0 px-6 pb-7">
      <button type="button" className="help-shot-frame group relative w-full cursor-zoom-in overflow-hidden rounded-[13px]
        border border-line-strong bg-surface-3 p-0 text-left text-text shadow-md outline-offset-[3px]
        focus-visible:outline-3 focus-visible:outline-primary/60"
        onClick={() => setExpanded(true)} aria-label={`放大查看：${shot.alt}`}>
        <img src={shot.src} alt={shot.alt} loading="lazy" onError={hideOnError}
          className="block h-auto w-full" />
        <span className="help-shot-zoom pointer-events-none absolute bottom-3 right-3 translate-y-0.5 rounded-full
          border border-primary-foreground/35 bg-primary/75 px-2.5 py-1.5 text-xs font-bold text-primary-foreground opacity-80
          shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100
          group-focus-visible:translate-y-0 group-focus-visible:opacity-100" aria-hidden>放大查看</span>
      </button>
      <figcaption className="mx-2 mt-3 flex items-start gap-1.5 text-xs leading-[1.55] text-muted-foreground">
        <span aria-hidden className="font-extrabold text-primary">↳</span>{shot.caption}
      </figcaption>
    </figure>

    <Dialog open={expanded} onOpenChange={(next) => { if (!next) setExpanded(false); }}>
      <DialogContent showCloseButton={false}
        className="w-full max-w-[min(1440px,100%)] gap-0 overflow-hidden p-0 sm:max-w-[min(1440px,100%)]">
        <DialogHeader className="flex-row items-start justify-between gap-4 border-b bg-muted/40 px-4 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle>图片预览</DialogTitle>
            <DialogDescription>点击背景或按 Esc 关闭</DialogDescription>
          </div>
          <DialogClose render={<Button variant="outline" size="icon-sm" aria-label="关闭图片预览"
            className="shrink-0" />}>
            <XIcon />
          </DialogClose>
        </DialogHeader>
        <div className="help-lightbox-image grid h-[min(70vh,640px)] min-h-0 min-w-0 place-items-center
          overflow-hidden bg-surface-3 p-3 sm:p-4.5">
          <img src={shot.src} alt={shot.alt} onError={hideOnError}
            className="block h-full max-h-full w-full max-w-full min-h-0 min-w-0 object-contain object-center" />
        </div>
        <p className="m-0 border-t bg-muted/40 px-4 py-2.5 text-xs leading-relaxed break-words text-muted-foreground">
          {shot.caption}
        </p>
      </DialogContent>
    </Dialog>
  </>;
}

export function HelpCenter({ viewer, initialArticleId, onArticleChange }: {
  viewer: AuthUser;
  initialArticleId?: string;
  onArticleChange?: (articleId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(
    () => findHelpArticle(initialArticleId, viewer.role).id);
  const articles = useMemo(
    () => filterHelpArticles(query, viewer.role), [query, viewer.role]);
  const article = findHelpArticle(selectedId, viewer.role);
  const quickLinks = QUICK_LINKS.filter((item) => {
    const target = HELP_ARTICLES.find((candidate) => candidate.id === item.id);
    return target && canViewHelpItem(target, viewer.role);
  });
  const relatedArticles = visibleHelpItemsById(
    HELP_ARTICLES, article.related ?? [], viewer.role);

  // App 的 popstate 会更新 initialArticleId；组件必须跟着切文章，不能只在
  // 第一次挂载时读一次。无权限或坏 id 同时规范成该角色可见的安全回退。
  useEffect(() => {
    const next = findHelpArticle(initialArticleId, viewer.role);
    setSelectedId(next.id);
    if (initialArticleId && initialArticleId !== next.id
        && /^\/help(?:\/|$)/.test(location.pathname)) {
      history.replaceState({}, "", `/help/${encodeURIComponent(next.id)}`);
    }
  }, [initialArticleId, viewer.role]);

  function select(id: string) {
    const next = findHelpArticle(id, viewer.role);
    setSelectedId(next.id);
    setQuery("");
    onArticleChange?.(next.id);
    document.querySelector(".workspace")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <section className="grid content-start gap-5.5" aria-label="Mae-Flow 使用帮助">
    <div className="relative grid min-h-[158px] grid-cols-[minmax(0,1fr)_minmax(340px,480px)] items-center
      gap-9 overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-surface
      via-surface to-surface-3 px-8 py-7 shadow-sm max-[980px]:grid-cols-1 max-[980px]:gap-4.5">
      <span aria-hidden className="pointer-events-none absolute -top-[52px] right-7 z-0 select-none
        text-[210px] font-extrabold leading-none text-primary/5">?</span>
      <div className="relative z-1">
        <span className="text-xs font-extrabold text-primary">FAQ &amp; PRODUCT GUIDE</span>
        <h2 className="mt-2 mb-1.5 text-[clamp(24px,2.3vw,34px)] font-bold leading-[1.18] tracking-[-0.035em] text-text-strong">
          从“我现在要做什么”开始</h2>
        <p className="m-0 text-[15px] text-muted-foreground">功能说明、真实界面和异常处理都在这里。搜索动作、状态或你看到的提示。</p>
      </div>
      <label className="relative z-1 grid h-[54px] grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5
        rounded-[14px] border border-line-strong bg-surface px-3.5 shadow-md
        transition focus-within:border-primary/50 focus-within:ring-4 focus-within:ring-primary/10">
        <SearchIcon />
        <span className="sr-only">搜索使用帮助</span>
        <Input className="h-full min-w-0 border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="例如：暂停、/mfc、自动匹配、工作流…" />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索"
          className="grid size-7 cursor-pointer place-items-center rounded-lg bg-surface-3 p-0 border-0 text-muted-foreground hover:text-text-strong">×</button>}
      </label>
    </div>

    {!query && <section aria-label="平台全景演示" className="flex items-center justify-between gap-8 overflow-hidden rounded-2xl border border-primary/20 bg-surface px-8 py-6">
      <div className="min-w-0">
        <span className="text-xs font-bold tracking-wider text-primary">MAE FLOW · 交互式演示</span>
        <h2 className="mt-2 mb-2 text-2xl font-bold text-text-strong">一分钟看懂：交付与知识双闭环</h2>
        <p className="mb-5 text-sm text-muted-foreground">全景、交付、知识三张架构图，展开 MR LOOP 与知识生产、存储、消费；一键播放，自动聚焦讲解。</p>
        <div className="flex gap-3">
          <Button size="lg" nativeButton={false} render={<a href="/help/platform-overview/index.html?autoplay=1" target="_blank" rel="noreferrer" />}>
            <PlayIcon />一键播放</Button>
          <Button size="lg" variant="outline" nativeButton={false} render={<a href="/help/platform-overview/index.html" target="_blank" rel="noreferrer" />}>
            查看架构<ArrowUpRightIcon /></Button>
        </div>
      </div>
      <a href="/help/platform-overview/index.html" target="_blank" rel="noreferrer" className="w-[34%] shrink-0 overflow-hidden rounded-xl border border-line bg-[#081322]" aria-label="查看平台全景架构">
        <img src="/help/platform-overview/architecture.svg" alt="交付闭环、知识闭环与工程能力底座" className="block w-full" loading="lazy" />
      </a>
    </section>}

    {!query && <div className="grid gap-3 max-[980px]:grid-cols-1 sm:grid-cols-3" aria-label="常用帮助">
      {quickLinks.map((item, index) => <button type="button" key={item.id}
        onClick={() => select(item.id)}
        className="grid min-w-0 cursor-pointer grid-cols-[34px_minmax(0,1fr)] items-center gap-x-2.5 rounded-[14px]
          border border-line bg-surface px-4.5 py-4 text-left transition hover:-translate-y-0.5
          hover:border-primary/40 hover:shadow-sm">
        <span className="col-start-1 row-span-2 grid size-[34px] place-items-center rounded-[10px] bg-surface-3
          text-xs font-extrabold text-primary">{String(index + 1).padStart(2, "0")}</span>
        <strong className="text-sm font-bold text-text-strong">{item.title}</strong>
        <small className="-mt-0.5 text-xs font-medium text-muted-foreground">{item.detail}</small>
      </button>)}
    </div>}

    <div className="grid grid-cols-1 items-start gap-5.5 min-[980px]:grid-cols-[200px_minmax(0,1fr)]
      min-[1220px]:grid-cols-[220px_minmax(0,1fr)_178px]">
      <aside className="sticky top-5 max-h-[calc(100vh-40px)] overflow-y-auto pr-2 [scrollbar-width:thin]
        max-[980px]:static max-[980px]:max-h-none max-[980px]:p-0" aria-label="帮助目录">
        {query ? <>
          <div className="flex min-h-7 items-center justify-between px-2 text-xs font-extrabold text-faint">
            <span>搜索结果</span>
            <b className="min-w-5 rounded-full bg-surface-3 px-1.5 py-px text-center text-xs leading-[18px] text-muted-foreground">{articles.length}</b>
          </div>
          {articles.length === 0 && <div className="my-2 rounded-xl border border-dashed border-line-strong bg-surface-2 p-3.5 text-muted-foreground">
            <strong className="text-[13px] text-text">没有直接匹配</strong>
            <p className="mt-1 text-xs leading-[1.55]">试试更短的词，或到许愿墙描述你遇到的场景。</p>
          </div>}
          {articles.map((item) => <button type="button" key={item.id}
            onClick={() => select(item.id)}
            className={cn("my-0.5 grid w-full cursor-pointer gap-[3px] rounded-[10px] border px-2.5 py-2.5 text-left",
              "text-muted-foreground hover:bg-surface-2 hover:text-text",
              item.id === article.id && "border-primary/15 bg-surface-3 text-primary")}>
            <strong className="text-[13px] leading-[1.35]">{item.title}</strong>
            <small className="line-clamp-2 text-xs font-medium leading-[1.45] text-muted-foreground">{item.summary}</small>
          </button>)}
        </> : GROUPS.map((group) => {
          const items = articles.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return <div className="[&+&]:mt-4.5 max-[980px]:grid max-[980px]:grid-cols-2 max-[980px]:gap-[3px]" key={group}>
            <div className="flex min-h-7 items-center justify-between px-2 text-xs font-extrabold text-faint
              max-[980px]:col-span-2">
              <span>{group}</span>
              <b className="min-w-5 rounded-full bg-surface-3 px-1.5 py-px text-center text-xs leading-[18px] text-muted-foreground">{items.length}</b>
            </div>
            {items.map((item) => <button type="button" key={item.id}
              onClick={() => select(item.id)}
              className={cn("my-0.5 grid w-full cursor-pointer gap-[3px] rounded-[10px] border px-2.5 py-2.5 text-left",
                "text-muted-foreground hover:bg-surface-2 hover:text-text",
                item.id === article.id && "border-primary/15 bg-surface-3 text-primary")}>
              <strong className="text-[13px] leading-[1.35]">{item.title}</strong>
            </button>)}
          </div>;
        })}
      </aside>

      <article className="min-w-0 overflow-hidden rounded-[18px] border border-line bg-surface shadow-xs">
        <header className="px-[38px] pt-[34px] pb-[25px] max-[980px]:px-5">
          {/* #220 面包屑换 Breadcrumb 原语:nav>ol 语义归位,原 .help-breadcrumb
              色彩字阶迁为令牌工具类;「／」分隔符随 BreadcrumbSeparator 保留。 */}
          <Breadcrumb>
            <BreadcrumbList className="gap-[5px] text-xs font-extrabold text-(--accent)">
              <BreadcrumbItem>{article.group}</BreadcrumbItem>
              <BreadcrumbSeparator className="text-(--faint)">／</BreadcrumbSeparator>
              <BreadcrumbItem>{article.audience}</BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h2 className="mt-2.5 mb-2 text-[clamp(26px,2.5vw,36px)] font-bold leading-[1.2] tracking-[-0.04em] text-text-strong">{article.title}</h2>
          <p className="m-0 text-[15px] text-muted-foreground">{article.summary}</p>
          <div className="mt-4.5 flex flex-wrap gap-2">
            <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted-foreground">{article.minutes} 分钟读完</span>
            <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted-foreground">{article.steps.length} 个关键步骤</span>
          </div>
        </header>

        {article.screenshots?.map((shot) => <ArticleScreenshot key={shot.src} shot={shot} />)}

        <section className="mx-[38px] border-y border-line py-7 max-[980px]:mx-5" aria-labelledby="help-steps-title">
          <div><span className="text-xs font-extrabold text-primary">照着做</span>
            <h3 id="help-steps-title" className="mt-1 mb-4 text-lg tracking-[-0.02em] text-text-strong">关键步骤</h3></div>
          <ol className="m-0 grid list-none gap-3.5 p-0">{article.steps.map((step, index) => <li key={step.title}
            className="grid grid-cols-[34px_minmax(0,1fr)] gap-[11px]">
            <span className="grid size-8 place-items-center rounded-[10px] border border-primary/20 bg-surface-3
              text-xs font-extrabold text-primary">{String(index + 1).padStart(2, "0")}</span>
            <div className="pt-px"><strong className="block text-[13px] text-text-strong">{step.title}</strong>
              <p className="mt-0.5 text-xs leading-[1.55] text-muted-foreground">{step.detail}</p></div>
          </li>)}</ol>
        </section>

        <div className="px-[38px] pt-7 pb-9 max-[980px]:px-5"><Markdown text={article.body} /></div>

        {relatedArticles.length > 0 && <footer className="border-t border-line bg-surface-2 px-[38px] pt-6 pb-[34px] max-[980px]:px-5">
          <span className="text-xs font-extrabold text-faint">接着看</span>
          <div className="mt-2.5 grid gap-2">{relatedArticles.map((related) => {
            return <button type="button" key={related.id}
              onClick={() => select(related.id)}
              className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-[11px]
                border border-line bg-surface px-3.5 py-3 text-left hover:border-primary/40">
              <strong className="text-[13px] text-text">{related.title}</strong>
              <small className="truncate text-xs font-medium text-muted-foreground">{related.summary}</small>
              <i aria-hidden className="col-start-2 row-span-2 self-center not-italic text-primary">→</i>
            </button>;
          })}</div>
        </footer>}
      </article>

      <aside className="sticky top-5 hidden text-muted-foreground min-[1220px]:block" aria-label="本页重点">
        <span className="mb-2.5 block text-xs font-extrabold text-faint">本页重点</span>
        <ol className="m-0 grid list-none gap-2.5 p-0">{article.steps.map((step, index) => <li key={step.title}
          className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-[7px]">
          <i className="grid size-5 place-items-center rounded-md bg-surface-3 text-xs font-extrabold
            not-italic text-primary">{index + 1}</i>
          <span className="pt-px text-xs font-semibold leading-[1.5]">{step.title}</span>
        </li>)}</ol>
        <div className="mt-5 rounded-[11px] border border-line bg-surface-2 p-3.5">
          <strong className="text-xs text-text">还是处理不了？</strong>
          <p className="mt-1 text-xs leading-[1.6]">到许愿墙提交场景、任务链接和脱敏截图。平台会明确标记是否接纳与何时闭环。</p>
        </div>
      </aside>
    </div>
  </section>;
}
