/** 团队维护的技术栈目录；编号固定，名称和可选状态可调整。 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { durableWriteFileSync } from "./durableWrite.ts";
import { knowledgeLanguageLabel, normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { readSkillKnowledgeMetadata } from "./knowledgeAssetModel.ts";

export interface TechnologyStack { id: string; name: string; enabled: boolean }
export class TechnologyStackError extends Error {}
const FILE = "technology-stacks.json";
const AUDIT = "technology-stack-operations.jsonl";
const ID = /^[a-z][a-z0-9.+#-]{0,31}$/;
const RESERVED = new Set(["agnostic", "all", "untagged", "general", "language-agnostic", "通用", "语言无关", "通用 / 语言无关", "全部", "未标注"]);

function nameOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80
      || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TechnologyStackError("技术栈名称必填，最多 80 字符，不能包含控制字符");
  }
  const name = value.trim();
  if (RESERVED.has(name.toLowerCase())) {
    throw new TechnologyStackError("该名称用于范围筛选，不能作为技术栈");
  }
  return name;
}

/** 稳定编号不做语言别名转换，避免目录改名影响已有关联。 */
export function normalizeTechnologyStackIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new TechnologyStackError("技术栈必须是数组，最多选择 8 项");
  }
  return [...new Set(value.map((item) => {
    if (typeof item !== "string" || !ID.test(item.trim().toLowerCase())
        || RESERVED.has(item.trim().toLowerCase())) {
      throw new TechnologyStackError(`技术栈编号不合法：${String(item)}`);
    }
    return item.trim().toLowerCase();
  }))];
}

function canonicalId(value: unknown): string {
  const id = normalizeTechnologyStackIds([value])[0];
  const normalized = normalizeKnowledgeLanguages([id])[0];
  if (normalized !== id) {
    throw new TechnologyStackError(`技术栈编号请使用 ${normalized}，避免与已有标签产生不同关联`);
  }
  return id;
}

function ordinaryFile(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new TechnologyStackError("技术栈配置或迁移来源不是普通文件");
  }
}

