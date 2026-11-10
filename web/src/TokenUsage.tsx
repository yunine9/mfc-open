import type { TaskTokenUsage } from "./api";
import { formatLocalDateTime } from "./time";
import { cn } from "cn";

function tokenText(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const compact = value / 1_000;
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  const compact = value / 1_000_000;
  return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}m`;
}

function rateText(value: number): string {
  return `${tokenText(value)} Token/分钟`;
}

function amountText(value: number): string {
  return `${tokenText(value)} Token`;
}

/** ↑/↓ 沿用 Pi 的输入/输出语义，不表示网络流量。 */
export function TokenUsage({
  usage,
  placement = "compact",
}: {
  usage?: TaskTokenUsage;
  placement?: "compact" | "workspace" | "history" | "detail";
}) {
  if (!usage) return null;
  const title = `模型真实用量 · 更新于 ${formatLocalDateTime(
    usage.updated_at, { seconds: true })}`;

  if (placement === "detail") {
    const totalRate = usage.input_tokens_per_minute
      + usage.output_tokens_per_minute;
    return (
      <section className="overflow-hidden rounded-[11px] border border-line bg-surface
        text-text shadow-xs tabular-nums" aria-label="任务模型 Token 用量" title={title}>
        <header className="flex min-h-[66px] items-center justify-between gap-3.5 border-b
          border-line bg-suspended/5 px-3.5 py-3 max-[560px]:flex-col max-[560px]:items-start">
          <div className="flex min-w-0 items-center gap-2.5">
            <i aria-hidden className="grid size-[34px] flex-none place-items-center rounded-[9px]
              bg-suspended/10 font-mono text-[17px] font-extrabold text-suspended">↕</i>
            <span className="grid min-w-0 gap-[3px]">
              <small className="text-[13px] font-extrabold text-suspended">模型用量</small>
              <strong className="text-[14.5px] text-text-strong">模型 Token 用量</strong>
            </span>
          </div>
          <div className={cn("grid min-w-[132px] justify-items-end gap-[3px] border-l border-line pl-3.5",
            "max-[560px]:w-full max-[560px]:grid-cols-[1fr_auto] max-[560px]:items-center max-[560px]:border-l-0 max-[560px]:border-t max-[560px]:py-2 max-[560px]:pl-0")}>
            <span className="flex items-center gap-[5px] text-[13px] text-faint">
              <i aria-hidden className={cn("size-[5px] rounded-full",
                totalRate > 0 && "bg-success shadow-[0_0_0_3px_var(--success-soft)]",
                totalRate <= 0 && "bg-faint")} />最近 {usage.rate_window_seconds} 秒速率</span>
            <strong className="whitespace-nowrap font-mono text-[13px] font-bold text-text-strong">{rateText(totalRate)}</strong>
          </div>
        </header>
        <div className="grid grid-cols-3 gap-[7px] p-[11px] max-[560px]:grid-cols-2">
          <article className="flex min-h-[88px] min-w-0 flex-col justify-center gap-[5px] rounded-[9px] border
            border-merge/20 bg-merge/[0.07] px-3 py-[11px] max-[560px]:col-span-full">
            <small className="flex items-center gap-1 text-[13px] font-bold text-muted-foreground">累计总量</small>
            <strong className="overflow-hidden truncate whitespace-nowrap font-mono text-base font-bold text-text-strong">{amountText(usage.total_tokens)}</strong>
            <span className="whitespace-nowrap font-mono text-xs font-bold text-muted-foreground">输入与输出合计</span>
          </article>
          <article className="flex min-h-[88px] min-w-0 flex-col justify-center gap-[5px] rounded-[9px] border
            border-success/20 bg-success/[0.07] px-3 py-[11px]">
            <small className="flex items-center gap-1 text-[13px] font-bold text-success/90"><b aria-hidden className="text-[13px]">↑</b> 输入</small>
            <strong className="overflow-hidden truncate whitespace-nowrap font-mono text-base font-bold text-text-strong">{amountText(usage.input_tokens)}</strong>
            <span className="whitespace-nowrap font-mono text-xs font-bold text-muted-foreground">{rateText(usage.input_tokens_per_minute)}</span>
          </article>
          <article className="flex min-h-[88px] min-w-0 flex-col justify-center gap-[5px] rounded-[9px] border
            border-suspended/20 bg-suspended/[0.07] px-3 py-[11px]">
            <small className="flex items-center gap-1 text-[13px] font-bold text-suspended/90"><b aria-hidden className="text-[13px]">↓</b> 输出</small>
            <strong className="overflow-hidden truncate whitespace-nowrap font-mono text-base font-bold text-text-strong">{amountText(usage.output_tokens)}</strong>
            <span className="whitespace-nowrap font-mono text-xs font-bold text-muted-foreground">{rateText(usage.output_tokens_per_minute)}</span>
          </article>
        </div>
        <footer className="flex min-h-[34px] flex-wrap items-center gap-3 border-t border-line
          px-[13px] py-[7px] text-[13px] text-faint max-[560px]:items-start">
          <span>单位：Token</span>
          <span>速率窗口：最近 {usage.rate_window_seconds} 秒</span>
          <time dateTime={usage.updated_at} className="ml-auto max-[560px]:ml-0 max-[560px]:w-full">
            更新于 {formatLocalDateTime(usage.updated_at, { seconds: true })}
          </time>
        </footer>
      </section>
    );
  }

  if (placement !== "workspace") {
    return (
      <span className="inline-flex w-fit items-center gap-[7px] font-mono text-xs font-bold
        leading-[1.2] tabular-nums text-muted-foreground" title={title}>
        <span className="font-sans text-[13px] font-bold tracking-[0.04em] text-faint">Token</span>
        <span className="inline-flex items-center gap-0.5"><b aria-hidden className="text-[13px] text-primary">↑</b>{tokenText(usage.input_tokens)}</span>
        <span className="inline-flex items-center gap-0.5"><b aria-hidden className="text-[13px] text-primary">↓</b>{tokenText(usage.output_tokens)}</span>
      </span>
    );
  }

  return (
    <section className="grid min-h-[58px] items-center gap-[22px] border-b border-line bg-primary/5
      px-6 py-2 shadow-xs tabular-nums max-[980px]:grid-cols-[minmax(145px,1fr)_auto_minmax(125px,auto)_minmax(125px,auto)] max-[980px]:gap-3 max-[980px]:px-3.5
      max-[560px]:grid-cols-[1fr_1fr] max-[560px]:gap-2.5 max-[560px]:gap-x-4"
      aria-label="任务模型用量" title={title}>
      <span className="flex min-w-0 items-center gap-[9px] max-[560px]:col-span-full">
        <i aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10
          font-mono text-base font-bold text-primary">↕</i>
        <span className="flex min-w-0 flex-col gap-0.5"><strong className="text-[13.5px] text-text-strong">模型用量</strong><small className="text-[13px] font-bold text-faint">提供方实时回报</small></span>
      </span>
      <span className="flex flex-col gap-0.5 border-x border-line px-5 max-[560px]:hidden">
        <small className="text-[13px] font-bold text-faint">累计</small><strong className="text-[17px] text-text-strong">{tokenText(usage.total_tokens)}</strong>
      </span>
      <span className="flex min-w-0 items-center gap-2 max-[560px]:border-t max-[560px]:pt-2">
        <b aria-hidden className="font-mono text-base font-bold text-primary">↑</b>
        <span className="flex flex-col gap-0.5"><small className="text-[13px] font-bold text-faint">输入</small><strong className="text-sm text-text-strong">{tokenText(usage.input_tokens)}</strong></span>
        <em className="ml-auto whitespace-nowrap text-[13px] not-italic text-muted-foreground">{rateText(usage.input_tokens_per_minute)}</em>
      </span>
      <span className="flex min-w-0 items-center gap-2 max-[560px]:border-t max-[560px]:pt-2">
        <b aria-hidden className="font-mono text-base font-bold text-primary">↓</b>
        <span className="flex flex-col gap-0.5"><small className="text-[13px] font-bold text-faint">输出</small><strong className="text-sm text-text-strong">{tokenText(usage.output_tokens)}</strong></span>
        <em className="ml-auto whitespace-nowrap text-[13px] not-italic text-muted-foreground">{rateText(usage.output_tokens_per_minute)}</em>
      </span>
    </section>
  );
}
