import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTaskFocus } from "../src/taskFocus.ts";

test("任务焦点:人工决定明确说明数量与放行后的动作", () => {
  const result = projectTaskFocus({
    status: "waiting_for_human",
    waiting: { question: { questions: [{}, {}, {}] } },
  });
  assert.deepEqual(result, {
    kind: "human_action",
    headline: "需要确认 3 个决策项",
    next_action: "提交决定后 Agent 自动继续",
    owner: "responsible",
    needs_attention: true,
    priority: 100,
  });
});

test("跨仓主任务在子任务推进期间保持活动，并把异常指向责任人", () => {
  const progressing = projectTaskFocus({
    status: "coordinating",
    detail: "1/3 个子任务已完成，其余正在推进",
    requirement_graph: { repositories: [
      { task_status: "completed" }, { task_status: "running" },
      { task_status: "queued" },
    ] },
  });
  assert.equal(progressing.kind, "machine");
  assert.equal(progressing.needs_attention, false);
  const canceled = projectTaskFocus({
    status: "coordinating",
    detail: "1/3 个子任务已完成，1 个已取消，其余正在推进",
    requirement_graph: { repositories: [
      { task_status: "completed" }, { task_status: "canceled" },
      { task_status: "queued" },
    ] },
  });
  assert.equal(canceled.needs_attention, false,
    "取消的子任务不应持续提示责任人处理");

  const attention = projectTaskFocus({
    status: "coordinating",
    detail: "1/3 个子任务已完成，1 个需要处理",
    requirement_graph: { repositories: [
      { task_status: "completed" }, { task_status: "failed" },
      { task_status: "queued" },
    ] },
  });
  assert.equal(attention.kind, "human_action");
  assert.equal(attention.needs_attention, true);
  assert.match(attention.next_action, /异常子任务/);
});

test("任务焦点:机器修复、平台验证与跨仓依赖不会冒充人工待办", () => {
  const repair = projectTaskFocus({
    status: "verifying",
    delivery: { loop: { state: "repairing", round: 2 } },
  });
  assert.equal(repair.headline, "Agent 正在修复流水线问题");
  assert.equal(repair.owner, "agent");
  assert.equal(repair.needs_attention, false);

  const pipeline = projectTaskFocus({
    status: "verifying",
    delivery: { waiting_on: "等待权威流水线返回 UT 结果" },
  });
  assert.equal(pipeline.headline, "等待权威流水线返回 UT 结果");
  assert.equal(pipeline.owner, "platform");

  const dependency = projectTaskFocus({
    status: "queued",
    blocked_by: ["task-2", "task-3"],
  });
  assert.equal(dependency.headline, "等待 2 个前置任务完成");
  assert.equal(dependency.needs_attention, false);
});

test("任务焦点:await_merge 是明确的人类行动，不藏进自动推进", () => {
  const waiting = projectTaskFocus({
    status: "await_merge",
    delivery: {
      mr_state: "等待合入",
      waiting_on: "等检视人确认已回复的意见",
    },
  });
  assert.equal(waiting.kind, "human_action");
  assert.equal(waiting.headline, "等检视人确认已回复的意见");
  assert.equal(waiting.owner, "responsible");
  assert.equal(waiting.needs_attention, true);
  assert.match(waiting.next_action, /打开 MR/);

  const closed = projectTaskFocus({
    status: "await_merge",
    delivery: {
      mr_state: "已关闭",
      waiting_on: "MR 已关闭，请重新打开或由任务责任人主动停止任务",
    },
  });
  assert.match(closed.next_action, /重新打开.*停止/);
  assert.equal(closed.needs_attention, true);
});

test("任务焦点:证据重试是平台动作，预算耗尽才进入人的行动收件箱", () => {
  const retrying = projectTaskFocus({
    status: "verifying",
    delivery: {
      waiting_on: "正在重试取证",
      evidence_gap: { state: "retrying", missing_dimensions: ["UT"] },
    },
  });
  assert.equal(retrying.owner, "platform");
  assert.equal(retrying.needs_attention, false);

  const waiting = projectTaskFocus({
    status: "verifying",
    delivery: {
      evidence_gap: {
        state: "waiting_human",
        missing_dimensions: ["COMPILE", "CODECHECK"],
      },
    },
  });
  assert.equal(waiting.kind, "human_action");
  assert.equal(waiting.owner, "responsible");
  assert.equal(waiting.needs_attention, true);
  assert.match(waiting.next_action, /证据缺口.*批注/);
});

test("修复会话结束后以当前 prepush 为焦点，不再同时声称仍在修复", () => {
  const task = {
    status: "verifying" as const,
    delivery: {
      loop: { state: "verifying", round: 2 },
      prepush: { state: "compiling", round: 3, message: "C++ 编译到 24%" },
    },
  };
  const result = projectTaskFocus(task);
  assert.equal(result.headline, "C++ 编译到 24%");
  assert.equal(result.next_action, "记录本次验证结果后继续当前工作");
});

