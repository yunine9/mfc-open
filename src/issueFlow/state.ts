/**
 * 问题会话的状态模型(问题流 v2)。
 *
 * 问题流与需求内核是两个范式:内核是固定阶段状态机,真相在
 * .mae-flow.json;问题流是"AI 在阶段内自主作业的多轮对话",
 * 平台承载阶段机与运行显示。这里的状态文件是问题域自己的账本——
 * 阶段真相在宿主(fixedAdvance 等机械操作是唯一写手,Agent 对
 * issue.json 只读),显示层 fail-open(与"前端不推断状态"同一纪律)。
 *
 * 秘密纪律:issue.json 里永远只有环境引用(id),密码在
 * IssueEnvironmentVault 的加密文件里;API/模型/事件流同此。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { repositoryIdentity } from "../knowledgeAssetModel.ts";
import { durableWriteFileSync } from "../durableWrite.ts";
import { join } from "node:path";
import type { IssueInterventionTier } from "../auth.ts";
import type { FeedbackRecord } from "../feedbackStore.ts";
import type { MrParticipantsResult } from "../mrParticipants.ts";
import { IssueControlError } from "./errors.ts";
import type { IssueWarmupReceipt } from "./warmup.ts";
import { validateRepoUrl } from "./issueGit.ts";
import {
  fixedStageIndex,
  fixedStages,
  GATE_OPTIONS,
  gateRecommendedCode,
  type FixedStage,
  type GateOption,
} from "./stageRegistry.ts";

// 固定流程的阶段词表、路线与显示名的定义在阶段注册表(stageRegistry.ts,
// 阶段规则的唯一事实源);这里沿用它一贯的导出面,老消费方不用改 import。
export {
  FIXED_NO_TICKET_STAGES,
  FIXED_TICKET_STAGES,
  FIXED_STAGE_LABELS,
  fixedStageIndex,
  fixedStages,
  type FixedStage,
} from "./stageRegistry.ts";

export type IssueSource = "manual" | "dts";

/** 会话生命周期。idle = 回合结束、对话仍开放,用户随时可以继续说;
 * 这是问题流与任务队列的根本差异——"聊完这轮"不等于"办完了"。
 * 没有"打断"态(2026-08-29 拍板):服务重启不是用户可停留的状态,
 * 正在跑的会话恢复时重新入队,由并发额度泵自动续跑。 */
export type IssueStatus =
  | "queued"         // 排队等并发额度(登记首轮与重启恢复共用)
  | "running"        // Agent 回合进行中
  | "waiting_user"   // Agent 举了 AskUserQuestion(或平台闸门),等用户作答
  | "idle"           // 回合结束,等用户下一句话
  | "archived"       // 已收口归档(结论见 conclusion)
  | "canceled"
  | "failed";

/** 有单走五阶段、无单走三节点；已有 MR 只进入流水线修复阶段。 */
export type IssueScenario = "ticket" | "no_ticket" | "mr_repair";

/** 固定流程单个阶段的执行状态(inherited=转正继承,redo=回退待重做)。 */
export type StageState =
  | "pending"
  | "in_progress"
  | "done"
  | "inherited"
  | "redo";

export function initStageStates(
  scenario: IssueScenario, inherited: number,
): StageState[] {
  const total = fixedStages(scenario).length;
  return Array.from({ length: total }, (_, index) =>
    index < inherited ? "inherited" : "pending");
}

/** 阶段转移日志:Agent 声明(source=agent)与平台机械事实(source=
 * platform,如推送成功/建 MR/绑单号)同账收记,各是各的真相——显示层
 * 只认 state.stage,这里只服务审计与排障("为什么卡在对齐方案三小时")。 */
export interface StageTransition {
  at: string;
  source: "agent" | "platform";
  stage?: FixedStage;
  note: string;
}

export type IssueConclusionKind =
  | "non_issue"   // 非问题(误报/需求误解/无法复现)
  | "delivered"   // 修复完成即交付(合入与否看 mrs 账,不进结论,ADR-0037)
  | "issue";      // 确认是问题(现行为:直接闭环归档出提单模板,ADR-0048;存量含挂起转正收口,血缘见 converted_to)

export interface IssueEnvironmentConfig {
  /** 环境引用(vault 里的 id);凭据永不进状态文件。 */
  credential_ref: string;
  name: string;
  /** 网管服务器地址列表(playbook 二进制支持多台串行)。 */
  hosts: string[];
  port: number;
  /** 独立 root 密码组的 vault 引用(ADR-0020/#150:台账条目显式设置
   * root 密码时快照才有;缺席=继承后台密码,消费面与手填时代的会话
   * 行为完全一致,不落独立凭据)。 */
  root_credential_ref?: string;
  /** 快照来源(ADR-0020「选入即快照」,非密):登记/env_needed 闸从
   * 环境台账选入时记录选定时点的台账主 IP,展示"来自环境管理 x.x.x.x"
   * 用;手填环境整字段缺席,前端与 AI 消费不受影响。 */
  environment_source_ip?: string;
  /** 环境形态(虚拟化/容器化 K8s,登记页面或 env_needed 卡人工选定;
   * 缺席=形态未登记的存量环境,AI 举卡补配时一并补齐)。 */
  env_type?: IssueEnvType;
}

export interface IssueConclusion {
  kind: IssueConclusionKind;
  summary: string;
  at: string;
}

export interface IssueMrRecord {
  /** MR 所属仓(地址);多仓会话一仓一 MR,各记各的。 */
  repo: string;
  branch: string;
  /** 目标分支(create_mr 申报,缺省=会话基线):合入事实核对要成对分支。 */
  target?: string;
  title: string;
  url?: string;
  iid?: string;
  at: string;
  /** MR 链接与人员设置分别记结果，人员设置失败不丢掉已创建的 MR。 */
  participants?: MrParticipantsResult;
  /** 合入事实(ADR-0022,监听轮询向平台读取):时刻为首次观测,
   * 不冒充平台动作时间;merged_sha 照平台返回记,不要求与验绿 SHA
   * 相同——合入的是 merge/squash 产物。 */
  merged_at?: string;
  merged_sha?: string;
  closed_at?: string;
}

export interface IssuePushRecord {
  repo: string;
  branch: string;
  sha: string;
  at: string;
}

/** 推送前基线同步账(ADR-0071,按仓):宿主把基线新提交并进修复分支
 * 的事实记录;同仓重推覆盖同仓旧账。内部机制账,不上 wire。 */
export interface IssueBaselineSyncRecord {
  repo: string;
  baseline: string;
  /** 并入前修复分支所基于的基线提交(merge-base)。 */
  from: string;
  /** 本次并入的基线新头。 */
  to: string;
  commits: number;
  at: string;
}

/** 平台问题卡(固定流程的人工闸)。与 Agent 的 AskUserQuestion 挂起
 * (humanGate/waiting.json)是并行的两条机制:平台闸由宿主写进
 * issue.json——Agent 对该文件只读,推不动闸门,这正是"固定流程"
 * 的强制度所在。渲染层复用问题卡组件(形状与 waiting 卡同构)。
 * 代码仓缺口不走平台闸(2026-08-28 拍板退役 repo_needed):AI 用
 * pull_repo/AskUserQuestion 自己闭环(模块发起即定局,ADR-0056)。 */
