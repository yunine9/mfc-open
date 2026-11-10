/**
 * Quill 工具栏子集的 HTML↔markdown 双向转换(#271 修订版)。
 *
 * 存储世界永远是 markdown(description 每回合全量进 AI 上下文,图片走
 * issue-images/ 相对引用)——Quill 只是输入壳:进编辑器前 md→HTML,
 * 出编辑器时 HTML→md。工具栏能产出的格式全部可映射;markdown 表达
 * 不了的(下划线/颜色)在出场时降级为纯文本,milkdown 现状同样丢,
 * 不比现在差。回退开关(descriptionEditorChoice)切回 milkdown 时
 * 零迁移——两边读写的是同一种存储。
 */

/** md → HTML(进编辑器)。resolveImage 把 issue-images/ 相对引用翻成
 * 预览 URL;子集外的语法按普通段落文本落地,不丢字。 */
export function markdownToEditorHtml(
  markdown: string,
  resolveImage?: (ref: string) => string,
): string {
  const escape = (text: string) => text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (text: string) => escape(text)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_m, alt: string, src: string) =>
        `<img src="${resolveImage ? resolveImage(src) : src}" alt="${alt}">`)
    .replace(/\\([.!?:;,()\[\]()_*#>\-])/g, "$1")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;
  let code: string[] = [];
  let para: string[] = [];
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^```/.test(line.trim())) {
      closeList();
      flushPara();
      if (inCode) {
        out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (heading || bullet || ordered || line.trim() === "" || /^>\s?/.test(line)) {
      flushPara();
    }
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet || ordered) {
      const want: "ul" | "ol" = bullet ? "ul" : "ol";
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((bullet ?? ordered)![1])}</li>`);
    } else if (/^>\s?/.test(line)) {
      closeList();
      const prev = out.slice(-1)[0] ?? "";
      if (prev.startsWith("<blockquote>") && prev.endsWith("</blockquote>")) {
        out[out.length - 1] =
          `${prev.slice(0, -12)}<br>${inline(line.replace(/^>\s?/, ""))}</blockquote>`;
      } else {
        out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      }
    } else if (line.trim() === "") {
      closeList();
    } else {
      if (list) closeList();
      para.push(line);
    }
  }
  closeList();
  flushPara();
  if (inCode && code.length) {
    out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  }
  return out.join("");
}

/** HTML(Quill 产出或粘贴的外部富文本)→ markdown(出编辑器)。
 * resolveRef 把预览 URL 翻回 issue-images/ 相对引用;子集外标签剥壳
 * 留字(不丢内容,丢的只是 markdown 表达不了的格式)。 */
export function editorHtmlToMarkdown(
  html: string,
  resolveRef?: (url: string) => string,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: string[] = [];
  const inlineOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const inner = Array.from(el.childNodes).map(inlineOf).join("");
    switch (el.tagName) {
      case "BR": return "\n";
      case "STRONG": case "B": return inner.trim() ? `**${inner}**` : inner;
      case "EM": case "I": return inner.trim() ? `*${inner}*` : inner;
      case "CODE": return inner.trim() ? `\`${inner}\`` : inner;
      case "A": {
        const href = el.getAttribute("href");
        return href ? `[${inner}](${href})` : inner;
      }
      case "IMG": {
        const src = el.getAttribute("src") ?? "";
        const ref = resolveRef ? resolveRef(src) : src;
        return `![${el.getAttribute("alt") ?? "截图"}](${ref})`;
      }
      default: return inner;
    }
  };
  const inlineChildren = (el: Element): string =>
    Array.from(el.childNodes).map(inlineOf).join("");
  const walkList = (list: Element, ordered: boolean, depth: number) => {
    let index = 1;
    for (const li of Array.from(list.children)) {
      if (li.tagName !== "LI") continue;
      const nested = Array.from(li.children)
        .filter((c) => c.tagName === "UL" || c.tagName === "OL");
      for (const sub of nested) sub.remove();
      const value = (li.textContent ?? "").trim();
      if (value) {
        blocks.push(`${"  ".repeat(depth)}${ordered ? `${index}. ` : "- "}${value}`);
      }
      index += 1;
      for (const sub of nested) walkList(sub, sub.tagName === "OL", depth + 1);
    }
  };
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      switch (child.tagName) {
        case "P": {
          const value = inlineChildren(child).replace(/\n/g, "  \n");
          if (value.trim()) blocks.push(value);
          break;
        }
        case "H1": case "H2": case "H3":
          blocks.push(`${"#".repeat(Number(child.tagName[1]))} ${inlineChildren(child)}`);
          break;
        case "UL": walkList(child, false, 0); break;
        case "OL": walkList(child, true, 0); break;
        case "BLOCKQUOTE":
          blocks.push(inlineChildren(child).split("\n")
            .map((l) => `> ${l}`).join("\n"));
          break;
        case "PRE":
          blocks.push("```\n" + (child.textContent ?? "") + "\n```");
          break;
        case "IMG": blocks.push(inlineOf(child)); break;
        case "DIV": case "SPAN": walk(child); break;
        case "TABLE":
          for (const row of Array.from(child.querySelectorAll("tr"))) {
            blocks.push(Array.from(row.querySelectorAll("th,td"))
              .map((cell) => (cell.textContent ?? "").trim()).join(" | "));
          }
          break;
        default: {
          const value = inlineChildren(child);
          if (value.trim()) blocks.push(value);
        }
      }
    }
  };
  walk(doc.body);
  return blocks.join("\n\n");
}
