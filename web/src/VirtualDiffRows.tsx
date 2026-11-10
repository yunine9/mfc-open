import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Keep the existing light-DOM line anchors so review annotations work in both task domains. */
export function VirtualDiffRows<T>({ rows, render, scrollElement, enabled, rowHeight }: {
  rows: readonly T[]; render(row: T, index: number): ReactNode;
  scrollElement: () => HTMLElement | null; enabled: boolean; rowHeight: number;
}) {
  const body = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: scrollElement,
    estimateSize: () => rowHeight, overscan: 16, initialRect: { width: 900, height: 600 }, enabled: enabled && rows.length > 400,
    scrollMargin: body.current?.offsetTop ?? 0 });
  if (!enabled || rows.length <= 400) return <div className="diff-review-body">{rows.map(render)}</div>;
  return <div ref={body} className="diff-review-body diff-virtual-body" style={{ height: virtual.getTotalSize(), position: "relative" }}>
    {virtual.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={virtual.measureElement}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - virtual.options.scrollMargin}px)` }}>
      {render(rows[item.index], item.index)}
    </div>)}
  </div>;
}
