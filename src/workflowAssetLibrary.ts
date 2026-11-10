import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
/**
 * 文件存储型工作流资产库(HANDOFF-workflow-assets-cc 第一批)。
 *
 * 职责边界:只管资产的存储、生命周期与复制语义。工作流内容的合法性
 * 全部交给共享契约 `workflowDefinition.ts`(唯一事实来源)——进出这里
 * 的 definition 一律过 normalizeWorkflowDefinition,摘要一律用
 * workflowDigest,本文件不复刻任何结构判断。团队场景下发布/归档/
 * 设默认的最终权限judgment在 route 层;这里只导出 canView/canEdit/
 * canPublish 基线判断与严格的状态机。
 *
 * 存储布局(<dataDir>/workflow-assets/):
 *   operations.jsonl            全部变更的追加留痕(谁、何时、干了什么)
 *   <asset-id>/asset.json       元数据与生命周期状态
 *   <asset-id>/draft.json       当前草稿(revision 乐观锁)
 *   <asset-id>/versions/vN.json 已发布版本,写入后永不可覆盖
 *
 * 纪律:
 * - 一切写入走 tmp+rename 原子替换;已发布版本用 link(2) 落盘——
 *   目标已存在时内核层面报 EEXIST,不存在"悄悄覆盖 v1"的路径。
 * - 读侧遇到损坏记录跳过并返回 warning(列表不能因一条坏账全瘫);
 *   写侧遇到损坏记录 fail-closed 拒绝操作(在坏账上继续写等于把
 *   损坏合法化)。
 * - 资产 ID 白名单正则 + 保留名 + 符号链接拒绝,路径永远不离开根目录。
 *
 * 事务策略(2026-08-29 第三批加固;每条顺序都要能解释、能恢复):
 * - operations.jsonl 是**先行账**(WAL):每个变更先记账、后落盘,
 *   追加失败则整个操作失败——因此永远不会出现"状态已变而账没记";
 *   反向(账记了、状态没变)是允许的中断形态,恢复规则见下。
 * - **提交点 = asset.json 的原子替换**。恢复一律以文件为准:
 *   draft.json 是草稿内容与乐观锁 revision 的唯一权威;asset.json 是
 *   生命周期/latest_version 的唯一权威(其 draft_revision/draft_digest
 *   只是展示缓存,中断后可能落后于 draft.json,下一次成功写入自愈);
 *   versions/vN.json 一旦存在即不可变。
 * - 各操作落盘顺序:create=账→目录→draft→asset;saveDraft=账→
 *   draft→asset;approve=账→vN→asset;状态迁移/归档=账→asset。
 * - approve 可安全重试:中断后 vN 已存在时,若其 digest 与
 *   from_revision 与当前草稿一致,视为上次中断的续跑直接复用;
 *   不一致才是真冲突(version_exists 拒绝)。
 * - create 中断(有目录无 asset.json)的残骸是惰性的:列表点名
 *   warning,同 ID 重新 create 直接回收覆盖。
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { requireTechnologyStackChanges } from "./technologyStacks.ts";
import {
  normalizeWorkflowDefinition,
  workflowDigest,
  type WorkflowDefinition,
  type WorkflowSourceRef,
} from "./workflowDefinition.ts";

export const WORKFLOW_ASSET_SCHEMA = "mae-flow-workflow-asset/1" as const;
export const WORKFLOW_DRAFT_SCHEMA = "mae-flow-workflow-draft/1" as const;
export const WORKFLOW_VERSION_SCHEMA = "mae-flow-workflow-version/1" as const;

export type WorkflowAssetScope = "personal" | "team";
export type WorkflowAssetStatus =
  | "draft"
  | "pending_review"
  | "published"
  | "archived";

/** 与共享契约同一 ID 白名单;另加保留名,operations.jsonl 不能被一个
 * 恶意资产 ID 顶掉。 */
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const RESERVED_IDS = new Set(["operations.jsonl"]);
const MAX_MAINTAINERS = 32;

export type WorkflowAssetErrorCode =
  | "invalid_input"
  | "not_found"
  | "revision_conflict"
  | "invalid_state"
  | "corrupted"
  | "version_exists";

/** 可识别错误:route 层按 code 翻译成 HTTP 语义(409/404/422…),
 * 不靠解析中文文案。 */
