/**
 * 一次交付动作失败了,该重试还是该停下喊人——**唯一分类处**。
 *
 * 这个判断原来散在四五处,靠对中文消息做 `startsWith` 前缀匹配各判各的,
 * 于是同一类故障在不同入口得到不同待遇:内核抖一下被当成"内核拒收"
 * 直接停摆、流水线登记失败被误诊成"索引损坏"、宿主命令一次超时就等于
 * 整轮停摆。本周 17 条 fix 都在补这类误诊(2026-09-04 盘账)。
 *
 * 分类只有三档,对应三条出路:
 * - `retry`    基础设施/瞬时故障。原样重放有意义:挂起,按既有预算自愈;
 * - `stall`    契约坏了或确定性 4xx。同一请求再发一百次还是这个结果,
 *              不烧重试预算,当场如实停下喊人;
 * - `dispatch` 这活儿压根还没人做过。不是失败,是派单没落地:重新派给
 *              修复会话,别拿"Agent 没留回执"把任务停在那等人。
 *
 * 红线口径(README「不许卡死」勘误):门禁与证据登记不是旁路,分不出类
 * 的一律按 `retry` 走**有预算**的自愈——预算烧完仍由调用方 fail-closed
 * 停下,绝不无预算干等,也绝不静默放行。
 */

import { KERNEL_UNAVAILABLE } from "./kernelDelivery.ts";
import type { StallClass } from "./stallPolicy.ts";

export type FailureDisposition = "retry" | "stall" | "dispatch";

/**
 * 失败是谁产生的。**认不出来的故障,两条路的默认出路相反**——这个差别
 * 原来只隐含在两处 else 分支里,没人写下来,收敛时差点被抹平:
 * - `platform` 外部交付平台/网络。没见过的错多半是一阵子的事,按瞬时
 *   故障走带预算的自愈;
 * - `receipt`  Agent 留在工作区的回执材料。没见过的错就是这份材料不
 *   合格,原样重读一百次还是不合格,当场停下喊人。
 */
export type FailureSource = "platform" | "receipt";

export interface ClassifiedFailure {
  disposition: FailureDisposition;
  /** 为什么这么判。进日志与诊断包,排障时不用再去猜分类依据。 */
  why: string;
  /** 真要停下时记哪一类:调用方不必再自己翻译一遍分类结论。retry 的
   * 结论对应基础设施类(预算烧完停下时人只需等恢复再重试)。 */
  stall_class: StallClass;
}

/** 重放这些没有意义:平台契约接错/损坏、提交本身被仓库规则拒收。
 * 网络错误、限流和超时**不在这里**,它们仍走带预算的自愈。 */
const CONTRACT_BROKEN = [
  "交付平台响应不完整",
  "流水线返回未知状态",
  "推送被仓库拒绝",
  "提交说明不符合仓库规范",
] as const;

/** 病因在提交/仓库这一侧,不是流水线没跑完。措辞不该说"等待权威流水线"。 */
const COMMIT_REJECTED = [
  "推送被仓库拒绝",
  "提交说明不符合仓库规范",
] as const;

/** 这批反馈还没被任何修复会话处理过——派单被打断,不是回执不合格。 */
export const FEEDBACK_RESULT_MISSING = "本批逐条反馈回执尚未落盘";

export function classifyDeliveryFailure(
  cause: string,
  source: FailureSource = "platform",
): ClassifiedFailure {
  const text = String(cause ?? "").trim();
  // 内核这一下没答 ≠ 内核拒收:材料还在工作区文件里,补登记即可,
  // 不必叫 Agent 重做,更不该把整轮修复成果晾在停摆里。
  if (text.startsWith(KERNEL_UNAVAILABLE)) {
    return { disposition: "retry", why: "内核基础设施故障,重放有意义", stall_class: "infrastructure" };
  }
  if (text.includes("缺少 Cloud 宿主权威收据") || text.startsWith("内核状态不可读")) {
    return { disposition: "stall", why: "宿主可信状态异常，Agent 改写回复无法修复", stall_class: "safety" };
  }
  if (text.startsWith(FEEDBACK_RESULT_MISSING)) {
    return { disposition: "dispatch", why: "本批反馈还没有被处理过", stall_class: "evidence_missing" };
  }
  if (CONTRACT_BROKEN.some((prefix) => text.startsWith(prefix))) {
    return { disposition: "stall", why: "平台契约或提交本身有问题,重放不会自愈", stall_class: "contract" };
  }
  // 确定性 4xx:同一请求再发一百次还是 4xx(MFC-020 实测同文 MR-400 刷了
  // 86 条日志、两轮预算)。408 超时与 429 限流是瞬时的,不在此列。
  if (/HTTP 4(?!08\b|29\b)\d\d\b/.test(text)) {
    return { disposition: "stall", why: "确定性 4xx,重放结果不变", stall_class: "contract" };
  }
  return source === "receipt"
    ? { disposition: "stall", why: "回执材料不合格,原样重读不会变好", stall_class: "evidence_invalid" }
    : { disposition: "retry", why: "未识别为确定性故障,按瞬时故障带预算自愈", stall_class: "infrastructure" };
}

/** 病因在提交这一侧时不要再说"等待权威流水线":人拿着这句话没法办事。 */
export function commitSideRejection(cause: string): boolean {
  const text = String(cause ?? "").trim();
  return COMMIT_REJECTED.some((prefix) => text.startsWith(prefix));
}

/** 交付失败在页面上的归属前缀。停摆与挂起共用同一套措辞规则。 */
export function deliveryFailureMessage(cause: string, reason: string): string {
  const text = String(cause ?? "").trim();
  if (commitSideRejection(text)) return reason;
  // 连接不上是最常见的一类瞬时故障,值得一句"不用你操作"的人话,
  // 否则页面上写着"等待权威流水线"人会去查流水线。
  if (text.startsWith("交付平台暂时连接不上")) {
    return "交付平台连接异常，系统正在自动重试，暂时无需操作";
  }
  return `等待权威流水线：${reason}`;
}

/** 这次挂起是不是因为"内核这一下没答"。
 *
 * 恢复循环靠它决定要不要先补登记逐条回执再交付——材料已经在工作区文件
 * 里,登记按结果摘要幂等,不必再叫 Agent 回来。这是全仓唯一一处需要问
 * "当初为什么挂起"的地方;前缀知识不外泄,别的文件不许再自己比对。 */
export function heldForKernelUnavailable(waitingOn: string | undefined): boolean {
  return String(waitingOn ?? "").startsWith(KERNEL_UNAVAILABLE);
}
