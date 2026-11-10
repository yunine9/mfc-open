import { ReviewBody } from "./ReviewBody";
import { supplementAnnotation } from "./api";
import { OVERALL_STORY_ARTIFACT } from "./OverallStoryTools";
/**
 * 批注清单:记录批注内容、提交状态和原位置变化。
 *
 * 进展这一栏只报**事实**,不下"已采纳"这种结论:
 * - 锚定的原文还在(不论挪没挪行)→ 它还没改这里
 * - 原文已不在 → 这处已经被改动
 * 是不是照你说的改的,你看了再说——系统替你判断"采纳了"就是推断,
 * 而推断错了比不显示更坏(你会以为提过的都落实了)。
 *
 * 踩过的坑(2026-08-19 内网实锤):moved(原文还在,只是行号变了)
 * 一度也被当"已被改动·请你确认"。agent 在跑,别处任何改动都会让
 * 行号漂移——批注打在工作区变更(diff)上时更是全文重排,刚送出的
 * 批注秒变"已修改请检视",而批的那处一个字没动。位置漂移只是定位
 * 信息(脚注里如实标),"被改动"的判据只有一个:原文没了。
 *
 * 没有"批注管理页":这块面板就长在工作台里,跟材料和决定同屏。
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Alert } from "./components/Alert";
import { resolvedAnnotationRange } from "./annotateTargets";
import {
  dropAnnotation,
  editAnnotation,
  judgeAnnotation,
  replyToAnnotation,
  sendAnnotations,
  TASK_REQUIREMENT_ARTIFACT,
  type AnnotationSubmissionView,
  type Annotation,
  type AnchorCheck,
  type AnnotationClosure,
  type TaskStatus,
  annotationAssetUrl,
} from "./api";
import { shortPath } from "./paths";
import { relativeTime } from "./time";

const ANCHOR_TEXT: Record<AnchorCheck["state"], string> = {
  hit: "定位正常",
  moved: "原文仍在,行号有漂移(定位已跟随)",
  gone: "原位置内容已删除",
  ambiguous: "存在多个匹配位置",
};

type AnnotationRoute = NonNullable<Annotation["route"]>;

function routeOf(item: Annotation): AnnotationRoute {
  return item.route ?? "agent";
}



export type AdminOverrideAction = "drop" | "verify";

export interface AdminOverrideArm {
  annotationId: string;
  action: AdminOverrideAction;
}

/** 首次点击只武装；只有同一条意见上的同一动作再次点击才真正执行。 */
export function advanceAdminOverrideArm(
  current: AdminOverrideArm | undefined,
  annotationId: string,
  action: AdminOverrideAction,
): { execute: boolean; arm: AdminOverrideArm | undefined } {
  if (current?.annotationId === annotationId && current.action === action) {
    return { execute: true, arm: undefined };
  }
  return { execute: false, arm: { annotationId, action } };
}

/** 批注与检视抽屉顶部筛选条的三档:等我确认 / 处理与验证 / 已闭环。
 * 批注、CodeHub 意见、机器告警三节共用,人一眼看到"此刻压在我这的有几条"。 */
export type ReviewFilter = "all" | "mine" | "agent" | "closed";

/** 说话人头像里的那一个字:中文名取姓(首字),英文名取首字母大写。 */
function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return /^[A-Za-z]/.test(trimmed) ? trimmed[0].toUpperCase() : trimmed[0];
}

/** 账号是权限主键，不是给人看的称呼；没有配置姓名时才退回账号。 */
export function displayPersonName(
  username: string,
  people: readonly { username: string; display_name?: string }[] = [],
): string {
  return people.find((person) => person.username === username)
    ?.display_name?.trim() || username;
}

/** 责任人核对答复后闭环，也可继续处理；不引入额外处置表单。 */
function OwnerResolution({ item, canVerify, busy, onResolve, onReopen }: {
  item: Annotation; canVerify: boolean; busy: boolean;
  onResolve(outcome: string, reason: string): void; onReopen(): void;
}) {
  return <div className="annot-resolution-actions">
    <Button type="button" size="sm" disabled={busy} onClick={() => onResolve("fixed", "")}>确认闭环</Button>
  </div>;
}

