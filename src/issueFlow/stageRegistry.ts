/**
 * 固定流程的阶段注册表——阶段规则的唯一事实源(问题域自有,不进内核)。
 *
 * 此前阶段知识散在三处,改一个阶段要同步三处,还会静默漂移:阶段简报
 * (prompt.ts 的 FIXED_STAGE_BRIEFS,引导层)手工复写每阶段的工具清单;
 * 工具门禁白名单(tools.ts 的 gateStage/gateStageFrom 调用点,权威层)
 * 独立硬编码;闸门裁决(service.ts 的 resolveGate)里另有写死的阶段
 * 分支。漂移有实锤:无单 conclude 的简报写着 submit_analysis,门禁却
 * 只在 analyze 放行——AI 被告知能用的工具,调用会被机械拒绝。
 *
 * 现在一张表定规矩:每个阶段一行,声明显示名(label)、目标(goal)、
 * 出口(exit)、出口动作(exitAction)、开放工具(tools)与出口闸
 * (gate);无单三节点与有单五阶段共用同一机制(prep_repo/analyze
 * 两场景同格,conclude 只属无单路线)。阶段简报、门禁白名单、裁决
 * 阶段分支全部由本表生成——简报与门禁读同一列 tools,引导层说能用
 * 的与权威层放行的永远一致;工具回执的交接文案也走本表的
 * stageBriefLines,不再手写。往后给阶段加技能/资料门槛只是加一列
 * requiredResources(本版只预留字段,不实现门槛逻辑)。
 *
 * 词表与路线也住这里:阶段推进的机械操作(fixedAdvance 等)留在
 * state.ts,它们查本表的路线;本表只声明规则,不做任何状态变更。
 */

import type { IssueGateKind, IssueScenario } from "./state.ts";

// ---- 阶段词表与路线 ----

/** 有单场景五阶段(2026-09-02 拍板:换库环境验证封存下线,见
 * ADR-0013——mr_green 全绿即流程收口,归档前可续聊返工)。 */
export const FIXED_TICKET_STAGES = [
  "dts_info",      // 获取 DTS 单信息(通读单据后 complete_stage 自报收口)
  "prep_repo",     // 拉取代码仓+创建分支(拉齐后 complete_stage 自报收口,无需代码仓也由它跳过)
  "analyze",       // 问题分析:循证定位,产出四章节分析报告(submit_analysis 触发人工闸)
  "fix",           // 问题修改:TDD 节奏,先写复现单测再改码转绿,UT 属于本阶段(report_ut 事实上报)
  "mr_green",      // 提交 MR+流水线跑绿(建齐 MR 后 complete_stage 申报清单,平台验绿收口)
] as const;

/** 无单场景三节点:测试/开发自行定位用,结论"是问题"即闭环归档出提单模板。 */
export const FIXED_NO_TICKET_STAGES = [
  "prep_repo",     // 拉取代码仓(无单不建分支——分支名规范需要单号)
  "analyze",       // 问题分析(同有单,产出报告)
  "conclude",      // 确定结论(平台闸:是问题→闭环出提单模板 / 非问题→闭环)
] as const;

/** 固定流程的阶段键(问题域唯一的阶段词表)。 */
export type FixedStage =
  | (typeof FIXED_TICKET_STAGES)[number]
  | (typeof FIXED_NO_TICKET_STAGES)[number];

// ---- 注册表本体:每阶段一行 ----

/** 阶段开放的一个平台工具。name 是工具工厂里的注册名(门禁按它比对);
 * note 只是简报里的用途注记(如「重查」),不参与门禁。 */
export interface IssueStageTool {
  name: string;
  note?: string;
}

/** 阶段出口举的平台闸与裁决后的阶段去向。resolveGate 的阶段分支
 * 查这里——确认后推进到哪(confirmTo)、补充意见后回流到哪
 * (reworkTo)都是阶段知识,不再写在裁决代码里。 */
