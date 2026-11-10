/** 把上传资料的完整解析结果汇成需求，同时保留每份原件和图片。 */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { readKnowledgeMaterial, type KnowledgeMaterial } from "./knowledgeMaterials.ts";
import { REQUIREMENT_BUNDLE_ASSET_ROOT, type RequirementAsset, type RequirementImageMime } from "./requirementBundle.ts";

export const REQUIREMENT_SOURCE_ROOT = ".mae-flow-work/requirement-sources";
export const REQUIREMENT_MATERIAL_MAX_COUNT = 30;
export const REQUIREMENT_MATERIAL_MAX_BYTES = 100 * 1024 * 1024;
export const REQUIREMENT_MATERIAL_TEXT_MAX_BYTES = 8 * 1024 * 1024;

export interface RequirementSourceMeta {
  id: string;
  name: string;
  path: string;
  bytes: number;
  digest: string;
  document_count: number;
  locations: string[];
}
export interface RequirementSource extends RequirementSourceMeta { content: Buffer }
export interface RequirementSourcesMeta { sources?: RequirementSourceMeta[] }
export interface ParsedRequirementMaterials {
  requirement: string;
  document_name: string;
  assets: RequirementAsset[];
  sources: RequirementSource[];
  warnings: string[];
}
export class RequirementMaterialsError extends Error {}

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const safeId = (id: string) => /^material-[a-f0-9-]{36}$/.test(id);
const sourcePathPattern = /^\.mae-flow-work\/requirement-sources\/material-[a-f0-9-]{36}\/source\.(md|txt|docx|pdf|xlsx|pptx|zip)$/;
const imageExtensions: Partial<Record<string, { ext: string; mime: RequirementImageMime }>> = {
  "image/png": { ext: ".png", mime: "image/png" }, "image/jpeg": { ext: ".jpg", mime: "image/jpeg" },
  "image/gif": { ext: ".gif", mime: "image/gif" }, "image/webp": { ext: ".webp", mime: "image/webp" },
};

function assertRelativePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f]/.test(path)
      || /^[a-z]:/i.test(path) || path.split("/").some(part => !part || part === "." || part === ".."))
    throw new RequirementMaterialsError(`资料包含不安全路径：${path}`);
  return path;
}

function readRegularFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RequirementMaterialsError("需求原件或图片不是普通文件");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return readFileSync(descriptor); } finally { closeSync(descriptor); }
}

type MaterialSection = KnowledgeMaterial["sections"][number] & { source_path?: string; continuation?: boolean };
interface MaterialDocument { path: string; text: string }

function materialDocuments(material: KnowledgeMaterial): MaterialDocument[] {
  if (!Array.isArray(material.sections)) throw new RequirementMaterialsError(`${material.name} 的解析记录损坏，请重新上传`);
  const documents = new Map<string, MaterialDocument>();
  for (const section of material.sections as MaterialSection[]) {
    if (typeof section.text !== "string" || typeof section.location !== "string" || typeof section.source_path !== "string"
        || typeof section.continuation !== "boolean")
      throw new RequirementMaterialsError(`${material.name} 的解析记录损坏，请重新上传`);
    const path = assertRelativePath(section.source_path);
    let document = documents.get(path);
    if (!document) { document = { path, text: "" }; documents.set(path, document); }
    if (document.text && !section.continuation) throw new RequirementMaterialsError(`${material.name} 的文档片段顺序无效，请重新上传`);
    document.text += section.text;
  }
  const expected = (material as KnowledgeMaterial & { documents?: Array<{ path: string }> }).documents;
  if (expected?.some(row => !documents.get(row.path)?.text.trim()))
    throw new RequirementMaterialsError(`${material.name} 包含没有可读正文的文档，请补充文字或重新解析`);
  if (!documents.size || [...documents.values()].some(document => !document.text.trim()))
    throw new RequirementMaterialsError(`${material.name} 没有可读正文，请补充文字或重新解析`);
  return [...documents.values()];
}

