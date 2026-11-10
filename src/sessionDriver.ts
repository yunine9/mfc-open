import { pendingDecisionsPrompt } from "./pendingDecisionsPrompt.ts";
import { GitAiSession, gitAiEnabled } from "./gitAi.ts";
import { SessionCompaction } from "./sessionCompaction.ts";
import { saveAnalysisContextSnapshot } from "./analysisContextSnapshot.ts";
export { looksLikeContextOverflow, compactionInstructions } from "./sessionCompaction.ts";
import { GIT_COMMIT_IDENTITY_GUIDANCE } from "./gitCommitIdentity.ts";
import { COMPONENT_ANALYST, COMPONENT_PLANNING_GUIDANCE, childKnowledgeTools, componentAnalysisPrompt, type ComponentAnalysisContext } from "./componentKnowledgePlanning.ts";
import type { ComponentKnowledgeConsumption } from "./componentKnowledgeConsumption.ts";
import { renderAgentDecision } from "./ownerDecisionContext.ts";
import { openSessionCheckpoint, restorePendingToolResults, type SessionCheckpoint } from "./sessionCheckpoint.ts";
/**
 * 进程内会话驱动(详设 §7 pi_session 的 TS 形态)。
 *
 * Pi 以 SDK 形式嵌入同一进程:tool_call 钩子即同步拦截(五问第 1 问),
 * 自定义工具的未 resolve Promise 即人工节点挂起(§5 挂起路线),
 * 子 Agent = 同进程再开一个 AgentSession(§6 平行会话)。
 * Python 版的 HTTP 环回桥与 RPC stdout 解析在这个形态下整层消失。
 *
 * 登记归属规则(防双行):谁执行谁登记——pi 真实执行的工具由
 * tool_execution_end 登记;宿主代演的(人工决定、子 Agent 结果)由
 * driver 自己 emit,pi 对这些 call_id 的回声一律丢弃。
 */

import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  createEditToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { withModelTransport } from "./modelTransport.ts";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { EventLog, type SemanticEvent, type SemanticEventKind, validateEvent } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate, type WaitingRecord } from "./humanGate.ts";
import { createWorkspaceBashToolDefinition } from "./bashOutputMirror.ts";
import { MAE_BUILD_SKILLS, maeBuildRoot } from "./maeBuildSupport.ts";
import { materializeHostSkills } from "./hostSkillRuntime.ts";
import {
  modelTokenUsageSample,
  type ModelTokenUsageSample,
} from "./tokenUsage.ts";
import {
  KnowledgeTrace,
  type KnowledgeResourceRef,
} from "./knowledgeTrace.ts";
import type { MaterializedBusinessModuleKnowledge } from "./businessModuleRuntime.ts";
import { materializeTaskKnowledgeIndex } from "./taskKnowledgeIndex.ts";
import {
  createInspectImageTool,
  createVisionToolState,
  type VisionCapabilityConfig,
} from "./visionCapability.ts";
import {
  resourceBlocked,
  resourceBlockNotice,
} from "./repositoryResourcePolicy.ts";

/** pi 工具名 → 内核工具词汇表。不认识的原样透传(错认比不认更危险)。 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  inspect_image: "InspectImage",
};

/** 决定 → 结构化回答。显式 answers 优先;单问题卡由 decision 兜底
 * (问题文本作键,老宿主回传就是这个形状)。 */
export function answersOf(
  record: { decision: string; answers?: Record<string, string> },
  waiting: { question: Record<string, any> },
): Record<string, string> {
  if (record.answers && Object.keys(record.answers).length) {
    return record.answers;
  }
  const questions = Array.isArray(waiting.question?.questions)
    ? waiting.question.questions
    : [];
  if (questions.length === 1) {
    return { [String(questions[0]?.question ?? "问题")]: record.decision };
  }
  return { 最终确认: record.decision };
}

const HOST_TOOLS = new Set(["AskUserQuestion", "Task"]);

/** 有些模型在输出预算耗尽时已经吐出了工具调用开头，却没生成完整参数。
 * Pi 会把它记成一次普通 tool error，随后回合仍以 end_turn 收口；如果宿主
 * 不单独识别，任务就会在当前步骤反复催办，看起来永远“正在推进”。 */
export function fatalToolExecutionError(
  name: string,
  result: string,
  isError: boolean,
): string | undefined {
  if (!isError) return undefined;
  const text = result.trim();
  const outputLimit = /output token limit|maximum output tokens|max[_ -]?tokens|输出(?:长度|令牌|token)?.{0,8}(?:上限|限制)/i.test(text);
  const unexecuted = /not executed|was not run|未执行|没有执行/i.test(text);
  if (!outputLimit || !unexecuted) return undefined;
  return `模型回复超过输出上限，${name || "工具调用"}没有真正执行。`
    + "任务已停在可恢复位置，请点“重跑续推”继续；已有数据不会丢失。";
}

/** 模型网关的失败会直接进入任务卡。限流响应常夹带整段 JSON、内部错误
 * 类型与 request_id；这些对开发者没有行动价值，反而把真正的恢复时间
 * 淹没。只收敛已明确识别的 429/额度错误，其他故障仍保留原文供排查。 */
export function userFacingModelFailure(detail: string): string {
  if (!looksLikeRateLimited(detail)) return detail.trim();
  const raw = detail.trim();
  const reset = raw.match(/限额将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/)?.[1];
  return reset
    ? `模型额度已用完，将于 ${reset} 恢复。任务已停在可恢复位置；`
      + "额度恢复后点“重跑续推”，已有数据不会丢失。"
    : "模型服务当前限流（429）。任务已停在可恢复位置；稍后点“重跑续推”，"
      + "已有数据不会丢失。";
}

/** 限流/额度类失败(429 家族,票 #159):时间可恢复——问题流对这类
 *  session_ended 落「停机待恢复」而不是判死。判据与
 *  userFacingModelFailure 同源(含它改写后的友好文案,判别要在映射
 *  两侧都成立),别处不要另写第三份正则。 */
export function looksLikeRateLimited(detail: string): boolean {
  return /(?:\b429\b|rate[_ ]limit|使用上限|额度已用完|限额.*重置|quota exhausted)/i
    .test(detail);
}

/** 模型网关认证失败(401 家族,2026-09-22 实锤:上游偶发以 401 拒绝
 *  有效密钥):与限流同属时间可恢复的模型侧失败。判别对象是 pi 收口的
 *  模型层错误原文——git 凭据报错走工具路径(issueGit),到不了这里。 */
export function looksLikeAuthFailure(detail: string): boolean {
  return /(?:\b401\b|unauthorized|authentication failed|(?:invalid|incorrect|expired|missing).{0,24}(?:api[ _-]?key|token|credentials?)|api[ _-]?key.{0,24}(?:invalid|expired|incorrect|not valid|missing))/i
    .test(detail);
}

/** pi 的"忙撞"拒答(issue-20 实锤):prompt 允诺已回、会话还自认忙的
 *  收尾窗口里再 prompt,pi 原文就是这一句。识别它不是为了吞——是让
 *  调用方区分"会话坏了"和"递早了一拍",后者让一拍重投即可。 */
export function looksLikeBusyCollision(detail: string): boolean {
  // 只认 Pi 拒收 prompt 的完整特征。普通工具报错里也可能出现
  // “already processing”，把它误判成可重投会吞掉真正的失败。
  return /Agent is already processing\.\s*Specify streamingBehavior\b/i
    .test(detail);
}

/** 忙撞重投前让出的节拍:pi 收尾是微任务+流关闭级别的活,250ms 足够
 *  它走完;再长就是在猜网络,不该在这层猜。 */
const BUSY_RETRY_DELAY_MS = 250;

/** 输出超限截断(issue-12 实锤)的识别:fatalToolExecutionError 的产出
 *  形状。导出给宿主(问题流 settle)做同款"可恢复"落点判断——工具没
 *  执行≠任务失败,代码与证据都还在。 */
export function looksLikeOutputTruncation(detail: string): boolean {
  return detail.includes("模型回复超过输出上限")
    && detail.includes("没有真正执行");
}

/** 输出超限纠偏重试预算:与催办预算同一哲学——纠偏不是永动机,模型
 *  连续无视精简指令就该交还人工,而不是无限烧请求。 */
const OUTPUT_TRUNCATION_RETRIES = 2;

/** 认证失败退避表(2026-09-22,上游偶发 401):预算=表长,穷尽就如实
 *  上交,落点语义交宿主 settle(问题流落「停机待恢复」不判死)。间隔
 *  可经 CloudSessionOptions.authRetryDelaysMs 覆盖(测试注快值)。 */
const AUTH_FAILURE_RETRY_DELAYS_MS = [10_000, 30_000];

function authFailureRetryNotice(attempt: number, budget: number): string {
  return `平台重试(第 ${attempt}/${budget} 次):上一条模型请求被模型网关以 `
    + "401 拒绝,判定为上游瞬时认证抖动,已自动重试。会话现场完好,已有"
    + "工作都在,从中断处继续推进即可,不要重做已完成的工作。";
}

function outputTruncationRepairNotice(attempt: number): string {
  return `平台纠偏(第 ${attempt}/${OUTPUT_TRUNCATION_RETRIES} 次):`
    + "上一条回复超出模型输出上限,工具调用的参数被截断,没有真正执行。"
    + "请重新发起同一意图的调用,这次必须大幅精简:正文每段两三句、"
    + "选项只留关键词,内容多就拆成多次短调用。已有工作都在,不要重做。";
}

/** AskUserQuestion 的工具描述(模型决定提问的那一刻必读,是方法级
 * 拦截位)。问题会话(knowledgeScope=issue)追加 grilling 指路:
 * vendor 技能的索引描述是"用户发起"口径,AI 自发对齐在渐进发现里
 * 匹配不到,成组对齐只能靠这里与介入节奏文本常驻点名(2026-09-11
 * 触发链诊断)。任务会话不物化该技能,不追加。 */
export function askToolDescription(scope?: "task" | "issue"): string {
  const base = "向用户提出结构化问题并等待决定。需要用户确认或选择时必须调用本工具,"
    + "不要在正文里描述问题然后自行假设答案。一张卡可含多个问题"
    + "(如配置确认 + 交付方式合并成一次提问)。"
    + "context 会原样显示为网页和小鲁班的‘决策背景’，请填写用户看得懂的"
    + "事实、证据或影响摘要；禁止填写 apply/git/Bash 等内部操作过程。"
    + "决策卡只保留做决定所必需的最少信息：问题一句话、选项简短清楚，"
    + "背景只解释关键差异或影响，不平铺长段说明、不复述整份方案。"
    + "设计、验收和技术细节放在对应文档，卡片先给必要事实，最后请用户确认。"
    // 实战实测:正文预告"两个衍生题一次问完",工具调用只带了一题,
    // 另一题要么多花一轮补问,要么被自行拍板。预告即契约。
    + "需要用户拍板的业务或设计问题，先按系统指引保存未决决策，再立即举卡；不要把新交办当成旧问题已解决。"
    + "正文预告了几个问题,questions 就必须带几个——预告了却不发,"
    + "等于把没问过的事当已确认。";
  return scope === "issue"
    ? base + "成组对齐(现象/方案多问题)按技能 grilling"
      + "(skills/grilling/SKILL.md)的设计树组织:先现象后方案、一轮一卡。"
    : base;
}

