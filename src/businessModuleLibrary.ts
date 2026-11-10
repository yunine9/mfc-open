/**
 * 业务模块与模块知识资产库。
 *
 * 模块是显式发布的团队实体，不从仓库目录或任务读过的文档推断。正文
 * 按版本保存；更新只切换当前元数据，历史任务自己的快照不受影响。
 */

import { businessModuleMigrations, commitBusinessModuleMigration, resolveBusinessModuleId } from "./businessModuleIdentity.ts";
import { createHash } from "node:crypto";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";
import { assertRepositoryCloneAddress } from "./repositoryAddress.ts";
import { componentRepositories } from "./componentRepositories.ts";
import { normalizeMrParticipants, type MrParticipants } from "./mrParticipants.ts";
import { normalizeRepositoryKnowledgeExclusions, type RepositoryKnowledgeExclusion } from "./businessModuleKnowledgeScope.ts";
import { validateRepoUrl } from "./issueFlow/issueGit.ts";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  repositoryIdentity,
  type KnowledgeForm,
} from "./knowledgeAssetModel.ts";

const ROOT = "business-modules";
const OPERATIONS = "business-module-operations.jsonl";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USERNAME = /^[A-Za-z0-9._-]{2,48}$/;
const MAX_ASSET_BYTES = 256 * 1024;
const MAX_ASSETS = 60;
const MAX_REPOSITORIES = 20;

export class BusinessModuleError extends Error {}

export type BusinessModuleStatus = "active" | "archived";
export type BusinessKnowledgeAssetStatus = "published" | "archived";

export interface BusinessKnowledgeAsset {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  /** 业务是性质；这里仅记录呈现形态。 */
  form: KnowledgeForm;
  /** 空数组表示适用于模块关联的全部仓库。 */
  repositories: string[];
  status: BusinessKnowledgeAssetStatus;
  version: number;
  digest: string;
  bytes: number;
  updated_at: string;
  updated_by: string;
}

export interface BusinessModuleKnowledgeLocation {
  repository: string;
  branch: string;
  /** 仓库根目录下的完整相对目录；读取和 MR 写入使用同一位置。 */
  docs_path: string;
}