export function AnnotationPanel({
  taskId,
  viewerUsername,
  items,
  checks,
  closures,
  reply,
  canOperate,
  taskStatus,
  reviewReady = false,
  reviewAnnotationIds = [],
  overallStoryPublished = false,
  submission,
  filter = "all",
  focus,
  people = [],
  onChanged,
  onLocate,
  onShowThread,
}: {
  /** 抽屉顶部筛选条选中的档;非 all 时只列该档的批注。 */
  filter?: ReviewFilter;
  /** 从文档/代码行反向定位过来；request 保证连续点同一行也会重新闪。 */
  focus?: { ids: readonly string[]; request: number };
  /** 平台账号到显示姓名的窄视图；权限判断始终仍使用稳定账号。 */
  people?: readonly { username: string; display_name?: string }[];
  taskId: string;
  viewerUsername: string;
  items: Annotation[];
  checks: AnchorCheck[];
  /** 每条意见此刻的处境:服务端 feedbackPolicy 算好的唯一结论。
   * 页面只渲染 text/hint、只按 can_* 开按钮,不再自己推。 */
  closures: readonly AnnotationClosure[];
  /** 旧任务的总体回复兼容展示；新检视以每条 response 为权威。 */
  reply?: { texts: string[]; truncated: boolean };
  canOperate: boolean;
  /** 点一条回到材料里那一行——改批注前人几乎总要再看一眼上下文。 */
  onLocate?: (item: Annotation) => void;
  /** 到右栏会话流里只看这条意见的处理记录(送出→回执→追问→确认)。 */
  onShowThread?: (id: string) => void;
  taskStatus: TaskStatus;
  /** 人工意见修复与 Build-Fix 都已完成，当前真的轮到意见作者裁决。 */
  reviewReady?: boolean;
  /** 当前工作区复检仍待闭环的意见 ID；缺席时管理员旁路按关闭处理。 */
  reviewAnnotationIds?: readonly string[];
  /** 设计发布后才使用独立 Story 会话；分析草稿仍随分析确认卡返工。 */
  overallStoryPublished?: boolean;
  /** 与实际提交共用的服务端判断；页面不按任务状态另算一遍。 */
  submission?: AnnotationSubmissionView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [contextId, setContextId] = useState("");
  const [contextText, setContextText] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [mutationBusy, setMutationBusy] = useState("");
  const [replyingId, setReplyingId] = useState("");
  const [ownerReply, setOwnerReply] = useState("");
  const [error, setError] = useState("");
  const [submissionNotice, setSubmissionNotice] = useState("");
  const [overrideArm, setOverrideArm] = useState<AdminOverrideArm>();
  const listRef = useRef<HTMLOListElement>(null);
  const personName = (username: string) => displayPersonName(username, people);
  // 结论按 id 取。服务端为每条可见意见都下发一条;真缺了就当"还在
  // 处理"(不可操作),绝不在这里补一套推断把不一致藏起来。
  const closureMap = new Map(closures.map((one) => [one.id, one]));
  const closureOf = (item: Annotation): AnnotationClosure =>
    closureMap.get(item.id) ?? {
      id: item.id, tone: "waiting", text: "处理中", bucket: "agent",
      delivery_text: "", verdict_ready: false, actionable: false,
      can_verify: false, can_override_verify: false,
      can_override_drop: false, can_route: false,
      needs_clarification: false, receipt_missing: false,
    };
  // 责任人统一提交仍待处理的意见；自行答复或闭环的条目不会夹带发送。
  const ownerControlled = closures.some(entry => entry.owner_controlled);
  const drafts = items.filter(item => ownerControlled
    ? closureOf(item).can_route && (item.status === "draft" || item.sent_via === "owner_pending")
    : item.status === "draft" && item.author === viewerUsername);
  const routedDrafts = items.filter((item) => closureOf(item).can_route);
  const overrideReviewCount = items.filter((item) =>
    closureOf(item).can_override_drop).length;
  const ordinaryReviewCount = items.filter((item) =>
    (closureOf(item).can_resolve || closureOf(item).can_verify)
    && routeOf(item) !== "owner_reply"
    && item.sent_via !== "review_repair").length;
  const ownerReplyReviewCount = items.filter((item) =>
    (closureOf(item).can_resolve || closureOf(item).can_verify) && routeOf(item) === "owner_reply").length;
  const authorActionable = (item: Annotation) => !!(closureOf(item).can_resolve || closureOf(item).can_verify);
  const overrideActionable = (item: Annotation) =>
    closureOf(item).can_override_verify;
  const authorActionableCount = items.filter(authorActionable).length;
  const overrideActionableCount = items.filter((item) =>
    !authorActionable(item) && overrideActionable(item)).length;
  const actionableReviewCount = authorActionableCount + overrideActionableCount
    + routedDrafts.length;
  const currentReviewIds = new Set(reviewAnnotationIds);
  const missingReceiptCount = items.filter((item) =>
    closureOf(item).receipt_missing).length;
  // 真正要人操作的卡永远置顶；保留原始顺序作为同优先级内的稳定顺序。
  // 过去提示在顶端、按钮却埋在历史记录中，用户会合理地认为按钮丢了。
  const orderedItems = items.map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftActionable = authorActionable(left.item)
        || overrideActionable(left.item) || routedDrafts.includes(left.item);
      const rightActionable = authorActionable(right.item)
        || overrideActionable(right.item) || routedDrafts.includes(right.item);
      if (leftActionable !== rightActionable) return rightActionable ? 1 : -1;
      const leftCurrent = currentReviewIds.has(left.item.id);
      const rightCurrent = currentReviewIds.has(right.item.id);
      if (leftCurrent !== rightCurrent) return rightCurrent ? 1 : -1;
      return left.index - right.index;
    }).map(({ item }) => item);
  const visibleItems = filter === "all" ? orderedItems
    : orderedItems.filter((item) => closureOf(item).bucket === filter);
  // 默认展开。"只在有草稿/待办时才展开"是它还嵌在侧栏里时的省地方策略;
  // 现在它是「批注与检视」弹层的正文,人点开弹层就是来看批注的,再让人
  // 多点一下标题才见内容,用户实锤"为啥默认折叠"。
  const [open, setOpen] = useState(true);
  const isPublishedStory = (item: Annotation) => overallStoryPublished && item.artifact === OVERALL_STORY_ARTIFACT;
  const actionFor = (item: Annotation) => submission?.[isPublishedStory(item) ? "story" : "ordinary"];
  const canSendItem = (item: Annotation) => !!actionFor(item)?.enabled;
  const sendableDrafts = drafts.filter(canSendItem);
  const canSend = sendableDrafts.length > 0;
  const overallDrafts = sendableDrafts.filter(isPublishedStory);
  const reviewScopeKey = (reviewReady ? "ready:" : "closed:")
    + reviewAnnotationIds.join("\u0000");

  useEffect(() => {
    if (drafts.length > 0 || actionableReviewCount > 0
        || missingReceiptCount > 0) {
      setOpen(true);
    }
  }, [drafts.length, actionableReviewCount, missingReceiptCount]);

  useEffect(() => {
    setOverrideArm(undefined);
  }, [taskId, reviewScopeKey]);

  useEffect(() => {
    if (!overrideArm) return;
    const timer = window.setTimeout(() => setOverrideArm(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [overrideArm]);

  useEffect(() => {
    if (!focus?.ids.length) return;
    setOpen(true);
    let secondFrame = 0;
    let clearTimer = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const wanted = new Set(focus.ids);
        const matches = [...(listRef.current
          ?.querySelectorAll<HTMLElement>("[data-annotation-id]") ?? [])]
          .filter((node) => wanted.has(node.dataset.annotationId ?? ""));
        if (!matches.length) return;
        matches.forEach((node) => node.classList.add("annot-panel-focus"));
        matches[0].scrollIntoView({ block: "center", behavior: "smooth" });
        matches[0].focus({ preventScroll: true });
        clearTimer = window.setTimeout(() => matches.forEach((node) =>
          node.classList.remove("annot-panel-focus")), 1800);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [focus?.request, filter]);

  if (!items.length) return null;
  const checkOf = (id: string) => checks.find((check) => check.id === id);

  async function send() {
    if (busy || !canOperate || !canSend || !drafts.length) return;
    setBusy(true);
    setError("");
    setSubmissionNotice("");
    try {
      {
        const groups = [overallDrafts, sendableDrafts.filter((item) => !isPublishedStory(item))];
        const notices: string[] = [];
        for (const group of groups) {
          if (!group.length) continue;
          const result = await sendAnnotations(taskId, group.map((item) => item.id));
          if (result.error) { setError(result.error); break; }
          notices.push(result.receipt ?? `已提交 ${result.sent?.length ?? group.length} 条意见，请查看逐条处理状态。`);
        }
        setSubmissionNotice(notices.join("；"));
      }
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "批注提交失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function mutateAnnotation(
    annotationId: string,
    operation: () => Promise<{ error?: string }>,
  ) {
    if (mutationBusy) return;
    setMutationBusy(annotationId);
    setError("");
    try {
      const result = await operation();
      if (result.error) setError(result.error);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationBusy("");
      setOverrideArm(undefined);
    }
  }

  async function requestAdminOverride(
    item: Annotation,
    action: AdminOverrideAction,
  ) {
    const access = closureOf(item);
    if (action === "drop"
      ? !access.can_override_drop : !access.can_override_verify) {
      setOverrideArm(undefined);
      setError("这条意见已不属于当前复检，管理员代办已取消；请刷新后再检查。");
      return;
    }
    const next = advanceAdminOverrideArm(overrideArm, item.id, action);
    setOverrideArm(next.arm);
    if (!next.execute) return;
    await mutateAnnotation(item.id, action === "drop"
      ? () => dropAnnotation(taskId, item.id)
      : () => judgeAnnotation(taskId, item.id, "verify", { revision: item.rework ?? 0 }));
  }

  async function submitOwnerReply(item: Annotation, retryText?: string) {
    const text = (retryText ?? ownerReply).trim();
    if (!text || mutationBusy) return;
    setMutationBusy(item.id);
    setError("");
    try {
      const result = await replyToAnnotation(taskId, item.id, text);
      if (result.error) setError(result.error);
      else {
        setReplyingId("");
        setOwnerReply("");
      }
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationBusy("");
    }
  }

  return (
    <details className="annot-panel" aria-label="批注" open={open}
             onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="annot-panel-head">
        <div>
          <span>工作台与 MR</span>
          <strong>检视批注</strong>
        </div>
        <div className="annot-panel-summary-side">
          <div className="annot-panel-counts">
            <span>{items.length} 条</span>
            {drafts.length > 0 && <em>{drafts.length} 条
              {taskStatus === "completed" ? "交付后记录" : "待处理"}</em>}
          </div>
          <i className="annot-panel-chevron" aria-hidden />
        </div>
      </summary>
      {reviewReady && authorActionableCount > 0 && (
        <div className="annot-panel-note review-ready" role="status">
          本轮有 {authorActionableCount} 条意见待你逐条处置。
          请核对最新代码与回执，再逐条确认处置结果；最终推送不能代替这些决定。
        </div>
      )}
      {reviewReady && missingReceiptCount > 0 && (
        <div className="annot-panel-note receipt-pending" role="alert">
          另有 {missingReceiptCount} 条意见的当前轮逐条回执尚未就绪；请等待 Agent 答复后再确认闭环。
          系统会保留这些意见并阻止推送；刷新后仍未恢复时，请查看执行现场中的回执诊断。
        </div>
      )}
      {ordinaryReviewCount > 0 && (
        <div className="annot-panel-note review-ready" role="status">
          请核对处理结果后逐条确认闭环，
          也可以要求继续调整。
        </div>
      )}
      {ownerReplyReviewCount > 0 && !closures.some((entry) => entry.owner_controlled) && (
        <div className="annot-panel-note review-ready" role="status">
          有 {ownerReplyReviewCount} 条意见已有答复，请核对后确认闭环，或退回待处理。
        </div>
      )}
      {overrideReviewCount > 0 && (
        <div className="annot-panel-note admin-override" role="note">
          当前复检有 {overrideReviewCount} 条他人意见仍待作者闭环。
          仅在作者不在场时使用管理员代办；第一次点击只会进入确认，
          必须再次点击才会执行，结果会显示实际管理员。
        </div>
      )}
      {actionableReviewCount > 0 && (
        <div className="annot-review-queue" role="heading" aria-level={3}>
          <div><strong>{routedDrafts.length ? "待我处理" : "待我确认"}</strong>
            <span>先逐条核对，再做整体交付决定</span></div>
          <em>{actionableReviewCount} 项</em>
        </div>
      )}
      {canOperate && sendableDrafts.length > 0 && taskStatus !== "canceled" && (
        <div className="tw-root my-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
          <div className="grid gap-1">
            <strong className="text-sm">{sendableDrafts.length} 条待提交</strong>
            {[...new Set(sendableDrafts.map(item => actionFor(item)?.hint))].map(hint =>
              <span key={hint} className="text-sm text-muted-foreground">{hint}</span>)}
          </div>
          <Button type="button" size="sm" disabled={busy || !canSend} onClick={() => void send()}>
            {busy ? "提交中…" : "提交修改意见"}
          </Button>
        </div>
      )}

      {drafts.some((item) => !isPublishedStory(item)) && taskStatus === "completed" && (
        <p className="annot-panel-note">
          任务已经交付；这些批注已保存在本任务档案中，不会自动触发修改。
          需要继续改代码时，请创建后续任务。
        </p>
      )}
      {drafts.length > 0 && taskStatus === "canceled" && (
        <p className="annot-panel-note">
          任务已由用户停止；已有批注仍保留，但不会再触发修改。
        </p>
      )}
      {!canOperate && items.some(item => item.status === "draft")
        && !["completed", "canceled"].includes(taskStatus) && (
        <p className="annot-panel-note">
          批注已保存，统一由任务责任人决定是否交给 Agent 处理。
        </p>
      )}
      {canOperate && drafts.length > 0 && !canSend
        && !["completed", "canceled"].includes(taskStatus) && (
        <p className="annot-panel-note">
          {submission ? [...new Set(drafts.map(item => actionFor(item)?.hint))].join("；")
            : "正在获取可提交状态，请稍后重试。"}
        </p>
      )}
      {submissionNotice && <p className="annot-panel-note" role="status">{submissionNotice}</p>}
      {error && <Alert variant="destructive" role="alert" className="mb-3">{error}</Alert>}

      {filter !== "all" && !visibleItems.length && items.length > 0 && (
        <p className="annot-panel-note">这一档下没有批注；切回“全部”看完整清单。</p>
      )}
      <ol className="annot-list" ref={listRef}>
        {visibleItems.map((item) => {
          const check = checkOf(item.id);
          const location = resolvedAnnotationRange(item, check);
          const archival = taskStatus === "completed"
            && !isPublishedStory(item) && item.status === "draft";
          const isAuthor = item.author === viewerUsername;
          const editing = editingId === item.id;
          const closure = closureOf(item);
          const verifyArmed = overrideArm?.annotationId === item.id
            && overrideArm.action === "verify";
          const authorCanJudge = !closure.owner_controlled && closure.can_verify;
          const actionable = closure.actionable;
          const progress = closure;
          return (
            <li key={item.id} data-annotation-id={item.id} tabIndex={-1}
                className={`annot-item ${progress.tone}${actionable
                  ? " actionable" : ""}`}>
              {/* 头一行只回答两件事:指着哪儿、现在什么状态。谁提的 / 去向 / 时间
                  搬进"意见"块的说话人行——用户 2026-09-06:"哪个是他的回复、哪个是
                  我的原文、现在状态是什么,很混乱"。 */}
              <div className="annot-item-head">
                <button type="button" className="annot-where"
                        onClick={() => onLocate?.(item)}
                        title={location ? `回到 ${item.file}:${location.line}` : "打开材料，核对原文位置"}>
                  {/* 需求原文是虚拟产物,内部名 __task_requirement__ 不该露给人
                      (2026-09-02 演示截图逮住)。 */}
                  <code>{item.file === TASK_REQUIREMENT_ARTIFACT
                    ? "需求原文" : shortPath(item.file)}:{location ? location.line : `原 ${item.line}`}{
                      location && location.lineEnd > location.line ? `–${location.lineEnd}` : ""}</code>
                </button>
                <span className={`annot-progress ${progress.tone}`}
                      title={progress.hint}>
                  {progress.text}
                </span>
              </div>
              {editing ? (
                <div className="annot-inline-editor">
                  <Textarea className="min-h-[132px] max-h-[70vh] resize-y bg-surface" value={editingNote} autoFocus rows={5}
                            aria-label="修改批注意见"
                            onChange={(event) => setEditingNote(event.target.value)} />
                  <div>
                    <span>{item.status === "draft"
                      ? archival
                        ? "保存后仍作为交付后记录保留。"
                        : "保存后仍在待提交清单中。"
                      : taskStatus === "completed"
                        ? "修改后会成为交付后记录，不会再次送给 Agent。"
                      : closure.needs_clarification
                        // 回答 Agent 的追问就是把答复写进意见正文:没有单独的
                        // 回复框(用户 2026-09-05:"没看到让我在哪回答这个问题")
                        ? "把答复写进意见正文里。保存后这条回到待提交，随下一次提交送给 Agent 重新处理。"
                        : "修改后会回到待提交，避免新内容被误认为已经送达。"}</span>
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => { setEditingId(""); setEditingNote(""); }}>
                      取消
                    </button>
                    <button type="button" className="primary"
                            disabled={!editingNote.trim() || !!mutationBusy}
                            onClick={async () => {
                              setMutationBusy(item.id);
                              setError("");
                              const result = await editAnnotation(
                                taskId, item.id, editingNote);
                              setMutationBusy("");
                              if (result.error) setError(result.error);
                              else { setEditingId(""); setEditingNote(""); }
                              onChanged();
                            }}>
                      {mutationBusy === item.id ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              ) : (
                // 左边这块原来是一段裸文字,右边 Agent 回应却是带标题的
                // 色块,看上去像"正文 vs 卡片"而不是"一问一答"。给它同样
                // 的块形和标题,明说这是检视意见原文,两边才对得起来。
                <div className="annot-note">
                  <div className="annot-speaker person">
                    <i aria-hidden>{initialOf(isAuthor ? "你" : personName(item.author))}</i>
                    <b>{isAuthor ? "你" : personName(item.author)}</b>
                    <span>提的意见 · {relativeTime(item.created_at)}</span>

                  </div>
                  <ReviewBody text={item.note || "（只记了原文，没另写一句）"} />
                  {item.images && item.images.length > 0 && (
                    <div className="annot-images" aria-label="批注附图">
                      {item.images.map((image) => (
                        <a key={image.path} href={annotationAssetUrl(taskId, image.path)}
                          target="_blank" rel="noreferrer" title={image.label ?? image.path}>
                          <img src={annotationAssetUrl(taskId, image.path)} alt={image.label ?? "批注附图"} loading="lazy" />
                        </a>
                      ))}
                    </div>
                  )}
                  {/* 圈的原文跟在意见下面、一行截断:它是"指着哪儿"的补充,整段留在
                      title 里,点位置也能直接回到那一行。 */}
                  {!item.external_review && (item.quote || item.anchor) && <blockquote
                    className={`annot-anchor${item.quote ? " has-quote" : ""}`}
                    title={item.quote ?? item.anchor}>
                    <span>圈的原文</span>{item.quote ?? item.anchor}
                  </blockquote>}
                  {/* 追问留档:作者已经补充过什么问题,人和 Agent 看到的是同一份历史。
                      在澄清卡上直接答的那种,连答复一起摆出来。 */}
                  {item.clarifications?.length ? <small className="annot-clarified">
                    {item.clarifications.at(-1)!.answer !== undefined
                      ? `Agent 曾问：${item.clarifications.at(-1)!.question} · ${
                        item.clarifications.at(-1)!.answered_by
                          ? `${personName(item.clarifications.at(-1)!.answered_by!)} 答复` : "答复"
                      }：${item.clarifications.at(-1)!.answer}`
                      : `已答复 Agent 的追问：${item.clarifications.at(-1)!.question}`}
                  </small> : null}
                </div>
              )}
              {item.response && (
                <div className={`annot-response outcome-${item.response.outcome}`}>
                  <div className="annot-speaker agent">
                    <i aria-hidden>A</i>
                    <b>Agent</b>
                    <span>的回复 · {relativeTime(item.response.responded_at)}</span>
                    <em>{item.response.outcome === "fixed"
                      ? "已处理"
                      : item.response.outcome === "not_fixed"
                        ? "没有修改"
                        : "需要你补充说明"}</em>
                  </div>
                  <p>{item.response.summary}</p>
                  {/* 老账目里可能有没带位置的 fixed 回执:如实标出,不装作有依据 */}
                  {item.response.outcome === "fixed" && !item.response.evidence.length && (
                    <small className="annot-no-evidence">Agent 没有给出改动位置</small>
                  )}
                  {(item.response.evidence.length > 0 || item.response.fixed_sha) && (
                    <small>{[
                      ...(item.response.evidence.length > 0
                        ? [`依据 ${item.response.evidence.join("；")}`] : []),
                      ...(item.response.fixed_sha
                        ? [`提交 ${item.response.fixed_sha.slice(0, 12)}`] : []),
                    ].join(" · ")}</small>
                  )}
                </div>
              )}
              {item.external_review && <div className="mt-2 flex items-center gap-3 text-sm text-muted-foreground">
                <span>来自 MR · 讨论 #{item.external_review.discussion_id} · 本地处理不代表远端已解决</span>
                {item.external_review.mr_url && /^https?:\/\//.test(item.external_review.mr_url) && <a className="rounded-md border border-border px-2 py-1 font-medium text-ink hover:bg-muted" href={item.external_review.mr_url} target="_blank" rel="noreferrer">打开 MR</a>}
              </div>}
              {item.agent_context?.revision === (item.rework ?? 0) && <p className="mt-2 text-sm text-muted-foreground">责任人补充：{item.agent_context!.text}</p>}
              {item.owner_reply && (
                <div className="annot-owner-reply">
                  <div className="annot-speaker owner">
                    <i aria-hidden>{initialOf(personName(item.owner_reply.author))}</i>
                    <b>{personName(item.owner_reply.author)}</b>
                    <span>责任人的答复 · {relativeTime(item.owner_reply.replied_at)}</span>
                  </div>
                  <p>{item.owner_reply.text}</p>
                </div>
              )}
              <div className="tw-root flex flex-wrap items-center gap-2 pt-3">
              {closure.can_edit && !item.external_review && !editing && (
                <Button type="button" size="sm" variant="ghost" disabled={!!mutationBusy}
                  onClick={() => { setEditingId(item.id); setEditingNote(item.note); }}>修改 / 补充</Button>
              )}
              {closure.owner_controlled && closure.can_route && !item.owner_reply && !item.resolution && !item.agent_assigned && (
                contextId === item.id ? <div className="w-full rounded-md border border-border bg-muted/30 p-3">
                  <Textarea rows={3} value={contextText} placeholder="补充你希望怎么改；保留检视原文，保存后统一批量交办"
                    onChange={event => setContextText(event.target.value)} />
                  <Button variant="ghost" size="sm" onClick={() => setContextId("")}>取消</Button>
                  <Button size="sm" disabled={!!mutationBusy} onClick={() => void mutateAnnotation(item.id, async () => {
                    const result = await supplementAnnotation(taskId, item.id, contextText);
                    if (!result.error) setContextId("");
                    return result;
                  })}>保存要求</Button>
                </div> : <Button variant="outline" size="sm" onClick={() => { setContextId(item.id); setContextText(item.agent_context?.text ?? ""); }}>补充修改要求</Button>
              )}
              {closure.owner_controlled && closure.can_route && !item.resolution && !item.owner_reply
                && (item.status === "draft" || item.sent_via === "owner_pending") && (
                replyingId === item.id ? <div className="annot-owner-reply-editor w-full rounded-md border border-border bg-muted/30 p-3">
                  <Textarea className="min-h-17 resize-y bg-surface" rows={3} autoFocus value={ownerReply} placeholder="写下处理说明"
                    onChange={(event) => setOwnerReply(event.target.value)} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setReplyingId(""); setOwnerReply(""); }}>取消</Button>
                  <Button type="button" size="sm" disabled={!ownerReply.trim() || !!mutationBusy}
                    onClick={() => void submitOwnerReply(item)}>{mutationBusy === item.id ? "保存中…" : "保存答复"}</Button>
                </div> : <Button type="button" size="sm" variant="outline" disabled={!!mutationBusy}
                  onClick={() => { setReplyingId(item.id); setOwnerReply(""); }}>自行答复</Button>
              )}
              {/* 已送出、但看的人此刻点不了:把"等谁、到哪步能点"写在卡上,
                  不藏在状态词的悬停提示里(用户 2026-09-05:"检视意见在哪里点
                  通过?没看到"——其实是等作者、等复检卡,卡上一个字没说)。 */}
              {item.status === "sent" && !actionable && !editing && closure.hint && (
                <p className="annot-next"><b>下一步</b>{closure.hint}</p>
              )}
              {item.resolution && <p className="annot-next"><b>责任人处置</b>{closure.hint}</p>}
              {closure.can_resolve && !editing && <OwnerResolution key={`${item.id}:${item.rework ?? 0}`}
                item={item} canVerify={closure.can_verify} busy={!!mutationBusy}
                onReopen={() => void mutateAnnotation(item.id, () => judgeAnnotation(taskId, item.id, "reopen", { revision: item.rework ?? 0 }))}
                onResolve={(outcome, reason) => void mutateAnnotation(item.id,
                  () => judgeAnnotation(taskId, item.id, "resolve", { revision: item.rework ?? 0, outcome, reason }))} />}
                {closure.can_delete && !editing && (
                  <Button type="button" size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" disabled={!!mutationBusy}
                    onClick={() => void mutateAnnotation(item.id, () => dropAnnotation(taskId, item.id))}>删除</Button>
                )}
              </div>
              <div className="annot-item-foot">
                <small>
                  {closure.delivery_text}
                  {item.sent_by && item.sent_by !== item.author
                    && ` · 由 ${personName(item.sent_by)} 原样转交`}
                  {item.edited_at && " · 已编辑"}
                  {/* 记忆条目是快照,不参与重锚定:原文以后变了也不追。 */}
                  {check && check.state !== "hit" && routeOf(item) !== "memory"
                    && ` · ${ANCHOR_TEXT[check.state]}`}
                </small>
                {onShowThread && item.status !== "draft" && (
                  <button type="button" className="annot-thread"
                          title="右栏只显示这条意见的处理记录:什么时候送给 Agent、Agent 怎么回的、谁确认或退回"
                          onClick={() => onShowThread(item.id)}>看处理记录</button>
                )}
                {closure.can_reopen && item.status === "verified" && (
                  <button type="button" className="ghost" disabled={!!mutationBusy} onClick={() => void mutateAnnotation(item.id,
                    () => judgeAnnotation(taskId, item.id, "reopen", { revision: item.rework ?? 0 }))}>重新处理</button>
                )}
                {/* 检视闭环的裁决:提过的意见不能停在"请你确认"没有下文。
                    通过=收口;返工=退回待提交,下一次提交再送给 AI。 */}
                {!closure.owner_controlled && item.status === "sent" && isAuthor && !editing
                  && authorCanJudge
                  && closure.needs_clarification && (
                  <span className="annot-verdict">
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => {
                              setEditingId(item.id);
                              setEditingNote(item.note);
                            }}>回答这个问题</button>
                  </span>
                )}
                {!closure.owner_controlled && item.status === "sent"
                  && (authorCanJudge || closure.can_override_verify) && !editing
                  && !closure.needs_clarification && (
                  <span className="annot-verdict">
                    {isAuthor && <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => void mutateAnnotation(item.id,
                              () => judgeAnnotation(taskId, item.id, "reopen", { revision: item.rework ?? 0 }))}>
                      {routeOf(item) === "owner_reply" ? "仍有疑问" : "仍需调整"}
                    </button>}
                    {isAuthor ? (
                      <button type="button" className="approve"
                              disabled={!!mutationBusy}
                              onClick={() => void mutateAnnotation(item.id,
                                () => judgeAnnotation(taskId, item.id, "verify", { revision: item.rework ?? 0 }))}>
                        {routeOf(item) === "owner_reply" ? "确认已解答" : "确认已修复"}
                      </button>
                    ) : (
                      <>
                        <button type="button" className="approve"
                                aria-pressed={verifyArmed}
                                title={verifyArmed
                                  ? `再次点击后，将由 ${personName(viewerUsername)} 代 ${personName(item.author)} 确认`
                                  : `先进入确认，再由 ${personName(viewerUsername)} 代 ${personName(item.author)} 确认`}
                                disabled={!!mutationBusy}
                                onClick={() => void requestAdminOverride(item, "verify")}>
                          {verifyArmed ? "再次点击确认代确认" : "管理员代确认"}
                        </button>
                        {verifyArmed && (
                          <button type="button" className="ghost"
                                  disabled={!!mutationBusy}
                                  onClick={() => setOverrideArm(undefined)}>
                            取消代办
                          </button>
                        )}
                      </>
                    )}
                  </span>
                )}
              </div>
              {/* 靶子变了要说清:意见可能已经过期,送过去轻则白烧一轮,
                  重则让它改回去。撤不撤是人的判断,这里只把事实摊开。 */}
              {item.status === "draft" && check?.state === "gone" && (
                <div className="annot-stale">
                  原位置内容已经删除{check.now ? `，当前位置内容为「${check.now}」` : ""}。
                  请确认这条批注是否仍然有效。
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* AI 收到批注后的原话。护栏要求它逐条回复"改了什么/为什么不改",
          那段话原来只躺在会话流里——不同意的批注在面板上就永远停在
          "已提交",人干等一个不会来的改动。这里原样摆出来,对应关系
          人自己看:从自由文本里猜"第几段对第几条",配错了更害人。 */}
      {reply && reply.texts.length > 0 && (
        <details className="annot-reply">
          <summary>送出之后 AI 说了什么({reply.texts.length} 段)</summary>
          <p className="annot-reply-note">
            原话未做逐条对应,请对照各条自行核对;不服就点那条的「返工」。
          </p>
          {reply.texts.map((text, at) => (
            <blockquote key={at}>{text}</blockquote>
          ))}
          {reply.truncated && <p className="annot-reply-note">(太长截断,完整内容见“执行现场”)</p>}
        </details>
      )}
    </details>
  );
}
