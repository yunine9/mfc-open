/**
 * 小鲁班通知语义(主 spec §9/§14.4):待办送达、失败退避重试且
 * 不改流程状态、同待办不重复通知。假小鲁班收什么记什么。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("发送成功:待办事实与审批链接送达账号;同待办幂等", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({ endpoint: luban.endpoint });
    const first = await notifier.notifyWaiting({
      waitingId: "T-1:c1", taskId: "T-1", account: "developer",
      step: "delivery_review", summary: "Diff 通过吗?",
      link: "http://x/tasks/T-1",
    });
    await until(() => (first.delivered ? true : undefined), "送达完成");
    const again = await notifier.notifyWaiting({
      waitingId: "T-1:c1", taskId: "T-1", account: "developer",
      step: "delivery_review", summary: "重复投递不应发生",
      link: "http://x/tasks/T-1",
    });
    assert.equal(again, first);
    assert.equal(luban.messages.length, 1);
    const message = luban.messages[0] as Record<string, string>;
    assert.equal(message.account, "developer");
    assert.match(message.text, /等你决定/);
    assert.match(message.text, /Diff 通过吗/);
    assert.match(message.text, /先输入“\/mfc”激活 Mae-Flow 插件/);
    assert.match(message.text, /未激活时，直接回复本消息不会进入 Mae-Flow/);
    assert.equal(message.link, "http://x/tasks/T-1");
  } finally {
    await luban.stop();
  }
});

test("人工意见修好后通知原作者复检；同一代码版本幂等且带 /mfc", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({ endpoint: luban.endpoint });
    const input = {
      taskId: "T-review-ready",
      senderAccount: "owner",
      account: "reviewer",
      summary: "Agent 已处理你提出的 2 条意见，请逐条确认。",
      link: "http://x/work/T-review-ready",
      revisionKey: "cycle-1-sha-a",
    };
    const first = await notifier.notifyReviewReady(input);
    const replay = await notifier.notifyReviewReady(input);
    assert.equal(replay, first);
    assert.equal(luban.messages.length, 1, "恢复重放不能重复轰炸检视人");
    assert.equal(first.account, "reviewer");
    assert.match(first.text, /Agent 已处理你提出的 2 条意见/);
    assert.match(first.text, /先输入“\/mfc”激活 Mae-Flow 插件/);

    await notifier.notifyReviewReady({
      ...input, revisionKey: "cycle-2-sha-b",
    });
    assert.equal(luban.messages.length, 2, "新一轮返工完成后必须重新提醒");
  } finally {
    await luban.stop();
  }
});

test("清空重跑会同时清除旧通知审批上下文", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: () => "A1B2C3D4E5",
    backoffMs: [],
  });
  await notifier.notifyWaiting({
    waitingId: "T-purge:c1", stateVersion: 1,
    taskId: "T-purge", account: "alice", step: "delivery_review",
    questions: [{ question: "Diff 通过吗？", options: ["通过", "打回"] }],
    link: "http://x/tasks/T-purge",
  });
  assert.equal(notifier.latestApproval("alice")?.waitingId, "T-purge:c1");

  notifier.purgeTask("T-purge");

  assert.equal(notifier.latestApproval("alice"), undefined);
});

test("清空重跑不让旧发送 Promise 占住同 ID 的新通知", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({
      endpoint: luban.endpoint,
      backoffMs: [40],
    });
    const input = {
      waitingId: "T-purge-live:c1", taskId: "T-purge-live",
      account: "alice", step: "delivery_review", summary: "请确认",
      link: "http://x/tasks/T-purge-live",
    };
    const oldDelivery = notifier.notifyWaiting(input);
    assert.equal(notifier.purgeTask("T-purge-live"), 1);
    const newDelivery = notifier.notifyWaiting(input);
    const [, fresh] = await Promise.all([oldDelivery, newDelivery]);
    assert.equal(fresh.delivered, true);
    assert.equal(fresh.settled, true);
    assert.equal(luban.messages.length, 2,
      "旧请求可自然收口，但新任务必须拥有自己的发送，不能借旧 Promise 假完成");
  } finally {
    await luban.stop();
  }
});

test("配置确认通知带出被确认内容；缺内容时禁止裸序号审批", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: () => "A1B2C3D4E5",
    backoffMs: [],
  });
  const complete = await notifier.notifyWaiting({
    waitingId: "T-config:complete", stateVersion: 1,
    taskId: "T-config", account: "alice", step: "config_confirm",
    context: [
      "需求单：REQ-20260826-01",
      "基线：master",
      "交付方式：完整开发 full",
    ].join("\n"),
    questions: [{
      question: "上述完整配置是否正确？",
      options: ["确认以上全部配置", "需要修改"],
    }],
    link: "http://x/work/T-config",
  });
  assert.match(complete.text, /待确认内容：/);
  assert.match(complete.text, /需求单：REQ-20260826-01/);
  assert.match(complete.text, /基线：master/);
  assert.match(complete.text, /交付方式：完整开发 full/);
  assert.match(complete.text,
    /先输入“\/mfc”激活 Mae-Flow 插件[\s\S]*插件激活后，只有这一项待办时，可回复选项序号/);
  assert.equal(notifier.latestApproval("alice")?.waitingId,
    "T-config:complete");

  const missing = await notifier.notifyWaiting({
    waitingId: "T-config:missing", stateVersion: 1,
    taskId: "T-config-2", account: "bob", step: "config_confirm",
    questions: [{
      question: "上述完整配置是否正确？",
      options: ["确认以上全部配置", "需要修改"],
    }],
    link: "http://x/work/T-config-2",
  });
  assert.match(missing.text, /被确认的具体内容没有随审批卡提供/);
  assert.match(missing.text, /已禁止裸序号审批/);
  assert.doesNotMatch(missing.text, /可直接回复选项序号/);
  assert.equal(notifier.latestApproval("bob"), undefined,
    "缺少被确认内容时不能建立裸回复审批上下文");
});

test("发送失败:调用方可旁路调度;Promise 只返回最终发送事实", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  luban.failFirst = 2;
  try {
    const notifier = new Notifier({
      endpoint: luban.endpoint, backoffMs: [0, 50, 50],
    });
    let resolved = false;
    const pending = notifier.notifyWaiting({
      waitingId: "T-2:c1", taskId: "T-2", account: "a",
      step: "grill", summary: "问题", link: "http://x/tasks/T-2",
    }).then((record) => {
      resolved = true;
      return record;
    });
    await until(() => notifier.list()[0]?.attempts === 1 ? true : undefined,
      "首轮失败");
    assert.equal(resolved, false, "重试中不能把瞬时失败当成最终事实返回");
    const record = await pending;
    assert.equal(record.delivered, true);
    assert.equal(record.settled, true);
    assert.equal(record.attempts, 3);
  } finally {
    await luban.stop();
  }
});

test("端到端:任务进入等待即通知;通知死透不改流程,页面可见事实", async () => {
  const SCRIPT: Scene[] = [
    { text: "待确认配置：兼容旧接口；灰度关闭；观察窗口 30 分钟。",
      tool: { name: "AskUserQuestion", input: { questions: [
      { question: "兼容旧接口吗?", options: ["兼容", "不兼容"],
        recommended: "兼容" },
      { question: "需要灰度吗?", options: ["需要", "不需要"],
        recommended: "需要" },
      { question: "灰度观察多久?", options: ["30 分钟", "2 小时"],
        recommended: "30 分钟" },
    ] } } },
    { text: "收口" },
  ];
  const luban = new FakeLubanServer();
  await luban.start();
  luban.failFirst = 99; // 永远失败:验证 §14.4 通知失败不改变流程状态
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-notify-"));
    const notifier = new Notifier({
      endpoint: luban.endpoint, backoffMs: [0, 30],
    });
    const service = new TaskService({
      dataDir,
      provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
      notifier,
      linkBase: "http://127.0.0.1:8787",
    });
    const created = service.create("交付 NT-1", { account: "developer" });
    const waiting = await until(() => {
      const task = service.get(created.id)!;
      return task.status === "waiting_for_human" ? task : undefined;
    }, "进入等待");
    const waitingNotice = await until(
      () => notifier.list()[0],
      "待办通知入账",
    );
    assert.match(waitingNotice.text,
      /待确认内容：\n待确认配置：兼容旧接口；灰度关闭；观察窗口 30 分钟/);
    assert.match(waitingNotice.text, /共 3 个问题/);
    assert.match(waitingNotice.text, /问题 1：兼容旧接口吗/);
    assert.match(waitingNotice.text, /问题 2：需要灰度吗/);
    assert.match(waitingNotice.text, /问题 3：灰度观察多久/);
    assert.match(waitingNotice.text, /选项：1\. 30 分钟；2\. 2 小时/);
    assert.equal(
      waitingNotice.link,
      `http://127.0.0.1:8787/work/${created.id}`,
      "通知应直达有稳定地址的任务工作台",
    );
    // 通知死透:流程仍在等待,决定照常可提交,页面拿得到失败事实。
    const failed = await until(() => {
      const task = service.get(created.id)!;
      return task.notify && task.notify.attempts >= 2
        && !task.notify.delivered ? task : undefined;
    }, "通知重试耗尽");
    assert.equal(failed.status, "waiting_for_human");
    assert.equal(failed.notify!.settled, true);
    assert.match(failed.notify!.last_error, /HTTP 500/);
    const restarted = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), maxConcurrent: 0,
    });
    restarted.recover();
    const restored = restarted.get(created.id)!;
    assert.equal(restored.notify?.settled, true,
      "重启后必须恢复重试耗尽的最终事实，不能再停在 attempts=1 的快照");
    assert.equal(restored.notify?.attempts, 2);
    await service.decide(created.id, {
      state_version: waiting.waiting!.state_version,
      answers: {
        "兼容旧接口吗?": "兼容",
        "需要灰度吗?": "不需要",
        "灰度观察多久?": "30 分钟",
      },
    });
    const done = await until(() => {
      const task = service.get(created.id)!;
      return task.status === "completed" ? task : undefined;
    }, "收口");
    assert.equal(done.luban_account, "developer");
  } finally {
    await model.stop();
    await luban.stop();
  }
});

test("收口通知:完成/交付说人话送达;同任务同状态幂等", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({ endpoint: luban.endpoint });
    const first = await notifier.notifyOutcome({
      taskId: "T-2", account: "developer", status: "await_merge",
      summary: "已提合入请求,流水线通过,等待合入:http://git/mr/1",
      link: "http://x/tasks/T-2",
    });
    await until(() => (first.delivered ? true : undefined), "送达完成");
    const again = await notifier.notifyOutcome({
      taskId: "T-2", account: "developer", status: "await_merge",
      summary: "重复收轮不应重复通知",
      link: "http://x/tasks/T-2",
    });
    assert.equal(again, first);
    assert.equal(luban.messages.length, 1);
    const message = luban.messages[0] as Record<string, string>;
    assert.match(message.text, /任务 T-2/);
    assert.match(message.text, /等待合入/);
    assert.match(message.text, /http:\/\/git\/mr\/1/);
    assert.match(message.text, /先输入“\/mfc”激活 Mae-Flow 插件/);
  } finally {
    await luban.stop();
  }
});

test("通知连通测试复用正式个人 Token 且带 /mfc 激活说明", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({
      endpoint: luban.endpoint,
      personalToken: (account) => account === "developer"
        ? "token with+/symbols" : undefined,
    });
    const result = await notifier.testDelivery("developer");
    assert.equal(result.ok, true);
    assert.equal(luban.messages.length, 1);
    assert.match(String(luban.messages[0].text),
      /先输入“\/mfc”激活 Mae-Flow 插件/);
    assert.equal(luban.requestHeaders[0]["x-mfc-luban-token"],
      encodeURIComponent("token with+/symbols"));
  } finally {
    await luban.stop();
  }
});

test("文案模板:占位符按类别套值;激活提示与手机指令不归模板管", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: () => "A1B2C3D4E5",
    backoffMs: [],
    templates: {
      waiting: "{account} 你好:{subject}({task_id})在 {stage}[{step}]等你\n{summary}\n直达:{link}",
      outcome: "任务 {task_id} 已 {status}:{summary}\n详情:{link}",
      review: "{sender_account} 邀 {account} 检视 {task_id}:{summary} {link}",
    },
  });
  const waiting = await notifier.notifyWaiting({
    waitingId: "T-tpl:w", stateVersion: 1, taskId: "T-tpl",
    account: "alice", step: "delivery_review",
    context: "基线:master",
    questions: [{ question: "Diff 通过吗?", options: ["通过", "打回"] }],
    link: "http://x/tasks/T-tpl",
  });
  // subject 缺席回落"任务 {task_id}";stage 是人话、step 是内核原名。
  assert.match(waiting.text,
    /alice 你好:任务 T-tpl\(T-tpl\)在 当前阶段确认\[delivery_review\]等你/);
  assert.match(waiting.text, /待确认内容：\n基线:master/);
  assert.match(waiting.text, /直达:http:\/\/x\/tasks\/T-tpl/);
  // 模板删不掉的两段:激活前置 + 手机审批指令
  assert.match(waiting.text, /先输入“\/mfc”激活 Mae-Flow 插件/);
  assert.match(waiting.text, /可回复选项序号/);

  const outcome = await notifier.notifyOutcome({
    taskId: "T-tpl", account: "alice", status: "failed",
    summary: "出错了", link: "http://x/tasks/T-tpl",
  });
  assert.match(outcome.text, /任务 T-tpl 已 failed:出错了/);
  assert.match(outcome.text, /详情:http:\/\/x\/tasks\/T-tpl/);
  assert.match(outcome.text, /先输入“\/mfc”激活/);

  const review = await notifier.notifyReview({
    taskId: "T-tpl", senderAccount: "bob", account: "alice",
    summary: "看看", link: "http://x/tasks/T-tpl",
  });
  assert.match(review.text, /bob 邀 alice 检视 T-tpl:看看/);
});

test("文案模板:表外或跨类别占位符拒绝构造(部署配置语义)", () => {
  assert.throws(
    () => new Notifier({ endpoint: "x", templates: { waiting: "{task_i}" } }),
    /waiting[\s\S]*task_i/);
  // {stage} 是 waiting 专属,outcome 里用它=跨类别配错,同样点名。
  assert.throws(
    () => new Notifier({ endpoint: "x", templates: { outcome: "{stage}" } }),
    /outcome[\s\S]*stage/);
  assert.throws(
    () => new Notifier({ endpoint: "x", templates: { review: "{status}" } }),
    /review[\s\S]*status/);
  // 报错里把该类别可用占位符列全,排障不用翻源码。
  assert.throws(
    () => new Notifier({ endpoint: "x", templates: { outcome: "{oops}" } }),
    /\{task_id\} \{status\} \{summary\} \{account\} \{link\}/);
  // 合法模板正常构造,不配模板=默认文案(既有用例已覆盖默认形状)。
  new Notifier({ endpoint: "x", templates: { review: "{sender_account}→{link}" } });
});
