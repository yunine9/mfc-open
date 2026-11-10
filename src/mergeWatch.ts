/**
 * 合入监控的决策部分——从 taskService 绞杀式抽出的第二块(2026-09-06)。
 *
 * 这里是门禁怎么分类、监控环每一拍看到平台事实后往哪走、合入/关闭/等人
 * 时台账和通知写什么。没有轮询、没有派单、没有内核调用——那些留在
 * TaskService.watchMerge/settleMergeState 中。决策表见 tests/mergeWatch.test.ts。
 */

/** 门禁项(适配层契约形状,宿主只读这些字段)。 */
export interface GateItem {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface GateView {
  mrState: "opened" | "merged" | "closed";
  gates: GateItem[];
  /** 平台报告的 MR 源提交。未合入时核对版本；已合入时登记实际版本，
   * 以平台人工合入收口，不要求它等于本任务旧验证 SHA。 */
  sourceSha?: string;
}

export type RepairKind = "review" | "conflict" | "ci";

/** 冲突与客观 CI 失败可自动修复。MR 检视意见交责任人判断，
 * 不能因出现新报告就自动改代码；其余审批门禁继续等真实平台结果。 */
export const REPAIRABLE_GATES: Record<
  string,
  { kind: RepairKind; priority: number }
> = {
  conflict_passed: { kind: "conflict", priority: 15 },
  ci_state_passed: { kind: "ci", priority: 20 },
  // 代码质量门禁(内网 2026-08-18 首次拿到真实门禁集才发现有这一项)。
  // 它是**改代码能解决的**——CodeCheck/CodeCC 那类扫描结论,正是 CI
  // 修复使命里"按类分诊"已经覆盖的一类。归到等人的话,MR 卡在这里
  // 永远没人动,任务干等到监控预算耗尽(逮住时它正是 false)。
  // 与 ci_state_passed 同一路(同一个修复会话一次修完),排在其后:
  // 流水线红通常连带质量红,先看流水线原文更全。
  codequality_passed: { kind: "ci", priority: 25 },
};

/** 等人门禁的人话。名字缺席不影响判定(认不出=等人),只影响文案:
 * 界面上"等 approval_reviewers_required_passed"没人看得懂,而这些
 * 名字来自内网真实 MR(2026-08-18 selftest 实测的 19 项)。 */
export const HUMAN_GATE_TEXT: Record<string, string> = {
  resolve_discussion_passed: "等责任人处理 MR 检视意见",
  approvers_passed: "等审批",
  vote_passed: "等投票",
  work_in_progress_passed: "等摘除 WIP 标记",
  e2e_check_passed: "等 e2e 检查",
  custom_ctrl_items_passed: "等自定义门禁",
  evaluation_passed: "等评估",
  approval_approvers_required_passed: "等必需审批人审批",
  approval_reviewers_required_passed: "等必需检视人检视",
  committer_must_cast_two_votes_passed: "等提交人以外的两票",
  merge_by_self_passed: "等他人代为合入(不允许自己合自己的单)",
  merged_by_user_passed: "等有权限的人点合入(目标分支受保护)",
  mr_state_passed: "等 MR 回到可合入状态",
  no_commits_passed: "等分支上出现提交",
  branch_missing_passed: "等分支恢复(远端分支不见了)",
  // 非快进:平台要求线性历史。宿主的冲突修复走 merge(会产生合并
  // 提交),对"必须快进"的仓解不了;真解法是变基后强推,而强推是
  // 内核明令禁止的不可逆动作——所以这一项如实挂等人,交给人裁决。
  non_ff_passed: "等处理非快进(需变基,自动修复不做强推)",
};

export interface GateRepair {
  kind: RepairKind;
  gate: GateItem;
  priority: number;
}

/** 失败分类:可修的按优先级排序(全部返回——高优先级不可派时要能
 * 落到下一路,如"检视已回复等确认"时 CI 还得修);等人的翻成人话。 */
export function classifyGates(gates: GateItem[]): {
  repairs: GateRepair[];
  waiting: string[];
} {
  const repairs: GateRepair[] = [];
  const waiting: string[] = [];
  for (const gate of gates) {
    if (gate.passed) continue;
    const known = REPAIRABLE_GATES[gate.name];
    if (known) repairs.push({ ...known, gate });
    else waiting.push(HUMAN_GATE_TEXT[gate.name] ?? `等 ${gate.name}`);
  }
  repairs.sort((a, b) => a.priority - b.priority);
  return { repairs, waiting };
}

/** MFC-038:平台报告的源提交与本任务验证过的 SHA 不一致就是漂移——
 * 旧绿灯、prepush 收据与人工检视全绑旧 SHA,不能背书别的代码。任一侧
 * 缺席(旧平台契约没这个字段)无法核对,按未漂移处理并由调用方留痕。 */
export function sourceShaDrift(
  verifiedSha: string | undefined,
  observedSha: string | undefined,
): { verified: string; observed: string; drifted: boolean } {
  const verified = String(verifiedSha ?? "").trim();
  const observed = String(observedSha ?? "").trim();
  return { verified, observed,
    drifted: Boolean(verified && observed && verified !== observed) };
}


export function openMrDriftReason(observed: string, verified: string): string {
  return `MR 源分支已指向未经本任务验证的提交 ${observed.slice(0, 7)}`
    + `(任务记录的是 ${verified.slice(0, 7)});已暂停自动交付`
    + "，继续监听平台合入结果。";
}

/** 监控环每一拍拿到平台事实之后往哪走。前面的退出检查(服务在停、任务已
 * 完成/取消、没有 MR)、发件箱刷新和"平台暂不可得等下一拍"是 I/O 顺序
 * 问题,留在环里。 */
export type WatchStep =
  | { kind: "wait" }
  | { kind: "settle_merged"; sourceSha?: string }
  | { kind: "settle_closed" }
  | { kind: "stall_drift"; reason: string }
  | { kind: "repair_conflict" }
  | { kind: "inspect_gates" };

export function nextWatchStep(input: {
  view: GateView;
  status: string;
  verifiedSha: string | undefined;
}): WatchStep {
  const { view } = input;
  if (view.mrState === "merged") {
    return { kind: "settle_merged", sourceSha: view.sourceSha };
  }
  if (view.mrState === "closed") return { kind: "settle_closed" };
  // 冲突可能阻止平台创建流水线，不能等待流水线结果或 await_merge。
  // 活跃会话由调用方补充指令，不能在监听器里并发修改工作区。
  if (["running", "queued", "verifying"].includes(input.status)
      && view.mrState === "opened"
      && !sourceShaDrift(input.verifiedSha, view.sourceSha).drifted
      && view.gates.some(gate => gate.name === "conflict_passed" && !gate.passed)) {
    return { kind: "repair_conflict" };
  }
  if (input.status !== "await_merge") return { kind: "wait" };
  const drift = sourceShaDrift(input.verifiedSha, view.sourceSha);
  if (drift.drifted) {
    return { kind: "stall_drift",
      reason: openMrDriftReason(drift.observed, drift.verified) };
  }
  return { kind: "inspect_gates" };
}

/** 合入是最终抢占事件:停在途 Build-Fix / Agent / 容器,哪个没停住要
 * 点名——任务不能在"可能还有人在写"的情况下宣告完成。 */
export function stopFailures(
  cleanup: readonly PromiseSettledResult<unknown>[],
): string[] {
  return cleanup.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${["Build-Fix", "Agent", "容器"][index]}停止失败:${String(result.reason)}`]
      : []);
}

/** 完成文案:合入时本地还有没推的东西要如实说,不冒充已交付。 */
export function mergedCompletionDetail(
  unpushedCommits: number,
  unpushedPaths: number,
): string {
  return unpushedCommits || unpushedPaths
    ? `MR 已合入，任务完成；合入时本地另有 ${unpushedCommits} 个未推送提交、`
      + `${unpushedPaths} 个未提交路径，已在内核 close 事件留痕，未冒充交付`
    : "MR 已合入,交付完成";
}

/** MR 被关只是需要人处理的等待态:可能误关后重开,不能替用户判死任务。 */
export const CLOSED_MR_WRITE = {
  mr_state: "已关闭",
  waiting_on: "MR 已关闭，请重新打开或由任务责任人主动停止任务",
  detail: "MR 已关闭，自动交付已停止；本地改动已保留，系统继续监听，重开后恢复未完成工作",
} as const;

export const REOPENED_MR_WRITE = {
  mr_state: "等待合入",
  waiting_on: undefined,
  detail: "MR 已重新打开，继续监听流水线与合入状态",
} as const;

/** 内核终态未对账时远端合入不能反向篡改流程真相:留在 verifying 等对账。 */
export function mergedPendingAttestationWrite(reason: string): {
  mr_state: string; waiting_on: string; detail: string;
} {
  return {
    mr_state: "已合入（内核终态待对账）",
    waiting_on: reason,
    detail: `MR 已合入，但不能标记完成：${reason}`,
  };
}

/** 关闭的是"自动修",不是"持续观察":红项如实交给人,环不退。 */
export function autoRepairDisabledText(repairs: readonly GateRepair[]): string {
  const names = repairs.map((candidate) =>
    candidate.kind === "review" ? "检视意见"
      : candidate.kind === "conflict" ? "代码冲突" : "流水线红灯");
  return `自动修复已关闭，请人工处理${[...new Set(names)].join("、")}`;
}

/** 等人名单落台账与通知的措辞。通知幂等键=门禁集合(排序后拼接):同一批
 * 等待只提醒一次,换了一批等待项才再响。 */
export function waitingWrite(waiting: readonly string[], mrUrl: string | undefined): {
  waiting_on: string | undefined;
  detail: string;
  notice?: { status: string; summary: string };
} {
  const waitingText = waiting.join("、");
  return {
    waiting_on: waitingText || undefined,
    detail: waitingText
      ? `门禁与流水线已过,MR 在${waitingText}` : "门禁全绿,等待合入",
    ...(waitingText ? { notice: {
      status: `waiting:${[...waiting].sort().join("+")}`,
      summary: `MR 在${waitingText},需要相关人处理`
        + (mrUrl ? `:${mrUrl}` : ""),
    } } : {}),
  };
}
