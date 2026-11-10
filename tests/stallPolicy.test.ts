/**
 * 停摆策略表的契约:每一类都有标签与"人接手要做什么";基础设施类是唯一
 * 理应先自愈再停的;分类器的结论能直接落到类别上,不用调用方再翻译。
 * 以及:所有停摆点都必须声明类别——TS 已经强制,这里再从源码侧钉一次
 * 直接写 stalled 的地方也带上 stall_class(那两处绕过了 markVerificationStalled)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STALL_CLASSES, STALL_POLICY, isStallClass } from "../src/stallPolicy.ts";
import { classifyDeliveryFailure } from "../src/deliveryFailure.ts";
import { KERNEL_UNAVAILABLE } from "../src/kernelDelivery.ts";

const ACTION = /重试|补齐|重做|修正|核实|等/;

test("停摆策略:五类齐全,每类都告诉人去哪、做什么", () => {
  assert.deepEqual(STALL_CLASSES,
    ["infrastructure", "evidence_missing", "evidence_invalid", "contract", "safety"]);
  for (const cls of STALL_CLASSES) {
    const policy = STALL_POLICY[cls];
    assert.ok(policy.label.length >= 4, `${cls} 缺标签`);
    assert.match(policy.next_action, ACTION, `${cls} 的下一步没有动作`);
    assert.doesNotMatch(policy.next_action, /重跑续推|重新尝试交付/,
      `${cls}: 两处按钮文字不同,措辞不许点名按钮`);
  }
  assert.ok(isStallClass("safety"));
  assert.ok(!isStallClass("unknown"));
});

test("停摆策略:只有基础设施类理应先自愈;完整性类明说不自动重试", () => {
  assert.deepEqual(STALL_CLASSES.filter((cls) => STALL_POLICY[cls].retry_first), ["infrastructure"]);
  assert.match(STALL_POLICY.safety.next_action, /不会自动重试/);
  assert.match(STALL_POLICY.infrastructure.next_action, /不用改代码/);
});

test("分类器结论直接给出停摆类别", () => {
  assert.equal(classifyDeliveryFailure(`${KERNEL_UNAVAILABLE}: 超时`).stall_class, "infrastructure");
  assert.equal(classifyDeliveryFailure("推送被仓库拒绝: hook declined").stall_class, "contract");
  assert.equal(classifyDeliveryFailure("MR 创建失败 HTTP 400").stall_class, "contract");
  assert.equal(classifyDeliveryFailure("回执缺少 evidence", "receipt").stall_class, "evidence_invalid");
  assert.equal(classifyDeliveryFailure("ECONNRESET").stall_class, "infrastructure");
});

test("源码侧:直接写 stalled 的地方都带类别,清 stalled 的地方同时清类别", () => {
  const source = readFileSync(new URL("../src/taskService.ts", import.meta.url), "utf-8");
  const lines = source.split("\n");
  const offenders: string[] = [];
  lines.forEach((line, index) => {
    const window = lines.slice(index, index + 3).join("\n");
    if (/^\s*stalled: (?!reason)[a-zA-Z]+,\s*$/.test(line) && !/stall_class:/.test(window)) {
      offenders.push(`L${index + 1} 写 stalled 没带 stall_class`);
    }
    if (/\.stalled = undefined;\s*$/.test(line) && !/stall_class = undefined/.test(window)) {
      offenders.push(`L${index + 1} 清 stalled 没清 stall_class`);
    }
    if (/delete [\w.!]+\.stalled;\s*$/.test(line) && !/delete [\w.!]+\.stall_class/.test(window)) {
      offenders.push(`L${index + 1} delete stalled 没 delete stall_class`);
    }
  });
  assert.deepEqual(offenders, []);
});
