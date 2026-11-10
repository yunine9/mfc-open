/**
 * 问题会话的宿主工具集(递给 Agent 的平台原子能力)。
 *
 * 设计立场:平台凭据(git/MCP token)止步于宿主,Agent 只拿到工具
 * 语义与结果文本;网管环境口令是例外——ADR-0003 裁定它是现场公开的
 * 出厂默认值,随登记元信息明文进上下文(get_issue_meta),vault 落盘
 * 的卫生不变。"提 MR 前必须有单号"在这里是机械门禁——
 * push_branch / create_mr 查不到绑定单号直接拒绝,提示词管不住的
 * 侥幸在工具层过不去。
 *
 * 固定流程(2026-08-27 拍板)在工具层叠加两件事:
 * - 阶段门禁:每个工具只在所属阶段开放,越权调用直接拒绝(双层
 *   门禁的权威层;提示词里的"本阶段工具清单"是引导层,两层的白名单
 *   同出阶段注册表 stageRegistry.ts,不会各说各话)。例外是
 *   request_env 举环境卡全程可调,dts_get_ticket 任意阶段可重查
 *   (2026-08-28 拍板:作业自由,门只守流程出口与出厂动作);
 * - 阶段推进(2026-08-28 目标驱动自报):四个阶段(拉单/拉仓/修改/
 *   提交MR)的出口是 complete_stage 自报收口,平台不核实 AI 的
 *   工作事实,只在提交 MR 阶段程序化验 MR 验绿门(清单=台账+流水线
 *   全绿);三个举卡阶段卡工具即出口,人工闸(报告确认/结论/环境
 *   验证)由工具举闸——raiseGate 写进 issue.json,Agent 对它只读,
 *   推不动。UT 属于问题修复阶段(TDD:先写复现单测再改码转绿),
 *   report_ut 是修复过程中的事实上报(只记账)。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dirname, join, resolve, sep } from "node:path";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import {
  FIXED_STAGE_LABELS,
  fixedAdvance,
  fixedComplete,
  fixedRollback,
  fixedStageIndex,
  MR_GREEN_ENV_VERIFY_NOTE,
  fixedStages,
  issueRepoWorkspaces,
  fixedFixBranch,
  resolveFixBranch,
  raiseGate,
  recordTransition,
  ENV_SCOPE_LABELS,
  type FixedStage,
  type IssueGateKind,
  type IssueGateScope,
  type IssueSessionState,
} from "./state.ts";
import {
  stageAllowsTool,
  stagesAllowingTool,
  stageBriefLines,
} from "./stageRegistry.ts";
import { promptCopy } from "./promptCopy.ts";
import {
  describePipelineRun,
  getPipelineStatus,
  type PipelineRun,
} from "../pipelineClient.ts";
import { readBusinessModule, listBusinessModules, type BusinessModule } from "../businessModuleLibrary.ts";
import { repositoryIdentity } from "../knowledgeAssetModel.ts";
import type { IssueOpsTools } from "./opsTools.ts";
import type { IssueInterventionTier } from "../auth.ts";
import type { DtsGateway, DtsTicketDetail } from "./gateways.ts";
import {
  applyTicketImageRewrites,
  renderTicketImageNote,
  syncTicketImages,
} from "./ticketImages.ts";
import { issueRegistrationMeta } from "./prompt.ts";
import {
  outstandingReviewBatch,
  renderReviewNotes,
  reviewStore,
  snapshotAnalysisVersion,
  writeReviewNotesSnapshot,
} from "./reviews.ts";
import {
  absorbExternalCommits,
  currentBranch,
  dirtyWorktree,
  ForceReceiptGateError,
  pushFromIssueWorkspace,
  remoteBranchState,
  syncBaselineBeforePush,
  type GitCredential,
} from "./issueGit.ts";
import { lastReceiptOf, ledgerReceiptsOf } from "./ledgerFacts.ts";
import {
  absorbBlockedFinding,
  createBranchTransferMutex,
  type BranchTransferMutex,
} from "./turnStartAbsorb.ts";
import {
  absorbConflictEscalation,
  recordAbsorbedCommits,
  resetAbsorbConflicts,
} from "./absorbLedger.ts";
import { createMergeRequest } from "../mrClient.ts";
import { resolveModuleMrParticipants } from "../moduleMrParticipants.ts";
import { mrParticipantsMessage } from "../mrParticipants.ts";

/** MR 状态复核结果(#321):MR 生命周期与源分支最新提交的现查事实。
 * 验绿门(complete_stage 申报放行)与监看器终态处理共用同一判断——
 * 一处判断、两处使用,两边口径不漂移。 */
export interface IssueMrRecheck {
  /** MR 平台状态(与 /mr/gates 同义:merged=已合入)。 */
  mrState: "merged" | "closed" | "opened";
  /** 平台带回的 MR 源分支最新提交;老适配层不带时缺席。 */
  sourceSha?: string;
  /** true=分支最新提交与对照提交对不上(头已变)。 */
  headMoved: boolean;
}

export interface IssueToolContext {
  /** 活状态引用(服务持有,工具直接读)。 */
  state: IssueSessionState;
  /** 会话工作区根(session cwd)。 */
  workspace: string;
  /** 数据目录(凭据沙箱运行区挂这里,不进工作区)。 */
  dataRoot: string;
  /** 状态变更的持久化钩子(服务保证落盘)。 */
  persist(): void;
  /** 推送前固定执行上传的 Skill；没有此回调的离线工具环境保持原行为。 */
  beforePush?(repo: { dir: string; url: string }): Promise<string>;
  /** 基线同步冲突现场交回容器前修复仓属主(ADR-0071):宿主 merge 以
   * 宿主身份写文件,容器用户改不动;非隔离部署缺席即免修。 */
  repairOwnership?(dir: string): void;
  assertActive?(): void;
  ops?: IssueOpsTools;
  dts?: DtsGateway;
  /** 交付平台适配层地址(--platform);MR 创建走公共 mrClient。 */
  platformUrl?: string;
  /** 宿主侧解密后的环境密码;未配置环境时为 undefined。 */
  environmentPassword?(): string | undefined;
  /** 宿主侧解密后的独立 root 密码(#150):只在显式凭据组在场时有值;
   * 继承后台密码的会话为 undefined(root 与后台密码相同,不重复出)。 */
  rootPassword?(): string | undefined;
  gitCredential?(): GitCredential | undefined;
  /** 介入档位现值(ADR-0019,现读现判):build_deploy 随路 env_verify
   * 卡的举卡条件(三档独有)。env_needed 配置卡已三档同举(2026-10-31
   * 增补:环境是只有人拿得到的事实),不再随档位分叉。 */
  interventionTier?: () => IssueInterventionTier;
  /** skill 圈选闸已封存(ADR-0014):complete_stage 推进进 analyze 时
   * 调用,现在只做扫描留痕(发现清单进转移账),恒返回 false。回调
   * 名保留——旧台账的必读清单注入口径不变。 */
  raiseSkillSelection?: () => boolean;
  /** 业务知识资产定格(ADR-0012):推进进 analyze 时调用,按绑定模块
   * 从资产库定格并落台账;不分介入档,缺席/失败静默。返回是否定格到
   * 了资产。 */
  freezeBusinessKnowledge?: () => boolean;
  /** 业务知识地图(ADR-0012/0021):analyze 简报只注入定格的
   * 团队资产台账；无资产时为空串。 */
  businessKnowledgeBrief?: () => string;
  /** 环境预热(2026-09-04):complete_stage 推进进 analyze 时调用。
   * service 侧现读现判开关与幂等,缺席=不预热。 */
  startWarmup?: () => void;
  /** 拉仓(2026-08-28 拍板:克隆是 Agent 的工具,不是平台自动动作)。
   * 宿主实现:登记合并 → 带凭据克隆到 repo/<仓名>/ →(有单场景)
   * 建修复分支。回执只含事实,凭据永不进结果。基线分支在远端缺失时
   * 整次失败抛错(ADR-0038),不降级默认分支。 */
  pullRepo(url: string): Promise<{
    dir: string;
    cloned: boolean;
    branch?: string;
    head: string;
    /** 命中公共组件仓目录(ADR-0054):只读参考件,不进登记清单。 */
    reference?: boolean;
  }>;
  /** 固定流程:create_mr 成功后由服务启动流水线监看(触发+轮询)。 */
  onMrCreated?(repo: string): void;
  /** push_branch 成功落账后上报(issue-72):修复环"同分支再推,
   *  MR 自动跟新提交"不重建 MR,监看重挂的启动不能只挂在 create_mr
   *  上——宿主按仓决定是否重挂(见 service 侧接线)。 */
  onBranchPushed?(repo: string): void;
  /** mr_green 即时收口的用户通知(complete_stage 验绿当场全绿/空清单
   *  时调;监看器滞后收口的通知在 service 侧,不经这里)。 */
  notifyMrGreen?(): void;
  /** MR 状态复核(#321):现查交付平台,回答「MR 是否已合入、源分支
   *  最新提交是哪个」。验绿门与监看器终态处理共用同一私有判断(一处
   *  判断、两处使用)。返回 undefined=查询不可得,调用方按既有口径
   *  继续;回调缺席(裸构造)时验绿门按推送账的提交验绿,与旧口径
   *  一致。 */
  mrRecheck?(repo: string, sha: string): Promise<IssueMrRecheck | undefined>;
  /** 单卡互斥②(ADR-0024):有未决的 Agent 问题卡时 raise_gate 拒举。
   * 服务侧接 humanGate.pending();缺席按无卡(裸构造兼容缺省)。 */
  pendingAgentCard?: () => boolean;
  /** 举卡即收口(票 #573,ADR-0019 2026-10-31 增补·六卡一规则):读
   *  「本回合是否已举过卡」(平台闸或 Agent 问题卡任一)。置位后同
   *  回合再调平台工具一律机械拦下——回执是纠偏,不是报错口吻。标记
   *  是回合内存态:举卡时置位,回合启动/收口清零,进程重启天然归零,
   *  不落盘;绝不按「闸在场」跨回合拦(检视分诊送达开的回合、收口后
   *  返工的回合照常用平台工具)。缺席(裸构造)=未举卡,不拦。 */
  turnCardRaised?: () => boolean;
  /** 举卡的置位口:平台闸举起后由工具层调用;Agent 问题卡落卡由服务
   *  侧接线置位(见 service 的 beforeHumanQuestion)。 */
  markTurnCardRaised?: () => void;
  /** 对话选环境(票 #574,spec #571):用户在对话中明确给出环境 IP
   *  时,服务端按环境管理台账主 IP 精确匹配并复用挂载路径(快照解密
   *  进 vault、覆盖允许、清环境卡、解锢、开平台回合);返回回执文本
   *  ——只含事实,密码永不进模型可见面。缺席(裸构造)由工具如实打回。 */
  selectEnvironmentByIp?: (ip: string) => string;
  /** 分支传输在途互斥(ADR-0074 票 3):push_branch/sync_branch 与回合
   *  开始探针共用一把(服务侧 LiveIssue 级单例经此传入);缺席时工具
   *  工厂自建一把(裸构造/直调兼容)。 */
  branchTransfer?: BranchTransferMutex;
  log?: (message: string) => void;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string): never {
  throw new Error(text);
}

/** 缺网管环境时的平台闸(拉日志/换库现场补配,2026-08-28):举卡后
 * 成功收口、回执叫模型立即结束本回合——不再让 AI 空口向用户要密码
 * (秘密纪律:密码只走 /environment 表单进 vault,不进对话)。任何
 * 介入档位都举(2026-10-31,ADR-0019 增补:环境是只有人拿得到的事实,
 * 归入「办不到」而非「询问」)。硬拒绝在先(票 93):用户已在
 * env_needed 卡上裁定这一用途不需要环境,则不再举闸纠缠——工具
 * 如实失败收口,把"用户已裁定"原样递给模型;配置环境成功即整册
 * 解锢(attachEnvironment)。 */
