/**
 * 回合开始的外部提交吸收(ADR-0074 票 3):续作回合开工前,宿主对每个
 * 已推送过修复分支的登记仓做一次单引用探针,远端头前进(用户把手改推
 * 回远端)即机械合并进工作区再开工——AI 醒来见到的就是含手改的最新代码。
 *
 * 探针经济(ADR-0074 拍板,一条都不许破):
 * - 修复分支未定名(首轮/无单形态)不探——分支刚按时间戳建,远端必然
 *   不存在;克隆未落地(等 Agent pull_repo)不探——无从探起;
 * - 该仓没有推送收据不探——没有比对锚点(推送链路的无收据门兜底);
 * - 探针/取回失败 fail-open 不拦回合——网络抖动不该停工(同 ADR-0071
 *   取回基线失败口径),只留日志;
 * - 与 push_branch/sync_branch 共用在途互斥(同一把 BranchTransferMutex,
 *   服务侧 LiveIssue 级单例):忙时跳过吸收,不排队不阻塞。
 *
 * 回合照常开工是本入口的硬契约:冲突/脏/异常形态都只产出随回合话递给
 * Agent 的通知词(ADR-0016 文案资产,notices.absorb.*),绝不抛错、绝不
 * 阻塞——解冲突要判断,交对话现场;吸收事实(范围小结 + 逐笔外部提交)
 * 留痕转移账,喂外部头观测投影,归属统计据此记平台外。
 *
 * 判定核心复用 issueGit.absorbExternalCommits(票 1 的窄函数,推送链路
 * 与 sync_branch 同源),本模块只做时机守门、记账与通知词组装。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { promptCopy } from "./promptCopy.ts";
import {
  absorbExternalCommits,
  type ExternalAbsorbOutcome,
  type GitCredential,
} from "./issueGit.ts";
import { lastReceiptOf } from "./ledgerFacts.ts";
import {
  absorbConflictEscalation,
  recordAbsorbedCommits,
  resetAbsorbConflicts,
} from "./absorbLedger.ts";
import {
  recordTransition,
  fixedFixBranch,
  issueRepoWorkspaces,
  type IssueSessionState,
} from "./state.ts";

/** 分支传输在途互斥(ADR-0074):push_branch/sync_branch 与回合开始
 * 探针共用一把——三者都在同一工作区做 fetch/merge,各持一把等于没有
 * 互斥。互斥是"在途"口径(acquire/release 成对,不是一次性熔断);
 * 探针侧只读不排队:inFlight() 为真即跳过吸收,不阻塞回合。 */
export interface BranchTransferMutex {
  inFlight(): boolean;
  acquire(): void;
  release(): void;
}

export function createBranchTransferMutex(): BranchTransferMutex {
  let inFlight = false;
  return {
    inFlight: () => inFlight,
    acquire: () => { inFlight = true; },
    release: () => { inFlight = false; },
  };
}

/** 三类非严格后代形态的人话事实(ADR-0074,回合开始探针与推送/分支
 * 同步共用一份——三种入口撞的是同一批"远端对不上账"现场,给 Agent
 * 的事实必须一致):按形态现拼,不预先全量求值。 */
export function absorbBlockedFinding(
  absorb: Extract<ExternalAbsorbOutcome, { kind: "blocked" }>,
  lastReceiptSha: string | undefined,
): string {
  if (absorb.form === "rewritten") {
    return `远端修复分支头 ${absorb.remoteTip} 的历史与本会话最后一笔`
      + `推送收据(${lastReceiptSha?.slice(0, 12)})对不上,远端历史`
      + "疑似被改写(如本地改写历史后强推)";
  }
  if (absorb.form === "unbacked") {
    return `远端修复分支已存在(头 ${absorb.remoteTip}),但本会话从未`
      + "推送过该分支,平台没有收据背书这个头";
  }
  return `远端修复分支头 ${absorb.remoteTip} 落后于本会话最后一笔推送`
    + `收据(${lastReceiptSha?.slice(0, 12)}),远端疑似被回滚`;
}

/** 回合开始吸收入口的依赖:与工具上下文(IssueToolContext)同形,
 * 服务侧从 LiveIssue 现拼,测试直调同款构造。 */
export interface TurnStartAbsorbContext {
  /** 活状态引用(收据投影与吸收账都读写它)。 */
  state: IssueSessionState;
  /** 会话工作区根(repo/<仓名>/ 挂这里)。 */
  workspace: string;
  /** 数据目录(凭据沙箱运行区挂这里,不进工作区)。 */
  dataRoot: string;
  gitCredential?(): GitCredential | undefined;
  /** 状态变更的持久化钩子(吸收账落盘)。 */
  persist(): void;
  /** 宿主合并把文件以宿主身份写进工作区,交回容器前修属主(ADR-0071
   * 同一纪律);非隔离部署缺席即免修。 */
  repairOwnership?(dir: string): void;
  /** 与 push_branch/sync_branch 共用的在途互斥(LiveIssue 级单例)。 */
  branchTransfer: BranchTransferMutex;
  log?(message: string): void;
}

/** 回合开工前的外部提交吸收:逐登记仓探针(有克隆、有收据才探),
 * 远端前进即合并进工作区并留痕,返回随回合话递给 Agent 的通知词——
 * 无事返回空串。绝不抛错:意外异常逐仓吞掉留日志,fail-open 是硬契约。 */