test("prepush 领域态与进程活性分开：无 owner 时不再谎报正在编译", () => {
  const interrupted = projectTaskFocus({
    status: "verifying",
    delivery: {
      prepush: { state: "preparing", message: "正在准备编译" },
      prepush_runtime: {
        state: "interrupted",
        message: "上次验证已中断，当前没有执行会话",
      },
    },
  });
  assert.equal(interrupted.kind, "blocked");
  assert.equal(interrupted.needs_attention, true);
  assert.match(interrupted.headline, /中断.*没有执行会话/);

  const recovering = projectTaskFocus({
    status: "verifying",
    delivery: {
      prepush: { state: "preparing", message: "旧阶段文案" },
      prepush_runtime: { state: "recovering", message: "服务正在恢复验证" },
    },
  });
  assert.equal(recovering.kind, "machine");
  assert.equal(recovering.headline, "服务正在恢复验证");
});

test("任务焦点:失败、暂停和预推送环境故障诚实进入关注队列", () => {
  const failed = projectTaskFocus({ status: "failed", detail: "模型网关不可用" });
  assert.equal(failed.kind, "blocked");
  assert.equal(failed.headline, "模型网关不可用");

  const paused = projectTaskFocus({ status: "paused" });
  assert.equal(paused.needs_attention, true);
  assert.match(paused.next_action, /恢复/);

  const environment = projectTaskFocus({
    status: "running",
    delivery: { prepush: { state: "environment_error", message: "Maven 仓库不可达" } },
  });
  assert.equal(environment.kind, "blocked");
  assert.equal(environment.owner, "platform");
  assert.match(environment.next_action, /编译环境/);
});

test("任务焦点:运行态使用内核同源步骤，不自造流程阶段", () => {
  const result = projectTaskFocus({
    status: "running",
    progress: { current_phase: "编码实现", step: "实现订单校验" },
  });
  assert.equal(result.headline, "Agent 正在推进：实现订单校验");
  assert.equal(result.kind, "machine");
});

test("任务焦点:排队真相压过陈旧 detail,并报出位次", () => {
  // 实锤:并发 2 跑 3 单,重跑后的排队单拿 detail("人工重跑…")当
  // 标题,三单看起来都在推进,没人知道谁在排队。
  const queued = projectTaskFocus({
    status: "queued",
    queue_position: 1,
    detail: "人工重跑,续接内核当前步骤",
  });
  assert.equal(queued.headline, "排队等待执行资源(第 1 位)");
  assert.equal(queued.next_action, "人工重跑,续接内核当前步骤");

  const noPosition = projectTaskFocus({ status: "queued" });
  assert.equal(noPosition.headline, "任务正在执行队列中等待");
});

test("检视返工不冒充流水线修复(MFC-023)", () => {
  const focus = projectTaskFocus({
    status: "running",
    delivery: { loop: { state: "repairing", kind: "review", round: 0 } },
  });
  assert.match(focus.headline, /按检视意见修改/);
  assert.doesNotMatch(focus.headline, /流水线/,
    "kind=review 时代码还没推,没有任何流水线在跑");
});

test("流水线修复播报保持原样(kind=ci)", () => {
  const focus = projectTaskFocus({
    status: "running",
    delivery: { loop: { state: "repairing", kind: "ci", round: 1, max: 2 } },
  });
  assert.match(focus.headline, /修复流水线问题/);
});

test("重启恢复中的 Build-Fix 压过旧的 halted 展示，但不伪造人工闭环", () => {
  const focus = projectTaskFocus({
    status: "verifying",
    delivery: {
      loop: {
        state: "halted", kind: "review", round: 0, max: 20,
        diagnosis: "部署前留下的旧停机原因",
      },
      prepush: { state: "preparing", round: 1, message: "准备定向验证" },
      prepush_runtime: {
        state: "recovering", message: "服务正在恢复上次中断的 Build-Fix",
      },
    },
  });
  assert.equal(focus.kind, "machine");
  assert.equal(focus.owner, "agent");
  assert.equal(focus.needs_attention, false);
  assert.match(focus.headline, /恢复.*Build-Fix/);
  assert.doesNotMatch(focus.headline, /停止|人工/);
});

test("助手占场的暂停指去交还入口,不指死路恢复(MFC-029)", () => {
  const focus = projectTaskFocus({
    status: "paused", assistant_engaged: true,
  });
  assert.match(focus.headline, /开发助手/);
  assert.match(focus.next_action, /交回给 Agent/);
  const plain = projectTaskFocus({ status: "paused" });
  assert.match(plain.next_action, /恢复/);
});

test("从未起跑的 failed 单指向重新下单,不指无效重跑(MFC-025)", () => {
  const focus = projectTaskFocus({
    status: "failed",
    detail: "Error: 仓库克隆失败：代码仓基线「no-such-branch」不存在或不可访问",
  });
  assert.match(focus.next_action, /重新发起/,
    "克隆期配置错,重跑一百次也一样");
  const started = projectTaskFocus({
    status: "failed", detail: "会话中断",
    progress: { current_phase: "写代码", step: "自由实现" },
  });
  assert.match(started.next_action, /按原流程重试/);
});

test("按需验证历史失败不遮盖已继续交付或完成的当前事实", () => {
  for (const status of ["verifying", "await_merge", "completed", "canceled"] as const) {
    const current = projectTaskFocus({ status });
    const withHistory = projectTaskFocus({ status,
      delivery: { prepush: { state: "environment_error", message: "历史编译环境故障" } },
    });
    assert.deepEqual(withHistory, current);
  }
});