export type IssueGateKind =
  | "analysis_confirm" // 报告确认:放行进入问题修改
  | "conclude"         // 无单结论:是问题→闭环出提单模板 / 非问题→闭环
  | "env_verify"       // 环境验证:发现问题→回退问题分析;通过无需作答
                       // ——MR 全部合入即视为通过并自动归档(ADR-0034)
  | "env_needed"       // 网管环境:拉日志/换库缺地址与密码时现场补配(2026-08-28)
  | "skill_select"     // skill 圈选(ADR-0011):analyze 入口的多选闸,
                       // 对齐档由归属人圈定业务仓 skill 必读集合;
                       // 作答走 selection 专用口(与 env_needed 表单同款)。
  | "pipeline_unfixable" // 流水线不可修告警(2026-09-01,票 03):红灯失败项
                         // 全是不可自动修复的工具告警——人在交付平台处理/
                         // 豁免后于卡上作答,平台重置监看账重看同一 SHA;
                         // 问的是人工处理事实,任何介入档位都不代答。
  | "pipeline_evidence"; // 流水线证据回灌(同票):红灯但没有一条可定位的
                         // 具体报错,为免猜改停机——请人把报错原文粘贴进
                         // 作答(自由文本),作答即证据回灌+续跑修复回合。

/** env_needed 闸的用途面:决策卡据此给表单文案,服务端清闸后提示重试。 */
export type IssueGateScope = "logs" | "deploy";

/** 用途面的人话(拒绝按钮文案/转移账/平台通知按它分叉,票 93)。
 *  service 与 tools 两处消费,单一来源在此——不许各写一份漂移。 */
export const ENV_SCOPE_LABELS: Record<IssueGateScope, string> = {
  logs: "拉日志",
  deploy: "换库部署",
};

/** 网管环境形态(2026-09-06 拍板):决定日志抓取走哪套引擎——
 * virtualized=虚拟化(网管节点 ipmc_adm 发现后台节点),k8s=容器化
 * (OM 节点 kubectl 发现 Pod)。登记页面与 env_needed 配置卡都是
 * 人工下拉选定,AI 只读不猜、不试错。 */
export type IssueEnvType = "virtualized" | "k8s";

/** 形态的人话(元信息行/转移账/配置回执消费,单一来源在此)。 */
export const ENV_TYPE_LABELS: Record<IssueEnvType, string> = {
  virtualized: "虚拟化",
  k8s: "容器化(K8s)",
};

/** 环境拒绝台账(2026-09-03,票 93):归属人在 env_needed 卡上拒绝
 * 拉日志/换库——这是人的硬裁定。字段在场=清单里的 scope 已被拒:
 * 同 scope 工具再调不再举闸(防纠缠),配置环境成功即整册清除
 * (解锢,见 attachEnvironment)。不上 wire(与 mr_gate 同为流程机制
 * 状态,前端镜像没有这个字段)。 */
export interface IssueEnvDeclined {
  /** 已拒的用途面。 */
  scopes: IssueGateScope[];
  /** 最近一次拒绝的时刻(同 scope 重复拒绝刷新清单与时刻)。 */
  at: string;
}

/** skill 圈选清单里的一项(ADR-0011):扫描已拉仓 `.cac/skills/` 所得。
 * path 是会话工作区相对路径(repo/<仓名>/.cac/skills/<名>/SKILL.md),
 * 天然唯一——多仓同名 skill 靠仓段区分;repo 是仓地址(分组展示用)。 */
export interface IssueSkillChoice {
  path: string;
  repo: string;
  name: string;
  description: string;
}

/** 圈选台账(ADR-0011):字段在场=归属人已作答(skills 空=明确"都不用",
 * AI 按取用次序自主)。重走 analyze 不重举的判据就是它在不在。 */
export interface IssueSkillSelection {
  at: string;
  skills: IssueSkillChoice[];
}

/** 业务知识台账的单项(ADR-0012):团队资产库按绑定模块定格的已发布
 * 知识资产,只读投影在 .mae-flow-work/business-modules/ 下。 */
export interface IssueBusinessKnowledgeEntry {
  id: string;
  module_id: string;
  module_name: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: string;
  version: number;
  /** 会话工作区相对路径(渲染业务知识地图直接用)。 */
  relative_path: string;
}

/** 业务知识台账(ADR-0012):字段在场=进入 analyze 时已按当时的绑定
 * 模块定格过;重启/续聊按它渲染地图,版本不随发布库中途更新漂移
 * (与需求侧"按任务固定版本"同一纪律)。entries 空=绑定的模块没有
 * 已发布资产(或会话没绑模块——整个字段缺席)。 */
export interface IssueBusinessKnowledge {
  at: string;
  entries: IssueBusinessKnowledgeEntry[];
}

export interface IssueGate {
  id: string;
  kind: IssueGateKind;
  /** 作答幂等基准:创建时的 transitions 长度,对不上即状态已变。 */
  state_version: number;
  /** 选项携带码+文案对(出自 stageRegistry 的 GATE_OPTIONS):前端
   * 渲染 label、提交 code,裁决按码单点分派——文案改字零协议后果。
   * recommended 是本闸的推荐码(ADR-0004,与 Agent 卡同一键):码表
   * 定死或从提案派生(gateRecommendedCode),宿主定不了的缺席。 */
  question: {
    questions: Array<{
      question: string;
      options: GateOption[];
      recommended?: string;
    }>;
  };
  context?: string;
  /** 仅 env_needed:闸为哪类动作而举(logs=拉日志 / deploy=换库部署)。 */
  scope?: IssueGateScope;
  /** 仅 skill_select:扫描所得的圈选清单(动态数据,不是文案——文案
   * 仍在 GATE_OPTIONS)。作答的 selection 必须是这里 path 的子集,
   * 浏览器自报路径一律拒绝(与需求侧仓内能力发现同一纪律)。 */
  skills?: IssueSkillChoice[];
  /** 仅 pipeline_unfixable/pipeline_evidence:闸属于哪个仓的哪次提交
   * (作答后续跑按它重置监看账/注入证据——同 SHA 重新监看或带着人工
   * 原文开修复回合)。卡面(卡面与作答协议)见 stageRegistry 码表。 */
  pipeline?: { repo: string; sha: string };
  /** 机器可读提案(结论闸带 AI 的结论与摘要,用户过目后确认)。 */
  proposal?: {
    conclusion?: "issue" | "non_issue";
    summary?: string;
    report?: string;
    /** 置信度自报(ADR-0006):无单结论闸的一档全自动代答消费——non_issue
     * 且 high 才自动闭环;缺省按置信度不足处理,宁人工勿猜。 */
    confidence?: "high" | "medium" | "low";
  };
  created_at: string;
}

/** UT 验证上报(修复阶段内,事实上报):平台只记账留痕,不推进、不设门——
 * 真正的硬验证在阶段6流水线(UT 本身也在流水线里跑),阶段出口是
 * complete_stage 自报。 */
