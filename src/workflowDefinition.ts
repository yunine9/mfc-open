/**
 * 工作流资产与最终执行快照的共享契约。
 *
 * 平台状态机仍然拥有阶段、退出条件、证据和权限。这里描述的只是
 * 标准方案中可编辑的做法，以及用户对它做出的结构化编辑。前端、
 * 资产库和内核桥接必须共用这份类型，不能各自拼一套提示词。
 */

import { createHash } from "node:crypto";

export const WORKFLOW_DEFINITION_SCHEMA =
  "mae-flow-workflow-definition/1" as const;
export const WORKFLOW_EXECUTION_PROFILE_SCHEMA =
  "mae-flow-execution-profile/2" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const MAX_EDITS = 256;
const MAX_STAGES = 32;
const MAX_ITEMS_PER_STAGE = 128;
const MAX_INSTRUCTIONS = 2_000;

export type WorkflowAssetRegistry =
  | "business_knowledge"
  | "team_skill"
  | "repository_skill"
  | "platform_capability";

export type WorkflowAssetNature = "business" | "engineering";
export type WorkflowAssetForm = "document" | "skill" | "rule" | "example";

/** 保存的工作流只保存稳定身份；任务创建时由服务端把它解析成精确
 * 版本和任务内快照路径。仓内 Skill 的 repository/revision/path 是
 * 身份的一部分，不能保存一次扫描产生的短期 catalog token。 */
export interface WorkflowAssetRef {
  registry: WorkflowAssetRegistry;
  id: string;
  version: string;
  digest: string;
  nature?: WorkflowAssetNature;
  form?: WorkflowAssetForm;
  /** 业务知识 ID 只在模块内唯一，因此必须同时固定模块身份。 */
  business_module_id?: string;
  repository?: string;
  revision?: string;
  relative_path?: string;
}

export type WorkflowUseMode =
  | "available"
  | "when_needed"
  | "on_stage_enter"
  | "before_item";

export interface WorkflowUseContract {
  mode: WorkflowUseMode;
  /** mode=before_item 时指向同阶段的稳定 item id。 */
  anchor?: string;
}

export type WorkflowItemKind =
  | "activity"
  | "knowledge"
  | "skill"
  | "agent"
  | "tool"
  | "instruction";

export type WorkflowItemSource = "platform" | "workflow" | "task";

/** 一个阶段最终只保留一份有序 item 列表。locked 项必须能由 flow、
 * evidence contract 或宿主权限找到真实保护，不能只靠文案自称底线。 */
export interface WorkflowPlanItem {
  id: string;
  kind: WorkflowItemKind;
  title: string;
  description?: string;
  slot?: string;
  locked: boolean;
  editable: boolean;
  source: WorkflowItemSource;
  asset_ref?: WorkflowAssetRef;
  use?: WorkflowUseContract;
  instructions?: string;
}

export interface WorkflowSlot {
  id: string;
  cardinality: "one" | "many";
}

export interface WorkflowStagePlan {
  id: string;
  title: string;
  phase: string;
  steps: string[];
  slots: WorkflowSlot[];
  items: WorkflowPlanItem[];
}

export interface WorkflowStandardSnapshot {
  standard_id: string;
  standard_version: string;
  catalog_digest: string;
  stages: WorkflowStagePlan[];
}

export interface WorkflowPosition {
  before?: string;
  after?: string;
}

interface WorkflowEditBase {
  edit_id: string;
  stage_id: string;
}

export interface WorkflowAddEdit extends WorkflowEditBase {
  op: "add";
  item: WorkflowPlanItem;
  position?: WorkflowPosition;
}

export interface WorkflowRemoveEdit extends WorkflowEditBase {
  op: "remove";
  target_id: string;
}

export interface WorkflowReplaceEdit extends WorkflowEditBase {
  op: "replace";
  target_id: string;
  item: WorkflowPlanItem;
}

export interface WorkflowMoveEdit extends WorkflowEditBase {
  op: "move";
  target_id: string;
  position: WorkflowPosition;
}

export interface WorkflowConfigureEdit extends WorkflowEditBase {
  op: "configure";
  target_id: string;
  use?: WorkflowUseContract;
  instructions?: string;
}

export type WorkflowEdit =
  | WorkflowAddEdit
  | WorkflowRemoveEdit
  | WorkflowReplaceEdit
  | WorkflowMoveEdit
  | WorkflowConfigureEdit;

