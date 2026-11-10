/** 左闭右开；界面把用户所选结束日的次日零点传给 before。 */
export interface CompletionRange { from?: string; before?: string }

export function validateCompletionRange(range: CompletionRange): CompletionRange {
  for (const value of [range.from, range.before]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error("完成日期范围无效");
  }
  if (range.from && range.before && Date.parse(range.from) >= Date.parse(range.before)) throw new Error("开始日期不能晚于结束日期");
  return range;
}

export function completedInRange(completedAt: string | undefined, range: CompletionRange): boolean {
  if (!range.from && !range.before) return true;
  const time = Date.parse(completedAt ?? "");
  return Number.isFinite(time) && (!range.from || time >= Date.parse(range.from)) && (!range.before || time < Date.parse(range.before));
}
