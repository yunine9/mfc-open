import { createRequire } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeProcessError, runKnowledgeCommand } from "./knowledgeProcess.ts";

export interface DocumentSection {
  location: string;
  text: string;
  source_path?: string;
  /** 连续片段直接拼接，不能在 Markdown 链接或表格中间补换行。 */
  continuation?: boolean;
}
export interface DocumentImage { id: string; path: string; mimeType: string; bytes: number }
export interface ConvertedDocument {
  sections: DocumentSection[];
  images: DocumentImage[];
  warnings: string[];
  documents: Array<{ path: string }>;
}

/** 图片随资料保存到同级 images/<摘要>，不依赖转换器的临时缓存。 */
export async function convertDocument(file: string, options: { name: string; signal?: AbortSignal }): Promise<ConvertedDocument> {
  let raw: string;
  try {
    raw = await runKnowledgeCommand(process.env.MAE_FLOW_PYTHON_BIN || "python3",
      [fileURLToPath(new URL("../scripts/parse-knowledge-material.py", import.meta.url)), file, options.name], {
        signal: options.signal, timeoutMs: 60_000, maxBytes: (extname(file).toLowerCase() === ".zip" ? 128 : 8) * 1024 * 1024,
        env: { ...process.env, MAE_FLOW_NODE_BIN: process.execPath,
          MAE_FLOW_ANYMD_LAUNCHER: createRequire(import.meta.url).resolve("@sylphx/anymd/bin/anymd.js") },
      });
  } catch (error) {
    const code = error instanceof KnowledgeProcessError ? error.code : undefined;
    throw new Error(options.signal?.aborted || code === "cancelled" ? "资料解析已取消"
      : code === "timeout" ? "资料解析超过 60 秒，请拆分资料后重试"
      : code === "output_limit" ? "资料解析结果过大，请拆分资料后重试"
      : "资料解析器不可用，请检查 Python 3 与 anymd 的当前系统原生依赖是否已安装");
  }
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(String(parsed.error));
  if (!Array.isArray(parsed.sections) || !Array.isArray(parsed.images) || !Array.isArray(parsed.warnings)
    || !Array.isArray(parsed.documents) || parsed.sections.some((section: DocumentSection) => typeof section.location !== "string" || typeof section.text !== "string"))
    throw new Error("资料解析结果无效，请检查解析器");
  return parsed;
}
