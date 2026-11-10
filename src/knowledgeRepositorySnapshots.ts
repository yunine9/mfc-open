import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { durableWriteFileSync } from "./durableWrite.ts";
import { listBusinessModules, readBusinessModule, type BusinessModule } from "./businessModuleLibrary.ts";
import { resolveModuleKnowledgeLocation } from "./businessModuleKnowledge.ts";
import { moduleIncludesRepositoryKnowledge } from "./businessModuleKnowledgeScope.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import type { KnowledgeDocument } from "./knowledgeDocuments.ts";
import type { FrozenGitKnowledgeDocumentResources, FrozenGitKnowledgeResources } from "./knowledgeRepositoryTypes.ts";
export type { FrozenGitKnowledgeDocumentResources, FrozenGitKnowledgeResources } from "./knowledgeRepositoryTypes.ts";

export interface KnowledgeRepositoryLocation { repository: string; branch: string; docs_path: string }
export interface ModuleKnowledgeSync {
  module_id: string;
  state: "syncing" | "ready" | "partial" | "failed";
  location: KnowledgeRepositoryLocation;
  attempted_at: string;
  synced_at?: string;
  commit?: string;
  document_count: number;
  error?: string;
  warnings?: string[];
  repositories?: Array<{ repository: string; branch: string; revision: string; synced_at?: string; scope?: "module" | "repository" }>;
}
export interface GitKnowledgeSnapshot {
  module_id: string;
  location: KnowledgeRepositoryLocation;
  synced_at: string;
  documents: KnowledgeDocument[];
  /** 只保存文稿实际引用的资源；共享图片按摘要只存一份。 */
  resources: Record<string, { digest: string; content_type: string }>;
  repositories: NonNullable<ModuleKnowledgeSync["repositories"]>;
}
export type GitKnowledgeDocumentMetadata = Omit<KnowledgeDocument, "content"> & { lines: number };
interface SnapshotReadIndex extends Omit<GitKnowledgeSnapshot, "documents"> {
  format: 1;
  memory_only?: true;
  snapshot_signature: string;
  content_bytes: number;
  documents: GitKnowledgeDocumentMetadata[];
  contents: Record<string, { offset: number; bytes: number; digest: string; resource_paths: string[] }>;
}
export const gitKnowledgeRoot = (dataDir: string) => join(dataDir, "knowledge-git");
const moduleKey = (id: string) => createHash("sha256").update(id).digest("hex");
const snapshotPath = (dataDir: string, moduleId: string) => join(gitKnowledgeRoot(dataDir), "modules", `${moduleKey(moduleId)}.json`);
const statusPath = (dataDir: string, moduleId: string) => join(gitKnowledgeRoot(dataDir), "status", `${moduleKey(moduleId)}.json`);
const snapshotCache = new Map<string, { signature: string; bytes: number; value: GitKnowledgeSnapshot }>();
const corruptFiles = new Set<string>();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const readIndexCache = new Map<string, { signature: string; bytes: number; value: SnapshotReadIndex }>();
const MAX_INDEX_CACHE_BYTES = 8 * 1024 * 1024;
const fileSignature = (path: string) => {
  const stat = statSync(path);
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
};
const readIndexRoot = (dataDir: string, moduleId: string) => join(gitKnowledgeRoot(dataDir), "read-cache", moduleKey(moduleId));
const readIndexDirectory = (dataDir: string, moduleId: string, signature: string) => join(readIndexRoot(dataDir, moduleId), moduleKey(signature));
const text = (value: unknown): value is string => typeof value === "string";
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const validLocation = (value: unknown): value is KnowledgeRepositoryLocation => record(value)
  && [value.repository, value.branch, value.docs_path].every(text);
