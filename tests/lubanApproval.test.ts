/** 小鲁班插件纯文本审批：验签、本人隔离、审批码、过期与幂等。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { WaitingRecord } from "../src/humanGate.ts";
import {
  loadLubanPluginToken,
  lubanApprovalCode,
  LubanApprovalGateway,
  type LubanApprovalService,
} from "../src/lubanApproval.ts";
import { createTaskServer } from "../src/server.ts";
import {
  TaskService,
  type TaskSummary,
} from "../src/taskService.ts";
import { Notifier } from "../src/notifier.ts";

const TOKEN = "test-luban-plugin-token-32-bytes-minimum";
const NOW = 1_800_000_000_000;

function waiting(
  taskId: string,
  questions: Array<{ question: string; options?: string[] }>,
  version = 1,
): WaitingRecord {
  return {
    waiting_id: `${taskId}:call-1`, task_id: taskId,
    step: "delivery_review", call_id: "call-1",
    question: { questions }, context: "编译与 UT 已通过，请核对本轮改动。",
    state_version: version, status: "waiting", decision: "", notes: "",
    created_at: "2026-08-23T00:00:00.000Z", resolved_at: "",
  };
}

function task(
  id: string,
  account: string,
  title: string,
  record = waiting(id, [{ question: "Diff 通过吗？", options: ["通过", "打回"] }]),
): TaskSummary {
  return {
    id, title, requirement: title, status: "waiting_for_human",
    waiting: record, luban_account: account,
    workspace: `/tmp/${id}`, created_at: "2026-08-23T00:00:00.000Z",
  };
}

class FakeApprovalService implements LubanApprovalService {
  calls: Array<{
    id: string;
    decision?: string;
    answers?: Record<string, string>;
    notes?: string;
  }> = [];

  constructor(readonly tasks: TaskSummary[]) {}

  list(): TaskSummary[] {
    return this.tasks;
  }

  async decide(id: string, input: {
    state_version: number;
    selected_options?: Record<string, string>;
    free_responses?: Record<string, string>;
    comment?: string;
  }): Promise<TaskSummary> {
    const found = this.tasks.find((item) => item.id === id)!;
    if (found.status !== "waiting_for_human" || !found.waiting
        || found.waiting.state_version !== input.state_version) {
      throw new Error("任务状态已变化");
    }
    const answers = {
      ...input.selected_options,
      ...input.free_responses,
    };
    const values = Object.values(answers);
    this.calls.push({
      id,
      ...(values.length === 1 ? { decision: values[0] } : { answers }),
      notes: input.comment,
    });
    found.status = "running";
    found.waiting = undefined;
    return found;
  }
}

function callback(
  gateway: LubanApprovalGateway,
  body: Record<string, unknown>,
  token = TOKEN,
) {
  const rawBody = JSON.stringify(body);
  return gateway.handle({
    rawBody,
    token,
  });
}

function codeOf(text: string): string {
  const match = text.match(/【([A-F0-9]{10})】/);
  assert.ok(match, `没有找到审批码：${text}`);
  return match[1];
}

function gateway(service: FakeApprovalService): LubanApprovalGateway {
  return new LubanApprovalGateway(service, {
    token: TOKEN, now: () => NOW,
    accountEnabled: (account) => ["alice", "bob"].includes(account),
  });
}

test("唯一待办首次查询直接展示完整详情，裸序号提交当前选项", async () => {
  const service = new FakeApprovalService([
    task("task-1", "alice", "支付接口修复"),
    task("task-2", "bob", "不能泄露给 Alice 的任务"),
  ]);
  const entry = gateway(service);
  const listed = await callback(entry, {
    message_id: "m-1", sender: "alice", content: "mae-flow 待审批",
  });
  assert.equal(listed.status, 200);
  assert.match(listed.text, /支付接口修复/);
  assert.doesNotMatch(listed.text, /不能泄露/);
  assert.match(listed.text, /编译与 UT 已通过/);
  assert.match(listed.text, /1\. 通过/);
  assert.match(listed.text, /直接选择：回复序号/);

  const code = codeOf(listed.text);
  const detail = await callback(entry, {
    message_id: "m-2", sender: "alice", content: `mae-flow 详情 ${code}`,
  });
  assert.equal(detail.status, 200);
  assert.match(detail.text, /编译与 UT 已通过/);
  assert.match(detail.text, /1\. 通过/);
  assert.match(detail.text, new RegExp(`mae-flow 选择 ${code}`));

  const chosen = await callback(entry, {
    message_id: "m-bare-choice", sender: "alice", content: "1",
  });
  assert.equal(chosen.status, 200);
  assert.deepEqual(service.calls, [{
    id: "task-1", decision: "通过", notes: "小鲁班手机审批",
  }]);

  service.tasks[0].status = "waiting_for_human";
  service.tasks[0].waiting = waiting("task-1", [{
    question: "新一轮 Diff 通过吗？", options: ["通过", "打回"],
  }], 2);
  service.tasks[0].waiting!.state_version += 1;
  const stale = await callback(entry, {
    message_id: "m-3", sender: "alice", content: `mae-flow 详情 ${code}`,
  });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /已更新|已过期/);
});

test("唯一待办通知建立审批上下文：先 /mfc 激活再回复序号", async () => {
  const service = new FakeApprovalService([
    task("task-notified", "alice", "支付接口修复"),
  ]);
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: (input) => lubanApprovalCode({ token: TOKEN, ...input }),
    backoffMs: [],
  });
  const notice = await notifier.notifyWaiting({
    waitingId: service.tasks[0].waiting!.waiting_id,
    stateVersion: service.tasks[0].waiting!.state_version,
    taskId: service.tasks[0].id,
    subject: service.tasks[0].title,
    account: "alice",
    step: service.tasks[0].waiting!.step,
    questions: (service.tasks[0].waiting!.question as any).questions,
    link: "http://intranet/work/task-notified",
  });
  assert.match(notice.text,
    /先输入“\/mfc”激活 Mae-Flow 插件[\s\S]*插件激活后，只有这一项待办时，可回复选项序号/);

  const entry = new LubanApprovalGateway(service, {
    token: TOKEN,
    accountEnabled: () => true,
    recentNotification: (account) => notifier.latestApproval(account),
  });
  const chosen = await callback(entry, {
    message_id: "notification-bare-choice", sender: "alice", content: "2",
  });

  assert.equal(chosen.status, 200);
  assert.deepEqual(service.calls, [{
    id: "task-notified", decision: "打回", notes: "小鲁班手机审批",
  }]);
});

test("通知后的裸序号仍核对版本，多待办时拒绝猜任务", async () => {
  const first = task("task-first", "alice", "第一项");
  const second = task("task-second", "alice", "第二项");
  const service = new FakeApprovalService([first, second]);
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: (input) => lubanApprovalCode({ token: TOKEN, ...input }),
    backoffMs: [],
  });
  await notifier.notifyWaiting({
    waitingId: first.waiting!.waiting_id,
    stateVersion: first.waiting!.state_version,
    taskId: first.id,
    account: "alice",
    step: first.waiting!.step,
    questions: (first.waiting!.question as any).questions,
    link: "http://intranet/work/task-first",
  });
  const entry = new LubanApprovalGateway(service, {
    token: TOKEN,
    accountEnabled: () => true,
    recentNotification: (account) => notifier.latestApproval(account),
  });

  const ambiguous = await callback(entry, {
    message_id: "notification-ambiguous", sender: "alice", content: "1",
  });
  assert.equal(ambiguous.status, 400);
  assert.match(ambiguous.text, /2 项待审批|审批码/);
  assert.equal(service.calls.length, 0);

  second.status = "running";
  first.waiting!.state_version += 1;
  const stale = await callback(entry, {
    message_id: "notification-stale", sender: "alice", content: "1",
  });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /已更新|已过期/);
  assert.equal(service.calls.length, 0);
});

test("多项待办先用裸序号选任务，再用裸序号审批", async () => {
  const service = new FakeApprovalService([
    task("task-1", "alice", "支付接口修复"),
    task("task-2", "alice", "订单接口修复"),
  ]);
  const entry = gateway(service);
  const listed = await callback(entry, {
    message_id: "many-tasks", sender: "alice", content: "待审批",
  });
  assert.match(listed.text, /1\. task-1/);
  assert.match(listed.text, /2\. task-2/);
  assert.doesNotMatch(listed.text, /审批上下文/);

  const selected = await callback(entry, {
    message_id: "select-task", sender: "alice", content: "2",
  });
  assert.match(selected.text, /task-2/);
  assert.match(selected.text, /审批上下文/);

  const approved = await callback(entry, {
    message_id: "select-option", sender: "alice", content: "1",
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(service.calls, [{
    id: "task-2", decision: "通过", notes: "小鲁班手机审批",
  }]);
});

test("自然语言确认与修改意见安全路由到当前单题", async () => {
  const approveService = new FakeApprovalService([task(
    "task-confirm", "alice", "确认范围",
    waiting("task-confirm", [{
      question: "是否确认修改范围？",
      options: ["确认范围并继续", "需要修改"],
    }]),
  )]);
  const approveEntry = gateway(approveService);
  await callback(approveEntry, {
    message_id: "confirm-list", sender: "alice", content: "mae-flow 待审批",
  });
  const confirmed = await callback(approveEntry, {
    message_id: "confirm-natural", sender: "alice", content: "确认，可以继续",
  });
  assert.equal(confirmed.status, 200);
  assert.equal(approveService.calls[0].decision, "确认范围并继续");

  const reviseService = new FakeApprovalService([task(
    "task-revise", "alice", "确认范围",
    waiting("task-revise", [{
      question: "是否确认修改范围？",
      options: ["确认范围并继续", "需要修改"],
    }]),
  )]);
  const reviseEntry = gateway(reviseService);
  await callback(reviseEntry, {
    message_id: "revise-list", sender: "alice", content: "待审批",
  });
  const revised = await callback(reviseEntry, {
    message_id: "revise-natural", sender: "alice",
    content: "README 注释请改成 [maven-test]",
  });
  assert.equal(revised.status, 200);
  assert.equal(reviseService.calls[0].decision, "需要修改");
  assert.match(reviseService.calls[0].notes!, /README 注释请改成/);
});

test("开放题支持裸自然语言，自定义回答不要求审批码", async () => {
  const service = new FakeApprovalService([task(
    "task-open", "alice", "补充说明",
    waiting("task-open", [{ question: "请说明期望的兼容范围" }]),
  )]);
  const entry = gateway(service);
  await callback(entry, {
    message_id: "open-list", sender: "alice", content: "待审批",
  });
  const result = await callback(entry, {
    message_id: "open-answer", sender: "alice",
    content: "兼容 2.3 及以上版本，不兼容旧协议",
  });
  assert.equal(result.status, 200);
  assert.equal(service.calls[0].decision, "兼容 2.3 及以上版本，不兼容旧协议");
});

test("裸回复只在短期当前卡上生效，卡片变化后拒绝旧上下文", async () => {
  let now = NOW;
  const service = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const entry = new LubanApprovalGateway(service, {
    token: TOKEN, now: () => now, accountEnabled: () => true,
  });
  await callback(entry, {
    message_id: "cursor-list", sender: "alice", content: "待审批",
  });
  service.tasks[0].waiting!.state_version += 1;
  const stale = await callback(entry, {
    message_id: "cursor-stale", sender: "alice", content: "1",
  });
  assert.equal(stale.status, 409);
  assert.equal(service.calls.length, 0);

  await callback(entry, {
    message_id: "cursor-refresh", sender: "alice", content: "待审批",
  });
  now += 10 * 60_000 + 1;
  const expired = await callback(entry, {
    message_id: "cursor-expired", sender: "alice", content: "1",
  });
  assert.equal(expired.status, 400);
  assert.match(expired.text, /先发送.*待审批/);
  assert.equal(service.calls.length, 0);
});

test("选择与退回始终提交选项原文；同 message_id 并发/重放不重复决定", async () => {
  const service = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const entry = gateway(service);
  const listed = await callback(entry, {
    message_id: "list", sender: "alice", content: "mae-flow 待审批",
  });
  const code = codeOf(listed.text);
  const body = { message_id: "approve-1", sender: "alice", content: `mae-flow 通过 ${code}` };
  const [first, repeated] = await Promise.all([
    callback(entry, body), callback(entry, body),
  ]);
  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(service.calls, [{
    id: "task-1", decision: "通过", notes: "小鲁班手机审批",
  }]);

  const rejectService = new FakeApprovalService([task("task-3", "alice", "异常补充")]);
  const rejectEntry = gateway(rejectService);
  const rejectCode = codeOf((await callback(rejectEntry, {
    message_id: "list-2", sender: "alice", content: "mae-flow 待审批",
  })).text);
  const noReason = await callback(rejectEntry, {
    message_id: "reject-empty", sender: "alice", content: `mae-flow 退回 ${rejectCode}`,
  });
  assert.equal(noReason.status, 400);
  const rejected = await callback(rejectEntry, {
    message_id: "reject", sender: "alice",
    content: `mae-flow 退回 ${rejectCode} 请补充异常场景`,
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejectService.calls[0].decision, "打回");
  assert.match(rejectService.calls[0].notes!, /请补充异常场景/);
});

test("固定 Token、账号与消息 ID 冲突均 fail-closed", async () => {
  const service = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const entry = gateway(service);
  const bad = await callback(entry, {
    message_id: "bad", sender: "alice", content: "mae-flow 待审批",
  }, "wrong-token-that-is-long-enough-but-still-wrong");
  assert.equal(bad.status, 401);

  const disabled = await callback(entry, {
    message_id: "disabled", sender: "mallory", content: "mae-flow 待审批",
  });
  assert.equal(disabled.status, 403);

  const first = await callback(entry, {
    message_id: "same", sender: "alice", content: "mae-flow 待审批",
  });
  assert.equal(first.status, 200);
  const collision = await callback(entry, {
    message_id: "same", sender: "alice", content: "mae 帮助",
  });
  assert.equal(collision.status, 409);
});

test("多题澄清按当前题逐题记录，全部答完后一次提交", async () => {
  const service = new FakeApprovalService([task(
    "task-many", "alice", "多题澄清",
    waiting("task-many", [
      { question: "兼容旧接口吗？", options: ["兼容", "不兼容"] },
      { question: "需要灰度吗？", options: ["需要", "不需要"] },
      { question: "请填写灰度观察时长" },
    ]),
  )]);
  const entry = gateway(service);
  const listed = await callback(entry, {
    message_id: "many-list", sender: "alice", content: "mae-flow 待审批",
  });
  const code = codeOf(listed.text);
  assert.match(listed.text, /共 3 个问题/);
  assert.match(listed.text, /兼容旧接口吗/);
  assert.doesNotMatch(listed.text, /需要灰度吗/,
    "多题卡首次只显示当前一题");
  assert.doesNotMatch(listed.text, /灰度观察时长/);

  const first = await callback(entry, {
    message_id: "many-choose", sender: "alice", content: "1",
  });
  assert.equal(first.status, 200);
  assert.match(first.text, /已记录问题 1\/3：兼容/);
  assert.match(first.text, /尚未提交/);
  assert.match(first.text, /问题 2\/3：需要灰度吗/);
  assert.equal(service.calls.length, 0);

  const back = await callback(entry, {
    message_id: "many-back", sender: "alice", content: "重答上一题",
  });
  assert.match(back.text, /已撤销问题 1 的原答案/);
  assert.match(back.text, /问题 1\/3：兼容旧接口吗/);
  assert.equal(service.calls.length, 0);

  const firstAgain = await callback(entry, {
    message_id: "many-first-again", sender: "alice", content: "1",
  });
  assert.match(firstAgain.text, /已记录问题 1\/3：兼容/);

  const resumed = await callback(entry, {
    message_id: "many-resume", sender: "alice",
    content: `mae-flow 详情 ${code}`,
  });
  assert.match(resumed.text, /已记录 1 个/);
  assert.match(resumed.text, /请继续回答问题 2/);

  const second = await callback(entry, {
    message_id: "many-second", sender: "alice",
    content: `mae-flow 选择 ${code} 2`,
  });
  assert.equal(second.status, 200);
  assert.match(second.text, /已记录问题 2\/3：不需要/);
  assert.match(second.text, /问题 3\/3：请填写灰度观察时长/);
  assert.equal(service.calls.length, 0);

  const third = await callback(entry, {
    message_id: "many-third", sender: "alice",
    content: `mae-flow 回复 ${code} 30 分钟`,
  });
  assert.equal(third.status, 200);
  assert.match(third.text, /已提交，Agent 已继续/);
  assert.match(third.text, /已处理 3 个问题/);
  assert.deepEqual(service.calls, [{
    id: "task-many",
    answers: {
      "兼容旧接口吗？": "兼容",
      "需要灰度吗？": "不需要",
      "请填写灰度观察时长": "30 分钟",
    },
    notes: "小鲁班手机审批",
  }]);
});

test("全选项多题可一次回复序号，补充说明与流程选项分离", async () => {
  const batchService = new FakeApprovalService([task(
    "task-batch", "alice", "批量选择",
    waiting("task-batch", [
      { question: "兼容旧接口吗？", options: ["兼容", "不兼容"] },
      { question: "需要灰度吗？", options: ["需要", "不需要"] },
      { question: "观察多久？", options: ["30 分钟", "2 小时"] },
    ]),
  )]);
  const batchEntry = gateway(batchService);
  const batchDetail = await callback(batchEntry, {
    message_id: "batch-list", sender: "alice", content: "待审批",
  });
  assert.match(batchDetail.text, /一次回复剩余各题的选项序号/);
  const batch = await callback(batchEntry, {
    message_id: "batch-answer", sender: "alice", content: "1/2/1",
  });
  assert.equal(batch.status, 200);
  assert.match(batch.text, /已处理 3 个问题/);
  assert.deepEqual(batchService.calls[0].answers, {
    "兼容旧接口吗？": "兼容",
    "需要灰度吗？": "不需要",
    "观察多久？": "30 分钟",
  });

  const freeService = new FakeApprovalService([task(
    "task-free", "alice", "自由意见",
    waiting("task-free", [
      { question: "兼容策略？", options: ["兼容", "不兼容"] },
      { question: "灰度策略？", options: ["需要", "不需要"] },
    ]),
  )]);
  const freeEntry = gateway(freeService);
  const freeDetail = await callback(freeEntry, {
    message_id: "free-list", sender: "alice", content: "待审批",
  });
  assert.match(freeDetail.text, /选择并说明：回复“序号：你的说明”/);
  const freeFirst = await callback(freeEntry, {
    message_id: "free-first", sender: "alice",
    content: "我选兼容，但只保证 2.3 以上版本",
  });
  assert.match(freeFirst.text, /已记录问题 1\/2：兼容/);
  assert.match(freeFirst.text, /具体意见已保留.*只保证 2\.3/);
  const freeSecond = await callback(freeEntry, {
    message_id: "free-second", sender: "alice",
    content: "2: 当前流量太小，暂不灰度",
  });
  assert.equal(freeSecond.status, 200);
  assert.match(freeSecond.text, /具体说明已一并保留/);
  assert.deepEqual(freeService.calls[0].answers, {
    "兼容策略？": "兼容",
    "灰度策略？": "不需要",
  });
  assert.match(freeService.calls[0].notes!, /只保证 2\.3 以上版本/);
  assert.match(freeService.calls[0].notes!, /当前流量太小，暂不灰度/);

  const customService = new FakeApprovalService([task(
    "task-custom", "alice", "自定义答案",
    waiting("task-custom", [{
      question: "采用哪个方案？", options: ["方案 A", "方案 B"],
    }]),
  )]);
  const customEntry = gateway(customService);
  await callback(customEntry, {
    message_id: "custom-list", sender: "alice", content: "待审批",
  });
  const custom = await callback(customEntry, {
    message_id: "custom-answer", sender: "alice",
    content: "先做最小灰度验证，再根据数据决定方案",
  });
  assert.equal(custom.status, 400);
  assert.match(custom.text, /尚未记录/);
  assert.equal(customService.calls.length, 0);
  const explicitCustom = await callback(customEntry, {
    message_id: "custom-explicit", sender: "alice",
    content: "自由回复：先做最小灰度验证，再根据数据决定方案",
  });
  assert.equal(explicitCustom.status, 200);
  assert.match(explicitCustom.text, /已提交，Agent 已继续/);
  assert.deepEqual(customService.calls[0].decision,
    "先做最小灰度验证，再根据数据决定方案");
});

test("通过快捷命令绝不把“不通过”当成正向选项", async () => {
  const service = new FakeApprovalService([task(
    "task-negative", "alice", "负向措辞",
    waiting("task-negative", [{
      question: "是否放行？", options: ["不通过", "稍后处理"],
    }]),
  )]);
  const entry = gateway(service);
  const code = codeOf((await callback(entry, {
    message_id: "negative-list", sender: "alice", content: "mae-flow 待审批",
  })).text);
  const result = await callback(entry, {
    message_id: "negative-pass", sender: "alice", content: `mae-flow 通过 ${code}`,
  });
  assert.equal(result.status, 400);
  assert.match(result.text, /无法安全判断/);
  assert.equal(service.calls.length, 0);
});

test("HTTP 回调复用主服务端口且不需要浏览器 Cookie", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-luban-http-"));
  const taskService = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const approvalService = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const logs: string[] = [];
  const entry = new LubanApprovalGateway(approvalService, {
    token: TOKEN,
    accountEnabled: () => true,
    log: (message) => logs.push(message),
  });
  const server = createTaskServer(taskService, { lubanApproval: entry });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rawBody = JSON.stringify({
      message_id: "http-1", sender: "alice", content: "mae-flow 待审批",
    });
    const response = await fetch(`${base}/integrations/luban/plugin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mfc-luban-plugin-token": TOKEN,
      },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { text: string };
    assert.match(result.text, /支付修复/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /sender=alice/);
    assert.match(logs[0], /status=200/);
    assert.doesNotMatch(logs[0], /http-1|mae-flow 待审批|test-luban-plugin-token/,
      "回调审计不能记录消息原文、原始 ID 或 Token");

    const unsigned = await fetch(`${base}/integrations/luban/plugin`, {
      method: "POST", body: rawBody,
    });
    assert.equal(unsigned.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("插件 Token 文件必须足够长且权限为 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-luban-token-"));
  const file = join(dir, "plugin.token");
  writeFileSync(file, TOKEN);
  chmodSync(file, 0o600);
  assert.equal(loadLubanPluginToken(file), TOKEN);
  chmodSync(file, 0o644);
  assert.throws(() => loadLubanPluginToken(file), /0600/);
});

test("启用手机入口后，待办通知说明会话式审批方式", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: () => "A1B2C3D4E5",
    backoffMs: [],
  });
  const record = await notifier.notifyWaiting({
    waitingId: "waiting-1", stateVersion: 1,
    taskId: "task-1", account: "alice",
    subject: "问题单 DTS20260824001（task-1）", step: "spec_review",
    questions: [
      { question: "Diff 通过吗？", options: ["通过", "打回"] },
      { question: "需要灰度吗？", options: ["需要", "不需要"] },
    ],
    link: "http://intranet/work/task-1",
  });
  assert.match(record.text, /问题单 DTS20260824001/);
  assert.match(record.text, /Diff 通过吗/);
  assert.doesNotMatch(record.text, /需要灰度吗/);
  assert.doesNotMatch(record.text, /spec_review/);
  assert.match(record.text, /方案确认/);
  assert.match(record.text, /先输入“\/mfc”激活 Mae-Flow 插件/);
  assert.match(record.text, /插件激活后，只有这一项待办时，可回复选项序号/);
  assert.match(record.text, /多项待办或无上下文时：mae-flow 选择 A1B2C3D4E5 <序号>/);
});
