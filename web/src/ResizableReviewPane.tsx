import { useEffect, useRef, useState, type ReactNode } from "react";

const WIDTH_KEY = "mae-flow:review-pane-width";

export function ResizableReviewPane({ open, children }: {
  open: boolean; children: ReactNode;
}) {
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [available, setAvailable] = useState(1000);
  const [preferred, setPreferred] = useState<number | undefined>(() => {
    try {
      const value = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(value) && value >= 260 ? value : undefined;
    } catch { return undefined; }
  });
  const maximum = Math.max(260, available - 320);
  const clamp = (value: number) => Math.max(260, Math.min(maximum, value));
  const width = clamp(preferred ?? Math.min(420, Math.max(340, available * .4)));
  useEffect(() => {
    const parent = pane.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailable(parent.clientWidth - 8);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      if (preferred === undefined) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(preferred));
    } catch { /* 私密模式也能调整宽度。 */ }
  }, [preferred]);
  useEffect(() => { if (!open) drag.current = undefined; }, [open]);

  return <>
    <div className="ws-review-resizer" hidden={!open}
      role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label="调整检视意见栏宽度" aria-controls="ws-review-canvas"
      aria-valuemin={260} aria-valuemax={maximum} aria-valuenow={Math.round(width)}
      title="拖动调整检视意见栏宽度；双击恢复默认，也可使用左右方向键"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current) setPreferred(clamp(
          drag.current.width + drag.current.x - event.clientX));
      }}
      onPointerUp={(event) => {
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { drag.current = undefined; }}
      onLostPointerCapture={() => { drag.current = undefined; }}
      onDoubleClick={() => setPreferred(undefined)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          setPreferred(clamp(width + (event.key === "ArrowLeft" ? 24 : -24)));
        } else if (event.key === "Home") {
          event.preventDefault(); setPreferred(undefined);
        }
      }} />
    <section ref={pane} className="ws-review-canvas" id="ws-review-canvas"
      role="complementary" aria-label="检视意见" tabIndex={-1}
      hidden={!open} style={{ flexBasis: width, minWidth: 0 }}>
      {children}
    </section>
  </>;
}