export interface IssueUtRecord {
  passed: boolean;
  summary: string;
  log_path?: string;
  round: number;
  at: string;
}

/** 流水线监看账(阶段6,宿主轮询)。重启后 watching=true 的要重新挂表。 */
export interface IssuePipelineWatch {
  sha: string;
  status: "running" | "success" | "failed";
  /** true=宿主定时器还在盯;false=已出终态或预算耗尽。 */
  watching: boolean;
  started_at: string;
  /** 轮询预算到期时刻(ISO);预算内不重复开表。预算耗尽时若还没延期过
   *  (#372),先自动延长一个完整预算再喊人,deadline 随之改写。 */
  deadline: string;
  /** 已自动延期的次数(#372):CI 高峰排队会让正常流水线(空闲期 6-10
   *  分钟出结果)在初始预算内跑不完,到期先静默延长一次再停表——
   *  真卡死的喊人从 30 分钟推到 60 分钟,是有界的代价。落盘计数,
   *  重启不多送;新一轮挂表(换 SHA/人工重看)从 0 重新计。 */
  deadline_extensions?: number;
  checks?: import("../pipelineContract.ts").PipelineCheck[];
  last_error?: string;
  round: number;
  /** 本仓累计红灯次数(绿了清零):与需求侧修复轮预算同语义——超过
   *  repair_rounds 就停止自动回灌修复,留痕请人工。 */
  reds?: number;
  /** 证据重试窗(票 82):红灯证据全缺/盲输入时不立即举卡,先记下
   *  取证截止时间,定时器每隔一段重拉镜像重新评估——产物晚到在窗内
   *  自愈(自动派发修复,人无感),到点仍缺才举 pipeline_evidence 卡。
   *  字段在场=重试窗在途;随 issue.json 落盘,重启凭它续算(不重置
   *  截止、不白等),新流水线重挂表时不随迁(旧窗随旧提交作废)。 */
  evidence_retry_deadline?: string;
  /** 重试窗内已做的重评次数(留痕/排障用,不作收手判据)。 */
  evidence_retry_attempts?: number;
  /** 进窗那次红灯的失败摘要原文(截断防膨胀):重启续算时重评的
   *  failureSummary 输入——终态处理现场的 run 不跨进程,落盘才评得动。 */
  evidence_failure_log?: string;
  /** 上次派发修复的提交(票 82 同提交刹车):红灯 SHA===它=修了没出新
   *  提交,停机不派(reds 不变),会话最后发言作诊断。派发修复时写入,
   *  跨重挂表保留(刹车判据必须跨 push/re-arm 存活),绿了清账。 */
  last_repair_sha?: string;
  /** 上轮报错摘要(维度点名+报错节选,截断防膨胀):下轮派发修复拼进
   *  回合提示词,附"同一处必须换思路"纪律(需求流 loop.failure 同
   *  语义);与 last_repair_sha 同拍写入、同拍清理。 */
  last_failure_summary?: string;
  /** 分支头是平台外提交(ADR-0041):字段在场=当前检查目标不是本会话
   *  自己推的——合入状态循环发现分支最新提交变了,检查目标跟着切过去
   *  时置位;自己推送经 armPipelineWatch 重挂时清除。红灯材料组装按它
   *  附"先拉取最新代码、看差异再修"的指引。 */
  external_head?: true;
}

/** MR 验绿门的申报账(阶段6受理路):AI 调 complete_stage 申报清单时
 * 流水线还在跑/无记录,平台先受理——监看器验绿后凭"申报在场"放行。
 * 不变量:进 deploy_verify 当且仅当"已申报且全绿",全绿当场放行与
 * 回退都要清掉它(新一轮要重新申报)。 */
export interface IssueMrGateRecord {
  /** 受理时 AI 申报的 MR 清单(归一到仓地址,一仓一 MR 下与链接等价)。 */
  mrs: string[];
  at: string;
}

/** 终止原因(#541):稳定英文值是协议,界面渲染中文——resolved=问题已
 * 处理(默认)/accidental=无需处理(原文案「误发起」,2026-11-03 更名
 * 只动文案,ADR-0072)/wrong_module=业务模块绑错/
 * inaccurate=分析不准确/slow=速度太慢/disobedient=指令不遵从/
 * unclear_plan=方案未明确/other=其他(附选填说明)。下拉顺序=排除类
 * 在前。统计侧只有负面原因计一次解决率失败;resolved、accidental
 * (无需处理)、wrong_module(模块绑错,重开登记即可)与无原因取消
 * 待遇相同(不进统计)。resolved 与 accidental 的终止另联动自动接单
 * 单级排除(ADR-0072,联动在 service 取消收口)。 */
export type IssueCancelReason =
  | "resolved"
  | "accidental"
  | "wrong_module"
  | "inaccurate"
  | "slow"
  | "disobedient"
  | "unclear_plan"
  | "other";

/** 码表单一事实:路由白名单与 UI 下拉共用这一份,顺序即下拉顺序。 */
export const ISSUE_CANCEL_REASONS: readonly IssueCancelReason[] = [
  "resolved", "accidental", "wrong_module", "inaccurate", "slow",
  "disobedient", "unclear_plan", "other",
];

/** 负面原因(#542):这些原因终止的有单会话进一次解决率分母记失败;
 *  resolved(问题已处理)、accidental(无需处理)、wrong_module(业务模
 *  块绑错)与无原因取消(历史数据)待遇相同,不进任何统计。显式列举
 *  词表——将来新增中性/负面原因时各自显式表态,不靠
 *  「非 resolved 即负面」的隐式推导漂移。 */
export const ISSUE_NEGATIVE_CANCEL_REASONS: readonly IssueCancelReason[] = [
  "inaccurate", "slow", "disobedient", "unclear_plan", "other",
];

/** 终止联动排除的原因(ADR-0072):断言这张单不再需要处理的完结类——
 *  有单会话以这些原因终止时,取消收口联动写自动接单单级排除(写入在
 *  service 取消分支)。与负面码表同款显式列举,将来新增原因各自表态。 */
export const ISSUE_CANCEL_EXCLUSION_LINK_REASONS: readonly IssueCancelReason[] = [
  "resolved", "accidental",
];

/** 词表外终止原因的统一报错(#540 复审):路由白名单与服务的 fail-loud
 *  各拒各的,但对外必须是同一句话——常量收口,不许各写一份漂移。 */
export const ISSUE_CANCEL_REASON_UNKNOWN_ERROR =
  "未知终止原因:只支持 resolved/accidental/wrong_module/inaccurate/slow/disobedient/unclear_plan/other";

