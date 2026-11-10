/**
 * 问题流自动接单(ADR-0061;2026-10-10 修订开关迁入个人设置):定时
 * 扫描已开启自动接单(个人自助开关,缺省关闭)的开发责任人名下的
 * DTS 单,把符合条件的新单以责任人自登记形态自动发起为问题会话。
 *
 * 纪律(ADR-0061 拍板):
 * - 同尺铁律:与页面上人工发起走完全相同的校验链,不发明第二条规则
 *   ——单据状态「开发人员实施修改」、配置中心版本映射命中且标记参与
 *   自动接单、特性名强匹配业务模块(三道预筛与 DTS 列表发起同一单点
 *   判据),同账号+同单号非终态去重与责任人 Git 凭据门由 create 内
 *   硬闸原样兜底;三道预筛之后另有第四道单级排除闸(ADR-0070):用户
 *   点名排除的单跳过,只拦扫描器、不拦人工发起。任何一道不过即跳过
 *   本单:宁可漏发不可错发。
 * - 静默跳过:发不了的单只落审计账(issue-auto-claim.jsonl,带原因),
 *   不通知任何人;版本未标记参与的老版本同此——按规则不归自动管。
 * - 唯一流控是回合并发额度(issue_max_turns 排队),单拍不限流,
 *   名下积压多拍自然消化。
 * - 调度器只接在正式入口(executionRuntime);间隔旋钮现读现判
 *   (issue_auto_claim_interval_s,缺省半小时,0=暂停——个人开关原样
 *   保留,恢复间隔即续),单飞防重入,unref() 不阻进程退出;测试/旁路
 *   直连形态不起定时器,要扫描直接调 runAutoClaimTick。
 */

import { matchProductVersion } from "../configurationCenter.ts";
import type { RuntimeKnobs } from "../settings.ts";
import { readDtsAutoClaimExclusions } from "../dtsAutoClaimExclusions.ts";
import { newRequestId, processAudit } from "./audit.ts";
import type { DtsGateway } from "./gateways.ts";
import type { IssueCreateInput, IssueSummary } from "./service.ts";
import { configuredVersionRows, dtsFeatureModuleIndex,
  matchDtsModule } from "./routes.ts";

/** 人工拉单与自动接单共同的可发起状态名(DTS 状态名,与页面同尺;
 *  交付流转走后单子不再是它,天然不会被重复接单)。 */
export const DTS_CLAIMABLE_STATUS = "开发人员实施修改";

/** 扫描间隔缺省值(秒,ADR-0061:半小时;旋钮缺席时生效)。 */
export const DEFAULT_ISSUE_AUTO_CLAIM_INTERVAL_S = 1800;

/** 关闭状态下重查旋钮的节奏(毫秒):0=关要能随时被改回开,链不能停。 */
const RECHECK_MS = 60_000;

/** 自动接单消费面的结构化收窄:单拍只碰这几样,测试用记录器假件
 *  即可驱动,不必起整条问题流服务。 */
export interface AutoClaimIssueFlow {
  dataDir: string;
  create(input: IssueCreateInput): IssueSummary;
}

export interface AutoClaimAuth {
  issueAutoClaimAccounts(): string[];
}

export interface AutoClaimSettings {
  runtime(): RuntimeKnobs;
}

export interface AutoClaimDeps {
  /** DTS 网关;缺席(未配置部署)时扫描空转——没有数据源就不发车。 */
  dts: DtsGateway | undefined;
  issueFlow: AutoClaimIssueFlow;
  auth: AutoClaimAuth | undefined;
  settings: AutoClaimSettings;
  log?: (message: string) => void;
}

export interface AutoClaimOutcome {
  claimed: Array<{ account: string; ticket: string; issue_id: string }>;
  skipped: number;
}

/** 单拍扫描:逐名单用户拉名下单 → 同尺过滤 → 逐个发起。测试与
 *  调度器共用这一个入口;全程纯旁路,任何异常都不外抛。 */
