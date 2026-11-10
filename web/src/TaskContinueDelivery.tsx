import { finalMrContinuationBlock } from "../../src/finalMrContinuationPolicy";
import { isMainTaskDelivery } from "../../src/requirementDecisionContract";
import { useState } from "react";
import { continueTaskDelivery, type TaskSummary } from "./api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** 完成页上的输入入口；打开输入框不改变任务，也不启动任何执行。 */
export function TaskContinueDelivery({ task, canOperate, onChanged }: {
  task: TaskSummary; canOperate: boolean; onChanged: () => void;
}) {
  const pending = !!task.continuation && task.continuation.state !== "active";
  const eligible = task.status === "completed" && !task.requirement_analysis_requested
    && (!task.requirement_graph || !!task.parent_task_id || isMainTaskDelivery(task))
    && (pending || ["merged", "已合入"].includes(task.delivery?.mr_state ?? ""));
  const blocked = eligible ? finalMrContinuationBlock(task) : undefined;
  const finalTarget = eligible && !blocked ? task.delivery?.final_mr?.target_branch : undefined;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true); setError("");
    try {
      await continueTaskDelivery(task.id, pending ? task.continuation!.text : text,
        pending ? task.continuation!.id : requestId);
      setOpen(false); setText(""); setRequestId(crypto.randomUUID());
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "继续修改失败，请重试");
      onChanged();
    } finally { setBusy(false); }
  }
  if (!eligible && !task.delivery_history?.length) return null;
  return <section className="flex-none border-b border-border px-(--ws-gutter) py-3" aria-label="继续修改与交付历史">
    {blocked && <p className="m-0 text-sm leading-relaxed text-text">{blocked}</p>}
    {finalTarget && <p className="m-0 mb-2 text-sm text-text">下一轮将从 <code className="break-all">{finalTarget}</code> 分支的最新版本开始。{!canOperate && "由任务责任人发起。"}</p>}
    {eligible && !blocked && canOperate && <div className="grid gap-2">
      {!open && !pending ? <Button className="w-fit" onClick={() => setOpen(true)}>继续修改</Button> : <>
        <label htmlFor={`continue-${task.id}`} className="text-sm font-medium">这次需要修改什么？</label>
        <Textarea id={`continue-${task.id}`} value={pending ? task.continuation!.text : text}
          onChange={event => setText(event.target.value)} maxLength={12000} rows={3}
          disabled={busy || pending} placeholder="描述验证发现的问题，或需要继续修改的代码、测试和文档。" />
        <p className="m-0 text-xs text-muted-foreground">{finalTarget
          ? <>平台会重建云端的原工作分支，放弃云端工作区未提交的代码修改，保留交付记录。如果远端仍有同名工作分支，平台会停止准备。你可以从 <code className="break-all">{finalTarget}</code> 新建任务继续开发。</>
          : "提交后从最新基准重建同名分支，放弃上一轮残留修改；保留原目录和不冲突的构建缓存。之前的交付记录会留存。"}</p>
        <div className="flex items-center gap-2">
          <Button disabled={busy || task.continuation?.state === "preparing" || (!pending && !text.trim())}
            onClick={() => void submit()}>{busy || task.continuation?.state === "preparing" ? "正在准备…" : pending ? "重试继续修改" : "发送并开始修改"}</Button>
          {!pending && <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>取消</Button>}
        </div>
      </>}
      {(error || (pending && task.continuation?.error)) && <p role="alert" className="m-0 text-sm text-destructive">{error || task.continuation?.error}</p>}
    </div>}
    {!!task.delivery_history?.length && <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">此前 {task.delivery_history.length} 次交付记录</summary>
      <ul className="my-2 grid list-none gap-2 p-0">
        {task.delivery_history.map((item, index) => {
          const mrUrl = item.delivery?.final_mr?.url ?? item.delivery?.mr_url;
          return <li key={item.id} className="flex flex-wrap items-center gap-3">
            <span>第 {index + 1} 次 · {new Date(item.completed_at).toLocaleString("zh-CN")} · 已合入</span>
            {mrUrl && /^https?:\/\//.test(mrUrl) && <a className="underline" href={mrUrl} target="_blank" rel="noreferrer">{item.delivery?.final_mr ? "查看最终 MR" : "查看 MR"}</a>}
            <a className="underline" href={`/tasks/${encodeURIComponent(task.id)}/delivery-history/${encodeURIComponent(item.archive)}`}>下载历史记录</a>
          </li>;
        })}
      </ul>
    </details>}
  </section>;
}
