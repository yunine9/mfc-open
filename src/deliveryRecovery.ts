/**
 * 交付恢复与停摆的决策部分——从 taskService 绞杀式抽出的第一块(2026-09-06)。
 *
 * 这里只有"算"和"判":预算与间隔怎么取、截止怎么开表、停摆写什么、喊人
 * 说什么、自愈链还该不该管、回执失败往哪条路走。没有定时器、持久化、
 * 通知发送和内核调用——那些留在 TaskService 的薄壳里。
 *
 * 为什么抽:度量(12 天 245 个 fix 提交,40% 落在 taskService.ts),而这块
 * 出过的 bug 全是决策错——6 处 catch 一律直接停摆、核销重试不吃预算、
 * 停摆不喊人。决策不摆成表就没人能一次看全。行为零变更:每个函数对应
 * 原方法里的一段,原有集成测试照旧;决策表见 tests/deliveryRecovery.test.ts。
 */
import { classifyDeliveryFailure } from "./deliveryFailure.ts";
import { KernelDeliveryError, KernelUnavailableError } from "./kernelDelivery.ts";
import { STALL_POLICY, type StallClass } from "./stallPolicy.ts";

/** 运行参数里与自愈有关的两个旋钮(settings.runtime() 的子集)。 */
export interface RecoveryKnobs {
  poll_timeout_s?: number;
  poll_interval_s?: number;
}

