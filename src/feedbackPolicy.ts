import { OVERALL_STORY_ARTIFACT } from "./overallStoryStore.ts";
import { pendingReviewAnnotation } from "./annotationPending.ts";
/**
 * 反馈闭环的纯领域规则。
 *
 * 这里不认识 TaskService、HTTP、MR 或页面。调用方只给“意见事实”，它
 * 回答哪些意见会阻塞、Agent 的逐条回执是否完整。把这把尺从 1.3 万行
 * 编排器里抽出来，服务端、恢复与测试才能永远使用同一口径。
 */

import type {
  Annotation,
  AnnotationResponse,
  AnnotationRoute,
} from "./annotations.ts";

/** 草稿不是团队事实。例外仅是任务责任人自己的草稿：他在最终确认时
 * 很可能只是忘了点“提交”，此时明确提醒比静默丢意见更安全。其他人的
 * 草稿既不能指挥 Agent，也不能成为锁死别人任务的暗门。 */
export function blockingAnnotations(
  items: Annotation[],
  taskOwner: string | undefined,
): Annotation[] {
  return items.filter((item) => item.status === "sent"
    || (item.status === "draft" && item.needs_owner_closure)
    // 无认证/旧任务没有 owner 时维持单用户语义：它的草稿就是当前
    // 操作者自己的草稿。只有明确知道“这是别人的任务”时才排除路人草稿。
    || (item.status === "draft" && (!taskOwner || item.author === taskOwner)));
}

export function submittedAnnotations(items: Annotation[]): Annotation[] {
  return items.filter((item) => item.status === "sent");
}

/* ------------------------------------------------------------------ *
 * Agent 的"处理完成"与提出人的"验收"是两件事(用户 2026-09-05 拍板):
 * - 已提交给 Agent 的意见,在最终"是否通过 / 确认推送"卡出现之前必须
 *   全部处理完成;"收到了""回了一句"都不算——只有**当前版本**的 fixed
 *   回执算。缺回执、旧版本回执、not_fixed、needs_clarification 都拦。
 * - 确实缺信息时 Agent 可以单独追问(澄清卡),人答了就继续处理;
 *   追问有次数上限,不许来回问。
 * - 处理完成 ≠ 验收:提出人仍在最终卡上逐条确认,Agent 不能替人点通过。
 * ------------------------------------------------------------------ */

/** 此刻在 Agent 手里的意见:已送到它眼前、要它处理的那些。草稿还没送、
 * queued_decision 还在等下一张决定卡捎过去、流水线证据只是取证材料、
 * 记忆不发给任何人、交给责任人的答复/决策没到 Agent 之前也不算。 */
export function agentReviewAnnotations(items: Annotation[]): Annotation[] {
  return items.filter((item) => item.status === "sent"
    // 专项文档会话在发布新正文时登记自己的回执，不归主编码会话处理。
    && !["requirement_queue", "requirement_review", "overall_story_queue",
      "overall_story_processing", "overall_story"].includes(item.sent_via ?? "")
    && item.sent_via !== "pipeline_evidence"
    && item.sent_via !== "queued_decision"
    && item.sent_via !== "issue_review"
    && ((item.route ?? "agent") === "agent"
      || (item.route === "owner_decision" && item.sent_via !== "owner_pending")));
}

/** 还没处理完成的:没有当前版本的 fixed 回执。 */
export function pendingReviewProcessing(items: Annotation[]): Annotation[] {
  return agentReviewAnnotations(items).filter((item) =>
    item.response?.revision !== (item.rework ?? 0)
    || item.response.outcome !== "fixed");
}

/** 同一版正文最多追问几次。人答过两次还问,就是把工作退回给人——之后
 * 只能按最合理理解处理并在回执里写明假设。 */
export const MAX_CLARIFICATION_ROUNDS = 2;

/** 当前版本里人已经在澄清卡上答过的追问。 */
export function answeredClarifications(item: Annotation): NonNullable<Annotation["clarifications"]> {
  const revision = item.rework ?? 0;
  return (item.clarifications ?? []).filter((row) =>
    row.answer !== undefined && row.revision === revision);
}

export function clarificationRoundsLeft(item: Annotation): number {
  return Math.max(0, MAX_CLARIFICATION_ROUNDS - answeredClarifications(item).length);
}

/** 这份回执是不是人已经答过的那个追问:Agent 写回执文件时可能把旧的
 * needs_clarification 原样再抄一遍(它没义务记得哪条已被答复)。这样的
 * 回执不能把已答复的追问"复活"成又在等人。 */
