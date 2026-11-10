/**
 * 交付恢复/停摆的决策表(src/deliveryRecovery.ts)。每一行都是一条踩过的坑
 * 或一条红线:预算不可省、停摆必喊人、两条自愈链不互踩、catch 里的抖动
 * 不算坏。这里全是纯函数,不起内核不起定时器——集成语义仍由
 * kernelUnavailableRecovery / feedbackSourcesReceipt / pipelineVerdictSyncGuard 兜着。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLL_INTERVAL_MS, DEFAULT_VERIFY_BUDGET_MS, MIN_RECOVERY_DELAY_MS,
  evidenceRetryStillValid, recoveryDelayMs, recoveryStillNeeded,
  resolveVerifyDeadline, routeReceiptFailure, stallClassForError, stallDetail,
  stallNotice, stallReasonOf, stallWrite, verificationBudgetMs,
} from "../src/deliveryRecovery.ts";
import { FEEDBACK_RESULT_MISSING } from "../src/deliveryFailure.ts";
import {
  KERNEL_UNAVAILABLE, KernelDeliveryError, KernelUnavailableError,
} from "../src/kernelDelivery.ts";
import { STALL_POLICY } from "../src/stallPolicy.ts";

test("预算与间隔:运行参数 > 服务配置 > 缺省;间隔有下限不忙等", () => {
  assert.equal(verificationBudgetMs({}), DEFAULT_VERIFY_BUDGET_MS);
  assert.equal(verificationBudgetMs({}, { pollTimeoutMs: 1234 }), 1234);
  assert.equal(verificationBudgetMs({ poll_timeout_s: 5 }, { pollTimeoutMs: 1234 }), 5000,
    "运行参数压过服务配置");
  assert.equal(verificationBudgetMs({ poll_timeout_s: 0 }), 0, "0 是合法的'不等'");
  assert.equal(recoveryDelayMs({}), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(recoveryDelayMs({}, { pollIntervalMs: 2000 }), 2000);
  assert.equal(recoveryDelayMs({ poll_interval_s: 1 }, { pollIntervalMs: 2000 }), 1000);
  assert.equal(recoveryDelayMs({ poll_interval_s: 0 }), MIN_RECOVERY_DELAY_MS,
    "测试把间隔调成 0 也不许打成忙等");
});

test("截止:第一次开表、之后对同一块表;坏掉的截止当没有", () => {
  const now = 1_000_000;
  assert.deepEqual(resolveVerifyDeadline(undefined, now, 60_000),
    { deadline: now + 60_000, opened: true });
  const iso = new Date(now + 5_000).toISOString();
  assert.deepEqual(resolveVerifyDeadline(iso, now, 60_000),
    { deadline: now + 5_000, opened: false }, "已有截止不重开,否则预算就没有尽头");
  assert.deepEqual(resolveVerifyDeadline("not-a-date", now, 60_000),
    { deadline: now + 60_000, opened: true });
});

test("停摆写盘:留在验证中、原因同时是 waiting_on 与 stalled、表清零", () => {
  assert.deepEqual(stallWrite(undefined, "宿主推送失败: fatal: 504", "infrastructure"), {
    mr_state: "验证中", waiting_on: "宿主推送失败: fatal: 504",
    stalled: "宿主推送失败: fatal: 504", stall_class: "infrastructure",
    verify_deadline: undefined,
  });
  assert.equal(stallWrite("MR 已建", "x", "safety").mr_state, "MR 已建", "不覆盖已有 MR 状态");
  assert.equal(stallDetail("原因"), "自动验证已停,需要你介入:原因");
});

test("停摆通知:键带类别与原因摘要,正文带类别标签与人该做的下一步", () => {
  const a = stallNotice("原因甲", "contract");
  const b = stallNotice("原因乙", "contract");
  assert.match(a.status, /^stalled_contract_[0-9a-f]+$/);
  assert.notEqual(a.status, b.status, "同类别换了原因要再喊一次");
  assert.equal(stallNotice("原因甲", "contract").status, a.status, "同原因幂等");
  assert.ok(a.summary.includes(STALL_POLICY.contract.label));
  assert.ok(a.summary.endsWith(`。${STALL_POLICY.contract.next_action}`));
  const long = stallNotice("长".repeat(500), "safety");
  assert.ok(long.summary.length < 320, "原因截到 200 字,不把通知撑爆");
});

test("catch 里的异常:能重放的按基础设施类记,认得出的确定性故障才按调用点声明", () => {
  assert.equal(stallClassForError(`${KERNEL_UNAVAILABLE}: 超时`, "contract"),
    "infrastructure", "内核一次没答不是契约错——2026-09-06 盘账前 6 处 catch 一律直接停摆");
  // 分类器对认不出的平台故障默认"按瞬时故障带预算自愈",所以 catch 里
  // 不认识的错一律归基础设施类:人先等恢复再重试,而不是被指去改配置。
  assert.equal(stallClassForError("连接被重置", "contract"), "infrastructure");
  assert.equal(stallClassForError("平台 HTTP 404 Not Found", "contract"), "contract",
    "确定性 4xx 重放不会变,才轮到调用点声明的类别");
  assert.equal(stallClassForError("平台 HTTP 404 Not Found", "safety"), "safety");
  // 内核层的两种错早就分好了,分类要认它们而不是认字符串。
  assert.equal(stallClassForError(
    new KernelUnavailableError(`${KERNEL_UNAVAILABLE}: dispatch 超时`), "contract"),
    "infrastructure", "内核根本没答(预算内重试已用尽):等恢复再试");
  assert.equal(stallClassForError(
    new KernelDeliveryError("内核拒绝登记:收据 sha 与提交不一致"), "contract"),
    "contract", "内核答了'不'是裁决,重放无意义——修 String(error) 前它被记成基础设施类");
  assert.equal(stallClassForError(new Error("推送被仓库拒绝: hook declined"), "safety"),
    "safety", "Error 对象按 message 分类;String(error) 的 'Error: ' 前缀会让确定性故障漏成瞬时");
  assert.equal(stallClassForError(new Error("read ECONNRESET"), "contract"), "infrastructure");
});

test("停摆原因说病因:skipped > waiting_on > detail > 兜底", () => {
  assert.equal(stallReasonOf({ skipped: "宿主推送失败: fatal", waiting_on: "流水线未过" }, "d"),
    "宿主推送失败: fatal");
  assert.equal(stallReasonOf({ waiting_on: "流水线未过" }, "d"), "流水线未过");
  assert.equal(stallReasonOf(undefined, "detail"), "detail");
  assert.equal(stallReasonOf(undefined, undefined), "外部验证迟迟没有结果");
});

test("交付自愈链还该不该管:两条链不互踩、停摆后收手、发件箱坏了例外", () => {
  const base = {
    current: true, status: "verifying", stalled: false, outboxStalled: false,
    pipeline: undefined as string | undefined,
    evidenceRetryActive: false, repairEvidenceRetryActive: false,
  };
  const rows: Array<[Partial<typeof base>, boolean, string]> = [
    [{}, true, "验证中、没人盯、没停摆:该管"],
    [{ current: false }, false, "纪元变了(重启/重跑接管):收手"],
    [{ status: "completed" }, false, "已走出验证中:收手"],
    [{ status: "queued" }, false, "派单后转 queued:不自旋"],
    [{ stalled: true }, false, "已如实停摆:人点重试才重新开表"],
    [{ stalled: true, outboxStalled: true }, true, "发件箱损坏:停摆也继续探测,修好自动续接"],
    [{ pipeline: "running" }, false, "流水线轮询在盯:让它盯"],
    [{ evidenceRetryActive: true }, false, "证据核销重试在盯:不踩"],
    [{ repairEvidenceRetryActive: true }, false, "修复环证据重试在盯:不踩"],
  ];
  for (const [patch, expected, why] of rows) {
    assert.equal(recoveryStillNeeded({ ...base, ...patch }), expected, why);
  }
});

test("回执补登记失败的出路:预算内重放、没人处理过重新派单、其余按类停摆", () => {
  const now = 1_000;
  assert.deepEqual(routeReceiptFailure(`${KERNEL_UNAVAILABLE}: 超时`, now, () => now + 1),
    { kind: "hold" }, "预算内的内核抖动:续等");
  assert.deepEqual(routeReceiptFailure(`${KERNEL_UNAVAILABLE}: 超时`, now, () => now),
    { kind: "stall", stall_class: "infrastructure" }, "预算烧完仍 fail-closed 停下喊人,不无限等");
  let opened = 0;
  assert.deepEqual(routeReceiptFailure(`${FEEDBACK_RESULT_MISSING}(task-38)`, now,
    () => { opened += 1; return now - 1; }),
    { kind: "dispatch" }, "这批还没人处理过:重新派单,和预算无关");
  assert.equal(opened, 0, "派单的路上不开表——开了会留到下一轮验证里白吃预算");
  const stalled = routeReceiptFailure("回执 sha 与提交不一致", now, () => now + 1);
  assert.equal(stalled.kind, "stall");
  assert.ok(stalled.kind === "stall" && stalled.stall_class !== "infrastructure",
    "回执本身不合格不是基础设施问题");
});

test("证据核销重试到点:必须还是排它时的那个现场", () => {
  const ok = { current: true, status: "verifying", sha: "abc", expectedSha: "abc", pipeline: "success" };
  assert.ok(evidenceRetryStillValid(ok));
  assert.ok(!evidenceRetryStillValid({ ...ok, current: false }));
  assert.ok(!evidenceRetryStillValid({ ...ok, status: "completed" }));
  assert.ok(!evidenceRetryStillValid({ ...ok, sha: "def" }), "HEAD 变了:那是新流水线的事");
  assert.ok(evidenceRetryStillValid({ ...ok, pipeline: "failed", stale: true }), "过期红灯必须能接续新 HEAD 验证");
  assert.ok(!evidenceRetryStillValid({ ...ok, pipeline: "failed" }), "当前红灯不能冒充绿灯核销重试");
  assert.ok(!evidenceRetryStillValid({ ...ok, pipeline: "running" }), "总体不是 success 就没有'逐项核销'可重试");
});
