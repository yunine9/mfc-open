import type {
  WorkflowAssetCatalogItem,
  WorkflowAssetRef,
  WorkflowDefinition,
  WorkflowEdit,
  WorkflowStandardBase,
  WorkflowPlanItem,
  WorkflowStagePlan,
} from "../api";

export type WorkflowEditorMode = "final" | "changes" | "dependencies";
export type WorkflowEditOperation = WorkflowEdit["op"];

export const operationLabels: Record<WorkflowEditOperation, string> = {
  add: "新增",
  remove: "移除",
  replace: "替换",
  move: "调序",
  configure: "配置",
};

export const statusLabels = {
  draft: "草稿",
  pending_review: "待审核",
  published: "已发布",
  archived: "已归档",
} as const;

/** 状态→Badge 语义 variant(#252 P0 四色):手搓 em.status-* 药丸退役,
 * 换 shadcn Badge soft 底——草稿灰(neutral)、待审核橙(warning)、
 * 已发布绿(success)、已归档弱底(suspended);配方见
 * components/ui/badge.tsx,颜色经 tailwind.css @theme 桥指向状态令牌。 */
export const statusBadgeVariants = {
  draft: "neutral",
  pending_review: "warning",
  published: "success",
  archived: "suspended",
} as const;

export const registryLabels: Record<WorkflowAssetRef["registry"], string> = {
  business_knowledge: "业务知识",
  team_skill: "团队 Skill",
  repository_skill: "代码仓 Skill",
  platform_capability: "平台能力",
};

export function assetKey(ref: WorkflowAssetRef): string {
  return [ref.registry, ref.business_module_id ?? "", ref.repository ?? "",
    ref.relative_path ?? "", ref.id, ref.version, ref.digest].join(":");
}

export function sourceLabel(item: WorkflowPlanItem): string {
  if (item.locked) return "平台锁定";
  if (item.source === "platform") return "平台默认";
  if (item.source === "task") return "本任务";
  return "工作流定制";
}

export function itemFromAsset(
  asset: WorkflowAssetCatalogItem,
  id: string,
): WorkflowPlanItem {
  return {
    id,
    kind: asset.type === "capability" ? "tool" : asset.type,
    title: asset.title,
    description: asset.summary,
    locked: false,
    editable: true,
    source: "workflow",
    asset_ref: asset.ref,
    use: { mode: "when_needed" },
  };
}

function insertItem(
  items: WorkflowPlanItem[],
  item: WorkflowPlanItem,
  position?: { before?: string; after?: string },
): WorkflowPlanItem[] {
  const anchor = position?.before ?? position?.after;
  const index = anchor ? items.findIndex((candidate) => candidate.id === anchor) : -1;
  if (index < 0) return [...items, item];
  return [
    ...items.slice(0, position?.before ? index : index + 1),
    item,
    ...items.slice(position?.before ? index : index + 1),
  ];
}

function moveItem(
  items: WorkflowPlanItem[],
  targetId: string,
  position: { before?: string; after?: string },
): WorkflowPlanItem[] {
  const item = items.find((candidate) => candidate.id === targetId);
  if (!item) return items;
  const without = items.filter((candidate) => candidate.id !== targetId);
  return insertItem(without, item, position);
}

/**
 * 前端仅用于即时预览；服务端编译器仍是最终执行方案的唯一权威。
 * 无法安全应用的编辑会被忽略，详情由服务端 diagnostics 明确说明。
 */
export function previewStages(
  base: WorkflowStandardBase,
  definition: WorkflowDefinition,
): WorkflowStagePlan[] {
  const stages = base.stages.map((stage) => ({
    ...stage,
    slots: stage.slots.map((slot) => ({ ...slot })),
    steps: [...stage.steps],
    items: stage.items.map((item) => ({ ...item })),
  }));
  for (const edit of definition.edits) {
    const stage = stages.find((candidate) => candidate.id === edit.stage_id);
    if (!stage) continue;
    if (edit.op === "add") {
      stage.items = insertItem(stage.items, edit.item, edit.position);
      continue;
    }
    const index = stage.items.findIndex((item) => item.id === edit.target_id);
    if (index < 0 || stage.items[index]?.locked) continue;
    if (edit.op === "remove") stage.items.splice(index, 1);
    if (edit.op === "replace") stage.items.splice(index, 1, edit.item);
    if (edit.op === "move") stage.items = moveItem(stage.items, edit.target_id, edit.position);
    if (edit.op === "configure") {
      const current = stage.items[index];
      if (!current) continue;
      stage.items[index] = {
        ...current,
        ...(edit.use ? { use: edit.use } : {}),
        ...(edit.instructions !== undefined ? { instructions: edit.instructions } : {}),
      };
    }
  }
  return stages;
}

export function editsForStage(
  definition: WorkflowDefinition,
  stageId: string,
): WorkflowEdit[] {
  return definition.edits.filter((edit) => edit.stage_id === stageId);
}

export function stageAssetRefs(stage: WorkflowStagePlan): WorkflowAssetRef[] {
  const refs = stage.items.flatMap((item) => item.asset_ref ? [item.asset_ref] : []);
  return [...new Map(refs.map((ref) => [assetKey(ref), ref])).values()];
}

export function newEditId(operation: WorkflowEditOperation): string {
  return `${operation}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
