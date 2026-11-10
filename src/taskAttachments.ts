/** 需求对话附件按任务保存；Agent 的运行目录重建时恢复相同相对路径。 */
import { unlinkSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { stageAttachmentStream } from "./attachmentUpload.ts";

export const TASK_ATTACHMENT_ROOT = ".mae-flow-work/attachments";
const STORE = "conversation-attachments";
export interface TaskAttachment { path: string; name: string; bytes: number }
function filename(path: string): string {
  const match = /^\.mae-flow-work\/attachments\/([a-f0-9]{16}\.[a-z0-9]{1,12})$/.exec(path);
  if (!match) throw new Error("附件路径无效");
  return match[1];
}
function safeDirectory(root: string, parts: string[]): string {
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    if (!existsSync(target)) mkdirSync(target);
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error("附件目录不可用");
  }
  return target;
}
function mirror(workspace: string, runtime: string, name: string): void {
  const dir = safeDirectory(runtime, TASK_ATTACHMENT_ROOT.split("/"));
  const target = join(dir, name);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("附件目标不能是软链接");
  copyFileSync(join(workspace, STORE, name), target);
}
export async function storeTaskAttachment(workspace: string, runtime: string | undefined, request: IncomingMessage, name: string): Promise<TaskAttachment> {
  safeDirectory(workspace, ["conversation-attachment-staging"]);
  const staged = await stageAttachmentStream(request, { dataDir: workspace, filename: name, stagingDir: "conversation-attachment-staging" });
  const file = staged.path.split("/")[1];
  const store = safeDirectory(workspace, [STORE]);
  const source = join(workspace, "conversation-attachment-staging", file);
  if (!staged.bytes) { unlinkSync(source); throw new Error("附件是空文件"); }
  renameSync(source, join(store, file));
  const meta = { path: `${TASK_ATTACHMENT_ROOT}/${file}`, name: name.split(/[\\/]/).pop()?.replace(/[\r\n]/g, " ") || file, bytes: staged.bytes };
  writeFileSync(join(store, `${file}.json`), JSON.stringify(meta));
  if (runtime) mirror(workspace, runtime, file);
  return meta;
}
export function materializeTaskAttachments(workspace: string, runtime: string): void {
  const store = join(workspace, STORE);
  if (!existsSync(store)) return;
  for (const name of readdirSync(store)) {
    if (/^[a-f0-9]{16}\.[a-z0-9]{1,12}$/.test(name)) mirror(workspace, runtime, name);
  }
}
export function taskAttachment(workspace: string, path: string): { meta: TaskAttachment; file: string } {
  const name = filename(path);
  const file = join(workspace, STORE, name);
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("附件不存在，请重新上传");
  return { meta: JSON.parse(readFileSync(`${file}.json`, "utf8")), file };
}
export function taskAttachmentContext(workspace: string, runtime: string | undefined, id: string, text: string, paths: unknown): string {
  if (paths === undefined) return text;
  if (!Array.isArray(paths) || paths.length > 10 || paths.some(path => typeof path !== "string")) throw new Error("一次最多附加 10 个文件");
  if (!paths.length) return text;
  const lines = [...new Set(paths)].map(path => {
    const { meta } = taskAttachment(workspace, path);
    if (runtime) mirror(workspace, runtime, filename(path));
    const label = meta.name.replace(/[\[\]<>]/g, "_");
    return `- [${label}](/tasks/${encodeURIComponent(id)}/attachments?path=${encodeURIComponent(path)}) (${meta.bytes} bytes)，Agent 工作区路径：\`${path}\``;
  });
  return [text, "[用户上传的日志附件]", ...lines,
    "先读取附件，结合本任务代码分析，结论引用文件和关键行。大文件先搜索再分段读取；压缩包先用容器已有的 unzip、tar 或 python3 等工具列目录，将需要的日志解压到 .mae-flow-work/attachment-analysis/ 后读取，不覆盖代码或执行包内程序。按用户本次要求分析或修复，读取、解压失败时明确说明原因。"].filter(Boolean).join("\n\n");
}
