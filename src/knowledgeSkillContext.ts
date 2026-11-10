import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeAssetMetadata } from "./knowledgeAssetModel.ts";

function contextPath(dataDir: string, id: string) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Skill 任务编号无效");
  return join(dataDir, "knowledge-skill-context", `${id}.json`);
}
export function saveKnowledgeSkillContext(dataDir: string, id: string, metadata: KnowledgeAssetMetadata) {
  mkdirSync(join(dataDir, "knowledge-skill-context"), { recursive: true });
  writeFileSync(contextPath(dataDir, id), JSON.stringify(metadata), { mode: 0o600 });
}
export function readKnowledgeSkillContext(dataDir: string, id: string): KnowledgeAssetMetadata | undefined {
  const path = contextPath(dataDir, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as KnowledgeAssetMetadata : undefined;
}
