import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KnowledgeDeletion {
  id: string; title: string; revision: string; at: string; operator: string;
  research_job_id?: string;
  index_ids: string[]; index_state: "pending" | "removed";
}
const root = (dir: string) => join(dir, "knowledge-deletions");
function path(dir: string, id: string) {
  if (!/^kd-[a-f0-9-]{36}$/.test(id)) throw new Error("知识文档编号无效");
  return join(root(dir), `${id}.json`);
}
export function knowledgeDeleted(dir: string, id: string) { return existsSync(path(dir, id)); }
export function readKnowledgeDeletion(dir: string, id: string): KnowledgeDeletion | undefined {
  const file = path(dir, id);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}
export function listKnowledgeDeletions(dir: string): KnowledgeDeletion[] {
  return existsSync(root(dir)) ? readdirSync(root(dir)).filter(n => /^kd-[a-f0-9-]{36}\.json$/.test(n))
    .map(n => readKnowledgeDeletion(dir, n.slice(0, -5))!) : [];
}
export function writeKnowledgeDeletion(dir: string, record: KnowledgeDeletion) {
  mkdirSync(root(dir), { recursive: true });
  const target = path(dir, record.id), temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o640 }); renameSync(temp, target);
}
