/**
 * 仓库级构建缓存的生命周期。
 *
 * 缓存是速度层：同一仓库的后续任务应复用，但不能永久、不可见地占盘。
 * 本模块只管理 cacheRoot 下的仓库哈希目录和具名共享下载缓存；不跟随符号链接，
 * 不触碰任务工作区，也不在 HTTP/定时器路径使用同步递归扫描。
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { lstat as lstatAsync, opendir, readFile, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";

export const BUILD_CACHE_METADATA = ".mae-flow-cache.json";
const CACHE_KEY = /^[a-f0-9]{20}$/;
const SHARED_CACHE_NAMES = {
  "shared-maven": "共享 Maven / C++ SDK 下载缓存",
} as const;
export type SharedBuildCacheKey = keyof typeof SHARED_CACHE_NAMES;
const DAY_MS = 24 * 60 * 60_000;

function isManagedCacheKey(key: string): boolean {
  return CACHE_KEY.test(key) || Object.hasOwn(SHARED_CACHE_NAMES, key);
}

interface BuildCacheMetadata {
  schema: 1;
  key: string;
  repository_hint: string;
  created_at: string;
  last_used_at: string;
}

export interface BuildCacheEntry {
  key: string;
  repository_hint?: string;
  last_used_at: string;
  size_bytes: number;
  active: boolean;
  /** 旧版本分区没有平台元数据；首次自动巡检会先纳管并给一个保留周期。 */
  tracked: boolean;
}

export interface BuildCacheStatus {
  configured: boolean;
  root?: string;
  caches: number;
  active: number;
  total_bytes: number;
  entries: BuildCacheEntry[];
  policy: {
    retention_days: number;
    max_bytes: number;
  };
}

export interface BuildCacheReclaimResult {
  reclaimed: number;
  freed_bytes: number;
  skipped_active: number;
  failed: Array<{ key: string; error: string }>;
  status: BuildCacheStatus;
}

export function buildCacheKey(repository: string): string {
  // 保持既有分区算法，升级后不让已经焐热的缓存集体失效。
  return createHash("sha256").update(repository).digest("hex").slice(0, 20);
}

/** 只存给管理员辨认的无凭据提示，不把 URL query/token 写进元数据。 */
function repositoryHint(repository: string): string {
  const value = repository.trim();
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (scp) return `${scp[1]}:${scp[2]}`;
    // 本地路径只展示末级目录，避免把宿主目录结构带进管理接口。
    return basename(value.replace(/[\\/]+$/, "")) || "本地仓库";
  }
}

function safeCacheBase(cacheRoot: string, key: string): string {
  if (!isManagedCacheKey(key)) throw new Error(`非法构建缓存分区: ${key}`);
  const root = resolve(cacheRoot);
  const base = resolve(root, key);
  if (base === root || !base.startsWith(root + sep)) {
    throw new Error(`构建缓存分区越过根目录: ${key}`);
  }
  return base;
}

function writeMetadata(base: string, metadata: BuildCacheMetadata): void {
  const path = join(base, BUILD_CACHE_METADATA);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(metadata, null, 1));
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/**
 * 挂载前登记一次真实使用。元数据住分区根，不会挂进任务容器。
 * 这里只做常数级小文件 I/O；缓存体积统计留给异步管理路径。
 */
export function touchBuildCache(
  cacheRoot: string,
  repository: string,
  now = Date.now(),
): { key: string; base: string } {
  const key = buildCacheKey(repository);
  return touchCache(cacheRoot, key, repositoryHint(repository), now);
}

export function touchSharedBuildCache(cacheRoot: string, key: SharedBuildCacheKey, now = Date.now()): { key: string; base: string } {
  return touchCache(cacheRoot, key, SHARED_CACHE_NAMES[key], now);
}

