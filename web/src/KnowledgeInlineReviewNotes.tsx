import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import type { KnowledgeReviewNote } from "../../src/knowledgeReviewNoteTypes";

interface ReviewRow { element: HTMLElement; text: string; line: number }
interface Placement { host: HTMLElement; container: HTMLElement; notes: KnowledgeReviewNote[] }
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
/** 历史行号只能作说明。原文唯一匹配，或相邻上下文能唯一消歧后，才把意见放回正文。 */
function locate(rows: ReviewRow[], note: KnowledgeReviewNote): HTMLElement | undefined {
  const quote = normalize(note.quote || note.anchor || "").replace(/…$/, "");
  if (!quote || /^第 \d+ 行$/.test(quote)) return;
  const offsets: number[] = []; let text = "";
  for (const row of rows) { offsets.push(text.length); text += `${row.text} `; }
  const matches: Array<{ end: number; score: number }> = [];
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) {
    const rowAt = (position: number) => { let index = offsets.length - 1; while (index > 0 && offsets[index] > position) index--; return index; };
    const first = rowAt(start);
    const last = rowAt(start + quote.length - 1);
    const before = normalize(rows.slice(Math.max(0, first - 2), first).map(row => row.text).join(" "));
    const after = normalize(rows.slice(last + 1, last + 3).map(row => row.text).join(" "));
    const expectedBefore = normalize(note.context_before ?? ""), expectedAfter = normalize(note.context_after ?? "");
    matches.push({ end: last, score: Number(!!expectedBefore && before.endsWith(expectedBefore)) + Number(!!expectedAfter && after.startsWith(expectedAfter)) });
  }
  if (matches.length === 1) return rows[matches[0].end]?.element;
  const best = Math.max(0, ...matches.map(match => match.score));
  const selected = matches.filter(match => match.score === best);
  if (best > 0 && selected.length === 1) return rows[selected[0].end]?.element;
}
function insertion(row: HTMLElement) {
  const host = document.createElement(row.tagName === "TR" ? "tr" : row.tagName === "LI" ? "li" : "div");
  host.className = "knowledge-inline-review-host"; host.dataset.knowledgeReview = "true"; host.dataset.knowledgeSearchExclude = "true";
  let container = host;
  if (row.tagName === "TR") { const cell = document.createElement("td"); cell.colSpan = 100; host.append(cell); container = cell; }
  row.after(host); return { host, container };
}
/** 只加独立的意见容器，不改原文节点、源行号或选区。找不到原文的意见继续留在意见列表。 */
export function KnowledgeInlineReviewNotes({ notes, children }: { notes: KnowledgeReviewNote[]; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), [placements, setPlacements] = useState<Placement[]>([]);
  useLayoutEffect(() => {
    const rows: ReviewRow[] = [...(root.current?.querySelectorAll<HTMLElement>("[data-l]") ?? [])]
      .filter(row => !row.closest("[data-knowledge-review]") && !row.querySelector("[data-l]"))
      .map(element => ({ element, line: Number(element.dataset.l), text: normalize(element.textContent ?? "") }));
    const grouped = new Map<HTMLElement, KnowledgeReviewNote[]>();
    for (const note of notes) { const row = locate(rows, note); if (row) grouped.set(row, [...(grouped.get(row) ?? []), note]); }
    const next = [...grouped].map(([row, items]) => ({ ...insertion(row), notes: items })); setPlacements(next);
    return () => { for (const placement of next) placement.host.remove(); };
  }, [notes, children]);
  return <div ref={root} className="knowledge-inline-review-root">{children}{placements.map(placement => createPortal(<div className="knowledge-inline-review-list" aria-label="此处的检视意见">{placement.notes.map(note => <article key={note.id} className={`knowledge-inline-review-note is-${note.status}`} data-note-id={note.id}>
    <header><span><MessageSquare size={13} />{note.operator}</span><span>{note.status === "open" ? "已保存 · 待提交" : note.status === "submitted" ? "已提交" : "已处理"}</span></header>
    <p>{note.note}</p>
  </article>)}</div>, placement.container, placement.notes.map(note => note.id).join(":")))}</div>;
}