export interface BusinessModule {
  id: string;
  name: string;
  description: string;
  owner: string;
  maintainers: string[];
  repositories: string[];
  /** 模块唯一保存的领域目录；仓库与分支统一取全局知识仓配置。 */
  knowledge_path?: string;
  /** 当前模块不使用的代码仓知识目录或文件；不删除远端文件或同步快照。 */
  repository_knowledge_exclusions?: RepositoryKnowledgeExclusion[];
  /** HTTP 视图派生的只读位置，不写入模块记录。 */
  knowledge_location?: BusinessModuleKnowledgeLocation;
  /** 本模块全部关联代码仓共用的新 MR 默认人员。 */
  mr_participants?: MrParticipants;
  /** 参考组件仓订阅(2026-09-23,ADR-0054):公共组件仓登记表条目的
   * id 引用,存引用不抄地址——登记表地址变更模块零跟进。问题会话
   * 开场只注入本模块订阅条目的描述;历史模块无此字段,读作空。 */
  reference_component_repos?: string[];
  status: BusinessModuleStatus;
  revision: number;
  assets: BusinessKnowledgeAsset[];
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface BusinessKnowledgeAssetDocument {
  module_id: string;
  module_name: string;
  asset: BusinessKnowledgeAsset;
  content: string;
}

export interface BusinessModuleOperation {
  at: string;
  operator: string;
  action: "create" | "update" | "archive" | "publish_asset"
    | "archive_asset" | "migrate";
  module_id: string;
  asset_id?: string;
  version?: number;
  detail?: string;
}

export interface BusinessModuleCatalog {
  modules: BusinessModule[];
  warnings: string[];
  operations: BusinessModuleOperation[];
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertId(value: string, label: string): string {
  const id = value.trim();
  if (!ID.test(id)) {
    throw new BusinessModuleError(
      `${label}只能使用字母、数字、点、下划线或短横线，最长 64 字符`,
    );
  }
  return id;
}

function required(value: string, label: string, max: number): string {
  const result = value.trim();
  if (!result) throw new BusinessModuleError(`${label}不能为空`);
  if (result.length > max) {
    throw new BusinessModuleError(`${label}不能超过 ${max} 个字符`);
  }
  return result;
}

function usernames(values: string[], owner?: string): string[] {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  for (const value of unique) {
    if (!USERNAME.test(value)) {
      throw new BusinessModuleError(`账号 ${value} 格式不合法`);
    }
  }
  return unique.filter((value) => value !== owner).sort();
}

function repositories(values: string[]): string[] {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  if (unique.length > MAX_REPOSITORIES) {
    throw new BusinessModuleError(`每个模块最多关联 ${MAX_REPOSITORIES} 个仓库`);
  }
  for (const value of unique) {
    if (value.length > 512 || /[\0\r\n]/.test(value)) {
      throw new BusinessModuleError("仓库地址不合法");
    }
  }
  return unique;
}

/** 模块是仓在登记侧的唯一来源，零仓模块没有存在价值；资产的作用域仓
 * 允许为空（表示适用全部关联仓），所以下限不放进 repositories()，
 * 只把守模块自身的保存。 */
function moduleRepositories(values: string[]): string[] {
  const unique = repositories(values);
  if (!unique.length) {
    throw new BusinessModuleError("业务模块必须至少绑定一个代码仓");
  }
  try { unique.forEach(assertRepositoryCloneAddress); }
  catch (error) {
    throw new BusinessModuleError(error instanceof Error ? error.message : "代码仓地址无效");
  }
  return unique;
}

function moduleMrParticipants(value: unknown): MrParticipants | undefined {
  if (value === undefined) return undefined;
  try {
    const participants = normalizeMrParticipants(value);
    return Object.values(participants).some((accounts) => accounts.length)
      ? participants : undefined;
  } catch (error) {
    throw new BusinessModuleError(error instanceof Error ? error.message : "MR 默认人员配置不合法");
  }
}

function moduleKnowledgeExclusions(value: unknown, repositories: readonly string[]) {
  try { return normalizeRepositoryKnowledgeExclusions(value, repositories); }
  catch (error) { throw new BusinessModuleError(error instanceof Error ? error.message : "知识文档筛选格式不正确"); }
}

export function normalizeModuleKnowledgeLocation(value: unknown): BusinessModuleKnowledgeLocation | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BusinessModuleError("请填写领域知识仓库、分支和相对目录");
  const input = value as Record<string, unknown>;
  if (["repository", "branch", "docs_path"].some(key => typeof input[key] !== "string")) throw new BusinessModuleError("请填写领域知识仓库、分支和相对目录");
  const repository = String(input.repository).trim();
  if (!repository || repository.length > 1024 || /[\x00-\x1f]/.test(repository) || /^git@/.test(repository)) throw new BusinessModuleError("领域知识仓库地址无效，请填写 HTTPS 克隆地址");
  try {
    validateRepoUrl(repository);
    assertRepositoryCloneAddress(repository);
    if (/^https?:\/\//i.test(repository)) {
      const url = new URL(repository);
      if (url.username || url.password || url.search || url.hash) throw new Error("仓库地址不能包含凭据、查询参数或片段");
    }
  } catch (error) { throw new BusinessModuleError(error instanceof Error ? error.message : "领域知识仓库地址无效"); }
  const branch = String(input.branch).trim();
  if (!branch || branch.length > 255 || branch === "@" || branch.startsWith("-") || branch.startsWith("/")
      || /[\s\\~^:?*\[\x00-\x1f]|\.\.|@\{|\/\/|\.$|\/$|\.lock(?:\/|$)/.test(branch)
      || branch.split("/").some(part => part.startsWith("."))) throw new BusinessModuleError("领域知识分支格式无效");
  const docs_path = normalizeModuleKnowledgePath(input.docs_path);
  return { repository: validateRepoUrl(repository), branch, docs_path };
}

export function normalizeModuleKnowledgePath(value: unknown): string {
  if (typeof value !== "string") throw new BusinessModuleError("领域知识目录必须是仓库根目录下的相对目录");
  const path = value.trim().replace(/\/+$/, "");
  if (!path || path.length > 1000 || path.startsWith("/") || /^[a-z]:/i.test(path)
      || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
    throw new BusinessModuleError("领域知识目录必须是仓库根目录下的相对目录，例如 Function_Knowledge/Access Function/交易业务");
  }
  return path;
}

export function defaultModuleKnowledgePath(name: string): string {
  const readable = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^[. ]+|[. ]+$/g, "") || "领域知识";
  return normalizeModuleKnowledgePath(`Function_Knowledge/Access Function/${readable}`);
}

function moduleKnowledgePathInput(dataDir: string, input: { knowledge_path?: unknown; knowledge_location?: unknown }, fallback?: string): string | undefined {
  let legacyPath: string | undefined;
  if (input.knowledge_location !== undefined) {
    const location = normalizeModuleKnowledgeLocation(input.knowledge_location), global = readKnowledgeRepoConfig(dataDir);
    if (!location || !global || repositoryIdentity(location.repository) !== repositoryIdentity(global.url) || location.branch !== (global.branch || "master")) {
      throw new BusinessModuleError("领域知识仓库和分支由平台统一配置，模块只能设置仓内相对目录");
    }
    legacyPath = location.docs_path;
  }
  if (input.knowledge_path !== undefined) {
    const path = normalizeModuleKnowledgePath(input.knowledge_path);
    if (legacyPath && legacyPath !== path) throw new BusinessModuleError("领域知识目录参数不一致，请只提交 knowledge_path");
    return path;
  }
  return legacyPath ?? fallback;
}

function assertKnowledgeLocationAvailable(dataDir: string, id: string, path?: string) {
  if (!path) return;
  const normalized = path.normalize("NFC").toLowerCase();
  const conflict = listBusinessModules(dataDir).modules.find(module => {
    const other = module.knowledge_path?.normalize("NFC").toLowerCase();
    return module.id !== id && module.status === "active" && other
      && (other === normalized || other.startsWith(`${normalized}/`) || normalized.startsWith(`${other}/`));
  });
  if (conflict) throw new BusinessModuleError(`领域知识目录与“${conflict.name}”重叠，请为每个模块设置独立目录`);
}

/** 参考组件仓存登记表条目 id，不复制地址。只校验本次提交的引用；
 * 修改模块其他字段时保留已有引用，不因组件条目已删除而阻塞保存。
 * 停用条目允许引用，停用只影响问题会话是否读取。 */
function referenceComponentRepos(dataDir: string, values: unknown): string[] {
  const unique = [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item).trim()).filter(Boolean))];
  if (!unique.length) return [];
  let known: Set<string>;
  try {
    known = new Set(componentRepositories(dataDir).map((row) => row.id));
  } catch {
    throw new BusinessModuleError(
      "公共组件仓登记表不可读，暂时无法核对参考组件仓订阅");
  }
  const missing = unique.filter((id) => !known.has(id));
  if (missing.length) {
    throw new BusinessModuleError(
      `引用的组件仓条目不存在：${missing.join("、")}`
        + "（请从公共组件仓登记表重新选择）");
  }
  return unique;
}

