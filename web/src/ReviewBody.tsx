/** 长报告先给摘要，原文保持完整，不用模型改写检视人的意思。 */
export function ReviewBody({ text }: { text: string }) {
  const long = text.length > 360 || text.split("\n").length > 8;
  if (!long) return <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</p>;
  return <div className="grid min-w-0 gap-2">
    <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{text.slice(0, 360)}…</p>
    <details className="min-w-0 rounded-md border border-border bg-surface p-2.5">
      <summary className="cursor-pointer text-sm font-medium text-ink">展开完整报告 · {text.length.toLocaleString()} 字</summary>
      <div className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap break-words pr-2 text-sm leading-7">{text}</div>
    </details>
  </div>;
}
