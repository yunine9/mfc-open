import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileProjectionCache } from "./fileProjectionCache.ts";
import { durableWriteFileSync } from "./durableWrite.ts";

export interface BusinessModuleMigration {
  source: { id: string; name: string };
  target: { id: string; name: string };
  at: string;
  operator: string;
}
const names = new FileProjectionCache<string>();
const cache = new FileProjectionCache<BusinessModuleMigration[]>();
const path = (dir: string) => join(dir, "business-module-migrations.json");
const validId = (id: unknown) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

export function businessModuleMigrations(dir: string): readonly BusinessModuleMigration[] {
  const file = path(dir);
  if (!existsSync(file)) return [];
  return cache.read(file, () => {
    const records: BusinessModuleMigration[] = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(records) || records.some(row => !validId(row?.source?.id) || !validId(row?.target?.id)
      || !row.source.name || !row.target.name || !row.operator || !Number.isFinite(Date.parse(row.at)))) {
      throw new Error("业务模块迁移记录损坏，请检查 business-module-migrations.json");
    }
    const seen = new Set<string>();
    for (const row of records) {
      if (seen.has(row.source.id) || row.source.id === row.target.id) throw new Error("业务模块迁移记录重复或循环");
      seen.add(row.source.id);
    }
    for (const row of records) resolve(records, row.source.id);
    return records;
  });
}
function resolve(records: readonly BusinessModuleMigration[], id: string) {
  const seen = new Set<string>();
  let current = id;
  while (true) {
    if (seen.has(current)) throw new Error("业务模块迁移记录存在循环");
    seen.add(current);
    const next = records.find(row => row.source.id === current);
    if (!next) return current;
    current = next.target.id;
  }
}
export function resolveBusinessModuleId(dir: string, id: string): string {
  return resolve(businessModuleMigrations(dir), id);
}
export function resolveBusinessModuleIds(dir: string, ids: readonly string[]): string[] {
  const records = businessModuleMigrations(dir);
  return [...new Set(ids.map(id => resolve(records, id)))];
}
export function resolveBusinessModuleRef<T extends { id: string; name: string }>(dir: string, ref: T): T {
  const records = businessModuleMigrations(dir), id = resolve(records, ref.id);
  if (id === ref.id) return ref;
  const target = records.findLast(row => row.target.id === id)!.target;
  const file = join(dir, "business-modules", id, "module.json");
  const name = names.read(file, () => String(JSON.parse(readFileSync(file, "utf8")).name ?? target.name));
  return { ...ref, id, name };
}
/** 一次原子写切换所有关联。正文、执行进度和已发布版本不重写，迟到写入仍按此记录解析归属。 */
export function commitBusinessModuleMigration(dir: string, record: BusinessModuleMigration): void {
  const previous = businessModuleMigrations(dir);
  if (resolve(previous, record.source.id) !== record.source.id || resolve(previous, record.target.id) !== record.target.id
    || record.source.id === record.target.id) throw new Error("模块已迁移，请刷新后重新选择");
  durableWriteFileSync(path(dir), JSON.stringify([...previous, record]), { mode: 0o640 });
}
