/**
 * 在 Agent 可写工作区上执行宿主只读/编排 Git 命令的最小安全边界。
 *
 * `.git/config`、hooks 与进程继承的 `GIT_*` 都是不可信输入：其中的
 * fsmonitor、external diff、remote helper 或 hook 可以把一次看似只读的
 * `git status/diff` 变成宿主命令执行。本模块因此忽略仓库/用户/系统配置，
 * 只保留调用点显式给出的 `-c`，并关闭交互、pager、hook 与 ext 协议。
 * 真正的网络 push 还需独立的临时传输仓和凭据沙箱，不能只靠本模块。
 */

import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SafeGitOptions {
  configs?: ReadonlyArray<readonly [key: string, value: string]>;
  env?: NodeJS.ProcessEnv;
  /** 宿主创建的临时索引；不从工作区配置或普通环境变量读取。 */
  indexFile?: string;
  /** 仅供宿主重建 commit 对象时显式提供。普通 env 中的 GIT_AUTHOR_* /
   * GIT_COMMITTER_* 仍会被清除，避免 Agent 环境暗改宿主提交身份。 */
  commitIdentity?: SafeGitCommitIdentity;
  maxBuffer?: number;
  timeoutMs?: number;
}

export interface SafeGitCommitIdentity {
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
}

export interface SafeGitAsyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface SafeGitView {
  /** 可信代理 gitdir；config 为空，不读取 Agent 可写的 .git/config。 */
  proxyGitDir: string;
  /** 已验证仍位于工作区内的真实 gitdir / object directory。 */
  repositoryGitDir: string;
  objectDirectory: string;
  environment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  cleanup(): void;
}

let processEmptyConfig: string | undefined;

/**
 * Git 的全局/系统配置必须指向真实空文件，不能依赖 `/dev/null`。
 *
 * 一些内网容器/沙箱会把 `/dev/null` 投影成普通文件，Git 会因此报
 * `bad config line 1 in file /dev/null`，甚至 `git --version` 都无法
 * 执行。这里每个 Cloud 进程只创建一次 0700 私有目录和 0600 空配置；
 * 文件若被系统临时目录清理，下次调用会自动重建。
 */
function emptyGitConfig(): string {
  if (processEmptyConfig && existsSync(processEmptyConfig)) {
    try {
      const info = lstatSync(processEmptyConfig);
      if (info.isFile() && !info.isSymbolicLink()) return processEmptyConfig;
    } catch {
      // 系统可能刚清理临时目录；下面在新的私有目录中重建。
    }
  }
  const root = mkdtempSync(join(tmpdir(), "mae-flow-git-config-"));
  chmodSync(root, 0o700);
  const config = join(root, "empty.gitconfig");
  writeFileSync(config, "", { mode: 0o600 });
  processEmptyConfig = config;
  return config;
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

function regularInside(root: string, path: string, label: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} 必须是工作区内的普通文件`);
  }
  const real = realpathSync(path);
  if (!contained(root, real)) throw new Error(`${label} 越出任务工作区`);
  return real;
}

function directoryInside(root: string, path: string, label: string): string {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} 必须是工作区内的真实目录`);
  }
  const real = realpathSync(path);
  if (!contained(root, real)) throw new Error(`${label} 越出任务工作区`);
  return real;
}

/**
 * 给宿主 Git / 会调用 Git 的内核进程创建只读配置视图。
 *
 * `GIT_CONFIG=/dev/null` 只改变 `git config` 的默认文件，不能让普通
 * `git status/diff/merge` 忽略 `.git/config`。这里因此使用独立 gitdir：
 * HEAD 是启动时快照，objects/refs 指向已验证的任务仓内部目录，index
 * 仍显式指向真实 index；代理 config 永远为空。这样 fsmonitor、filter、
 * external diff、merge driver、credential helper 与 url.insteadOf 都没有
 * 配置来源，同时状态/暂存区仍与任务工作区一致。
 */
