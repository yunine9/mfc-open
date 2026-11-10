/** 删除配置项时清理当前关联，不改写任务快照与已发布历史版本。 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { durableWriteFileSync } from "./durableWrite.ts";
import { clearSkillTechnology } from "./knowledgeAssetModel.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { knowledgeDeleted } from "./knowledgeDeletionStore.ts";
import { readKnowledgeDocument, prepareKnowledgeDocument, writePreparedKnowledgeDocument } from "./knowledgeDocuments.ts";
import { listTechnologyStacks, normalizeTechnologyStackIds, removeTechnologyStack } from "./technologyStacks.ts";
import { WorkflowAssetLibrary } from "./workflowAssetLibrary.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function ordinary(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`关联来源不是普通${directory ? "目录" : "文件"}：${path}`);
  }
}

function read(path: string): string { ordinary(path); return readFileSync(path, "utf8"); }

function references(value: unknown, technologyId: string): { values: string[]; changed: boolean } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("技术栈关联必须是字符串数组");
  }
  const values = value.filter((item) => {
    try { return normalizeKnowledgeLanguages([item])[0] !== technologyId; }
    catch { return item !== technologyId; }
  });
  return { values, changed: values.length !== value.length };
}

/** 同步预读、逐项写入、最后删除目录项。失败可重复调用同一个 DELETE。 */
export function deleteTechnologyStack(dataDir: string, technologyId: string, operator: string): void {
  const id = normalizeTechnologyStackIds([technologyId])[0];
  const operations: Array<() => void> = [];
  const changed: string[] = [];
  const auditPath = join(dataDir, "technology-stack-operations.jsonl");
  const audit = (detail: Record<string, unknown>) => {
    if (existsSync(auditPath)) ordinary(auditPath);
    appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), operator,
      technology_id: id, ...detail })}\n`, { mode: 0o600 });
  };
  const planText = (path: string, before: string, after: string) => {
    if (before === after) return;
    const source = relative(dataDir, path);
    changed.push(source);
    operations.push(() => {
      if (read(path) !== before) throw new Error(`关联在清理前已变化：${source}`);
      // 元数据文件保留修改前副本，失败重试和人工恢复均有明确依据。
      const backupRoot = join(dataDir, "technology-stack-deletion-backups");
      if (existsSync(backupRoot)) ordinary(backupRoot, true);
      const backupDir = join(backupRoot, id);
      if (existsSync(backupDir)) ordinary(backupDir, true);
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const backup = join(backupDir, `${hash(source + "\0" + before)}.txt`);
      if (!existsSync(backup)) durableWriteFileSync(backup, before, { mode: 0o600 });
      else if (read(backup) !== before) throw new Error(`关联备份不一致：${source}`);
      audit({ action: "clear_references", source, backup: relative(dataDir, backup),
        previous_digest: hash(before), next_digest: hash(after) });
      durableWriteFileSync(path, after, { mode: lstatSync(path).mode & 0o777 });
    });
  };
  const planRows = (path: string, field: string, empty: (row: Record<string, unknown>) => void) => {
    if (!existsSync(path)) return;
    ordinary(dirname(path), true);
    const before = read(path);
    const rows = JSON.parse(before);
    if (!Array.isArray(rows)) throw new Error(`关联来源格式错误：${relative(dataDir, path)}`);
    let anyChanged = false;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("关联记录格式错误");
      const result = references(row[field], id);
      if (!result.changed) continue;
      row[field] = result.values;
      if (!result.values.length) empty(row);
      anyChanged = true;
    }
    if (anyChanged) planText(path, before, `${JSON.stringify(rows, null, 2)}\n`);
  };
  try {
    // 也校验目录文件本身；目录项已删除的重试仍会完成剩余关联清理。
    listTechnologyStacks(dataDir);
    planRows(join(dataDir, "component-repositories.json"), "languages", (row) => { row.enabled = false; });
    planRows(join(dataDir, "repository-profiles", "profiles.json"), "technologies", (row) => { row.confirmed = false; });

    const documents = join(dataDir, "knowledge-documents");
    if (existsSync(documents)) {
      ordinary(documents, true);
      for (const name of readdirSync(documents).filter((name) => /^kd-[a-f0-9-]{36}\.json$/.test(name))) {
        const documentId = name.slice(0, -5);
        if (knowledgeDeleted(dataDir, documentId)) continue;
        ordinary(join(documents, name));
        const document = readKnowledgeDocument(dataDir, documentId);
        const result = references(document.technologies, id);
        if (!result.changed) continue;
        const prepared = prepareKnowledgeDocument(dataDir, { technologies: result.values,
          ...(!result.values.length ? { active: false } : {}) }, operator, document.id,
        { expectedRevision: document.revision,
          ...(!result.values.length ? { technologyAssignmentRequired: true as const } : {}) });
        changed.push(`knowledge-documents/${name}`);
        operations.push(() => { writePreparedKnowledgeDocument(dataDir, prepared); });
      }
    }

    const skills = join(dataDir, "skills");
    const walk = (dir: string, depth: number) => {
      ordinary(dir, true);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Skill 关联来源含软链接：${relative(dataDir, path)}`);
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.name === "SKILL.md" || (depth === 0 && entry.name.endsWith(".md"))) {
          const before = read(path);
          planText(path, before, clearSkillTechnology(before, id));
        }
      }
    };
    if (existsSync(skills)) walk(skills, 0);

    const workflows = join(dataDir, "workflow-assets");
    if (existsSync(workflows)) {
      ordinary(workflows, true);
      const library = new WorkflowAssetLibrary(dataDir);
      for (const entry of readdirSync(workflows, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error(`工作流关联来源含软链接：${entry.name}`);
        if (!entry.isDirectory()) continue;
        const folder = join(workflows, entry.name);
        if (!existsSync(join(folder, "asset.json"))) continue;
        ordinary(join(folder, "asset.json"));
        ordinary(join(folder, "draft.json"));
        const detail = library.get(entry.name);
        if (!references(detail.draft.definition.applicability.technologies, id).changed
            && !references(detail.asset.applicability?.technologies ?? [], id).changed) continue;
        changed.push(`workflow-assets/${entry.name}`);
        operations.push(() => { library.removeTechnologyReference(entry.name, id, operator); });
      }
    }

    audit({ action: "delete_references_started", sources: changed });
    for (const operation of operations) operation();
    removeTechnologyStack(dataDir, id, operator);
    audit({ action: "delete_references_completed", sources: changed });
  } catch (error) {
    throw new Error(`技术栈关联清理未完成：${error instanceof Error ? error.message : String(error)}。`
      + "修复后可重试删除同一技术栈；已完成的清理不会回滚，操作记录及元数据备份保留在数据目录。");
  }
}