/** 代码块和行内代码中的示例语法不能被当成真实图片或引用。 */
function mapMarkdownProse(text: string, transform: (part: string) => string): string {
  return text.split(/(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)|`+[^`]*`+)/gm)
    .map((part, index) => index % 2 ? part : transform(part)).join("");
}

function rewriteDocumentImages(text: string, resolveImage: (target: string) => string, namespace: string): string {
  const labels = new Set<string>(), imageLabels = new Set<string>();
  const normalized = (label: string) => label.replace(/\s+/g, " ").trim().toLowerCase();
  const labelFor = (label: string) => `${namespace}${label}`;
  mapMarkdownProse(text, part => {
    for (const match of part.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)) labels.add(normalized(match[1]));
    for (const match of part.matchAll(/!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?!\()/g))
      imageLabels.add(normalized(match[2] || match[1]));
    return part;
  });
  return mapMarkdownProse(text, part => {
    part = part.replace(/^([ ]{0,3})\[([^\]\n]+)\]:([^\n]*)/gm, (whole, indent: string, label: string, body: string) => {
      let destination = body;
      if (!label.startsWith("^") && imageLabels.has(normalized(label))) {
        const match = body.match(/^(\s*)(?:<([^>]+)>|((?:\\.|[^\s])+))(.*)$/);
        if (!match) throw new RequirementMaterialsError(`图片引用没有有效地址：${label}`);
        destination = `${match[1]}${resolveImage(match[2] ?? match[3])}${match[4]}`;
      }
      return `${indent}[${label.startsWith("^") ? "^" + labelFor(label.slice(1)) : labelFor(label)}]:${destination}`;
    });
    // 地址可含配对括号和空格（尖括号形式）。
    let output = "", cursor = 0;
    const inline = /!\[((?:\\.|[^\]\\])*)\]\(/g;
    let match: RegExpExecArray | null;
    while ((match = inline.exec(part))) {
      let end = inline.lastIndex, depth = 1, angle = false;
      for (; end < part.length; end++) {
        if (part[end] === "\\") { end++; continue; }
        if (part[end] === "<") angle = true;
        else if (part[end] === ">") angle = false;
        else if (!angle && part[end] === "(") depth++;
        else if (!angle && part[end] === ")" && --depth === 0) break;
      }
      if (depth !== 0) continue;
      const destination = part.slice(inline.lastIndex, end).match(/^\s*(?:<([^>]+)>|((?:\\.|[^\s])+))(.*)$/s);
      if (!destination) throw new RequirementMaterialsError("图片引用没有有效地址");
      output += part.slice(cursor, match.index) + `![${match[1]}](${resolveImage(destination[1] ?? destination[2])}${destination[3]})`;
      cursor = end + 1; inline.lastIndex = cursor;
    }
    part = output + part.slice(cursor);
    part = part.replace(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi, (whole, _quote, target: string) =>
      `![${whole.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "图片"}](${resolveImage(target)})`);
    // 引用定义已更名；正文显式引用、折叠引用、简写引用和脚注也要一起更名。
    part = part.replace(/\[\^([^\]\n]+)\](?!:)/g, (_whole, label: string) => `[^${labelFor(label)}]`);
    part = part.replace(/(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (whole, image: string, text: string, label: string) =>
      labels.has(normalized(label || text)) ? `${image}[${text}][${labelFor(label || text)}]` : whole);
    part = part.replace(/(!?)\[([^\]\n]+)\](?![\[(])/g, (whole, image: string, label: string, offset: number) => {
      if (part[offset - 1] === "]" || label.startsWith("^")) return whole;
      return labels.has(normalized(label)) ? `${image}[${label}][${labelFor(label)}]` : whole;
    });
    return part;
  });
}

export function buildRequirementMaterials(root: string, materialIds: unknown, supplementalText = ""): ParsedRequirementMaterials {
  if (!Array.isArray(materialIds) || !materialIds.length || materialIds.length > REQUIREMENT_MATERIAL_MAX_COUNT
      || materialIds.some(id => typeof id !== "string" || !safeId(id)))
    throw new RequirementMaterialsError("请选择 1 至 30 份有效需求资料");
  if (new Set(materialIds).size !== materialIds.length) throw new RequirementMaterialsError("需求资料重复，请移除重复项");
  if (typeof supplementalText !== "string") throw new RequirementMaterialsError("补充要求必须是文字");
  const assets = new Map<string, RequirementAsset>(), sources: RequirementSource[] = [], warnings: string[] = [];
  const contents = ["# 需求资料\n\n以下资料按上传顺序完整保留，均属于本次需求。"];
  if (supplementalText.trim()) contents.push(`## 补充要求\n\n${rewriteDocumentImages(supplementalText, target => { throw new RequirementMaterialsError(`补充要求的图片需要随资料上传：${target}`); }, "supplement-")}`);
  let total = 0;
  for (const [index, id] of (materialIds as string[]).entries()) {
    const material = readKnowledgeMaterial(root, id);
    if (material.id !== id || material.state !== "ready") throw new RequirementMaterialsError(`${material.name || id} 解析失败，请重新上传：${material.error || "资料不可读"}`);
    const extension = extname(material.name).toLowerCase(), path = `${REQUIREMENT_SOURCE_ROOT}/${id}/source${extension}`;
    if (!sourcePathPattern.test(path)) throw new RequirementMaterialsError(`${material.name} 的原件类型无效`);
    const content = readRegularFile(join(root, id, `source${extension}`));
    if (content.length !== material.bytes || hash(content) !== material.digest) throw new RequirementMaterialsError(`${material.name} 原件校验失败，请重新上传`);
    total += content.length;
    if (total > REQUIREMENT_MATERIAL_MAX_BYTES) throw new RequirementMaterialsError("需求资料总容量不能超过 100 MiB");
    const documents = materialDocuments(material), imagePaths = new Map<string, RequirementAsset>(), referenced = new Set<string>();
    for (const image of material.images ?? []) {
      const imagePath = assertRelativePath(image.path), type = imageExtensions[image.mimeType];
      if (!type || !/^[a-f0-9]{64}$/.test(image.id)) throw new RequirementMaterialsError(`${material.name} 包含不支持的图片：${image.path}`);
      const bytes = readRegularFile(join(root, id, "images", image.id));
      if (bytes.length !== image.bytes || hash(bytes) !== image.id) throw new RequirementMaterialsError(`${material.name} 图片校验失败：${image.path}`);
      const asset: RequirementAsset = { path: `${REQUIREMENT_BUNDLE_ASSET_ROOT}/${image.id.slice(0, 24)}${type.ext}`,
        source_path: `${material.name}/${imagePath}`, mime_type: type.mime, bytes: bytes.length, digest: image.id, content: bytes };
      assets.set(asset.path, asset); imagePaths.set(imagePath, asset);
    }
    const title = material.name.replace(/[\r\n]/g, " ");
    contents.push(`## 资料 ${index + 1}：${title}`);
    for (const [documentIndex, document] of documents.entries()) {
      const transformed = rewriteDocumentImages(document.text, target => {
        let decoded: string;
        try { decoded = decodeURIComponent(target.replace(/\\([\\()[\] ])/g, "$1")); } catch { decoded = target; }
        if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("/") || decoded.startsWith("#"))
          throw new RequirementMaterialsError(`${material.name} 图片需要随资料上传：${target}`);
        const relative = assertRelativePath(posix.normalize(posix.join(posix.dirname(document.path), decoded)));
        const asset = imagePaths.get(relative);
        if (!asset) throw new RequirementMaterialsError(`${material.name} / ${document.path} 引用的图片不存在：${target}`);
        referenced.add(relative); return asset.path;
      }, `material-${index + 1}-document-${documentIndex + 1}-`);
      contents.push(`### 文档：${document.path}\n\n${transformed}`);
    }
    const extraImages = [...imagePaths].filter(([imagePath]) => !referenced.has(imagePath));
    if (extraImages.length) contents.push(`### 资料中的其他图片\n\n${extraImages.map(([imagePath, asset]) => `![${imagePath.replace(/[\[\]]/g, "")}](${asset.path})`).join("\n\n")}`);
    warnings.push(...(material.warnings ?? []).map(warning => `${material.name}：${warning}`));
    sources.push({ id, name: material.name, path, bytes: content.length, digest: material.digest,
      document_count: documents.length, locations: documents.map(document => document.path), content });
  }
  // 原件记录器的摘要只校验它自己的正文，不能让内核拿它校验整个汇编。
  // 保留原件字节及摘要；派生阅读文档只改机器注释的名称。
  const requirement = contents.join("\n\n---\n\n")
    .replace(/<!--\s*MAE-FLOW-USERMSG-SHA256:\s*([0-9a-f]{64})\s*-->/g, "<!-- 原件记录 SHA256: $1 -->");
  if (Buffer.byteLength(requirement) > REQUIREMENT_MATERIAL_TEXT_MAX_BYTES)
    throw new RequirementMaterialsError("解析后的需求正文不能超过 8 MiB，请减少资料或分成独立需求；正文未被截断");
  return { requirement, document_name: "需求资料汇编.md", assets: [...assets.values()], sources, warnings };
}