function root(dataDir: string): string {
  return join(dataDir, ROOT);
}

function moduleRoot(dataDir: string, id: string): string {
  return join(root(dataDir), id);
}

function moduleFile(dataDir: string, id: string): string {
  return join(moduleRoot(dataDir, id), "module.json");
}

function assertOrdinaryDirectory(path: string): void {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink()
      || !lstatSync(path).isDirectory())) {
    throw new BusinessModuleError(`模块存储路径不是普通目录：${path}`);
  }
}

function parseModule(value: unknown): BusinessModule {
  const module = value as BusinessModule;
  if (!module || !ID.test(String(module.id ?? ""))
      || !module.name || !USERNAME.test(String(module.owner ?? ""))
      || !Array.isArray(module.assets) || !Array.isArray(module.maintainers)
      || !Array.isArray(module.repositories)
      || !["active", "archived"].includes(module.status)) {
    throw new BusinessModuleError("业务模块元数据损坏");
  }
  const { knowledge_location: legacy, ...record } = module;
  if (module.knowledge_path === undefined && legacy !== undefined && legacy !== null
      && (typeof legacy !== "object" || Array.isArray(legacy) || typeof legacy.docs_path !== "string")) {
    throw new BusinessModuleError("业务模块领域知识目录损坏");
  }
  const path = module.knowledge_path ?? legacy?.docs_path ?? defaultModuleKnowledgePath(module.name);
  return {
    ...record,
    knowledge_path: normalizeModuleKnowledgePath(path),
    repository_knowledge_exclusions: moduleKnowledgeExclusions(module.repository_knowledge_exclusions, module.repositories),
    mr_participants: moduleMrParticipants(module.mr_participants),
    reference_component_repos: Array.isArray(module.reference_component_repos)
      ? module.reference_component_repos.map(String) : [],
    assets: module.assets.map((asset) => ({
      ...asset,
      // 兼容历史资产：旧 languages 不再参与业务知识归属或匹配。
      form: ["document", "skill", "rule", "example"].includes(
        String((asset as BusinessKnowledgeAsset).form ?? ""))
        ? (asset as BusinessKnowledgeAsset).form : "document",
      repositories: Array.isArray((asset as BusinessKnowledgeAsset).repositories)
        ? repositories((asset as BusinessKnowledgeAsset).repositories) : [],
    })),
  };
}

