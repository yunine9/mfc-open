/**
 * 任务容器运行时。
 *
 * Cloud 控制面仍在宿主；业务命令只经这里进入任务专属容器。这个类
 * 自己守住最后一道边界：容器不存在、不满足加固项、Docker 状态不可
 * 确认时一律拒绝执行，绝不偷偷回退宿主。
 */

import { MAE_CONTAINER_BOOTSTRAP, MAE_EXEC_ENVIRONMENT } from "./maeBuildSupport.ts";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CONTAINER_USER_BOOTSTRAP, containerUserEnvironment, withOptionalCompilerCache } from "./containerBuildEnvironment.ts";

export const TASK_CONTAINER_HOME = "/home/mae-flow";

const DEFAULT_PIDS_LIMIT = 512;
const DEFAULT_STOP_GRACE_SECONDS = 5;
const DEFAULT_MANAGEMENT_TIMEOUT_MS = 30_000;
const RUNNING_PROBE_ATTEMPTS = 3;
const RUNNING_PROBE_BACKOFF_MS = [100, 300] as const;
const DEFAULT_HOME_TMPFS = "rw,nosuid,nodev,size=256m,mode=1777";
// Maven libjansi、JNA/SQLite 等会从 /tmp mmap/执行 native library；Docker
// daemon 在部分环境把 tmpfs 落成 noexec，所以这里必须显式写 exec。
const DEFAULT_TMP_TMPFS = "rw,exec,nosuid,nodev,size=1g,mode=1777";
const MAX_BASH_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const DEFAULT_FORWARDED_ENV = [
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

const RESERVED_ENV = new Set([
  "HOME",
  "TMPDIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
]);

// 模型/平台/Git 凭据绝不能顺手跟着宿主 process.env 进入业务容器。
const SECRET_ENV = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)(?:_|$)/i;

export interface DockerCommandOptions {
  timeoutMs?: number;
  includeStderr?: boolean;
}

export interface DockerStreamOptions {
  onData: (data: Buffer) => void;
}

export interface DockerStreamProcess {
  readonly completed: Promise<{ exitCode: number | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/** 可注入的 Docker CLI 边界：单测不依赖本机 daemon。 */
export interface DockerRunner {
  command(
    args: readonly string[],
    options?: DockerCommandOptions,
  ): Promise<string>;
  stream(args: readonly string[], options: DockerStreamOptions): DockerStreamProcess;
}

export class DockerCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode?: number | string | null,
  ) {
    super(stderr || `docker ${args.join(" ")} 执行失败`);
    this.name = "DockerCommandError";
  }
}

export type TaskContainerUnavailableKind =
  | "missing"
  | "stopped"
  | "inspect_unavailable";

/**
 * 容器执行面的结构化基础设施错误。调用方不能把它当成普通 Bash 失败
 * 继续让模型试命令；prepush 会据此熔断本轮并如实上报平台故障。
 */
export class TaskContainerUnavailableError extends Error {
  constructor(
    readonly kind: TaskContainerUnavailableKind,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "TaskContainerUnavailableError";
  }
}

/**
 * 命令自己的墙钟预算耗尽。容器会按隔离契约被完整销毁，但“已停止”只是
 * 清理结果，不是根因；调用方应在第一次异常上按验证超时收口。
 */
export class TaskContainerExecTimeoutError extends Error {
  constructor(readonly timeoutSeconds: number) {
    // Pi 的 Bash tool 依赖此前缀渲染统一的超时文案，结构化类型则供宿主熔断。
    super(`timeout:${timeoutSeconds}`);
    this.name = "TaskContainerExecTimeoutError";
  }
}

export class DockerCliRunner implements DockerRunner {
  command(
    args: readonly string[],
    options: DockerCommandOptions = {},
  ): Promise<string> {
    return new Promise((resolveResult, reject) => {
      execFile("docker", [...args], {
        encoding: "utf-8",
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(new DockerCommandError(args, stderr.trim() || String(error), code));
          return;
        }
        resolveResult((options.includeStderr ? `${stdout}\n${stderr}` : stdout).trim());
      });
    });
  }

  stream(args: readonly string[], options: DockerStreamOptions): DockerStreamProcess {
    const child = spawn("docker", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    const completed = new Promise<{ exitCode: number | null }>((done, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => done({ exitCode }));
    });
    return {
      completed,
      kill: (signal = "SIGKILL") => {
        try {
          child.kill(signal);
        } catch {
          // 容器销毁后 docker exec 客户端通常已经自己退出；重复 kill 无害。
        }
      },
    };
  }
}

const DEFAULT_RUNNER = new DockerCliRunner();

export interface TaskContainerLimits {
  memory?: string;
  cpus?: string;
  user?: string;
  pidsLimit?: number;
}

export interface TaskContainerOptions {
  /** 业务标签会和平台的 managed/name 标签合并。 */
  labels?: Record<string, string>;
  /** 缺省开启；仅为向后兼容测试镜像保留显式关闭能力。 */
  readOnlyRoot?: boolean;
  /** false 才关闭；字符串是 Docker tmpfs mount options。 */
  tmpfsHome?: string | false;
  tmpfsTmp?: string | false;
  /** 缺省 bridge；host/container:* 会破坏隔离，始终拒绝。 */
  network?: string;
  /** 部署明确下发的非敏感构建环境。值会出现在容器 inspect 中。 */
  environment?: NodeJS.ProcessEnv;
  /** 每次 Bash 调用允许从 Pi 环境透传的键；默认仅 PI 元数据/locale。 */
  forwardEnvironment?: readonly string[];
  stopGraceSeconds?: number;
  managementTimeoutMs?: number;
  runner?: DockerRunner;
}

export interface TaskContainerMetadata {
  containerId: string;
  name: string;
  imageReference: string;
  imageId: string;
  imageDigest: string;
  repoDigests: string[];
  immutableImageReference: string;
  createdAt?: string;
  startedAt?: string;
  workspace: string;
  labels: Record<string, string>;
  network: string;
  readOnlyRoot: boolean;
  pidsLimit: number;
  memoryBytes?: number;
  nanoCpus?: number;
  user?: string;
  environmentKeys: string[];
  mounts: Array<{
    destination: string;
    readOnly: boolean;
    type?: string;
  }>;
}

type Lifecycle = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