function raiseEnvNeededGate(
  ctx: IssueToolContext,
  scope: IssueGateScope,
): string {
  // 硬拒绝在先(票 93):用户已在 env_needed 卡上裁定这一用途不需要
  // 环境——具体的用户意志赢过一切一般策略,任何档位都不再举闸纠缠。
  if (ctx.state.env_declined?.scopes.includes(scope)) {
    fail(promptCopy("receipts", "env.hard_declined",
      { scope: ENV_SCOPE_LABELS[scope] }));
  }
  // 三档同举(2026-10-31,ADR-0019 增补):环境地址与密码是只有人拿到
  // 的事实,归入「办不到」而非「询问」,任何介入档位都举卡——与
  // 流水线人工事实闸同族,一档「全自动」也不例外。
  if (ctx.state.gate?.kind === "env_needed") {
    // 已有一张配置卡在等:幂等回报,不覆盖闸——覆盖会换 gate id,
    // 页面卡与手机通知都按 waiting_id 对账,换了就成第二张卡。
    return "已有一张网管环境配置卡在等用户填写,不要重复发起——"
      + "请结束本回合,等平台通知(用户补配或拒绝)后再继续。";
  }
  raiseGate(
    ctx.state,
    "env_needed",
    "获取日志/换库需要网管服务器地址与密码",
    undefined,
    undefined,
    scope,
  );
  ctx.markTurnCardRaised?.();
  ctx.persist();
  // 成功收口(不是 fail):发起配置请求是一次完成的工具执行,把它记成
  // 失败会让现场回执画 ✕、用户以为出错。模型侧语义靠文案自明:
  // 举卡即收口,等用户补配或拒绝后平台开新回合继续。
  return `已向用户发起网管环境配置请求(${ENV_SCOPE_LABELS[scope]}),`
    + "请立即结束本回合,等待用户补配或拒绝——用户补配后平台会通知你"
    + "重试刚才的操作,拒绝后平台会开新回合告知你基于现有证据继续,"
    + "在此之前不要自行继续。";
}

/** 分析报告的既定落点(prompt 行为契约要求 Agent 维护它,闸门以它
 *  为门票——报告不在场就举闸等于让用户对着空气确认)。 */
export const ANALYSIS_REPORT_FILENAME = "issue-analysis.md";

function analysisReportPath(ctx: IssueToolContext): string {
  return join(ctx.workspace, ANALYSIS_REPORT_FILENAME);
}

/** 分析报告四章节(CONTEXT.md「分析报告」词条,模板在技能
 * issue-analysis):submit_analysis 的门票从"文件在场"升级为"章节
 * 齐全",守住报告结构完整。章节按标题行匹配(1~4 级),内容长短
 * 不管:轻量路径的报告照样四章节齐全,只是每节更短。首行是一句话
 * 总结(现象→根因→方案串联),不是章节。(2026-09-03 重构:现象-
 * 根因-方案三段式解禁,下一步建议并入修改方案——从可选建议升格为
 * fix 阶段的执行承诺。2026-09-20 退役「证据链」章(ADR-0046):
 * 报告写给用户,用户不关心证据链——取证归 AI 自证、出处随文标注,
 * 证据局限写进置信度。)
 * 存量五节报告是本清单的超集,照常过闸,不做迁移。 */
export const ANALYSIS_REPORT_SECTIONS = [
  "问题现象", "问题根因", "修改方案", "置信度",
] as const;

export function missingAnalysisSections(content: string): string[] {
  return ANALYSIS_REPORT_SECTIONS.filter((section) =>
    !new RegExp(`^#{1,4}\\s*${section}`, "m").test(content));
}

/** 摘出报告某一章节的正文(标题行到下一标题行为止),给分析→修复
 *  边界的压缩锚点用——锚只拿方案要点,不整份进。截到 2000 字:方案
 *  章按仓一行一条,正常远小于它;病态长报告也不许把锚撑爆。 */
