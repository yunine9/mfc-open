/** Trusted Cloud adapter for Mae-Flow's continuous-review delivery commands. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { probeKernelCapabilities } from "./kernelCapabilities.ts";
import { createSafeGitView } from "./safeGit.ts";

export interface KernelDeliveryHost {
  kernelRoot: string;
  python?: string;
}

export interface KernelFeedbackItem {
  id: string;
  source: string;
  source_id: string;
  source_revision: number;
  kind: string;
  summary: string;
  material?: string;
  verification: string;
  file?: string;
  line?: number;
}

export interface KernelFeedbackBatch {
  schema: "mae-flow-feedback-batch/1";
  batch_id: string;
  task_id: string;
  base_sha: string;
  opened_at: string;
  items: KernelFeedbackItem[];
}

export interface KernelDeliveryRecord {
  schema: "mae-flow-delivery-loop/1";
  idempotent: boolean;
  current?: string;
  batch_id?: string;
  migration_id?: string;
  status?: string;
  event_id?: string;
  sha?: string;
  local_head?: string;
  unpushed_local_commits?: string[];
  unpushed_local_paths?: string[];
}

export interface KernelFeedbackResultItem {
  id: string;
  status: "fixed" | "explained" | "needs_human" | "not_applicable";
  summary: string;
  evidence?: string;
}

export class KernelDeliveryError extends Error {}

/** 内核**根本没答**(起不来、超时、被信号打死,预算内重试用尽)。与
 * "内核答了不"(KernelDeliveryError)必须分开:前者是基础设施故障,
 * 调用方按挂起+带预算重试处理;后者是裁决,一次都不重试。 */
export class KernelUnavailableError extends KernelDeliveryError {}

/** 所有"内核暂时不可用"的原因文案都以它开头;taskService 靠这个前缀
 * 区分"该自愈重试"与"该停下叫人"。 */
export const KERNEL_UNAVAILABLE = "内核暂时不可用";

export interface KernelHostAuthority {
  schema: "mae-flow-host-authority/1";
  alg: "RS256";
  key_id: string;
  task_id: string;
  n: string;
  e: string;
}

interface StoredKernelHostCapability {
  schema: "mae-flow-host-capability/1";
  authority: KernelHostAuthority;
  private_key: string;
}

interface StoredKernelHostBinding {
  schema: "mae-flow-host-binding/1";
  task_id: string;
  workspace: string;
  cwd: string;
  continuous_review: true;
}

export type KernelHostAction = "feedback-open" | "feedback-result" | "close"
  | "pipeline-record" | "intervention-reconcile" | "selection-reconcile" | "ticket-correction";

/**
 * 与内核 `_canonical`(json.dumps sort_keys、无空格、不转义 UTF-8)逐字节
 * 同形——凭据签的是它的摘要,内核拿事实文件重算,差一个字节就是
 * "载荷摘要不匹配"。
 *
 * 2026-09-02 实测踩坑:值为 undefined 的键原来会被拼成 `"evidence":undefined`,
 * 而事实文件是 JSON.stringify 写的、根本没有这个键。于是**凡是没带
 * evidence 的逐条回执**(流水线告警、工作台批注不填证据是常态)内核一律
 * 拒收,Agent 被叫回来"补回执"再拒一次,最后 halted 停摆——整个"修流水线
 * 告警"来源在生产里走不通。这里按 JSON.stringify 的语义办:对象里
 * undefined 的键不存在,数组里的 undefined 是 null。
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item === undefined ? null : item))
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function capabilityRoot(workspace: string): string {
  const realWorkspace = realpathSync(workspace);
  const root = join(dirname(realWorkspace), ".host-capabilities");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()
      || realpathSync(root) !== root) {
    throw new KernelDeliveryError("持续检视宿主信任根不是可信普通目录");
  }
  if ((info.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new KernelDeliveryError("持续检视宿主信任根权限或属主异常");
  }
  return root;
}

function capabilityPath(workspace: string, taskId: string): string {
  const safeTask = createHash("sha256").update(taskId).digest("hex");
  return join(capabilityRoot(workspace), `${safeTask}.json`);
}

function bindingPath(workspace: string, cwd: string): string {
  const realCwd = realpathSync(cwd);
  const safeCwd = createHash("sha256").update(realCwd).digest("hex");
  return join(capabilityRoot(workspace), `binding-${safeCwd}.json`);
}

function ensureKernelHostBinding(input: {
  workspace: string;
  cwd: string;
  taskId: string;
}): void {
  const binding: StoredKernelHostBinding = {
    schema: "mae-flow-host-binding/1",
    task_id: input.taskId,
    workspace: realpathSync(input.workspace),
    cwd: realpathSync(input.cwd),
    continuous_review: true,
  };
  const path = bindingPath(input.workspace, input.cwd);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()
        || realpathSync(path) !== path || (info.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new KernelDeliveryError("持续检视宿主任务绑定不是可信普通文件");
    }
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(path, "utf-8")); } catch { /* below */ }
    if (canonical(stored) !== canonical(binding)) {
      throw new KernelDeliveryError("持续检视宿主任务绑定与当前工作区不一致");
    }
    return;
  }
  writeFileSync(path, JSON.stringify(binding) + "\n", {
    encoding: "utf-8", mode: 0o600, flag: "wx",
  });
}

