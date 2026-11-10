/**
 * 状态短文案与"需介入"的推断表(src/taskFocus.ts)。2026-09-06 从前端
 * api.ts 搬到服务端:前端不推断状态,这两样以前却各在浏览器里拼一份。
 * 每一行是原来 api.ts 里的一条分支或一条踩过的坑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATUS_TEXT, deliveryStopped, projectRepairStopped, projectStatusLabel,
} from "../src/taskFocus.ts";

test("状态短文案:Build-Fix 活性 > 修复环状态 > 状态词表;检视返工不把第 0 轮说成流水线修复", () => {
  assert.equal(projectStatusLabel({ status: "running" }), "进行中");
  assert.equal(projectStatusLabel({ status: "verifying" }), "代码已提交,流水线验证中");
  assert.equal(projectStatusLabel({ status: "mystery" }), "mystery", "未知状态原样返回,不猜");
  assert.equal(projectStatusLabel({
    status: "running",
    delivery: { loop: { state: "repairing", kind: "review", round: 0, max: 2 } },
  }), "正在按检视意见修改");
  assert.equal(projectStatusLabel({
    status: "running",
    delivery: { loop: { state: "repairing", kind: "ci", round: 0, max: 2 } },
  }), "正在按检视意见修改", "round=0 是内部状态,不能作为'第 0 轮'暴露");
  assert.equal(projectStatusLabel({
    status: "verifying",
    delivery: { loop: { state: "repairing", kind: "ci", round: 1, max: 2 } },
  }), "流水线修复中");
  assert.equal(projectStatusLabel({ status: "verifying", delivery: { loop: { state: "verifying" } } }),
    "修复结果验证中");
  assert.equal(projectStatusLabel({ status: "verifying", delivery: { loop: { state: "halted" } } }),
    "自动修复已停,需人工");
  assert.equal(projectStatusLabel({ status: "verifying", delivery: { loop: { state: "exhausted" } } }),
    "修复预算用完,需人工");
  assert.equal(projectStatusLabel({ status: "waiting_for_human", delivery: { loop: { state: "halted" } } }),
    "等你决定", "人工节点永远压过修复环文案");
  assert.equal(projectStatusLabel({ status: "failed", delivery: { loop: { state: "repairing", round: 1 } } }),
    "出错了", "出错压过修复环文案");
  assert.equal(projectStatusLabel({
    status: "verifying",
    delivery: { loop: { state: "halted" }, prepush_runtime: { state: "recovering" } },
  }), "Build-Fix 恢复中", "服务正在自救时旧的停机牌不算数");
  assert.equal(projectStatusLabel({
    status: "running", delivery: { prepush_runtime: { state: "running" } },
  }), "Build-Fix 进行中");
  assert.equal(projectStatusLabel({
    status: "paused", delivery: { prepush_runtime: { state: "running" } },
  }), "已暂停", "只有 queued/running/verifying 才被 Build-Fix 活性改写");
  assert.equal(Object.keys(TASK_STATUS_TEXT).length, 11);
});

test("需介入:只有 verifying 且机器确实停了;Build-Fix 在跑/在恢复时不算;retry 准入同源", () => {
  assert.equal(projectRepairStopped({ status: "verifying", delivery: { loop: { state: "halted" } } }), true);
  assert.equal(projectRepairStopped({ status: "verifying", delivery: { loop: { state: "exhausted" } } }), true);
  assert.equal(projectRepairStopped({ status: "verifying", delivery: { stalled: "宿主推送失败" } }), true,
    "外部验证自愈预算烧完如实停下:同样是机器停了该人上");
  assert.equal(projectRepairStopped({ status: "verifying", delivery: { pipeline: "轮询预算耗尽" } }), true);
  assert.equal(projectRepairStopped({ status: "verifying", delivery: { loop: { state: "repairing" } } }), false);
  assert.equal(projectRepairStopped({ status: "running", delivery: { loop: { state: "halted" } } }), false,
    "不在 verifying 就不是这块牌子");
  assert.equal(projectRepairStopped({
    status: "verifying",
    delivery: { loop: { state: "halted" }, prepush_runtime: { state: "recovering" } },
  }), false, "Build-Fix 已恢复运行时不再显示旧的自动修复停机");
  assert.equal(projectRepairStopped({
    status: "verifying",
    delivery: { stalled: "x", prepush_runtime: { state: "running" } },
  }), false);
  assert.equal(deliveryStopped(undefined), false);
  assert.equal(deliveryStopped({ loop: { state: "halted" } }), true);
});