export interface IssueSessionState {
  id: string;
  /** 归属账号=问题责任人(ADR-0031):写操作的唯一闸口,闸口通知、
   * Git 提交身份、介入档位、同账号+同单号去重都跟它走。登记时指派,
   * 缺省=登记人(自登记)。 */
  account: string;
  /** 最近一次会话启动解析到的网关通道(ADR-0039/0068):platform=平台
   *  网关,personal=责任人的个人网关;beta 是 Beta 网关时期的历史事实
   *  (ADR-0068 退役),读取侧照常兼容。fail-open 回落不回改。 */
  model_lane?: "platform" | "personal" | "beta";
  /** 登记人(ADR-0031,通常是测试):登记完成即撒手,对会话只读,
   * 靠「我登记的」列表跟踪;登记人≠归属时凭它过滤出登记视角的列表。
   * 缺席=指派机制之前的老会话(自登记),loadState 回填=归属账号。 */
  reporter?: string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  /** 附加信息(原发起备注,2026-10-15 #502 更名):DTS 列表发起时
   * 人随单填写的文字,尾部可带随单上传的附件路径引用;原样进登记
   * 元信息(IssueRegistrationMeta)——开场词/续聊词与 get_issue_meta
   * 都要求 AI 优先读它。缺席=发起时没填(手工登记不带这列)。 */
  remark?: string;
  /** 会话级介入档位(ADR-0057):DTS 列表发起前按单选定(1/2/3),
   * create 时定格进状态——发起后不可改,终身不随全局改档;缺席=
   * 跟随全局(tierOf 现读责任人的账号设置)。 */
  intervention_tier?: IssueInterventionTier;
  /** 自动接单(ADR-0061):本会话由平台定时扫描自动发起(发起方式=
   * 自动)。纯展示标记:流程语义与人工发起完全一致(同一条校验链、
   * 同一套五阶段与闸、统计照走),工作台据此挂「自动接单」徽标。
   * 缺席=人工发起。 */
  auto_claim?: true;
  source: IssueSource;
  /** 可空:先研究后补单是问题流的一等场景。绑定前推送/MR 被机械拒绝。 */
  ticket?: string;
  /** 首个登记仓(兼容别名):推送/MR/部署缺省目标的权威地址,克隆在
   * repo/<仓名>/。与 repo_urls[0] 保持一致(dual-write),旧字段留给
   * 展示层与老会话。 */
  repo_url?: string;
  /** 全部目标代码仓(2026-08-28 拍板:彼此平等,都可读可改),克隆
   * 平铺在 repo/<仓名>/,由 Agent 调 pull_repo 逐个拉取。 */
  repo_urls?: string[];
  /** 知识仓装载账(#286,ADR-0033):配置中心管理员指定的全局领域知识
   * 仓,开工前置由平台克隆为只读参考件(可研读,不可修改、不可交付)。
   * URL **不进** repo_urls——不在关联仓台账这一个事实,就是交付链全部
   * 闸(locateRepo/create_mr/push_branch、工作区 diff 的 materialRepos、
   * 修复分支切换)天然拒绝它的根基;这里只记装载事实,供提示词注入与
   * 现场复盘。不上 wire(工作台无消费面,现场经转移账可见)。 */
  knowledge_repo?: {
    url: string;
    name: string;
    status: "ready" | "skipped";
    note?: string;
    at: string;
  };
  /** 参考仓台账(2026-09-23,ADR-0054):拉取时命中公共组件仓目录
   * (组件仓库表启用行)的只读参考件——可研读,不可修改、不可交付。
   * URL **不进** repo_urls,与知识仓同一个只读机理:交付工具的定位
   * 映射只认登记清单,参考仓在结构上推不了、交不了。name 是落盘
   * 仓名(撞登记仓名时带序号),目录即 repo/<name>/。 */
  public_repos?: Array<{ url: string; name: string; at: string }>;
  /** 参考组件仓目录快照(2026-09-23,ADR-0054):发起时刻按模块订阅
   * 解析的启用条目(名称/地址/描述)。开场注入给 AI 做按需拉取决策;
   * 快照在 create 定格,会话生命周期内不变——模块订阅后续增删不
   * 追溯进行中的会话(与环境快照同一纪律)。 */
  reference_repos?: Array<{
    id: string;
    name: string;
    url: string;
    description: string;
  }>;
  /** 用户指派意图的未消费留痕(ADR-0054):requestRepoChanges 接受的
   * 新增地址先记在这,Agent 调 pull_repo 落地时消费——凭它走平等仓
   * 登记路径并摘参考仓台账行(指派升级为平等仓)。端点依旧不直改
   * 清单,pending 记的是人的意志,清单仍随 Agent 执行变化。 */
  repo_assign_pending?: string[];
  /** 用户指派过的地址(永久留痕,ADR-0023 通道):requestRepoChanges
   * 的每次新增都记一笔,展示层据此把「运行中经人指派」的在册仓与
   * 登记自带仓区分开;摘除仓不销痕(指派史是审计事实)。 */
  assigned_repos?: string[];
  baseline?: string;
  /** 会话修复分支的定名(ADR-0063):首次建分支时按
   * `<基线>_<工号>_<单号>_<yyyymmddhhmmss>` 生成(宿主本地时间)并
   * 即刻落盘,此后是会话级常量——所有仓、推送、MR 全程同名,绝不
   * 重算。老会话升级:推送账/MR 账挂着旧格式分支名的沿用账里的名字。
   * 不上 wire(工作台无消费面,分支名经推送/MR 账与回执可见)。 */
  fix_branch?: string;
  product_version?: string;
  /** 业务模块:module_id 是登记时选定的一等实体(带出 repo_urls 的
   * 来源留痕);module 是展示/报告用的名称标签,由模块名派生。
   * 三路发起开场必有模块(ADR-0056),运行时不再有绑模块动作。 */
  module_id?: string;
  module?: string;
  environment?: IssueEnvironmentConfig;
  /** 固定流程的场景。 */
  scenario?: IssueScenario;
  /** 从用户提供的已有 MR 开始，前置调查步骤不适用；不伪造 DTS 或推送记录。 */
  imported_mr?: import("../mrImportTypes.ts").RepairMr;
  /** 固定流程每阶段执行状态,与 scenario 阶段表对齐。 */
  stage_states?: StageState[];
  /** 验证回退轮次(fixed 用;回退问题分析时 +1,分支/MR 延用)。 */
  round?: number;
  /** 检视回合进行中(ADR-0007):分析阶段已有人工修改要求,
   * 新增意见仍可交办；submit_analysis 或责任人确认结论时清除。 */
  review_active?: boolean;
  /** skill 圈选台账(ADR-0011):analyze 入口圈选的必读集合。字段在场
   * =已作答(skills 空=明确跳过,AI 自主);重走不重举的判据。 */
  skill_selection?: IssueSkillSelection;
  /** 业务知识台账(ADR-0012):进入 analyze 时按绑定模块定格的资产库
   * 知识,只读投影在 .mae-flow-work/business-modules/。字段在场=已
   * 定格,不随发布库中途更新漂移。 */
  business_knowledge?: IssueBusinessKnowledge;
  /** 平台问题卡在场即 waiting_user 由闸门挂起(与 humanGate 并行)。 */
  gate?: IssueGate;
  /** 环境拒绝台账(票 93):env_needed 卡上「拒绝」的硬裁定——同
   * scope 工具再调不再举闸(防纠缠);attachEnvironment 成功即整册
   * 清除(解锢)。不上 wire,与 mr_gate 同罪同罚。 */
  env_declined?: IssueEnvDeclined;
  ut?: IssueUtRecord;
  /** 流水线监看账(按仓,键=仓地址;一仓一 MR 一流水线)。重启后
   * watching=true 的要逐仓重新挂表。 */
  pipelines?: Record<string, IssuePipelineWatch>;
  /** 转正来源:本会话由哪个无单挂起会话转正而来(带报告继承)。 */
  converted_from?: string;
  /** 转正去向:本会话(无单挂起)转正生成的新会话 id。 */
  converted_to?: string;
  /** 转正继承的交付账引用(#31 拍板:只读引用零拷贝):指向旧会话 id,
   * 旧账(pushes/mrs/pipelines)留在原地不搬运——服务端保持薄,前端
   * 仓卡渲染时经只读详情接口取回并标注「转正前」;旧会话被物理清理时
   * 引用静默缺省。 */
  inherited_accounts?: { issue: string };
  status: IssueStatus;
  stage: FixedStage;
  stage_note: string;
  stage_at: string;
  /** 停靠通知的欠账队列(#244,发送必达):等人时落下的平台通知全文,
   * 续跑(答卡原地续跑/重启重建作答)时随注入词送达模型,送达即清账。
   * stage_note 只是首行 120 字的显示摘要,不是发送账——机制账在这里。
   * 不上 wire(与 mr_gate 同罪同罚:服务端投影多出前端镜像没有的字段
   * 会让契约对账当场红)。 */
  parked_notices?: string[];
  /** 阶段转移审计日志(Agent 声明 + 平台机械事实)。只增不改。 */
  transitions?: StageTransition[];
  conclusion?: IssueConclusion;
  /** 推送账(按仓,一仓一分支):只增不删,重推同分支覆盖同仓旧账。 */
  pushes?: IssuePushRecord[];
  /** 基线同步账(ADR-0071,按仓):push_branch 前宿主把基线新提交并进
   * 修复分支的落账;同仓重推覆盖同仓旧账。内部机制账,不上 wire。 */
  baseline_syncs?: IssueBaselineSyncRecord[];
  /** 连续「推送前基线同步撞冲突」计数(ADR-0071):任何一次推送成功
   * 即清零;满 3 次回执升级提示人工确认时机,不硬停。内部机制账。 */
  baseline_sync_conflicts?: number;
  /** 连续「外部提交合并撞冲突」计数(#589,推送链路/sync_branch/回合
   * 开始探针三条吸收路径共用):合并落定(并入或本地已含)即清零,
   * 与 baseline_sync_conflicts 互相独立;满 3 次回执/通知词升级提示
   * 人工确认时机,不硬停。内部机制账。 */
  absorb_conflicts?: number;
  /** MR 账(按仓,一仓一 MR):AI 的"上报"即 create_mr 的调用记录;
   *  merged_at/merged_sha/closed_at 是合入事实(ADR-0022)。 */
  mrs?: IssueMrRecord[];
  /** 合入事实通知账(ADR-0022):全合入/被关闭的通知各只发一次,
   *  重启不重发;重开返工不重置——note 是事实陈述不是状态。 */
  merge_noted?: boolean;
  mr_closed_noted?: boolean;
  /** MR 验绿门的申报账(受理路):complete_stage 申报时流水线在跑则
   * 记账停等,监看器全绿后凭它在场放行(见 IssueMrGateRecord)。 */
  mr_gate?: IssueMrGateRecord;
  /** 人工接管标记(2026-09-07 走查拍板):字段在场=AI 已暂停、人工作业
   * 中——接管即打断 AI 当前回合(abort 只掐回合,现场保留),状态定格
   * idle;期间的人工操作以 via=takeover 的 user_message 记事件账,交还
   * 时随续聊词回灌 AI。by=接管人(归属人);at 是接管时刻(交还时从
   * 账本收集接管期记录的时间下界)。催办谓词对它让路(见
   * shouldNudgeFixed):人工驾驶中平台不催。 */
  takeover?: { at: string; by: string };
  /** 本回合已用催办次数(模型提前收嘴的自动续跑)。每个新回合起点清零;
   * 落在状态里是为了重启后不重复催办。 */
  nudges?: number;
  /** 环境预热收据(2026-09-04,需求侧 baseline_build 的问题流形态):
   * 拉仓完成进 analyze 时后台预热专员的状态。幂等判据=finished_at;
   * warmup 模块权威,前端镜像没有这个字段。类型与收据写入方共用
   * IssueWarmupReceipt,防两侧 status 联合各自漂移。 */
  warmup?: IssueWarmupReceipt;
  /** 代码现场已回收的时刻(磁盘治理票 01):终态(canceled/archived)单的
   * repo/ 子树被清扫器删除后落此标记——工作区变更签据此如实降级,
   * 恢复/续跑路径据此不再触碰已回收现场。上 wire(前端降级文案)。 */
  repo_reclaimed_at?: string;
  /** 已知编译中间目录回收的时刻；续跑通知提醒 Agent 按需重新准备。
   * 源码、依赖与报告仍保留，历史编译结果不因回收而改变。上 wire。 */
  build_products_reclaimed_at?: string;
  error?: string;
  last_reply?: string;
  /** 终止原因(#541):cancel 终态伴生,稳定英文值(词表见
   * IssueCancelReason);缺席=无原因取消(历史路径),行为与现状一致。 */
  cancel_reason?: IssueCancelReason;
  /** 终止补充说明(#541):仅 cancel_reason="other" 有意义,选填人话,
   * 留存备分析;不复用 revive 专用的 note(ADR-0055 语义不动)。 */
  cancel_reason_text?: string;
  /** mr_repair 修绿收口的总结轮在飞(ADR-0073):closeMrGreen 举起,
   * 总结轮 settle 后落 archived 并清除。持久化是为了崩溃恢复后总结轮
   * 重放仍能收口——没有它,中断的会话会永远停在 idle 占着现场。 */
  mr_repair_closing?: true;
}

