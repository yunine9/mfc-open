/**
 * 用户直接提供的 Markdown 需求文档。
 *
 * 小文档可以直接进首轮上下文；长文档必须完整落盘，让 Agent 按章节
 * 读取，不能为了省上下文先让模型做摘要——摘要可能恰好丢掉验收约束。
 */
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RequirementAssetMeta } from "./requirementBundle.ts";
import type { RequirementSourceMeta } from "./requirementMaterials.ts";
import { reanchor, TASK_REQUIREMENT_ARTIFACT } from "./annotations.ts";

export const MAX_REQUIREMENT_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const INLINE_REQUIREMENT_DOCUMENT_BYTES = 32 * 1024;
export const STORED_REQUIREMENT_DOCUMENT = "requirement-input.md";
export const AGENT_REQUIREMENT_DOCUMENT = ".mae-flow-requirement.md";
/** 需求确认阶段每一轮 Agent 修改都留底:改前全文 + 统一 diff。没有这份
 * 底,复检的人只能靠锚点猜"改了什么",要真核对得把整篇重读一遍。 */
export const REQUIREMENT_HISTORY_DIR = "requirement-history";

export interface RequirementDocumentMeta {
  name: string;
  bytes: number;
  context_mode: "inline" | "file";
  bundle_name?: string;
  assets?: RequirementAssetMeta[];
  sources?: RequirementSourceMeta[];
  warnings?: string[];
}

function normalizedName(name: string | undefined): string | undefined {
  const value = name?.trim();
  if (!value) return undefined;
  if (value.length > 160 || /[/\\\0]/.test(value)
      || !value.toLowerCase().endsWith(".md")) {
    throw new Error("设计文档只支持文件名不超过 160 个字符的 .md 文件");
  }
  return value;
}

export function requirementDocumentMeta(
  content: string,
  uploadedName?: string,
  maxBytes = MAX_REQUIREMENT_DOCUMENT_BYTES,
): RequirementDocumentMeta | undefined {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > maxBytes) {
    throw new Error(`设计文档不能超过 ${Math.floor(maxBytes / 1024)} KiB；`
      + "请减少重复内容或拆分为独立需求，不会截断正文");
  }
  const name = normalizedName(uploadedName);
  if (!name && bytes <= INLINE_REQUIREMENT_DOCUMENT_BYTES) return undefined;
  return {
    name: name ?? "需求设计文档.md",
    bytes,
    context_mode: bytes > INLINE_REQUIREMENT_DOCUMENT_BYTES ? "file" : "inline",
  };
}

/** O_NOFOLLOW 避免业务仓预埋同名软链，让宿主写出任务边界。 */
function writeNoFollow(path: string, content: string): void {
  const descriptor = openSync(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
      | (constants.O_NOFOLLOW ?? 0),
    0o600);
  try {
    writeFileSync(descriptor, content, "utf-8");
  } finally {
    closeSync(descriptor);
  }
}

export function storeRequirementDocument(
  workspace: string,
  content: string,
  meta: RequirementDocumentMeta | undefined,
): void {
  if (meta?.context_mode !== "file") return;
  mkdirSync(workspace, { recursive: true });
  writeNoFollow(join(workspace, STORED_REQUIREMENT_DOCUMENT), content);
}

/** 把长文档放进 Agent 可读的工作区。返回的是 prompt/内核配置使用的
 * 相对路径；短文档无需产生平台文件。 */
export function materializeRequirementDocument(
  workspace: string,
  content: string,
  meta: RequirementDocumentMeta | undefined,
  forceFile = false,
): string | undefined {
  if (!forceFile && meta?.context_mode !== "file") return undefined;
  writeNoFollow(join(workspace, AGENT_REQUIREMENT_DOCUMENT), content);
  return AGENT_REQUIREMENT_DOCUMENT;
}

/** 把平台定格的拆分材料带进代码工作区。固定文件名 + O_NOFOLLOW，避免
 * 业务仓预埋同名软链让宿主把已确认方案写到任务边界之外。 */
