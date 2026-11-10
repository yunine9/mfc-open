import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import { readBusinessModule } from "./businessModuleLibrary.ts";
import { resolveModuleKnowledgeLocation } from "./businessModuleKnowledge.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { syncKnowledgeSource } from "./knowledgeExtractionFactory.ts";
import { HostGitSandbox } from "./hostGitSandbox.ts";
import { runKnowledgeBufferCommand, runKnowledgeCommand } from "./knowledgeProcess.ts";
import { durableWriteFileSync } from "./durableWrite.ts";
import type { KnowledgeDocument } from "./knowledgeDocuments.ts";
import {
  gitKnowledgeRoot, gitKnowledgeResourceKey, writeGitKnowledgeSnapshot, writeModuleKnowledgeSync,
  readModuleKnowledgeSync, type ModuleKnowledgeSync, type GitKnowledgeSnapshot,
  setModuleKnowledgeSyncActive,
  readGitKnowledgeSnapshot,
  referencedGitResourcePaths,
} from "./knowledgeRepositorySnapshots.ts";
export { readModuleKnowledgeSync, listGitKnowledgeDocuments, readGitKnowledgeDocument, readGitKnowledgeResource } from "./knowledgeRepositorySnapshots.ts";
export type { ModuleKnowledgeSync, KnowledgeRepositoryLocation } from "./knowledgeRepositorySnapshots.ts";

type Options = { signal?: AbortSignal; credential?: { username: string; password: string } };
type Source = { root: string; repository: string; branch: string; revision: string };
type Entry = { mode: string; object: string; bytes: number; path: string };
const activeModules = new Map<string, Promise<ModuleKnowledgeSync>>();
const sourceFetches = new Map<string, Promise<Source>>();
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const markdown = (path: string) => /\.(?:md|markdown)$/i.test(path);
const contentTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".pdf": "application/pdf",
  ".puml": "text/plain; charset=utf-8", ".plantuml": "text/plain; charset=utf-8",
};

async function readSource(dataDir: string, repository: string, branch: string, options: Options): Promise<Source> {
  const key = digest(JSON.stringify([dataDir, repositoryIdentity(repository), branch, options.credential?.username]));
  const existing = sourceFetches.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const sandbox = new HostGitSandbox(dataDir), prepared = sandbox.prepare(options.credential);
    const root = join(gitKnowledgeRoot(dataDir), "sources", key);
    mkdirSync(root, { recursive: true });
    try {
      if (!branch) {
        const remote = await runKnowledgeCommand("git", [...prepared.args, "ls-remote", "--symref", repository, "HEAD"], {
          cwd: root, env: prepared.env, signal: options.signal, timeoutMs: 45_000, maxBytes: 1024 * 1024,
        });
        branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remote)?.[1] ?? "";
        if (!branch) throw new Error("无法确定代码仓的正式分支，请检查远端 HEAD 配置");
      }
      const result = await syncKnowledgeSource(root, repository, branch, prepared, options.signal);
      return { ...result, repository, branch };
    } finally { sandbox.cleanup(prepared); }
  })();
  sourceFetches.set(key, pending);
  try { return await pending; }
  finally { if (sourceFetches.get(key) === pending) sourceFetches.delete(key); }
}
async function git(dataDir: string, source: Source, args: string[], signal: AbortSignal, maxBytes: number) {
  const sandbox = new HostGitSandbox(dataDir), prepared = sandbox.prepare(undefined);
  try { return await runKnowledgeBufferCommand("git", [...prepared.args, "--no-replace-objects", "--literal-pathspecs", ...args], {
    cwd: source.root, env: prepared.env, signal, timeoutMs: 30_000, maxBytes,
  }); } finally { sandbox.cleanup(prepared); }
}
async function entries(dataDir: string, source: Source, paths: string[], signal: AbortSignal): Promise<Entry[]> {
  const text = (await git(dataDir, source, ["ls-tree", "-r", "-l", "-z", source.revision, "--", ...paths], signal, 8 * 1024 * 1024)).toString("utf8");
  return text.split("\0").filter(Boolean).flatMap(row => {
    const item = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(row);
    // 符号链接不能变成正文或资源；只读取当前提交中的普通 blob。
    return item && ["100644", "100755"].includes(item[1]) ? [{ mode: item[1], object: item[2], bytes: Number(item[3]), path: item[4] }] : [];
  });
}
function makeDocument(moduleId: string, source: Source, path: string, content: string, domain: boolean, operator: string, at: string): KnowledgeDocument {
  const location = { repository: source.repository, branch: source.branch, path, revision: source.revision };
  const fields = {
    title: /^#\s+(.+)$/m.exec(content)?.[1].trim().slice(0, 160) || posix.basename(path), content,
    scope: domain ? "module" as const : "repository" as const,
    module_ids: domain ? [moduleId] : [], repositories: domain ? [] : [source.repository],
    technologies: [], product_versions: [], when_to_use: "", active: true, source: location,
    archive_target: { repository: source.repository, branch: source.branch, path },
  };
  // 代码仓无关提交不应作废正文引用或重建全文索引；精确来源提交另存在 source.revision。
  const revision = digest(JSON.stringify({ ...fields, source: { ...location, revision: "" } }));
  return { ...fields, id: `kg-${digest(JSON.stringify([repositoryIdentity(source.repository), source.branch, path]))}`,
    revision, history: [{ at, operator, action: "从正式分支同步", revision }] };
}