export function createSafeGitView(cwd: string): SafeGitView {
  const workspace = realpathSync(resolve(cwd));
  const repositoryGitDir = directoryInside(
    workspace, join(workspace, ".git"), "Git 元数据目录");
  const objectDirectory = directoryInside(
    workspace, join(repositoryGitDir, "objects"), "Git 对象目录");
  const refs = directoryInside(
    workspace, join(repositoryGitDir, "refs"), "Git refs 目录");
  const head = regularInside(
    workspace, join(repositoryGitDir, "HEAD"), "Git HEAD");
  const indexPath = join(repositoryGitDir, "index");
  const index = existsSync(indexPath)
    ? regularInside(workspace, indexPath, "Git index") : undefined;
  const alternates = join(objectDirectory, "info", "alternates");
  if (existsSync(alternates)
      && readFileSync(alternates, "utf-8").trim()) {
    throw new Error("Git objects/info/alternates 不允许指向任务仓外对象库");
  }

  const root = mkdtempSync(join(tmpdir(), "mae-flow-safe-git-"));
  chmodSync(root, 0o700);
  const proxyGitDir = join(root, "gitdir");
  mkdirSync(proxyGitDir, { mode: 0o700 });
  writeFileSync(join(proxyGitDir, "config"), "", { mode: 0o600 });
  writeFileSync(join(proxyGitDir, "HEAD"), readFileSync(head), { mode: 0o600 });
  symlinkSync(objectDirectory, join(proxyGitDir, "objects"), "dir");
  symlinkSync(refs, join(proxyGitDir, "refs"), "dir");
  for (const name of ["packed-refs", "shallow"] as const) {
    const source = join(repositoryGitDir, name);
    if (!existsSync(source)) continue;
    symlinkSync(regularInside(workspace, source, `Git ${name}`),
      join(proxyGitDir, name), "file");
  }

  let removed = false;
  const view: SafeGitView = {
    proxyGitDir,
    repositoryGitDir,
    objectDirectory,
    environment: (extra = {}) => safeGitEnvironment({
      ...extra,
      GIT_DIR: proxyGitDir,
      GIT_WORK_TREE: workspace,
      ...(index ? { GIT_INDEX_FILE: index } : {}),
    }),
    cleanup: () => {
      if (removed) return;
      removed = true;
      rmSync(root, { recursive: true, force: true });
    },
  };
  return view;
}

/** 清掉所有可改变 Git 执行路径的继承变量，再装入固定非交互配置。 */
export function safeGitEnvironment(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "SSH_ASKPASS") delete env[key];
  }
  const config = emptyGitConfig();
  return {
    ...env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_OPTIONAL_LOCKS: "0",
    // 这些键使用 Git 的 command-scope 配置，优先级高于任意文件配置。
    // 真正隔离 local config 仍依赖 createSafeGitView，不能只靠这组覆盖。
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "protocol.ext.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "commit.gpgSign",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "credential.helper",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "core.sshCommand",
    GIT_CONFIG_VALUE_5: "false",
    // createSafeGitView 的定位变量只能由可信调用方通过 extra 提供；在
    // 清除继承值后回填，其他 GIT_* 不接受部署/Agent 环境注入。
    ...Object.fromEntries(Object.entries(extra).filter(([key]) =>
      ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(key))),
  };
}

export function safeGitArguments(
  cwd: string,
  args: readonly string[],
  configs: SafeGitOptions["configs"] = [],
): string[] {
  return [
    "--no-pager",
    "-c", `safe.directory=${resolve(cwd)}`,
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "protocol.ext.allow=never",
    "-c", "commit.gpgSign=false",
    ...configs.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...args,
  ];
}

export function runSafeWorktreeGit(
  cwd: string,
  args: readonly string[],
  options: SafeGitOptions = {},
): SpawnSyncReturns<string> {
  const view = createSafeGitView(cwd);
  try {
    return spawnSync("git", safeGitArguments(cwd, args, options.configs), {
      cwd,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      timeout: options.timeoutMs,
      env: safeGitProcessEnvironment(view, options),
    });
  } finally {
    view.cleanup();
  }
}

/** HTTP/观测路径必须使用异步 Git。同步版本仍供启动期和状态机内极短的
 * 本地查询使用；把它放进请求回调会让一个慢 diff 拖死整个 Node 服务。 */
export function runSafeWorktreeGitAsync(
  cwd: string,
  args: readonly string[],
  options: SafeGitOptions = {},
): Promise<SafeGitAsyncResult> {
  let view: SafeGitView;
  try {
    view = createSafeGitView(cwd);
  } catch (error) {
    return Promise.resolve({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return new Promise((resolveResult) => {
    execFile("git", safeGitArguments(cwd, args, options.configs), {
      cwd,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      timeout: options.timeoutMs,
      env: safeGitProcessEnvironment(view, options),
    }, (error, stdout, stderr) => {
      view.cleanup();
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolveResult({
        status: error ? (typeof code === "number" ? code : null) : 0,
        signal: (error as NodeJS.ErrnoException & {
          signal?: NodeJS.Signals;
        } | null)?.signal ?? null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        ...(error ? { error } : {}),
      });
    });
  });
}

function safeGitProcessEnvironment(
  view: SafeGitView,
  options: SafeGitOptions,
): NodeJS.ProcessEnv {
  const env = { ...view.environment(options.env),
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}) };
  const identity = options.commitIdentity;
  if (!identity) return env;
  return {
    ...env,
    GIT_AUTHOR_NAME: identity.authorName,
    GIT_AUTHOR_EMAIL: identity.authorEmail,
    GIT_AUTHOR_DATE: identity.authorDate,
    GIT_COMMITTER_NAME: identity.committerName,
    GIT_COMMITTER_EMAIL: identity.committerEmail,
    GIT_COMMITTER_DATE: identity.committerDate,
  };
}