export function materializeDeliveryDocument(
  workspace: string,
  name: ".mae-flow-chain.md" | ".mae-flow-unit.md" | "chain-plan.md",
  content: string,
): string {
  writeNoFollow(join(workspace, name), content);
  return name;
}

export function storeRequirementRevision(
  workspace: string,
  revisionId: string,
  before: string,
  diff: string,
): void {
  const dir = join(workspace, REQUIREMENT_HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  writeNoFollow(join(dir, `${revisionId}.before.md`), before);
  writeNoFollow(join(dir, `${revisionId}.diff`), diff);
}

export function readRequirementRevision(
  workspace: string,
  revisionId: string,
): { before: string; diff: string } | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(revisionId)) return undefined;
  const dir = join(workspace, REQUIREMENT_HISTORY_DIR);
  try {
    return {
      before: readFileSync(join(dir, `${revisionId}.before.md`), "utf-8"),
      diff: readFileSync(join(dir, `${revisionId}.diff`), "utf-8"),
    };
  } catch {
    return undefined;
  }
}

function headings(content: string): string[] {
  return content.split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 40);
}

export function requirementContext(
  content: string,
  meta: RequirementDocumentMeta | undefined,
  readablePath?: string,
): string {
  const sourceInstruction = meta?.sources?.length
    ? `本需求由 ${meta.sources.length} 份上传资料共同构成，没有主文档。当前需求正文已完整收录各份资料的解析文字，并可能包含人工批注确认后的修改。请逐份核对来源章节、约束和验收标准，不得只读第一份或目录；原件仅供核对，不得用原件覆盖当前需求中的修改。\n`
      + meta.sources.map((source, index) => `${index + 1}. ${source.name}（原件：${source.path}）`).join("\n")
    : "";
  const imageInstruction = meta?.assets?.length
    ? `需求文档包含 ${meta.assets.length} 张必须核对的图片。图片已在工作区按 Markdown 相对路径落盘；请使用 InspectImage 逐张读取（单次最多 4 张时分批），不得只根据文件名猜测。`
    : "";
  if (meta?.context_mode !== "file") {
    return [sourceInstruction, content, imageInstruction].filter(Boolean).join("\n\n");
  }
  const outline = headings(content);
  const preview = content.slice(0, 2_400).trimEnd();
  return [
    `当前需求文档较长（${meta.name}，`
      + `${meta.bytes} 字节），完整正文保存在 ${readablePath
        ?? AGENT_REQUIREMENT_DOCUMENT}。`,
    sourceInstruction,
    "这份文件是需求原文，不是可选参考。先读取标题结构，再用 Read 的"
      + " offset/limit 按章节分段阅读；不要一次回显全文，也不要只看开头。"
      + "背景、范围、约束和验收标准都必须核对，后续需要时可再次读取原文。",
    outline.length ? `文档标题提纲：\n${outline.map((item) => `- ${item}`).join("\n")}`
      : "文档没有 Markdown 标题；请按段落分批读取完整文件。",
    `开头预览（只用于定位，不代替全文）：\n${preview}`,
    imageInstruction,
  ].join("\n\n");
}

/** 给 Agent 的行号与页面定位保持一致；只调整本轮副本，不改写历史坐标。 */
function requirementAnnotationChecks(content: string,
  annotations: ReadonlyArray<{ anchor: string; quote?: string; line: number; line_end?: number }>) {
  return reanchor(annotations.map((item, index) => ({
    ...item, id: String(index), artifact: TASK_REQUIREMENT_ARTIFACT,
  })), () => content);
}

export function reanchorRequirementAnnotations<T extends { anchor: string; quote?: string; line: number; line_end?: number }>(
  content: string, annotations: readonly T[],
): T[] {
  const checks = requirementAnnotationChecks(content, annotations);
  return annotations.map((item, index) => {
    const check = checks[index];
    if (!["hit", "moved"].includes(check.state) || check.line === undefined) return { ...item };
    const delta = check.line - item.line;
    return { ...item, line: check.line,
      ...(item.line_end && item.line_end >= item.line ? { line_end: check.line_end ?? item.line_end + delta } : {}) };
  });
}
