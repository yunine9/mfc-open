/**
 * Developer-assistant/core hand-off contract.
 *
 * The assistant remains a Cloud sidecar: it never receives KernelHost hooks.
 * This module only answers two mechanical questions at the boundary:
 *
 * 1. Where was Mae-Flow when the user deliberately took over the workspace?
 * 2. What changed in the worktree while the main session was paused?
 *
 * The step is context, not permission: user intervention can override normal
 * edit windows. This module never invents transitions or marks evidence PASS.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runSafeWorktreeGit } from "./safeGit.ts";
import {
  AGENT_PLATFORM_PATHSPECS,
  AGENT_PLATFORM_ROOTS,
} from "./agentPlatformPaths.ts";

export type DeveloperAssistantAvailabilityCode =
  | "edit_window"
  | "user_override"
  | "approval_pending"
  | "host_wait"
  | "not_editable"
  | "core_unavailable"
  | "session_only";

export interface DeveloperAssistantCoreCheckpoint {
  step: string;
  title?: string;
  revision?: number;
}

export interface DeveloperAssistantAvailability {
  available: boolean;
  code: DeveloperAssistantAvailabilityCode;
  mode: "edit" | "unavailable";
  reason: string;
  core?: DeveloperAssistantCoreCheckpoint;
}

export interface DeveloperAssistantWorktreeCheckpoint {
  sha: string;
  fingerprint: string;
  paths: string[];
  path_fingerprints: Record<string, string>;
  paths_truncated?: boolean;
  derived_only?: boolean;
}

export interface DeveloperAssistantHandoff {
  /** `blocked` is retained only for reading snapshots written by older versions. */
  state: "running" | "unchanged" | "changed" | "returned" | "blocked";
  /** Stable retry identity; it is not a code/content gate. */
  id?: string;
  started_at: string;
  finished_at?: string;
  returned_at?: string;
  core?: DeveloperAssistantCoreCheckpoint;
  initial: DeveloperAssistantWorktreeCheckpoint;
  current?: DeveloperAssistantWorktreeCheckpoint;
  changed_paths?: string[];
  paths_truncated?: boolean;
  derived_only?: boolean;
  message: string;
}

export interface DeveloperAssistantChangedPathSummary {
  paths: string[];
  total: number;
  truncated: boolean;
  derivedOnly: boolean;
}

const GENERATED_SEGMENTS = new Set([
  ".git", ".gradle", ".m2", ".cache", "node_modules", "coverage",
  ".mae-flow-work", ...AGENT_PLATFORM_ROOTS,
]);
const GENERATED_OUTPUT = /\.(?:class|o|obj|so|dylib|dll|a|lib|jar|war|ear|pyc|pyo|exe|pdb|d)$/i;
const CODE_PATH = /\.(?:[cm]?[jt]sx?|java|kt|kts|groovy|c|cc|cpp|cxx|h|hh|hpp|hxx|py|go|rs|cs|swift|scala|rb|php|sh|bash|zsh|sql|proto)$/i;
const TEST_PATH = /(^|\/)(?:tests?|__tests__)(\/|$)|(?:^|[._-])(?:test|spec)s?\.[^/]+$/i;
const BUILD_PATH = /(^|\/)(?:pom\.xml|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|CMakeLists\.txt|Makefile|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/i;
const DOC_PATH = /(^|\/)docs?\/|\.(?:md|mdx|rst|adoc|txt)$/i;

function pathPriority(path: string): number {
  if (TEST_PATH.test(path) || CODE_PATH.test(path)) return 0;
  if (BUILD_PATH.test(path)) return 1;
  if (DOC_PATH.test(path)) return 2;
  return 3;
}

function knownGenerated(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((segment) => GENERATED_SEGMENTS.has(segment))) return true;
  return parts.some((segment) => ["target", "build", "dist", "out"]
    .includes(segment)) && GENERATED_OUTPUT.test(path);
}

/** Bound diagnostic paths so build output can never make hand-off impossible. */
export function summarizeDeveloperAssistantChangedPaths(
  values: string[],
  limit = 160,
): DeveloperAssistantChangedPathSummary {
  const unique = [...new Set(values.map((value) => value.replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "").trim()).filter((value) => value
      && !value.startsWith("/") && value !== ".." && !value.startsWith("../")
      && !value.includes("/../")))];
  const useful = unique.filter((path) => !knownGenerated(path));
  useful.sort((left, right) => pathPriority(left) - pathPriority(right)
    || left.localeCompare(right));
  const paths = useful.slice(0, Math.max(1, limit))
    .map((path) => path.slice(0, 500));
  return {
    paths,
    total: unique.length,
    truncated: useful.length > paths.length,
    derivedOnly: unique.length > 0 && useful.length === 0,
  };
}