/**
 * Agent 工作区里的 execution_contract 只能用于展示，不能决定是否启用
 * Cloud 宿主保护。能力文件位于任务目录之外；只要它存在，这张任务就
 * 必须继续按持续检视契约 fail-closed，哪怕状态文件被删字段或改成
 * false。文件损坏会在后续验签时报错，绝不能被当成“旧任务”降级。
 */
export function kernelHostCapabilityPresent(input: {
  workspace: string;
  taskId: string;
  cwd: string;
}): boolean {
  const paths = [
    capabilityPath(input.workspace, input.taskId),
    bindingPath(input.workspace, input.cwd),
  ];
  try {
    paths.forEach((path) => lstatSync(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateStoredCapability(
  stored: StoredKernelHostCapability,
  taskId: string,
): void {
  const authority = stored.authority;
  if (stored.schema !== "mae-flow-host-capability/1"
      || authority?.schema !== "mae-flow-host-authority/1"
      || authority.alg !== "RS256"
      || authority.task_id !== taskId
      || !stored.private_key) {
    throw new KernelDeliveryError("持续检视宿主凭据损坏，拒绝执行内核命令");
  }
  const modulus = Buffer.from(authority.n, "base64url");
  const exponent = Buffer.from(authority.e, "base64url");
  const exponentValue = exponent.reduce((value, byte) => value * 256 + byte, 0);
  const keyId = createHash("sha256").update(`${authority.n}.${authority.e}`)
    .digest("hex").slice(0, 24);
  let derived: { n?: string; e?: string };
  try {
    derived = createPublicKey(createPrivateKey(stored.private_key))
      .export({ format: "jwk" });
  } catch {
    throw new KernelDeliveryError("持续检视宿主私钥无法解析，拒绝执行内核命令");
  }
  if (modulus.length < 256 || exponentValue !== 65537
      || authority.key_id !== keyId
      || derived.n !== authority.n || derived.e !== authority.e) {
    throw new KernelDeliveryError("持续检视宿主公私钥不匹配或强度不足");
  }
}

/**
 * The private signing key lives beside task workspaces, never inside the
 * Agent-visible workspace.  The public half is pinned into the kernel state.
 */
export function ensureKernelHostCapability(input: {
  workspace: string;
  taskId: string;
  cwd?: string;
}): KernelHostAuthority {
  const path = capabilityPath(input.workspace, input.taskId);
  if (input.cwd) ensureKernelHostBinding({ ...input, cwd: input.cwd });
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()
        || realpathSync(path) !== path
        || (info.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new KernelDeliveryError("持续检视宿主凭据不是普通文件，拒绝读取");
    }
    let stored: StoredKernelHostCapability;
    try {
      stored = JSON.parse(readFileSync(path, "utf-8")) as
        StoredKernelHostCapability;
    } catch {
      throw new KernelDeliveryError("持续检视宿主凭据损坏，拒绝执行内核命令");
    }
    validateStoredCapability(stored, input.taskId);
    return stored.authority;
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) {
    throw new KernelDeliveryError("无法生成持续检视宿主公钥");
  }
  const authority: KernelHostAuthority = {
    schema: "mae-flow-host-authority/1",
    alg: "RS256",
    key_id: createHash("sha256").update(`${jwk.n}.${jwk.e}`)
      .digest("hex").slice(0, 24),
    task_id: input.taskId,
    n: jwk.n,
    e: jwk.e,
  };
  const stored: StoredKernelHostCapability = {
    schema: "mae-flow-host-capability/1",
    authority,
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  try {
    writeFileSync(path, JSON.stringify(stored) + "\n", {
      encoding: "utf-8", mode: 0o600, flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return ensureKernelHostCapability(input);
  }
  return authority;
}

/** Pin the public authority before the Agent can observe a managed state. */
export function pinKernelHostAuthority(input: {
  cwd: string;
  workspace: string;
  taskId: string;
}): KernelHostAuthority {
  const authority = ensureKernelHostCapability(input);
  const statePath = join(input.cwd, ".mae-flow.json");
  if (!existsSync(statePath)) return authority;
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, any>;
  const contract = state.execution_contract;
  if (!contract || contract.host !== "cloud") {
    throw new KernelDeliveryError("只有 Cloud 执行契约可以固定持续检视宿主公钥");
  }
  const pinned = contract.host_authority as KernelHostAuthority | undefined;
  if (pinned) {
    if (canonical(pinned) !== canonical(authority)) {
      throw new KernelDeliveryError("内核状态绑定了另一把宿主公钥，拒绝替换");
    }
    return authority;
  }
  contract.host_authority = authority;
  const temporary = `${statePath}.host-authority-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf-8", mode: 0o600, flag: "wx",
  });
  renameSync(temporary, statePath);
  return authority;
}

function factsPath(workspace: string, label: string, payload: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  const dir = join(workspace, "kernel-delivery");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${label}-${digest}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function createKernelHostProof(input: {
  cwd: string;
  workspace: string;
  taskId: string;
  action: KernelHostAction;
  payload: unknown;
}): { path: string; cleanup(): void } {
  const authority = pinKernelHostAuthority(input);
  const storedPath = capabilityPath(input.workspace, input.taskId);
  const stored = JSON.parse(readFileSync(storedPath, "utf-8")) as
    StoredKernelHostCapability;
  validateStoredCapability(stored, input.taskId);
  if (canonical(stored.authority) !== canonical(authority)) {
    throw new KernelDeliveryError("持续检视宿主私钥与内核公钥不匹配");
  }
  const proof = {
    schema: "mae-flow-host-proof/1",
    task_id: input.taskId,
    action: input.action,
    payload_digest: createHash("sha256").update(canonical(input.payload))
      .digest("hex"),
    nonce: randomUUID(),
    issued_at: Math.floor(Date.now() / 1000),
  };
  const signature = sign("RSA-SHA256", Buffer.from(canonical(proof)), {
    key: stored.private_key,
  }).toString("base64url");
  const path = join(dirname(storedPath), `proof-${proof.nonce}.json`);
  writeFileSync(path, JSON.stringify({ ...proof, signature }) + "\n", {
    encoding: "utf-8", mode: 0o600, flag: "wx",
  });
  return { path, cleanup: () => rmSync(path, { force: true }) };
}

/**
 * 让内核按当前阶段词表重写一次看板与脉冲(`mae-flow.py panel`)。
 *
 * 用途只有一个:阶段词表升级前留下的老任务,脉冲里的阶段名不在当前词表里,
 * Cloud 画不了轨道;跑一次 panel 就自愈,不用等下一个 Hook 事件。纯旁路:
 * 异步、30 秒预算、失败只返回 false,绝不影响任务。
 */
export function refreshKernelPanel(input: {
  host: KernelDeliveryHost;
  cwd: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const gitView = createSafeGitView(input.cwd);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gitView.cleanup();
      resolve(ok);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        input.host.python ?? "python3",
        [join(input.host.kernelRoot, "scripts", "mae-flow.py"), "panel"],
        { cwd: input.cwd, env: gitView.environment(), stdio: "ignore" },
      );
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 30_000);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/** 与 KernelHost.INFRA_ATTEMPTS 同一口径:基础设施故障先带预算重试。 */
const INFRA_ATTEMPTS = 3;

/** spawnSync 是同步的,退避只能同步等;Atomics.wait 不烧 CPU。 */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 内核**答了**(退 0 或明确拒收)就是它的裁决,一次都不重试;只有起不来、
 * 超时、被信号打死这类基础设施故障才重试。
 *
 * 为什么必须有这一层:delivery 命令原来一次 spawnSync 完事,所有失败一律
 * throw,而调用方(pipeline 红灯、冲突、Build-Fix、push 返工)全是
 * catch → markVerificationStalled。持续检视本来就是"反馈不断进环、直到
 * 合入"的长跑,一次 30 秒抖动就把整条环停下来找人,和"Agent 不能因
 * harness 卡死"是同一个红线;KernelHost 对 dispatch 早已是三次预算重试,
 * 这里不该是例外。
 *
 * 每次重试**换新凭据**:上一次若是内核落盘之后才超时,旧 nonce 已被消费,
 * 原样重放会被判"拒绝重放";命令本身按 batch_id / 结果摘要 / event_id
 * 幂等,拿新凭据走幂等路径才是正确结局。
 */
function spawnKernelDelivery(input: {
  host: KernelDeliveryHost;
  cwd: string;
  stdin?: string;
  /** 每次尝试重新准备参数——凭据是一次性 nonce,重试必须换新。 */
  attempt: () => { args: string[]; cleanup(): void };
}): { status: number; stdout: string; stderr: string } {
  let infraFailure = "";
  for (let attempt = 1; attempt <= INFRA_ATTEMPTS; attempt += 1) {
    if (attempt > 1) pauseSync(200 * (attempt - 1));
    const prepared = input.attempt();
    const gitView = createSafeGitView(input.cwd);
    try {
      const result = spawnSync(
        input.host.python ?? "python3",
        [join(input.host.kernelRoot, "scripts", "mae-flow.py"),
         "delivery", ...prepared.args],
        {
          cwd: input.cwd,
          encoding: "utf-8",
          env: gitView.environment(),
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
          ...(input.stdin === undefined ? {} : { input: input.stdin }),
        },
      );
      if (result.error || result.status === null) {
        infraFailure = result.error?.message
          ?? `内核进程被信号 ${String(result.signal ?? "?")} 终止`;
        continue;
      }
      return {
        status: result.status,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
      };
    } finally {
      gitView.cleanup();
      prepared.cleanup();
    }
  }
  throw new KernelUnavailableError(
    `${KERNEL_UNAVAILABLE}：${infraFailure}`
    + `（基础设施故障，已重试 ${INFRA_ATTEMPTS} 次仍不可用）`);
}

function lastJsonLine(stdout: string): Record<string, any> | undefined {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : undefined;
  } catch { return undefined; }
}

function invoke(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  action: KernelHostAction;
  payload: unknown;
  args: string[];
}): KernelDeliveryRecord {
  const result = spawnKernelDelivery({
    host: input.host,
    cwd: input.cwd,
    attempt: () => {
      const proof = createKernelHostProof(input);
      return {
        args: [...input.args, "--host-proof", proof.path],
        cleanup: () => proof.cleanup(),
      };
    },
  });
  const record = lastJsonLine(result.stdout) as KernelDeliveryRecord | undefined;
  if (result.status !== 0 || record?.schema !== "mae-flow-delivery-loop/1") {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new KernelDeliveryError(
      `内核持续检视命令失败：\n${detail || "没有返回结构化结果"}`);
  }
  return record;
}

/**
 * 问内核:这份状态有没有真实宿主收据背书?Cloud 只问,不判。
 *
 * 这里原来是一份 TypeScript 镜像——收据归属前缀、签名校验、投影形状、
 * 活动批次摘要,逐字段抄自内核 host_receipts.py。2026-09-02 内核一改投影
 * 契约(/1→/2),镜像没跟上,三个 fail-closed 门当场恒假、整条持续检视
 * 链静默锁死。"本仓一行判定逻辑都不复刻"不是口号:两份实现迟早再分叉。
 * 现在裁决只在内核 `delivery attest`,Cloud 侧再没有一行可以和它不一致
 * 的逻辑。
 *
 * 快照走 stdin:核对的必须是调用方**刚读到的那份**状态,而不是内核此刻
 * 再读一次的现场——两次读之间 Agent 可以改文件。
 *
 * 只有结构化核验结果中的 false 才表示无收据背书。读盘失败、命令失败
 * 和输出损坏是核验不可用，交给已有恢复机制，不冒充否定裁决。
 */
export function attestKernelHost(input: {
  host: KernelDeliveryHost;
  cwd: string;
  state?: Record<string, any>;
  lifecycle?: KernelHostAction[];
  activeBatch?: KernelHostAction[];
  feedbackLoop?: boolean;
}): { lifecycle: boolean; activeBatch: boolean; feedbackLoop: boolean } {
  let state: Record<string, any>;
  try {
    state = input.state ?? JSON.parse(readFileSync(
      join(input.cwd, ".mae-flow.json"), "utf-8"));
  } catch (error) {
    throw new KernelUnavailableError(`${KERNEL_UNAVAILABLE}：无法读取核验状态：${String(error)}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new KernelUnavailableError(`${KERNEL_UNAVAILABLE}：核验状态格式损坏`);
  }
  // Transport only receipt inputs; hashing, signatures and decisions stay in Python.
  // Keep the complete loop: old batches are part of the signed lifecycle.
  const snapshot = {
    current: state.current,
    delivery_loop: state.delivery_loop,
    quality: { external_verification: state.quality?.external_verification },
    user_intervention: state.user_intervention,
    host_capability_nonces: state.host_capability_nonces,
  };
  const args = ["attest", "--snapshot-stdin"];
  if (input.feedbackLoop) args.push("--feedback-loop");
  if (input.lifecycle?.length) args.push("--lifecycle", input.lifecycle.join(","));
  if (input.activeBatch?.length) {
    args.push("--active-batch", input.activeBatch.join(","));
  }
  const result = spawnKernelDelivery({
    host: input.host,
    cwd: input.cwd,
    stdin: JSON.stringify(snapshot),
    attempt: () => ({ args, cleanup: () => {} }),
  });
  const record = lastJsonLine(result.stdout);
  if (result.status !== 0 || record?.schema !== "mae-flow-host-attest/1"
      || (input.lifecycle?.length && typeof record.lifecycle !== "boolean")
      || (input.activeBatch?.length && typeof record.active_batch !== "boolean")
      || (input.feedbackLoop && typeof record.feedback_loop !== "boolean")) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new KernelUnavailableError(
      `${KERNEL_UNAVAILABLE}：收据核验未完成：${detail || "没有有效的结构化结果"}`);
  }
  return {
    lifecycle: record.lifecycle === true,
    activeBatch: record.active_batch === true,
    feedbackLoop: record.feedback_loop === true,
  };
}

function hasKernelErrorCode(error: unknown, expected: string): boolean {
  if (!(error instanceof KernelDeliveryError)) return false;
  for (const line of error.message.split(/\r?\n/)) {
    if (!line.startsWith("[mae-flow:error] ")) continue;
    try {
      const record = JSON.parse(line.slice("[mae-flow:error] ".length));
      if (record?.schema === "mae-flow-error/1" && record.code === expected) {
        return true;
      }
    } catch { /* malformed diagnostic is not a retry signal */ }
  }
  return false;
}

/**
 * A merged event can race the last in-flight pipeline record after Cloud has
 * stopped the Agent writer. Delivery commands are idempotent, so retry only
 * the kernel's exact optimistic-lock conflict with a fresh state read/proof.
 * Every other failure remains fail-closed.
 */
function invokeAfterRevisionConflict(input: Parameters<typeof invoke>[0]):
    KernelDeliveryRecord {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return invoke(input);
    } catch (error) {
      lastError = error;
      if (!hasKernelErrorCode(error, "FLOW_REVISION_CONFLICT")) throw error;
    }
  }
  throw lastError;
}

/** 整份生命周期(current、活动批次、流水线事实、接管记录)必须与某张
 * 真实宿主收据精确一致——只用于宣布 ready/completed。 */
export function trustedKernelHostLifecycle(input: {
  host: KernelDeliveryHost;
  cwd: string;
  actions: KernelHostAction[];
  state?: Record<string, any>;
}): boolean {
  return attestKernelHost({
    host: input.host,
    cwd: input.cwd,
    state: input.state,
    lifecycle: input.actions,
  }).lifecycle;
}

/** 反馈读取、结果收口和索引恢复只消费反馈事实，不依赖工作步骤或流水线状态。 */
export function trustedKernelHostFeedback(input: {
  host: KernelDeliveryHost;
  cwd: string;
  state?: Record<string, any>;
}): boolean {
  return attestKernelHost({ ...input, feedbackLoop: true }).feedbackLoop;
}

/**
 * Agent 修复期间可以通过正常内核命令移动 current，但活动 writer 与批次
 * 内容必须和某张真实宿主收据完全一致。用于回收处理结果，不用于宣布
 * ready/completed；后两者仍要求整份生命周期精确匹配。
 */
export function trustedKernelHostActiveBatch(input: {
  host: KernelDeliveryHost;
  cwd: string;
  actions: KernelHostAction[];
  state?: Record<string, any>;
}): boolean {
  return attestKernelHost({
    host: input.host,
    cwd: input.cwd,
    state: input.state,
    activeBatch: input.actions,
  }).activeBatch;
}

export function openKernelFeedback(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  batch: KernelFeedbackBatch;
}): KernelDeliveryRecord {
  const path = factsPath(input.workspace, "feedback-open", input.batch);
  return invoke({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.batch.task_id, action: "feedback-open", payload: input.batch,
    args: ["feedback-open", "--file", path],
  });
}

export function adoptKernelDeliveryWatch(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  migrationId: string;
  taskId: string;
}): KernelDeliveryRecord {
  const payload = {
    schema: "mae-flow-feedback-batch/1",
    mode: "adopt-watch",
    batch_id: input.migrationId,
  };
  const path = factsPath(input.workspace, "adopt-watch", payload);
  return invoke({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId, action: "feedback-open", payload,
    args: ["feedback-open", "--file", path],
  });
}