export function validateAskUserQuestionInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return "缺少 questions";
  const request = input as Record<string, unknown>;
  const extra = Object.keys(request)
    .filter((key) => !["questions", "context", "purpose", "annotation_ids"].includes(key));
  if (extra.length) return `问题卡含不支持字段 ${extra.join("、")}`;
  if (request.purpose !== undefined
      && !["confirmation", "clarification"].includes(String(request.purpose))) {
    return "purpose 只能是 confirmation 或 clarification";
  }
  if (request.annotation_ids !== undefined
      && (request.purpose !== "clarification" || !Array.isArray(request.annotation_ids)
        || !request.annotation_ids.length
        || request.annotation_ids.some((id) => typeof id !== "string" || !id.trim())
        || new Set(request.annotation_ids).size !== request.annotation_ids.length)) {
    return "annotation_ids 只能用于 clarification，必须是非空、无重复的意见 ID 数组";
  }
  if (request.context !== undefined
      && (typeof request.context !== "string" || !request.context.trim())) {
    return "context 必须是非空的用户可见说明";
  }
  if (typeof request.context === "string" && request.context.length > 2_000) {
    return "context 最多 2000 字符";
  }
  const questions = request.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return "questions 必须包含至少一个问题";
  }
  if (questions.length > 4) return `一张卡有 ${questions.length} 个问题，最多四个`;
  for (let index = 0; index < questions.length; index += 1) {
    const value = questions[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `第 ${index + 1} 题不是问题对象`;
    }
    const question = value as Record<string, unknown>;
    const extra = Object.keys(question)
      .filter((key) => key !== "question" && key !== "options"
        && key !== "recommended");
    if (extra.length) {
      return `第 ${index + 1} 题含不支持字段 ${extra.join("、")}`;
    }
    if (typeof question.question !== "string" || !question.question.trim()) {
      return `第 ${index + 1} 题缺少问题正文`;
    }
    if (question.recommended !== undefined
        && typeof question.recommended !== "string") {
      return `第 ${index + 1} 题的 recommended 不是字符串`;
    }
    if (question.options === undefined) {
      // 推荐协议(ADR-0004):推荐挂在选项上,自由作答题带它是误用。
      if (question.recommended !== undefined) {
        return `第 ${index + 1} 题是自由作答题(未给 options),不能带 recommended`;
      }
      continue;
    }
    if (!Array.isArray(question.options)) {
      return `第 ${index + 1} 题的 options 不是数组`;
    }
    const options = question.options.map((option) =>
      typeof option === "string" ? option.trim() : "");
    if (options.length < 2) return `第 ${index + 1} 题只有 ${options.length} 个选项`;
    if (options.length > 6) return `第 ${index + 1} 题有 ${options.length} 个选项，最多六个`;
    if (options.some((option) => !option)) return `第 ${index + 1} 题含空选项`;
    if (new Set(options).size !== options.length) return `第 ${index + 1} 题含重复选项`;
    // 推荐是协议必填而非可选礼貌(将来无审批全自动模式要按它执行):
    // 必须给、trim 后与选项原文逐字命中。选项已去重,命中即唯一。
    const recommended = String(question.recommended ?? "").trim();
    if (!recommended) {
      return `第 ${index + 1} 题缺少推荐项:选项题必须带 recommended`
        + "(所推荐选项的原文)";
    }
    if (!options.includes(recommended)) {
      return `第 ${index + 1} 题的推荐项不在选项中:「${recommended.slice(0, 40)}」`
        + "须与 options 之一逐字一致(trim 后比对)";
    }
  }
  return undefined;
}

export interface Outcome {
  status: "turn_finished" | "waiting_for_human" | "session_ended";
  waiting?: WaitingRecord;
  reason?: string;
  detail?: string;
}

/** 深层宿主钩子(=内核 dispatch 合成,见 kernelHost.ts)。全部可选:
 * 不接时行为与演练模式一致,接上时内核契约成为真正的门禁与证据引擎。 */
export interface HostHooks {
  preTool?(event: SemanticEvent): Promise<{ action: string; reason?: string } | undefined>;
  /** 解析出字符串 = 内核退 2 的纠偏话,调用方须送回模型,不是失败。 */
  postTool?(event: SemanticEvent): Promise<void | string>;
  /** 普通进度说明附在本次工具结果中，不作为新用户插话重新启动回合。 */
  toolResultNote?(tool: { name: string; input: Record<string, unknown> }): Promise<string | undefined>;
  flush?(): Promise<void>;
}

/** 对人说话的口径。右栏会话流把主会话的每段话原样、按时间给人看;run7 真
 * 现场 145 段里 116 段是"我先看一下…"这类过程话,人要的是结论。规则的骨架
 * 借自 ayghri/i-have-adhd(用户点名的那份"让 agent 说人话"的 skill:先说
 * 动作、不寒暄、多步编号、收尾只给一个下一步、列表封顶五条、报错就事论事),
 * 再加上本仓的现场约束(不贴 diff/日志、说人话、用中文)。这是给模型的提示,
 * 不是流程规则,也不校验——说不说得好看试跑。 */
export const HUMAN_FACING_STYLE = [
  "【对人说话的口径】你在正文里说的每一段话都会原样、按时间显示给用户;用户看的是结论,不是过程。",
  "- 先说结论或要对方做的事,再给理由;不写开场白、寒暄、复述上文,也不写\"如有需要请告诉我\"这类收尾。",
  "- 交接语(举卡前、回合收口、需要人做事时)三段以内:结论一句;需要对方做什么;依据在哪(文件路径、提交号、材料名)。结尾只给一个下一步。",
  "- 多步的事用编号,一条一步;列表封顶五条,多了拆成\"现在做\"和\"以后做\"。",
  "- 每次收口顺手说一句进展到哪了(如\"五步里做完第三步\"),用户不会记得上一轮。",
  "- 落实用户的建议、批注或补充要求后，在阶段回报或收尾中用一两句话连起‘用户提出的具体想法 → 实际改动 → 已观察到的结果’，让用户看见自己的判断如何影响了交付；自然融入原回报，不另加庆祝段落，不逐次重复。",
  "- 例如（仅在事实支持时）：‘按你提出的统一入口方案，三个模块现在共用一套校验逻辑。’‘你提醒的超时场景已补上测试，刚刚执行通过。’未验证就说‘已补用例，尚未执行’，部分完成就说明剩余部分；未采纳的建议如实解释原因，不为了积极反馈而迎合。",
  "- 只归因于用户确实提出且已落实的内容，不把 Agent 自己的改动说成用户的贡献，不编造收益或验证结果，不评价用户聪明、不泛泛夸‘建议非常关键’；没有相关建议时照常简短汇报。",
  "- 不要把整段 diff、日志、命令输出贴进正文:给路径或一句摘要就够,正本在工作区和执行日志里。",
  "- 动手前的过程话(\"我先看一下…\"\"现在去跑测试\")能不说就不说,要说压成一句。",
  "- 报错就事论事:出了什么、原因、下一步怎么办;不写\"糟糕\"\"抱歉\"这类情绪词。",
  "- 说用户听得懂的话:内部步骤代号、工具名、hook 细节不必展开;术语第一次出现带一句人话解释。用中文。",
  "- 例外:用户要求详细解释、破坏性操作前的确认、真有歧义要问清时,该长就长。",
].join("\n");

export interface CloudSessionOptions {
  taskId: string;
  workspace: string;
  agentDir: string;
  provider: string;
  model: string;
  eventLog: EventLog;
  transcript: TranscriptStore;
  gate: GateService;
  humanGate: HumanGate;
  hostHooks?: HostHooks;
  /** 专项宿主会话可关闭人工问答工具。推送前编译/UT 会话必须自己收口，
   * 不能在交付临门一脚再生成一张脱离内核语义的等待卡。缺省保留原行为。 */
  allowHumanQuestions?: boolean;
  /** 专项旁路会话可关闭 Task，避免一个轻量助手再扩散出子 Agent 树。 */
  allowSubagents?: boolean;
  /** 专项会话仅暴露能执行的工具，同时让 SDK 生成与门禁一致的工具说明。 */
  allowedTools?: readonly string[];
  /** 面向人的问题卡文本整形(问题/选项/推荐/背景)。分析会话用它把模型
   * 写的 repo-N 序号换成仓库名——序号只在 prompt 清单里有意义,落到卡上
   * 人看不懂(内网实锤)。选项与 recommended 过同一个函数,逐字关系不破。 */
  humanizeQuestionText?: (text: string) => string;
  /** 正式检视的选项取自流程契约，不新增提问门禁。 */
  prepareHumanQuestion?: (input: Record<string, unknown>) => Record<string, unknown>;
  /** 直接面对人的会话(主会话、开发助手)挂"对人说话的口径":宿主提示,
   * 不做校验(用户 2026-09-05 拍板:不必强校验,提示词提示下让他说人话)。
   * 专项会话(编译/预热/抽取/需求检视)不面对人,不挂。 */
  humanFacing?: boolean;
  /** 举卡前的宿主核对(2026-09-05):Agent 要向人举卡时,先问宿主"此刻
   * 该不该举"。返回纠偏文字 = 不举:文字作为工具错误回给模型,原会话
   * 继续干活——不创建待办、不通知人,也不伪造人的同意。宿主用它拦
   * "检视意见还没处理完就举最终确认卡";已答过/已作废的重放不再问。 */
  beforeHumanQuestion?: (input: Record<string, unknown>) =>
    string | undefined | Promise<string | undefined>;
  /** 编译专项会话把长 Bash 的 stdout 节流写入事件账，供独立 SSE 实时
   * 展示。普通编码会话默认关闭，避免把高频输出灌进主事件账。 */
  streamBashOutput?: boolean;
  /** 同一任务事件账里的会话身份；缺省 main，旁路助手使用独立身份。 */
  sessionId?: string;
  /** 继续同一执行会话时打开明确绑定的原生记录；新任务/独立专项仍建立新会话。 */
  resumeSession?: boolean;
  currentStep?: () => string;
  memoryContext?: () => (messages: any[]) => Promise<any[]>;
  /** 仅在组件分析子会话启动时给出有界能力目录，不根据读代码行为选组件。 */
  componentAnalysisContext?: () => ComponentAnalysisContext;
  /** 容器隔离(设计文档):换掉内建 bash 的执行后端,命令进任务
   * 容器跑;工具仍叫 bash,门禁与 transcript 看到的世界不变。
   * 子会话经同一 openSession 装配,天然同套隔离。 */
  bashOperations?: BashOperations;
  /** root 宿主 + 非 root 容器时，内建 Write/Edit 成功落盘后立刻修正
   * bind 文件属主。回调失败会让本次工具调用失败，不把隐患拖到编译时。 */
  afterFileMutation?: (absolutePath: string) => void | Promise<void>;
  /** 宿主级 skill 源目录(部署时放一次,每个任务自动带)。运行时先把
   * 每个通过校验的完整 Skill 包只读投影到当前任务 .mae-flow-work，
   * 再把任务内路径交给 Pi，不能向 Agent 暴露部署数据目录的绝对路径。
   * 团队的两个
   * UT skill 在内网、出不来仓,老宿主是"每次手动集成进 ut-generator
   * 子 agent";云端子 Agent 照样有(Task 工具),缺的是自动装载——
   * pi 的 includeDefaults=false,不喂路径就一个 skill 都不装。 */
  hostSkillsDir?: string;
  knowledgeModuleDataDir?: string;
  /** 认证失败(401)重试的退避间隔表,预算=表长;缺省 10s/30s。测试
   *  注快值,生产不传。 */
  authRetryDelaysMs?: number[];
  /** 用任务固定的模块/仓库/语言画像筛选尚未定格的团队 Skill；新任务
   * 已在创建现场生成精确快照，后续会话不应重复匹配。 */
  knowledgeContext?: {
    repositories: string[];
    technologies: string[];
    businessModuleIds: string[];
  };
  /** 知识匹配口径:缺省 task;问题会话传 issue(ADR-0005)——未限定
   * 作用域的通用工程知识豁免进会话,技术栈维度不参与过滤。 */
  knowledgeScope?: "task" | "issue";
  /** 本单明确选中的仓库 Skill。每项必须是一个存在的 SKILL.md 文件；
   * 不能传 skills 目录，否则同目录下未选择的 Skill 也会被 Pi 扫入。
   * 跨仓时可同时传多个仓各自的文件，主/子 Agent 共用同一 allowlist。 */
  repositorySkillPaths?: string[];
  /** 与 repositorySkillPaths 一一对应的业务身份，仅用于知识足迹归因；
   * 缺失时仍能按实际 Skill 文件记录，不影响装载。 */
  repositorySkillResources?: Array<KnowledgeResourceRef & { actual_path: string }>;
  /** 管理员屏蔽的仓库行为资源。每次组装主/子会话时现读，确保设置修改
   * 对恢复中的任务也生效；只影响仓内 Skill/AGENTS，不屏蔽平台 Skill。 */
  repositoryResourceBlocks?: () => readonly string[];
  /** 多仓契约文件(spec #131 / issue #132,2026-09-03):问题流会话的
   * 代码仓平铺在 <workspace>/repo/<仓名>/ 下,而会话 cwd 是 workspace——
   * SDK 的祖先目录发现从 cwd 往上走,永远望不到仓根的 AGENTS.md。
   * 平台按与 SDK 相同的候选优先级逐仓收好(见 issueFlow 的
   * collectRepoContextFiles),这里原样并入系统提示词,顺序在知识
   * 索引之后。收集发生在上下文构建时:回合中途 pull_repo 新落地的
   * 仓,要等下一次会话重建才进入提示词。空/缺席=行为不变。 */
  repoContextFiles?: Array<{ path: string; content: string }>;
  /** 临时知识效果验证：不加载 SDK 自动发现及显式传入的既有 AGENTS 文件。 */
  excludeAgentFiles?: boolean;
  /** 会话专属宿主工具(defineTool 形状)。问题流这样的旁路会话用它把
   * 平台原子能力(报阶段/拉日志/受门禁的推送)递给 Agent——秘密留在
   * 宿主,Agent 只拿到工具语义。内核任务不传,行为不变。 */
  extraTools?: unknown[];
  /** 宿主的固定工作指令，主/子会话及恢复时都进入系统提示，不随对话压缩。 */
  additionalSystemInstructions?: readonly string[];
  /** 组件新增代码检查；主、子和恢复会话共用，知识查询沿用 knowledge。 */
  componentKnowledge?: ComponentKnowledgeConsumption;
  /** 创建任务时固定的业务模块知识。非 Skill 只进入统一轻量索引；
   * 正文保留为工作区文件，由 Agent 使用 Read/Grep 按需读取。 */
  businessModuleKnowledge?: MaterializedBusinessModuleKnowledge;
  knowledgeTrace?: KnowledgeTrace;
  /** 上下文超限自愈用的锚点提供者(通常是内核现场 current/config)。
   * 不给就用需求原话兜底——锚永远来自权威,不由云端编造。 */
  compactAnchor?: () => string;
  /** 模型提供方真实 usage 的旁路出口。统计失败不得影响会话。 */
  onTokenUsage?: (sample: ModelTokenUsageSample) => void;
  /** 专用图片理解模型。只给主开发/修复会话配置；子 Agent 经同一
   * openSession 继承，预热与 prepush 专项会话不隐式获得此能力。 */
  vision?: VisionCapabilityConfig;
  /** 只读分析会话的图片仍位于原任务目录；不扩大其他文件工具的权限。 */
  visionWorkspace?: string;
  log?: (message: string) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 环回流量强制直连:pi-ai 会跟随代理环境变量,内网 Clash 实测把
 * 127.0.0.1 的模型/桥请求劫走回 502。生产同样成立——网关走代理可以,
 * 环回不行。 */
export function ensureLoopbackDirect(): void {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const host of ["127.0.0.1", "localhost"]) {
      if (!entries.includes(host)) entries.push(host);
    }
    process.env[key] = entries.join(",");
  }
}