export interface IssueSummary extends IssueSessionState {
  has_environment: boolean;
  /** 该单已被排除出自动接单(ADR-0070 单级排除;与 DTS 列表行的同名
   *  字段同一口径,稀疏在场,缺席=允许):终止确认框据此抑制「将改为
   *  排除」的事前提示(ADR-0072)——已排除的单无需再提示。 */
  auto_claim_excluded?: true;
  /** 进入代码交付后的持续检视投影；原始流水线/MR 账仍各自权威。 */
  feedback?: FeedbackRecord[];
}

// ---- 多仓工作区映射(克隆/工具/提示词共用,目录命名只写这一处) ----

/** 登记仓清单:单仓(兼容字段)与多仓合并去重,逐个过协议校验。
 * 顺序即语义——首个即 repo_url 兼容别名(推送/部署的缺省目标),
 * 仓彼此平等。登记(create)与
 * 闸门补填(resolveGate)两处共用同一
 * 把尺子,协议规则不允许各自为政;数量上限已废除(ADR-0054)。 */
export function normalizeIssueRepos(
  single: string | undefined,
  list: string[] | undefined,
): string[] {
  const unique: string[] = [];
  for (const raw of [single ?? "", ...(list ?? [])]) {
    const url = raw.trim();
    if (!url) continue;
    const validated = validateRepoUrl(url);
    if (!unique.includes(validated)) unique.push(validated);
  }
  return unique;
}

