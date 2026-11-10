/**
 * 转移账与检视账的事实投影(ADR-0044,首次生成归属的共享地基):
 * 推送账(同提交回放去重,#506)、红灯三种处置结局、外部头观测、回退
 * 轮、验证失败、检视
 * 批次送出、反馈事件归并——判定键与解析集中在此单一来源,写账文案
 * 要改就连这里一起改(归档冻结快照 metricsSnapshot、一次率 onceRates
 * 与首次生成归属层都消费这一份,不许各写一份漂移)。纯投影:只读
 * 账面结构,不碰 Git、不落盘。
 */

import { VERIFY_FAIL_NOTE_PREFIX } from "./state.ts";

/** 推送账:push_branch 每笔一条「分支已推送 <仓> <分支> @ <提交号>」。 */
export const PUSH_NOTE = /^分支已推送 (\S+) (\S+) @ ([0-9a-f]{7,40})/;

// ---- 红灯处置结局(三分互斥,转移账文案计) ----

/** 红灯按失败处理(进入修复分诊/停机)。 */
const RED_FAILED_NOTE = "流水线失败(";
/** 红灯随合入取消(9a4d5f75 加的处置结局)。 */
const MERGE_CANCELED_NOTE = "MR 已合入,旧提交";
/** 红灯随头变丢弃(9a4d5f75 加的处置结局)。 */
const HEAD_DISCARDED_NOTE = "旧提交";

/** 外部头观测(c12c1cf0 加的检查目标跟随条目):文案是「分支头已被
 * 平台外提交 <短码> 取代,检查目标跟随切换(<仓>)」。 */
export const EXTERNAL_HEAD_COMMIT =
  /^分支头已被平台外提交 ([0-9a-f]{7,40}) 取代/;

/** 外部提交合并的逐笔吸收账(ADR-0074)解析正则:匹配「外部提交合并:
 * <仓> <分支> 并入平台外提交 <短码>」。写账方一律走 absorbedCommitNote
 * / absorbedScopeNote 构造(下一组),字面改两处一起改,不许手拼漂移。
 * 范围小结(「并入远端外部提交 N 条(… → …)」)不带逐笔短码,对不上
 * 这条正则。 */
export const ABSORBED_EXTERNAL_COMMIT =
  /^外部提交合并:\S+ \S+ 并入平台外提交 ([0-9a-f]{7,40})$/;

// ---- 外部提交合并的账面文案单一来源(ADR-0074,与上面的解析正则
// ---- 同源;写账方 tools.ts / turnStartAbsorb.ts 只从这两个构造函数
// ---- 取字面,不许各拼一份) ----

/** 范围小结条目:「外部提交合并:<仓> <分支> 并入远端外部提交 N 条
 * (<from12> → <to12>)」。提交号按账面惯例取前 12 位(见 LedgerPush)。 */
export function absorbedScopeNote(
  repo: string, branch: string, count: number, fromSha: string, toSha: string,
): string {
  return `外部提交合并:${repo} ${branch} 并入远端外部提交 ${count} 条(`
    + `${fromSha.slice(0, 12)} → ${toSha.slice(0, 12)})`;
}

/** 逐笔条目(即 ABSORBED_EXTERNAL_COMMIT 匹配的形态):「外部提交合并:
 * <仓> <分支> 并入平台外提交 <短码>」。 */
export function absorbedCommitNote(
  repo: string, branch: string, sha: string,
): string {
  return `外部提交合并:${repo} ${branch} 并入平台外提交 ${sha.slice(0, 12)}`;
}

/** 回退轮次(fixedRollback 的「第 N 轮:原因」)。 */
export const ROLLBACK_NOTE = /^第 \d+ 轮:(.*)$/s;

/** 转移账推送投影(仓、分支、提交号、时刻),账面顺序即推送顺序。
 *  同 (仓,分支,提交号) 的重推只留首笔(#506):重启续跑等触发的同
 *  提交回放不携带任何新提交,不是新推送——推送计数、逐笔差异、
 *  返工归属三个消费方按唯一提交口径,不再被回放翻转归类。 */
export interface LedgerPush {
  repo: string;
  branch: string;
  /** 提交号(账面记前 12 位,照录)。 */
  sha: string;
  at: string;
}

