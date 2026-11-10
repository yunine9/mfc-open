/**
 * 跑动中插话(本地 CLI 的 ESC 在云端的等价物)。
 *
 * 契约只有一条,但它是硬的:**人说的话一定会送到模型**。
 * 无论插话撞上的是"模型正在跑工具"(pi 的 steer 直送)还是"回合刚好
 * 收口"(steer 队列没人取,由宿主取回来补发),结果必须一样——这两条
 * 路都在这里用同一个断言收口,免得哪天只剩一条还以为都好着。
 *
 * 为什么不能只靠 try/catch 兜底:读 pi 源码才发现 steer 从不抛错,
 * 它只是把消息压进内部队列;撞在间隙就静静躺着永远没人送。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

/** 第一幕故意跑一条慢命令,给插话留出"模型正忙"的窗口。 */
const SCRIPT: Scene[] = [
  { text: "先看一眼现场",
    tool: { name: "bash", input: { command: "sleep 2; echo LOOKED" } } },
  { text: "收到,按你说的办,完成。" },
];

const WAITING_SCRIPT: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "通过吗?",
                                   options: ["通过", "打回"],
                                   recommended: "通过" }] } } },
  { text: "完成。" },
];

test("失败现场可以补充处理要求，保留原分支和 MR，不把新要求变成盲目重推", async () => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "mfc-failed-steer-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const id = service.create("处理工作区遗留文件", { account: "owner" }).id;
    const task = (service as any).tasks.get(id);
    task.summary.luban_account = "owner";
    task.summary.status = "failed";
    task.summary.waiting = undefined;
    task.summary.delivery = { source_branch: "feature", mr_url: "https://code.example/mr/15445", pipeline: "success" };
    (service as any).removeFromQueue(id);
    await assert.rejects(service.interrupt(id, "直接重推", "other"), /没有在跑的会话/);
    const reply = await service.interrupt(id, "先核对 toolType.dat 和 imap 的来源，产物不交付；保留源码和 master 合入内容。", "owner");
    assert.equal(reply.status, "queued");
    assert.match(task.pendingMainSteers.join("\n"), /先核对 toolType.dat 和 imap 的来源/);
    assert.equal(reply.delivery?.source_branch, "feature");
    assert.equal(reply.delivery?.mr_url, "https://code.example/mr/15445");
    assert.equal(reply.delivery?.git_push, undefined, "补充要求不直接推送");
  } finally { await service.shutdown(); }
});

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 模型收到的全部用户消息文本(跨请求、跨回合)。 */
function userTexts(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .filter((message: any) => message?.role === "user")
    .map((message: any) => typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
        .map((block: any) => block?.text ?? "").join(" "))
    .join("\n");
}