const CONTROL_PATHSPECS = [
  ":(exclude).mae-flow.json",
  ":(exclude).mae-flow.json.*",
  ":(exclude).mae-flow-*",
  ":(exclude).mae-flow-work",
  ":(exclude).mae-flow-work/**",
  ":(exclude).codecheckcli",
  ":(exclude).codecheckcli/**",
  ...AGENT_PLATFORM_PATHSPECS,
] as const;

function readNoFollowJson(path: string): Record<string, unknown> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(readFileSync(descriptor, "utf-8")) as Record<string, unknown>;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function coreCheckpoint(
  state: Record<string, unknown>,
  step: string,
  title?: string,
): DeveloperAssistantCoreCheckpoint {
  const revision = Number(state.revision);
  return {
    step,
    ...(title ? { title } : {}),
    ...(Number.isFinite(revision) ? { revision } : {}),
  };
}

/** Read-only compatibility check. Missing host means a scripted/session-only task. */
export function inspectDeveloperAssistantAvailability(
  cwd: string | undefined,
  kernelRoot: string | undefined,
): DeveloperAssistantAvailability {
  if (!kernelRoot) {
    return {
      available: true,
      code: "session_only",
      mode: "edit",
      reason: "当前任务不使用 Mae-Flow 内核，可直接处理代码现场",
    };
  }
  if (!cwd) {
    return {
      available: false,
      code: "core_unavailable",
      mode: "unavailable",
      reason: "代码现场尚未就绪，暂不能启动开发助手",
    };
  }
  try {
    const statePath = join(cwd, ".mae-flow.json");
    if (!existsSync(statePath)) throw new Error("流程尚未初始化");
    const state = readNoFollowJson(statePath);
    const stepId = String(state.current ?? "").trim();
    if (!stepId) throw new Error("内核没有给出当前步骤");
    const flow = JSON.parse(readFileSync(
      join(kernelRoot, "flow", "flow.json"), "utf-8")) as {
        steps?: Record<string, Record<string, unknown>>;
      };
    const step = flow.steps?.[stepId];
    if (!step) throw new Error(`内核步骤 ${stepId} 不在流程定义中`);
    const title = String(step.title ?? "").trim() || undefined;
    const core = coreCheckpoint(state, stepId, title);
    if (step.allow_source_edit === true
        && !step.user_ack && !step.approval_subject && !step.host_wait) {
      return {
        available: true,
        code: "edit_window",
        mode: "edit",
        core,
        reason: `当前「${title ?? stepId}」允许修改源码，助手完成后会把现场交还主任务`,
      };
    }
    return {
      available: true,
      code: "user_override",
      mode: "edit",
      core,
      reason: `当前主流程位于「${title ?? stepId}」；这是用户主动接管的旁路助手，可直接处理代码，交还后主任务会重新读取现场`,
    };
  } catch (error) {
    return {
      available: true,
      code: "user_override",
      mode: "edit",
      reason: `内核位置暂时不可读，但不阻止用户接管代码现场；交还后主任务会重新读取：${String(error)}`,
    };
  }
}