interface ContainerInspect {
  Id?: string;
  Name?: string;
  Image?: string;
  Created?: string;
  Config?: {
    Image?: string;
    User?: string;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  State?: { Running?: boolean; StartedAt?: string; ExitCode?: number; Error?: string; OOMKilled?: boolean; Status?: string };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidsLimit?: number;
    NetworkMode?: string;
    Memory?: number;
    NanoCpus?: number;
    Tmpfs?: Record<string, string>;
  };
  Mounts?: Array<{
    Source?: string;
    Destination?: string;
    RW?: boolean;
    Type?: string;
  }>;
}

interface ImageInspect {
  Id?: string;
  RepoDigests?: string[] | null;
}

function parseFirst<T>(raw: string, what: string): T {
  try {
    const parsed = JSON.parse(raw);
    const value = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!value || typeof value !== "object") throw new Error("结果为空");
    return value as T;
  } catch (error) {
    throw new Error(`无法解析 Docker ${what} 结果: ${String(error)}`);
  }
}

function isMissingContainer(error: unknown): boolean {
  if (!(error instanceof DockerCommandError)) return false;
  return /no such container|no such object/i.test(error.stderr);
}

function errorDetail(error: unknown): string {
  if (error instanceof DockerCommandError) return `docker ${error.args[0]} exit=${error.exitCode ?? "unknown"}: ${error.stderr}`;
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorDetail).join(" | ")}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`容器环境变量名不合法: ${key}`);
  }
  if (SECRET_ENV.test(key)) {
    throw new Error(`拒绝向任务容器传递疑似凭据环境变量: ${key}`);
  }
}

function envEntries(environment: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
}

