/**
 * Cloud-native Build-Fix 状态机。
 *
 * 这里故意不依赖 TaskService、SessionDriver 或 Mae-Flow 内核：它只记录
 * “这个工作区快照是否已经编译 + UT 通过”。调用方负责运行 Agent、
 * 落盘和真正 push；状态机负责版本绑定、失败分类和 fail-closed 复用。
 *
 * 每次转移都显式传入时间，函数不读时钟、不碰文件系统，整个状态可以
 * 直接 JSON.stringify 到 task.delivery.prepush。进程恢复时用
 * restorePrePushVerification() 对账当前 SHA + workspace fingerprint；
 * 崩在运行中的 attempt 会回到 preparing，已完成的单项 PASS 会保留。
 */

export const PRE_PUSH_STATE_SCHEMA = "mae-flow-cloud/prepush-verification/1" as const;
export const PRE_PUSH_RECEIPT_SCHEMA = "mae-flow-cloud/prepush-pass/1" as const;
export const PRE_PUSH_EXECUTION_SCHEMA = "mae-flow-cloud/prepush-execution/1" as const;

export type PrePushStateName =
  | "preparing"
  | "repairing"
  | "passed"
  | "blocked"
  | "environment_error"
  /** 用户显式拍板跳过本地验证:绑跳过时刻的 HEAD;编译与 UT 交由
   * 权威流水线裁决。不是收据——getReusablePushReceipt 只认 passed。 */
  | "user_skipped";

export type PrePushCheck = "compile" | "unit_test";
/** 领域侧归因；与 runner 的终止 status（code_failure 等）刻意分名。 */
export type PrePushFailureClass = "code" | "infrastructure";
export type PrePushCheckOutcome =
  | "passed"
  | "code_failure"
  | "infrastructure_failure";

/** `not_run` 只允许出现在一次性 runner 报告里，永远不能成为 PASS。 */
export type PrePushReportedOutcome = PrePushCheckOutcome | "not_run";

export interface PrePushRevision {
  /** 准备推送的本地 HEAD。通常新 SHA 要重验；宿主证明只改提交元数据、
   * tree 完全一致时可通过显式 rebindEquivalentPrePushRevision 迁票。 */
  sha: string;
  /**
   * 工作区内容指纹（应覆盖 tracked/untracked 的待推送源码和测试）。
   * HEAD 未变但 Agent 改了文件时，靠它立即作废旧 receipt。
   */
  workspace_fingerprint: string;
}

export interface PrePushPendingCheck {
  state: "pending";
}

export interface PrePushPassedCheck {
  state: "passed";
  attempt_id: string;
  completed_at: string;
}

export interface PrePushFailedCheck {
  state: "failed";
  attempt_id: string;
  completed_at: string;
  failure_kind: PrePushFailureClass;
  message: string;
}

export type PrePushCheckRecord =
  | PrePushPendingCheck
  | PrePushPassedCheck
  | PrePushFailedCheck;

export interface PrePushChecks {
  compile: PrePushCheckRecord;
  unit_test: PrePushCheckRecord;
}

export interface PrePushAttempt {
  id: string;
  started_at: string;
}

export interface PrePushIssue {
  kind: PrePushFailureClass | "no_progress";
  check?: PrePushCheck;
  message: string;
  at: string;
}

export interface PrePushInvalidation {
  reason: "new_sha" | "workspace_changed";
  previous_sha: string;
  previous_workspace_fingerprint: string;
  at: string;
}

export interface PrePushPassReceipt {
  schema: typeof PRE_PUSH_RECEIPT_SCHEMA;
  sha: string;
  workspace_fingerprint: string;
  issued_at: string;
  checks: {
    compile: PrePushPassedCheck;
    unit_test: PrePushPassedCheck;
  };
  /** 宿主签入的容器事实。它用于审计与排障，不替代编译/UT 两项证据。 */
  execution?: PrePushExecutionAttestation;
}

export interface PrePushExecutionAttestation {
  schema: typeof PRE_PUSH_EXECUTION_SCHEMA;
  attempt_id: string;
  sha: string;
  container_id: string;
  image_reference: string;
  image_id: string;
  image_digest: string;
  network: string;
  read_only_root: boolean;
  pids_limit: number;
  memory_bytes?: number;
  nano_cpus?: number;
  user?: string;
  started_at?: string;
  mount_destinations: string[];
}

