import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DeliveryAnalysisRow, MrComparisonDetail } from "../../src/deliveryAnalyticsTypes";
import { getFinalMrComparison } from "./api";

function Patch({ title, text, empty }: { title: string; text?: string; empty: string }) {
  return <section aria-label={title} className="min-w-0 overflow-hidden rounded-md border border-line">
    <div className="bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-text-strong">{title}</div>
    {text ? <pre className="m-0 max-h-56 overflow-auto px-2.5 py-2 text-xs leading-relaxed" tabIndex={0} aria-label={title + "代码"}>
      {text.split("\n").map((line, index) => <span key={index} className={
        line.startsWith("@@") ? "text-faint" : line.startsWith("+") ? "text-success" : line.startsWith("-") ? "text-danger" : "text-text"
      }>{line}{"\n"}</span>)}
    </pre> : <p className="m-0 px-2.5 py-2 text-xs text-muted-foreground">{empty}</p>}
  </section>;
}

export function FinalMrComparison({ row, expandFirst = false }: { row: DeliveryAnalysisRow; expandFirst?: boolean }) {
  if (!row.mr_comparison) return null;
  const version = JSON.stringify([row.id, row.delivery_id, row.mr_url, row.mr_comparison.method, row.mr_comparison.reference, row.mr_comparison.initial_head, row.mr_comparison.final_head]);
  return <ComparisonContent key={version} row={row} summary={row.mr_comparison} expandFirst={expandFirst} />;
}

function ComparisonContent({ row, summary, expandFirst }: {
  row: DeliveryAnalysisRow; summary: NonNullable<DeliveryAnalysisRow["mr_comparison"]>; expandFirst: boolean;
}) {
  const files = (summary.files ?? []).filter(file => file.changed);
  const [chosenPath, setPath] = useState<string>();
  const path = chosenPath ?? (expandFirst ? files[0]?.path ?? "" : "");
  const [detail, setDetail] = useState<MrComparisonDetail>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const open = !!path;
  const generation = row.delivery_id ?? "initial";
  useEffect(() => {
    if (!open || detail) return;
    const controller = new AbortController();
    setError("");
    void getFinalMrComparison(row.id, generation, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取代码差异");
      });
    return () => controller.abort();
  }, [open, detail, row.id, generation, retry]);

  const selected = detail?.files.find(file => file.path === path);
  const finalOnly = summary.method === "final" || (summary.method === "unavailable" && !row.initial_mr_url);
  const pushed = summary.reference === "platform_push";
  const before = summary.reference === "local_snapshot" ? "本地快照" : pushed ? "平台已推送版本" : "初版";
  const heading = finalOnly ? "最终 MR 的代码改动" : `${before}与最终版的代码差异`;
  return <section aria-label={heading} className="grid min-w-0 gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="m-0 text-base font-semibold">{heading}</h3>
      <div className="flex flex-wrap gap-3 text-xs">
        {row.initial_mr_url && <a className="inline-flex items-center gap-1 text-ink" href={row.initial_mr_url} target="_blank" rel="noreferrer">初版 MR <ExternalLink size={12} /></a>}
        {row.mr_url && <a className="inline-flex items-center gap-1 text-ink" href={row.mr_url} target="_blank" rel="noreferrer">最终 MR <ExternalLink size={12} /></a>}
      </div>
    </div>
    {summary.reason && <p className="m-0 text-xs leading-relaxed text-muted-foreground">{summary.reason}</p>}
    {summary.method !== "unavailable" && <>
      {!finalOnly && <><div className="grid grid-cols-3 gap-2 rounded-lg border border-line bg-surface-2 p-3">
        {([["两版共有", summary.retained], [`仅${before}`, summary.removed], ["仅最终版", summary.added]] as const).map(([label, value]) =>
          <div key={label}><small className="block text-xs text-muted-foreground">{label}</small><strong className="mt-1 block text-sm">{value?.toLocaleString() ?? "—"} 行</strong></div>)}
      </div>
      {summary.method === "patch" && <p className="m-0 text-xs leading-relaxed text-muted-foreground">提交历史无法连续追溯，按两版的改动内容比对。</p>}</>}
      {!files.length ? <p className="m-0 text-sm">{finalOnly ? "没有可展示的代码改动。" : "两版的代码改动一致。"}</p> : <div className="grid gap-1.5">
        <strong className="text-xs text-muted-foreground">{finalOnly ? "变更文件" : "有差异的文件"} · {files.length}</strong>
        {files.map(file => <div key={file.path} className="min-w-0 overflow-hidden rounded-lg border border-line">
          <button type="button" aria-expanded={path === file.path} aria-label={file.path} onClick={() => setPath(path === file.path ? "" : file.path)}
            className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
            <ChevronDown size={14} className={path === file.path ? "shrink-0" : "shrink-0 -rotate-90"} />
            <code className="min-w-0 flex-1 break-all">{file.path}</code>
            <span className="shrink-0 text-xs text-muted-foreground">{finalOnly ? `+${file.added} / −${file.removed}` : `仅${before} ${file.removed} · 仅最终版 ${file.added}`}</span>
          </button>
          {path === file.path && <div className="grid min-w-0 gap-2 border-t border-line p-2">
            {error ? <div role="alert" className="flex gap-2 text-sm text-danger">{error}<Button size="xs" variant="outline" onClick={() => setRetry(value => value + 1)}>重试</Button></div>
              : !detail ? <span role="status" className="text-xs">正在读取代码差异…</span>
              : selected ? <>
                {detail.comparison_basis === "patch" && <p className="m-0 text-xs text-muted-foreground">两版基线不同，按各自引入的改动对照。</p>}
                <Patch title={finalOnly ? "相对目标分支的改动" : `从${before}到最终版`} text={selected.change_patch} empty="没有可展示的差异行。" />
                {!finalOnly && <details className="min-w-0 text-xs"><summary className="cursor-pointer py-1 text-muted-foreground">查看两版各自的改动</summary>
                  <div className="mt-1 grid gap-2">
                    <Patch title={summary.reference === "local_snapshot" ? "本地快照的改动" : pushed ? "平台已推送版本的改动" : "初版 MR 的改动"} text={selected.initial_patch} empty={selected.truncated ? "未保存此段差异。" : `${before}没有此文件的改动。`} />
                    <Patch title="最终 MR 的改动" text={selected.final_patch} empty={selected.truncated ? "未保存此段差异。" : "最终 MR 没有此文件的改动。"} />
                  </div>
                </details>}
                {selected.truncated && <span className="text-xs text-muted-foreground">仅展示部分差异，可打开对应 MR 查看完整代码。</span>}
              </> : <span className="text-xs text-muted-foreground">{detail.truncated ? "此文件超出可展示范围，可打开对应 MR 查看完整代码。" : "此文件的代码差异不可用。"}</span>}
          </div>}
        </div>)}
      </div>}
    </>}
  </section>;
}