export interface WorkflowApplicability {
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

export interface WorkflowDefinition {
  schema: typeof WORKFLOW_DEFINITION_SCHEMA;
  base: {
    standard_id: string;
    standard_version: string;
    catalog_digest: string;
  };
  applicability: WorkflowApplicability;
  edits: WorkflowEdit[];
}

export interface WorkflowSourceRef {
  kind: "platform" | "workflow" | "task";
  id: string;
  /** 创建任务时固定的人类可读名称；资产后来改名不影响历史任务。 */
  label?: string;
  version?: string;
  digest?: string;
}

export type WorkflowDiagnosticCode =
  | "asset_unavailable"
  | "asset_incompatible"
  | "base_item_restored"
  | "edit_ignored"
  | "instruction_conflict"
  | "profile_invalid";

export interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  severity: "warning" | "error";
  message: string;
  stage_id?: string;
  item_id?: string;
  edit_id?: string;
  fallback?: string;
}

export interface WorkflowResolvedAsset extends WorkflowAssetRef {
  state: "available" | "unavailable" | "incompatible";
  snapshot_path?: string;
  diagnostic?: string;
}

/** 文字建议层(v1 execution-profile 于 2026-08-29 退役并入):任务
 * 补充说明/仓库执行约定/团队指引都长这样,只调整关注点、顺序与协作,
 * 永远低于阶段合同、真实证据、人工决定与权限。 */
export interface WorkflowSupplement {
  scope: "team" | "business_module" | "repository" | "task";
  source_id: string;
  title: string;
  instructions: string;
}

/** 任务运行只消费 final_snapshot；base_snapshot 和 edits 用于审计、
 * 展示差异以及单项资产损坏时恢复对应标准项。
 * 两快照可整体缺席(supplement-only:没选工作流、只写了文字补充的
 * 任务),此时按平台默认方案执行、只叠 supplements——校验口径与内核
 * workflow_profile_errors 一致:结构化与补充至少有一。 */
export interface WorkflowExecutionProfileV2 {
  schema: typeof WORKFLOW_EXECUTION_PROFILE_SCHEMA;
  revision: string;
  source: WorkflowSourceRef;
  base_snapshot?: WorkflowStandardSnapshot;
  edits: WorkflowEdit[];
  final_snapshot?: WorkflowStandardSnapshot;
  asset_manifest: WorkflowResolvedAsset[];
  diagnostics: WorkflowDiagnostic[];
  supplements?: WorkflowSupplement[];
}

/** 编译器产物必带两快照;supplement-only 档不经编译器产生。 */
export interface CompiledWorkflowProfile extends WorkflowExecutionProfileV2 {
  base_snapshot: WorkflowStandardSnapshot;
  final_snapshot: WorkflowStandardSnapshot;
}

