import { useCallback, useEffect, useState } from "react";
import { getIssueReviews, sendIssueReviews, updateIssueReview, dropIssueReview, type IssueReview } from "../api";
import { confirmDialog } from "../ConfirmDialog";
import { ReviewBody } from "../ReviewBody";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { cn } from "cn";

/**
 * MR 检视批注(2026-09-17 收编为「MR 检视」页签,ADR-0027 修订):
 * 原是页签容器上方的整卡面板,挤占工作区首屏——收编进第六签后按任务侧
 * 检视画布的密度压缩(紧凑卡+胶囊两档+去分页),信息量与占面对齐
 * FeedbackList(机器门禁告警卡)同款版式。词表口径:这里全是 MR 检视
 * 意见(检视代码),与分析报告的「检视意见」两分,不混称(CONTEXT.md)。
 */

/** 已处理判定:有处理结果、有自行答复或已核验 = 本地已闭环;
 * 待判断与处理中 = !done(含已交办待核对结果的)。 */
export function externalReviewDone(item: IssueReview): boolean {
  return !!item.resolution || !!item.owner_reply || item.status === "verified";
}

/** 批注归属仓:external_review.scope 由同步侧拼成 `仓名:iid或链接`
 * (issueFlow/service 同步 MR 讨论处),取首个冒号前即仓名;旧账缺席时
 * 落「未知仓」兜底,分组不崩。多仓会话的批注天生分属不同 MR。 */
export function reviewRepo(item: IssueReview): string {
  const scope = item.external_review?.scope ?? "";
  const cut = scope.indexOf(":");
  return cut > 0 ? scope.slice(0, cut) : "未知仓";
}

/** 检视批注轮询(5s 可见轮询)提升到会话层:「MR 检视」页签的在场
 * (有批注才现身)与脉冲点(有待判断)靠这份账,页签没开时也得轮。
 * 断连单独记态、下一拍自愈即清;不混入操作回执,也不给浏览器原文——
 * 「TypeError: Failed to fetch」是噪声不是信息。 */
export function useIssueReviews(id: string): {
  items: IssueReview[];
  pollError: string;
  refresh: () => Promise<void>;
} {
  const [items, setItems] = useState<IssueReview[]>([]);
  const [pollError, setPollError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const result = await getIssueReviews(id);
      setItems(result.reviews.filter(item => item.external_review));
      setPollError("");
    } catch {
      setPollError("检视批注暂时读不到，稍后自动重试。");
    }
  }, [id]);
  useEffect(() => {
    let alive = true;
    // 换会话先清账:SessionView 不按 id 重挂,旧会的批注不能串到新会闪现。
    setItems([]); setPollError("");
    const guarded = () => { if (alive) void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) guarded(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refresh]);
  return { items, pollError, refresh };
}

/** 两档胶囊(任务侧检视画布同款):选中墨底,计数徽标随档。 */
const REVIEW_PILL = "h-auto flex-none gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium";
const REVIEW_PILL_COUNT = "inline-grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 font-mono text-[11px] not-italic tabular-nums";
/** 紧凑操作钮:卡内一行多枚,压掉默认尺寸的占面。 */
const REVIEW_ACTION = "h-6 px-1.5 text-xs";

