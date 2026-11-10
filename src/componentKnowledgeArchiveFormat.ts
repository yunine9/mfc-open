import { createHash } from "node:crypto";
import { posix } from "node:path";
import { componentKnowledgeMarkdown } from "./componentKnowledgeMarkdown.ts";
import { publishedComponentParadigms } from "./componentKnowledgeDocument.ts";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const schema = "mfc.component-guide/v2";

/** 正文给人读、结构字段给程序：归档进 Git 只放正文，结构字段随派生产物导出。 */
export function componentArchiveParts(text: string) {
  const content = componentKnowledgeMarkdown(text) + "\n";
  const front = /^---\r?\nschema: "mfc\.component-guide\/v1"\r?\ncomponent_paradigms: ([^\r\n]+)\r?\n---/.exec(text);
  const metadata = front ? JSON.stringify({ schema, component_paradigms: JSON.parse(front[1]) }) : undefined;
  return { content, component_metadata: metadata ? componentArchiveMetadata(content, metadata) : undefined };
}

export function componentArchiveMetadata(content: string, metadata: string): string {
  const value = JSON.parse(metadata);
  if (value.schema !== schema || !Array.isArray(value.component_paradigms)) throw new Error("组件知识结构文件格式不正确");
  return JSON.stringify({ schema, content_sha256: digest(content), component_paradigms: value.component_paradigms }, null, 2) + "\n";
}

/** 派生产物里的正文与结构文件按摘要配对还原，避免错配旧规则。 */
export function restoreComponentArchive(content: string, metadata: string): string {
  const value = JSON.parse(metadata);
  if (value.schema !== schema || value.content_sha256 !== digest(content)) throw new Error("组件知识正文与结构文件不一致，请更新配套文件后同步");
  const canonical = `---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: ${JSON.stringify(value.component_paradigms)}\n---\n\n${content}`;
  publishedComponentParadigms({ id: "archive", revision: "archive", content: canonical, productVersions: [] });
  return canonical;
}

/** 按语言和知识标题确定归档位置；有结构化能力时以此文件名生成目录，旧整篇批次仍可恢复。 */
export function componentArchivePath(docsPath: string, formal: { title: string; technologies: string[] }) {
  const name = formal.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").replace(/-{2,}/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "").slice(0, 80) || "组件知识";
  return `${docsPath}/${formal.technologies[0] ?? "agnostic"}/${name}.md`;
}

/** 从已发布的精确版本拆分；不读取研究草稿，也不让模型重新生成正文。 */
export function componentArchiveFiles(text: string, guidePath: string, sourceId = "component-guide") {
  const parts = componentArchiveParts(text);
  const entries = parts.component_metadata ? JSON.parse(parts.component_metadata).component_paradigms : [];
  if (!entries.some((entry: any) => entry.kind === "paradigm" && entry.status === "recommended")) {
    return [{ id: sourceId, title: "组件知识", path: guidePath, content: parts.content }];
  }
  const paradigms = publishedComponentParadigms({ id: "archive", revision: "archive", content: text, productVersions: [] });
  const directory = guidePath.replace(/\.md$/, ""), indexPath = `${directory}/README.md`;
  const paths = new Map(paradigms.map(entry => [entry.id, `${directory}/${entry.component}/${entry.id}.md`]));
  const link = (from: string, to: string) => posix.relative(posix.dirname(from), to);
  const rewrite = (content: string, from: string) => {
    let fence = "";
    return content.split("\n").map(line => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
        return line;
      }
      return fence || /^(?: {4}|\t)/.test(line) ? line : line.split(/(`+[^`]*`+)/g).map((part, index) => index % 2 ? part :
        part.replace(/\]\(#component-([a-z0-9-]+)\)/g, (match, id) => paths.has(id) ? `](${link(from, paths.get(id)!)}#component-${id})` : match)).join("");
    }).join("\n");
  };
  const lines = text.split(/\r?\n/), first = Math.min(...paradigms.map(entry => entry.start_line)) - 1;
  const introduction = componentKnowledgeMarkdown(lines.slice(0, first).join("\n"));
  const navigation = introduction.lastIndexOf("\n## 用法导航\n");
  const summary = navigation < 0 ? introduction : introduction.slice(0, navigation);
  const label = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/([\\\[\]])/g, "\\$1");
  const files = paradigms.map(entry => {
    const path = paths.get(entry.id)!;
    const body = componentKnowledgeMarkdown(lines.slice(entry.start_line - 1, entry.end_line).join("\n"))
      .replace(/^(<a id="component-[a-z0-9-]+"><\/a>\n\n)## [^\n]+\n\n/, "$1");
    return { id: `${sourceId}-${digest(entry.id).slice(0, 24)}`, title: entry.title, path,
      content: `# ${label(entry.title)}\n\n[返回能力目录与接入配置](${link(path, indexPath)})\n\n${rewrite(body, path)}\n` };
  });
  const groups = [...new Set(paradigms.map(entry => entry.component))];
  const contents = groups.map(component => `### ${component}\n\n` + paradigms.filter(entry => entry.component === component)
    .map(entry => `- [${label(entry.title)}](${link(indexPath, paths.get(entry.id)!)}): ${label(entry.need)}`).join("\n")).join("\n\n");
  return [{ id: sourceId, title: "能力目录与接入配置", path: indexPath,
    content: `${rewrite(summary, indexPath)}\n\n## 能力目录\n\n${contents}\n` }, ...files];
}