export function analysisSectionOf(content: string, section: string): string {
  const match = content.match(new RegExp(`^#{1,4}\\s*${section}\\s*$`, "m"));
  if (!match || match.index === undefined) return "";
  const rest = content.slice(match.index + match[0].length);
  const next = rest.match(/^#{1,4}\s/m);
  return (next && next.index !== undefined
    ? rest.slice(0, next.index) : rest).trim().slice(0, 2000);
}

/** MR 标题的权威解出(2026-09-07 拍板):CodeHub 要求 MR 标题与问题单
 *  标题精确相等,标题没有 AI 裁决自由度——create_mr 平台代笔,按绑定
 *  单号现场查 DTS 取标题。不收模型传入,也不拿会话登记标题顶替(登记
 *  在先,单据标题可能已改;每次现场取,单据中途改题也不漂)。取不到/
 *  为空如实打回(mr.title_missing),绝不静默降级。 */
async function issueMrTitle(
  ctx: IssueToolContext,
  ticket: string,
): Promise<string> {
  if (!ctx.dts) {
    fail("DTS 网关未配置,拿不到问题单权威标题(部署需 --dts-mcp-url)");
  }
  let detail: DtsTicketDetail;
  try {
    detail = await ctx.dts.detail(ticket);
  } catch (error) {
    fail(promptCopy("receipts", "mr.title_missing", {
      ticket,
      reason: String(error instanceof Error ? error.message : error),
    }));
  }
  const title = detail.title.trim();
  if (!title) {
    fail(promptCopy("receipts", "mr.title_missing", {
      ticket, reason: "单据标题为空",
    }));
  }
  return title;
}

export function createIssueTools(ctx: IssueToolContext): unknown[] {
  const tools: unknown[] = [];
  const state = ctx.state;
  const scenario = state.scenario;

  /** 会话仓定位:repo 参数(缺省首个登记仓)→ 克隆目录 + 权威地址。
   * 多仓会话全部平铺在 repo/<仓名>/(2026-08-28:仓平等,无主从);
   * 地址比对忽略 .git 后缀,没登记过的仓一律打回。 */
  const locateRepo = (requested: string | undefined): { url: string; dir: string } => {
    const repos = issueRepoWorkspaces(state, ctx.workspace);
    if (!repos.length) fail("会话没有登记代码仓地址");
    const wanted = requested?.trim();
    if (!wanted) return repos[0];
    const match = repos.find((repo) =>
      repo.url === wanted
      || repo.url.replace(/\.git$/i, "") === wanted.replace(/\.git$/i, ""));
    if (!match) {
      fail(promptCopy("receipts", "repo.not_registered", {
        wanted,
        registered: repos.map((repo) => repo.url).join(", "),
      }));
    }
    return match;
  };

  // ---- 阶段门禁(所有会话一律过闸;无场景的存量现场不在任何路线
  // 里,与未开放工具同罪同罚) ----
  // 白名单查阶段注册表:每个阶段在注册表里声明自己开放哪些工具,
  // 简报(引导层)读同一列——这里不再各自硬编码,越权拒绝时反查
  // 注册表报出"允许的阶段"。

  const stageLabel = (): string =>
    scenario
      ? FIXED_STAGE_LABELS[scenario][state.stage as FixedStage] ?? String(state.stage)
      : String(state.stage);

  const gateStage = (tool: string): void => {
    // 举卡即收口(票 #573,六卡一规则):本回合已举过卡(平台闸或
    // Agent 问题卡)——举卡回执已叫 Agent 结束回合,它若继续调平台
    // 工具,这里机械拦下,回执是纠偏不是报错。守卫放在所有阶段门禁
    // 之前。收编了 skill_select 旧专支:存量圈选闸的跨回合拦截改由
    // 回合启动时的存量种子承担(service.beginTurn),六种卡一条规则。
    if (ctx.turnCardRaised?.()) {
      fail(promptCopy("receipts", "gate.turn_card_pending"));
    }
    const allowedStages = scenario ? stagesAllowingTool(scenario, tool) : [];
    if (scenario && stageAllowsTool(scenario, state.stage as FixedStage, tool)) {
      return;
    }
    const allowed = allowedStages
      .map((stage) => FIXED_STAGE_LABELS[scenario!][stage]);
    fail(promptCopy("receipts", "gate.stage_closed", {
      tool,
      stage: stageLabel(),
      allowed: allowed.length
        ? allowed.join(" / ") : "无(本场景流程不含该工具)",
    }));
  };

  // ---- 网管环境配置请求(平台机制,全程可调):日志抓取引擎已下放为
  // 平台技能 fetch-logs(整包自带 bin 引擎,按 SKILL.md 执行),这个工具
  // 只剩一件事——缺网管环境时向用户举配置卡。闸本身(#93 拒绝流/
  // vault 表单/配置通知)不随工具退役,换载体继续服务。 ----

  tools.push(defineTool({
    name: "request_env",
    label: "Request Environment",
    description:
      "需要网管环境(抓日志等)而会话尚未配置时,调它向用户发起配置请求:"
      + "平台举出配置卡(服务器地址+网管后台密码),任何介入档位都会举"
      + "——环境是只有人拿得到的事实。举卡后请立即结束本回合,等待用户"
      + "补配或拒绝:补配后平台会通知你重试刚才的操作,拒绝后平台会开"
      + "新回合让你基于现有证据继续。登记元信息里已有网管环境"
      + "(get_issue_meta 可查)就无需调用,按技能 fetch-logs 直接抓取。",
    parameters: Type.Object({}),
    async execute() {
      // 举卡即收口(票 #573):request_env 不走阶段门禁(全程可调),
      // 但本回合已举过卡时同样拦下——六卡一规则不留例外口。
      if (ctx.turnCardRaised?.()) {
        fail(promptCopy("receipts", "gate.turn_card_pending"));
      }
      if (ctx.environmentPassword?.()) {
        return ok("网管环境已配置(get_issue_meta 可查全量),无需请求——"
          + "按技能 fetch-logs 抓取日志即可。");
      }
      return ok(raiseEnvNeededGate(ctx, "logs"));
    },
  }));

  tools.push(defineTool({
    name: "select_environment",
    label: "Select Environment",
    description:
      "用户在对话中明确给出网管环境 IP 时才调它:按环境管理台账的主 IP "
      + "精确匹配,唯一命中即挂载(服务端解密快照,密码不经你手;按技能 "
      + "fetch-logs 直接抓取)。会话已配环境时可覆盖——登记时选错了,"
      + "用户给出正确 IP 即换。用户没给 IP 时不要自行巡游台账替用户挑"
      + "环境;台账里没有的 IP 会如实打回,转告用户到「环境管理」补录。",
    parameters: Type.Object({
      ip: Type.String({ description: "用户给出的网管环境主 IP(台账唯一键)" }),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: any) {
      // 举卡即收口(票 #573):全程可调工具不走阶段门禁,但本回合已举
      // 过卡时同样拦下——六卡一规则不留例外口。
      if (ctx.turnCardRaised?.()) {
        fail(promptCopy("receipts", "gate.turn_card_pending"));
      }
      const ip = String(params?.ip ?? "").trim();
      if (!ip) fail("ip 不能为空:用户在对话里给出的网管环境主 IP");
      if (!ctx.selectEnvironmentByIp) {
        fail("宿主未接线对话选环境回调,无法挂载——如实告知用户本路暂不可用");
      }
      return ok(ctx.selectEnvironmentByIp(ip));
    },
  }));

  // ---- 拉仓(2026-08-28 拍板:克隆是 Agent 的显式工具动作) ----

  tools.push(defineTool({
    name: "pull_repo",
    label: "Pull Repository",
    description:
      "把一个代码仓加入会话并克隆到 repo/<仓名>/(宿主带凭据执行,你只见"
      + "结果事实)。幂等:已克隆的仓直接回报。有单场景顺带创建修复分支 "
      + "<基线>_<工号>_<单号>_<时间戳>(平台生成并全程固定,以回执为准);"
      + "基线分支在远端不存在时拉仓整次失败,如实"
      + "向用户报告,不要在别的分支上继续。"
      + "发现缺仓就调它:登记清单里的仓、用户给的地址都经它落地。"
      + "命中公共组件仓目录(组件仓库表)的地址落成参考仓——只读参考件,"
      + "可研读,不可修改、不可交付(ADR-0054)。",
    parameters: Type.Object({
      url: Type.String({
        description: "代码仓地址(https 或本地路径);已在会话里的仓幂等回报",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("pull_repo");
      const url = String(params.url ?? "").trim();
      if (!url) fail("url 不能为空:给要拉取的代码仓地址");
      const facts = await ctx.pullRepo(url);
      recordTransition(state, {
        source: "platform",
        note: `代码仓已拉取: ${facts.dir}${facts.cloned ? "(新克隆)" : "(已在场)"}`
          + `${facts.branch ? `,分支 ${facts.branch}` : ""}`
          + `${facts.reference ? "·参考仓(只读)" : ""}`,
      });
      ctx.persist();
      // 拉仓只落地,不再机械推进(2026-08-28 拍板:出口=complete_stage
      // 自报)。拉取阶段的回执带注册表简报指引:还有仓继续拉,拉齐了
      // complete_stage 收口;其余阶段的补仓只回事实,不催收口。
      const guide = scenario && state.stage === "prep_repo"
        ? "\n\n" + promptCopy("receipts", "pull.guide.prep", {
          stage_brief: stageBriefLines(scenario, "prep_repo",
            promptCopy("briefs", "stage.prep_repo")).join("\n"),
        }) + "\n"
        : "";
      return ok(`代码仓就绪:\n- 工作区目录: ${facts.dir}\n`
        + `- HEAD: ${facts.head.slice(0, 12)}`
        + `${facts.branch ? `\n- 修复分支: ${facts.branch}(已切好)` : ""}`
        + `${facts.reference
          ? "\n- 身份: 参考仓(只读参考件:可研读,不可修改、不可交付——"
            + "推送/交付工具对它不可达;需要修改时请用户在元信息页签按"
            + "普通地址指派;指派后重新拉取,即转为平等关联仓)"
          : ""}`
        + `${guide}`);
    },
  }));

  // ---- 移除仓(用户指派,#240;阶段注册表把它补进每个阶段,全程可调) ----
  // 删除语义 = 用户裁定该仓与本问题无关。门禁立场与单号门禁同款:
  // 提示词管不住的侥幸在工具层过不去;网络不可判定=保守拒(宁误拦
  // 不误放);MR 不单独查——远端分支不存在时 MR 自然不可合。

  tools.push(defineTool({
    name: "remove_repo",
    label: "Remove Repository",
    description:
      "把一个仓从本会话移除(仅限用户指派时调用):移除=确认该仓与本"
      + "问题无关,若已有与该仓相关的分析思路或结论,应先重新审视、必要"
      + "时修订后再移除。平台机械门禁:①业务模块的绑定仓不可移除;"
      + "②本会话的修复分支(<基线>_<工号>_<单号>_<时间戳>)还在远端时"
      + "不可移除,要请用户先在代码平台删除远端分支;③远端状态查不到(网络/凭据)"
      + "时保守拒绝,稍后重试。通过后宿主物理删除工作区仓目录,并把该仓"
      + "从会话关联仓清单摘除(首位仓被删时兼容首位字段自动接替新首位),"
      + "删除事实入转移账。repo 必填,必须是会话登记过的仓。参考仓(拉取"
      + "时命中公共组件仓目录的只读参考件)同样可摘:删台账行与工作区"
      + "目录,无修复分支门禁——它本就不建分支(ADR-0054)。",
    parameters: Type.Object({
      repo: Type.String({
        description: "要移除的代码仓地址(会话登记过的);删除必须显式指仓",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("remove_repo");
      const wanted = String(params.repo ?? "").trim();
      if (!wanted) fail("repo 不能为空:删除必须显式指仓(给要移除的代码仓地址)");
      // 参考仓分支(ADR-0054):参考仓不在登记清单,locateRepo 够不着;
      // 摘除 = 删台账行 + 物理删目录。无修复分支门禁——参考仓不建分支,
      // 也无模块绑定可言(命中登记表的非绑定地址才成参考仓)。
      const wantedIdentity = repositoryIdentity(wanted);
      const publicHit = (state.public_repos ?? []).find((row) =>
        repositoryIdentity(row.url) === wantedIdentity);
      if (publicHit) {
        const publicDir = resolve(join(ctx.workspace, "repo", publicHit.name));
        const publicRoot = resolve(ctx.workspace);
        if (publicDir === publicRoot
          || !publicDir.startsWith(publicRoot + sep)) {
          fail(`参考仓工作区目录异常(repo/${publicHit.name}),拒绝删除`);
        }
        rmSync(publicDir, { recursive: true, force: true });
        try {
          const parent = dirname(publicDir);
          if (existsSync(parent) && readdirSync(parent).length === 0) {
            rmdirSync(parent);
          }
        } catch { /* 空目录清理是尽力而为 */ }
        state.public_repos = (state.public_repos ?? [])
          .filter((row) => row !== publicHit);
        recordTransition(state, {
          source: "platform",
          note: `参考仓已摘除(该仓与本问题无关): ${publicHit.url}`
            + `(工作区 repo/${publicHit.name}/)·参考仓(只读)`,
        });
        ctx.persist();
        return ok(`已摘除参考仓 ${publicHit.url}:工作区目录已删除,`
          + "参考仓台账行已移除。参考仓是只读参考件,与登记仓清单无关"
          + "(需要它重新可研读时再调 pull_repo)。");
      }
      // 目录只认登记映射(issueRepoWorkspaces),不吃任何用户路径输入:
      // URL 不在清单=拒;映射值锚死 <工作区>/repo/<仓名> 平铺名,仓名
      // 取地址末段去 .git 且不含路径分隔符,逃逸形态在公共调用面上
      // 构造不出来。下方另有解析路径双保险。
      const target = locateRepo(wanted);
      // 门禁①:模块绑定仓不可移除——模块带出的仓是登记/绑定侧的既定
      // 关系,AI 单方面移除等于改登记。查不到模块(已删除/元数据损坏)
      // 按无绑定仓处理,不挡移除。
      if (state.module_id) {
        let bound: BusinessModule | undefined;
        try {
          bound = readBusinessModule(ctx.dataRoot, state.module_id);
        } catch {
          bound = undefined;
        }
        const isBound = bound?.repositories.some((repo) =>
          repositoryIdentity(repo) === repositoryIdentity(target.url));
        if (isBound) {
          fail(promptCopy("receipts", "remove.bound_module", {
            url: target.url, module: bound!.name,
          }));
        }
      }
      // 门禁②/③(现场现查,不信缓存):远端不可判定=保守拒;已定名
      // 的修复分支还在远端=拒并指路(先删远端分支)。与单号门禁同一
      // 哲学:宁误拦不误放。纯读(ADR-0063 读写分离):只认已定名
      // (fix_branch 或推送/MR 账挂名);无单(manual)会话没有修复分支
      // 可言,解不出已定名的会话从未拉仓——没拉过仓就不可能推过本
      // 会话分支,远端同名探测无意义,直接跳过这道门。
      if (state.ticket) {
        const fixed = fixedFixBranch(state);
        if (fixed) {
          const probe = await remoteBranchState({
            dataDir: ctx.dataRoot,
            repoUrl: target.url,
            branch: fixed,
            credential: ctx.gitCredential?.(),
          });
          if (!probe.reachable) {
            fail(promptCopy("receipts", "remove.remote_unreachable",
              { url: target.url }));
          }
          if (probe.tip) {
            fail(promptCopy("receipts", "remove.remote_branch_left", {
              branch: fixed, url: target.url, tip: probe.tip.slice(0, 12),
            }));
          }
        }
      }
      // 双保险:映射目录解析后必须严格落在会话工作区内(映射已锚死,
      // 这里防的是将来映射改动把逃逸面带进来)。
      const resolvedDir = resolve(target.dir);
      const resolvedRoot = resolve(ctx.workspace);
      if (resolvedDir === resolvedRoot
          || !resolvedDir.startsWith(resolvedRoot + sep)) {
        fail(`工作区目录异常(${target.dir}),拒绝删除`);
      }
      // 执行:物理删除(不存在也容错——登记在册但从未拉取的仓照样
      // 可移除,清的是清单不是目录)。
      rmSync(resolvedDir, { recursive: true, force: true });
      try {
        // repo/ 平铺根空了就顺手收走;清理失败不回滚移除语义。
        const parent = dirname(resolvedDir);
        if (existsSync(parent) && readdirSync(parent).length === 0) {
          rmdirSync(parent);
        }
      } catch { /* 空目录清理是尽力而为 */ }
      // 清单摘除 + 首位接替:repo_url 是 repo_urls[0] 的兼容别名
      // (dual-write),首位被删时接替新首位;清单空则两个字段一起退场。
      const remaining = (state.repo_urls ?? []).filter((url) =>
        url !== target.url);
      if (remaining.length) {
        state.repo_urls = remaining;
        if ((state.repo_url ?? "") === target.url) {
          state.repo_url = remaining[0];
        }
      } else {
        delete state.repo_urls;
        delete state.repo_url;
      }
      recordTransition(state, {
        source: "platform",
        note: `代码仓已移除(用户指派:该仓与本问题无关): ${target.url}`
          + `(工作区 ${target.dir});剩余 ${remaining.length} 个登记仓`
          + `${remaining.length ? `:${remaining.join(", ")}` : "(清单已空)"}`,
      });
      ctx.persist();
      return ok(`已移除代码仓 ${target.url}:工作区目录已删除,`
        + "已从会话关联仓清单摘除。\n"
        + (remaining.length
          ? `剩余 ${remaining.length} 个登记仓:\n`
            + remaining.map((url) => `- ${url}`).join("\n")
          : "会话已没有登记仓(需要时可用 pull_repo 重新登记)。"));
    },
  }));

  // ---- 运维:换库部署(2026-09-02 封存,ADR-0013:换库验证阶段下线,
  // 无阶段开放本工具,调用一律被阶段门禁拒绝;执行体与闸举升代码原地
  // 保留——重启换库时在注册表加回阶段行即可,见 ADR-0013) ----

  tools.push(defineTool({
    name: "build_deploy",
    label: "Build And Deploy",
    description:
      "(暂未启用:当前流程不含换库部署,调用会被拒绝)"
      + "把工作区代码仓(含 deployment/pom.xml)构建并部署到网管服务器,"
      + "自动备份当前版本。多仓会话用 repo 参数指定要部署的仓(缺省首个"
      + "登记仓)。仅页面/前后端改动不要加 include_lib;"
      + "仅当 pom.xml 依赖版本变更时才加。部署后平台会举验证卡,"
      + "必须停下等用户在真实环境验证。",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({
        description: "要部署的代码仓地址;缺省首个登记仓(多仓时按需指定)",
      })),
      hosts: Type.Optional(Type.Array(Type.String(), {
        description: "目标服务器 IP(可多台);缺省用会话环境配置",
      })),
      include_lib: Type.Boolean({
        description: "同时更新 lib 目录;仅 pom.xml 依赖版本变更时为 true",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("build_deploy");
      if (!ctx.ops) fail("宿主未部署运维工具(assets/ops-tools),无法换库");
      const password = ctx.environmentPassword?.();
      if (!password) return ok(raiseEnvNeededGate(ctx, "deploy"));
      const repoDir = locateRepo(params.repo).dir;
      if (!existsSync(join(repoDir, ".git"))) fail("代码克隆不存在,无法部署(先 pull_repo)");
      const hosts = (params.hosts as string[] | undefined)?.length
        ? params.hosts as string[]
        : ctx.state.environment?.hosts ?? [];
      const result = await ctx.ops.buildDeploy({
        projectPath: repoDir,
        hosts,
        password,
        includeLib: Boolean(params.include_lib),
      });
      recordTransition(ctx.state, {
        source: "platform",
        note: `换库部署完成:${result.summary.split("\n")[0]}`,
      });
      // env_verify 问"目标环境是否真修好"——只有用户知道的人工事实
      // (票 03)。一/二档(ADR-0019)不举这张卡:AI 自行核对部署输出
      // 并在报告里记录验证情况,流水线验绿仍是交付终点。
      if ((ctx.interventionTier?.() ?? "2") === "3") {
        // 卡面与 raise_gate 的 env_verify 模板是两处刻意的异文
        // (触发语境:部署完 vs 全绿收口),见 RAISE_GATE_QUESTIONS 头注。
        raiseGate(
          ctx.state,
          "env_verify",
          "换库部署已完成,请在目标环境验证问题是否修复",
          undefined,
          result.summary.split("\n")[0],
        );
        ctx.markTurnCardRaised?.();
        ctx.persist();
        return ok(result.summary
          + "\n平台已举出验证卡,请结束本回合等待用户验证结果——不要自行继续。");
      }
      return ok(result.summary
        + "\n当前介入档位不举验证卡:请自行核对以上部署输出,"
        + "并在分析报告中记录验证情况与结果。");
    },
  }));

  // ---- 举卡工具(ADR-0024):举卡发起权归 AI,平台只做前置事实校验 ----

  /** 卡面问题模板(卡面文案留在代码,ADR-0016 分工;选项出自注册表
   * GATE_OPTIONS,AI 不可注入——决策码是作答协议,不是模型的填空题)。
   * 监看器代举路径在切换票(#246/#247)落地后应收敛引用这里,防两处漂移。 */
  const RAISE_GATE_QUESTIONS: Record<
    "env_verify" | "pipeline_unfixable" | "pipeline_evidence", string> = {
    // env_verify 的另一处卡面:build_deploy 三档部署完举的同款卡
    // (触发语境不同=部署完而非全绿,问题文案各异、选项同出注册表)
    // ——两处都在本文件,改措辞时对着看。
    env_verify:
      "MR 流水线均已通过。请到目标环境验证修复效果:\n"
      + "- 验证通过:无需作答。MR 全部合入即视为验证通过,本单自动归档收口。\n"
      + "- 发现问题:选「验证发现问题」并描述现象(补充说明支持粘贴截图),"
      + "再次进行问题分析。",
    pipeline_unfixable:
      "流水线红灯需要人工在交付平台处理或豁免(改代码解决不了)——"
      + "请在交付平台处理/豁免后,在本卡作答「已在平台处理/豁免,"
      + "重新监看」,平台会重新监看同一提交。",
    pipeline_evidence:
      "流水线红灯缺少可定位的报错原文——请把平台上失败项的报错原文"
      + "(带文件/行号/堆栈)粘贴进本卡作答,原文将作为修复证据回灌"
      + "下一修复回合。",
  };

  tools.push(defineTool({
    name: "raise_gate",
    label: "Raise Human Gate",
    description:
      "向用户举平台人工卡(三种,按 kind 区分)。什么时候该举由你判断,"
      + "但平台只认事实:前置条件不满足会被拒,拒回文案里写了下一步"
      + "该做什么。卡面问题与选项由平台模板决定,你只能带事实性补充"
      + "(supplement),不能自创选项或决策码。落卡即返回——举完就结束"
      + "回合等待用户作答,不要自行继续。",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("env_verify"),
        Type.Literal("pipeline_unfixable"),
        Type.Literal("pipeline_evidence"),
      ], { description:
        "env_verify=请用户到目标环境验证修复效果(前置:全部 MR 跑绿"
        + "且「提交 MR·跑绿」阶段已收口);pipeline_unfixable=红灯需"
        + "人工在交付平台处理/豁免(前置:该仓红灯事实在案);"
        + "pipeline_evidence=请用户回灌失败报错原文(前置同上)" }),
      repo: Type.Optional(Type.String({
        description: "pipeline 两卡必填:红灯所属仓(会话仓清单内的地址)" })),
      supplement: Type.Optional(Type.String({
        description: "事实性补充,随卡展示给用户:失败摘要、现场观察、"
          + "已尝试的动作;只写事实与证据,不写内部操作过程",
        maxLength: 2000 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: any) {
      // 单卡互斥(ADR-0024):任何卡在场都不许再举——两卡并存是
      // issue-53 撞车类 bug 的土壤(作答分派闸优先,Agent 卡成死卡)。
      if (ctx.state.gate) {
        fail(promptCopy("receipts", "raisegate.gate_pending"));
      }
      if (ctx.pendingAgentCard?.()) {
        fail(promptCopy("receipts", "raisegate.card_pending"));
      }
      const kind = String(params?.kind ?? "") as IssueGateKind;
      if (ctx.state.scenario === "mr_repair" && kind === "env_verify") fail("本次从已有 MR 开始，只验证流水线，不要求网管环境验证");
      // 白名单即模板键集:加卡种只改一处(模板表),校验自动跟上。
      if (!(kind in RAISE_GATE_QUESTIONS)) {
        fail(promptCopy("receipts", "raisegate.bad_kind",
          { kind: kind || "(缺席)" }));
      }
      if (kind === "env_verify") {
        // 前置事实:mr_green 已收口。收口只能由验绿全绿放行产生
        // (complete_stage 当场核验或监看器滞后收口,空清单同款),
        // 所以「已收口」本身就蕴含「全绿」——不再查监看账的 status:
        // 那份账由监看器异步刷新,当场收口的窗口期它还停在 running,
        // 查它会把刚收口的合法举卡误拒掉。
        const index = ctx.state.scenario
          ? fixedStageIndex(ctx.state.scenario, "mr_green") : -1;
        if (index < 0
          || (ctx.state.stage_states?.[index] ?? "pending") !== "done") {
          fail(promptCopy("receipts", "raisegate.env_verify_premature"));
        }
        raiseGate(ctx.state, "env_verify",
          RAISE_GATE_QUESTIONS.env_verify, undefined, params.supplement);
        ctx.markTurnCardRaised?.();
        ctx.persist();
        return ok("已举出环境验证卡,请结束本回合等待用户验证"
          + "(可不答——MR 全部合入即视为验证通过)——不要自行继续。");
      }
      // pipeline 两卡:红灯事实必须在平台账上在案(仓+提交定位),
      // resume_watch 裁决重看同一提交靠它。
      const repo = String(params?.repo ?? "").trim();
      if (!repo) {
        fail(promptCopy("receipts", "raisegate.repo_required"));
      }
      const watch = ctx.state.pipelines?.[repo];
      if (!watch || watch.status !== "failed") {
        fail(promptCopy("receipts", "raisegate.no_red_fact", { repo }));
      }
      raiseGate(ctx.state, kind, RAISE_GATE_QUESTIONS[kind], undefined,
        params.supplement, undefined, undefined, { repo, sha: watch.sha });
      ctx.markTurnCardRaised?.();
      ctx.persist();
      return ok(kind === "pipeline_unfixable"
        ? "已举出流水线人工处理卡,请结束本回合等待用户在平台处理/"
          + "豁免后作答——不要自行继续。"
        : "已举出报错回灌卡,请结束本回合等待用户粘贴失败原文作答"
          + "——不要自行继续。");
    },
  }));

  // ---- DTS 查单(工读类:任意阶段可重查;首查回执带注册表简报) ----

  tools.push(defineTool({
    name: "dts_get_ticket",
    label: "Get DTS Ticket",
    description:
      "按单号查 DTS 问题单详情(现象/影响/处理历史),单号缺省用会话已"
      + "绑定的单号,任意阶段都可重查。注意:绑定单号是用户动作——查到"
      + "的单号要用于推送/提MR,需请用户在页面完成绑定。",
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "DTS 问题单号;缺省用会话绑定单号" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.dts) fail("DTS 网关未配置,无法查单(部署需 --dts-mcp-url)");
      const ticket = String(params.ticket ?? "").trim() || ctx.state.ticket;
      if (!ticket) fail("没有单号:请提供 ticket 参数,或请用户先绑定单号");
      const detail = await ctx.dts.detail(ticket);
      // 内嵌截图落工作区(#42):描述里的 <img> 下载到 ticket-images/
      // 并把 AI 可见文本里的 URL 改写为工作区相对路径,随后可对本地
      // 路径调 inspect_image 识图。fail-open:下载是旁路,单图失败/
      // 超时/超限只标注缺失,详情照常返回,绝不因此堵住查单。
      let contentText = detail.content;
      let imageNote = "";
      const description = detail.description ?? detail.content;
      if (/<img\s[^>]*?src="/i.test(description)) {
        try {
          const outcome = await syncTicketImages({
            description,
            ticket: detail.ticket,
            workspace: ctx.workspace,
            gateway: ctx.dts,
            log: ctx.log,
          });
          contentText = applyTicketImageRewrites(contentText, outcome.downloads);
          imageNote = renderTicketImageNote(outcome);
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error);
          imageNote = `[内嵌图] 下载环节异常,本次未处理(详情照常): ${reason}`;
          ctx.log?.(`[issue-tools] 内嵌图处理失败(${detail.ticket}): ${reason}`);
        }
      }
      recordTransition(ctx.state, {
        source: "platform",
        note: `DTS 单 ${detail.ticket} 详情已获取`,
      });
      ctx.persist();
      // 首查不再机械推进:回执提醒"读完单据 complete_stage 收口"(出口
      // 条文在注册表,阶段转移时 complete.stage_closed 会带下一阶段简报)。
      const briefing = scenario && state.stage === "dts_info"
        ? "\n\n" + promptCopy("receipts", "dts.briefing") + "\n"
        : "";
      return ok(`问题单 ${detail.ticket} 详情:\n${contentText}`
        + (imageNote ? `\n\n${imageNote}` : "")
        + `${briefing}`);
    },
  }));

  // ---- 登记元信息(工读类:任意阶段可查;与 dts_get_ticket 分工) ----
  // 人手工登记的输入全量(标题/现象/附件/模块/仓/产品版本/网管环境
  // 四件套/登记人与责任人)加现场指针(形态/单号/修复分支/知识仓/转正
  // 来源),与提示词的元信息块同出 issueRegistrationMeta 一源;网管口令
  // 按 ADR-0003 明文返回。只读:不碰状态、不落盘、不推进阶段。

  tools.push(defineTool({
    name: "get_issue_meta",
    label: "Get Issue Meta",
    description:
      "获取本会话的登记元信息——人填的登记输入全量与现场指针:流程形态"
      + "(有单/无单)、标题、现象描述、登记附件(日志等文件的相对路径,"
      + "优先查看)、业务模块、代码仓(地址与工作区路径)、产品版本与拉仓"
      + "基线分支、单号与修复分支(有单才有)、知识仓指针、登记人与责任人"
      + "工号、网管环境(地址/形态/后台密码/独立 root 密码(仅显式设置"
      + "时),现场公开默认值,明文返回)。"
      + "任意阶段都可调用,长会话里随时重查,不必翻找历史上下文。大块内容"
      + "只给指针:知识仓给 repo/ 下的路径,附件给文件路径,内容自行读取。"
      + "与 dts_get_ticket 的分工:登记元信息是人填的输入,查它用本工具;"
      + "按单号拉问题单详情(平台拉的)用 dts_get_ticket,两者不可混用。",
    parameters: Type.Object({}),
    async execute() {
      const meta = issueRegistrationMeta(state, {
        backend: ctx.environmentPassword?.(),
        root: ctx.rootPassword?.(),
      });
      return ok(JSON.stringify(meta, null, 2));
    },
  }));

  // ---- 推送(自问题修改阶段起;机械单号门禁全程同在) ----

  // issue-14 推送反复失败收口(2026-09-10):执行器会并行跑同一消息里
  // 的多个工具调用(生产实测同毫秒双 push_branch)。在途互斥把改工作区
  // 的分支传输串行化,并发第二个直接打回;多仓节奏=逐仓串行,节奏教给
  // 回执(push.busy/sync.busy)与工具说明。sync_branch(ADR-0074)与
  // push_branch 共用同一把锁——两者都在工作区做 fetch/merge,各持一把
  // 等于没有互斥;回合开始探针(ADR-0074 票 3)也取同一把(服务侧经
  // ctx 传入 LiveIssue 级单例),忙时跳过吸收不阻塞回合;缺席(裸构造
  // /直调)自建一把,工具语义不变。
  const branchTransfer = ctx.branchTransfer ?? createBranchTransferMutex();
  const runPush = async (params: any) => {
    gateStage("push_branch");
    const state = ctx.state;
    if (!state.ticket && !state.imported_mr) {
      fail(promptCopy("receipts", "push.no_ticket"));
    }
    const repo = locateRepo(params.repo);
    if (!existsSync(join(repo.dir, ".git"))) fail("代码克隆不存在,无法推送(先 pull_repo)");
    const branch = String(params.branch ?? "").trim()
      || await currentBranch(repo.dir);
    if (!branch) fail("没有可推送的分支(缺 branch 参数且当前不在分支上)");
    const expected = resolveFixBranch(state);
    if (branch !== expected) {
      fail(promptCopy("receipts", "push.branch_mismatch",
        { expected, branch }));
    }
    const ticket = state.ticket ?? `MR !${state.imported_mr!.iid}`;
    // 强制覆盖意图(ADR-0063 修订):新命名下正常流程不会再撞远端同名
    // 分支,force 保留防平台侧罕见异动。覆盖前先现查远端同名分支当前
    // 位置并核对推送收据(issueGit 侧的收据门,ADR-0074),对不上即
    // 拒推——不盲盖。已建 MR 的会话维持机械禁 force(放行参数也放不了
    // 行);显式放行(override_external)只在人工核对远端后有意义。
    const force = params.force === true;
    if (force && state.imported_mr) fail("已有 MR 修复不允许强制覆盖源分支，请保留其他人的提交");
    const overrideExternal = params.override_external === true;
    if (overrideExternal && !force) {
      fail("override_external 只在 force=true 的强制覆盖里有意义,单独传"
        + "不构成任何操作;若目的是拿到远端最新代码,正常推送即可"
        + "(远端有手改时平台会自动并入)");
    }
    // 脏工作区熔断做实(2026-08-28 真实环境事故;ADR-0071):已跟踪
    // 文件有未提交改动即拒推——push 推已提交历史,带脏改动推只会推出
    // 旧 HEAD(MR 没 diff),基线合并也要求干净的树。未跟踪的过程产物
    // 不拦(不改变推送内容;真与基线合并相撞时同步会如实报错让路)。
    const dirty = (await dirtyWorktree(repo.dir))
      .filter((line) => !line.startsWith("??"));
    if (dirty.length) {
      fail(promptCopy("receipts", "push.dirty", {
        ticket, count: dirty.length, files: dirty.join("\n"),
      }));
    }
    // 推送收据投影(ADR-0064 去重,同仓同分支口径):非 force 路径取
    // 末笔作吸收锚点;force 路径整组传给收据门(ADR-0074)。
    const receipts = ledgerReceiptsOf(state.transitions ?? [], repo.url, branch);
    // 推送前外部提交吸收(ADR-0074):用户把手改拉到本地推回远端是协作
    // 的正常形态——远端修复分支头前进(本会话最后一笔推送收据的严格
    // 后代)即先 fetch+merge 进工作区再推;撞冲突还原现场交回本回合;
    // 三类非严格后代形态(历史被改写/无收据而远端有提交/远端被回滚)
    // 一律拒绝喊人,绝不自动处理、绝不 force。探针/取回失败 fail-open
    // 照推留痕(非强制推送推不动分叉的远端,门在远端拒收)。
    // force=true 是调用方显式下达的覆盖指令,吸收判定不代为改判;force
    // 自己的门(收据核对 + 租赁核对,同一次探针)在 pushFromIssueWorkspace
    // 内,拒绝时在下面的推送环节给出收据回执。
    let absorbedNote = "";
    if (!force) {
      const lastReceiptSha = receipts.at(-1)?.sha;
      const absorb = await absorbExternalCommits({
        dataDir: ctx.dataRoot,
        repoDir: repo.dir,
        repoUrl: repo.url,
        branch,
        ticket,
        receiptSha: lastReceiptSha,
        credential: ctx.gitCredential?.(),
      });
      if (absorb.kind === "synced") {
        // 吸收记账走三入口共用的助手(absorbLedger):范围小结 + 逐笔
        // 留痕、计数清零、落盘、修属主,一条不漏(归属统计的来源)。
        recordAbsorbedCommits(ctx, repo, branch, absorb, lastReceiptSha!);
        absorbedNote = `;已并入远端外部提交 ${absorb.commits.length} 条`;
      } else if (absorb.kind === "conflict") {
        // 连续冲突计数与升级提示(#589,基线同步 ADR-0071 同款形态)。
        const escalate = absorbConflictEscalation(ctx, "推送");
        fail(promptCopy("receipts", "push.absorb_conflict", {
          branch, ticket,
          count: absorb.files.length,
          files: absorb.files.join("\n"),
        }) + escalate);
      } else if (absorb.kind === "blocked") {
        const finding = absorbBlockedFinding(absorb, lastReceiptSha);
        recordTransition(state, {
          source: "platform",
          note: `推送前外部提交检查未通过,已拒绝推送:${finding};`
            + "需人工核对,平台绝不自动处理",
        });
        ctx.persist();
        fail(promptCopy("receipts", "push.absorb_blocked", { finding }));
      } else if (absorb.kind === "dirty") {
        fail(promptCopy("receipts", "push.dirty", {
          ticket, count: absorb.files.length, files: absorb.files.join("\n"),
        }));
      } else if (absorb.kind === "failed") {
        fail(promptCopy("receipts", "push.absorb_failed", { reason: absorb.reason }));
      } else if (absorb.kind === "unavailable") {
        recordTransition(state, {
          source: "platform",
          note: `推送前外部提交吸收跳过(远端探针/取回失败): ${absorb.reason};`
            + "按原分支继续推送",
        });
        ctx.persist();
      }
    }
    // 推送前基线同步(ADR-0071):基线有新提交先并进修复分支再推,MR
    // 始终基于新鲜的基线;撞冲突当场交回 Agent 解决后重推。取不到基线
    // 按 fail-open 照推留痕,传输故障不卡交付。
    const baseline = state.baseline?.trim();
    let syncedNote = "";
    if (baseline) {
      const sync = await syncBaselineBeforePush({
        dataDir: ctx.dataRoot,
        repoDir: repo.dir,
        repoUrl: repo.url,
        baseline,
        ticket,
        credential: ctx.gitCredential?.(),
      });
      if (sync.kind === "unavailable") {
        recordTransition(state, {
          source: "platform",
          note: `推送前基线同步跳过(取基线失败): ${sync.reason};按原分支继续推送`,
        });
        ctx.persist();
      } else if (sync.kind === "synced") {
        // 按仓记账(一仓一分支):重推同仓覆盖旧账,不同仓各记各的。
        const syncs = state.baseline_syncs ??= [];
        const slot = syncs.findIndex((item) => item.repo === repo.url);
        if (slot >= 0) syncs[slot] = sync.record; else syncs.push(sync.record);
        recordTransition(state, {
          source: "platform",
          note: `推送前基线同步:${repo.url} ${sync.record.baseline} `
            + `${sync.record.from.slice(0, 12)} → ${sync.record.to.slice(0, 12)},`
            + `并入 ${sync.record.commits} 条新提交`,
        });
        ctx.persist();
        // 宿主合并把基线变更以宿主身份写进工作区,交回容器前修属主,
        // Agent 后续改得动(与冲突路径同一纪律);非隔离部署零开销。
        ctx.repairOwnership?.(repo.dir);
        syncedNote = `;已并入基线 ${sync.record.baseline} 的 `
          + `${sync.record.commits} 条新提交`;
      } else if (sync.kind === "conflict") {
        const streak = (state.baseline_sync_conflicts ?? 0) + 1;
        state.baseline_sync_conflicts = streak;
        ctx.persist();
        // 冲突现场交回容器前修属主:宿主 merge 以宿主身份写文件,不修
        // 容器用户改不动(ADR-0071);非隔离部署/裸构造缺席即免修。
        ctx.repairOwnership?.(repo.dir);
        const escalate = streak >= 3
          ? `\n\n基线持续变动:已连续 ${streak} 次推送撞上基线新提交的冲突,`
            + "建议先与用户人工确认合并时机,再继续解决推送。"
          : "";
        fail(promptCopy("receipts", "push.sync_conflict", {
          baseline, ticket,
          count: sync.files.length,
          files: sync.files.join("\n"),
        }) + escalate);
      } else if (sync.kind === "failed") {
        fail(promptCopy("receipts", "push.sync_failed", { reason: sync.reason }));
      }
    } else {
      // 有单会话基线必在(登记闸保证);缺席属异常状态,留痕后照推。
      recordTransition(state, {
        source: "platform",
        note: "推送前基线同步跳过:会话没有基线分支,按原分支继续推送",
      });
      ctx.persist();
    }
    const codecheck = await ctx.beforePush?.(repo);
    ctx.assertActive?.();
    const pushOnce = async () => {
      try {
        return await pushFromIssueWorkspace({
          dataDir: ctx.dataRoot,
          repoDir: repo.dir,
          repoUrl: repo.url,
          branch,
          credential: ctx.gitCredential?.(),
          log: ctx.log,
          ...(force ? { force: true } : {}),
          ...(force
            ? { forceReceiptShas: receipts.map((entry) => entry.sha) }
            : {}),
          ...(force && overrideExternal ? { forceOverrideExternal: true } : {}),
        });
      } catch (error) {
        // force 收据门的机械拒绝(ADR-0074):错误只带事实,人话回执与
        // 留痕在工具层组装(ADR-0016)。
        if (error instanceof ForceReceiptGateError) {
          const finding = error.reason === "external"
            ? `远端分支当前提交 ${error.remoteTip.slice(0, 12)} 不在本会话`
              + "推送收据内(平台不知道的外部提交)"
            : "远端状态查不到,无法核对推送收据";
          recordTransition(state, {
            source: "platform",
            note: `强制覆盖被收据门拒绝:${finding};需人工核对后显式放行`,
          });
          ctx.persist();
          // 各自取各的文案:force_unreachable 模板没有 {{tip}} 槽,不传
          // 占位参数。
          fail(error.reason === "external"
            ? promptCopy("receipts", "push.force_external",
              { tip: error.remoteTip.slice(0, 12) || "-" })
            : promptCopy("receipts", "push.force_unreachable"));
        }
        throw error;
      }
    };
    const receipt = await pushOnce();
    // 按仓记账(一仓一分支):重推同仓覆盖旧账,不同仓各记各的。
    const pushes = state.pushes ??= [];
    const record = {
      repo: repo.url, branch: receipt.branch,
      sha: receipt.sha, at: new Date().toISOString(),
    };
    const slot = pushes.findIndex((item) => item.repo === repo.url);
    if (slot >= 0) pushes[slot] = record; else pushes.push(record);
    // 推送成功即清零连续同步冲突计数(ADR-0071:「连续」指推送接连被拒)。
    if (state.baseline_sync_conflicts) state.baseline_sync_conflicts = 0;
    // 外部提交合并的连续冲突计数同理(#589):走到推送即吸收没有拦路
    // (拦路在前面就拒推了),与基线同步计数互相独立。
    if (state.absorb_conflicts) state.absorb_conflicts = 0;
    recordTransition(state, {
      source: "platform",
      note: `分支已推送 ${repo.url} ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`
        + (receipt.forced ? "(强制覆盖远端同名分支)" : ""),
    });
    ctx.persist();
    // 推送事实上报:已有 MR 的仓由宿主按新 SHA 重挂流水线监看。
    ctx.onBranchPushed?.(repo.url);
    return ok(`已推送 ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`
      + `(仓 ${repo.url})${receipt.forced ? "(强制覆盖远端同名分支)" : ""}`
      + `${syncedNote}${absorbedNote}`
      + (codecheck ? `\n${codecheck}` : ""));
  };
  tools.push(defineTool({
    name: "push_branch",
    label: "Push Branch (Host)",
    description:
      "把当前修复分支经宿主推送到远端(容器里 git push 被禁用,推送一律"
      + "走本工具)。平台机械校验:会话已绑定单号、分支名为会话修复分支"
      + "(<基线>_<工号>_<单号>_<时间戳>,平台生成并全程固定,以拉仓回执"
      + "为准);多仓交付逐仓串行推送,推送后返回 SHA。"
      + "推送前宿主自动做两件并账:远端修复分支有用户手改推回的新提交"
      + "(本会话推送收据的后代)先合并进工作区再推;基线有新提交先合并"
      + "进修复分支再推。撞冲突时本次推送被拒、回执列冲突文件——按回执"
      + "解决冲突并 commit 后重推即可,不要绕开。远端历史与本会话推送"
      + "收据对不上(被改写/回滚/来历不明的新提交)时推送被拒并要求"
      + "人工核对:停止重试、绝不带 force,把情况转告用户。"
      + "force=true 强制覆盖远端同名分支:新命名下正常流程不会撞名,"
      + "只防平台侧罕见异动。覆盖前过收据门:远端当前提交必须是本会话"
      + "推送过的(远端有用户手改推回的外部提交、或远端状态查不到,都"
      + "会被机械拒绝),人工核对远端分支确认可以覆盖后,带 override_external"
      + "=true 重推才放行。",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({
        description: "要推送的分支;缺省取代码仓当前分支",
      })),
      repo: Type.Optional(Type.String({
        description:
          "目标代码仓地址;缺省首个登记仓。必须是会话登记过的仓"
          + "(多仓分析时其余关联仓也能推,分支命名规则不变)",
      })),
      force: Type.Optional(Type.Boolean({
        description:
          "强制推送:覆盖远端同名分支(新命名下正常流程不会撞名,"
          + "只防平台侧罕见异动)。远端当前提交不是本会话推送过的、或"
          + "远端状态查不到时会被收据门拒绝;人工核对后加 override_external 放行",
      })),
      override_external: Type.Optional(Type.Boolean({
        description:
          "强制覆盖的显式放行:仅在 force=true 被收据门拒绝、且用户已"
          + "人工核对远端分支确认没有需要保留的手改后,与 force=true "
          + "一起传;单独传不构成任何操作",
      })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (branchTransfer.inFlight()) fail(promptCopy("receipts", "push.busy"));
      branchTransfer.acquire();
      try {
        return await runPush(params);
      } finally {
        branchTransfer.release();
      }
    },
  }));

  // ---- 分支同步(ADR-0074 票 2):Agent 可执行的显式同步入口 ----
  // 容器里没有拉取动作,pull_repo 克隆即冻结——"先拉最新代码再修"这类
  // 指引要可执行,就得有这个工具。薄封装 absorbExternalCommits(票 1 的
  // 判定核心,推送链路与回合开始探针共用),四种回执:已最新/合并完成
  // (带吸收事实)/冲突清单(现场已还原)/异常喊人;dirty/unavailable/
  // failed 三个环境形态也各有回执,不把说不清的现场丢给 Agent。

  const runSync = async (params: any) => {
    gateStage("sync_branch");
    const state = ctx.state;
    if (!state.ticket && !state.imported_mr) {
      fail(promptCopy("receipts", "sync.no_ticket"));
    }
    const repo = locateRepo(params.repo);
    if (!existsSync(join(repo.dir, ".git"))) {
      fail("代码克隆不存在,无法同步(先 pull_repo)");
    }
    const branch = String(params.branch ?? "").trim()
      || await currentBranch(repo.dir);
    if (!branch) fail("没有可同步的分支(缺 branch 参数且当前不在分支上)");
    const expected = resolveFixBranch(state);
    if (branch !== expected) {
      fail(promptCopy("receipts", "push.branch_mismatch",
        { expected, branch }));
    }
    const ticket = state.ticket ?? `MR !${state.imported_mr!.iid}`;
    // 吸收判定的锚点:本会话在该仓该分支的最后一笔推送收据(与推送链路
    // 同一份收据投影,两边判定不漂移)。
    const lastReceiptSha = lastReceiptOf(state.transitions ?? [],
      repo.url, branch)?.sha;
    const absorb = await absorbExternalCommits({
      dataDir: ctx.dataRoot,
      repoDir: repo.dir,
      repoUrl: repo.url,
      branch,
      ticket,
      receiptSha: lastReceiptSha,
      credential: ctx.gitCredential?.(),
    });
    if (absorb.kind === "current") {
      // 远端头已被本地包含 = 冲突(若有)已了结,计数从 1 重数(#589)。
      resetAbsorbConflicts(ctx);
      return ok(promptCopy("receipts", "sync.current", { branch }));
    }
    if (absorb.kind === "synced") {
      // 吸收记账走三入口共用的助手(absorbLedger):与推送链路同一份
      // 文案与落盘(逐笔条目喂外部头观测投影,归属统计据此记平台外)。
      recordAbsorbedCommits(ctx, repo, branch, absorb, lastReceiptSha!);
      return ok(promptCopy("receipts", "sync.merged", {
        branch,
        count: absorb.commits.length,
        from: lastReceiptSha!.slice(0, 12),
        to: absorb.remoteTip.slice(0, 12),
      }));
    }
    if (absorb.kind === "conflict") {
      // 连续冲突计数与升级提示(#589,基线同步 ADR-0071 同款形态)。
      const escalate = absorbConflictEscalation(ctx, "同步");
      fail(promptCopy("receipts", "sync.conflict", {
        branch, ticket,
        count: absorb.files.length,
        files: absorb.files.join("\n"),
      }) + escalate);
    }
    if (absorb.kind === "blocked") {
      const finding = absorbBlockedFinding(absorb, lastReceiptSha);
      recordTransition(state, {
        source: "platform",
        note: `分支同步的外部提交检查未通过,已拒绝同步:${finding};`
          + "需人工核对,平台绝不自动处理",
      });
      ctx.persist();
      fail(promptCopy("receipts", "sync.blocked", { finding }));
    }
    if (absorb.kind === "dirty") {
      fail(promptCopy("receipts", "sync.dirty", {
        ticket, count: absorb.files.length, files: absorb.files.join("\n"),
      }));
    }
    if (absorb.kind === "unavailable") {
      fail(promptCopy("receipts", "sync.unavailable", { reason: absorb.reason }));
    }
    fail(promptCopy("receipts", "sync.failed", { reason: absorb.reason }));
  };
  tools.push(defineTool({
    name: "sync_branch",
    label: "Sync Branch (Host)",
    description:
      "把远端修复分支的最新提交同步进工作区(容器里没有拉取动作,同步"
      + "一律走本工具):远端没动回执无需同步;有用户手改推回的新提交"
      + "(本会话推送收据的后代)机械合并进工作区并回执结果;撞真实冲突"
      + "时现场已还原,按回执列出的冲突文件自己完成合并再提交——外部"
      + "提交是用户手改,不许回滚、不许 ours/theirs 一选了事;远端历史"
      + "与本会话推送收据对不上(被改写/回滚/来历不明的新提交)时拒绝"
      + "并喊人:停止操作、绝不带 force,把情况转告用户。本工具只同步"
      + "不推送,交付仍走 push_branch。",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({
        description: "要同步的分支;缺省取代码仓当前分支",
      })),
      repo: Type.Optional(Type.String({
        description:
          "目标代码仓地址;缺省首个登记仓。必须是会话登记过的仓"
          + "(多仓分析时其余关联仓也能同步,分支命名规则不变)",
      })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (branchTransfer.inFlight()) fail(promptCopy("receipts", "sync.busy"));
      branchTransfer.acquire();
      try {
        return await runSync(params);
      } finally {
        branchTransfer.release();
      }
    },
  }));

  // ---- MR 创建(仅提交MR·跑绿阶段;验绿由 complete_stage 的
  // MR 验绿门程序化把守,UT 不再是建 MR 前置) ----

  tools.push(defineTool({
    name: "create_mr",
    label: "Create Merge Request",
    description:
      "为已推送的修复分支创建合并请求(经交付平台适配层调 codehub CLI;"
      + "单号自动关联,合入由用户在门禁通过后决定)。前置:已绑定单号、"
      + "分支已 push_branch。MR 标题平台代笔=问题单标题(CodeHub 要求"
      + "精确相等),不用也不能自拟。",
    parameters: Type.Object({
      target_branch: Type.Optional(Type.String({
        description: "目标分支;缺省会话基线分支(登记产品版本映射)",
      })),
      repo: Type.Optional(Type.String({
        description: "目标代码仓地址;缺省首个登记仓。必须是会话登记过的仓",
      })),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("create_mr");
      const state = ctx.state;
      if (!state.ticket) {
        fail(promptCopy("receipts", "mr.no_ticket"));
      }
      const platformUrl = ctx.platformUrl;
      if (!platformUrl) {
        fail("交付平台未配置(部署需 --platform 接适配层),无法创建 MR");
      }
      // 按仓门禁与记账(2026-08-28 拍板:对哪些仓交付由 AI 裁决,平台
      // 只核"该仓自己推过分支"这一条机械事实)。
      const repo = locateRepo(params.repo);
      const pushRecord = state.pushes?.find((item) => item.repo === repo.url);
      if (!pushRecord) {
        fail(promptCopy("receipts", "mr.no_push", { repo: repo.url }));
      }
      // 目标分支缺省=会话基线(#441):登记必选产品版本(2026-09-18,自动
      // 接单同样以映射命中为闸),版本映射分支就是合入口径,AI 不传参
      // 也打不偏——2026-09-27 现场即因这里静默落 master,把 26C10 的
      // 修复 MR 打到了 master。无基线(直连接口/存量会话)如实拒绝,
      // 不再猜;多目标交付仍由 AI 显式传参(2026-08-28 裁量权)。
      const target = String(params.target_branch ?? "").trim()
        || String(state.baseline ?? "").trim();
      if (!target) {
        fail("会话没有基线分支(登记未带产品版本),无法确定 MR 目标:"
          + "请显式传 target_branch");
      }
      const previous = state.mrs?.find((item) => item.repo === repo.url
        && item.branch === pushRecord.branch && item.target === target);
      const title = await issueMrTitle(ctx, state.ticket);
      const receipt = await createMergeRequest({
        platformUrl,
        repo: repo.url,
        sourceBranch: pushRecord.branch,
        targetBranch: target,
        title,
        dtsNo: state.ticket,
        credential: ctx.gitCredential?.(),
        participants: resolveModuleMrParticipants(ctx.dataRoot, state.module_id, repo.url),
      });
      const mrs = state.mrs ??= [];
      const participants = previous?.url === receipt.url
          && previous.participants
          && (!receipt.participants || receipt.participants.status === "skipped")
        ? previous.participants : receipt.participants;
      const participantsNote = mrParticipantsMessage(participants);
      const record = {
        repo: repo.url, branch: pushRecord.branch, target,
        title,
        url: receipt.url,
        ...(receipt.id !== undefined ? { iid: String(receipt.id) } : {}),
        at: new Date().toISOString(),
        ...(participants ? { participants } : {}),
      };
      const slot = mrs.findIndex((item) => item.repo === repo.url);
      if (slot >= 0) mrs[slot] = record; else mrs.push(record);
      recordTransition(state, {
        source: "platform",
        note: `MR 已创建: ${receipt.url}`
          + (participantsNote ? `\n${participantsNote}` : ""),
      });
      ctx.persist();
      ctx.onMrCreated?.(repo.url);
      return ok(`MR 已创建: ${receipt.url}\n(source ${pushRecord.branch} → ${target},`
        + `仓 ${repo.url},关联单号 ${state.ticket})。\n`
        + (participantsNote ? `${participantsNote}\n` : "")
        + `${promptCopy("receipts",
          "mr.receipt.fixed")}`);
    },
  }));

  // ---- 以下工具绑场景注册表(无场景的存量现场不注册) ----

  if (scenario) {
    // 提交分析报告:人工闸的入口(有单=报告确认;无单=结论确认)
    tools.push(defineTool({
      name: "submit_analysis",
      label: "Submit Analysis Report",
      description:
        "宣布问题分析完成,提交工作区根目录的 issue-analysis.md——平台以"
        + "文件在场且四章节齐全为门票(模板与写法见技能 issue-analysis),"
        + "缺章节直接打回。提交后确认卡转给用户:有单确认后进问题修复;"
        + "无单须给 conclusion(issue=是问题/non_issue=非问题)由用户定夺。",
      parameters: Type.Object({
        conclusion: Type.Optional(Type.Union(
          [Type.Literal("issue"), Type.Literal("non_issue")],
          { description: "分析结论(无单场景必填):issue=是问题 / non_issue=非问题" },
        )),
        confidence: Type.Optional(Type.Union(
          [Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
          { description: "结论置信度自报(无单场景消费:non_issue 且 high 在"
            + "全自动档自动闭环归档;缺省按置信度不足处理,人工裁决)" },
        )),
        summary: Type.String({
          description: "一段话结论摘要:根因与方向(或非问题的判定依据),会展示给用户",
        }),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("submit_analysis");
        const report = analysisReportPath(ctx);
        if (!existsSync(report)) {
          fail(promptCopy("receipts", "analysis.no_report"));
        }
        const missing = missingAnalysisSections(readFileSync(report, "utf-8"));
        if (missing.length) {
          fail(promptCopy("receipts", "analysis.missing_sections",
            { missing: missing.join("、") }));
        }
        const summary = String(params.summary ?? "").trim();
        if (!summary) fail("summary 不能为空:给用户看的结论摘要");
        if (scenario === "no_ticket"
            && params.conclusion !== "issue" && params.conclusion !== "non_issue") {
          fail("无单场景必须给 conclusion(issue=是问题 / non_issue=非问题)");
        }
        const proposal = {
          ...(params.conclusion ? { conclusion: params.conclusion } : {}),
          ...(params.confidence ? { confidence: params.confidence } : {}),
          summary,
          report,
        };
        if (scenario === "no_ticket") {
          // 无单场景:结论的确认本身就是「确定结论」节点——先推进再举闸,
          // 进度条上用户看到的就是"正在等确认"。
          fixedAdvance(ctx.state, "conclude",
            `分析结论:${params.conclusion === "non_issue" ? "非问题" : "是问题"},等待用户确认`);
          raiseGate(
            ctx.state, "conclude",
            `分析结论:${params.conclusion === "non_issue" ? "非问题" : "是问题"}——${summary}`,
            proposal,
          );
        } else {
          raiseGate(
            ctx.state, "analysis_confirm",
            `问题分析报告已产出(${summary}),请查阅 issue-analysis.md 后确认`,
            proposal,
          );
        }
        ctx.markTurnCardRaised?.();
        // 检视回合收口(ADR-0007):新一轮报告提交即举确认卡,检视
        // 入口随之恢复——in-flight 标记在此清除。
        delete ctx.state.review_active;
        ctx.persist();
        return ok(promptCopy("receipts", scenario === "no_ticket"
          ? "analysis.submitted.no_ticket"
          : "analysis.submitted.ticket"));
      },
    }));

    // ---- 检视分诊(ADR-0035):意见递给 AI 逐条自判回复型/修改型 ----
    // 回复型(澄清/追问/确认)由 respond_review 在意见处回复,原地闭环;
    // 含修改型的批次由 declare_review_rework 申报,平台执行原整体回退
    // 链路(此刻才冻结版本快照)。两工具全程可调(见 stageRegistry)。

    /** 回执里的可引用意见摘要(#366):逐条带台账 id、位置与要求线索
     * ——上下文压缩丢了意见正文后,AI 第一次用错编号就能从回执拿到
     * 全部意见内容,一次修正到位;quote/上下文不进回执,完整原文
     * 指路 reviews/review-notes.md 快照。 */
    const reviewSummaries = (items: ReturnType<ReturnType<typeof reviewStore>["list"]>) =>
      items.map((item) => {
        const note = String(item.note ?? "").replace(/\s+/g, " ").trim();
        const brief = note.length > 60 ? `${note.slice(0, 60)}…` : note;
        return `意见${item.seq} [${item.id}] ${item.file}:${item.line} — ${brief}`;
      }).join("\n") || "无";

    /** 按意见号或台账 id 定位一条已送出的检视意见;定位不到如实打回,
     * 不给 AI 拿幻觉意见号落账的口子。打回时附全部可引用意见的摘要
     * 与快照指路(#366),不让 AI 拿着编号猜内容。 */
    const locateSentReview = (reference: number | string) => {
      const store = reviewStore(ctx.workspace);
      const items = store.list().filter((item) =>
        item.status === "sent" && item.sent_via === "issue_review");
      const match = typeof reference === "number" || /^\d+$/.test(String(reference))
        ? items.find((item) => item.seq === Math.trunc(Number(reference)))
        : items.find((item) => item.id === String(reference).trim());
      if (!match) {
        fail(promptCopy("receipts", "review.unknown_ref",
          { reference, known: reviewSummaries(items) }));
      }
      return match;
    };

    tools.push(defineTool({
      name: "respond_review",
      label: "Respond To Review",
      description:
        "对检视意见逐条回复(检视分诊的回复型闭环):按意见号对每条意见"
        + "给出回复文本,平台落账后在检视意见面板对该意见下可见。回复型"
        + "意见(澄清、追问、确认语义)用它原地闭环——不回退、不改报告、"
        + "不出版本。用户可在意见处对你的回复再回复,平台会把线程递回"
        + "(needs_clarification 的补充说明就是这么回来的),收到后对同一"
        + "意见重新调用本工具作答即可。outcome 按语义选:"
        + "needs_clarification=要用户补充说明;"
        + "not_fixed=解释说明/确认无需改动;fixed=确已按意见改动(附依据)。"
        + "对 MR 检视意见(CodeHub 讨论区来的,清单会注明)作答时,回复"
        + "正文会由平台自动发布回 CodeHub 讨论——正文要自足,写清改了什么"
        + "(附提交号)或答复了什么,检视人在 CodeHub 只看得到这段话。"
        + "本批含修改型意见时,回复完仍须调 declare_review_rework 申报;"
        + "修改型批次在重写完成后,也用它对本批意见逐条交代(改了什么,"
        + "outcome=fixed 附依据)再重新 submit_analysis——报告正文不写"
        + "应答段,检视回复只落在意见处。",
      parameters: Type.Object({
        items: Type.Array(Type.Object({
          review: Type.Union([Type.Number(), Type.String()], {
            description: "意见号(清单里的「意见N」的 N)或台账 id",
          }),
          reply: Type.String({
            description: "给用户的回复原文(完整话,不是\"已知悉\")",
          }),
          outcome: Type.Union([
            Type.Literal("fixed"),
            Type.Literal("not_fixed"),
            Type.Literal("needs_clarification"),
          ], { description: "处理结果:fixed=已按意见改动/not_fixed=无需改动"
            + "/needs_clarification=要用户补充说明" }),
          evidence: Type.Optional(Type.Array(Type.String(), {
            description: "依据(改动的文件/位置);纯答复可空",
          })),
        }), { description: "逐条回复清单,一次可回多条" }),
      }),
      async execute(_toolCallId: string, params: any) {
        const entries = Array.isArray(params.items) ? params.items : [];
        if (!entries.length) fail("items 不能为空:至少回复一条检视意见");
        const store = reviewStore(ctx.workspace);
        const receipts: string[] = [];
        for (const entry of entries) {
          const target = locateSentReview(entry.review);
          const reply = String(entry.reply ?? "").trim();
          if (!reply) fail(`意见${target.seq} 的回复不能为空:要给用户完整话`);
          store.respond(target.id, {
            outcome: entry.outcome,
            summary: reply,
            evidence: Array.isArray(entry.evidence)
              ? entry.evidence.map((item: unknown) => String(item)) : [],
          });
          receipts.push(`意见${target.seq}:已回复落账`);
        }
        return ok(`已逐条回复 ${receipts.length} 条检视意见`
          + `(用户在检视意见面板可见):\n${receipts.join("\n")}\n`
          + "分诊回合里本批还有修改型意见的,先回复完再调 declare_review_rework;"
          + "重写回合里逐条交代完的,调 submit_analysis 重新提交;"
          + "其余情况到此为止,不要重写报告。");
      },
    }));

    tools.push(defineTool({
      name: "declare_review_rework",
      label: "Declare Review Rework",
      description:
        "检视分诊的修改申报入口:本批检视意见里有需要改动分析报告内容本身"
        + "的修改型意见时,先对回复型意见逐条 respond_review,再调它申报。"
        + "平台会整体回退重写(回退问题分析、轮次+1、冻结被检视的报告"
        + "版本),并把意见清单重新注入;之后按清单修订报告,对本批意见"
        + "逐条 respond_review 交代(报告正文不写应答段),再重新 "
        + "submit_analysis,确认卡照旧交用户。纯回复型批次(澄清/追问/"
        + "确认,无需改动报告)禁止调用。",
      parameters: Type.Object({
        reviews: Type.Array(Type.Object({
          seq: Type.Number({
            description: "判定为修改型的意见号(清单里的「意见N」的 N)",
          }),
        }), { description: "修改型意见号清单" }),
        reason: Type.String({
          description: "一句话:为什么这些意见必须回退重写而非原地答复",
        }),
      }),
      async execute(_toolCallId: string, params: any) {
        const batch = outstandingReviewBatch(ctx.workspace);
        if (!batch.length) {
          fail("没有待分诊的检视意见:没有已送出的检视意见可申报修改");
        }
        const wanted: number[] = [...new Set(
          (Array.isArray(params.reviews) ? params.reviews : [])
            .map((item: any) => Math.trunc(Number(item?.seq)))
            .filter((seq: unknown) => Number.isFinite(seq)),
        )] as number[];
        if (!wanted.length) {
          fail("reviews 不能为空:列出判定为修改型的意见号(意见N 的 N)");
        }
        const reason = String(params.reason ?? "").trim();
        if (!reason) fail("reason 不能为空:说清为什么必须回退重写");
        const unique = [...new Set(wanted)];
        // 申报对象必须是本批待分诊的意见:更早批次的意见已锚在自己的
        // 冻结版上,拿历史意见号申报是幻觉引用,如实打回。
        const batchSeqs = new Set(batch.map((item) => item.seq));
        const known = reviewSummaries(batch);
        for (const seq of unique) {
          if (!batchSeqs.has(seq)) {
            fail(promptCopy("receipts", "review.unknown_seq", { seq, known }));
          }
        }
        // MR 检视意见没有报告回退(ADR-0052):对象是代码,验收在流水线
        // 与 MR 合入,不在分析报告确认卡——误申报会把分析阶段标记重做,
        // 让责任人为一条代码意见重新确认报告。护栏打回并指路。
        const externalSeqs = batch
          .filter((item) => unique.includes(item.seq as number)
            && item.external_review)
          .map((item) => item.seq);
        if (externalSeqs.length) {
          fail(`意见${externalSeqs.join("、意见")} 是 MR 检视意见`
            + "(检视人在 CodeHub 对代码提的意见),没有报告回退:不要申报、"
            + "不要重写 issue-analysis.md。需要改代码的,修好后在同一修复"
            + "分支追加提交并用 push_branch 重推;纯澄清的,直接 "
            + "respond_review 作答——你的回复会自动发布回 CodeHub 讨论。");
        }
        // 版本快照在申报时刻冻结(ADR-0035):送出在先、冻结在后,快照
        // 名用批次送出时刻命名,读侧批次窗口才把意见对回它锚定的版本。
        snapshotAnalysisVersion(ctx.workspace);
        // 原整体回退链路照旧(ADR-0007):回退问题分析、轮次+1、其后
        // 阶段标 redo、申报账作废;检视回合标记随回退置位。
        fixedRollback(ctx.state,
          `用户检视分析报告,提交 ${batch.length} 条修订意见,`
            + `其中 ${unique.length} 条修改型需回退重写:${reason}`);
        ctx.state.review_active = true;
        ctx.persist();
        // 意见清单快照以 rework 契约覆写(#366):重写回合的清单注入
        // 同样会被上下文压缩丢正文,恢复源跟着换版;放在回退落账后,
        // 轮次与注入清单同口径。
        writeReviewNotesSnapshot(ctx.workspace, ctx.state.title ?? "分析报告",
          ctx.state.round ?? 1, "rework");
        // 意见清单重注入(修改版契约:逐条 respond 交代+submit_analysis
        // 收尾)——AI 据此整份重写,重写完重新举确认卡。
        return ok(`已申报修改:平台已整体回退问题分析(第 ${ctx.state.round} 轮),`
          + "被检视报告已冻结版本。请按以下意见清单修订报告:\n\n"
          + renderReviewNotes(batch, ctx.state.title ?? "分析报告",
            ctx.state.round ?? 1));
      },
    }));

    // UT 事实上报(2026-09-02 并入问题修复:TDD 先写复现单测再改码,
    // 没有独立 UT 阶段)。只记账(台账+事件流+现场记录),不推进阶段、
    // 不设建 MR 门禁——出口是 complete_stage,硬验证在提交 MR 阶段的
    // 流水线验绿。
    tools.push(defineTool({
      name: "report_ut",
      label: "Report UT Result",
      description:
        "上报 UT 验证结果(在代码仓里实际跑的单测)。这是事实上报:平台只"
        + "记录留痕,不推进阶段、不设任何门禁。UT 属于问题修复阶段的一部分"
        + "(TDD:先写复现单测再改码转绿),修复过程中每轮都可上报。summary "
        + "带通过率与关键失败(如有),log_path 指向工作区内的测试报告/日志。"
        + "测试结果可接受后调 complete_stage 申报完成。",
      parameters: Type.Object({
        passed: Type.Boolean({ description: "本轮单测是否全部通过" }),
        summary: Type.String({ description: "一段话结果:跑了什么/通过率/关键失败" }),
        log_path: Type.Optional(Type.String({
          description: "测试输出落点(工作区内相对路径),供用户查证",
        })),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("report_ut");
        const round = ctx.state.round ?? 1;
        ctx.state.ut = {
          passed: params.passed === true,
          summary: String(params.summary ?? ""),
          ...(params.log_path ? { log_path: String(params.log_path) } : {}),
          round,
          at: new Date().toISOString(),
        };
        recordTransition(ctx.state, {
          source: "agent",
          note: `UT 上报(第 ${round} 轮):${params.passed === true ? "通过" : "未通过"}`
            + ` — ${String(params.summary ?? "").split("\n")[0]}`,
        });
        ctx.persist();
        return ok(promptCopy("receipts",
          params.passed === true ? "ut.recorded" : "ut.failed",
          { round }));
      },
    }));

    /** MR 验绿门(mr_green 阶段的 complete_stage 契约):AI 申报的清单
     * 与台账(state.mrs,create_mr 自动记账)归一比对,少报多报都打回;
     * 再对台账每个 MR 复核分支最新提交(#321,与监看器终态处理共用同一
     * 判断)后查它的流水线,三态裁决——全绿当场放行、有红当场打回带
     * 失败项、在跑/无记录受理由监看器等绿放行(受理账 state.mr_gate,
     * 进 deploy_verify 当且仅当"已申报且全绿")。
     * 裁决只认 run 归属与被验 SHA 一致的记录:过期结果(旧提交的 run)不
     * 背书也不定罪,对齐需求侧 selectTerminalRun 语义。 */
    const settleMrGate = async (
      declared: string[], note: string,
    ): Promise<ReturnType<typeof ok>> => {
      const ledger = state.mrs ?? [];
      // 归一:去空白/尾斜杠/.git 后缀。一仓一 MR 不变量下,MR 链接与
      // 仓地址都能定位同一条台账。
      const norm = (value: string) =>
        value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
      const byRepo = new Map(ledger.map((record) => [norm(record.repo), record]));
      const byUrl = new Map(
        ledger.filter((record) => record.url)
          .map((record) => [norm(record.url!), record]));
      const declaredRepos: string[] = [];
      const unknown: string[] = [];
      for (const entry of declared.map(norm)) {
        if (!entry) continue;
        const record = byUrl.get(entry) ?? byRepo.get(entry);
        if (!record) {
          if (!unknown.includes(entry)) unknown.push(entry);
          continue;
        }
        if (!declaredRepos.includes(record.repo)) declaredRepos.push(record.repo);
      }
      const missing = ledger
        .map((record) => record.repo)
        .filter((repo) => !declaredRepos.includes(repo));
      if (missing.length || unknown.length) {
        const details = (missing.length
          ? `\n- 少报(台账里有、清单没申报): ${missing.join(", ")}`
          : "")
          + (unknown.length
            ? `\n- 多报(清单里有、台账没有这个 MR): ${unknown.join(", ")}`
            : "");
        fail(promptCopy("receipts", "mrgate.mismatch", { details }));
      }
      // 空=空合法(无码修改路径):没有 MR 就没有可验的流水线,直接收口。
      if (!ledger.length) {
        fixedComplete(ctx.state, `无 MR 交付(空清单=空台账):${note}`);
        ctx.state.stage_note = "流程已完成(无 MR 交付)——待环境验证:通过可归档,发现问题回退重新分析";
        ctx.persist();
        ctx.notifyMrGreen?.();
        return ok(promptCopy("receipts", "mrgate.empty_ok"));
      }
      const platformUrl = ctx.platformUrl;
      if (!platformUrl) {
        fail("交付平台未配置(部署需 --platform 接适配层),无法验绿 MR 流水线");
      }
      // 逐 MR 查流水线(验绿事实源,不新增按 MR id 查)。验绿判据=
      // 「分支最新提交的流水线绿」(#321,与监看器同一把尺子):先经
      // 宿主复核 MR 状态——分支头已被平台外推送推进时,申报提交(推送
      // 账上的)的绿灯背书不了会被合入的代码,改验分支最新提交;老提交
      // 的结果既不背书也不定罪。复核缺席(老适配层/裸构造)按推送账的
      // 提交验,与旧口径一致。
      const runs: Array<{ repo: string; sha: string; run: PipelineRun | { status: "not_found" } }> = [];
      const staleRepos: string[] = [];
      const headMovedRepos: string[] = [];
      for (const record of ledger) {
        const sha = state.pushes?.find((item) => item.repo === record.repo)?.sha
          ?? (state.imported_mr?.repo === record.repo ? state.imported_mr.sha : undefined);
        if (!sha) {
          fail(promptCopy("receipts", "mr.verify_missing_push",
            { repo: record.repo }));
        }
        const recheck = await ctx.mrRecheck?.(record.repo, sha);
        const verifySha = recheck?.sourceSha ?? sha;
        if (verifySha !== sha) headMovedRepos.push(record.repo);
        const status = await getPipelineStatus({
          platformUrl: platformUrl!,
          repo: record.repo,
          sha: verifySha,
          // 适配层状态命令模板可能引用 {mr}(2026-08-28 真实环境 502:
          // 模板变量空串渲染失败)——台账里记了 iid,带上。
          ...(record.iid ? { mr: record.iid } : {}),
          credential: ctx.gitCredential?.(),
        });
        // runs 是同一 SHA 按时间顺序返回的运行历史，只有最后一条代表
        // 当前流水线。历史绿/红后又触发的新 run 仍在 running 时，绝不
        // 能拿旧终态提前放行或打回。
        const latest = status.runs.at(-1);
        // 过期结果防御(#108,对齐需求侧 selectTerminalRun):平台按 MR 维度
        // 返回流水线历史,AI 修复重推新提交(换 SHA)后立即重新申报时,
        // 新 run 注册前的窗口期内 runs.at(-1) 还是旧提交的 run——run 级
        // sha 与申报 SHA 对不上(或 is_valid=false 的 MR 头挂着过期结果)
        // 就是过期结果,既不能让它给新提交背书(冒充 success),也不能拿
        // 它定罪(旧红算到新头上,申报被冤枉打回、申报账被清)。一律按在跑
        // 受理停等,等监看器拿到新 run 的真终态再裁决。run 级 sha/is_valid
        // 缺席(旧适配层)时不设防,行为与透传前一致。
        const stale = latest !== undefined
          && ((typeof latest.sha === "string" && latest.sha && latest.sha !== verifySha)
            || latest.is_valid === false);
        if (stale) staleRepos.push(record.repo);
        runs.push({
          repo: record.repo,
          sha: verifySha,
          run: stale ? { status: "not_found" } : latest ?? { status: "not_found" },
        });
      }
      const failed = runs.filter((item) => item.run.status === "failed");
      if (failed.length) {
        delete state.mr_gate;
        ctx.persist();
        fail(promptCopy("receipts", "mrgate.red", {
          details: failed.map((item) =>
            `- ${item.repo} @ ${item.sha.slice(0, 12)}\n  `
              + describePipelineRun(item.run)).join("\n"),
        }));
      }
      if (runs.every((item) => item.run.status === "success")) {
        delete state.mr_gate;
        fixedComplete(ctx.state,
          `MR 核验通过(${runs.length} 个 MR 全绿):${note}`);
        ctx.state.stage_note = state.scenario === "mr_repair"
          ? "流水线修复完成" : MR_GREEN_ENV_VERIFY_NOTE;
        ctx.persist();
        ctx.notifyMrGreen?.();
        if (state.scenario === "mr_repair") return ok("已有 MR 的当前提交流水线已通过。本次工具修复完成；不要推进 DTS、审批、合入或归档，不要求网管环境验证。");
        return ok(promptCopy("receipts", "mrgate.all_green", {
          repos: runs.map((item) => item.repo).join(", "),
        }));
      }
      // 在跑/无记录:受理——记申报账,监看器绿了收口、红了带回失败项。
      state.mr_gate = { mrs: declaredRepos, at: new Date().toISOString() };
      recordTransition(state, {
        source: "platform",
        note: `MR 清单已申报(${declaredRepos.length} 个),等流水线验绿`
          + (staleRepos.length
            ? `(过期结果已拒,按在跑停等:${staleRepos.join(", ")})`
            : "")
          + (headMovedRepos.length
            ? `(分支头已变,按分支最新提交验绿:${headMovedRepos.join(", ")})`
            : ""),
      });
      ctx.persist();
      if (headMovedRepos.length) {
        const moved = runs.find((item) => headMovedRepos.includes(item.repo));
        return ok(promptCopy("receipts", "mrgate.awaiting_head_moved", {
          repos: declaredRepos.join(", "),
          head_repos: headMovedRepos.join(", "),
          sha: (moved?.sha ?? "").slice(0, 12),
        }));
      }
      return ok(promptCopy("receipts", "mrgate.awaiting", {
        repos: declaredRepos.join(", "),
      }));
    };

    // 阶段自报出口(2026-08-28 目标驱动拍板):四个阶段(拉单/拉仓/
    // 修改/提交MR)的唯一出口。前三段只自报收口推进;提交MR
    // 段是 MR 验绿门(唯一带平台核验的出口)。
    tools.push(defineTool({
      name: "complete_stage",
      label: "Complete Current Stage",
      description:
        "宣布当前阶段目标已达成并申报完成——阶段的唯一出口,完成标准以"
        + "阶段简报的「怎么算完」为准,活干完再调。「拉取代码仓」无需"
        + "代码改动时不拉仓、直接调它跳过;「提交 MR·跑绿」必带 mrs 参数"
        + "申报 MR 清单(MR 链接或对应仓地址),平台按台账与流水线验绿"
        + "放行(全绿收口,有红打回,在跑受理等绿)。",
      parameters: Type.Object({
        note: Type.String({ description: "一句话:做了什么(文件/要点),或为何无需代码仓" }),
        mrs: Type.Optional(Type.Array(Type.String(), {
          description: "提交MR阶段必填:申报的 MR 清单(MR 链接或对应仓地址),"
            + "必须与会话台账(create_mr 记的账)完全一致",
        })),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("complete_stage");
        const firstLine = String(params.note ?? "").split("\n")[0];
        if (state.stage === "mr_green") {
          return settleMrGate(
            ((params.mrs as string[] | undefined) ?? []).map(String), firstLine);
        }
        // 前三段:纯自报推进,下一阶段指引全部由注册表生成。
        const to: FixedStage = state.stage === "dts_info" ? "prep_repo"
          : state.stage === "prep_repo" ? "analyze"
          : "mr_green";
        const note = state.stage === "prep_repo"
          ? ((state.repo_urls?.length ?? 0) > 0
            ? `拉取代码仓完成:${firstLine}`
            : `跳过拉取代码仓:${firstLine}`)
          : state.stage === "dts_info" ? `单据已通读:${firstLine}`
          : `问题修复完成:${firstLine}`;
        fixedAdvance(ctx.state, to, note);
        // analyze 入口(ADR-0012/0014):先定格业务知识资产(不分介入
        // 档,缺席静默;重走时台账已在,重复定格被台账判据挡住),再
        // 渲染定格资产地图(空台账则静默缺席),最后
        // 扫描仓内业务 skill 留痕(ADR-0014:圈选闸已封存,只记账
        // 不举卡,AI 按编排技能的索引纪律自主发现)。
        const enteredAnalyze = to === "analyze";
        const knowledgeBrief = enteredAnalyze
          ? (void ctx.freezeBusinessKnowledge?.(),
            ctx.businessKnowledgeBrief?.() ?? "")
          : "";
        void (enteredAnalyze
          ? ctx.raiseSkillSelection?.() : undefined);
        // 环境预热(2026-09-04):拉仓收口进 analyze 时启动,与主
        // Agent 的分析并行。fail-open 旁路:预热自己的失败不碰流程。
        void (enteredAnalyze ? ctx.startWarmup?.() : undefined);
        ctx.persist();
        return ok(promptCopy("receipts", "complete.stage_closed", {
          stage_brief: stageBriefLines(scenario, to,
            promptCopy("briefs", `stage.${to}`)).join("\n"),
        }) + (knowledgeBrief ? `\n\n${knowledgeBrief}` : ""));
      },
    }));

  }

  // 给模型的固定流程阶段速查(描述里说明,方便宿主提示词引用)
  if (scenario) {
    ctx.log?.(`[issue-tools] 固定流程工具集就绪(${scenario} 场景,`
      + `${fixedStages(scenario).length} 阶段)`);
  }
  return tools;
}