export class CloudSession {
  private session!: Awaited<ReturnType<typeof createAgentSession>>["session"];
  private modelRuntime!: Awaited<ReturnType<typeof ModelRuntime.create>>;
  private pendingTurn?: Promise<Outcome>;
  private turnInFlight = false;
  /** 人工工具仍挂起或模型仍在执行时，宿主不能借用工作区。 */
  get isIdle(): boolean { return !this.turnInFlight && !this.waitingRecord; }
  private waitingSignal = deferred<Outcome>();
  private decisionResolvers = new Map<string, (text: string) => void>();
  private waitingRecord?: WaitingRecord;
  private hostAnswered = new Set<string>();
  /** 宿主自己举的卡(如拆分提议):走同一条决定通道,但内核没见过这次
   * 提问,回执不进内核账本,也不再替 pi 补一条 AskUserQuestion 回声。 */
  private hostRaised = new Set<string>();
  /** 主会话本轮活动量与模型层错误:pi 把 API 失败静默成
   * stopReason="error" 的空 assistant 消息(run4 实测,回合零活动
   * 直接 end_turn),宿主必须自己识别,否则空转被标成 completed。 */
  private turnActivity = 0;
  private turnError = "";
  private turnTerminalError = "";
  /** abort() 的内存信号:退避等待中的认证重试醒来后据此放弃重投——
   *  取消/关停已把会话带走,再 prompt 是往死会话里灌消息。 */
  private aborted = false;
  private toolArgs = new Map<string, Record<string, unknown>>();
  private lastAssistantText = new Map<string, string>();
  /** 各会话最近一条 assistant 消息若是模型层错误,记下原文;成功消息即清除。
   * 子会话必须也记:pi 遇模型错误是正常收轮、prompt() 正常 resolve,不记的话
   * 子 Agent 死于 300s 掐线也会被当成"返回了",主 Agent 拿到的是失败前最后
   * 一句旁白(cross-glm53-20260906c 实锤,连派两次各白等 5 分钟)。 */
  private modelErrors = new Map<string, string>();
  private childCount = 0;
  private checkpoint?: SessionCheckpoint;
  private childSessions = new Map<string, any>();
  private pendingKernel = new Set<Promise<void>>();
  private kernelFailures: string[] = [];
  private readonly visionState = createVisionToolState();
  readonly sessionId: string;

  private constructor(private readonly options: CloudSessionOptions) {
    this.sessionId = options.sessionId ?? "main";
  }

  /** 主会话最后一段发言。修复会话不提交时,这就是它留给人的诊断
   * (缺什么、去哪配),halted 裁决原文上浮。 */
  finalReply(): string {
    return this.lastAssistantText.get(this.sessionId) ?? "";
  }

  static async create(options: CloudSessionOptions): Promise<CloudSession> {
    ensureLoopbackDirect();
    const driver = new CloudSession(options);
    // 模型请求套上长空闲预算的 fetch(见 modelTransport.ts 头注:Node 默认
    // 300s 掐线,GLM 长生成首 token 前的沉默经常超过它)。
    driver.modelRuntime = withModelTransport(await ModelRuntime.create({
      modelsPath: join(options.agentDir, "models.json"),
    }));
    driver.session = await driver.openSession({
      sessionId: driver.sessionId,
      customTools: [
        ...(options.allowHumanQuestions === false ? [] : [driver.askTool()]),
        ...(options.allowSubagents === false ? [] : [driver.dispatchTool()]),
      ],
    });
    options.transcript.mainSessionId = driver.sessionId;
    return driver;
  }

  // ---- 事实登记(事件日志 → transcript,顺序固定) ----

  private emit(
    kind: SemanticEventKind,
    sessionId: string,
    payload: Record<string, unknown>,
  ): SemanticEvent {
    const event: SemanticEvent = {
      eventId: this.options.eventLog.lastEventId() + 1,
      taskId: this.options.taskId,
      sessionId,
      ts: new Date().toISOString(),
      kind,
      payload,
    };
    const error = validateEvent(event);
    if (error) throw new Error(error);
    this.options.eventLog.append(event);
    this.options.transcript.record(event);
    return event;
  }

  // ---- 生命周期 ----

  async start(userMessage: string): Promise<Outcome> {
    if (this.checkpoint?.restored) return this.startResume(userMessage);
    this.emit("session_started", this.sessionId, { resume: false });
    return this.turnWithRepairs(userMessage);
  }

  /** 恢复原生上下文并补齐中断回执；流程与授权仍以宿主最新事实为准。 */
  async startResume(userMessage: string): Promise<Outcome> {
    await this.reconcileInterruptedWork();
    if (this.checkpoint?.restored) {
      restorePendingToolResults(this.checkpoint.manager, this.options.eventLog.replay(), this.sessionId);
      this.session.refreshContext();
    }
    this.emit("session_started", this.sessionId, { resume: true,
      context_restored: Boolean(this.checkpoint?.restored),
      restored_messages: this.checkpoint?.messageCount ?? 0,
      recovery_reason: this.checkpoint?.reason });
    // 降级开局(原生会话缺失/损坏)的告知语:不管具体原因是什么,都
    // 固定带上「勿从头重做」——恢复依据是工作区已有材料和执行记录
    // (ADR-0055:异常重跑的降级开局也走这里)。
    const continuity = this.checkpoint?.restored
      ? "原 Pi 会话上下文已恢复（含已返回的工具结果及压缩记录）。从实际未完成处继续，已完成的阅读、分析和子 Agent 报告可复用。"
      : `${this.checkpoint?.reason ?? "原 Pi 会话上下文不可用"}。`
        + "请依据工作区已有材料和执行记录恢复，勿从头重做。";
    return this.turnWithRepairs(`${continuity}\n以宿主本轮下发的最新用户决定、插话和批注为准；与历史上下文冲突时同步修订文档、测试和实现。旧执行目标不能推翻用户的新决定。current 只用于核对流程事实，不代表要重做整个步骤。未知结果先核实再重试。\n\n${userMessage}`);
  }

  /** Close the lifecycle gap left by a process crash.
   *
   * A tool/child that has a durable start event but no finish event is not a
   * success and not safe to redispatch silently.  Recovery first records an
   * explicit interrupted result into the same transcript/Hook ledger, then
   * lets the new session consult the kernel current step and retry normally. */
  private async reconcileInterruptedWork(): Promise<void> {
    const events = this.options.eventLog.replay();
    const nativeResults = new Map<string, any>();
    if (this.checkpoint?.restored) for (const message of this.checkpoint.manager.buildSessionContext().messages as any[]) {
      if (message.role === "toolResult") nativeResults.set(message.toolCallId, message);
    }
    for (const event of events) {
      if (event.kind !== "agent_spawned") continue;
      const payload = event.payload as Record<string, any>;
      const childId = String(payload.child_session_id ?? "");
      const callId = String(payload.call_id ?? "");
      if (childId && callId) {
        this.options.transcript.bindChild(childId, callId);
        const ordinal = /^child-(\d+)$/.exec(childId);
        if (ordinal) this.childCount = Math.max(
          this.childCount, Number(ordinal[1]));
      }
    }
    const finishedTools = new Set(events
      .filter((event) => event.kind === "tool_finished")
      .map((event) => `${event.sessionId}:${String(event.payload.call_id ?? "")}`));
    const finishedAgents = new Map(events
      .filter((event) => event.kind === "agent_finished")
      .map((event) => [String(event.payload.call_id ?? ""), event]));
    const observedAgents = new Set(events
      .filter((event) => event.kind === "agent_observed")
      .map((event) => Number(event.payload.source_event_id)));
    for (const event of events) {
      const payload = event.payload as Record<string, any>;
      if (event.kind === "tool_requested") {
        const callId = String(payload.call_id ?? "");
        const name = String(payload.name ?? "");
        if (!callId || name === "AskUserQuestion"
            || finishedTools.has(`${event.sessionId}:${callId}`)) continue;
        const native = event.sessionId === this.sessionId ? nativeResults.get(callId) : undefined;
        const interrupted = this.emit("tool_finished", event.sessionId, {
          call_id: callId, name, input: payload.input ?? {}, is_error: native ? Boolean(native.isError) : true,
          result: native ? native.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n")
            : "服务重启时发现该工具没有可靠完成记录，已按 interrupted 登记；先核实实际结果再决定是否重试",
        });
        this.trackKernelHook(this.options.hostHooks?.postTool?.(interrupted));
      }
      if (event.kind === "agent_spawned") {
        const callId = String(payload.call_id ?? "");
        if (!callId) continue;
        const childId = String(payload.child_session_id ?? "");
        const finished = finishedAgents.get(callId) ?? this.emit("agent_finished", event.sessionId, {
          call_id: callId, child_session_id: childId,
          lifecycle: "interrupted",
          final_text: "服务重启时发现子 Agent 未返回，已登记中断；可按原任务卡受控重派",
        });
        if (!observedAgents.has(finished.eventId)) {
          await this.recordAgentCompletion(finished, {
            subagent_type: payload.agent_type,
            description: payload.description,
            prompt: payload.prompt,
          });
        }
      }
    }
    const failure = await this.flushKernel();
    if (failure) throw new Error(
      `恢复中断现场时内核登记失败，任务已安全停止: ${failure}`);
  }

