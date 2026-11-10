import { createHash, randomUUID } from "node:crypto";
import { convertDocument, type DocumentSection, type DocumentImage } from "./documentConversion.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanForSecrets } from "./hostSkillLibrary.ts";

export interface KnowledgeMaterial {
  id: string; name: string; scope: string; version: string; bytes: number; digest: string;
  state: "ready" | "failed"; error?: string; sections: DocumentSection[];
  uploaded_at?: string; warnings?: string[];
  images?: DocumentImage[];
  documents?: Array<{ path: string }>;
}
const supported = new Set([".md", ".txt", ".docx", ".pdf", ".xlsx", ".pptx", ".zip"]);
export async function saveKnowledgeMaterial(root: string, input: { name: string; content_base64: string; scope?: string; version?: string }, signal?: AbortSignal): Promise<KnowledgeMaterial> {
  if (!input || typeof input.name !== "string" || input.name.length > 180 || /[\x00-\x1f/\\]/.test(input.name) || !supported.has(extname(input.name).toLowerCase()))
    throw new Error("支持 Markdown、文本、DOCX、PDF、XLSX、PPTX、ZIP，请使用有效文件名");
  if (typeof input.content_base64 !== "string" || input.content_base64.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64)) throw new Error("资料编码无效或超过 20 MiB");
  const bytes = Buffer.from(input.content_base64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("资料不能为空且不能超过 20 MiB");
  const record: KnowledgeMaterial = { id: `material-${randomUUID()}`, name: input.name, scope: String(input.scope ?? "本次萃取任务").slice(0, 500), version: String(input.version ?? "").slice(0, 100), uploaded_at: new Date().toISOString(), bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), state: "failed", sections: [] };
  const folder = join(root, record.id); mkdirSync(folder, { recursive: true });
  const file = join(folder, `source${extname(input.name).toLowerCase()}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  try {
    const parsed = await convertDocument(file, { name: input.name, signal });
    scanForSecrets(input.name, Buffer.from(JSON.stringify(parsed)));
    Object.assign(record, parsed);
    if (!record.sections.some(s => s.text.trim()) && !record.images?.length) throw new Error("未提取到可读文本或图片，请补充可检索文档或 OCR 结果");
    record.state = "ready";
  } catch (error) { record.error = signal?.aborted ? "资料解析已取消" : error instanceof Error ? error.message : "资料解析失败"; }
  finally {
    for (const entry of readdirSync(folder)) if (/^parse-(?:pdf|document|bundle)-/.test(entry)) rmSync(join(folder, entry), { recursive: true, force: true });
    if (record.state === "failed") { rmSync(join(folder, "images"), { recursive: true, force: true }); record.sections = []; record.images = []; record.documents = []; }
  }
  writeFileSync(join(folder, "material.json"), JSON.stringify(record), { mode: 0o600 });
  return record;
}
export function readKnowledgeMaterial(root: string, id: string): KnowledgeMaterial {
  if (!/^material-[a-f0-9-]{36}$/.test(id) || !existsSync(join(root, id, "material.json"))) throw new Error("资料不存在");
  return JSON.parse(readFileSync(join(root, id, "material.json"), "utf8"));
}
export function readKnowledgeMaterialImage(root: string, id: string, imagePath: string): { asset: DocumentImage; content: Buffer } {
  const material = readKnowledgeMaterial(root, id);
  const asset = material.state === "ready" && material.images?.find(image => image.path === imagePath);
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.id) || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.mimeType))
    throw new Error("图片不在本次资料中，或资料解析失败");
  const content = readFileSync(join(root, id, "images", asset.id));
  if (content.length !== asset.bytes || content.length > 10 * 1024 * 1024 || createHash("sha256").update(content).digest("hex") !== asset.id)
    throw new Error("图片文件不完整或已改变，请重新上传资料");
  return { asset, content };
}
export function knowledgeMaterialTool(materials: KnowledgeMaterial[], root?: string, observe?: (event: Record<string, unknown>) => unknown) {
  return defineTool({
    name: "knowledge_material", label: "读取上传资料",
    description: "列出本任务上传资料、解析警告、章节和图片路径；按资料编号及章节序号读取正文。用 id + image_path 读取图片内容，每次一张。Markdown 相对图片链接按章节 source_path 所在目录对应到图片路径，不能仅凭文件名推断图片内容。未填写的版本为未知，上传时间不代表业务版本。",
    parameters: Type.Object({ id: Type.Optional(Type.String()), start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), image_path: Type.Optional(Type.String()) }),
    async execute(_id: string, input: { id?: string; start?: number; count?: number; image_path?: string }, _signal?: AbortSignal, _onUpdate?: unknown, context?: Pick<ExtensionContext, "model">) {
      const material = materials.find(m => m.id === input.id);
      if (input.image_path !== undefined) {
        const asset = material?.state === "ready" && material.images?.find(i => i.path === input.image_path);
        if (!root || !material || !/^material-[a-f0-9-]{36}$/.test(material.id) || !asset || !/^[a-f0-9]{64}$/.test(asset.id))
          return { content: [{ type: "text" as const, text: "图片不在本次资料中，或资料解析失败" }], details: {}, isError: true };
        if (context?.model && !context.model.input.includes("image"))
          return { content: [{ type: "text" as const, text: "当前萃取模型不支持图片，尚未读取该图片；请在模型配置中使用支持图片的模型，或补充文字说明。不能推断图中内容。" }], details: {}, isError: true };
        try {
          const data = readKnowledgeMaterialImage(root, material.id, asset.path).content.toString("base64");
          const evidenceId = observe?.({ tool: "knowledge_material", action: "image", status: "returned", material_id: material.id, name: material.name, digest: material.digest, version: material.version, image_path: asset.path });
          return { content: [{ type: "text" as const, text: `${material.name} / ${asset.path}${typeof evidenceId === "string" ? `\n证据编号：${evidenceId}` : ""}` },
            { type: "image" as const, data, mimeType: asset.mimeType }], details: {} };
        } catch { return { content: [{ type: "text" as const, text: "图片文件不可读，请重新上传资料" }], details: {}, isError: true }; }
      }
      let data: unknown;
      if (!input.id) data = materials.map(({ sections, ...rest }) => ({ ...rest, sections: sections.map((s, i) => ({ index: i + 1, location: s.location, characters: s.text.length })) }));
      else if (!material) return { content: [{ type: "text" as const, text: "资料不在本次研究范围" }], details: {}, isError: true };
      else {
        const sections = material.sections.slice((input.start ?? 1) - 1, (input.start ?? 1) - 1 + Math.min(input.count ?? 1, 10));
        const evidenceId = material.state === "ready" && sections.some(s => s.text.trim()) ? observe?.({ tool: "knowledge_material", action: "read", status: "returned",
          material_id: material.id, name: material.name, digest: material.digest, version: material.version, locations: sections.map(s => s.location) }) : undefined;
        data = { ...material, sections, ...(typeof evidenceId === "string" ? { evidence_id: evidenceId } : {}) };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} };
    },
  });
}