export async function absorbExternalAtTurnStart(
  ctx: TurnStartAbsorbContext,
): Promise<string> {
  const { state } = ctx;
  // 在途互斥:分支传输忙时整轮跳过(不排队——探针等推送收尾没有意义,
  // 推送链路自己的吸收兜底还在)。
  if (ctx.branchTransfer.inFlight()) {
    ctx.log?.("回合开始外部提交吸收跳过:分支传输在途(push/sync),不阻塞回合");
    return "";
  }
  const branch = fixedFixBranch(state);
  if (!branch) return ""; // 修复分支未定名(首轮/无单形态),没有可探的分支
  const notices: string[] = [];
  for (const repo of issueRepoWorkspaces(state, ctx.workspace)) {
    try {
      if (!existsSync(join(repo.dir, ".git"))) continue; // 克隆未落地,等 pull_repo
      // 无收据不探(ADR-0074 探针经济):该仓该分支平台从未推过,没有
      // 比对锚点——首轮分支刚建远端必然不存在,不在这里浪费一次探针。
      const lastReceiptSha = lastReceiptOf(state.transitions ?? [],
        repo.url, branch)?.sha;
      if (!lastReceiptSha) continue;
      const absorb = await absorbExternalCommits({
        dataDir: ctx.dataRoot,
        repoDir: repo.dir,
        repoUrl: repo.url,
        branch,
        ticket: state.ticket ?? `MR !${state.imported_mr?.iid ?? "?"}`,
        receiptSha: lastReceiptSha,
        credential: ctx.gitCredential?.(),
      });
      const notice = await absorbTurnOutcome(ctx, repo.dir, repo.url, branch,
        lastReceiptSha, absorb);
      if (notice) notices.push(notice);
    } catch (error) {
      // 吸收自身绝不拦回合(硬契约):意外异常逐仓吞掉,留日志照常开工。
      ctx.log?.(`回合开始外部提交吸收跳过(意外失败,照常开工): `
        + `${repo.url} ${String(error)}`);
    }
  }
  return notices.join("\n\n");
}

/** 单仓结果分叉:记账 + 修属主 + 通知词。current 无事返回空串;
 * unavailable fail-open 只留日志;其余形态各有一段通知词(notices.
 * absorb.*),吸收/冲突/暂停三类留痕转移账。 */
async function absorbTurnOutcome(
  ctx: TurnStartAbsorbContext,
  repoDir: string,
  repoUrl: string,
  branch: string,
  lastReceiptSha: string,
  absorb: ExternalAbsorbOutcome,
): Promise<string> {
  const { state } = ctx;
  if (absorb.kind === "current") {
    // 远端头已被本地包含 = 冲突(若有)已了结,计数从 1 重数(#589)。
    resetAbsorbConflicts(ctx);
    return "";
  }
  if (absorb.kind === "unavailable") {
    // 探针/取回失败 fail-open(ADR-0074):网络抖动不该停工,只留日志,
    // 不递通知词(远端状态不可判定时不给 Agent 猜的材料)。
    ctx.log?.(`回合开始外部提交吸收跳过(远端探针/取回失败,照常开工): `
      + `${repoUrl} ${absorb.reason}`);
    return "";
  }
  if (absorb.kind === "synced") {
    // 记账走三入口共用的助手(absorbLedger):与推送/sync_branch 同一份
    // 文案与落盘(范围小结 + 逐笔,喂外部头观测投影,归属统计据此记
    // 平台外)。
    recordAbsorbedCommits(ctx, { dir: repoDir, url: repoUrl }, branch,
      absorb, lastReceiptSha);
    return promptCopy("notices", "absorb.merged", {
      branch,
      count: absorb.commits.length,
      from: lastReceiptSha.slice(0, 12),
      to: absorb.remoteTip.slice(0, 12),
    });
  }
  if (absorb.kind === "conflict") {
    // 冲突事实留痕(回放"平台为何停手"):现场已还原,交由会话内解决。
    recordTransition(state, {
      source: "platform",
      note: `回合开始外部提交合并撞冲突,已还原现场:${repoUrl} ${branch} `
        + `冲突 ${absorb.files.length} 条(${absorb.files.join("、")})`
        + "——交由会话内解决,外部提交是用户手改不许回滚",
    });
    ctx.persist();
    // merge 尝试写过工作区文件(冲突标记)再 abort 还原,被重写的文件
    // 可能已是宿主属主;交回容器前修属主(与基线同步冲突路径同一纪律)。
    ctx.repairOwnership?.(repoDir);
    // 连续冲突计数与升级提示(#589,基线同步 ADR-0071 同款形态),
    // 追加在通知词后。
    const escalate = absorbConflictEscalation(ctx, "开工");
    return promptCopy("notices", "absorb.conflict", {
      branch,
      count: absorb.files.length,
      files: absorb.files.join("\n"),
    }) + escalate;
  }
  if (absorb.kind === "blocked") {
    // 非严格后代(改写/回滚/无收据的外部头):照常开工但声明吸收已
    // 暂停喊人——绝不自动处理,留痕转移账。
    const finding = absorbBlockedFinding(absorb, lastReceiptSha);
    recordTransition(state, {
      source: "platform",
      note: `回合开始外部提交吸收已暂停:${finding};`
        + "需人工核对,平台绝不自动处理",
    });
    ctx.persist();
    return promptCopy("notices", "absorb.blocked", { finding });
  }
  if (absorb.kind === "dirty") {
    // 脏工作区不做机械合并(ADR-0071 同口径):交 Agent 收尾后自行同步。
    return promptCopy("notices", "absorb.dirty", {
      count: absorb.files.length,
      files: absorb.files.join("\n"),
    });
  }
  // failed:merge 失败且无冲突文件,现场已 abort 还原。
  return promptCopy("notices", "absorb.failed", { reason: absorb.reason });
}
