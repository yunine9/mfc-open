import { useState } from "react";
import { generateDeliveryReport, type TaskSummary } from "./api";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";

export function DeliveryReportMenu({ task, available, canOperate, onOpen, onChanged }: {
  task: TaskSummary; available: boolean; canOperate: boolean; onOpen: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const report = task.delivery_report;
  const permissionHint = canOperate ? "" : "只有任务责任人或管理员可以生成或更新交付报告";
  const message = error || permissionHint || report?.message;
  if (!available && !report && !task.delivery?.mr_url) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />} aria-label="交付报告操作">
      报告 <span aria-hidden>⌄</span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60">
      {available && <DropdownMenuItem onClick={onOpen}>查看交付报告</DropdownMenuItem>}
      {/* 生成条件由接口核对并返回原因，避免旧任务因前端重复判断而无声丢失入口。 */}
      <DropdownMenuItem closeOnClick={false} disabled={!canOperate || busy || report?.status === "running"} onClick={async () => {
        setBusy(true); setError("");
        try { await generateDeliveryReport(task.id); onChanged(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      }}>{busy || report?.status === "running" ? "生成中…" : report?.status === "failed" ? "重试生成" : available || report?.available ? "更新报告" : "生成报告"}</DropdownMenuItem>
      {message && <p role={error || (!permissionHint && report?.status === "failed") ? "alert" : "status"}
        className="m-0 px-1.5 py-2 text-xs leading-relaxed text-muted-foreground break-words">{message}</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