function sourceLocation(workspace: string, source: RequirementSourceMeta, create = false): string {
  if (!safeId(source.id) || !sourcePathPattern.test(source.path) || source.path.split("/")[2] !== source.id)
    throw new RequirementMaterialsError("需求原件路径无效");
  let directory = workspace;
  for (const segment of source.path.split("/").slice(0, -1)) {
    directory = join(directory, segment);
    if (create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RequirementMaterialsError("需求原件目录不是安全的普通目录");
  }
  return join(workspace, source.path);
}

export function storeRequirementSources(workspace: string, sources: RequirementSource[]): void {
  for (const source of sources) {
    if (source.content.length !== source.bytes || hash(source.content) !== source.digest) throw new RequirementMaterialsError(`需求原件校验失败：${source.name}`);
    const target = sourceLocation(workspace, source, true);
    const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(descriptor, source.content); } finally { closeSync(descriptor); }
  }
}

export function loadRequirementSources(workspace: string, meta: RequirementSourcesMeta | undefined): RequirementSource[] {
  return (meta?.sources ?? []).map(source => {
    const content = readRegularFile(sourceLocation(workspace, source));
    if (content.length !== source.bytes || hash(content) !== source.digest) throw new RequirementMaterialsError(`需求原件已损坏：${source.name}`);
    return { ...source, content };
  });
}

export function materializeRequirementSources(taskWorkspace: string, runtimeWorkspace: string, meta: RequirementSourcesMeta | undefined): void {
  storeRequirementSources(runtimeWorkspace, loadRequirementSources(taskWorkspace, meta));
}

export function readRequirementSource(workspace: string, meta: RequirementSourcesMeta | undefined, requestedPath: string): { meta: RequirementSourceMeta; content: Buffer } | undefined {
  const source = meta?.sources?.find(row => row.path === requestedPath);
  if (!source) return undefined;
  const [{ content }] = loadRequirementSources(workspace, { sources: [source] });
  return { meta: source, content };
}