function validSnapshot(value: unknown, moduleId: string): value is GitKnowledgeSnapshot {
  return record(value) && value.module_id === moduleId && validLocation(value.location) && text(value.synced_at)
    && Number.isFinite(Date.parse(value.synced_at)) && Array.isArray(value.documents) && value.documents.every(document => record(document)
      && /^kg-[a-f0-9]{64}$/.test(document.id) && [document.title, document.content, document.revision, document.when_to_use].every(text)
      && ["module", "repository"].includes(document.scope) && [document.module_ids, document.repositories, document.technologies, document.product_versions].every(strings)
      && typeof document.active === "boolean" && Array.isArray(document.history) && record(document.source)
      && [document.source.repository, document.source.branch, document.source.path, document.source.revision].every(text))
    && Array.isArray(value.repositories) && value.repositories.every(source => record(source) && [source.repository, source.branch, source.revision].every(text))
    && record(value.resources) && Object.entries(value.resources).every(([key, resource]) => {
      try { const parts = JSON.parse(key); return Array.isArray(parts) && parts.length === 4 && parts.every(text)
        && record(resource) && /^[a-f0-9]{64}$/.test(resource.digest) && text(resource.content_type); } catch { return false; }
    });
}
function preserveCorruptFile(path: string) {
  if (!corruptFiles.has(path) || !existsSync(path)) return;
  const backup = `${path}.corrupt-${randomUUID()}`;
  copyFileSync(path, backup); chmodSync(backup, 0o640);
  corruptFiles.delete(path);
}
function cachedSnapshot(path: string): GitKnowledgeSnapshot {
  const stat = statSync(path), signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = snapshotCache.get(path);
  snapshotCache.delete(path);
  if (cached?.signature === signature) { snapshotCache.set(path, cached); return cached.value; }
  const value = JSON.parse(readFileSync(path, "utf8")) as GitKnowledgeSnapshot;
  // 业务模块越多也不能把全部文稿长期留在进程内；超大快照按需读盘。
  if (stat.size <= MAX_CACHE_BYTES / 2) {
    snapshotCache.set(path, { signature, bytes: stat.size, value });
    let total = [...snapshotCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of snapshotCache) {
      if (total <= MAX_CACHE_BYTES) break;
      snapshotCache.delete(key); total -= entry.bytes;
    }
  }
  return value;
}
function cacheReadIndex(path: string, signature: string, bytes: number, value: SnapshotReadIndex) {
  readIndexCache.delete(path);
  if (bytes > MAX_INDEX_CACHE_BYTES) return;
  readIndexCache.set(path, { signature, bytes, value });
  let total = [...readIndexCache.values()].reduce((sum, cached) => sum + cached.bytes, 0);
  for (const [key, cached] of readIndexCache) {
    if (total <= MAX_INDEX_CACHE_BYTES) break;
    readIndexCache.delete(key); total -= cached.bytes;
  }
}
function validReadIndex(value: unknown, moduleId: string, signature: string): value is SnapshotReadIndex {
  if (!record(value) || value.format !== 1 || value.snapshot_signature !== signature
    || !Number.isSafeInteger(value.content_bytes) || value.content_bytes < 0 || !record(value.contents)
    || !Array.isArray(value.documents)) return false;
  // 索引沿用正式快照的字段校验；正文只在单篇读取时按长度和摘要核对。
  return validSnapshot({ ...value, documents: value.documents.map(document => ({ ...document, content: "" })) }, moduleId)
    && value.documents.every(document => {
      const body = value.contents[document.id];
      return !("content" in document) && Number.isSafeInteger(document.lines) && document.lines >= 1 && record(body)
        && Number.isSafeInteger(body.offset) && body.offset >= 0 && Number.isSafeInteger(body.bytes) && body.bytes >= 0
        && body.offset + body.bytes <= value.content_bytes && /^[a-f0-9]{64}$/.test(body.digest) && strings(body.resource_paths);
    });
}
/** 仅用于加速阅读，可由正式快照随时重建；打包正文避免产生数千个小文件。 */
function buildReadIndex(dataDir: string, snapshot: GitKnowledgeSnapshot, signature: string): SnapshotReadIndex {
  const root = readIndexRoot(dataDir, snapshot.module_id);
  const directory = readIndexDirectory(dataDir, snapshot.module_id, signature), temporary = join(root, `building-${randomUUID()}`);
  const contents: SnapshotReadIndex["contents"] = {}, buffers: Buffer[] = [];
  let offset = 0;
  const documents = snapshot.documents.map(({ content, ...document }) => {
    const buffer = Buffer.from(content, "utf8");
    contents[document.id] = { offset, bytes: buffer.length, digest: createHash("sha256").update(buffer).digest("hex"),
      resource_paths: document.source ? referencedGitResourcePaths(content, document.source.path) : [] };
    offset += buffer.length; buffers.push(buffer);
    let lines = 1;
    for (let cursor = content.indexOf("\n"); cursor !== -1; cursor = content.indexOf("\n", cursor + 1)) lines++;
    return { ...document, lines };
  });
  const value: SnapshotReadIndex = { ...snapshot, format: 1, snapshot_signature: signature, documents, contents, content_bytes: offset };
  const serialized = JSON.stringify(value);
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(temporary, { mode: 0o750 });
    writeFileSync(join(temporary, "contents.bin"), Buffer.concat(buffers, offset), { mode: 0o640 });
    writeFileSync(join(temporary, "index.json"), serialized, { mode: 0o640 });
    // 缓存无需逐篇 fsync；异常中断后，长度/摘要检查会从原快照恢复。
    rmSync(directory, { recursive: true, force: true });
    renameSync(temporary, directory);
    const indexPath = join(directory, "index.json");
    cacheReadIndex(indexPath, fileSignature(indexPath), Buffer.byteLength(serialized), value);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name !== moduleKey(signature) && entry.isDirectory() && /^(?:[a-f0-9]{64}|building-[a-f0-9-]+)$/.test(entry.name)) {
        readIndexCache.delete(join(root, entry.name, "index.json"));
        rmSync(join(root, entry.name), { recursive: true, force: true });
      }
    }
    return value;
  } catch {
    // 阅读缓存写不了时仍使用已成功保存的正式快照，不能把模块隐藏或把同步误报为失败。
    return { ...value, memory_only: true };
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }); } catch { /* 缓存清理失败不改变正式快照的保存结果。 */ }
  }
}
function readSnapshotIndex(dataDir: string, moduleId: string): SnapshotReadIndex | undefined {
  const source = snapshotPath(dataDir, moduleId);
  if (!existsSync(source)) return undefined;
  const signature = fileSignature(source), indexPath = join(readIndexDirectory(dataDir, moduleId, signature), "index.json");
  let value: SnapshotReadIndex | undefined;
  try {
    const stamp = fileSignature(indexPath), cached = readIndexCache.get(indexPath);
    if (cached?.signature === stamp) {
      readIndexCache.delete(indexPath); readIndexCache.set(indexPath, cached); value = cached.value;
    } else {
      const serialized = readFileSync(indexPath, "utf8"), parsed: unknown = JSON.parse(serialized);
      if (!validReadIndex(parsed, moduleId, signature)) throw new Error("阅读索引损坏");
      value = parsed;
      cacheReadIndex(indexPath, stamp, Buffer.byteLength(serialized), value);
    }
  } catch {
    const snapshot = readGitKnowledgeSnapshot(dataDir, moduleId);
    if (!snapshot) return undefined;
    value = buildReadIndex(dataDir, snapshot, signature);
  }
  const binding = resolveModuleKnowledgeLocation(dataDir, moduleId);
  return binding && sameLocation(value.location, binding) ? value : undefined;
}
function readIndexedDocument(dataDir: string, index: SnapshotReadIndex, document: GitKnowledgeDocumentMetadata, retry = true): KnowledgeDocument {
  if (index.memory_only) {
    const original = readGitKnowledgeSnapshot(dataDir, index.module_id)?.documents.find(row => row.id === document.id);
    if (!original) throw new Error("仓库知识不存在或正式快照损坏");
    const { lines: _lines, ...metadata } = document;
    return { ...metadata, content: original.content };
  }
  const body = index.contents[document.id];
  try {
    const buffer = Buffer.alloc(body.bytes), path = join(readIndexDirectory(dataDir, index.module_id, index.snapshot_signature), "contents.bin");
    const fd = openSync(path, "r");
    try {
      let count = 0;
      while (count < buffer.length) {
        const read = readSync(fd, buffer, count, buffer.length - count, body.offset + count);
        if (!read) throw new Error("文档阅读缓存不完整");
        count += read;
      }
    } finally { closeSync(fd); }
    if (createHash("sha256").update(buffer).digest("hex") !== body.digest) throw new Error("文档阅读缓存损坏");
    const { lines: _lines, ...metadata } = document;
    return { ...metadata, content: buffer.toString("utf8") };
  } catch (error) {
    if (!retry) throw error;
    const snapshot = readGitKnowledgeSnapshot(dataDir, index.module_id);
    if (!snapshot) throw new Error("仓库知识不存在或正式快照损坏");
    const rebuilt = buildReadIndex(dataDir, snapshot, fileSignature(snapshotPath(dataDir, index.module_id)));
    const current = rebuilt.documents.find(row => row.id === document.id);
    if (!current) throw new Error("仓库知识不存在或已从正式分支删除");
    return readIndexedDocument(dataDir, rebuilt, { ...current, module_ids: document.module_ids }, false);
  }
}
const runningSyncs = new Set<string>();
export function setModuleKnowledgeSyncActive(dataDir: string, moduleId: string, active: boolean) {
  const key = JSON.stringify([dataDir, moduleId]);
  if (active) runningSyncs.add(key); else runningSyncs.delete(key);
}
export const gitKnowledgeResourceKey = (repository: string, branch: string, path: string, revision: string) => JSON.stringify([repositoryIdentity(repository), branch, revision, path]);

