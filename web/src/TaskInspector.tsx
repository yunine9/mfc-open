import { useState } from "react";
import { Input } from "@/components/ui/input";
import { correctTaskTicket, cancelTaskTicketCorrection } from "./api";
import { TaskMergeRequests } from "./TaskMergeRequests";
import { PersonName } from "./People";
import { statusText, type TaskSummary } from "./api";
import { formatLocalDateTime } from "./time";
import { ExecutionPanel, TaskTimeline } from "./TaskCard";
import { TokenUsage } from "./TokenUsage";
import { WorkflowProfileCard } from "./WorkflowProfileCard";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";
import { MrParticipantsNotice } from "./MrParticipantsNotice";

export type TaskInspectorKind = "details" | "usage" | "workflow" | "logs" | "timing";
const titles: Record<TaskInspectorKind, string> = {
  details: "任务详情",
  usage: "模型用量", workflow: "执行方案",
  logs: "执行日志", timing: "耗时分析",
};

/** 任务详情及其子页共用居中 Dialog，保留焦点管理与 Esc 关闭。 */
export function TaskInspector({ task, kind, onClose, onInspect, onOpenProcess, canOperate, onChanged }: {
  canOperate?: boolean; onChanged?: () => void;
  task: TaskSummary; kind: TaskInspectorKind; onClose: () => void;
  onInspect: (kind: TaskInspectorKind) => void; onOpenProcess: () => void;
}) {
  const [editingTicket, setEditingTicket] = useState(false);
  const [ticket, setTicket] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const correction = task.ticket_correction;
  const submit = async (nextTicket = ticket, nextTitle = title) => {
    setSaving(true); setError("");
    try { await correctTaskTicket(task.id, nextTicket, nextTitle); setEditingTicket(false); onChanged?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const dtc = "text-xs leading-[1.6] text-muted-foreground";
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className={`task-inspector inspector-${kind} tw-root flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[800px]`}>
      <DialogHeader className="flex flex-row items-start justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          {(kind === "usage" || kind === "workflow") && <Button type="button"
            variant="outline" size="sm"
            className="mb-3 w-fit"
            onClick={() => onInspect("details")}>← 返回任务详情</Button>}
          <small className="block font-mono text-xs text-muted-foreground">{task.ticket || task.id}</small>
          <DialogTitle className="mt-1 text-lg">{titles[kind]}</DialogTitle>
        </div>
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" />}>
          <XIcon />
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {kind === "details" && <div>
          <h3 className="m-0 mb-5 text-lg leading-[1.6] [overflow-wrap:anywhere]">{task.title ?? task.requirement}</h3>
          <dl className="m-0 mb-5 grid grid-cols-3 gap-x-6 gap-y-4">
            <div><dt className={dtc}>负责人</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]"><PersonName account={task.luban_account} /></dd></div>
            <div><dt className={dtc}>任务状态</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{statusText(task)}</dd></div>
            <div><dt className={dtc}>任务编号</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]"><code>{task.id}</code></dd></div>
            <div><dt className={dtc}>创建时间</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.created_at, { year: true })}</dd></div>
            {task.updated_at && <div><dt className={dtc}>最近更新</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.updated_at, { year: true })}</dd></div>}
            {task.completed_at && <div><dt className={dtc}>完成时间</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.completed_at, { year: true })}</dd></div>}
          </dl>
          <section className="mb-5 rounded-lg border border-line p-4" aria-label="AR 单号">
            <div className="flex items-center justify-between gap-4"><div><span className="mr-3 text-muted-foreground">AR 单号</span><code>{task.ticket || "未填写"}</code></div>
              {canOperate && !task.delivery?.final_mr && !["completed", "canceled", "coordinating"].includes(task.status) && (!correction || correction.state === "completed") &&
                <Button variant="outline" size="sm" onClick={() => { setEditingTicket(!editingTicket); setError(""); }}>纠正单号</Button>}
            </div>
            {editingTicket && <form className="mt-4 grid gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
              <label className="grid gap-2 text-sm">正确的 AR 单号<Input value={ticket} onChange={event => setTicket(event.target.value)} placeholder="REQ…" required /></label>
              <label className="grid gap-2 text-sm">AR 准确描述<Input value={title} onChange={event => setTitle(event.target.value)} placeholder="从 AR 单复制，将用作新 MR 的标题" required /></label>
              <p className="m-0 text-sm text-muted-foreground">同步修改单号、分支和提交说明，保留已有验证与检视。已有 MR 时创建新 MR，成功后关闭旧 MR、删除旧远端分支；未推送时只修改本地。</p>
              <div className="flex gap-2"><Button type="submit" disabled={saving}>{saving ? "正在提交…" : "纠正单号"}</Button><Button type="button" variant="ghost" onClick={() => setEditingTicket(false)}>取消</Button></div>
            </form>}
            {correction && <div className="mt-3 text-sm" role="status"><p>{correction.old_ticket} → {correction.ticket} · {correction.message}</p>
              {canOperate && correction.state === "failed" && <Button variant="outline" size="sm" disabled={saving}
                onClick={() => void submit(correction.ticket, correction.title)}>继续重试</Button>}
              {canOperate && correction.state === "failed" && correction.can_cancel && <Button variant="ghost" size="sm" disabled={saving}
                onClick={async () => { setSaving(true); try { await cancelTaskTicketCorrection(task.id); onChanged?.(); }
                  catch (cause) { setError(String(cause)); } finally { setSaving(false); } }}>撤销本次纠正</Button>}
            </div>}
            {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
          </section>
          <section className="border-t border-line py-4"><h3 className="m-0 mb-3 text-sm">进度与交付</h3>
            <dl className="m-0 grid gap-3.5">
              <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>当前步骤</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.progress?.step || task.detail || "暂无步骤记录"}</dd></div>
              {task.progress?.milestone && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>子任务里程碑</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.progress.milestone.title} · {task.progress.milestone.event}
                {task.progress.milestone.reason && ` · ${task.progress.milestone.reason}`}</dd></div>}
              <TaskMergeRequests key={task.id} task={task} canOperate={!!canOperate} onChanged={onChanged} />
              {task.delivery?.pipeline && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>{task.delivery?.final_mr ? "初版流水线" : "流水线"}</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.delivery.pipeline}</dd></div>}
              {task.delivery?.mr_participants && task.delivery.mr_participants.status !== "failed" && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={dtc}>{task.delivery?.final_mr ? "初版 MR 人员" : "MR 人员"}</dt><dd className="m-0">
                <MrParticipantsNotice result={task.delivery.mr_participants} />
              </dd></div>}
              {task.delivery?.loop?.failure && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>流水线失败原文</dt><dd className="m-0 whitespace-pre-wrap font-mono text-xs leading-[1.8]">{task.delivery.loop.failure}</dd></div>}
              {task.workspace_reclaimed_at && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>现场回收</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.workspace_reclaimed_at, { year: true })}
                <p className="mt-1 text-xs text-muted-foreground">需求与交付文档、过程记录和批注仍可查看。工作区中的代码文件已回收。</p></dd></div>}
            </dl>
            <Button type="button" variant="outline" size="sm"
              className="mt-4 w-fit" onClick={onOpenProcess}>查看工作过程 →</Button>
          </section>
          <nav className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2" aria-label="任务执行信息">
            <Button type="button" variant="outline"
              className="h-auto w-full justify-between gap-4 whitespace-normal px-4 py-3 text-left"
              onClick={() => onInspect("usage")}><span>模型用量{task.token_usage && ` · ${task.token_usage.total_tokens.toLocaleString()} Token`}</span><i className="not-italic text-ink" aria-hidden>→</i></Button>
            <Button type="button" variant="outline"
              className="h-auto w-full justify-between gap-4 whitespace-normal px-4 py-3 text-left"
              onClick={() => onInspect("workflow")}>执行方案<i className="not-italic text-ink" aria-hidden>→</i></Button>
          </nav>
        </div>}
        {kind === "logs" && <ExecutionPanel task={task} defaultOpen />}
        {kind === "timing" && <><p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground">按已记录的事件估算历史耗时；任务当前状态以工作台为准。</p><TaskTimeline taskId={task.id} defaultOpen /></>}
        {kind === "usage" && (task.token_usage ? <TokenUsage usage={task.token_usage} placement="detail" />
          : <p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground">模型提供方暂未返回用量，不能据此认为消耗为零。</p>)}
        {kind === "workflow" && <>
          {task.workflow_profile ? <WorkflowProfileCard profile={task.workflow_profile} warning={task.workflow_profile_warning} />
            : <p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground">本任务没有记录执行方案。</p>}
          {(task.execution_plan_alerts ?? []).map((line, index) => <p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground" key={index}>{line}</p>)}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}