function assertSafeVolume(volume: string, workspace: string, home = TASK_CONTAINER_HOME): void {
  if (/docker\.sock/i.test(volume)) {
    throw new Error("任务容器禁止挂载 Docker socket");
  }
  // 当前仅支持 Unix 主机；取第二段即可得到 container destination。
  const destination = volume.split(":")[1];
  if (!destination || !isAbsolute(destination)) {
    throw new Error(`容器挂载格式必须是 宿主绝对路径:容器绝对路径[:ro]: ${volume}`);
  }
  if ([workspace, "/", TASK_CONTAINER_HOME, home, "/tmp"].includes(resolve(destination))) {
    throw new Error(`额外挂载不能覆盖隔离关键目录: ${destination}`);
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

export interface ContainerUserInput {
  /** --isolate-user 的原值;未配置为 undefined。 */
  configured?: string;
  platform: NodeJS.Platform;
  /** 服务进程自己的 uid/gid;非 POSIX 平台上可能取不到。 */
  uid?: number;
  gid?: number;
}

export interface ContainerUserChoice {
  user?: string;
  /** 为什么是这个值——启动日志要打出来,不能让人事后靠猜。 */
  reason: string;
}

/**
 * 决定容器以哪个用户跑。
 *
 * Linux 上这不是性能旋钮而是正确性问题:工作区是 bind mount,容器里
 * 写出来的文件在宿主上就是容器 uid 的。镜像默认 builder 是 10001,
 * 和服务账号对不上时,宿主接手做 git add/commit/push 直接 EACCES——
 * 而且是在 Agent 干完活之后才炸,现场已经脏了。所以 Linux 不配就按
 * 服务进程自己的 uid:gid 跑,让容器写出来的东西天生归宿主所有。
 *
 * macOS/Windows 的 Docker(Desktop、Colima)在 VM 边界上做 uid 映射,
 * 宿主看到的属主永远是当前用户,套本机 uid 反而会撞上 VM 里不存在的
 * 用户。那边保持镜像默认。
 */
export function resolveContainerUser(
  input: ContainerUserInput,
): ContainerUserChoice {
  const configured = input.configured?.trim();
  if (configured) {
    if (input.platform === "linux" && (input.uid === 0 || input.gid === 0)
        && !/^[1-9][0-9]*:[1-9][0-9]*$/.test(configured)) {
      throw new Error(
        "Mae-Flow Cloud 以 root 运行时，--isolate-user 必须使用非 root "
        + "数字 uid:gid（例如 10001:10001），宿主才能安全准备工作区属主",
      );
    }
    return { user: configured, reason: "由 --isolate-user 显式指定" };
  }
  if (input.platform !== "linux") {
    return {
      reason: `${input.platform} 的 Docker 在 VM 边界做 uid 映射,`
        + "沿用镜像内置非 root 用户",
    };
  }
  const { uid, gid } = input;
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(
      "Linux 上取不到服务进程的 uid/gid，无法保证容器写出的文件宿主可读写。"
      + "请显式指定 --isolate-user <uid>:<gid>。");
  }
  if (uid === 0 || gid === 0) {
    // 兜到 0:0 等于让业务命令在容器里当 root,那是明确红线。此时
    // 拒绝启动比"降级成镜像默认用户"诚实——后者会在 push 前才炸。
    throw new Error(
      "Mae-Flow Cloud 正以 root 运行，不能把 root 兜进任务容器。"
      + "请用非 root 服务账号启动，或显式指定 --isolate-user <uid>:<gid>"
      + "（该 uid 需对工作区与构建缓存可写）。");
  }
  return {
    user: `${uid}:${gid}`,
    reason: "Linux 未配 --isolate-user,按服务进程 uid:gid 兜底,"
      + "保证容器写出的文件宿主可读写",
  };
}

/** dataDir 是一个 Cloud 实例的持久身份。完整指纹用于 ownership label，
 * 短前缀只用于可读容器名；清扫永远按完整指纹过滤，不能只凭名字猜。 */
export function taskContainerInstance(dataDir: string): {
  fingerprint: string;
  namePrefix: string;
} {
  let canonical = resolve(dataDir);
  try {
    canonical = realpathSync(canonical);
  } catch {
    // 启动早期目录可能刚创建；resolve 后的绝对路径仍是稳定输入。
  }
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  return { fingerprint, namePrefix: fingerprint.slice(0, 6) };
}

export interface ManagedContainerSweepOptions {
  instanceFingerprint: string;
  namePrefix: string;
  /** 2026-08-29 之前的问题容器只有 managed/container 两枚标签，没有
   * instance/role/task。给出 issues 根目录后，可用“精确旧名字 + 精确
   * 工作区挂载 + 两枚平台标签”迁移清理；其余近似容器仍拒绝触碰。 */
  legacyIssueRoot?: string;
  stopGraceSeconds?: number;
  managementTimeoutMs?: number;
  runner?: DockerRunner;
  log?: (message: string) => void;
}

export interface ManagedContainerSweepResult {
  found: number;
  removed: string[];
}

const MANAGED_ROLES = new Set([
  "coding", "prepush", "system-check", "issue", "knowledge-extract", "pipeline-repair",
]);

/**
 * 清理上一次进程崩溃遗留的本实例容器。
 *
 * 两道 ownership 证明缺一不可：Docker filter 先按完整 dataDir 指纹缩小
 * 范围，随后逐个 inspect 复核 managed/instance/container/name/role。任何
 * 一项不一致都 fail-closed，绝不把“看起来像 Mae-Flow”的外部容器删掉。
 */
export async function sweepManagedTaskContainers(
  options: ManagedContainerSweepOptions,
): Promise<ManagedContainerSweepResult> {
  const runner = options.runner ?? DEFAULT_RUNNER;
  const instance = options.instanceFingerprint.trim();
  const namePrefix = options.namePrefix.trim();
  const grace = options.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS;
  const timeoutMs = options.managementTimeoutMs ?? DEFAULT_MANAGEMENT_TIMEOUT_MS;
  if (!/^[a-f0-9]{64}$/i.test(instance)) {
    throw new Error("容器实例 ownership 指纹必须是 64 位 SHA-256");
  }
  if (!/^[a-f0-9]{6,64}$/i.test(namePrefix)) {
    throw new Error("容器实例名指纹不合法");
  }
  if (!Number.isInteger(grace) || grace < 0 || grace > 60) {
    throw new Error("容器清扫 stopGraceSeconds 必须是 0~60 的整数");
  }
  const command = (args: readonly string[]) => runner.command(args, { timeoutMs });
  const inspect = async (reference: string): Promise<ContainerInspect | undefined> => {
    try {
      return parseFirst<ContainerInspect>(
        await command(["inspect", "--type", "container", reference]),
        "container inspect",
      );
    } catch (error) {
      if (isMissingContainer(error)) return undefined;
      throw error;
    }
  };
  const raw = await command([
    "ps", "-aq",
    "--filter", "label=com.mae-flow-cloud.managed=true",
    "--filter", `label=com.mae-flow-cloud.instance=${instance}`,
  ]);
  const legacyRaw = options.legacyIssueRoot
    ? await command([
        "ps", "-aq",
        "--filter", "label=com.mae-flow-cloud.managed=true",
        "--filter", `name=mfc-${namePrefix}-issue-`,
      ])
    : "";
  const references = [...new Set(`${raw}\n${legacyRaw}`
    .split(/\s+/).filter(Boolean))];
  const removed: string[] = [];
  for (const reference of references) {
    if (!/^[a-f0-9]{12,64}$/i.test(reference)) {
      throw new Error(`Docker 清扫返回了非法容器 ID: ${reference}`);
    }
    let inspected = await inspect(reference);
    if (!inspected) continue;
    const id = String(inspected.Id ?? "");
    const name = String(inspected.Name ?? "").replace(/^\//, "");
    const labels = inspected.Config?.Labels ?? {};
    const role = labels["com.mae-flow-cloud.role"] ?? "";
    const shortId = id.slice(0, 12);
    const image = String(inspected.Image ?? inspected.Config?.Image ?? "<未知镜像>");
    const owned = id.startsWith(reference)
      && name.startsWith(`mfc-${namePrefix}-`)
      && labels["com.mae-flow-cloud.managed"] === "true"
      && labels["com.mae-flow-cloud.instance"] === instance
      && labels["com.mae-flow-cloud.container"] === name
      && MANAGED_ROLES.has(role)
      && (role === "system-check"
        || Boolean(labels["com.mae-flow-cloud.task"]));
    const legacyName = new RegExp(
      `^mfc-${namePrefix}-(issue-[0-9]+)$`).exec(name);
    const legacyWorkspace = legacyName && options.legacyIssueRoot
      ? resolve(options.legacyIssueRoot, legacyName[1]) : undefined;
    const legacyOwned = !owned && !!legacyWorkspace
      && id.startsWith(reference)
      && labels["com.mae-flow-cloud.managed"] === "true"
      && labels["com.mae-flow-cloud.container"] === name
      && labels["com.mae-flow-cloud.instance"] === undefined
      && labels["com.mae-flow-cloud.role"] === undefined
      && labels["com.mae-flow-cloud.task"] === undefined
      && (inspected.Mounts ?? []).some((mount) =>
        resolve(String(mount.Source ?? "")) === legacyWorkspace
        && resolve(String(mount.Destination ?? "")) === legacyWorkspace
        && mount.Type === "bind" && mount.RW === true);
    if (!owned && !legacyOwned) {
      throw new Error(
        `容器清扫 phase=ownership-check role=${role || "unknown"}`
          + ` name=${name || reference} id=${shortId} image=${image}: `
          + "命中实例过滤但 ownership 复验失败，拒绝清理",
      );
    }
    const effectiveRole = legacyOwned ? "issue-legacy" : role;
    options.log?.(`容器清扫 phase=TERM role=${effectiveRole} name=${name} id=${shortId}`
      + ` image=${image}`);
    try {
      await command(["stop", "--time", String(grace), id]);
    } catch (error) {
      if (!isMissingContainer(error)) {
        options.log?.(`容器清扫 phase=TERM-failed role=${effectiveRole} name=${name}`
          + ` id=${shortId} image=${image}: ${errorDetail(error)}`);
      }
    }
    inspected = await inspect(id);
    if (inspected) {
      try {
        await command(["kill", "--signal", "KILL", id]);
      } catch (error) {
        if (!isMissingContainer(error)) {
          options.log?.(`容器清扫 phase=KILL-failed role=${effectiveRole} name=${name}`
            + ` id=${shortId} image=${image}: ${errorDetail(error)}`);
        }
      }
    }
    inspected = await inspect(id);
    if (inspected) {
      try {
        await command(["rm", "-f", id]);
      } catch (error) {
        if (!isMissingContainer(error)) throw error;
      }
    }
    if (await inspect(id)) {
      throw new Error(`容器清扫 phase=verify-remove role=${effectiveRole} name=${name}`
        + ` id=${shortId} image=${image}: 无法确认容器 ${name} 已删除`);
    }
    options.log?.(`容器清扫 phase=removed role=${effectiveRole} name=${name}`
      + ` id=${shortId} image=${image}`);
    removed.push(name);
  }
  return { found: references.length, removed };
}

/**
 * 长驻任务容器。旧的 7 参数构造方式保持兼容；第 8 参数承载加固选项，
 * 便于普通任务和预推送 Agent 共用同一个运行时。
 */
export class TaskContainer {
  private containerId = "";
  private lifecycle: Lifecycle = "idle";
  private stopPromise?: Promise<void>;
  private metadataValue?: TaskContainerMetadata | undefined;
  private readonly runner: DockerRunner;
  private readonly runtime: Required<Pick<
    TaskContainerOptions,
    "readOnlyRoot" | "network" | "stopGraceSeconds" | "managementTimeoutMs"
  >> & TaskContainerOptions;
  private readonly expectedLabels: Record<string, string>;
  private readonly baseEnvironment: Record<string, string>;
  private readonly forwardedEnvironment: Set<string>;
  private readonly activeProcesses = new Set<DockerStreamProcess>();
  private pendingExecutions = 0;
  private startupDiagnostic: { containerId?: string; phase: string } = { phase: "not-started" };
  get diagnostics() { return { ...this.startupDiagnostic }; }

  /** 当前生命周期状态(供宿主检查容器是否还在场)。 */
  get isAlive(): boolean {
    return this.lifecycle === "running";
  }

  /** 包括命令启动前后的容器检查，清理工作区时必须避让。 */
  get hasActiveProcesses(): boolean {
    return this.pendingExecutions > 0;
  }

  constructor(
    readonly image: string,
    readonly workspace: string,
    /** 容器名必须按实例+任务唯一，恢复时同名残留会先安全清掉。 */
    readonly name: string,
    private log?: (message: string) => void,
    /** 额外挂载("宿主:容器[:ro]")。 */
    private volumes: string[] = [],
    /** 不配 memory/cpus 时由部署策略决定；pids 始终有安全默认值。 */
    private limits: TaskContainerLimits = {},
    options: TaskContainerOptions = {},
  ) {
    this.runner = options.runner ?? DEFAULT_RUNNER;
    this.runtime = {
      ...options,
      readOnlyRoot: options.readOnlyRoot ?? true,
      network: options.network ?? "bridge",
      stopGraceSeconds: options.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS,
      managementTimeoutMs:
        options.managementTimeoutMs ?? DEFAULT_MANAGEMENT_TIMEOUT_MS,
    };
    this.expectedLabels = {
      ...(options.labels ?? {}),
      // 平台 ownership labels 最后写，部署参数不能覆盖这两项。
      "com.mae-flow-cloud.managed": "true",
      "com.mae-flow-cloud.container": name,
    };
    this.baseEnvironment = {
      ...containerUserEnvironment(String(options.environment?.HOME ?? TASK_CONTAINER_HOME)),
      // 精确白名单，绝不能再用 safe.directory=*。
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: resolve(workspace),
    };
    for (const [key, value] of envEntries(options.environment ?? {})) {
      validateEnvKey(key);
      if (RESERVED_ENV.has(key) && key !== "HOME") {
        throw new Error(`容器环境变量 ${key} 由平台保留，不能覆盖`);
      }
      if (value.includes("\0")) throw new Error(`容器环境变量 ${key} 含 NUL`);
      this.baseEnvironment[key] = value;
    }
    this.forwardedEnvironment = new Set(
      options.forwardEnvironment ?? DEFAULT_FORWARDED_ENV,
    );
    for (const key of this.forwardedEnvironment) {
      validateEnvKey(key);
      if (RESERVED_ENV.has(key)) {
        throw new Error(`运行时环境透传不能覆盖平台变量: ${key}`);
      }
    }
  }

  get state(): Lifecycle {
    return this.lifecycle;
  }

  get metadata(): TaskContainerMetadata | undefined {
    if (!this.metadataValue) return undefined;
    return {
      ...this.metadataValue,
      labels: { ...this.metadataValue.labels },
      repoDigests: [...this.metadataValue.repoDigests],
      environmentKeys: [...this.metadataValue.environmentKeys],
      mounts: this.metadataValue.mounts.map((mount) => ({ ...mount })),
    };
  }

  /** 起不来或 inspect 不满足隔离契约就抛，绝不降级宿主。 */
  async start(): Promise<void> {
    if (!["idle", "stopped", "failed"].includes(this.lifecycle)) {
      throw new Error(`容器 ${this.name} 当前状态 ${this.lifecycle}，不能启动`);
    }
    this.validateConfiguration();
    this.lifecycle = "starting";
    this.metadataValue = undefined;
    this.startupDiagnostic = { phase: "pre-cleanup" };
    let runAttempted = false;
    try {
      // 仅清理这个精确名字的上次残留；不存在是正常事实，daemon 不可查不是。
      await this.destroyReference(this.name);
      runAttempted = true;
      this.startupDiagnostic.phase = "docker-run";
      const id = await this.command(this.runArgs());
      if (!/^[a-f0-9]{12,64}$/i.test(id)) {
        throw new Error(`docker run 未返回有效容器 ID: ${id || "<空>"}`);
      }
      this.containerId = id;
      this.startupDiagnostic = { phase: "startup-inspect", containerId: id };
      const metadata = await this.readAndValidateMetadata(id);
      this.startupDiagnostic.phase = "user-environment";
      await this.command(["exec", id, "sh", "-lc", CONTAINER_USER_BOOTSTRAP
        + "\n" + MAE_CONTAINER_BOOTSTRAP]);
      if (this.baseEnvironment.MFC_MAE_BUILD_ROOT) await this.command(["exec", id, "sh", "-c",
        'printf "%s" "$1" > "$HOME/.mae-build-image"', "sh", metadata.immutableImageReference]);
      this.metadataValue = metadata;
      this.lifecycle = "running";
      const role = metadata.labels["com.mae-flow-cloud.role"] ?? "unknown";
      this.log?.(`容器生命周期 phase=running role=${role} name=${this.name}`
        + ` id=${metadata.containerId.slice(0, 12)}`
        + ` image=${metadata.immutableImageReference}`);
    } catch (error) {
      this.lifecycle = "failed";
      this.log?.(`容器启动失败 phase=${this.startupDiagnostic.phase} name=${this.name} id=${this.startupDiagnostic.containerId ?? "unknown"}: ${errorDetail(error)}`);
      let cleanupError: unknown;
      // 同名外部容器在预清理阶段被识别时，绝不能在 catch 里再碰它。
      // docker run 已经发出但没回 ID 时，才用精确名字查找我们带 label
      // 的半成品；ownership 校验仍然生效。
      if (this.containerId || runAttempted) {
        try {
          await this.destroyReference(this.containerId || this.name);
          this.containerId = "";
        } catch (destroyError) {
          cleanupError = destroyError;
        }
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `容器 ${this.name} 创建失败且未能确认清理: `
            + `${errorDetail(error)} | ${errorDetail(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  /** 重新读取真实 Docker 状态与镜像 digest，并复验全部加固项。 */
  async inspect(): Promise<TaskContainerMetadata> {
    if (this.lifecycle !== "running" || !this.containerId) {
      throw new Error(`容器 ${this.name} 未运行，不能 inspect`);
    }
    try {
      const metadata = await this.readAndValidateMetadata(this.containerId);
      this.metadataValue = metadata;
      return this.metadata!;
    } catch (error) {
      this.lifecycle = "failed";
      try {
        await this.destroyReference(this.containerId);
        this.containerId = "";
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `容器 ${this.name} inspect 复验失败且未能确认清理: `
            + `${errorDetail(error)} | ${errorDetail(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  /**
   * BashOperations.exec 同形。timeout 的单位与 Pi 一致：秒。
   * timeout/Abort 不是只杀本机 docker exec，而是销毁整个任务容器；
   * 当前会话要继续必须显式创建新的 TaskContainer。
   */
  async exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
      /**
       * 特例凭据环境变量:仅限宿主侧 ops 工具(build-deploy/fetch-logs)
       * 传递运维密码。不放宽 SECRET_ENV 正则也不改 forwardedEnvironment
       * 默认白名单——只放这两个精确键名,其他仍走标准透传校验。
       */
      privilegedEnv?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }> {
    this.pendingExecutions += 1;
    try {
      return await this.executeCommand(command, cwd, options);
    } finally {
      this.pendingExecutions -= 1;
    }
  }

  private async executeCommand(
    command: string,
    cwd: string,
    options: Parameters<TaskContainer["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    if (this.lifecycle !== "running" || !this.containerId) {
      // 这里发生在 assertRunning() 之前，也必须使用同一份结构化错误契约。
      // timeout/Abort 会销毁容器并把 lifecycle 置为 stopped；若仍抛普通
      // Error，prepush 只能把它交还模型，模型随后会在已死容器上无限重试。
      throw new TaskContainerUnavailableError(
        this.lifecycle === "running" ? "missing" : "stopped",
        `容器 ${this.name} 未运行（lifecycle=${this.lifecycle}），不能执行命令`,
      );
    }
    const exactCwd = resolve(cwd);
    let realCwd: string;
    try {
      realCwd = realpathSync(exactCwd);
    } catch {
      throw new Error(`任务容器工作目录不存在或不可读: ${cwd}`);
    }
    if (!inside(realpathSync(this.workspace), realCwd)) {
      throw new Error(`拒绝在任务工作区之外执行命令: ${cwd}`);
    }
    const timeoutMs = this.timeoutMs(options.timeout);
    if (options.signal?.aborted) {
      await this.stopForExecFailure("Abort");
      throw new Error("aborted");
    }
    await this.assertRunning();
    // Abort 可能恰好在异步 preflight inspect 期间到达；监听器尚未注册，
    // 必须在真正 docker exec 前再查一次，不能留下永不结束的命令。
    if (options.signal?.aborted) {
      await this.stopForExecFailure("Abort");
      throw new Error("aborted");
    }

    // 宿主侧 ops 工具的运维密码走特例通道:精确键名白名单,不放宽
    // SECRET_ENV 正则也不改 forwardedEnvironment 默认白名单。
    // (拉日志引擎已迁平台技能 fetch-logs,密码 --pwd 直传不走环境
    // 变量,ADR-0047——白名单只剩 build-deploy 的键。)
    const OPS_PRIVILEGED_KEYS = new Set([
      "BUILD_DEPLOY_PASSWORD",
    ]);
    const execEnvironment: Record<string, string> = {};
    for (const [key, value] of envEntries(options.env ?? {})) {
      if (!this.forwardedEnvironment.has(key)) continue;
      validateEnvKey(key);
      if (value.includes("\0")) throw new Error(`运行时环境变量 ${key} 含 NUL`);
      execEnvironment[key] = value;
    }
    for (const [key, value] of envEntries(options.privilegedEnv ?? {})) {
      if (!OPS_PRIVILEGED_KEYS.has(key)) {
        throw new Error(`privilegedEnv 拒绝非白名单键: ${key}`);
      }
      if (value.includes("\0")) throw new Error(`运行时环境变量 ${key} 含 NUL`);
      execEnvironment[key] = value;
    }
    const args = [
      "exec",
      "-w", exactCwd,
      ...envEntries(execEnvironment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      this.containerId,
      "sh", "-lc", withOptionalCompilerCache(MAE_EXEC_ENVIRONMENT + "\n" + command),
    ];

    let process: DockerStreamProcess;
    try {
      process = this.runner.stream(args, { onData: options.onData });
    } catch (error) {
      await this.stopForExecFailure("docker exec 无法启动", error);
      throw error;
    }
    this.activeProcesses.add(process);
    const processOutcome = process.completed.then(
      (result) => ({ kind: "completed" as const, result }),
      (error) => ({ kind: "spawn_error" as const, error }),
    );
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const interruption = new Promise<
      { kind: "abort" } | { kind: "timeout" }
    >((done) => {
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => done({ kind: "timeout" }), timeoutMs);
        timer.unref?.();
      }
      if (options.signal) {
        abortListener = () => done({ kind: "abort" });
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    const outcome = await Promise.race([processOutcome, interruption]);
    if (timer) clearTimeout(timer);
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);

    if (outcome.kind === "abort" || outcome.kind === "timeout") {
      try {
        await this.stopForExecFailure(
          outcome.kind === "abort" ? "Abort" : "timeout",
        );
      } finally {
        // 先确认容器停止，再收掉可能仍挂着的本机 CLI 客户端。
        process.kill("SIGKILL");
        this.activeProcesses.delete(process);
      }
      if (outcome.kind === "abort") throw new Error("aborted");
      throw new TaskContainerExecTimeoutError(options.timeout!);
    }

    this.activeProcesses.delete(process);
    if (outcome.kind === "spawn_error") {
      await this.stopForExecFailure("docker exec 客户端异常", outcome.error);
      throw outcome.error;
    }
    // 命令可以主动杀 PID 1；无论退出码多少都复查容器还在。若同时
    // 消失，必须报隔离基础设施故障，不能伪装成普通脚本结果。
    await this.assertRunning();
    return outcome.result;
  }

  /** TERM → KILL → rm，并最终 inspect 证明对象不存在。可重复调用。 */
  async stop(): Promise<void> {
    if ((this.lifecycle === "idle" || this.lifecycle === "stopped")
        && !this.containerId) return;
    if (this.stopPromise) return this.stopPromise;
    const target = this.containerId || this.name;
    const metadata = this.metadataValue;
    const role = this.expectedLabels["com.mae-flow-cloud.role"] ?? "unknown";
    const shortId = (this.containerId || "unknown").slice(0, 12);
    const image = metadata?.immutableImageReference ?? this.image;
    this.lifecycle = "stopping";
    this.stopPromise = (async () => {
      try {
        this.log?.(`容器回收 phase=TERM role=${role} name=${this.name}`
          + ` id=${shortId} image=${image}`);
        await this.destroyReference(target);
        this.containerId = "";
        this.lifecycle = "stopped";
        for (const process of this.activeProcesses) process.kill("SIGKILL");
        this.activeProcesses.clear();
        this.log?.(`容器回收 phase=removed role=${role} name=${this.name}`
          + ` id=${shortId} image=${image}`);
      } catch (error) {
        this.lifecycle = "failed";
        this.log?.(`容器回收 phase=failed role=${role} name=${this.name}`
          + ` id=${shortId} image=${image}: ${errorDetail(error)}`);
        throw error;
      } finally {
        this.stopPromise = undefined;
      }
    })();
    return this.stopPromise;
  }

  private validateConfiguration(): void {
    if (!this.image.trim()) throw new Error("任务容器镜像不能为空");
    if (!this.name.trim()) throw new Error("任务容器名不能为空");
    if (!isAbsolute(this.workspace) || !existsSync(this.workspace)
        || !statSync(this.workspace).isDirectory()) {
      throw new Error(`任务容器工作区必须是已存在的绝对目录: ${this.workspace}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(this.name)) {
      throw new Error(`任务容器名不合法: ${this.name}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(this.runtime.network)
        || /^(?:host|container)$/i.test(this.runtime.network)) {
      throw new Error(`任务容器网络模式不安全或不合法: ${this.runtime.network}`);
    }
    if (!Number.isInteger(this.pidsLimit()) || this.pidsLimit() <= 0) {
      throw new Error(`pidsLimit 必须是正整数: ${this.pidsLimit()}`);
    }
    if (this.limits.user !== undefined) {
      const user = this.limits.user.trim();
      if (!user || /^(?:root|0)(?::|$)/i.test(user)) {
        throw new Error("任务容器禁止使用 root/0 或空用户");
      }
    }
    if (!Number.isInteger(this.runtime.stopGraceSeconds)
        || this.runtime.stopGraceSeconds < 0
        || this.runtime.stopGraceSeconds > 60) {
      throw new Error("stopGraceSeconds 必须是 0~60 的整数");
    }
    if (!Number.isFinite(this.runtime.managementTimeoutMs)
        || this.runtime.managementTimeoutMs <= 0) {
      throw new Error("managementTimeoutMs 必须是正数");
    }
    for (const [key, value] of Object.entries(this.expectedLabels)) {
      if (!key.trim() || value.includes("\0")) {
        throw new Error(`容器 label 不合法: ${key}`);
      }
    }
    if (inside(this.baseEnvironment.HOME, resolve(this.workspace)) || inside(resolve(this.workspace), this.baseEnvironment.HOME)) throw new Error("容器 HOME 不得覆盖任务工作区");
    for (const volume of this.volumes) assertSafeVolume(volume, resolve(this.workspace), this.baseEnvironment.HOME);
  }

  private pidsLimit(): number {
    return this.limits.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  }

  private runArgs(): string[] {
    return [
      "run", "-d", "--init",
      "--name", this.name,
      "--stop-timeout", String(this.runtime.stopGraceSeconds),
      ...Object.entries(this.expectedLabels)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...(this.runtime.readOnlyRoot ? ["--read-only"] : []),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", String(this.pidsLimit()),
      "--network", this.runtime.network,
      ...(this.runtime.tmpfsHome === false ? [] : [
        "--tmpfs",
        `${this.baseEnvironment.HOME}:${this.runtime.tmpfsHome || DEFAULT_HOME_TMPFS}`,
      ]),
      ...(this.runtime.tmpfsTmp === false ? [] : [
        "--tmpfs", `/tmp:${this.runtime.tmpfsTmp || DEFAULT_TMP_TMPFS}`,
      ]),
      "-v", `${resolve(this.workspace)}:${resolve(this.workspace)}:rw`,
      ...this.volumes.flatMap((volume) => ["-v", volume]),
      ...(this.limits.memory ? ["--memory", this.limits.memory] : []),
      ...(this.limits.cpus ? ["--cpus", this.limits.cpus] : []),
      ...(this.limits.user ? ["--user", this.limits.user] : []),
      ...envEntries(this.baseEnvironment)
        .flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "-w", resolve(this.workspace),
      this.image,
      "sh", "-lc",
      "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
    ];
  }

  private timeoutMs(timeout?: number): number | undefined {
    if (timeout === undefined) return undefined;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("Invalid timeout: must be a finite number of seconds");
    }
    if (timeout > MAX_BASH_TIMEOUT_SECONDS) {
      throw new Error(`Invalid timeout: maximum is ${MAX_BASH_TIMEOUT_SECONDS} seconds`);
    }
    return timeout * 1000;
  }

  private async command(args: readonly string[]): Promise<string> {
    return this.runner.command(args, {
      timeoutMs: this.runtime.managementTimeoutMs,
    });
  }

  private async containerInspect(reference: string): Promise<ContainerInspect | undefined> {
    try {
      const raw = await this.command(["inspect", "--type", "container", reference]);
      return parseFirst<ContainerInspect>(raw, "container inspect");
    } catch (error) {
      if (isMissingContainer(error)) return undefined;
      throw error;
    }
  }

  /**
   * exec 前只需要一个 running 位，不应反复拉取包含环境和挂载的完整
   * inspect JSON。标量输出既降低旧 Docker CLI 的传输面，也让诊断日志
   * 永远不必接触可能敏感的容器元数据。
   */
  private async containerRunning(reference: string): Promise<boolean | undefined> {
    try {
      const raw = (await this.command([
        "inspect", "--type", "container",
        "--format", "{{.State.Running}}", reference,
      ])).trim().toLowerCase();
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(
        `Docker container inspect 未返回 running 标量（${Buffer.byteLength(raw)} bytes）`,
      );
    } catch (error) {
      if (isMissingContainer(error)) return undefined;
      throw error;
    }
  }

  private async assertRunning(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RUNNING_PROBE_ATTEMPTS; attempt += 1) {
      try {
        const running = await this.containerRunning(this.containerId);
        if (running === true) return;
        this.lifecycle = "failed";
        const kind = running === undefined ? "missing" : "stopped";
        throw new TaskContainerUnavailableError(
          kind,
          `任务容器 ${this.name} 已${kind === "missing" ? "丢失" : "停止"}，拒绝执行命令`,
        );
      } catch (error) {
        if (error instanceof TaskContainerUnavailableError) throw error;
        lastError = error;
        if (attempt < RUNNING_PROBE_ATTEMPTS) {
          this.log?.(
            `容器运行状态暂不可确认 name=${this.name} attempt=${attempt}`
              + `/${RUNNING_PROBE_ATTEMPTS}: ${errorDetail(error)}`,
          );
          await new Promise<void>((resolveRetry) => {
            const timer = setTimeout(
              resolveRetry,
              RUNNING_PROBE_BACKOFF_MS[attempt - 1],
            );
            timer.unref?.();
          });
        }
      }
    }
    // inspect 传输/解析失败只代表“当前不可确认”，不能把内存状态永久
    // 毒成 failed；后续由宿主熔断本轮，下一轮仍可重新探测或重建容器。
    throw new TaskContainerUnavailableError(
      "inspect_unavailable",
      `任务容器 ${this.name} 运行状态连续 ${RUNNING_PROBE_ATTEMPTS} 次无法确认`,
      { cause: lastError },
    );
  }

  /**
   * 容器启动即退出时的诊断补充:退出码 + 它自己打的最后几行。
   *
   * 纯旁路——取不到就返回空串,绝不把"拿日志失败"变成新的故障;
   * 这里已经在报错路径上,再抛一次只会盖掉真正的原因。
   */
  private async exitDiagnosis(reference: string, observed?: ContainerInspect): Promise<string> {
    const parts: string[] = [];
    try {
      const state = observed ?? await this.containerInspect(reference);
      const code = state?.State?.ExitCode;
      if (code !== undefined) parts.push(`退出码 ${code}`);
      if (state?.State?.Error) parts.push(`Docker: ${state.State.Error}`);
      if (state?.State?.OOMKilled) parts.push("OOMKilled=true");
    } catch {
      // inspect 失败不影响下面取日志。
    }
    try {
      const logs = await this.runner.command(
        ["logs", "--tail", "20", reference],
        { timeoutMs: this.runtime.managementTimeoutMs, includeStderr: true });
      const text = logs.trim();
      if (text) parts.push(`容器输出: ${text.slice(0, 2000)}`);
    } catch {
      // daemon/日志驱动不可用时保留已取得的退出状态，不覆盖原始错误。
    }
    return parts.length ? `(${parts.join("；")})` : "";
  }

  private async readAndValidateMetadata(reference: string): Promise<TaskContainerMetadata> {
    const inspected = await this.containerInspect(reference);
    if (!inspected) throw new Error(`启动后找不到任务容器 ${this.name}`);
    const id = String(inspected.Id ?? "");
    if (!id || (!id.startsWith(reference) && !reference.startsWith(id))) {
      throw new Error(`Docker inspect 返回了非目标容器: ${id || "<空>"}`);
    }
    const inspectedName = String(inspected.Name ?? "").replace(/^\//, "");
    if (inspectedName !== this.name) {
      throw new Error(`Docker inspect 返回了非目标容器名: ${inspectedName || "<空>"}`);
    }
    if (!inspected.State?.Running) {
      // 容器启动即退出时,真正的原因只在它自己的 stdout/stderr 里
      // (实测:统一构建镜像的 entrypoint 会校验缓存目录可写,不给
      // 缓存挂载就 "build environment is not writable" 退 73)。光说
      // "未处于 running" 等于让人去手工复现一遍——把日志带上来。
      const detail = await this.exitDiagnosis(id, inspected);
      throw new Error(`任务容器启动后未处于 running id=${id.slice(0, 12)}${detail}`);
    }
    const configuredUser = String(inspected.Config?.User ?? "").trim();
    if (!configuredUser || /^(?:root|0)(?::|$)/i.test(configuredUser)) {
      throw new Error("任务容器 Config.User 为空或为 root/0，拒绝运行");
    }
    const host = inspected.HostConfig ?? {};
    if (this.runtime.readOnlyRoot && host.ReadonlyRootfs !== true) {
      throw new Error("任务容器未启用 read-only root filesystem");
    }
    if (!(host.CapDrop ?? []).some((value) => value.toUpperCase() === "ALL")) {
      throw new Error("任务容器未启用 cap-drop=ALL");
    }
    if (!(host.SecurityOpt ?? []).some((value) =>
      /^no-new-privileges(?::true)?$/i.test(value))) {
      throw new Error("任务容器未启用 no-new-privileges");
    }
    if (Number(host.PidsLimit) !== this.pidsLimit()) {
      throw new Error(`任务容器 pids-limit 未生效: ${host.PidsLimit}`);
    }
    if (String(host.NetworkMode ?? "") !== this.runtime.network) {
      throw new Error(`任务容器 network 未生效: ${host.NetworkMode}`);
    }
    if (this.runtime.tmpfsHome !== false && !host.Tmpfs?.[this.baseEnvironment.HOME]) {
      throw new Error("任务容器 HOME tmpfs 未生效");
    }
    if (this.runtime.tmpfsTmp !== false && !host.Tmpfs?.["/tmp"]) {
      throw new Error("任务容器 /tmp tmpfs 未生效");
    }
    if (!(inspected.Mounts ?? []).some((mount) =>
      mount.Destination === resolve(this.workspace) && mount.RW === true)) {
      throw new Error("任务工作区没有以可写挂载进入容器");
    }
    const actualLabels = inspected.Config?.Labels ?? {};
    for (const [key, value] of Object.entries(this.expectedLabels)) {
      if (actualLabels[key] !== value) throw new Error(`任务容器 label 未生效: ${key}`);
    }
    const actualEnv = new Map((inspected.Config?.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    // 不只检查平台主动注入：内部基础镜像若误把 Token/密码烘焙进 ENV，
    // 同样必须拒绝启动。错误只报 key，绝不把 value 带进日志。
    for (const key of actualEnv.keys()) validateEnvKey(key);
    for (const [key, value] of Object.entries(this.baseEnvironment)) {
      if (actualEnv.get(key) !== value) {
        throw new Error(`任务容器环境变量未生效: ${key}`);
      }
    }

    const rawImage = await this.command([
      "image", "inspect", String(inspected.Image ?? this.image),
    ]);
    const image = parseFirst<ImageInspect>(rawImage, "image inspect");
    const imageId = String(image.Id ?? inspected.Image ?? "");
    if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
      throw new Error(`无法取得不可变镜像 ID: ${imageId || "<空>"}`);
    }
    const repoDigests = (image.RepoDigests ?? []).filter(Boolean).sort();
    const imageDigest = repoDigests[0] ?? imageId;
    return {
      containerId: id,
      name: String(inspected.Name ?? `/${this.name}`).replace(/^\//, ""),
      imageReference: String(inspected.Config?.Image ?? this.image),
      imageId,
      imageDigest,
      repoDigests,
      immutableImageReference: imageDigest,
      createdAt: inspected.Created,
      startedAt: inspected.State?.StartedAt,
      workspace: resolve(this.workspace),
      labels: { ...actualLabels },
      network: String(host.NetworkMode ?? ""),
      readOnlyRoot: host.ReadonlyRootfs === true,
      pidsLimit: Number(host.PidsLimit),
      memoryBytes: host.Memory,
      nanoCpus: host.NanoCpus,
      user: inspected.Config?.User,
      environmentKeys: [...actualEnv.keys()].sort(),
      mounts: (inspected.Mounts ?? []).map((mount) => ({
        destination: String(mount.Destination ?? ""),
        readOnly: mount.RW === false,
        type: mount.Type,
      })).sort((left, right) => left.destination.localeCompare(right.destination)),
    };
  }

  private async destroyReference(reference: string): Promise<void> {
    let inspected = await this.containerInspect(reference);
    if (!inspected) return;
    this.assertOwnedContainer(inspected);
    const name = String(inspected.Name ?? `/${this.name}`).replace(/^\//, "");
    const id = String(inspected.Id ?? reference).slice(0, 12);
    const role = inspected.Config?.Labels?.["com.mae-flow-cloud.role"]
      ?? this.expectedLabels["com.mae-flow-cloud.role"] ?? "unknown";
    const image = this.metadataValue?.immutableImageReference
      ?? String(inspected.Image ?? inspected.Config?.Image ?? this.image);
    const context = (phase: string) => `phase=${phase} role=${role} name=${name}`
      + ` id=${id} image=${image}`;
    try {
      await this.command([
        "stop", "--time", String(this.runtime.stopGraceSeconds), reference,
      ]);
    } catch (error) {
      if (!isMissingContainer(error)) {
        this.log?.(`容器回收 ${context("TERM-failed")}，继续 KILL: `
          + errorDetail(error));
      }
    }
    inspected = await this.containerInspect(reference);
    if (inspected) {
      try {
        await this.command(["kill", "--signal", "KILL", reference]);
      } catch (error) {
        if (!isMissingContainer(error)) {
          this.log?.(`容器回收 ${context("KILL-failed")}，继续删除: `
            + errorDetail(error));
        }
      }
    }
    inspected = await this.containerInspect(reference);
    if (inspected) {
      try {
        await this.command(["rm", "-f", reference]);
      } catch (error) {
        if (!isMissingContainer(error)) throw error;
      }
    }
    if (await this.containerInspect(reference)) {
      throw new Error(`容器回收 ${context("verify-remove")}: `
        + `无法确认容器 ${name} 已删除`);
    }
  }

  private assertOwnedContainer(inspected: ContainerInspect): void {
    const actualName = String(inspected.Name ?? "").replace(/^\//, "");
    const labels = inspected.Config?.Labels ?? {};
    const ownershipKeys = [
      "com.mae-flow-cloud.instance",
      "com.mae-flow-cloud.role",
      "com.mae-flow-cloud.task",
    ];
    const ownershipMatches = ownershipKeys.every((key) =>
      this.expectedLabels[key] === undefined
        || labels[key] === this.expectedLabels[key]);
    if (actualName !== this.name
        || labels["com.mae-flow-cloud.managed"] !== "true"
        || labels["com.mae-flow-cloud.container"] !== this.name
        || !ownershipMatches) {
      throw new Error(
        `发现同名但不属于本任务的容器 ${actualName || "<未知>"}，拒绝清理`,
      );
    }
  }

  private async stopForExecFailure(reason: string, cause?: unknown): Promise<void> {
    try {
      await this.stop();
    } catch (cleanupError) {
      throw new AggregateError(
        cause === undefined ? [cleanupError] : [cause, cleanupError],
        `${reason} 后未能确认任务容器已销毁: `
          + `${cause === undefined ? "" : `${errorDetail(cause)} | `}`
          + errorDetail(cleanupError),
      );
    }
  }
}

/** docker daemon 活着才算可用，只装 CLI 不算。 */
export async function dockerAvailable(runner: DockerRunner = DEFAULT_RUNNER): Promise<boolean> {
  try {
    await runner.command(["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