function touchCache(cacheRoot: string, key: string, hint: string, now: number): { key: string; base: string } {
  const root = resolve(cacheRoot);
  const base = safeCacheBase(root, key);
  mkdirSync(root, { recursive: true });
  mkdirSync(base, { recursive: true });
  const info = lstatSync(base);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`构建缓存分区 ${key} 不是可信目录，拒绝挂载`);
  }

  const path = join(base, BUILD_CACHE_METADATA);
  let previous: Partial<BuildCacheMetadata> = {};
  try { previous = JSON.parse(readFileSync(path, "utf-8")); } catch { /* 新分区 */ }
  const instant = new Date(now).toISOString();
  const metadata: BuildCacheMetadata = {
    schema: 1,
    key,
    repository_hint: hint,
    created_at: typeof previous.created_at === "string"
      ? previous.created_at : instant,
    last_used_at: instant,
  };
  writeMetadata(base, metadata);
  return { key, base };
}

/** 从真实挂载源反查缓存。共享区沿用容器占用记录，最后一个容器停止后才回收；
 * 仅保留工作区的闲置任务不应永久锁住所有仓库的下载缓存。 */
export function cacheKeyFromPath(
  cacheRoot: string,
  source: string,
): string | undefined {
  const parts = relative(resolve(cacheRoot), resolve(source)).split(sep);
  return parts.length >= 2 && isManagedCacheKey(parts[0]) ? parts[0] : undefined;
}

async function treeSize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let directory;
    try { directory = await opendir(current); } catch { continue; }
    for await (const entry of directory) {
      const path = join(current, entry.name);
      try {
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
        else total += (await lstatAsync(path)).size;
      } catch { /* 文件并发消失，忽略这一项 */ }
    }
  }
  return total;
}

async function readMetadata(path: string): Promise<BuildCacheMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    if (parsed?.schema === 1 && typeof parsed.last_used_at === "string"
        && Number.isFinite(Date.parse(parsed.last_used_at))) {
      return parsed as BuildCacheMetadata;
    }
  } catch { /* 老缓存或损坏元数据，下面回退目录时间 */ }
  return undefined;
}

export async function inspectBuildCaches(options: {
  cacheRoot?: string;
  activeKeys?: ReadonlySet<string>;
  retentionDays: number;
  maxBytes: number;
}): Promise<BuildCacheStatus> {
  if (!options.cacheRoot) {
    return {
      configured: false, caches: 0, active: 0, total_bytes: 0, entries: [],
      policy: { retention_days: options.retentionDays, max_bytes: options.maxBytes },
    };
  }
  const root = resolve(options.cacheRoot);
  mkdirSync(root, { recursive: true });
  const entries: BuildCacheEntry[] = [];
  let directory;
  try { directory = await opendir(root); } catch {
    return {
      configured: true, root, caches: 0, active: 0, total_bytes: 0, entries: [],
      policy: { retention_days: options.retentionDays, max_bytes: options.maxBytes },
    };
  }
  for await (const child of directory) {
    if (!isManagedCacheKey(child.name) || !child.isDirectory()
        || child.isSymbolicLink()) continue;
    const base = safeCacheBase(root, child.name);
    const metadata = await readMetadata(join(base, BUILD_CACHE_METADATA));
    let fallback = Date.now();
    try { fallback = (await stat(base)).mtimeMs; } catch { /* 并发消失 */ }
    const lastUsed = metadata?.last_used_at ?? new Date(fallback).toISOString();
    entries.push({
      key: child.name,
      repository_hint: metadata?.repository_hint || SHARED_CACHE_NAMES[child.name as SharedBuildCacheKey],
      last_used_at: lastUsed,
      size_bytes: await treeSize(base),
      active: options.activeKeys?.has(child.name) ?? false,
      tracked: !!metadata,
    });
  }
  entries.sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at));
  return {
    configured: true,
    root,
    caches: entries.length,
    active: entries.filter((entry) => entry.active).length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries,
    policy: { retention_days: options.retentionDays, max_bytes: options.maxBytes },
  };
}

/**
 * 自动模式：先清超过保留期的，再按 LRU 压到容量上限。
 * 手动 allUnused：清掉当前没有任务/容器占用的全部分区。
 */
