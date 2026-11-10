import { Markdown } from "./markdown";
import { answerParts, sourceText } from "./knowledgeAnswerPresentation";

function sourceLinkLabel(label: string, href: string): string {
  return /^#evidence-[A-Za-z0-9_-]+$/.test(href) ? sourceText(label) : label;
}

export function KnowledgeAnswerMarkdown({ text, evidenceIds = [], onOpenKnowledgeLink }: {
  text: string;
  evidenceIds?: string[];
  onOpenKnowledgeLink?: (href: string, quote?: string) => void;
}) {
  const parts = answerParts(text);
  const ids = evidenceIds.length ? evidenceIds : [...new Set(parts.flatMap(part => part.kind === "sources" ? part.citations.map(item => item.id) : []))];
  return <>{parts.map((part, index) => part.kind === "body"
    ? <Markdown key={index} text={part.text} onOpenKnowledgeLink={onOpenKnowledgeLink}
      renderQuotedText={sourceText} renderKnowledgeLinkLabel={sourceLinkLabel} />
    : <div key={index} className="ka-inline-sources" aria-label="本段来源"><span>依据</span>{part.citations.map((citation, i) =>
      <button type="button" key={`${citation.id}:${i}`} className="ka-source-link" title={citation.label}
        aria-label={`查看来源：${citation.label}`} onClick={() => onOpenKnowledgeLink?.(`#evidence-${citation.id}`, citation.quote)}>
        <span>{ids.indexOf(citation.id) + 1 || "↗"}</span><span>{citation.label}</span>
      </button>)}</div>)}</>;
}