/** Owner-directed scheduling uses the existing signed feedback writer. */
export function controlKernelFeedback(input: {
  host: KernelDeliveryHost; cwd: string; workspace: string; taskId: string;
  operationId: string; target: string; actor: string; requestId: string;
  reason: string; feedbackId?: string;
}): KernelDeliveryRecord {
  const capability = probeKernelCapabilities({ kernelRoot: input.host.kernelRoot, python: input.host.python, cwd: input.cwd });
  if (!capability.agent_host_control) throw new KernelDeliveryError("当前内核版本尚不支持 Agent 目标调整，请同步部署 Cloud 配套内核；未改变原目标");
  const payload = { schema: "mae-flow-feedback-batch/1", mode: "control",
    operation_id: input.operationId, target: input.target, actor: input.actor,
    request_id: input.requestId, reason: input.reason, feedback_id: input.feedbackId ?? "" };
  const path = factsPath(input.workspace, "feedback-control", payload);
  return invokeAfterRevisionConflict({ host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId, action: "feedback-open", payload,
    args: ["feedback-open", "--file", path] });
}

/** 真实远端收据只撤出旧 CI 调度，不登记任何质量通过或人工闭环。 */
export function recordKernelPublishedPush(input: {
  host: KernelDeliveryHost; cwd: string; workspace: string; taskId: string;
  receipt: { sha: string; ref: string; remote: string };
}): KernelDeliveryRecord {
  const payload = { schema: "mae-flow-feedback-batch/1", mode: "published", receipt: input.receipt };
  const path = factsPath(input.workspace, "feedback-published", payload);
  return invokeAfterRevisionConflict({ ...input, action: "feedback-open", payload,
    args: ["feedback-open", "--file", path] });
}