export interface IssueStageGate {
  kind: IssueGateKind;
  /** 用户确认/通过出口闸后推进到的阶段。 */
  confirmTo?: FixedStage;
  /** 用户补充意见后回到的阶段(同域返工,不换问题)。 */
  reworkTo?: FixedStage;
}

/** 阶段出口动作——每个阶段有且只有一个出口,全流程只有两种形态:
 * complete_stage = AI 判断目标达成后自报收口(平台不核实其工作事实);
 * 其余值 = 卡工具本身(submit_analysis/build_deploy)就是出口,举卡
 * 阶段没有 complete_stage 可绕。本列是声明与对账用:门禁白名单仍以
 * tools 列为准,两列不一致在测试里当场红。 */
export type StageExitAction =
  | "complete_stage"
  | "submit_analysis"
  | "build_deploy";

export interface IssueStageSpec {
  /** 阶段显示名(有单口径;无单不同的用 noTicketLabel 覆写)。 */
  label: string;
  /** 无单场景的显示名覆写(目前只有 prep_repo:无单不建分支)。 */
  noTicketLabel?: string;
  // 阶段引导语(2026-09-06,ADR-0017)不在本表:goal 的自由引导部分
  // 外置 assets/issue-prompts/briefs.md(锚点 stage.<名>),渲染时由
  // 调用方取文案传入 stageBriefLines;本表只留与门禁/出口同源的
  // 契约列(exit/tools/exitAction)。
  /** 出口——"到什么程度算完"的白纸黑字,停机合法性只认出口动作。 */
  exit: string;
  /** 出口动作(见 StageExitAction):四阶段=complete_stage 自报;
   * 三个举卡阶段=卡工具本身。 */
  exitAction: StageExitAction;
  /** 本阶段开放的平台工具。引导层(简报的"可用工具")与权威层
   * (工具门禁白名单)读同一列——两边的工具清单由构造保证一致。 */
  tools: readonly IssueStageTool[];
  /** 必读资源扩展位(技能/资料门槛的预留列):本版只声明,不实现
   * 门槛逻辑;哪天要"没读过不许出阶段",加数据不加机制。 */
  requiredResources?: readonly string[];
  /** 出口闸(仅出口举闸的阶段声明;env_needed 不绑阶段,不在此列)。 */
  gate?: IssueStageGate;
  /** 入口闸(ADR-0011):平台在阶段转移**进**本阶段时机械举,与出口闸
   * 相对。裁决不走 gateVerdict 的单码分派(作答是 selection 专用口,
   * 与 env_needed 表单同款),也不表达 confirmTo/reworkTo——它不清场
   * 推进,只在阶段开始前收一道人为圈选。 */
  entryGate?: { kind: IssueGateKind };
}

/**
 * 阶段注册表。工具列 = 该阶段门禁实际放行的全集(含工读类:
 * request_env(缺网管环境举配置卡)与 select_environment(用户对话
 * 给出 IP 时按台账直选)全程可调、dts_get_ticket 任意阶段可重查、
 * get_issue_meta
 * 任意阶段可查登记元信息,2026-08-28 拍板"作业自由,门只守流程出口
 * 与出厂动作",所以它们每行都在)。
 */