function requiredText(value: unknown, label: string, max = 500): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label}不能为空`);
  if (result.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = requiredText(value, label, 120);
  if (!ID.test(result)) {
    throw new Error(`${label}只能使用字母、数字、点、下划线或短横线`);
  }
  return result;
}

function digest(value: unknown, label: string): string {
  const result = requiredText(value, label, 71).toLowerCase();
  if (!DIGEST.test(result)) throw new Error(`${label}必须是 SHA-256`);
  return result.startsWith("sha256:") ? result : `sha256:${result}`;
}

function stringList(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const result = [...new Set(value.map((item) => String(item).trim())
    .filter(Boolean))].sort();
  if (result.length > max) throw new Error(`${label}最多包含 ${max} 项`);
  if (result.some((item) => item.length > 512 || /[\0\r\n]/.test(item))) {
    throw new Error(`${label}包含非法内容`);
  }
  return result;
}

function normalizeUse(value: unknown, label: string): WorkflowUseContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const input = value as Record<string, unknown>;
  const mode = String(input.mode ?? "") as WorkflowUseMode;
  if (!["available", "when_needed", "on_stage_enter", "before_item"]
      .includes(mode)) throw new Error(`${label}使用方式不受支持`);
  const anchor = input.anchor == null ? undefined
    : identifier(input.anchor, `${label}锚点`);
  if (mode === "before_item" && !anchor) {
    throw new Error(`${label}在 before_item 模式下必须提供锚点`);
  }
  if (mode !== "before_item" && anchor) {
    throw new Error(`${label}只有 before_item 模式可以提供锚点`);
  }
  return { mode, ...(anchor ? { anchor } : {}) };
}

function normalizeAssetRef(value: unknown, label: string): WorkflowAssetRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const input = value as Record<string, unknown>;
  const registry = String(input.registry ?? "") as WorkflowAssetRegistry;
  if (!["business_knowledge", "team_skill",
    "repository_skill", "platform_capability"].includes(registry)) {
    throw new Error(`${label}引用了不支持的资产库`);
  }
  const nature = input.nature == null ? undefined
    : String(input.nature) as WorkflowAssetNature;
  if (nature && !["business", "engineering"].includes(nature)) {
    throw new Error(`${label}知识性质不受支持`);
  }
  const form = input.form == null ? undefined
    : String(input.form) as WorkflowAssetForm;
  if (form && !["document", "skill", "rule", "example"].includes(form)) {
    throw new Error(`${label}知识形态不受支持`);
  }
  const repository = input.repository == null ? undefined
    : requiredText(input.repository, `${label}仓库`, 512);
  const revision = input.revision == null ? undefined
    : requiredText(input.revision, `${label}仓库版本`, 255);
  const relativePath = input.relative_path == null ? undefined
    : requiredText(input.relative_path, `${label}仓内路径`, 512);
  const businessModuleId = input.business_module_id == null ? undefined
    : identifier(input.business_module_id, `${label}业务模块`);
  if (registry === "business_knowledge" && !businessModuleId) {
    throw new Error(`${label}业务知识必须固定业务模块 ID`);
  }
  if (registry === "repository_skill"
      && (!repository || !revision || !relativePath)) {
    throw new Error(`${label}仓内 Skill 必须固定仓库、版本和相对路径`);
  }
  return {
    registry,
    id: identifier(input.id, `${label} ID`),
    version: requiredText(input.version, `${label}版本`, 120),
    digest: digest(input.digest, `${label}摘要`),
    ...(nature ? { nature } : {}),
    ...(form ? { form } : {}),
    ...(businessModuleId ? { business_module_id: businessModuleId } : {}),
    ...(repository ? { repository } : {}),
    ...(revision ? { revision } : {}),
    ...(relativePath ? { relative_path: relativePath } : {}),
  };
}

function normalizeItem(value: unknown, label: string): WorkflowPlanItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const input = value as Record<string, unknown>;
  const kind = String(input.kind ?? "") as WorkflowItemKind;
  if (!["activity", "knowledge", "skill", "agent", "tool", "instruction"]
      .includes(kind)) throw new Error(`${label}类型不受支持`);
  const instructions = input.instructions == null ? undefined
    : requiredText(input.instructions, `${label}补充`, MAX_INSTRUCTIONS);
  const assetRef = input.asset_ref == null ? undefined
    : normalizeAssetRef(input.asset_ref, `${label}资产`);
  const use = input.use == null ? undefined
    : normalizeUse(input.use, `${label}使用要求`);
  return {
    id: identifier(input.id, `${label} ID`),
    kind,
    title: requiredText(input.title, `${label}标题`, 160),
    ...(input.description == null ? {} : {
      description: requiredText(input.description, `${label}说明`, 1_000),
    }),
    ...(input.slot == null ? {} : {
      slot: identifier(input.slot, `${label}能力槽`),
    }),
    locked: input.locked === true,
    editable: input.editable !== false,
    source: (["platform", "workflow", "task"].includes(String(input.source))
      ? String(input.source) : "workflow") as WorkflowItemSource,
    ...(assetRef ? { asset_ref: assetRef } : {}),
    ...(use ? { use } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

function normalizePosition(value: unknown, label: string): WorkflowPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const input = value as Record<string, unknown>;
  const before = input.before == null ? undefined
    : identifier(input.before, `${label} before`);
  const after = input.after == null ? undefined
    : identifier(input.after, `${label} after`);
  if (!!before === !!after) throw new Error(`${label}必须且只能指定 before/after`);
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

function normalizeEdit(value: unknown, index: number): WorkflowEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`第 ${index + 1} 条工作流编辑必须是对象`);
  }
  const input = value as Record<string, unknown>;
  const base = {
    edit_id: identifier(input.edit_id, `第 ${index + 1} 条编辑 ID`),
    stage_id: identifier(input.stage_id, `第 ${index + 1} 条编辑阶段`),
  };
  switch (input.op) {
    case "add":
      return { ...base, op: "add",
        item: normalizeItem(input.item, `编辑 ${base.edit_id} 新增项`),
        ...(input.position == null ? {} : {
          position: normalizePosition(input.position, `编辑 ${base.edit_id} 位置`),
        }) };
    case "remove":
      return { ...base, op: "remove",
        target_id: identifier(input.target_id, `编辑 ${base.edit_id} 目标`) };
    case "replace":
      return { ...base, op: "replace",
        target_id: identifier(input.target_id, `编辑 ${base.edit_id} 目标`),
        item: normalizeItem(input.item, `编辑 ${base.edit_id} 替换项`) };
    case "move":
      return { ...base, op: "move",
        target_id: identifier(input.target_id, `编辑 ${base.edit_id} 目标`),
        position: normalizePosition(input.position, `编辑 ${base.edit_id} 位置`) };
    case "configure": {
      const use = input.use == null ? undefined
        : normalizeUse(input.use, `编辑 ${base.edit_id} 使用要求`);
      const instructions = input.instructions == null ? undefined
        : requiredText(input.instructions, `编辑 ${base.edit_id} 补充`,
          MAX_INSTRUCTIONS);
      if (!use && !instructions) throw new Error(
        `编辑 ${base.edit_id} 没有任何配置内容`);
      return { ...base, op: "configure",
        target_id: identifier(input.target_id, `编辑 ${base.edit_id} 目标`),
        ...(use ? { use } : {}),
        ...(instructions ? { instructions } : {}) };
    }
    default:
      throw new Error(`编辑 ${base.edit_id} 的操作不受支持`);
  }
}

/** 这里只验证可独立判断的输入边界；目标是否存在、是否触碰平台下限、
 * slot 是否冲突由服务端 compiler 结合标准方案统一裁决。 */
export function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工作流定义必须是对象");
  }
  const input = value as Record<string, unknown>;
  if (input.schema !== WORKFLOW_DEFINITION_SCHEMA) {
    throw new Error(`工作流定义 schema 必须是 ${WORKFLOW_DEFINITION_SCHEMA}`);
  }
  const base = input.base as Record<string, unknown> | undefined;
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    throw new Error("工作流必须声明标准方案基线");
  }
  const applicability = input.applicability as Record<string, unknown> | undefined;
  if (!applicability || typeof applicability !== "object"
      || Array.isArray(applicability)) {
    throw new Error("工作流必须声明适用范围");
  }
  if (!Array.isArray(input.edits)) throw new Error("工作流编辑必须是数组");
  if (input.edits.length > MAX_EDITS) {
    throw new Error(`每个工作流最多包含 ${MAX_EDITS} 条编辑`);
  }
  const edits = input.edits.map(normalizeEdit);
  const editIds = edits.map((item) => item.edit_id);
  if (new Set(editIds).size !== editIds.length) {
    throw new Error("工作流编辑 ID 不能重复");
  }
  return {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    base: {
      standard_id: identifier(base.standard_id, "标准方案 ID"),
      standard_version: requiredText(
        base.standard_version, "标准方案版本", 120),
      catalog_digest: digest(base.catalog_digest, "标准方案目录摘要"),
    },
    applicability: {
      business_module_ids: stringList(
        applicability.business_module_ids ?? [], "适用业务模块", 16),
      repositories: stringList(
        applicability.repositories ?? [], "适用仓库", 32),
      technologies: stringList(
        applicability.technologies ?? [], "适用技术", 32),
    },
    edits,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function workflowDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf-8").digest("hex")}`;
}

/** compiler 输出前的共同容量守卫。 */
export function assertWorkflowSnapshotBounds(
  snapshot: WorkflowStandardSnapshot,
): void {
  if (snapshot.stages.length > MAX_STAGES) {
    throw new Error(`工作流最多包含 ${MAX_STAGES} 个阶段`);
  }
  for (const stage of snapshot.stages) {
    if (stage.items.length > MAX_ITEMS_PER_STAGE) {
      throw new Error(`阶段 ${stage.id} 最多包含 ${MAX_ITEMS_PER_STAGE} 项`);
    }
  }
}