function gitOutput(cwd: string, args: string[], label: string): string {
  // 同步调用必须有上限(2026-08-25 卡死事故的纪律):接管/交还是人在
  // 页面上点出来的请求路径,大仓 status/diff 无界同步跑就是整站冻结。
  const result = runSafeWorktreeGit(cwd, args, { timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(`${label}失败：${String(result.stderr ?? "").trim()}`);
  }
  return String(result.stdout ?? "");
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

function fingerprintPath(
  root: string,
  relativePath: string,
  readBudget: { remaining: number },
): string {
  const absolute = resolve(root, relativePath);
  if (!contained(root, absolute) || !existsSync(absolute)) return "missing";
  const info = lstatSync(absolute);
  const hash = createHash("sha256")
    .update(String(info.mode)).update("\0").update(String(info.size)).update("\0")
    .update(String(info.mtimeMs)).update("\0");
  if (info.isSymbolicLink()) {
    return hash.update("symlink\0").update(readlinkSync(absolute)).digest("hex");
  }
  if (!info.isFile()) return hash.update("other").digest("hex");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const allowance = Math.min(64 * 1024, readBudget.remaining, info.size);
    if (allowance > 0) {
      const firstSize = info.size > allowance ? Math.ceil(allowance / 2) : allowance;
      const first = Buffer.allocUnsafe(firstSize);
      const firstRead = readSync(descriptor, first, 0, first.length, 0);
      hash.update("head\0").update(first.subarray(0, firstRead));
      let total = firstRead;
      const tailSize = allowance - firstRead;
      if (tailSize > 0 && info.size > firstRead) {
        const tail = Buffer.allocUnsafe(tailSize);
        const offset = Math.max(firstRead, info.size - tailSize);
        const tailRead = readSync(descriptor, tail, 0, tail.length, offset);
        hash.update("tail\0").update(tail.subarray(0, tailRead));
        total += tailRead;
      }
      readBudget.remaining -= total;
    }
    return hash.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function splitZero(text: string): string[] {
  return text.split("\0").map((item) => item.trim()).filter(Boolean);
}

/** Exact-enough content snapshot for hand-off, not a quality/approval receipt. */
export function captureDeveloperAssistantWorktree(
  cwd: string,
): DeveloperAssistantWorktreeCheckpoint {
  const root = resolve(cwd);
  const sha = gitOutput(root, ["rev-parse", "--verify", "HEAD"], "读取 HEAD").trim();
  const pathspec = ["--", ".", ...CONTROL_PATHSPECS];
  const tracked = splitZero(gitOutput(root,
    ["diff", "--name-only", "-z", "HEAD", ...pathspec], "读取变更文件"));
  const untracked = splitZero(gitOutput(root,
    ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec],
    "读取新文件"));
  const candidates = [...new Set([...tracked, ...untracked])].sort();
  const summary = summarizeDeveloperAssistantChangedPaths(candidates, 256);
  const paths = summary.paths;
  const readBudget = { remaining: 4 * 1024 * 1024 };
  const pathFingerprints = Object.fromEntries(paths.map((path) =>
    [path, fingerprintPath(root, path, readBudget)]));
  const fingerprint = createHash("sha256")
    .update(sha).update("\0").update(JSON.stringify(candidates))
    .update("\0").update(JSON.stringify(pathFingerprints)).digest("hex");
  return {
    sha,
    fingerprint,
    paths,
    path_fingerprints: pathFingerprints,
    paths_truncated: summary.truncated,
    derived_only: summary.derivedOnly,
  };
}

export function beginDeveloperAssistantHandoff(
  previous: DeveloperAssistantHandoff | undefined,
  availability: DeveloperAssistantAvailability,
  worktree: DeveloperAssistantWorktreeCheckpoint,
  at = new Date().toISOString(),
): DeveloperAssistantHandoff {
  if (previous && previous.state !== "returned") {
    return {
      ...previous,
      id: previous.id ?? randomUUID(),
      state: "running",
      current: undefined,
      finished_at: undefined,
      changed_paths: undefined,
      paths_truncated: undefined,
      derived_only: undefined,
      message: "开发助手正在处理，主任务继续保持暂停",
    };
  }
  return {
    id: randomUUID(),
    state: "running",
    started_at: at,
    core: availability.core,
    initial: worktree,
    message: "已冻结交还起点，开发助手正在处理",
  };
}

export function finishDeveloperAssistantHandoff(
  handoff: DeveloperAssistantHandoff,
  current: DeveloperAssistantWorktreeCheckpoint,
  at = new Date().toISOString(),
): DeveloperAssistantHandoff {
  const candidates = new Set([
    ...Object.keys(handoff.initial.path_fingerprints),
    ...Object.keys(current.path_fingerprints),
  ]);
  let changedPaths = [...candidates].filter((path) =>
    handoff.initial.path_fingerprints[path]
      !== current.path_fingerprints[path]).sort();
  const pathsTruncated = Boolean(
    handoff.initial.paths_truncated || current.paths_truncated);
  // 超过有界快照时不能证明“完全没改”。用户既然主动接管，宁可让
  // 内核多做一次安全回退，也不能保留可能已过期的审批/流水线。
  const changed = handoff.initial.fingerprint !== current.fingerprint
    || pathsTruncated;
  if (changed && changedPaths.length === 0) {
    changedPaths = [...new Set([
      ...handoff.initial.paths, ...current.paths,
    ])].sort();
  }
  return {
    ...handoff,
    state: changed ? "changed" : "unchanged",
    current,
    finished_at: at,
    changed_paths: changedPaths,
    paths_truncated: pathsTruncated,
    derived_only: changed && changedPaths.length === 0
      && Boolean(handoff.initial.derived_only || current.derived_only),
    message: changed
      ? handoff.initial.sha !== current.sha
        ? `代码基线发生了变化；平台已刷新当前现场并交给主任务重新读取，不会阻塞任务`
        : `助手修改了 ${changedPaths.length || "若干"} 个文件；交还后主任务会收到现场摘要`
      : "助手没有改变业务代码，可直接交还主任务",
  };
}

export function markDeveloperAssistantReturned(
  handoff: DeveloperAssistantHandoff,
  at = new Date().toISOString(),
): DeveloperAssistantHandoff {
  return {
    ...handoff,
    state: "returned",
    returned_at: at,
    message: handoff.state === "changed"
      ? "现场摘要已交给主任务，主任务将从原内核步骤继续"
      : "已交还主任务",
  };
}