export function ledgerPushes(
  transitions: ReadonlyArray<{ note: string; at: string }>,
): LedgerPush[] {
  const pushes: LedgerPush[] = [];
  const seen = new Set<string>();
  for (const transition of transitions) {
    const match = PUSH_NOTE.exec(transition.note);
    if (!match) continue;
    const push: LedgerPush = {
      repo: match[1]!, branch: match[2]!, sha: match[3]!, at: transition.at,
    };
    const key = `${push.repo}\u0000${push.branch}\u0000${push.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushes.push(push);
  }
  return pushes;
}

/** 本会话在指定仓、分支的推送收据组(账面顺序):push_branch 的 force
 * 收据门(ADR-0074)整组核对用。 */
export function ledgerReceiptsOf(
  transitions: ReadonlyArray<{ note: string; at: string }>,
  repo: string, branch: string,
): LedgerPush[] {
  return ledgerPushes(transitions)
    .filter((entry) => entry.repo === repo && entry.branch === branch);
}

/** 吸收判定的锚点(ADR-0074):本会话在该仓该分支的最后一笔推送收据;
 * 推送链路、sync_branch 与回合开始探针三入口共用同一份投影,判定不
 * 漂移。 */
export function lastReceiptOf(
  transitions: ReadonlyArray<{ note: string; at: string }>,
  repo: string, branch: string,
): LedgerPush | undefined {
  return ledgerReceiptsOf(transitions, repo, branch).at(-1);
}

export function isRedLightRepaired(note: string): boolean {
  return note.startsWith(RED_FAILED_NOTE);
}

export function isRedLightCanceledByMerge(note: string): boolean {
  return note.startsWith(MERGE_CANCELED_NOTE) && note.includes("随合入取消");
}

export function isRedLightDiscardedOnHeadMove(note: string): boolean {
  return note.startsWith(HEAD_DISCARDED_NOTE)
    && note.includes("结果丢弃,不作失败处理");
}

/** 验证未通过次数:按转移账的平台文案计(#328)。生产记账是
 *  「第 N 轮:用户环境验证发现问题:…」(回退统一加轮次前缀),开头
 *  匹配永远对不上;包含匹配同时覆盖历史裸前缀旧账。 */
export function countVerifyFailures(
  transitions: ReadonlyArray<{ note: string }>,
): number {
  return transitions.filter(
    (transition) => transition.note.includes(VERIFY_FAIL_NOTE_PREFIX),
  ).length;
}

/** 外部头观测明细:分支头被平台外推送取代的每一次发现(检查目标
 * 跟随)+ 外部提交合并逐笔吸收的用户提交(ADR-0074)——归属统计
 * 据此把两类提交都记平台外,不落进平台推送区间被误算成平台工作量。 */
export function externalHeadObservations(
  transitions: ReadonlyArray<{ note: string; at: string }>,
): Array<{ sha: string; at: string }> {
  const records: Array<{ sha: string; at: string }> = [];
  for (const transition of transitions) {
    const match = EXTERNAL_HEAD_COMMIT.exec(transition.note)
      ?? ABSORBED_EXTERNAL_COMMIT.exec(transition.note);
    if (match) records.push({ sha: match[1]!, at: transition.at });
  }
  return records;
}

// ---- 检视账与反馈事件(ADR-0044 口径) ----

/** 检视账里一次提交动作=一批:只认经检视通道(issue_review)送出的
 *  sent 操作,带时刻(反馈事件归并用)。 */
export function sentReviewOperations(
  history: ReadonlyArray<{
    op?: string; via?: string; ids?: string[]; at?: string;
  }>,
): Array<{ at: string; ids: string[] }> {
  return history.flatMap((operation) =>
    operation.op === "sent" && operation.via === "issue_review"
      ? [{ at: operation.at ?? "", ids: operation.ids ?? [] }]
      : [],
  );
}

/** 反馈事件三触发源(ADR-0044):检视批次送出、红灯仅「按失败处理」
 *  结局、环境验证发现问题。红灯随合入取消/随头变丢弃不算反馈(不是
 *  对当前代码的返工要求),人工回退轮不算(重做不是修反馈)——它们
 *  都不推进首次生成归属的返工边界。输出按时刻升序。 */
export type FeedbackEventKind =
  | "review_sent"
  | "pipeline_repaired"
  | "verify_fail";

export interface FeedbackEvent {
  kind: FeedbackEventKind;
  at: string;
}

export function feedbackEvents(input: {
  transitions: ReadonlyArray<{ note: string; at: string }>;
  reviewOperations: ReadonlyArray<{ at: string }>;
}): FeedbackEvent[] {
  const events: FeedbackEvent[] = [];
  for (const transition of input.transitions) {
    if (isRedLightRepaired(transition.note)) {
      events.push({ kind: "pipeline_repaired", at: transition.at });
    } else if (transition.note.includes(VERIFY_FAIL_NOTE_PREFIX)) {
      events.push({ kind: "verify_fail", at: transition.at });
    }
  }
  for (const operation of input.reviewOperations) {
    if (operation.at) events.push({ kind: "review_sent", at: operation.at });
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
