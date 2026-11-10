import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileSearch, LoaderCircle, X } from "lucide-react";
import type { DeliveryAnalysisRow } from "../../src/deliveryAnalyticsTypes";
import type { ImprovementPolicy, ImprovementReport } from "../../src/deliveryImprovementTypes";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";

async function readResponse(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "交付改进分析请求失败");
  return value;
}

/** 每轮交付独立展示；关闭后停止读取，不影响后台分析。 */
export function DeliveryImprovement({ row, children }: { row: DeliveryAnalysisRow; children: ReactNode }) {
  const endpoint = `/tasks/${encodeURIComponent(row.id)}/delivery-improvement?delivery_id=${encodeURIComponent(row.delivery_id ?? "initial")}`;
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ImprovementReport>({ state: row.improvement });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const force = useRef(false);
  useEffect(() => {
    if (row.improvement) setReport(previous => ({ ...previous, state: row.improvement }));
  }, [row.improvement]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async (method: "GET" | "POST"): Promise<ImprovementReport> =>
      readResponse(await fetch(endpoint, { method, signal: controller.signal }));
    async function update(first: boolean) {
      if (first) { setLoading(true); setError(""); }
      try {
        let next = await request(first && force.current ? "POST" : "GET");
        if (controller.signal.aborted) return;
        if (first && !force.current && !next.state && !next.markdown) next = await request("POST");
        if (controller.signal.aborted) return;
        force.current = false;
        setReport(previous => ({ ...next, markdown: next.markdown ?? previous.markdown }));
        setError("");
        if (next.state?.status === "queued" || next.state?.status === "running") timer = setTimeout(() => void update(false), 1500);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "交付改进分析请求失败");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void update(true);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, endpoint, attempt]);
  const running = report.state?.status === "queued" || report.state?.status === "running";
  const stale = report.state?.stale || (!!report.state?.head && !!row.metric?.head && report.state.head !== row.metric.head);
  const label = running ? "交付改进分析进行中，查看进度" : report.state?.available || report.markdown ? "查看交付改进报告" : "分析本次交付的改进机会";
  const retry = () => { force.current = true; setAttempt(value => value + 1); };
  return <>
    <div className="delivery-detail-heading">{children}<Button variant="ghost" size="icon-sm" title={label} aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {running ? <LoaderCircle size={17} className="animate-spin" /> : <FileSearch size={17} />}
    </Button></div>
    {open && <section aria-label={`${row.id} 交付改进报告`} className="my-4 min-w-0 rounded-lg border border-line bg-canvas p-4">
      <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">交付改进报告</h3><Button variant="ghost" size="icon-sm" title="收起报告" aria-label="收起报告" onClick={() => setOpen(false)}><X size={16} /></Button></div>
      {(loading || running) && <p role="status" className="mb-3 text-sm text-muted-foreground">{loading ? "正在读取分析状态…" : report.state?.status === "queued" ? "已排队，等待分析；可关闭此处稍后查看。" : "正在核对交付证据并生成报告；可关闭此处稍后查看。"}</p>}
      {stale && <p className="delivery-note">此报告对应较早的交付版本，请结合报告中的版本阅读。</p>}
      {report.state?.status === "failed" && <p role="alert" className="delivery-error">本次分析失败：{report.state.message ?? "请重试"}。{report.markdown ? "下方保留上一次报告。" : ""}</p>}
      {error && <p role="alert" className="delivery-error">{error}</p>}
      {report.markdown && <div className="min-w-0 overflow-x-auto"><Markdown text={report.markdown.replace(/\(analysis:\/\/evidence\/([a-f0-9]{64})\)/g,
        `(${endpoint.replace("?", "/evidence?")}&ref=$1)`)} /></div>}
      {!loading && !running && <div className="mt-3 flex items-center gap-3"><Button size="sm" variant="outline" onClick={retry}>{report.state?.status === "failed" || error ? "重试分析" : stale ? "分析当前版本" : "重新分析"}</Button>{report.state?.finished_at && <small className="text-muted-foreground">{new Date(report.state.finished_at).toLocaleString("zh-CN")}</small>}</div>}
    </section>}
  </>;
}

export function ImprovementPolicyControl({ policy, onSaved }: { policy: ImprovementPolicy & { can_configure?: boolean }; onSaved: (policy: ImprovementPolicy) => void }) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [threshold, setThreshold] = useState(String(policy.threshold_percent));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!policy.can_configure) return null;
  async function save() {
    const value = Number(threshold);
    if (!threshold.trim() || !Number.isFinite(value) || value < 0 || value > 100) { setError("阈值须为 0～100 的数字"); return; }
    setBusy(true); setError("");
    try {
      const result = await readResponse(await fetch("/delivery-analytics/improvement-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, threshold_percent: value }) }));
      onSaved(result.improvement_policy ?? result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <details className="delivery-method"><summary>自动交付分析</summary><div className="flex flex-wrap items-center gap-3 py-3 text-sm">
    <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />自动分析新完成的交付</label>
    <label className="flex items-center gap-2">分析阈值<input className="w-20 rounded border border-line bg-surface px-2 py-1" type="number" min="0" max="100" aria-label="自动分析阈值" value={threshold} onChange={event => setThreshold(event.target.value)} />%</label>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存"}</Button>
  </div><p>100% 表示分析全部新完成的交付；低于 100% 时，仅分析首次实现占比低于阈值的交付。历史任务仍可手动分析，开关不会批量补跑历史任务。</p>{error && <p role="alert" className="delivery-error">{error}</p>}</details>;
}