  /** 恢复场景的决定回注:旧会话已死,没有挂起的工具调用可 resolve,
   * 但登记义务不变——宿主代演的工具结果由 driver 登记(tool_result
   * 与崩溃前落盘的 tool_use 行按 call_id join),答案走 posttooluse
   * 进内核台账,重建会话执行 messages 就能看到。 */
  injectDecision(record: WaitingRecord): void {
    this.emit("human_decision", this.sessionId, {
      waiting_id: record.waiting_id,
      state_version: record.state_version,
      decision: record.decision,
      notes: record.notes,
    });
    const finished = this.emit("tool_finished", this.sessionId, {
      call_id: record.call_id,
      name: "AskUserQuestion",
      input: record.question,
      is_error: false,
      result: renderAgentDecision(record),
      answers: answersOf(record, record),
    });
    this.trackKernelHook(this.options.hostHooks?.postTool?.(finished));
    this.hostAnswered.add(record.call_id);
  }

  /** Queue a Hook write without blocking the model, but never lose failure.
   *
   * The old fire-and-forget path kept the process alive by swallowing every
   * rejection.  That also let a task advance after its authorization/evidence
   * write had failed.  We now isolate the process in the same way, then flush
   * and adjudicate these writes before the turn can settle. */
  private trackKernelHook(work: Promise<unknown> | undefined): void {
    if (!work) return;
    let tracked!: Promise<void>;
    tracked = work.then((feedback) => {
      // 解析出字符串 = 内核退 2 的纠偏话(补模板章节、对账不符)。那是
      // 让模型改的指令,不是登记失败——进 kernelFailures 会把"让模型改"
      // 升级成整单判死(内网实锤:IMPLEMENTATION 缺一节,任务 failed,
      // push/MR 全没发生,而模型全程没见过那句话)。
      if (typeof feedback === "string" && feedback.trim()) {
        this.relayKernelFeedback(feedback.trim());
      }
    }).catch((error) => {
      const detail = String(error);
      this.kernelFailures.push(detail);
      this.options.log?.(
        `任务 ${this.options.taskId} 内核授权/证据登记失败(fail-closed): `
        + detail);
    }).finally(() => this.pendingKernel.delete(tracked));
    this.pendingKernel.add(tracked);
  }

  /** 把内核 posttooluse 的纠偏话送回模型。单机形态里这段 stderr 由
   * harness 直接喂进上下文;云端的等价通道是 steer——当前工具调用一做完
   * 就送达,模型在同一轮里补。撞上回合收口没送到也不丢:settleTurn 的
   * "未送达插话补发"会连它一起取回补发。送达失败只记日志(fail-open):
   * 反馈丢了顶多这轮没纠,下次写同一文件内核还会再说一遍。 */
  private relayKernelFeedback(text: string): void {
    Promise.resolve()
      .then(() => (this.session as any).steer(text))
      .then(() => this.emit("user_message", this.sessionId,
        { text, via: "kernel" }))
      .catch((error) => this.options.log?.(
        `任务 ${this.options.taskId} 内核反馈未能送回会话(已丢弃): `
        + String(error)));
  }

  private async flushKernel(): Promise<string> {
    while (this.pendingKernel.size) {
      await Promise.all([...this.pendingKernel]);
    }
    try {
      await this.options.hostHooks?.flush?.();
    } catch (error) {
      this.kernelFailures.push(String(error));
    }
    const failures = this.kernelFailures.splice(0);
    return failures.join("；");
  }

  /** 发一条用户消息并跑完本轮,统一收口判定。announce=false 的重投
   *  (忙撞让一拍那次)不再记一遍用户消息账——首投已经记过。
   *  失败在这里只产出 Outcome 不落终态事件:补救链(自愈/重投)可能
   *  把它救活,确认不再补救才由 settle 落账。 */
  private promptTurn(userMessage: string, announce = true): Promise<Outcome> {
    this.turnInFlight = true;
    if (announce) {
      this.emit("user_message", this.sessionId, { text: userMessage });
    }
    this.turnActivity = 0;
    this.turnError = "";
    this.turnTerminalError = "";
    this.waitingSignal = deferred<Outcome>();
    this.pendingTurn = this.session
      .prompt(userMessage)
      .then(() => this.turnOutcome())
      .catch((error): Outcome => {
        const detail = userFacingModelFailure(String(error));
        return { status: "session_ended", reason: "failed", detail };
      }).finally(() => { this.turnInFlight = false; });
    return Promise.race([this.pendingTurn, this.waitingSignal.promise]);
  }

  /** 终态落账的唯一咽喉:确认不再补救的失败才把 session_ended 写进
   *  事件账——提前落账会把救活的会话在账上记死(issue-64 一爆自愈
   *  成功,events.jsonl 却躺着一条 session_ended,#285 复盘)。只管
   *  事件账的时机,Outcome 本身不受影响。 */
  private settle(outcome: Outcome): Outcome {
    if (outcome.status === "session_ended") {
      this.emit("session_ended", this.sessionId, {
        reason: outcome.reason ?? "failed", detail: outcome.detail,
      });
    }
    return outcome;
  }

  /** 回合收口:最后一次模型请求失败就如实报告，不能因前面调过工具
   *  就把中途报错当正常结束；成功续跑会清除旧错误。
   *  失败只产出 Outcome,终态事件由 settle 在确认不再补救后落账。 */
  private async turnOutcome(): Promise<Outcome> {
    const kernelFailure = await this.flushKernel();
    if (kernelFailure) {
      const detail = `内核授权或证据登记未可靠落盘: ${kernelFailure}`;
      return { status: "session_ended", reason: "failed", detail };
    }
    if (this.turnError) {
      const detail = userFacingModelFailure(this.turnError);
      return { status: "session_ended", reason: "failed", detail };
    }
    if (this.turnTerminalError) {
      const detail = this.turnTerminalError;
      return { status: "session_ended", reason: "failed", detail };
    }
    const reason = this.turnActivity ? "end_turn" : "empty_turn";
    this.emit("turn_finished", this.sessionId, { reason });
    return { status: "turn_finished", reason };
  }

  /** 中途插话(本地 CLI 的 ESC 在云端的等价物)。
   *
   * 用 pi 的 steer 而不是 abort:steer 的语义是"当前这一轮的工具调用做完
   * 就送达",所以模型不会在文件写一半、构建杀一半的地方被掐断——那种半截
   * 现场比慢几秒麻烦得多。真要掐死一条卡住的长命令是另一回事(abortBash),
   * 不在这条路上。
   *
   * 这不绕过任何门禁:插话只改变模型下一步干什么,该过的证据一样得过。
   * 登记在 steer 成功之后——先记后发,发失败就会留下一条从未送达的假账。
   */
  async steer(text: string, extra: Record<string, unknown> = {}): Promise<void> {
    await (this.session as any).steer(text);
    // via 标记让重启后认得出"这条是插话":它可能还压在 pi 的内存队列里
    // 没送到,而队列随进程一起死。事件日志是唯一跨进程活下来的账。
    // extra 是给页面看的展示字段(附言原文、引用名):text 里带着整份
    // 注入正文,直接摆出来是几万字的墙。
    this.emit("user_message", this.sessionId, { text, via: "interrupt", ...extra });
  }

  /** 取走"发出去却没送到"的插话。
   *
   * 坑(读 pi 源码才发现):steer 从不抛错,它只是把消息压进内部队列。
   * 正好撞在回合间隙发出的插话,会静静躺在那儿永远没人送——靠 try/catch
   * 兜底是空想。真正可靠的判定是"回合都收口了队列还有货",那就是没送到。
   *
   * 用 clearQueue 而不是只读的 getSteeringMessages:它同时清掉 agent 侧
   * 队列,取走即归我,不会出现我补发一遍、pi 事后又送一遍。它连 followUp
   * 队列一并清空——我们从不用 followUp,清了无妨。
   */
  /** 还压在 pi 队列里、没进模型上下文的插话(只读)。
   *
   * pi 在真正开始那条用户消息时才把它移出队列,所以"不在队列里"就是
   * "模型已经读到了"——这是可观测的事实,不是推断。页面据此如实告诉人
   * "送达没有",省得他发完一句就石沉大海。 */
  /** 只记账不送达:等人决定/排队时的 @ 引用不走 steer,而是随决定或
   * 使命送达,但页面的「捎过去的话」只认事件账里的 via=interrupt。没这条
   * 账,人点完发送就石沉大海(用户 2026-09-02 实测)。必须走本会话的
   * emit——另开一个 EventLog 实例追加会让这里缓存的 lastEventId 落后,
   * 下一条真事件撞号被当重放 no-op 静默丢掉。 */
  noteUserMessage(text: string, extra: Record<string, unknown>): void {
    this.emit("user_message", this.sessionId, { text, via: "interrupt", ...extra });
  }

  /** 沿用会话的事件序号，清单只供界面阅读，不注入模型或新增审批。 */
  notePushFileList(payload: Record<string, unknown>): void {
    this.emit("push_file_list", "main", payload);
  }

  pendingSteers(): string[] {
    try {
      const queue = (this.session as any).getSteeringMessages?.();
      return Array.isArray(queue) ? [...queue] : [];
    } catch {
      return [];
    }
  }

  takeUndeliveredSteers(): string[] {
    try {
      const queue = (this.session as any).clearQueue?.();
      return Array.isArray(queue?.steering) ? queue.steering : [];
    } catch {
      return [];      // 旁路一律 fail-open:取不回来也不许挡住收口
    }
  }

  /** 回合结束但流程未到终态时的催办续跑:同一会话追加一条用户消息。
   * 模型提前收嘴(run3 实测:拿到 message-id 后直接 end_turn)不等于
   * 任务完成——阶段真相只看内核状态,宿主负责把会话推回流程。 */
  async continueWith(text: string): Promise<Outcome> {
    return this.turnWithRepairs(text);
  }

