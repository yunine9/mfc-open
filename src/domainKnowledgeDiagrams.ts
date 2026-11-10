import { createHash } from "node:crypto";
import { renderPlantUml, PLANTUML_SOURCE_LIMIT, type PlantUmlResult } from "./plantumlRender.ts";

export interface KnowledgeDiagramResult {
  index: number; line: number; status: "valid" | "invalid" | "unavailable"; error?: string;
}
export interface KnowledgeDiagramReport {
  status: "valid" | "invalid" | "unavailable";
  total: number; checked: number; diagrams: KnowledgeDiagramResult[];
}
interface DiagramBlock { line: number; source: string; error?: string }

/** 只识别 Markdown 图块边界，PlantUML 文法交给随平台发布的解析器。 */
export function knowledgeDiagramBlocks(markdown: string): DiagramBlock[] {
  const lines = markdown.split(/\r\n|[\n\r\u2028\u2029]/), blocks: DiagramBlock[] = [];
  let fence: { marker: string; quoted: boolean; language: string; line: number; lines: string[] } | undefined;
  const finish = (closed: boolean) => {
    if (!fence) return;
    const source = fence.lines.join("\n");
    if (/^(?:plantuml|puml|uml)(?:\s|$)/.test(fence.language) || /^\s*@startuml\b/m.test(source)) {
      blocks.push({ line: fence.line + 1, source,
        ...(!closed ? { error: "Markdown 图代码块未闭合" }
          : fence.quoted ? { error: "请把图代码块移到引用块之外，页面才会渲染该图" }
          : fence.language !== "plantuml" ? { error: "图代码块语言必须仅标为 plantuml，页面才能识别并渲染" } : {}) });
    }
    fence = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    // 页面只渲染独立图块；识别引用中的误用并返回修正位置。
    const line = !fence || fence.quoted ? lines[i]!.replace(/^(?: {0,3}> ?)+/, "") : lines[i]!;
    if (fence) {
      const closing = line.trim();
      if (closing.length >= fence.marker.length && [...closing].every(char => char === fence!.marker[0])) finish(true);
      else fence.lines.push(line);
      continue;
    }
    const opening = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening) fence = { marker: opening[1]!, quoted: line !== lines[i], language: opening[2]!.trim().toLowerCase(), line: i + 1, lines: [] };
    else if (/^\s*@startuml\b/.test(line)) blocks.push({ line: i + 1, source: line, error: "PlantUML 图必须放入完整的 plantuml 代码块" });
  }
  finish(false);
  return blocks;
}

// 多篇、多任务共用宿主时也只允许两个知识图渲染进程；等待可随任务取消。
let active = 0;
const waiting: Array<() => void> = [];
async function renderSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const enter = () => { signal.removeEventListener("abort", abort); active++; resolve(); };
    const abort = () => {
      const index = waiting.indexOf(enter); if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason);
    };
    if (active < 2) enter();
    else { waiting.push(enter); signal.addEventListener("abort", abort, { once: true }); }
  });
  return () => { active--; waiting.shift()?.(); };
}

function syntaxFeedback(svg: string): string {
  // 错误 SVG 包含源码及错误行；只给模型末尾的可读诊断，不复制 SVG 或整篇正文。
  const lines = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(match => match[1]!
    .replace(/<[^>]*>/g, "").replace(/&#(x[\da-f]+|\d+);/gi, (_all, value: string) => {
      const code = value.startsWith("x") || value.startsWith("X") ? parseInt(value.slice(1), 16) : Number(value);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "?";
    }).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  return lines.slice(-8).join("\n").slice(-1600) || "PlantUML 判定语法错误，请检查该图的声明、连线和块结束符";
}

/** 有界内存复用与磁盘 SVG 缓存都按完整图源绑定；环境错误不缓存为成功。 */
export function createKnowledgeDiagramChecker(options: {
  signal: AbortSignal; cacheDir?: string;
  render?: (source: string, options: Parameters<typeof renderPlantUml>[1]) => Promise<PlantUmlResult>;
}) {
  const cache = new Map<string, Promise<Omit<KnowledgeDiagramResult, "index" | "line">>>();
  const check = (source: string) => {
    const key = createHash("sha256").update(source).digest("hex");
    if (!cache.has(key)) {
      const pending = (async (): Promise<Omit<KnowledgeDiagramResult, "index" | "line">> => {
        if (Buffer.byteLength(source) > PLANTUML_SOURCE_LIMIT) return { status: "invalid", error: "单图超过 256 KiB；按完整场景拆图并保留所有业务分支" };
        const meaningful = source.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("'"));
        if (!/^@startuml(?:\s|$)/.test(meaningful[0] ?? "") || meaningful.at(-1) !== "@enduml"
            || meaningful.filter(line => /^@start\w+\b/.test(line)).length !== 1
            || meaningful.filter(line => /^@end\w+\b/.test(line)).length !== 1) {
          return { status: "invalid", error: "每个图代码块必须仅含一张图，以独立的 @startuml 开始、@enduml 结束" };
        }
        const release = await renderSlot(options.signal);
        try {
          options.signal.throwIfAborted();
          const result = await (options.render ?? renderPlantUml)(source, { cacheDir: options.cacheDir, signal: options.signal, sandbox: true });
          options.signal.throwIfAborted();
          if (result.error) return { status: "unavailable", error: result.error };
          if (result.syntax_error) return { status: "invalid", error: syntaxFeedback(result.svg ?? "") };
          return result.svg ? { status: "valid" } : { status: "unavailable", error: "渲染器未返回图，语法尚未验证" };
        } finally { release(); }
      })();
      cache.set(key, pending);
      void pending.then(result => { if (result.status === "unavailable" && cache.get(key) === pending) cache.delete(key); }, () => { if (cache.get(key) === pending) cache.delete(key); });
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
    }
    return cache.get(key)!;
  };
  return async (markdown: string): Promise<KnowledgeDiagramReport> => {
    options.signal.throwIfAborted();
    const blocks = knowledgeDiagramBlocks(markdown), diagrams: KnowledgeDiagramResult[] = [];
    for (const [index, block] of blocks.entries()) {
      options.signal.throwIfAborted();
      const result = block.error ? { status: "invalid" as const, error: block.error } : await check(block.source);
      diagrams.push({ index: index + 1, line: block.line, ...result });
      // 运行条件不足时不为后续图反复启动失败的渲染；checked 明确标出未检查部分。
      if (result.status === "unavailable") break;
    }
    return { status: diagrams.some(item => item.status === "unavailable") ? "unavailable" : diagrams.some(item => item.status === "invalid") ? "invalid" : "valid",
      total: blocks.length, checked: diagrams.length, diagrams };
  };
}

export function knowledgeDiagramFeedback(documentId: string, report: KnowledgeDiagramReport): string {
  const errors = report.diagrams.filter(item => item.status !== "valid");
  return `${documentId}: PlantUML ${report.status}，已检查 ${report.checked}/${report.total} 张图。\n`
    + errors.slice(0, 5).map(item => `第 ${item.index} 张，文稿第 ${item.line} 行开始：${item.error}`).join("\n")
    + (errors.length > 5 ? "\n更多错误请分页调用 knowledge_diagram_check。" : "");
}