/** pull_repo 的身份裁决(2026-09-23,ADR-0054):指派意图 > 登记表
 * 命中 > 平等登记。assigned = 地址带着用户指派意图(pending 未消费,
 * requestRepoChanges 落下的"人的意志");reference = 不在已知集合且
 * 命中公共组件仓目录启用行;其余一律平等登记(现状口径)。known
 * 之外,extraKnown(模块绑定仓等登记侧既定关系)同样算已知——模块
 * 绑定的地址即使没进 repo_urls(发起时显式给了仓清单的边缘场景)
 * 也不该被登记表卷成参考仓。只裁决不落账——pending 与参考仓台账的
 * 消费在服务侧 pullRepoFor。纯函数,直测。 */
export function resolvePullRoute(
  state: Pick<IssueSessionState,
    "repo_urls" | "public_repos" | "repo_assign_pending">,
  url: string,
  registryHit: boolean,
  extraKnown: readonly string[] = [],
): "assigned" | "reference" | "registered" {
  const identity = repositoryIdentity(url);
  if (state.repo_assign_pending?.some((item) =>
    repositoryIdentity(item) === identity)) {
    return "assigned";
  }
  const known = (state.repo_urls ?? []).some((item) =>
    repositoryIdentity(item) === identity)
    || extraKnown.some((item) => repositoryIdentity(item) === identity);
  if (!known && registryHit) return "reference";
  return "registered";
}

/** 仓名派生的唯一真相:地址末段去 .git。issueRepoWorkspaces 与知识仓
 * 装载(#286)共用——知识仓的撞名判定依赖两处同名同源,分叉即漏闸。 */
export function repoNameOf(url: string): string {
  const tail = url.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return tail.replace(/\.git$/i, "") || "repo";
}

/** 会话登记仓 → 工作区克隆路径:全部平铺 repo/<仓名>/(2026-08-28
 * 拍板:仓平等——废除主仓 repo/ + 参考仓 ref/ 的等级布局,单仓多仓
 * 同构)。仓名取地址末段去 .git,重名追加序号;克隆一律由 Agent 调
 * pull_repo 工具发起,平台不自动克隆。知识仓(#286)不在本口径:
 * 它的 URL 不进 repo_urls,装载走 service.ensureKnowledgeRepo。
 * 参考仓台账(ADR-0054)的名字参与占用:登记仓名与参考仓名撞名时,
 * 后拉的一方落序号名,谁也不覆盖谁。 */
export function issueRepoWorkspaces(
  state: IssueSessionState,
  workspaceRoot: string,
): Array<{ url: string; dir: string }> {
  const repoUrls = state.repo_urls?.length
    ? state.repo_urls
    : state.repo_url ? [state.repo_url] : [];
  const taken = new Set<string>(
    (state.public_repos ?? []).map((row) => row.name));
  return repoUrls.map((url) => {
    const name = repoNameOf(url);
    let candidate = name;
    let serial = 2;
    while (taken.has(candidate)) candidate = `${name}-${serial++}`;
    taken.add(candidate);
    return { url, dir: join(workspaceRoot, "repo", candidate) };
  });
}

/** 宿主本地时间的分支时间戳(yyyymmddhhmmss,ADR-0063):取时刻由
 * 调用方保证是首次建分支时刻,生成后持久化,不再重算。 */
function fixBranchStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** 已定名的修复分支(纯读):state.fix_branch 在场直接用;否则看推送
 * 账/MR 账挂着的分支名(老会话升级兼容——换名会让在途推送与 MR 对
 * 不上)。都没有 = 本会话从未定过名,返回 undefined,调用方据此区分
 * "沿用已定名"与"要生成新名"。 */
export function fixedFixBranch(state: IssueSessionState): string | undefined {
  return state.fix_branch
    ?? state.pushes?.find((item) => item.branch)?.branch
    ?? state.mrs?.find((item) => item.branch)?.branch;
}

/** 会话修复分支的权威定名(ADR-0063),三步解出、定后不变:
 * 1. state.fix_branch 在场直接用(已定名的会话);
 * 2. 老会话升级兼容:推送账/MR 账挂着旧格式(`master_<工号>_<单号>`)
 *    分支名的在途会话沿用账里的名字——换名会让在途推送与 MR 对不上;
 * 3. 新会话按 `<基线>_<工号>_<单号>_<yyyymmddhhmmss>` 生成(宿主本地
 *    时间,首次建分支时刻)。基线缺席直接报错,不回退 master——基线
 *    在有单会话必在(手工登记缺版本 409、DTS 无映射不发车、自动接单
 *    带匹配版本),缺席只可能来自绕过路由直调服务。
 *
 * 纯读契约:本函数不写状态、不落盘。持久化只由拉仓路显式负责
 * (pullRepoFor 在首次解出后写 state.fix_branch 并 saveState——生成
 * 即持久化,时间戳就此定死,中断不重算)。推送门禁纯读比对;remove_repo
 * 门禁纯读,解不出已定名(fixedFixBranch 返回 undefined)就跳过远端
 * 同名探测——从未拉仓的会话不可能推过本会话分支,探测无意义。 */
export function resolveFixBranch(state: IssueSessionState): string {
  const fixed = fixedFixBranch(state);
  if (fixed) return fixed;
  const baseline = state.baseline?.trim();
  if (!baseline) {
    throw new Error("会话没有基线分支,无法命名修复分支:"
      + "修复分支以拉仓基线为前缀(基线_工号_单号_时间戳),"
      + "请先补登记产品版本或为会话配置基线,再重新拉仓");
  }
  if (!state.ticket) {
    throw new Error("会话没有绑定单号,不需要也不会创建修复分支");
  }
  return `${baseline}_${state.account}_${state.ticket}_${fixBranchStamp(new Date())}`;
}

export function summarize(state: IssueSessionState): IssueSummary {
  // mr_gate 是 MR 验绿门的内部受理账(流程机制状态):不上 wire——
  // 服务端投影多出前端镜像没有的字段会让契约对账当场红;要上前端
  // 先补 web/src/api.ts 镜像与样例。env_declined(环境拒绝台账,票 93)
  // 同理:效力只在服务端工具层(同 scope 不再举闸),前端镜像没有
  // 这个字段。warmup(环境预热收据)2026-09-10 起上 wire(对齐清单⑤):
  // 前端要判"预热在跑/结果"决定直播面板;build-notes 仍由修复 Agent
  // 从文件系统读,不走投影。
  const { mr_gate: _gate,
    env_declined: _envDeclined,
    merge_noted: _mergeNoted, mr_closed_noted: _mrClosedNoted,
    parked_notices: _parkedNotices,
    // reference_repos(参考组件仓目录快照,ADR-0054)不上 wire:它是
    // 开场词的注入源,工作台无消费面;要上前端先补镜像与样例,不白送。
    reference_repos: _referenceRepos,
    // fix_branch(修复分支定名,ADR-0063)不上 wire:会话内部机制账,
    // 工作台的分支名事实都来自推送/MR 账与回执;要上前端先补镜像与
    // 样例,不白送。
    fix_branch: _fixBranch,
    // baseline_syncs(基线同步账,ADR-0071)与 baseline_sync_conflicts
    // (连续同步冲突计数)不上 wire:推送的内部前置卫生,工作台事实
    // 经推送账与回执呈现;要上前端先补镜像与样例,不白送。
    // absorb_conflicts(#589,连续外部提交合并冲突计数)同理。
    baseline_syncs: _baselineSyncs,
    baseline_sync_conflicts: _baselineSyncConflicts,
    absorb_conflicts: _absorbConflicts,
    ...rest } = state;
  return {
    ...rest,
    // takeover(人工接管标记)与上面的机制账不同:它要上 wire——头部
    // 徽标与输入区 takeover 模式都靠它分派,缺席=不在接管中。
    ...(state.takeover ? { takeover: state.takeover } : {}),
    has_environment: Boolean(state.environment),
  };
}

