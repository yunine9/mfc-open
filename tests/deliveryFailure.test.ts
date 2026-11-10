/**
 * 一次交付动作失败该怎么处置——唯一分类处的契约。
 *
 * 本周 17 条 fix 都在补同一类误诊:内核抖一下被当成"内核拒收"直接停摆、
 * 流水线登记失败被误诊成"索引损坏"、宿主命令一次超时就等于整轮停摆。
 * 根因是这个判断散在四五处、各自对中文消息做前缀匹配。收成一处之后,
 * 每一档的判据都必须钉在这里:以后加一类故障,先在这里补一条用例。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  classifyDeliveryFailure,
  commitSideRejection,
  deliveryFailureMessage,
  heldForKernelUnavailable,
  FEEDBACK_RESULT_MISSING,
} from "../src/deliveryFailure.ts";
import { KERNEL_UNAVAILABLE } from "../src/kernelDelivery.ts";

test("基础设施故障重放有意义:内核没答只挂起自愈,不当成拒收", () => {
  const verdict = classifyDeliveryFailure(
    `${KERNEL_UNAVAILABLE}：内核进程被信号 SIGKILL 终止（基础设施故障）`);
  assert.equal(verdict.disposition, "retry");
  assert.match(verdict.why, /基础设施/);
});

test("这批还没人处理过:派单,不是把任务停在那等人", () => {
  assert.equal(classifyDeliveryFailure(
    `${FEEDBACK_RESULT_MISSING}（result-x.json）：本批反馈尚未被修复会话处理过`)
    .disposition, "dispatch");
});

test("契约坏了不烧重试预算:四类确定性失败一律停摆喊人", () => {
  for (const cause of [
    "交付平台响应不完整，未返回 MR 链接",
    "流水线返回未知状态: (empty)",
    "推送被仓库拒绝：提交 abc123 的说明不符合仓库规范",
    "提交说明不符合仓库规范：abc123「wip」",
  ]) assert.equal(classifyDeliveryFailure(cause).disposition, "stall", cause);
});

test("确定性 4xx 停摆,408 超时与 429 限流仍自愈", () => {
  assert.equal(classifyDeliveryFailure("平台返回 HTTP 400: 分支不存在")
    .disposition, "stall");
  assert.equal(classifyDeliveryFailure("平台返回 HTTP 404: 无此 MR")
    .disposition, "stall");
  assert.equal(classifyDeliveryFailure("平台返回 HTTP 408: 超时")
    .disposition, "retry", "超时是瞬时故障");
  assert.equal(classifyDeliveryFailure("平台返回 HTTP 429: 限流")
    .disposition, "retry", "限流是瞬时故障");
  assert.equal(classifyDeliveryFailure("平台返回 HTTP 502: 网关错误")
    .disposition, "retry", "5xx 自己再试几轮");
});

// 两条路的默认出路相反,这是收敛时最容易被抹平的一条:平台侧没见过的
// 错多半是一阵子的事,回执侧没见过的错就是材料不合格。
test("认不出来的平台故障按瞬时走带预算的自愈,不静默放行也不干等", () => {
  const verdict = classifyDeliveryFailure("宿主推送失败: 某种没见过的错");
  assert.equal(verdict.disposition, "retry");
  assert.match(verdict.why, /未识别|瞬时/);
});

test("认不出来的回执故障是材料不合格:当场停下喊人,不许无限重读", () => {
  const verdict = classifyDeliveryFailure(
    "Agent 留下的本批逐条反馈回执无法读取（result-x.json）：SyntaxError",
    "receipt");
  assert.equal(verdict.disposition, "stall");
  assert.match(verdict.why, /不合格/);
  // 但内核没答与"还没人处理"在两条路上判法一致。
  assert.equal(classifyDeliveryFailure(
    `${KERNEL_UNAVAILABLE}：进程被杀`, "receipt").disposition, "retry");
  assert.equal(classifyDeliveryFailure(
    `${FEEDBACK_RESULT_MISSING}（x.json）：尚未处理`, "receipt").disposition,
    "dispatch");
});

test("病因在提交这一侧时不说等待权威流水线", () => {
  const push = "推送被仓库拒绝：提交说明不符合仓库规范";
  assert.equal(commitSideRejection(push), true);
  assert.equal(deliveryFailureMessage(push, `交付动作失败: ${push}`),
    `交付动作失败: ${push}`, "人拿着这句话要去改提交,不是去查流水线");
  assert.match(
    deliveryFailureMessage("流水线返回未知状态: (empty)", "交付动作失败: x"),
    /^等待权威流水线：/);
  assert.match(
    deliveryFailureMessage("交付平台暂时连接不上，请检查平台地址或网络", "x"),
    /系统正在自动重试，暂时无需操作/);
});

test("挂起原因归属可判:恢复循环据此决定要不要先补登记回执", () => {
  assert.equal(heldForKernelUnavailable(`${KERNEL_UNAVAILABLE}：进程被杀`), true);
  assert.equal(heldForKernelUnavailable("等待权威流水线：MR 尚未创建"), false);
  assert.equal(heldForKernelUnavailable(undefined), false);
});

// 收敛的硬约束:前缀知识只许住在 deliveryFailure.ts。别处再比对一次,
// 就又有了第二种判法——那正是这 17 条 fix 的来源。
test("没有第二个文件认识这些故障前缀", () => {
  const root = join(process.cwd(), "src");
  const offenders: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".ts")) continue;
    // 分类器本身、以及产出这些标记的地方(内核调用、回执读取)不在此列:
    // 产出 ≠ 判定,判定必须回到唯一处。
    if (["deliveryFailure.ts", "kernelDelivery.ts"].includes(name)) continue;
    const source = readFileSync(join(root, name), "utf-8");
    if (/startsWith\(\s*(KERNEL_UNAVAILABLE|FEEDBACK_RESULT_MISSING)/.test(source)
      || /startsWith\("(交付平台响应不完整|流水线返回未知状态|推送被仓库拒绝|提交说明不符合仓库规范)/
        .test(source)
      || /HTTP 4\(\?!08/.test(source)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [],
    "该重试还是该停摆只由 deliveryFailure.classifyDeliveryFailure 判");
});
