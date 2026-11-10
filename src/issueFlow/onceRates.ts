/**
 * 一次率二轴聚合(2026-09-17 拍板,口径唯一权威:CONTEXT「一次修复
 * 成功率」「一次定位成功率」词条)。纯分类:输入各会话的结构化判定
 * 事实,输出分母与两轴分子/比率及逐条明细;不读盘。两个判定口径
 * (验证未通过、检视批次)的解析自 2026-09-20 起住在 ledgerFacts
 * (转移账与检视账的共享事实投影,首次生成归属层同源消费)——本模块
 * 转发导出保持调用方稳定,口径不分家;报告版本数由调用方读分析报告
 * 版本账(随修改型检视与验证打回增长,ADR-0045)。终态会话的判定事实也可以
 * 来自冻结快照(metrics.json,ADR-0042):本模块只做纯提取与验形(见
 * onceRateFactsFromSnapshot),盘上读写仍归调用方。
 */

import type { IssueCancelReason, IssueConclusionKind, IssueStatus } from "./state.ts";
import { ISSUE_NEGATIVE_CANCEL_REASONS } from "./state.ts";
import { sentReviewOperations } from "./ledgerFacts.ts";
import {
  ISSUE_METRICS_SCHEMA_VERSION,
  type IssueMetricsSnapshot,
} from "./metricsSnapshot.ts";

// ---- 判定口径(解析在 ledgerFacts,这里转发导出,口径不分家) ----

export { countVerifyFailures } from "./ledgerFacts.ts";

/** 检视批次:一次提交动作=一批,只认经检视通道(issue_review)送出的
 *  sent 操作。返回每批的意见号清单(意见条数=各批长度合计),批次数=
 *  数组长度。带时刻的完整投影见 ledgerFacts.sentReviewOperations。 */
export function sentReviewBatches(
  history: ReadonlyArray<{ op?: string; via?: string; ids?: string[] }>,
): string[][] {
  return sentReviewOperations(history).map((operation) => operation.ids);
}

/** 单个会话的判定事实(结构化账,判什么列什么,不携带过程细节)。 */
export interface IssueOnceRateFacts {
  id: string;
  /** 单号:空=无单流程,不参与统计。 */
  ticket?: string;
  status: IssueStatus;
  /** 结论 kind:完成交付=delivered(修复完成归档;合入与否不进结论,
   * ADR-0037)。 */
  conclusion_kind?: IssueConclusionKind;
  /** 环境验证卡答「验证发现问题」的次数。 */
  verify_fail_count: number;
  /** 分析报告版本数(初版=1;缺 0 按 ≤1 宽容,坏账不虚构失败)。 */
  report_version_count: number;
  /** 检视提交批次数(只记账,不参与两轴判定)。 */
  review_count: number;
  /** 转正血缘(ADR-0048 存量):在场=本会话由无单挂起关联单号转正
   *  而来,自身没有分析阶段——一次定位轴剔出分子分母(研究在前身
   *  会话做的,版本数 0 是「没做过」不是「一版过」);验证轴照常计。 */
  converted_from?: string;
  /** 终止原因(#542):仅 status="canceled" 时有意义。负面原因
   *  (ISSUE_NEGATIVE_CANCEL_REASONS)进一次解决率分母记失败;
   *  resolved 与缺席(历史无原因取消)维持排除。词表外的脏值按
   *  「非负面」处理——坏账不虚构失败,与快照读侧宁缺勿假同纪律。 */
  cancel_reason?: IssueCancelReason;
}

/** 从终态冻结快照(metrics.json,ADR-0042)提取一次率判定事实。
 *  快照的判定字段与现算同源(写盘时都从同一批账投影),读侧只认
 *  当前版本戳、且判定字段齐整:版本不认识、字段缺失、被手改或标了
 *  「不可得」的快照一律返回 null,由调用方回退现算——坏账不当事实,
 *  也不报错。 */
export function onceRateFactsFromSnapshot(
  snapshot: IssueMetricsSnapshot,
): IssueOnceRateFacts | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (snapshot.schema_version !== ISSUE_METRICS_SCHEMA_VERSION) return null;
  if (typeof snapshot.session_id !== "string" || !snapshot.session_id) {
    return null;
  }
  const status = snapshot.terminal_status;
  if (status !== "archived" && status !== "canceled" && status !== "failed") {
    return null;
  }
  // 判定字段逐个验形:metrics.json 是盘上文件,可能缺字段、半写或
  // 被标了「不可得」(unavailable 对象不是 number,过不了验形)。
  const verifyFail = snapshot.verify_fail_count;
  const reportVersions = snapshot.report_version_count;
  const reviewBatches = snapshot.reviews?.review_batches;
  if (typeof verifyFail !== "number" || !Number.isFinite(verifyFail)
    || typeof reportVersions !== "number"
    || !Number.isFinite(reportVersions)
    || typeof reviewBatches !== "number" || !Number.isFinite(reviewBatches)) {
    return null;
  }
  if (snapshot.ticket !== undefined && typeof snapshot.ticket !== "string") {
    return null;
  }
  const conclusionKind = snapshot.conclusion_kind;
  if (conclusionKind !== undefined && typeof conclusionKind !== "string") {
    return null;
  }
  return {
    id: snapshot.session_id,
    ticket: snapshot.ticket,
    status,
    conclusion_kind: conclusionKind as IssueOnceRateFacts["conclusion_kind"],
    verify_fail_count: verifyFail,
    report_version_count: reportVersions,
    review_count: reviewBatches,
    // 终止原因(#542):canceled 终态伴生冻结,原样透传交分类裁决;
    // 缺席键=无原因取消(历史路径),分类按排除处理。
    ...(snapshot.cancel_reason
      ? { cancel_reason: snapshot.cancel_reason } : {}),
  };
}

