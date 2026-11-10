import {
  constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync,
  readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface ToolchainFile { path: string; bytes: number; symlink?: string }
interface Manifest {
  product: string;
  version: string;
  toolchainRoot: string;
  files: ToolchainFile[];
  fileCount: number;
  bytes: number;
  createdAt: number;
  lastUsedAt: number;
}
interface Master { root: string; manifest: Manifest }
type Release = () => void;
export interface CodecheckToolchainPreparation { release?: Release }
// 首次下载发生在 CodeCheck 会话内，通常数分钟；等锁过短会让并发任务
// 在母本落盘前各自下载一遍。超过 30 分钟视为进程异常退出留下的锁。
const LOCK_TIMEOUT_MS = 15 * 60_000;
const LOCK_STALE_MS = 30 * 60_000;
export const CODECHECK_TOOLCHAIN_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const seeds = new Map<string, Promise<void>>();
const cacheRoot = (dataDir: string) => join(dataDir, "shared", "codecheck-agent");
const segment = (name: string) => !!name && name !== "." && name !== ".." && !/[\\/]/.test(name);
const stable = (name: string) => !/^\.?(?:logs?|locks?|tmp|temp|skills)$/i.test(name)
  && !/(?:\.(?:log|lock|tmp|temp|part|partial)(?:[.-].*)?|~)$/i.test(name)
  && !/^(?:\.lock|\.tmp|codecheck-result\.json|prepush-context\.json)$/i.test(name);

/** 任务目录和母本目录都不能通过父级软链接写到别处。 */
function directory(root: string, path = ""): string {
  mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`目录不是普通目录：${root}`);
  let current = root;
  for (const part of path.split(/[\\/]/).filter(Boolean)) {
    if (!segment(part)) throw new Error(`非法相对路径：${path}`);
    current = join(current, part);
    try { mkdirSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error(`目录不是普通目录：${current}`);
  }
  return current;
}
function rootFor(dataDir: string): string { return directory(dataDir, "shared/codecheck-agent"); }
function directories(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function save(root: string, manifest: Manifest): void {
  const file = join(root, "manifest.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(manifest));
  renameSync(`${file}.tmp`, file);
}
function masters(dataDir: string): Master[] {
  const root = cacheRoot(dataDir);
  const result: Master[] = [];
  for (const product of directories(root)) for (const version of directories(join(root, product))) {
    const path = join(root, product, version);
    if (!existsSync(join(path, "manifest.json"))) continue;
    // 单个损坏清单只跳过这一份，不能让所有任务从此失去去重能力。
    let m: Manifest;
    try { m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as Manifest; }
    catch { continue; }
    const prefix = `home/${product}/tools/agent/${version}`;
    if (!m || m.product !== product || m.version !== version || m.toolchainRoot !== prefix
      || !Array.isArray(m.files) || !m.files.length || !Number.isFinite(m.lastUsedAt)
      || !Number.isFinite(m.createdAt) || !Number.isFinite(m.bytes)
      || m.files.some(f => typeof f.path !== "string" || !f.path.startsWith(`${prefix}/`)
        || !f.path.split("/").every(segment) || !Number.isFinite(f.bytes)
        || (f.symlink !== undefined && !safeLink(f.path, f.symlink, prefix)))) {
      continue;
    }
    result.push({ root: path, manifest: m });
  }
  return result;
}
function newest(items: Master[]): Master[] {
  const byProduct = new Map<string, Master>();
  for (const item of items) {
    const old = byProduct.get(item.manifest.product);
    if (!old || item.manifest.version.localeCompare(old.manifest.version, "en", { numeric: true }) > 0) byProduct.set(item.manifest.product, item);
  }
  return [...byProduct.values()];
}
function safeLink(path: string, target: string, toolchainRoot: string): boolean {
  if (typeof target !== "string" || isAbsolute(target)) return false;
  const destination = relative(resolve(toolchainRoot), resolve(dirname(path), target));
  return destination !== ".." && !destination.startsWith(`..${sep}`) && !isAbsolute(destination);
}
function files(root: string, path: string, toolchainRoot = path): ToolchainFile[] {
  const result: ToolchainFile[] = [];
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    if (!stable(entry.name)) continue;
    const name = `${path}/${entry.name}`;
    if (entry.isDirectory()) result.push(...files(root, name, toolchainRoot));
    else if (entry.isFile()) result.push({ path: name, bytes: lstatSync(join(root, name)).size });
    else if (entry.isSymbolicLink()) {
      const target = readlinkSync(join(root, name));
      if (safeLink(name, target, toolchainRoot)) result.push({ path: name, bytes: 0, symlink: target });
    }
  }
  return result;
}
function mirror(source: string, target: string, entries: ToolchainFile[]): void {
  for (const entry of entries) {
    directory(source, dirname(entry.path));
    directory(target, dirname(entry.path));
    const from = join(source, entry.path), to = join(target, entry.path);
    try {
      // lstat 也会看到断开的软链接，不能覆盖任务原有的状态。
      try { lstatSync(to); continue; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (entry.symlink !== undefined) symlinkSync(entry.symlink, to);
      else {
        if (!lstatSync(from).isFile() || lstatSync(from).isSymbolicLink()) throw new Error(`工具链文件已变化：${from}`);
        try { linkSync(from, to); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          copyFileSync(from, to, constants.COPYFILE_EXCL);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
function tryLock(path: string): Release | undefined {
  try { mkdirSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // 进程被强杀时目录锁不会自己消失；超过会话预算的锁按残留处理。
    try {
      if (Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return;
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path);
    } catch { return; }
  }
  return () => { rmSync(path, { recursive: true, force: true }); };
}
async function lock(path: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<Release> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const release = tryLock(path);
    if (release) return release;
    if (Date.now() >= until) throw new Error(`等待 CodeCheck 工具链锁超时：${path}`);
    await delay(Math.min(50, Math.max(1, until - Date.now())));
  }
}
const lockPath = (root: string, version: string) => join(root, `.${version}.lock`);

/** 返回的首次安装锁由调用方在会话结束时释放，包括会话失败的情况。 */
export async function prepareCodecheckToolchain(dataDir: string | undefined, repo: string,
  options: { lockTimeoutMs?: number } = {}): Promise<CodecheckToolchainPreparation> {
  if (!dataDir) return {};
  const root = rootFor(dataDir);
  let release: Release | undefined;
  try {
    let available = newest(masters(dataDir));
    if (!available.length) {
      // 首次下载前还不知道产品和版本，持锁到成功落母本，避免两个工作区同时下载。
      release = await lock(join(root, ".bootstrap.lock"), options.lockTimeoutMs);
      available = newest(masters(dataDir));
      if (!available.length) return { release };
      release(); release = undefined;
    }
    for (const master of available) {
      const unlock = await lock(lockPath(dirname(master.root), master.manifest.version), options.lockTimeoutMs);
      try {
        mirror(join(master.root, "tree"), directory(repo, ".codecheckcli"), master.manifest.files);
        save(master.root, { ...master.manifest, lastUsedAt: Date.now() });
      } finally { unlock(); }
    }
    return {};
  } catch (error) { release?.(); throw error; }
}

/** 同一进程同版本共享一次落盘工作；跨进程用目录锁和最终清单确认完成。 */
export async function seedCodecheckToolchain(dataDir: string | undefined, repo: string): Promise<void> {
  if (!dataDir) return;
  rootFor(dataDir);
  const source = join(repo, ".codecheckcli");
  if (!existsSync(source)) return;
  directory(repo, ".codecheckcli");
  for (const product of directories(join(source, "home"))) {
    directory(source, `home/${product}/tools/agent`);
    for (const version of directories(join(source, "home", product, "tools", "agent"))) {
      const toolchainRoot = `home/${product}/tools/agent/${version}`;
      const entries = files(source, toolchainRoot);
      if (!entries.some(e => e.symlink === undefined)) continue;
      const parent = directory(cacheRoot(dataDir), product);
      const root = join(parent, version);
      let work = seeds.get(root);
      if (!work) {
        work = (async () => {
          const release = await lock(lockPath(parent, version));
          try {
            const existing = masters(dataDir).find(master => master.root === root);
            if (existing) {
              save(root, { ...existing.manifest, lastUsedAt: Date.now() });
              return;
            }
            // 清单损坏或缺失时按本次下载重建，不能留一份永远不可用的母本。
            if (existsSync(root)) rmSync(root, { recursive: true, force: true });
            directory(parent, version);
            mirror(source, directory(root, "tree"), entries);
            const now = Date.now();
            save(root, { product, version, toolchainRoot, files: entries, fileCount: entries.length,
              bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), createdAt: now, lastUsedAt: now });
          } finally { release(); }
        })().finally(() => { seeds.delete(root); });
        seeds.set(root, work);
      }
      await work;
    }
  }
}

/** 旧母本只解链；任务侧仍在使用的硬链接不受影响，最新版本始终保留。 */
export function reclaimCodecheckToolchain(dataDir: string, options: { maxAgeMs: number }): { masters: number; bytes: number } {
  const result = { masters: 0, bytes: 0 };
  const items = masters(dataDir), keep = new Set(newest(items).map(m => m.root));
  for (const master of items) {
    if (keep.has(master.root) || Date.now() - master.manifest.lastUsedAt <= options.maxAgeMs) continue;
    const release = tryLock(lockPath(dirname(master.root), master.manifest.version));
    if (!release) continue;
    try {
      // 另一个进程可能刚在本次扫描与拿锁之间复用过它。
      const current = JSON.parse(readFileSync(join(master.root, "manifest.json"), "utf8")) as Manifest;
      if (Date.now() - current.lastUsedAt <= options.maxAgeMs) continue;
      rmSync(master.root, { recursive: true, force: true });
      result.masters++; result.bytes += master.manifest.bytes;
    } finally { release(); }
  }
  return result;
}

/** 母本按清单计逻辑字节；任务增量排除和母本 inode 相同的文件，跨盘复制计入增量。 */
export function codecheckToolchainStats(dataDir: string, repo?: string): {
  masters: number; bytes: number; taskBytes: number; taskIncrementalBytes: number;
} {
  const items = masters(dataDir);
  const result = { masters: items.length, bytes: items.reduce((sum, m) => sum + m.manifest.bytes, 0),
    taskBytes: 0, taskIncrementalBytes: 0 };
  if (!repo || !existsSync(join(repo, ".codecheckcli"))) return result;
  const shared = new Set<string>();
  for (const master of items) for (const entry of master.manifest.files) {
    if (entry.symlink !== undefined) continue;
    const info = statSync(join(master.root, "tree", entry.path));
    shared.add(`${info.dev}:${info.ino}`);
  }
  const walk = (path: string) => {
    const info = lstatSync(path);
    if (info.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); }
    else if (info.isFile()) {
      result.taskBytes += info.size;
      if (!shared.has(`${info.dev}:${info.ino}`)) result.taskIncrementalBytes += info.size;
    }
  };
  walk(join(repo, ".codecheckcli"));
  return result;
}
