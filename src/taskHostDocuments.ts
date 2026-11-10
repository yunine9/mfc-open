/** Reuse the artifact catalogue while accepting the short names used in chat. */
import { join } from "node:path";
import { listArtifactDocuments } from "./artifacts.ts";
import { assertTaskReadRoot } from "./taskHostDiagnostics.ts";

export async function readTaskHostDocument(input: {
  workspace: string; root?: string; name: string;
  read(name: string): Promise<string | undefined>;
}): Promise<string | undefined> {
  for (const root of [input.root, input.root && join(input.root, ".mae-flow-work"), join(input.workspace, "pipeline")]) {
    if (root) assertTaskReadRoot(input.workspace, root);
  }
  const direct = await input.read(input.name);
  if (direct !== undefined) return direct;
  const names = listArtifactDocuments(input.root, { taskMaterialRoot: input.workspace }).map(doc => doc.name);
  const candidates = names.filter(name => name.endsWith(`/${input.name}`));
  if (candidates.length === 1) return input.read(candidates[0]);
  throw new Error(`${candidates.length > 1 ? "存在同名文档，请使用完整名称" : "文档尚不存在"}；可用文档：${names.slice(0, 30).join("、") || "尚未生成"}`);
}