/** 服务级缺省(TaskService options.delivery 的子集)。 */
export interface RecoveryDefaults {
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export const DEFAULT_VERIFY_BUDGET_MS = 30 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** 测试把间隔调到接近 0 时也别把事件循环打成忙等。 */
export const MIN_RECOVERY_DELAY_MS = 50;

/** 外部验证的自愈预算:运行参数 > 服务配置 > 30 分钟。沿用轮询那一档,
 * 不另立旋钮——凡等待必须带预算,但旋钮多一个就多一处没人会调的地方。 */
export function verificationBudgetMs(
  knobs: RecoveryKnobs,
  defaults?: RecoveryDefaults,
): number {
  return (knobs.poll_timeout_s !== undefined
    ? knobs.poll_timeout_s * 1000 : undefined)
    ?? defaults?.pollTimeoutMs ?? DEFAULT_VERIFY_BUDGET_MS;
}

/** 两条自愈链(交付重试、证据核销重试)共用的重试间隔——原来在两个方法
 * 里各抄一份,改一处漏一处。 */
export function recoveryDelayMs(
  knobs: RecoveryKnobs,
  defaults?: RecoveryDefaults,
): number {
  return Math.max(MIN_RECOVERY_DELAY_MS,
    (knobs.poll_interval_s !== undefined
      ? knobs.poll_interval_s * 1000 : undefined)
    ?? defaults?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
}

/** 第一次挂起时开表,之后每次续命都对同一块表:已有可解析的截止就用它,
 * 否则从现在起算一份预算(opened=true 提醒调用方把新截止写回现场)。 */
export function resolveVerifyDeadline(
  existing: string | undefined,
  now: number,
  budgetMs: number,
): { deadline: number; opened: boolean } {
  const parsed = existing ? Date.parse(existing) : NaN;
  if (Number.isFinite(parsed)) return { deadline: parsed, opened: false };
  return { deadline: now + budgetMs, opened: true };
}

/** 停摆写进 delivery 的那几个字段:任务留在 verifying(代码确实已提交,
 * 不能假装 failed 也不能假装完成),原因同时是 waiting_on 与 stalled,
 * 表清零——人点重试才重新开表。 */
export interface StallWrite {
  mr_state: string;
  waiting_on: string;
  stalled: string;
  stall_class: StallClass;
  verify_deadline: undefined;
}

export function stallWrite(
  previousMrState: string | undefined,
  reason: string,
  cls: StallClass,
): StallWrite {
  return {
    mr_state: previousMrState ?? "验证中",
    waiting_on: reason,
    stalled: reason,
    stall_class: cls,
    verify_deadline: undefined,
  };
}

export function stallDetail(reason: string): string {
  return `自动验证已停,需要你介入:${reason}`;
}

/** 停摆通知的状态键与正文。键带原因摘要:人重试后同类别换了原因再停,
 * 要再喊一次;同一次停摆只喊一次由调用方按 stalled 幂等。 */
export function stallNotice(
  reason: string,
  cls: StallClass,
): { status: string; summary: string } {
  const policy = STALL_POLICY[cls];
  let digest = 0;
  for (const ch of reason) digest = (digest * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    status: `stalled_${cls}_${digest.toString(16)}`,
    summary: `自动验证已停(${policy.label}),需要你介入——${reason.slice(0, 200)}`
      + `。${policy.next_action}`,
  };
}

/** catch 里抓到的异常不知道是抖动还是坏了。内核层已经分好两种:
 * KernelUnavailableError=内核根本没答(预算内重试已用尽)→基础设施类,人只
 * 需等恢复再重试;KernelDeliveryError=内核答了"不"→裁决,重放无意义,用
 * 调用点声明的类别。其余按文案交给唯一分类处:判成"重放有意义"的按基础
 * 设施类,认得出的确定性故障按声明。文案取 message 而不是 String(error):
 * 后者带 "Error: " 前缀,分类器的前缀匹配一条都对不上——2026-09-06 决策表
 * 逮住:六个 catch 里内核的裁决一律被记成"等恢复再试"。 */
export function stallClassForError(
  error: unknown,
  declared: StallClass,
): StallClass {
  if (error instanceof KernelUnavailableError) return "infrastructure";
  if (error instanceof KernelDeliveryError) return declared;
  const text = error instanceof Error ? error.message : String(error);
  return classifyDeliveryFailure(text).disposition === "retry"
    ? "infrastructure" : declared;
}

/** 停摆要说病因不是症状:"权威流水线尚未逐项通过"是症状,"宿主推送失败:
 * fatal: ..." 才是人能拿着去办的那句。 */
export function stallReasonOf(
  delivery: { skipped?: string; waiting_on?: string } | undefined,
  detail: string | undefined,
): string {
  return delivery?.skipped ?? delivery?.waiting_on
    ?? detail ?? "外部验证迟迟没有结果";
}

/** 交付自愈链"还该不该我管"的快照。 */
export interface RecoveryGuard {
  /** 任务纪元没变(没被重启/重跑接管)。 */
  current: boolean;
  status: string;
  stalled: boolean;
  /** 检视回复发件箱损坏时即使已停摆也要继续探测,管理员修好就自动续接。 */
  outboxStalled: boolean;
  pipeline?: string;
  evidenceRetryActive: boolean;
  repairEvidenceRetryActive: boolean;
}

/** 别人在盯的(流水线轮询、证据核销重试)让它盯,已经走出验证中或已如实
 * 停摆的收手——两条自愈链不许互相踩。 */
export function recoveryStillNeeded(guard: RecoveryGuard): boolean {
  return guard.current
    && guard.status === "verifying"
    && (!guard.stalled || guard.outboxStalled)
    && guard.pipeline !== "running"
    && !guard.evidenceRetryActive
    && !guard.repairEvidenceRetryActive;
}

/** 因"内核暂时不可用"挂起、补登记回执又失败时的三条出路。 */
export type ReceiptRecoveryRoute =
  | { kind: "hold" }
  | { kind: "dispatch" }
  | { kind: "stall"; stall_class: StallClass };

/** 预算是 retry 的硬边界:烧完仍 fail-closed 停下喊人,不无限等;"这批还
 * 没人处理过"不是回执不合格,重新派单;其余按分类器给的类别停摆。
 * 截止用函数传:取截止会顺手开表(第一次挂起),只有"重放有意义"才该开。 */
export function routeReceiptFailure(
  failure: string,
  now: number,
  deadline: () => number,
): ReceiptRecoveryRoute {
  const verdict = classifyDeliveryFailure(failure, "receipt");
  if (verdict.disposition === "retry" && now < deadline()) return { kind: "hold" };
  if (verdict.disposition === "dispatch") return { kind: "dispatch" };
  return { kind: "stall", stall_class: verdict.stall_class };
}

/** 证据核销重试的定时器到点时,现场还得是排它时的那个现场:同纪元、仍在
 * 验证中、同 SHA；过期的红绿结果都可重验，普通核销重试只接受绿灯。 */
export function evidenceRetryStillValid(snapshot: {
  current: boolean;
  status: string;
  sha: string | undefined;
  expectedSha: string;
  pipeline: string | undefined;
  stale?: boolean;
}): boolean {
  return snapshot.current
    && snapshot.status === "verifying"
    && snapshot.sha === snapshot.expectedSha
    && (snapshot.pipeline === "success" || (snapshot.stale === true && snapshot.pipeline === "failed"));
}
