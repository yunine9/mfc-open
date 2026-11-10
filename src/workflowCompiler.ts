/**
 * 把平台标准方案与一组结构化编辑编译成任务唯一消费的最终方案。
 *
 * 这里不执行工作流，也不重新定义阶段门禁。平台下限由 flow、证据合同
 * 和宿主权限真正保护；compiler 只负责裁决“这一阶段具体怎么做”。
 */

import {
  WORKFLOW_EXECUTION_PROFILE_SCHEMA,
  assertWorkflowSnapshotBounds,
  normalizeWorkflowDefinition,
  workflowDigest,
  type WorkflowAssetRef,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type CompiledWorkflowProfile,
  type WorkflowPlanItem,
  type WorkflowPosition,
  type WorkflowResolvedAsset,
  type WorkflowSourceRef,
  type WorkflowStagePlan,
  type WorkflowStandardSnapshot,
} from "./workflowDefinition.ts";

export interface CompileWorkflowInput {
  baseSnapshot: WorkflowStandardSnapshot;
  definition: unknown;
  source: WorkflowSourceRef;
  /** 资产解析在 compiler 外完成，以便业务知识、团队 Skill、仓内 Skill
   * 各自沿用现有快照机制；这里仅消费精确身份的解析结果。 */
  resolvedAssets?: WorkflowResolvedAsset[];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function assetKey(ref: WorkflowAssetRef): string {
  return [
    ref.registry,
    ref.id,
    ref.version,
    ref.digest,
    ref.business_module_id ?? "",
    ref.repository ?? "",
    ref.revision ?? "",
    ref.relative_path ?? "",
  ].join("\0");
}

function sameBase(
  snapshot: WorkflowStandardSnapshot,
  definition: WorkflowDefinition,
): boolean {
  return snapshot.standard_id === definition.base.standard_id
    && snapshot.standard_version === definition.base.standard_version
    && snapshot.catalog_digest === definition.base.catalog_digest;
}

function assertBaseSnapshot(snapshot: WorkflowStandardSnapshot): void {
  assertWorkflowSnapshotBounds(snapshot);
  if (!snapshot.standard_id || !snapshot.standard_version
      || !snapshot.catalog_digest) {
    throw new Error("平台标准方案缺少固定身份");
  }
  const stageIds = new Set<string>();
  for (const stage of snapshot.stages) {
    if (!stage.id || stageIds.has(stage.id)) {
      throw new Error(`平台标准方案包含重复或空阶段: ${stage.id || "(空)"}`);
    }
    stageIds.add(stage.id);
    const itemIds = new Set<string>();
    const slotIds = new Set(stage.slots.map((slot) => slot.id));
    if (slotIds.size !== stage.slots.length) {
      throw new Error(`阶段 ${stage.id} 包含重复能力槽`);
    }
    for (const item of stage.items) {
      if (!item.id || itemIds.has(item.id)) {
        throw new Error(`阶段 ${stage.id} 包含重复或空方案项: ${item.id}`);
      }
      itemIds.add(item.id);
      if (item.locked && item.editable) {
        throw new Error(`平台下限项 ${stage.id}/${item.id} 不能同时标为可编辑`);
      }
      if (item.slot && !slotIds.has(item.slot)) {
        throw new Error(`方案项 ${stage.id}/${item.id} 引用了不存在的能力槽`);
      }
    }
  }
}

function diagnostic(
  diagnostics: WorkflowDiagnostic[],
  input: Omit<WorkflowDiagnostic, "severity"> & {
    severity?: WorkflowDiagnostic["severity"];
  },
): void {
  diagnostics.push({ severity: input.severity ?? "warning", ...input });
}

function positionIndex(
  stage: WorkflowStagePlan,
  position: WorkflowPosition | undefined,
): number | undefined {
  if (!position) return stage.items.length;
  const anchor = position.before ?? position.after;
  const found = stage.items.findIndex((item) => item.id === anchor);
  if (found < 0) return undefined;
  return position.before ? found : found + 1;
}

function editable(item: WorkflowPlanItem): boolean {
  return !item.locked && item.editable;
}

function workflowItem(
  item: WorkflowPlanItem,
  source: WorkflowSourceRef,
): WorkflowPlanItem {
  return {
    ...copy(item),
    // 用户资产不能通过自报字段制造另一层“平台下限”。复制出来的方案
    // 始终可继续编辑；真正的锁只来自固定的 base snapshot。
    locked: false,
    editable: true,
    source: source.kind === "task" ? "task" : "workflow",
  };
}

function slotError(
  stage: WorkflowStagePlan,
  item: WorkflowPlanItem,
  ignoredItemId?: string,
): string | undefined {
  if (!item.slot) return undefined;
  const slot = stage.slots.find((candidate) => candidate.id === item.slot);
  if (!slot) return `能力槽 ${item.slot} 不存在`;
  if (slot.cardinality === "one" && stage.items.some((candidate) =>
    candidate.id !== ignoredItemId && candidate.slot === item.slot)) {
    return `能力槽 ${item.slot} 只能保留一项，请使用替换而不是增加`;
  }
  return undefined;
}

function useError(
  stage: WorkflowStagePlan,
  item: WorkflowPlanItem,
  replacingId?: string,
): string | undefined {
  if (item.use?.mode !== "before_item") return undefined;
  const anchor = item.use.anchor;
  if (!anchor || anchor === item.id) return "before_item 必须引用同阶段另一项";
  if (anchor === replacingId) return undefined;
  if (!stage.items.some((candidate) => candidate.id === anchor)) {
    return `使用时机引用了不存在的方案项 ${anchor}`;
  }
  return undefined;
}

function assetState(
  item: WorkflowPlanItem,
  assets: Map<string, WorkflowResolvedAsset>,
): WorkflowResolvedAsset | undefined {
  return item.asset_ref ? assets.get(assetKey(item.asset_ref)) : undefined;
}

function assetFailure(
  item: WorkflowPlanItem,
  assets: Map<string, WorkflowResolvedAsset>,
): { code: "asset_unavailable" | "asset_incompatible";
    message: string } | undefined {
  if (!item.asset_ref) return undefined;
  const state = assetState(item, assets);
  if (!state || state.state === "unavailable") return {
    code: "asset_unavailable",
    message: state?.diagnostic
      || `资产 ${item.asset_ref.id}@${item.asset_ref.version} 当前不可用`,
  };
  if (state.state === "incompatible") return {
    code: "asset_incompatible",
    message: state.diagnostic
      || `资产 ${item.asset_ref.id}@${item.asset_ref.version} 与本任务不兼容`,
  };
  return undefined;
}

function editIgnored(
  diagnostics: WorkflowDiagnostic[],
  input: {
    message: string;
    stageId: string;
    editId: string;
    itemId?: string;
    fallback?: string;
  },
): void {
  diagnostic(diagnostics, {
    code: "edit_ignored",
    message: input.message,
    stage_id: input.stageId,
    edit_id: input.editId,
    ...(input.itemId ? { item_id: input.itemId } : {}),
    ...(input.fallback ? { fallback: input.fallback } : {}),
  });
}

function resolvedManifest(
  definition: WorkflowDefinition | undefined,
  supplied: WorkflowResolvedAsset[],
): { manifest: WorkflowResolvedAsset[];
  lookup: Map<string, WorkflowResolvedAsset> } {
  const suppliedByKey = new Map<string, WorkflowResolvedAsset>();
  for (const asset of supplied) suppliedByKey.set(assetKey(asset), copy(asset));
  const refs = new Map<string, WorkflowAssetRef>();
  for (const edit of definition?.edits ?? []) {
    if ((edit.op === "add" || edit.op === "replace") && edit.item.asset_ref) {
      refs.set(assetKey(edit.item.asset_ref), edit.item.asset_ref);
    }
  }
  const manifest = [...refs.entries()].map(([key, ref]) =>
    suppliedByKey.get(key) ?? {
      ...copy(ref),
      state: "unavailable" as const,
      diagnostic: "任务创建时没有解析到该精确资产版本",
    }).sort((left, right) => assetKey(left).localeCompare(assetKey(right)));
  return {
    manifest,
    lookup: new Map(manifest.map((asset) => [assetKey(asset), asset])),
  };
}

function defaultProfile(
  base: WorkflowStandardSnapshot,
  source: WorkflowSourceRef,
  diagnostics: WorkflowDiagnostic[],
): CompiledWorkflowProfile {
  const payload = {
    source,
    base_snapshot: base,
    edits: [],
    final_snapshot: base,
    asset_manifest: [],
    diagnostics,
  };
  return {
    schema: WORKFLOW_EXECUTION_PROFILE_SCHEMA,
    revision: workflowDigest(payload),
    ...copy(payload),
  };
}

/**
 * 编辑级 fail-open：一个操作无效只忽略这一项并给出诊断。平台标准方案
 * 本身损坏才抛错，因为那不是用户定制可以安全掩盖的问题。
 */
export function compileWorkflow(
  input: CompileWorkflowInput,
): CompiledWorkflowProfile {
  assertBaseSnapshot(input.baseSnapshot);
  const base = copy(input.baseSnapshot);
  let definition: WorkflowDefinition;
  try {
    definition = normalizeWorkflowDefinition(input.definition);
  } catch (error) {
    return defaultProfile(base, input.source, [{
      code: "profile_invalid",
      severity: "error",
      message: `工作流定义无效：${error instanceof Error
        ? error.message : String(error)}`,
      fallback: "已采用完整平台标准方案",
    }]);
  }
  if (!sameBase(base, definition)) {
    return defaultProfile(base, input.source, [{
      code: "profile_invalid",
      severity: "error",
      message: "工作流基线与当前固定的标准方案不一致",
      fallback: "已采用完整平台标准方案；请复制当前版本后重新定制",
    }]);
  }

  const finalSnapshot = copy(base);
  const diagnostics: WorkflowDiagnostic[] = [];
  const { manifest, lookup } = resolvedManifest(
    definition, input.resolvedAssets ?? []);

  for (const edit of definition.edits) {
    const stage = finalSnapshot.stages.find((item) => item.id === edit.stage_id);
    if (!stage) {
      editIgnored(diagnostics, {
        message: `阶段 ${edit.stage_id} 不存在`,
        stageId: edit.stage_id,
        editId: edit.edit_id,
        fallback: "该项未执行，其余定制继续生效",
      });
      continue;
    }

    if (edit.op === "add") {
      const item = workflowItem(edit.item, input.source);
      if (stage.items.some((candidate) => candidate.id === item.id)) {
        editIgnored(diagnostics, { message: `方案项 ${item.id} 已存在`,
          stageId: stage.id, editId: edit.edit_id, itemId: item.id,
          fallback: "新增项未加入" });
        continue;
      }
      const invalid = slotError(stage, item) ?? useError(stage, item);
      const index = positionIndex(stage, edit.position);
      const unavailable = assetFailure(item, lookup);
      if (invalid || index === undefined || unavailable) {
        diagnostic(diagnostics, {
          code: unavailable?.code ?? "edit_ignored",
          message: unavailable?.message ?? invalid
            ?? "新增位置引用了不存在的方案项",
          stage_id: stage.id,
          edit_id: edit.edit_id,
          item_id: item.id,
          fallback: "新增项未加入，其余定制继续生效",
        });
        continue;
      }
      stage.items.splice(index, 0, item);
      continue;
    }

    const targetIndex = stage.items.findIndex((item) =>
      item.id === edit.target_id);
    if (targetIndex < 0) {
      editIgnored(diagnostics, { message: `方案项 ${edit.target_id} 不存在`,
        stageId: stage.id, editId: edit.edit_id, itemId: edit.target_id,
        fallback: "该项未执行，其余定制继续生效" });
      continue;
    }
    const target = stage.items[targetIndex];
    if (!editable(target)) {
      diagnostic(diagnostics, {
        code: "base_item_restored",
        message: `方案项 ${target.id} 属于平台下限，不能${
          edit.op === "remove" ? "删除" : edit.op === "replace" ? "替换"
            : edit.op === "move" ? "移动" : "修改"}`,
        stage_id: stage.id,
        edit_id: edit.edit_id,
        item_id: target.id,
        fallback: "已保留平台下限项",
      });
      continue;
    }

    if (edit.op === "remove") {
      const dependent = stage.items.find((item) =>
        item.id !== target.id && item.use?.mode === "before_item"
        && item.use.anchor === target.id);
      if (dependent) {
        editIgnored(diagnostics, {
          message: `${dependent.id} 的使用时机依赖 ${target.id}`,
          stageId: stage.id, editId: edit.edit_id, itemId: target.id,
          fallback: "已保留被依赖项；请先调整依赖项的使用时机",
        });
        continue;
      }
      stage.items.splice(targetIndex, 1);
      continue;
    }

    if (edit.op === "replace") {
      const replacement = workflowItem(edit.item, input.source);
      if (replacement.id !== target.id && stage.items.some((candidate) =>
        candidate.id === replacement.id)) {
        editIgnored(diagnostics, { message: `方案项 ${replacement.id} 已存在`,
          stageId: stage.id, editId: edit.edit_id, itemId: replacement.id,
          fallback: `已保留原方案项 ${target.id}` });
        continue;
      }
      const invalid = slotError(stage, replacement, target.id)
        ?? useError(stage, replacement, target.id);
      const unavailable = assetFailure(replacement, lookup);
      if (invalid || unavailable) {
        diagnostic(diagnostics, {
          code: unavailable?.code ?? "edit_ignored",
          message: unavailable?.message ?? invalid!,
          stage_id: stage.id,
          edit_id: edit.edit_id,
          item_id: replacement.id,
          fallback: `已保留原方案项 ${target.id}`,
        });
        continue;
      }
      stage.items[targetIndex] = replacement;
      if (replacement.id !== target.id) {
        for (const item of stage.items) {
          if (item.use?.mode === "before_item" && item.use.anchor === target.id) {
            item.use.anchor = replacement.id;
          }
        }
      }
      continue;
    }

    if (edit.op === "move") {
      const moving = stage.items.splice(targetIndex, 1)[0];
      const index = positionIndex(stage, edit.position);
      if (index === undefined) {
        stage.items.splice(targetIndex, 0, moving);
        editIgnored(diagnostics, {
          message: "移动位置引用了不存在的方案项",
          stageId: stage.id, editId: edit.edit_id, itemId: target.id,
          fallback: "已保留原顺序",
        });
        continue;
      }
      stage.items.splice(index, 0, moving);
      continue;
    }

    const configured: WorkflowPlanItem = {
      ...target,
      ...(edit.use ? { use: copy(edit.use) } : {}),
      ...(edit.instructions ? { instructions: edit.instructions } : {}),
    };
    const invalid = useError(stage, configured);
    if (invalid) {
      editIgnored(diagnostics, { message: invalid,
        stageId: stage.id, editId: edit.edit_id, itemId: target.id,
        fallback: "已保留原配置" });
      continue;
    }
    stage.items[targetIndex] = configured;
  }

  assertWorkflowSnapshotBounds(finalSnapshot);
  const payload = {
    source: copy(input.source),
    base_snapshot: base,
    edits: copy(definition.edits),
    final_snapshot: finalSnapshot,
    asset_manifest: manifest,
    diagnostics,
  };
  return {
    schema: WORKFLOW_EXECUTION_PROFILE_SCHEMA,
    revision: workflowDigest(payload),
    ...payload,
  };
}