export function loadState(root: string): IssueSessionState | undefined {
  const path = join(root, "issue.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf-8")) as IssueSessionState;
  // 多仓迁移:repo_urls 是权威清单,repo_url 是单仓时代的兼容别名。
  // 老会话只有单仓字段,读进来就补齐另一侧,消费方不用两头兜底。
  if (state.repo_urls?.length) {
    state.repo_url ??= state.repo_urls[0];
  } else if (state.repo_url) {
    state.repo_urls = [state.repo_url];
  }
  // 推送/MR 账迁移:老会话的单数账(push/mr)读进来换成按仓数组
  // (repo 用当时的首个仓地址兜底),字段本身退役。
  const legacyPush = (state as { push?: IssuePushRecord }).push;
  if (!state.pushes?.length && legacyPush) {
    state.pushes = [{
      repo: state.repo_url ?? "",
      branch: legacyPush.branch,
      sha: legacyPush.sha,
      at: legacyPush.at,
    }];
  }
  const legacyMr = (state as { mr?: IssueMrRecord }).mr;
  if (!state.mrs?.length && legacyMr) {
    state.mrs = [{
      repo: state.repo_url ?? "",
      branch: legacyMr.branch,
      title: legacyMr.title,
      ...(legacyMr.url ? { url: legacyMr.url } : {}),
      ...(legacyMr.iid ? { iid: legacyMr.iid } : {}),
      at: legacyMr.at,
    }];
  }
  delete (state as { push?: unknown }).push;
  delete (state as { mr?: unknown }).mr;
  // 登记人回填(ADR-0031):指派机制之前的老会话都是"登记即归属"
  // (自登记),读盘时补齐,消费方(listReported/投影)不用两头兜底。
  state.reporter ??= state.account;
  // 流水线账迁移:老单数 pipeline 读进来挂到当时首个仓(repo_url
  // 兼容别名)名下。
  const legacyPipeline = (state as { pipeline?: IssuePipelineWatch }).pipeline;
  if (legacyPipeline && !state.pipelines) {
    state.pipelines = { [state.repo_url ?? ""]: legacyPipeline };
  }
  delete (state as { pipeline?: unknown }).pipeline;
  // 挂起状态退役(ADR-0048/0057):无单结论曾挂起等关联转正,机制拆除
  // 后存量挂起读盘即按既定出口归为取消(不入结论统计),类型与消费方
  // 都不再认旧词,盘面在下一次落盘时自然对齐。
  if ((state.status as string) === "suspended") {
    state.status = "canceled";
  }
  // 结论词表收敛(ADR-0037):fixed 并入 delivered(修复完成即交付,
  // 合入与否看 mrs 账)、converted 并入 issue(转正=问题成立+开新会话,
  // 血缘 converted_from/to 保留)。读侧归一,统计与展示不认旧词。
  const legacyConclusion = state.conclusion as { kind?: string } | undefined;
  if (legacyConclusion?.kind === "fixed") legacyConclusion.kind = "delivered";
  else if (legacyConclusion?.kind === "converted") legacyConclusion.kind = "issue";
  // 推送过目闸退役(2026-09-17,ADR-0009 增补):全部介入档位推送
  // 直推,机制整体拆除。存量盘上的卡与令牌是死账——闸不剥会落进
  // rework 裁决(回流分析)错伤现场,令牌不再有任何消费口;等人空壳
  // 的续跑由 recover() 处理。
  if ((state.gate as { kind?: string } | undefined)?.kind === "push_confirm") {
    delete state.gate;
  }
  delete (state as { push_token?: unknown }).push_token;
  delete (state as { push_review_head?: unknown }).push_review_head;
  delete (state as { push_review_force?: unknown }).push_review_force;
  delete (state as { push_review_remote?: unknown }).push_review_remote;
  // 预绑锁退役(ADR-0056):三路发起开场必有模块,不再有 AI 绑模块
  // 的动作,锁没有锁的对象;盘上存量字段是死账,读盘即剥不上 wire。
  delete (state as { module_locked?: unknown }).module_locked;
  return state;
}

/** 状态落盘:临时文件 + rename 保原子(与 waiting.json 同款纪律)。 */
export function saveState(root: string, state: IssueSessionState, options?: { preserveUpdatedAt?: boolean }): void {
  mkdirSync(root, { recursive: true });
  if (!options?.preserveUpdatedAt) state.updated_at = new Date().toISOString();
  const path = join(root, "issue.json");
  durableWriteFileSync(path, JSON.stringify(state, null, 1));
}

export function isTerminal(status: IssueStatus): boolean {
  return status === "archived" || status === "canceled" || status === "failed";
}

/** 催办谓词:回合正常收口时,流程还没走到"可以停"的程度吗?
 * 算"可以停"的情况:
 * - 会话没有场景阶段(转正前的存量现场,停机合法性无从机械判定,不催);
 * - 当前阶段已收口(stage_states 里本阶段 done)——唯一例外是 mr_green
 *   欠环境验证卡(#246,ADR-0024):收口只是出口的一半,卡没交到用户
 *   手上(无闸)就停机 = 欠出口,催。卡在场即不欠:通过无需作答
 *   (合入即通过,ADR-0034),答卡的唯一裁决是回退,回退即离开
 *   mr_green,不会回到这个判据上;
 * - 流水线在途(MR 已建、平台还在监看——停等流水线是出口的一部分);
 * - MR 验绿门已受理申报(mr_green 阶段 complete_stage 申报后等绿,
 *   同"停等流水线"的合法停机;推进/回退即清,不会滞留)。
 * 其余一律催:阶段没走完,模型收嘴就是提前收嘴。 */
/** mr_green 收口后的统一停机说明(两条收口路共写,#246):显示摘要
 *  一字不差——前端与文档按它识别「待环境验证」态。 */
export const MR_GREEN_ENV_VERIFY_NOTE =
  "MR 已全绿——待环境验证:通过可归档,发现问题回退重新分析";

