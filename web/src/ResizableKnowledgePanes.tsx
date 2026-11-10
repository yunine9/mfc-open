import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const WIDTH_KEY = "mae-flow:knowledge-tree-width";

/** 阅读器共用目录宽度；窗口变窄时只限制显示宽度，保留用户偏好。 */
export function ResizableKnowledgePanes({ children, className, treeHidden = false }: {
  children: ReactNode; className: string; treeHidden?: boolean;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [available, setAvailable] = useState(1000);
  const [preferred, setPreferred] = useState<number | undefined>(() => {
    try {
      const value = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(value) && value >= 200 && value <= 600 ? value : undefined;
    } catch { return undefined; }
  });
  // 为正文保留 480px，另留 16px 给阅读器已有的栏间距。
  const maximum = Math.max(200, Math.min(600, available - 496));
  const clamp = (value: number) => Math.max(200, Math.min(maximum, value));
  const width = clamp(preferred ?? 260);
  function resize(value?: number) {
    setPreferred(value);
    try {
      if (value === undefined) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(value));
    } catch { /* 浏览器禁用存储时仍可调整当前阅读器。 */ }
  }
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    const measure = () => setAvailable(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <div ref={pane} className={`resizable-knowledge-panes ${className}`} data-tree-hidden={treeHidden}
    style={{ "--knowledge-tree-width": `${width}px` } as CSSProperties}>
    {children}
    <div className="knowledge-tree-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label="调整目录宽度" aria-valuemin={200} aria-valuemax={maximum} aria-valuenow={Math.round(width)}
      title="拖动调整目录宽度；双击恢复默认，也可使用左右方向键"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (drag.current) resize(clamp(drag.current.width + event.clientX - drag.current.x));
      }}
      onPointerUp={event => {
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = undefined; }}
      onLostPointerCapture={() => { drag.current = undefined; }}
      onDoubleClick={() => resize()}
      onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault(); resize(clamp(width + (event.key === "ArrowRight" ? 24 : -24)));
        } else if (event.key === "Home") {
          event.preventDefault(); resize();
        }
      }} />
  </div>;
}