/**
 * 可直接持久化为 `summary.delivery.prepush` 的领域状态。
 * `round` 是同一 SHA 下启动过的 Agent/验证轮数；没有最大轮数语义。
 */
export interface PrePushVerificationState {
  schema: typeof PRE_PUSH_STATE_SCHEMA;
  state: PrePushStateName;
  round: number;
  message: string;
  /** user_skipped 的拍板人。现场必须答得出“谁点的”；是否需要给 MR
   * 加风险标记由 skip_reason 决定，不能再拿“有没有人名”混作原因。 */
  skipped_by?: string;
  /** failed_build_fix=本地编译/UT 已失败后人工放行；delivery_selection=
   * 用户调整最终文件后选择不再编译。旧记录缺席时按前者兼容。 */
  skip_reason?: "failed_build_fix" | "delivery_selection";
  sha: string;
  workspace_fingerprint: string;
  updated_at: string;
  checks: PrePushChecks;
  active_attempt?: PrePushAttempt;
  issue?: PrePushIssue;
  receipt?: PrePushPassReceipt;
  last_invalidation?: PrePushInvalidation;
}

export interface PrePushReportedCheck {
  outcome: PrePushReportedOutcome;
  message?: string;
}

/** runner 一次返回两项；compile 失败时 unit_test 应为 not_run。 */
export interface PrePushReport {
  compile: PrePushReportedCheck;
  unit_test: PrePushReportedCheck;
}

export type PrePushEvent =
  | { type: "revision_observed"; revision: PrePushRevision; at: string }
  | { type: "workspace_changed"; workspace_fingerprint: string; at: string }
  | { type: "attempt_started"; at: string; attempt_id?: string }
  | {
      type: "check_finished";
      attempt_id: string;
      check: PrePushCheck;
      outcome: PrePushCheckOutcome;
      at: string;
      message?: string;
    }
  | {
      type: "no_progress";
      at: string;
      message: string;
      attempt_id?: string;
    }
  | { type: "environment_failed"; at: string; message: string }
  | { type: "retry_requested"; at: string; message?: string }
  | { type: "recovered"; at: string };

export type PrePushNextAction =
  | "start_agent"
  | "wait_for_agent"
  | "repair_code"
  | "restore_environment"
  | "request_attention"
  | "push";

const PENDING_CHECK: PrePushPendingCheck = { state: "pending" };
const STATE_NAMES = new Set<string>([
  "preparing", "repairing", "passed", "blocked", "environment_error",
]);
const CHECK_NAMES = new Set<string>(["compile", "unit_test"]);

