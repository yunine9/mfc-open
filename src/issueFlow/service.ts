import { migrateMrRepairRecords } from "./mrRepairStore.ts";
import { runCodecheckPrepush, rememberCodecheckBase, type CodecheckRunner } from "../codecheckPrepush.ts";
import { runCodecheckSkillSession } from "../codecheckSkillSession.ts";
import { excludeCodecheckArtifacts } from "../codecheckArtifacts.ts";
import { resolveBusinessModuleRef } from "../businessModuleIdentity.ts";
import { completedInRange, validateCompletionRange, type CompletionRange } from "../completionRange.ts";
import { applyGitCommitIdentity } from "../gitCommitIdentity.ts";
import { importExternalReviews, notifyExternalReviews } from "../externalReviewInbox.ts";
import { postMrDiscussionReply, postMrDiscussionResolve } from "../mrDiscussionReply.ts";
import { concurrentWorkPrompt } from "../concurrentWorkPrompt.ts";
import { resolveProductBranch } from "../configurationCenter.ts";
import { readResourceBlocks, resourceBlocked } from "../repositoryResourcePolicy.ts";
import { auxiliarySessionEpoch, trackAuxiliarySession, untrackAuxiliarySession, abortAuxiliarySessions, interruptWarmupReceipt, hasAuxiliarySessions } from "../auxiliarySessions.ts";
import { reclaimBuildProducts } from "./buildProducts.ts";
import { CODECHECK_TOOLCHAIN_MAX_AGE_MS, codecheckToolchainStats, reclaimCodecheckToolchain } from "../codecheckToolchain.ts";
import { backoffMs, extendDeadlineByBackoff, ConsecutiveFailureLog } from "./backoff.ts";
import { withinDataDir, humanBytes } from "../workspaceReclaim.ts";
import { judgeIssueReclaim, reclaimIssueWorkspace } from "../issueFlowWorkspaceReclaim.ts";
import { prepareMaeBuildSupport, isMaeRepository, MAE_BUILD_ASSETS, MAE_BUILD_MOUNT, MAE_CONTAINER_BOOTSTRAP } from "../maeBuildSupport.ts";
/**
 * 问题流服务:与需求任务并行的独立会话域。
 *
 * 范式差异(有意为之,别"修"回内核):需求走内核固定流水线,问题走
 * "AI 按 playbook 自主编排的多轮对话"。本服务只做三件事:
 * 1. 承载会话(克隆/容器/CloudSession,不挂任何内核 hook);
 * 2. 显示(状态文件 + 事件账本,阶段由 Agent 上报,平台不推断);
 * 3. 门禁(推送/提MR 的单号闸;秘密止步宿主)。
 *
 * 会话真相在 dataDir/issues/<id>/(issue.json + events.jsonl +
 * transcript.jsonl + waiting.json),API 是投影;服务重启后正在跑/
 * 排队的会话重新入队,由并发额度泵以续聊回合自动续跑——需求侧断点
 * 续跑的同款语义(2026-08-29 拍板),不再有等人发消息救活的滞留态。
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CloudSession,
  looksLikeAuthFailure,
  looksLikeBusyCollision,
  looksLikeOutputTruncation,
  looksLikeRateLimited,
  type Outcome,
} from "../sessionDriver.ts";
import { pipelineHeaders } from "../pipelineClient.ts";
import { fetchMrGates } from "../mrGateClient.ts";
import type { GateView } from "../mergeWatch.ts";
import {
  fetchMrDiscussions,
  type MrDiscussionItem,
  type MrReviewReplyOutboxItem,
} from "./mrDiscussions.ts";
import type { VisionCapabilityConfig, VisionModelChoice } from "../visionCapability.ts";
import type { Notifier, NotifyQuestion } from "../notifier.ts";
import { isIssueInterventionTier, type IssueInterventionTier } from "../auth.ts";
import { EventLog, type SemanticEvent } from "../semanticEvents.ts";
import { TranscriptStore } from "../transcriptStore.ts";
import { createKnowledgeTool } from "../knowledgeTools.ts";
import type { KnowledgeContext, KnowledgeSearch } from "../knowledgeSearch.ts";
import { KnowledgeTrace } from "../knowledgeTrace.ts";
import { repoSlug } from "../taskMemory.ts";
import { GateService } from "../gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "../humanGate.ts";
import {
  IssueEnvironmentVault,
  type IssueEnvironmentInput as VaultEnvironmentInput,
} from "../issueEnvironment.ts";
import {
  EnvironmentRegistry,
  contributeEnvironmentByIp,
} from "../environmentRegistry.ts";
import {
  TaskContainer,
  taskContainerInstance,
  type TaskContainerLimits,
} from "../containerRuntime.ts";
import { mirrorPipelineArtifacts, isBlindPipelineInput, MISSING_FAILURE_PLACEHOLDER } from "../pipelineMirror.ts";
import { assessPipelineRepairEvidence, hasActionablePipelineSummary } from "../pipelineEvidence.ts";
import { repairBudget, pipelineEvidenceLines, repairStatusSummary } from "./pipelineRepair.ts";
import { collectRepoContextFiles } from "./repoContextFiles.ts";
import { perRepoBuildCacheMounts } from "../buildCacheMounts.ts";
import {
  prepareContainerHostPaths,
  repairContainerCloneOwnership,
  repairContainerMutationOwnership,
  type ContainerOwnershipRuntime,
} from "../containerOwnership.ts";
import {
  resolveFixBranch,
  fixedAdvance,
  fixedComplete,
  fixedRollback,
  fixedStageIndex,
  MR_GREEN_ENV_VERIFY_NOTE,
  fixedStages,
  initStageStates,
  isTerminal,
  ISSUE_CANCEL_REASON_UNKNOWN_ERROR,
  ISSUE_CANCEL_REASONS,
  ISSUE_CANCEL_EXCLUSION_LINK_REASONS,
  ISSUE_NEGATIVE_CANCEL_REASONS,
  issueRepoWorkspaces,
  loadState,
  normalizeIssueRepos,
  resolvePullRoute,
  recordTransition,
  repoNameOf,
  saveState,
  shouldNudgeFixed,
  summarize,
  VERIFY_FAIL_NOTE_PREFIX,
  type FixedStage,
  type IssueBusinessKnowledge,
  type IssueBusinessKnowledgeEntry,
  type IssueCancelReason,
  type IssueEnvironmentConfig,
  type IssueGate,
  type IssueGateScope,
  type IssueScenario,
  type IssueSkillChoice,
  type IssueSource,
  type IssueStatus,
  type IssueSummary,
  type IssueSessionState,
  ENV_SCOPE_LABELS,
  ENV_TYPE_LABELS,
  type IssueEnvType,
} from "./state.ts";
import { businessKnowledgeLines } from "./businessKnowledge.ts";
import {
  readDtsAutoClaimExclusions,
  setDtsAutoClaimExclusion,
} from "../dtsAutoClaimExclusions.ts";
import {
  materializeBusinessModuleKnowledge,
  snapshotBusinessModules,
} from "../businessModuleRuntime.ts";
import {
  buildWorksiteRecord,
  type WorksiteRecord,
} from "./worksiteExport.ts";
import { recentEvents } from "./materials.ts";

/** 恢复消息里引用原文的统一截断线:末条人工决定与重跑操作者说明共用。 */
const QUOTED_NOTE_MAX = 2000;

/** 崩溃回灌的取材(遗留洞 A-H1):事件账末条恰是人的决定时取原文。
 *  只认末条——后面已有 Agent 回应的说明当时送达了,不重播旧话。 */
function lastHumanDecisionNote(root: string): string {
  const last = recentEvents(root, 1).at(-1) as
    | { kind?: string; payload?: { decision?: unknown } }
    | undefined;
  if (last?.kind !== "human_decision") return "";
  const text = String(last.payload?.decision ?? "").trim();
  if (!text) return "";
  return "\n\n[服务中断前你还没来得及读到的用户决定,原文如下]\n"
    + text.slice(0, QUOTED_NOTE_MAX);
}

/** 异常重跑的决定回灌(ADR-0055):事件账最近 3 条人工决定原文,按
 *  时间正序回放。与崩溃回灌(lastHumanDecisionNote,只认末条)不同:
 *  重跑常见降级开局——底层上下文没了,人的近期决定是续跑最直接的
 *  执行输入,三条内的连贯指令比孤零零一条完整;更早的已沉淀进分析
 *  报告与转移账,不再重播。重启恢复路径不换:仍走 last-1 版,语义
 *  不动。 */
function recentHumanDecisionNotes(root: string, limit = 3): string {
  const decisions = recentEvents(root, 200)
    .filter((event) => event.kind === "human_decision")
    .slice(-limit) as Array<{ payload?: { decision?: unknown } }>;
  const lines = decisions
    .map((event) => String(event.payload?.decision ?? "").trim())
    .filter(Boolean)
    .map((text) => text.slice(0, 2000));
  if (!lines.length) return "";
  return "\n\n[会话异常前最近的人工决定,原文回放(时间正序)]\n"
    + lines.map((text, index) => `${index + 1}. ${text}`).join("\n");
}
import {
  cloneRepository,
  currentHead,
  ensureBranch,
  validateRepoUrl,
  type GitCredential,
} from "./issueGit.ts";
import { readKnowledgeRepoConfig } from "../knowledgeRepoConfig.ts";
import {
  componentRepositories,
  type ComponentRepository,
} from "../componentRepositories.ts";
import {
  readBusinessModule,
  type BusinessModule,
} from "../businessModuleLibrary.ts";
import { repositoryIdentity } from "../knowledgeAssetModel.ts";
import { normalizeRepairMrUrl, readRepairMr } from "../mrImport.ts";
import { type ModelsSettings } from "../settings.ts";
import { resolveModelConfig, type ModelLane } from "../modelResolution.ts";
import { createGoOpsTools, type ContainerExec, type IssueOpsTools } from "./opsTools.ts";
import { createContainerBashOperations } from "./containerBash.ts";
import { applyDebugIssueSkillPatch } from "./debugIssue.ts";
import {
  issueWarmupMission,
  type IssueWarmupOutcome,
  type IssueWarmupReceipt,
  type IssueWarmupRunner,
} from "./warmup.ts";
import { parseWarmupReport } from "../warmupAgent.ts";
import {
  DtsGatewayUnconfiguredError,
  IssueControlError,
  IssueInfraError,
  IssueNotFoundError,
} from "./errors.ts";
import type { DtsGateway, DtsTicketDetail } from "./gateways.ts";
import {
  ANALYSIS_REPORT_FILENAME,
  analysisSectionOf,
  createIssueTools,
  type IssueMrRecheck,
  type IssueToolContext,
} from "./tools.ts";
import {
  absorbExternalAtTurnStart,
  createBranchTransferMutex,
  type BranchTransferMutex,
} from "./turnStartAbsorb.ts";
import {
  buildIssueTimeline,
  type IssueSessionTimeline,
} from "./sessionView.ts";
import {
  fixedAdvanceNotice,
  fixedNudgeNotice,
  issueFixedOpeningPrompt,
  issueResumePrompt,
  materializeIssueSkills,
  type IssueEnvCredentials,
  type IssueResumeOptions,
} from "./prompt.ts";
import {
  countVerifyFailures,
  issueOnceOutcome,
  issueOnceRates,
  onceRateFactsFromSnapshot,
  sentReviewBatches,
  type IssueOnceOutcome,
  type IssueOnceRateFacts,
  type IssueOnceRateSummary,
} from "./onceRates.ts";
import { listAnalysisVersions } from "./analysisVersions.ts";
import { TICKET_TEMPLATE_FILE, writeTicketTemplate } from "./ticketTemplate.ts";
import {
  aggregateRegistrationStats,
  type IssueRegistrationSessionRow,
  type IssueRegistrationStats,
} from "./registrationStats.ts";
import {
  aggregateCodeOrigin,
  backfillCodeOrigin,
  enqueueCodeOrigin,
  ISSUE_CODE_ORIGIN_SINCE,
  ISSUE_CODE_ORIGIN_THRESHOLD_DEFAULT,
  readCodeOriginSnapshot,
  type IssueCodeOriginRepoOk,
  type IssueCodeOriginSnapshot,
  type IssueOnceGeneratedRepoRow,
  type IssueOnceGeneratedSession,
  type IssueOnceGeneratedStats,
} from "./codeOrigin.ts";
import {
  ISSUE_METRICS_FILE,
  writeIssueMetricsSnapshot,
  type IssueMetricsSnapshot,
} from "./metricsSnapshot.ts";
import { promptCopy } from "./promptCopy.ts";
import {
  AnnotationError,
  orderAnnotations,
  type AnchorCheck,
  type Annotation,
} from "../annotations.ts";
import {
  addReview,
  anchorChecks,
  dropReview,
  renderReviewNotes,
  renderReviewThread,
  reviewStore,
  snapshotAnalysisVersion,
  submitReviews as submitReviewLedger,
  writeReviewNotesSnapshot,
} from "./reviews.ts";
import { configureAudit, sessionAudit } from "./audit.ts";
import {
  issueConversation,
  readConversationEvents,
  type IssueConversationView,
} from "./conversation.ts";
import {
  GATE_OPTIONS,
  fixedStageLabel,
  gateOptionLabel,
  gateVerdict,
  stageGateRoute,
} from "./stageRegistry.ts";
import {
  describePipelineRun,
  getPipelineStatus,
  triggerPipeline,
  type PipelineRun,
} from "../pipelineClient.ts";
import {
  PIPELINE_DIMENSIONS,
  summarizeFailedChecks,
  type PipelineCheck,
  type PipelineDimension,
} from "../pipelineContract.ts";
import {
  PIPELINE_DIMENSION_TEXT,
  type PipelineArtifactText,
} from "../pipelineEvidence.ts";
import { syncIssueImagesToWorkspace } from "./issueImages.ts";
import { syncIssueAttachmentsToWorkspace } from "./issueAttachments.ts";
import { FeedbackStore, type FeedbackRecord } from "../feedbackStore.ts";

// ---- 举卡作答的机器可读协议 ----

/** Agent 问题卡(AskUserQuestion)选项的决策码:选项措辞是 Agent 现场
 * 自由给的,没有领域码表可查,就按「题号-序号」机械派码(opt-0-1)。
 * 投影时派码(前端渲染 label、提交 code),作答时按同一张码表把码
 * 还原成选项原文——Agent 看到的永远是自己的措辞,行为零变化。 */
function agentOptionCode(questionIndex: number, optionIndex: number): string {
  return `opt-${questionIndex}-${optionIndex}`;
}

const AGENT_OPTION_CODE = /^opt-(\d+)-(\d+)$/;

/** Agent 卡问题清单(AskUserQuestion 的原始形状;读不出来的当没有)。 */
function agentCardQuestions(record: WaitingRecord): Array<{
  question?: string;
  options?: string[];
  recommended?: string;
}> {
  return (record.question as { questions?: Array<{
    question?: string;
    options?: string[];
    recommended?: string;
  }> })?.questions ?? [];
}

/** 「AI 推荐」的命中尺:trim 后逐字命中选项原文,返回下标(-1=没有)。
 * 投影(推荐原文换投影码)与档位代答(按推荐作答)共用同一把——
 * 卡上标的推荐与代答认的推荐永远同一判定,不会各说各话。 */
function recommendedIndex(
  options: string[] | undefined,
  recommended: string | undefined,
): number {
  const wanted = recommended?.trim() ?? "";
  if (!wanted) return -1;
  return (options ?? []).findIndex((option) => option.trim() === wanted);
}

/** 投影:给 Agent 卡的字符串选项派发决策码(get 的 waiting 出口)。
 * 平台闸不走这里——它的码表就是 stageRegistry 的 GATE_OPTIONS,
 * 举闸时已带码落盘。没有在等的卡原样返回 undefined。 */
function withAgentOptionCodes(
  record: WaitingRecord | undefined,
): WaitingRecord | undefined {
  if (!record) return undefined;
  const questions = agentCardQuestions(record);
  if (!questions.length) return record;
  return {
    ...record,
    question: {
      ...record.question,
      questions: questions.map((item, questionIndex) => {
        const options = (item.options ?? []).map((option, optionIndex) => ({
          code: agentOptionCode(questionIndex, optionIndex),
          label: option,
        }));
        // 推荐协议(ADR-0004):推荐原文换算成命中选项的投影码随卡
        // 下发(questions[].recommended),前端按码标「AI 推荐」——
        // 与选项同一条码表,文案改字零协议后果。校验器保证必命中;
        // 万一没命中(卡先于校验落盘的旧现场)不带该键,不造悬空码。
        const { recommended: rawRecommended, ...rest } = item;
        const hit = recommendedIndex(item.options, rawRecommended);
        return {
          ...rest,
          options,
          ...(hit >= 0 ? { recommended: options[hit].code } : {}),
        };
      }),
    },
  };
}

/** Agent 卡作答的归码还原:answers(键=题号)里的决策码还原成选项
 * 原文,自由作答原样保留,拼回与旧协议一致的换行合并 decision——
 * humanGate 记录与 Agent 上下文看到的文本,与文字作答时代逐字节相同。
 * 没带 answers(直调/自由文本旧形态)返回 undefined,由调用方透传
 * decision。码对不上(卡已换)当自由作答,不静默吃掉用户的选择。 */
function decodeAgentDecision(
  record: WaitingRecord,
  answers: Record<string, string> | undefined,
): string | undefined {
  if (!answers || !Object.keys(answers).length) return undefined;
  const questions = agentCardQuestions(record);
  const lines = questions.map((item, questionIndex) => {
    const raw = answers[String(questionIndex)]?.trim() ?? "";
    if (!raw) return "";
    const match = AGENT_OPTION_CODE.exec(raw);
    const option = match && Number(match[1]) === questionIndex
      ? item.options?.[Number(match[2])]
      : undefined;
    return option ?? raw;
  });
  const joined = lines.filter(Boolean).join("\n");
  return joined || undefined;
}

export interface IssueEnvironmentInput {
  /** 从环境台账快照(ADR-0020/#150):给 environment_id 时地址/端口/
   * 形态/后台密码一概不收(互斥,同给打回),由服务端从台账解密取值——
   * 前端永远没有密码。 */
  environmentId?: string;
  name?: string;
  hosts?: string[];
  port?: number;
  /** 独立 root 密码(手填可选字段,留空 = 与后台密码相同;快照路径在
   * 台账显式设置时由服务端解析带入)。缺席/空 = 不落独立 root 凭据,
   * 会话行为与现状完全一致(ADR-0020)。 */
  rootPassword?: string;
  /** 网管后台密码(playbook 契约:operator/serviceaccount/administrator 同密码)。 */
  backendPassword?: string;
  /** 环境形态(虚拟化/容器化 K8s):登记页面下拉或 env_needed 卡下拉
   * 人工选定,决定日志抓取走哪套引擎;AI 只读不猜。 */
  envType?: IssueEnvType;
}

/** 快照解析结果:resolved 与手填同形(同一把尺校验、同一条 vault 路径
 * 落盘),sourceIp 是选定时点的台账主 IP(非密,进会话状态作来源展示)。 */
interface ResolvedEnvironmentInput {
  resolved: IssueEnvironmentInput;
  sourceIp?: string;
}

/** 环境输入的机械校验与归一(登记与 env_needed 闸作答共用同一把尺)。
 * 归一在落盘前跑,半截登记不许烧掉会话号。快照路径解析出的输入与
 * 手填同形,过的是同一把尺。 */
function normalizeEnvironmentInput(
  input: IssueEnvironmentInput,
): {
  hosts: string[];
  name: string;
  port: number;
  rootPassword?: string;
  backendPassword: string;
  envType?: IssueEnvType;
} {
  const hosts = (input.hosts ?? []).map((host) => host.trim()).filter(Boolean);
  if (!hosts.length) {
    throw new IssueControlError("网管环境至少要有一个服务器地址");
  }
  const backendPassword = input.backendPassword?.trim();
  if (!backendPassword) {
    throw new IssueControlError("配置了网管环境就必须填写网管后台密码");
  }
  if (input.envType !== undefined
      && input.envType !== "virtualized" && input.envType !== "k8s") {
    throw new IssueControlError("环境形态只能是虚拟化或容器化(K8s)");
  }
  const rootPassword = input.rootPassword?.trim();
  return {
    hosts,
    name: input.name?.trim() || hosts[0],
    port: input.port ?? 22,
    ...(rootPassword ? { rootPassword } : {}),
    backendPassword,
    ...(input.envType ? { envType: input.envType } : {}),
  };
}

/** env_needed 闸用途面的人话:单一来源在 state.ts(ENV_SCOPE_LABELS,
 *  与 tools 共用),转移账与平台通知按它分叉。 */

/** 问题域知识上下文(ADR-0005):货架 skill 匹配问题会话用的画像=
 * 登记的关联仓 + 绑定的业务模块。纯函数单源,openDriver 装配与测试
 * 共用——改口径只动这里。 */
export function issueKnowledgeContext(state: IssueSessionState): {
  repositories: string[];
  technologies: string[];
  businessModuleIds: string[];
} {
  return {
    repositories: state.repo_urls?.length
      ? [...state.repo_urls]
      : state.repo_url ? [state.repo_url] : [],
    technologies: [],
    businessModuleIds: state.module_id ? [state.module_id] : [],
  };
}

/** 统一检索工具的问题会话口径(ADR-0062):与货架匹配同源(登记仓+
 *  绑定模块),补产品版本供知识检索按版本收窄。repo 用 slug 形态,
 *  与需求侧 memoryRepo 同语义(经验归属按 slug 匹配)。 */
export function issueToolKnowledgeContext(state: IssueSessionState): KnowledgeContext {
  const base = issueKnowledgeContext(state);
  return {
    repo: repoSlug(base.repositories[0]),
    repositories: base.repositories,
    moduleIds: base.businessModuleIds,
    productVersion: state.product_version,
  };
}

/** vault 行·后台凭据:playbook 契约三个系统账号同密码,按形状存三套,
 * vault 校验与工具取密(operator)都不用特判。 */
function backendVaultRow(
  name: string,
  host: string,
  port: number,
  password: string,
): VaultEnvironmentInput {
  return {
    name,
    purpose: "both",
    host,
    port,
    accounts: ["operator", "serviceaccount", "administrator"].map((username) =>
      ({ username, password })),
  };
}


/** vault 行·独立 root 凭据(#150,ADR-0020):purpose=root 单账号成组,
 * 形状仿照 page 组。只在 root 密码显式存在时落(台账显式设置的快照、
 * 或闸手填显式给了 root);继承后台密码的会话不落这一组,消费面按
 * "没有独立 root"处理——与手填时代的会话行为完全一致。 */
function rootVaultRow(
  name: string,
  host: string,
  port: number,
  password: string,
): VaultEnvironmentInput {
  return {
    name: `${name}·root`,
    purpose: "root",
    host,
    port,
    username: "root",
    password,
  };
}

export interface IssueCreateInput {
  /** 发起登记的登录账号(登记人的缺省来源;路由层从登录态取)。 */
  account: string;
  /** 责任人(ADR-0031):会话归属账号,登记后的推进人;缺席=自登记
   * (归属=登记人)。显式指派时校验存在且非管理员,Git 凭据按责任人
   * 现查——拉仓/提交/推送都用责任人的身份。 */
  assignee?: string;
  /** 登记人(ADR-0031,通常是测试):路由层从登录态取,服务端不信任
   * 客户端改写;缺席=自登记。登记人≠责任人时登记完成发指派通知。 */
  reporter?: string;
  title: string;
  description?: string;
  /** 附加信息(原发起备注,DTS 列表随单填写,#502 更名):原样进
   * 登记元信息,AI 开场被要求优先读;尾部可带随单上传的附件路径
   * 引用(与 description 同规则提取同步)。trim 后为空 = 没填,不落
   * 字段。手工登记不带。 */
  remark?: string;
  source?: IssueSource;
  ticket?: string;
  repoUrl?: string;
  /** 多仓登记(模块带仓是常态):与 repoUrl 合并去重;repo_url 兼容
   * 别名取首个,仓彼此平等。 */
  repoUrls?: string[];
  baseline?: string;
  productVersion?: string;
  /** 业务模块自由文本标签(仅展示/报告引用,不承载判定)。 */
  module?: string;
  /** 登记选定的业务模块 ID:校验存在且 active,名称派生 module 标签。
   * 三路发起开场必有(ADR-0056),运行时不再有绑模块动作。 */
  moduleId?: string;
  /** 会话级介入档位(ADR-0057):DTS 列表发起前按单选定,create 定格
   * 进状态,发起后不可改;缺席=跟随全局。 */
  interventionTier?: IssueInterventionTier;
  /** 自动接单(ADR-0061):调度器发起时置位——发起方式=自动的展示
   * 标记进状态;流程语义零分叉,校验链与人工发起完全同一条。 */
  autoClaim?: boolean;
  environment?: IssueEnvironmentInput;
}

export interface IssueIsolation {
  image: string;
  volumes: string[];
  /** 分仓构建缓存根(与 taskService isolation.cacheRoot 同款);
   *  有值时 ensureContainer 按 repo URL 创建分仓缓存,挂载 /cache/maven
   *  等并设 MAVEN_OPTS——容器内 mvn 能找到 parent POM。 */
  cacheRoot?: string;
  memory: string;
  cpus: string;
  user?: string;
  pidsLimit: number;
  network: string;
  /** 向容器注入的额外环境变量(与 taskService isolation.environment 同款);
   *  ensureContainer 先继承这里,再追加缓存相关变量(MAVEN_OPTS 等)。 */
  environment?: NodeJS.ProcessEnv;
  /** 窄测试注入口(与 taskService isolation.containerFactory 同款意图):
   *  生产缺席时始终 new TaskContainer;测试注入它,无 daemon 环境也能
   *  证明容器生命周期契约(回合收口不停、终态必停)。 */
  containerFactory?: (build: IssueContainerBuild) => TaskContainer;
}

/** ensureContainer 组装容器时的全部入参(与 TaskContainer 构造同形),
 *  抽成对象是为了上面的 containerFactory 注入口。 */
export interface IssueContainerBuild {
  image: string;
  workspace: string;
  name: string;
  log?: (message: string) => void;
  volumes: string[];
  limits: TaskContainerLimits;
  options: {
    network: string;
    environment?: NodeJS.ProcessEnv;
    labels: Record<string, string>;
  };
}

export interface IssueFlowOptions {
  /** 复用执行能力，但工具数据、编号和生命周期与问题交付隔离。 */
  purpose?: "pipeline_repair";
  /** MR 信息读取边界；缺省使用交付平台的只读详情接口。 */
  mrDetails?: (url: string, account: string) => Promise<import("../mrImport.ts").RepairMr>;
  dataDir: string;
  provider: string;
  model: string;
  modelsJson: Record<string, unknown>;
  /** 平台统一知识检索(ADR-0062):问题会话以只读子集消费正式知识。
   *  惰性闭包——TaskService 在 issueFlow 之后装配,回合时才调用;
   *  缺省=本部署不挂检索工具,行为与历史一致。 */
  knowledgeSearch?: () => KnowledgeSearch | undefined;
  /** 认证失败(401)重试的退避间隔表,透传给会话驱动;缺省 10s/30s。
   *  测试注快值,部署不传。 */
  authRetryDelaysMs?: number[];
  settings?: {
    models(): ModelsSettings;
    /** 流水线监看的轮询节奏(与需求侧同一份运行参数);其中的
     *  issue_max_turns 是问题流回合并发额度(管理页「问题单并发数」,
     *  泵现读现判,优先于 maxConcurrentTurns 部署旗)。 */
    runtime?(): {
      poll_interval_s?: number; poll_timeout_s?: number;
      issue_max_turns?: number;
      /** @deprecated 兼容历史配置；上下文改由模型请求前容量策略管理。 */
      issue_compact_every_events?: number;
      /** 红灯修复轮预算(与需求侧同一旋钮,缺省 20;0=关掉自动修复)。 */
      repair_rounds?: number;
      /** 环境验证卡守闸阈值(#248,分钟):mr_green 收口后超过该值
       *  仍无 env_verify 卡(且会话空闲、无闸在等),守闸器向小鲁班
       *  报警——纯报警不举卡,静默漏卡唯一的声器。缺省 120;0=关闭;
       *  允许小数(亚分钟窗口,测试用)。 */
      env_verify_watchdog_minutes?: number;
      /** 终态现场回收(磁盘治理票 01):canceled/archived 单的 repo/ 子树
       *  由清扫器回收。缺省 1=开;0=关(行为与现状全等,现场保留)。 */
      issue_repo_reclaim?: number;
      /** 管理员开启后，后续分析回合可以自动预热；缺省关闭。 */
      issue_warmup_enabled?: number;
      /** 闲置或等待中的会话，无工作活动超过此小时数后回收可再生中间文件。
       *  源码、依赖和报告保留；缺省 24，0 关闭。 */
      issue_build_products_cooldown_hours?: number;
      /** 现场保留期(与需求侧同一旋钮):对问题流只剩通断语义(ADR-0073
       *  当场制)——0=整体禁运;非 0 天数只用于附件中转孤儿 GC。 */
      workspace_retention_days?: number;
    };
  };
  /** 不可自动修复工具名单(--unfixable-tools,与需求交付同一面旗):
   *  需求交付的分诊输入。问题流已停代举分诊(#247,ADR-0024)——
   *  红灯事实发送给 AI 自行判断,本字段对问题流不再生效,保留给
   *  同一面旗的需求侧消费者(executionRuntime 装配共用)。 */
  unfixableTools?: string[];
  /** 发布检视回复时代点"已解决"(--resolve-discussions,与需求交付
   *  同一面旗):默认关——resolve 归检视人,代点是越权;平台/团队
   *  明确允许的部署才开。 */
  resolveDiscussions?: boolean;
  /** 问题处理介入档位(ADR-0019,个人设置按流剥离):三档缺省二档,
   * 按会话归属人现读现判,闸策略/提示词节奏全部由档位派生——三档
   * 「优先对齐」=guard 提示词;二档「优先报告」=唯一停靠点是分析
   * 结论确认卡(检视循环);一档「全自动」=确认类闸代答
   * (analysis_confirm 全量/conclude 高置信非问题)+纯选项问答卡
   * 代答。环境配置卡(env_needed)与流水线人工事实闸任何档位都举
   * (2026-10-31 起,ADR-0019 增补:只有人拿得到的事实不算询问),
   * 且永不代答;build_deploy 随路 env_verify 卡维持三档独有。推送
   * 分支任何档都直推(2026-09-17 推送过目退役,ADR-0009 增补)。
   * 回调缺席=缺省二档(裸构造/测试形态与产品缺省一致)。 */
  interventionTier?: (account?: string) => IssueInterventionTier;
  /** 账号角色查询(ADR-0031 指派校验):账号不存在或已停用返回
   * undefined。回调缺席=裸构造(测试世界无身份体系),按缺席即放行
   * 的既有纪律处理;生产接线(serve)恒注入,门恒生效。 */
  userRole?: (username: string) => "admin" | "developer" | undefined;
  gitCredential?: (account: string) =>
    (GitCredential & { email?: string }) | undefined;
  /** 个人模型网关查询口(ADR-0068,serve 接 LocalAuth.personalModels):
   *  按会话责任人现取其自配的模型接入,配齐则问题会话的主模型调用
   *  整体走它;缺席/未配=undefined,走平台网关。 */
  personalModels?: (account?: string) => ModelsSettings | undefined;
  opsTools?: IssueOpsTools;
  /** ops 二进制目录(宿主 assets/ops-tools);有 isolation 时按会话
   * 构造容器内执行的 ops 工具,比全局 opsTools 更优先。 */
  opsToolsDir?: string;
  dts?: DtsGateway;
  /** 交付平台适配层(--platform):MR 创建与需求交付共用同一端点。 */
  platformUrl?: string;
  /** 调试形态(--debug-issue):会话技能物化后把 fetch-logs 的抓日志
   * wrapper 换成假引擎(罐头复制,不连网管)。旗标缺席时整个字段
   * 不在,会话行为与现状逐字节一致。 */
  debugIssue?: { opsMockBinDir: string };
  vault?: IssueEnvironmentVault;
  /** 环境台账(ADR-0020/#150 快照语义):登记与 env_needed 闸从台账
   * 选环境时解密取值。缺省按 dataDir 自建(与 vault 同一数据目录的
   * 独立台账文件);测试可注入。 */
  environmentRegistry?: EnvironmentRegistry;
  /** 回合并发额度的部署缺省(--issue-max-turns):泵先读管理页运行时
   *  旋钮 issue_max_turns,缺席才用这里;两边都缺省时是 10。 */
  maxConcurrentTurns?: number;
  /** @deprecated 旧部署参数兼容，不再按事件数压缩。 */
  compactEveryEvents?: number;
  /** 可选的专用视觉模型角色(与需求侧 TaskService 同形)。openDriver
   * 组装会话时按同款逻辑变成 VisionCapabilityConfig,主会话由此获得
   * inspect_image 工具;缺席则工具不出现,行为照旧。 */
  vision?: VisionModelChoice;
  /** 小鲁班通知(公共能力,与需求侧同一实例):AI 举卡等决策时提醒
   * 归属用户。缺席(演示形态)不通知,流程照走——通知是旁路,不是
   * 问题流的启动依赖。 */
  notifier?: Notifier;
  /** 通知链接的对外入口(--public-url):深链落到问题会话工作台
   *  /issues/<id>,与需求侧 /work/<id> 同一地位。缺席时从已登录
   *  用户的实际请求 Host 学到内网入口(observeLinkBase),不再
   *  默认写死 127.0.0.1,也不出只剩路径后缀的死链。 */
  linkBase?: string;
  isolation?: IssueIsolation;
  /** 环境预热编译(需求侧 warmupAgent 的问题流移植,2026-09-04):
   * 拉仓完成后于同一容器另起专职会话编译基线、焐热分仓缓存、沉淀
   * build-notes。fail-open 旁路,失败绝不打断主流程。缺席=关闭
   * (测试形态零意外会话);正式接线在 serve 层与需求侧同条件
   * (host + isolateImage)。runner 供测试注入,生产缺席走原生
   * CloudSession 执行器。 */
  warmup?: {
    enabled?: boolean;
    runner?: IssueWarmupRunner;
  };
  /** 上传 Skill 的固定调用；不新增交付阶段。 */
  codecheck?: { runner?: CodecheckRunner };
  /** 容器属主判定的运行时形态:生产缺席即按进程真实形态判定(非 root
   * 部署守卫直接 false,零开销);只有测试注入它来模拟 root 宿主。 */
  ownershipRuntime?: ContainerOwnershipRuntime;
  log?: (message: string) => void;
  /** 正式服务需要先清扫上次进程遗留的容器，再恢复问题会话。缺省仍在
   * 构造时恢复，保持独立使用与既有测试兼容；serve 显式延后并调用
   * start()，从启动顺序上消掉“新容器被孤儿清扫误杀”的竞态。 */
  deferRecovery?: boolean;
}

interface LiveIssue {
  id: string;
  root: string;
  state: IssueSessionState;
  humanGate: HumanGate;
  /** 用户取消会递增；旧回合稍后返回时凭此识别自己已经失效，不能把
   * canceled 覆盖回 failed/idle。 */
  controlEpoch: number;
  driver?: CloudSession;
  container?: TaskContainer;
  toolContext?: IssueToolContext;
  /** 分支传输在途互斥(ADR-0074 票 3):回合开始探针与 push_branch/
   *  sync_branch 共用一把;LiveIssue 级单例,driver 重建不断链。懒建,
   *  见 branchTransferOf。 */
  branchTransfer?: BranchTransferMutex;
  /** 环境预热在跑的内存闸:预热会话与主会话共享容器,重复启动会
   * 叠加编译负载;重启后丢内存态没关系,收据(state.warmup)兜底
   * 幂等。 */
  warmupActive?: boolean;
  /** 重启续跑的待递话:恢复路径把会话重新入队时放上平台通知,泵启动
   * 时消费——续跑与用户续聊共用同一条重建回合体,只差这句开场。 */
  resumeMessage?: string;
  /** turning 占位的代币(issue-20):settle 的催办/补发延续接棒时领取
   *  新号,外层回合收口见号易主即让位——互斥位与并发额度因此横跨整条
   *  延续链,而不是在催办一开始就裸奔。 */
  turnToken?: number;
  /** 本回合的审计关联 id(ADR-0053):beginTurn/beginContinuationTurn
   *  定格,canonical 行与回合内投递账共享;跨重启唯一(带时间戳)。 */
  auditTurnId?: string;
  /** 举卡即收口的回合标记(票 #573,ADR-0019 2026-10-31 增补):本
   *  回合内已举过卡(平台闸或 Agent 问题卡)。举卡置位,回合启动/
   *  收口清零,重启天然归零——绝不按「闸在场」跨回合拦(检视分诊
   *  送达开的回合、收口后返工的回合要用平台工具)。唯一例外:存量
   *  skill_select 圈选闸在场时回合启动即置位——封存闸按在场跨回合拦
   *  的旧语义原样保留(ADR-0014),新举的卡不吃这颗种子。 */
  cardRaisedInTurn?: boolean;
}

export interface IssueMessage {
  role: "user" | "assistant" | "decision";
  text: string;
  ts: string;
}

/** 通用压缩锚点(标题+阶段+单号):openDriver 的 compactAnchor 与阈值
 * 路的回合前压缩共用一份,别让两处文案漂移。 */
function issueCompactAnchor(state: IssueSessionState): string {
  return `问题会话「${state.title}」;阶段 ${state.stage};单号 ${state.ticket ?? "未绑定"}`;
}

/** 基础设施瞬断的统一包装(票 #159 对齐拍板 2026-09-10):Docker
 * daemon 不可达/镜像拉取失败这类时间可恢复的失败,标哨兵交 runTurn
 * 落 idle 交还人工,不再走"整单 failed"——下一回合 ensureContainer
 * 本就会按 isAlive 重建。 */
/** 目录递归统计(磁盘治理清扫):字节数 + 最新 mtime(产物冷却判据,
 * 编译在持续 touch 嵌套文件,只看目录自身 mtime 会把活跃产物误判成
 * 冷的)。软链不跟随——与 GateService 的账本纪律同款,绝不走到工作区
 * 外;不可读条目按 0/跳过(保守不删)。 */
function treeStats(dir: string): { bytes: number; newestMtime: number } {
  let bytes = 0;
  let newestMtime = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      try {
        const stat = statSync(path);
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        bytes += stat.size;
        newestMtime = Math.max(newestMtime, stat.mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return { bytes, newestMtime };
}

/** 终态现场回收开关的部署缺省(server.ts 缺省快照同用,勿两处漂移)。 */
export const ISSUE_REPO_RECLAIM_DEFAULT = 1;
export const ISSUE_WARMUP_ENABLED_DEFAULT = 0;
/** 守闸器阈值缺省(分钟,#248):两小时——留足「用户验证要时间」的量,
 *  又不至于漏卡隔夜才被发现;server defaults 与旋钮两处同源。 */
export const ENV_VERIFY_WATCHDOG_MINUTES_DEFAULT = 120;
/** 构建产物冷却期的部署缺省(小时)。 */
export const ISSUE_BUILD_PRODUCTS_COOLDOWN_HOURS_DEFAULT = 24;

function issueInfraFailure(cause: unknown): IssueInfraError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new IssueInfraError(`容器启动失败(基础设施): ${detail}`);
}

const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 催办续跑预算:每个用户/平台回合最多自动推回模型这么多次,再收嘴就
 * 落 idle 交还人工——催办是纠偏不是永动机,连收嘴说明模型真不想干了。 */
const NUDGE_BUDGET = 2;

/** 重启续跑的开场通知(#27):续跑回合以它为用户消息,落事件流——
 * 重启这件事在会话时间线里可查,不落 stage_note(那是显示层的现场
 * 说明,盖掉就丢了恢复前的阶段语境,续聊提示词还要用它)。 */
const RESTART_RESUME_NOTICE = promptCopy("notices", "restart.resume");

/** 异常重跑(ADR-0055)的恢复回合开场:与重启通知同一纪律——以用户
 * 消息落事件流、时间线可查。操作者说明原文拼进通知(补充说明不变量:
 * 带说明必开回合送达,只记账不算送达),截断线用 QUOTED_NOTE_MAX。 */
function reviveResumeNotice(note?: string): string {
  const text = note?.trim();
  return promptCopy("notices", "revive.resume", {
    note: text
      ? `\n\n[操作者关于本次异常的说明]\n${text.slice(0, QUOTED_NOTE_MAX)}`
      : "",
  });
}

/** MR 检视回复的出站信箱(宿主发送账,会话工作区根):AI 的回复经
 * respond_review 落批注账后由平台扫描装箱(ADR-0052 单通道),信箱是
 * 发送的唯一真相。 */
const MR_REPLY_OUTBOX_FILE = "mr-review-outbox.json";
/** 单条回复发送的等待预算：平台挂住不响应时按失败记一次重试，不让监看环无限等。 */
const MR_REPLY_SEND_TIMEOUT_MS = 30_000;

/** SKILL.md frontmatter 的 description(没有就空串):只认文件开头
 * `---` 包围块里的 description 行,多余内容一律不猜——清单卡上的
 * 描述只是展示,真相始终在文件本体,Agent 圈选后要读的也是本体。 */
function skillDescription(path: string): string {
  try {
    const head = readFileSync(path, "utf-8").split("---", 3);
    if (head.length < 3 || head[0].trim() !== "") return "";
    const match = head[1].match(/^description:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

/** skill 圈选扫描的两个固定目录(2026-09-03 拍板):数组序即优先级,
 * `.cac` 在前(存量团队行为不变),`.agents` 补位;pi/.claude 不进
 * 问题流扫描(与需求流 REPOSITORY_SKILL_ROOTS 四根刻意不同)。 */
const SKILL_SCAN_ROOTS = [
  { dir: join(".cac", "skills"), label: ".cac/skills" },
  { dir: join(".agents", "skills"), label: ".agents/skills" },
] as const;

/** 业务 skill 发现的递归深度上限(与团队货架 collectSkillFiles 同约定):
 * 分类层(如 .cac/skills/engineering/<名>/SKILL.md)支持到 8 层。 */
const MAX_BUSINESS_SKILL_DEPTH = 8;

/** 递归发现根下全部技能目录(直接含 SKILL.md 的目录),发现即止——
 * 技能包的子目录是资源不是分类;根不存在/不可读=零发现(可选能力,
 * 不响)。导出仅供测试。 */
export function discoverBusinessSkillDirs(
  skillsRoot: string,
): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_BUSINESS_SKILL_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolute = join(dir, entry.name);
      if (existsSync(join(absolute, "SKILL.md"))) found.push(absolute);
      else walk(absolute, depth + 1);
    }
  };
  walk(skillsRoot, 0);
  return found.sort();
}

/** 维度的人话名(展示用):COMPILE→编译/构建。 */
function dimensionLabels(dimensions: PipelineDimension[]): string {
  return dimensions.map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
}

/** 上轮报错对比段(票 82)的唯一来源:派发修复的回合与人工回灌回合两路共用,
 *  不许各写一份漂移。机制是代码(两路都记账),纪律是这段提示词。 */
function previousFailureLines(
  previousSha: string | undefined,
  previousSummary: string | undefined,
): string[] {
  return previousSha && previousSummary
    ? [`上一轮(提交 ${previousSha.slice(0, 12)})红灯的报错摘要如下,`,
      "先对比是否同一处:", previousSummary,
      "纪律:同一处必须换思路,换思路也解决不了就直说修不了,",
      "不许重复同样的修改。"]
    : [];
}

/** 失败维度的人话名(去重,保持 PIPELINE_DIMENSIONS 的自然顺序)。 */
function failedDimensionLabels(checks: PipelineCheck[] | undefined): string {
  const failed = new Set((checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => check.dimension));
  const ordered = PIPELINE_DIMENSIONS.filter((dimension) =>
    failed.has(dimension));
  return dimensionLabels(ordered);
}

/** 本轮红灯的人话摘要(票 82 派发修复留账用):维度点名+失败摘要节选,
 *  截断防膨胀。下一轮派发修复时作为"上轮报错"拼进回合提示词,让会话
 *  对比是否同一处再决定换不换思路(需求流 loop.failure 同语义)。 */
function pipelineFailureDigest(
  run: PipelineRun,
  checks: PipelineCheck[] | undefined,
): string {
  const dims = failedDimensionLabels(checks);
  const log = (run.log ?? "").trim();
  const parts = [
    dims ? `失败维度: ${dims}` : "",
    log ? log.slice(0, 400) : "",
  ].filter(Boolean);
  return (parts.join(";") || "(平台未给出失败详情)").slice(0, 600);
}

export class IssueFlowService {
  private readonly mrImports = new Map<string, { account: string; promise: Promise<IssueSummary> }>();
  /** 公开只读:管理页服务设置的 defaults 要展示部署层并发缺省
   *  (与 TaskService.options 公开同一理由)。 */
  readonly options: IssueFlowOptions;
  private readonly vault: IssueEnvironmentVault;
  private readonly environmentRegistry: EnvironmentRegistry;
  private readonly issuesRoot: string;
  private readonly live = new Map<string, LiveIssue>();
  private readonly turning = new Set<string>();
  private storageSweepActive = false;
  /** 回合代币发放器:每次启动回合/接棒发新号,收口方凭号判断自己还是不是
   *  槽位主人。纯内存计数,进程内唯一即可。 */
  private turnSeq = 0;
  private recoveryStarted = false;
  private shuttingDown = false;
  /** 从已登录用户请求 Host 学到的通知入口(--public-url 缺席时的
   *  兜底,与需求侧 TaskService 同款)。 */
  private observedLinkBase?: string;
  /** 数据目录(业务模块库等子系统的根),供路由层读取。 */
  readonly dataDir: string;

  constructor(options: IssueFlowOptions) {
    migrateMrRepairRecords(options.dataDir, options.log);
    this.options = options;
    this.dataDir = options.dataDir;
    // 进程级审计账(host-calls/canonical,ADR-0053):单实例服务装配
    // 一次;多实例并存(测试)后者覆盖前者,进程账面归属最后装配者,
    // 会话级账(root 内)不受影响。
    configureAudit(join(options.dataDir, "logs"));
    this.vault = options.vault
      ?? new IssueEnvironmentVault(options.dataDir);
    this.environmentRegistry = options.environmentRegistry
      ?? new EnvironmentRegistry(options.dataDir);
    this.issuesRoot = join(options.dataDir, options.purpose === "pipeline_repair" ? "pipeline-repairs" : "issues");
    mkdirSync(this.issuesRoot, { recursive: true });
    if (!options.deferRecovery) this.start();
  }

  private get idPrefix(): string { return this.options.purpose === "pipeline_repair" ? "mr-repair-" : "issue-"; }

  /** 共用执行能力与凭据设施，记录和运行状态由独立实例持有。 */
  createPipelineRepairTool(): IssueFlowService {
    return new IssueFlowService({ ...this.options, purpose: "pipeline_repair",
      vault: this.vault, environmentRegistry: this.environmentRegistry,
      dts: undefined, notifier: undefined,
    });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** 重启恢复(#27,与需求侧断点续跑同语义):正在跑的会话重新入队,
   * 由并发额度泵逐个自动续跑(现场 driver 不在就重建,续聊提示词交给
   * 重建的上下文);排队中的保持 queued 原样开跑;旧版本盖在盘上的
   * interrupted 戳(词表已退役)按 running 同一条路处理。
   * waiting_user 照旧等家人,终态不动。恢复完成补一脚泵——
   * 泵原本只在回合启动/收口被调,启动期没有调用点,不补则重新入队的
   * 会话永远坐着。
   *
   * 正式服务在遗留容器清扫完成后显式调用；幂等避免
   * 启动接线或测试重复调用时把同一问题会话恢复两次。 */
  start(): void {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.recover();
    this.armEnvVerifyWatchdog();
  }

  private recover(): void {
    let requeued = 0;
    let keptQueued = 0;
    for (const name of readdirSync(this.issuesRoot)) {
      if (!name.startsWith(this.idPrefix)) continue;
      const root = join(this.issuesRoot, name);
      // 单目录隔离(票 #158,issue-31/32/33 复盘):一个损坏的 issue.json
      // 不许把整个服务启动拖死——全场唯一"死的是所有会话"的路径。
      // 隔离只救邻居不救自己:该目录跳过并大声记账,列表可见的「现场
      // 损坏」投影另行拍板(见票)。
      let state: IssueSessionState | undefined;
      // 推送过目闸退役(2026-09-17,ADR-0009 增补):盘上等这张卡的
      // 会话要在 loadState 剥卡**之前**认领——剥卡后"等人无卡"的空壳
      // 无法与其他现场区分,不能把整个形态卷进自动续跑。原文解析失败
      // 不在此处理会,loadState 的隔离纪律兜底。
      let hadLegacyPushGate = false;
      try {
        const raw = JSON.parse(readFileSync(join(root, "issue.json"),
          "utf-8")) as { gate?: { kind?: string } };
        hadLegacyPushGate = raw.gate?.kind === "push_confirm";
      } catch {
        hadLegacyPushGate = false;
      }
      try {
        state = loadState(root);
      } catch (error) {
        this.log(`[issue-flow] ${name} 恢复失败,已隔离跳过(服务继续启动;`
          + `现场文件损坏?路径 ${join(root, "issue.json")}): `
          + String(error instanceof Error ? error.message : error));
        continue;
      }
      if (!state) continue;
      if (state.scenario === "mr_repair" && this.options.purpose !== "pipeline_repair") continue;
      if (this.options.purpose === "pipeline_repair" && state.id !== name) { state.id = name; saveState(root, state); }
      if (interruptWarmupReceipt(state.warmup)) saveState(root, state);
      // 旧值按字符串比(interrupted 已不在词表里,类型层面不认它)。
      const humanGate = new HumanGate(join(root, "waiting.json"));
      const diskStatus: string = state.status;
      // 退役推送卡的等人空壳:loadState 已剥卡,重新入队让 AI 续跑,
      // 推送直推不再等确认(只认认领过的现场,其他等人会话原样不动)。
      const retiredPushWait = diskStatus === "waiting_user" && hadLegacyPushGate;
      const resuming = diskStatus === "running" || diskStatus === "interrupted"
        || retiredPushWait;
      if (resuming) {
        state.status = "queued";
        // 阶段语境(stage/note)原样保留:续聊提示词的「最近阶段」
        // 靠它把现场交给重建的上下文;重启事实走转移台账与开场通知。
        recordTransition(state, {
          source: "platform",
          note: retiredPushWait
            ? "推送确认卡已退役:推送不再需要人工确认,自动续跑"
            : "服务重启,重新入队,平台自动续跑",
        });
        saveState(root, state);
        requeued += 1;
      } else if (state.status === "queued") {
        keptQueued += 1;
      }
      const live: LiveIssue = {
        id: state.id, root, state,
        humanGate,
        controlEpoch: 0,
        // 崩溃回灌(遗留洞 A-H1):作答落账后、送达模型前崩溃,恢复
        // 回合只带重启通知会把人的决定整条丢掉——末条事件恰是人的
        // 决定时,原文附进恢复消息,Agent 不装没听见。
        ...(resuming ? { resumeMessage: RESTART_RESUME_NOTICE
          + lastHumanDecisionNote(root) } : {}),
      };
      this.live.set(state.id, live);
      // 在途账清理(与异常重跑共用的每单段,ADR-0055):日志前缀传
      // 空串、作废来路标「重启」——重启恢复的日志与作废备注一字不差。
      this.rearmInFlightLedgers(live, "", "重启");
    }
    // 孤儿凭据对账(H5):崩溃/强杀可能把"vault 里还有凭据、会话已不在
    // 册或已终态"的孤儿留在盘上——按会话 id 隔离的保险箱没人再去
    // remove。启动期对一次账:不在 live 或已终态的凭据组直接删除。
    // 只对账 issue- 前缀:保险箱存储区与需求任务(task-N)共用,
    // 需求侧的凭据不归问题流清扫。
    const aliveIds = new Set<string>();
    for (const [existingId, existingLive] of this.live) {
      if (!isTerminal(existingLive.state.status)) aliveIds.add(existingId);
    }
    for (const vaultId of this.vault.ids()) {
      if (!vaultId.startsWith(this.idPrefix) || aliveIds.has(vaultId)) continue;
      this.vault.remove(vaultId);
      this.log(`[issue-flow] 重启清扫:会话 ${vaultId} 不在册或已终态,`
        + `孤儿环境凭据已删除`);
    }
    if (requeued || keptQueued) {
      this.log(`[issue-flow] 重启恢复: 续跑 ${requeued} 个、`
        + `排队 ${keptQueued} 个问题会话`);
      // 台账行之后立即开泵:构造函数不能 await,泵与 create()
      // 同款 void 火力——同步段把首批额度占上,余下的在收口时再泵。
      void this.pump();
    }
  }

  /** 在途账重新接手(重启恢复与异常重跑共用的每单段,ADR-0055):
   *  崩溃留在窗口里的账不因「换个方式续跑」而漂——未定格 Agent 卡
   *  作废、MR 合入/检视监看续挂、流水线监看续表、监看账落后于推送账
   *  补挂、retry 死账清理。判断依据与日志行沿重启恢复的既有写法;
   *  logPrefix 只进日志行(重启恢复传空串,历史日志一字不差),作废
   *  备注按 scene 标来路(重启/异常重跑)。 */
  private rearmInFlightLedgers(
    live: LiveIssue,
    logPrefix: string,
    scene: string,
  ): void {
    const { state } = live;
    // 合入事实监看续挂(ADR-0022):验绿已收口、MR 还没全部合入的,
    // 中断后继续逐仓盯 /mr/gates;已终态/已全合入的循环自会退出。
    // 检视监看续挂(②-Q1):原启动链(MR 建成→流水线监看)中断后
    // 不再触发——流水线已按终态处理(watching=false)的会话,意见发现、
    // 注入与回复发送会全部停摆,凡 mr_green 且有 MR 一律续挂;
    // 外部意见只同步为待判断批注，不恢复旧版自动派发修复通知。
    if (state.mrs?.length && !isTerminal(state.status)) {
      this.watchMergeStates(live);
      this.watchMrDiscussions(live);
    }
    // 流水线监看续表:deadline 还是原来那张(中断不白送预算);
    // watching=false 的(终态/耗尽)不重挂。多仓各自挂各自的表。
    let staleRetryLedger = false;
    for (const [repo, watch] of Object.entries(state.pipelines ?? {})) {
      // #578：在途取证沿用原截止时间，直接续取产物，不重新触发流水线。
      if (watch.watching && watch.status === "failed" && watch.evidence_retry_deadline) {
        void this.settlePipeline(live, repo, watch.sha, {
          status: "failed", checks: watch.checks, log: watch.evidence_failure_log,
        });
        continue;
      }
      if (watch.watching) {
        this.log(`[issue-flow] ${logPrefix}${state.id} 恢复流水线监看(${repo})`
          + ` @ ${watch.sha.slice(0, 12)}`);
        void this.watchPipeline(live, repo, watch.sha);
      }
      // 非在途取证的旧字段仍清理，避免把已处理的红灯重新发送。
      if (watch.evidence_retry_deadline) {
        delete watch.evidence_retry_deadline;
        delete watch.evidence_retry_attempts;
        delete watch.evidence_failure_log;
        staleRetryLedger = true;
      }
    }
    if (staleRetryLedger) saveState(live.root, state);
    // 监看账落后于推送账就补挂(issue-72 死表现场的中断自愈):有
    // MR 的仓,监看缺席或 SHA 与推送账对不上,说明推送后启动的监看丢失
    // (修复环不重建 MR/进程崩溃窗口/回退轮清表)——按推送账新 SHA
    // 重挂。同 SHA 已按终态处理的不碰:重放红灯终态处理会扰动同提交刹车账。
    // external_head 的账不补挂(ADR-0041):检查目标是有意跟着平台外
    // 提交走的,落后的推送账不是正确目标——补挂会跟检查目标跟随机制
    // 打架(重启即来回切)。放在续表循环之后,补挂换掉的新账不会被
    // 旧循环重复盯。
    if (!isTerminal(state.status)) {
      for (const mr of state.mrs ?? []) {
        const pushed = state.pushes
          ?.find((item) => item.repo === mr.repo)?.sha
          ?? (state.imported_mr?.repo === mr.repo ? state.imported_mr.sha : undefined);
        const watch = state.pipelines?.[mr.repo];
        if (pushed && (!watch || (watch.sha !== pushed
            && !watch.external_head))) {
          this.log(`[issue-flow] ${logPrefix}${state.id} 监看账落后于推送账`
            + `(${mr.repo}),补挂 @ ${pushed.slice(0, 12)}`);
          this.armPipelineWatch(live, mr.repo);
        }
      }
    }
    // 清扫(H6):等人会话里够格代答的闸重判一次(免审批档位不因
    // 中断漏答);非等人的会话不该还有挂着的人问卡——崩溃前没走完的
    // 定格作废留痕,别留一张永远答不了的卡占列表。
    if (state.status === "waiting_user") {
      this.maybeAutoAnswerGate(live);
    } else {
      for (const record of live.humanGate.pending()) {
        try {
          live.humanGate.supersede(record.waiting_id, {
            stateVersion: record.state_version,
            notes: `${scene}清扫:崩溃遗留的未定格待办,作废`,
          });
        } catch (error) {
          this.log(`[issue-flow] ${state.id} ${scene}作废待办 `
            + `${record.waiting_id} 失败: `
            + String(error instanceof Error ? error.message : error));
        }
      }
    }
  }

  // ---- 查询 ----

  /** 「我的问题」(ADR-0031,2026-09-16 修订为单一列表):归属**或**
   * 登记人是登录账号——名下要推进的、登记给他人要跟踪的,一张列表;
   * 自登记两个条件同真,只出现一次。account 缺席=不过滤(团队看板与
   * 管理员视角,scope=all 同款)。 */
  list(account?: string): IssueSummary[] {
    const rows = [...this.live.values()].map((item) => this.project(item));
    // 按最近更新倒序:列表顺序与卡片上显示的时间(updated_at)一致,
    // 最近有动静的会话浮到最上面;创建时间只决定初始位置。
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return account
      ? rows.filter((row) =>
          row.account === account || row.reporter === account)
      : rows;
  }

  /** 终态冻结快照(ADR-0042,#325):会话落终态、issue.json 落盘之后,
   *  代码现场回收之前,把全部事实账投影计算一次,冻结成会话目录的
   *  metrics.json。只生成一次(已在则跳过);生成与写盘的任何失败都
   *  只记日志,绝不阻塞归档/取消/失败收口本身。 */
  private freezeMetricsSnapshot(
    live: Pick<LiveIssue, "root" | "id" | "state">,
  ): void {
    if (this.options.purpose === "pipeline_repair") return;
    try {
      // 提交归属层要 fetch MR 分支(#326):凭据与推送工具同源;缺席
      // (测试裸构)按匿名尝试,取不到由快照就地降级。
      const result = writeIssueMetricsSnapshot(live.root, live.state, {
        fetchCredential: this.options.gitCredential?.(live.state.account),
      });
      if (result.skipped) return;
      this.log(`[issue-flow] ${live.id} 终态快照已冻结`
        + (result.degraded.length
          ? `(缺项:${result.degraded.join("、")})` : ""));
    } catch (error) {
      this.log(`[issue-flow] ${live.id} 终态快照生成失败(不阻塞收口): `
        + String(error instanceof Error ? error.message : error));
    }
  }

  /** 一次率二轴(口径:CONTEXT「一次修复成功率」「一次定位成功率」
   *  词条,分类在 onceRates.ts 纯函数)。读侧切换(#327,ADR-0042):
   *  终态会话优先读会话目录里冻结的 metrics.json 判定事实(快、稳,
   *  调用方无感);在途会话照旧现算。快照缺失、损坏或不认识的版本
   *  自动回退现算——不报错、记一条日志,等价于没接过快照。现算口径
   *  不变:验证失败与检视批次的判定由 onceRates.ts 的共享函数
   *  (countVerifyFailures/sentReviewBatches)承担,快照投影
   *  (metricsSnapshot.ts)与现算调同一份,口径不分家;报告版本数读
   *  分析报告版本账(listAnalysisVersions)。枚举与 list() 同源(live
   *  全集,重启恢复时装载)。 */
  onceRates(): IssueOnceRateSummary {
    const rows: IssueOnceRateFacts[] = [...this.live.values()].map(
      (live) => this.onceRateFacts(live),
    );
    return issueOnceRates(rows);
  }

  /** 单个会话的判定事实:终态先试冻结快照,拿不到再现算。 */
  private onceRateFacts(live: LiveIssue): IssueOnceRateFacts {
    let facts: IssueOnceRateFacts;
    if (isTerminal(live.state.status)) {
      const frozen = this.frozenOnceRateFacts(live);
      facts = frozen ?? this.computedOnceRateFacts(live);
    } else {
      facts = this.computedOnceRateFacts(live);
    }
    // 转正血缘是会话级事实,不在冻结快照里,统一从现场状态补齐
    // (ADR-0048 存量:一次定位轴据此剔除)。
    return { ...facts, converted_from: live.state.converted_from };
  }

  /** 终态会话的冻结快照读侧:文件在、内容认、会话号对得上才采用;
   *  任何一步不满足都返回 null 交回退,绝不抛错。 */
  private frozenOnceRateFacts(live: LiveIssue): IssueOnceRateFacts | null {
    const path = join(live.root, ISSUE_METRICS_FILE);
    if (!existsSync(path)) {
      this.log(`[issue-flow] ${live.id} 终态快照缺失,统计回退现算`);
      return null;
    }
    let snapshot: IssueMetricsSnapshot;
    try {
      snapshot = JSON.parse(readFileSync(path, "utf-8")) as IssueMetricsSnapshot;
    } catch (error) {
      this.log(`[issue-flow] ${live.id} 终态快照损坏,统计回退现算: `
        + String(error instanceof Error ? error.message : error));
      return null;
    }
    if (!snapshot || typeof snapshot !== "object"
      || snapshot.session_id !== live.id) {
      this.log(`[issue-flow] ${live.id} 终态快照会话号对不上,`
        + "统计回退现算");
      return null;
    }
    const facts = onceRateFactsFromSnapshot(snapshot);
    if (!facts) {
      this.log(`[issue-flow] ${live.id} 终态快照不可用`
        + "(版本或判定字段不认),统计回退现算");
      return null;
    }
    return facts;
  }

  /** 判定事实现算(切换前的原路径,也是快照拿不到时的回退路径)。 */
  private computedOnceRateFacts(live: LiveIssue): IssueOnceRateFacts {
    return {
      id: live.id,
      ticket: live.state.ticket,
      status: live.state.status,
      conclusion_kind: live.state.conclusion?.kind,
      // 终止原因(#542):canceled 终态伴生,与快照冻结字段同源。
      cancel_reason: live.state.cancel_reason,
      // 判定收在 onceRates.ts 的共享函数,与快照投影同一份(口径
      // 注释见彼处):这里不各写各的判定。
      verify_fail_count: countVerifyFailures(live.state.transitions ?? []),
      report_version_count: listAnalysisVersions(live.root).length,
      review_count: sentReviewBatches(reviewStore(live.root).history()).length,
    };
  }

  /** 首次生成占比读侧(ADR-0045,#342):终态伴生快照(code-origin.json)
   *  的聚合,days 为时间过滤(按结论时刻,近 N 天;缺省=全部)。
   *  占比/达标分母=范围内有数据(伴生在场且有工作变更行)的完成交付会话;
   *  伴生缺席按结论时刻分「待算」(支持期内:通道在途或曾丢失,清扫器兜底)
   *  与「不支持期」(起算日期前终态,永不回填)。达标线是参数(settings
   *  runtime 的 issue_once_generated_threshold_percent,缺省 90)。
   *  一次定位/验证两根过程率轴与 /issues/stats 同源(this.onceRates
   *  的既有判定),分母=范围内完成交付全集——不随伴生在缺漂移;
   *  一次解决率分母(#542)=完成交付全集+负面原因终止会话(记失败)。 */
  onceGeneratedStats(days?: number, range: CompletionRange = {}): IssueOnceGeneratedStats {
    const runtime = this.options.settings?.runtime?.();
    const configured = Number(
      (runtime as Record<string, unknown> | undefined)
        ?.issue_once_generated_threshold_percent);
    const threshold = Number.isFinite(configured) && configured > 0 && configured <= 100
      ? configured
      : ISSUE_CODE_ORIGIN_THRESHOLD_DEFAULT;
    validateCompletionRange(range);
    const cutoff = days && days > 0 ? Date.now() - days * 86400000 : undefined;
    // 收集范围内全部完成交付会话与负面原因终止会话(#542,判定事实
    // + 结论时刻;取消的结论时刻=取消时刻,saveState 落盘时写 updated_at)。
    const collected: Array<{ live: LiveIssue; concludedAt: string }> = [];
    for (const live of this.live.values()) {
      const state = live.state;
      let concludedAt: string;
      if (state.status === "archived") {
        if (state.conclusion?.kind !== "delivered") continue;
        if (!state.ticket?.trim()) continue;
        concludedAt = state.conclusion?.at ?? state.updated_at ?? "";
      } else if (state.status === "canceled") {
        // 负面原因终止进统计(#542);resolved 与无原因取消(历史
        // 路径)维持排除,口径裁决与纯函数 issueOnceRates 同源。
        if (!state.ticket?.trim()) continue;
        if (!state.cancel_reason
          || !ISSUE_NEGATIVE_CANCEL_REASONS.includes(state.cancel_reason)) {
          continue;
        }
        concludedAt = state.updated_at ?? "";
      } else {
        continue;
      }
      const atMs = Date.parse(concludedAt);
      if (!completedInRange(concludedAt, range)) continue;
      if (cutoff !== undefined && (!Number.isFinite(atMs) || atMs < cutoff)) continue;
      collected.push({ live, concludedAt });
    }
    const once = issueOnceRates(collected.map(
      ({ live, concludedAt }) => ({ ...this.onceRateFacts(live), concludedAt })));
    const solvedPassed = once.per_session
      .filter((row) => row.localization_pass && row.repair_pass).length;
    const percent = (passed: number, total: number): number | null =>
      total ? Math.round((passed / total) * 1000) / 10 : null;
    const localization = {
      passed: once.localization.passed, total: once.localization.total,
      rate: once.localization.rate,
    };
    const verify = {
      passed: once.repair.passed, total: once.repair.total,
      rate: once.repair.rate,
    };
    const solved = {
      passed: solvedPassed, total: once.total,
      rate: percent(solvedPassed, once.total),
    };
    const axesById = new Map(once.per_session.map((row) => [row.id, row]));

    const sessions: IssueOnceGeneratedSession[] = [];
    let pending = 0;
    let unsupported = 0;
    let noCode = 0;
    const repoMap = new Map<string, IssueOnceGeneratedRepoRow>();
    for (const { live, concludedAt, ...rowFacts } of collected) {
      // 负面终止行(#542):工作机器事实(定位/验证/占比/检视)缺席不设
      // 键(#540 复审——false/0 假值会被第三方误读成「验证失败」),
      // 带终止原因与说明文本;不进 by_repo、不进达标分母。
      if (live.state.status === "canceled") {
        sessions.push({
          id: live.id,
          title: live.state.title,
          module: this.currentModule(live.state)?.name || live.state.module?.trim() || "未分类",
          reporter: live.state.reporter?.trim() || live.state.account,
          concluded_at: concludedAt,
          state: "canceled",
          ...(live.state.cancel_reason
            ? { cancel_reason: live.state.cancel_reason } : {}),
          ...(live.state.cancel_reason_text
            ? { cancel_reason_text: live.state.cancel_reason_text } : {}),
        });
        continue;
      }
      const axes = axesById.get(live.id);
      const supported = concludedAt.slice(0, 10) >= ISSUE_CODE_ORIGIN_SINCE;
      const snapshot = supported
        ? readCodeOriginSnapshot(live.root, live.id) : undefined;
      const aggregate = snapshot ? aggregateCodeOrigin(snapshot, threshold) : undefined;
      const state: IssueOnceGeneratedSession["state"] =
        !supported ? "unsupported"
        : aggregate && aggregate.total > 0 ? "ok"
        : aggregate ? "no_code"
        : "pending";
      if (state === "pending") pending += 1;
      if (state === "unsupported") unsupported += 1;
      if (state === "no_code") noCode += 1;
      if (state !== "ok" || !snapshot) {
        sessions.push({
          id: live.id,
          title: live.state.title,
          module: this.currentModule(live.state)?.name || live.state.module?.trim() || "未分类",
          reporter: live.state.reporter?.trim() || live.state.account,
          concluded_at: concludedAt,
          reviews: axes?.reviews ?? 0,
          localization_pass: axes?.localization_pass ?? false,
          verify_pass: axes?.repair_pass ?? false,
          solved_pass: axes ? axes.localization_pass && axes.repair_pass : false,
          state,
        });
        continue;
      }
      // 可得且有工作行的仓,单趟筛出供两处消费:per_session 明细与
      // 全局 by_repo 聚合——同一把守卫,不会各漂各的。
      const repoLines = snapshot.by_repo.filter((repo): repo is IssueCodeOriginRepoOk =>
        !("unavailable" in repo)
        && repo.lines.first + repo.lines.rework + repo.lines.external > 0);
      sessions.push({
        id: live.id,
        title: live.state.title,
        module: this.currentModule(live.state)?.name || live.state.module?.trim() || "未分类",
        reporter: live.state.reporter?.trim() || live.state.account,
        concluded_at: concludedAt,
        reviews: axes?.reviews ?? 0,
        localization_pass: axes?.localization_pass ?? false,
        verify_pass: axes?.repair_pass ?? false,
        solved_pass: axes ? axes.localization_pass && axes.repair_pass : false,
        state,
        ...(aggregate ? {
          share: aggregate.share!,
          pass: aggregate.pass === true,
          lines: {
            first: aggregate.first,
            rework: aggregate.rework,
            external: aggregate.external,
          },
          by_repo: repoLines.map((repo) => ({
            repo: repo.repo, first: repo.lines.first,
            rework: repo.lines.rework, external: repo.lines.external,
          })),
        } : {}),
      });
      for (const repo of repoLines) {
        const bucket = repoMap.get(repo.repo) ?? {
          repo: repo.repo, sessions: 0,
          first: 0, rework: 0, external: 0, total: 0, share: null,
        };
        bucket.sessions += 1;
        bucket.first += repo.lines.first;
        bucket.rework += repo.lines.rework;
        bucket.external += repo.lines.external;
        bucket.total = bucket.first + bucket.rework + bucket.external;
        bucket.share = bucket.total
          ? Math.round((bucket.first / bucket.total) * 1000) / 10
          : null;
        repoMap.set(repo.repo, bucket);
      }
    }
    sessions.sort((a, b) => b.concluded_at.localeCompare(a.concluded_at));
    const okRows = sessions.filter((row) => row.state === "ok");
    const total = okRows.length;
    const passed = okRows.filter((row) => row.pass).length;
    return {
      threshold_percent: threshold,
      supported_since: ISSUE_CODE_ORIGIN_SINCE,
      delivered: once.delivered,
      terminated: once.terminated,
      total,
      passed,
      rate: total ? Math.round((passed / total) * 1000) / 10 : null,
      localization,
      verify,
      solved,
      by_repo: [...repoMap.values()].sort((a, b) =>
        b.total - a.total || a.repo.localeCompare(b.repo, "zh-Hans-CN")),
      pending,
      unsupported,
      no_code: noCode,
      per_session: sessions,
    };
  }

  /** 单会话首次生成明细(伴生文件原样读;统计与详情同一份事实,
   *  缺席返回 undefined 由路由 404)。 */
  /** 单会话首次生成明细(伴生文件原样读 + 读侧按 仓+分支 join 会话
   *  mrs 账补 MR 链接:对上就带 mr_url,对不上缺席——冻结文件不动,
   *  只在响应加可选键(#353)。统计与详情同一份事实。 */
  codeOriginDetail(id: string): IssueCodeOriginSnapshot | undefined {
    const live = this.live.get(id);
    const snapshot = live ? readCodeOriginSnapshot(live.root, live.id) : undefined;
    if (!live || !snapshot) return undefined;
    return {
      ...snapshot,
      by_repo: snapshot.by_repo.map((repo) => {
        const url = live.state.mrs?.find((mr) =>
          mr.repo === repo.repo && mr.branch === repo.branch)?.url;
        return { ...repo, ...(url ? { mr_url: url } : {}) };
      }),
    };
  }

  /** 提单模板读侧(ADR-0048):确认是问题闭环的会话在场;缺席返回
   *  undefined 由路由 404(非问题/取消/早期会话自然缺席)。 */
  ticketTemplate(id: string): string | undefined {
    const live = this.live.get(id);
    if (!live) return undefined;
    const file = join(live.root, TICKET_TEMPLATE_FILE);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  /** 登记问题统计读侧(ADR-0048,#362;口径 2026-10-16 由 ADR-0064
   *  收紧):无单会话的结论漏斗与研究质量,days 为时间过滤(按结论
   *  时刻,近 N 天;缺省=全部)。人群=研究结论已出:非问题/确认是
   *  问题归档;取消是退场、不算研究结论,不进本页任何数字——
   *  与一次定位率既有口径对齐(研究进行中、存量挂起读盘按取消退场,
   *  同不入统计,ADR-0048/0057/0064)。版本数从分析版本账现读(同账
   *  同源不漂移),登记人缺席按归属兜底(CONTEXT 口径)。 */
  registrationStats(days?: number, range: CompletionRange = {}): IssueRegistrationStats {
    validateCompletionRange(range);
    const cutoff = days && days > 0 ? Date.now() - days * 86400000 : undefined;
    const rows: IssueRegistrationSessionRow[] = [];
    for (const live of this.live.values()) {
      const state = live.state;
      if (state.scenario !== "no_ticket") continue;
      if (state.status !== "archived"
        || (state.conclusion?.kind !== "issue"
          && state.conclusion?.kind !== "non_issue")) continue;
      const concludedAt = state.conclusion?.at ?? state.updated_at ?? "";
      const atMs = Date.parse(concludedAt);
      if (!completedInRange(state.conclusion?.at, range)) continue;
      if (cutoff !== undefined
        && (!Number.isFinite(atMs) || atMs < cutoff)) continue;
      const versionCount = listAnalysisVersions(live.root).length;
      rows.push({
        id: live.id,
        title: state.title,
        module: this.currentModule(state)?.name || state.module?.trim() || "未分类",
        reporter: state.reporter?.trim() || state.account,
        account: state.account,
        concluded_at: concludedAt,
        conclusion: state.conclusion!.kind as "issue" | "non_issue",
        report_version_count: versionCount,
        localization_pass: versionCount <= 1,
      });
    }
    rows.sort((a, b) => b.concluded_at.localeCompare(a.concluded_at));
    return aggregateRegistrationStats(rows);
  }

  /** 容器探活(供工作区回收等外部清扫方做保险判断):会话容器当前
   *  是否在运行。终态会话容器应已停,此探活是 belt-and-suspenders。 */
  hasRunningContainer(id: string): boolean {
    return !!this.live.get(id)?.container?.isAlive;
  }

  private require(id: string): LiveIssue {
    const live = this.live.get(id);
    if (!live) throw new IssueNotFoundError(id);
    return live;
  }

  /** Issue Flow 的前置分析仍独立；进入代码交付后，反馈索引与需求交付
   * 共用同一份 append-only 模型，页面和恢复不再认识第二套状态词。 */
  private feedbackStore(live: LiveIssue): FeedbackStore {
    return new FeedbackStore(join(live.root, "feedback", "index.jsonl"));
  }

  private currentModule(state: IssueSessionState) {
    return state.module_id ? resolveBusinessModuleRef(this.options.dataDir, { id: state.module_id, name: state.module ?? state.module_id }) : undefined;
  }
  private summarize(state: IssueSessionState): IssueSummary {
    const module = this.currentModule(state);
    return {
      ...summarize(state),
      ...(module ? { module_id: module.id, module: module.name } : {}),
      // 该单已排除自动接单(ADR-0072):终止确认框据此抑制「将改为排除」
      // 的事前提示(已排除无需再提示)。稀疏在场,缺席=允许;per-call
      // 现读与 currentModule 同款,排除表是小 JSON,量级可忽略。
      ...(state.ticket
        && readDtsAutoClaimExclusions(this.options.dataDir)[state.ticket]
        ? { auto_claim_excluded: true } : {}),
    };
  }
  private project(live: LiveIssue): IssueSummary {
    const feedback = this.feedbackStore(live).list();
    return {
      ...this.summarize(live.state),
      ...(feedback.length ? { feedback } : {}),
    };
  }

  private resolveIssuePipelineFeedback(
    live: LiveIssue,
    repo: string,
    status: FeedbackRecord["status"],
    resolution: string,
  ): void {
    const store = this.feedbackStore(live);
    for (const record of store.list()) {
      if (record.source === "pipeline"
          && record.source_id.startsWith(`${repo}@`)
          && record.status !== "closed") {
        store.resolve(record.id, status, resolution);
      }
    }
  }

  get(id: string): IssueSummary & {
    waiting?: WaitingRecord;
    has_analysis: boolean;
    /** 一次结果章(会话卡片呈现):只在「有单+修复完成归档」上出——
     *  与团队页两轴同一判定(经 onceRateFacts 终态优先读冻结快照,
     *  口径一处两用);无单、取消、失败、非问题收口不适用,字段缺席
     *  即不渲染,避免给没有修复旅程的会话误发「一次修复」章。 */
    once_outcome?: IssueOnceOutcome;
  } {
    const live = this.require(id);
    const { state } = live;
    const onceEligible = Boolean(state.ticket?.trim())
      && state.status === "archived"
      && state.conclusion?.kind === "delivered";
    return {
      ...this.project(live),
      // Agent 卡选项投影时派决策码(前端认码不认文案);平台闸的卡
      // 自带 GATE_OPTIONS 的码,原样在 state.gate 里。
      waiting: withAgentOptionCodes(live.humanGate.pending()[0]),
      has_analysis: existsSync(join(live.root, "issue-analysis.md")),
      ...(onceEligible
        ? { once_outcome: issueOnceOutcome(this.onceRateFacts(live)) }
        : {}),
    };
  }

  /** 会话消息(事件账本投影):user/assistant/decision 三类,尾部截断。
   * 唯一消费者是「耗时与卡点」视图(timeline);详情响应不携带它——
   * 前端的对话内容直接来自现场页签的事件流。 */
  messages(id: string): IssueMessage[] {
    const live = this.require(id);
    const path = join(live.root, "events.jsonl");
    if (!existsSync(path)) return [];
    const messages: IssueMessage[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.kind === "user_message") {
        messages.push({
          role: "user", text: String(payload.text ?? ""), ts: String(event.ts ?? ""),
        });
      } else if (event.kind === "assistant_message") {
        messages.push({
          role: "assistant", text: String(payload.text ?? ""), ts: String(event.ts ?? ""),
        });
      } else if (event.kind === "human_decision") {
        messages.push({
          role: "decision",
          text: `用户决定: ${String(payload.decision ?? "")}`,
          ts: String(event.ts ?? ""),
        });
      }
    }
    return messages.slice(-300);
  }

  /** 协作流(ADR-0018):事件账本投影成任务侧 ConversationItem 同形状
   * 的条目数组,右栏「与 Agent 协作」对话框消费。同一条现场记录的
   * 投影(原复盘问答投影已随 #260 页签退役)——这里是流回放;在场
   * 未作答的平台闸从状态投影为 waiting 卡,Agent 卡(AskUserQuestion)
   * 以 waiting.json 记录为账源(真 waiting_id/真状态,事件出卡会让等待
   * 中的卡多出误标已决的影子、重放还会成倍繁殖)。
   * 只读:坏行跳过、缺账本给空,绝不抛错拖垮页面。 */
  conversation(id: string): IssueConversationView {
    const live = this.require(id);
    const events = readConversationEvents(join(live.root, "events.jsonl"));
    const gate = live.state.gate;
    const firstQuestion = gate?.question.questions[0];
    return issueConversation(events, {
      pendingSteers: [...(live.driver?.pendingSteers() ?? []), ...(live.state.parked_notices ?? [])],
      ...(gate
        ? { waitingCard: {
          waiting_id: gate.id,
          step: live.state.scenario && live.state.stage
            ? fixedStageLabel(live.state.scenario,
              live.state.stage as FixedStage)
            : undefined,
          question: firstQuestion?.question,
          options: firstQuestion?.options.map((option) => option.label),
        } }
        : {}),
      agentCards: live.humanGate.all().map((record) => ({
        waiting_id: record.waiting_id,
        step: record.step,
        created_at: record.created_at,
        question: record.question,
        status: record.status,
      })),
    });
  }

  /** 会话现场定位(收窄票 #7):材料/事件旁路改由路由直连各自模块后,
   * 这里是路由拿到"哪个会话、现场在哪"的唯一入口。未知会话抛
   * IssueNotFoundError——与原先各透传方法里的 require 同一 404 语义。
   * state 是活引用:材料旁路只读(人工修改写口已随 ADR-0028 退役),
   * 路由不写会话状态。 */
  session(id: string): { state: IssueSessionState; root: string } {
    const live = this.require(id);
    return { state: live.state, root: live.root };
  }

  // ---- 视图旁路:耗时与卡点(只读,fail-open);过程文档数据面在 documents.ts ----

  /** 「耗时与卡点」视图:纯函数归纳(见 sessionView.ts),这里只负责
   * 把消息账、状态与在等的问题卡喂给它——面板没有自己的真相。 */
  timeline(id: string): IssueSessionTimeline {
    const live = this.require(id);
    return buildIssueTimeline({
      state: live.state,
      messages: this.messages(id),
      waiting: live.humanGate.pending()[0],
    });
  }

  /** 现场记录导出:事件流逐字 + issue.json 台账 → 单文件 Markdown
   * (人粗读 + 喂 AI 精读复盘,2026-08-28 拍板)。事件流读取容错:
   * 半行/坏行跳过——导出是排障工具,不能自己是第一个炸点。 */
  exportWorksite(id: string): WorksiteRecord {
    const live = this.require(id);
    const path = join(live.root, "events.jsonl");
    const events: SemanticEvent[] = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as SemanticEvent);
        } catch {
          // 写入方可能还在写:宁缺毋炸,坏行跳过。
        }
      }
    }
    return buildWorksiteRecord({ state: live.state, events });
  }

  // ---- 登记 ----

  create(input: IssueCreateInput): IssueSummary {
    const creator = input.account?.trim();
    if (!creator) throw new IssueControlError("缺少登记账号(工号)");
    const baseline = resolveProductBranch(this.options.dataDir, input.productVersion, input.baseline);
    // 登记人=发起登记的登录用户;归属=责任人,显式指派优先,缺席=
    // 自登记(ADR-0031)。同账号+同单号去重、写闸、闸口通知、Git 身份、
    // 介入档位(全局档;会话级特例随会话走,ADR-0057)全部继续挂
    // 归属账号——责任人换了人,机制语义自动跟着换人。
    const reporter = input.reporter?.trim() || creator;
    const account = input.assignee?.trim() || creator;
    // 指派校验只在角色回调在场时生效(缺席=裸构造,测试世界无身份
    // 体系,按缺席即放行的既有纪律);生产接线(serve)恒注入,门恒生效。
    if (input.assignee?.trim() && account !== creator
        && this.options.userRole) {
      const role = this.options.userRole(account);
      if (!role) {
        throw new IssueControlError(
          `责任人 ${account} 不存在或已停用,请回登记页重新选择`);
      }
      if (role === "admin") {
        throw new IssueControlError(
          `责任人不能是管理员账号 ${account}:管理员不写问题会话,`
            + "指派了也没有人能推进,请改选开发责任人");
      }
    }
    const title = input.title?.trim() ?? "";
    // 长度上限已按用户拍板(2026-08-28)去掉:标题只要求必填,长标题
    // 由各消费面(列表卡/通知)自行单行截断;MR 标题遇平台限制再说。
    if (!title) {
      throw new IssueControlError("问题标题必填");
    }
    const ticket = input.ticket?.trim() || undefined;
    if (ticket && !TICKET_PATTERN.test(ticket)) {
      throw new IssueControlError("单号只能是字母数字下划线连字符(如 DTS2026082001317)");
    }
    // 会话级介入档位(ADR-0057):发起前定档,发起后不可改;路由已拦
    // 非法值,这里兜底直调方(测试/内部调用),半截登记不落盘。
    if (input.interventionTier
        && !isIssueInterventionTier(input.interventionTier)) {
      throw new IssueControlError("介入档位不合法(只支持 1/2/3 三档)");
    }
    const explicitRepos = normalizeIssueRepos(input.repoUrl, input.repoUrls);
    // 场景由单号有无机械派生:有单走五阶段,无单走三节点。
    const scenario: IssueScenario = ticket ? "ticket" : "no_ticket";
    // 模块是一等实体:module_id 必须真实存在且在架,名称由模块库派生
    // (前端传来的 module 文本在带 moduleId 时让位,标签不出现两个真相)。
    let moduleName = input.module?.trim() || undefined;
    let moduleRepos: string[] | undefined;
    // 参考组件仓目录快照(ADR-0054):发起时刻按模块订阅解析启用条目,
    // create 定格进 state——会话中途改模块订阅不追溯。登记表不可读
    // 按 fail-open 走(空目录),不挡发起;与知识仓装载同一姿态。
    let moduleReferenceRepos: IssueSessionState["reference_repos"];
    const moduleId = input.moduleId?.trim() || undefined;
    // 登记门禁(无单定位的机械真相):无单号登记必须指名业务模块并带上
    // 网管环境——仓的唯一来源是模块绑定,现场凭据发起时就要齐。
    // 有单号登记(DTS 页签)不拦:单据自带现场线索,
    // 环境可以在会话内经 env_needed 闸现场补。
    if (!ticket && !moduleId) {
      throw new IssueControlError(
        "无单号登记必须指定业务模块:代码仓从模块绑定带出,"
          + "请回登记页选择模块后再发起");
    }
    if (moduleId) {
      try {
        const module = readBusinessModule(this.options.dataDir, moduleId);
        if (module.status !== "active") {
          throw new IssueControlError(
            `业务模块「${module.name}」已归档,不能用于新问题会话`);
        }
        if (!module.repositories.length) {
          throw new IssueControlError(
            `业务模块「${module.name}」还没有绑定代码仓,请先补绑定再发起`);
        }
        moduleName = module.name;
        moduleRepos = module.repositories;
        try {
          const registryRows = componentRepositories(this.options.dataDir);
          moduleReferenceRepos = (module.reference_component_repos ?? [])
            .map((refId) => registryRows.find((row) => row.id === refId))
            .filter((row): row is ComponentRepository =>
              !!row && row.enabled)
            .map((row) => ({
              id: row.id, name: row.name,
              url: row.repository, description: row.description,
            }));
        } catch {
          moduleReferenceRepos = [];
        }
      } catch (error) {
        if (error instanceof IssueControlError) throw error;
        throw new IssueControlError(
          `业务模块 ${moduleId} 不存在或元数据不可读,请刷新模块列表后重试`);
      }
    }
    if (!ticket && !input.environment) {
      throw new IssueControlError(
        "无单号登记必须配置网管环境(地址与网管后台密码)");
    }
    // 模块带仓:只登记模块没给仓时,按模块绑定整表带出(同样过协议
    // 校验与上限)。"选模块→带仓"在服务端同样成立,不是前端专属糖。
    const repoUrls = !explicitRepos.length && moduleRepos?.length
      ? normalizeIssueRepos(undefined, moduleRepos)
      : explicitRepos;
    // 同账号+同单号至多一个进行中的固定流程会话(2026-08-28 批量发起的
    // 配套守卫):双发起 fail-loud 到具体单,而不是静默开出第二条平行
    // 工作流(分支/MR/流水线监看都会打架)。
    if (ticket) {
      const clash = [...this.live.values()].find((item) =>
        item.state.account === account
        && item.state.ticket === ticket
        && !isTerminal(item.state.status));
      if (clash) {
        throw new IssueControlError(
          `该单号已有进行中的问题会话 ${clash.id},同一单号不能重复发起`);
      }
    }
    // 个人凭据前置门禁(2026-08-28 立门;2026-09-08 升格无条件):有单
    // 必经拉仓,无单也可能补仓——不管有没有单、登记时带不带仓,发起前
    // 必须配齐 Git 令牌与署名邮箱。免仓发起曾借"登记期无仓可查"绕过
    // 这道门,用户进了工作台才在拉仓期撞上报错;现在门关在发起按钮上。
    // 拉仓期 requireGitIdentity 仍逐仓复查,双保险各守各的口。
    // ADR-0031:门查的是**责任人**——推代码的是责任人,不是登记人
    // (测试通常没配 Git 凭据);自登记两号同一,文案维持"你"。
    this.requireGitAccount(account, reporter);
    // 四件套校验先行: mkdir/占号之前打回,半截登记不落任何盘。快照
    // (environment_id)与手填都先解析过同一把尺——解析即完成互斥校验
    // 与台账取值,登记烧号之前一切打回。
    const envResolution = input.environment
      ? this.resolveEnvironmentInput(input.environment) : undefined;
    if (envResolution) normalizeEnvironmentInput(envResolution.resolved);

    const id = this.nextId();
    const root = join(this.issuesRoot, id);
    mkdirSync(root, { recursive: true });
    // 现象描述内嵌截图:把 staging 里的图片复制到会话工作区 issue-images/,
    // description 里的相对路径引用原样保留——AI 侧 inspect_image 直接可用。
    // 同步在状态落盘前:失败只跳过(fail-open),不阻断登记。
    const descriptionText = input.description?.trim() ?? "";
    const remarkText = input.remark?.trim() ?? "";
    if (descriptionText || remarkText) {
      // 现象描述内嵌截图:把 staging 里的图片复制到会话工作区 issue-images/,
      // description 里的相对路径引用原样保留——AI 侧 inspect_image 直接可用。
      // 同步在状态落盘前:失败只跳过(fail-open),不阻断登记。
      if (descriptionText) {
        syncIssueImagesToWorkspace({
          description: descriptionText,
          dataDir: this.options.dataDir,
          workspace: root,
          log: (message) => this.log(message),
        });
      }
      // 登记附件(日志等):同一纪律,从 staging 复制到工作区 attachments/。
      // 两源(#502):无单嵌在描述,DTS 发起随单上传的拼在附加信息尾部。
      syncIssueAttachmentsToWorkspace({
        description: descriptionText,
        remark: remarkText,
        dataDir: this.options.dataDir,
        workspace: root,
        log: (message) => this.log(message),
      });
    }
    const environment = envResolution
      ? this.storeEnvironment(id, envResolution.resolved,
        envResolution.sourceIp)
      : undefined;
    const now = new Date().toISOString();
    const firstStage: FixedStage = fixedStages(scenario)[0];
    const state: IssueSessionState = {
      id,
      account,
      reporter,
      created_at: now,
      updated_at: now,
      title,
      description: input.description?.trim() ?? "",
      ...(remarkText ? { remark: remarkText } : {}),
      ...(input.interventionTier
        ? { intervention_tier: input.interventionTier } : {}),
      ...(input.autoClaim ? { auto_claim: true as const } : {}),
      source: input.source ?? "manual",
      ...(ticket ? { ticket } : {}),
      ...(repoUrls.length
        ? { repo_url: repoUrls[0], repo_urls: repoUrls }
        : {}),
      ...(baseline?.trim() ? { baseline: baseline.trim() } : {}),
      ...(input.productVersion ? { product_version: input.productVersion } : {}),
      ...(moduleName ? { module: moduleName } : {}),
      ...(moduleId ? { module_id: moduleId } : {}),
      ...(moduleReferenceRepos?.length
        ? { reference_repos: moduleReferenceRepos } : {}),
      ...(environment ? { environment } : {}),
      scenario,
      round: 1,
      // 首阶段直接 in_progress:登记即入场,等 complete_stage 收口
      // 后由 fixedAdvance 接管后续;全 pending 会让进度条首节点
      // 不亮,当前感无处安放。
      stage_states: initStageStates(scenario, 0)
        .map((entry, index) =>
          index === 0 ? "in_progress" as const : entry),
      status: "queued",
      stage: firstStage,
      stage_note: "已登记,固定流程启动",
      stage_at: now,
    };
    recordTransition(state, {
      source: "platform", stage: firstStage,
      note: `固定流程会话已登记(${scenario === "ticket" ? "有单五阶段" : "无单三节点"})`,
    });
    saveState(root, state);
    this.live.set(id, {
      id, root, state,
      humanGate: new HumanGate(join(root, "waiting.json")),
      controlEpoch: 0,
    });
    this.log(`[issue-flow] ${id} 已登记(${ticket ?? "无单号"},固定流程): ${title}`);
    // 指派通知(ADR-0031):登记人≠责任人时一次性送达——登记完成即
    // 移交,开发责任人由此接到问题。旁路 fail-open:通知失败只留痕,
    // 登记照常成立、流程照走(与等待卡通知同款纪律)。
    if (reporter !== account && this.options.notifier) {
      this.options.notifier.notifyAssignment({
        taskId: id,
        account,
        reporter,
        title,
        link: this.issueLink(id),
      }).catch((error) =>
        this.log(`[issue-flow] ${id} 指派通知失败(旁路,流程照走): `
          + String(error)));
    }
    // 自动接单通知(ADR-0061):发起人是系统,指派通知的"登记人递来"
    // 叙事不成立——换自动接单文案点名来源。同样旁路 fail-open。
    if (input.autoClaim && this.options.notifier) {
      this.options.notifier.notifyAutoClaim({
        taskId: id,
        account,
        title,
        link: this.issueLink(id),
      }).catch((error) =>
        this.log(`[issue-flow] ${id} 自动接单通知失败(旁路,流程照走): `
          + String(error)));
    }
    void this.pump();
    return this.summarize(state);
  }

  /** 只增加已有 MR 的进入方式，后续使用同一问题会话、工具和流水线监看。 */
  async importMr(rawUrl: unknown, account: string): Promise<IssueSummary> {
    if (this.options.purpose !== "pipeline_repair") throw new IssueControlError("请从流水线修复工具发起，不创建问题会话");
    const url = normalizeRepairMrUrl(rawUrl);
    this.requireGitAccount(account);
    if (this.shuttingDown) throw new IssueControlError("执行服务正在关闭，请稍后重试");
    if (!this.options.platformUrl) throw new IssueControlError("尚未配置交付平台，请联系管理员");
    const pending = this.mrImports.get(url);
    if (pending) {
      if (pending.account !== account) throw new IssueControlError("这个 MR 正在由其他成员接入，请稍后查看");
      return pending.promise;
    }
    const promise = (async () => {
      const mr = await this.readMrDetails(url, account);
      if (mr.state !== "opened") throw new IssueControlError("MR 已关闭或合入，不能启动修复");
      if (this.shuttingDown) throw new IssueControlError("执行服务正在关闭，请稍后重试");
      const existing = [...this.live.values()].find(live => !isTerminal(live.state.status)
        && live.state.mrs?.some(row => row.url === mr.url
          || (repositoryIdentity(row.repo) === repositoryIdentity(mr.repo) && row.branch === mr.source_branch)));
      if (existing) {
        if (existing.state.account === account) return this.project(existing);
        throw new IssueControlError("这个 MR 的源分支已有其他成员的进行中会话，请在原会话协作");
      }
      const id = this.nextId(), root = join(this.issuesRoot, id), now = new Date().toISOString();
      mkdirSync(root, { recursive: true });
      const state: IssueSessionState = { id, account, reporter: account, created_at: now, updated_at: now,
        title: mr.title, description: `修复已有 MR ${mr.url} 的流水线失败；仅处理编译、测试和代码质量问题。`,
        source: "manual", scenario: "mr_repair", imported_mr: mr, repo_url: mr.repo, repo_urls: [mr.repo],
        baseline: mr.target_branch, fix_branch: mr.source_branch, round: 1, stage: "mr_green", stage_states: ["in_progress"],
        status: "queued", stage_at: now, stage_note: "先拉取 MR 源分支，再检查流水线失败；前置调查步骤不适用",
        mrs: [{ repo: mr.repo, branch: mr.source_branch, target: mr.target_branch, title: mr.title, url: mr.url, iid: mr.iid, at: now }] };
      recordTransition(state, { source: "platform", stage: "mr_green", note: `接入用户提供的已有 MR ${mr.url}，沿用源分支 ${mr.source_branch}；没有创建 DTS、MR 或推送代码` });
      saveState(root, state);
      const live: LiveIssue = { id, root, state, humanGate: new HumanGate(join(root, "waiting.json")), controlEpoch: 0 };
      this.live.set(id, live);
      void this.pump();
      return this.project(live);
    })();
    this.mrImports.set(url, { account, promise });
    try { return await promise; } finally { if (this.mrImports.get(url)?.promise === promise) this.mrImports.delete(url); }
  }

  private readMrDetails(url: string, account: string) {
    return this.options.mrDetails?.(url, account) ?? readRepairMr({ platformUrl: this.options.platformUrl!, url,
      credential: this.options.gitCredential?.(account) });
  }

  private nextId(): string {
    let max = 0;
    for (const name of readdirSync(this.issuesRoot)) {
      const match = new RegExp(`^${this.idPrefix}(\\d+)$`).exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `${this.idPrefix}${max + 1}`;
  }

  /** 发起即校验 Git 身份(2026-09-08 拍板,从"按仓校验"升格为无条件):
   *  有单必经拉仓(可单结论也可能补仓),克隆与推送都用发起人身份——
   *  没配齐就别进工作台。此前免仓发起(2026-08-28)在登记期无仓可查而
   *  放行,第二道门(拉仓期)才撞,用户已进工作台才见 git 报错,观感即
   *  "内部报错"。gitCredential 回调缺席=裸构造(测试世界无身份体系),
   *  按缺席即放行的既有纪律处理;生产接线(serve)恒在,门恒生效。
   *  ADR-0031:登记人≠责任人时门查的是责任人,文案点名责任人而非
   *  "你"——看到报错的是登记人,他要能把话准确带到。 */
  private requireGitAccount(account: string, reporter?: string): void {
    // 回调缺席=裸构造(测试世界无身份体系),按缺席即放行的既有纪律
    // 处理;生产接线(serve)恒注入回调,门恒生效。
    if (!this.options.gitCredential) return;
    const assigned = reporter !== undefined && reporter !== account;
    const credential = this.options.gitCredential(account);
    if (!credential) {
      throw new IssueControlError(assigned
        ? `责任人 ${account} 的 Git 令牌未配置(个人设置 → 个人接入):`
            + "拉取代码仓、提交与推送都用责任人的身份——请责任人配好令牌,"
            + "或改选已配齐的责任人后再登记"
        : "Git 令牌未配置(个人设置 → 个人接入):拉取代码仓、提交与推送"
            + "都用你的身份——配好令牌后再发起问题会话");
    }
    if (!credential.email) {
      throw new IssueControlError(assigned
        ? `责任人 ${account} 的个人邮箱未配置(个人设置 → 个人接入):`
            + "Git 提交署名与平台归属都按邮箱对人——请责任人配好邮箱,"
            + "或改选已配齐的责任人后再登记"
        : "个人邮箱未配置(个人设置 → 个人接入):Git 提交署名与平台"
            + "归属都按邮箱对人——配好邮箱后再发起问题会话");
    }
  }

  /** 拉仓路径的逐仓复查:碰远端仓才需要身份,file:// 本地仓不拦。 */
  private requireGitIdentity(account: string, repoUrls: string[]): void {
    const remoteRepos = repoUrls.filter((url) => /^https?:\/\//i.test(url));
    if (!remoteRepos.length) return;
    this.requireGitAccount(account);
  }

  /** 台账快照解析(ADR-0020「选入即快照」,票 #150):environment_id
   * 在场时从台账解密取值,产出与手填同形的输入——两个消费端点(登记/
   * env_needed 闸)走同一条 storeEnvironment 落盘路径,秘密纪律只有
   * 一份;值是选定时点的拷贝,台账后续改/删都不影响本会话。与手填字段
   * 互斥(同给打回);root 密码只在台账显式设置(root_password_inherited
   * =false)时把解析值一并带入,继承态不带独立凭据——会话与"只填后台
   * 密码"完全同构。前端永远没有密码:值只在此处(服务端)现解现用。 */
  private resolveEnvironmentInput(
    input: IssueEnvironmentInput,
  ): ResolvedEnvironmentInput {
    if (input.environmentId === undefined) return { resolved: input };
    const mixed = Boolean(input.hosts?.length)
      || Boolean(input.backendPassword?.trim())
      || input.envType !== undefined
      || input.port !== undefined
      || Boolean(input.rootPassword?.trim());
    if (mixed) {
      throw new IssueControlError(
        "台账快照与手工填写互斥:选了环境管理里的环境,就不要再填"
          + "地址、端口、形态或密码");
    }
    const entry = this.environmentRegistry.get(input.environmentId)
      ?? undefined;
    const secrets = entry
      ? this.environmentRegistry.secrets(input.environmentId) : undefined;
    if (!entry || !secrets) {
      throw new IssueControlError(
        `环境台账条目不存在或已被删除(${input.environmentId}),请刷新后重选`);
    }
    return {
      resolved: {
        hosts: [entry.ip],
        port: entry.port,
        envType: entry.form,
        backendPassword: secrets.backendPassword,
        // 显式 root 才一并快照(ADR-0020);继承态不落独立凭据。
        ...(entry.root_password_inherited
          ? {} : { rootPassword: secrets.rootPassword }),
      },
      sourceIp: entry.ip,
    };
  }

  /** 网管环境落盘的唯一路径:凭据只进 vault(AES-GCM 按会话隔离的
   * 加密文件),issue.json/公开 API/事件只有引用；随后
   * environmentCredentials 会按 ADR-0003 解密到当前问题的 AI 上下文。
   * 后台凭据(both)供日志抓取(技能 fetch-logs)/build_deploy 消费,独立
   * root 凭据(root,显式存在时)供 get_issue_meta 元信息出口,各组
   * 自成行、可分别解出。登记与 env_needed 闸作答共用本路径,秘密
   * 纪律只有一份。sourceIp 在场=本次配置来自台账快照,会话状态记下
   * 选定时点的台账主 IP(非密来源展示)。 */
  private storeEnvironment(
    id: string,
    input: IssueEnvironmentInput,
    sourceIp?: string,
  ): IssueEnvironmentConfig {
    const parts = normalizeEnvironmentInput(input);
    const rows = [
      backendVaultRow(parts.name, parts.hosts[0], parts.port,
        parts.backendPassword),
      ...(parts.rootPassword
        ? [rootVaultRow(parts.name, parts.hosts[0], parts.port,
          parts.rootPassword)]
        : []),
    ];
    const refs = this.vault.store(id, rows);
    // 凭据组按 purpose 定位:root 组缺席时后续位置会前移,
    // 位置序号不可靠,名字才是身份。
    const refByPurpose = (purpose: string) =>
      refs.find((ref) => ref.purpose === purpose)?.id ?? "";
    return {
      credential_ref: refByPurpose("both"),
      name: parts.name,
      hosts: parts.hosts,
      port: parts.port,
      ...(parts.rootPassword
        ? { root_credential_ref: refByPurpose("root") }
        : {}),
      ...(parts.envType ? { env_type: parts.envType } : {}),
      ...(sourceIp ? { environment_source_ip: sourceIp } : {}),
    };
  }

  /** 登记元信息的网管凭据明文(ADR-0003:网管口令允许进 AI 上下文):
   * 开场词/续聊词的渲染与 get_issue_meta 工具共用同一解密路。
   * 当前台账只保存后台 operator 与可选 root 凭据，不再采集网管页面账号；
   * 老数据若在同一凭据组里还有其他账号，只在与 backend 不同时以 page 兼容带入。 */
  private environmentCredentials(live: LiveIssue): IssueEnvCredentials {
    const env = live.state.environment;
    if (!env) return {};
    const backend = env.credential_ref
      ? this.vault.credential(live.id, env.credential_ref, "operator")?.password
      : undefined;
    // 独立 root 凭据只在显式存在时解出(继承后台密码的会话没有这一组,
    // 元信息出口自然不带——缺席即缺省)。
    const root = env.root_credential_ref
      ? this.vault.credential(live.id, env.root_credential_ref, "root")
        ?.password
      : undefined;
    // 老凭据组的兼容口：无用户名时取 accounts[0]。新台账组里只有
    // operator，解出的与 backend 相同，按同值去重后不会伪造 page 凭据。
    const page = this.vault.credential(live.id, env.credential_ref)?.password;
    return {
      ...(backend ? { backend } : {}),
      ...(page && page !== backend ? { page } : {}),
      ...(root ? { root } : {}),
    };
  }

  /** 对话选环境(票 #574,spec #571):用户在对话中明确给出环境 IP
   * 时,AI 经 select_environment 工具按台账主 IP 精确匹配,唯一命中即
   * 挂载。挂载复用 attachEnvironment 同一条路径(快照解密进 vault、
   * 覆盖允许、env_needed 卡清除、拒绝台账解锢、平台回合通知重试),
   * 本方法只多做「按 IP 找台账条目」与回执事实行——回执只有事实,
   * 密码永不进模型可见面(get_issue_meta 的明文例外是 ADR-0003 的事,
   * 这条路不沾)。台账以主 IP 为唯一键,findByIp 至多命中一条,没有
   * 多命中歧义分支可言。终态守卫与 C-H3 同口径:补配会开平台回合,
   * 不能把已收口的会话复活成 running。 */
  selectEnvironmentByIp(id: string, ip: string): string {
    const live = this.require(id);
    const { state } = live;
    if (isTerminal(state.status)) {
      throw new IssueControlError(
        `会话已处于终态 ${state.status},不能补配环境`);
    }
    const entry = this.environmentRegistry.findByIp(ip);
    if (!entry) {
      throw new IssueControlError(
        `环境管理里没有主 IP 为 ${ip} 的环境记录——请如实转告用户到`
        + "「环境管理」补录后再选,不要猜测或手造环境信息");
    }
    // 事实行先采后挂:attachEnvironment 会改现场(覆盖/清卡/解锢)。
    const replaced = Boolean(state.environment);
    const unblocked = state.gate?.kind === "env_needed";
    const ungated = Boolean(state.env_declined);
    this.attachEnvironment(id, { environmentId: entry.id });
    const lines = [
      `网管环境已挂载:${entry.ip}`
      + (entry.port ? `:${entry.port}` : "")
      + `,形态${ENV_TYPE_LABELS[entry.form]}(环境管理台账快照)`
      + "——按技能 fetch-logs 直接抓取即可",
    ];
    if (replaced) lines.push("已覆盖会话原有环境(登记时的选择被替换)");
    if (unblocked) {
      lines.push("挂着的网管环境配置卡已解除——平台已通知你重试刚才的操作");
    }
    if (ungated) {
      lines.push("此前的环境拒绝记录已整册清除(解锢):同 scope 工具"
        + "恢复举卡路径");
    }
    return lines.join("\n");
  }

  /** 网管环境配置(问题卡 env_needed 闸的作答口,POST
   * /issues/:id/environment):登记时没配环境,拉日志/换库的工具现场
   * 举闸后,用户在这里补地址与网管后台密码。密码进 vault 后即清闸并开
   * 平台回合,让 Agent 重试刚才的操作。快照语义(票 #150,ADR-0020):
   * input.environmentId 在场即从台账解密取值(服务端快照,前端零密码),
   * 与手填同一条落盘路径。options.saveToRegistry:手填作答顺带沉淀——
   * 把这次手填用 contributeEnvironmentByIp 幂等存进团队台账(创建者/
   * 更新人=作答人,即会话归属人),合并不覆盖台账已显式配置的密码;
   * 沉淀在环境落盘之前做,校验失败整体打回,不留半截现场。 */
  attachEnvironment(
    id: string,
    input: IssueEnvironmentInput,
    options?: { saveToRegistry?: boolean },
  ): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    // 状态守卫(体检 C-H3):终态会话不接受补配环境——补配会开平台
    // 回合,把已收口的会话悄悄复活成 running。
    if (isTerminal(state.status)) {
      throw new IssueControlError(`会话已处于终态 ${state.status},不能补配环境`);
    }
    const { resolved, sourceIp } = this.resolveEnvironmentInput(input);
    if (options?.saveToRegistry) {
      const parts = normalizeEnvironmentInput(resolved);
      if (!parts.envType) {
        throw new IssueControlError(
          "存入环境管理需要先选定环境形态(虚拟化或容器化)");
      }
      contributeEnvironmentByIp(this.environmentRegistry, {
        ip: parts.hosts[0],
        port: parts.port,
        form: parts.envType,
        backendPassword: parts.backendPassword,
        ...(parts.rootPassword ? { rootPassword: parts.rootPassword } : {}),
      }, state.account);
    }
    const environment = this.storeEnvironment(id, resolved, sourceIp);
    state.environment = environment;
    // 解锢(票 93):配置成功即整册清除拒绝台账——用户对环境的新裁定
    // 覆盖旧裁定,日志抓取(技能 fetch-logs)/build_deploy 恢复正常举闸路径。
    delete state.env_declined;
    if (state.gate?.kind === "env_needed") {
      // 闸清在 issue.json(与 answer() 的闸裁决同一纪律)。清闸后
      // waiting_user 的理由消失,状态回落 idle,由平台回合接管。
      delete state.gate;
      if (state.status === "waiting_user") state.status = "idle";
    }
    recordTransition(state, {
      source: "platform",
      note: `网管环境已配置(${environment.hosts.join(", ")})`
        + (environment.env_type
          ? `,形态${ENV_TYPE_LABELS[environment.env_type]}`
          : ""),
    });
    saveState(live.root, state);
    this.log(`[issue-flow] ${id} 网管环境已配置(${environment.name})`);
    this.startPlatformTurn(live, promptCopy("notices", "env.configured"));
    return this.summarize(state);
  }

  /** 网管环境拒绝(问题卡 env_needed 闸的拒绝口,POST
   * /issues/:id/environment 的 decline 分支,票 93):拉日志/换库举闸
   * 后,用户认定这一动作不需要网管环境——按闸上的 scope 记入拒绝台账
   * (硬拒绝:同 scope 工具再调不再举闸,防纠缠),清闸回落 idle,
   * 开平台回合通知 AI 基于现有证据继续。配置环境成功即整册清除
   * (解锢,见 attachEnvironment)。闸不在场如实打回:没有卡就无所谓
   * 拒绝。理由是人的原话,只随通知与转移账转给 AI,永不代答环境闸。 */
  declineEnvironment(id: string, input?: { note?: string }): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    if (state.gate?.kind !== "env_needed") {
      throw new IssueControlError("当前没有网管环境配置卡在等作答,无需拒绝");
    }
    const scope = state.gate.scope ?? "logs";
    const note = input?.note?.trim();
    state.env_declined = {
      scopes: [...new Set([...(state.env_declined?.scopes ?? []), scope])],
      at: new Date().toISOString(),
    };
    // 闸清在 issue.json(与 attachEnvironment 的清闸同一纪律)。拒绝后
    // waiting_user 的理由消失,状态回落 idle,由平台回合接管。
    delete state.gate;
    if (state.status === "waiting_user") state.status = "idle";
    recordTransition(state, {
      source: "platform",
      note: `网管环境配置被用户拒绝(无需${ENV_SCOPE_LABELS[scope]})`
        + (note ? `:${note}` : ",未说明理由"),
    });
    saveState(live.root, state);
    this.log(`[issue-flow] ${id} 网管环境配置被用户拒绝(${scope})`);
    this.startPlatformTurn(live, promptCopy("notices", "env.refused", {
      scope: ENV_SCOPE_LABELS[scope],
      note: note ? `\n用户理由: ${note}` : "",
    }));
    return this.summarize(state);
  }

  /** 会话仓清单的用户调整口(#241,POST /issues/:id/repos):端点只做
   * 校验+留痕+发送通知,不改 repo_urls——清单是 Agent 执行的产出
   * (新增=pull_repo 幂等入列,移除=#240 remove_repo 摘除),平台不代执。
   * 门禁分层:这里只核静态事实(HTTPS 格式/在册与否/模块绑定;查法与
   * remove_repo 门禁①同款),远端分支检查在工具执行时现查。校验全过才
   * 留痕,任何打回零副作用。发送通道与 attachEnvironment 同一咽喉:
   * startPlatformTurn(忙=steer 送达,等人/终态=park 便签随续聊带上,
   * 空闲=开续聊回合)。 */
  requestRepoChanges(id: string, input: {
    add?: string[];
    remove?: string[];
  }): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    // 终态守卫(与 reply 同款):archived/canceled/failed 不可续聊,发送
    // 只会写成永不送达的死信——如实打回。页面侧编辑器本就被终态闸隐藏,
    // 这里防的是直接调 API 的路径。
    if (state.status === "archived" || state.status === "canceled"
      || state.status === "failed") {
      throw new IssueControlError(
        "该问题单已结束(终态),不能再调整仓清单");
    }
    if (state.status === "queued") {
      throw new IssueControlError(
        "首轮研究还在排队启动,请稍候再调整仓清单");
    }
    const clean = (values?: string[]): string[] =>
      (values ?? [])
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
    const adds = clean(input.add);
    const removes = clean(input.remove);
    if (!adds.length && !removes.length) {
      throw new IssueControlError(
        "没有要调整的仓:新增与移除至少填一边"
          + "(新增给代码仓地址,移除从当前清单里选)");
    }
    // 新增链①:https 限定(浏览器用户手输口径)。validateRepoUrl 还放行
    // file:// 与本地路径——那是 Agent 工具(pull_repo)的口径,页面入口
    // 在它之前先行限定,免得本地路径从页面溜进会话清单。
    for (const url of adds) {
      if (!/^https:\/\//i.test(url)) {
        throw new IssueControlError(
          `「${url}」不是 https:// 代码仓地址:页面指派只收 HTTPS 仓库地址`);
      }
    }
    // 新增链②:协议校验兜底 → ③组内去重(归一比对:同批里 `…/a.git`
    // 与 `…/a` 是同一仓,精确串比较会漏判;顺序即语义,不重排)。
    const freshAdds: string[] = [];
    for (const url of adds) {
      const validated = validateRepoUrl(url);
      if (!freshAdds.some((item) =>
        repositoryIdentity(item) === repositoryIdentity(validated))) {
        freshAdds.push(validated);
      }
    }
    const current = state.repo_urls ?? [];
    // 归一尺与模块绑定门禁(#240)同一把:尾斜杠/.git/大小写差不另立仓。
    const inCurrent = (url: string): string | undefined =>
      current.find((item) =>
        repositoryIdentity(item) === repositoryIdentity(url));
    // 新增链④:不得与当前清单重复(重复新增=误操作,如实打回)。
    for (const url of freshAdds) {
      const hit = inCurrent(url);
      if (hit) {
        throw new IssueControlError(
          `「${url}」已在会话仓清单里(${hit}),不用重复新增`);
      }
    }
  // 数量上限已废除(ADR-0054):不再做合并计数校验。
  // 移除链①:必须在册(归一比对,命中登记原文)→ 组内去重。
    const removed: string[] = [];
    for (const url of removes) {
      const hit = inCurrent(url);
      if (!hit) {
        throw new IssueControlError(
          `「${url}」不在当前会话仓清单里,无从移除(当前清单:`
            + `${current.length ? current.join(", ") : "空"})`);
      }
      if (!removed.includes(hit)) removed.push(hit);
    }
    // 移除链②:非模块绑定仓(readBusinessModule 查法与 remove_repo
    // 门禁①同款:模块查不到/已删除按无绑定处理,不挡移除)。
    if (state.module_id && removed.length) {
      let bound: BusinessModule | undefined;
      try {
        bound = readBusinessModule(this.options.dataDir, state.module_id);
      } catch {
        bound = undefined;
      }
      for (const url of removed) {
        const isBound = bound?.repositories.some((repo) =>
          repositoryIdentity(repo) === repositoryIdentity(url));
        if (isBound) {
          throw new IssueControlError(
            `「${url}」是业务模块「${bound!.name}」的绑定仓,`
              + "模块绑定仓不可移除——如该仓确与本问题无关,"
              + "请先在「团队资产 → 业务模块」调整模块绑定");
        }
      }
    }
    // 校验全过才留痕(转移账 + 事件账双记),清单一字不动——repo_urls
    // 由 Agent 经 pull_repo/remove_repo 执行后变化,这里是"用户的裁定",
    // 不是清单本身。新增方向顺带记指派意图(ADR-0054):Agent 调
    // pull_repo 落地时凭它走平等仓登记路径并摘参考仓台账行(指派升级)。
    if (freshAdds.length) {
      state.repo_assign_pending = [
        ...(state.repo_assign_pending ?? []), ...freshAdds];
      // 指派史永久留痕:展示层区分「运行中经人指派」与登记自带仓。
      const assigned = state.assigned_repos ?? [];
      for (const url of freshAdds) {
        if (!assigned.some((item) =>
          repositoryIdentity(item) === repositoryIdentity(url))) {
          assigned.push(url);
        }
      }
      state.assigned_repos = assigned;
    }
    const summary = [
      ...(freshAdds.length ? [`新增 ${freshAdds.join("、")}`] : []),
      ...(removed.length ? [`移除 ${removed.join("、")}`] : []),
    ].join(";");
    recordTransition(state, {
      source: "platform",
      note: `用户调整会话仓清单(${summary})——清单随 Agent 执行 `
        + "pull_repo/remove_repo 变化,端点不直改",
    });
    saveState(live.root, state);
    this.appendSessionEvent(live, "user_message", {
      text: `调整会话代码仓(${summary})`,
      via: "repos",
    });
    this.log(`[issue-flow] ${id} 用户调整仓清单(${summary})`);
    // 通知按 diff 拼段:空方向不出空段(锚点/文件缺失在首次取用处
    // fail-loud,文案是协议)。
    // 段文先 trim:md 锚点段以 header 后的空行打头,park 便签只取首行
    // ——不 trim 就把空行当首行,落成一张空便签。
    const sections: string[] = [];
    if (freshAdds.length) {
      sections.push(promptCopy("notices", "repos.changed.add",
        { repos: freshAdds.join("、") }).trim());
    }
    if (removed.length) {
      sections.push(promptCopy("notices", "repos.changed.remove",
        { repos: removed.join("、") }).trim());
    }
    this.startPlatformTurn(live, sections.join("\n\n"));
    return this.summarize(state);
  }

  /** 主动拉取日志的意图递交口(#268,POST /issues/:id/logs/fetch;
   * Agent 主理第二例,ADR-0026):按钮不执行任何事,端点只守卫+留痕+
   * 经平台回合通道发送通知词——拉取由 Agent 按技能 fetch-logs 执行,
   * 缺环境走既有环境闸(request_env 举卡→回填→自动续拉),平台不代拉。
   * 无重复拉取门禁:排队语义下连点只是重复意图,通知词一句"已拉取过
   * 先向用户确认"兜住;无独立"已拉取"状态位,页面判定用材料清单。
   * 发送通道与 requestRepoChanges 同一咽喉:startPlatformTurn(忙=
   * steer 送达,等人/终态=park 便签随续聊带上,空闲=开续聊回合)。 */
  requestLogFetch(id: string): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    // 终态守卫(与调整仓清单同款):终态不可续聊,发送只会写成永不
    // 送达的死信。页面侧按钮本就被终态闸隐藏,这里防的是直调 API。
    if (state.status === "archived" || state.status === "canceled"
      || state.status === "failed") {
      throw new IssueControlError(
        "该问题单已结束(终态),不能再请求拉取日志");
    }
    if (state.status === "queued") {
      throw new IssueControlError(
        "首轮研究还在排队启动,请稍候再请求拉取日志");
    }
    recordTransition(state, {
      source: "platform",
      note: "用户请求拉取网管日志——拉取由 Agent 按技能 fetch-logs 执行,"
        + "端点不代拉",
    });
    saveState(live.root, state);
    this.appendSessionEvent(live, "user_message", {
      text: "请求拉取网管日志",
      via: "logs",
    });
    this.log(`[issue-flow] ${id} 用户请求拉取日志`);
    // 段文先 trim:park 便签只取首行,不 trim 就把锚点段的空行当首行。
    this.startPlatformTurn(live, promptCopy("notices", "logs.fetch").trim());
    return this.summarize(state);
  }

  // ---- 会话驱动 ----

  /** 回合启动单点(收窄票 #7):新回合的共有不变量只有这一份——
   * turning 互斥占位、status=running、催办预算清零(预算永不跨回合
   * 传染)、落盘、调度 runTurn、finally 收口+再泵。各入口(登记启动/
   * 作答/闸门裁决/续聊/平台通知)只保留差异部分:开场词、续聊词、
   * 作答重放。入口冲突判守(409 打回/挂便签/排队跳过)留在调用点:
   * 出路语义各不相同,收进来反而要改行为。settle 里的催办/补发续跑
   * 走 beginContinuationTurn——同一回合的延续,预算不清,turning 由
   * 代币接棒跨回合持有(2026-09-09,issue-20 复盘)。 */
  private beginTurn(live: LiveIssue, body: () => Promise<Outcome>): void {
    if (this.shuttingDown) return;
    const epoch = live.controlEpoch;
    const token = ++this.turnSeq;
    live.turnToken = token;
    // 回合关联 id(ADR-0053):token 跨重启归零,拼时间戳保唯一;
    // canonical 行与回合内投递账共享此 id。
    live.auditTurnId = `t-${token}-${Date.now().toString(36)}`;
    this.turning.add(live.id);
    live.state.status = "running";
    live.state.nudges = 0;
    // 举卡即收口的回合标记(票 #573):新回合清零;存量 skill_select
    // 圈选闸在场时置位——封存闸按「在场」跨回合拦的旧语义,收编进
    // 本标记的种子(其余五种卡绝不按在场跨回合拦)。
    live.cardRaisedInTurn = live.state.gate?.kind === "skill_select";
    saveState(live.root, live.state);
    void this.runTurn(live, body, epoch).finally(() =>
      this.endTurnSlot(live, token));
  }

  /** 回合槽位收口:代币仍在本棒手里才释放 turning 并再泵;延续回合
   *  已接棒(号易主)就让位。互斥位与并发额度因此横跨整条延续链——
   *  过去外层收口把占位提前删掉,催办期间忙时守卫全盲,平台通知撞进
   *  忙会话反把整单标 failed(issue-20 实锤)。 */
  private endTurnSlot(live: LiveIssue, token: number): void {
    if (live.turnToken !== token) return;
    // canonical 行(ADR-0053):每回合收口必发,成败都发——Agent 考古
    // 第一入口,先读汇总拿关联 id 再下钻明细账。
    sessionAudit(live.root, live.id, "canonical", {
      kind: "canonical.turn",
      msg: `回合收口(${live.state.stage} 阶段,${live.state.status})`,
      turn_id: live.auditTurnId,
      stage: live.state.stage,
      status: live.state.status,
      round: live.state.round ?? 1,
      nudges: live.state.nudges ?? 0,
    });
    this.turning.delete(live.id);
    // 举卡即收口的回合标记(票 #573):回合槽位收口即清零——卡跨回合
    // 挂起是常态(env_verify 可能等很久),下一回合(#350 分诊送达/
    // 返工/作答续跑)平台工具必须照常可用。延续回合不走这里(代币
    // 已接棒让位),标记随延续链传递,与催办续跑的「同一回合」语义
    // 一致。
    live.cardRaisedInTurn = false;
    void this.pump();
  }

  /** settle 里的催办/补发续跑入口:同一回合的延续——不重置催办预算、
   *  不改 status(调用方已置 running 并落盘),但必须接棒 turning 占位,
   *  让 startPlatformTurn/answer/control 的忙时守卫看得见它。 */
  private beginContinuationTurn(
    live: LiveIssue,
    body: () => Promise<Outcome>,
  ): void {
    const epoch = live.controlEpoch;
    const token = ++this.turnSeq;
    live.turnToken = token;
    live.auditTurnId = `t-${token}-${Date.now().toString(36)}`;
    this.turning.add(live.id);
    void this.runTurn(live, body, epoch).finally(() =>
      this.endTurnSlot(live, token));
  }

  /** 续聊形态的回合入口:现场(driver)在场就把话递进去;进程重启后
   * 重建会话,以续聊提示词把话交给重建的上下文。用户主动续聊与平台
   * 通知共用;重启自动续跑(#27)是同一回合体的另一条启动路径,走
   * 泵(见 pump),不在这里——它必须排队等并发额度。 */
  private continueTurn(
    live: LiveIssue,
    message: string,
  ): void {
    // 投递账 started(ADR-0053):continueTurn 是所有开回合的公共咽喉
    // (startPlatformTurn 的直通分支与闸挂起时的插话直调都汇到这),
    // 记账放这里才不漏 submitReviews/replyToReview 的直调路径。
    sessionAudit(live.root, live.id, "delivery", {
      kind: "delivery.turn",
      msg: `平台消息投递:开新回合——${message.slice(0, 160)}`,
      decision: "started", why: "空闲且无闸挡,开回合投递",
      turn_id: live.auditTurnId,
      stage: live.state.stage, status: live.state.status,
    });
    this.beginTurn(live, () => this.resumeTurnBody(live, message));
  }

  /** 分支传输在途互斥的单例口(ADR-0074 票 3):懒建挂 LiveIssue,
   *  driver 重建换上下文也取同一把——回合开始探针与 push_branch/
   *  sync_branch 三者互斥才成立。 */
  private branchTransferOf(live: LiveIssue): BranchTransferMutex {
    return live.branchTransfer ??= createBranchTransferMutex();
  }

  /** 宿主合并以宿主身份写文件,交回容器前修属主(ADR-0071 同一纪律);
   *  非隔离部署零开销。工具上下文与回合开始吸收共用一份——回合开始
   *  吸收先于 driver 重建跑,不能经 toolContext 取。 */
  private repairOwnershipFor(live: LiveIssue): (dir: string) => void {
    return (dir) => repairContainerCloneOwnership({
      workspace: live.root,
      dir,
      user: this.options.isolation?.user,
      runtime: this.options.ownershipRuntime,
    });
  }

  /** 续聊/续跑共用的回合体:话递给在场 driver,或重建后以续聊提示词
   *  开回合(issueResumePrompt 带登记元信息与最近阶段,上下文不流失)。 */
  private async resumeTurnBody(
    live: LiveIssue,
    message: string,
  ): Promise<Outcome> {
    await this.ensureContainer(live);
    // 预热补跑(#358):被打断/基建失败的预热收据不算终局,analyze
    // 期间主 Agent 只读,续聊回合容器就绪即补跑(startBaselineWarmup
    // 自身守卫幂等,fail-open);过了 analyze 不补——修复期编译的是
    // 脏树,会把半成品的编译错扣到基线头上。重启续跑与用户消息同享
    // 这条自愈路:阶段单向,没有别的时机再进 analyze。
    if (live.state.stage === "analyze") this.startBaselineWarmup(live);
    // 回合开工前的外部提交吸收(ADR-0074 票 3):探针比对远端修复分支
    // 头与本会话最后一笔推送收据,远端前进(用户把手改推回)即合并进
    // 工作区再开工——AI 醒来见到的就是含手改的最新代码。远端没动零
    // fetch/merge;首轮(分支未定名)、无收据的仓、传输在途、探针失败
    // 一律放行(探针经济,守门在 absorbExternalAtTurnStart);撞冲突/
    // 非严格后代只还原现场交通知词,回合照常开工。入口自身绝不抛错,
    // 这里再兜一层——吸收绝不拦回合是硬契约。
    const absorbNotice = await absorbExternalAtTurnStart({
      state: live.state,
      workspace: live.root,
      dataRoot: this.options.dataDir,
      gitCredential: () => this.options.gitCredential?.(live.state.account),
      persist: () => saveState(live.root, live.state),
      repairOwnership: this.repairOwnershipFor(live),
      branchTransfer: this.branchTransferOf(live),
      log: (note) => this.log(`[issue-flow] ${live.id} ${note}`),
    }).catch((error) => {
      this.log(`[issue-flow] ${live.id} 回合开始外部提交吸收失败`
        + `(跳过,照常开工): ${String(error)}`);
      return "";
    });
    // 欠账便签随行(#244 发送必达):任何续聊形态的回合都把停靠通知
    // 捎给模型——落到便签的通知不能停在显示摘要里没人看见。
    return this.withParkedNotices(live, async (replay) => {
      const full = [message, absorbNotice, replay].filter(Boolean)
        .join("\n\n");
      if (live.driver) {
        return live.driver.continueWith(full);
      }
      const driver = await this.openDriver(live);
      return driver.startResume(issueResumePrompt(live.state, full,
        this.environmentCredentials(live), this.resumePromptOptions(live)));
    });
  }

  /** 续聊提示词的公共选项(两处 startResume 同源):档位/工作区/屏蔽
   *  清单,外加分析报告指针(ADR-0055)——报告在场才带,重启与异常
   *  重跑的降级开局都直接知道方案要点在哪,不必从头重找。 */
  private resumePromptOptions(live: LiveIssue): IssueResumeOptions {
    return {
      tier: this.tierOf(live),
      workspace: live.root,
      blockedPaths: readResourceBlocks(this.options.dataDir),
      ...(existsSync(join(live.root, ANALYSIS_REPORT_FILENAME))
        ? { report: this.analysisReportPointer(live) }
        : {}),
    };
  }

  /** 分析报告指针(边界路共用):落盘路径 + 「修改方案」章节要点。
   *  读不出(不应发生:submit_analysis 以报告在场为门票)降级为
   *  "先重读整份报告"的提醒——指针永远非空,通知词与锚点不留空洞。 */
  private analysisReportPointer(live: LiveIssue): {
    path: string;
    plan: string;
  } {
    const path = join(live.root, ANALYSIS_REPORT_FILENAME);
    try {
      const plan = analysisSectionOf(readFileSync(path, "utf-8"), "修改方案");
      return {
        path,
        plan: plan || "(报告缺「修改方案」章节,进 fix 后先重读整份报告)",
      };
    } catch {
      return { path, plan: "(此刻读不出,进 fix 后先重读整份报告)" };
    }
  }

  /** 并发额度:同时进行的回合数(等待用户/闲置/终态的会话不占额度)。
   *  现读现判:管理页「问题单并发数」旋钮(issue_max_turns)每次开泵
   *  都读,改完即生效;缺席退回部署旗 --issue-max-turns,再退缺省 10。 */
  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    const budget = this.options.settings?.runtime?.().issue_max_turns
      ?? this.options.maxConcurrentTurns ?? 10;
    for (const live of this.live.values()) {
      if (this.turning.size >= budget) break;
      if (live.state.status !== "queued" || this.turning.has(live.id)) continue;
      // 重启续跑与首轮开跑共用同一份额度:带待递话的(恢复路径重新
      // 入队的)走续聊回合体,开场是平台通知;纯排队的是登记首轮,
      // 仍走开场词。待递话消费即清,再泵不重放。
      const resumeMessage = live.resumeMessage;
      live.resumeMessage = undefined;
      this.beginTurn(live, async () => {
        if (resumeMessage) return this.resumeTurnBody(live, resumeMessage);
        // 知识仓开工前置(#286,ADR-0033):平台拉完才把会话交给 Agent
        // ——首轮回合体里、开场词组装之前克隆到位,确定性归平台不走
        // pull_repo(自报推进下"仓拉没拉齐"归 AI 裁量,知识仓不在其列;
        // 与货架 skill 快照、业务知识定格同属知识装载线)。重启续跑不
        // 重拉:首轮已定局;存量会话无此账=未配置时代,不追溯。
        await this.ensureKnowledgeRepo(live);
        // 2026-08-28 拍板:克隆不再是回合前的自动动作——登记的仓由
        // Agent 在「拉取代码仓」阶段调 pull_repo 逐个落地(开场词有令)。
        const driver = await this.openDriver(live);
        return this.withParkedNotices(live, replay => driver.start([
          issueFixedOpeningPrompt(live.state, this.environmentCredentials(live),
            { tier: this.tierOf(live), blockedPaths: readResourceBlocks(this.options.dataDir) }),
          replay,
        ].filter(Boolean).join("\n\n")));
      });
    }
  }

  /** 知识仓开工前置装载(#286,ADR-0033):配置中心管理员指定的全局
   * 领域知识仓,在开场词组装前克隆到 repo/<仓名>/(平铺同场)。只读
   * 参考件:URL 不进 repo_urls——交付、diff、修复分支全部因"不在关联
   * 仓台账"天然拒绝(仓名派生与撞名判定与关联仓同源 repoNameOf);
   * 推送加固由 cloneRepository 内置。fail-open:克隆失败、仓名撞名、
   * 配置损坏都记 skipped 留痕后照走,定位不因知识缺席停摆;会话内
   * 定局不重试,改配置从下一个会话生效(开工时点快照)。 */
  private async ensureKnowledgeRepo(live: LiveIssue): Promise<void> {
    const { state } = live;
    if (state.knowledge_repo) return;
    let configured: { url: string } | undefined;
    try {
      configured = readKnowledgeRepoConfig(this.options.dataDir);
    } catch (error) {
      this.log(`[issue-flow] ${live.id} 知识仓配置不可用,按未配置走: `
        + String(error));
      return;
    }
    if (!configured) return;
    const url = configured.url;
    const name = repoNameOf(url);
    const skip = async (note: string) => {
      state.knowledge_repo = {
        url, name, status: "skipped", note,
        at: new Date().toISOString(),
      };
      recordTransition(state, {
        source: "platform", stage: state.stage,
        note: `知识仓未装载: ${note}`,
      });
      saveState(live.root, state);
    };
    const taken = new Set(issueRepoWorkspaces(state, live.root)
      .map((repo) => repo.dir.split(/[\\/]/).at(-1) ?? ""));
    // 参考仓(ADR-0054)的名字同样占用:知识仓不与参考仓名相撞。
    (state.public_repos ?? []).forEach((row) => taken.add(row.name));
    if (taken.has(name)) return skip(`仓名 ${name} 与关联仓撞名`);
    const target = join(live.root, "repo", name);
    try {
      this.log(`[issue-flow] ${live.id} 知识仓装载: ${url}`);
      await cloneRepository({
        dataDir: this.options.dataDir,
        targetDir: target,
        repoUrl: url,
        credential: this.options.gitCredential?.(state.account),
      });
      // 克隆在容器起来之前落盘;属主修正如 pull_repo 收口(幂等,属主
      // 已对时零写入),容器内只读读取不受属主问题干扰。
      repairContainerCloneOwnership({
        workspace: live.root,
        dir: target,
        user: this.options.isolation?.user,
        runtime: this.options.ownershipRuntime,
      });
      state.knowledge_repo = {
        url, name, status: "ready", at: new Date().toISOString(),
      };
      recordTransition(state, {
        source: "platform", stage: state.stage,
        note: `知识仓已装载(只读参考): repo/${name}/`,
      });
      saveState(live.root, state);
    } catch (error) {
      this.log(`[issue-flow] ${live.id} 知识仓装载失败(跳过,流程照走): `
        + String(error));
      return skip(`克隆失败: ${String(error).slice(0, 200)}`);
    }
  }

  /** 拉仓(pull_repo 工具的宿主实现;2026-08-28 拍板:克隆是 Agent 的
   * 显式动作,平台只代劳凭据与机械步骤)。登记合并 → 带凭据克隆到
   * repo/<仓名>/ →(有单场景)切好修复分支。回执只含事实;基线分支
   * 在远端缺失即硬失败(ADR-0038):退回默认分支会把修复悄悄送上
   * 错误的版本线,如实抛错让 Agent 上报、停在拉仓阶段。 */
  private async pullRepoFor(
    live: LiveIssue,
    rawUrl: string,
  ): Promise<{
    dir: string; cloned: boolean; branch?: string;
    head: string;
    reference?: boolean;
  }> {
    const { state } = live;
    const url = validateRepoUrl(rawUrl);
    if (state.imported_mr && repositoryIdentity(url) !== repositoryIdentity(state.imported_mr.repo)) {
      throw new IssueControlError("本次只修复已接入 MR 的源仓库，不能增加其他交付仓");
    }
    this.requireGitIdentity(state.account, [url]);
    // 身份裁决(ADR-0054,resolvePullRoute 纯函数):指派意图 > 登记
    // 表命中 > 平等登记。指派升级:摘掉参考仓台账行走平等仓登记路径
    // ——「改共享资产」由用户指派背书,身份随人的意志升级,不随 AI
    // 的重复拉取升级。模块绑定仓(登记侧既定关系)也算已知:发起时
    // 显式给了仓清单的边缘场景下绑定仓不在 repo_urls,不该被登记表
    // 卷成参考仓。命中只查一次,裁决与参考仓路径共用。
    const registryHit = this.referenceRegistryHit(url);
    const route = resolvePullRoute(state, url, registryHit !== undefined,
      this.moduleBoundRepos(state));
    if (route === "assigned") {
      const identity = repositoryIdentity(url);
      state.repo_assign_pending = (state.repo_assign_pending ?? [])
        .filter((item) => repositoryIdentity(item) !== identity);
      state.public_repos = (state.public_repos ?? []).filter((row) =>
        repositoryIdentity(row.url) !== identity);
    } else if (route === "reference") {
      return this.pullReferenceRepo(live, url, registryHit!);
    }
    // 登记合并:与登记/模块绑定同一把尺。
    const merged = normalizeIssueRepos(undefined,
      [...(state.repo_urls ?? []), url]);
    state.repo_urls = merged;
    state.repo_url ??= merged[0];
    const repo = issueRepoWorkspaces(state, live.root)
      .find((item) => item.url === url)!;
    // 有单场景:修复分支统一由宿主切好(分支名烧着单号,不交给起名)。
    // 命名先行(ADR-0063):分支名在克隆之前解出——基线缺席在克隆前就
    // 打回,不留停在默认分支上的半截克隆。拉仓路是定名唯一的持久化点:
    // 首次解出即显式写 state.fix_branch 并保存(生成即持久化),时间戳
    // 是首次建分支时刻,中断重试不重算,同会话所有仓全程同名。
    let branch: string | undefined;
    if (state.imported_mr) branch = state.imported_mr.source_branch;
    if (state.scenario === "ticket" && state.ticket) {
      const known = state.fix_branch;
      branch = resolveFixBranch(state);
      if (!known) {
        state.fix_branch = branch;
        saveState(live.root, state);
      }
    }
    const cloned = !existsSync(join(repo.dir, ".git"));
    if (cloned) {
      this.log(`[issue-flow] ${live.id} 拉仓: ${url}`);
      const common = {
        dataDir: this.options.dataDir,
        targetDir: repo.dir,
        repoUrl: url,
        credential: this.options.gitCredential?.(state.account),
      };
      try {
        await cloneRepository({
          ...common,
          ...((state.imported_mr?.source_branch ?? state.baseline)
            ? { baseline: state.imported_mr?.source_branch ?? state.baseline } : {}),
        });
      } catch (error) {
        if (state.imported_mr) throw new IssueControlError(`无法拉取 MR 源分支 ${state.imported_mr.source_branch}，请核对分支和仓库权限：${String(error).slice(0, 200)}`);
        if (!state.baseline) throw error;
        // 基线分支缺失是硬失败(ADR-0038):不退默认分支继续。
        throw new Error(
          `基线分支 ${state.baseline} 在远端不存在(或不可取),拉仓失败:`
          + `请到配置中心核对版本→分支映射,修正后重新拉取。原始错误: `
          + String(error).slice(0, 200));
      }
    }
    if (this.options.isolation && isMaeRepository(url)) {
      await this.prepareMaeBuild(live);
      repairContainerCloneOwnership({ workspace: live.root, dir: join(live.root, "repo"),
        user: this.options.isolation.user, runtime: this.options.ownershipRuntime });
      if (live.container?.isAlive) await live.container.exec(MAE_CONTAINER_BOOTSTRAP, live.root,
        { onData: () => {}, timeout: 30 });
    }
    if (branch) {
      await ensureBranch({
        dataDir: this.options.dataDir,
        repoDir: repo.dir,
        branch,
      });
    }
    excludeCodecheckArtifacts(repo.dir);
    if (cloned) await rememberCodecheckBase(join(live.root, "codecheck"), repo.dir);
    const head = await currentHead(repo.dir);
    // 克隆与切分支都以宿主身份落盘,而容器已经在跑:不把整棵仓交回容器
    // 用户,容器内 git add/commit 就是 Permission denied。收口必须压在
    // 全部宿主 git 写之后(切分支的 checkout 会重写 .git 内部,提前
    // chown 会被原样污染回去),也只能在这里无条件做而不按 cloned 门——
    // 存量 root 仓在下次拉取时顺带修好,幂等 walk 对属主已对的 inode
    // 零写入;非 root 部署守卫直接 false,零开销。
    repairContainerCloneOwnership({
      workspace: live.root,
      dir: repo.dir,
      user: this.options.isolation?.user,
      runtime: this.options.ownershipRuntime,
    });
    if (state.imported_mr) this.armPipelineWatch(live, state.imported_mr.repo);
    return {
      dir: relative(live.root, repo.dir) || repo.dir,
      cloned,
      ...(branch ? { branch } : {}),
      head,
    };
  }

  /** 公共组件仓目录命中查询(ADR-0054):组件仓库表的启用行按地址
   * 归一比对。登记表读不出来(缺文件/坏 JSON)按未配置走,不挡平等
   * 仓路径——目录是增强项,不是拉仓的前置闸。 */
  private referenceRegistryHit(url: string): ComponentRepository | undefined {
    let rows: ComponentRepository[];
    try {
      rows = componentRepositories(this.options.dataDir);
    } catch {
      return undefined;
    }
    const identity = repositoryIdentity(url);
    return rows.find((row) => row.enabled
      && repositoryIdentity(row.repository) === identity);
  }

  /** 模块绑定仓清单(登记侧既定关系,身份裁决的 extraKnown):模块
   * 读不到/没绑定按空走,fail-open 不挡拉仓。 */
  private moduleBoundRepos(state: IssueSessionState): string[] {
    if (!state.module_id) return [];
    try {
      return readBusinessModule(this.options.dataDir, state.module_id)
        .repositories;
    } catch {
      return [];
    }
  }

  /** 参考仓拉取(ADR-0054):命中目录的地址落只读参考件。照常平铺
   * repo/<仓名>/ 可研读,但不进登记清单——交付工具的定位映射只认
   * 登记清单,参考仓在结构上推不了、交不了(知识仓同款机理)。与
   * 版本线无关的共享资产:不走基线克隆、不建修复分支、不做 Mae 构建
   * 准备。幂等:台账已在场的仓按原仓名回报,不重记不重克隆。 */
  private async pullReferenceRepo(
    live: LiveIssue,
    url: string,
    hit: ComponentRepository,
  ): Promise<{
    dir: string; cloned: boolean; head: string; reference: boolean;
  }> {
    const { state } = live;
    const identity = repositoryIdentity(url);
    const existing = (state.public_repos ?? []).find((row) =>
      repositoryIdentity(row.url) === identity);
    const base = repoNameOf(url);
    const name = existing?.name ?? (() => {
      const taken = new Set<string>([
        ...issueRepoWorkspaces(state, live.root)
          .map((repo) => repo.dir.split(/[\\/]/).at(-1) ?? ""),
        ...(state.public_repos ?? []).map((row) => row.name),
      ]);
      let candidate = base;
      let serial = 2;
      while (taken.has(candidate)) candidate = `${base}-${serial++}`;
      return candidate;
    })();
    const dir = join(live.root, "repo", name);
    const cloned = !existsSync(join(dir, ".git"));
    if (cloned) {
      this.log(`[issue-flow] ${live.id} 参考仓拉取: ${url}`
        + `(${hit.name})`);
      await cloneRepository({
        dataDir: this.options.dataDir,
        targetDir: dir,
        repoUrl: url,
        credential: this.options.gitCredential?.(state.account),
      });
    }
    // 克隆以宿主身份落盘,收口修属主(与 pull_repo 同款;幂等 walk 对
    // 属主已对的 inode 零写入)。
    repairContainerCloneOwnership({
      workspace: live.root,
      dir,
      user: this.options.isolation?.user,
      runtime: this.options.ownershipRuntime,
    });
    const head = await currentHead(dir);
    if (!existing) {
      state.public_repos = [...(state.public_repos ?? []),
        { url, name, at: new Date().toISOString() }];
    }
    return {
      dir: relative(live.root, dir) || dir,
      cloned,
      head,
      reference: true,
    };
  }

  /** 单回合执行骨架:统一失败收口,绝不把异常闷成悬挂状态。
   *
   *  容器生命周期(2026-09-01 拍板,对齐需求流"随任务起、随收口停"):
   *  回合收口**不停容器**——容器随会话存活到终态,回合间隙(idle/
   *  waiting_user)保持原实例,续聊/作答直接复用,消掉两件事:跨回合
   *  "容器已停止"的重建开销与失败面;催办/补发插话同回合接力时
   *  "收口停"与续跑 ensureContainer 的重建竞态。容器自身故障有自愈
   *  闭环:exec 超时/中止由 TaskContainer 销毁自身,外部死亡(OOM)被
   *  exec 前的 assertRunning 探活标 failed——下回合 ensureContainer
   *  检 isAlive 重建。真正的停点只在终态:取消/归档(control)、结论
   *  闭环归档、服务关停。 */
  private async runTurn(
    live: LiveIssue,
    body: () => Promise<Outcome>,
    epoch: number,
  ): Promise<void> {
    try {
      const outcome = await body();
      if (live.controlEpoch !== epoch) return;
      this.settle(live, outcome);
    } catch (error) {
      if (live.controlEpoch !== epoch) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (live.state.gate) {
        // 举闸异常:gate 在场说明是 raiseEnvNeededGate 抛的,
        // 容器必须保留(用户配好环境后 AI 要重试)。
        live.state.status = "waiting_user";
        live.state.last_reply = live.driver?.finalReply() ?? live.state.last_reply;
      } else {
        // 人工接管让路(2026-09-07 走查拍板):接管方已把状态定格 idle,
        // abort 引爆的回合异常不标 failed、不 releaseDriver——现场还
        // 要给交还后的续聊用。
        if (live.state.takeover) {
          saveState(live.root, live.state);
          return;
        }
        if (error instanceof IssueInfraError) {
          // 基础设施瞬断(票 #159):Docker 抖动时间可恢复,容器下回合
          // 本就会按 isAlive 重建——落 idle 交还人工,发「继续」即续推;
          // 现场保留(不 releaseDriver),配置类错误才落 failed。
          live.state.status = "idle";
          live.state.stage_note =
            "基础设施暂不可用(容器未能启动)——稍后发送「继续」即可重试";
          this.log(`[issue-flow] ${live.id} 容器基础设施瞬断,停机待恢复`
            + `(不标失败): ${detail}`);
        } else {
          live.state.status = "failed";
          live.state.error = detail;
          this.releaseDriver(live);
        }
      }
      saveState(live.root, live.state);
      if (live.state.status === "failed") {
        this.freezeMetricsSnapshot(live);
      }
      this.log(`[issue-flow] ${live.id} 回合失败: ${detail}`);
    }
  }

  private settle(live: LiveIssue, outcome: Outcome): void {
    const { state } = live;
    // 人工接管让路(2026-09-07 走查拍板):abort 捏死的回合仍会带着
    // outcome 走到收尾处理——接管方已定格 idle 与 stage_note,这里不再
    // 覆写(不催办、不置 waiting_user、不 releaseDriver),只如实落盘。
    if (state.takeover) {
      saveState(live.root, state);
      return;
    }
    if (state.mr_repair_closing && outcome.status === "turn_finished") {
      // 修绿总结轮落定(ADR-0073):修复会话的终点就是修绿,总结即归档
      // ——打通终态卫生尾巴,现场不再永驻。总结轮若转等人(AI 提问),
      // 旗子保留:用户的回答仍是收口对话的一部分,下一个落定的回合照常
      // 收口。阶段若已被重开(返工),旗子作废,等下次收口再举。
      if (state.scenario === "mr_repair" && this.mrGreenClosed(state)) {
        this.archiveMrRepair(live);
        return;
      }
      delete state.mr_repair_closing;
    }
    if (outcome.status === "waiting_for_human") {
      state.status = "waiting_user";
    } else if (outcome.status === "turn_finished") {
      // 平台闸在场:回合定格等用户,闸比一切优先(补发插话让位——
      // 闸挂起时 steer 本就进不来)。
      if (state.gate) {
        state.status = "waiting_user";
        state.last_reply = live.driver?.finalReply() ?? state.last_reply;
      } else {
        // 撞在回合间隙的插话可能没送进模型——收口前补发一次。
        const driver = live.driver;
        const late = driver?.takeUndeliveredSteers() ?? [];
        if (driver && (late.length || state.parked_notices?.length)) {
          this.log(`[issue-flow] ${live.id} 补发未送达插话 ${late.length} 条`);
          live.state.status = "running";
          saveState(live.root, live.state);
          // 现场引用收进闭包:settle 到延续体之间没有空档,driver 不可能
          // 易主;若真被停(取消/关停),abort 会让它如实失败交 epoch 守卫。
          this.beginContinuationTurn(live, () =>
            this.withParkedNotices(live, replay =>
              driver.continueWith([...late, replay].filter(Boolean).join("\n\n"))));
          return;
        }
        // 催办续跑(2026-08-28 拍板 A):模型提前收嘴不等于阶段完成,
        // 阶段真相在平台——没走到出口就把阶段简报砸回去推它继续,
        // 预算内自动续跑,耗尽才落 idle 交还人工。需求流同款机制的移植。
        // driver 缺席(现场刚被停)时催办无从谈起,直接落 idle:
        // 过去这里靠 ! 断言硬闯,releaseDriver 后就是 undefined 崩溃
        // (issue-20 实锤)。
        if (driver && shouldNudgeFixed(state)) {
          state.nudges = (state.nudges ?? 0) + 1;
          const nudge = state.nudges;
          if (nudge <= NUDGE_BUDGET) {
            this.log(`[issue-flow] ${live.id} 模型提前收嘴,`
              + `第 ${nudge}/${NUDGE_BUDGET} 次催办续跑(阶段 ${state.stage})`);
            state.status = "running";
            saveState(live.root, live.state);
            this.beginContinuationTurn(live, async () => {
              await this.ensureContainer(live);
              // ensureContainer 的空档里现场可能被停/清(取消、关停),
              // 如实放弃本拍催办:交给 epoch 守卫或 idle 收口,不拿
              // 断言硬闯(issue-20 的崩溃点就在这一行)。
              const liveDriver = live.driver;
              if (!liveDriver) return { status: "turn_finished" };
              return liveDriver.continueWith(
                fixedNudgeNotice(state, nudge, NUDGE_BUDGET));
            });
            return;
          }
          state.status = "idle";
          state.stage_note = `模型连续 ${NUDGE_BUDGET} 次提前收嘴,已停机`
            + "——发送「继续」或补充指示,平台才会再推进";
          state.last_reply = driver.finalReply() ?? state.last_reply;
          this.log(`[issue-flow] ${live.id} 催办预算耗尽,转人工(阶段 ${state.stage})`);
        } else {
          if (!driver && shouldNudgeFixed(state)) {
            this.log(`[issue-flow] ${live.id} 想催办但现场已不在,直接交还人工`);
          }
          state.status = "idle";
          state.last_reply = driver?.finalReply() ?? state.last_reply;
        }
      }
    } else {
      const detail = outcome.detail ?? outcome.reason ?? "会话异常结束";
      if (outcome.status === "session_ended"
          && looksLikeBusyCollision(detail)) {
        // 忙撞(issue-20 复盘):消息没递进忙会话,但会话现场毫发无伤。
        // 标 failed + 释放 driver 会把一条健康会话陪葬——留话待补投。
        state.status = "idle";
        state.stage_note =
          "平台消息与进行中的回合相撞,未能送达——发送「继续」即可补投";
        this.log(`[issue-flow] ${live.id} 消息撞上忙会话被拒,`
          + `留话待补投(不标失败): ${detail}`);
      } else if (outcome.status === "session_ended"
          && looksLikeOutputTruncation(detail)) {
        // 输出超限兜底(issue-12 复盘):driver 已纠偏重试两次仍超限。
        // 截断的工具没执行≠任务失败——代码修复、分析、证据都还在,
        // 模型甚至已用纯文本把阻塞说清了。落 idle 交还人工,发「继续」
        // 即可再推进;标 failed 是把健康会话逼进只能取消的死胡同。
        state.status = "idle";
        state.stage_note = "模型连续输出超限,已停机——发送「继续」并要求"
          + "精简输出(正文短、选项只留关键词、内容多就拆多次调用),"
          + "平台会再推进";
        state.last_reply = live.driver?.finalReply() ?? state.last_reply;
        this.log(`[issue-flow] ${live.id} 输出超限纠偏穷尽,转人工(不标失败)`);
      } else if (outcome.status === "session_ended"
          && looksLikeRateLimited(detail)) {
        // 限流/额度(2026-09-10,票 #159 首批):时间可恢复的模型侧失败。
        // 过去落 failed——问题流的 failed 只有取消一条出路,文案还让人
        // 「点重跑续推」,那个按钮问题流根本没有。落 idle:额度恢复后
        // 发「继续」即原地续推。
        state.status = "idle";
        state.stage_note = detail.split("\n")[0].slice(0, 100)
          + "——额度恢复后发送「继续」,平台会原地续推";
        state.last_reply = live.driver?.finalReply() ?? state.last_reply;
        this.log(`[issue-flow] ${live.id} 模型限流/额度,停机待恢复(不标失败)`);
      } else if (outcome.status === "session_ended"
          && looksLikeAuthFailure(detail)) {
        // 认证失败(401 家族,2026-09-22):上游网关偶发拒绝有效密钥,
        // 驱动层退避重试已穷尽。与限流同尺——时间可恢复的模型侧失败
        // 不判死:落 idle 交还人工,现场保留(不 releaseDriver),会话
        // 上下文不丢;上游恢复后发「继续」原地续推,不必整单重来。
        // 持续 401 多为密钥真的失效,文案指向核对配置而不怂恿盲试。
        state.status = "idle";
        state.stage_note = "模型网关认证失败(401),自动重试后仍被拒——"
          + "稍后发送「继续」即可原地续推;若反复出现,请核对配置中心的"
          + "模型网关密钥";
        state.last_reply = live.driver?.finalReply() ?? state.last_reply;
        this.log(`[issue-flow] ${live.id} 模型网关认证失败,`
          + "停机待恢复(不标失败)");
      } else {
        state.status = "failed";
        state.error = detail;
        this.releaseDriver(live);
      }
    }
    saveState(live.root, live.state);
    if (state.status === "failed") {
      this.freezeMetricsSnapshot(live);
    }
    // AI 要人拍板才通知(对齐需求侧公共能力);idle/终态是
    // 结论后的动作与正常交还,不催人。
    if (state.status === "waiting_user") {
      // 代答在即的卡不发可行动卡通知(判据与代答同尺,见 willAutoAnswer)
      // ——告知义务由代答自带的「已代答」收口通知承担;真人闸、开放题
      // 卡、三档对齐照常通知。
      if (!this.willAutoAnswer(live)) this.notifyWaitingCard(live);
      this.maybeAutoAnswerGate(live);
      // 闸缺席才轮到 Agent 卡(闸优先,两路互斥不重复作答)。
      this.maybeAutoAnswerAgentCard(live);
    }
    if (isTerminal(state.status)) this.releaseDriver(live);
  }

  /** 等待卡 → 小鲁班(需求侧 notifyWaiting 的同款公共能力)。两条纪律:
   * - 旁路 fail-open:发送失败只记日志,回合状态一字不动;
   * - 幂等靠 notifier 按 waiting_id 去重,恢复重放不重复轰炸。
   * 闸卡与 Agent 卡并存时闸优先——与作答分派(answer)同一优先级;
   * 通知里只给人话文案:决策码是页面作答协议,发给用户只会把人看懵。 */
  private notifyWaitingCard(live: LiveIssue): void {
    const { notifier } = this.options;
    if (!notifier) return;
    const { state } = live;
    const gate = state.gate;
    const record = gate ? undefined : live.humanGate.pending()[0];
    if (!gate && !record) return;
    const questions: NotifyQuestion[] = gate
      ? gate.question.questions.map((item) => ({
          question: item.question,
          options: item.options.map((option) => option.label),
        }))
      : agentCardQuestions(record!).map((item) => ({
          question: String(item.question ?? ""),
          options: (item.options ?? []).map(String),
        }));
    notifier.notifyWaiting({
      waitingId: gate ? gate.id : record!.waiting_id,
      stateVersion: gate ? gate.state_version : record!.state_version,
      taskId: live.id,
      subject: this.issueSubject(live),
      account: state.account,
      step: state.stage_note || state.stage,
      context: gate ? gate.context : record?.context,
      questions,
      summary: "问题处理需要你决策",
      link: this.issueLink(live.id),
    }).catch((error) =>
      this.log(`[issue-flow] ${live.id} 等待卡通知失败(旁路,流程照走): `
        + String(error)));
  }

  /** 介入档位现读现判(ADR-0019):会话开/续聊/闸判定都读当下值,
   * 用户改档即刻生效;回调缺席=缺省二档。会话级覆盖(ADR-0057)
   * 优先——发起前按单定档的会话终身用它,不吃全局改档。 */
  private tierOf(live: LiveIssue): IssueInterventionTier {
    return live.state.intervention_tier
      ?? this.options.interventionTier?.(live.state.account) ?? "2";
  }

  /** 自动节奏(提示词少问/不简报、纯选项问答卡按推荐整卡代答):
   * 一/二档自动,三档「优先对齐」不自动。 */
  private autoModeOn(live: LiveIssue): boolean {
    return this.tierOf(live) !== "3";
  }

  /** 一档「全自动」专属:确认类闸(analysis_confirm 全量/conclude
   * 高置信非问题)由系统代答;二档的停靠点恰是这些闸,永不代答。 */
  private fullAutoOn(live: LiveIssue): boolean {
    return this.tierOf(live) === "1";
  }

  /** 从这次 HTTP 请求学内网入口(--public-url 缺席时通知深链的唯一
   *  完整地址来源;与需求侧 TaskService.observeLinkBase 同款纪律):
   *  回环地址永不入账——它只对本机成立,发给别人就是死链;管理员在
   *  服务器本机或经 SSH 隧道登录一次,不该把全体人的通知地址带沟里,
   *  学过的可用地址也不许被回环访问冲掉。解析不了的地址不入账。 */
  observeLinkBase(base: string | undefined): void {
    if (this.options.linkBase || !base) return;
    try {
      const host = new URL(base).hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1"
          || host === "::1" || host === "[::1]") {
        return;
      }
    } catch {
      return;
    }
    this.observedLinkBase = base.replace(/\/+$/, "");
  }

  private notificationLinkBase(): string | undefined {
    return this.options.linkBase ?? this.observedLinkBase;
  }

  /** 会话工作台深链(等待卡/代答的小鲁班通知共用;尾部斜杠归一)。
   *  linkBase 缺席时回落从请求 Host 学到的入口,不再只剩路径后缀。 */
  private issueLink(issueId: string): string {
    return `${(this.notificationLinkBase() ?? "").replace(/\/+$/, "")}`
      + `/${this.options.purpose === "pipeline_repair" ? "pipeline-repairs" : "issues"}/${encodeURIComponent(issueId)}`;
  }

  /** skill 圈选入口闸(ADR-0011):complete_stage 推进进 analyze 时由
   * 工具层调用。现读现判五条件:固定流程 + 注册表声明本阶段有入口闸
   * + 自动节奏关 + 台账未圈选过 + 盘上无其他闸;再扫描已拉仓的
   * `.cac/skills/` 与 `.agents/skills/`(.cac 同名优先,见扫描处),
   * 非空才真举。同名跳过/扫描为空都留一行转移账(现场可查),不举卡
   * ——浪费用户一次点击的卡不是好卡。返回是否举了(工具回执据此叫
   * Agent 停回合)。 */
  /** skill 圈选闸已封存(ADR-0014,2026-09-03):skill 是渐进式发现
   * ——编排技能先列 .cac/skills 索引(name+description)再按相关性读
   * 正文;描述没命中是维护者该修的描述,不拿运行时人工圈选来补。
   * 本方法降级为 analyze 入口的扫描留痕:发现清单/同名告警进转移账,
   **永不举卡、永不写 skill_selection 台账**。旧台账的必读清单照旧
   * 注入简报(挂起退役后不再有存量圈选卡可作答,ADR-0048)。 */
  private raiseSkillSelectionGate(live: LiveIssue): boolean {
    const { state } = live;
    if (state.stage !== "analyze") return false;
    if (state.skill_selection) return false;
    if (state.gate) return false;
    const { choices: skills, warnings } = this.scanBusinessSkills(live);
    // 跨目录同名跳过必须留痕(2026-09-03 拍板,不静默):转移账一行
    // + 平台日志,团队得能从现场账查到".agents 里那个为什么没上清单"。
    if (warnings.length) {
      recordTransition(state, {
        source: "platform",
        note: `skill 扫描告警:${warnings.join(";")}`,
      });
      for (const warning of warnings) {
        this.log(`[issue-flow] ${live.id} skill 扫描告警: ${warning}`);
      }
    }
    if (!skills.length) {
      recordTransition(state, {
        source: "platform",
        note: "进入问题分析:已拉仓内未发现业务 skill"
          + "(.cac/skills、.agents/skills),AI 按取用次序自主定位",
      });
      return false;
    }
    // 封存后的入口动作只留痕:AI 靠编排技能的索引纪律自主发现,
    // 扫描账让现场可查"当时仓里有哪些 skill 可用"。
    recordTransition(state, {
      source: "platform",
      note: `进入问题分析:扫描到 ${skills.length} 个业务 skill(`
        + `${skills.map((skill) => skill.name).join("、")}),`
        + "AI 按取用次序自主取用(渐进式发现,ADR-0014)",
    });
    return false;
    this.log(`[issue-flow] ${live.id} 举 skill 圈选闸:`
      + ` ${skills.map((skill) => skill.name).join("、")}`);
    return true;
  }

  /** 扫描已拉仓工作区里的业务 skill(ADR-0011):repo/<仓名>/ 下的
   * `.cac/skills/` 与 `.agents/skills/`(2026-09-03 拍板扩为两根,
   * pi/.claude 不进问题流;2026-09-04 起支持分类层——递归发现直接含
   * SKILL.md 的目录,深度封顶 8,不进技能包内再找技能)。
   * 固定优先级 **`.cac` 优先**(存量团队行为不变),`.agents` 补位:
   * 同仓内跨目录同名(以 SKILL.md 所在目录名为准)时 `.cac` 版本胜出,
   * 另一个版本跳过并出告警(warnings,由调用方留痕,不静默)。
   * 本地文件系统扫描,零新增网络路径——仓已落地,这就是 Agent 视角的
   * 同一份事实(需求侧走网络发现是因为下单时仓还没 clone,威胁模型
   * 不同)。 */
  private scanBusinessSkills(
    live: LiveIssue,
  ): { choices: IssueSkillChoice[]; warnings: string[] } {
    const choices: IssueSkillChoice[] = [];
    const warnings: string[] = [];
    for (const repo of issueRepoWorkspaces(live.state, live.root)) {
      const claimed = new Set<string>();
      for (const root of SKILL_SCAN_ROOTS) {
        const skillsRoot = join(repo.dir, root.dir);
        for (const skillDir of discoverBusinessSkillDirs(skillsRoot)) {
          const name = basename(skillDir);
          const skillFile = join(skillDir, "SKILL.md");
          if (resourceBlocked(relative(repo.dir, skillFile), readResourceBlocks(this.options.dataDir))) continue;
          if (claimed.has(name)) {
            warnings.push(`技能 ${name} 在 ${root.label}`
              + ` 有同名定义,按 .cac 优先已跳过`
              + `(${SKILL_SCAN_ROOTS[0].label} 版本生效;仓 ${repo.url})`);
            continue;
          }
          claimed.add(name);
          choices.push({
            path: relative(live.root, skillFile).split("\\").join("/"),
            repo: repo.url,
            name,
            description: skillDescription(skillFile),
          });
        }
      }
    }
    return { choices, warnings };
  }

  /** 业务知识资产定格(ADR-0012):进入 analyze 时按**当时**的绑定
   * 模块从发布库选取并只读投影(.mae-flow-work/business-modules/),
   * 清单落台账——重启/续聊按台账渲染地图,版本不随发布库中途更新
   * 漂移(与需求侧"按任务固定版本"同一纪律)。与 skill 圈选闸同一
   * 扫描点但**不分介入档**:它不举卡、不等人,自动档照常定格。
   * 没绑模块=静默缺席;模块库故障 fail-open(知识旁路不能卡会话),
   * 留一行转移账。返回是否定格到了资产。 */
  private freezeBusinessKnowledge(live: LiveIssue): boolean {
    const { state } = live;
    if (!state.scenario) return false;
    if (state.stage !== "analyze") return false;
    if (state.business_knowledge) return false;
    const repositories = state.repo_urls?.length
      ? [...state.repo_urls]
      : state.repo_url ? [state.repo_url] : [];
    try {
      const selected = snapshotBusinessModules({
        dataDir: this.options.dataDir,
        taskWorkspace: live.root,
        moduleIds: state.module_id ? [state.module_id] : [],
        repositories,
      });
      const materialized = materializeBusinessModuleKnowledge({
        selected,
        taskWorkspace: live.root,
        runtimeWorkspace: live.root,
      });
      const entries: IssueBusinessKnowledgeEntry[] = materialized.entries
        .map(({ path: _path, ...rest }) => rest);
      state.business_knowledge = {
        at: new Date().toISOString(),
        entries,
      };
      if (entries.length) {
        recordTransition(state, {
          source: "platform",
          note: `进入问题分析:业务知识资产已定格(${entries.length} 项,`
            + `绑定模块 ${selected.map((module) => module.name).join("、")})`,
        });
      }
      for (const warning of materialized.warnings) {
        this.log(`[issue-flow] ${live.id} 业务知识投影告警: ${warning}`);
      }
      return entries.length > 0;
    } catch (error) {
      recordTransition(state, {
        source: "platform",
        note: `业务知识资产定格失败(旁路,不挡分析): ${
          error instanceof Error ? error.message : String(error)}`,
      });
      this.log(`[issue-flow] ${live.id} 业务知识定格失败: `
        + String(error instanceof Error ? error.message : error));
      return false;
    }
  }

  /** 介入档位的闸代答(ADR-0006 口径,ADR-0019 收进一档「全自动」):
   * 只代答"确认类"闸——analysis_confirm 全量(推荐码表定死 confirm);
   * conclude 仅提案 non_issue 且自报高置信(闭环无下游闸,分级保守)。
   * env_needed/env_verify 问的是用户的事实(环境配置/验证结果),
   * 任何档位都等人,永不代答;pipeline_unfixable/pipeline_evidence
   * 问的是"人是否已在交付平台处理/豁免"与"报错原文"——都是只有人
   * 拿得到的人工事实(票 03),任何档位永不代答。
   * 作答 defer 到回合收口(turning 释放)之后,走 answer() 同一裁决
   * 通道——现场账、通知、续跑与真人作答同款,事后可经现有回退推翻。 */
  /** 这张等待卡会不会被介入档位代答(settle 通知守卫,与代答同拍):
   * 会代答就不发可行动卡通知——通知先飞、代答紧随(settle 固定顺序),
   * 用户拿到“请 /mfc 回复”的消息时卡已被平台自己答掉,/mfc 一查空,
   * 比没有通知更误导(用户实锤:问题分析流程收卡即空)。判据与
   * maybeAutoAnswerGate/AgentCard 逐条同尺:闸=一档+确认类(检视回合
   * 除外);Agent 卡=一/二档+纯选项全带推荐。只在卡落地的 settle
   * 时刻判定一次,与代答“不追溯存量卡”同一口径。 */
  private willAutoAnswer(live: LiveIssue): boolean {
    const { state } = live;
    if (state.review_active === true) return false;
    if (state.gate) {
      if (!this.fullAutoOn(live)) return false;
      const gate = state.gate;
      if (gate.kind === "analysis_confirm") return true;
      return gate.kind === "conclude"
        && gate.proposal?.conclusion === "non_issue"
        && gate.proposal?.confidence === "high";
    }
    if (!this.autoModeOn(live)) return false;
    const record = live.humanGate.pending()[0];
    if (!record) return false;
    const questions = agentCardQuestions(record);
    if (!questions.length) return false;
    return questions.every((item) => {
      const options = item.options ?? [];
      if (!options.length) return false;
      return recommendedIndex(item.options, item.recommended) >= 0;
    });
  }

  /** 档位代答的公共尾:卡落地时回合还没收口(turning 未释放),此刻
   * answer() 必拒(状态尚未定格 waiting_user);setTimeout(0) 在慢环境
   * 下抢不过收口路径(CI 实锤:代答被拒→旁路弃答→回合不按"落卡即
   * 收口"停住,剧本被烧穿)。轮询等回合收口再落,预算内不成则
   * fail-open 卡留待人——宁等人,不硬答。 */
  private deferAutoAnswer(issueId: string, run: () => void): void {
    setTimeout(() => {
      const attempt = (left: number): void => {
        if (this.turning.has(issueId)) {
          if (left <= 0) {
            this.log(`[issue-flow] ${issueId} 档位自动作答放弃(回合未按期收口,卡留待人)`);
            return;
          }
          setTimeout(() => attempt(left - 1), 25);
          return;
        }
        try {
          run();
        } catch (error) {
          this.log(`[issue-flow] ${issueId} 档位自动作答失败(旁路,卡留待人): `
            + String(error instanceof Error ? error.message : error));
        }
      };
      attempt(80);
    }, 0);
  }

  private maybeAutoAnswerGate(live: LiveIssue): void {
    const { state } = live;
    const gate = state.gate;
    if (!gate) return;
    // skill_select 永不代答(ADR-0011;闸本身已被 ADR-0014 封存):
    // 这里显式守卫,防任何档位把已挂起的圈选卡追溯代答掉。
    if (gate.kind === "skill_select") return;
    // 环境验证闸永不代答(2026-09-10 A 方案拍板):验证结果只有用户
    // 知道,代答"通过"等于替用户宣布修好了——与流水线人工闸同款
    // 纪律,任何介入档位都只等真人。
    if (gate.kind === "env_verify") return;
    // 流水线人工闸永不代答(票 03):不可修卡问的是"人处理/豁免了没"
    // ——答"已处理"就是人工事实声明,机器代答等于替人声明平台侧
    // 已处理;证据回灌卡的报错原文只有人粘贴得出来。两类都放在档位
    // 判定之前,任何介入档位都只等真人。
    if (gate.kind === "pipeline_unfixable") return;
    if (gate.kind === "pipeline_evidence") return;
    // 一档「全自动」才代答确认类闸(ADR-0019);二档的停靠点恰是
    // 这张卡——分析结论等人检视,永不代答。
    if (!this.fullAutoOn(live)) return;
    // 检视回合的确认卡永不代答(ADR-0007):用户提了意见、agent 按意见
    // 修订重提,这张卡就是"意见是否被吸收"的复核点——代答放行等于
    // 检视闭环被架空。普通流程(无检视回合)不受影响。
    if (state.review_active === true) return;
    let code: string | undefined;
    if (gate.kind === "analysis_confirm") code = "confirm";
    else if (gate.kind === "conclude"
        && gate.proposal?.conclusion === "non_issue"
        && gate.proposal?.confidence === "high") code = "non_issue";
    if (!code) return;
    const issueId = live.id;
    const version = gate.state_version;
    const kind = gate.kind;
    this.log(`[issue-flow] ${issueId} 介入档位免审批:闸 ${kind} 自动作答(${code})`);
    this.deferAutoAnswer(issueId, () => {
      this.answer(issueId, {
        state_version: version,
        code,
        decision: `介入档位免审批自动确认(${gateOptionLabel(kind, code)})`,
      });
      void this.options.notifier?.notifyOutcome({
        taskId: issueId,
        account: state.account,
        // 独立状态词(体检 B-H4):summary.status 在两路代答里都是
        // running,共用幂等键会把第二次代答的通知吞掉。
        status: "已代答",
        summary: `介入档位免审批:分析结论已自动确认(${gateOptionLabel(kind, code)})`,
        link: this.issueLink(issueId),
      }).catch(() => undefined);
    });
  }

  /** 介入档位免审批的 Agent 卡代答(ADR-0006 口径从平台闸扩至问答卡,
   * ADR-0019 收进一/二档的自动节奏):
   * Agent 自举的 AskUserQuestion 卡,卡上每题都是选项题且都带
   * recommended(ADR-0004 的「AI 推荐」——校验层保证选项题必带、
   * trim 后逐字命中)时,按推荐项的决策码整卡代答。整卡纪律:含
   * 开放题、recommended 缺失/不命中(历史卡防身,新卡进不来)一律
   * 整卡等人,不做半卡代答——机器只复述 AI 明示的推荐,不替人拼凑
   * 方案;开放题与"问用户事实"的闸同则,永不代答。
   * 守卫顺序:平台闸优先(盘上有闸走 maybeAutoAnswerGate,与 answer()
   * 的作答分派同一优先级)→ 档位现读现判 → 检视回合整段跳过
   * (ADR-0007 口径延伸:检视回合的卡是"意见是否被吸收"的复核点)。
   * 只在卡落地的 settle 时刻判定一次:已挂起的卡不追溯代答,档位
   * 中途切换对存量卡无效(与需求流同口径)。作答走 answer() 同一
   * 通道——状态版本先到生效、decodeAgentDecision 还原选项原文入账、
   * 续跑、事后可经现有回退推翻;defer 到回合收口(turning 释放)之后,
   * 失败旁路 fail-open,卡留待人。留痕落 notes:decision 位被 answers
   * 的码还原结果占用(与真人页面作答同形),notes 是本次入账唯一
   * 空着的留痕位,过程问答与现场导出都投影它。 */
  private maybeAutoAnswerAgentCard(live: LiveIssue): void {
    const { state } = live;
    if (state.gate) return;
    // 一/二档自动(ADR-0019):纯选项问答卡按推荐整卡代答,三档对齐等人。
    if (!this.autoModeOn(live)) return;
    if (state.review_active === true) return;
    const record = live.humanGate.pending()[0];
    if (!record) return;
    const questions = agentCardQuestions(record);
    if (!questions.length) return;
    const answers: Record<string, string> = {};
    const recommended: string[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const item = questions[index];
      const options = item.options ?? [];
      // 开放题(无 options)整卡等人:机器不替人写自由文本。
      if (!options.length) return;
      // 推荐必须命中(recommendedIndex 与投影层同一把尺);缺失或
      // 不命中整卡等人,宁人工勿猜。
      const hit = recommendedIndex(item.options, item.recommended);
      if (hit < 0) return;
      answers[String(index)] = agentOptionCode(index, hit);
      recommended.push(options[hit]);
    }
    const issueId = live.id;
    const version = record.state_version;
    const trace = `介入档位免审批自动作答(推荐项:${recommended.join("、")})`;
    this.log(`[issue-flow] ${issueId} 介入档位免审批:问题卡 ${record.waiting_id}`
      + ` 按推荐项自动作答(${recommended.join("、")})`);
    this.deferAutoAnswer(issueId, () => {
      this.answer(issueId, {
        state_version: version,
        answers,
        notes: trace,
      });
      void this.options.notifier?.notifyOutcome({
        taskId: issueId,
        account: state.account,
        status: "已代答",
        summary: `介入档位免审批:问题卡已按推荐项自动作答`
          + `(${recommended.join("、")})`,
        link: this.issueLink(issueId),
      }).catch(() => undefined);
    });
  }

  private releaseDriver(live: LiveIssue): void {
    live.driver?.dispose();
    live.driver = undefined;
  }

  /** 确认容器真正删除后才清句柄。失败时保留句柄，取消/关停可以重试，
   * 不能先把内存引用扔掉再把“已取消”返回给用户。 */
  private async stopContainer(live: LiveIssue): Promise<void> {
    const container = live.container;
    const results = await Promise.allSettled([abortAuxiliarySessions(live), container?.stop()]);
    if (results[1].status === "fulfilled" && live.container === container) live.container = undefined;
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    // 单一原因直接透传,理由同 control():包裹层会把真实病因吃掉。
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "问题会话执行资源未能全部停止");
    if (!this.shuttingDown && interruptWarmupReceipt(live.state.warmup)) saveState(live.root, live.state);
  }

  /** 阶段自然收口仍不阻塞业务答复，但失败必须留住句柄并明确记账；服务
   * 关停或用户取消会再次回收。 */
  private stopContainerInBackground(live: LiveIssue, reason: string): void {
    void this.stopContainer(live).catch((error) =>
      this.log(`[issue-flow] ${live.id} ${reason}容器停止失败(保留待重试): ${
        String(error)}`));
  }

  /** 网关解析咽喉(ADR-0039/0068,需求侧同款):settings 压部署参数;
   *  operator=问题责任人(归属账号),配了可用的个人网关时整体换装。
   *  不传 operator=平台口径(视觉校验等平台职能用它)。 */
  private modelChoice(operator?: string): {
    lane: ModelLane;
    provider: string;
    model: string;
    json: Record<string, unknown>;
  } {
    const resolved = resolveModelConfig({
      settings: this.options.settings,
      deployment: {
        modelsJson: this.options.modelsJson,
        provider: this.options.provider,
        model: this.options.model,
        vision: this.options.vision,
      },
      personal: operator
        ? this.options.personalModels?.(operator) : undefined,
      operator,
      log: (message) => this.log(`[issue-flow] ${message}`),
    });
    return {
      lane: resolved.lane,
      provider: resolved.provider ?? this.options.provider,
      model: resolved.model ?? this.options.model,
      json: resolved.json,
    };
  }

  /** 当前生效的视觉角色(TaskService.activeVisionChoice 的同款组装):角色必须
   * 指向 models.json 中明确声明支持图片的模型,配置漂移时宁可不暴露
   * 工具,也不把图片误发给文本模型。缓存落会话工作区(与需求侧
   * workspace/vision-cache 同一约定;代码仓在其下的 repo/ 子目录,
   * 缓存不会被推送或结论文档卷走)。
   *
   * 来源优先级与 TaskService 一致:管理页 settings.vision 优先于部署旗标
   * --vision-provider/--vision-model。管理页配的视觉模型必须对问题流生效,
   * 否则问题会话的 inspect_image 永远不注入(用户配了却看不到工具)。 */
  private visionCapability(workspace: string): VisionCapabilityConfig | undefined {
    const choice = this.options.settings?.models().vision ?? this.options.vision;
    if (!choice?.provider || !choice?.model) return undefined;
    const spec = (this.modelChoice().json as {
      providers?: Record<string, { models?: Array<{
        id?: string; input?: string[];
      }> }>;
    }).providers?.[choice.provider]?.models?.find((item) =>
      String(item?.id ?? "") === choice.model);
    return Array.isArray(spec?.input) && spec.input.includes("image")
      ? { choice, cacheDir: join(workspace, "vision-cache"), timeoutMs: 45_000 }
      : undefined;
  }

  /**
   * 把 ops 二进制复制到会话工作区 .ops-tools/(workspace 同路径挂载进容器,
   * 容器内就能直接执行)。只在有 isolation 且配了 opsToolsDir 时做。
   */
  private stageOpsBinaries(live: LiveIssue): void {
    const toolsDir = this.options.opsToolsDir;
    if (!toolsDir || !this.options.isolation) return;
    const destDir = join(live.root, ".ops-tools");
    mkdirSync(destDir, { recursive: true });
    // fetch-logs 引擎已迁为平台技能 fetch-logs 的 bin(随技能整包物化),
    // 这里只剩封存中的 build-deploy(ADR-0013:代码原地保留)。
    const binName = process.platform === "win32"
      ? ["build-deploy.exe"]
      : process.arch === "arm64"
        ? ["build-deploy-linux-arm64"]
        : ["build-deploy-linux-amd64"];
    for (const name of binName) {
      const src = join(toolsDir, name);
      if (!existsSync(src)) continue;
      const dest = join(destDir, name);
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
    }
  }

  /**
   * 为会话构造容器内执行的 ops 工具。把 live.container.exec 包装成
   * ContainerExec 接口(收集 stdout/stderr),再交给 createGoOpsTools。
   */
  private createSessionOps(live: LiveIssue): IssueOpsTools | undefined {
    const toolsDir = this.options.opsToolsDir;
    if (!toolsDir || !live.container) return this.options.opsTools;
    // 不捕获容器快照:容器可能因超时/OOM 停掉后被 ensureContainer 重建,
    // live.container 指向新实例。闭包捕获旧引用会永远调已死的容器。
    // 每次 exec 动态读 live.container,拿到当前实例。
    const containerExec: ContainerExec = {
      async exec(command, cwd, opts) {
        const container = live.container;
        if (!container) {
          throw new Error("会话容器已释放,无法执行运维命令");
        }
        let stdout = "";
        let stderr = "";
        const { exitCode } = await container.exec(command, cwd, {
          onData: (data: Buffer) => {
            const text = data.toString("utf-8");
            // docker exec 的 stdout/stderr 混在一起,靠前缀粗分。
            // ops 二进制输出量不大(8MB 上限),收集完整文本够用。
            stdout += text;
          },
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts.privilegedEnv ? { privilegedEnv: opts.privilegedEnv } : {}),
        });
        return { exitCode, stdout, stderr };
      },
    };
    return createGoOpsTools({
      toolsDir,
      containerExec,
      workspace: live.root,
      log: (message) => this.log(message),
    });
  }

  /** 辅助仓构建资源准备,失败降级不挡会话(2026-09-08 对齐 taskService
   *  的 try/catch 口径):辅助仓只服务构建类阶段,analyze 以业务仓只读
   *  证据为主,dirty 不影响分析正确性。此前裸抛使重启续跑撞上 warmup
   *  编译链写脏的辅助仓(签名工具原地改写 config)就整会话 failed。
   *  错误原文回传给调用方,ensureContainer 挂进 MFC_MAE_BUILD_ERROR
   *  供构建类阶段感知。 */
  private async prepareMaeBuild(live: LiveIssue): Promise<string | undefined> {
    try {
      await prepareMaeBuildSupport({ root: join(live.root, "repo"), dataDir: this.options.dataDir, user: this.options.isolation?.user,
        repositories: live.state.repo_urls ?? (live.state.repo_url ? [live.state.repo_url] : []),
        clone: (repoUrl, targetDir, baseline) => cloneRepository({ dataDir: this.options.dataDir,
          repoUrl, targetDir, baseline, shallow: true, credential: this.options.gitCredential?.(live.state.account) }),
        log: (message) => this.log(message) });
      return undefined;
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error);
      this.log(`[mae-build] ${live.id} 构建资源未就绪,降级不挡会话: ${detail}`);
      recordTransition(live.state, {
        source: "platform",
        note: `构建资源未就绪,已降级继续(不影响分析): ${detail}`,
      });
      return detail;
    }
  }

  private async ensureContainer(live: LiveIssue): Promise<void> {
    if (this.shuttingDown || isTerminal(live.state.status)) throw new IssueControlError("会话已停止");
    const epoch = live.controlEpoch;
    if (!this.options.isolation) return;
    // 容器可能因为超时/OOM/外部因素已 stopped——引用还在但 lifecycle
    // 不再 running。检查并重建,避免后续 exec 报"容器未运行"。
    if (live.container && live.container.isAlive) return;
    if (live.container) {
      this.log(`[issue-container] ${live.id} 容器已停(lifecycle≠running),重建`);
      live.container = undefined;
    }
    const isolation = this.options.isolation;
    const instance = taskContainerInstance(this.options.dataDir);
    // 辅助仓拉取会等待网络；缓存目录要在等待结束后、登记容器前创建，
    // 避免准备期间被闲置回收，随后 Docker 又以 root 重建空挂载源。
    const maeBuildError = await this.prepareMaeBuild(live);
    if (this.shuttingDown || live.controlEpoch !== epoch) throw new IssueControlError("会话已停止");
    // 分仓构建缓存挂载:与需求侧共用 perRepoBuildCacheMounts
    // (2026-09-03, issue #78 抽取;防覆盖守卫、合并顺序、touch/mkdir
    // 时机都在共享函数里,两侧不再各养一份)。issueFlow 容器内要跑
    // mvn clean package(build_deploy 工具),没有 Maven 仓库挂载就找
    // 不到 parent POM。cacheKey 按会话首个仓,缺了退会话 id。
    const mounts = perRepoBuildCacheMounts({
      cacheRoot: isolation.cacheRoot,
      cacheKeySource: live.state.repo_url
        ?? live.state.repo_urls?.[0] ?? live.id,
      volumes: isolation.volumes,
      seedEnvironment: isolation.environment,
      // C++ Maven 插件约定 ${project.basedir}/../cpp_sdk_repository;
      // issueFlow 仓在 live.root/repo/<仓名>/,所以 SDK 缓存挂在
      // live.root/repo/cpp_sdk_repository,多仓场景所有仓共享同一处
      // ——与单仓语义天然一致。
      cppSdkDestination: join(live.root, "repo", "cpp_sdk_repository"),
      ccacheBaseDirSource: live.root,
      // 问题流没有宿主身份透传、防覆盖报错回显去尾斜杠形态:
      // 两个旗子都缺席,正是抽取前这里的既有行为。
    });
    // The issue container exists before pull_repo; keep a stable parent bind so late host preparation is visible.
    // 降级口径见 prepareMaeBuild:错误挂环境变量,不阻断容器与会话。
    const volumes = [...mounts.volumes, `${MAE_BUILD_ASSETS}:${MAE_BUILD_MOUNT}:ro`];
    const environment = { ...mounts.environment, MFC_MAE_BUILD_ROOT: join(live.root, "repo"),
      MFC_MAE_BASELINE: live.state.baseline ?? "",
      ...(maeBuildError ? { MFC_MAE_BUILD_ERROR: maeBuildError } : {}) };
    const build: IssueContainerBuild = {
      image: isolation.image,
      workspace: live.root,
      name: `mfc-${instance.namePrefix}-${live.id}`,
      log: (message) => this.log(`[issue-container] ${message}`),
      volumes,
      // user 必须随 limits 传到 docker run(2026-08-29 真实环境实测:
      // 漏传使容器落回镜像默认用户,安全自检"Config.User 为空或为
      // root/0"拒绝运行——需求侧同环境能跑正是它传了)。
      limits: {
        memory: isolation.memory,
        cpus: isolation.cpus,
        pidsLimit: isolation.pidsLimit,
        user: isolation.user,
      },
      options: {
        network: isolation.network,
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        // ownership 标签与需求侧 createTaskContainer 同一套。少了它们,
        // kill -9 后的启动清扫(按 instance 指纹过滤)整批看不见 issue
        // 容器——每次硬重启漏一批,宿主内存被静默吃光(2026-08-29
        // 部署审计实锤)。role=issue 已列入清扫白名单 MANAGED_ROLES。
        labels: {
          "com.mae-flow-cloud.instance": instance.fingerprint,
          "com.mae-flow-cloud.role": "issue",
          "com.mae-flow-cloud.task": live.id,
        },
      },
    };
    let container: TaskContainer;
    try {
      container = isolation.containerFactory
        ? isolation.containerFactory(build)
        : new TaskContainer(build.image, build.workspace, build.name,
            build.log, build.volumes, build.limits, build.options);
    } catch (cause) {
      throw issueInfraFailure(cause);
    }
    // root 守护进程 + 非 root 容器用户时,把工作区属主在 docker run
    // 前交给容器用户(与需求侧同款;非 root 服务自判 active:false 跳过)。
    const prepared = prepareContainerHostPaths({
      log: message => this.log(`${message} container=${live.id}`),
      workspace: live.root,
      volumes: volumes,
      user: isolation.user,
      markerRoot: join(this.options.dataDir, ".container-ownership"),
      // cacheRoot 在场时,缓存目录会被 chown 给容器用户——不加这行
      // /cache/maven 属主留 root,mfc 无法创建 repository 子目录。
      ...(isolation.cacheRoot ? { cacheRoot: isolation.cacheRoot } : {}),
    });
    if (prepared.active
        && (prepared.workspaceEntries || prepared.cacheTrees)) {
      this.log(`[issue-container] ${live.id} 属主准备: `
        + `workspace=${prepared.workspaceEntries},`
        + `owner=${prepared.owner!.uid}:${prepared.owner!.gid}`);
    }
    // Maven settings.xml 通常以只读 volume 挂入容器。如果宿主文件是
    // 640 root:root,容器用户 mfc 读不了——entrypoint 的 [ -r ] 检查
    // 失败,不创建 ~/.m2/settings.xml 软链,Maven 找不到内部仓库配置,
    // parent POM 不可解析。服务以 root 运行,启动前确保世界可读。
    const mavenSettingsVolume = volumes.find(
      (v) => v.split(":")[1]?.replace(/\/+$/, "") === "/etc/mae-flow/maven/settings.xml",
    );
    if (mavenSettingsVolume) {
      const settingsPath = mavenSettingsVolume.split(":")[0];
      if (existsSync(settingsPath)) {
        const stat = statSync(settingsPath);
        if (!(stat.mode & 0o044)) {
          chmodSync(settingsPath, stat.mode | 0o044);
          this.log(`[issue-container] ${live.id} Maven settings.xml 权限修正: `
            + `${settingsPath} 添加世界可读(原 0${(stat.mode & 0o777).toString(8)})`);
        }
      }
    }
    try {
      await container.start();
    } catch (cause) {
      throw issueInfraFailure(cause);
    }
    live.container = container;
    if (this.shuttingDown || live.controlEpoch !== epoch) {
      await this.stopContainer(live);
      throw new IssueControlError("会话已停止");
    }
    // /etc/profile.d/mfc-env.sh 把 TMPDIR 设成 /tmp/mae-flow-build,但该
    // 目录不存在。登录 shell(sh -lc)会 source profile 导致 TMPDIR 指向
    // 不存在的路径,build-deploy 二进制用 TMPDIR 创建临时目录时 stat 失败。
    // 容器启动后通过 exec 建出这个目录(tmpfs 不在 workspace 挂载内,宿主
    // 侧无法直接 mkdir)。
    try {
      await container.exec(
        "mkdir -p /tmp/mae-flow-build",
        live.root,
        { onData: () => {}, timeout: 5 },
      );
    } catch { /* best-effort; 目录可能已存在或容器未启用 exec */ }
    if (this.shuttingDown || live.controlEpoch !== epoch) throw new IssueControlError("会话已停止");
    // ops 二进制分发到 workspace(容器内同路径可执行)
    this.stageOpsBinaries(live);
  }

  /** 预热会话墙钟预算:与需求侧 attemptTimeoutMs 缺省同款。 */
  private static readonly WARMUP_BUDGET_MS = 25 * 60_000;

  /** 环境预热启动(2026-09-04,需求侧 startBaselineWarmup 的问题流
   * 移植)。complete_stage 推进进 analyze(工具层)与续聊回合容器就绪
   * 后(resumeTurnBody,#358 补跑)两条路调用,与主 Agent 的分析并行。
   * 守卫全 fail-open:开关缺席、无隔离、已在跑、收过终局收据、容器
   * 不在场,任何一条不满足就静默跳过——预热是旁路,不是流程依赖。
   * 幂等:终局收据(passed/failed)在 state 不再重跑;中断/基建失败
   * (infrastructure_failure)不算编译完成,analyze 期间补跑,与需求
   * 侧 293343c3 同款守卫。 */
  private startBaselineWarmup(live: LiveIssue): void {
    if (this.shuttingDown || isTerminal(live.state.status)) return;
    const configured = this.options.warmup;
    if (!configured || configured.enabled === false) return;
    if ((this.options.settings?.runtime?.().issue_warmup_enabled
      ?? ISSUE_WARMUP_ENABLED_DEFAULT) !== 1) return;
    // 原生路径要真容器;测试注入 runner 时放行。
    if (!configured.runner && !this.options.isolation) return;
    if (live.warmupActive) return;
    // 中断/基建失败不等于编译完成,不拦补跑(#358):此前 finished_at
    // 一刀切,重启打断的预热永不重跑(issue-79 实锤,09-17 起无基线)。
    if (live.state.warmup?.finished_at
        && live.state.warmup.status !== "infrastructure_failure") {
      // 守卫拦截留痕(#404 场景 7):「为什么没预热」要能只凭账面回答。
      sessionAudit(live.root, live.id, "decisions", {
        kind: "decision.warmup",
        msg: `预热守卫放行拦截:已有终局收据(${live.state.warmup.status})`,
        decision: "skip-warmup",
        reason_code: "warmup-finished",
        warmup_status: live.state.warmup.status,
      });
      return;
    }
    if (!live.container && !configured.runner) {
      sessionAudit(live.root, live.id, "decisions", {
        kind: "decision.warmup",
        msg: "预热守卫放行拦截:无容器且无 runner 注入",
        decision: "skip-warmup", reason_code: "no-container",
      });
      return;
    }
    live.warmupActive = true;
    const budgetMs = (live.state.repo_urls ?? [live.state.repo_url ?? ""]).some(isMaeRepository)
      ? 90 * 60_000 : IssueFlowService.WARMUP_BUDGET_MS;
    this.log(`[issue-warmup] ${live.id} 环境预热开跑(预算 `
      + `${Math.round(budgetMs / 60_000)} 分钟)`);
    void this.runWarmupSession(live, budgetMs)
      .catch((error) => this.log(`[issue-warmup] ${live.id} 环境预热异常`
        + `(fail-open,流程照走): ${String(error)}`))
      .finally(() => { live.warmupActive = false; });
  }

  /** 预热原生执行器:任务容器里的独立 Pi 会话。与主会话共享容器但
   * 不共享会话;此刻主 Agent 在分析(只读为主),编译负载可接受
   * (2026-08-26 拍板"开始就爆红是好事"的同款取舍)。 */
  private async runWarmupSession(
    live: LiveIssue,
    budgetMs: number,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const sessionEpoch = auxiliarySessionEpoch(live);
    const settle = (receipt: IssueWarmupReceipt) => {
      // 会话已被取消/归档换新时,旧收据不覆盖新现实。
      if (this.shuttingDown || this.live.get(live.id) !== live || auxiliarySessionEpoch(live) !== sessionEpoch) return;
      live.state.warmup = receipt;
      saveState(live.root, live.state);
      this.log(`[issue-warmup] ${live.id} 环境预热收口: ${receipt.status}`
        + (receipt.detail ? ` — ${receipt.detail.slice(0, 120)}` : ""));
    };
    const writeRunning = () => {
      if (this.live.get(live.id) !== live) return;
      live.state.warmup = { status: "running", started_at: startedAt };
      saveState(live.root, live.state);
    };
    const finish = (
      status: IssueWarmupReceipt["status"],
      detail?: string,
      build_command?: string,
    ) => {
      settle({
        status,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        ...(detail ? { detail: detail.slice(0, 600) } : {}),
        ...(build_command ? { build_command } : {}),
      });
    };
    writeRunning();
    let outcome: IssueWarmupOutcome;
    try {
      outcome = await (this.options.warmup?.runner
        ? this.options.warmup.runner({ workspace: live.root })
        : this.runCloudWarmupAgent(live, budgetMs));
    } catch (error) {
      // 执行器自身异常也是基建事实:如实收口,不留 running 僵收据。
      outcome = {
        status: "infrastructure_failure",
        message: String(error instanceof Error ? error.message : error)
          .slice(0, 300),
      };
    }
    finish(outcome.status, outcome.message, outcome.build_command);
  }

  /** 预热会话执行器(需求侧 runCloudWarmupAgent 的简化移植):独立
   * CloudSession,同款 <warmup-result> 报告协议,预算到点 abort。 */
  private async runCloudWarmupAgent(
    live: LiveIssue,
    budgetMs: number,
  ): Promise<IssueWarmupOutcome> {
    if (this.shuttingDown || isTerminal(live.state.status)) throw new IssueControlError("会话已停止");
    const sessionEpoch = auxiliarySessionEpoch(live);
    const runRoot = join(live.root, "warmup");
    // agentDir 与主会话共用顶层 pi-agent(需求侧同款):密钥目录的闸
    // 只认工作区顶层路径段(HOST_SECRET_DIRS),埋进 warmup/ 子目录
    // 等于把 models.json 的网关密钥暴露给预热会话。
    const agentDir = join(live.root, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    // build-notes 目录宿主预建,预热专员只写放行的那个文件。
    mkdirSync(join(live.root, ".mae-flow-work"), { recursive: true });
    const model = this.modelChoice(live.state.account);
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(model.json), { mode: 0o600 });
    const driver = await CloudSession.create({
      taskId: `${live.id}:warmup`,
      repositoryResourceBlocks: () =>
        readResourceBlocks(this.options.dataDir),
      knowledgeContext: issueKnowledgeContext(live.state),
      hostSkillsDir: join(this.options.dataDir, "skills"),
      knowledgeModuleDataDir: this.options.dataDir,
      knowledgeScope: "issue",
      workspace: live.root,
      agentDir,
      provider: model.provider,
      model: model.model,
      eventLog: new EventLog(join(runRoot, "events.jsonl"), undefined, this.log),
      transcript: new TranscriptStore(join(runRoot, "transcript.jsonl"), "main"),
      // 与主会话同一份可达边界:台账文件与只读投影目录同罪。
      gate: new GateService({
        workspace: live.root,
        cwd: live.root,
        extraLedgerFiles: ["issue.json", "issue.json.tmp"],
        extraLedgerDirs: ["codecheck", "skills", ".mae-flow-work/host-skills",
          ".mae-flow-work/business-modules"],
        failClosed: false,
        log: (message) => this.log(`[issue-warmup-gate] ${message}`),
      }),
      humanGate: live.humanGate,
      allowHumanQuestions: false,
      allowSubagents: false,
      bashOperations: this.options.isolation
        ? // forwardAbort=false:预算到点的 abort 是系统发起,不得经
          // Abort 语义销毁与主会话共享的容器(用户打断走主会话,不变)。
          createContainerBashOperations(() => auxiliarySessionEpoch(live) === sessionEpoch ? live.container : undefined,
            { forwardAbort: false, buildBudget: { attemptTimeoutMs: budgetMs,
              buildCommandTimeoutMs: Math.max(1000, budgetMs - 5 * 60_000) } })
        : undefined,
      sessionId: "warmup",
      // 预热直播(对齐清单⑤):bash 流式输出进 events.jsonl,前端
      // PrepushLiveLog 才有命令可看——与需求侧 warmup 会话同款开关。
      streamBashOutput: true,
      currentStep: () => "环境预热编译",
      compactAnchor: () => `问题会话「${live.state.title}」环境预热编译`,
      log: (message) => this.log(`[issue-warmup] ${message}`),
    });
    trackAuxiliarySession(live, driver, sessionEpoch);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void driver.abort().catch(() => undefined);
    }, budgetMs);
    timer.unref?.();
    try {
      let outcome = await driver.start(
        issueWarmupMission(Math.round(budgetMs / 60_000)));
      for (let correction = 0; correction < 2; correction += 1) {
        if (this.shuttingDown || auxiliarySessionEpoch(live) !== sessionEpoch) {
          return { status: "infrastructure_failure", message: "预热已停止" };
        }
        if (timedOut) {
          return {
            status: "infrastructure_failure",
            message: `环境预热超过 ${Math.ceil(budgetMs / 60_000)} `
              + "分钟预算,已安全停止;不代表基线编译失败",
          };
        }
        if (outcome.status === "session_ended") {
          return {
            status: "infrastructure_failure",
            message: outcome.detail ?? outcome.reason ?? "预热会话异常结束",
          };
        }
        const report = parseWarmupReport(driver.finalReply());
        if (report) return report;
        // 报告缺失只是格式问题,给一次补交机会,别把整轮预热判死。
        outcome = await driver.continueWith(
          "预热尚未收口:请按任务说明输出单行 JSON 的 <warmup-result> 结构。");
      }
      return {
        status: "infrastructure_failure",
        message: "预热会话未产出合法的 <warmup-result> 报告",
      };
    } finally {
      clearTimeout(timer);
      untrackAuxiliarySession(live, driver);
      driver.dispose();
    }
  }

  private async checkCodecheckBeforePush(live: LiveIssue, repo: { dir: string; url: string }): Promise<string> {
    const epoch = live.controlEpoch;
    const result = await runCodecheckPrepush({ repo: repo.dir, workspace: live.root,
      recordRoot: join(live.root, "codecheck"), sourceRoot: join(this.options.dataDir, "skills"),
      moduleDataDir: this.options.dataDir, context: issueKnowledgeContext(live.state), scope: "issue",
      target: live.state.baseline, log: message => this.log(`[issue-codecheck] ${message}`),
      ticket: live.state.ticket,
      commitConvention: `本单修复提交使用 [${live.state.ticket}][fix] 描述。`,
      run: this.options.codecheck?.runner ?? (async request => {
        if (this.shuttingDown || live.controlEpoch !== epoch) throw new IssueControlError("会话已停止");
        if (!this.options.isolation) throw new Error("CodeCheck 需要任务执行容器，未回退到宿主运行");
        await this.ensureContainer(live);
        if (this.shuttingDown || live.controlEpoch !== epoch) throw new IssueControlError("会话已停止");
        const model = this.modelChoice(live.state.account);
        repairContainerMutationOwnership({ workspace: live.root, path: join(request.repo, ".codecheckcli"),
          user: this.options.isolation?.user, runtime: this.options.ownershipRuntime, recursive: true });
        return runCodecheckSkillSession(live, request, {
          taskId: `${live.id}:codecheck`, workspace: live.root, agentDir: join(live.root, "pi-agent"),
          provider: model.provider, model: model.model,
          eventLog: new EventLog(join(live.root, "codecheck", "events.jsonl"), undefined, this.log),
          transcript: new TranscriptStore(join(live.root, "codecheck", "transcript.jsonl"), "codecheck"),
          humanGate: live.humanGate, streamBashOutput: true,
          bashOperations: createContainerBashOperations(() => live.controlEpoch === epoch ? live.container : undefined),
          afterFileMutation: path => { repairContainerMutationOwnership({ workspace: live.root, path,
            user: this.options.isolation?.user, runtime: this.options.ownershipRuntime }); },
          log: message => this.log(`[issue-codecheck] ${message}`),
        });
      }),
    });
    if (this.shuttingDown || live.controlEpoch !== epoch) throw new IssueControlError("会话已停止");
    recordTransition(live.state, { source: "platform", note: result.summary });
    saveState(live.root, live.state);
    return result.summary;
  }

  private async openDriver(live: LiveIssue): Promise<CloudSession> {
    if (this.shuttingDown || isTerminal(live.state.status)) throw new IssueControlError("会话已停止");
    const epoch = live.controlEpoch;
    if (live.driver) return live.driver;
    await this.ensureContainer(live);
    if (this.shuttingDown || live.controlEpoch !== epoch) throw new IssueControlError("会话已停止");
    const agentDir = join(live.root, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const model = this.modelChoice(live.state.account);
    // 网关标记记主会话的解析结果(ADR-0039),随下次 saveState 落盘。
    live.state.model_lane = model.lane;
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), {
      mode: 0o600,
    });
    const skillPaths = materializeIssueSkills(live.root);
    // 调试形态(--debug-issue):物化后把 fetch-logs 的抓日志 wrapper
    // 换成假引擎。只在旗标在场时发生;正式形态无此调用。
    if (this.options.debugIssue) {
      applyDebugIssueSkillPatch(live.root, this.options.debugIssue.opsMockBinDir);
    }
    this.log(`[issue-flow] ${live.id} 装载技能: ${
      skillPaths.map((path) => path.split("/").at(-2)).join(", ")}`);
    const service = this;
    // 团队货架 skill 进问题会话(ADR-0005):问题域知识上下文=登记的
    // 关联仓 + 绑定的业务模块;匹配走 issue 口径(通用工程知识豁免、
    // 技术栈维度不参与)。部署源与需求侧同一个 dataDir/skills。
    const knowledgeContext = issueKnowledgeContext(live.state);
    const context: IssueToolContext = {
      state: live.state,
      workspace: live.root,
      dataRoot: this.options.dataDir,
      persist: () => saveState(live.root, live.state),
      beforePush: async repo => {
        const imported = live.state.imported_mr;
        if (imported) {
          const current = await this.readMrDetails(imported.url, live.state.account);
          if (current.state !== "opened" || current.repo !== imported.repo
            || current.source_branch !== imported.source_branch || current.target_branch !== imported.target_branch) {
            throw new IssueControlError("已有 MR 的状态、仓库或分支已变化，已停止推送，请先核对");
          }
        }
        return this.checkCodecheckBeforePush(live, repo);
      },
      assertActive: () => {
        if (this.shuttingDown || live.controlEpoch !== epoch || isTerminal(live.state.status)) throw new IssueControlError("会话已停止");
      },
      ops: this.createSessionOps(live) ?? this.options.opsTools,
      dts: this.options.dts,
      platformUrl: this.options.platformUrl,
      environmentPassword: () => {
        const ref = live.state.environment?.credential_ref;
        return ref
          ? service.vault.credential(live.id, ref, "operator")?.password
          : undefined;
      },
      // 独立 root 密码(#150,ADR-0003 同一条明文进上下文的口):只在
      // 显式凭据组在场时解出;继承后台密码的会话缺省,消费面按
      // "root 与后台密码相同"理解。
      rootPassword: () => {
        const ref = live.state.environment?.root_credential_ref;
        return ref
          ? service.vault.credential(live.id, ref, "root")?.password
          : undefined;
      },
      gitCredential: () =>
        this.options.gitCredential?.(live.state.account),
      // 基线同步冲突现场交回容器前修属主(ADR-0071):宿主 merge 以宿主
      // 身份写文件,容器用户改不动;幂等 walk,非隔离部署零开销。
      // 与回合开始吸收共用一份(见 repairOwnershipFor)。
      repairOwnership: this.repairOwnershipFor(live),
      // 分支传输在途互斥(ADR-0074 票 3):工具侧与回合开始探针共用
      // LiveIssue 级单例,两边互斥不漂。
      branchTransfer: this.branchTransferOf(live),
      // 介入档位现值:build_deploy 随路 env_verify 卡的举卡条件(三档
      // 独有);env_needed 配置卡三档同举,不再随档位分叉(ADR-0019
      // 2026-10-31 增补)。
      interventionTier: () => this.tierOf(live),
      // skill 圈选入口闸(ADR-0011):complete_stage 推进进 analyze 时
      // 调用,service 现读现判决定举不举(见 raiseSkillSelectionGate)。
      raiseSkillSelection: () => this.raiseSkillSelectionGate(live),
      // 环境预热(2026-09-04):complete_stage 推进进 analyze 时启动,
      // 与主 Agent 的分析并行(fail-open,见 startBaselineWarmup)。
      startWarmup: () => this.startBaselineWarmup(live),
      // 业务知识资产定格(ADR-0012):进 analyze 时按绑定模块定格资产
      // 库知识并落台账;不分介入档,缺席静默(见 freezeBusinessKnowledge)。
      freezeBusinessKnowledge: () => this.freezeBusinessKnowledge(live),
      // 业务知识地图(ADR-0012/0021):analyze 只注入按模块定格的
      // 资产台账；仓内 docs 的发现权归仓内契约/skill。
      businessKnowledgeBrief: () =>
        businessKnowledgeLines(live.state).join("\n"),
      // 拉仓工具的宿主实现(克隆+登记+建分支,凭据止步宿主)。
      pullRepo: (url: string) => service.pullRepoFor(live, url),
      // 固定流程:MR 建成→对该仓启动流水线监看(多仓各自挂表)。
      onMrCreated: (repo: string) => service.armPipelineWatch(live, repo),
      // 推送即启动监看(issue-72):修复环"同分支再推,MR 自动跟新提交"
      // 不重建 MR,监看重挂不能只挂在 create_mr 上——该仓已有 MR 就按
      // 推送账新 SHA 重挂(幂等),申报门受理过期结果时承诺的"等监看器拿
      // 新 run 真终态"才有表可等。尚无 MR 的仓不挂,保持"有 MR 才监看"。
      onBranchPushed: (repo: string) => {
        if (live.state.mrs?.some((mr) => mr.repo === repo)) {
          service.armPipelineWatch(live, repo);
        }
      },
      // mr_green 即时收口(complete_stage 验绿当场全绿/空清单):平台
      // 不再代举验证卡(#246,ADR-0024)——只启动合入事实监看;验证卡
      // 由 AI 凭收口回执里的指引自己经 raise_gate 举出。监看器滞后
      // 收口走 settlePipeline 的 closeMrGreen(全绿事实发送)。
      notifyMrGreen: () => {
        this.watchMergeStates(live);
      },
      // MR 状态复核(#321):验绿门与监看器终态处理共用同一私有判断
      //(recheckMrForSettle),两边口径不漂移。
      mrRecheck: (repo, sha) => service.recheckMrForSettle(live, repo, sha),
      // 单卡互斥②(ADR-0024):有未决 Agent 卡时 raise_gate 拒举。
      pendingAgentCard: () => live.humanGate.pending().length > 0,
      // 举卡即收口(票 #573,六卡一规则):「本回合已举卡」内存标记,
      // 见 LiveIssue.cardRaisedInTurn 注释(清零挂点=回合启动/收口)。
      turnCardRaised: () => live.cardRaisedInTurn === true,
      markTurnCardRaised: () => {
        live.cardRaisedInTurn = true;
      },
      // 对话选环境(票 #574):用户在对话给出 IP 时按台账精确匹配挂载,
      // 复用 attachEnvironment 全部语义(覆盖/清卡/解锢/开平台回合)。
      selectEnvironmentByIp: (ip: string) =>
        this.selectEnvironmentByIp(live.id, ip),
      log: (message) => this.log(message),
    };
    live.toolContext = context;
    const isolation = this.options.isolation;
    const bashOperations: import("@earendil-works/pi-coding-agent").BashOperations | undefined =
      isolation
        ? // 超时语义收窄的容器适配(2026-09-04):容器内 timeout 了结命令,
          // 不再连坐销毁容器;动态取当前实例,重建后自动跟上。
          createContainerBashOperations(() => live.container)
        : undefined;
    const identity = this.options.gitCredential?.(live.state.account);
    for (const repo of issueRepoWorkspaces(live.state, live.root)) {
      if (existsSync(join(repo.dir, ".git"))) {
        excludeCodecheckArtifacts(repo.dir);
        await applyGitCommitIdentity(repo.dir, identity);
      }
    }
    const sessionOptions: import("../sessionDriver.ts").CloudSessionOptions = {
      taskId: live.id,
      workspace: live.root,
      agentDir,
      repositoryResourceBlocks: () =>
        readResourceBlocks(this.options.dataDir),
      // 多仓契约文件进系统提示词(spec #131 / issue #132,2026-09-03):
      // 会话 cwd 是 live.root,repo/<仓名>/ 下的 AGENTS.md 不在 SDK 祖先
      // 发现链上,平台按 SDK 同款候选序收好递进去。收集点=上下文构建:
      // 本回合中途 pull_repo 落地的仓,下次会话重建才带上。fail-open
      // 兜底:收集器自身已逐仓吞错,这里的 try/catch 防的是它之外的
      // 意外——上下文装配绝不允许炸会话开启。
      repoContextFiles: (() => {
        try {
          return collectRepoContextFiles(live.root);
        } catch (error) {
          this.log(`[issue-flow] ${live.id} 仓契约收集失败,按空处理: `
            + String(error));
          return [];
        }
      })(),
      // 改编版 playbook 技能(精确到 SKILL.md 文件的 allowlist 形态)。
      repositorySkillPaths: skillPaths,
      // 团队货架 skill(通用定位类知识的问题会话供给线,ADR-0005)。
      hostSkillsDir: join(this.options.dataDir, "skills"),
      knowledgeModuleDataDir: this.options.dataDir,
      knowledgeContext,
      knowledgeScope: "issue",
      provider: model.provider,
      model: model.model,
      ...(this.options.authRetryDelaysMs
        ? { authRetryDelaysMs: this.options.authRetryDelaysMs }
        : {}),
      eventLog: new EventLog(join(live.root, "events.jsonl"), undefined, this.log),
      transcript: new TranscriptStore(join(live.root, "transcript.jsonl"), "main"),
      resumeSession: true,
      gate: new GateService({
        // 问题会话的可达边界=整个会话工作区(代码仓 + local-logs +
        // issue-analysis.md 都在里面)。台账类文件由 GateService 的
        // 宿主账本规则拒写;问题域追加自己的账本与技能目录——
        // issue.json 是推送门禁的依据,skills/ 是行为契约,都不能
        // 让 Agent 自己改;货架 skill 快照(.mae-flow-work/host-skills)
        // 与业务知识投影(.mae-flow-work/business-modules,ADR-0012)
        // 同罪:只读投影,Agent 没有写它的理由。
        workspace: live.root,
        cwd: live.root,
        extraLedgerFiles: ["issue.json", "issue.json.tmp"],
        extraLedgerDirs: ["codecheck", "skills", ".mae-flow-work/host-skills",
          ".mae-flow-work/business-modules"],
        failClosed: false,
        log: (message) => this.log(`[issue-gate] ${message}`),
      }),
      humanGate: live.humanGate,
      allowHumanQuestions: true,
      // 单卡互斥①(ADR-0024):平台闸在场时 AskUserQuestion 先问宿主,
      // 宿主拦下(纠偏文字作工具错误回给模型,不建卡不通知)——闸优先
      // 是作答分派的既有语义,两卡并存是 issue-53 撞车类 bug 的土壤。
      beforeHumanQuestion: () => {
        if (live.state.gate) {
          return "已有一张平台闸在等用户作答,不要再举问题卡——闸裁决后会开"
            + "新回合,届时若仍需要向用户提问,再举问题卡。";
        }
        // 举卡即收口(票 #573):问题卡即将落地——置「本回合已举卡」
        // 标记,同回合后续的平台工具调用一律机械拦下。
        live.cardRaisedInTurn = true;
        return undefined;
      },
      // 子 Agent 派发开闸(2026-09-06):vendor 方法论技能(code-review
      // 并行评审/grilling 派子查证)原生可用。安全边界:
      // - 业务工具(complete_stage/push_branch 等)只在主会话——
      //   sessionDriver 的子会话 extraTools 强制为空;
      // - 子内提问/再派发由框架拒绝工具打回,主 Agent 凭报告举卡;
      // - 派发纪律(子只做只读任务/证据指针化/预算写进任务卡)由
      //   适配层约束。预热专员会话保持关闭(专职编译,无需派发)。
      // 平台统一知识检索(ADR-0062,只读消费边界):只读子集——不传
      // research/plan,生产动作在这个会话域不存在;子 Agent 经
      // childKnowledgeTools 自动继承只读同款。
      extraTools: [
        ...createIssueTools(context),
        ...(this.options.knowledgeSearch ? [createKnowledgeTool({
          service: this.options.knowledgeSearch,
          context: () => issueToolKnowledgeContext(live.state),
        })] : []),
      ],
      // 视觉旁路(与需求侧同一套配置语义):配了有效角色才注入
      // inspect_image,主上下文只收文字结论。
      vision: this.visionCapability(live.root),
      currentStep: () => live.state.stage_note || live.state.stage,
      // 知识足迹(ADR-0062):只记宿主可观察事实,写失败只记日志;
      // 读侧投影(UI/飞轮)后置,先攒数据。
      knowledgeTrace: new KnowledgeTrace(
        join(live.root, "knowledge-events.jsonl"), live.id, live.root,
        () => live.state.stage_note || live.state.stage,
        (message) => this.log(`[issue-knowledge] ${message}`),
      ),
      compactAnchor: () => {
        if (live.state.stage !== "fix") return issueCompactAnchor(live.state);
        const pointer = this.analysisReportPointer(live);
        return `${issueCompactAnchor(live.state)}\n分析报告: ${pointer.path}\n修改方案要点: ${pointer.plan}`;
      },
      ...(bashOperations ? { bashOperations } : {}),
      ...(isolation?.user
        ? {
            afterFileMutation: (path: string) => {
              repairContainerMutationOwnership({
                workspace: live.root, path, user: isolation.user,
              });
            },
          }
        : {}),
      log: (message) => this.log(`[issue-session] ${message}`),
    };
    const driver = await CloudSession.create(sessionOptions);
    if (this.shuttingDown || live.controlEpoch !== epoch) {
      driver.dispose();
      throw new IssueControlError("会话已停止");
    }
    live.driver = driver;
    return driver;
  }

  // ---- 用户输入三通道:作答 / 插话 / 续聊 ----

  answer(id: string, input: {
    state_version: number;
    /** 人话答复:现场账与续聊提示词的显示/自由作答文本;闸卡按码作答
     * 时可缺席(码能从注册表反查文案)。 */
    decision?: string;
    /** 平台闸的决策码(单题卡):裁决按它单点分派,文案不是匹配键。 */
    code?: string;
    /** Agent 问题卡逐题作答:键=题号,值=决策码或自由作答文本。 */
    answers?: Record<string, string>;
    /** skill 圈选闸(ADR-0011)的勾选清单:必须是闸上 skills path 的
     * 子集;缺席/空=「都不用」,AI 按取用次序自主。 */
    selection?: string[];
    notes?: string;
  }): IssueSummary {
    const live = this.require(id);
    if (live.state.status !== "waiting_user") {
      throw new IssueControlError(
        `当前状态 ${live.state.status} 没有等待中的问题卡`);
    }
    this.promoteMessageImages(live, input.decision ?? "",
      ...(input.notes ? [input.notes] : []),
      ...Object.values(input.answers ?? {}));
    // 平台闸(固定流程的人工硬闸)优先于 Agent 问题卡:闸在 state 里,
    // 分派语义在服务,不进模型。
    if (live.state.gate) {
      return this.resolveGate(live, {
        stateVersion: input.state_version,
        decision: input.decision ?? "",
        // 闸卡恒为单题:code 缺席时兼容逐题通道(同一提交协议)。
        code: input.code?.trim()
          || Object.values(input.answers ?? {}).find((value) => value.trim()),
        ...(input.selection !== undefined ? { selection: input.selection } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    }
    const waiting = live.humanGate.pending()[0];
    if (!waiting) throw new IssueControlError("盘上没有等待中的问题卡(状态不一致)");
    const record = live.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      // 决策码还原成选项原文再入账:Agent 看到的文本与文字作答时代一致。
      decision: decodeAgentDecision(waiting, input.answers)
        ?? input.decision ?? "",
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在处理上一条输入,稍候再试");
    }
    this.beginTurn(live, async () => {
      await this.ensureContainer(live);
      // 欠账便签随行(#244 发送必达):作答回合是停靠通知的补发时机。
      return this.withParkedNotices(live, async (replay) => {
        if (live.driver) {
          return live.driver.resumeWithDecision(record, replay || undefined);
        }
        // 进程重启后的作答:重开 会话,决定先补登记(审计),再以
        // 续聊提示词把答案交给重建的上下文。
        const driver = await this.openDriver(live);
        driver.injectDecision(record);
        const decisionText = `用户对问题卡的答复:\n${renderDecision(record)}`
          + (replay ? `\n\n${replay}` : "");
        return driver.startResume(issueResumePrompt(live.state, decisionText,
          this.environmentCredentials(live), this.resumePromptOptions(live)));
      });
    });
    return this.summarize(live.state);
  }

  /** 会话消息内嵌截图(2026-09-10 验证闸配套):消息文本里的
   * issue-images/<hash> 引用从 staging 提升到会话工作区——AI 侧
   * inspect_image 按工作区相对路径识图。与登记 create() 的同步
   * 同款 fail-open:单图缺席只跳过,不阻断消息。 */
  private promoteMessageImages(live: LiveIssue, ...texts: string[]): void {
    const text = texts.join("\n");
    if (!text.includes("issue-images/")) return;
    const result = syncIssueImagesToWorkspace({
      description: text,
      dataDir: this.options.dataDir,
      workspace: live.root,
      log: (message) => this.log(message),
    });
    if (result.copied || result.missing) {
      this.log(`[issue-flow] ${live.id} 消息截图提升: `
        + `复制 ${result.copied},缺席 ${result.missing}`);
    }
  }

  /** 会话事件补记:服务侧发生的事实(如闸作答)落进事件账本,与
   * driver 记的模型侧事件共用一个幂等序列。 */
  private appendSessionEvent(
    live: Pick<LiveIssue, "root" | "id">,
    kind: SemanticEvent["kind"],
    payload: Record<string, unknown>,
  ): void {
    try {
      const eventLog = new EventLog(join(live.root, "events.jsonl"),
        undefined, this.log);
      eventLog.append({
        eventId: eventLog.lastEventId() + 1,
        taskId: live.id,
        sessionId: live.id,
        ts: new Date().toISOString(),
        kind,
        payload,
      });
    } catch (cause) {
      this.log?.(`[issue-flow] ${live.id} 事件补记失败(${kind}): `
        + String(cause instanceof Error ? cause.message : cause));
    }
  }

  // ---- 固定流程:平台闸的裁决与阶段机联动 ----

  /** 平台闸作答分派:按决策码单点分派(gateVerdict 纯函数,语义与
   * 分派规则都住在 stageRegistry),中文文案不再是匹配键——改决策卡
   * 文案零协议后果。decision 只进现场账与续聊提示词(显示语义):
   * 按码作答时可缺席,从注册表码表反查人话;自由作答原样入账。
   * 确认后推进到哪、补充意见后回流到哪,是阶段知识,查阶段注册表
   * 的出口闸声明(stageGateRoute),不在裁决代码里写死。 */
  private resolveGate(live: LiveIssue, input: {
    stateVersion: number;
    decision: string;
    code?: string;
    selection?: string[];
    notes?: string;
  }): IssueSummary {
    const { state } = live;
    const gate = state.gate!;
    if (input.stateVersion !== gate.state_version) {
      throw new IssueControlError("问题卡状态已变化,请刷新后重试");
    }
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在处理上一条输入,稍候再试");
    }
    if (gate.kind === "env_needed") {
      // 环境闸的作答口是 POST /issues/:id/environment(问题卡上的专用
      // 表单),不是选项卡:走错口不动状态,如实指路。
      throw new IssueControlError(
        "网管环境请在问题卡的配置表单里填写服务器地址与网管后台密码后提交");
    }
    if (gate.kind === "skill_select") {
      // skill 圈选闸的作答口是 selection 专用口(ADR-0011,与 env_needed
      // 表单同款的多选协议),不走单码分派。
      return this.resolveSkillSelection(live, gate, input);
    }
    const route = stageGateRoute(gate.kind);
    const stageName = (stage: FixedStage): string =>
      fixedStageLabel(state.scenario ?? "ticket", stage);
    const rawDecision = input.decision?.trim() ?? "";
    const notes = input.notes?.trim() ?? "";
    let code = input.code?.trim() ?? "";
    // 证据回灌闸的主通道是自由文本:只贴了原文没带码也算作答(码从
    // 文本在场归码)——前端证据卡提交"文本+码",直调/旧客户端只给
    // 文本时同样受理,不留死协议口。
    if (gate.kind === "pipeline_evidence" && !code
        && (rawDecision || notes)) {
      code = "supply";
    }
    // env_verify 的自定义答复归码:没带 fail 码但带了文本(卡上
    // 「自定义答复」通道,前端不发明码)按等待中的插话受理;连文本
    // 都没有的认不得码照旧打回,不留乱码冒充插话的门。
    if (gate.kind === "env_verify" && code !== "fail"
        && (rawDecision || notes)) {
      code = "note";
    }
    // 显示语义的 decision:提交带了人话就原样用;只带码就从码表反查;
    // 认不得的码原样示人(409 的现场账要能看到交上来的到底是什么)。
    const decision = rawDecision
      || (code ? gateOptionLabel(gate.kind, code) : "");
    const supplement = notes ? `\n用户补充说明: ${notes}` : "";
    // 先裁决后动手:认不得的答复在状态未动前打回(不留下"闸已清、
    // 转移已记"的半截账)。
    const verdict = gateVerdict(gate.kind, code);
    if (gate.kind === "pipeline_evidence" && !(rawDecision || notes)) {
      // 证据卡的特殊空答:码到了但原文没贴——卡片协议要的是文本本体,
      // 选项标签不是证据,专项打回并把要求说全。
      throw new IssueControlError(
        "请把平台上失败项的报错原文(带文件/行号/堆栈)粘贴进作答再提交"
          + "——空答复无法作为修复证据");
    }
    if (verdict === "unrecognized") {
      throw new IssueControlError(
        `无法识别的验证答复:「${decision.slice(0, 40)}」,请通过问题卡的选项作答`);
    }
    if (verdict === "note") {
      // env_verify 的自定义答复:验证等待中用户有话要说(如 MR 冒出
      // 合并冲突要处理——答「发现问题」是回退重修,与事实不符;通过
      // 又是沉默等合入,没处说话)。按等待中的插话处理(与检视意见
      // 插话同机制):开一回合把话递给 AI,闸保持原样——回合收口时
      // 闸在场仍定格等待;处理完卡还在,继续等合入,仍可改答「发现
      // 问题」。
      recordTransition(state, {
        source: "platform",
        note: `用户插话(验证等待中): ${(rawDecision || notes).split("\n")[0]}`,
      });
      saveState(live.root, state);
      // 闸没清,问句半边仍在 issue.json,human_decision 只补答半边、
      // 不带问句快照——与闸答清卡的那几路不同。
      this.appendSessionEvent(live, "human_decision", {
        waiting_id: gate.id,
        state_version: gate.state_version,
        decision: rawDecision || notes,
        ...(rawDecision && notes ? { notes } : { notes: "" }),
      });
      this.continueTurn(live, promptCopy("notices", "gate.verify.note", {
        text: [rawDecision, notes].filter(Boolean).join("\n"),
      }));
      return this.summarize(state);
    }
    delete state.gate;
    recordTransition(state, {
      source: "platform",
      note: `用户作答(${gate.kind}): ${decision.split("\n")[0]}${notes ? `;补充: ${notes.split("\n")[0]}` : ""}`,
    });
    // 闸作答补记 human_decision:CONTEXT 对"现场记录"的定义是"事件流
    // 含用户决策",而闸作答此前只进转移账,过程问答(事件账本投影)里
    // 固定流程的关键问答会缺用户那一半。失败 fail-open:账少一条不挡
    // 闸裁决——闸的真相在 issue.json,事件账是投影不是第二状态机。
    // 问句快照随事件落账(ADR-0008):闸答完即从 issue.json 消失,
    // 历史闸的"问"半边投影时无处合成,只能在这里随事件走。
    this.appendSessionEvent(live, "human_decision", {
      waiting_id: gate.id,
      state_version: gate.state_version,
      decision,
      ...(notes ? { notes } : { notes: "" }),
      gate: {
        kind: gate.kind,
        questions: gate.question.questions.map((item) => ({
          question: item.question,
          options: item.options.map((option) => option.label),
        })),
      },
    });

    if (verdict === "advance") {
      // analysis_confirm 确认:推进到注册表声明的 confirmTo。
      const target = route?.confirmTo;
      if (!target) {
        throw new IssueControlError(
          "阶段注册表缺少分析确认闸的推进目标(阶段配置错误)");
      }
      delete state.review_active;
      fixedAdvance(state, target,
        `用户确认分析报告,进入${stageName(target)}`);
      saveState(live.root, state);
      // 报告指针钉进推进通知词(必达通道):通知词是 fix 回合的开场,
      // 压缩再多次它都在最新回合里;fix 阶段的压缩锚也带同一指针。
      const pointer = this.analysisReportPointer(live);
      this.continueTurn(live, fixedAdvanceNotice(state,
        promptCopy("notices", "gate.analysis_confirm.confirm", {
          stage: stageName(target),
          supplement,
          report_path: pointer.path,
          plan: pointer.plan,
        })));
      return this.summarize(state);
    }

    if (verdict === "archive") {
      // conclude 闸收口(ADR-0048):确认是问题与非问题都直接闭环归档
      // ——挂起与转正退役,确认是问题即终态,当场产出提单模板(研究
      // 成果以模板文本穿过 DTS 系统带到下一个有单会话);非问题也留
      // 报告留痕。模板写盘 fail-open:失败不挡归档,读侧 404 如实。
      const isIssue = code === "issue";
      if (isIssue) {
        try {
          writeTicketTemplate(live.root, state);
        } catch (error) {
          this.log(`[issue-flow] ${live.id} 提单模板生成失败(归档不受阻): ${String(error)}`);
        }
      }
      const now = new Date().toISOString();
      fixedComplete(state, isIssue
        ? "结论:是问题,已闭环归档(提单模板已出)"
        : "结论:非问题,已闭环归档");
      state.conclusion = {
        kind: isIssue ? "issue" : "non_issue",
        summary: gate.proposal?.summary
          ? `${gate.proposal.summary}${notes ? `;${notes}` : ""}`
          : decision,
        at: now,
      };
      state.status = "archived";
      saveState(live.root, state);
      this.releaseDriver(live);
      this.stopContainerInBackground(live, isIssue ? "问题归档" : "非问题归档");
      this.finishTerminalHygiene(live);
      this.log(`[issue-flow] ${live.id} 结论${isIssue ? "是问题(提单模板已出)" : "非问题"},已闭环归档`);
      return this.summarize(state);
    }

    if (verdict === "fail") {
      // env_verify 不通过:回退问题分析(轮次+1,回退细节在 fixedRollback)。
      // 打回也是报告重写的来源(与检视修改型同账):回退前把当时的报告
      // 冻结成版本,AI 重写后 live 即新版;报告最终没改则与快照同文,
      // 读侧去重不出假版本。报告不在场/写失败不挡回退(fail-open)。
      const reason = notes || decision;
      snapshotAnalysisVersion(live.root);
      fixedRollback(state,
        `${VERIFY_FAIL_NOTE_PREFIX}:${reason.split("\n")[0]}`);
      saveState(live.root, state);
      this.continueTurn(live, fixedAdvanceNotice(state,
        promptCopy("notices", "gate.verify.fail", {
          round: state.round ?? 1,
          reason: supplement || `\n用户描述: ${reason}`,
        })));
      return this.summarize(state);
    }

    if (verdict === "resume_watch") {
      // pipeline_unfixable 已答「已在平台处理/豁免」:重置该仓监看账
      // (deadline 重置、watching=true、清上一轮红灯账)并重新监看同一
      // SHA——平台侧已处理则这次就绿(走 success 终态处理:提醒重新申报/
      // 进验证),仍红则重新走分诊(可能变成可修,照常派回合;仍不可修
      // 则再次举卡)。补充说明非空必须开回合带话(ADR-0049,#368):卡上
      // 选项装不下指令,真指令(如「回退 C++ 改用 JS」)只写在补充说明
      // 里,只进账本不开回合等于用户没说——AI 先按补充说明处置,监看器
      // 自然跟到新提交;为空(纯确认)维持不开回合,落 idle 等监看结果。
      // 两路监看都照挂,竞态由忙时转投与「头已变丢弃旧结果」既有守卫兜。
      const target = gate.pipeline;
      if (!target) {
        throw new IssueControlError("闸缺少流水线定位(举闸配置错误)");
      }
      const watch = state.pipelines?.[target.repo];
      if (!watch || watch.sha !== target.sha) {
        throw new IssueControlError("流水线监看账已变化,请刷新后重试");
      }
      // 合入短路(#318,ADR-0034):答得出「已在平台处理」,合入往往也
      // 已在平台完成——旧提交的流水线随合入被平台取消,重看它只会再
      // 红一次。合入账全部记了 merged_at 时,按外部事实直接归档收口,
      // 不再重看旧提交;归档的终态/在飞守卫若挡下(罕见窗口),照原路
      // 重看兜底,合入状态循环下一拍自会收口。
      const mrs = state.mrs ?? [];
      if (mrs.length && mrs.every((mr) => Boolean(mr.merged_at))) {
        this.autoArchiveDelivered(live);
        if (isTerminal(state.status)) return this.summarize(state);
      }
      const now = Date.now();
      const { budgetMs } = this.pipelineKnobs();
      watch.status = "running";
      watch.watching = true;
      watch.started_at = new Date(now).toISOString();
      watch.deadline = new Date(now + budgetMs).toISOString();
      delete watch.checks;
      delete watch.last_error;
      // 红灯环账一并清(#247):人在平台处理后的重看是新一轮——刹车账
      // (last_repair_sha)不清会把"重看仍红"误判成同提交刹车,预算账
      // (reds)不清会把举卡轮次越积越多;都归零,重看仍红按新红灯
      // 重新发送、重新计数。
      delete watch.last_repair_sha;
      delete watch.last_failure_summary;
      watch.reds = 0;
      // 延期计数一并清(#372):人工重看是新一轮监看,初始预算重新起算,
      // 旧账上的"已延期一次"不能让新监看失去延期资格,也不能累加。
      delete watch.deadline_extensions;
      const supplement = (notes ?? "").trim();
      if (supplement) {
        // 带话开回合:状态不落 idle——回合在飞,runTurn 自管状态。
        state.stage_note = `已按人工答复重新监看流水线(${target.repo})`
          + `@ ${target.sha.slice(0, 12)};用户补充: `
          + `${supplement.split("\n")[0].slice(0, 80)}`;
        saveState(live.root, state);
        this.log(`[issue-flow] ${live.id} 不可修闸已答带补充说明,重置监看账`
          + `(${target.repo}) @ ${target.sha.slice(0, 12)},开回合带话`);
        void this.watchPipeline(live, target.repo, target.sha);
        this.continueTurn(live, promptCopy("notices", "gate.resume.notes", {
          repo: target.repo,
          sha: target.sha.slice(0, 12),
          notes: supplement,
        }));
        return this.summarize(state);
      }
      state.status = "idle";
      state.stage_note = `已按人工答复重新监看流水线(${target.repo})`
        + `@ ${target.sha.slice(0, 12)},等结果`;
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 不可修闸已答,重置监看账`
        + `(${target.repo}) @ ${target.sha.slice(0, 12)}`);
      void this.watchPipeline(live, target.repo, target.sha);
      return this.summarize(state);
    }

    if (verdict === "human_evidence") {
      // pipeline_evidence 已贴原文:原文作为人工证据注入下一修复回合
      // (回合文案带「人工从平台回灌的报错原文」段),该轮才消耗修复轮
      // 预算(reds+1,与"派了回合才记账"同口径);续跑走 continueTurn
      // → beginTurn,与全部闸作答同一并发语义。预算已耗尽就不再派回合
      // ——证据已入账(human_decision 事件+转移账),诚实停机请人工。
      const target = gate.pipeline;
      if (!target) {
        throw new IssueControlError("闸缺少流水线定位(举闸配置错误)");
      }
      const watch = state.pipelines?.[target.repo];
      if (!watch || watch.sha !== target.sha) {
        throw new IssueControlError("流水线监看账已变化,无法按原闸回灌证据");
      }
      const evidence = rawDecision || notes;
      const max = repairBudget(this.options.settings);
      // 预算不再在此记(#247):发送回合(AI 判断证据缺口、举卡的那一
      // 回合)已经是本轮修复回合,reds 在发送时已 +1;人贴原文后的
      // 回灌回合是同一轮的延续,不重复计数、也不设预算闸——人亲自
      // 供给的证据,没有"空转"可防。
      const reds = watch.reds ?? 0;
      const dims = failedDimensionLabels(watch.checks);
      // 刹车账照写(票 82 口径):人工回灌的原文就是"上轮报错",AI 修
      // 完没出新提交再红灯时刹车要认账。
      const previousSha = watch.last_repair_sha;
      const previousSummary = watch.last_failure_summary;
      watch.last_repair_sha = target.sha;
      watch.last_failure_summary =
        `人工回灌的报错原文(节选): ${evidence.slice(0, 500)}`;
      this.log(`[issue-flow] ${live.id} 证据回灌闸已答(${target.repo}),`
        + `第 ${reds}/${max} 轮修复(延续,不重复计数)`);
      saveState(live.root, state);
      this.continueTurn(live, [
        promptCopy("notices", "gate.evidence.header",
          { repo: target.repo, reds, max }),
        promptCopy("notices", "gate.evidence.dims", { dims }),
        "",
        promptCopy("notices", "gate.evidence.source"),
        evidence,
        "",
        ...(watch.checks?.length
          ? [describePipelineRun({ status: watch.status, checks: watch.checks }),
            ""]
          : []),
        ...(previousFailureLines(previousSha, previousSummary)
          .flatMap((line, index) => index === 0 ? ["", line] : [line]), ""),
        promptCopy("notices", "gate.evidence.tail"),
      ].join("\n"));
      return this.summarize(state);
    }

    // verdict === "rework":补充意见/自由作答。两类闸的去向不同——
    // analysis_confirm 留在分析阶段完善重提;conclude 重置回分析继续查证。
    if (gate.kind === "conclude") {
      const owner = route?.stage;
      if (!owner || !route?.reworkTo) {
        throw new IssueControlError(
          "阶段注册表缺少结论闸的归属阶段或回流目标(阶段配置错误)");
      }
      const ownerIndex = state.scenario
        ? fixedStageIndex(state.scenario, owner) : -1;
      if (ownerIndex >= 0
          && (state.stage_states?.[ownerIndex] ?? "pending") !== "pending") {
        (state.stage_states ??= [])[ownerIndex] = "pending";
      }
      const rework = route.reworkTo;
      fixedAdvance(state, rework, "用户对结论有补充意见,继续分析");
      saveState(live.root, state);
      this.continueTurn(live,
        promptCopy("notices", "gate.conclude.rework",
          { stage: stageName(rework), decision, supplement }));
      return this.summarize(state);
    }
    // analysis_confirm 的补充意见:留在分析阶段继续完善,改完重新提交。
    state.stage_note = "用户对分析报告有补充意见,继续分析";
    saveState(live.root, state);
    this.continueTurn(live,
      promptCopy("notices", "gate.analysis_confirm.supplement", {
        stage: stageName(state.stage as FixedStage), decision, supplement,
      }));
    return this.summarize(state);
  }

  /** skill 圈选闸的裁决(ADR-0011):selection 必须是闸上 skills path
   * 的子集(浏览器自报路径一律拒绝,与需求侧仓内能力发现同一纪律);
   * 空选=「都不用」,AI 按取用次序自主。选定集合写台账(skill_selection
   * 字段在场=已作答,重走 analyze 不重举的判据),续跑消息带必读清单
   * 与 analyze 阶段简报。留痕与真人作答同形:human_decision 事件带
   * 问句快照与勾选结果,转移账记人话。 */
  private resolveSkillSelection(
    live: LiveIssue,
    gate: IssueGate,
    input: { decision: string; code?: string; selection?: string[]; notes?: string },
  ): IssueSummary {
    const { state } = live;
    const offered = new Map((gate.skills ?? []).map((skill) =>
      [skill.path, skill]));
    const selection = [...new Set((input.selection ?? [])
      .map((path) => String(path).trim()).filter(Boolean))];
    const unknown = selection.filter((path) => !offered.has(path));
    if (unknown.length) {
      throw new IssueControlError(
        `勾选了清单之外的 skill 路径:${unknown.join("、")}`
          + "——只能勾选问题卡上列出的项");
    }
    const skills = selection.map((path) => offered.get(path)!);
    const decision = input.decision?.trim()
      || (skills.length
        ? `圈选必读 skill:${skills.map((skill) => skill.name).join("、")}`
        : gateOptionLabel("skill_select", "skip"));
    const notes = input.notes?.trim() ?? "";
    state.skill_selection = { at: new Date().toISOString(), skills };
    delete state.gate;
    recordTransition(state, {
      source: "platform",
      note: `用户作答(skill_select): ${decision.split("\n")[0]}`
        + `${notes ? `;补充: ${notes.split("\n")[0]}` : ""}`,
    });
    this.appendSessionEvent(live, "human_decision", {
      waiting_id: gate.id,
      state_version: gate.state_version,
      decision,
      ...(notes ? { notes } : { notes: "" }),
      gate: {
        kind: gate.kind,
        questions: gate.question.questions.map((item) => ({
          question: item.question,
          options: item.options.map((option) => option.label),
        })),
        ...(gate.skills ? {
          offered: gate.skills.map((skill) => `${skill.repo} → ${skill.name}`),
        } : {}),
      },
      ...(skills.length ? {
        selection: skills.map((skill) => skill.path),
      } : {}),
    });
    saveState(live.root, state);
    const lines = skills.length
      ? ["用户已圈选以下业务 skill 为**必读**(分析前先读;"
          + "路径相对会话工作区):",
        ...skills.map((skill) =>
          `- ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`),
        "读完它们再继续问题分析;读完仍可按方法论取用次序补充其他材料。"]
      : ["用户未圈选任何业务 skill——按方法论取用次序自主定位"
          + "(业务仓 .cac/skills 与 .agents/skills、货架通用 skill、"
          + "issue-analysis 自力定位)。"];
    this.continueTurn(live, [
      ...lines,
      "",
      fixedAdvanceNotice(state,
        `用户已完成 skill 圈选,继续「${fixedStageLabel(
          state.scenario ?? "ticket", state.stage as FixedStage)}」阶段。`
        + (notes ? `\n用户补充说明: ${notes}` : "")),
    ].join("\n"));
    return this.summarize(state);
  }

  reply(id: string, text: string): IssueSummary {
    const live = this.require(id);
    const status = live.state.status;
    if (status === "waiting_user") {
      throw new IssueControlError("会话在等你对问题卡的答复,请回答问题卡而不是发消息");
    }
    if (status === "queued") {
      throw new IssueControlError("首轮研究还在排队启动,请稍候再发消息");
    }
    if (status === "running" || this.turning.has(live.id)) {
      throw new IssueControlError("会话正在运行,请用「补充」(运行中输入会在当前步骤完成后送达)");
    }
    if (isTerminal(status)) {
      throw new IssueControlError(`会话已${status === "archived" ? "归档" : "结束"},不能再续聊`);
    }
    let content = text?.trim();
    if (!content) throw new IssueControlError("消息内容不能为空");    this.promoteMessageImages(live, content);
    // 收口后返工(ADR-0013):流程终点是 MR 跑绿,收口态(idle+阶段
    // done)下用户续聊 = "还没修好",重开当前阶段让 AI 继续修——归档
    // 之前都能继续,可多轮(修完重推再申报,验绿门重新受理)。不在
    // 场景路线里的存量现场(fixedStageIndex -1)不重开。轮次账不动:
    // 这不是回退,分支与 MR 延用,现场记录本就连续。
    if (live.state.scenario && live.state.status === "idle") {
      const index = fixedStageIndex(
        live.state.scenario, live.state.stage as FixedStage);
      if (index >= 0 && live.state.stage_states?.[index] === "done") {
        live.state.stage_states![index] = "in_progress";
        recordTransition(live.state, {
          source: "platform",
          note: `用户续聊返工,重开「${fixedStageLabel(
            live.state.scenario, live.state.stage as FixedStage)}」阶段`,
        });
        saveState(live.root, live.state);
      }
    }
    this.continueTurn(live, content);
    return this.summarize(live.state);
  }

  steer(id: string, text: string): IssueSummary {
    const live = this.require(id);
    const content = text?.trim();
    if (!content) throw new IssueControlError("补充内容不能为空");
    this.promoteMessageImages(live, content);
    if (live.state.status !== "running" || !live.driver) {
      throw new IssueControlError("会话不在运行中,补充无处送达");
    }
    void live.driver.steer(`${content}\n\n${concurrentWorkPrompt()}`, { display: content }).catch(() =>
      this.parkPlatformNotice(live, `${content}\n\n${concurrentWorkPrompt()}`));
    return this.summarize(live.state);
  }

  // ---- 人工接管(2026-09-07 走查拍板):打断 AI/期间人工记录/交还继续 ----

  /** 接管=打断 AI:当前回合 abort(只掐回合,现场 CloudSession 保留,
   * 交还后续聊免重建),状态定格 idle、现场交由人工。takeover 标记
   * **必须在 abort 之前落盘**——被捏死的回合稍后走到 settle/catch,
   * 两处的让路守卫靠它在场识别"这是接管,不是失败"。等待中的问题卡
   * (waiting_user)不是 AI 在干活,先答卡。 */
  takeover(id: string): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    if (state.takeover) {
      throw new IssueControlError("已在人工接管中");
    }
    if (isTerminal(state.status)) {
      throw new IssueControlError("会话已结束,不能接管");
    }
    if (state.status === "waiting_user") {
      throw new IssueControlError("先作答当前问题卡再接管");
    }
    const previous = state.status;
    const wasRunning = previous === "running";
    state.takeover = { at: new Date().toISOString(), by: state.account };
    recordTransition(state, {
      source: "platform",
      note: "人工接管:AI 回合中止,现场交由人工",
    });
    state.status = "idle";
    state.stage_note = "人工接管中——AI 已暂停,交还后带着人工记录继续";
    saveState(live.root, state);
    this.log(`[issue-flow] ${id} 人工接管(原状态 ${previous}${wasRunning
      ? ",回合中止" : ""})`);
    if (wasRunning) {
      // 异步 abort:接口即刻回执,不等模型侧收束;abort 完成后再落盘
      // 一次,压住被中止回合 settle/catch 与本状态之间的收尾竞态。
      void (async () => {
        await live.driver?.abort().catch(() => undefined);
        saveState(live.root, state);
      })();
    }
    return this.summarize(state);
  }

  /** 接管期间的人工操作记录:只记账不投喂 AI——事件账本追加一条
   * via=takeover 的 user_message,协作流照常以插话气泡回放;正文在
   * 交还(resumeFromTakeover)时才随续聊词回灌模型。 */
  addTakeoverNote(id: string, text: string): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    if (!state.takeover) {
      throw new IssueControlError("不在人工接管中,无处记录人工操作");
    }
    const content = text?.trim();
    if (!content) throw new IssueControlError("记录内容不能为空");
    this.appendSessionEvent(live, "user_message",
      { text: content, via: "takeover" });
    return this.summarize(state);
  }

  /** 交还:AI 带着人工记录继续。从事件账本收齐接管期(via=takeover
   * 且 ts ≥ 接管时刻)的全部人工记录,拼进交接词照 reply() 的回合
   * 模式续跑——现场 driver 在场直递续聊,进程重启后重建现场以同一句
   * 开回合(记录在账本里,重建也不丢)。 */
  resumeFromTakeover(id: string, input?: { note?: string }): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    if (!state.takeover) {
      throw new IssueControlError("不在人工接管中,无从交还");
    }
    if (state.status === "running" || this.turning.has(live.id)) {
      throw new IssueControlError("上一回合还在收尾,请稍候再交还");
    }
    const since = state.takeover.at;
    const notes = readConversationEvents(join(live.root, "events.jsonl"))
      .filter((event) => event.kind === "user_message"
        && event.payload?.via === "takeover"
        && String(event.ts ?? "") >= since)
      .map((event) => String(event.payload?.text ?? "").trim())
      .filter((text) => text.length > 0);
    const note = input?.note?.trim() || undefined;
    delete state.takeover;
    const message = [
      "人工接管结束,现场交还 AI 继续。",
      ...(note ? [`交还说明:${note}`] : []),
      notes.length
        ? `接管期间的人工操作记录:\n${notes.map((item) => `- ${item}`).join("\n")}`
        : "接管期间无人工操作记录。",
      "人工改动以人的原话为准,先核实现状再继续推进当前阶段。",
    ].join("\n");
    this.log(`[issue-flow] ${id} 交还 AI(接管期人工记录 ${notes.length} 条)`);
    // 与 reply() 同一条续聊咽喉(ensureContainer + 回合前压缩 + 直递/
    // 重建):交还正是"话递进在场会话"的新回合入口,不该绕开压缩节奏。
    this.continueTurn(live, message);
    return this.summarize(state);
  }

  // ---- 人工检视：批量交办，结合当前工作处理 ----

  /** 检视的会话级门槛(记账与提交共用):固定流程、未终态、分析段
   * 不是转正继承——转正继承的分析报告是上一会话已确认的结论,
   * 重跑会污染继承账(ADR-0007 拍板的边界)。 */
  private requireReviewable(live: LiveIssue): void {
    const { state } = live;
    if (!state.scenario) {
      throw new IssueControlError(
        "检视重跑只支持固定流程会话(请直接发消息补充意见)");
    }
    if (isTerminal(state.status)) {
      throw new IssueControlError("会话已结束,不能再检视");
    }
    const analyzeIndex = fixedStageIndex(state.scenario, "analyze");
    if (analyzeIndex >= 0
        && (state.stage_states?.[analyzeIndex] ?? "") === "inherited") {
      throw new IssueControlError(
        "转正继承的分析报告不可检视重跑");
    }
  }

  /** 检视面板的数据面:意见清单 + 锚点检测(原文还在/已被改动)+
   * 回合标记。读类,查看模式下登录即可读(写仍仅归属人)。 */
  listReviews(id: string): {
    reviews: Annotation[];
    checks: AnchorCheck[];
    review_active: boolean;
  } {
    const live = this.require(id);
    return {
      reviews: orderAnnotations(reviewStore(live.root).visible()),
      checks: anchorChecks(live.root),
      review_active: live.state.review_active === true,
    };
  }

  /** 记一条检视草稿(悬停圈注的落账口)。作者恒为会话归属人——
   * 问题会话没有协作检视,谁的问题谁提意见。 */
  addReview(id: string, input: {
    line: number; anchor: string; note: string; quote?: string; line_end?: number; context_before?: string; context_after?: string;
  }): Annotation {
    const live = this.require(id);
    this.requireReviewable(live);
    const note = input.note?.trim() ?? "";
    const anchor = input.anchor?.trim() ?? "";
    if (!note) throw new IssueControlError("检视意见不能为空");
    if (!anchor) throw new IssueControlError("缺少原文快照,意见无从定位");
    const line = Number(input.line);
    return addReview(live.root, {
      author: live.state.account,
      quote: input.quote, line_end: input.line_end, context_before: input.context_before, context_after: input.context_after,
      line: Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0,
      anchor,
      note,
    });
  }

  /** 移除一条意见(账本软删,jsonl 留痕)。带外部讨论的,顺手在
   * CodeHub 标已解决(2026-09-18 拍板:忽略=本地扔 + 远端了结)。 */
  dropReview(id: string, reviewId: string): Annotation {
    const live = this.require(id);
    const item = reviewStore(live.root).list().find(note => note.id === reviewId);
    const external = item?.external_review;
    if (!external) this.requireReviewable(live);
    else if (isTerminal(live.state.status) || item?.agent_assigned) throw new IssueControlError("意见已交办或会话已结束");
    const dropped = reviewStore(live.root).drop(reviewId, live.state.account, true);
    if (external) {
      this.enqueueOwnerMrResolve(live, external.discussion_id);
      void this.flushMrReviewReplies(live)
        .catch((error) =>
          this.log(`[issue-flow] ${live.id} 忽略意见的远端标解决发送失败(信箱留痕重试): `
            + String(error instanceof Error ? error.message : error)));
    }
    return dropped;
  }

  updateExternalReview(id: string, reviewId: string, input: { context?: string; reply?: string; resolve_remote?: boolean }): Annotation {
    const live = this.require(id);
    if (isTerminal(live.state.status)) throw new IssueControlError("会话已结束");
    const store = reviewStore(live.root);
    const note = store.list().find(item => item.id === reviewId);
    if (!note?.external_review) throw new IssueControlError("MR 批注不存在");
    if (input.context !== undefined) return store.saveAgentContext(reviewId, live.state.account, input.context);
    if (input.reply !== undefined) {
      const updated = store.replyAsOwner(reviewId, live.state.account, input.reply, true);
      this.enqueueOwnerMrReply(live, note.external_review.discussion_id, input.reply,
        input.resolve_remote === true);
      // 立即投一拍:首发不依赖监看环是否在场(监看只在 mr_green+有 MR
      // 时活着);发送失败留在信箱,监看在场时下一拍自动重试。
      void this.flushMrReviewReplies(live)
        .catch((error) =>
          this.log(`[issue-flow] ${live.id} 责任人答复即时发送失败(信箱留痕重试): `
            + String(error instanceof Error ? error.message : error)));
      return updated;
    }
    throw new IssueControlError("请选择补充要求或自行答复");
  }

  /** 提交检视(ADR-0035 检视分诊):意见送出后交 AI 逐条自判回复型/
   * 修改型。提交只做三件事——意见标记送出、作废挂起的 Agent 问题卡
   * (平台闸不动作废)、意见清单连同分诊准则递给 AI。不再整体回退、
   * 不再置 review_active、不再冻结版本快照:纯回复型批次由 respond_review
   * 原地闭环(不回退、不重跑、不出版本、不再举确认卡),含修改型才由
   * declare_review_rework 触发原回退链路(快照在申报时刻冻结)。
   * 落账 review_submitted 事件——协作流里"这批意见何时送的"靠它。 */
  submitReviews(id: string, ids?: string[]): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    const candidates = reviewStore(live.root).list().filter(item =>
      (ids ? ids.includes(item.id) : !item.external_review) && item.status === "draft" && !item.owner_reply && !item.resolution);
    if (ids && (new Set(ids).size !== candidates.length)) throw new IssueControlError("部分意见已交办或闭环，请刷新");
    if (candidates.some(item => !item.external_review)) this.requireReviewable(live);
    else if (isTerminal(state.status)) throw new IssueControlError("会话已结束");
    if (state.takeover) throw new IssueControlError("现场由你接管中；请交还 Agent 后提交修改意见");
    if (!candidates.length) {
      throw new IssueControlError("没有待提交的检视意见");
    }
    const sent = submitReviewLedger(live.root, ids);
    // 挂起的 Agent 问题卡先作废(有账的撤下,不是替用户作答);冲突
    // 说明卡刚被答过/状态已变,如实打回。平台闸(分析确认/结论确认等)
    // 保持原样不动——分诊不是裁决,待确认状态不因插话消失。
    let supersededCard = false;
    const pendingCard = live.humanGate?.pending()[0];
    if (pendingCard) {
      try {
        live.humanGate.supersede(pendingCard.waiting_id, {
          stateVersion: pendingCard.state_version,
          notes: "用户提交检视意见,本卡作废,意见随分诊回合处理",
        });
        supersededCard = true;
      } catch {
        throw new IssueControlError("问题卡状态已变化,请刷新后重试");
      }
    }
    // 意见清单快照(#366):全部可引用意见落盘 reviews/review-notes.md,
    // 注入回合的正文被上下文压缩/服务重启丢掉后,AI 读文件拿回。
    writeReviewNotesSnapshot(live.root, state.title, state.round ?? 1, "triage");
    const notes = renderReviewNotes(sent, state.title, state.round ?? 1, "triage");
    // 分节注入(ADR-0052):报告意见配报告检视话术(review.triage),
    // MR 检视意见配代码意见话术(review.triage.mr)——通知层把两个域
    // 混成一节,正是 issue-383 里 AI 拿代码意见走报告分诊的根因。
    // 混合批次两节拼接各说各的,不拒绝交办。
    const externals = sent.filter((item) => item.external_review);
    const internals = sent.filter((item) => !item.external_review);
    const sections: string[] = [];
    if (internals.length) {
      sections.push(promptCopy("notices", "review.triage",
        { count: internals.length }));
      sections.push(renderReviewNotes(internals, state.title,
        state.round ?? 1, "triage"));
    }
    if (externals.length) {
      sections.push(promptCopy("notices", "review.triage.mr",
        { count: externals.length }));
      sections.push(renderReviewNotes(externals, state.title,
        state.round ?? 1, "triage"));
    }
    const message = sections.join("\n\n");
    // 平台闸挂起(不论种类)= 用户在等待中插话:开分诊回合把意见递给
    // AI,闸保持原样——回合收口时闸在场仍定格等待(#350:env_verify 卡
    // 可能等很久,检视意见与验证互不相关,停靠到卡答完才送达 AI 就没法
    // 处理);修改型申报回退时 fixedRollback 自会清掉旧闸。
    const gatePending = state.status === "waiting_user" && !!state.gate;
    const receipt = state.status === "queued"
      ? `已接收 ${sent.length} 条检视意见；随任务启动一起送达，不用重复提交。`
      : state.status === "waiting_user" && !gatePending && !supersededCard
      ? `已接收 ${sent.length} 条检视意见；当前问题答复后一起送达，不用重复提交。`
      : `已接收 ${sent.length} 条检视意见；AI 逐条分诊：回复型直接答复，修改型才回退重写。`;
    state.stage_note = receipt;
    saveState(live.root, state);
    this.appendSessionEvent(live, "review_submitted", {
      count: sent.length, text: notes, receipt, mode: "incremental",
    });
    if ((gatePending || supersededCard) && !this.turning.has(live.id)) {
      // 等待的理由已消失(闸不挡插话/卡已作废):开分诊回合。回合仍忙
      // 的窄窗口(卡刚落地未收口)不抢方向盘,走 steer 随行。
      this.continueTurn(live, message);
    } else {
      // 运行中 steer 进当回合(#284 通道不变);排队/接管/无闸无卡的
      // 等待态停靠随行;空闲开新回合——发送咽喉同一。
      this.startPlatformTurn(live, message);
    }
    state.stage_note = receipt;
    saveState(live.root, state);
    return this.summarize(state);
  }

  /** 意见处就地回复(检视回复环,ADR-0035 的下半圈):用户对 AI 的
   * 逐条回应再回复——账本 replyToResponse 落账留档并清空旧回执(球
   * 踢回 Agent),平台只守卫、留痕、唤醒:把完整线程递给 AI,由它对
   * 该意见重新 respond_review。needs_clarification 的补充说明走同一
   * 入口。与提交检视同款边界:平台闸不动作废、保持原样(检视与验证
   * 互不相关,#350);挂起的 Agent 问题卡不替用户作答,答复停靠随卡
   * 答完的续聊送达。 */
  replyToReview(id: string, reference: number | string, text: string): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    if (isTerminal(state.status)) throw new IssueControlError("会话已结束");
    if (state.takeover) {
      throw new IssueControlError("现场由你接管中；请交还 Agent 后再回复检视意见");
    }
    const reply = String(text ?? "").trim();
    if (!reply) throw new IssueControlError("回复不能为空");
    const store = reviewStore(live.root);
    // 按意见号或台账 id 定位一条已送出的检视意见(口径同 respond_review)。
    const items = store.list().filter((item) =>
      item.status === "sent" && item.sent_via === "issue_review");
    const match = typeof reference === "number" || /^\d+$/.test(String(reference))
      ? items.find((item) => item.seq === Math.trunc(Number(reference)))
      : items.find((item) => item.id === String(reference).trim());
    if (!match) throw new IssueControlError("没有找到这条已提交的检视意见");
    // 账本的打回(没回应可回/上一条回复还没被处理)是人话控制反馈,
    // 转 IssueControlError 落 409,不进未登记错误族的 500。
    let updated: Annotation;
    try {
      updated = store.replyToResponse(match.id, reply, live.state.account);
    } catch (error) {
      if (error instanceof AnnotationError) {
        throw new IssueControlError(error.message);
      }
      throw error;
    }
    const receipt = `已把你对意见${match.seq} 的回复递给 AI；它会在该意见处再答复。`;
    state.stage_note = receipt;
    saveState(live.root, state);
    this.appendSessionEvent(live, "user_message", {
      text: `回复了意见${match.seq}`, via: "review_reply",
    });
    const message = [
      promptCopy("notices", "review.reply"),
      renderReviewThread(updated),
    ].join("\n\n");
    const gatePending = state.status === "waiting_user" && !!state.gate;
    if (gatePending && !this.turning.has(live.id)) {
      this.continueTurn(live, message);
    } else {
      // 运行中 steer 进当回合;等卡/空闲停靠随行或开新回合——发送咽喉同提交检视。
      this.startPlatformTurn(live, message);
    }
    state.stage_note = receipt;
    saveState(live.root, state);
    return this.summarize(state);
  }

  // ---- 台面动作 ----

  bindTicket(id: string, ticket: string): IssueSummary {
    this.require(id);
    const value = ticket?.trim() ?? "";
    if (!TICKET_PATTERN.test(value)) {
      throw new IssueControlError("单号只能是字母数字下划线连字符");
    }
    // 固定流程的会话不直接绑定单号(ADR-0048:有单会话发起即带单号,
    // 无单会话确认是问题即闭环归档出提单模板,关联/绑定不复存在):
    // 端点保留报错口径,兜住存量调用方。
    throw new IssueControlError(
      "固定流程的会话不直接绑定单号:有单会话发起即带单号;无单会话确认是"
        + "问题即闭环归档并产出提单模板(研究成果带到下一个有单会话)");
  }

  async control(id: string, input: {
    action: "cancel" | "revive";
    /** 异常重跑(ADR-0055)可附的操作者说明,随恢复回合必达送达 AI。 */
    note?: string;
    /** 终止原因(#541):cancel 动作伴生的独立入参(不复用 revive 的
     * note);缺席=无原因取消(历史路径),行为与现状一致。 */
    reason?: IssueCancelReason;
    /** 终止补充说明(#541):仅 reason="other" 有意义,选填,落状态文件
     * 备分析;非 other 原因递了也不落。 */
    reasonText?: string;
  }): Promise<IssueSummary> {
    const live = this.require(id);
    if (input.action === "revive") return this.reviveIssue(live, input.note);
    // 终止原因 fail-loud(#541):词表外的值直接拒绝,不静默吞成无原因
    // 取消——落盘前就挡住,脏数据到不了状态文件。报错话术与路由同源
    // (state.ts 常量,#540 复审)。
    if (input.reason !== undefined
      && !ISSUE_CANCEL_REASONS.includes(input.reason)) {
      throw new IssueControlError(ISSUE_CANCEL_REASON_UNKNOWN_ERROR);
    }
    if (isTerminal(live.state.status)
      && live.state.status !== "failed") {
      throw new IssueControlError(`会话已处于终态 ${live.state.status}`);
    }
    // 取消是运行中会话的即时停止出口(turning 不挡),也是 failed 的
    // 出口之一(另一出口异常重跑,ADR-0055,自行守卫)——到这里动作
    // 只剩取消,无需再设状态闸。
    // 先停净再写终态。过去先清 live.container、异步 stop，接口已经回了
    // “取消成功”但 Docker 仍在；失败后也没有句柄可重试。
    const previousStatus = live.state.status;
    live.controlEpoch += 1;
    delete live.state.takeover; // 接管中收口:人工驾驶标记不残留进终态
    // 验证未答就取消:闸随终态清面——"没答"本身是有效选择,
    // 终态不再挂待办(2026-09-10 A 方案拍板的"不锁死"半边)。
    delete live.state.gate;
    try {
      const stopped = await Promise.allSettled([live.driver?.abort(), this.stopContainer(live)]);
      const errors = stopped.flatMap((item) => item.status === "rejected" ? [item.reason] : []);
      // 单一原因直接透传:AggregateError 的 String() 只剩"会话或容器未能
      // 停止",底层的 permission denied 之类真实病因到不了用户眼前。
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "会话或容器未能停止");
      this.releaseDriver(live);
    } catch (error) {
      if (previousStatus === "running") {
        live.state.status = "idle";
        live.state.error = `取消时容器回收失败：${String(error)}`;
        saveState(live.root, live.state);
      }
      throw new IssueControlError(
        `容器未能确认回收，取消尚未完成，请重试：${String(error)}`);
    }
    live.state.status = "canceled";
    // 终止原因(#541):cancel 终态伴生落账,与状态同一笔落盘;说明只跟
    // other 有意义(非 other 递了也不落),trim 由这里兜底。
    if (input.reason) live.state.cancel_reason = input.reason;
    if (input.reason === "other" && input.reasonText?.trim()) {
      live.state.cancel_reason_text = input.reasonText.trim();
    }
    saveState(live.root, live.state);
    // 收口清面(体检 C-H6):闸与未决 Agent 卡不随终态残留——不然
    // 已取消的会话还投影着一张永远答不了的卡。平台闸直接删;
    // Agent 卡逐条 supersede(作废留痕,decision 空串=无人答过)。
    if (live.state.gate) {
      delete live.state.gate;
      saveState(live.root, live.state);
    }
    for (const record of live.humanGate.pending()) {
      try {
        live.humanGate.supersede(record.waiting_id, {
          stateVersion: record.state_version,
          notes: "会话已取消,待办作废",
        });
      } catch (error) {
        this.log(`[issue-flow] ${id} 终态作废待办 ${record.waiting_id} 失败: `
          + String(error instanceof Error ? error.message : error));
      }
    }
    this.finishTerminalHygiene(live);
    // 终止联动单级排除(ADR-0072):完结类原因(词表
    // ISSUE_CANCEL_EXCLUSION_LINK_REASONS,当前=问题已处理/无需处理)断言
    // 这张单不再需要处理——不排除的话,只要 DTS 状态还停在可接状态,
    // 下一拍定时扫描就会重新接走复活(ADR-0070 记录的循环)。有单才联动;
    // 不看责任人开关(是对将来开开关的保险);幂等。其余原因、无原因取消
    // 不联动。终态已落盘,联动失败不回滚取消——取消是不可逆主动作,
    // 不能因伴生标记写失败谎报「取消未完成」,记日志可对账。
    if (live.state.ticket && input.reason
        && ISSUE_CANCEL_EXCLUSION_LINK_REASONS.includes(input.reason)) {
      try {
        setDtsAutoClaimExclusion(
          this.options.dataDir, live.state.ticket, true, live.state.account);
      } catch (error) {
        this.log(`[issue-flow] ${id} 终止联动自动接单排除失败(不回滚取消): `
          + String(error));
      }
    }
    this.log(`[issue-flow] ${id} 取消`);
    return this.summarize(live.state);
  }

  /** 异常重跑(ADR-0055):failed 的第二出口。不取消、不动问题单目录
   * ——分析报告、检视意见、人工决定原文、阶段与轮次账、代码现场原
   * 地全在(它们绑问题单目录,不绑底层会话;failed 又豁免现场回收,
   * repo/ 与 Pi 原生会话文件都在盘上)。恢复回合走 continueTurn:现
   * 场重建后 resumeSession 原样接回底层上下文(与重启自续跑同链),
   * 开场是 revive 通知+操作者说明原文+末条人工决定原文补投。走续聊
   * 而非排队泵:操作者在场显式动作,与用户「继续」同权——排队消息
   * 只在内存,落盘 queued 撞上进程重启会被恢复管线误当登记首轮开场。
   * 异常是黑盒:平台不诊断、不自动重试,确认权在操作者;轮次账不推
   * 高(重跑不是流程倒退,不脏修复轮预算与一次率口径)。 */
  private reviveIssue(live: LiveIssue, note?: string): IssueSummary {
    const { state } = live;
    if (state.status !== "failed" || this.turning.has(live.id)) {
      throw new IssueControlError(
        "异常重跑只适用于已失败的会话;已取消/归档是终态,如需重做请重新发起");
    }
    const operatorNote = note?.trim() ?? "";
    // failed 时冻结的终态快照(ADR-0042)随复活失效:删掉,最终收口
    // 重新冻结——留着会让"只生成一次"的读侧拿 failed 版本当终局。
    const metricsSnapshot = join(live.root, ISSUE_METRICS_FILE);
    if (existsSync(metricsSnapshot)) {
      rmSync(metricsSnapshot, { force: true });
      this.log(`[issue-flow] ${live.id} 异常重跑:终态快照已失效删除`);
    }
    // 状态落 idle(对话开放,同 reply 发消息前的状态);回合跑起来后
    // 页面自然显示进行中。若恢复回合再失败,落回 failed 可再次重跑。
    state.status = "idle";
    delete state.error;
    recordTransition(state, {
      source: "platform",
      note: operatorNote
        ? `操作者确认异常已排除,异常重跑(说明:${operatorNote.slice(0, 160)})`
        : "操作者确认异常已排除,异常重跑,继续推进",
    });
    saveState(live.root, state);
    this.appendSessionEvent(live, "issue_revived", {
      operator_note: operatorNote,
    });
    sessionAudit(live.root, live.id, "decisions", {
      kind: "decision.revive",
      msg: `操作者发起异常重跑:failed 会话原地复活`
        + (operatorNote ? ",附操作者说明" : ""),
      decision: "revive",
      reason_code: "operator-confirmed",
      stage: state.stage, status: state.status,
    });
    // 在途账清理与重启恢复对齐(ADR-0055):崩溃留在窗口里的未定格
    // Agent 卡作废、MR/流水线监看续挂、监看账落后补挂、retry 死账
    // 清理——异常前的在途账不越过复活线带进恢复回合。
    this.rearmInFlightLedgers(live, "异常重跑:", "异常重跑");
    this.log(`[issue-flow] ${live.id} 异常重跑:恢复回合启动`);
    this.continueTurn(live, reviveResumeNotice(operatorNote)
      + recentHumanDecisionNotes(live.root));
    return this.summarize(state);
  }

  /** 终态现场回收(磁盘治理票 01):canceled/archived 的 repo/ 无消费方
   *  (不可续聊,过程记录全保留),后台回收——不阻塞响应(删 GB 级
   *  node_modules 可能要数秒)。首次生成归属(ADR-0044)入队时,回收
   *  挂在通道任务收尾之后(统计窗口与磁盘治理两全);旋钮关=不删。 */
  /** 终态卫生尾巴:凡写 archived/canceled 终态的路径,收尾必须走到
   *  这里——冻结终态快照(ADR-0042,待办作废账落定后)→清理环境凭据
   *  →入队首次生成归属并在算完后回收现场(ADR-0044:响应不等计算,
   *  伴生统计挂后台通道,现场回收为它让路;不入队(伴生已在/不支持
   *  期/无仓)则当场后台回收;崩溃缺口由每小时清扫器兜底)。三处调用:
   *  取消、结论闸闭环归档、交付自动归档(mr_repair 修绿总结轮后的落
   *  终态也汇到 settle 的 archiveMrRepair,同走这里)。漏一处的代价
   *  (#434 实证):单子顶着「待算」等下一轮清扫(最长 1h),凭据等
   *  重启对账才清。停容器同步/异步、通知、提单模板由触发场景决定,
   *  留在各路径。流水线修复会话同规则(ADR-0073 去掉了用途早退)。 */
  private finishTerminalHygiene(
    live: Pick<LiveIssue, "root" | "id" | "state">,
  ): void {
    this.freezeMetricsSnapshot(live);
    try {
      this.vault.remove(live.id);
    } catch (error) {
      // 凭据库只认 issue- 编号;mr-repair-* 会话从无凭据可清(ADR-0073
      // 去掉用途早退后修复会话也走这里),无害,fail-open。
      this.log(`[issue-flow] ${live.id} 环境凭据清理跳过: `
        + String(error instanceof Error ? error.message : error));
    }
    this.reclaimAfterCodeOrigin(live);
  }

  /** 保留期旋钮的通断语义(ADR-0073):0 = 整体禁运;缺席/非 0 = 开。
   *  天数值对问题流不再有意义(当场制),只供需求侧与附件中转 GC 用。 */
  private workspaceRetentionOn(): boolean {
    const value = this.options.settings?.runtime?.()
      ?.workspace_retention_days;
    return !(typeof value === "number" && value === 0);
  }

  private reclaimAfterCodeOrigin(
    live: Pick<LiveIssue, "root" | "id" | "state">,
  ): void {
    const reclaim = (): void => {
      setImmediate(() => {
        // 代码现场:专属路径(开关+标记+事件账),先删——留痕标记
        // repo_reclaimed_at 只有这条路写。
        if (this.repoReclaimOn()) {
          try {
            const bytes = this.reclaimRepoDir(live.root, live.id, live.state);
            if (bytes > 0) {
              this.log(`[issue-flow] ${live.id} 终态现场已回收 `
                + `(${(bytes / 1024 ** 3).toFixed(2)} GB)`);
            }
          } catch (error) {
            this.log(`[issue-flow] ${live.id} 终态现场回收失败(下次清扫重试): `
              + String(error instanceof Error ? error.message : error));
          }
        }
        // 保留名单外当场清(ADR-0073):旋钮 0 整体禁运;repo 已被
        // 上面(或开关关闭时原样保留),本模块跳过它。
        if (this.workspaceRetentionOn()) {
          try {
            this.reclaimLooseEntries(live.root, live.id);
          } catch (error) {
            this.log(`[issue-flow] ${live.id} 名单外当场清失败(下次清扫重试): `
              + String(error instanceof Error ? error.message : error));
          }
        }
      });
    };
    const queued = enqueueCodeOrigin(live.root, live.state, {
      fetchCredential: this.options.gitCredential?.(live.state.account),
    }, { onSettled: reclaim, log: (message) => this.log(message) });
    if (!queued) reclaim();
  }

  /** 保留名单外清理的共享出口(ADR-0073):当场路与兜底清扫同走这一段
   *  ——删除、逐条目事件账(条目名+字节数,漏项对账靠它定位到条)、
   *  日志。repo/ 不归这里(专属路径管)。返回释放字节数。 */
  private reclaimLooseEntries(root: string, id: string): number {
    const result = reclaimIssueWorkspace(root,
      { dataDir: this.options.dataDir });
    if (result.refused) {
      this.log(`[issue-flow] ${id} 名单外清理被边界拦下: ${result.refused}`);
      return 0;
    }
    if (!result.removed.length) return 0;
    this.appendSessionEvent({ root, id }, "workspace_reclaimed", {
      bytes: result.freed,
      scope: "loose",
      entries: result.removed,
    });
    this.log(`[issue-flow] ${id} 清名单外 ${result.removed.length} 项`
      + `(释放 ${humanBytes(result.freed)}): `
      + result.removed.map((entry) => entry.name).join("、"));
    return result.freed;
  }

  // ---- 磁盘治理:终态现场回收与构建产物冷却清理(票 01/03) ----

  private repoReclaimOn(): boolean {
    return (this.options.settings?.runtime?.().issue_repo_reclaim
      ?? ISSUE_REPO_RECLAIM_DEFAULT) !== 0;
  }

  private buildProductsCooldownMs(): number {
    const hours = this.options.settings?.runtime?.()
      ?.issue_build_products_cooldown_hours
      ?? ISSUE_BUILD_PRODUCTS_COOLDOWN_HOURS_DEFAULT;
    return Math.max(0, hours) * 3_600_000;
  }

  /** 终态整仓回收和闲置中间文件清理分别受各自配置控制；同一实例不重叠扫描。 */
  async sweepTerminalRepos(): Promise<{ reclaimed: number; bytes: number;
    productBytes: number; looseBytes: number }> {
    if (this.storageSweepActive) {
      return { reclaimed: 0, bytes: 0, productBytes: 0, looseBytes: 0 };
    }
    this.storageSweepActive = true;
    try {
      return await this.sweepRepos();
    } finally {
      this.storageSweepActive = false;
    }
  }

  private async sweepRepos(): Promise<{ reclaimed: number; bytes: number;
    productBytes: number; looseBytes: number }> {
    try {
      const reclaimed = reclaimCodecheckToolchain(this.options.dataDir, { maxAgeMs: CODECHECK_TOOLCHAIN_MAX_AGE_MS });
      const stats = codecheckToolchainStats(this.options.dataDir);
      if (stats.masters || reclaimed.masters) this.log(`[issue-flow] CodeCheck 工具链母本 `
        + `${stats.masters} 份 (${humanBytes(stats.bytes)})，回收 ${reclaimed.masters} 份 (${humanBytes(reclaimed.bytes)})`);
    } catch (error) {
      this.log(`[issue-flow] CodeCheck 工具链回收或统计失败(下轮重试): ${String(error)}`);
    }
    const productsCooldownMs = this.buildProductsCooldownMs();
    const reclaimOn = this.repoReclaimOn();
    const retentionOn = this.workspaceRetentionOn();
    if ((!reclaimOn && !retentionOn) && productsCooldownMs <= 0) {
      return { reclaimed: 0, bytes: 0, productBytes: 0, looseBytes: 0 };
    }
    let reclaimed = 0;
    let bytes = 0;
    let productBytes = 0;
    let looseBytes = 0;
    for (const name of readdirSync(this.issuesRoot)) {
      if (!name.startsWith(this.idPrefix)) continue;
      const root = join(this.issuesRoot, name);
      // 状态取内存优先:单子在内存时盘面是它的旧投影,拿盘面副本改标记
      // 再落盘,会被内存态的下一次 saveState 整个抹掉(返工通知失灵)。
      const live = this.live.get(name);
      let state = live?.state;
      if (!state) {
        try {
          state = loadState(root);
        } catch {
          continue; // 现场损坏的目录与 recover() 同款隔离,不清扫
        }
      }
      if (!state) continue;
      // 等待中的容器会长期保留，是否正在工作须看回合、辅助会话和命令。
      const terminal = state.status === "canceled" || state.status === "archived";
      if (this.turning.has(name)) continue;
      try {
        if (terminal) {
          // 兜底清扫(ADR-0073):崩溃缺口与存量欠账见一个清一个,不等
          // 保留期。判据与当场制同一把尺子(旋钮/终态/容器),单点住在
          // judgeIssueReclaim——容器探活统一走注册表,不再只看内存句柄。
          const verdict = judgeIssueReclaim(
            { status: state.status },
            { retentionEnabled: retentionOn,
              containerRunning: this.hasRunningContainer(name) });
          if (!verdict.reclaim) continue;
          if (reclaimOn) {
            // 首次生成归属兜底(ADR-0044):现场还在而伴生缺失(进程曾在
            // 归档与算完之间退出),回收前补算一次再删;支持期外的终态
            // 会话不试算。通道在途的由兜底函数自己让路。
            try {
              await backfillCodeOrigin(root, state, {
                fetchCredential: this.options.gitCredential?.(state.account),
              }, (message) => this.log(message));
            } catch (error) {
              this.log(`[issue-flow] ${name} 首次生成归属补算异常(不阻塞回收): `
                + String(error instanceof Error ? error.message : error));
            }
            const size = this.reclaimRepoDir(root, name, state);
            if (size > 0) {
              reclaimed += 1;
              bytes += size;
              this.log(`[issue-flow] ${name} 清扫回收终态现场 `
                + `(${(size / 1024 ** 3).toFixed(2)} GB)`);
            }
          }
          // 保留名单外(ADR-0073):repo 已被上面处理(开关关闭时原样
          // 保留),这里清其余全部——见一个清一个。
          looseBytes += this.reclaimLooseEntries(root, name);
        } else if (productsCooldownMs > 0 && withinDataDir(root, this.options.dataDir)) {
          const cutoff = Date.now() - productsCooldownMs;
          if (!["idle", "waiting_user"].includes(state.status)
              || state.takeover || live?.warmupActive
              || (live && hasAuxiliarySessions(live))
              || live?.container?.hasActiveProcesses
              || !(Date.parse(state.updated_at) <= cutoff)
              || (state.warmup?.finished_at && !(Date.parse(state.warmup.finished_at) <= cutoff))) continue;
          // 从检查到删除完成不 await，新回合只能在删除结束后启动。
          const { bytes: size, directories: removed } = reclaimBuildProducts(join(root, "repo"), cutoff);
          if (removed > 0) {
            state.build_products_reclaimed_at = new Date().toISOString();
            const notice = promptCopy("notices", "rework.products_reclaimed");
            const queue = state.parked_notices ?? (state.parked_notices = []);
            if (!queue.includes(notice)) queue.push(notice);
            // 回收记账不代表用户活动，不能重新开始计算链接库的冷却期。
            saveState(root, state, { preserveUpdatedAt: true });
            this.appendSessionEvent({ root, id: name }, "workspace_reclaimed",
              { bytes: size, scope: "products", directories: removed });
          }
          if (size > 0) {
            productBytes += size;
            this.log(`[issue-flow] ${name} 清扫回收构建产物 `
              + `(${(size / 1024 ** 2).toFixed(0)} MB)`);
          }
        }
      } catch (error) {
        this.log(`[issue-flow] ${name} 清扫失败(下轮重试): `
          + String(error instanceof Error ? error.message : error));
      }
    }
    return { reclaimed, bytes, productBytes, looseBytes };
  }

  /** 回收 repo/ 整个子树:落 repo_reclaimed_at 标记 + 事件账,返回回收
   *  字节数(目录不在场返回 0——幂等,重扫不炸)。 */
  private reclaimRepoDir(root: string, id: string, state: IssueSessionState): number {
    const repoDir = join(root, "repo");
    if (!existsSync(repoDir)) return 0;
    const bytes = treeStats(repoDir).bytes;
    rmSync(repoDir, { recursive: true, force: true });
    state.repo_reclaimed_at = new Date().toISOString();
    saveState(root, state);
    this.appendSessionEvent({ root, id }, "workspace_reclaimed",
      { bytes, scope: "repo" });
    return bytes;
  }

  // ---- 固定流程:流水线监看(阶段6:已申报且全绿才放行换库) ----

  private pipelineKnobs(): { pollMs: number; budgetMs: number } {
    const knobs = this.options.settings?.runtime?.() ?? {};
    return {
      // 流水线一轮至少数分钟，检视/合入监看同样按这个节奏；10 秒轮询
      // 的请求量是必要值的数倍，平台抖动时会把一次故障放大成风暴。
      pollMs: Math.max(1_000, (knobs.poll_interval_s ?? 30) * 1000),
      budgetMs: Math.max(60_000, (knobs.poll_timeout_s ?? 1_800) * 1000),
    };
  }

  /** 同一监看连续失败只记首条全文与每 10 次的计数，避免 500+ 字符的
   * 错误串每轮灌日志。 */
  private readonly failureLog = new ConsecutiveFailureLog(message => this.log(message));

  /** MR 建成即挂表监看:触发流水线 → 轮询到终态。绿→已申报则自动进
   * 换库验证(未申报则提示 AI 申报);红→携失败项开回合让 AI 修
   * (同分支再推,MR 自动跟新提交)。幂等:同 SHA 在盯则跳过
   * (MR 幂等重建会重复触发本钩子)。 */
  /** 新事实使在场旧卡过期时的撤卡(#374):卡是平台对用户的断言,
   *  断言被推翻就撤下——是撤卡,不是替用户作答,作答账照旧走 answer。
   *  范围(2026-09-22 拍板):
   *  - 环境验证卡的断言是全局的(「均已通过,请验证」),任何仓的新
   *    提交/红灯都推翻它;
   *  - 红灯人工两卡断言的是特定提交的红灯,只有同仓换新提交才作废
   *    (作答按提交定位续看,提交被取代后必打回「监看账已变化」——
   *    留着是僵尸卡);跨仓红灯不推翻它,卡照常等人,新事实停靠随卡
   *    答完送达。新提交红灯落账后重举前置即满足,撤卡不丢终局。
   *  撤卡动作与 autoArchiveDelivered 清面同款:清 gate、作废等待待办、
   *  等人回落空闲、转移账留痕。stage_note 不动——守闸器欠卡判据按
   *  收口说明常量认现场(#248),动了它绿灯真空(新推送跑绿后没人
   *  补举)就永远没人喊。parked_notices 原样保留(续聊照常注入)。
   *  落盘点:armPipelineWatch 换 SHA(推送/重启补挂同函数)+ 
   *  settlePipeline 红灯终态(兜住恢复直挂续表与「推送后 AI 同回合
   *  补举」的窗口——raise_gate 前置只查收口不查在途流水线)。
   *  调用方负责 saveState。 */
  private dismissStaleGate(
    live: LiveIssue,
    repo: string,
    sha: string,
    cause: "push" | "red",
  ): void {
    const { state } = live;
    const gate = state.gate;
    if (!gate || isTerminal(state.status)) return;
    if (gate.kind !== "env_verify"
        && !(gate.pipeline && gate.pipeline.repo === repo
          && gate.pipeline.sha !== sha)) {
      return;
    }
    const gateName = gate.kind === "env_verify" ? "环境验证卡"
      : gate.kind === "pipeline_unfixable" ? "流水线不可修告警卡"
      : "流水线报错回灌卡";
    const note = cause === "push"
      ? `新提交 ${sha.slice(0, 12)} 使${gateName}过期撤下——断言的旧事实不再成立`
      : `流水线红灯(${repo} @ ${sha.slice(0, 12)})使${gateName}过期撤下`
        + "——失败事实改送 AI 修复";
    delete state.gate;
    if (state.status === "waiting_user") state.status = "idle";
    recordTransition(state, { source: "platform", note });
    const pending = live.humanGate.pending()[0];
    if (pending) {
      try {
        live.humanGate.supersede(pending.waiting_id, {
          stateVersion: pending.state_version,
          notes: cause === "push"
            ? "流水线新提交使本卡过期作废" : "流水线红灯使本卡过期作废",
        });
      } catch (error) {
        this.log(`[issue-flow] ${live.id} 撤卡作废待办 `
          + `${pending.waiting_id} 失败: `
          + String(error instanceof Error ? error.message : error));
      }
    }
    this.log(`[issue-flow] ${live.id} ${gateName}过期撤下`
      + `(${cause === "push" ? "新提交" : "红灯"} @ ${repo} ${sha.slice(0, 12)})`);
  }

  armPipelineWatch(live: LiveIssue, repo: string): void {
    const state = live.state;
    const platformUrl = this.options.platformUrl;
    // 已有 MR 先准备原分支工作区，再检查报错；恢复补挂也遵守同一顺序。
    if (state.imported_mr) {
      const workspace = issueRepoWorkspaces(state, live.root).find(item => item.url === repo);
      if (!workspace || !existsSync(join(workspace.dir, ".git"))) return;
    }
    const sha = state.pushes?.find((item) => item.repo === repo)?.sha
      ?? (state.imported_mr?.repo === repo ? state.imported_mr.sha : undefined);
    if (!platformUrl || !sha) return;
    // 返工轮没人启动合入状态循环(#319):这条循环原先只在 mr_green
    // 收口和进程重启恢复时启动。环境验证不通过回退后,第二轮重新进
    // mr_green 时既不会收口也没重启,MR 被人在平台上提前合入的事实
    // 就一直没人记账,要等下次重启才补上。挂流水线监看的启动点(MR
    // 建成、已有 MR 的仓再推送、重启补挂)到这里时顺手把它一并启动;
    // 放在同 SHA 跳过判定的前面,幂等重建 MR 重复触发的重挂也能补上。
    // 幂等依据:watchMergeStates 有单例挡板(mergeWatchers),循环
    // 已在跑直接返回,不会出现第二条并行循环;台账上还没有 MR 记录的
    // 会话不启动,保持「有 MR 才监看」。
    if (state.mrs?.length) this.watchMergeStates(live);
    const watching = state.pipelines?.[repo];
    if (watching?.watching && watching.sha === sha) return;
    if (watching?.sha && watching.sha !== sha) {
      this.resolveIssuePipelineFeedback(live, repo, "addressed",
        `已产生新提交 ${sha.slice(0, 12)}，等待新流水线核验`);
      // 新推送使旧卡过期就撤(#374,见 dismissStaleGate):全绿/红灯
      // 断言都绑定提交,推送即过期,不等结果。
      this.dismissStaleGate(live, repo, sha, "push");
    }
    const now = Date.now();
    const { budgetMs } = this.pipelineKnobs();
    (state.pipelines ??= {})[repo] = {
      sha,
      status: "running",
      watching: true,
      started_at: new Date(now).toISOString(),
      deadline: new Date(now + budgetMs).toISOString(),
      round: state.round ?? 1,
      // 红灯计数跨 SHA 累计(绿了才清零):修复轮预算是每仓总量,
      // 换 SHA 不重置——与需求侧修复环"同任务总量"同一口径。
      ...(watching?.reds ? { reds: watching.reds } : {}),
      // external_head(ADR-0041)不随迁:这里挂的 sha 取自推送账,是
      // 本会话自己推的提交——自己的推送天然不是平台外的,标记清除。
      // 刹车账跨重挂表保留(票 82):同 SHA 重推/重建 MR 后重看,刹车
      // 判据(last_repair_sha)必须活着;证据重试窗字段不随迁——新提交
      // 是新流水线,旧窗随旧提交作废。
      ...(watching?.last_repair_sha
        ? { last_repair_sha: watching.last_repair_sha } : {}),
      ...(watching?.last_failure_summary
        ? { last_failure_summary: watching.last_failure_summary } : {}),
    };
    recordTransition(state, {
      source: "platform",
      note: `流水线监看已启动(${repo})@ ${sha.slice(0, 12)}`,
    });
    saveState(live.root, state);
    void this.watchPipeline(live, repo, sha);
  }

  private async watchPipeline(
    live: LiveIssue,
    repo: string,
    sha: string,
  ): Promise<void> {
    const { state } = live;
    const platformUrl = this.options.platformUrl;
    if (!platformUrl) return;
    // MR 检视意见监看(票 01:发现与落账)与流水线监看并行启动;
    // 自身单例、fail-open,详见 watchMrDiscussions。
    this.watchMrDiscussions(live);
    const { pollMs } = this.pipelineKnobs();
    const call = () => ({
      platformUrl,
      sha,
      repo,
      // 状态命令模板可能引用 {mr},缺了每轮 502、监看永远等不到绿
      // (2026-08-28 真实环境事故)。iid 按 repo 现查现用——MR 重建后
      // 下一轮自然带上新 id。
      mr: state.mrs?.find((item) => item.repo === repo)?.iid,
      credential: this.options.gitCredential?.(state.account),
    });
    // 过期结果防御(票 107,对齐需求侧 selectTerminalRun 的「过期结果,
    // 拒绝背书」):重推换 SHA 后、新 run 注册前,平台账面最新可能还是旧
    // 提交的终态红——裸取最新 run 按终态处理会把新监看账定格 failed、
    // watching=false,真绿灯再没人看。给了 run 级 sha/is_valid 才核验
    // (老适配层缺席=无过期结果信息,维持旧行为)。拒绝只记一次:轮询
    // 每秒一轮,轮轮记就是日志噪声。
    let staleLogged = false;
    const rejectStale = (run: PipelineRun): boolean => {
      const reason = typeof run.sha === "string" && run.sha && run.sha !== sha
        ? `run 绑定 ${run.sha.slice(0, 12)} ≠ 当次提交 ${sha.slice(0, 12)}`
        : run.is_valid === false
        ? "is_valid=false(MR 头上挂的是过期结果)"
        : undefined;
      if (!reason) return false;
      if (!staleLogged) {
        staleLogged = true;
        // 决策账(#404 场景 8):过期结果拒绝按终态处理——「为什么没绿」
        // 的判定留痕。
        sessionAudit(live.root, live.id, "decisions", {
          kind: "decision.pipeline",
          msg: `终态 run 疑似过期结果,拒绝按终态处理(${repo})`,
          decision: "reject-stale", repo, sha, reason,
        });
        this.log(`[issue-flow] ${live.id} ${repo} 终态 run 疑似过期结果,`
          + `拒绝按终态处理继续轮询(${reason})`);
      }
      return true;
    };
    // 每轮固定顺序(#321 固化):先经合入状态循环对齐检查目标,再查
    // 流水线。两条循环各自每拍轮询、并行在跑,"先对齐、后查结果"的
    // 顺序由两道保证成立:监看的每个启动点(建 MR、同分支再推送、
    // 重启恢复、跟随切换本身)都先挂合入状态循环再挂流水线监看;终态
    // 结果动手前还有一道 MR 状态复核(settlePipeline,与验绿门共用
    // 同一判断)兜住两循环之间的窗口——顺序不依赖时序巧合。
    // 触发(假件必须显式触发;真件幂等无害)。触发响应可能已是终态。
    try {
      const first = (await triggerPipeline(call())).runs.at(-1);
      if (first && first.status !== "running" && !rejectStale(first)) {
        await this.settlePipeline(live, repo, sha, first);
        return;
      }
    } catch (error) {
      // 触发失败不弃看:适配层可能已因建 MR 自动触发,状态查询照走。
      this.log(`[issue-flow] ${live.id} 流水线触发失败(继续查状态): ${String(error)}`);
    }
    // 到点出循环后不立刻停表(#372):先终查一次(结果可能恰在最后一拍
    // 出),仍在跑且本轮还没延期过就静默延长一个完整预算回到轮询。
    // CI 高峰排队是真实耗尽现场(#372,issue-131):空闲期 10 分钟出结果
    // 的流水线,高峰期 30 分钟只是还在排队,停表喊人只会把人叫来看
    // 「还在跑」。延期把真卡死的喊人推迟一拍(30→60 分钟),是有界的
    // 代价——只延一次,60 分钟仍不够是该仓调 poll_timeout_s 的信号,
    // 不该靠堆延期掩盖;计数随 issue.json 落盘,重启不重置不多送。
    let failures = 0;
    const failureKey = `[issue-flow] ${live.id} ${repo} 流水线查询`;
    for (;;) {
      while (
        state.pipelines?.[repo]?.sha === sha
        && state.pipelines[repo].watching
        && !isTerminal(state.status)
        && Date.now() < Date.parse(state.pipelines[repo].deadline)
      ) {
        // 连续失败按 2 的幂退避；多等的时间补回截止时间，平台抖动
        // 不能把轮询预算提前耗光。成功一次立刻回到基础间隔。
        const watch = state.pipelines?.[repo];
        const delay = backoffMs(pollMs, failures);
        if (watch && watch.sha === sha && delay > pollMs) {
          const extended = extendDeadlineByBackoff(watch.deadline, pollMs, failures);
          if (extended !== watch.deadline) {
            watch.deadline = extended;
            saveState(live.root, state);
          }
        }
        await new Promise<void>((done) => {
          const timer = setTimeout(done, delay);
          timer.unref?.();
        });
        if (state.pipelines?.[repo]?.sha !== sha
            || !state.pipelines[repo].watching
            || isTerminal(state.status)) return;
        try {
          const status = await getPipelineStatus(call());
          failures = 0;
          this.failureLog.reset(failureKey);
          // 与申报门同一口径：runs.at(-1) 才是当前 run。历史终态不能
          // 越过后触发且仍在 running 的新 run，让监看器提前收口。
          const latest = status.runs.at(-1);
          if (latest && latest.status !== "running" && !rejectStale(latest)) {
            await this.settlePipeline(live, repo, sha, latest);
            return;
          }
        } catch (error) {
          failures++;
          this.failureLog.fail(failureKey,
            `[issue-flow] ${live.id} 流水线查询失败(继续轮): ${String(error)}`);
        }
      }
      // 循环因账目变化(换 SHA/停表/终态)退出时不延期,直接落到停表段;
      // 只有「同提交仍在监看+非终态」才是预算真到点,才轮到终查与延期。
      if (!(state.pipelines?.[repo]?.sha === sha
        && state.pipelines[repo].watching
        && !isTerminal(state.status))) break;
      let final: PipelineRun | undefined;
      try {
        final = (await getPipelineStatus(call())).runs.at(-1);
      } catch (error) {
        // 终查失败按仍在跑延期:平台瞬时抖动不该恰在到点时终止监看。
        this.failureLog.fail(`${failureKey}:终查`,
          `[issue-flow] ${live.id} 预算终查失败(按仍在跑处理): ${String(error)}`);
      }
      if (final && final.status !== "running" && !rejectStale(final)) {
        await this.settlePipeline(live, repo, sha, final);
        return;
      }
      if ((state.pipelines[repo].deadline_extensions ?? 0) >= 1) break;
      const { budgetMs } = this.pipelineKnobs();
      state.pipelines[repo].deadline_extensions =
        (state.pipelines[repo].deadline_extensions ?? 0) + 1;
      state.pipelines[repo].deadline = new Date(Date.now() + budgetMs).toISOString();
      sessionAudit(live.root, live.id, "decisions", {
        kind: "decision.pipeline",
        msg: `轮询预算到点流水线未出结果,自动延期一次(${repo})`,
        decision: "extend-deadline", repo, sha,
        extensions: state.pipelines[repo].deadline_extensions,
        new_deadline: state.pipelines[repo].deadline,
      });
      recordTransition(state, {
        source: "platform",
        note: `轮询预算到点流水线仍未出结果,自动延期一次(${repo})`
          + ` @ ${sha.slice(0, 12)},新到期 ${state.pipelines[repo].deadline}`,
      });
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 轮询预算到点流水线未出结果,`
        + `自动延期一次(${repo}) @ ${sha.slice(0, 12)}`);
    }
    // 预算耗尽:如实停表,不阻塞会话——用户可人工查看后发消息继续。
    // 终态会话不写不算不喊(体检 C-H2):循环因 isTerminal 退出时也落
    // 到这里,不能给已取消/归档的会话改 stage_note、发"请人工"通知。
    if (state.pipelines?.[repo]?.sha === sha && state.pipelines[repo].watching
        && !isTerminal(state.status)) {
      const extendedOnce = (state.pipelines[repo].deadline_extensions ?? 0) >= 1;
      const extensionNote = extendedOnce ? "(已自动延期一次)" : "";
      state.pipelines[repo].watching = false;
      state.pipelines[repo].last_error =
        `轮询预算耗尽${extensionNote},请人工查看流水线`;
      state.stage_note = `流水线轮询预算耗尽${extensionNote}`
        + "——请人工查看 MR/流水线,再发消息继续";
      saveState(live.root, state);
      sessionAudit(live.root, live.id, "decisions", {
        kind: "decision.pipeline",
        msg: `轮询预算耗尽${extensionNote},停止监看喊人(${repo})`,
        decision: "deadline-exhausted", repo, sha,
        extensions: state.pipelines[repo].deadline_extensions ?? 0,
        reason_code: "pipeline_watch_timeout",
      });
      this.log(`[issue-flow] ${live.id} 流水线监看预算耗尽(${repo})`
        + ` @ ${sha.slice(0, 12)}`);
      // 放弃点通知(票 81):机器等不起了就是需要人的时刻,主动喊人,
      // 不让用户靠刷网页发现停机。幂等见 notifyPipelineStopped。
      this.notifyPipelineStopped(live,
        `pipeline_watch_timeout:${repo}:${sha}`,
        `${this.issueSubject(live)}:仓 ${repo} 流水线轮询预算耗尽`
          + `${extensionNote}(第 ${state.pipelines[repo].round ?? 1} 轮验证,`
          + `提交 ${sha.slice(0, 12)}),流水线在预算内迟迟未出结果,`
          + "自动监看已停止。请人工查看 MR/流水线,处理后发消息继续");
    }
  }

  /** 合入事实监看(ADR-0022):单例;stage 留在 mr_green 且未终态期间
   *  逐仓轮询 /mr/gates 记 merged_at/merged_sha/closed_at,全合入/被
   *  关闭各通知一次。归档与 merge-status 端点另有竞态核对兜底。 */
  private readonly mergeWatchers = new Set<string>();

  /** 启动合入事实监看:mr_green 收口(即时/滞后两路都汇到
   *  notifyMrGreenClosed)与重启恢复调用;重复启动单例挡掉。 */
  private watchMergeStates(live: LiveIssue): void {
    if (!this.options.platformUrl || this.mergeWatchers.has(live.id)) return;
    this.mergeWatchers.add(live.id);
    void this.pollMergeStates(live)
      .catch((error) =>
        this.log(`[issue-flow] ${live.id} 合入事实监看异常退出: `
          + String(error instanceof Error ? error.message : error)))
      .finally(() => {
        this.mergeWatchers.delete(live.id);
      });
  }

  private async pollMergeStates(live: LiveIssue): Promise<void> {
    const { pollMs } = this.pipelineKnobs();
    let failures = 0;
    for (;;) {
      if (this.shuttingDown || isTerminal(live.state.status)
          || live.state.stage !== "mr_green" || !live.state.mrs?.length
          || (live.state.scenario === "mr_repair" && this.mrGreenClosed(live.state))) {
        return;
      }
      const { all_merged, failures: roundFailures } = await this.syncMergeFacts(live);
      failures = roundFailures ? failures + 1 : 0;
      // 合入即归档(ADR-0034):全合入的有单会话在这里自动收口,不再
      // 等人类点归档。验证 pass 后 stage 仍是 mr_green,轮询自然继续
      // 覆盖「pass 后等待合入」窗口;回退(阶段离开 mr_green)即退出。
      if (all_merged) this.autoArchiveDelivered(live);
      await new Promise<void>((done) => {
        const timer = setTimeout(done, backoffMs(pollMs, failures));
        timer.unref?.();
      });
    }
  }

  /** 逐仓向平台读合入事实并记账(ADR-0022):时刻=首次观测,不冒充
   *  平台动作时间;merged_sha 照平台返回记,不要求与验绿 SHA 相同。
   *  平台不可得保留上次观测等下一轮——监看循环、归档核对、
   *  merge-status 端点三方共用这一扫。 */
  async syncMergeFacts(live: LiveIssue): Promise<{ all_merged: boolean; failures: number }> {
    const state = live.state;
    // 终态复核(体检 C-H1/C-H2 同族):取消/归档落在轮询迭代内时,
    // 不再写终态会话的账与通知;归档竞态核对路(control)在终态前调用,
    // 不受影响。
    if (isTerminal(state.status)) {
      const frozen = state.mrs ?? [];
      return { all_merged: frozen.length > 0
        && frozen.every((mr) => Boolean(mr.merged_at)), failures: 0 };
    }
    let changed = false;
    let failures = 0;
    for (const mr of state.mrs ?? []) {
      const view = await this.fetchMrViewFor(live, mr);
      if (!view) {
        failures++;
        this.failureLog.fail(`[issue-flow] ${live.id} ${mr.repo} 合入状态`,
          `[issue-flow] ${live.id} ${mr.repo} 合入状态暂不可用,等下一轮`);
        continue;
      }
      this.failureLog.reset(`[issue-flow] ${live.id} ${mr.repo} 合入状态`);
      // 检查目标跟随分支最新提交(ADR-0041):平台带回的源分支最新提交
      // 与流水线检查账不一致即切换(幂等,见 followBranchHead)。本函数
      // 的调用方(合入状态循环、merge-status 端点)都会走到这里,切换
      // 事实只落一次。
      if (view.sourceSha && this.followBranchHead(live, mr.repo, view.sourceSha)) {
        changed = true;
      }
      const now = new Date().toISOString();
      if (view.mrState === "merged" && !mr.merged_at) {
        mr.merged_at = now;
        if (view.sourceSha) mr.merged_sha = view.sourceSha;
        changed = true;
      } else if (view.mrState === "closed" && !mr.closed_at && !mr.merged_at) {
        mr.closed_at = now;
        changed = true;
      }
    }
    const mrs = state.mrs ?? [];
    const allMerged = mrs.length > 0 && mrs.every((mr) => Boolean(mr.merged_at));
    const anyClosed = mrs.some((mr) => Boolean(mr.closed_at));
    if (allMerged && !state.merge_noted) {
      // 合入已入账标记。通知与收口由 autoArchiveDelivered 接管
      // (ADR-0034):不再有「可归档收口」的人工停靠。
      state.merge_noted = true;
      changed = true;
    }
    if (anyClosed && !state.mr_closed_noted) {
      state.mr_closed_noted = true;
      changed = true;
      this.notifyMergeFact(live,
        "有 MR 被关闭——可续聊返工(重推重报),或直接归档收口");
    }
    if (changed) saveState(live.root, state);
    return { all_merged: allMerged, failures };
  }

  /** 检查目标跟随分支最新提交(ADR-0041,#320):合入状态循环逐仓拿到
   *  平台返回的 MR 源分支最新提交编号,与流水线检查账不一致即把检查
   *  目标切过去——问题单分支按单号命名,分支上的一切皆属本单,最新
   *  提交的流水线就是本单当前的质量信号。账面按新提交整体重置(与
   *  resume_watch 同一清账口径):旧提交的失败计数、上轮报错与刹车账
   *  一并作废,查询时限重新起算。新头不在本会话推送账上=平台外推送,
   *  落 external_head 标记,红灯材料据此附"先拉最新代码、看差异再修"
   *  的指引。幂等:账上 sha 已是它就跳过(感知点被多处共用,同一
   *  sourceSha 只切换一次);自己推送的重挂走 armPipelineWatch,天然
   *  清掉 external_head。返回是否发生了切换(调用方据此落盘)。 */
  private followBranchHead(
    live: LiveIssue,
    repo: string,
    sourceSha: string,
  ): boolean {
    const state = live.state;
    const watch = state.pipelines?.[repo];
    if (!watch || watch.sha === sourceSha) return false;
    const own = state.pushes?.find((item) => item.repo === repo)?.sha;
    const external = sourceSha !== own;
    const now = Date.now();
    const { budgetMs } = this.pipelineKnobs();
    state.pipelines![repo] = {
      sha: sourceSha,
      status: "running",
      watching: true,
      started_at: new Date(now).toISOString(),
      deadline: new Date(now + budgetMs).toISOString(),
      round: watch.round + 1,
      reds: 0,
      ...(external ? { external_head: true as const } : {}),
    };
    recordTransition(state, {
      source: "platform",
      note: external
        ? `分支头已被平台外提交 ${sourceSha.slice(0, 12)} 取代,`
          + `检查目标跟随切换(${repo})`
        : `分支最新提交 ${sourceSha.slice(0, 12)} 与检查账不一致,`
          + `检查目标已对齐(${repo})`,
    });
    this.log(`[issue-flow] ${live.id} 检查目标跟随分支最新提交(${repo})`
      + ` @ ${sourceSha.slice(0, 12)}${external ? "(平台外提交)" : ""}`);
    void this.watchPipeline(live, repo, sourceSha);
    return true;
  }

  /** 合入即归档(ADR-0034):全部 MR 合入(merged_at 全在账)的有单会话
   *  自动收口,结论 delivered。合入是人在平台上做的决定、代码已进主干
   *  ——合入事实就是「交付完成没有」的答案,内部账本状态不再前置否决
   *  这个外部事实:「提交 MR·跑绿」阶段没收口、环境验证卡没答、不可修
   *  卡还挂着,都随归档一并清面(未答的卡作废,统计口径视为认可)。
   *  守闸器判据不受扰:终态被排除。回合在飞不抢(下一拍再试);回退中
   *  的会话阶段已离开 mr_green,轮询退出,到不了这里。 */
  private autoArchiveDelivered(live: LiveIssue): void {
    const state = live.state;
    if (isTerminal(state.status) || this.turning.has(live.id)) return;
    if (state.scenario !== "ticket") return;
    const mrs = state.mrs ?? [];
    if (!mrs.length || !mrs.every((mr) => Boolean(mr.merged_at))) return;
    state.conclusion = {
      kind: "delivered",
      summary: state.last_reply || state.stage_note || "(无补充说明)",
      at: new Date().toISOString(),
    };
    state.status = "archived";
    fixedComplete(state, "全部 MR 合入,自动归档收口");
    delete state.gate;
    saveState(live.root, state);
    for (const record of live.humanGate.pending()) {
      try {
        live.humanGate.supersede(record.waiting_id, {
          stateVersion: record.state_version,
          notes: "会话已自动归档,待办作废",
        });
      } catch (error) {
        this.log(`[issue-flow] ${live.id} 自动归档作废待办 `
          + `${record.waiting_id} 失败: `
          + String(error instanceof Error ? error.message : error));
      }
    }
    this.releaseDriver(live);
    this.stopContainerInBackground(live, "交付完成自动归档");
    this.finishTerminalHygiene(live);
    this.notifyMergeFact(live,
      `全部 MR 已合入(${mrs.length} 个)——已自动归档收口,交付完成`);
    this.log(`[issue-flow] ${live.id} 全部 MR 合入,自动归档收口`);
  }

  /** 流水线修复会话修绿收口后落终态(ADR-0073):修复的终点就是修绿,
   *  总结轮跑完即归档——终态卫生尾巴照走,现场不再永驻 idle 占盘。
   *  旗子(mr_repair_closing)在此清除;崩溃恢复的总结轮重放同路收口。 */
  private archiveMrRepair(live: LiveIssue): void {
    const state = live.state;
    delete state.mr_repair_closing;
    state.conclusion = {
      kind: "delivered",
      summary: state.last_reply || state.stage_note || "流水线修复完成",
      at: new Date().toISOString(),
    };
    state.status = "archived";
    fixedComplete(state, "流水线修复完成,已归档收口");
    delete state.gate;
    saveState(live.root, state);
    for (const record of live.humanGate.pending()) {
      try {
        live.humanGate.supersede(record.waiting_id, {
          stateVersion: record.state_version,
          notes: "会话已自动归档,待办作废",
        });
      } catch (error) {
        this.log(`[issue-flow] ${live.id} 自动归档作废待办 `
          + `${record.waiting_id} 失败: `
          + String(error instanceof Error ? error.message : error));
      }
    }
    this.releaseDriver(live);
    this.stopContainerInBackground(live, "修复完成自动归档");
    this.finishTerminalHygiene(live);
    this.log(`[issue-flow] ${live.id} 流水线修复完成,已归档收口`);
  }

  private notifyMergeFact(live: LiveIssue, summary: string): void {
    void this.options.notifier?.notifyOutcome({
      taskId: live.id,
      account: live.state.account,
      // 状态词与其它 outcome 通知分开:小鲁班按 taskId:outcome:状态
      // 幂等,同词会被前一条吞掉。
      status: summary.includes("已合入") ? "已合入" : "MR被关闭",
      summary,
      link: this.issueLink(live.id),
    }).catch(() => undefined);
  }

  /** 合入事实单次现扫(ADR-0022):逐仓问一遍平台并记账,返回快照
   *  投影。生产的持续同步由合入监看循环承担(阶段到 mr_green 才启动),
   *  这里是不等监看的单次入口——监看未启动的窗口(如检查目标未收口)
   *  要把合入事实落账,测试与诊断也走这一扫。HTTP 端点随归档对话框
   *  退役(ADR-0057),不再单独过线。 */
  async mergeStatus(id: string): Promise<{
    mrs: Array<{ repo: string; url?: string;
      state: "merged" | "closed" | "opened"; merged_sha?: string }>;
    all_merged: boolean;
  }> {
    const live = this.require(id);
    await this.syncMergeFacts(live);
    const mrs = live.state.mrs ?? [];
    return {
      mrs: mrs.map((mr) => ({
        repo: mr.repo,
        ...(mr.url ? { url: mr.url } : {}),
        state: mr.merged_at ? "merged" : mr.closed_at ? "closed" : "opened",
        ...(mr.merged_sha ? { merged_sha: mr.merged_sha } : {}),
      })),
      all_merged: mrs.length > 0 && mrs.every((mr) => Boolean(mr.merged_at)),
    };
  }

  /** MR 创建后持续同步外部意见为待判断批注；终态停止。
   * 新增通知按五分钟汇总，不因轮询、验绿或新提交自动派发修复。
   * 旧回复仍由现有 outbox 完成发送。 */
  private readonly reviewWatchers = new Set<string>();

  private watchMrDiscussions(live: LiveIssue): void {
    if (!this.options.platformUrl || this.reviewWatchers.has(live.id)) return;
    this.reviewWatchers.add(live.id);
    // fail-open 兜底:循环体内任何一步(如反馈账读爆)都不许击穿进程
    // ——记日志、退出、下轮启动(申报/重推)自然重来。
    void this.pollMrDiscussions(live)
      .catch((error) =>
        this.log(`[issue-flow] ${live.id} 检视意见监看异常退出: `
          + String(error instanceof Error ? error.message : error)))
      .finally(() => {
        this.reviewWatchers.delete(live.id);
      });
  }

  private async pollMrDiscussions(live: LiveIssue): Promise<void> {
    const { pollMs } = this.pipelineKnobs();
    const credential = this.options.gitCredential?.(live.state.account);
    let failures = 0;
    for (;;) {
      if (this.shuttingDown || isTerminal(live.state.status)
          || !live.state.mrs?.length
          || (live.state.scenario === "mr_repair" && this.mrGreenClosed(live.state))) {
        // 退出清算(H4):监看循环退出后没人再替信箱里的 pending 条目
        // 跑发送——统一置 failed 落 last_error 留痕,不让"待发送"悄悄
        // 烂在箱里装作还在路上。
        this.expirePendingReplies(live,
          "检视监看已退出(终态/关停/无 MR),未发送的回复作废");
        return;
      }
      // 验绿后仍发现新增意见，由责任人决定是否批量交办。全部 MR
      // 合入后停止追踪新意见(ADR-0032):账保留展示,在途回复照常
      // 投完,监看留到终态/关停再撤(退出清算兜底)。
      const allMerged = live.state.mrs.length > 0
        && live.state.mrs.every((mr) => Boolean(mr.merged_at));
      let roundFailed = false;
      if (!allMerged) {
        for (const mr of live.state.mrs) {
          const failureKey = `[issue-flow] ${live.id} ${mr.repo} 检视明细`;
          const fetched = await fetchMrDiscussions({
            platformUrl: this.options.platformUrl!,
            repo: mr.repo,
            mr: mr.iid ?? mr.url,
            ...(credential ? { credential } : {}),
          });
          if (fetched.kind !== "unavailable") {
            this.failureLog.reset(failureKey);
          } else {
            // 明细暂不可用:连续失败拉长等待，同一原因只记首条与周期计数。
            roundFailed = true;
            this.failureLog.fail(failureKey,
              `[issue-flow] ${live.id} ${mr.repo} 检视明细暂不可用,`
              + `等下一轮:${fetched.reason}`);
            continue;
          }
          this.absorbMrDiscussions(live, mr.repo, fetched.items);
          const scope = `${mr.repo}:${mr.iid ?? mr.url}`;
          importExternalReviews(reviewStore(live.root), { scope, mrUrl: mr.url, owner: live.state.account, items: fetched.items });
          void notifyExternalReviews({ store: reviewStore(live.root), workspace: live.root, scope,
            owner: live.state.account, taskId: live.id, link: this.issueLink(live.id), notifier: this.options.notifier })
            .catch(error => this.log(`[issue-flow] MR 新意见通知失败: ${String(error)}`));
        }
      }
      failures = roundFailed ? failures + 1 : 0;
      this.stageRespondedMrReviews(live);
      await this.flushMrReviewReplies(live);
      await new Promise<void>((done) => {
        const timer = setTimeout(done, backoffMs(pollMs, failures));
        timer.unref?.();
      });
    }
  }

  /** 监看退出时的信箱清算(H4):信箱内全部 pending 条目置 failed 并
   *  记 last_error,写回信箱留痕——循环没了,没人再替这些条目发送,
   *  与其挂着假 pending,不如如实作废等人重写。 */
  private expirePendingReplies(live: LiveIssue, reason: string): void {
    const outbox = this.readMrReviewOutbox(live);
    const pending = outbox.items.filter((item) => item.status === "pending");
    if (!pending.length) return;
    for (const item of pending) {
      item.status = "failed";
      item.last_error = reason;
    }
    this.writeMrReviewOutbox(live, outbox);
    this.log(`[issue-flow] ${live.id} 检视回复 ${pending.length} 条`
      + `随监看退出作废: ${reason}`);
  }

  /** 新意见/追问落反馈账,返回需要处置的(调用方决定注入还是标待人工);
   *  已落账且未了结(open/addressed)的意见这轮没再出现 = 讨论在平台
   *  已解决,闭环标注——归因按发送账分家(②-Q3):Agent 自己 resolve
   *  的不许记成"检视人已解决"。 */
  private absorbMrDiscussions(
    live: LiveIssue,
    repo: string,
    items: MrDiscussionItem[],
  ): MrDiscussionItem[] {
    const recordPrefix = `mr-discussion:${repo}:`;
    const store = this.feedbackStore(live);
    const records = store.list()
      .filter((record) => record.source === "mr_discussion"
        && record.id.startsWith(recordPrefix));
    const known = new Map(records.map((record) => [record.source_id, record]));
    const fresh: MrDiscussionItem[] = [];
    const followedUp: MrDiscussionItem[] = [];
    for (const item of items) {
      const record = known.get(item.id);
      const revision = item.revision ?? 0;
      if (!record) {
        fresh.push(item);
        continue;
      }
      // 同讨论、版本号变且未了结 = 检视人追问(②-Q4):刷新账并重新
      // 注入,不能让追问石沉大海。closed/needs_human 已了结,不追。
      if (revision !== record.source_revision
          && (record.status === "open" || record.status === "addressed")) {
        followedUp.push(item);
      }
    }
    if (fresh.length || followedUp.length) {
      // 观察基准:该仓最近一次推送——检视意见是对哪版代码提的,账上
      // 要能对回去;还没有推送收据(理论不可达,申报前置了推送)留空。
      const observedSha = live.state.pushes
        ?.find((push) => push.repo === repo)?.sha ?? "";
      const toRecord = (item: MrDiscussionItem) => ({
        id: `${recordPrefix}${item.id}`,
        // batch_id 带版本号:upsert 按同 id+同 batch 跳过——版本变了
        // 换 batch 即整体刷新,追问的新正文才能落到账上。
        batch_id: `mr-discussion:${repo}:${item.id}:${item.revision ?? 0}`,
        source: "mr_discussion" as const,
        source_id: item.id,
        source_revision: item.revision ?? 0,
        observed_sha: observedSha,
        summary: (item.severity ? `[${item.severity}] ` : "")
          + String(item.body ?? "MR 检视意见").slice(0, 1000 - 12),
        ...(item.file ? { file: item.file } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
        ...(item.author ? { author: item.author.slice(0, 120) } : {}),
        verification: "reviewer",
        status: "open" as const,
        updated_at: new Date().toISOString(),
      });
      store.upsert([...fresh, ...followedUp].map(toRecord));
      this.log(`[issue-flow] ${live.id} 收到 MR 检视意见 ${fresh.length} 条`
        + `${followedUp.length ? `,追问 ${followedUp.length} 条` : ""}(${repo})`);
    }
    const openIds = new Set(items.map((item) => item.id));
    const outbox = this.readMrReviewOutbox(live);
    for (const record of records.filter((row) =>
      row.status === "open" || row.status === "addressed")) {
      if (openIds.has(record.source_id)) continue;
      const agentResolved = outbox.items.some((item) =>
        item.discussion_id === record.source_id
        && item.status === "delivered" && item.resolve);
      store.resolve(record.id, "closed", agentResolved
        ? "Agent 回复并解决(AI 在回复时标记,待检视人知悉)"
        : "检视人已在 CodeHub 解决该讨论");
    }
    return [...fresh, ...followedUp];
  }

  /** 对外发送账(ADR-0053 dispatch.jsonl):信箱条目的装箱与发送流水,
   *  request_id=条目 id,与 host-calls 按同 id join(#383② 的解药)。 */
  private auditDispatch(
    live: LiveIssue, action: string, item: MrReviewReplyOutboxItem,
    extra: Record<string, unknown> = {},
  ): void {
    sessionAudit(live.root, live.id, "dispatch", {
      kind: "dispatch.outbox",
      msg: `检视回复信箱 ${action}(${item.discussion_id})`,
      action, request_id: item.id,
      discussion_id: item.discussion_id, repo: item.repo,
      ...(item.mr !== undefined ? { mr: item.mr } : {}),
      ...extra,
    });
  }

  /** 按仓从会话 MR 台账取 MR 标识(iid 优先,与监看拉取同口径)。
   * 台账没有该仓(理论不可达:外部意见必来自某个 MR)返回 undefined,
   * 装箱不带 mr——部署模板引用 {mr} 会诚实报错,不猜。 */
  private mrRefFor(live: LiveIssue, repo: string): string | number | undefined {
    const mr = live.state.mrs?.find((entry) => entry.repo === repo);
    return mr ? (mr.iid ?? mr.url) : undefined;
  }

  /** 扫描批注账,把「已 respond 未入箱」的 MR 检视意见回复装入出站信箱
   *  (ADR-0052 单通道:AI 经 respond_review 落面板账,平台按 responded_at
   *  代发 CodeHub——不再有第二套 AI 侧协议)。回合进行中不装箱:AI 常
   *  在同一回合里"回复→推送",回合中装箱会把 expected_sha 绑到推送前
   *  的旧版本,下一拍就误判漂移——等回合收口绑稳定版本。按次去重
   *  (键=responded_at):追问线程的后续回复照发;同键条目失败即终局,
   *  重新 respond 才有新键,不借重发旧回复绕过 SHA 漂移作废。存量
   *  「已 respond 未入箱」的历史回复同路补发(ADR-0052 自愈)。 */
  private stageRespondedMrReviews(live: LiveIssue): void {
    if (this.turning.has(live.id)) return;
    const responded = reviewStore(live.root).list().filter((item) =>
      item.external_review?.discussion_id && item.response);
    if (!responded.length) return;
    const outbox = this.readMrReviewOutbox(live);
    let staged = 0;
    for (const annotation of responded) {
      const discussionId = annotation.external_review!.discussion_id;
      const response = annotation.response!;
      if (outbox.items.some((item) =>
        item.discussion_id === discussionId
        && item.responded_at === response.responded_at)) {
        continue; // 同一回应已在箱(投过/发送中/失败终局)
      }
      const scope = annotation.external_review!.scope;
      const tracked = live.state.mrs?.find((mr) =>
        `${mr.repo}:${mr.iid ?? mr.url}` === scope);
      const repo = tracked?.repo
        ?? scope.slice(0, Math.max(0, scope.lastIndexOf(":")));
      if (!repo) {
        this.log(`[issue-flow] ${live.id} 检视回复 ${discussionId} 的 scope `
          + `解析不出仓,跳过: ${scope}`);
        continue;
      }
      const mrRef = this.mrRefFor(live, repo);
      const item: MrReviewReplyOutboxItem = {
        id: `mrr-${randomUUID()}`,
        repo,
        ...(mrRef !== undefined ? { mr: mrRef } : {}),
        discussion_id: discussionId,
        body: response.summary,
        resolve: this.options.resolveDiscussions === true,
        responded_at: response.responded_at,
        expected_sha: live.state.pushes
          ?.find((push) => push.repo === repo)?.sha ?? "",
        status: "pending",
        attempts: 0,
        created_at: new Date().toISOString(),
      };
      outbox.items.push(item);
      this.auditDispatch(live, "stage", item,
        { expected_sha: item.expected_sha, resolve: item.resolve,
          source: "agent-respond" });
      staged += 1;
    }
    if (!staged) return;
    this.writeMrReviewOutbox(live, outbox);
    this.log(`[issue-flow] ${live.id} 检视回复待发布 ${staged} 条`);
  }

  /** 出站信箱发送:SHA 不匹配说明回复绑定的那版代码已不是当前版本
   *  (②-Q2)——直接标失败("请针对当前代码重写"),不能永远 pending
   *  (旧实现不计重试、还挡新草稿,永久卡死);失败不挡责任人交办后的新草稿。
   * 发送带 Idempotency-Key,重放不产生第二条 CodeHub
   *  回复;HTTP 重试超限标 failed 交人工(不再注入,防平台持续故障下
   *  无限循环)。发送成功→意见转 addressed(Agent 已回复,待检视人
   *  核验,②-Q3:处理≠验收)。 */
  private readonly replyFlushes = new Map<string, Promise<void>>();

  /** 同一会话的信箱发送串行：监看环与责任人答复/忽略的即时一拍会并发
   *  进来，两边各拿一份信箱快照发送再整份写回，后写的会把先写的条目
   *  冲掉（2026-10-08 读码发现）。排在前一拍之后跑，前一拍失败不连坐。 */
  private flushMrReviewReplies(live: LiveIssue): Promise<void> {
    const previous = this.replyFlushes.get(live.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.flushMrReviewRepliesOnce(live));
    this.replyFlushes.set(live.id, next);
    void next.catch(() => undefined).finally(() => {
      if (this.replyFlushes.get(live.id) === next) this.replyFlushes.delete(live.id);
    });
    return next;
  }

  private async flushMrReviewRepliesOnce(live: LiveIssue): Promise<void> {
    // 终态复核(体检 C-H5):取消/归档落在迭代内,不再向平台发送
    // 已装箱回复——终态会话不该再产生外部副作用。
    if (isTerminal(live.state.status)) return;
    const outbox = this.readMrReviewOutbox(live);
    const pending = outbox.items.filter((item) => item.status === "pending");
    if (!pending.length) return;
    const platformUrl = this.options.platformUrl!;
    const credential = this.options.gitCredential?.(live.state.account);
    let dirty = false;
    for (const item of pending) {
      // 版本核对只对绑定了收据的回复生效;责任人答复不主张代码已改,
      // 不绑收据,重推也不作废(ADR-0032)。
      const boundSha = item.expected_sha ?? "";
      const receipt = live.state.pushes
        ?.find((push) => push.repo === item.repo)?.sha ?? "";
      if (boundSha && (!receipt || receipt !== boundSha)) {
        item.status = "failed";
        item.last_error = !receipt
          ? "该仓没有推送收据,回复作废——重推后请重写回复草稿"
          : `代码已更新(回复绑定 ${boundSha.slice(0, 12)},`
            + `当前推送 ${receipt.slice(0, 12)})——请针对当前代码重写回复草稿`;
        dirty = true;
        this.auditDispatch(live, "void", item,
          { result: "sha-drift", error: item.last_error,
            expected_sha: boundSha, current_sha: receipt || undefined });
        this.log(`[issue-flow] ${live.id} 检视回复作废(${item.discussion_id}): `
          + item.last_error);
        // 自愈闭环:意见仍是未了结状态时重新注入,AI 会拿到最新清单
        // 重写回复;推送稳定后必然收敛,不会无限循环。
        const record = this.feedbackStore(live).list().find((row) =>
          row.source === "mr_discussion"
          && row.source_id === item.discussion_id);
        if (record && (record.status === "open"
          || record.status === "addressed")) {
          this.log(`[issue-flow] 远端回复版本已变化，保留本地记录供责任人处理`);
        }
        continue;
      }
      if (item.attempts >= 5) {
        item.status = "failed";
        item.last_error = "发送重试超限,请人工在 CodeHub 回复";
        dirty = true;
        this.auditDispatch(live, "fail", item,
          { result: "retries-exhausted", error: item.last_error });
        continue;
      }
      item.attempts += 1;
      try {
        if (item.resolve_only) {
          // 仅标已解决(「忽略」的远端半边):不跟帖,发送即到头,
          // 没有回复式的事后记账——本地账在忽略时已软删。
          await postMrDiscussionResolve({
            platformUrl,
            discussionId: item.discussion_id,
            repo: item.repo,
            ...(item.mr !== undefined ? { mr: item.mr } : {}),
            idempotencyKey: item.id,
            requestId: item.id,
            issueId: live.id,
            headers: pipelineHeaders(credential),
            signal: AbortSignal.timeout(MR_REPLY_SEND_TIMEOUT_MS),
          });
          item.status = "delivered";
          item.delivered_at = new Date().toISOString();
          delete item.last_error;
          dirty = true;
          this.auditDispatch(live, "deliver", item,
            { result: "resolved-only" });
          this.log(`[issue-flow] ${live.id} 检视讨论已标已解决(${item.discussion_id})`);
          continue;
        }
        await postMrDiscussionReply({
          platformUrl,
          discussionId: item.discussion_id,
          repo: item.repo,
          ...(item.mr !== undefined ? { mr: item.mr } : {}),
          body: item.body,
          resolve: item.resolve,
          idempotencyKey: item.id,
          requestId: item.id,
          issueId: live.id,
          headers: pipelineHeaders(credential),
          signal: AbortSignal.timeout(MR_REPLY_SEND_TIMEOUT_MS),
        });
        item.status = "delivered";
        item.delivered_at = new Date().toISOString();
        delete item.last_error;
        dirty = true;
        this.auditDispatch(live, "deliver", item,
          { result: "replied", resolve: item.resolve });
        this.log(`[issue-flow] ${live.id} 检视回复已发布(${item.discussion_id})`);
        // 记账分家(②-Q3):发送成功只代表"已回复",检视人核验
        // 前不算了结;账失败不回滚发送事实(平台已有回复)。归因按
        // 装箱人分家:责任人在场答复制为责任人,AI 草稿制为 Agent。
        try {
          this.feedbackStore(live).resolve(
            `mr-discussion:${item.repo}:${item.discussion_id}`,
            "addressed", item.author
              ? `责任人 ${item.author} 已回复,待检视人核验`
              : "Agent 已回复,待检视人核验");
        } catch (error) {
          this.log(`[issue-flow] ${live.id} 检视回复入账失败(发送事实保留): `
            + String(error instanceof Error ? error.message : error));
        }
      } catch (error) {
        item.last_error = String(
          error instanceof Error ? error.message : error);
        dirty = true;
        this.auditDispatch(live, "retry", item,
          { result: "error", attempt: item.attempts,
            error: item.last_error });
      }
    }
    if (dirty) {
      // 发送期间别处可能已往信箱追加（责任人答复/忽略同步落盘）：按 id 把
      // 本拍处理过的条目合回最新信箱，不拿发送前的旧快照整份覆盖。
      const handled = new Map(pending.map((item) => [item.id, item]));
      const fresh = this.readMrReviewOutbox(live);
      fresh.items = fresh.items.map((item) => handled.get(item.id) ?? item);
      for (const item of pending) {
        if (!fresh.items.some((row) => row.id === item.id)) fresh.items.push(item);
      }
      this.writeMrReviewOutbox(live, fresh);
    }
  }

  /** 责任人答复直达 CodeHub(ADR-0032):经出站信箱原样发布,复用
   *  AI 回复同一条发送路(共享发送原语+幂等键)。不主张代码已改——
   *  不绑推送收据,重推不作废;批注侧本地答复账(replyAsOwner)与
   *  远端发送分家,发送失败留痕重试,不回滚批注。一条意见至多一次
   *  责任人答复由批注层把关,这里不做去重。 */
  private enqueueOwnerMrReply(
    live: LiveIssue, discussionId: string, body: string,
    resolveRemote = false,
  ): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    const record = this.feedbackStore(live).list().find(
      (row) => row.source === "mr_discussion"
        && row.source_id === discussionId);
    if (!record) {
      this.log(`[issue-flow] ${live.id} 责任人答复找不到意见账`
        + `(${discussionId}),仅保留本地批注`);
      return;
    }
    const repo = record.id.slice(
      "mr-discussion:".length,
      record.id.length - discussionId.length - 1);
    const outbox = this.readMrReviewOutbox(live);
    const ownerMrRef = this.mrRefFor(live, repo);
    const ownerItem: MrReviewReplyOutboxItem = {
      id: `mrr-${randomUUID()}`,
      repo,
      ...(ownerMrRef !== undefined ? { mr: ownerMrRef } : {}),
      discussion_id: discussionId,
      body: trimmed,
      // 2026-09-18 拍板:责任人可勾选随答复代点已解决,默认不点——
      // 取代 spec 17 的"答复一律不代 resolve";是否真解决了,远端为准。
      resolve: resolveRemote,
      status: "pending",
      attempts: 0,
      author: live.state.account,
      created_at: new Date().toISOString(),
    };
    outbox.items.push(ownerItem);
    this.auditDispatch(live, "stage", ownerItem,
      { source: "owner-reply", author: live.state.account });
    this.writeMrReviewOutbox(live, outbox);
    this.log(`[issue-flow] ${live.id} 责任人答复待发布(${discussionId})`);
  }

  /** 「忽略」的远端半边(2026-09-18):仅在 CodeHub 标已解决,不跟帖。
   * 走同一信箱拿重试与留痕;找不到意见账(旧账无 mr_discussion 记录)
   * 就没有仓信息可投,静默跳过——本地忽略不受影响。 */
  private enqueueOwnerMrResolve(live: LiveIssue, discussionId: string): void {
    const record = this.feedbackStore(live).list().find(
      (row) => row.source === "mr_discussion"
        && row.source_id === discussionId);
    if (!record) {
      this.log(`[issue-flow] ${live.id} 忽略意见找不到意见账(${discussionId}),`
        + "仅本地忽略");
      return;
    }
    const repo = record.id.slice(
      "mr-discussion:".length,
      record.id.length - discussionId.length - 1);
    const outbox = this.readMrReviewOutbox(live);
    const ownerMrRef = this.mrRefFor(live, repo);
    const resolveItem: MrReviewReplyOutboxItem = {
      id: `mrr-${randomUUID()}`,
      repo,
      ...(ownerMrRef !== undefined ? { mr: ownerMrRef } : {}),
      discussion_id: discussionId,
      body: "",
      resolve: false,
      resolve_only: true,
      status: "pending",
      attempts: 0,
      author: live.state.account,
      created_at: new Date().toISOString(),
    };
    outbox.items.push(resolveItem);
    this.auditDispatch(live, "stage", resolveItem,
      { source: "owner-drop", resolve_only: true });
    this.writeMrReviewOutbox(live, outbox);
    this.log(`[issue-flow] ${live.id} 忽略意见待代点已解决(${discussionId})`);
  }

  private readMrReviewOutbox(live: LiveIssue): {
    items: MrReviewReplyOutboxItem[];
  } {
    const path = join(live.root, MR_REPLY_OUTBOX_FILE);
    if (!existsSync(path)) return { items: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
          items?: MrReviewReplyOutboxItem[];
        };
      if (Array.isArray(parsed.items)) return { items: parsed.items };
    } catch (error) {
      // 读不动不拖垮监看(fail-open),但不再无声(②-Q6):回复是承诺过
      // 的动作,静默当空箱等于悄悄丢回复——记错误日志引人来修。
      this.log(`[issue-flow] ${live.id} 检视回复信箱读不动,按空箱继续`
        + `(发送暂缓): ${String(error instanceof Error ? error.message : error)}`);
    }
    return { items: [] };
  }

  private writeMrReviewOutbox(
    live: LiveIssue,
    outbox: { items: MrReviewReplyOutboxItem[] },
  ): void {
    writeFileSync(join(live.root, MR_REPLY_OUTBOX_FILE),
      JSON.stringify(outbox, null, 1), "utf-8");
  }

  /** 逐仓现查 MR 平台事实(合入状态记账与终态复核共用同一查询):生命
   *  周期状态 + 源分支最新提交编号。查询不可得返回 undefined,调用方
   *  按各自口径处理,不在此处造死路。 */
  private fetchMrViewFor(
    live: LiveIssue,
    mr: NonNullable<IssueSessionState["mrs"]>[number],
  ): Promise<GateView | undefined> {
    return fetchMrGates({
      platformUrl: this.options.platformUrl,
      repo: mr.repo,
      headers: pipelineHeaders(
        this.options.gitCredential?.(live.state.account)),
      delivery: {
        source_branch: mr.branch,
        target_branch: mr.target ?? "master",
        ...(mr.url ? { mr_url: mr.url } : {}),
        ...(mr.iid !== undefined ? { mr_id: mr.iid } : {}),
      },
    });
  }

  /** MR 状态复核(#321,赛跑防护):红/绿终态处理动手前与验绿门申报
   *  放行共用这一查(一处判断、两处使用,两边口径不漂移)——与
   *  syncMergeFacts 同一个 /mr/gates 查询(经 fetchMrViewFor),现问
   *  平台「MR 是否已合入、源分支最新提交是哪个」。依据:旧提交的
   *  流水线被平台取消,必然是「分支头变了/合入了」引起的,终态结果
   *  出现之后现查 MR 状态,看到的一定是真相(issue-107)——这关上
   *  「旧提交的取消红被当成真失败派出修复」的赛跑窗口。返回
   *  undefined=查询不可得(平台未配置/网络抖动/老适配层):复核是
   *  防赛跑的加法,查询失败不许变成新的死路,调用方按既有口径继续。 */
  private async recheckMrForSettle(
    live: LiveIssue,
    repo: string,
    sha: string,
  ): Promise<IssueMrRecheck | undefined> {
    const mr = live.state.mrs?.find((item) => item.repo === repo);
    if (!this.options.platformUrl || !mr) return undefined;
    const view = await this.fetchMrViewFor(live, mr);
    if (!view) return undefined;
    return {
      mrState: view.mrState,
      ...(view.sourceSha ? { sourceSha: view.sourceSha } : {}),
      headMoved: Boolean(view.sourceSha && view.sourceSha !== sha),
    };
  }

  private async settlePipeline(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
  ): Promise<void> {
    const { state } = live;
    // 决策账(#404 场景 5/8):监看收到终态并动手结算——「平台看到了
    // 什么、判了什么」的事实与判定一行可查。
    sessionAudit(live.root, live.id, "decisions", {
      kind: "decision.pipeline",
      msg: `流水线终态结算(${repo},${run.status})`,
      decision: "settle", repo, sha, run_status: run.status,
    });
    // 终态复核(体检 C-H1):取消/归档可能落在监看迭代的 sleep/fetch
    // 窗口内——终态处理与它触发的举闸都不得再写已终态会话的状态。
    if (isTerminal(state.status)) return;
    const watch = state.pipelines?.[repo];
    if (watch?.sha !== sha) return;
    const epoch = live.controlEpoch;
    const current = () => !this.shuttingDown && !isTerminal(state.status)
      && live.controlEpoch === epoch && state.pipelines?.[repo] === watch
      && watch.sha === sha && (run.status === "success" || (watch.status !== "success"
        && !state.mrs?.some(mr => mr.repo === repo && (mr.merged_at || mr.closed_at))));
    // ---- 最终结果动手前复核 MR 状态(#321,赛跑防护,issue-107)----
    // 红或绿的最终结果都是「记账并触发动作」的扳机,扣扳机之前现查
    // 一次 MR 状态(低频:每个提交只在拿到最终结果时复核一次):
    // - 已合入:红灯不作失败处理(不派发修复回合、不进修复预算账、不举
    //   卡)——合入即交付,归档路(合入状态循环里的自动归档)接管;
    //   绿灯照常收口,收口后归档路自然接上。
    // - 分支头已变:这次结果整个丢弃、不触发任何动作——检查目标跟随
    //   分支最新提交(ADR-0041,合入状态循环每拍在跑)自会接管,只记
    //   一笔转移账。
    // - 都对得上(或查询不可得):照常处理,与既有行为全等。
    const recheck = await this.recheckMrForSettle(live, repo, sha);
    // 复核是一场网络往返:期间检查目标可能已被跟随切换换走——换走了
    // 就说明切换已接管,这次旧结果同样不作数。
    if (!current()) return;
    if (recheck?.mrState === "merged" && run.status !== "success") {
      recordTransition(state, {
        source: "platform",
        note: `MR 已合入,旧提交 ${sha.slice(0, 12)} 的流水线随合入取消,`
          + `不作失败处理(${repo}),归档路接管`,
      });
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 红灯随 MR 合入取消,不作失败处理`
        + `(${repo})@ ${sha.slice(0, 12)}`);
      return;
    }
    if (recheck?.headMoved) {
      // 绿灯但头已变:不收口当前阶段(closeMrGreen 不调)、不引出验证
      // 卡——分支最新提交才是会被合入的代码,旧提交的绿灯背书不了它,
      // 把「头已变」事实作为一轮消息交给 AI。红灯但头已变:结果丢弃,
      // 只记转移账,不派发修复(新头的红灯自会按新账走完整流程)。
      const headShort = recheck.sourceSha!.slice(0, 12);
      if (run.status === "success") {
        recordTransition(state, {
          source: "platform",
          note: `流水线绿的是旧提交 ${sha.slice(0, 12)},分支最新提交已变`
            + `为 ${headShort}(${repo})——绿灯不作收口,检查目标跟随切换`
            + `后按新提交继续`,
        });
        saveState(live.root, state);
        this.startPlatformTurn(live, promptCopy("notices",
          "pipeline.green.head_moved", { repo, sha: headShort }));
      } else {
        recordTransition(state, {
          source: "platform",
          note: `旧提交 ${sha.slice(0, 12)} 的流水线结果到达时,分支最新`
            + `提交已变为 ${headShort}(${repo})——结果丢弃,不作失败处理,`
            + `检查目标跟随切换后按新提交继续`,
        });
        saveState(live.root, state);
      }
      this.log(`[issue-flow] ${live.id} 终态结果随分支头变化丢弃(${repo})`
        + `@ ${sha.slice(0, 12)},分支最新提交 ${headShort}`);
      return;
    }
    watch.status = run.status;
    watch.watching = false;
    if (run.checks) watch.checks = run.checks;
    if (run.status === "success") {
      watch.reds = 0;
      // 绿了清账:刹车账(last_repair_sha/last_failure_summary)与证据
      // 重试窗字段随红灯环一起作废——下一轮红灯从干净账起算。
      this.clearRepairLedger(watch);
      this.resolveIssuePipelineFeedback(live, repo, "closed",
        `新提交 ${sha.slice(0, 12)} 的权威流水线已通过`);
      recordTransition(state, {
        source: "platform", note: `流水线全绿(${repo})@ ${sha.slice(0, 12)}`,
      });
      // 多仓语义(2026-08-28 拍板):AI 已建的 MR 各自跑流水线,全部
      // 跑绿才收口;还有在途/未绿的就等齐,不抢跑。收口还要过 MR 验绿
      // 门的申报半边(不变量:收口当且仅当"已申报且全绿"):AI 没申报
      // 就不收,开回合提醒它 complete_stage。
      const mrs = state.mrs ?? [];
      const allGreen = mrs.length > 0 && mrs.every((mr) =>
        state.pipelines?.[mr.repo]?.status === "success");
      const anyWatching = Object.values(state.pipelines ?? {})
        .some((item) => item.watching);
      if (allGreen && !anyWatching && state.mr_gate) {
        delete state.mr_gate;
        this.closeMrGreen(live,
          `全部 ${mrs.length} 个 MR 流水线跑绿(监看器验绿收口)`);
      } else if (allGreen && !anyWatching && state.stage === "mr_green"
          && !this.mrGreenClosed(state)) {
        // 全绿但 AI 还没申报清单:不收口(申报是 mr_green 的出口半边),
        // 提醒它调 complete_stage 完成收口。(已在验绿门当场收口的滞后
        // 终态处理不进这里——阶段守卫挡住,不发过时的申报提醒。)
        saveState(live.root, state);
        this.startPlatformTurn(live,
          promptCopy("notices", "pipeline.green.remind", {
            repos: mrs.map((mr) => mr.repo).join(", "),
          }));
      } else if (allGreen && !anyWatching && state.stage === "fix") {
        // 全绿但 AI 停在 fix 阶段(#357):它没调 complete_stage 推进
        // 就结束了回合,在等一个此阶段没人监听的流水线。MR 已建且全绿,
        // 这里是唯一的唤醒点——开回合指路:先推进阶段,再按 mr_green
        // 口径申报。无 MR 的首修等不到全绿(监看压根没挂),那条轨迹
        // 归催办词的定向纠偏(nudge.fix_wait_pipeline)。
        saveState(live.root, state);
        this.startPlatformTurn(live,
          promptCopy("notices", "pipeline.green.remind_fix", {
            repos: mrs.map((mr) => mr.repo).join(", "),
          }));
      } else if (!allGreen && !anyWatching && mrs.length > 0) {
        // 有 MR 未绿且没表在跑:那就是失败了,带回失败项让 AI 修。
        saveState(live.root, state);
        this.startPlatformTurn(live,
          promptCopy("notices", "pipeline.green.others_red", { repo }));
      } else {
        // 全绿但收口点已过(归档前返工的跟进提交跑绿):账定格即毕,
        // 不重发收口,也不误报"其他仓红灯"。
        saveState(live.root, state);
      }
      return;
    }
    recordTransition(state, {
      source: "platform", note: `流水线失败(${repo})@ ${sha.slice(0, 12)}`,
    });
    // 红=申报打回:清掉申报账,修复后要重新申报再过验绿门。
    delete state.mr_gate;
    // 红灯兜底撤卡(#374,见 dismissStaleGate):推送撤卡(main 路)漏
    // 掉的现场——恢复直挂续表绕过 armPipelineWatch、推送后 AI 同回合
    // 补举的验证卡——到红灯这里必须让失败事实正常送达,不再停靠旧卡。
    this.dismissStaleGate(live, repo, sha, "red");
    run = { ...run, log: repairStatusSummary(run.log) };
    const evidence = await this.collectPipelineEvidence(live, repo, sha, run, current);
    if (!evidence || !current()) return;
    const { artifacts, lines: evidenceLines } = evidence;
    const feedbackId = `issue-pipeline:${repo}:${sha}`;
    this.feedbackStore(live).upsert([{
      id: feedbackId,
      batch_id: feedbackId,
      source: "pipeline",
      source_id: `${repo}@${sha}`,
      source_revision: watch.round,
      observed_sha: sha,
      summary: describePipelineRun(run).slice(0, 1000),
      verification: "pipeline",
      status: "repairing",
      updated_at: new Date().toISOString(),
    }]);
    // #578：平台先有限重试取证，再发送失败事实和采证评估。
    // 修复方式、不可修判断与人工卡仍由 Agent 决定(ADR-0024)。
    const checks = run.checks ?? watch.checks;
    const max = repairBudget(this.options.settings);
    // ① 同提交刹车(需求流 last_sha===sha→halted 同语义):红灯还是
    // 上次派发修复的同一提交=修了没出新提交,再发送同一份事实只会
    // 原地打转——停机不投:reds 不变(不耗预算),会话最后一次发言
    // (AI 的诊断)写进留痕与通知,"把 AI 的诊断交给我"。人的
    // resume_watch 重看豁免刹车(作答时清刹车账):人声明平台侧已
    // 处理,重看仍红按新红灯重新发送。
    if (watch.last_repair_sha && watch.last_repair_sha === sha) {
      const diagnosis = (state.last_reply ?? "").trim();
      const note = `流水线红灯仍是上次派发修复的同一提交(${sha.slice(0, 12)})`
        + "——修复没有产出新提交,已停机不再派发修复,请人工处理";
      watch.last_error = note;
      state.stage_note = diagnosis
        ? `${note};AI 最后诊断: ${diagnosis.slice(0, 300)}`
        : `${note}(会话没有留下诊断发言)`;
      recordTransition(state, {
        source: "platform",
        note: diagnosis
          ? `同提交刹车(${repo})@ ${sha.slice(0, 12)}:自动修复停机,`
            + `AI 诊断: ${diagnosis.slice(0, 300)}`
          : `同提交刹车(${repo})@ ${sha.slice(0, 12)}:自动修复停机`
            + "(会话没有留下诊断发言)",
      });
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 同提交刹车(${repo})`
        + ` @ ${sha.slice(0, 12)},reds 保持 ${watch.reds ?? 0},`
        + `${diagnosis ? "带 AI 诊断停机" : "无诊断发言停机"}`);
      this.notifyPipelineStopped(live,
        `pipeline_repair_brake:${repo}:${sha}`,
        `${this.issueSubject(live)}:仓 ${repo} 流水线红灯仍是上次派发修复的`
          + `同一提交(${sha.slice(0, 12)}),修复没有产出新提交,自动修复`
          + "已暂停。"
          + (diagnosis
            ? `修复会话的诊断: ${diagnosis.slice(0, 600)}`
            : "修复会话没有留下诊断发言。")
          + "请人工查看 MR/流水线,处理后发消息继续");
      return;
    }
    // ② 修复轮预算(与需求侧同一管理页旋钮 repair_rounds,缺省 20):
    // 发送回合就是修复回合——AI 在里面或修或举卡,派了才记一轮,绿了
    // 清零;超限停止自动发送,请人工处理后发消息继续。预算 0=完全
    // 人工(第一次红灯也停机)——举卡也是判断,判断发生在发送回合
    // 里,没有"不派回合先举卡"的旁路。
    const reds = (watch.reds ?? 0) + 1;
    watch.reds = reds;
    if (reds > max) {
      watch.last_error =
        `流水线红灯修复轮预算耗尽(${max} 轮),请人工查看流水线`;
      state.stage_note = `流水线连续 ${reds} 次红灯,修复轮预算(${max} 轮)`
        + "已耗尽——请人工查看 MR/流水线;处理后发消息继续";
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线修复轮预算耗尽(${repo},`
        + `${reds}/${max}) @ ${sha.slice(0, 12)}`);
      // 放弃点通知(需求侧 notifyRepairStopped 同语义):预算烧完就是
      // "机器放弃、该人接手"的时刻,主动喊人。同因(同仓同提交)再
      // 停机凭 outcome 通道幂等不重发。
      this.notifyPipelineStopped(live,
        `pipeline_repair_exhausted:${repo}:${sha}`,
        `${this.issueSubject(live)}:流水线连续 ${reds} 次红灯,修复轮预算`
          + `(${max} 轮)已耗尽,自动修复已放弃。请人工查看 MR/流水线,`
          + "处理后发消息继续");
      return;
    }
    // ③ 派发修复记账:本轮提交与红灯摘要落账——下一轮"换新提交"红灯时
    // 作为上轮报错拼进发送词(先写账再发送,进程死在两行之间也只是
    // 多记一轮,不会把账记到没派过的提交头上)。
    const previousSha = watch.last_repair_sha;
    const previousSummary = watch.last_failure_summary;
    watch.last_repair_sha = sha;
    watch.last_failure_summary = pipelineFailureDigest(run, checks);
    saveState(live.root, state);
    // ④ 失败事实发送(三态:运行中 steer/等人落便签/空闲开回合)。
    // 逐维度明细与镜像产物都给全——判断交 AI,材料也交全。
    this.startPlatformTurn(live, [
      promptCopy("notices", "red.deliver.header", { repo, reds, max }),
      "",
      // 分支头是平台外提交(ADR-0041):红灯属于别人推的提交——材料
      // 开头先交底,修复指引让 AI 先拉最新代码、看差异再动手。
      ...(watch.external_head
        ? [promptCopy("notices", "red.deliver.external_head",
            { sha: sha.slice(0, 12) }), ""]
        : []),
      "**失败摘要**",
      "",
      describePipelineRun(run, { fullSummary: true }),
      "",
      "**逐维度明细**(含工具)",
      "",
      ...(checks?.length ? summarizeFailedChecks(checks)
        : ["(平台未返回逐维度明细)"]),
      "",
      "**镜像产物**",
      "",
      artifacts.length
        ? `失败产物全文已镜像到会话工作区 pipeline/ 目录(${artifacts.join("、")}),先用 Bash 读全文再判断。`
        : "平台未返回本次失败产物,可按上方摘要与各维度链接判断,"
          + "或到交付平台的 MR/流水线页面查看。",
      "",
      ...evidenceLines,
      ...(previousFailureLines(previousSha, previousSummary)
        .flatMap((line, index) => index === 0 ? ["", line] : [line])),
      "",
      promptCopy("notices", "red.deliver.guidance", { repo }),
    ].join("\n"));
    this.log(`[issue-flow] ${live.id} 流水线红灯(${repo})`
      + `@ ${sha.slice(0, 12)},第 ${reds}/${max} 轮:失败事实已发送`
      + "(分诊交 AI)");
  }

  private pipelineEvidenceDelayMs(): number { return 3 * 60_000; }

  /** 全部具体报错缺失时先重取一次，仍缺则间隔重试；期间不发修复回合。 */
  private async collectPipelineEvidence(
    live: LiveIssue, repo: string, sha: string, run: PipelineRun,
    current: () => boolean,
  ): Promise<{ artifacts: string[]; lines: string[] } | undefined> {
    const watch = live.state.pipelines![repo];
    const priorDeadline = Date.parse(watch.evidence_retry_deadline ?? "");
    const budget = (this.options.settings?.runtime?.().poll_timeout_s ?? 1_800) * 1000;
    const deadline = Number.isFinite(priorDeadline) ? priorDeadline : Date.now() + budget;
    watch.evidence_retry_deadline = new Date(deadline).toISOString();
    // 取证中重启也要用同一份状态摘要评估并交给 Agent，包括末尾的报错。
    watch.evidence_failure_log = run.log;
    watch.watching = true;
    saveState(live.root, live.state);
    for (;;) {
      if (!current()) return;
      const diagnostics: string[] = [];
      let transientFailure = false;
      const artifacts = await this.mirrorPipelineArtifactsFor(live, repo, sha, current, (message, retryable) => {
        diagnostics.push(message);
        if (retryable) transientFailure = true;
      });
      if (!current()) return;
      const texts = artifacts.flatMap(name => {
        try { return [{ name, text: readFileSync(join(live.root, "pipeline", name), "utf8") }]; }
        catch { return []; }
      });
      const assessment = assessPipelineRepairEvidence({ checks: run.checks ?? watch.checks,
        artifacts: texts, failureSummary: run.log });
      const allMissing = assessment.failedDimensions.length
        ? assessment.availableDimensions.length === 0
        : isBlindPipelineInput(run.log?.trim() || MISSING_FAILURE_PLACEHOLDER, texts.length > 0)
          || (transientFailure && !texts.length && !hasActionablePipelineSummary(run.log ?? ""));
      watch.evidence_retry_attempts = (watch.evidence_retry_attempts ?? 0) + 1;
      const expired = Date.now() >= deadline;
      // 已派过同提交或关闭自动修复时保留原停机规则，不额外等待取证。
      const stopped = watch.last_repair_sha === sha
        || (watch.reds ?? 0) >= repairBudget(this.options.settings);
      if (!allMissing || expired || stopped || !this.options.platformUrl) {
        const lines = pipelineEvidenceLines(assessment, texts);
        if (allMissing && !assessment.failedDimensions.length) lines.push("失败维度未知：平台未返回逐维度明细，摘要没有可定位报错。");
        if (allMissing) lines.push(...diagnostics);
        if (allMissing && expired) lines.push("取证重试已到期。若仍无法定位，请调 raise_gate(kind=pipeline_evidence)，"
          + "将上述缺失维度与原因原样写入 supplement，请用户补充报错原文。");
        else if (assessment.missingDimensions.length) lines.push("先修复已有证据的问题；缺失维度不要猜改，必要时单独请求补证。");
        watch.watching = false;
        delete watch.evidence_retry_deadline;
        delete watch.evidence_retry_attempts;
        delete watch.evidence_failure_log;
        if (live.state.stage_note.startsWith("流水线具体报错暂缺，正在重试取证")) {
          live.state.stage_note = allMissing ? "流水线取证重试已结束，等待会话判断缺失证据"
            : "流水线具体报错已取得，继续处理红灯";
        }
        saveState(live.root, live.state);
        return { artifacts, lines };
      }
      live.state.stage_note = `流水线具体报错暂缺，正在重试取证(第 ${watch.evidence_retry_attempts} 次)，未消耗修复轮次`;
      saveState(live.root, live.state);
      this.log(`[issue-flow] ${live.id} ${repo}@${sha.slice(0, 12)} ${live.state.stage_note}`);
      if (watch.evidence_retry_attempts > 1) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(this.pipelineEvidenceDelayMs(), Math.max(0, deadline - Date.now())));
          timer.unref?.();
        });
      }
    }
  }

  /** 失败产物的平台侧镜像(红灯终态处理取证):全文落会话工作区
   *  pipeline/,AI 用 Bash 读原文判断与修复,不啃截断摘要。 */
  private mirrorPipelineArtifactsFor(
    live: LiveIssue,
    repo: string,
    sha: string,
    current?: () => boolean,
    onDiagnostic?: (message: string, retryable?: boolean) => void,
  ): Promise<string[]> {
    if (!this.options.platformUrl) return Promise.resolve([]);
    const mrUrl = live.state.mrs?.find((item) => item.repo === repo)?.url;
    return mirrorPipelineArtifacts({
      platformUrl: this.options.platformUrl,
      sha, repo, mrUrl,
      current,
      dir: join(live.root, "pipeline"),
      headers: this.platformHeaders(live.state.account),
      log: (message, retryable) => {
        onDiagnostic?.(message, retryable);
        this.log(`[issue-flow] ${live.id} ${message}`);
      },
    }).catch(() => [] as string[]);
  }

  /** 派发修复账的清理(绿了清账):刹车账随红灯环作废——下一轮红灯
   *  从干净账起算。 */
  private clearRepairLedger(watch: NonNullable<
    IssueSessionState["pipelines"]>[string]): void {
    delete watch.last_repair_sha;
    delete watch.last_failure_summary;
    delete watch.evidence_retry_deadline;
    delete watch.evidence_retry_attempts;
    delete watch.evidence_failure_log;
  }

  /** mr_green 收口(2026-09-02 拍板,ADR-0013:流程终点=流水线全绿,
   * 换库验证封存):当前阶段 fixedComplete、用户小鲁班通知、等归属人
   * 合入即自动归档(ADR-0034,归档收尾走终态卫生尾巴)。合入前用户
   * 续聊即重开本阶段返工(见 reply 的收口重开),AI 修完重推再申报,
   * 可多轮。ticket 场景状态保持 idle——收口是"等合入事实",不是终态;
   * mr_repair 场景总结轮结束后落 archived(ADR-0073:修复会话的终点
   * 就是修绿,不再永驻 idle 占现场)。 */
  private closeMrGreen(live: LiveIssue, note: string): void {
    fixedComplete(live.state, note);
    // 收口即启动合入事实监看(ADR-0022):两条收口路都汇到这里,
    // 单例防重入;重启恢复由 recover() 补挂。
    this.watchMergeStates(live);
    if (live.state.scenario === "mr_repair") {
      live.state.stage_note = "流水线修复完成";
      // 总结轮在飞的旗子(ADR-0073):settle 的 turn_finished 据此落
      // archived。持久化——崩溃后 recover() 重放总结轮,收口照样完成。
      live.state.mr_repair_closing = true;
      saveState(live.root, live.state);
      this.startPlatformTurn(live, "已有 MR 的当前提交流水线已通过。请总结本次修复并结束本轮；本轮回结束后本工具将自动归档收口，不推进 DTS、审批或合入。");
      return;
    }
    // 全绿事实发送(ADR-0024,#246):平台不代举验证卡——收口后把
    // 事实交给 AI,由它经 raise_gate 落卡(前置校验会复核全绿+收口)。
    // 欠卡由催办机器打回(shouldNudgeFixed 的出口卡未清判据),
    // 长期缺席由守闸器喊人(#248)。
    live.state.stage_note = MR_GREEN_ENV_VERIFY_NOTE;
    saveState(live.root, live.state);
    this.startPlatformTurn(live, promptCopy("notices", "green.deliver", {
      repos: (live.state.mrs ?? []).map((mr) => mr.repo).join(", "),
    }));
    this.log(`[issue-flow] ${live.id} MR 全绿收口,全绿事实已发送`
      + "(验证卡改由 AI 经 raise_gate 举出)");
  }

  /** mr_green 是否已收口(本阶段 stage_states=done)。监看器的滞后终态处理
   * 与重复放行都靠它挡——收口后再处理不重通知、不重记账。 */
  private mrGreenClosed(state: IssueSessionState): boolean {
    if (!state.scenario) return false;
    const index = fixedStageIndex(state.scenario, "mr_green");
    return index >= 0
      && (state.stage_states?.[index] ?? "pending") === "done";
  }

  /** 红灯取证的评估输入:把刚镜像到会话工作区 pipeline/ 的产物读回
   *  文本(镜像委托返回的是文件名清单,逐维度评估需要内容;直接读盘,
   *  不动公共委托的签名)。读不出的产物(二进制等)当没有,不拦主链路。 */
  private pipelineArtifactTexts(live: LiveIssue): PipelineArtifactText[] {
    const dir = join(live.root, "pipeline");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const texts: PipelineArtifactText[] = [];
    for (const name of names) {
      try {
        texts.push({ name, text: readFileSync(join(dir, name), "utf-8") });
      } catch {
        // 单个产物读不出只损失它自己的取证路,其余照评。
      }
    }
    return texts;
  }

  /** 问题的人话称呼(通知共用的展示形态):绑了单号就带单号,没绑
   *  就裸标题。 */
  private issueSubject(live: LiveIssue): string {
    const { state } = live;
    return state.ticket
      ? `${state.title}(单号 ${state.ticket})` : state.title;
  }

  // ---- 守闸器(#248,ADR-0024):应举的卡长时间缺席,纯报警 ----

  private watchdogTimer?: ReturnType<typeof setInterval>;

  /** 守闸阈值旋钮(现读现判):分钟值,缺省 120;0=关闭;负值/非数
   *  按缺省。节拍=阈值的 1/5,下限 500ms 防热转。 */
  private envVerifyWatchdogKnobs(): { thresholdMs: number; tickMs: number } {
    const knobs = this.options.settings?.runtime?.() ?? {};
    const raw = knobs.env_verify_watchdog_minutes;
    const minutes = typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? raw : ENV_VERIFY_WATCHDOG_MINUTES_DEFAULT;
    const thresholdMs = minutes * 60_000;
    return { thresholdMs, tickMs: Math.max(500, Math.floor(thresholdMs / 5)) };
  }

  /** 守闸器启动(服务启动即挂):周期扫描全 live 会话。表恒挂、阈值
   *  每拍现读——启动时关(0)后来经管理页开到非 0,下一拍即生效,不用
   *  重启;unref 不阻进程关停,关停时显式清。 */
  private armEnvVerifyWatchdog(): void {
    const { tickMs } = this.envVerifyWatchdogKnobs();
    // 首扫立即执行一次:重启后等一个节拍才首扫没有意义,阈值本身已经
    // 是"留足时间"的口径。
    this.sweepEnvVerifyWatchdog();
    const timer = setInterval(() => this.sweepEnvVerifyWatchdog(), tickMs);
    timer.unref?.();
    this.watchdogTimer = timer;
  }

  /** 一拍守闸扫描(#248,ADR-0024):机械判据=「mr_green 已收口+
   *  会话空闲+无任何闸在等+无在途流水线监看+收口已超阈值」——正是
   *  "平台认为没事可做,但验证卡没交出去"的静默态。waiting_user
   *  (有人被等)/running(回合在飞,卡可能正在举)/接管中/终态一律
   *  不喊;在途监看也不喊(#374):推送撤卡后修复环在飞,卡缺席是
   *  暂态,跑完自见分晓(绿→真空再喊,红→修复回合接着来),飞行中
   *  喊人只会把人叫来打断正在跑的修复。纯报警:不改会话状态、不举卡、
   *  不开回合;通知 fail-open,发送失败只记日志。幂等靠 outcome 通道
   *  按 (taskId,status) 去重——status 带轮次,返工新一轮是新事件。 */
  private sweepEnvVerifyWatchdog(): void {
    // 阈值每拍现读(评审修正):0=关即刻生效,改大改小不用重启。
    const { thresholdMs } = this.envVerifyWatchdogKnobs();
    if (thresholdMs <= 0) return;
    for (const live of this.live.values()) {
      const { state } = live;
      if (state.status !== "idle" || state.gate || state.takeover) continue;
      if (Object.values(state.pipelines ?? {})
        .some((item) => item.watching)) continue;
      if (!state.scenario || state.stage !== "mr_green") continue;
      const index = fixedStageIndex(state.scenario, "mr_green");
      if (index < 0 || (state.stage_states?.[index] ?? "pending") !== "done") {
        continue;
      }
      // 只认「收口待验证」的现场(评审修正):停机说明精确等于收口
      // 常量才可能欠卡。旧现场(ADR-0043 前答过「验证通过」的存量单,
      // 停机说明是「环境验证通过…」口径)不喊——若不区分,已验证的
      // 单子会被误报漏卡,诱使用户发「继续」推进。返工重开会把阶段
      // 标回 in_progress,也到不了这里。
      if (state.stage_note !== MR_GREEN_ENV_VERIFY_NOTE) continue;
      const closedAt = Date.parse(state.stage_at);
      if (!Number.isFinite(closedAt)
        || Date.now() - closedAt < thresholdMs) continue;
      const round = state.round ?? 1;
      this.log(`[issue-flow] ${live.id} 环境验证卡缺席超时`
        + `(收口 ${state.stage_at},第 ${round} 轮),守闸器报警`);
      void this.options.notifier?.notifyOutcome({
        taskId: live.id,
        account: state.account,
        status: round > 1
          ? `环境验证卡超时未举(第 ${round} 轮)` : "环境验证卡超时未举",
        summary: `${this.issueSubject(live)}:MR 已全绿收口`
          + `(${new Date(closedAt).toISOString()}),但超过阈值仍没有`
          + "环境验证卡——可能漏举。请到问题单查看:必要时发「继续」"
          + "让 Agent 补举验证卡,或验证后取消会话",
        link: this.issueLink(live.id),
      }).catch((error) =>
        this.log(`[issue-flow] ${live.id} 守闸报警发送失败(旁路,`
          + `会话状态一字不动): ${String(error)}`));
    }
  }

  /** 放弃点 → 小鲁班(票 81,需求侧 notifyRepairStopped 同语义):
   * 预算烧完/轮询超时这类"机器放弃、需要人接手"的时刻必须主动喊人,
   * 不能等人自己刷网页。两条纪律:
   * - 幂等靠 outcome 通道既有机制(键=会话:原因:仓:提交,taskId 已含
   *   会话 id),同因重复停机/恢复重放只发一条,不自造去重;
   * - 旁路 fail-open:发送失败只记日志,停机留痕一字不动。
   * 只在放弃点调用——开始派发修复/修复进行中不通知(2026-09-03 拍板)。 */
  private notifyPipelineStopped(
    live: LiveIssue,
    status: string,
    summary: string,
  ): void {
    const { notifier } = this.options;
    if (!notifier) return;
    void notifier.notifyOutcome({
      taskId: live.id,
      account: live.state.account,
      status,
      summary,
      link: this.issueLink(live.id),
    }).catch((error) =>
      this.log(`[issue-flow] ${live.id} 停机通知失败(旁路,留痕照旧): `
        + String(error)));
  }

  /** 平台身份头(与 pipelineClient 的 pipelineHeaders 完全同形):
   *  产物端点与状态端点同一鉴权形态,凭据止步宿主。 */
  private platformHeaders(account: string): Record<string, string> {
    const credential = this.options.gitCredential?.(account);
    return credential
      ? {
          "x-mfc-git-user": encodeURIComponent(credential.username),
          "x-mfc-git-token": encodeURIComponent(credential.password),
        }
      : {};
  }

  /** 平台侧开回合(闸门裁决/流水线结果的交接词)。会话正忙(等用户/
   * 运行中/终态)时不抢方向盘:通知挂到 stage_note,续聊提示词会带上。 */
  private startPlatformTurn(live: LiveIssue, message: string): void {
    const { state } = live;
    // 投递账(ADR-0053):平台递给 AI 什么、为什么没递到——判定分支
    // 留痕与事实留痕同等,三分支各记一行(steer 入忙回合/便签停靠/开新回合)。
    const delivery = (decision: string, why: string) =>
      sessionAudit(live.root, live.id, "delivery", {
        kind: "delivery.turn",
        msg: `平台消息投递:${decision}——${message.slice(0, 160)}`,
        decision, why, turn_id: live.auditTurnId,
        stage: state.stage, status: state.status,
      });
    // 忙时 steer 优先(2026-09-09,issue-20 复盘):不抢方向盘但也不干等,
    // 话递进正在跑的回合;收口前没送达的由 settle 的补发分支接力;
    // 现场不在(排队窗口)或等人/终态才落便签等续聊带上。
    if (this.turning.has(live.id) && live.driver
        && !isTerminal(state.status) && state.status !== "waiting_user" && !state.takeover) {
      delivery("steer", "回合进行中,递进在跑的回合;收口未送达由 settle 补发接力");
      // steer 只入队不抛错;旁路 fail-open,递不进去就退回挂便签。
      void live.driver.steer(message)
        .catch(() => this.parkPlatformNotice(live, message));
      return;
    }
    if (isTerminal(state.status) || this.turning.has(live.id)
        || state.status === "waiting_user" || state.status === "queued" || !!state.takeover) {
      delivery("parked", isTerminal(state.status) ? "会话已终态"
        : state.status === "waiting_user" ? "等人状态,随续聊带上"
        : state.status === "queued" ? "排队窗口,现场不在"
        : "现场由责任人接管中");
      this.parkPlatformNotice(live, message);
      return;
    }
    this.continueTurn(live, message);
  }

  /** 平台通知的落便签口:不抢回合——首行进 stage_note(显示摘要;闸卡
   *  在场时不动 stage_note,等待语义以卡为准,便签抬头别把人引向错误
   *  的状态),全文进欠账队列(#244 发送必达):stage_note 装不下也丢
   *  不了,续跑(答卡原地续跑/重启重建作答)时经 takeParkedNotices
   *  注入模型上下文。同文重复入队只记一次(监看重放/重复通知不去重
   *  会双份注入)。 */
  private parkPlatformNotice(live: LiveIssue, message: string): void {
    const full = message;
    const queue = live.state.parked_notices ?? (live.state.parked_notices = []);
    if (!queue.includes(full)) {
      queue.push(full);
      sessionAudit(live.root, live.id, "delivery", {
        kind: "delivery.park",
        msg: `通知停靠便签(续跑随行):${full.slice(0, 160)}`,
        turn_id: live.auditTurnId,
      });
      // 补充要求和批注不能按长度截断，也不能用新消息覆盖尚未送达的旧要求。
    }
    if (!live.state.gate) {
      live.state.stage_note = message.split("\n")[0].slice(0, 120);
    }
    saveState(live.root, live.state);
  }

  /** 取走全部欠账便签(取走即清账并落盘);无欠账返回空数组。 */
  private takeParkedNotices(live: LiveIssue): string[] {
    const queue = live.state.parked_notices;
    if (!queue?.length) return [];
    live.state.parked_notices = undefined;
    saveState(live.root, live.state);
    return queue;
  }

  /** 欠账便签的注入词:拼在决定回执/续聊词之后随行送达模型(#244)。 */
  private parkedReplay(notices: string[]): string {
    if (!notices.length) return "";
    return promptCopy("notices", "parked.replay",
      { items: notices.join("\n\n") });
  }

  /** 欠账便签的取用护栏(#244 发送必达):取走即清是常态,但回合体
   *  在交接前炸掉(容器/会话开启失败等基础设施异常)时原样退回——
   *  通知不能因为一次抖动就静默蒸发。模型侧失败不炸回合体(在
   *  driver 内部收口成 outcome),由既有 settle/催办机器接手。 */
  private async withParkedNotices<T>(
    live: LiveIssue,
    fn: (replay: string) => Promise<T>,
  ): Promise<T> {
    const notices = this.takeParkedNotices(live);
    try {
      return await fn(this.parkedReplay(notices));
    } catch (error) {
      if (notices.length) {
        const queue =
          live.state.parked_notices ?? (live.state.parked_notices = []);
        queue.unshift(...notices);
        saveState(live.root, live.state);
      }
      throw error;
    }
  }

  // ---- 关停 ----

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    const work = [...this.live.values()].map(async (live) => {
      live.controlEpoch += 1;
      const stopped = await Promise.allSettled([live.driver?.abort(), this.stopContainer(live)]);
      const errors = stopped.flatMap((item) => item.status === "rejected" ? [item.reason] : []);
      if (errors.length) throw new AggregateError(errors, "会话或容器未能停止");
      this.releaseDriver(live);
    });
    const settled = await Promise.allSettled(work);
    const failures = settled
      .filter((item): item is PromiseRejectedResult => item.status === "rejected")
      .map((item) => item.reason);
    if (failures.length) {
      throw new AggregateError(failures,
        `问题会话关停时有 ${failures.length} 个容器未能确认回收`);
    }
  }
}

/** 供 server 路由做类型收窄的状态导出。 */
export type { IssueStatus, IssueSummary };
