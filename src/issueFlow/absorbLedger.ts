/**
 * 外部提交合并的记账与连续冲突计数(#589/ADR-0074):推送链路
 * (push_branch 的推送前吸收)、sync_branch 与回合开始探针
 * (turnStartAbsorb)三个入口共用的单一来源。
 *
 * 吸收记账(范围小结 + 逐笔外部提交落转移账)此前三处复制、文案手拼,
 * 与 ledgerFacts 的解析正则靠人肉保持同步(自查注释自承漂移风险)——
 * 这里连同账面字面(ledgerFacts 的构造函数)一起收敛,三入口调用
 * 同一份,归属统计的来源不会漏算。
 *
 * 连续冲突计数与 ADR-0071 基线同步的同款形态:同会话连续撞冲突 +1,
 * 合并落定(平台并入,或本地已含)即清零,与 baseline_sync_conflicts
 * 互相独立;满 3 次在回执/通知词后追加升级提示建议人工确认时机,
 * 不硬停。
 */

import {
  absorbedCommitNote,
  absorbedScopeNote,
} from "./ledgerFacts.ts";
import {
  recordTransition,
  type IssueSessionState,
} from "./state.ts";

/** 记账依赖:与 IssueToolContext / TurnStartAbsorbContext 同形子集,
 * 两侧上下文可直接传入。 */
export interface AbsorbLedgerContext {
  /** 活状态引用(吸收账与冲突计数都读写它)。 */
  state: IssueSessionState;
  /** 状态变更的持久化钩子。 */
  persist(): void;
  /** 宿主合并把文件以宿主身份写进工作区,交回容器前修属主;非隔离
   * 部署缺席即免修。 */
  repairOwnership?(dir: string): void;
}

/** 外部提交合并成功的吸收记账(三入口一份):范围小结 + 逐笔条目落
 * 转移账(喂外部头观测投影,归属统计据此记平台外),合并落定即清零
 * 连续冲突计数(#589),落盘,宿主合并后修属主。 */
export function recordAbsorbedCommits(
  ctx: AbsorbLedgerContext,
  repo: { dir: string; url: string },
  branch: string,
  absorb: { remoteTip: string; commits: string[] },
  /** 本场合并的起点(本会话该仓该分支最后一笔推送收据)。 */
  lastReceiptSha: string,
): void {
  recordTransition(ctx.state, {
    source: "platform",
    note: absorbedScopeNote(repo.url, branch, absorb.commits.length,
      lastReceiptSha, absorb.remoteTip),
  });
  for (const sha of absorb.commits) {
    recordTransition(ctx.state, {
      source: "platform",
      note: absorbedCommitNote(repo.url, branch, sha),
    });
  }
  resetAbsorbConflicts(ctx);
  ctx.persist();
  // 宿主合并把用户手改以宿主身份写进工作区,交回容器前修属主;
  // 非隔离部署零开销(与基线同步同一纪律)。
  ctx.repairOwnership?.(repo.dir);
}

/** 合并落定(平台并入,或本地已含远端头)即清零连续冲突计数(#589):
 * 「连续」指冲突接连未解;冲突已了结(无论谁并的)就从 1 重数。只在
 * 真的清了才落盘。 */
export function resetAbsorbConflicts(ctx: AbsorbLedgerContext): void {
  if (ctx.state.absorb_conflicts) {
    ctx.state.absorb_conflicts = 0;
    ctx.persist();
  }
}

/** 吸收撞冲突的连续计数与升级提示(#589,ADR-0071 基线同步同款形态):
 * 同会话连续 +1 并落盘;满 3 次返回追加在回执/通知词后的升级文案
 * (建议人工确认合并时机,不硬停),未满返回空串。action 是场景话头
 * (推送/同步/开工),只进升级文案。 */
export function absorbConflictEscalation(
  ctx: AbsorbLedgerContext,
  action: string,
): string {
  const streak = (ctx.state.absorb_conflicts ?? 0) + 1;
  ctx.state.absorb_conflicts = streak;
  ctx.persist();
  return streak >= 3
    ? `\n\n外部提交持续变动:已连续 ${streak} 次${action}撞上外部提交合并`
      + "的冲突,建议先与用户人工确认合并时机,再继续解决。"
    : "";
}
