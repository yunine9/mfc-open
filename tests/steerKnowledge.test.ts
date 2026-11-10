/**
 * 插话 @ 知识引用(用户拍板 2026-09-01:"支持中途引用知识或skill,
 * 防止开局忘选了,导致没有机会再让用知识了")。契约:
 * - 前端只传结构化标识,正文由服务端解析并在**发送时固定版本**;
 * - 三态送达:running→steer;queued→并进使命;等人决定→随下一次决定
 *   的 notes 送达(pendingDecisionKnowledge 持久化,重启不丢);
 * - 注入有总预算,超了如实报错,绝不静默截断;
 * - 中途引用写进知识足迹(观测旁路,fail-open)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService, TaskControlError } from "../src/taskService.ts";
import { uploadHostSkill } from "../src/hostSkillLibrary.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import {
  createBusinessModule,
  publishBusinessKnowledgeAsset,
} from "../src/businessModuleLibrary.ts";

const encode = (text: string) => Buffer.from(text, "utf-8").toString("base64");

const SLOW_SCRIPT: Scene[] = [
  { text: "先看现场",
    tool: { name: "bash", input: { command: "sleep 2; echo OK" } } },
  { text: "收到,完成。" },
];

const WAITING_SCRIPT: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "通过吗?",
                                   options: ["通过", "打回"],
                                   recommended: "通过" }] } } },
  { text: "完成。" },
];

async function until(
  probe: () => boolean, what: string, timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function userTexts(model: ScriptedModelServer): string {
  // 决定的答案与 notes 是作为 AskUserQuestion 的 tool_result 回到模型的,
  // 正文藏在 block.content 里——只抽 block.text 会漏掉这条路。
  const blockText = (block: any): string => {
    if (typeof block === "string") return block;
    if (typeof block?.text === "string") return block.text;
    if (Array.isArray(block?.content)) {
      return block.content.map(blockText).join(" ");
    }
    if (typeof block?.content === "string") return block.content;
    return "";
  };
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .filter((message: any) => message?.role === "user")
    .map((message: any) => typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map(blockText).join(" "))
    .join("\n");
}

const METADATA = {
  nature: "engineering" as const,
  business_module_ids: [], repositories: [], technologies: ["java"],
};

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: 测试用\n`
    + `knowledge_nature: engineering\ntechnologies: [java]\n---\n\n${body}\n`;
}

async function seedSkill(
  dataDir: string, directory: string, body: string,
): Promise<void> {
  seedTechnologyStacks(dataDir, ["java"]);
  await uploadHostSkill(dataDir, directory, [
    { path: "SKILL.md", content_base64: encode(skillMd(directory, body)) },
  ], "admin", METADATA);
}

test("解析即固定版本:同一引用,货架更新后各拿各的版本号", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-atref-pin-"));
  await seedSkill(dataDir, "retry-guide", "重试上限读 retry.max(v1)");
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: { providers: {} },
  });
  const resolve = (service as any).resolveSteerKnowledge.bind(service);
  const first = resolve([{ kind: "skill", directory: "retry-guide" }]);
  assert.match(first.text, /retry\.max(v1)?/);
  assert.match(first.text, /【团队 Skill · retry-guide@[0-9a-f]{8}】/);
  await seedSkill(dataDir, "retry-guide", "重试上限读 retry.max(v2 改版)");
  const second = resolve([{ kind: "skill", directory: "retry-guide" }]);
  assert.match(second.text, /v2 改版/);
  assert.notEqual(first.labels[0], second.labels[0],
    "版本标签必须随内容变——发送时固定的是当时的版本");
  // 不存在的引用当场报错,不静默丢项。
  assert.throws(() => resolve([{ kind: "skill", directory: "missing" }]));
  assert.throws(() => resolve([{ kind: "nonsense" }]), TaskControlError);
});

test("注入预算:超限如实报错,不静默截断", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-atref-budget-"));
  await seedSkill(dataDir, "huge-guide", "x".repeat(49_000));
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: { providers: {} },
  });
  const resolve = (service as any).resolveSteerKnowledge.bind(service);
  assert.throws(() => resolve([{ kind: "skill", directory: "huge-guide" }]),
    /超出单次注入预算/);
  assert.throws(() => resolve(Array.from({ length: 5 },
    () => ({ kind: "skill", directory: "huge-guide" }))), /最多引用 4 项/);
});

test("running:引用正文随插话直送模型;足迹落账", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-atref-run-"));
  await seedSkill(dataDir, "mask-rules", "手机号掩码必须保留后四位——这是铁律");
  const model = new ScriptedModelServer(SLOW_SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(() => model.requests.length >= 1, "模型开跑");
    await service.interrupt(id, "参考这份团队规范", "alice",
      [{ kind: "skill", directory: "mask-rules" }]);
    await until(() => service.get(id)?.status === "completed", "任务收口");
    const seen = userTexts(model);
    assert.match(seen, /参考这份团队规范/);
    assert.match(seen, /中途引用知识/);
    assert.match(seen, /掩码必须保留后四位——这是铁律/,
      "引用的不是名字,是正文本身");
    // 「捎过去的话」只摆附言和引用名:正文进模型,不进页面(用户拍板)。
    const receipt = service.listInterrupts(id)[0];
    assert.equal(receipt.text, "参考这份团队规范");
    assert.match(receipt.references?.[0] ?? "", /^mask-rules@[0-9a-f]{8}$/);
    // 足迹:中途引用是可观察事实,要进 knowledge-events.jsonl。
    const events = readFileSync(
      join(dataDir, id, "knowledge-events.jsonl"), "utf-8");
    assert.match(events, /steer:skill:mask-rules@[0-9a-f]{8}/);
    assert.match(events, /插话 @ 引用注入/);
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("等人决定:纯文字仍拒;引用压进决定 continuation 并持久化", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-atref-wait-"));
  await seedSkill(dataDir, "review-rules", "检视时先看边界条件再看主流程");
  // 业务知识资产同样可引用。
  createBusinessModule(dataDir, {
    id: "order", name: "订单", description: "订单域", owner: "alice",
    repositories: ["git@example.com:demo/order.git"],
  }, "alice");
  publishBusinessKnowledgeAsset(dataDir, "order", {
    id: "refund-flow", title: "退款流程", summary: "退款语义",
    when_to_use: "改退款时", content: "退款必须走对账幂等表",
  }, "alice");
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
    // 纯文字插话在等待窗口的既有契约不变:决定卡是唯一入口。
    await assert.rejects(() => service.interrupt(id, "顺便说一句"), /决定卡/);
    // 带引用的插话:版本此刻固定,随下一次决定送达。
    await service.interrupt(id, "决定前先看这两份", "alice", [
      { kind: "skill", directory: "review-rules" },
      { kind: "business", module_id: "order", asset_id: "refund-flow" },
    ]);
    const saved = JSON.parse(readFileSync(
      join(dataDir, id, "task.json"), "utf-8"));
    assert.equal(saved.pending_decision_knowledge?.length, 1,
      "等待期引用必须持久化,重启不能吞掉人说过的话");
    assert.match(String(saved.pending_decision_knowledge[0]),
      /边界条件|对账幂等表/);
    // 回执:延后送达也得当场在「捎过去的话」里有一行,并如实标"还没送"。
    // 原来这条路不落事件账,页面永远停在"待读取状态会在下方更新"。
    const queued = service.listInterrupts(id);
    assert.equal(queued.length, 1, "等待期引用发出即记账");
    assert.equal(queued[0].deferred, "decision");
    assert.equal(queued[0].delivered, false, "决定没提交就不许报已读取");
    assert.equal(queued[0].text, "决定前先看这两份", "附言原文,不带注入正文");
    assert.deepEqual(queued[0].references?.map((label) =>
      label.replace(/@[0-9a-f]{8}$/, "@<digest>")),
      ["review-rules@<digest>", "退款流程@v1"]);

    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version, decision: "通过",
    });
    await until(() => service.get(id)?.status === "completed", "任务收口");
    const seen = userTexts(model);
    assert.match(seen, /先看边界条件再看主流程/);
    assert.match(seen, /退款必须走对账幂等表/);
    assert.match(seen, /退款流程@v1/, "业务资产按版本号固定");
    // 送达后清账:决定完成后不得再有待送引用。
    const after = JSON.parse(readFileSync(
      join(dataDir, id, "task.json"), "utf-8"));
    assert.ok(!after.pending_decision_knowledge?.length,
      "已送达的引用不许在下一张决定卡重复注入");
    const delivered = service.listInterrupts(id);
    assert.equal(delivered.length, 1, "记账不重复:决定送达不再补一条");
    assert.equal(delivered[0].delivered, true, "随决定送达后回执翻成已读取");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("排队:引用并入使命并当场记账;任务启动后回执翻成已读取", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-atref-queued-"));
  await seedSkill(dataDir, "mask-rules", "手机号掩码必须保留后四位——这是铁律");
  // 剧本按各自对话里的工具结果数选场景,两单共用同一份剧本互不串台。
  const model = new ScriptedModelServer(SLOW_SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 1,
  });
  try {
    const first = service.create("先占住唯一并发槽").id;
    await until(() => model.requests.length >= 1, "首单开跑");
    const id = service.create("给手机号打码").id;
    assert.equal(service.get(id)?.status, "queued", "第二单必须还在排队");
    await service.interrupt(id, "开工前先读这份", "alice",
      [{ kind: "skill", directory: "mask-rules" }]);
    const rows = service.listInterrupts(id);
    assert.equal(rows.length, 1, "排队期引用发出即记账,没有会话也不例外");
    assert.equal(rows[0].deferred, "mission");
    assert.equal(rows[0].delivered, false, "还没启动就不许报已读取");
    await until(() => service.get(first)?.status === "completed", "首单收口");
    await until(() => service.get(id)?.status === "completed", "第二单收口",
      30_000);
    assert.equal(service.listInterrupts(id)[0]?.delivered, true,
      "使命进了首条 prompt 才算送达");
    assert.match(userTexts(model), /掩码必须保留后四位——这是铁律/,
      "引用正文随使命进了模型");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});
