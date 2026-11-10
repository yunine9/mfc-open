/**
 * Root 宿主与非 root 任务容器之间的文件所有权接缝。
 *
 * 正式推荐仍是“服务账号 uid:gid = 容器 uid:gid”。但部分部署由 root
 * 守护进程启动，并显式把业务命令降到 10001:10001。此时 clone、内核
 * bootstrap 和宿主文件工具创建的内容都归 root；只把 Docker `-u` 改成
 * 10001 并不会自动改变 bind mount 的所有权。
 *
 * 本模块只处理真正挂给任务容器的代码工作区、明确单独挂载的任务材料
 * 子目录和平台管理的构建缓存。task.json、models.json、账号与凭据等
 * 控制面目录绝不能顺手 chown。
 */

import {
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const CACHE_DESTINATIONS = new Set([
  "/cache/maven",
  "/cache/maven/repository/.mfc-remote",
  "/cache/npm",
  "/cache/ccache",
  "/cache/xdg",
]);
const OWNER_MARKER_PREFIX = ".mae-flow-container-owner-v1";

export interface NumericOwner {
  uid: number;
  gid: number;
}

export interface ContainerOwnershipRuntime {
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}

export interface PreparedOwnership {
  active: boolean;
  owner?: NumericOwner;
  workspaceEntries: number;
  cacheTrees: number;
}

/** Root/Linux 才需要代容器用户接管宿主文件；其他形态天然同属主或由
 * Docker Desktop 做映射。Root 形态必须给精确数字 uid:gid，名字只在
 * 容器 `/etc/passwd` 内有意义，宿主无法安全地拿它 chown。 */
export function rootContainerOwner(
  user: string | undefined,
  runtime: ContainerOwnershipRuntime = {},
): NumericOwner | undefined {
  const platform = runtime.platform ?? process.platform;
  const effectiveUid = runtime.effectiveUid ?? process.getuid?.();
  if (platform !== "linux" || effectiveUid !== 0) return undefined;
  const match = user?.trim().match(/^([0-9]+):([0-9]+)$/);
  if (!match) {
    throw new Error(
      "服务以 root 运行时，--isolate-user 必须是非 root 数字 uid:gid"
      + "（例如 10001:10001），以便准备 bind 工作区所有权",
    );
  }
  const uid = Number(match[1]);
  const gid = Number(match[2]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)
      || uid <= 0 || gid <= 0) {
    throw new Error(
      "服务以 root 运行时，--isolate-user 的 uid 和 gid 必须都是正整数",
    );
  }
  return { uid, gid };
}

function chownTree(path: string, owner: NumericOwner): number {
  const root = resolve(path);
  if (root === "/" || !existsSync(root)) {
    throw new Error(`拒绝准备不安全或不存在的容器目录：${root}`);
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`容器挂载根不能是符号链接：${root}`);
  }
  let changed = 0;
  const visit = (entry: string): void => {
    let stat;
    try {
      stat = lstatSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
        lchownSync(entry, owner.uid, owner.gid);
        changed += 1;
      }
      return; // 只改链接本身，绝不跟随到工作区外。
    }
    // Git 对象若与别的仓共享 inode(旧版本地 clone 的 hardlink 复用),
    // 这里 chown 会直接改到源仓/兄弟任务的同一对象上——数据安全问题,
    // 宁可任务起不来也不能悄悄污染源仓(e2e-picky-20260830 实锤)。
    // 新 clone 已统一 --no-local,撞到这条只可能是历史现场,提示重建。
    if (stat.isFile() && stat.nlink > 1
        && /\/\.git\/objects\//.test(entry.split("\\").join("/"))) {
      throw new Error(
        `拒绝准备容器属主:Git 对象与其他仓库共享硬链接(nlink=${stat.nlink})`
        + `——继续会污染源仓。请重新发起任务以获得隔离克隆:${entry}`);
    }
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
      chownSync(entry, owner.uid, owner.gid);
      changed += 1;
    }
    if (!stat.isDirectory()) return;
    for (const child of readdirSync(entry)) visit(join(entry, child));
  };
  visit(root);
  return changed;
}

function cacheSource(volume: string, cacheRoot: string | undefined): string | undefined {
  const [source, destination, mode] = volume.split(":");
  if (!source || !destination || !isAbsolute(source) || !cacheRoot) {
    return undefined;
  }
  const resolvedSource = resolve(source);
  const resolvedCacheRoot = resolve(cacheRoot);
  if (resolvedSource !== resolvedCacheRoot
      && !resolvedSource.startsWith(`${resolvedCacheRoot}/`)) {
    return undefined;
  }
  const resolvedDestination = resolve(destination);
  // 前四类使用固定容器目录；C++ SDK 为保持业务仓 build/../../ 语义，
  // 动态挂到代码仓同级的 cpp_sdk_repository。它同样是平台按仓创建的
  // cacheRoot 子树，root 宿主必须在 docker run 前交给任务 uid。
  if (!CACHE_DESTINATIONS.has(resolvedDestination)
      && basename(resolvedDestination) !== "cpp_sdk_repository") {
    return undefined;
  }
  if (mode?.split(",").includes("ro")) return undefined;
  return resolvedSource;
}

function ownershipMarkerRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`容器属主标记目录必须是宿主专用真实目录：${path}`);
  }
  // 旧部署可能曾用 umask 0000。标记决定 root 是否跳过整棵缓存核对，
  // 不能放在容器可写目录里，也不能继续继承 world-writable 权限。
  chmodSync(path, 0o700);
}

function prepareCache(
  path: string,
  owner: NumericOwner,
  markerRoot: string,
): boolean {
  mkdirSync(path, { recursive: true });
  ownershipMarkerRoot(markerRoot);
  // 签名绑定目录 inode:缓存被回收重建后路径相同、inode 必然不同,
  // 旧标记不得再让宿主跳过核对(MFC-013:重建后 marker 陈旧,root
  // 误以为属主已就位)。
  const identity = lstatSync(path);
  const signature =
    `${owner.uid}:${owner.gid} ${identity.dev}:${identity.ino}\n`;
  const sourceId = createHash("sha256").update(resolve(path)).digest("hex");
  const marker = join(
    markerRoot,
    `${OWNER_MARKER_PREFIX}-${sourceId}-${owner.uid}-${owner.gid}`,
  );
  try {
    if (lstatSync(marker).isSymbolicLink()) {
      throw new Error(`容器属主标记不能是符号链接：${marker}`);
    }
    if (readFileSync(marker, "utf-8") === signature) return false;
  } catch {
    // 首次使用、旧用户或损坏标记都重新核对整棵缓存。
  }
  chownTree(path, owner);
  const temporary = join(
    dirname(marker), `.${basename(marker)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, signature, { mode: 0o600, flag: "wx" });
  renameSync(temporary, marker);
  return true;
}

/** 在 docker run 之前调用。workspace 必须是本次真正可写 bind 的代码
 * 现场或平台明确划出的窄材料目录，不能传任务控制面根目录。缓存使用
 * 属主标记避免每单递归扫描大仓库。 */
export function prepareContainerHostPaths(input: {
  workspace: string;
  volumes: readonly string[];
  user?: string;
  /** 宿主专用，绝不能 bind 给任务容器。缓存跳过标记放在这里。 */
  markerRoot?: string;
  /** 只有平台管理的缓存根子树才允许递归 chown；自定义 volume 不参与。 */
  cacheRoot?: string;
  runtime?: ContainerOwnershipRuntime;
  log?: (message: string) => void;
}): PreparedOwnership {
  const owner = rootContainerOwner(input.user, input.runtime);
  if (!owner) {
    return { active: false, workspaceEntries: 0, cacheTrees: 0 };
  }
  if (!input.markerRoot) {
    throw new Error("root 宿主准备容器缓存时缺少宿主专用属主标记目录");
  }
  const started = performance.now();
  input.log?.('[container-prepare] {"event":"start"}');
  try {
  const workspaceEntries = chownTree(input.workspace, owner);
  let cacheTrees = 0;
  const seen = new Set<string>();
  for (const volume of input.volumes) {
    const source = cacheSource(volume, input.cacheRoot);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    if (prepareCache(source, owner, resolve(input.markerRoot))) cacheTrees += 1;
    if (volume.split(":")[1] === "/cache/maven") {
      // 升级时这两层可能刚由 root 创建，旧 maven 根的属主标记仍然有效。
      // 只检查挂载所需的两层目录，不能为此每次重扫数十 GB 的老本地仓。
      for (const relative of ["repository", "repository/.mfc-remote"]) {
        const path = join(source, relative);
        if (!existsSync(path)) break;
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(`Maven 缓存挂载父目录必须是真实目录：${path}`);
        }
        if (info.uid !== owner.uid || info.gid !== owner.gid) chownSync(path, owner.uid, owner.gid);
      }
    }
  }
  return { active: true, owner, workspaceEntries, cacheTrees };
  } finally {
    input.log?.(`[container-prepare] ${JSON.stringify({ event: "finish", elapsed_ms: Math.round(performance.now() - started) })}`);
  }
}

/**
 * 把任务控制面里平台明确划给 Agent 的单个回执文件交给容器用户。
 *
 * 不能为了一份回执递归 chown 它的父目录：父目录可能同时放着宿主的
 * 可信索引。调用方先以宿主身份创建普通文件，这里只核对真实边界并
 * 交接这一枚 inode；容器也应只 bind 这一文件，不能顺手挂整棵目录。
 */
export function prepareContainerWritableFile(input: {
  workspace: string;
  path: string;
  user?: string;
  runtime?: ContainerOwnershipRuntime;
}): boolean {
  const owner = rootContainerOwner(input.user, input.runtime);
  if (!owner) return false;
  const workspace = realpathSync(resolve(input.workspace));
  const requested = resolve(input.path);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`容器回执必须是宿主预创建的普通文件：${requested}`);
  }
  // macOS 的 /var -> /private/var 等系统级规范化不能被误报为越界；
  // 同时先 lstat 拒绝目标软链，避免 realpath 跟到工作区外。
  const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested));
  if (target === workspace || !target.startsWith(`${workspace}/`)) {
    throw new Error(`拒绝准备任务工作区外的容器回执文件：${target}`);
  }
  if (parent !== workspace && !parent.startsWith(`${workspace}/`)) {
    throw new Error(`容器回执文件父目录越出任务工作区：${target}`);
  }
  if (stat.uid === owner.uid && stat.gid === owner.gid) return false;
  chownSync(requested, owner.uid, owner.gid);
  return true;
}

/**
 * Pi 的 Write/Edit 在宿主进程执行。root 宿主写完一个文件后要立刻把该
 * 文件及新建父目录交回容器用户；否则开场 chown 虽成功，下一次编译仍
 * 可能因刚生成的 root 文件失败。工作区外的修复材料不在 bind mount 中，
 * 这里明确忽略，不扩大 chown 边界。
 */
export function repairContainerMutationOwnership(input: {
  workspace: string;
  path: string;
  user?: string;
  runtime?: ContainerOwnershipRuntime;
  /** 宿主预置整套工具链时，子目录和跨盘复制的文件也要交给容器用户。 */
  recursive?: boolean;
}): boolean {
  const owner = rootContainerOwner(input.user, input.runtime);
  if (!owner) return false;
  const workspace = resolve(input.workspace);
  const target = resolve(workspace, input.path);
  if (target !== workspace && !target.startsWith(`${workspace}/`)) return false;
  if (!existsSync(target)) {
    throw new Error(`文件工具写入后目标不存在，无法准备容器属主：${target}`);
  }
  if (input.recursive) chownTree(target, owner);
  let cursor = target;
  while (true) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      // GateService 已在执行前校验真实目标；此处仍只 lchown 链接本身，
      // 不让一个写入后的竞态把 root chown 引到工作区外。
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
        lchownSync(cursor, owner.uid, owner.gid);
      }
    } else if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
      chownSync(cursor, owner.uid, owner.gid);
    }
    if (cursor === workspace) break;
    cursor = dirname(cursor);
  }
  return true;
}

/**
 * 宿主 git 在容器运行期间落盘后的整树交接。问题流的克隆与切分支都在
 * 宿主执行而容器已在跑（需求流是"先 clone → 整树 chown → 再 docker
 * run"，时序天然安全；问题流的 clone 发生在 docker run 之后），这些
 * root 新文件不交回容器用户，容器内 git add/commit 就是 Permission
 * denied。调用点必须在整个宿主 git 写结束之后：切分支的 checkout 会
 * 重写 .git 内部，提前 chown 会被原样污染回去。
 */
export function repairContainerCloneOwnership(input: {
  /** 会话工作区边界；dir 只许是里面的代码仓现场。 */
  workspace: string;
  dir: string;
  user?: string;
  runtime?: ContainerOwnershipRuntime;
}): boolean {
  // 无 user 先行 false:调用点对非隔离部署同样每单路过,而
  // rootContainerOwner 对 root 形态缺 user 是 fail-loud——那是容器
  // 启动期的契约,不该在拉仓收口上爆炸。
  if (!input.user?.trim()) return false;
  const owner = rootContainerOwner(input.user, input.runtime);
  if (!owner) return false;
  const workspace = resolve(input.workspace);
  const dir = resolve(workspace, input.dir);
  // 边界比写入修复更紧：工作区根本身还背着 issue.json 等控制面文件，
  // 整树交接只认 workspace 深处的工作区，根目录整体 chown 不在本职内。
  if (!dir.startsWith(`${workspace}/`)) return false;
  // 调用点在 clone 之后，dir 不在场说明时序已被破坏，与写入修复同款
  // fail-loud（chownTree 自带存在性守卫），不吞成静默 false。
  chownTree(dir, owner);
  return true;
}

/** 宿主 KernelHost 使用原子 replace 写状态，会把原本属于容器用户的
 * `.mae-flow*` 文件重新变成 root。每次 Hook 收口只核对这些小型状态树，
 * 不递归扫描整个业务仓。 */
export function repairContainerKernelOwnership(input: {
  workspace: string;
  user?: string;
  runtime?: ContainerOwnershipRuntime;
}): number {
  const owner = rootContainerOwner(input.user, input.runtime);
  if (!owner) return 0;
  const workspace = resolve(input.workspace);
  let changed = 0;
  for (const name of readdirSync(workspace)) {
    if (!name.startsWith(".mae-flow") && name !== ".codecheckcli") continue;
    changed += chownTree(join(workspace, name), owner);
  }
  return changed;
}