export class WorkflowAssetError extends Error {
  constructor(
    readonly code: WorkflowAssetErrorCode,
    message: string,
    /** revision_conflict 时带上当前 revision,前端能直接引导刷新。 */
    readonly current_revision?: number,
  ) {
    super(message);
    this.name = "WorkflowAssetError";
  }
}

export interface WorkflowAssetRecord {
  schema: typeof WORKFLOW_ASSET_SCHEMA;
  id: string;
  name: string;
  description?: string;
  scope: WorkflowAssetScope;
  owner: string;
  maintainers: string[];
  status: WorkflowAssetStatus;
  /** 归档只是"新任务不可选",不是删除;记下归档前状态,历史可考。 */
  status_before_archive?: WorkflowAssetStatus;
  latest_version: number;
  draft_revision: number;
  draft_digest: string;
  published_digest?: string;
  copied_from?: WorkflowSourceRef;
  /** 最新已知适用范围快照(创建/存草稿时同步)。列表页要直接回答
   * "这个方案适用于哪"(审计 P2-14),不能逼人逐个点详情;缺席=
   * 旧资产,前端按未声明处理。 */
  applicability?: WorkflowDefinition["applicability"];
  /** 删除最后一个技术栈后，补齐关联才能重新发布。 */
  technology_assignment_required?: true;
  created_at: string;
  updated_at: string;
}

export interface WorkflowDraftRecord {
  schema: typeof WORKFLOW_DRAFT_SCHEMA;
  revision: number;
  definition: WorkflowDefinition;
  digest: string;
  updated_at: string;
  updated_by: string;
}

export interface WorkflowVersionRecord {
  schema: typeof WORKFLOW_VERSION_SCHEMA;
  version: number;
  definition: WorkflowDefinition;
  digest: string;
  published_at: string;
  published_by: string;
  from_revision: number;
}

export interface WorkflowAssetSummary {
  id: string;
  name: string;
  description?: string;
  scope: WorkflowAssetScope;
  owner: string;
  maintainers: string[];
  status: WorkflowAssetStatus;
  latest_version: number;
  draft_revision: number;
  copied_from?: WorkflowSourceRef;
  /** 归档只影响这一位:新任务不能再选它;已有引用与历史都在。 */
  selectable_for_tasks: boolean;
  applicability?: WorkflowDefinition["applicability"];
  technology_assignment_required?: true;
  updated_at: string;
}

export interface WorkflowAssetDetail {
  asset: WorkflowAssetSummary;
  draft: WorkflowDraftRecord;
  versions: Array<{
    version: number;
    digest: string;
    published_at: string;
    published_by: string;
  }>;
}

export interface WorkflowAssetListResult {
  items: WorkflowAssetSummary[];
  /** 损坏/可疑目录逐条点名——静默跳过等于假装没坏。 */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 权限基线:团队发布/归档/设默认的最终裁决在 route 层,这里只给
// 任何 route 都不该低于的下限判断。
// ---------------------------------------------------------------------------
type WorkflowPermissionSubject = Pick<WorkflowAssetRecord,
  "scope" | "owner" | "maintainers" | "status">;

export function canView(asset: WorkflowPermissionSubject, user: string): boolean {
  if (asset.scope === "team") return true;
  return asset.owner === user || asset.maintainers.includes(user);
}

export function canEdit(asset: WorkflowPermissionSubject, user: string): boolean {
  if (asset.status === "archived") return false;
  return asset.owner === user || asset.maintainers.includes(user);
}

export function canPublish(asset: WorkflowPermissionSubject, user: string): boolean {
  if (asset.status === "archived") return false;
  // 个人资产只有本人能发布;团队资产 owner/maintainer 都可提请,
  // 是否还需要额外审批人由 route 层叠加。
  if (asset.scope === "personal") return asset.owner === user;
  return asset.owner === user || asset.maintainers.includes(user);
}

// ---------------------------------------------------------------------------
// 存储原语
// ---------------------------------------------------------------------------
function nowIso(): string {
  return new Date().toISOString();
}

/** 测试专用故障注入口:每次落盘 I/O 前调用,抛错即模拟该次写失败。
 * 生产不传,不改变任何对外行为——事务顺序的兜底必须在它防御的故障
 * 下被测过,否则等于没兜。 */
export type WorkflowAssetFaultHook =
  (action: "write" | "append" | "link", path: string) => void;

export interface WorkflowAssetLibraryOptions {
  faultInjection?: WorkflowAssetFaultHook;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function normalizeActor(value: unknown, label: string): string {
  const actor = String(value ?? "").trim();
  if (!actor || actor.length > 120 || /[\0\r\n]/.test(actor)) {
    throw new WorkflowAssetError("invalid_input", `${label}不能为空或含控制字符`);
  }
  return actor;
}

function normalizeMaintainers(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new WorkflowAssetError("invalid_input", "maintainers 必须是数组");
  }
  const list = [...new Set(value.map((item) =>
    normalizeActor(item, "maintainer")))].sort();
  if (list.length > MAX_MAINTAINERS) {
    throw new WorkflowAssetError(
      "invalid_input", `maintainers 最多 ${MAX_MAINTAINERS} 人`);
  }
  return list;
}

// ---------------------------------------------------------------------------
// 资产库
// ---------------------------------------------------------------------------
export class WorkflowAssetLibrary {
  private readonly root: string;
  private readonly oplogPath: string;
  private readonly fault?: WorkflowAssetFaultHook;