  /** 回合级自愈总口(2026-09-10,issue-12/issue-20 复盘):收尾窗口
   *  忙撞让拍重投、输出超限截断纠偏重试、模型网关认证失败退避重试,
   *  上下文容量由请求前策略统一管理。
   *  三条回合补救共用一套纪律:每类只补有限次,
   *  补不动就如实上抛——自愈是纠偏不是永动机,绝不停在"看起来在
   *  推进"的假循环里,也不把可恢复的失败装成会话死亡(落点语义交
   *  宿主,问题流 settle 按 looksLike* 落 idle 而非 failed)。 */
  private async turnWithRepairs(userMessage: string): Promise<Outcome> {
    let outcome = await this.promptTurn(userMessage);
    if (outcome.status === "session_ended"
        && looksLikeBusyCollision(outcome.detail ?? "")) {
      // 首投被拒时消息没进队列,重投不会重复;仍忙就如实上交。
      await new Promise((done) => {
        const timer = setTimeout(done, BUSY_RETRY_DELAY_MS);
        timer.unref?.();
      });
      outcome = await this.promptTurn(userMessage, false);
    }
    for (let attempt = 1; attempt <= OUTPUT_TRUNCATION_RETRIES; attempt++) {
      if (outcome.status !== "session_ended"
          || !looksLikeOutputTruncation(outcome.detail ?? "")) break;
      this.options.log?.(`任务 ${this.options.taskId} 输出超限截断,`
        + `第 ${attempt}/${OUTPUT_TRUNCATION_RETRIES} 次纠偏重试`);
      outcome = await this.promptTurn(
        outputTruncationRepairNotice(attempt));
    }
    // 认证失败(401 家族)退避重试:上游偶发拒绝有效密钥,时间可恢复。
    // 与 SDK/pi 的自动重试互补——那两层对 401 快速失败,这里才兜得住。
    // 预算=退避表长;表空视为关闭。取消/关停(aborted)后不再重投。
    const authDelays = this.options.authRetryDelaysMs
      ?? AUTH_FAILURE_RETRY_DELAYS_MS;
    for (let attempt = 1; attempt <= authDelays.length; attempt++) {
      if (this.aborted || outcome.status !== "session_ended"
          || !looksLikeAuthFailure(outcome.detail ?? "")) break;
      const delayMs = authDelays[attempt - 1];
      this.options.log?.(`任务 ${this.options.taskId} 模型网关认证失败(401),`
        + `${delayMs}ms 后第 ${attempt}/${authDelays.length} 次自动重试`);
      await new Promise((done) => {
        const timer = setTimeout(done, delayMs);
        timer.unref?.();
      });
      if (this.aborted) break;
      outcome = await this.promptTurn(
        authFailureRetryNotice(attempt, authDelays.length));
    }
    return this.settle(outcome);
  }


  /** 宿主在某个自定义工具里举卡等人(拆分提议):记录由宿主建好,这里只
   * 把会话挂在同一条决定通道上——状态切 waiting_for_human、通知、决定回注
   * 与 AskUserQuestion 完全同款。区别在回注时:不给内核补回执(内核没见过
   * 这次提问),也不替 pi 补回声(pi 自己会给这个工具发 tool_finished)。 */
  awaitHostDecision(record: WaitingRecord): Promise<string> {
    if (record.status === "resolved") return Promise.resolve(renderAgentDecision(record));
    if (record.status === "superseded") {
      return Promise.resolve("这张卡已因用户接管代码现场而失效,按最新现场继续。");
    }
    this.hostRaised.add(record.call_id);
    this.waitingRecord = record;
    const decision = new Promise<string>((resolve) =>
      this.decisionResolvers.set(record.call_id, resolve));
    this.waitingSignal.resolve({
      status: "waiting_for_human", waiting: { ...record },
    });
    return decision;
  }

  /** 把 Web 决定回注为 AskUserQuestion 的工具结果,继续本轮。
   *  parkedReplay 是宿主欠着的停靠通知(#244 发送必达):拼在决定回执
   *  之后随行送达——工具结果是模型此刻必读的文本,通知搭这条车不会被
   *  漏看;决定账(human_decision 事件)保持纯决定,不混平台通知。 */
  async resumeWithDecision(
    record: WaitingRecord,
    parkedReplay?: string,
  ): Promise<Outcome> {
    const waiting = this.waitingRecord;
    if (!waiting) throw new Error("没有等待中的人工节点,无决定可回注");
    const resolver = this.decisionResolvers.get(waiting.call_id);
    if (!resolver) throw new Error(`没有挂起的决定通道: ${waiting.call_id}`);
    this.emit("human_decision", this.sessionId, {
      waiting_id: record.waiting_id,
      state_version: record.state_version,
      decision: record.decision,
      notes: record.notes,
    });
    const answerText = renderAgentDecision(record)
      + (parkedReplay ? `\n\n${parkedReplay}` : "");
    if (this.hostRaised.has(waiting.call_id)) {
      this.hostRaised.delete(waiting.call_id);
    } else {
      // 宿主代演的工具结果由 driver 登记;pi 的回声按 hostAnswered 丢弃。
      // answers 是结构化回答(问题→选项):内核 ack 的"整份背书"判定看的是
      // 结构不是措辞——键是配置项名的只代表单项,独立确认题才能替整份背书。
      const finished = this.emit("tool_finished", this.sessionId, {
        call_id: waiting.call_id,
        name: "AskUserQuestion",
        input: waiting.question,
        is_error: false,
        result: answerText,
        answers: answersOf(record, waiting),
      });
      // 决定进内核:旧插件 posttooluse 捕获 AskUserQuestion 答案的同一路径。
      this.trackKernelHook(this.options.hostHooks?.postTool?.(finished));
      this.hostAnswered.add(waiting.call_id);
    }
    this.decisionResolvers.delete(waiting.call_id);
    this.waitingRecord = undefined;
    this.waitingSignal = deferred<Outcome>();
    resolver(answerText);
    const outcome = await Promise.race(
      [this.pendingTurn!, this.waitingSignal.promise]);
    return this.settle(outcome);
  }

  /** 取消任务用的硬边界：中止当前 agent 回合并等它回到 idle。
   * 容器由 TaskService 同时停止，长 bash 不会遗留在隔离环境里。 */
  async abort(): Promise<void> {
    // 先竖旗再收束:退避等待中的认证重试醒来后看旗放弃,不往已中止的
    // 会话里再投消息。
    this.aborted = true;
    // Pi 的 abort 不会替宿主 resolve 自定义 AskUserQuestion 工具里的
    // Promise。若会话正停在人工卡，直接 await abort 会永久等待，导致
    // pause/cancel/SIGTERM 全部挂死。先只解开内存工具调用（不写人类决定
    // 事件；HumanGate 的 waiting 仍在盘上），再让 Pi 收束并中止回合。
    for (const [callId, resolver] of this.decisionResolvers) {
      this.hostAnswered.add(callId);
      resolver("[mae-flow-cloud] 会话已由宿主中止，人工待办仍保留");
    }
    this.decisionResolvers.clear();
    this.waitingRecord = undefined;
    await Promise.allSettled([
      (this.session as any).abort(),
      ...[...this.childSessions.values()].map((child) => child.abort()),
    ]);
    await this.flushKernel();
  }

  dispose(): void {
    for (const child of this.childSessions.values()) child.dispose();
    this.childSessions.clear();
    this.session.dispose();
  }

  // ---- pi 会话装配 ----

