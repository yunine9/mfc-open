import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CompletionRange } from "../../src/completionRange";

export interface CompletionDates { from: string; to: string }
export function completionDateRange(dates: CompletionDates): CompletionRange {
  const start = dates.from ? new Date(`${dates.from}T00:00:00`) : undefined;
  const end = dates.to ? new Date(`${dates.to}T00:00:00`) : undefined;
  // 用本地日历递增，跨夏令时的结束日也包含全天。
  if (end) end.setDate(end.getDate() + 1);
  return { from: start?.toISOString(), before: end?.toISOString() };
}
export function CompletionDateFilter({ value, onChange }: { value: CompletionDates; onChange: (value: CompletionDates) => void }) {
  const invalid = !!value.from && !!value.to && value.from > value.to;
  return <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0 text-sm" aria-label="按完成日期筛选">
    <span>完成日期</span>
    <Input type="date" aria-label="完成开始日期" className="w-40" value={value.from} max={value.to || undefined} onChange={event => onChange({ ...value, from: event.target.value })} />
    <span>至</span>
    <Input type="date" aria-label="完成结束日期" className="w-40" value={value.to} min={value.from || undefined} onChange={event => onChange({ ...value, to: event.target.value })} />
    {(value.from || value.to) && <Button size="sm" variant="ghost" onClick={() => onChange({ from: "", to: "" })}>全部时间</Button>}
    {invalid && <span role="alert" className="text-danger">开始日期不能晚于结束日期</span>}
  </fieldset>;
}