function writeModule(dataDir: string, module: BusinessModule): void {
  const home = moduleRoot(dataDir, module.id);
  assertOrdinaryDirectory(root(dataDir));
  assertOrdinaryDirectory(home);
  mkdirSync(home, { recursive: true, mode: 0o750 });
  const file = moduleFile(dataDir, module.id);
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(module, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o640,
    });
    chmodSync(temporary, 0o640);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function operation(dataDir: string, value: BusinessModuleOperation): void {
  mkdirSync(root(dataDir), { recursive: true, mode: 0o750 });
  const file = join(root(dataDir), OPERATIONS);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new BusinessModuleError("业务模块操作留痕不能是软链接");
  }
  appendFileSync(file,
    `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o640 });
}

function operations(dataDir: string): BusinessModuleOperation[] {
  const file = join(root(dataDir), OPERATIONS);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return [];
  try {
    return readFileSync(file, "utf-8").split("\n").filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as BusinessModuleOperation;
          return value?.module_id && value?.action ? [value] : [];
        } catch { return []; }
      }).sort((left, right) => right.at.localeCompare(left.at));
  } catch { return []; }
}

function readStoredBusinessModule(dataDir: string, value: string): BusinessModule {
  const id = assertId(value, "模块 ID");
  const home = moduleRoot(dataDir, id);
  const file = moduleFile(dataDir, id);
  assertOrdinaryDirectory(root(dataDir));
  assertOrdinaryDirectory(home);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()
      || !lstatSync(file).isFile()) {
    throw new BusinessModuleError(`没有业务模块 ${id}`);
  }
  try {
    return parseModule(JSON.parse(readFileSync(file, "utf-8")));
  } catch (error) {
    if (error instanceof BusinessModuleError) throw error;
    throw new BusinessModuleError(`业务模块 ${id} 元数据损坏`);
  }
}

// 迁入资产保留原版本文件和发布指纹。独立编号避免目标模块的同名资产被覆盖。
function migratedAssetId(moduleId: string, assetId: string): string {
  return `migrated-${digest(`${moduleId}:${assetId}`).slice(0, 32)}`;
}
function moduleSources(dataDir: string, targetId: string): string[] {
  return businessModuleMigrations(dataDir).map(row => row.source.id)
    .filter(id => resolveBusinessModuleId(dataDir, id) === targetId);
}
export function readBusinessModule(dataDir: string, value: string): BusinessModule {
  const id = resolveBusinessModuleId(dataDir, assertId(value, "模块 ID"));
  const module = readStoredBusinessModule(dataDir, id);
  const sources = moduleSources(dataDir, id);
  if (!sources.length) return module;
  return { ...module, assets: [...module.assets, ...sources.flatMap(sourceId =>
    readStoredBusinessModule(dataDir, sourceId).assets.map(asset => ({ ...asset, id: migratedAssetId(sourceId, asset.id) }))) ] };
}
function assetLocation(dataDir: string, moduleId: string, assetId: string) {
  const targetId = resolveBusinessModuleId(dataDir, moduleId);
  const original = readStoredBusinessModule(dataDir, moduleId);
  if (original.assets.some(asset => asset.id === assetId)) return { module: original, assetId, targetId };
  for (const source of moduleSources(dataDir, targetId)) {
    const module = readStoredBusinessModule(dataDir, source);
    const asset = module.assets.find(asset => migratedAssetId(source, asset.id) === assetId);
    if (asset) return { module, assetId: asset.id, targetId };
  }
  return { module: readStoredBusinessModule(dataDir, targetId), assetId, targetId };
}
export function resolveBusinessKnowledgeAssetReference(dataDir: string, moduleId: string, assetId: string) {
  const location = assetLocation(dataDir, moduleId, assetId);
  return { moduleId: location.targetId, assetId: location.module.id === location.targetId
    ? location.assetId : migratedAssetId(location.module.id, location.assetId) };
}
export function migrateBusinessModule(dataDir: string, sourceId: string, targetId: string, operator: string) {
  sourceId = assertId(sourceId, "原模块 ID"); targetId = assertId(targetId, "目标模块 ID");
  if (sourceId === targetId) throw new BusinessModuleError("请选择另一个业务模块");
  const resolvedSource = resolveBusinessModuleId(dataDir, sourceId);
  if (resolvedSource !== sourceId) {
    if (resolvedSource === targetId) return readBusinessModule(dataDir, targetId);
    throw new BusinessModuleError("原模块已迁移，请刷新列表");
  }
  if (resolveBusinessModuleId(dataDir, targetId) !== targetId) throw new BusinessModuleError("目标模块已迁移，请刷新列表");
  const source = readBusinessModule(dataDir, sourceId), target = readBusinessModule(dataDir, targetId);
  if (target.status !== "active") throw new BusinessModuleError("请选择正常使用的目标模块");
  const incoming = [sourceId, ...moduleSources(dataDir, sourceId)].flatMap(id =>
    readStoredBusinessModule(dataDir, id).assets.map(asset => ({ moduleId: id, asset })));
  const ids = new Set(target.assets.map(asset => asset.id));
  for (const { moduleId, asset } of incoming) {
    const id = migratedAssetId(moduleId, asset.id);
    if (ids.has(id)) throw new BusinessModuleError("迁入的知识编号与目标模块冲突，请先调整目标模块的知识编号");
    ids.add(id);
    for (let version = 1; version <= asset.version; version++) readBusinessKnowledgeAsset(dataDir, moduleId, asset.id, version);
  }
  commitBusinessModuleMigration(dataDir, { source: { id: source.id, name: source.name },
    target: { id: target.id, name: target.name }, at: new Date().toISOString(), operator });
  return readBusinessModule(dataDir, targetId);
}

export function listBusinessModules(dataDir: string): BusinessModuleCatalog {
  const home = root(dataDir);
  if (!existsSync(home)) return { modules: [], warnings: [], operations: [] };
  assertOrdinaryDirectory(home);
  const modules: BusinessModule[] = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ID.test(entry.name)) {
      continue;
    }
    try {
      if (resolveBusinessModuleId(dataDir, entry.name) === entry.name) modules.push(readBusinessModule(dataDir, entry.name));
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));
  return { modules, warnings, operations: [...operations(dataDir), ...businessModuleMigrations(dataDir).map(row => ({ at: row.at, operator: row.operator, action: "migrate" as const, module_id: row.source.id, detail: `${row.source.name} → ${row.target.name}` }))].sort((a, b) => b.at.localeCompare(a.at)) };
}

export function canManageBusinessModule(
  _module: BusinessModule,
  username: string | undefined,
  admin = false,
): boolean {
  // 保留 Owner 元数据兼容历史记录；它不再是团队配置/知识的权限边界。
  return admin || !!username;
}

export function createBusinessModule(
  dataDir: string,
  input: {
    id: string;
    name: string;
    description: string;
    owner: string;
    maintainers?: string[];
    repositories?: string[];
    knowledge_path?: unknown;
    repository_knowledge_exclusions?: unknown;
    knowledge_location?: unknown;
    mr_participants?: unknown;
    reference_component_repos?: string[];
  },
  operator: string,
): BusinessModule {
  const id = assertId(input.id, "模块 ID");
  if (existsSync(moduleFile(dataDir, id))) {
    throw new BusinessModuleError(`业务模块 ${id} 已存在`);
  }
  const owner = required(input.owner, "Owner", 48);
  if (!USERNAME.test(owner)) throw new BusinessModuleError("Owner 账号格式不合法");
  const now = new Date().toISOString();
  const linkedRepositories = moduleRepositories(input.repositories ?? []);
  const module: BusinessModule = {
    id,
    name: required(input.name, "模块名称", 80),
    description: required(input.description, "模块说明", 500),
    owner,
    maintainers: usernames(input.maintainers ?? [], owner),
    repositories: linkedRepositories,
    knowledge_path: moduleKnowledgePathInput(dataDir, input, defaultModuleKnowledgePath(String(input.name ?? ""))),
    repository_knowledge_exclusions: moduleKnowledgeExclusions(input.repository_knowledge_exclusions, linkedRepositories),
    mr_participants: moduleMrParticipants(input.mr_participants),
    reference_component_repos: referenceComponentRepos(
      dataDir, input.reference_component_repos ?? []),
    status: "active",
    revision: 1,
    assets: [],
    created_at: now,
    created_by: operator,
    updated_at: now,
    updated_by: operator,
  };
  assertKnowledgeLocationAvailable(dataDir, id, module.knowledge_path);
  writeModule(dataDir, module);
  operation(dataDir, { at: now, operator, action: "create", module_id: id });
  return module;
}

export function updateBusinessModule(
  dataDir: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    owner?: string;
    maintainers?: string[];
    repositories?: string[];
    knowledge_path?: unknown;
    repository_knowledge_exclusions?: unknown;
    knowledge_location?: unknown;
    mr_participants?: unknown;
    reference_component_repos?: string[];
    status?: BusinessModuleStatus;
  },
  operator: string,
): BusinessModule {
  if (resolveBusinessModuleId(dataDir, id) !== id) throw new BusinessModuleError("模块已迁移，请刷新列表");
  const current = readStoredBusinessModule(dataDir, id);
  const owner = patch.owner === undefined ? current.owner
    : required(patch.owner, "Owner", 48);
  if (!USERNAME.test(owner)) throw new BusinessModuleError("Owner 账号格式不合法");
  const status = patch.status ?? current.status;
  if (!["active", "archived"].includes(status)) {
    throw new BusinessModuleError("模块状态只能是 active 或 archived");
  }
  const now = new Date().toISOString();
  const nextRepositories = patch.repositories === undefined ? current.repositories : moduleRepositories(patch.repositories);
  const retainedExclusions = (current.repository_knowledge_exclusions ?? []).filter(entry =>
    nextRepositories.some(repository => repositoryIdentity(repository) === repositoryIdentity(entry.repository)));
  const updated: BusinessModule = {
    ...current,
    name: patch.name === undefined ? current.name
      : required(patch.name, "模块名称", 80),
    description: patch.description === undefined ? current.description
      : required(patch.description, "模块说明", 500),
    owner,
    maintainers: patch.maintainers === undefined
      ? current.maintainers.filter((item) => item !== owner)
      : usernames(patch.maintainers, owner),
    repositories: nextRepositories,
    knowledge_path: moduleKnowledgePathInput(dataDir, patch, current.knowledge_path),
    repository_knowledge_exclusions: moduleKnowledgeExclusions(
      patch.repository_knowledge_exclusions === undefined ? retainedExclusions : patch.repository_knowledge_exclusions, nextRepositories),
    mr_participants: patch.mr_participants === undefined
      ? current.mr_participants : moduleMrParticipants(patch.mr_participants),
    reference_component_repos: patch.reference_component_repos === undefined
      ? current.reference_component_repos
      : referenceComponentRepos(dataDir, patch.reference_component_repos),
    status,
    revision: current.revision + 1,
    updated_at: now,
    updated_by: operator,
  };
  assertKnowledgeLocationAvailable(dataDir, id, updated.knowledge_path);
  writeModule(dataDir, updated);
  operation(dataDir, {
    at: now, operator,
    action: status === "archived" && current.status !== "archived"
      ? "archive" : "update",
    module_id: current.id,
  });
  return readBusinessModule(dataDir, updated.id);
}

function assetVersionFile(
  dataDir: string,
  moduleId: string,
  assetId: string,
  version: number,
): string {
  return join(moduleRoot(dataDir, moduleId), "assets", assetId,
    `v${version}.md`);
}

function assetVersionManifestFile(
  dataDir: string,
  moduleId: string,
  assetId: string,
  version: number,
): string {
  return join(moduleRoot(dataDir, moduleId), "assets", assetId,
    `v${version}.json`);
}

/**
 * 每个发布版本都保存当时的治理元数据和正文指纹。只有 Markdown 文件
 * 无法证明历史 vN 仍是发布时那一版，也会错误套用当前标题/作用域。
 */
function readAssetVersionManifest(
  dataDir: string,
  moduleId: string,
  assetId: string,
  version: number,
): BusinessKnowledgeAsset | undefined {
  const file = assetVersionManifestFile(
    dataDir, moduleId, assetId, version);
  if (!existsSync(file)) return undefined;
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new BusinessModuleError("知识版本发布清单不是普通文件");
  }
  try {
    const asset = JSON.parse(readFileSync(file, "utf-8")) as
      BusinessKnowledgeAsset;
    if (!asset || asset.id !== assetId || asset.version !== version
        || !asset.title || !asset.summary || !asset.when_to_use
        || !["document", "skill", "rule", "example"].includes(asset.form)
        || !Array.isArray(asset.repositories)
        || !["published", "archived"].includes(asset.status)
        || !/^[a-f0-9]{64}$/.test(String(asset.digest ?? ""))
        || !Number.isInteger(asset.bytes) || asset.bytes < 0
        || asset.bytes > MAX_ASSET_BYTES
        || !asset.updated_at || !asset.updated_by) {
      throw new Error("invalid manifest");
    }
    return { ...asset, repositories: repositories(asset.repositories) };
  } catch (error) {
    if (error instanceof BusinessModuleError) throw error;
    throw new BusinessModuleError("知识版本发布清单损坏");
  }
}

export function publishBusinessKnowledgeAsset(
  dataDir: string,
  moduleId: string,
  input: {
    id: string;
    title: string;
    summary: string;
    when_to_use: string;
    form?: KnowledgeForm;
    repositories?: string[];
    content: string;
  },
  operator: string,
): BusinessModule {
  const location = assetLocation(dataDir, moduleId, assertId(input.id, "资产 ID"));
  const module = location.module;
  const target = readBusinessModule(dataDir, location.targetId);
  if (target.status !== "active") {
    throw new BusinessModuleError("已归档模块不能发布知识");
  }
  const assetId = location.assetId;
  const content = input.content.replace(/\r\n/g, "\n");
  if (!content.trim()) throw new BusinessModuleError("知识正文不能为空");
  if (content.includes("\0")) throw new BusinessModuleError("知识正文包含二进制内容");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_ASSET_BYTES) {
    throw new BusinessModuleError("单项知识正文不能超过 256 KiB");
  }
  const previous = module.assets.find((item) => item.id === assetId);
  if (!previous && module.assets.length >= MAX_ASSETS) {
    throw new BusinessModuleError(`每个模块最多发布 ${MAX_ASSETS} 项知识`);
  }
  const now = new Date().toISOString();
  const form = input.form ?? previous?.form ?? "document";
  if (!["document", "skill", "rule", "example"].includes(form)) {
    throw new BusinessModuleError("知识形态只能是文档、Skill、规则或示例");
  }
  const applicableRepositories = input.repositories === undefined
    ? previous?.repositories ?? [] : repositories(input.repositories);
  const moduleRepositories = new Set([...target.repositories, ...(previous?.repositories ?? [])].map(repositoryIdentity));
  for (const repository of applicableRepositories) {
    if (!moduleRepositories.has(repositoryIdentity(repository))) {
      throw new BusinessModuleError(
        `适用仓库 ${repository} 未关联到业务模块 ${module.name}`);
    }
  }
  const asset: BusinessKnowledgeAsset = {
    id: assetId,
    title: required(input.title, "资产标题", 120),
    summary: required(input.summary, "资产摘要", 500),
    when_to_use: required(input.when_to_use, "适用场景", 500),
    form,
    repositories: applicableRepositories,
    status: "published",
    version: (previous?.version ?? 0) + 1,
    digest: digest(content),
    bytes,
    updated_at: now,
    updated_by: operator,
  };
  const file = assetVersionFile(dataDir, module.id, asset.id, asset.version);
  const manifest = assetVersionManifestFile(
    dataDir, module.id, asset.id, asset.version);
  const home = join(moduleRoot(dataDir, module.id), "assets", asset.id);
  assertOrdinaryDirectory(join(moduleRoot(dataDir, module.id), "assets"));
  assertOrdinaryDirectory(home);
  mkdirSync(home, { recursive: true, mode: 0o750 });
  if (existsSync(file) || existsSync(manifest)) {
    throw new BusinessModuleError("知识版本文件已存在，拒绝覆盖历史版本");
  }
  try {
    writeFileSync(file, content,
      { encoding: "utf-8", mode: 0o640, flag: "wx" });
    chmodSync(file, 0o640);
    writeFileSync(manifest, `${JSON.stringify(asset, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o640, flag: "wx" });
    chmodSync(manifest, 0o640);
  } catch (error) {
    rmSync(file, { force: true });
    rmSync(manifest, { force: true });
    throw error;
  }
  const updated: BusinessModule = {
    ...module,
    revision: module.revision + 1,
    assets: [...module.assets.filter((item) => item.id !== asset.id), asset]
      .sort((left, right) => left.title.localeCompare(right.title)),
    updated_at: now,
    updated_by: operator,
  };
  try {
    writeModule(dataDir, updated);
  } catch (error) {
    rmSync(file, { force: true });
    rmSync(manifest, { force: true });
    throw error;
  }
  operation(dataDir, {
    at: now, operator, action: "publish_asset", module_id: module.id,
    asset_id: asset.id, version: asset.version,
  });
  return readBusinessModule(dataDir, updated.id);
}

