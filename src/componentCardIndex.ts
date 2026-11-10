import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = (dir: string) => join(dir, "component-card-indexes");
const file = (dir: string, id: string) => join(root(dir), `${createHash("sha256").update(id).digest("hex")}.json`);
export function componentIndexSources(dir: string, id: string): string[] | undefined {
  const path = file(dir, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).sources : undefined;
}
export function componentIndexDocuments(dir: string): string[] {
  return existsSync(root(dir)) ? readdirSync(root(dir)).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(root(dir), n), "utf8")).id) : [];
}
export function saveComponentIndexSources(dir: string, id: string, sources: string[]) {
  mkdirSync(root(dir), { recursive: true });
  const path = file(dir, id), temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ id, sources: [...new Set(sources)] }), { mode: 0o640 }); renameSync(temp, path);
}
export function removeComponentIndexSources(dir: string, id: string) { rmSync(file(dir, id), { force: true }); }