  constructor(private readonly dataDir: string, options: WorkflowAssetLibraryOptions = {}) {
    this.root = join(dataDir, "workflow-assets");
    this.oplogPath = join(this.root, "operations.jsonl");
    this.fault = options.faultInjection;
    mkdirSync(this.root, { recursive: true });
    this.sweepOrphanTmp();
  }

  /** 崩溃遗留的写入中间态(*.tmp-<pid>-<hex>)只在这里回收:构造发生
   * 在起服早期,实例锁保证此刻没有并发写者,扫到的 tmp 一律是上个
   * 进程的孤儿。不影响正确性(读侧从不看 tmp),但不扫会无限累积。
   * 纯旁路:任何失败都不拦启动。 */
  private sweepOrphanTmp(): void {
    const isTmp = (name: string) => /\.tmp-\d+-[0-9a-f]+$/.test(name);
    const sweepDir = (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (isTmp(name)) rmSync(join(dir, name), { force: true });
      }
    };
    try {
      sweepDir(this.root);
      for (const entry of readdirSync(this.root)) {
        const dir = join(this.root, entry);
        try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
        sweepDir(dir);
        sweepDir(join(dir, "versions"));
      }
    } catch { /* 清扫是旁路,失败不许拦库的启动 */ }
  }

  // -- 落盘原语(全部带故障注入口) --
  private atomicWriteJson(path: string, value: unknown): void {
    this.fault?.("write", path);
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, path);
  }

  /** 已发布版本专用:link(2) 在目标已存在时报 EEXIST——"永不可覆盖"
   * 靠内核保证,不靠先 existsSync 再写的竞态检查。 */
  private immutableWriteJson(path: string, value: unknown): void {
    this.fault?.("link", path);
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    try {
      linkSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkflowAssetError(
          "version_exists",
          `已发布版本文件已存在,拒绝覆盖:${path}`,
        );
      }
      throw error;
    }
    rmSync(tmp, { force: true });
  }

  // -- 路径防护 --
  private assetDir(id: string): string {
    if (!ASSET_ID.test(id) || RESERVED_IDS.has(id)) {
      throw new WorkflowAssetError("invalid_input", `资产 ID 不合法:${id}`);
    }
    const dir = join(this.root, id);
    // ID 正则已排除路径分隔符与 "..";这里再拒符号链接——资产目录被
    // 换成软链后,后续写入会落到库外任意位置。
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        throw new WorkflowAssetError(
          "corrupted", `资产目录是符号链接,拒绝操作:${id}`);
      }
    } catch (error) {
      if (error instanceof WorkflowAssetError) throw error;
      // 目录还不存在:交给调用方决定是创建还是 not_found。
    }
    return dir;
  }

  /** 变更留痕(先行账/WAL)。每个变更**先记账、后落盘**:追加失败
   * 直接抛错且不做任何状态写入(fail-closed)——因此绝无"状态已变
   * 而账没记";反向"账记了、状态没变"是允许的中断形态,恢复规则
   * 一律以文件为准(见文件头"事务策略")。 */
  private logOperation(
    op: string,
    assetId: string,
    actor: string,
    detail: Record<string, unknown> = {},
  ): void {
    this.fault?.("append", this.oplogPath);
    appendFileSync(this.oplogPath, JSON.stringify({
      ts: nowIso(), op, asset_id: assetId, actor, ...detail,
    }) + "\n");
  }

  // -- 读原语(写路径共用;损坏时 fail-closed) --
  private readAssetStrict(id: string): WorkflowAssetRecord {
    const dir = this.assetDir(id);
    const path = join(dir, "asset.json");
    if (!existsSync(path)) {
      throw new WorkflowAssetError("not_found", `资产不存在:${id}`);
    }
    let record: WorkflowAssetRecord;
    try {
      record = parseJson<WorkflowAssetRecord>(readFileSync(path, "utf-8"));
    } catch {
      throw new WorkflowAssetError(
        "corrupted", `资产元数据损坏,拒绝在其上继续写入:${id}`);
    }
    if (record.schema !== WORKFLOW_ASSET_SCHEMA || record.id !== id) {
      throw new WorkflowAssetError(
        "corrupted", `资产元数据 schema/ID 不符,拒绝操作:${id}`);
    }
    return record;
  }

  private readDraftStrict(id: string): WorkflowDraftRecord {
    const path = join(this.assetDir(id), "draft.json");
    if (!existsSync(path)) {
      throw new WorkflowAssetError("corrupted", `资产缺少草稿文件:${id}`);
    }
    let draft: WorkflowDraftRecord;
    try {
      draft = parseJson<WorkflowDraftRecord>(readFileSync(path, "utf-8"));
    } catch {
      throw new WorkflowAssetError("corrupted", `草稿文件损坏:${id}`);
    }
    if (draft.schema !== WORKFLOW_DRAFT_SCHEMA) {
      throw new WorkflowAssetError("corrupted", `草稿 schema 不符:${id}`);
    }
    // 草稿内容重新过契约:磁盘不可信,坏定义不能借道流回系统。
    try {
      draft.definition = normalizeWorkflowDefinition(draft.definition);
    } catch (error) {
      throw new WorkflowAssetError(
        "corrupted", `草稿定义不再符合契约:${id}(${String(
          (error as Error).message)})`);
    }
    return draft;
  }

  private writeAsset(record: WorkflowAssetRecord): void {
    this.atomicWriteJson(join(this.assetDir(record.id), "asset.json"), record);
  }

  private summarize(record: WorkflowAssetRecord): WorkflowAssetSummary {
    return {
      id: record.id,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      scope: record.scope,
      owner: record.owner,
      maintainers: record.maintainers,
      status: record.status,
      latest_version: record.latest_version,
      draft_revision: record.draft_revision,
      ...(record.copied_from ? { copied_from: record.copied_from } : {}),
      selectable_for_tasks:
        record.status === "published" && record.latest_version > 0,
      ...(record.applicability
        ? { applicability: { ...record.applicability, business_module_ids: resolveBusinessModuleIds(this.dataDir, record.applicability.business_module_ids) } } : {}),
      ...(record.technology_assignment_required
        ? { technology_assignment_required: true as const } : {}),
      updated_at: record.updated_at,
    };
  }

  // -- 创建 --
  create(input: {
    id?: string;
    name: string;
    description?: string;
    scope: WorkflowAssetScope;
    owner: string;
    maintainers?: string[];
    definition: unknown;
    copied_from?: WorkflowSourceRef;
    actor?: string;
  }): WorkflowAssetSummary {
    const id = input.id ?? `wf-${randomBytes(6).toString("hex")}`;
    const dir = this.assetDir(id);
    if (existsSync(join(dir, "asset.json"))) {
      throw new WorkflowAssetError("invalid_input", `资产 ID 已被占用:${id}`);
    }
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 160) {
      throw new WorkflowAssetError("invalid_input", "资产名称不能为空且不超过 160 字");
    }
    if (input.scope !== "personal" && input.scope !== "team") {
      throw new WorkflowAssetError("invalid_input", "scope 只能是 personal 或 team");
    }
    const owner = normalizeActor(input.owner, "owner");
    const actor = normalizeActor(input.actor ?? owner, "actor");
    const definition = normalizeWorkflowDefinition(input.definition);
    definition.applicability.technologies = requireTechnologyStackChanges(
      this.dataDir, definition.applicability.technologies);
    const digest = workflowDigest(definition);
    const at = nowIso();

    // 账先行;随后 目录→draft→asset(提交点)。中断残骸(有目录无
    // asset.json)是惰性的:列表点名,同 ID 重建直接回收。
    this.logOperation("create", id, actor, {
      scope: input.scope, digest,
      ...(input.copied_from ? { copied_from: input.copied_from } : {}),
    });
    mkdirSync(join(dir, "versions"), { recursive: true });
    const draft: WorkflowDraftRecord = {
      schema: WORKFLOW_DRAFT_SCHEMA,
      revision: 1,
      definition,
      digest,
      updated_at: at,
      updated_by: actor,
    };
    this.atomicWriteJson(join(dir, "draft.json"), draft);
    const record: WorkflowAssetRecord = {
      schema: WORKFLOW_ASSET_SCHEMA,
      id,
      name,
      ...(input.description
        ? { description: String(input.description).slice(0, 1_000) } : {}),
      scope: input.scope,
      owner,
      maintainers: normalizeMaintainers(input.maintainers),
      status: "draft",
      latest_version: 0,
      draft_revision: 1,
      draft_digest: digest,
      ...(input.copied_from ? { copied_from: input.copied_from } : {}),
      applicability: definition.applicability,
      created_at: at,
      updated_at: at,
    };
    this.writeAsset(record);
    return this.summarize(record);
  }

  // -- 复制:副本深拷贝独立编辑,永不共享;copied_from 记出身 --
  copy(input: {
    source: WorkflowSourceRef;
    /** platform/task 来源必须由调用方带 definition(库够不到平台目录
     * 与任务存储);workflow 来源从本库已发布版本取。 */
    definition?: unknown;
    name: string;
    description?: string;
    scope: WorkflowAssetScope;
    owner: string;
    maintainers?: string[];
    actor?: string;
  }): WorkflowAssetSummary {
    const source = input.source;
    let definition: unknown;
    let copiedFrom: WorkflowSourceRef;
    if (source.kind === "workflow") {
      const origin = this.readAssetStrict(source.id);
      const version = source.version
        ? Number(String(source.version).replace(/^v/, ""))
        : origin.latest_version;
      if (!Number.isInteger(version) || version < 1
          || version > origin.latest_version) {
        throw new WorkflowAssetError(
          "not_found", `资产 ${source.id} 没有可复制的版本 ${source.version ?? "(latest)"}`);
      }
      const record = this.readVersionStrict(source.id, version);
      definition = record.definition;
      copiedFrom = {
        kind: "workflow", id: source.id,
        version: `v${version}`, digest: record.digest,
      };
    } else if (source.kind === "platform" || source.kind === "task") {
      if (input.definition == null) {
        throw new WorkflowAssetError(
          "invalid_input", `${source.kind} 来源复制必须提供 definition`);
      }
      definition = input.definition;
      copiedFrom = { ...source };
    } else {
      throw new WorkflowAssetError("invalid_input", "不支持的复制来源");
    }
    // normalizeWorkflowDefinition 返回全新对象——这就是深拷贝边界,
    // 副本与来源没有任何共享引用。
    const summary = this.create({
      name: input.name,
      description: input.description,
      scope: input.scope,
      owner: input.owner,
      maintainers: input.maintainers,
      definition,
      copied_from: copiedFrom,
      actor: input.actor,
    });
    return summary;
  }

  private readVersionStrict(id: string, version: number): WorkflowVersionRecord {
    const path = join(this.assetDir(id), "versions", `v${version}.json`);
    if (!existsSync(path)) {
      throw new WorkflowAssetError("not_found", `版本不存在:${id} v${version}`);
    }
    let record: WorkflowVersionRecord;
    try {
      record = parseJson<WorkflowVersionRecord>(readFileSync(path, "utf-8"));
    } catch {
      throw new WorkflowAssetError("corrupted", `版本文件损坏:${id} v${version}`);
    }
    if (record.schema !== WORKFLOW_VERSION_SCHEMA) {
      throw new WorkflowAssetError("corrupted", `版本 schema 不符:${id} v${version}`);
    }
    try {
      record.definition = normalizeWorkflowDefinition(record.definition);
    } catch (error) {
      throw new WorkflowAssetError(
        "corrupted", `版本定义不再符合契约:${id} v${version}(${String(
          (error as Error).message)})`);
    }
    return record;
  }

  // -- 列表:读侧宽容,坏账跳过并点名 --
  list(): WorkflowAssetListResult {
    const items: WorkflowAssetSummary[] = [];
    const warnings: string[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          warnings.push(`跳过符号链接:${entry.name}`);
        }
        continue;
      }
      if (!ASSET_ID.test(entry.name) || RESERVED_IDS.has(entry.name)) {
        warnings.push(`跳过不合法目录名:${entry.name}`);
        continue;
      }
      const path = join(this.root, entry.name, "asset.json");
      try {
        const record = parseJson<WorkflowAssetRecord>(
          readFileSync(path, "utf-8"));
        if (record.schema !== WORKFLOW_ASSET_SCHEMA
            || record.id !== entry.name) {
          warnings.push(`资产元数据 schema/ID 不符,已跳过:${entry.name}`);
          continue;
        }
        items.push(this.summarize(record));
      } catch {
        warnings.push(`资产元数据缺失或损坏,已跳过:${entry.name}`);
      }
    }
    items.sort((left, right) => left.id.localeCompare(right.id));
    return { items, warnings };
  }

  // -- 详情 --
  get(id: string): WorkflowAssetDetail {
    const record = this.readAssetStrict(id);
    const draft = this.readDraftStrict(id);
    const versions: WorkflowAssetDetail["versions"] = [];
    for (let version = 1; version <= record.latest_version; version += 1) {
      const item = this.readVersionStrict(id, version);
      versions.push({
        version: item.version,
        digest: item.digest,
        published_at: item.published_at,
        published_by: item.published_by,
      });
    }
    return { asset: this.summarize(record), draft, versions };
  }

  /** 任务创建选流程时用:必须已发布且未归档。指定 version 的历史读取
   * 不受归档影响(归档只挡"新任务默认选择",不消灭历史)。 */
  getPublished(id: string, version?: number): WorkflowVersionRecord {
    const record = this.readAssetStrict(id);
    if (record.latest_version < 1) {
      throw new WorkflowAssetError("invalid_state", `资产尚未发布:${id}`);
    }
    if (version == null && record.status === "archived") {
      throw new WorkflowAssetError(
        "invalid_state", `资产已归档,新任务不能再选择它:${id}`);
    }
    return this.readVersionStrict(id, version ?? record.latest_version);
  }

  // -- 草稿保存(乐观锁) --
  saveDraft(id: string, input: {
    definition: unknown;
    expected_revision: number;
    actor: string;
  }): WorkflowAssetDetail {
    const record = this.readAssetStrict(id);
    if (record.status === "archived") {
      throw new WorkflowAssetError("invalid_state", "资产已归档,不能修改草稿");
    }
    if (record.status === "pending_review") {
      throw new WorkflowAssetError(
        "invalid_state", "资产在待审核中,请先撤回再修改草稿");
    }
    const draft = this.readDraftStrict(id);
    if (draft.revision !== input.expected_revision) {
      // 可识别冲突:code + 当前 revision,前端据此提示刷新合并,
      // 而不是把别人刚存的草稿悄悄盖掉。
      throw new WorkflowAssetError(
        "revision_conflict",
        `草稿已被更新(当前 revision ${draft.revision},`
        + `提交基于 ${input.expected_revision})`,
        draft.revision,
      );
    }
    const actor = normalizeActor(input.actor, "actor");
    const definition = normalizeWorkflowDefinition(input.definition);
    definition.applicability.technologies = requireTechnologyStackChanges(
      this.dataDir, definition.applicability.technologies,
      draft.definition.applicability.technologies);
    const digest = workflowDigest(definition);
    const at = nowIso();
    const next: WorkflowDraftRecord = {
      schema: WORKFLOW_DRAFT_SCHEMA,
      revision: draft.revision + 1,
      definition,
      digest,
      updated_at: at,
      updated_by: actor,
    };
    // 账先行;随后 draft(乐观锁权威)→ asset(提交点/展示缓存)。
    // 中断在两者之间:draft.revision 已前进而 asset 缓存落后——锁
    // 语义不受影响(锁只看 draft.json),下一次成功写入自愈缓存。
    this.logOperation("save_draft", id, actor, {
      revision: next.revision, digest,
    });
    this.atomicWriteJson(join(this.assetDir(id), "draft.json"), next);
    record.draft_revision = next.revision;
    record.draft_digest = digest;
    record.applicability = definition.applicability;
    if (definition.applicability.technologies.length) delete record.technology_assignment_required;
    record.updated_at = at;
    // 改已发布资产 = 开新草稿周期:published → draft;vN 原样躺着。
    if (record.status === "published") record.status = "draft";
    this.writeAsset(record);
    return this.get(id);
  }

  // -- 生命周期:draft → pending_review → published;archived 终态 --
  /** 配置目录删除只清理当前关联；已发布版本仍供历史任务追溯。 */
  removeTechnologyReference(id: string, technologyId: string, actorInput: string): void {
    const record = this.readAssetStrict(id);
    const draft = this.readDraftStrict(id);
    const matches = (value: string) => {
      try { return normalizeKnowledgeLanguages([value])[0] === technologyId; }
      catch { return value === technologyId; }
    };
    const technologies = draft.definition.applicability.technologies.filter((value) => !matches(value));
    const draftChanged = technologies.length !== draft.definition.applicability.technologies.length;
    if (!draftChanged && !record.applicability?.technologies.some(matches)) return;
    const actor = normalizeActor(actorInput, "actor");
    const at = nowIso();
    const definition = normalizeWorkflowDefinition({ ...draft.definition,
      applicability: { ...draft.definition.applicability, technologies } });
    const next = { ...draft, definition, digest: workflowDigest(definition),
      revision: draft.revision + (draftChanged ? 1 : 0), updated_at: at, updated_by: actor };
    this.logOperation("remove_technology", id, actor, { technology_id: technologyId,
      revision: next.revision, digest: next.digest });
    if (draftChanged) this.atomicWriteJson(join(this.assetDir(id), "draft.json"), next);
    record.applicability = definition.applicability;
    if (!technologies.length) record.technology_assignment_required = true;
    else delete record.technology_assignment_required;
    record.draft_revision = next.revision;
    record.draft_digest = next.digest;
    record.updated_at = at;
    if (record.status !== "archived") record.status = "draft";
    this.writeAsset(record);
  }

  submitForReview(id: string, input: { actor: string }): WorkflowAssetSummary {
    return this.transition(id, input.actor, "submit", ["draft"],
      "pending_review");
  }

  withdraw(id: string, input: { actor: string }): WorkflowAssetSummary {
    return this.transition(id, input.actor, "withdraw", ["pending_review"],
      "draft");
  }

  reject(id: string, input: { actor: string; reason?: string }):
  WorkflowAssetSummary {
    return this.transition(id, input.actor, "reject", ["pending_review"],
      "draft", { ...(input.reason ? { reason: input.reason } : {}) });
  }

  private transition(
    id: string,
    actorInput: string,
    op: string,
    from: WorkflowAssetStatus[],
    to: WorkflowAssetStatus,
    detail: Record<string, unknown> = {},
  ): WorkflowAssetSummary {
    const record = this.readAssetStrict(id);
    const actor = normalizeActor(actorInput, "actor");
    if (!from.includes(record.status)) {
      throw new WorkflowAssetError(
        "invalid_state",
        `当前状态 ${record.status} 不能执行 ${op}(需要 ${from.join("/")})`);
    }
    this.logOperation(op, id, actor, detail);   // 账先行
    record.status = to;
    record.updated_at = nowIso();
    this.writeAsset(record);
    return this.summarize(record);
  }

  /** 通过审核并发布:草稿定格为 v(latest+1)。vN 用 link(2) 落盘,
   * 已存在即 EEXIST——"永不可覆盖"不靠自觉。
   * 可安全重试:上一次 approve 在 vN 落盘后、asset.json 提交前中断,
   * 重试会撞上已存在的 vN;此时若其 digest 与 from_revision 与当前
   * 草稿完全一致,判定为同一次发布的续跑,直接复用该文件补写提交点;
   * 内容不一致才是真冲突,version_exists 拒绝且现场原样。 */
  approve(id: string, input: { actor: string }): WorkflowAssetSummary {
    const record = this.readAssetStrict(id);
    const actor = normalizeActor(input.actor, "actor");
    if (record.status !== "pending_review") {
      throw new WorkflowAssetError(
        "invalid_state",
        `当前状态 ${record.status} 不能执行 approve(需要 pending_review)`);
    }
    const draft = this.readDraftStrict(id);
    if (record.technology_assignment_required && !draft.definition.applicability.technologies.length) {
      throw new WorkflowAssetError("invalid_input", "工作流的技术栈关联已清空，请补齐技术栈后重新发布");
    }
    requireTechnologyStackChanges(this.dataDir, draft.definition.applicability.technologies,
      draft.definition.applicability.technologies);
    const version = record.latest_version + 1;
    const versionRecord: WorkflowVersionRecord = {
      schema: WORKFLOW_VERSION_SCHEMA,
      version,
      definition: draft.definition,
      digest: draft.digest,
      published_at: nowIso(),
      published_by: actor,
      from_revision: draft.revision,
    };
    this.logOperation("approve", id, actor, {   // 账先行
      version, digest: draft.digest, from_revision: draft.revision,
    });
    try {
      this.immutableWriteJson(
        join(this.assetDir(id), "versions", `v${version}.json`),
        versionRecord);
    } catch (error) {
      if (!(error instanceof WorkflowAssetError)
          || error.code !== "version_exists") throw error;
      const existing = this.readVersionStrict(id, version);
      if (existing.digest !== draft.digest
          || existing.from_revision !== draft.revision) {
        // 内容不同:要么是上次发布在"vN 落盘"与"提交点写入"之间被杀
        // 留下的孤儿(不回收的话,改稿后重新发布永远撞 version_exists,
        // 资产整个焊死——2026-08-29 部署审计实锤,曾被故障测试当正确
        // 行为钉住),要么是提交点被拨回、诱导重写真发布版本的篡改。
        // 光看 latest_version 分不清这两者(拨回的就是它),铁证在
        // WAL:每次发布提交成功都补一笔 approve_commit,查得到的 vN
        // 是真发布过的,绝不覆盖;查不到的才是可回收的孤儿。
        if (this.hasApproveCommit(id, version)) {
          throw error;   // WAL 有提交确认:真发布过,永不可覆盖
        }
        // 回收动作照样账先行,孤儿的 digest 留痕可追。
        this.logOperation("approve", id, actor, {
          version, digest: draft.digest, from_revision: draft.revision,
          reclaimed_orphan_digest: existing.digest,
        });
        rmSync(join(this.assetDir(id), "versions", `v${version}.json`),
          { force: true });
        this.immutableWriteJson(
          join(this.assetDir(id), "versions", `v${version}.json`),
          versionRecord);
      }
      // 同 digest 同 from_revision:上次中断的续跑,复用已落盘的 vN。
    }
    record.status = "published";
    record.latest_version = version;
    record.published_digest = draft.digest;
    record.updated_at = versionRecord.published_at;
    this.writeAsset(record);
    // 唯一的账后行:它是"提交点已落定"的确认,天然只能写在提交之后。
    // 有它的 vN 从此铁证不可覆盖;这一笔本身被杀掉的窗口无害——
    // 状态已是 published,approve 不会再对同一个 version 走冲突分支。
    this.logOperation("approve_commit", id, actor, { version });
    return this.summarize(record);
  }

  /** WAL 里是否有 vN 的发布提交确认。证据链断了(读失败/坏行)一律
   * 按"有"处理:回收孤儿的前提是能证明它没发布过,证明不了就拒绝
   * (fail-closed,宁可让人来看也不冒覆盖已发布版本的险)。 */
  private hasApproveCommit(id: string, version: number): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.oplogPath, "utf-8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.op === "approve_commit" && entry.asset_id === id
            && entry.version === version) return true;
      } catch {
        return true;   // 账本有坏行=证据不全,按已发布对待
      }
    }
    return false;
  }

  /** 归档:只挡"新任务选择"这一件事;草稿、版本、留痕全部原样保留。 */
  archive(id: string, input: { actor: string }): WorkflowAssetSummary {
    const record = this.readAssetStrict(id);
    const actor = normalizeActor(input.actor, "actor");
    if (record.status === "archived") {
      throw new WorkflowAssetError("invalid_state", "资产已经归档");
    }
    this.logOperation("archive", id, actor, {   // 账先行
      status_before: record.status,
    });
    record.status_before_archive = record.status;
    record.status = "archived";
    record.updated_at = nowIso();
    this.writeAsset(record);
    return this.summarize(record);
  }
}