function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 不能为空`);
  }
  return value;
}

function assertRevision(revision: PrePushRevision): void {
  required(revision.sha, "pre-push sha");
  required(revision.workspace_fingerprint, "pre-push workspace_fingerprint");
}

export function sameRevision(
  state: Pick<PrePushVerificationState, "sha" | "workspace_fingerprint">,
  revision: PrePushRevision,
): boolean {
  return state.sha === revision.sha
    && state.workspace_fingerprint === revision.workspace_fingerprint;
}

function pendingChecks(): PrePushChecks {
  // 不共享嵌套对象，免得调用方误改一个维度连带污染另一个。
  return { compile: { ...PENDING_CHECK }, unit_test: { ...PENDING_CHECK } };
}

function pendingFailedChecks(checks: PrePushChecks): PrePushChecks {
  return {
    compile: checks.compile.state === "failed"
      ? { ...PENDING_CHECK } : checks.compile,
    unit_test: checks.unit_test.state === "failed"
      ? { ...PENDING_CHECK } : checks.unit_test,
  };
}

function checkLabel(check: PrePushCheck): string {
  return check === "compile" ? "编译" : "UT";
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function createPrePushVerification(
  revision: PrePushRevision,
  at: string,
): PrePushVerificationState {
  assertRevision(revision);
  required(at, "pre-push 时间");
  return {
    schema: PRE_PUSH_STATE_SCHEMA,
    state: "preparing",
    round: 0,
    message: `等待验证 ${shortSha(revision.sha)} 的编译和 UT`,
    sha: revision.sha,
    workspace_fingerprint: revision.workspace_fingerprint,
    updated_at: at,
    checks: pendingChecks(),
  };
}

/**
 * 对账当前现场。完全相同的 revision 原样返回，因而网络失败后的同 SHA
 * push 重试会复用 receipt；SHA 或内容指纹任一变化都 fail-closed 清票。
 */
export function observePrePushRevision(
  state: PrePushVerificationState | undefined,
  revision: PrePushRevision,
  at: string,
): PrePushVerificationState {
  if (!state) return createPrePushVerification(revision, at);
  assertRevision(revision);
  required(at, "pre-push 时间");
  if (sameRevision(state, revision)) return state;

  const reason: PrePushInvalidation["reason"] = state.sha !== revision.sha
    ? "new_sha" : "workspace_changed";
  return {
    schema: PRE_PUSH_STATE_SCHEMA,
    state: "preparing",
    // 文件修复仍属于同一待推送 SHA 的下一轮；真正的新提交重新计轮。
    round: reason === "workspace_changed" ? state.round : 0,
    message: reason === "new_sha"
      ? `发现新 SHA ${shortSha(revision.sha)}，需要重新验证`
      : "工作区内容已变化，旧的 Build-Fix 结果已失效",
    sha: revision.sha,
    workspace_fingerprint: revision.workspace_fingerprint,
    updated_at: at,
    checks: pendingChecks(),
    last_invalidation: {
      reason,
      previous_sha: state.sha,
      previous_workspace_fingerprint: state.workspace_fingerprint,
      at,
    },
  };
}

function generatedAttemptId(state: PrePushVerificationState): string {
  return `${state.sha}:${state.workspace_fingerprint}:${state.round + 1}`;
}

function startAttempt(
  state: PrePushVerificationState,
  at: string,
  requestedId?: string,
): PrePushVerificationState {
  if (state.state === "passed" || state.state === "blocked"
      || state.state === "environment_error") return state;
  if (state.active_attempt) {
    if (!requestedId || requestedId === state.active_attempt.id) return state;
    // 已有一轮在跑时不能偷换 attempt；先由 recovered/no_progress 收口。
    return state;
  }
  const attemptId = requestedId
    ? required(requestedId, "pre-push attempt_id")
    : generatedAttemptId(state);
  const round = state.round + 1;
  return {
    ...state,
    state: state.state === "repairing" ? "repairing" : "preparing",
    round,
    message: state.state === "repairing"
      ? `第 ${round} 轮 Build-Fix 修复与复验`
      : `第 ${round} 轮 Build-Fix`,
    updated_at: at,
    checks: pendingFailedChecks(state.checks),
    active_attempt: { id: attemptId, started_at: at },
    issue: undefined,
    receipt: undefined,
  };
}

function failedMessage(
  check: PrePushCheck,
  kind: PrePushFailureClass,
  detail: string | undefined,
): string {
  const prefix = kind === "code"
    ? `${checkLabel(check)}未通过`
    : `${checkLabel(check)}环境异常`;
  return detail?.trim() ? `${prefix}：${detail.trim()}` : prefix;
}

function recordCheck(
  state: PrePushVerificationState,
  event: Extract<PrePushEvent, { type: "check_finished" }>,
): PrePushVerificationState {
  if (!state.active_attempt || state.active_attempt.id !== event.attempt_id) {
    // 内容变化或恢复后的迟到结果不属于当前 attempt，必须静默丢弃。
    return state;
  }
  if (event.check === "unit_test" && state.checks.compile.state !== "passed") {
    // UT 绿灯不能补猜编译绿灯，矛盾报告 fail-closed。
    return state;
  }
  const existing = state.checks[event.check];
  if (existing.state === "passed") return state; // 幂等重放

  if (event.outcome === "passed") {
    const passed: PrePushPassedCheck = {
      state: "passed",
      attempt_id: event.attempt_id,
      completed_at: event.at,
    };
    const checks = { ...state.checks, [event.check]: passed } as PrePushChecks;
    if (event.check === "compile") {
      return {
        ...state,
        state: "preparing",
        message: "编译已通过，继续运行 UT",
        updated_at: event.at,
        checks,
      };
    }
    const compile = checks.compile;
    if (compile.state !== "passed") return state;
    const receipt: PrePushPassReceipt = {
      schema: PRE_PUSH_RECEIPT_SCHEMA,
      sha: state.sha,
      workspace_fingerprint: state.workspace_fingerprint,
      issued_at: event.at,
      checks: { compile, unit_test: passed },
    };
    return {
      ...state,
      state: "passed",
      message: `编译和 UT 已通过，可推送 ${shortSha(state.sha)}`,
      updated_at: event.at,
      checks,
      active_attempt: undefined,
      issue: undefined,
      receipt,
    };
  }

  const failureKind: PrePushFailureClass = event.outcome === "code_failure"
    ? "code" : "infrastructure";
  const message = failedMessage(event.check, failureKind, event.message);
  const failed: PrePushFailedCheck = {
    state: "failed",
    attempt_id: event.attempt_id,
    completed_at: event.at,
    failure_kind: failureKind,
    message,
  };
  return {
    ...state,
    state: failureKind === "code" ? "repairing" : "environment_error",
    message,
    updated_at: event.at,
    checks: {
      ...state.checks,
      [event.check]: failed,
      // 编译没过时，任何历史 UT 结果都不能继续背书。
      ...(event.check === "compile"
        ? { unit_test: { ...PENDING_CHECK } } : {}),
    } as PrePushChecks,
    active_attempt: undefined,
    issue: { kind: failureKind, check: event.check, message, at: event.at },
    receipt: undefined,
  };
}

function markNoProgress(
  state: PrePushVerificationState,
  at: string,
  message: string,
  attemptId?: string,
): PrePushVerificationState {
  if (state.state === "passed") return state;
  if (attemptId && state.active_attempt?.id !== attemptId) return state;
  const detail = required(message, "pre-push no_progress message");
  return {
    ...state,
    state: "blocked",
    message: detail,
    updated_at: at,
    active_attempt: undefined,
    issue: { kind: "no_progress", message: detail, at },
    receipt: undefined,
  };
}

/** 领域 reducer；未知/迟到 attempt 的结果保持原状态，绝不误签 receipt。 */
export function transitionPrePush(
  state: PrePushVerificationState,
  event: PrePushEvent,
): PrePushVerificationState {
  switch (event.type) {
    case "revision_observed":
      return observePrePushRevision(state, event.revision, event.at);
    case "workspace_changed":
      return observePrePushRevision(state, {
        sha: state.sha,
        workspace_fingerprint: event.workspace_fingerprint,
      }, event.at);
    case "attempt_started":
      return startAttempt(state, event.at, event.attempt_id);
    case "check_finished":
      return recordCheck(state, event);
    case "no_progress":
      return markNoProgress(
        state, event.at, event.message, event.attempt_id);
    case "environment_failed": {
      if (state.state === "passed") return state;
      const message = required(event.message, "pre-push 环境异常");
      return {
        ...state,
        state: "environment_error",
        message,
        updated_at: event.at,
        active_attempt: undefined,
        issue: { kind: "infrastructure", message, at: event.at },
        receipt: undefined,
      };
    }
    case "retry_requested": {
      if (state.state === "passed" || state.active_attempt) return state;
      return {
        ...state,
        state: "preparing",
        message: event.message?.trim() || "重新执行 Build-Fix",
        updated_at: event.at,
        checks: pendingFailedChecks(state.checks),
        issue: undefined,
        receipt: undefined,
      };
    }
    case "recovered": {
      if (!state.active_attempt) return state;
      return {
        ...state,
        state: "preparing",
        message: "服务恢复，继续未完成的 Build-Fix",
        updated_at: event.at,
        active_attempt: undefined,
        // 已收到的单项 PASS 绑定同一快照，可继续；未知的在途动作重跑。
        checks: pendingFailedChecks(state.checks),
        issue: undefined,
        receipt: undefined,
      };
    }
  }
}

export function beginPrePushAttempt(
  state: PrePushVerificationState,
  at: string,
  attemptId?: string,
): PrePushVerificationState {
  return transitionPrePush(state, {
    type: "attempt_started", at, ...(attemptId ? { attempt_id: attemptId } : {}),
  });
}

export function recordPrePushCheck(
  state: PrePushVerificationState,
  attemptId: string,
  check: PrePushCheck,
  outcome: PrePushCheckOutcome,
  at: string,
  message?: string,
): PrePushVerificationState {
  return transitionPrePush(state, {
    type: "check_finished", attempt_id: attemptId, check, outcome, at,
    ...(message ? { message } : {}),
  });
}

/**
 * 接收 runner 的一次性报告。compile 非 PASS 时 unit_test 结果不可信；
 * compile PASS 但 unit_test=not_run 视为“本轮无完整进展”，停在 blocked
 * 等显式恢复，避免无预算原地重启 Agent。
 */
export function recordPrePushReport(
  state: PrePushVerificationState,
  attemptId: string,
  report: PrePushReport,
  at: string,
): PrePushVerificationState {
  if (!state.active_attempt || state.active_attempt.id !== attemptId) {
    return state;
  }
  if (report.compile.outcome === "not_run") {
    return markNoProgress(
      state, at,
      report.compile.message?.trim() || "本轮没有执行编译，Build-Fix 无进展",
      attemptId);
  }
  let next = recordPrePushCheck(
    state, attemptId, "compile", report.compile.outcome, at,
    report.compile.message);
  if (report.compile.outcome !== "passed") return next;
  if (report.unit_test.outcome === "not_run") {
    return markNoProgress(
      next, at,
      report.unit_test.message?.trim() || "编译通过但本轮没有执行 UT",
      attemptId);
  }
  next = recordPrePushCheck(
    next, attemptId, "unit_test", report.unit_test.outcome, at,
    report.unit_test.message);
  return next;
}

/** 把真实容器事实绑定到已签发的同 attempt/SHA 收据。错配直接拒绝，
 * 但没有该字段的自定义 runner 仍可沿用原有收据兼容路径。 */
export function attestPrePushExecution(
  state: PrePushVerificationState,
  execution: PrePushExecutionAttestation,
): PrePushVerificationState {
  const receipt = state.receipt;
  if (state.state !== "passed" || !receipt) {
    throw new Error("只有已通过的 Build-Fix 才能登记容器事实");
  }
  if (execution.schema !== PRE_PUSH_EXECUTION_SCHEMA
      || execution.sha !== receipt.sha
      || execution.attempt_id !== receipt.checks.compile.attempt_id
      || execution.attempt_id !== receipt.checks.unit_test.attempt_id
      || !execution.container_id || !execution.image_id
      || !execution.image_digest || execution.read_only_root !== true
      || !Number.isInteger(execution.pids_limit) || execution.pids_limit <= 0) {
    throw new Error("容器事实与 Build-Fix 收据不匹配");
  }
  return {
    ...state,
    receipt: {
      ...receipt,
      execution: {
        ...execution,
        mount_destinations: [...execution.mount_destinations].sort(),
      },
    },
  };
}

export function retryPrePushVerification(
  state: PrePushVerificationState,
  at: string,
  message?: string,
): PrePushVerificationState {
  return transitionPrePush(state, {
    type: "retry_requested", at, ...(message ? { message } : {}),
  });
}

export function markPrePushNoProgress(
  state: PrePushVerificationState,
  at: string,
  message: string,
  attemptId?: string,
): PrePushVerificationState {
  return transitionPrePush(state, {
    type: "no_progress", at, message,
    ...(attemptId ? { attempt_id: attemptId } : {}),
  });
}

/** 恢复编排在真正启动 runner 前发现现场/配置不可用时的统一收口。
 * 这类失败没有具体 compile/UT 维度，不能伪造成某一项检查结果。 */
export function failPrePushEnvironment(
  state: PrePushVerificationState,
  at: string,
  message: string,
): PrePushVerificationState {
  return transitionPrePush(state, { type: "environment_failed", at, message });
}

/**
 * 只有 exact SHA + fingerprint 且两项记录仍与 receipt 一致才可复用。
 * 这是 push 入口最后一道纯检查，不能只看 state === "passed"。
 */
export function getReusablePushReceipt(
  state: PrePushVerificationState | undefined,
  revision: PrePushRevision,
): PrePushPassReceipt | undefined {
  if (!state || state.schema !== PRE_PUSH_STATE_SCHEMA
      || state.state !== "passed" || !state.receipt
      || state.receipt.schema !== PRE_PUSH_RECEIPT_SCHEMA
      || !state.receipt.issued_at
      || !sameRevision(state, revision)
      || state.receipt.sha !== revision.sha
      || state.receipt.workspace_fingerprint !== revision.workspace_fingerprint
      || state.checks.compile.state !== "passed"
      || state.checks.unit_test.state !== "passed"
      || state.receipt.checks.compile.attempt_id
        !== state.checks.compile.attempt_id
      || state.receipt.checks.compile.completed_at
        !== state.checks.compile.completed_at
      || state.receipt.checks.unit_test.attempt_id
        !== state.checks.unit_test.attempt_id
      || state.receipt.checks.unit_test.completed_at
        !== state.checks.unit_test.completed_at) return undefined;
  return state.receipt;
}

/**
 * 宿主已经机械证明前后 commit 的 tree 完全一致时，只把 PASS 收据重绑到
 * 新提交对象。调用方负责 tree 等价校验；这里仍严格核对旧收据确实属于
 * previous，避免把任意历史绿灯搬到新代码上。
 */
export function rebindEquivalentPrePushRevision(
  state: PrePushVerificationState,
  previous: PrePushRevision,
  next: PrePushRevision,
  at: string,
): PrePushVerificationState {
  if (!sameRevision(state, previous)) {
    throw new Error("旧 Build-Fix 收据与提交说明修正前的 revision 不一致");
  }
  if (state.state === "user_skipped") {
    return {
      ...state,
      sha: next.sha,
      workspace_fingerprint: next.workspace_fingerprint,
      updated_at: at,
      message: `提交说明已修正；代码内容未变，沿用 ${state.skipped_by ?? "用户"} 的跳过决定`,
      last_invalidation: {
        reason: "new_sha",
        previous_sha: previous.sha,
        previous_workspace_fingerprint: previous.workspace_fingerprint,
        at,
      },
    };
  }
  const receipt = getReusablePushReceipt(state, previous);
  if (!receipt) throw new Error("只有有效的 Build-Fix PASS 收据才能等价重绑");
  return {
    ...state,
    sha: next.sha,
    workspace_fingerprint: next.workspace_fingerprint,
    updated_at: at,
    message: `提交说明已修正；代码内容未变，沿用 ${previous.sha.slice(0, 12)} 的编译和 UT 结果`,
    receipt: {
      ...receipt,
      sha: next.sha,
      workspace_fingerprint: next.workspace_fingerprint,
      ...(receipt.execution ? {
        execution: { ...receipt.execution, sha: next.sha },
      } : {}),
    },
    last_invalidation: {
      reason: "new_sha",
      previous_sha: previous.sha,
      previous_workspace_fingerprint: previous.workspace_fingerprint,
      at,
    },
  };
}

export function canPushRevision(
  state: PrePushVerificationState | undefined,
  revision: PrePushRevision,
): boolean {
  return getReusablePushReceipt(state, revision) !== undefined;
}

export function nextPrePushAction(
  state: PrePushVerificationState,
): PrePushNextAction {
  if (state.state === "passed") return "push";
  if (state.state === "environment_error") return "restore_environment";
  if (state.state === "blocked") return "request_attention";
  if (state.active_attempt) return "wait_for_agent";
  if (state.state === "repairing") return "repair_code";
  return "start_agent";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCheckRecord(value: unknown): value is PrePushCheckRecord {
  if (!isObject(value) || typeof value.state !== "string") return false;
  if (value.state === "pending") return true;
  if (value.state === "passed") {
    return typeof value.attempt_id === "string"
      && typeof value.completed_at === "string";
  }
  return value.state === "failed"
    && typeof value.attempt_id === "string"
    && typeof value.completed_at === "string"
    && (value.failure_kind === "code"
      || value.failure_kind === "infrastructure")
    && typeof value.message === "string";
}

function isPassedCheck(value: unknown): value is PrePushPassedCheck {
  return isCheckRecord(value) && value.state === "passed";
}

function isExecutionAttestation(value: unknown): value is PrePushExecutionAttestation {
  return isObject(value)
    && value.schema === PRE_PUSH_EXECUTION_SCHEMA
    && typeof value.attempt_id === "string" && Boolean(value.attempt_id)
    && typeof value.sha === "string" && Boolean(value.sha)
    && typeof value.container_id === "string" && Boolean(value.container_id)
    && typeof value.image_reference === "string"
    && typeof value.image_id === "string" && Boolean(value.image_id)
    && typeof value.image_digest === "string" && Boolean(value.image_digest)
    && typeof value.network === "string"
    && value.read_only_root === true
    && Number.isInteger(value.pids_limit) && Number(value.pids_limit) > 0
    && Array.isArray(value.mount_destinations)
    && value.mount_destinations.every((item) => typeof item === "string");
}

/** 严格识别可恢复状态；畸形/伪造 receipt 一律由 restore 退回重验。 */
export function isPrePushVerificationState(
  value: unknown,
): value is PrePushVerificationState {
  if (!isObject(value)
      || value.schema !== PRE_PUSH_STATE_SCHEMA
      || typeof value.state !== "string" || !STATE_NAMES.has(value.state)
      || !Number.isInteger(value.round) || Number(value.round) < 0
      || typeof value.message !== "string"
      || typeof value.sha !== "string" || !value.sha
      || typeof value.workspace_fingerprint !== "string"
      || !value.workspace_fingerprint
      || typeof value.updated_at !== "string"
      || !isObject(value.checks)
      || !isCheckRecord(value.checks.compile)
      || !isCheckRecord(value.checks.unit_test)) return false;

  if (value.active_attempt !== undefined) {
    if (!isObject(value.active_attempt)
        || typeof value.active_attempt.id !== "string"
        || typeof value.active_attempt.started_at !== "string") return false;
  }
  if (value.state === "passed") {
    if (!isObject(value.receipt)
        || value.receipt.schema !== PRE_PUSH_RECEIPT_SCHEMA
        || value.receipt.sha !== value.sha
        || value.receipt.workspace_fingerprint !== value.workspace_fingerprint
        || typeof value.receipt.issued_at !== "string"
        || !isObject(value.receipt.checks)
        || !isPassedCheck(value.receipt.checks.compile)
        || !isPassedCheck(value.receipt.checks.unit_test)
        || !isPassedCheck(value.checks.compile)
        || !isPassedCheck(value.checks.unit_test)
        || value.receipt.checks.compile.attempt_id
          !== value.checks.compile.attempt_id
        || value.receipt.checks.compile.completed_at
          !== value.checks.compile.completed_at
        || value.receipt.checks.unit_test.attempt_id
          !== value.checks.unit_test.attempt_id
        || value.receipt.checks.unit_test.completed_at
          !== value.checks.unit_test.completed_at
        || (value.receipt.execution !== undefined
          && (!isExecutionAttestation(value.receipt.execution)
            || value.receipt.execution.sha !== value.sha
            || value.receipt.execution.attempt_id
              !== value.checks.compile.attempt_id))) return false;
  } else if (value.receipt !== undefined) {
    return false;
  }
  return true;
}

/**
 * 重启入口：坏账 fail-closed 创建新状态；好账先处理在途 attempt，再与
 * 当前现场对账。已 PASS 且 revision 未变时 receipt 原样保留供 push 重试。
 */
export function restorePrePushVerification(
  saved: unknown,
  currentRevision: PrePushRevision,
  at: string,
): PrePushVerificationState {
  if (!isPrePushVerificationState(saved)) {
    return createPrePushVerification(currentRevision, at);
  }
  const recovered = transitionPrePush(saved, { type: "recovered", at });
  return observePrePushRevision(recovered, currentRevision, at);
}

/** 编译、UT 是此领域唯一两维；CodeCheck 明确不属于 push 前 Agent。 */
export function isPrePushCheck(value: string): value is PrePushCheck {
  return CHECK_NAMES.has(value);
}
