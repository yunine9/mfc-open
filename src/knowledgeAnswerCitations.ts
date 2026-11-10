/** 只认可答案正文中的引用；代码示例、图片与转义文本不算可点击来源。 */
export function knowledgeAnswerCitations(markdown: string): string[] {
  const lines = markdown.split(/\r\n|[\n\r\u2028\u2029]/);
  const visible: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    const marker = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      visible.push("");
      continue;
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      visible.push("");
    } else visible.push(line);
  }
  const text = visible.join("\n"), output: string[] = [];
  let position = 0;
  while (position < text.length) {
    const char = text[position];
    if (char === "\\" && position + 1 < text.length) {
      // 保留字面反斜杠的位置，屏蔽被转义字符；偶数个反斜杠不转义后续链接。
      output.push(" ", " "); position += 2; continue;
    }
    if (char === "`") {
      let end = position;
      while (text[end] === "`") end++;
      const length = end - position;
      let cursor = end, closing = -1;
      while (cursor < text.length) {
        const next = text.indexOf("`", cursor);
        if (next < 0) break;
        let nextEnd = next;
        while (text[nextEnd] === "`") nextEnd++;
        if (nextEnd - next === length) { closing = nextEnd; break; }
        cursor = nextEnd;
      }
      if (closing >= 0) { output.push(" ".repeat(closing - position)); position = closing; continue; }
      output.push(text.slice(position, end)); position = end; continue;
    }
    output.push(char); position++;
  }
  const prose = output.join("");
  return [...prose.matchAll(/\[([^\[\]\n]+)\]\(#evidence-([A-Za-z0-9_-]+)\)/g)]
    .filter(match => prose[match.index! - 1] !== "!")
    .map(match => match[2]);
}