  private async openSession(config: {
    sessionId: string;
    customTools: unknown[];
    readOnly?: boolean;
    /** 缺省继承驱动级 extraTools(主会话形态);子 Agent 派发时必须传
     *  仅继承只读 knowledge——complete_stage/push_branch 这类业务工具只能存在于主会话,
     *  否则模型派个平行会话就能绕过主上下文推进阶段机(2026-09-06)。 */
    extraTools?: unknown[];
  }) {
    const { workspace, agentDir, provider, model } = this.options;
    const blockedRepositoryResources = [
      ...(this.options.repositoryResourceBlocks?.() ?? []),
    ];
    const repositoryResourceBlocked = (path: string) => resourceBlocked(
      relative(workspace, path).split(sep).join("/"),
      blockedRepositoryResources,
    );
    // Skill=写法指南(团队那两个 UT skill 只负责"单测怎么写"),云端照用:
    // Pi 只把 name/description/location 组成轻量可用 Skill 索引；模型判断
    // 相关后再用 Read 读取 SKILL.md 正文。它不承担 UT 运行，也不构成
    // 通过证据。正文里若含本地构建段落，以 Cloud 执行契约为准。
    //
    // 两个来源,宿主级在前(部署放一次、每个任务都带——团队的 skill 在
    // 内网出不来仓,老宿主靠"每次手动集成进 ut-generator 子 agent",
    // 云端给它一个固定的家)。仓内 Skill 只接受任务在首次 clone 后从
    // Git 已跟踪内容固定的精确 SKILL.md；平台不管理正文，也绝不能把
    // .pi/.claude 的 skills 目录整体交给 Pi，否则中心临时注入内容会
    // 静默进入模型上下文。
    // 宿主 Skill 会先按完整包投影进当前任务，所以正文引导的附件相对路径
    // 也在边界内；源目录绝对路径绝不进入 Pi。子 Agent 经同一 openSession
    // 装配,自动使用完全相同的 allowlist。
    // **必须显式喂路径**:pi 的 DefaultResourceLoader 是 includeDefaults
    // = false,不喂就一个 skill 都不装(读 SDK 才发现,不是放进去就生效)。
    const hostSkills = materializeHostSkills({
      sourceRoot: this.options.hostSkillsDir,
      moduleDataDir: this.options.knowledgeModuleDataDir,
      workspaceRoot: workspace,
      snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
      context: this.options.knowledgeContext,
      knowledgeScope: this.options.knowledgeScope,
    });
    for (const warning of hostSkills.warnings) {
      this.options.log?.(
        `[host-skill] 任务 ${this.options.taskId}: ${warning}`);
    }
    const repositorySkillPaths = (this.options.repositorySkillPaths ?? [])
      .filter((path) => {
        if (repositoryResourceBlocked(path)) return false;
        if (basename(path) !== "SKILL.md" || !existsSync(path)) return false;
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    const platformBuildSkills = (maeBuildRoot(workspace) || this.options.knowledgeScope === "issue") ? materializeHostSkills({
      sourceRoot: MAE_BUILD_SKILLS, workspaceRoot: workspace,
      snapshotRoot: join(workspace, ".mae-flow-work/host-skills/platform-build"),
    }) : { paths: [] as string[], warnings: [] as string[] };
    for (const warning of platformBuildSkills.warnings) this.options.log?.(`[mae-build-skill] ${warning}`);
    const skillPaths = [...new Set([
      ...platformBuildSkills.paths,
      ...hostSkills.paths,
      ...repositorySkillPaths,
      ...(this.options.businessModuleKnowledge?.skill_paths ?? []),
    ])];
    if (platformBuildSkills.paths.length) {
      for (let i = skillPaths.length - 1; i >= 0; i--) {
        if (!platformBuildSkills.paths.includes(skillPaths[i])
          && /^name:\s*["']?mae-first-build["']?\s*$/m.test(readFileSync(skillPaths[i], "utf8"))) skillPaths.splice(i, 1);
      }
    }
    const businessModuleKnowledge = this.options.businessModuleKnowledge;
    const moduleKnowledgeEntries = (businessModuleKnowledge?.entries ?? [])
      .filter((item) => {
        try {
          return existsSync(item.path) && statSync(item.path).isFile();
        } catch {
          return false;
        }
      });
    const knowledgeIndex = materializeTaskKnowledgeIndex({
      workspace,
      businessKnowledge: moduleKnowledgeEntries,
    });
    for (const warning of knowledgeIndex.warnings) {
      this.options.log?.(
        `[task-knowledge-index] 任务 ${this.options.taskId}: ${warning}`);
    }
    for (const item of moduleKnowledgeEntries) {
      const resource: KnowledgeResourceRef = {
        id: item.id,
        kind: item.form === "skill" ? "skill" : "document",
        name: item.title,
        path: item.relative_path,
        description: item.summary,
        digest: item.digest,
        selected: true,
        scope: "module",
        module_id: item.module_id,
        module_name: item.module_name,
        asset_version: item.version,
      };
      this.options.knowledgeTrace?.register(item.path, resource);
      this.options.knowledgeTrace?.record(
        "available", config.sessionId, resource);
    }
    const repositorySkillResources = (this.options.repositorySkillResources ?? [])
      .filter((item) => !repositoryResourceBlocked(item.actual_path));
    for (const item of repositorySkillResources) {
      this.options.knowledgeTrace?.register(item.actual_path, {
        id: item.id,
        kind: item.kind,
        name: item.name,
        path: item.path,
        repository: item.repository,
        description: item.description,
        digest: item.digest,
        selected: item.selected,
        scope: "repository",
      }, true);
    }
    if (skillPaths.length) {
      const safeRepositoryNames = repositorySkillPaths.map((path) => {
        const fromWorkspace = relative(workspace, path);
        if (fromWorkspace && fromWorkspace !== ".."
            && !fromWorkspace.startsWith(`..${sep}`)
            && !isAbsolute(fromWorkspace)) {
          return fromWorkspace;
        }
        return join(basename(dirname(path)), "SKILL.md");
      });
      const labels = [
        ...hostSkills.names.map((name) => `宿主技能/${name}`),
        ...safeRepositoryNames,
      ];
      this.options.log?.(
        `任务 ${this.options.taskId} 装载 skill: ${labels.join(", ")}`);
    }
    // 仓契约注入同款一行事(2026-09-03):提示词里多了什么必须能在
    // 日志里对账,只记 repo/ 下的相对路径,不贴正文。
    const repoContextFiles = (this.options.repoContextFiles ?? [])
      .filter((file) => !repositoryResourceBlocked(file.path));
    if (repoContextFiles.length) {
      this.options.log?.(`任务 ${this.options.taskId} 注入仓契约: ${
        repoContextFiles.map((file) => {
          const fromRepoRoot = relative(join(workspace, "repo"), file.path);
          return fromRepoRoot && !fromRepoRoot.startsWith("..")
            ? fromRepoRoot.split(sep).join("/")
            : basename(file.path);
        }).join(", ")}`);
    }
    const appendedSystemPrompt = [
      GIT_COMMIT_IDENTITY_GUIDANCE,
      ...(this.options.additionalSystemInstructions ?? []),
      ...resourceBlockNotice(blockedRepositoryResources),
      ...(this.options.humanFacing && config.sessionId === this.sessionId
        ? [HUMAN_FACING_STYLE, pendingDecisionsPrompt(workspace)] : []),
    ];
    const gitAi = gitAiEnabled() && this.options.bashOperations
      ? new GitAiSession(this.options.bashOperations, workspace, this.options.log)
      : undefined;
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      // Pi 默认会经 package/settings 解析项目 .pi/skills；allowlist 模式
      // 必须关掉这条隐式来源。noSkills 仍会保留 additionalSkillPaths，
      // SDK 在该模式下的语义正是“只装显式路径”。
      noSkills: true,
      additionalSkillPaths: skillPaths,
      // 平台管理的非 Skill 知识统一走轻量目录：默认勾选只表示“本任务
      // 可用”，正文按需 Read。仓库自身资料不进入平台知识通路。
      // 仓契约文件(spec #131)排在其后:知识索引是平台账,仓契约是
      // 仓自带的规矩——注入顺序即阅读顺序,SDK 默认 → 平台知识索引 →
      // 各仓契约(收集口径见 collectRepoContextFiles)。
      agentsFilesOverride: (current) => ({
        agentsFiles: this.options.excludeAgentFiles ? [] : [
          ...current.agentsFiles.filter((file) =>
            !repositoryResourceBlocked(file.path)),
          ...(knowledgeIndex.path && knowledgeIndex.content
            ? [{ path: knowledgeIndex.path, content: knowledgeIndex.content }]
            : []),
          ...repoContextFiles,
        ],
      }),
      // 固定指令覆盖主、子与专项会话；面对人的语气只用于主会话。
      ...(appendedSystemPrompt.length ? {
        appendSystemPromptOverride: (base: string[]) => [
          ...base, ...appendedSystemPrompt,
        ],
      } : {}),
      extensionFactories: [
        {
          name: "mae-flow-gate",
          factory: (pi: any) => {
            const memoryContext = this.options.memoryContext?.();
            if (memoryContext) pi.on("context", async (event: any) => ({
              messages: await memoryContext(event.messages),
            }));
            pi.on("tool_call", async (event: any, ctx: any) => {
              const decision = await this.onToolCall(config.sessionId, event);
              if (!decision?.block) await gitAi?.before(event, ctx);
              return decision;
            });
            pi.on("tool_result", async (event: any) => {
              await gitAi?.after(event);
              const componentNote = await this.options.componentKnowledge?.afterTool(
                TOOL_NAME_MAP[event.toolName] ?? event.toolName, event.input ?? {},
              ).catch(error => `组件使用检查未完成：${String(error)}`);
              try {
                const note = await this.options.hostHooks?.toolResultNote?.({
                  name: TOOL_NAME_MAP[event.toolName] ?? event.toolName,
                  input: event.input ?? {},
                });
                const notes = [note, componentNote].filter(Boolean);
                if (notes.length) return { content: [...event.content, { type: "text", text: notes.join("\n\n") }] };
              } catch (error) {
                this.kernelFailures.push(String(error));
                return { content: [...event.content, { type: "text",
                  text: `宿主回执登记失败：${String(error)}` }], isError: true };
              }
            });
          },
        } as any,
      ],
    });
    await loader.reload();
    const repositorySkillByPath = new Map(
      (this.options.repositorySkillResources ?? [])
        .map((item) => [resolve(item.actual_path), item] as const));
    const moduleSkillByPath = new Map(moduleKnowledgeEntries
      .filter((item) => item.form === "skill")
      .map((item) => [resolve(item.path), item] as const));
    for (const skill of loader.getSkills().skills) {
      const known = repositorySkillByPath.get(resolve(skill.filePath));
      const moduleKnown = moduleSkillByPath.get(resolve(skill.filePath));
      const displayPath = skill.filePath.includes(workspace)
        ? relative(workspace, skill.filePath).split(sep).join("/")
        : `宿主技能/${skill.name}/SKILL.md`;
      // actual_path 只用于宿主侧匹配，不能跟着知识事件/API 泄露快照
      // 的绝对宿主路径。
      const resource: KnowledgeResourceRef = known ? {
        id: known.id,
        kind: known.kind,
        name: known.name,
        path: known.path,
        repository: known.repository,
        description: known.description,
        digest: known.digest,
        selected: known.selected,
        scope: "repository",
      } : moduleKnown ? {
        id: moduleKnown.id,
        kind: "skill",
        name: moduleKnown.title,
        path: moduleKnown.relative_path,
        description: moduleKnown.summary,
        digest: moduleKnown.digest,
        selected: true,
        scope: "module",
        module_id: moduleKnown.module_id,
        module_name: moduleKnown.module_name,
        asset_version: moduleKnown.version,
      } : {
        id: `skill:${skill.name}:${displayPath}`,
        kind: "skill",
        name: skill.name,
        path: displayPath,
        description: skill.description,
        scope: "team",
      };
      this.options.knowledgeTrace?.register(skill.filePath, resource, true);
      this.options.knowledgeTrace?.record(
        "available", config.sessionId, resource);
    }
    for (const file of loader.getAgentsFiles().agentsFiles) {
      if (knowledgeIndex.path
          && resolve(file.path) === resolve(knowledgeIndex.path)) {
        continue;
      }
      const withinWorkspace = resolve(file.path).startsWith(`${resolve(workspace)}${sep}`)
        || resolve(file.path) === resolve(workspace);
      const display = withinWorkspace
        ? relative(workspace, file.path).split(sep).join("/")
        : file.path.split(sep).slice(-2).join("/");
      const resource: KnowledgeResourceRef = {
        id: `rules:${display}`,
        kind: "rules",
        scope: withinWorkspace ? "repository" : "team",
        name: display.split("/").at(-1) || "项目规则",
        path: display,
      };
      this.options.knowledgeTrace?.register(file.path, resource);
      this.options.knowledgeTrace?.record("loaded", config.sessionId, resource);
    }
    const resolved = this.modelRuntime.getModel(provider, model);
    if (!resolved) {
      throw new Error(`models.json 里找不到模型 ${provider}/${model}`);
    }
    // 容器隔离:注册执行后端进容器的同名 bash——SDK 的工具注册表
    // 同名 customTool 后写覆盖内建(agent-session._refreshToolRegistry),
    // 不能用 excludeTools(denylist 按名字生效,会连替换品一起杀,实测)。
    const isolatedTools = this.options.bashOperations
      ? [createWorkspaceBashToolDefinition(
          workspace,
          gitAi?.operations() ?? this.options.bashOperations,
          {
            // 每个主/子/prepush 会话各有自己的受控日志目录。所有命令仍由
            // 原容器 backend 执行；这层只镜像输出并把可达相对路径交给 Pi。
            workspace,
            taskId: this.options.taskId,
            sessionId: config.sessionId,
            log: this.options.log,
            onOutput: this.options.streamBashOutput
              ? ({ text, relativePath }) => {
                  this.emit("tool_output", config.sessionId, {
                    name: "Bash",
                    text,
                    log_path: relativePath,
                  });
                }
              : undefined,
          },
        )]
      : [];
    const ownedFileTools = this.options.afterFileMutation
      ? this.ownedFileTools(workspace, this.options.afterFileMutation)
      : [];
    const visionTools = this.options.vision
      ? [createInspectImageTool({
          runtime: this.modelRuntime,
          workspace: this.options.visionWorkspace ?? workspace,
          config: this.options.vision,
          state: this.visionState,
          sessionId: config.sessionId,
          onTokenUsage: this.options.onTokenUsage,
        })]
      : [];
    const checkpoint = openSessionCheckpoint({ taskId: this.options.taskId,
      sessionId: config.sessionId, transcriptPath: this.options.transcript.mainPath,
      agentDir, cwd: workspace, resume: config.sessionId === this.sessionId && this.options.resumeSession === true,
      log: this.options.log });
    if (config.sessionId === this.sessionId) this.checkpoint = checkpoint;
    const readOnlyTools = ["read", "grep", "find", "ls",
      ...childKnowledgeTools(config.extraTools ?? []).map((tool: any) => tool.name),
      ...(this.options.vision ? ["inspect_image"] : [])];
    const allowedTools = config.readOnly
      ? readOnlyTools.filter(name => !this.options.allowedTools
        || this.options.allowedTools.some(allowed => allowed.toLowerCase() === name))
      : this.options.allowedTools;
    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      tools: allowedTools ? [...allowedTools] : undefined,
      model: resolved,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      customTools: [
        ...(config.customTools as any[]),
        ...((config.extraTools ?? this.options.extraTools ?? []) as any[]),
        ...visionTools,
        ...ownedFileTools,
        ...isolatedTools,
      ] as any,
      sessionManager: checkpoint.manager,
    });
    try {
      void saveAnalysisContextSnapshot({
        eventLogPath: this.options.eventLog.path,
        taskId: this.options.taskId, sessionId: config.sessionId,
        provider, model, session,
        agentsFiles: loader.getAgentsFiles?.().agentsFiles,
        step: this.options.currentStep?.(), log: this.options.log,
      });
    } catch {
      try { this.options.log?.("分析上下文快照输入读取失败；任务继续执行。"); } catch { /* 观测旁路不能阻止会话启动 */ }
    }
    const compaction = new SessionCompaction(session, this.modelRuntime!, {
      anchor: () => this.options.compactAnchor?.() ?? "围绕当前用户需求继续工作",
      log: (message) => this.options.log?.(`任务 ${this.options.taskId} 会话 ${config.sessionId} ${message}`),
      onUsage: (message) => {
        const usage = modelTokenUsageSample(message, config.sessionId);
        if (usage) this.options.onTokenUsage?.(usage);
      },
    });
    compaction.install();
    session.subscribe((event: any) => this.onSessionEvent(config.sessionId, event));
    return session;
  }

