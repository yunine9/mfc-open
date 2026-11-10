export interface KnowledgeHeading { title: string; level: number; line: number; anchor: string; children: KnowledgeHeading[] }
const plainTitle = (text: string) => text.replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/<[^>]*>/g, "").trim();
export function knowledgeHeadings(text: string): KnowledgeHeading[] {
  const headings: KnowledgeHeading[] = [], counts = new Map<string, number>();
  let fence: string | undefined;
  text.split(/\r\n|[\n\r\u2028\u2029]/).forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined; return; }
    if (fence) return;
    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (!match) return;
    const title = plainTitle(match[2]);
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const count = counts.get(base) ?? 0; counts.set(base, count + 1);
    headings.push({ title, level: match[1].length, line: index + 1, anchor: `${base}${count ? `-${count}` : ""}`, children: [] });
  });
  return headings;
}
export function knowledgeHeadingTree(text: string) {
  const all = knowledgeHeadings(text), headings = all[0]?.level === 1 ? all.slice(1) : all;
  const roots: KnowledgeHeading[] = [], stack: KnowledgeHeading[] = [];
  for (const heading of headings) {
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(heading); stack.push(heading);
  }
  return roots;
}
export function knowledgeAnchorLine(text: string, anchor: string): number | undefined {
  const heading = knowledgeHeadings(text).find(h => h.anchor === anchor);
  if (heading) return heading.line;
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined; continue; }
    if (!fence && lines[i].match(/^\s*<a\s+(?:id|name)=["']([^"']+)["']\s*>\s*<\/a>\s*$/)?.[1] === anchor) return i + 1;
  }
}
export function resolveKnowledgeReference<T extends { id: string; path: string; target_id: string }>(items: T[], current: T, href: string): { item: T; anchor: string } | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return;
  const [rawPath, rawAnchor = ""] = href.split("#", 2);
  let path: string, anchor: string;
  try { path = decodeURIComponent(rawPath); anchor = decodeURIComponent(rawAnchor); } catch { return; }
  if (!path) return { item: current, anchor };
  const parts = path.startsWith("/") ? [] : current.path.split("/").slice(0, -1);
  for (const part of path.split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!parts.length) return; parts.pop(); } else parts.push(part); }
  const found = items.filter(item => item.target_id === current.target_id && item.path === parts.join("/"));
  return found.length === 1 ? { item: found[0], anchor } : undefined;
}