function sameLocation(a: KnowledgeRepositoryLocation, b: KnowledgeRepositoryLocation) {
  return repositoryIdentity(a.repository) === repositoryIdentity(b.repository) && a.branch === b.branch && a.docs_path === b.docs_path;
}
export function readModuleKnowledgeSync(dataDir: string, moduleId: string): ModuleKnowledgeSync | undefined {
  const binding = resolveModuleKnowledgeLocation(dataDir, moduleId);
  if (!binding) return undefined;
  const path = statusPath(dataDir, moduleId);
  if (!existsSync(path)) return undefined;
  let value: ModuleKnowledgeSync;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || value.module_id !== moduleId || !validLocation(value.location) || !["syncing", "ready", "partial", "failed"].includes(value.state)
      || !text(value.attempted_at) || !Number.isFinite(Date.parse(value.attempted_at)) || !Number.isSafeInteger(value.document_count) || value.document_count < 0
      || value.repositories !== undefined && (!Array.isArray(value.repositories) || !value.repositories.every(source => record(source)
        && [source.repository, source.branch, source.revision].every(text)))) throw new Error("同步记录格式不正确");
    corruptFiles.delete(path);
  } catch {
    corruptFiles.add(path);
    const snapshot = readSnapshotIndex(dataDir, moduleId);
    return { module_id: moduleId, state: "failed", location: binding, attempted_at: statSync(path).mtime.toISOString(),
      document_count: snapshot?.documents.length ?? 0, ...(snapshot ? { synced_at: snapshot.synced_at, repositories: snapshot.repositories,
        commit: snapshot.repositories.find(source => source.repository === binding.repository && source.branch === binding.branch)?.revision } : {}),
      error: "本地同步记录损坏，原文件将保留备份；重新同步可从正式 Git 重建" };
  }
  if (!sameLocation(value.location, binding)) return undefined;
  if (value.synced_at && value.state !== "syncing" && !readSnapshotIndex(dataDir, moduleId)) {
    return { ...value, state: "failed", error: "本地正式知识快照缺失或损坏，原文件将保留备份；重新同步可从正式 Git 重建" };
  }
  return value.state === "syncing" && !runningSyncs.has(JSON.stringify([dataDir, moduleId]))
    ? { ...value, state: "failed", error: "上次知识同步已中断，保留上次成功内容，可重新同步" } : value;
}
export function writeModuleKnowledgeSync(dataDir: string, status: ModuleKnowledgeSync) {
  mkdirSync(join(gitKnowledgeRoot(dataDir), "status"), { recursive: true });
  preserveCorruptFile(statusPath(dataDir, status.module_id));
  durableWriteFileSync(statusPath(dataDir, status.module_id), JSON.stringify(status), { mode: 0o640 });
}
export function writeGitKnowledgeSnapshot(dataDir: string, snapshot: GitKnowledgeSnapshot) {
  mkdirSync(join(gitKnowledgeRoot(dataDir), "modules"), { recursive: true });
  preserveCorruptFile(snapshotPath(dataDir, snapshot.module_id));
  durableWriteFileSync(snapshotPath(dataDir, snapshot.module_id), JSON.stringify(snapshot), { mode: 0o640 });
  buildReadIndex(dataDir, snapshot, fileSignature(snapshotPath(dataDir, snapshot.module_id)));
}
export function readGitKnowledgeSnapshot(dataDir: string, moduleId: string): GitKnowledgeSnapshot | undefined {
  const path = snapshotPath(dataDir, moduleId);
  if (!existsSync(path)) return undefined;
  let snapshot: GitKnowledgeSnapshot;
  try {
    snapshot = cachedSnapshot(path);
    if (!validSnapshot(snapshot, moduleId)) throw new Error("正式快照格式不正确");
    corruptFiles.delete(path);
  } catch { corruptFiles.add(path); return undefined; }
  const binding = resolveModuleKnowledgeLocation(dataDir, moduleId);
  if (!binding || !sameLocation(snapshot.location, binding)) return undefined;
  return snapshot;
}
function liveSnapshots(dataDir: string, modules: BusinessModule[]): GitKnowledgeSnapshot[] {
  const snapshots: GitKnowledgeSnapshot[] = [];
  for (const module of modules) {
    try {
      const snapshot = readGitKnowledgeSnapshot(dataDir, module.id);
      if (snapshot) snapshots.push(snapshot);
    }
    catch { /* 单模块坏记录不影响其余模块；同步状态入口负责报告和重试。 */ }
  }
  return snapshots.sort((a, b) => b.synced_at.localeCompare(a.synced_at));
}
function projectRepositoryDocument<T extends Pick<KnowledgeDocument, "scope" | "source" | "module_ids">>(
  document: T, modules: BusinessModule[],
): T | undefined {
  if (document.scope !== "repository") return document;
  if (!document.source) return undefined;
  const module_ids = modules.filter(module => moduleIncludesRepositoryKnowledge(module, document.source!)).map(module => module.id).sort();
  return module_ids.length ? { ...document, module_ids } : undefined;
}
export function listGitKnowledgeDocuments(dataDir: string): KnowledgeDocument[] {
  const documents = new Map<string, KnowledgeDocument>();
  const modules = listBusinessModules(dataDir).modules.filter(module => module.status === "active");
  const snapshots = liveSnapshots(dataDir, modules);
  const latestSources = new Map<string, { revision: string; at: string }>();
  for (const snapshot of snapshots) for (const repository of snapshot.repositories) {
    if (repository.scope === "module") continue;
    const key = JSON.stringify([repositoryIdentity(repository.repository), repository.branch]);
    const at = repository.synced_at ?? snapshot.synced_at, previous = latestSources.get(key);
    if (!previous || at > previous.at) latestSources.set(key, { revision: repository.revision, at });
  }
  for (const snapshot of snapshots) for (const document of snapshot.documents) {
    if (document.scope === "repository" && document.source) {
      const latest = latestSources.get(JSON.stringify([repositoryIdentity(document.source.repository), document.source.branch]));
      // 同一公共仓只展示最新成功提交，其他模块的旧快照不能复活已删除文件。
      if (latest && latest.revision !== document.source.revision) continue;
    }
    const previous = documents.get(document.id);
    if (!previous) documents.set(document.id, { ...document, module_ids: [...document.module_ids], repositories: [...document.repositories], source: document.source ? { ...document.source } : undefined });
    else if (document.scope === "module") previous.module_ids = [...new Set([...previous.module_ids, ...document.module_ids])];
  }
  return [...documents.values()].flatMap(document => {
    const projected = projectRepositoryDocument(document, modules);
    return projected ? [projected] : [];
  });
}
function liveReadIndexes(dataDir: string, modules = listBusinessModules(dataDir).modules.filter(module => module.status === "active")): SnapshotReadIndex[] {
  const indexes: SnapshotReadIndex[] = [];
  for (const module of modules) {
    try {
      const index = readSnapshotIndex(dataDir, module.id);
      if (index) indexes.push(index);
    } catch { /* 正式快照损坏的模块由同步状态报告，其余模块仍可阅读。 */ }
  }
  return indexes.sort((a, b) => b.synced_at.localeCompare(a.synced_at));
}
function indexedDocuments(dataDir: string, projectModules = true) {
  const modules = listBusinessModules(dataDir).modules.filter(module => module.status === "active");
  const indexes = liveReadIndexes(dataDir, modules);
  const latestSources = new Map<string, { revision: string; at: string }>();
  for (const index of indexes) for (const repository of index.repositories) {
    if (repository.scope === "module") continue;
    const key = JSON.stringify([repositoryIdentity(repository.repository), repository.branch]);
    const at = repository.synced_at ?? index.synced_at, previous = latestSources.get(key);
    if (!previous || at > previous.at) latestSources.set(key, { revision: repository.revision, at });
  }
  const documents = new Map<string, { document: GitKnowledgeDocumentMetadata; index: SnapshotReadIndex }>();
  for (const index of indexes) for (const document of index.documents) {
    if (document.scope === "repository" && document.source) {
      const latest = latestSources.get(JSON.stringify([repositoryIdentity(document.source.repository), document.source.branch]));
      if (latest && latest.revision !== document.source.revision) continue;
    }
    const previous = documents.get(document.id);
    if (!previous) documents.set(document.id, { index, document: { ...document, module_ids: [...document.module_ids],
      repositories: [...document.repositories], source: document.source ? { ...document.source } : undefined } });
    else if (document.scope === "module") previous.document.module_ids = [...new Set([...previous.document.module_ids, ...document.module_ids])];
  }
  if (projectModules) for (const [id, value] of documents) {
    const document = projectRepositoryDocument(value.document, modules);
    if (document) documents.set(id, { ...value, document });
    else documents.delete(id);
  }
  return documents;
}
/** 目录与卡片仅消费持久摘要，不解析其他模块的 Markdown 正文。 */
export function listGitKnowledgeDocumentMetadata(dataDir: string): GitKnowledgeDocumentMetadata[] {
  return [...indexedDocuments(dataDir).values()].map(value => value.document);
}
/** 下单预览与任务快照共用正文摘要；已有阅读索引不会重复加载整篇正文。 */
export function listGitKnowledgeDocumentManifest(dataDir: string): Array<GitKnowledgeDocumentMetadata & { bytes: number; digest: string }> {
  return [...indexedDocuments(dataDir).values()].map(({ document, index }) => ({
    ...document, bytes: index.contents[document.id].bytes, digest: index.contents[document.id].digest,
  }));
}
/** 筛选使用未排除的正式文档摘要，目录和单篇文档都能单独选择并恢复。 */
export function listModuleRepositoryKnowledgePaths(dataDir: string, moduleId: string): Array<{ repository: string; directories: string[]; files: string[] }> {
  const module = readBusinessModule(dataDir, moduleId);
  const sources = new Map(module.repositories.map(repository => [repositoryIdentity(repository), { repository, directories: new Set(["docs"]), files: new Set<string>() }]));
  for (const { document } of indexedDocuments(dataDir, false).values()) {
    if (document.scope !== "repository" || !document.source) continue;
    const source = sources.get(repositoryIdentity(document.source.repository)), parts = document.source.path.split("/");
    if (!source || parts[0] !== "docs" || parts.length < 2) continue;
    source.files.add(document.source.path);
    for (let depth = 1; depth < parts.length; depth++) source.directories.add(parts.slice(0, depth).join("/"));
  }
  return [...sources.values()].map(source => ({ repository: source.repository, directories: [...source.directories].sort(), files: [...source.files].sort() }));
}
/** 源码的无关提交与同步时间变化不应触发知识正文重新索引。 */
export function readModuleKnowledgeContentRevision(dataDir: string, moduleId: string): string | undefined {
  const module = readBusinessModule(dataDir, moduleId);
  if (module.status !== "active") return undefined;
  const documents = [...indexedDocuments(dataDir).values()].map(value => value.document)
    .filter(document => document.active && document.module_ids.includes(module.id));
  if (!documents.length && !readSnapshotIndex(dataDir, module.id)) return undefined;
  return createHash("sha256").update(JSON.stringify(documents
    .map(document => [document.id, document.revision]).sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
}
/** 一次任务固定多篇正文时只投影一次目录，正文仍逐篇读取和校验。 */
export function createGitKnowledgeDocumentReader(dataDir: string): (id: string) => KnowledgeDocument {
  const documents = indexedDocuments(dataDir);
  return id => {
    if (!/^kg-[a-f0-9]{64}$/.test(id)) throw new Error("仓库知识文档编号无效");
    const selected = documents.get(id);
    if (!selected) throw new Error("仓库知识不存在或已从正式分支删除");
    return readIndexedDocument(dataDir, selected.index, selected.document);
  };
}
export function readGitKnowledgeDocument(dataDir: string, id: string): KnowledgeDocument {
  return createGitKnowledgeDocumentReader(dataDir)(id);
}
/** 旧业务正文保留在原记录中；正式消费只使用 Git，不因模块尚未配置而退回本地。 */
export function withoutBoundModuleDrafts(_dataDir: string, documents: KnowledgeDocument[]): KnowledgeDocument[] {
  return documents.filter(document => document.scope !== "module" && !document.module_ids.length
    && !(document.research_source?.job_id && (document.research_source.job_id.startsWith("dkx-")
      || ["domain", "repository"].includes(document.research_source.layer ?? ""))));
}
function gitResourcePath(sourcePath: string, href: string): string | undefined {
  if (!href || href.length > 2048 || /^[a-z][a-z\d+.-]*:|^\/\/|^\//i.test(href) || /[\0\\]/.test(href)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/)[0]); } catch { return undefined; }
  if (!decoded || /[\0\\]/.test(decoded) || decoded.startsWith("/")) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
  return path === ".." || path.startsWith("../") ? undefined : path;
}
/** 同步与冻结使用同一套相对链接解析，正文未引用的其他图片不进入该篇任务快照。 */
export function referencedGitResourcePaths(content: string, sourcePath: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const path = gitResourcePath(sourcePath, match[1]);
    if (path) paths.add(path);
  }
  return [...paths];
}
function readResource(dataDir: string, resource: { digest: string; content_type: string } | undefined): { content: Buffer; content_type: string } | undefined {
  if (!resource || !/^[a-f0-9]{64}$/.test(resource.digest) || !/^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/i.test(resource.content_type)) return undefined;
  return { content: Buffer.from(readFileSync(join(gitKnowledgeRoot(dataDir), "resources", `${resource.digest}.b64`), "utf8"), "base64"), content_type: resource.content_type };
}
/** 检视任务只保存原图摘要与来源位置；二进制文件按摘要共享，不随正式快照切换而改变。 */
export function freezeGitKnowledgeResources(dataDir: string, documents: Array<Pick<KnowledgeDocument, "id" | "source">>): FrozenGitKnowledgeResources {
  const frozen: FrozenGitKnowledgeResources = {}, originals = new Map<string, { resource_paths: string[] }>();
  const resourcesByLocation = new Map<string, { digest: string; content_type: string }>();
  const documentKey = (id: string, source: NonNullable<KnowledgeDocument["source"]>) => JSON.stringify([id, repositoryIdentity(source.repository), source.branch, source.path, source.revision]);
  for (const { document, index } of indexedDocuments(dataDir).values()) {
    if (document.source) originals.set(documentKey(document.id, document.source), index.contents[document.id]);
  }
  for (const snapshot of liveReadIndexes(dataDir)) {
    for (const [key, resource] of Object.entries(snapshot.resources)) resourcesByLocation.set(key, resource);
  }
  for (const document of documents) {
    if (!document.source || !document.id.startsWith("kg-")) continue;
    const source = document.source;
    const original = originals.get(documentKey(document.id, source));
    if (!original) throw new Error("正式文档版本已变化，请刷新文稿后开始检视，未混用新版本图片");
    const resources: FrozenGitKnowledgeDocumentResources["resources"] = {};
    for (const path of original.resource_paths) {
      const resource = resourcesByLocation.get(gitKnowledgeResourceKey(source.repository, source.branch, path, source.revision));
      if (resource) resources[path] = { ...resource };
    }
    frozen[document.id] = { source: { ...source }, resources };
  }
  return frozen;
}
export function readFrozenGitKnowledgeResource(dataDir: string, refs: FrozenGitKnowledgeDocumentResources | undefined, href: string): { content: Buffer; content_type: string } | undefined {
  if (!refs?.source?.path || !record(refs.resources)) return undefined;
  const path = gitResourcePath(refs.source.path, href);
  return path ? readResource(dataDir, refs.resources[path]) : undefined;
}
export function readGitKnowledgeResource(dataDir: string, id: string, href: string): { content: Buffer; content_type: string } | undefined {
  if (!/^kg-[a-f0-9]{64}$/.test(id)) return undefined;
  const current = indexedDocuments(dataDir).get(id), source = current?.document.source;
  if (!current || !source) return undefined;
  const path = gitResourcePath(source.path, href);
  if (!path) return undefined;
  const key = gitKnowledgeResourceKey(source.repository, source.branch, path, source.revision);
  const resource = current.index.resources[key];
  if (resource) return readResource(dataDir, resource);
  // 同一公共仓被多个模块引用时，可复用同一提交已成功同步的资源。
  for (const index of liveReadIndexes(dataDir)) {
    if (index.documents.some(document => document.id === id && document.source?.revision === source.revision)
      && index.resources[key]) return readResource(dataDir, index.resources[key]);
  }
  return undefined;
}