export interface IssueOnceRateRow {
  id: string;
  /** 终止原因(#540 复审):仅负面终止行有——第三方据它区分「用户终止」
   *  与完成交付行,与 once-generated 明细行形状对齐。 */
  cancel_reason?: IssueCancelReason;
  /** 以下工作机器事实只在完成交付行出现;负面终止行不设键(#540 复审:
   *  两轴未判、检视未记账,缺席=无从判定,不硬编码假值——false/0 会被
   *  第三方误读成「验证失败」)。 */
  reviews?: number;
  localization_pass?: boolean;
  repair_pass?: boolean;
}

/** 单会话的一次结果章(会话卡片呈现):与团队页两轴同一判定,
 *  一处函数两处使用——卡片出章与统计口径永不漂移。 */
export interface IssueOnceOutcome {
  /** 一次定位:分析报告一版过(版本数 ≤1)。 */
  localization_pass: boolean;
  /** 一次修复:环境验证零失败(未答卡=通过)。 */
  repair_pass: boolean;
}

export function issueOnceOutcome(
  facts: Pick<IssueOnceRateFacts, "report_version_count" | "verify_fail_count">,
): IssueOnceOutcome {
  return {
    localization_pass: facts.report_version_count <= 1,
    repair_pass: facts.verify_fail_count === 0,
  };
}

export interface IssueOnceRateAxis {
  passed: number;
  /** 该轴自己的分母(一次定位剔除转正会话后可与 summary.total 不同)。 */
  total: number;
  /** 占分母的百分数一位小数;分母 0 = null,前端显示 —。 */
  rate: number | null;
}

export interface IssueOnceRateSummary {
  /** 分母:完成交付 + 负面原因主动终止(#542)的会话数(一次解决率
   *  口径,主动终止记失败)。 */
  total: number;
  /** 完成交付会话数(一次定位/一次验证两轴的分母基数;#542 起与
   *  total 分家——主动终止只进一次解决率分母,不进两轴)。 */
  delivered: number;
  /** 负面原因主动终止的会话数(total 中记失败的部分)。 */
  terminated: number;
  /** 一次定位成功率:分析报告版本数 ≤1(分母=完成交付,转正剔除)。 */
  localization: IssueOnceRateAxis;
  /** 一次修复成功率:从未验证未通过(分母=完成交付)。 */
  repair: IssueOnceRateAxis;
  /** 分母会话逐条(检视次数是先行能力,呈现后议)。#542 起含负面
   *  终止行:两轴未判,工作机器事实缺席、只带终止原因(#540 复审)。 */
  per_session: IssueOnceRateRow[];
}

const percent = (passed: number, total: number): number | null =>
  total ? Math.round((passed / total) * 1000) / 10 : null;

export function issueOnceRates(
  rows: ReadonlyArray<IssueOnceRateFacts>,
): IssueOnceRateSummary {
  const per_session: IssueOnceRateRow[] = [];
  let localizationPassed = 0;
  let localizationTotal = 0;
  let repairPassed = 0;
  let delivered = 0;
  let terminated = 0;
  for (const row of rows) {
    if (!row.ticket?.trim()) continue;
    if (row.status === "canceled") {
      // 负面原因终止(#542):进一次解决率分母记失败;终止时刻两轴
      // 无法判轴(两轴口径不动),整条不进定位/验证轴,明细行不带
      // 工作机器事实(缺席,不硬编码假值),只带终止原因供第三方
      // 区分(#540 复审)。resolved 与无原因取消(缺席)维持排除。
      if (row.cancel_reason
        && ISSUE_NEGATIVE_CANCEL_REASONS.includes(row.cancel_reason)) {
        terminated += 1;
        per_session.push({ id: row.id, cancel_reason: row.cancel_reason });
      }
      continue;
    }
    if (row.status !== "archived") continue;
    if (row.conclusion_kind !== "delivered") continue;
    delivered += 1;
    // 两轴各测一个裁决点:定位=报告一版过(版本账);修复=环境验证
    // 一次过(验证卡零 fail;自动归档未答卡=验证通过,不进失败计数)。
    const { localization_pass, repair_pass } = issueOnceOutcome(row);
    // 转正会话没有分析阶段,一次定位轴整条剔出(分子分母都剔);
    // 验证轴是它真实走过的裁决,照常进。
    if (!row.converted_from) {
      localizationTotal += 1;
      if (localization_pass) localizationPassed += 1;
    }
    repairPassed += repair_pass ? 1 : 0;
    per_session.push({
      id: row.id, reviews: row.review_count,
      localization_pass, repair_pass,
    });
  }
  return {
    total: delivered + terminated,
    delivered,
    terminated,
    localization: {
      passed: localizationPassed, total: localizationTotal,
      rate: percent(localizationPassed, localizationTotal),
    },
    repair: { passed: repairPassed, total: delivered, rate: percent(repairPassed, delivered) },
    per_session,
  };
}