  private ownedFileTools(
    workspace: string,
    afterMutation: (absolutePath: string) => void | Promise<void>,
  ): unknown[] {
    const finish = async (path: string, content: string): Promise<void> => {
      await fsWriteFile(path, content, "utf-8");
      await afterMutation(path);
    };
    const writeOperations: WriteOperations = {
      mkdir: (path) => fsMkdir(path, { recursive: true }).then(() => undefined),
      writeFile: finish,
    };
    const editOperations: EditOperations = {
      access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
      readFile: fsReadFile,
      writeFile: finish,
    };
    return [
      createWriteToolDefinition(workspace, { operations: writeOperations }),
      createEditToolDefinition(workspace, { operations: editOperations }),
    ];
  }

  // ---- 同步拦截(tool_call 钩子) ----

  private async onToolCall(sessionId: string, event: any) {
    // 登记失败后不再让后续工具推进，不能等到 done 才发现证据缺失。
    await Promise.all([...this.pendingKernel]);
    if (this.kernelFailures.length) {
      return { block: true, reason: "内核证据登记失败，已停止工具执行："
        + this.kernelFailures.join("；") };
    }
    const rawName = String(event.toolName ?? "");
    if (HOST_TOOLS.has(rawName)) return undefined; // 宿主工具在执行体内代演
    const name = TOOL_NAME_MAP[rawName] ?? rawName;
    const callId = String(event.toolCallId ?? "");
    const semantic: SemanticEvent = {
      eventId: this.options.eventLog.lastEventId() + 1,
      taskId: this.options.taskId,
      sessionId,
      ts: new Date().toISOString(),
      kind: "tool_requested",
      payload: { call_id: callId, name, input: event.input ?? {} },
    };
    this.options.eventLog.append(semantic);
    this.options.transcript.record(semantic);
    // 深层契约(内核 dispatch)先裁——它拦的是谎言与授权;
    // GateService 的注入契约(演练/附加规则)随后。任一 deny 即打回。
    const host = await this.options.hostHooks?.preTool?.(semantic);
    if (host?.action === "deny") {
      return { block: true, reason: host.reason ?? "被 mae-flow 门禁打回" };
    }
    const decision = this.options.gate.decide(semantic);
    if (decision.action === "deny") {
      return { block: true, reason: decision.reason ?? "被 mae-flow 门禁打回" };
    }
    return undefined;
  }

  // ---- 事实流(pi 会话事件 → 语义事件) ----

