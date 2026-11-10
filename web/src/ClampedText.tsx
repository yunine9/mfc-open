/**
 * 长话按渲染高度折叠,不按字数切(工作过程页签踩过切坏 Markdown 的坑)。
 * 超过约 12 行收成固定高度加"展开全文";静态渲染(测试)下量不到高度,
 * 原样摊开。需求侧会话流与问题侧协作流共用——折叠观感一致,两域不再
 * 各养一份(问题侧曾按字数折,阈值松得几乎不折,2026-09-08 对齐拍板)。
 */
import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";

export const CLAMP_PX = 260;

export function ClampedText({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(node.scrollHeight > CLAMP_PX + 24);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className={`conv-text${overflows && !expanded ? " clamped" : ""}`}>
      <div className="conv-text-window"><div ref={body}><Markdown text={text} /></div></div>
      {overflows && (
        <button type="button" className="conv-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}