/** 每个模块独立同步，整个操作有三分钟预算；失败不切换已成功的文稿快照。 */
export async function syncModuleKnowledge(dataDir: string, moduleId: string, operator: string, options: Options = {}): Promise<ModuleKnowledgeSync> {
  const key = JSON.stringify([dataDir, moduleId]);
  const current = activeModules.get(key);
  if (current) return current;
  setModuleKnowledgeSyncActive(dataDir, moduleId, true);
  const work = syncModule(dataDir, moduleId, operator, options);
  activeModules.set(key, work);
  try { return await work; }
  finally { if (activeModules.get(key) === work) { activeModules.delete(key); setModuleKnowledgeSyncActive(dataDir, moduleId, false); } }
}
async function syncModule(dataDir: string, moduleId: string, operator: string, options: Options): Promise<ModuleKnowledgeSync> {
  const module = readBusinessModule(dataDir, moduleId);
  if (module.status !== "active") throw new Error("业务模块已停用");
  const location = resolveModuleKnowledgeLocation(dataDir, module.id);
  if (!location) throw new Error("请先配置该模块的领域知识目录");
  const previous = readModuleKnowledgeSync(dataDir, module.id);
  const status: ModuleKnowledgeSync = { module_id: module.id, state: "syncing", location, attempted_at: new Date().toISOString(),
    document_count: previous?.document_count ?? 0, ...(previous?.synced_at ? { synced_at: previous.synced_at, commit: previous.commit, repositories: previous.repositories } : {}) };
  writeModuleKnowledgeSync(dataDir, status);
  const timeout = AbortSignal.timeout(180_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const existing = readGitKnowledgeSnapshot(dataDir, module.id);
    const requests = [{ repository: location.repository, branch: location.branch, domain: true, paths: [location.docs_path] },
      ...[...new Set(module.repositories)].map(repository => ({ repository, branch: "", domain: false, paths: ["docs", "AGENTS.md"] }))];
    const at = new Date().toISOString();
    const snapshot: GitKnowledgeSnapshot = { module_id: module.id, location, synced_at: at, documents: [], resources: {}, repositories: [] };
    let totalBytes = 0;
    let successes = 0, changed = !existing, cursor = 0;
    const warnings: string[] = [];
    const pieces: Array<Pick<GitKnowledgeSnapshot, "documents" | "resources" | "repositories">> = new Array(requests.length);
    const work = async () => {
      while (cursor < requests.length) {
        const index = cursor++, request = requests[index];
        const priorDocuments = existing?.documents.filter(document => document.scope === (request.domain ? "module" : "repository")
          && document.source && repositoryIdentity(document.source.repository) === repositoryIdentity(request.repository)) ?? [];
        const priorRepositories = existing?.repositories.filter(repository => repositoryIdentity(repository.repository) === repositoryIdentity(request.repository)
          && (!repository.scope || repository.scope === (request.domain ? "module" : "repository"))
          && (!request.branch || request.branch === repository.branch)) ?? [];
        const priorResources = Object.fromEntries(Object.entries(existing?.resources ?? {}).filter(([key]) => {
          const [repository, branch, revision] = JSON.parse(key);
          return repository === repositoryIdentity(request.repository) && (!request.branch || branch === request.branch)
            && priorRepositories.some(source => source.branch === branch && source.revision === revision);
        }));
        const prior = { documents: priorDocuments, resources: priorResources, repositories: priorRepositories };
        try {
          // 各仓独立预算，某个公共仓不可达时仍能同步已就绪的领域知识。
          const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
          const source = await readSource(dataDir, request.repository, request.branch, { ...options, signal: sourceSignal });
          if (priorRepositories.some(repository => repository.branch === source.branch && repository.revision === source.revision)) {
            successes++; pieces[index] = prior; continue;
          }
          const piece: typeof prior = { documents: [], resources: {}, repositories: [{ repository: source.repository, branch: source.branch, revision: source.revision, synced_at: at,
            scope: request.domain ? "module" : "repository" }] };
          const tree = await entries(dataDir, source, request.paths, sourceSignal);
          const markdownEntries = tree.filter(entry => markdown(entry.path));
          if (markdownEntries.length > 5000) throw new Error("正式文档数量超过单次同步容量，请缩小领域目录");
          const resourcePaths = new Set<string>();
          for (const entry of markdownEntries) {
            sourceSignal.throwIfAborted();
            if (entry.bytes > MAX_DOCUMENT_BYTES || totalBytes + entry.bytes > MAX_SNAPSHOT_BYTES) throw new Error("正式文档超过单次同步容量，请缩小领域目录");
            totalBytes += entry.bytes;
            const buffer = await git(dataDir, source, ["cat-file", "blob", entry.object], sourceSignal, MAX_DOCUMENT_BYTES);
            const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r\n/g, "\n");
            if (!content.trim() || content.includes("\0")) continue;
            piece.documents.push(makeDocument(module.id, source, entry.path, content, request.domain, operator, at));
            for (const path of referencedGitResourcePaths(content, entry.path)) if (contentTypes[posix.extname(path).toLowerCase()]) resourcePaths.add(path);
          }
          const resourceTree = resourcePaths.size ? await entries(dataDir, source, [...resourcePaths], sourceSignal) : [];
          for (const entry of resourceTree.filter(entry => resourcePaths.has(entry.path))) {
            if (entry.bytes > MAX_RESOURCE_BYTES || totalBytes + entry.bytes > MAX_SNAPSHOT_BYTES) throw new Error("文档关联资源超过单次同步容量，原有知识仍保留");
            totalBytes += entry.bytes;
            const buffer = await git(dataDir, source, ["cat-file", "blob", entry.object], sourceSignal, MAX_RESOURCE_BYTES);
            const hash = digest(buffer), resourceRoot = join(gitKnowledgeRoot(dataDir), "resources");
            mkdirSync(resourceRoot, { recursive: true });
            const resourcePath = join(resourceRoot, `${hash}.b64`);
            if (!existsSync(resourcePath)) durableWriteFileSync(resourcePath, buffer.toString("base64"), { mode: 0o640 });
            piece.resources[gitKnowledgeResourceKey(source.repository, source.branch, entry.path, source.revision)] = { digest: hash, content_type: contentTypes[posix.extname(entry.path).toLowerCase()] };
          }
          successes++; changed = true; pieces[index] = piece;
        } catch (error) {
          pieces[index] = prior;
          warnings.push(`${request.domain ? "领域目录" : `代码仓 ${request.repository}`}：${signal.aborted ? "同步超时或已取消" : error instanceof Error ? error.message.replace(/组件源码/g, "知识仓") : "同步失败"}；保留该来源上次成功内容`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, requests.length) }, work));
    if (options.signal?.aborted) throw new Error("知识同步已取消");
    if (!successes) throw new Error(warnings.join("；") || "知识同步失败");
    const documents = new Map<string, KnowledgeDocument>();
    const repositories = new Map<string, GitKnowledgeSnapshot["repositories"][number]>();
    for (const piece of pieces) {
      for (const document of piece.documents) if (!documents.has(document.id)) documents.set(document.id, document);
      Object.assign(snapshot.resources, piece.resources);
      for (const repository of piece.repositories) repositories.set(JSON.stringify([repositoryIdentity(repository.repository), repository.branch, repository.scope]), repository);
    }
    snapshot.documents = [...documents.values()]; snapshot.repositories = [...repositories.values()];
    if (existing && (JSON.stringify(snapshot.documents.map(document => document.id).sort()) !== JSON.stringify(existing.documents.map(document => document.id).sort())
      || JSON.stringify(snapshot.repositories) !== JSON.stringify(existing.repositories))) changed = true;
    const stillBound = resolveModuleKnowledgeLocation(dataDir, module.id);
    if (!stillBound || JSON.stringify(stillBound) !== JSON.stringify(location)) throw new Error("同步期间领域知识目录已更改，请同步新目录");
    if (changed) writeGitKnowledgeSnapshot(dataDir, snapshot);
    const commit = pieces[0].repositories.find(repository => repositoryIdentity(repository.repository) === repositoryIdentity(location.repository) && repository.branch === location.branch)?.revision;
    const ready: ModuleKnowledgeSync = { ...status, state: warnings.length ? "partial" : "ready", synced_at: changed ? at : existing?.synced_at ?? at,
      commit, document_count: snapshot.documents.length, repositories: snapshot.repositories, ...(warnings.length ? { warnings } : {}) };
    writeModuleKnowledgeSync(dataDir, ready);
    return ready;
  } catch (error) {
    const message = signal.aborted ? options.signal?.aborted ? "知识同步已取消，保留上次成功内容" : "知识同步超时，保留上次成功内容"
      : error instanceof Error ? error.message.replace(/组件源码/g, "知识仓") : "知识同步失败，保留上次成功内容";
    const failed: ModuleKnowledgeSync = { ...status, state: "failed", error: message };
    writeModuleKnowledgeSync(dataDir, failed);
    return failed;
  }
}
