import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface KnowledgeContentSearchProps {
  contentRef: RefObject<HTMLElement | null>;
  contentKey: string | number;
  contentSelector?: string;
  disabled?: boolean;
}

const excluded = "button:not(.knowledge-inline-link), input, textarea, select, script, style, [hidden], [aria-hidden='true'], [data-knowledge-search-exclude], [aria-label='文稿审阅意见'], .knowledge-review-note-list, .research-discussion";
const textBlock = "p, h1, h2, h3, h4, h5, h6, li, pre, td, th, blockquote";

function findRanges(container: HTMLElement, selector: string, query: string): Range[] {
  if (!query) return [];
  const candidates = [...container.querySelectorAll<HTMLElement>(selector)];
  if (container.matches(selector)) candidates.unshift(container);
  const roots = candidates.filter(element => !element.closest(excluded) && !candidates.some(other => other !== element && other.contains(element)));
  const ranges: Range[] = [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const root of roots) {
    const nodes: Array<{ node: Text; start: number; end: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.textContent && !node.parentElement?.closest(excluded) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let text = "", block: Element | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const nextBlock = node.parentElement?.closest(textBlock) ?? root;
      if (block && block !== nextBlock) text += "\n";
      block = nextBlock;
      const start = text.length;
      text += node.textContent;
      nodes.push({ node: node as Text, start, end: text.length });
    }
    for (const match of text.matchAll(expression)) {
      const start = match.index!, end = start + match[0].length;
      const first = nodes.find(item => item.start <= start && item.end > start);
      const last = nodes.find(item => item.start < end && item.end >= end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      ranges.push(range);
    }
  }
  return ranges;
}

function revealRange(range: Range, container: HTMLElement) {
  let scroller = range.startContainer.parentElement;
  while (scroller && (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight <= scroller.clientHeight)) scroller = scroller.parentElement;
  if (!scroller || !scroller.contains(container) && !container.contains(scroller)) return;
  const rect = range.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
  scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + rect.top - bounds.top - Math.max(64, scroller.clientHeight / 3)), behavior: "instant" });
}

export function KnowledgeContentSearch({ contentRef, contentKey, contentSelector = ".md, pre", disabled = false }: KnowledgeContentSearchProps) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const allKey = `knowledge-find-${id}`, activeKey = `${allKey}-active`;
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]), [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const supported = typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  function move(offset: number) { if (ranges.length) setCurrent(value => (value + offset + ranges.length) % ranges.length); }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (disabled || !supported || !contentRef.current?.getClientRects().length) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); setOpen(true); input.current?.focus(); input.current?.select();
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [contentRef, disabled, supported]);
  useEffect(() => { if (open) { input.current?.focus(); input.current?.select(); } }, [open]);
  useEffect(() => {
    if (!open || disabled) { setRanges([]); return; }
    const container = contentRef.current;
    if (!container) { setRanges([]); return; }
    let live = true, scheduled = false;
    function scan() { setRanges(findRanges(container!, contentSelector, query)); setCurrent(0); }
    scan();
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (live) scan(); });
    });
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => { live = false; observer.disconnect(); };
  }, [open, query, contentKey, contentRef, contentSelector, disabled]);
  useEffect(() => {
    if (!supported) return;
    if (open && !disabled && ranges.length) {
      CSS.highlights.set(allKey, new Highlight(...ranges));
      const active = ranges[current];
      if (active) {
        const highlight = new Highlight(active); highlight.priority = 1;
        CSS.highlights.set(activeKey, highlight);
        if (contentRef.current) revealRange(active, contentRef.current);
      }
    }
    return () => { CSS.highlights.delete(allKey); CSS.highlights.delete(activeKey); };
  }, [allKey, activeKey, supported, open, disabled, ranges, current, contentRef]);
  return <div className="knowledge-content-search">
    <style>{`::highlight(${allKey}) { background-color: #ffeaa0; color: #382900; } ::highlight(${activeKey}) { background-color: #efaa36; color: #211600; }`}</style>
    <Button ref={trigger} variant="ghost" size="sm" disabled={disabled || !supported} title={supported ? "查找当前正文（Ctrl / ⌘ + F）" : "当前浏览器不支持正文高亮查找"} aria-expanded={open} onClick={() => setOpen(value => !value)}><Search size={16} />查找正文</Button>
    {open && <div className="knowledge-content-search-panel" role="search" aria-label="当前正文查找" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
    }}>
      <Search size={16} aria-hidden="true" />
      <input ref={input} aria-label="查找正文内容" placeholder="查找当前正文…" value={query} onChange={event => setQuery(event.target.value)} />
      <span className="knowledge-content-search-count" role="status" aria-live="polite" aria-label="正文匹配结果">{ranges.length ? `${current + 1} / ${ranges.length}` : query ? "无结果" : "0 / 0"}</span>
      <button type="button" aria-label="上一处匹配" title="上一处（Shift + Enter）" disabled={!ranges.length} onClick={() => move(-1)}><ArrowUp size={16} /></button>
      <button type="button" aria-label="下一处匹配" title="下一处（Enter）" disabled={!ranges.length} onClick={() => move(1)}><ArrowDown size={16} /></button>
      <button type="button" aria-label="关闭正文查找" title="关闭（Esc）" onClick={close}><X size={16} /></button>
    </div>}
  </div>;
}