function readJson(path: string): unknown {
  ordinaryFile(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

function write(dataDir: string, rows: TechnologyStack[], operation: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  const audit = join(dataDir, AUDIT);
  if (existsSync(audit)) ordinaryFile(audit);
  durableWriteFileSync(join(dataDir, FILE), `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  appendFileSync(audit, `${JSON.stringify({ at: new Date().toISOString(), ...operation })}\n`, { mode: 0o600 });
}

/** 只在首次部署目录时读取历史标签，避免依赖会反向校验目录的业务服务。 */
function initialize(dataDir: string): TechnologyStack[] {
  const ids = new Set<string>();
  const warnings: string[] = [];
  const collect = (value: unknown) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new TechnologyStackError("已有技术标签格式错误，请修复来源后重试");
    }
    for (const raw of value) {
      if (RESERVED.has(raw.trim().toLowerCase())) continue;
      const id = normalizeKnowledgeLanguages([raw])[0];
      if (!RESERVED.has(id)) ids.add(id);
    }
  };
  for (const [file, field] of [["component-repositories.json", "languages"],
    ["repository-profiles/profiles.json", "technologies"]]) {
    const path = join(dataDir, file);
    if (!existsSync(path)) continue;
    const rows = readJson(path);
    if (!Array.isArray(rows)) throw new TechnologyStackError(`迁移来源 ${file} 格式错误`);
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new TechnologyStackError(`迁移来源 ${file} 格式错误`);
      collect(row[field]);
    }
  }
  const documents = join(dataDir, "knowledge-documents");
  if (existsSync(documents)) {
    if (lstatSync(documents).isSymbolicLink() || !lstatSync(documents).isDirectory()) {
      throw new TechnologyStackError("知识文档迁移来源不是普通目录");
    }
    for (const file of readdirSync(documents).filter((name) => /^kd-[a-f0-9-]{36}\.json$/.test(name))) {
      if (existsSync(join(dataDir, "knowledge-deletions", file))) continue;
      const row = readJson(join(documents, file));
      if (!row || typeof row !== "object") throw new TechnologyStackError("知识文档迁移来源格式错误");
      collect((row as { technologies?: unknown }).technologies);
    }
  }
  const skills = join(dataDir, "skills");
  const walkSkills = (dir: string, depth: number) => {
    if (depth > 8 || !existsSync(dir) || lstatSync(dir).isSymbolicLink()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walkSkills(path, depth + 1);
      else if (entry.isFile() && (entry.name === "SKILL.md" || depth === 0 && entry.name.endsWith(".md"))) {
        try { collect(readSkillKnowledgeMetadata(readFileSync(path, "utf8")).technologies); }
        catch { warnings.push(`未读取无效 Skill 标签：${relative(dataDir, path)}`); }
      }
    }
  };
  walkSkills(skills, 0);
  const workflows = join(dataDir, "workflow-assets");
  if (existsSync(workflows)) {
    if (lstatSync(workflows).isSymbolicLink() || !lstatSync(workflows).isDirectory()) {
      throw new TechnologyStackError("工作流迁移来源不是普通目录");
    }
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const file of ["asset.json", "draft.json"]) {
        const path = join(workflows, entry.name, file);
        if (!existsSync(path)) continue;
        const row = readJson(path) as { applicability?: { technologies?: unknown }; definition?: { applicability?: { technologies?: unknown } } };
        if (!row || typeof row !== "object") throw new TechnologyStackError("工作流迁移来源格式错误");
        collect(file === "draft.json" ? row.definition?.applicability?.technologies : row.applicability?.technologies);
      }
    }
  }
  const rows = [...ids].sort().map((id) => ({ id, name: knowledgeLanguageLabel(id), enabled: true }));
  write(dataDir, rows, { action: "initialize", operator: "系统迁移", stacks: rows, ...(warnings.length ? { warnings } : {}) });
  return rows;
}

export function listTechnologyStacks(dataDir: string): TechnologyStack[] {
  const path = join(dataDir, FILE);
  if (!existsSync(path)) return initialize(dataDir);
  try {
    const value = readJson(path);
    if (!Array.isArray(value)) throw new Error("not an array");
    const ids = new Set<string>(), names = new Set<string>();
    return value.map((row) => {
      if (!row || typeof row !== "object" || typeof row.enabled !== "boolean") throw new Error("invalid row");
      const id = canonicalId(row.id), name = nameOf(row.name);
      if (id !== row.id || name !== row.name || ids.has(id) || names.has(name.toLowerCase())) throw new Error("duplicate or invalid row");
      ids.add(id); names.add(name.toLowerCase());
      return { id, name, enabled: row.enabled };
    });
  } catch {
    throw new TechnologyStackError("技术栈配置文件损坏，请修复后重试；原文件未改动");
  }
}

export function requireTechnologyStacks(dataDir: string, value: unknown,
  options: { allowDisabled?: boolean } = {}): string[] {
  const ids = normalizeTechnologyStackIds(value);
  const rows = new Map(listTechnologyStacks(dataDir).map((row) => [row.id, row]));
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) throw new TechnologyStackError(`技术栈 ${id} 尚未登记，请先在配置中心添加`);
    if (!row.enabled && !options.allowDisabled) throw new TechnologyStackError(`技术栈「${row.name}」已停用，请重新选择`);
  }
  return ids;
}

/** 停用只影响新选择；已有资源调整正文或名称时保留其关联。 */
export function requireTechnologyStackChanges(dataDir: string, value: unknown, previous: string[] = []): string[] {
  const ids = requireTechnologyStacks(dataDir, value, { allowDisabled: true });
  const existing = new Set(previous);
  requireTechnologyStacks(dataDir, ids.filter((id) => !existing.has(id)));
  return ids;
}

export function createTechnologyStack(dataDir: string, input: { name?: unknown; id?: unknown }, operator: string): TechnologyStack {
  const rows = listTechnologyStacks(dataDir), name = nameOf(input.name);
  let id: string;
  if (input.id !== undefined) id = canonicalId(input.id);
  else {
    try { id = canonicalId(normalizeKnowledgeLanguages([name])[0]); }
    catch { id = `stack-${randomUUID().slice(0, 8)}`; }
  }
  if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) throw new TechnologyStackError("技术栈名称已存在，请编辑已有条目");
  if (rows.some((row) => row.id === id)) {
    if (input.id !== undefined) throw new TechnologyStackError("技术栈编号已存在，请编辑已有条目");
    // 不同技术栈可以共享旧语言别名（例如 JavaScript 与 NodeJS），名称不强制合并。
    do { id = `stack-${randomUUID().slice(0, 8)}`; } while (rows.some((row) => row.id === id));
  }
  const stack = { id, name, enabled: true };
  write(dataDir, [...rows, stack], { action: "create", operator, stack });
  return stack;
}

export function updateTechnologyStack(dataDir: string, id: string,
  input: { name?: unknown; enabled?: unknown; id?: unknown }, operator: string): TechnologyStack {
  const rows = listTechnologyStacks(dataDir), previous = rows.find((row) => row.id === id);
  if (!previous) throw new TechnologyStackError("技术栈不存在，请刷新列表");
  if (input.id !== undefined && input.id !== id) throw new TechnologyStackError("技术栈编号不能修改");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new TechnologyStackError("技术栈启用状态必须是布尔值");
  const name = input.name === undefined ? previous.name : nameOf(input.name);
  if (rows.some((row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) throw new TechnologyStackError("技术栈名称已存在，请编辑已有条目");
  const stack = { id, name, enabled: input.enabled === undefined ? previous.enabled : input.enabled as boolean };
  write(dataDir, rows.map((row) => row.id === id ? stack : row), { action: "update", operator, previous, stack });
  return stack;
}

/** 关联清理服务完成全部更新后再移除目录条目；失败时保留条目供重试。 */
export function removeTechnologyStack(dataDir: string, id: string, operator: string): void {
  const rows = listTechnologyStacks(dataDir), previous = rows.find((row) => row.id === id);
  if (!previous) return;
  write(dataDir, rows.filter((row) => row.id !== id), { action: "delete", operator, previous });
}