test("空档期插话会被 pi 悄悄收下不送——宿主必须取得回来", async () => {
  // 这条钉的是坑本身,不是流程:steer 从不抛错,没有回合在跑时它只是
  // 把消息压进内部队列,再也没人送。靠 try/catch 兜底是空想,所以宿主
  // 必须能在收口时把它取回来,而且取走即归我(pi 不会事后又送一遍,
  // 否则模型会收到两遍同一句话)。
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const dir = mkdtempSync(join(tmpdir(), "mfc-steer-unit-"));
  const agentDir = join(dir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
                JSON.stringify(model.modelsJson()));
  const session = await CloudSession.create({
    taskId: "T-steer", workspace: dir, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: new EventLog(join(dir, "events.jsonl")),
    transcript: new TranscriptStore(join(dir, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(dir, "waiting.json")),
  });
  try {
    // 一个回合都没起过,直接插话——最纯粹的"撞在间隙"。
    await session.steer("插一句:掩码要保留后四位");
    assert.deepEqual(session.takeUndeliveredSteers(),
                     ["插一句:掩码要保留后四位"]);
    assert.deepEqual(session.takeUndeliveredSteers(), [],
                     "取走即归宿主,不能留在 pi 队列里被重复送达");
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("插话与接管边界:暂停不得伪造已读，恢复后必须补送", async () => {
  // 这是“补充给主任务”与“我接管主现场”正面相撞的边界：
  // steer 刚进 Pi 内存队列，主会话就因接管被暂停。队列必须先取回
  // 且持久化；否则旧会话一销毁，读侧还会错把“队列没了”当成“模型已读”。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-takeover-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 0,
  });
  const id = service.create("接管前的补充不能丢").id;
  const internal = (service as unknown as {
    tasks: Map<string, {
      cwd?: string;
      driver?: CloudSession;
      summary: { id: string; workspace: string; status: string };
      humanGate: HumanGate;
    }>;
  }).tasks.get(id)!;
  internal.cwd = internal.summary.workspace;
  internal.summary.status = "running";
  const agentDir = join(internal.summary.workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
    JSON.stringify(model.modelsJson()));
  internal.driver = await CloudSession.create({
    taskId: id,
    workspace: internal.summary.workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(internal.summary.workspace, "events.jsonl")),
    transcript: new TranscriptStore(
      join(internal.summary.workspace, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: internal.humanGate,
  });

  try {
    await service.interrupt(id, "这条补充必须在交还后继续处理");
    assert.equal(service.listInterrupts(id)[0]?.delivered, false);
    assert.equal((await service.pause(id, "alice")).status, "pausing");
    await until(() => service.get(id)?.status === "paused", "暂停完成");

    assert.equal(service.get(id)?.status, "paused");
    assert.equal(service.listInterrupts(id)[0]?.delivered, false,
      "旧主会话销毁后，取回的补充仍必须显示待读");
    const saved = JSON.parse(readFileSync(
      join(dataDir, id, "task.json"), "utf-8"));
    assert.equal(saved.pending_main_steers.length, 1);
    // 恢复补送的正文以责任人指令开头,后接新交办工作指引
    // (concurrentWorkPrompt 随插话捎带,指引插话不含该块时补上)。
    assert.match(saved.pending_main_steers[0], /^\[责任人指令编号 [^\]]+\]\n这条补充必须在交还后继续处理/);
    assert.match(saved.pending_main_steers[0], /^\[处理新交办与当前工作\]$/m);

    await service.shutdown();
    const recovered = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    try {
      assert.equal(recovered.recover().restored, 1);
      assert.equal(recovered.listInterrupts(id)[0]?.delivered, false,
        "服务重启也不得把待读补充变成假回执");
      recovered.resume(id, "alice");
      await until(() => recovered.get(id)?.status === "completed",
        "主任务恢复并消费暂停前补充");
      assert.match(userTexts(model), /这条补充必须在交还后继续处理/);
      assert.equal(recovered.listInterrupts(id)[0]?.delivered, true);
    } finally {
      await recovered.shutdown();
    }
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("插话:发送即打断,话一定送到模型", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  // 收尾必须进 finally:断言一旦失败,model.stop() 被跳过,假模型
  // 服务的监听句柄就吊住事件循环——测试子进程退不出去,整个套件就地
  // 挂死且永不超时(2026-08-27 实测挂 46 分钟那种)。失败也要干净退场。
  try {
    const id = service.create("给手机号打码").id;

    // 等模型真的开跑再插话:此刻它正卡在那条慢命令上。
    await until(() => model.requests.length >= 1, "模型收到第一轮请求");
    await service.interrupt(id, "插一句:掩码要保留后四位");

    await until(() => service.get(id)?.status === "completed", "任务收口");
    assert.match(userTexts(model), /掩码要保留后四位/);
  } finally {
    await service.shutdown();
    await model.stop();
  }
});


test("插话:等人决定时走决定卡,不许开第二个入口", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-wait-"));
  const model = new ScriptedModelServer(WAITING_SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务等人");

    // 同一件事有两个入口,内核台账上却只认决定那一个——这里必须拒。
    await assert.rejects(
      () => service.interrupt(id, "顺便说一句"),
      /决定卡/);

    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version, decision: "通过",
    });
    await until(() => service.get(id)?.status === "completed", "任务收口");

    // 收口之后也没有会话可插:如实拒绝,不假装收下。
    await assert.rejects(() => service.interrupt(id, "马后炮"), /没有在跑的会话/);
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("插话:空内容与不存在的任务如实拒绝", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-bad-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await assert.rejects(() => service.interrupt(id, "   "), /不能为空/);
    await assert.rejects(() => service.interrupt("task-404", "在吗"), /不存在/);
    await until(() => service.get(id)?.status === "completed", "任务收口");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("插话回执:发过什么、读到没有,都要能查", async () => {
  // "我发了然后就没了,咋知道它消费了没"——发出去没有回执等于对着空气
  // 说话。送达是可观测事实:消息离开 pi 的待送队列 = 已进入模型上下文。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-log-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(() => model.requests.length >= 1, "模型开跑");

    assert.deepEqual(service.listInterrupts(id), [], "没发过就是空的");

    // 时序收口(#33):只等"模型开跑"钉不住第一幕已成过去时——假模型
    // 收到请求到宿主把第一幕文本落账(message_end → assistant_message
    // 入 events.jsonl)之间有窗口,全套并发跑时插话能钻进去:插话账
    // (user_message)先落,第一幕文本后落,重放时它就排在插话后面,
    // 按"送达时刻分界"的契约被算进 said——炸的是测试没等齐,不是产品
    // 语义。这里等第一幕文本出现在同一本事件账里再插话:落账走
    // appendFileSync,先落者必排前,listInterrupts 重放同一文件,顺序即
    // 事实,插话只可能晚于第一幕,窗口不复存在(328 行的边界断言恒真)。
    await until(
      () => new EventLog(service.eventLogPath(id)).replay()
        .some((event) => event.kind === "assistant_message"
          && String(event.payload?.text ?? "").includes("先看一眼现场")),
      "第一幕发言已落账");

    await service.interrupt(id, "掩码保留后四位");
    const logged = service.listInterrupts(id);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].text, "掩码保留后四位");

    assert.deepEqual(logged[0].said, [], "还没说下文就是空的,不许硬凑");

    await until(() => service.get(id)?.status === "completed", "任务收口");
    // 收口之后队列必然空了 = 已读取。落账和收口同拍完成,但立即读会
    // 踩到"已送达未落账"的中间态——那是读的竞态,不是契约破坏,轮询掉。
    await until(() => service.listInterrupts(id)[0]?.delivered === true,
                "插话回执落账");
    await until(() => (service.listInterrupts(id)[0]?.said?.length ?? 0) > 0,
                "下文落账");
    const done = service.listInterrupts(id)[0];
    assert.equal(done.delivered, true);

    // "有时我是问了个问题…我看不到 agent 的回复"(用户 2026-08-22 原话):
    // 只报"已读取"而不给下文,提问就永远没有答案。这里给的是时间顺序上的
    // 下文——刻意不叫"回复",宿主证明不了哪一段是在答你。
    assert.deepEqual(done.said.map((item) => item.text),
      ["收到,按你说的办,完成。"]);
    // 「你开口之前它说过的话不算你的账」这一边界由落账顺序结构性
    // 保证(见上方 until 注释),不再单独断言(2026-09-18 去恒真)。
  } finally {
    await service.shutdown();
    await model.stop();
  }
});
