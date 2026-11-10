import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";
import { knowledgeAnchorLine } from "./knowledgeStructure";
export interface KnowledgeFocus { line?: number; anchor?: string; token: number }
/** 组件指南开头的结构字段（mfc.component-guide 等）给机器读；阅读时换成空行，
 *  行号不变，批注与章节定位仍对得上。其他文档的 frontmatter 原样保留。 */
export function blankKnowledgeMetadata(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(text);
  if (!match || !/^schema:\s*["']?mfc\./m.test(match[1])) return text;
  return match[0].replace(/[^\n]/g, "") + text.slice(match[0].length);
}
export function KnowledgeMarkdown({ text: original, focus, onReference, hideMetadata = false, resolveImage }: { text: string; focus?: KnowledgeFocus; onReference?: (href: string) => boolean; hideMetadata?: boolean; resolveImage?: (path: string) => string | undefined }) {
  const text = hideMetadata ? blankKnowledgeMetadata(original) : original;
  const root = useRef<HTMLDivElement>(null), [notice, setNotice] = useState("");
  function navigate(line?: number, anchor?: string) {
    const number = anchor ? knowledgeAnchorLine(text, anchor) : line;
    const target = number ? [...(root.current?.querySelectorAll<HTMLElement>("[data-l]") ?? [])].find(el => Number(el.dataset.l) === number) : root.current;
    if (!target) { setNotice("当前知识中未找到这个章节。"); return; }
    setNotice("");
    let panel = root.current?.parentElement;
    while (panel && !/(auto|scroll)/.test(getComputedStyle(panel).overflowY)) panel = panel.parentElement;
    if (panel) panel.scrollTo({ top: !number && !panel.classList.contains("research-full-document") ? 0 : panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12, behavior: "instant" });
    target.tabIndex = -1; target.focus({ preventScroll: true });
  }
  useEffect(() => { setNotice(""); if (focus) navigate(focus.line, focus.anchor); }, [focus?.token]);
  return <div ref={root} className="knowledge-markdown">
    {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
    <Markdown text={text} resolveImage={resolveImage} onOpenKnowledgeLink={href => {
      if (href.startsWith("#")) { try { navigate(undefined, decodeURIComponent(href.slice(1))); } catch { setNotice("章节链接格式无效。"); } }
      else if (!onReference?.(href)) setNotice("当前知识目录中未找到这个链接对应的文件。");
    }} />
  </div>;
}