export function recordKernelFeedbackResult(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  batchId: string;
  changed: boolean;
  results: KernelFeedbackResultItem[];
}): KernelDeliveryRecord {
  const payload = {
    schema: "mae-flow-feedback-result/1",
    batch_id: input.batchId,
    changed: input.changed,
    results: input.results,
  };
  const path = factsPath(input.workspace, "feedback-result", payload);
  return invoke({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId,
    action: "feedback-result", payload,
    args: ["feedback-result", "--file", path],
  });
}

export function correctKernelTicket(input: {
  host: KernelDeliveryHost; cwd: string; workspace: string; taskId: string;
  correction: Record<string, unknown>;
}): KernelDeliveryRecord {
  const payload = { ...input.correction, schema: "mae-flow-ticket-correction/1" };
  const path = factsPath(input.workspace, "ticket-correction", payload);
  return invokeAfterRevisionConflict({ ...input, action: "ticket-correction", payload,
    args: ["ticket-correction", "--file", path] });
}

export function closeKernelDelivery(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  sha: string;
  eventId: string;
}): KernelDeliveryRecord {
  const payload = { reason: "merged", sha: input.sha, event_id: input.eventId };
  return invokeAfterRevisionConflict({
    host: input.host, cwd: input.cwd, workspace: input.workspace,
    taskId: input.taskId, action: "close", payload,
    args: ["close", "--reason", "merged", "--sha", input.sha,
      "--event-id", input.eventId],
  });
}