export function answeredClarificationReceipt(
  item: Annotation,
  receipt: Pick<WorkspaceReviewReceipt, "outcome" | "summary" | "revision">,
): boolean {
  return receipt.outcome === "needs_clarification"
    && answeredClarifications(item).some((row) =>
      row.revision === receipt.revision && row.question === receipt.summary);
}

/** 一条未处理完成的意见此刻卡在哪,说给 Agent 听(也写进日志)。 */
export function describeReviewProcessingGap(item: Annotation): string {
  const revision = item.rework ?? 0;
  const current = item.response?.revision === revision ? item.response : undefined;
  const answered = answeredClarifications(item);
  const answeredNote = answered.length
    ? `;你之前的追问已答复:${answered.map((row) =>
      `「${row.question}」→「${row.answer}」`).join("、")}`
    : "";
  if (!current) {
    return `${item.id}:缺当前版本(revision ${revision})的回执${answeredNote}`;
  }
  if (current.outcome === "not_fixed") {
    return `${item.id}:回执是 not_fixed(${current.summary}),不算处理完成`
      + "——要么按意见修改,要么先追问提出人拿到明确答复后再按答复处理"
      + answeredNote;
  }
  return `${item.id}:回执是 needs_clarification(${current.summary}),`
    + (clarificationRoundsLeft(item) > 0
      ? "尚未向人追问——用 AskUserQuestion(purpose=clarification)问清楚,答复后继续"
      : `追问已达 ${MAX_CLARIFICATION_ROUNDS} 次上限,不能再问——按最合理理解处理,回执里写明假设`)
    + answeredNote;
}

/** 一组待处理意见的指纹(id + 版本):催办预算、派单去重都按它算,换一批
 * 意见或改了字自然重置。 */
export function reviewProcessingKey(items: Annotation[]): string {
  return items.map((item) => `${item.id}:r${item.rework ?? 0}`).sort().join(",");
}

export interface WorkspaceReviewReceipt {
  annotation_id: string;
  revision: number;
  outcome: AnnotationResponse["outcome"];
  summary: string;
  evidence?: string[];
}

export interface ParsedWorkspaceReceipts {
  receipts: WorkspaceReviewReceipt[];
  missing_ids: string[];
  unexpected_ids: string[];
  errors: string[];
}

/** 回执说明的下限:少于这个字数基本只能是结论词。 */
export const MIN_RECEIPT_SUMMARY_LENGTH = 6;
/** 只写结论词的"说明":已处理 / 已修改 / done / fixed / ok…,不算说明。 */
const PLACEHOLDER_SUMMARY =
  /^(已处理|已修改|已修复|已完成|已解决|处理完成|修改完成|修复完成|完成|搞定|改好了|done|fixed|resolved|ok|okay|n\/a|无)[。.!！~～]*$/i;

/** Agent 写出的文件是不可信输入：逐项校验、按当前 revision 对拍，绝不
 * 用数组顺序猜对应关系。重复 id 也是错误，否则后写者会静默覆盖前者。 */
