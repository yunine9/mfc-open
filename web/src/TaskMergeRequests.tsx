import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { linkFinalMr, type TaskSummary } from "./api";

export function TaskMergeRequests({ task, canOperate, onChanged }: {
  task: TaskSummary; canOperate: boolean; onChanged?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initial = task.delivery?.initial_mr?.url || task.delivery?.mr_url;
  const final = task.delivery?.final_mr;
  const correction = task.ticket_correction;
  const analysisTask = !task.parent_task_id && (task.requirement_analysis_requested || (task.repositories?.length ?? 0) > 1);
  const canLink = canOperate && task.origin !== "issue" && !analysisTask && final?.state !== "merged"
    && !["completed", "canceled", "coordinating"].includes(task.status)
    && (!correction || correction.state === "completed" || correction.cleanup_only)
    && (!task.continuation || task.continuation.state === "active");

  async function submit() {
    setBusy(true); setError("");
    try {
      await linkFinalMr(task.id, url.trim());
      setEditing(false);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "关联失败，请检查链接后重试");
    } finally { setBusy(false); }
  }
  return <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]">
    <dt className="pt-[3px] text-xs leading-[1.6] text-muted-foreground">合入请求</dt>
    <dd className="m-0 grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {!initial && !final && !canLink && <span>尚未记录合入请求</span>}
        {initial && <Button variant="outline" size="sm" render={<a href={initial} target="_blank" rel="noreferrer" />}>
          初版 MR{!final && task.delivery?.mr_state ? ` · ${task.delivery.mr_state}` : ""} <ExternalLink aria-hidden /></Button>}
        {final && <Button variant="outline" size="sm" render={<a href={final.url} target="_blank" rel="noreferrer" />}>
          最终 MR · {{ opened: "待合入", closed: "已关闭", merged: "已合入" }[final.state]} <ExternalLink aria-hidden /></Button>}
        {final?.state === "merged" && <a className="inline-flex items-center gap-1 px-1 text-sm text-ink underline-offset-2 hover:underline"
          href={`/?${new URLSearchParams({ deliveryAnalysis: "1", deliveryTask: task.id })}`} target="_blank" rel="noreferrer">
          {initial ? "查看两版代码差异" : "查看交付分析"} <ExternalLink size={14} aria-hidden /></a>}
        {canLink && !editing && <Button variant="link" size="sm" onClick={() => {
          setError(""); setUrl(final?.url ?? ""); setEditing(true);
        }}>{final ? "更换最终 MR" : "关联最终 MR"}</Button>}
      </div>
      {canLink && editing && <form className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="grid gap-1.5 text-sm font-medium">最终 MR 链接
          <Input type="url" required autoFocus maxLength={2048} value={url} disabled={busy}
            onChange={event => setUrl(event.target.value)} placeholder="粘贴本仓库的合入请求链接" /></label>
        {error && <p className="m-0 text-sm text-danger" role="alert">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !url.trim()}
            title={final ? undefined : "关联后，本轮无法切回平台改码"}>
            {busy ? "正在关联…" : final ? "保存更换" : "关联并切换为只读跟踪"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>取消</Button>
        </div>
      </form>}
    </dd>
  </div>;
}