export function readBusinessKnowledgeAsset(
  dataDir: string,
  moduleId: string,
  assetIdValue: string,
  version?: number,
): BusinessKnowledgeAssetDocument {
  const location = assetLocation(dataDir, moduleId, assertId(assetIdValue, "资产 ID"));
  const module = location.module;
  const assetId = location.assetId;
  const current = module.assets.find((item) => item.id === assetId);
  if (!current) throw new BusinessModuleError(`模块 ${module.id} 没有知识 ${assetId}`);
  const wanted = version ?? current.version;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > current.version) {
    throw new BusinessModuleError("知识版本不存在");
  }
  const file = assetVersionFile(dataDir, module.id, assetId, wanted);
  assertOrdinaryDirectory(join(moduleRoot(dataDir, module.id), "assets"));
  assertOrdinaryDirectory(join(
    moduleRoot(dataDir, module.id), "assets", assetId));
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()
      || !lstatSync(file).isFile()) {
    throw new BusinessModuleError("知识正文版本不存在或不是普通文件");
  }
  const content = readFileSync(file, "utf-8");
  const contentDigest = digest(content);
  const manifest = readAssetVersionManifest(
    dataDir, module.id, assetId, wanted);
  // 升级前的当前版本仍可由 module.json 中既有发布指纹核对；历史版本
  // 没有同等证据时必须诚实拒绝，不能现场重算后冒充原发布身份。
  if (!manifest && wanted !== current.version) {
    throw new BusinessModuleError(
      "知识历史版本缺少发布清单，无法核对发布指纹");
  }
  const published = manifest ?? current;
  if (contentDigest !== published.digest
      || Buffer.byteLength(content, "utf-8") !== published.bytes) {
    throw new BusinessModuleError("知识正文与发布指纹不一致");
  }
  if (manifest && wanted === current.version
      && JSON.stringify({
        id: current.id, title: current.title, summary: current.summary,
        when_to_use: current.when_to_use, form: current.form,
        repositories: current.repositories, version: current.version,
        digest: current.digest, bytes: current.bytes,
      }) !== JSON.stringify({
        id: manifest.id, title: manifest.title, summary: manifest.summary,
        when_to_use: manifest.when_to_use, form: manifest.form,
        repositories: manifest.repositories, version: manifest.version,
        digest: manifest.digest, bytes: manifest.bytes,
      })) {
    throw new BusinessModuleError("知识元数据与版本发布清单不一致");
  }
  const asset = wanted === current.version
    ? { ...published, status: current.status }
    : published;
  const target = readStoredBusinessModule(dataDir, location.targetId);
  return { module_id: target.id, module_name: target.name,
    asset: { ...asset, id: module.id === target.id ? asset.id : migratedAssetId(module.id, asset.id) }, content };
}

export function archiveBusinessKnowledgeAsset(
  dataDir: string,
  moduleId: string,
  assetIdValue: string,
  operator: string,
): BusinessModule {
  const location = assetLocation(dataDir, moduleId, assertId(assetIdValue, "资产 ID"));
  const module = location.module;
  const assetId = location.assetId;
  const current = module.assets.find((item) => item.id === assetId);
  if (!current) throw new BusinessModuleError(`模块 ${module.id} 没有知识 ${assetId}`);
  if (current.status === "archived") return readBusinessModule(dataDir, moduleId);
  const now = new Date().toISOString();
  const updated: BusinessModule = {
    ...module,
    revision: module.revision + 1,
    assets: module.assets.map((item) => item.id === assetId
      ? { ...item, status: "archived" as const, updated_at: now,
          updated_by: operator }
      : item),
    updated_at: now,
    updated_by: operator,
  };
  writeModule(dataDir, updated);
  operation(dataDir, {
    at: now, operator, action: "archive_asset", module_id: module.id,
    asset_id: assetId, version: current.version,
  });
  return readBusinessModule(dataDir, updated.id);
}