  private onSessionEvent(sessionId: string, event: any): void {
    const kind = String(event.type ?? "");
    if (kind === "message_end") {
      const message = event.message ?? {};
      if (message.role !== "assistant") return;
      const usage = modelTokenUsageSample(message, sessionId);
      if (usage) {
        try {
          this.options.onTokenUsage?.(usage);
        } catch (error) {
          this.options.log?.(
            `任务 ${this.options.taskId} Token 统计失败(不影响会话): ${String(error)}`);
        }
      }
      // 模型层错误藏在 stopReason 里(消息往往无文本,不能只看 text)。
      // 主会话与子会话都记:原文进日志,以后再出"5 分钟沉默后返回"这种事,
      // 不用再从 pi 源码反推是谁掐的线。
      if (String(message.stopReason ?? "") === "error") {
        const modelError = String(message.errorMessage ?? "未知模型错误");
        this.modelErrors.set(sessionId, modelError);
        if (sessionId === this.sessionId) this.turnError = modelError;
        this.options.log?.(
          `任务 ${this.options.taskId} 会话 ${sessionId} 模型层错误: ${modelError.slice(0, 400)}`);
      } else {
        if (sessionId === this.sessionId) this.turnError = "";
        this.modelErrors.delete(sessionId);
      }
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block.text ?? ""))
        .join("");
      if (!text) return;
      if (sessionId === this.sessionId) this.turnActivity += 1;
      this.lastAssistantText.set(sessionId, text);
      this.emit("assistant_message", sessionId, { text });
      return;
    }
    // pi 的自动重试(默认 3 次,2s/4s/8s 退避)以前完全不可见——现场里只看到
    // 一段沉默。写进日志,重试了几次、每次为什么失败都有据可查。
    if (kind === "auto_retry_start") {
      this.options.log?.(
        `任务 ${this.options.taskId} 会话 ${sessionId} 模型请求自动重试 `
        + `${event.attempt}/${event.maxAttempts}(${event.delayMs}ms 后): `
        + String(event.errorMessage ?? "").slice(0, 200));
      return;
    }
    if (kind === "auto_retry_end") {
      this.options.log?.(
        `任务 ${this.options.taskId} 会话 ${sessionId} 模型请求自动重试`
        + `${event.success ? "成功" : "放弃"}(第 ${event.attempt} 次)`
        + (event.finalError ? `: ${String(event.finalError).slice(0, 200)}` : ""));
      return;
    }
    if (kind === "tool_execution_start") {
      if (sessionId === this.sessionId) this.turnActivity += 1;
      this.toolArgs.set(String(event.toolCallId ?? ""), event.args ?? {});
      return;
    }
    if (kind === "tool_execution_end") {
      const callId = String(event.toolCallId ?? "");
      if (this.hostAnswered.delete(callId)) return; // 宿主已登记,回声丢弃
      const rawName = String(event.toolName ?? "");
      const input = this.toolArgs.get(callId) ?? {};
      this.toolArgs.delete(callId);
      const content = event.result?.content;
      const result = (Array.isArray(content) ? content : [])
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block.text ?? ""))
        .join("\n");
      if (sessionId === this.sessionId) {
        this.turnTerminalError = fatalToolExecutionError(
          TOOL_NAME_MAP[rawName] ?? rawName,
          result,
          Boolean(event.isError),
        ) ?? this.turnTerminalError;
      }
      const semantic: SemanticEvent = {
        eventId: this.options.eventLog.lastEventId() + 1,
        taskId: this.options.taskId,
        sessionId,
        ts: new Date().toISOString(),
        kind: "tool_finished",
        payload: {
          call_id: callId,
          name: TOOL_NAME_MAP[rawName] ?? rawName,
          input,
          is_error: Boolean(event.isError),
          result,
        },
      };
      this.options.eventLog.append(semantic);
      this.options.transcript.record(semantic);
      this.options.knowledgeTrace?.observeTool(
        sessionId,
        String(semantic.payload.name ?? ""),
        input,
        Boolean(event.isError),
      );
      // 证据登记交内核(fire 进 KernelHost 的串行链,顺序由它保证)。
      this.trackKernelHook(this.options.hostHooks?.postTool?.(semantic));
    }
  }

  // ---- 人工节点(§5 挂起路线) ----

  private askTool() {
    const driver = this;
    return defineTool({
      name: "AskUserQuestion",
      label: "Ask User Question",
      description: askToolDescription(this.options.knowledgeScope),
      // 形状对齐旧宿主(步骤文档假设的就是它):questions 数组,每项
      // question + options。回答按问题分开记录——内核"整份背书"判定
      // 依赖这个结构。
      parameters: Type.Object({
        purpose: Type.Optional(Type.Union([
          Type.Literal("confirmation"), Type.Literal("clarification"),
        ], { description: "默认 confirmation。仅补充缺失信息用 clarification，不能夹带最终验收" })),
        annotation_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1, description: "clarification 所追问的检视意见 ID；先为它们记录 needs_clarification 回执",
        })),
        context: Type.Optional(Type.String({
          description: "用户可见的决策背景；只写事实、证据与影响，不写内部操作过程",
          minLength: 1,
          maxLength: 2000,
        })),
        questions: Type.Array(Type.Object({
          question: Type.String({ description: "问题正文" }),
          options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
            description: "可选决定；选择题至少两项，开放题省略本字段",
            minItems: 2,
            maxItems: 6,
          })),
          recommended: Type.Optional(Type.String({
            description:
              "所推荐选项的原文(与 options 之一逐字一致)。选项题必填:"
              + "推荐要有依据(写进问题正文或 context),拿不准先补研究,"
              + "不要空着;开放题不得携带本字段",
          })),
        }, { additionalProperties: false }), {
          description: "一张卡里的问题；彼此独立的问题可合并，最多四个",
          minItems: 1,
          maxItems: 4,
        }),
      }, { additionalProperties: false }),
      async execute(toolCallId: string, params: any) {
        return driver.askUser(toolCallId, params);
      },
    });
  }

  private async askUser(toolCallId: string, params: any): Promise<{
    content: Array<{ type: "text"; text: string }>; details: Record<string, never>; isError?: boolean;
  }> {
    const driver = this;
    const callId = String(toolCallId);
    driver.emit("tool_requested", driver.sessionId, {
      call_id: callId, name: "AskUserQuestion", input: params ?? {},
    });
    const invalid = validateAskUserQuestionInput(params);
    if (invalid) {
      const text = "问题卡结构不完整，未向用户发送：" + invalid
        + "。选择题必须提供至少两个非空、互不重复的选项；"
        + "选项题必须带 recommended(所推荐选项的原文，须与选项逐字一致)；"
        + "若确实要自由回答，请省略 options，页面会显示答复输入框。"
        + "请修正后重试一次 AskUserQuestion，不要替用户猜答案。";
      const finished = driver.emit("tool_finished", driver.sessionId, {
        call_id: callId,
        name: "AskUserQuestion",
        input: params ?? {},
        is_error: true,
        result: text,
      });
      driver.trackKernelHook(driver.options.hostHooks?.postTool?.(finished));
      driver.hostAnswered.add(callId);
      return {
        content: [{ type: "text", text }],
        details: {},
        isError: true,
      };
    }
    const humanize = driver.options.humanizeQuestionText
      ?? ((text: string) => text);
    const questions = (params.questions as Array<{
      question: string; options?: string[]; recommended?: string;
    }>).map((item) => ({
      ...item,
      question: humanize(item.question),
      ...(item.options ? { options: item.options.map(humanize) } : {}),
      ...(item.recommended !== undefined
        ? { recommended: humanize(item.recommended) } : {}),
    }));
    const explicitContext =
      typeof params.context === "string" && params.context.trim()
        ? humanize(params.context.trim()) : undefined;
    const lastSaidRaw = driver.lastAssistantText.get(driver.sessionId);
    const lastSaid = lastSaidRaw === undefined
      ? undefined : humanize(lastSaidRaw);
    // 重放已决/已作废的旧卡不再核对(下面按记录原样回放);新卡先问
    // 宿主。核对本身出错不能让卡消失也不能让会话死:按"没拦"处理,
    // 交给回合结束与推送卡那两道后置检查兜底,错误记进日志。
    const previous = driver.options.humanGate.get(`${driver.options.taskId}:${callId}`);
    let blocked: string | undefined;
    if (previous?.status !== "resolved" && previous?.status !== "superseded") {
      try {
        blocked = await driver.options.beforeHumanQuestion?.(params);
      } catch (error) {
        driver.options.log?.(
          `任务 ${driver.options.taskId} 举卡前核对出错(按未拦处理): ${String(error)}`);
      }
    }
    if (blocked) {
      const finished = driver.emit("tool_finished", driver.sessionId, {
        call_id: callId, name: "AskUserQuestion", input: params,
        is_error: true, result: blocked,
      });
      driver.trackKernelHook(driver.options.hostHooks?.postTool?.(finished));
      driver.hostAnswered.add(callId);
      return { content: [{ type: "text", text: blocked }], details: {}, isError: true };
    }
    const record = driver.options.humanGate.createWaiting({
      taskId: driver.options.taskId,
      step: driver.options.currentStep?.() ?? "",
      callId,
      questionInput: (driver.options.prepareHumanQuestion ?? ((input) => input))({ questions,
        ...(params.purpose ? { purpose: params.purpose } : {}),
        ...(params.annotation_ids ? { annotation_ids: params.annotation_ids } : {}),
      }),
      context: explicitContext ?? lastSaid,
      // Agent 常在举卡前把完整清单说在正文里,卡的 context 只写
      // "以上/上述…"——卡上必须带得到那个"上述",不能让人回翻
      // 现场流水(MFC-028 盲签)。context 缺席时 lastSaid 已经当
      // context 用了,不重复。
      preface: explicitContext && lastSaid
        && lastSaid !== explicitContext ? lastSaid : undefined,
    });
    // 重建会话可能把同一个工具调用重放出来。waiting_id 以
    // task+call_id 幂等；若盘上的决定已经 resolved，就把原答案
    // 直接作为本次工具结果回放，绝不能再把它包装成一张新待办。
    // 用户实测的症状正是:子任务已生成，父分析单却又出现同一张卡。
    if (record.status === "resolved") {
      const finished = driver.emit("tool_finished", driver.sessionId, {
        call_id: callId,
        name: "AskUserQuestion",
        input: params ?? {},
        is_error: false,
        result: renderAgentDecision(record),
        answers: answersOf(record, record),
      });
      driver.trackKernelHook(driver.options.hostHooks?.postTool?.(finished));
      driver.hostAnswered.add(callId);
      driver.options.log?.(
        `任务 ${driver.options.taskId} 重放已完成待办 ${record.waiting_id},不重复举卡`);
      return {
        content: [{ type: "text", text: renderAgentDecision(record) }],
        details: {},
      };
    }
    if (record.status === "superseded") {
      const text = `这张旧问题已失效：${record.notes || "现场已更新"}。请读取 mae-flow current 和已记录的用户回答，`
        + "按当前要求继续；不要重复询问已获回答的问题。";
      const finished = driver.emit("tool_finished", driver.sessionId, {
        call_id: callId,
        name: "AskUserQuestion",
        input: params ?? {},
        is_error: true,
        result: text,
      });
      driver.trackKernelHook(driver.options.hostHooks?.postTool?.(finished));
      driver.hostAnswered.add(callId);
      driver.options.log?.(
        `任务 ${driver.options.taskId} 拒绝重放已失效待办 ${record.waiting_id}`);
      return {
        content: [{ type: "text", text }],
        details: {},
        isError: true,
      };
    }
    driver.waitingRecord = record;
    const decision = new Promise<string>((resolve) =>
      driver.decisionResolvers.set(callId, resolve));
    driver.waitingSignal.resolve({
      status: "waiting_for_human", waiting: { ...record },
    });
    const text = await decision; // 会话挂起点:决定到达前 pi 停在这里
    return { content: [{ type: "text", text }], details: {} };
  }

  // ---- 子 Agent(§6 平行会话;同进程) ----

  private dispatchTool() {
    const driver = this;
    // 组件计划指引只教给配备了组件能力目录的会话(需求侧传入);
    // 问题流等旁路会话挂只读 knowledge 后不能被顺带指向任务侧的
    // component-plan-agent 流程——那是 ADR-0062 明确不接的语义。
    const componentPlanning = Boolean(
      childKnowledgeTools(this.options.extraTools).length
      && this.options.componentAnalysisContext);
    return defineTool({
      name: "Task",
      label: "Dispatch Agent",
      promptGuidelines: componentPlanning ? [COMPONENT_PLANNING_GUIDANCE] : [],
      description:
        "派发一个子 Agent 完成任务卡并返回其最终报告(等价旧插件的 Task 工具)。" +
        "子 Agent 不能提问、不能再派子 Agent。" +
        (componentPlanning ? "实施环节开始编码前，派发 component-plan-agent 分析本次全部工作项可复用的组件；返回报告由主 Agent 整合到现有 implementation。" : ""),
      parameters: Type.Object({
        subagent_type: Type.String({
          description: "子 Agent 类型,如 ut-generator-agent 或 reviewer-agent",
        }),
        description: Type.String({ description: "一句话任务描述" }),
        prompt: Type.String({ description: "完整任务卡内容" }),
        read_only: Type.Optional(Type.Boolean({
          description: "只开放读取、检索和只读知识工具，适用于独立检视；默认期限 180 秒。",
        })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600,
          description: "只读子任务的执行期限；须同时设置 read_only。到期中止并返回未完成，不改变其他子任务。" })),
      }),
      async execute(toolCallId: string, params: any) {
        const text = await driver.runSubagent(String(toolCallId), params ?? {});
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  private refusalTool(
    sessionId: string,
    name: string,
    kernelName: string,
    label: string,
    reason: string,
  ) {
    const driver = this;
    return defineTool({
      name,
      label,
      description: `${label}(子 Agent 内不可用)`,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute(toolCallId: string, params: any) {
        // 打回也要先登记调用:tool_result 没有配对的 tool_use 行,
        // parse_transcript 按 id join 不上就整条蒸发——"被打回"这个
        // 事实必须留在证据里,不然嵌套封顶在审计中不可见。
        driver.emit("tool_requested", sessionId, {
          call_id: String(toolCallId), name: kernelName, input: params ?? {},
        });
        throw new Error(reason); // pi 只认 throw 作为工具失败信号
      },
    });
  }

  private async runSubagent(
    callId: string,
    params: Record<string, any>,
  ): Promise<string> {
    const readOnly = params.read_only === true;
    if (!readOnly && params.timeout_seconds !== undefined) {
      throw new Error("单次执行期限只适用于只读子 Agent；请同时设置 read_only，写入型子任务沿用原执行方式");
    }
    const timeoutSeconds = params.timeout_seconds ?? (readOnly ? 180 : undefined);
    if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)) {
      throw new Error("子任务执行期限必须是 1～3600 秒的整数");
    }
    this.childCount += 1;
    const childId = `child-${this.childCount}`;
    // 派发意图先过内核 pretooluse:记 started 观察、验任务卡契约;
    // 内核打回即不派(打回文案原样返回给主 Agent)。
    const hostVerdict = await this.options.hostHooks?.preTool?.({
      eventId: this.options.eventLog.lastEventId(),
      taskId: this.options.taskId,
      sessionId: this.sessionId,
      ts: "",
      kind: "tool_requested",
      payload: { call_id: callId, name: "Task", input: params },
    });
    if (hostVerdict?.action === "deny") {
      throw new Error(hostVerdict.reason ?? "派发被 mae-flow 门禁打回");
    }
    this.emit("agent_spawned", this.sessionId, {
      call_id: callId,
      agent_type: String(params.subagent_type ?? ""),
      description: String(params.description ?? ""),
      prompt: String(params.prompt ?? ""),
      child_session_id: childId,
    });
    const refusal =
      "子 Agent 不设人工节点、不得再派子 Agent;" +
      "按任务卡既有信息完成或如实报告失败。";
    let lifecycle: "returned" | "interrupted" | "failed" = "returned";
    let child: Awaited<ReturnType<CloudSession["openSession"]>> | undefined;
    let setupError = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = timeoutSeconds === undefined ? undefined : new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // 只读旁路超时应让主会话继续，不能再等待子会话的取消请求返回。
        void Promise.resolve().then(() => child?.abort()).catch(() => {});
        reject(new Error(`子 Agent 超过 ${timeoutSeconds} 秒执行期限，本次未完成；保留缺口，不自动重派。`));
      }, timeoutSeconds * 1000);
    });
    try {
      const work = (async () => {
        child = await this.openSession({
          sessionId: childId,
          readOnly,
          customTools: [
            this.refusalTool(childId, "AskUserQuestion",
              "AskUserQuestion", "Ask User Question", refusal),
            this.refusalTool(childId, "Task",
              "Task", "Dispatch Agent", refusal),
          ],
          // 复用同一知识范围；阶段推进和推送工具只归主会话。
          extraTools: childKnowledgeTools(this.options.extraTools),
        });
        if (timedOut) {
          child.dispose();
          return;
        }
        if (this.aborted) throw new Error("子 Agent 启动已取消");
        this.childSessions.set(childId, child);
        let prompt = String(params.prompt ?? "");
        if (params.subagent_type === COMPONENT_ANALYST) {
          let directory: ComponentAnalysisContext | undefined;
          let directoryError: string | undefined;
          try { directory = this.options.componentAnalysisContext?.(); }
          catch (error) {
            directoryError = String(error);
            this.options.log?.(`组件分析启动目录读取未完成：${directoryError}`);
          }
          prompt = componentAnalysisPrompt(prompt, directory, directoryError);
        }
        await child.prompt(prompt);
      })();
      if (deadline) await Promise.race([work, deadline]);
      else await work;
    } catch (error) {
      lifecycle = child ? "interrupted" : "failed";
      setupError = String(error);
      this.options.log?.(`子 Agent ${childId} 中断: ${String(error)}`);
    } finally {
      clearTimeout(timer);
      this.childSessions.delete(childId);
      child?.dispose();
    }
    let finalText = setupError || this.lastAssistantText.get(childId) || "";
    // pi 遇模型层错误(掐线、429 用尽重试……)是正常收轮,prompt() 照样
    // resolve。这时 lastAssistantText 是失败前最后一句旁白,交回去主 Agent
    // 只会看到"中途话术"然后再派一次(实锤:同一子任务连派两次各白等 5 分钟)。
    // 如实按失败返回,错误原文带上,主 Agent 才有依据决定重派还是停下。
    const modelError = this.modelErrors.get(childId);
    this.modelErrors.delete(childId);
    if (lifecycle === "returned" && modelError) {
      lifecycle = "failed";
      finalText = `子 Agent 模型请求失败(pi 自动重试后仍失败): ${modelError}`
        + (finalText ? `\n失败前最后一句: ${finalText}` : "");
      this.options.log?.(`子 Agent ${childId} 模型层失败: ${modelError.slice(0, 400)}`);
    }
    const finished = this.emit("agent_finished", this.sessionId, {
      call_id: callId,
      child_session_id: childId,
      lifecycle,
      final_text: finalText,
    });
    this.hostAnswered.add(callId); // pi 对 dispatch_agent 的回声丢弃
    await this.recordAgentCompletion(finished, params);
    if (lifecycle !== "returned") {
      throw new Error(finalText || "子 Agent 中断,无最终报告");
    }
    return finalText;
  }

  /** 先持久化报告，再等待内核登记，最后落确认事件。任何两步之间重启，
   * 恢复都按原 call_id 重放未确认的完成事件；不补造 started 或成功结果。 */
  private async recordAgentCompletion(
    finished: SemanticEvent, params: Record<string, any>,
  ): Promise<void> {
    if (!this.options.hostHooks?.postTool) return;
    const payload = finished.payload;
    const work = this.options.hostHooks.postTool({
      ...finished,
      kind: "tool_finished",
      payload: {
        call_id: payload.call_id, name: "Task", input: params,
        child_session_id: payload.child_session_id,
        lifecycle: payload.lifecycle,
        is_error: payload.lifecycle !== "returned", result: payload.final_text,
      },
    });
    this.trackKernelHook(work);
    const feedback = await work;
    this.emit("agent_observed", finished.sessionId, {
      call_id: payload.call_id, source_event_id: finished.eventId,
      ...(feedback ? { feedback } : {}),
    });
  }
}