export function parseWorkspaceReviewReceipts(
  value: unknown,
  expected: Annotation[],
): ParsedWorkspaceReceipts {
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      && Array.isArray((value as { receipts?: unknown }).receipts)
      ? (value as { receipts: unknown[] }).receipts : [];
  const receipts: WorkspaceReviewReceipt[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unexpected = new Set<string>();
  for (const [at, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object") {
      errors.push(`第 ${at + 1} 条回执不是对象`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const id = String(item.annotation_id ?? "").trim();
    if (!id) {
      errors.push(`第 ${at + 1} 条回执缺 annotation_id`);
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
      errors.push(`批注 ${id} 出现重复回执`);
      continue;
    }
    seen.add(id);
    const target = expectedById.get(id);
    if (!target) {
      unexpected.add(id);
      continue;
    }
    const revision = Number(item.revision ?? 0);
    if (!Number.isInteger(revision) || revision !== (target.rework ?? 0)) {
      errors.push(`批注 ${id} 回执 revision=${String(item.revision ?? 0)}`
        + `，当前应为 ${target.rework ?? 0}`);
      continue;
    }
    const outcome = String(item.outcome ?? "");
    if (!["fixed", "not_fixed", "needs_clarification"].includes(outcome)) {
      errors.push(`批注 ${id} 的 outcome 不合法`);
      continue;
    }
    const summary = String(item.summary ?? "").trim();
    if (!summary) {
      errors.push(`批注 ${id} 缺少逐条说明`);
      continue;
    }
    // "已处理"三个字不是说明:人看到只知道它改了,不知道改了什么(用户实锤
    // "显示已处理但完全不知道它怎么处理的")。一句话下限 6 个字,且不能只是
    // 结论词本身。
    if (summary.length < MIN_RECEIPT_SUMMARY_LENGTH || PLACEHOLDER_SUMMARY.test(summary)) {
      errors.push(`批注 ${id} 的 summary 只写了「${summary}」,要说清改了什么或为什么不改`);
      continue;
    }
    const evidence = Array.isArray(item.evidence)
      ? [...new Set(item.evidence.map(String).map((one) => one.trim()).filter(Boolean))].slice(0, 20)
      : [];
    // fixed = 真改了文件,那就必须能指出改在哪(path:line);没有位置的"已修复"
    // 人无法复核。not_fixed / needs_clarification 不改文件,不强求。
    if (outcome === "fixed" && !evidence.length) {
      errors.push(`批注 ${id} 标了 fixed 但没有 evidence,写上改动位置(path:line)`);
      continue;
    }
    receipts.push({
      annotation_id: id,
      revision,
      outcome: outcome as WorkspaceReviewReceipt["outcome"],
      summary,
      evidence,
    });
  }
  // 重复 id 的任意一条都不能被当作确定结果，其他合法条目仍可独立登记。
  const valid = receipts.filter((item) => !duplicates.has(item.annotation_id));
  const accepted = new Set(valid.map((item) => item.annotation_id));
  return {
    receipts: valid,
    missing_ids: expected.filter((item) => !accepted.has(item.id))
      .map((item) => item.id),
    unexpected_ids: [...unexpected],
    errors,
  };
}

export function unansweredAnnotations(
  items: Annotation[],
  ids: Iterable<string>,
): Annotation[] {
  const wanted = new Set(ids);
  return items.filter((item) => wanted.has(item.id)
    && item.status === "sent"
    && item.response?.revision !== (item.rework ?? 0));
}

export function workspaceReviewReceiptInstructions(items: Annotation[], receiptPath: string): string {
  if (!items.length) return "";
  const revisions = items.map((item) =>
    `- ${item.id}: revision ${item.rework ?? 0}`).join("\n");
  return [
    `逐条处理后必须把机器可核对的回执写到这个唯一绝对路径：${JSON.stringify(receiptPath)}。`,
    "回执路径以本次给出的绝对路径为准，覆盖旧提示中的相对路径；即使 Bash 切换了目录，也原样使用该地址。",
    "若改动已经完成但回执写到了别处，只核对并补写回执，不要因此重复修改文档或代码。",
    "该目录在代码仓外，不会进入提交；可直接使用文件工具或 Bash 写入。",
    "文件格式必须是 JSON 对象，不要写 Markdown 围栏：",
    '{"receipts":[{"annotation_id":"an-...","revision":0,'
      + '"outcome":"fixed|not_fixed|needs_clarification",'
      + '"summary":"改了什么，或为什么不改","evidence":["path:line"]}]}',
    "每个 annotation_id 恰好一条；缺失、重复或旧 revision 都不会进入 push。",
    "summary 是给提意见的人看的:一句话说清改了什么或为什么不改,不能只写"
      + "「已处理」这类结论词;outcome=fixed 必须带 evidence(path:line),"
      + "指出改在哪里——没有位置的回执会被退回重写。",
    "在你举起任何确认卡、或结束本轮之前，所有已提交意见都必须有当前 revision 的"
      + " fixed 回执。not_fixed 和 needs_clarification 都不算处理完成，只是中间状态。",
    "确实缺少信息时：先把这条写成 needs_clarification 并写明具体疑问，再单独调用"
      + " AskUserQuestion，purpose=clarification、annotation_ids=[对应意见 ID]，"
      + "只问缺少的信息，不夹带整体通过、验收或推送确认。人答复后按答复继续处理，"
      + "把这条改写成 fixed（summary 写明依据）。同一条意见最多追问"
      + ` ${MAX_CLARIFICATION_ROUNDS} 次；仍不清楚就按最合理理解处理并在 summary 写明假设。`,
    "本轮清单：",
    revisions,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 一条检视意见此刻在哪、球在谁脚下、谁能动它——**唯一判定处**。
 *
 * 这段逻辑原来同时长在两处:服务端按 sent_via/status 决定放不放行,
 * 前端 AnnotationPanel 自己再推一遍决定显示什么字、开哪个按钮。两边
 * 各自演化,于是每加一个入口(抽屉、全屏、决定卡、MR 复检)就多一份
 * 推法,也就多一条 bug——本周 111 条 fix 里 42 条落在这个概念上。
 *
 * 现在只有这里判。API 把结论镜像给前端,前端只渲染不推断(CLAUDE.md
 * 「前端不推断状态,一切文案来自任务 API 镜像」)。新增一种 sent_via
 * 或一条路由,改这一个文件加它的测试即可,所有界面自动跟上。
 * ------------------------------------------------------------------ */

export type AnnotationTone = "draft" | "waiting" | "review" | "done";
/** 抽屉顶部筛选条的档位:等我确认 / 处理与验证 / 已闭环。 */
export type AnnotationBucket = "mine" | "agent" | "closed";

/** 判定要用的任务侧事实。全是现成字段,这里不查库、不猜。 */
export interface AnnotationClosureFacts {
  task_status: string;
  task_owner?: string;
  owner_controlled?: boolean;
  /** 工作台复检卡已到:MR 修复轮的逐条裁决只在这时开放。 */
  review_ready: boolean;
  /** 本轮复检卡点名的意见;管理员代办白名单也用它。 */
  review_annotation_ids: readonly string[];
  /** 任务已交付。此时仍是草稿的意见只作档案展示,不再是待办。 */
  archival: boolean;
}

/** 谁在看。权限是判定的一部分:同一条意见对作者、管理员、路人是三种处境。 */
export interface AnnotationViewerFacts {
  username: string;
  can_override: boolean;
  can_route_others: boolean;
}

export interface AnnotationClosure {
  id: string;
  tone: AnnotationTone;
  /** 状态词与提示:前端原样渲染,不再自己拼。 */
  text: string;
  hint?: string;
  bucket: AnnotationBucket;
  /** "已交给当前 MR 的修复 Agent" 这类去向说明。 */
  delivery_text: string;
  /** 这条到没到裁决点——与谁在看无关。 */
  verdict_ready: boolean;
  /** 当前这位看的人能不能亲自裁决(作者到点,或管理员代办)。 */
  actionable: boolean;
  can_verify: boolean;
  owner_controlled?: boolean;
  can_resolve?: boolean;
  can_delete?: boolean;
  can_edit?: boolean;
  can_reopen?: boolean;
  can_override_verify: boolean;
  can_override_drop: boolean;
  /** 别人的草稿,这位看的人可以代为转交/提交。 */
  can_route: boolean;
  /** 当前轮回执是"需要补充说明"。页面据此在"确认/返工"与"补充说明后
   * 重提"之间二选一——原来它只看 outcome 不看 revision,上一轮的追问会
   * 让按钮错开。 */
  needs_clarification: boolean;
  /** 本轮复检点名了这条、且看的人就是作者,但 Agent 的当前轮回执还没到。
   * 面板据此说"另有 N 条回执尚未就绪",不必自己再对一遍 revision。 */
  receipt_missing: boolean;
}

export function annotationRoute(item: Annotation): AnnotationRoute {
  return item.route ?? "agent";
}

/** 工作台复检卡是否已到。四个条件缺一不可,原来服务端和前端各写一遍。 */
export function workspaceReviewReady(input: {
  task_status: string;
  waiting_step?: string;
  review_source?: string;
  recheck_required?: boolean;
}): boolean {
  return input.task_status === "waiting_for_human"
    && input.waiting_step === "cloud_push_confirm"
    && input.review_source === "workspace"
    && input.recheck_required === true;
}

/** Agent 这一轮的回执是不是针对当前 revision。旧回执不背书新一轮。 */
function currentResponse(item: Annotation): AnnotationResponse | undefined {
  return item.response?.revision === (item.rework ?? 0) ? item.response : undefined;
}

/**
 * 意见作者什么时候可以裁决一条已送达批注。
 *
 * MR 修复轮有逐条结构化回执,仍按 review_ready 的严格门禁开放;普通
 * 需求/设计检视没有这份回执,Agent 再次举卡就是本轮已经回到人工的
 * 权威事实。两类曾被混成一类:普通批注送达、Agent 也改完并再次等人后,
 * 页面仍藏起"确认已修复 / 仍需调整",服务端又用这条 sent 意见阻止通过,
 * 形成无法自救的闭环死锁。
 */
export function annotationVerdictReady(
  item: Annotation,
  facts: AnnotationClosureFacts,
): boolean {
  if (item.status !== "sent") return false;
  // 问责任人的意见不需要等 Agent 或任务阶段:责任人留下原话后,
  // 提出人即可判断是否解答。决策后处理仍必须等 Agent 真正执行。
  if (annotationRoute(item) === "owner_reply") return Boolean(item.owner_reply);
  if (item.artifact === OVERALL_STORY_ARTIFACT) {
    return facts.task_status !== "canceled" && item.sent_via === "overall_story" && Boolean(currentResponse(item));
  }
  if (facts.task_status !== "waiting_for_human") return false;
  // 只是趁"等决定"窗口先登记为团队事实,还没随决定送给 Agent。
  if (["queued_decision", "requirement_queue", "requirement_review"].includes(item.sent_via ?? "")) return false;
  // 流水线证据用于恢复取证,不是代码/文档检视闭环。
  if (item.sent_via === "pipeline_evidence") return false;
  // MR 工作区修复必须生成当前复检卡;有总回复也
  // 不能绕过逐条回执与 HEAD 绑定。
  if (item.sent_via === "review_repair") {
    const current = currentResponse(item);
    // "需要补充说明":回执已登记、球在作者脚下,不必等最终推送卡。
    if (current?.outcome === "needs_clarification") return true;
    return facts.review_ready && Boolean(current);
  }
  // decision / interrupt 以及没有 sent_via 的旧账都是普通流程检视。
  return true;
}

/** 管理员旁路:必须同时满足本轮复检白名单与阶段事实,缺一即关。 */
export function annotationOverrideAccess(
  item: Annotation,
  facts: AnnotationClosureFacts,
  viewer: AnnotationViewerFacts,
): { can_drop: boolean; can_verify: boolean } {
  const pending = viewer.can_override
    && facts.review_ready
    && item.author !== viewer.username
    && item.status === "sent"
    && facts.review_annotation_ids.includes(item.id);
  const current = currentResponse(item);
  return {
    can_drop: pending,
    can_verify: pending && Boolean(current)
      && current!.outcome !== "needs_clarification",
  };
}

/** 别人的草稿能不能由这位看的人代为送出。 */
function canRouteDraft(
  item: Annotation,
  facts: AnnotationClosureFacts,
  viewer: AnnotationViewerFacts,
): boolean {
  return item.status === "draft"
    && item.author !== viewer.username
    && viewer.can_route_others
    && facts.task_status !== "canceled"
    && (facts.task_status !== "completed" || item.artifact === OVERALL_STORY_ARTIFACT)
    && (annotationRoute(item) === "agent" || item.assignee === viewer.username);
}

function deliveryTextOf(
  item: Annotation,
  facts: AnnotationClosureFacts,
  personName: (username: string) => string,
): string {
  if (annotationRoute(item) === "memory") return "已记为记忆，不发给任何人";
  if (item.status === "verified") {
    return item.verified_by && item.verified_by !== item.author
      ? `管理员 ${personName(item.verified_by)} 代确认`
      : "意见作者已确认";
  }
  if (item.status !== "sent") {
    return facts.archival && item.status === "draft" ? "交付后记录" : "尚未提交";
  }
  if (item.sent_via === "owner_pending") {
    return annotationRoute(item) === "owner_reply"
      ? "已交给责任人答复" : "已交给责任人决策";
  }
  if (item.sent_via === "overall_story_queue") return "已排队，Agent 将修改整体 Story";
  if (item.sent_via === "overall_story_processing") return "Agent 正在修改整体 Story";
  if (item.sent_via === "overall_story") return "整体 Story 已有处理回执，请检视改动";
  if (item.sent_via === "decision") return "通过审批提交";
  if (item.sent_via === "pipeline_evidence") return "作为流水线证据提交";
  if (item.sent_via === "review_repair") return "已交给当前 MR 的修复 Agent";
  if (item.sent_via === "requirement_review") return "Agent 正在处理这条需求意见";
  if (item.sent_via === "requirement_queue") return "已排队，当前需求修订完成后自动处理";
  if (item.sent_via === "queued_decision") return "已排队，随决定送达";
  return "执行中发送";
}

/** 检视闭环的五站:待提交 → 已提交 → 已被改动·请你确认 → 确认通过 / 返工。 */
function progressOf(
  item: Annotation,
  facts: AnnotationClosureFacts,
  anchorGone: boolean,
  /** 当前看的人此刻能裁决(作者且到点,或管理员代办)。 */
  actionable: boolean,
  /** 这条意见本身到没到裁决点(与看的人无关)。 */
  ready: boolean,
  personName: (username: string) => string,
  /** 看的人就是作者。"再由你确认"只能对作者说,对旁人要点名作者——
   *  用户 2026-09-05 以责任人身份看别人的意见,问"在哪里点通过":文案
   *  说"再由你确认",按钮却永远不会给他。 */
  isAuthor: boolean,
): { tone: AnnotationTone; text: string; hint?: string } {
  const judge = isAuthor ? "你" : `意见作者 ${personName(item.author)} `;
  if (annotationRoute(item) === "memory") {
    return { tone: "done", text: "已记为记忆",
      hint: "没有发给任何人。以后有人改到这段附近时，平台会把它提醒给 Agent。" };
  }
  if (item.status === "verified") {
    const proxy = item.verified_by && item.verified_by !== item.author
      ? item.verified_by : undefined;
    return proxy
      ? { tone: "done", text: "管理员代确认",
          hint: `由管理员 ${personName(proxy)} 代替批注作者 ${
            personName(item.author)} 确认。` }
      : { tone: "done", text: "确认通过", hint: "意见作者已确认这处改动符合要求。" };
  }
  if (item.status !== "sent") {
    // 归档只对草稿成立:交付后仍留在草稿里的意见是档案,不是待办。
    if (facts.archival && item.status === "draft") {
      return { tone: "draft", text: "交付后记录",
        hint: "任务已经交付，这条记录保留在任务档案中，不会再触发 Agent 修改。" };
    }
    // 看 returned 不看 rework:作者补充说明后重提也会换版本号,但那不是
    // "上一轮改坏了"。
    return item.returned
      ? { tone: "draft", text: `第 ${item.returned + 1} 轮·待提交`,
          hint: "上一轮改动没达到要求,这条已退回,提交后会再送给 AI。" }
      : { tone: "draft", text: "待提交" };
  }
  const route = annotationRoute(item);
  if (route !== "agent" && !item.owner_reply) {
    return {
      tone: "waiting",
      text: route === "owner_reply" ? "等待责任人答复" : "等待责任人决策",
      hint: `已指派给 ${item.assignee ? personName(item.assignee) : "任务责任人"
        }，Agent 不会代答。`,
    };
  }
  if (route === "owner_reply" && item.owner_reply) {
    return { tone: "review", text: "等待提出人确认",
      hint: "责任人已经答复，请由意见提出人确认是否解决问题。" };
  }
  if (route === "owner_decision" && item.owner_reply && !actionable) {
    return {
      tone: "waiting",
      text: item.sent_via === "owner_pending"
        ? "决策已记录·等待继续"
        : item.sent_via === "queued_decision"
          ? "决策已记录·等待执行" : "决策已交给 Agent",
      hint: item.sent_via === "owner_pending"
        ? "责任人结论已经保存；当前流程暂时不能接收，恢复后可继续交给 Agent。"
        : item.sent_via === "queued_decision"
          ? "当前还有任务决定卡；提交决定后，这份责任人结论会一并交给 Agent。"
          : "责任人已经给出结论，正在等待 Agent 完成修改。",
    };
  }
  if (actionable) {
    const current = currentResponse(item);
    if (current?.outcome === "needs_clarification") {
      return { tone: "review", text: "Agent 需要你补充说明",
        hint: current.summary || "Agent 说明这条意见有歧义，请补充后重提。" };
    }
    return { tone: "review", text: "待你确认",
      hint: current
        ? "Agent 已留下当前轮逐条回应，请核对最新材料后确认或退回。"
        : "任务已回到人工检视，请核对最新材料后确认或退回。" };
  }
  // 等决定期间提交的意见只是登记成团队事实,正文还没送到 Agent——原来
  // 也显示"已提交",人以为送到了,其实要等责任人在卡上选返工(内网实锤)。
  if (route === "agent" && item.sent_via === "queued_decision") {
    return { tone: "waiting", text: "已排队·等决定",
      hint: "还没送到 Agent:任务正等一张决定卡,责任人在卡上选「需要调整」提交后才随决定送达。" };
  }
  if (item.sent_via === "overall_story_queue") {
    return { tone: "waiting", text: "已排队 · 整体 Story", hint: "当前一轮结束后自动处理，完成后请检视文档改动。" };
  }
  if (item.sent_via === "overall_story_processing") {
    return { tone: "waiting", text: "Agent 正在修改整体 Story", hint: "只修改整体文档；子任务设计和代码另行处理。" };
  }
  if (route === "agent" && item.sent_via === "requirement_queue") {
    return { tone: "waiting", text: "已排队·需求修订",
      hint: "当前一批完成后自动处理这条意见，无需再次提交；处理后仍需由意见作者复检确认。" };
  }
  if (route === "agent" && item.sent_via === "requirement_review") {
    return { tone: "waiting", text: "Agent 正在修改需求",
      hint: "这条意见已提交并正在处理，不需要再次提交；完成后请核对改动并确认。" };
  }
  // 还没到裁决点:回执在 Agent 本轮结束后才登记,MR 修复轮的意见更要等到
  // 最终推送确认卡。这之前原来写成"已提交/已被改动·请你确认",人以为
  // 送到了、以为能确认(内网实锤:9 条意见、Agent 说全闭环、按钮却不在)。
  if (!ready && item.sent_via !== "pipeline_evidence") {
    const viaRepair = item.sent_via === "review_repair";
    // 原文消失只能证明"这处有改动",不能证明意见已经修好;但完全藏掉
    // 继续写"Agent 处理中"也是假状态。拆成已有改动 / 回执 / 人工确认三层。
    const where = anchorGone ? "你圈的原文已经不在了（Agent 动过这处）；" : "";
    const current = currentResponse(item);
    if (current) {
      const outcome = current.outcome === "fixed" ? "已修改"
        : current.outcome === "not_fixed" ? "未修改" : "需要你补充说明";
      // 回执正文卡上就有,不在这里重复;这里只说"等谁、到哪一步能点"。
      return { tone: "waiting", text: `Agent 回执：${outcome}·等复检`,
        hint: `${where}Build-Fix 通过、最终推送确认卡出现后，由${judge}点「确认已修复」或「仍需调整」。` };
    }
    if (anchorGone) {
      return { tone: "waiting", text: "已有改动·待验证",
        hint: "你圈的原文已经发生变化；平台还在等待这条意见的逐条回执，暂不冒充已经修好。" };
    }
    return { tone: "waiting",
      text: viaRepair ? "等待 Agent 回执" : "已交给 Agent",
      hint: viaRepair
        ? `${where}Agent 处理完会为每条意见留下回执；Build-Fix 通过、最终推送确认卡出现后由${judge}确认。`
        : `${where}平台尚未收到这条意见的处理回执；任务再次停下等人时由${judge}确认。` };
  }
  // 到点了但看的人不是作者:裁决权在作者手里,别对旁人说"请你确认"。
  return anchorGone
    ? { tone: "review", text: "已被改动·等作者确认",
        hint: `你圈的原文已经不在了；是否修好由意见作者 ${
          personName(item.author)} 确认。` }
    : { tone: "waiting", text: "等作者确认",
        hint: `由意见作者 ${personName(item.author)} 确认是否修好。` };
}

/** 一条意见对某位观察者的完整处境。所有界面都读它,不再各推各的。 */
export function annotationClosure(
  item: Annotation,
  facts: AnnotationClosureFacts,
  viewer: AnnotationViewerFacts,
  options: {
    anchor_gone?: boolean;
    person_name?: (username: string) => string;
  } = {},
): AnnotationClosure {
  if (item.artifact === OVERALL_STORY_ARTIFACT) facts = { ...facts, archival: false };
  const personName = options.person_name ?? ((username: string) => username);
  if (facts.owner_controlled && annotationRoute(item) !== "memory") {
    const pending = item.status === "sent" || item.status === "draft";
    const owner = facts.task_owner ?? "本地用户";
    const mine = viewer.username === owner;
    const canManage = mine && facts.task_status !== "canceled"
      && (!facts.archival || item.artifact === OVERALL_STORY_ARTIFACT);
    const response = currentResponse(item);
    const queuedDecision = item.status === "sent" && item.sent_via === "queued_decision" && !response;
    const handingOff = item.status === "draft" && !!item.agent_assigned;
    const waitingForAgent = handingOff || (item.status === "sent" && item.sent_via !== "owner_pending" && !response);
    const answered = !handingOff && (!!response || (!!item.owner_reply && item.sent_via === "owner_pending"));
    const canResolve = pending && canManage && answered;
    const labels = { fixed: "责任人确认已修复", not_adopted: "责任人不采纳", deferred: "责任人决定延期", accepted_risk: "责任人接受风险继续" };
    const resolution = item.resolution;
    // 没有新处置事件的旧闭环保留原操作者和原含义。
    if (pending || resolution || item.status === "verified") return {
      id: item.id, tone: resolution ? "done" : "review",
      text: item.status === "verified" ? "已闭环" : handingOff ? "正在发送给 Agent" : queuedDecision ? ["paused", "pausing"].includes(facts.task_status ?? "") ? "已排队，等任务恢复" : "已排队，等当前决定" : waitingForAgent ? "等待 Agent 答复" : answered ? "待责任人确认闭环" : "待处理",
      hint: resolution ? `${personName(resolution.by)}：${resolution.reason || response?.summary || item.owner_reply?.text || "已核对处理结果"}`
        : queuedDecision ? ["paused", "pausing"].includes(facts.task_status ?? "")
          ? "意见已提交，恢复任务后处理。" : "尚未送到 Agent；答复当前问题后，意见会一起送达。"
        : item.withdrawal_requested ? "提出人申请撤回表达，仍需责任人逐条处置。"
        : `由任务责任人 ${personName(owner)} 核对回执及最新材料后逐条决定。`,
      bucket: item.status === "verified" ? "closed" : mine && (!waitingForAgent || queuedDecision) ? "mine" : "agent",
      delivery_text: resolution ? `由责任人 ${personName(resolution.by)} 处置` : handingOff ? "正在发送，尚未取得送达回执" : item.status === "draft" ? "已记下，等待责任人处理" : deliveryTextOf(item, facts, personName),
      verdict_ready: answered, actionable: pending && canManage && (!waitingForAgent || queuedDecision), can_resolve: canResolve, owner_controlled: true,
      can_delete: canManage && pendingReviewAnnotation(item) && !item.agent_assigned,
      can_edit: canManage && pendingReviewAnnotation(item) && !item.agent_assigned,
      can_reopen: canManage && (item.status === "verified" || (item.status === "sent" && answered)),
      can_verify: canResolve && (response?.outcome === "fixed" || (item.route === "owner_reply" && !!item.owner_reply)),
      can_override_verify: false, can_override_drop: false, can_route: canManage && pendingReviewAnnotation(item) && !handingOff,
      needs_clarification: response?.outcome === "needs_clarification", receipt_missing: waitingForAgent && !handingOff && !queuedDecision && mine,
    };
  }
  const ready = annotationVerdictReady(item, facts);
  const override = facts.owner_controlled ? { can_drop: false, can_verify: false } : annotationOverrideAccess(item, facts, viewer);
  const isAuthor = item.author === viewer.username;
  const canVerify = !facts.owner_controlled && isAuthor && ready;
  const actionable = canVerify || override.can_verify;
  const progress = progressOf(item, facts, Boolean(options.anchor_gone),
    actionable, ready, personName, isAuthor);
  const bucket: AnnotationBucket =
    item.status === "verified" || item.status === "dropped" ? "closed"
    : item.status === "draft"
      ? (isAuthor || canRouteDraft(item, facts, viewer) ? "mine" : "agent")
      : canVerify ? "mine"
      : override.can_verify ? "mine" : "agent";
  return {
    id: item.id,
    owner_controlled: facts.owner_controlled,
    tone: progress.tone,
    text: progress.text,
    ...(progress.hint ? { hint: progress.hint } : {}),
    bucket,
    delivery_text: deliveryTextOf(item, facts, personName),
    verdict_ready: ready,
    actionable,
    can_verify: canVerify,
    can_override_verify: override.can_verify,
    can_override_drop: override.can_drop,
    can_route: canRouteDraft(item, facts, viewer),
    needs_clarification:
      currentResponse(item)?.outcome === "needs_clarification",
    receipt_missing: facts.review_ready
      && facts.review_annotation_ids.includes(item.id)
      && item.status === "sent"
      && isAuthor
      && !currentResponse(item),
  };
}

export function annotationClosures(
  items: readonly Annotation[],
  facts: AnnotationClosureFacts,
  viewer: AnnotationViewerFacts,
  options: {
    /** 锚点原文已消失的意见 id。"被改动"只认这一个判据。 */
    anchor_gone_ids?: Iterable<string>;
    person_name?: (username: string) => string;
  } = {},
): AnnotationClosure[] {
  const gone = new Set(options.anchor_gone_ids ?? []);
  return items.map((item) => annotationClosure(item, facts, viewer, {
    anchor_gone: gone.has(item.id),
    ...(options.person_name ? { person_name: options.person_name } : {}),
  }));
}