export async function reclaimBuildCaches(options: {
  cacheRoot?: string;
  activeKeys: () => ReadonlySet<string>;
  retentionDays: number;
  maxBytes: number;
  allUnused?: boolean;
  now?: number;
}): Promise<BuildCacheReclaimResult> {
  const now = options.now ?? Date.now();
  const initial = await inspectBuildCaches({
    cacheRoot: options.cacheRoot,
    activeKeys: options.activeKeys(),
    retentionDays: options.retentionDays,
    maxBytes: options.maxBytes,
  });
  const planned = new Set<string>();
  if (options.allUnused) {
    initial.entries.filter((entry) => !entry.active)
      .forEach((entry) => planned.add(entry.key));
  } else {
    if (options.retentionDays > 0) {
      for (const entry of initial.entries) {
        const used = Date.parse(entry.last_used_at);
        if (entry.tracked && !entry.active && Number.isFinite(used)
            && now - used >= options.retentionDays * DAY_MS) {
          planned.add(entry.key);
        }
      }
    }
    if (options.maxBytes > 0) {
      let remaining = initial.total_bytes - initial.entries
        .filter((entry) => planned.has(entry.key))
        .reduce((sum, entry) => sum + entry.size_bytes, 0);
      const oldest = [...initial.entries]
        .filter((entry) => !entry.active && !planned.has(entry.key))
        .sort((a, b) => Date.parse(a.last_used_at) - Date.parse(b.last_used_at));
      for (const entry of oldest) {
        if (remaining <= options.maxBytes) break;
        planned.add(entry.key);
        remaining -= entry.size_bytes;
      }
    }
  }

  // 升级前的缓存没有 last_used_at。自动巡检不能拿“分区第一次创建的
  // mtime”冒充最后使用并立刻误删；容量判定完成后，给未被选中清理的
  // 老分区从本次升级起一个完整保留周期。手动“清全部闲置”是用户明确
  // 动作，不做这层宽限。
  if (!options.allUnused && options.cacheRoot) {
    for (const entry of initial.entries) {
      if (entry.tracked || planned.has(entry.key)) continue;
      try {
        const base = safeCacheBase(options.cacheRoot, entry.key);
        const instant = new Date(now).toISOString();
        writeMetadata(base, {
          schema: 1,
          key: entry.key,
          repository_hint: "",
          created_at: entry.last_used_at,
          last_used_at: instant,
        });
        entry.last_used_at = instant;
        entry.tracked = true;
      } catch { /* 纳管失败只是不自动删，不能影响其他缓存回收 */ }
    }
  }

  let reclaimed = 0;
  let freed = 0;
  let skippedActive = 0;
  const failed: Array<{ key: string; error: string }> = [];
  if (planned.size === 0) {
    return {
      reclaimed, freed_bytes: freed, skipped_active: skippedActive, failed,
      status: initial,
    };
  }
  const byKey = new Map(initial.entries.map((entry) => [entry.key, entry]));
  for (const key of planned) {
    // 扫描和删除之间可能刚好启动新任务：删除前必须现读占用状态。
    if (options.activeKeys().has(key)) { skippedActive += 1; continue; }
    if (!options.cacheRoot) continue;
    const base = safeCacheBase(options.cacheRoot, key);
    const quarantine = join(resolve(options.cacheRoot),
      `.reclaim-${key}-${randomUUID()}`);
    let moved = false;
    try {
      const info = lstatSync(base);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("目标不是可信缓存目录");
      }
      // 最终占用检查与 rename 之间没有 await；rename 后新任务只会创建并
      // 使用一份新分区，不会撞上正在递归删除的旧目录。
      if (options.activeKeys().has(key)) { skippedActive += 1; continue; }
      renameSync(base, quarantine);
      moved = true;
      await rm(quarantine, { recursive: true, force: true });
      reclaimed += 1;
      freed += byKey.get(key)?.size_bytes ?? 0;
    } catch (error) {
      // 删除失败时尽量放回原名，让它保持可见、可重试；若新任务已经在
      // 原名创建了新缓存则不能覆盖，失败记录会把隔离目录留给运维取证。
      if (moved && !existsSync(base) && existsSync(quarantine)) {
        try { renameSync(quarantine, base); } catch { /* 保留原始失败 */ }
      }
      failed.push({ key, error: String((error as Error).message ?? error) });
    }
  }
  const status = await inspectBuildCaches({
    cacheRoot: options.cacheRoot,
    activeKeys: options.activeKeys(),
    retentionDays: options.retentionDays,
    maxBytes: options.maxBytes,
  });
  return {
    reclaimed,
    freed_bytes: freed,
    skipped_active: skippedActive,
    failed,
    status,
  };
}