export function shouldNudgeFixed(state: IssueSessionState): boolean {
  if (state.takeover) return false;
  if (!state.scenario) return false;
  const index = fixedStageIndex(state.scenario, state.stage as FixedStage);
  // 已收口的阶段停机合法——唯一例外是 mr_green 的出口卡未清(#246,
  // ADR-0024):收口只是出口的一半(申报),另一半是把验证卡交到用户
  // 手上;卡没举(闸不在场)就停机 = 欠着出口,催。
  if (index >= 0 && (state.stage_states?.[index] ?? "pending") === "done") {
    return state.scenario !== "mr_repair" && state.stage === "mr_green" && !state.gate;
  }
  const pipelines = Object.values(state.pipelines ?? {});
  if ((state.mrs?.length ?? 0) > 0
      && pipelines.some((watch) => watch.watching || watch.status === "running")) {
    return false;
  }
  if (state.mr_gate) return false;
  return true;
}

/** 追加一条转移日志(只增不改;调用方负责随 saveState 落盘)。 */
export function recordTransition(
  state: IssueSessionState,
  entry: Omit<StageTransition, "at">,
): void {
  (state.transitions ??= []).push({ at: new Date().toISOString(), ...entry });
}

// ---- 固定流程的阶段机操作(工具与服务共用;真相只在这些函数里变) ----

/** 平台举闸(固定流程的人工硬闸)。只记"闸在场",**不动状态**:
 * 回合可能还在收尾,waiting_user 由 settle 在回合终点定格——中途置位
 * 会让作答撞上"正在处理上一条输入"的竞态。Agent 对 issue.json 只读,
 * 推不动闸。选项不接收参:码+文案对整表投影自 stageRegistry 的
 * GATE_OPTIONS——举卡方自带文案的旧路已废,文案定义地只剩注册表。
 * 推荐码同源:码表定死或按 AI 提案派生(gateRecommendedCode),
 * 随 questions[].recommended 落盘,与 Agent 卡的 wire 同形。 */
const GATE_NAMES: Record<IssueGateKind, string> = {
  analysis_confirm: "分析报告确认",
  conclude: "结论确认",
  env_verify: "环境验证",
  env_needed: "网管环境配置",
  skill_select: "skill 圈选",
  pipeline_unfixable: "流水线不可修告警",
  pipeline_evidence: "流水线报错回灌",
};

export function raiseGate(
  state: IssueSessionState,
  kind: IssueGateKind,
  question: string,
  proposal?: IssueGate["proposal"],
  context?: string,
  scope?: IssueGateScope,
  /** 仅 skill_select:扫描所得的圈选清单(动态数据,非文案——选项
   * 码表照旧出自 GATE_OPTIONS)。其余闸不传,在场即阶段配置错误。 */
  skills?: IssueSkillChoice[],
  /** 仅 pipeline_unfixable/pipeline_evidence:闸归属的仓与提交
   * (作答续跑的重新监看/证据注入按它定位)。 */
  pipeline?: IssueGate["pipeline"],
): void {
  const recommended = gateRecommendedCode(kind, proposal);
  state.gate = {
    id: `gate-${state.id}-${Date.now().toString(36)}`,
    kind,
    state_version: state.transitions?.length ?? 0,
    question: {
      questions: [{
        question,
        options: GATE_OPTIONS[kind].options.map((option) => ({ ...option })),
        ...(recommended ? { recommended } : {}),
      }],
    },
    ...(proposal ? { proposal } : {}),
    ...(context ? { context } : {}),
    ...(scope ? { scope } : {}),
    ...(skills ? { skills } : {}),
    ...(pipeline ? { pipeline } : {}),
    created_at: new Date().toISOString(),
  };
  recordTransition(state, {
    source: "platform",
    note: `平台举闸:${GATE_NAMES[kind]}——等待用户作答`,
  });
}

/** 阶段推进:把 [当前+1 .. 目标-1] 一并标记完成(机械跳过的中间段),
 * 目标置 in_progress。继承段(inherited)不动——那是转正带来的既成
 * 事实,不是本轮做的。 */
export function fixedAdvance(
  state: IssueSessionState,
  to: FixedStage,
  note: string,
): void {
  const scenario = state.scenario;
  if (!scenario) return;
  const stages = fixedStages(scenario);
  const target = stages.indexOf(to);
  if (target < 0) return;
  const current = stages.indexOf(state.stage as FixedStage);
  if (current >= 0 && current < target) {
    for (let index = current; index < target; index += 1) {
      if (state.stage_states?.[index] === "inherited") continue;
      (state.stage_states ??= initStageStates(scenario, 0))[index] = "done";
    }
  }
  (state.stage_states ??= initStageStates(scenario, 0))[target] = "in_progress";
  state.stage = to;
  state.stage_note = note;
  state.stage_at = new Date().toISOString();
  recordTransition(state, { source: "platform", stage: to, note });
}

/** 环境验证闸的转移账文案(2026-09-16 起是统计协议,不是随手文案:
 * 一次率二轴聚合(一次修复成功率)按失败前缀从转移账取验证事实,改
 * 文案必须连这里一起改;写入点在 service 的 env_verify fail 分派。
 * 通过没有文案也不落账——MR 全部合入即视为通过(ADR-0034,2026-09-19
 * 起唯一通过出口),归档动作自带结论。 */
export const VERIFY_FAIL_NOTE_PREFIX = "用户环境验证发现问题";

/** 当前阶段收尾(不再前进):换库验证通过后的终态用。 */
export function fixedComplete(state: IssueSessionState, note: string): void {
  const scenario = state.scenario;
  if (!scenario) return;
  const current = fixedStageIndex(scenario, state.stage);
  if (current < 0) return;
  (state.stage_states ??= initStageStates(scenario, 0))[current] = "done";
  state.stage_note = note;
  state.stage_at = new Date().toISOString();
  recordTransition(state, { source: "platform", stage: state.stage, note });
}

/** 验证不通过的一律回退(2026-08-27 拍板):回到问题分析,分析之后的
 * 阶段标 redo 待重做,轮次 +1;分支与 MR 记录延用(同分支追加修复,
 * CodeHub MR 自动跟新提交);UT 上报、流水线监看与 MR 申报账作废重来
 * (mr_gate 清掉——新一轮要重新申报)。 */
export function fixedRollback(
  state: IssueSessionState,
  reason: string,
): void {
  const scenario = state.scenario;
  if (!scenario) return;
  const analyzeIndex = fixedStageIndex(scenario, "analyze");
  if (analyzeIndex < 0) return;
  const current = fixedStageIndex(scenario, state.stage);
  const states = state.stage_states ??= initStageStates(scenario, 0);
  if (current > analyzeIndex) {
    for (let index = analyzeIndex + 1; index < states.length; index += 1) {
      if (states[index] === "inherited") continue;
      states[index] = "redo";
    }
  }
  states[analyzeIndex] = "in_progress";
  state.stage = "analyze";
  state.round = (state.round ?? 1) + 1;
  state.stage_note = reason;
  state.stage_at = new Date().toISOString();
  delete state.ut;
  delete state.pipelines;
  delete state.mr_gate;
  delete state.gate;
  recordTransition(state, {
    source: "platform", stage: "analyze",
    note: `第 ${state.round} 轮:${reason}`,
  });
}
