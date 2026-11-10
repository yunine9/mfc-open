/** 来源文字由宿主转义，只还原这一层，再交给 React 当文字显示。 */
export function sourceText(row: string): string {
  return row.replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export interface AnswerCitation { id: string; label: string; quote?: string }
export type AnswerPart = { kind: "body"; text: string } | { kind: "sources"; citations: AnswerCitation[] };
const citationLink = /^\[((?:\\.|[^\]\\])+)\]\(#evidence-([A-Za-z0-9_-]+)\)$/;

/** 只收起平台生成且完整的来源块；正文、代码示例和不完整的来源内容保留原样。 */
export function answerParts(text: string): AnswerPart[] {
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/), parts: AnswerPart[] = [];
  let body: string[] = [], fence: { char: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index], marker = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      body.push(line); continue;
    }
    if (fence || !["**来源原句：**", "**来源原文（点击查看）：**"].includes(line)) { body.push(line); continue; }
    const quoted = line === "**来源原句：**", citations: AnswerCitation[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      let next = cursor;
      while (next < lines.length && !lines[next].trim()) next += 1;
      const quote: string[] = [];
      if (quoted) {
        while (next < lines.length && /^> ?/.test(lines[next])) quote.push(sourceText(lines[next++].replace(/^> ?/, "")));
        if (!quote.length) break;
        while (next < lines.length && !lines[next].trim()) next += 1;
      }
      const link = citationLink.exec(lines[next] || "");
      if (!link) break;
      citations.push({ id: link[2], label: sourceText(link[1]), ...(quoted ? { quote: quote.join("\n") } : {}) });
      cursor = next + 1;
    }
    if (!citations.length) { body.push(line); continue; }
    if (body.join("\n").trim()) parts.push({ kind: "body", text: body.join("\n") });
    body = [];
    parts.push({ kind: "sources", citations });
    index = cursor - 1;
  }
  if (body.join("\n").trim()) parts.push({ kind: "body", text: body.join("\n") });
  return parts;
}