export async function runAutoClaimTick(deps: AutoClaimDeps): Promise<AutoClaimOutcome> {
  const outcome: AutoClaimOutcome = { claimed: [], skipped: 0 };
  const accounts = deps.auth?.issueAutoClaimAccounts() ?? [];
  if (!accounts.length || !deps.dts) return outcome;
  const versionRows = configuredVersionRows(deps.issueFlow.dataDir);
  const moduleIndex = dtsFeatureModuleIndex(deps.issueFlow.dataDir);
  const exclusions = readDtsAutoClaimExclusions(deps.issueFlow.dataDir);
  for (const account of accounts) {
    let briefs;
    try {
      briefs = await deps.dts.listByOwner(account);
    } catch (error) {
      // 网关异常按"这一拍不碰这个人名下"处理:下一拍自然重试,
      // 落账为证;其他名单用户不受牵连。
      processAudit("issue-auto-claim", {
        kind: "auto_claim.list_failed",
        level: "warn",
        msg: `自动接单拉取 ${account} 名下单失败,本拍跳过:`
          + `${String(error instanceof Error ? error.message : error)}`,
        account,
      });
      continue;
    }
    for (const brief of briefs ?? []) {
      const skip = (reason: string): void => {
        outcome.skipped += 1;
        processAudit("issue-auto-claim", {
          kind: "auto_claim.skipped",
          msg: `自动接单跳过 ${brief.ticket}(${account}):${reason}`,
          account, ticket: brief.ticket, reason,
        });
      };
      // 同尺第一闸:单据状态。状态名缺席与不匹配同罪(fail-closed,
      // 拿不准就不发)。
      if (brief.status !== DTS_CLAIMABLE_STATUS) {
        skip(`单据状态「${brief.status ?? "未知"}」不是「${DTS_CLAIMABLE_STATUS}」`);
        continue;
      }
      // 同尺第二闸:版本映射命中 + 参与自动接单标记(ADR-0061 的
      // 老版本过滤;命中口径与发起分支匹配同一条 matchProductVersion)。
      const row = matchProductVersion(versionRows, brief.version);
      if (!row) {
        skip("单据版本未配置分支映射");
        continue;
      }
      if (row.auto_claim !== true) {
        skip("版本组未标记参与自动接单");
        continue;
      }
      // 同尺第三闸:特性名强匹配业务模块(ADR-0056,与列表带出
      // 同一个判定点)。
      const moduleId = matchDtsModule(moduleIndex, brief.featureName);
      if (!moduleId) {
        skip("特性名未匹配到业务模块");
        continue;
      }
      // 同尺第四闸:单级排除(ADR-0070)——用户点名这张单不自动接。
      // 标记按单号全局生效(改派责任人后仍在),取消(条目删除)即
      // 恢复;只拦扫描器,人工发起路径不受影响。因排除跳过与其他
      // 跳过同待遇:静默 + 审计留痕,原因单列「用户排除」并带操作人。
      const exclusion = exclusions[brief.ticket];
      if (exclusion) {
        skip(`用户排除:${exclusion.updated_by} 标记不自动接单`);
        continue;
      }
      // 发起:责任人自登记形态(ADR-0031),发起方式=自动标记进状态。
      // 非终态去重、模块在架、Git 凭据门等 create 硬闸原样生效,
      // 抛错即跳过并如实落账。
      try {
        const created = deps.issueFlow.create({
          account,
          assignee: account,
          reporter: account,
          title: brief.title,
          source: "dts",
          ticket: brief.ticket,
          moduleId,
          productVersion: row.version,
          autoClaim: true,
        });
        outcome.claimed.push({
          account, ticket: brief.ticket, issue_id: created.id,
        });
        processAudit("issue-auto-claim", {
          kind: "auto_claim.claimed",
          msg: `自动接单发起 ${brief.ticket} → ${created.id}(${account})`,
          issue_id: created.id, account, ticket: brief.ticket,
          request_id: newRequestId(),
        });
        deps.log?.(`[issue-auto] ${brief.ticket} 已自动接单 → `
          + `${created.id}(${account})`);
      } catch (error) {
        skip(`发起被拒:${String(error instanceof Error ? error.message : error)}`);
      }
    }
  }
  return outcome;
}

/** 下次扫描时刻(epoch ms;null=未排程——调度器未装配,或间隔旋钮
 *  为 0 管理员暂停)。个人设置的问号悬停卡经 GET /issues/auto-claim
 *  读取;调度器每次排程刷新,测试/旁路形态不装配恒为 null。 */
let scheduledNextRunAt: number | null = null;

export function autoClaimNextRunAt(): string | null {
  return scheduledNextRunAt === null
    ? null : new Date(scheduledNextRunAt).toISOString();
}

/** 装配定时器:自续链 setTimeout(间隔旋钮现读现判,改了下一拍生效;
 *  0=关闭时空转重查),单飞防重入。unref() 不阻进程退出。 */
export function startAutoClaimScheduler(deps: AutoClaimDeps): void {
  let running = false;
  const intervalMs = (): number => {
    const seconds = deps.settings.runtime().issue_auto_claim_interval_s
      ?? DEFAULT_ISSUE_AUTO_CLAIM_INTERVAL_S;
    return Math.max(0, seconds) * 1000;
  };
  const run = async (): Promise<void> => {
    if (running || intervalMs() <= 0) return;
    running = true;
    try {
      await runAutoClaimTick(deps);
    } catch (error) {
      deps.log?.(`[issue-auto] 扫描失败(不影响服务): `
        + String(error instanceof Error ? error.message : error));
    } finally {
      running = false;
    }
  };
  const schedule = (): void => {
    const delay = intervalMs();
    scheduledNextRunAt = delay > 0 ? Date.now() + delay : null;
    const timer = setTimeout(() => {
      void run().finally(schedule);
    }, delay > 0 ? delay : RECHECK_MS);
    timer.unref?.();
  };
  schedule();
}
