/** Versioned adapter from the kernel Playbook catalog to the editable standard. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertWorkflowSnapshotBounds,
  workflowDigest,
  type WorkflowItemKind,
  type WorkflowPlanItem,
  type WorkflowStagePlan,
  type WorkflowStandardSnapshot,
} from "./workflowDefinition.ts";

const CATALOG_SCHEMA = "mae-flow-playbook-catalog/1";

interface CatalogResource {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  ref?: unknown;
  usage?: unknown;
  locked?: unknown;
  default_enabled?: unknown;
}

interface CatalogActivity {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  required?: unknown;
  default_enabled?: unknown;
  locked?: unknown;
}

interface CatalogPlaybook {
  id?: unknown;
  version?: unknown;
  title?: unknown;
  summary?: unknown;
  phase?: unknown;
  steps?: unknown;
  slots?: unknown;
  activities?: unknown;
  resources?: unknown;
}

function text(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function resourceKind(kind: unknown): WorkflowItemKind {
  switch (kind) {
    case "agent": return "agent";
    case "knowledge": return "knowledge";
    case "skill": return "skill";
    case "tool":
    case "platform": return "tool";
    case "guidance":
    case "standard": return "instruction";
    default: throw new Error(`不支持的资源类型: ${String(kind)}`);
  }
}

function useMode(usage: unknown): WorkflowPlanItem["use"] {
  switch (usage) {
    case "required": return { mode: "on_stage_enter" };
    case "when_needed": return { mode: "when_needed" };
    case "on_demand": return { mode: "available" };
    default: throw new Error(`不支持的资源使用方式: ${String(usage)}`);
  }
}

function slots(value: unknown, stageId: string): WorkflowStagePlan["slots"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`阶段 ${stageId} 的能力槽必须是数组`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`阶段 ${stageId} 的第 ${index + 1} 个能力槽无效`);
    }
    const item = raw as Record<string, unknown>;
    const cardinality = String(item.cardinality ?? "") as "one" | "many";
    if (cardinality !== "one" && cardinality !== "many") {
      throw new Error(`阶段 ${stageId} 的能力槽基数无效`);
    }
    return { id: text(item.id, `阶段 ${stageId} 能力槽 ID`), cardinality };
  });
}

function stage(raw: CatalogPlaybook): WorkflowStagePlan {
  const id = text(raw.id, "阶段方案 ID");
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((item) => text(item, `阶段 ${id} 步骤`)) : [];
  if (!steps.length) throw new Error(`阶段 ${id} 没有绑定内核步骤`);
  const activities = Array.isArray(raw.activities)
    ? raw.activities as CatalogActivity[] : [];
  const resources = Array.isArray(raw.resources)
    ? raw.resources as CatalogResource[] : [];
  const items: WorkflowPlanItem[] = [];
  for (const activity of activities) {
    // v1 required 的本意其实是“标准方案默认启用”。在新的统一快照里
    // 它不再代表平台下限；只有显式 locked 才不可编辑。
    const enabled = activity.default_enabled === undefined
      ? activity.required === true : activity.default_enabled === true;
    if (!enabled) continue;
    const locked = activity.locked === true;
    items.push({
      id: text(activity.id, `阶段 ${id} 动作 ID`),
      kind: "activity",
      title: text(activity.title, `阶段 ${id} 动作标题`),
      description: text(activity.description, `阶段 ${id} 动作说明`),
      locked,
      editable: !locked,
      source: "platform",
    });
  }
  for (const resource of resources) {
    if (resource.default_enabled === false) continue;
    const locked = resource.locked === true;
    const ref = resource.ref == null ? "" : String(resource.ref).trim();
    items.push({
      id: text(resource.id, `阶段 ${id} 资源 ID`),
      kind: resourceKind(resource.kind),
      title: text(resource.name, `阶段 ${id} 资源名称`),
      ...(ref ? { description: `平台资源：${ref}` } : {}),
      locked,
      editable: !locked,
      source: "platform",
      use: useMode(resource.usage),
    });
  }
  return {
    id,
    title: text(raw.title, `阶段 ${id} 标题`),
    phase: text(raw.phase, `阶段 ${id} 流程阶段`),
    steps,
    slots: slots(raw.slots, id),
    items,
  };
}

export function workflowStandardSnapshotFromCatalog(
  value: unknown,
): WorkflowStandardSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工作流目录必须是对象");
  }
  const catalog = value as Record<string, unknown>;
  if (catalog.schema !== CATALOG_SCHEMA) {
    throw new Error(`工作流目录 schema 必须是 ${CATALOG_SCHEMA}`);
  }
  const standard = catalog.standard as Record<string, unknown> | undefined;
  if (!standard || typeof standard !== "object" || Array.isArray(standard)) {
    throw new Error("工作流目录缺少 standard 身份");
  }
  if (!Array.isArray(catalog.playbooks) || !catalog.playbooks.length) {
    throw new Error("工作流目录没有阶段方案");
  }
  const result: WorkflowStandardSnapshot = {
    standard_id: text(standard.id, "标准方案 ID"),
    standard_version: text(standard.version, "标准方案版本"),
    catalog_digest: workflowDigest(catalog),
    stages: catalog.playbooks.map((item) => stage(item as CatalogPlaybook)),
  };
  assertWorkflowSnapshotBounds(result);
  return result;
}

export function readWorkflowStandardSnapshot(
  kernelRoot: string | undefined,
): WorkflowStandardSnapshot | undefined {
  if (!kernelRoot) return undefined;
  try {
    const catalog = JSON.parse(readFileSync(
      join(kernelRoot, "flow", "playbooks.json"), "utf-8"));
    return workflowStandardSnapshotFromCatalog(catalog);
  } catch {
    // 目录是可选的执行解释层；内核固定流程不能因目录损坏而无法下单。
    return undefined;
  }
}