export function IssueExternalReviewPanel({ issueId, items, pollError, refresh, canOperate }: {
  issueId: string;
  items: IssueReview[];
  pollError: string;
  refresh: () => Promise<void>;
  canOperate: boolean;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; mode: "context" | "reply"; text: string; resolveRemote: boolean }>();
  const [closed, setClosed] = useState(false);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await action(); setEditing(undefined); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const done = externalReviewDone;
  const pending = items.filter(item => !done(item) && item.status === "draft" && !item.agent_assigned);
  const doneCount = items.filter(done).length;
  const shown = items.filter(item => done(item) === closed);
  // 按仓分组(多仓流程,2026-09-18 走查):保持首次出现序,组内维持
  // 原排序;本签条目全带 external_review,仓信息齐,旧账落「未知仓」。
  const repoGroups: Array<[string, IssueReview[]]> = [];
  for (const item of shown) {
    const repo = reviewRepo(item);
    const bucket = repoGroups.find(([name]) => name === repo);
    if (bucket) bucket[1].push(item);
    else repoGroups.push([repo, [item]]);
  }
  if (!items.length) {
    return <p className="m-0 px-1 py-6 text-center text-[13px] text-muted-foreground">还没有 MR 检视批注。</p>;
  }
  return <section className="grid gap-2.5" aria-label="MR 检视批注">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => setClosed(false)}
          className={cn(REVIEW_PILL,
            !closed ? "border-ink bg-accent-soft text-ink hover:text-ink" : "border-line text-muted-foreground")}>
          待判断与处理中<i className={REVIEW_PILL_COUNT}>{items.length - doneCount}</i>
        </button>
        <button type="button" onClick={() => setClosed(true)}
          className={cn(REVIEW_PILL,
            closed ? "border-ink bg-accent-soft text-ink hover:text-ink" : "border-line text-muted-foreground")}>
          本地已闭环<i className={REVIEW_PILL_COUNT}>{doneCount}</i>
        </button>
      </div>
      {canOperate && <Button size="sm" disabled={busy || !pending.length} onClick={() => void run(async () => {
        const result = await sendIssueReviews(issueId, pending.map(item => item.id));
        setMessage(result.stage_note || "已批量交办");
      })}>提交 {pending.length} 条修改意见</Button>}
    </div>
    <p className="m-0 text-xs leading-relaxed text-muted-foreground">责任人先判断：Agent处理连同补充要求批量交办；自行答复可勾选同时在 CodeHub 标已解决；忽略也会代点已解决。远端以 CodeHub 为准。</p>
    {(message || pollError) && <p role="status" className="m-0 text-xs text-muted-foreground">{message || pollError}</p>}
    {!shown.length && <p className="m-0 px-1 py-3 text-[13px] text-muted-foreground">这一档下没有批注。</p>}
    {repoGroups.map(([repo, repoItems]) => <div key={repo} className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-bold tracking-wide text-ink">{repo}</span>
        <i className="rounded-full bg-surface-3 px-2 py-0.5 not-italic text-xs text-muted-foreground">{repoItems.length} 条</i>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {repoItems.map(item => {
          const status = done(item) ? { label: "本地已处理", tone: "neutral" as const }
            : item.agent_assigned ? { label: "已交办 · 待核对结果", tone: "info" as const }
            : { label: "待你判断", tone: "warning" as const };
          return <li key={item.id} className="grid gap-1.5 rounded-lg bg-surface-2 p-2.5 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="font-mono text-xs text-muted-foreground">{item.author} · {item.file}{item.line ? `:${item.line}` : ""}</code>
              <Badge variant={status.tone}>{status.label}</Badge>
            </div>
            <ReviewBody text={item.note} />
            {item.agent_context && <p className="m-0 whitespace-pre-wrap border-l-2 border-l-line-strong pl-2.5 text-xs text-muted-foreground">责任人补充:{item.agent_context.text}</p>}
            {item.owner_reply && <p className="m-0 whitespace-pre-wrap border-l-2 border-l-line-strong pl-2.5 text-xs text-muted-foreground">自行答复:{item.owner_reply.text}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              {item.external_review?.mr_url && /^https?:\/\//.test(item.external_review.mr_url)
                && <a className="text-xs text-ink underline underline-offset-2 hover:text-ink-hover"
                  href={item.external_review.mr_url} target="_blank" rel="noreferrer">打开 MR</a>}
              {canOperate && !done(item) && !item.agent_assigned && <>
                <Button size="sm" variant="ghost" className={REVIEW_ACTION}
                  onClick={() => setEditing({ id: item.id, mode: "context", text: item.agent_context?.text ?? "", resolveRemote: false })}>Agent处理</Button>
                <Button size="sm" variant="ghost" className={REVIEW_ACTION}
                  onClick={() => setEditing({ id: item.id, mode: "reply", text: "", resolveRemote: false })}>自行答复</Button>
                <Button size="sm" variant="ghost" className={REVIEW_ACTION} disabled={busy}
                  title="本地忽略并留痕，同时在 CodeHub 把这条讨论标记为已解决"
                  onClick={async () => {
                    // 忽略带外向副作用(dropReview 会代点 CodeHub 已解决,
                    // 收不回),且与相邻小按钮易误触(有用户误点反馈)——
                    // 走全站 confirmDialog 二次确认(spec #52)。
                    if (!await confirmDialog({
                      title: "忽略这条检视批注？",
                      message: "忽略会在本地留痕，并同时在 CodeHub 把这条讨论标记为已解决；误点后需到 CodeHub 重新打开讨论才能恢复。",
                      confirmLabel: "忽略",
                      danger: true,
                    })) return;
                    await run(() => dropIssueReview(issueId, item.id));
                  }}>忽略</Button>
              </>}
            </div>
            {editing?.id === item.id && <div className="grid gap-1.5">
              <Textarea rows={2} className="min-h-0 bg-surface text-[13px]" value={editing.text}
                onChange={event => setEditing({ ...editing, text: event.target.value })}
                placeholder={editing.mode === "context" ? "保存要求后，再统一批量交办；不会自动启动 Agent" : "写下你的处理说明，不会发到远端 MR"} />
              {editing.mode === "reply" && <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" className="accent-primary" checked={editing.resolveRemote}
                  onChange={event => setEditing({ ...editing, resolveRemote: event.target.checked })} />
                同时在 CodeHub 把这条讨论标记为已解决
              </label>}
              <div className="flex gap-1.5">
                <Button size="sm" className={cn(REVIEW_ACTION, "px-2")} disabled={busy || (editing.mode === "reply" && !editing.text.trim())}
                  onClick={() => void run(() => updateIssueReview(issueId, item.id, editing.mode === "reply"
                    ? { reply: editing.text, ...(editing.resolveRemote ? { resolve_remote: true } : {}) }
                    : { [editing.mode]: editing.text }))}>保存</Button>
                <Button size="sm" variant="ghost" className={cn(REVIEW_ACTION, "px-2")} onClick={() => setEditing(undefined)}>取消</Button>
              </div>
            </div>}
          </li>;
        })}
      </ol>
    </div>)}
  </section>;
}