export const FIXED_STAGE_SPECS: Record<FixedStage, IssueStageSpec> = {
  dts_info: {
    label: "获取 DTS 单信息",
    exit: "通读单据后调 complete_stage 申报完成(dts_get_ticket 返回成功只是材料到位,不会自动推进)",
    exitAction: "complete_stage",
    tools: [
      { name: "dts_get_ticket" },
      { name: "complete_stage" },
      { name: "request_env" },
      { name: "select_environment" },
      { name: "get_issue_meta" },
    ],
  },
  prep_repo: {
    label: "拉取代码仓·建分支",
    noTicketLabel: "拉取代码仓",
    exit: "要用的仓都 pull_repo 拉齐 → complete_stage 申报完成;无需代码仓则直接 complete_stage 跳过",
    exitAction: "complete_stage",
    tools: [
      { name: "pull_repo" },
      { name: "complete_stage" },
      { name: "request_env" },
      { name: "select_environment" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
    ],
  },
  analyze: {
    label: "问题分析",
  exit: "issue-analysis.md 写完 → submit_analysis 提交,平台把确认卡转给用户",
  exitAction: "submit_analysis",
  // 入口闸已拆除(ADR-0014,2026-09-03):skill 是渐进式发现(编排
  // 技能先列索引再按需读),描述没命中是维护者该修的描述,不该用运行
  // 时人工圈选来补。skill_select 闸封存:新卡永不举(存量随挂起退役
  // 消失,ADR-0048)。
  tools: [
    { name: "request_env" },
    { name: "select_environment", note: "用户对话给出 IP 直选" },
    { name: "get_issue_meta" },
    { name: "dts_get_ticket", note: "重查" },
    { name: "pull_repo", note: "补仓" },
    { name: "remove_repo", note: "用户指派移除无关仓" },
    { name: "submit_analysis" },
  ],
  gate: { kind: "analysis_confirm", confirmTo: "fix" },
},
  fix: {
    label: "问题修复",
    exit: "所有涉及的仓改完、自检与单测可接受 → complete_stage 推进到"
      + "「提交 MR·跑绿」(推送、建 MR 与流水线验绿都在下一阶段,本阶段"
      + "不写远端,无须等绿)",
    exitAction: "complete_stage",
    tools: [
      { name: "request_env", note: "缺网管环境先要配置" },
      { name: "select_environment", note: "用户对话给出 IP 直选" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo", note: "补仓" },
      { name: "remove_repo", note: "用户指派移除无关仓" },
      { name: "sync_branch", note: "远端有用户手改时按需同步" },
      { name: "report_ut", note: "记录 UT 结果" },
      { name: "complete_stage" },
    ],
  },
  mr_green: {
    label: "提交 MR·跑绿",
    exit: "对每个改过的仓 push_branch + create_mr,然后 complete_stage 申报 MR 清单"
      + "(平台核验清单与实际一致、流水线全绿:全绿进下一阶段,有红当场打回,在跑等绿)",
    exitAction: "complete_stage",
    tools: [
      { name: "push_branch" },
      { name: "sync_branch", note: "按需同步远端修复分支" },
      { name: "create_mr" },
      { name: "complete_stage", note: "申报 MR 清单" },
      { name: "request_env" },
      { name: "select_environment" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo" },
    ],
  },
  conclude: {
    label: "确定结论",
    exit: "结论明确 → submit_analysis 提交,等用户在「结论确认」卡上作答",
    exitAction: "submit_analysis",
    // 出口动作 submit_analysis 是在 analyze 调的(调完即推进到本节点
    // 等闸),本阶段不再放行它——工具列以门禁真相为准,简报不谎报。
    tools: [
      { name: "request_env" },
      { name: "select_environment" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo" },
    ],
    gate: { kind: "conclude", reworkTo: "analyze" },
  },
};

// 调查、测试取证和检视分诊是通用能力,全程可调:移除仓(#240)跟随
// 用户指派(门禁在工具层:模块绑定仓/远端分支在/不可判定三类机械拒);
// 检视分诊(ADR-0035)的 respond_review/declare_review_rework 意见可能
// 在任何阶段送达(提交通道本就运行中交办,#284)。「阶段只组织出口,
// 不禁止工具」的例外是交付类:push_branch/create_mr 会启动流水线监看、
// 验绿门以 MR 台账为收口半边,与「提交 MR·跑绿」的阶段语义绑定,收敛
// 为该阶段独占(#373,ADR-0050);无单路线不含该阶段,天然不交付代码。
for (const spec of Object.values(FIXED_STAGE_SPECS)) {
  for (const name of ["pull_repo", "remove_repo", "report_ut",
    "respond_review", "declare_review_rework"]) {
    if (!spec.tools.some(tool => tool.name === name)) spec.tools = [...spec.tools, { name }];
  }
}

export const STAGE_ROUTES: Record<IssueScenario, readonly FixedStage[]> = {
  ticket: FIXED_TICKET_STAGES,
  no_ticket: FIXED_NO_TICKET_STAGES,
  mr_repair: ["mr_green"],
};

export function fixedStages(scenario: IssueScenario): readonly FixedStage[] {
  return STAGE_ROUTES[scenario];
}

/** 固定流程路线里的位次(不在本场景路线里的阶段一律 -1)。 */
export function fixedStageIndex(
  scenario: IssueScenario, stage: FixedStage,
): number {
  return STAGE_ROUTES[scenario].indexOf(stage as FixedStage);
}

/** 阶段显示名(按场景取词;prep_repo 两场景叫法不同)。 */
export function fixedStageLabel(scenario: IssueScenario, stage: FixedStage): string {
  const spec = FIXED_STAGE_SPECS[stage];
  if (scenario === "mr_repair" && stage === "mr_green") return "修复已有 MR 流水线";
  return scenario === "no_ticket" && spec.noTicketLabel
    ? spec.noTicketLabel
    : spec.label;
}

/** 场景 × 阶段的完整显示名词表(state.ts 沿用的导出形状)。 */
export const FIXED_STAGE_LABELS: Record<IssueScenario, Record<FixedStage, string>> = {
  mr_repair: Object.fromEntries(
    (Object.keys(FIXED_STAGE_SPECS) as FixedStage[]).map(stage => [stage, fixedStageLabel("mr_repair", stage)]),
  ) as Record<FixedStage, string>,
  ticket: Object.fromEntries(
    (Object.keys(FIXED_STAGE_SPECS) as FixedStage[]).map((stage) =>
      [stage, fixedStageLabel("ticket", stage)]),
  ) as Record<FixedStage, string>,
  no_ticket: Object.fromEntries(
    (Object.keys(FIXED_STAGE_SPECS) as FixedStage[]).map((stage) =>
      [stage, fixedStageLabel("no_ticket", stage)]),
  ) as Record<FixedStage, string>,
};

/** 阶段规格(fail-loud:未知阶段当场响,不让 undefined 溜进提示词)。 */
export function fixedStageSpec(stage: FixedStage): IssueStageSpec {
  const spec = FIXED_STAGE_SPECS[stage];
  if (!spec) {
    throw new Error(`固定流程没有这个阶段: ${String(stage)}`);
  }
  return spec;
}

// ---- 门禁视角(权威层:工具工厂的越权拒绝查这里) ----

/** 这个阶段放行这个工具吗。stage 不在场景路线里(异常现场)一律拒绝。 */
export function stageAllowsTool(
  scenario: IssueScenario, stage: FixedStage, tool: string,
): boolean {
  if (!STAGE_ROUTES[scenario].includes(stage)) return false;
  if (scenario === "mr_repair" && ["create_mr", "request_env", "select_environment", "dts_get_ticket"].includes(tool)) return false;
  return FIXED_STAGE_SPECS[stage]?.tools.some((entry) => entry.name === tool)
    ?? false;
}

/** 反查:某工具在本场景的哪些阶段开放(拒绝文案的"允许的阶段")。 */
export function stagesAllowingTool(
  scenario: IssueScenario, tool: string,
): FixedStage[] {
  return STAGE_ROUTES[scenario].filter((stage) =>
    stageAllowsTool(scenario, stage, tool));
}

/** 注册表登记过的全部工具名(等价性对账的枚举域)。 */
export function registeredStageTools(): string[] {
  const names: string[] = [];
  for (const spec of Object.values(FIXED_STAGE_SPECS)) {
    for (const tool of spec.tools) {
      if (!names.includes(tool.name)) names.push(tool.name);
    }
  }
  return names;
}

// ---- 简报视角(引导层:提示词的"可用工具"行查这里) ----

/** 阶段简报的工具行:与门禁同一列 tools,只多渲染用途注记。 */
export function stageToolLine(stage: FixedStage, scenario?: IssueScenario): string {
  return fixedStageSpec(stage).tools
    .filter(tool => !scenario || stageAllowsTool(scenario, stage, tool.name))
    .map((tool) => (tool.note ? `${tool.name}(${tool.note})` : tool.name))
    .join("、");
}

/** 阶段简报三行(引导层单点):当前阶段「X」:goal / 出口:exit /
 * 可用工具:tools。开场词、交接词、催办词、工具回执共用——工具回执
 * 也从这里生成,消灭手写交接文案;label 按场景取词(prep_repo 两
 * 场景叫法不同)。 */
export function stageBriefLines(
  scenario: IssueScenario, stage: FixedStage, guidance: string,
): string[] {
  const spec = fixedStageSpec(stage);
  if (scenario === "mr_repair") return [
    "当前阶段「修复已有 MR 流水线」：读取已有 MR 的失败材料，只修复编译、测试和代码质量问题。",
    "先用 pull_repo 拉取 MR 的源分支，拉取完成后检查当前提交的流水线报错。首次按仓库标准完整构建，后续复用同一工作区增量验证；提交后用 push_branch 推送原分支，再用 complete_stage 申报已有 MR。",
    "不新建 MR、不绑定 DTS、不重走问题分析；检视意见不自动修改，不推进审批、合入或归档；工具记录不计入 DTS 交付统计。",
    `可用工具：${stageToolLine(stage, scenario)}。`,
  ];
  return [
    `当前阶段「${fixedStageLabel(scenario, stage)}」: ${guidance}`,
    `怎么算完: ${spec.exit}`,
    `可用工具: ${stageToolLine(stage)}`,
  ];
}

// ---- 举卡决策码(裁决协议:按码分派,文案只管显示) ----

/** 闸卡的一个选项。code 是裁决协议(resolveGate 按 code 单点分派,
 * 前端提交回传 code);label 只是给人看的文案——改文案零协议后果,
 * 旧协议里文案前缀/包含就是匹配键,改一个字裁决静默 409(实锤债务)。 */
export interface GateOption {
  code: string;
  label: string;
}

/** 每类闸的码表行:选项整表 + 推荐码(ADR-0004 平台闸同款推荐)。
 * recommended 是宿主能定的推荐(值为 options 里的码,前端按它标
 * 「AI 推荐」);宿主定不了的留空——无单结论从 AI 的结论提案派生
 * (见 gateRecommendedCode),换库验证通过与否只有用户知道,不硬给。 */
export interface GateOptionTable {
  options: readonly GateOption[];
  /** 宿主码表定死的推荐码;缺省=该闸不由码表定推荐。 */
  recommended?: string;
}

/** 每类闸的码表(码+文案对,附推荐码)。raiseGate 举卡时整表投影进
 * 闸卡,resolveGate 按码裁决,前端渲染 label、提交 code——文案的定义
 * 地只此一处,「改字两处要同步」的自警从此作废。 */
export const GATE_OPTIONS: Record<IssueGateKind, GateOptionTable> = {
  analysis_confirm: {
    // 分析确认的推荐就是放行:报告已过 submit_analysis 的文件门票,
    // 平台没有更多事实可核,推荐摇摆只会把用户拖回追问循环。
    options: [
      { code: "confirm", label: "确认报告,开始问题修复" },
      { code: "supplement", label: "有补充意见(填写补充说明)" },
    ],
    recommended: "confirm",
  },
  conclude: {
    // 结论推荐跟 AI 提案走(提案是问题→推荐「是问题」码),不在此定死。
    options: [
      { code: "issue", label: "确认是问题,闭环归档出提单模板" },
      { code: "non_issue", label: "确认非问题,闭环归档" },
      { code: "supplement", label: "有补充意见(填写补充说明)" },
    ],
  },
  env_verify: {
    // 通过没有按钮(ADR-0034 修订,2026-09-19):MR 全部合入即视为
    // 验证通过并自动归档——卡只收「发现问题」这一种人工事实,
    // 沉默到合入就是通过。通过与否只有用户知道,不硬给推荐。
    options: [
      { code: "fail", label: "验证发现问题(填写补充说明)" },
    ],
  },
  // env_needed 在决策卡上渲染为专用表单(地址+密码),作答口是
  // /environment,不走选项裁决;这个选项只是卡面占位,自然无推荐。
  env_needed: {
    options: [
      { code: "fill", label: "填写并继续" },
    ],
  },
  skill_select: {
    // skill 圈选(ADR-0011)是多选闸:勾选清单走 answer 的 selection
    // 专用口(与 env_needed 表单同款),这里的码表只是"都不用"的
    // 单码通道——空选=AI 按取用次序自主,不算异常。无推荐:推荐的
    // 唯一消费方是月光代答,而本卡只在月光关时举起,永远人答。
    options: [
      { code: "skip", label: "都不用,AI 按取用次序自主" },
    ],
  },
  pipeline_unfixable: {
    // 流水线不可修告警(2026-09-01,票 03):红灯失败项全是不可自动
    // 修复的工具告警,问的是"人是否已在交付平台处理/豁免"这一人工
    // 事实——宿主无从核验,月光永不代答(与 env_verify 同类),故无
    // 推荐码。作答即开跑:重置该仓监看账,重新监看同一 SHA。
    options: [
      { code: "resume", label: "已在平台处理/豁免,重新监看" },
    ],
  },
  pipeline_evidence: {
    // 流水线证据回灌(同票):主通道是卡上的自由文本(粘贴报错原文),
    // 码只是提交凭据(只贴文本不带码也认,见 service 的归码);无推荐
    // ——原文只有人拿得到,机器不代写(月光代答同此守卫)。
    options: [
      { code: "supply", label: "已粘贴报错原文,继续修复" },
    ],
  },
};

/** 闸卡的推荐码(questions[].recommended 与 Agent 卡同一键)。分析
 * 确认取码表定死值;无单结论按 AI 提案派生——提案是问题→推荐
 * 「是问题」码,非问题同理;提案缺席不派生,宿主不替 AI 表态。 */
export function gateRecommendedCode(
  kind: IssueGateKind,
  proposal?: { conclusion?: "issue" | "non_issue" },
): string | undefined {
  if (kind === "conclude") return proposal?.conclusion;
  return GATE_OPTIONS[kind].recommended;
}

/** 码 → 文案(显示语义的还原:现场账与续聊提示词里永远是人话)。 */
export function gateOptionLabel(kind: IssueGateKind, code: string): string {
  const option = GATE_OPTIONS[kind]?.options.find((item) => item.code === code);
  return option?.label ?? code;
}

/** 闸裁决的语义动作(与改造前的分支行为逐项对齐)。分派是纯函数:
 * 只认 (kind, code),中文文案根本不是输入——文案怎么改都动不了它。 */
export type GateVerdict =
  | "advance"       // analysis_confirm+confirm:推进到 confirmTo
  | "rework"        // 有补充意见/自由作答:留在或回流分析
  | "archive"       // conclude+issue/non_issue:闭环归档(issue 出提单模板,ADR-0048)
  | "fail"          // env_verify+fail:验证发现问题回退(通过无码——合入即通过)
  | "note"          // env_verify+note:自定义答复=等待中插话,闸保持原样递 AI
  | "resume_watch"  // pipeline_unfixable+resume:重置监看账重看同一 SHA
  | "human_evidence" // pipeline_evidence+supply:原文入账,开修复回合
  | "unrecognized"; // 认不得的答复(仅 env_verify 打回,其余按补充意见)

/** 决策码分派单点。语义钉死:
 * - analysis_confirm:confirm 推进;其余(补充意见码/自由文本)一律
 *   留在分析阶段完善重提——与旧 startsWith 前缀匹配的 else 分支一致;
 * - conclude:issue 与 non_issue 都闭环归档(issue 出提单模板,
 *   ADR-0048);其余回流分析(旧的 includes 匹配同样认不得就回流);
 * - env_verify:fail 回退(通过没有码——MR 全部合入即视为通过,
 *   ADR-0034);自定义答复(服务端按文本在场归码 note,不在卡面码表)
 *   是等待中的插话——验证等很久,冒出合并冲突这类插曲要说得上话;
 *   其余认不得的原样 409。 */
export function gateVerdict(kind: IssueGateKind, code: string): GateVerdict {
  switch (kind) {
    case "analysis_confirm":
      return code === "confirm" ? "advance" : "rework";
    case "conclude":
      // ADR-0048:确认是问题与非问题都直接闭环归档(前者出提单模板),
      // 挂起与转正退役;认不得的回流分析。
      return code === "issue" || code === "non_issue" ? "archive" : "rework";
    case "env_verify":
      if (code === "fail") return "fail";
      if (code === "note") return "note";
      return "unrecognized";
    case "env_needed":
      // 作答口是配置表单;走到选项裁决即调用方违约,一律打回。
      return "unrecognized";
    case "skill_select":
      // 作答口是 selection 专用口(勾选清单)加 skip 单码,都在 service
      // 的专用分支里裁决(env_needed 同款);到不了选项分派——真到了
      // 就是调用方违约,打回。
      return "unrecognized";
    case "pipeline_unfixable":
      // 不可修告警闸只有"已在平台处理/豁免"一个出口:答了就重置监看
      // 账重看同一 SHA;认不得的答复原样打回(人工事实不猜)。
      return code === "resume" ? "resume_watch" : "unrecognized";
    case "pipeline_evidence":
      // 证据回灌闸:码(或从粘贴文本归码,见 service)即提交,文本本体
      // 才是证据;空文本在 service 的专用检查里打回,这里认不得的码
      // 同样原样打回。
      return code === "supply" ? "human_evidence" : "unrecognized";
  }
}

// ---- 闸门裁决视角(resolveGate 的阶段分支查这里) ----

export interface StageGateRoute {
  /** 举这个闸的阶段(出口动作所在)。 */
  stage: FixedStage;
  kind: IssueGateKind;
  /** 确认/通过后推进到的阶段。 */
  confirmTo?: FixedStage;
  /** 补充意见后回流到的阶段。 */
  reworkTo?: FixedStage;
}

/** 闸 kind → 所属阶段与去向。env_needed 不绑阶段(作答口是配置
 * 表单),查不到返回 undefined。 */
export function stageGateRoute(
  kind: IssueGateKind,
): StageGateRoute | undefined {
  for (const stage of Object.keys(FIXED_STAGE_SPECS) as FixedStage[]) {
    const gate = FIXED_STAGE_SPECS[stage].gate;
    if (gate?.kind === kind) {
      return { stage, ...gate };
    }
  }
  return undefined;
}

/** 入口闸反查(ADR-0011):这个阶段的转移入口要不要举闸。没有入口
 * 闸的阶段返回 undefined。ADR-0014(2026-09-03)拆除了唯一的入口闸
 * (skill 圈选),当前所有阶段都返回 undefined——函数保留给将来的
 * 入口闸形态,别为"永假"删掉类型通道。 */
export function stageEntryGate(stage: FixedStage): IssueGateKind | undefined {
  return FIXED_STAGE_SPECS[stage]?.entryGate?.kind;
}
