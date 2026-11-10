/**
 * 检视批注的语义契约。
 *
 * 三件事必须钉死:
 * 1. **那四条护栏一字不能少**。它们是内核 panel/annotate.py 对着弱模型
 *    踩出来的("已知悉"式敷衍、顺手改别处、行号偏移、默默跳过),看着
 *    像客套话,其实是契约。本仓复制了一份,所以这里得有人看着。
 * 2. **以原文为准定位**。靶子是活的:圈的第 23 行,模型十分钟后重构了。
 *    重锚定必须在送出那一刻做,而且只报告事实、不替人撤条目。
 * 3. **append-only**。多人同圈一份文档,就地覆盖会静默吃掉别人写的字;
 *    半行 JSON(崩在写一半)只能丢它自己,不能炸掉整份。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnnotationError,
  AnnotationPermissionError,
  AnnotationStore,
  TASK_REQUIREMENT_ARTIFACT,
  orderAnnotations,
  reanchor,
  renderAnnotations,
  type Annotation,
  ANNOTATION_QUOTE_MAX,
} from "../src/annotations.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";

function store(): AnnotationStore {
  return new AnnotationStore(
    join(mkdtempSync(join(tmpdir(), "mfc-anno-")), "annotations.jsonl"));
}

function seed(
  target: AnnotationStore,
  note: string,
  over: Partial<Annotation> = {},
): Annotation {
  return target.add({
    author: over.author ?? "developer",
    artifact: over.artifact ?? "REQ-1/spec.md",
    file: over.file ?? "spec.md",
    line: over.line ?? 42,
    anchor: over.anchor ?? "手机号按后四位掩码",
    context_before: over.context_before, context_after: over.context_after,
    note,
    kind: over.kind ?? "doc",
    route: over.route,
    assignee: over.assignee,
  });
}

test("批注接收对象：旧账默认 Agent，责任人答复独立留痕且只有指派人可答", () => {
  const target = store();
  const legacy = seed(target, "按旧逻辑交给 Agent");
  assert.equal(legacy.route, undefined, "旧账不补写字段也必须保持可读");

  const question = seed(target, "为什么不用旧接口？", {
    route: "owner_reply", assignee: "owner",
  });
  assert.throws(() => target.replyAsOwner(question.id, "visitor", "我猜是历史原因"),
    AnnotationPermissionError);
  const answered = target.replyAsOwner(question.id, "owner", "旧接口不支持多通道");
  assert.equal(answered.status, "sent", "责任人答复应原子接收尚未提交的意见");
  assert.equal(answered.sent_via, "owner_pending");
  assert.equal(answered.sent_by, "owner");
  assert.equal(answered.owner_reply?.author, "owner");
  assert.equal(answered.owner_reply?.text, "旧接口不支持多通道");
  assert.equal(answered.response, undefined, "责任人答复不能冒充 Agent 回执");
});

test("决策后处理：先等责任人，责任人落结论后排进当前人工决定再交 Agent", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-owner-route-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const id = service.create("高风险失败需要明确策略", { account: "owner" }).id;
  const note = service.addAnnotation(id, {
    author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "高风险失败需要明确策略",
    note: "请责任人决定是否停止交付", kind: "doc",
    route: "owner_decision",
  });
  assert.equal(note.assignee, "owner", "指派对象由任务责任人事实固定");
  const internal = (service as any).tasks.get(id);
  internal.summary.status = "waiting_for_human";
  const replied = await service.replyToAnnotation(
    id, note.id, "owner", "重试耗尽后停止交付，不允许自动降级");
  assert.equal(replied.owner_reply?.text, "重试耗尽后停止交付，不允许自动降级");
  assert.equal(replied.sent_via, "owner_pending",
    "自行答复不自动派给 Agent，由责任人后续明确选择");
});

test("责任人答复只通知意见提出人；责任人决策直接交 Agent 不发中间通知", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-owner-notify-")),
      provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
      notifier: new Notifier({ endpoint: luban.endpoint }),
    });
    const id = service.create("核对接口兼容性", { account: "owner" }).id;
    const question = service.addAnnotation(id, {
      author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "核对接口兼容性",
      note: "请解释为什么不能兼容旧接口", kind: "doc", route: "owner_reply",
    });
    await service.replyToAnnotation(id, question.id, "owner", "旧接口缺少幂等键");
    const deadline = Date.now() + 3_000;
    while (luban.messages.length < 1 && Date.now() < deadline) {
      await new Promise((tick) => setTimeout(tick, 20));
    }
    assert.equal(luban.messages.length, 1);
    assert.equal((luban.messages[0] as { account: string }).account, "reviewer");
    assert.match((luban.messages[0] as { text: string }).text,
      /责任人 owner 已答复.*最终由任务责任人逐条闭环/);

    const decision = service.addAnnotation(id, {
      author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "核对接口兼容性",
      note: "请决定是否停止兼容", kind: "doc", route: "owner_decision",
    });
    const internal = (service as any).tasks.get(id);
    internal.summary.status = "waiting_for_human";
    await service.replyToAnnotation(id, decision.id, "owner", "继续兼容");
    await new Promise((tick) => setTimeout(tick, 50));
    assert.equal(luban.messages.length, 1,
      "责任人决策后下一棒是 Agent，不应给提出人发送无行动通知");
  } finally {
    await luban.stop();
  }
});

test("责任人代转必须显式点中意见，旧的无 ids 提交只发送自己的草稿", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-owner-explicit-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const id = service.create("显式转交", { account: "owner" }).id;
  const own = service.addAnnotation(id, {
    author: "owner", artifact: "spec.md", file: "spec.md", line: 1,
    anchor: "a", note: "自己的问题", kind: "doc", route: "owner_reply",
  });
  const foreign = service.addAnnotation(id, {
    author: "reviewer", artifact: "spec.md", file: "spec.md", line: 2,
    anchor: "b", note: "别人的问题", kind: "doc", route: "owner_reply",
  });
  (service as any).tasks.get(id).summary.status = "waiting_for_human";
  await service.sendAnnotations(id, undefined, "owner", true);
  const items = service.listAnnotations(id).items;
  assert.equal(items.find((item) => item.id === own.id)?.status, "sent");
  assert.equal(items.find((item) => item.id === foreign.id)?.status, "draft",
    "没有显式 ID 时不能把其他人的草稿整批送出");
});

test("批注清单:那四条护栏一字不能少", () => {
  const target = store();
  seed(target, "掩码要保留后四位");
  const text = renderAnnotations(target.drafts(), "REQ2026081501");

  assert.match(text, /这是我人工检视 REQ2026081501 的结果/);
  assert.match(text, /共 1 条,涉及 1 个文件/);
  // 四条护栏——少一条模型就会退回"已知悉"式敷衍
  assert.match(text, /这是检视结论,不是征求意见/);
  assert.match(text, /只改这些地方/);
  assert.match(text, /以原文为准定位/);
  assert.match(text, /说明理由,别默默跳过/);
  // 三元组:坐标 + 原文 + 要求
  assert.match(text, /【spec\.md】/);
  assert.match(text, /1\. \[an-[^\]]+\] 历史第 42 行/);
  assert.match(text, /原文:手机号按后四位掩码/);
  assert.match(text, /要求:掩码要保留后四位/);
});

test("清单排序:按文件分组、组内按行号升序——人跳着圈,模型顺着改", () => {
  const target = store();
  seed(target, "第三处", { file: "b.md", line: 9 });
  seed(target, "第一处", { file: "a.md", line: 30 });
  seed(target, "第二处", { file: "a.md", line: 7 });
  const order = orderAnnotations(target.drafts())
    .map((item) => `${item.file}:${item.line}`);
  assert.deepEqual(order, ["a.md:7", "a.md:30", "b.md:9"]);
});

test("代码和文档都明确显示批注时原文，不能冒充当前内容", () => {
  const target = store();
  seed(target, "这个重试只该对网关失败生效",
       { kind: "code", file: "SmsHandler.java", anchor: "retry(3)" });
  assert.match(renderAnnotations(target.drafts(), "T-1"), /批注时原文:retry\(3\)/);
});

test("重锚定:命中/偏移/消失/多处都如实报,不替人撤条目", () => {
  const target = store();
  const hit = seed(target, "还在原处", { line: 2, anchor: "第二行原文" });
  const moved = seed(target, "被推下去了", { line: 2, anchor: "会挪走的那行" });
  const gone = seed(target, "已经没了", { line: 3, anchor: "早被删掉的内容" });
  const many = seed(target, "有歧义", { line: 9, anchor: "重复出现" });
  const now = [
    "第一行",
    "第二行原文",
    "插进来的新行",
    "会挪走的那行",
    "重复出现",
    "重复出现",
  ].join("\n");

  const checks = reanchor(target.drafts(), () => now);
  const state = (id: string) => checks.find((item) => item.id === id)!;
  assert.equal(state(hit.id).state, "hit");
  assert.equal(state(moved.id).state, "moved");
  assert.equal(state(moved.id).line, 4, "偏移后要报出新行号");
  assert.equal(state(gone.id).state, "gone");
  assert.equal(state(many.id).state, "ambiguous");
  // 报告归报告:条目一条没少,撤不撤是人的判断
  assert.equal(target.drafts().length, 4);
});

test("重锚定读不到材料时按「还在」放行——旁路绝不挡住人送意见", () => {
  const target = store();
  const only = seed(target, "读不到也得让我送");
  const checks = reanchor(target.drafts(), () => undefined);
  assert.equal(checks[0].state, "hit");
  assert.equal(checks[0].id, only.id);
});

test("重复原文即使占着旧行号也不能冒充唯一命中", () => {
  const [check] = reanchor([{ id: "same", artifact: "doc.md", line: 3, anchor: "结论：涉及" }],
    () => "**结论：涉及**\n\n**结论：涉及**");
  assert.equal(check.state, "ambiguous");
});

test("需求原文批注直接锚定任务快照，现场不存在也能跟随新行号", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-requirement-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const id = service.create("第一行\n需要重点检视的原文\n第三行").id;
  const note = service.addAnnotation(id, {
    author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 2, anchor: "需要重点检视的原文",
    note: "这里的验收口径要更明确", kind: "doc",
  });

  assert.equal(service.listAnnotations(id).checks[0].state, "hit");
  const internal = (service as any).tasks.get(id);
  internal.summary.requirement =
    "新增说明\n第一行\n需要重点检视的原文\n第三行";
  const syncCheck = service.listAnnotations(id).checks[0];
  assert.equal(syncCheck.state, "moved");
  assert.equal(syncCheck.line, 3);
  const asyncCheck = (await service.listAnnotationsAsync(id)).checks[0];
  assert.equal(asyncCheck.state, "moved",
    "没有 artifact root 时异步清单也必须读取需求快照");
  assert.equal(asyncCheck.line, 3);

  const store = (service as any).annotations(internal) as AnnotationStore;
  store.markSent([note.id], "review_repair");
  store.respond(note.id, { outcome: "not_fixed", summary: "请责任人核对当前位置", evidence: [] });
  const reopened = await service.reopenAnnotation(id, note.id, "本地用户");
  assert.equal(reopened.line, 3, "返工应把需求原文批注更新到当前行号");
});

test("终态批注合同：已交付可留档但不能再送，已停止仍禁止新增", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-terminal-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const id = service.create("终态也要允许留下复盘意见").id;
  const internal = (service as any).tasks.get(id);
  internal.summary.status = "completed";
  const archived = service.addAnnotation(id, {
    author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "终态也要允许留下复盘意见",
    note: "后续任务需要补充这个边界", kind: "doc",
  });
  assert.equal(service.listAnnotations(id).items[0].id, archived.id);
  await assert.rejects(
    service.sendAnnotations(id, [archived.id], "本地用户"),
    (error) => error instanceof TaskControlError
      && /任务已经结束，不能再提交批注/.test(error.message),
  );
  assert.equal(service.listAnnotations(id).items[0].status, "draft",
    "拒绝发送不能改动归档记录状态");

  internal.summary.status = "canceled";
  assert.throws(() => service.addAnnotation(id, {
    author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "终态也要允许留下复盘意见",
    note: "停止后不应再增加", kind: "doc",
  }), (error) => error instanceof TaskControlError
    && /用户停止，不能再新增批注/.test(error.message));
});

test("append-only:软删留痕、已送出可移出看板、半行 JSON 只丢它自己", () => {
  const target = store();
  const mine = seed(target, "我写的");
  const yours = seed(target, "别人写的", { author: "wangwu" });

  // 只能删自己的:替别人删等于替他改主意
  assert.throws(() => target.drop(yours.id, "developer"), AnnotationError);
  target.drop(mine.id, "developer");
  assert.deepEqual(target.drafts().map((item) => item.id), [yours.id]);
  // 软删留痕:记录还在,只是不再是 draft
  assert.equal(target.list().find((item) => item.id === mine.id)?.status,
               "dropped");

  target.markSent([yours.id], "interrupt");
  assert.deepEqual(target.drafts(), []);
  const sent = target.list().find((item) => item.id === yours.id)!;
  assert.equal(sent.status, "sent");
  assert.equal(sent.sent_via, "interrupt");
  // 已送出的可以从看板移除(话收不回,但清单是人自己的):记录留痕
  target.drop(yours.id, "wangwu");
  assert.deepEqual(target.visible(), []);
  assert.equal(target.list().length, 2, "移出看板不等于抹掉记录");

  // 崩在写一半留下的半行,只能丢它自己
  appendFileSync(target.path, '{"op":"add","record":{"id":"an-x"', "utf-8");
  assert.equal(target.list().length, 2, "坏行不许炸掉整份批注");
});

test("批注归作者管理:本人可编辑删除,其他人无权代改", () => {
  const target = store();
  const mine = seed(target, "第一版意见", { author: "committer" });

  assert.throws(
    () => target.edit(mine.id, "越权修改", "developer"),
    AnnotationPermissionError,
  );
  assert.throws(
    () => target.drop(mine.id, "developer"),
    AnnotationPermissionError,
  );

  const edited = target.edit(mine.id, "第二版意见", "committer");
  assert.equal(edited.note, "第二版意见");
  assert.ok(edited.edited_at);

  target.markSent([mine.id], "decision");
  const sentEdited = target.edit(mine.id, "提交后再修正", "committer");
  assert.equal(sentEdited.status, "draft",
    "改过的版本必须重新提交,不能冒充旧版本已经送达");
  assert.equal(sentEdited.sent_at, undefined);

  const dropped = target.drop(mine.id, "committer");
  assert.equal(dropped.status, "dropped");
});

test("死锁出路:管理员可代闭环并留痕,非 override 仍拒绝越权", () => {
  // 作者不在场时,一条未闭环批注会把整单推送永远锁死(2026-08-30
  // 审计)。"谁的意见谁裁决"仍是默认规则;override 是有账可查的门。
  const target = store();
  const stray = seed(target, "路过圈的一条", { author: "visitor" });
  target.markSent([stray.id], "decision");
  assert.throws(() => target.verify(stray.id, "admin"),
    AnnotationPermissionError, "不带 override 依然不能替别人签字");
  const verified = target.verify(stray.id, "admin", true);
  assert.equal(verified.status, "verified");
  assert.equal(verified.verified_by, "admin", "代闭环必须记谁点的");
  const replayed = target.list().find((item) => item.id === stray.id)!;
  assert.equal(replayed.verified_by, "admin", "台账重放后留痕仍在");
  // 作者本人裁决不算代签,verified_by 不落。
  const own = seed(target, "自己的意见", { author: "visitor" });
  target.markSent([own.id], "decision");
  assert.equal(target.verify(own.id, "visitor").verified_by, undefined);
  // 草稿没有可裁决的改动,管理员的出路是代删——同样留痕生效。
  const draft = seed(target, "没送出的草稿", { author: "visitor" });
  assert.throws(() => target.drop(draft.id, "admin"),
    AnnotationPermissionError);
  assert.equal(target.drop(draft.id, "admin", true).status, "dropped");
});

test("当前任务责任人逐条处置；管理员不能代签，未处理意见需要明确依据", () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-owner-service-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const id = service.create("责任人闭环边界", { account: "owner" }).id;
  const internal = (service as any).tasks.get(id);
  const annotations = (service as any).annotations(internal) as AnnotationStore;
  const add = (note: string) => service.addAnnotation(id, {
    author: "reviewer", artifact: "本任务变更", file: "src/feature.ts", line: 1,
    anchor: "export const value = 1;", note, kind: "code",
  });
  const fixed = add("已修复");
  const pending = add("尚未处理");
  annotations.markSent([fixed.id, pending.id], "review_repair");
  annotations.respond(fixed.id, { outcome: "fixed", summary: "已增加边界测试", evidence: ["src/feature.ts:1"] });
  for (const actor of ["reviewer", "admin"]) {
    assert.throws(() => service.verifyAnnotation(id, fixed.id, actor, true), AnnotationPermissionError);
    assert.throws(() => service.dropAnnotation(id, fixed.id, "admin", true), AnnotationPermissionError);
  }
  const verified = service.verifyAnnotation(id, fixed.id, "owner");
  assert.equal(verified.resolution?.by, "owner");
  assert.equal(verified.resolution?.outcome, "fixed");
  assert.equal(annotations.list().find((a) => a.id === pending.id)?.status, "sent", "没有批量闭环副作用");
  assert.throws(() => service.verifyAnnotation(id, pending.id, "owner"), /先交给 Agent/);
  annotations.respond(pending.id, { outcome: "not_fixed", summary: "依赖环境未就绪，需要延期", evidence: [] });
  const decided = service.verifyAnnotation(id, pending.id, "owner", false, {
    revision: 0, outcome: "deferred", reason: "依赖环境未就绪，安排下一版本验证",
  });
  assert.equal(decided.resolution?.outcome, "deferred");
  assert.equal(decided.response?.outcome, "not_fixed", "人工延期保留原始 Agent 回执");
});

test("批注 HTTP 权限:成员记下意见后由责任人统一处理，管理员不代签", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-anno-auth-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("developer", "developer-pass-1", "developer");
  auth.createUser("committer", "committer-pass-1", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const developer = await login("developer", "developer-pass-1");
    const committer = await login("committer", "committer-pass-1");
    const created = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: developer },
      body: JSON.stringify({ requirement: "检视作者权限" }),
    }).then((response) => readJson(response)) as { id: string };

    async function add(
      cookie: string,
      note: string,
      route: Annotation["route"] = "agent",
    ): Promise<Annotation> {
      const response = await fetch(`${base}/tasks/${created.id}/annotations`, {
        method: "POST", headers: { cookie },
        body: JSON.stringify({
          artifact: "spec.md", file: "spec.md", line: 1,
          anchor: "原始内容", note, kind: "doc", route,
        }),
      });
      assert.equal(response.status, 201);
      return await response.json() as Annotation;
    }

    const committerNote = await add(committer, "Committer 的意见");
    const developerNote = await add(developer, "开发的意见");

    const ownerQuestion = await add(
      committer, "请任务责任人解释接口取舍", "owner_reply");
    const visitorCannotReply = await fetch(
      `${base}/tasks/${created.id}/annotations/${ownerQuestion.id}/reply`, {
        method: "POST", headers: { cookie: committer },
        body: JSON.stringify({ text: "我替责任人回答" }),
      });
    assert.equal(visitorCannotReply.status, 403);
    assert.match((await readJson(visitorCannotReply) as { error: string }).error,
      /需要任务责任人 developer 答复/);
    const ownerReplies = await fetch(
      `${base}/tasks/${created.id}/annotations/${ownerQuestion.id}/reply`, {
        method: "POST", headers: { cookie: developer },
        body: JSON.stringify({ text: "旧接口无法支持多通道" }),
      });
    assert.equal(ownerReplies.status, 200);
    const ownerReply = await readJson(ownerReplies) as Annotation;
    assert.equal(ownerReply.owner_reply?.text, "旧接口无法支持多通道");
    assert.equal(ownerReply.status, "sent",
      "责任人应能直接接住别人尚未提交的提问并答复");
    assert.equal(ownerReply.sent_by, "developer");

    const committerCannotSend = await fetch(
      `${base}/tasks/${created.id}/annotations/send`, {
        method: "POST", headers: { cookie: committer },
        body: JSON.stringify({ ids: [committerNote.id] }),
      });
    assert.equal(committerCannotSend.status, 403,
      "普通成员可以先圈注，但不能因此获得指挥 Agent 的权限");

    const internal = (service as any).tasks.get(created.id);
    internal.summary.collaborators = ["committer"];
    const adminForSend = await login("admin", "administrator-pass");
    for (const cookie of [committer, adminForSend]) {
      for (const body of [{}, { ids: [] }, { ids: [committerNote.id] }]) {
        const rejected = await fetch(`${base}/tasks/${created.id}/annotations/send`, {
          method: "POST", headers: { cookie }, body: JSON.stringify(body),
        });
        assert.equal(rejected.status, 403, "受邀和管理员身份不能越过责任人，省略 ID 也一样");
      }
    }
    internal.summary.status = "waiting_for_human";
    internal.summary.waiting = undefined;
    const ownerRoutesForeignDraft = await fetch(
      `${base}/tasks/${created.id}/annotations/send`, {
        method: "POST", headers: { cookie: developer },
        body: JSON.stringify({ ids: [committerNote.id] }),
      });
    const ownerRoutesForeignBody = await readJson(ownerRoutesForeignDraft);
    assert.equal(ownerRoutesForeignDraft.status, 200,
      `任务责任人可以原样转交别人留下的意见：${JSON.stringify(ownerRoutesForeignBody)}`);
    const routed = service.listAnnotations(created.id).items.find((item) =>
      item.id === committerNote.id)!;
    assert.equal(routed.sent_by, "developer");
    assert.equal(routed.author, "committer", "转交不能篡改意见作者");

    const committerEditsOwn = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "PATCH", headers: { cookie: committer },
        body: JSON.stringify({ note: "Committer 修改后的意见" }),
      });
    assert.equal(committerEditsOwn.status, 403,
      "记下后的意见由责任人统一处理");

    const developerCannotEdit = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "PATCH", headers: { cookie: developer },
        body: JSON.stringify({ note: "开发越权修改" }),
      });
    assert.equal(developerCannotEdit.status, 409, "Agent 已接手时不能修改本轮意见");
    const developerCannotDelete = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "DELETE", headers: { cookie: developer },
      });
    assert.equal(developerCannotDelete.status, 409, "已交给 Agent 后责任人也不能删除");

    const committerCannotEdit = await fetch(
      `${base}/tasks/${created.id}/annotations/${developerNote.id}`, {
        method: "PATCH", headers: { cookie: committer },
        body: JSON.stringify({ note: "Committer 越权修改" }),
      });
    assert.equal(committerCannotEdit.status, 403);

    // 管理员角色只让路由提出 override 请求；真正的当前复检事实必须由
    // 服务层核验，普通草稿/历史意见不能因为 API 被直接调用就越权。
    const admin = await login("admin", "administrator-pass");
    const adminCannotDeleteOrdinaryDraft = await fetch(
      `${base}/tasks/${created.id}/annotations/${developerNote.id}`, {
        method: "DELETE", headers: { cookie: admin },
      });
    assert.equal(adminCannotDeleteOrdinaryDraft.status, 403,
      "不在当前 push 复检时，admin 也不能直接删他人草稿");

    const annotations = (service as any).annotations(internal) as AnnotationStore;
    annotations.markSent(
      [developerNote.id, committerNote.id], "review_repair");
    annotations.respond(committerNote.id, {
      outcome: "fixed", summary: "已按意见修复", evidence: ["spec.md:1"],
    });
    const historical = service.addAnnotation(created.id, {
      author: "former-reviewer", artifact: "spec.md", file: "spec.md", line: 1,
      anchor: "原始内容", note: "历史意见", kind: "doc",
    });
    annotations.markSent([historical.id], "review_repair");
    internal.summary.delivery = { loop: {
      round: 0, state: "verifying", kind: "review",
      review_source: "workspace", workspace_review_recheck_required: true,
      workspace_review_annotation_ids: [developerNote.id, committerNote.id],
    } };
    internal.summary.status = "waiting_for_human";
    internal.summary.waiting = internal.humanGate.createWaiting({
      taskId: created.id, step: "cloud_push_confirm",
      callId: "annotation-admin-http", questionInput: { questions: [] },
    });

    const adminCannotDeleteHistorical = await fetch(
      `${base}/tasks/${created.id}/annotations/${historical.id}`, {
        method: "DELETE", headers: { cookie: admin },
      });
    assert.equal(adminCannotDeleteHistorical.status, 403,
      "sent 历史意见不在当前 ID 白名单，API 必须拒绝");

    internal.summary.status = "verifying";
    const racedDelete = await fetch(
      `${base}/tasks/${created.id}/annotations/${developerNote.id}`, {
        method: "DELETE", headers: { cookie: admin },
      });
    assert.equal(racedDelete.status, 403,
      "前端确认期间阶段变化后，第二次请求必须由服务端拒绝");
    internal.summary.status = "waiting_for_human";

    const adminDeletesCurrent = await fetch(
      `${base}/tasks/${created.id}/annotations/${developerNote.id}`, {
        method: "DELETE", headers: { cookie: admin },
      });
    assert.equal(adminDeletesCurrent.status, 403,
      "当前复检也不授予管理员代删权限");
    const adminVerifiesCurrent = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}/verify`, {
        method: "POST", headers: { cookie: admin },
      });
    assert.equal(adminVerifiesCurrent.status, 403, "管理员不能代签");
    const reviewerCannotResolve = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}/resolve`, {
        method: "POST", headers: { cookie: committer },
        body: JSON.stringify({ revision: 0, outcome: "fixed", reason: "" }),
      });
    assert.equal(reviewerCannotResolve.status, 403, "作者也不能替责任人闭环");
    const withoutRevision = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}/verify`, {
        method: "POST", headers: { cookie: developer }, body: "{}",
      });
    assert.equal(withoutRevision.status, 409);
    const staleResolution = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}/resolve`, {
        method: "POST", headers: { cookie: developer },
        body: JSON.stringify({ revision: 99, outcome: "fixed", reason: "旧页面的处理" }),
      });
    assert.equal(staleResolution.status, 409, "提交后已改字，旧页面不得处置新意见");
    const currentRevision = annotations.list().find((item) => item.id === committerNote.id)!.rework ?? 0;
    const ownerVerifiesCurrent = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}/resolve`, {
        method: "POST", headers: { cookie: developer },
        body: JSON.stringify({ revision: currentRevision, outcome: "fixed", reason: "" }),
      });
    assert.equal(ownerVerifiesCurrent.status, 200, await ownerVerifiesCurrent.clone().text());
    const verifiedBody = await ownerVerifiesCurrent.json() as Annotation;
    assert.equal(verifiedBody.resolution?.by, "developer", "记录实际责任人");

    const committerOwn = await add(committer, "Committer 自己删除的意见");
    const committerDeletesOwn = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerOwn.id}`, {
        method: "DELETE", headers: { cookie: committer },
      });
    assert.equal(committerDeletesOwn.status, 403);
    const listed = await fetch(`${base}/tasks/${created.id}/annotations`, {
      headers: { cookie: developer },
    }).then((response) => readJson(response)) as { items: Annotation[] };
    assert.equal(listed.items.find((item) => item.id === developerNote.id)?.status,
      "sent", "管理员不能删除已提交意见");
    assert.equal(listed.items.find((item) => item.id === committerNote.id)?.status,
      "verified", "当前意见已由责任人逐条处置");
    assert.equal(listed.items.find((item) => item.id === historical.id)?.status,
      "sent", "被拒绝的历史意见必须保持原状");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("检视闭环:确认通过收口,返工退回草稿再送一轮", () => {
  // "本质上是我给 AI 提了检视意见,这条路得闭环"——提出→送达→改动之后,
  // 人必须能落一个裁决:通过就收口,不行就返工。返工不造新送出机制,
  // 退回 draft 走原有两条通道。
  const target = store();
  const first = seed(target, "掩码保留后四位");
  target.markSent([first.id], "interrupt");

  // 通过:状态落 verified,不再出现在待送出里
  const verified = target.verify(first.id, "developer");
  assert.equal(verified.status, "verified");
  assert.ok(verified.verified_at);
  assert.equal(target.drafts().length, 0);

  // 返工:退回 draft,轮次 +1,锚点可更新且历史留档
  const reopened = target.reopen(first.id, "developer",
    { line: 50, anchor: "掩码保留后四位(新写法)" });
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.rework, 1);
  assert.equal(reopened.line, 50);
  assert.equal(reopened.anchor, "掩码保留后四位(新写法)");
  assert.equal(reopened.anchor_was, "手机号按后四位掩码");
  assert.equal(target.drafts().length, 1, "返工的必须回到待送出队列");

  // 渲染要点明这是第二轮,并给出上一轮锚点——不然模型当新意见处理
  const text = renderAnnotations(target.drafts(), "REQ-1");
  assert.match(text, /第 2 次提出/);
  assert.match(text, /不要原样重复上次的改法/);
  assert.match(text, /上一轮针对的原文:手机号按后四位掩码/);

  // 边界:草稿没有可裁决的改动;别人的意见不能替裁
  const draft = seed(target, "另一条");
  assert.throws(() => target.verify(draft.id, "developer"), /没有可裁决/);
  target.markSent([draft.id], "decision");
  assert.throws(() => target.verify(draft.id, "路人"), /只能由他裁决/);
});

test("逐条回执:按 revision 追加留痕,返工后旧回应不能冒充新一轮", () => {
  const target = store();
  const note = seed(target, "补充空值保护");
  assert.throws(() => target.respond(note.id, {
    outcome: "fixed", summary: "尚未提交就声称已修", evidence: [],
  }), /尚未提交/);

  target.markSent([note.id], "review_repair");
  const responded = target.respond(note.id, {
    outcome: "fixed",
    summary: "已在入口增加空值保护并补测试",
    evidence: ["src/handler.ts:23", "src/handler.ts:23"],
    fixed_sha: "abc123",
  });
  assert.equal(responded.response?.revision, 0);
  assert.deepEqual(responded.response?.evidence, ["src/handler.ts:23"]);
  assert.equal(target.list()[0].response?.fixed_sha, "abc123",
    "append-only 台账重放后回应仍须存在");

  const reopened = target.reopen(note.id, "developer");
  assert.equal(reopened.response, undefined, "返工必须清掉上一轮机器回应");
  target.markSent([note.id], "review_repair");
  assert.throws(() => target.respond(note.id, {
    revision: 0, outcome: "fixed", summary: "迟到的第一轮回应", evidence: [],
  }), /不能登记旧轮回应/);
  const second = target.respond(note.id, {
    revision: 1, outcome: "not_fixed", summary: "按新证据无需修改", evidence: [],
  });
  assert.equal(second.response?.revision, 1);
  assert.equal(second.response?.outcome, "not_fixed");
});

test("空内容与缺原文一律拒收——没有原文的批注无从定位", () => {
  const target = store();
  assert.throws(() => seed(target, "   "), AnnotationError);
  assert.throws(() => seed(target, "有意见", { anchor: "" }), AnnotationError);
});

/* ------- 端到端:批注真的成了"需要修改"的理由,进到模型那里 ------- */

const REVIEW_SCRIPT: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "这轮代码通过吗?",
                                   options: ["通过", "需要修改"],
                                   recommended: "通过" }] } } },
  { text: "按你圈的几处改完了。" },
];

async function until(
  probe: () => boolean, what: string, timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("批注随决定提交:只送决定者自己的草稿,旁观记录不越权", async () => {
  const model = new ScriptedModelServer(REVIEW_SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-e2e-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务等人");

    const one = service.addAnnotation(id, {
      author: "developer", artifact: "REQ-1/spec.md", file: "SmsHandler.java",
      line: 23, anchor: "retry(3)", note: "重试只该对网关失败生效",
      kind: "code",
    });
    const visitor = service.addAnnotation(id, {
      author: "visitor", artifact: "REQ-1/spec.md", file: "SmsHandler.java",
      line: 24, anchor: "timeout(3)", note: "这只是旁观者的个人记录",
      kind: "code",
    });
    assert.equal(service.listAnnotations(id).items.length, 2);

    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      decision: "需要修改",
      annotation_ids: [one.id],
      actor: "developer",
    });
    const durable = (service as any).tasks.get(id).humanGate.get(waiting.waiting_id);
    assert.deepEqual(durable.continuation.annotation_versions,
      [{ id: one.id, revision: 0, note: one.note }],
      "真实决定须落盘本次送达的正文版本，不能只保存可重复使用的意见 id");
    await until(() => service.get(id)?.status === "completed", "任务收口");

    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    // 选项原样(内核按标签记账),批注作为理由跟在后面
    assert.match(seen, /需要修改/);
    assert.match(seen, /重试只该对网关失败生效/);
    assert.match(seen, /以原文为准定位/);
    assert.doesNotMatch(seen, /这只是旁观者的个人记录/,
      "记录权不能被决定路径暗中升级为送达权");
    // 送出即出队,不会在下一个检视点重复送一遍;但清单上不下架——
    // 人得看得见"这条我提过了、是随决定提的"。
    const after = service.listAnnotations(id).items;
    assert.equal(after.length, 2);
    assert.equal(after.find((item) => item.id === one.id)?.status, "sent");
    assert.equal(after.find((item) => item.id === one.id)?.sent_via, "decision");
    assert.equal(after.find((item) => item.id === visitor.id)?.status, "draft",
      "旁观者记录在决定后仍应保持未送达");
  } finally {
    await model.stop();
  }
});

test("未闭环检视意见不能随直接提交分支越过返工", async () => {
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-anno-kernel-"));
  mkdirSync(join(kernelRoot, "flow"));
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: {
      inspect: {
        approval_subject: { kind: "worktree" },
        choices: ["continue", "revise"],
        choice_answers: {
          continue: ["代码无需调整，继续提交"],
          revise: ["需要调整代码（按检视意见返工）"],
        },
        next: { continue: "commit", revise: "rework" },
      },
      commit: {},
      rework: { allow_source_edit: true },
    },
  }));
  const model = new ScriptedModelServer([{
    tool: { name: "AskUserQuestion", input: { questions: [{
      question: "这轮代码通过吗?",
      options: ["代码无需调整，继续提交", "需要调整代码（按检视意见返工）"],
      recommended: "代码无需调整，继续提交",
    }] } },
  }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-open-review-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("检视意见必须闭环").id;
    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务等人");
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "SmsHandler.java",
      line: 23, anchor: "retry(3)", note: "这里只重试网关错误", kind: "code",
    });

    // 会话已经用无宿主模式举卡；这里只给决定层接上一个最小内核契约，
    // 避免为了验证分支联动而启动仓库、容器和完整 Mae-Flow 流程。
    const internal = (service as any).tasks.get(id);
    internal.summary.waiting.step = "inspect";
    (service.options as any).host = { kernelRoot, repoPath: "/unused" };
    const waiting = service.get(id)!.waiting!;
    assert.equal(
      waiting.choice_effects?.find((item) => item.key === "revise")
        ?.allows_source_edit,
      true,
    );

    await assert.rejects(service.decide(id, {
      state_version: waiting.state_version,
      decision: "代码无需调整，继续提交",
    }), (error) => error instanceof TaskControlError
      && /仍有 1 条检视意见未闭环.*建议选择.*需要调整代码/.test(error.message));

    assert.equal(service.get(id)?.status, "waiting_for_human",
      "矛盾决定不能消费等待卡");
    assert.equal(service.listAnnotations(id).items[0].status, "draft",
      "被拒绝后批注仍须保持未提交");
  } finally {
    await model.stop();
  }
});

test("MR 修复轮的意见不拦内核中途的确认卡:作者只能在最终推送卡上闭环", async () => {
  // 内网实锤 2026-09-04:9 条意见经修复通道送出,Agent 中途举卡说全闭环,
  // 责任人点确认被"未闭环不能放行"拦下,作者又因回执未登记点不了通过,
  // 只剩"需要调整"。拦截只能放在人能闭环的地方——最终推送确认卡。
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-anno-kernel-"));
  mkdirSync(join(kernelRoot, "flow"));
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: {
      inspect: {
        approval_subject: { kind: "worktree" },
        choices: ["continue", "revise"],
        choice_answers: {
          continue: ["代码无需调整，继续提交"],
          revise: ["需要调整代码（按检视意见返工）"],
        },
        next: { continue: "commit", revise: "rework" },
      },
      commit: {},
      rework: { allow_source_edit: true },
    },
  }));
  const model = new ScriptedModelServer([{
    tool: { name: "AskUserQuestion", input: { questions: [{
      question: "这轮代码通过吗?",
      options: ["代码无需调整，继续提交", "需要调整代码（按检视意见返工）"],
      recommended: "代码无需调整，继续提交",
    }] } },
  }, { text: "继续。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-repair-gate-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("中途卡不拦修复轮意见").id;
    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务等人");
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "SmsHandler.java",
      line: 23, anchor: "retry(3)", note: "这里只重试网关错误", kind: "code",
    });
    const internal = (service as any).tasks.get(id);
    internal.summary.waiting.step = "inspect";
    (service.options as any).host = { kernelRoot, repoPath: "/unused" };
    // 模拟 MR 已开、意见经修复通道送出:回执要等本轮结束,作者此刻点不了通过。
    (service as any).annotations(internal)
      .markSent([note.id], "review_repair", "developer");
    (service as any).persist(internal);
    const waiting = service.get(id)!.waiting!;
    let rejected: unknown;
    try {
      await service.decide(id, {
        state_version: waiting.state_version,
        decision: "代码无需调整，继续提交",
      });
    } catch (error) {
      rejected = error;
    }
    assert.ok(!(rejected instanceof TaskControlError)
      || !/未闭环/.test(rejected.message),
      `中途确认卡不该被修复轮意见拦下:${String(rejected)}`);
    assert.equal(service.listAnnotations(id).items[0].status, "sent",
      "意见仍在账上,等最终推送卡上由作者闭环");
  } finally {
    await model.stop();
  }
});

test("批注 HTTP 面:圈注→清单带进展→送出走插话通道", async () => {
  const model = new ScriptedModelServer([
    { text: "先看看", tool: { name: "bash", input: { command: "sleep 2; echo OK" } } },
    { text: "按你圈的改完了。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-http-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${base}/tasks`, {
      method: "POST", body: JSON.stringify({ requirement: "给手机号打码" }),
    }).then((response) => readJson(response));
    const id: string = created.id;
    const confirmation = service.get(id)!.waiting!;
    const confirmationQuestion = (confirmation.question.questions as
      Array<{ question: string }>)[0].question;
    await service.decide(id, {
      waiting_id: confirmation.waiting_id,
      state_version: confirmation.state_version,
      selected_options: {
        [confirmationQuestion]: "需求已确认，进入需求分析",
      },
    });
    await until(() => model.requests.length >= 1, "模型开跑");

    const made = await fetch(`${base}/tasks/${id}/annotations`, {
      method: "POST",
      body: JSON.stringify({
        artifact: "未提交改动", file: "SmsHandler.java", line: 23,
        anchor: "retry(3)", note: "重试只该对网关失败生效", kind: "code",
      }),
    });
    assert.equal(made.status, 201);

    // 清单里能看见"我圈了什么、现在什么进展"
    const before = await fetch(`${base}/tasks/${id}/annotations`)
      .then((response) => readJson(response));
    assert.equal(before.items.length, 1);
    assert.equal(before.items[0].status, "draft");
    assert.equal(before.checks.length, 1);

    const sent = await fetch(`${base}/tasks/${id}/annotations/send`, {
      method: "POST", body: JSON.stringify({}),
    }).then((response) => readJson(response));
    assert.equal(sent.sent.length, 1);

    // 送出后不下架:状态翻成 sent,人还看得见"这条提过了"
    const after = await fetch(`${base}/tasks/${id}/annotations`)
      .then((response) => readJson(response));
    assert.equal(after.items[0].status, "sent");
    assert.equal(after.items[0].sent_via, "interrupt");

    await until(() => service.get(id)?.status === "completed", "任务收口");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? "")).join("\n");
    assert.match(seen, /重试只该对网关失败生效/);

    // AI 收到之后说的话要能在清单里看到(原话,不做逐条对应)——
    // 不然"不同意+理由"永远躺在会话流里,面板上像什么都没发生。
    const replied = await fetch(`${base}/tasks/${id}/annotations`)
      .then((response) => readJson(response));
    assert.ok(replied.reply, "送出之后必须带回 AI 的回话");
    assert.match(replied.reply.texts.join("\n"), /按你圈的改完了/);
  } finally {
    server.close();
    await model.stop();
  }
});

test("批注已主动送达后，检视决定的补充说明仍可提交且不重复送批注", async () => {
  const question = "这轮检视怎么处理?";
  const model = new ScriptedModelServer([
    { text: "先检查实现",
      tool: { name: "bash", input: { command: "sleep 2; echo CHECKED" } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question, options: ["继续调整", "确认通过"],
      recommended: "确认通过",
    }] } } },
    { text: "收到新的补充要求。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-sent-decision-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("主动批注后继续检视").id;
    await until(() => model.requests.length >= 1, "模型开跑");
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "SmsHandler.java",
      line: 23, anchor: "retry(3)", note: "这里只重试网关错误", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);
    const sentAt = service.listAnnotations(id).items[0].sent_at;
    assert.ok(sentAt, "主动送达后应记录 sent_at");
    // 2026-09-05 起意见没处理完不许举确认卡:这里替剧本模型把"处理完成"的
    // 机器回执写上(真模型由使命里的回执契约驱动),检视卡才会出现。
    const workspace = (service as any).tasks.get(id).summary.workspace as string;
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(join(workspace, "reviews", "local-receipts.json"), JSON.stringify({
      receipts: [{ annotation_id: note.id, revision: 0, outcome: "fixed",
        summary: "只对网关错误重试", evidence: ["SmsHandler.java:23"] }],
    }));

    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务进入检视");
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { [question]: "继续调整" },
      comment: "另外，请补一条失败指标埋点",
      // 模拟旧页面或并发刷新仍携带 sent ID；决定接口必须幂等跳过。
      annotation_ids: [note.id],
    });
    await until(() => service.get(id)?.status === "completed", "任务收口");

    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /另外，请补一条失败指标埋点/,
      "新补充说明必须进入 Agent 上下文");
    const after = service.listAnnotations(id).items[0];
    assert.equal(after.status, "sent");
    assert.equal(after.sent_at, sentAt, "已经送达的批注不能被决定重复发送");
  } finally {
    await model.stop();
  }
});

test("重锚定:缩进不同也算命中——两边必须一把尺子量", () => {
  // 实测事故:锚点是渲染时抓的(空白已折叠),文件里是原始缩进,
  // 直接 includes 一条带缩进的代码永远找不到,于是三条批注全被误报成
  // "这处已被改动",而代码一个字都没动。误报比不报更坏——人会以为
  // 提过的都落实了。
  const target = store();
  const one = seed(target, "这里用英文",
    { kind: "code", anchor: "? \"push 已发送\" + NotifyRenderer.SUFFIX" });
  const file = [
    "class PushChannelHandler {",
    "        return SendResult.ok(rendered.isDegraded()",
    "                ? \"push 已发送\" + NotifyRenderer.SUFFIX",
    "                : \"push 已发送\");",
  ].join("\n");
  const checks = reanchor(target.drafts(), () => file);
  assert.equal(checks[0].id, one.id);
  assert.notEqual(checks[0].state, "gone", "缩进差异不该被判成原文消失");
});

test("重锚定:渲染吃掉的 markdown 语法不该被判成原文消失", () => {
  // 2026-08-20 内网实锤:锚点是页面渲染后的 textContent,**加粗**、
  // `行内代码`、[链接]、表格 |、标题 # 的语法字符全被渲染剥掉;拿这份
  // "干净文本"回源文件搜,批注刚圈上(还没送给 agent)就被判"原位置
  // 内容已删除,请核查"。
  const target = store();
  const cases: Array<{ anchor: string; line: number }> = [
    { anchor: "修改 接口 并保持 幂等", line: 1 },        // 加粗+行内代码
    { anchor: "部署手册", line: 2 },                      // 链接显示文字
    { anchor: "步骤总览", line: 3 },                      // 标题
    { anchor: "单号 REQ1 状态 进行中", line: 4 },         // 表格行
    { anchor: "第 5 行", line: 5 },                       // 空行占位锚
  ];
  for (const item of cases) {
    seed(target, "检视意见", { anchor: item.anchor, line: item.line });
  }
  const file = [
    "修改 **接口** 并保持 `幂等`",
    "见 [部署手册](docs/deploy.md)",
    "## 步骤总览",
    "| 单号 | REQ1 | 状态 | 进行中 |",
    "",
  ].join("\n");
  const checks = reanchor(target.drafts(), () => file);
  for (const [at, check] of checks.entries()) {
    assert.notEqual(check.state, "gone",
      `第 ${at + 1} 条(${cases[at].anchor})不该被判成原文消失`);
  }
  // 真删了仍要如实报:诚实的 gone 不能被归一化磨掉。
  const removed = seed(target, "真没了", { anchor: "这句真的被删了" });
  const after = reanchor([removed], () => file);
  assert.equal(after[0].state, "gone");
});

test("重锚定:跨行代码块的整块锚点刚创建时不能立刻 gone", () => {
  const target = store();
  const block = seed(target, "代码块里的返回值要补判空", {
    line: 1,
    anchor: "const result = await load(); if (!result) return fallback;",
  });
  const source = [
    "```ts",
    "const result = await load();",
    "if (!result) return fallback;",
    "```",
  ].join("\n");
  const [check] = reanchor([block], () => source);
  assert.notEqual(check.state, "gone");
  assert.equal(check.line, 2, "跨行命中应定位到正文起始行");
});

test("划选一块:整块原文给模型看、跨行行号如实抬头、超长截断;定位仍靠首行", () => {
  const target = store();
  const base = {
    author: "developer", artifact: "REQ-1/spec.md", file: "spec.md",
    line: 3, anchor: "背景:先看渠道开关", kind: "doc" as const,
  };
  const item = target.add({ ...base, line_end: 5, note: "这一整段记下来",
    quote: "背景:先看渠道开关\n要求:\n不改 registry.xml" });
  assert.equal(item.line_end, 5);
  const text = renderAnnotations(target.drafts(), "T-1");
  assert.match(text, /第 3–5 行/);
  assert.match(text,
    /原文\(选中整块\):\n   \| 背景:先看渠道开关\n   \| 要求:\n   \| 不改 registry\.xml/);
  assert.doesNotMatch(text, /原文:背景/, "有整块就不再单抬首行,免得模型看两遍");
  const capped = target.add({ ...base, line_end: 2, note: "太长",
    quote: "长".repeat(3000) });
  assert.equal(capped.quote?.length, ANNOTATION_QUOTE_MAX + 1, "超长截断带省略号");
  assert.equal(capped.line_end, undefined, "末行不大于首行就不算跨行");
});

test("记为记忆可以只圈不写;交给人的意见仍必须有内容", () => {
  const target = store();
  const silent = target.add({
    author: "developer", artifact: "REQ-1/spec.md", file: "spec.md", line: 3,
    anchor: "背景:先看渠道开关", kind: "doc", route: "memory", note: "   ",
  });
  assert.equal(silent.note, "");
  assert.equal(silent.status, "verified");
  assert.throws(() => target.add({
    author: "developer", artifact: "REQ-1/spec.md", file: "spec.md", line: 3,
    anchor: "背景:先看渠道开关", kind: "doc", note: "",
  }), /批注内容不能为空/);
});

test("追问留档:作者改字重提时 Agent 的问题不随回执抹掉,下一轮渲染给模型看", () => {
  const target = store();
  const item = seed(target, "空值要处理");
  target.markSent([item.id], "interrupt");
  target.respond(item.id, {
    outcome: "needs_clarification", summary: "空值指的是入参还是返回值？", evidence: [],
  });
  const edited = target.edit(item.id, "空值指入参:入参为空时返回空列表", "developer");
  assert.equal(edited.status, "draft", "改字即退回待提交");
  assert.equal(edited.response, undefined);
  assert.deepEqual(edited.clarifications?.map((row) => row.question),
    ["空值指的是入参还是返回值？"]);
  const text = renderAnnotations(target.drafts(), "T-1");
  assert.match(text, /上一轮你问过:空值指的是入参还是返回值？/);
  assert.match(text, /不要再问同一件事/);
  assert.doesNotMatch(text, /第 2 次提出/, "补充说明不是返工,不许把它说成上一轮改坏了");
});

test("批注附图:只认资产路径,随记录落盘,给 Agent 的材料引导 inspect_image 逐张看", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-annot-img-"));
  const store = new AnnotationStore(join(dir, "annotations.jsonl"));
  const base = { author: "zhou", artifact: "docs/spec.md", file: "docs/spec.md", line: 3,
    anchor: "页面布局", kind: "doc" as const };
  assert.throws(() => store.add({ ...base, note: "按图改", images: [{ path: "/etc/passwd" }] }),
    /附图路径不合法/);
  const image = { path: ".mae-flow-work/review-assets/0123456789abcdef01234567.png", label: "期望效果" };
  const added = store.add({ ...base, note: "按这张图的布局改", images: [image] });
  assert.deepEqual(added.images, [image]);
  const reloaded = new AnnotationStore(join(dir, "annotations.jsonl")).list().find((item) => item.id === added.id)!;
  assert.deepEqual(reloaded.images, [image], "重放台账后附图引用还在");
  const text = renderAnnotations([added], "REQ1");
  assert.match(text, /附图 1 张,先用 inspect_image 逐张看清再动手/);
  assert.match(text, /- \.mae-flow-work\/review-assets\/0123456789abcdef01234567\.png\(期望效果\)/);
  const plain = store.add({ ...base, note: "不带图" });
  assert.equal(plain.images, undefined);
});

test("代码定位保留运算符，不能把不同代码当成同一原文", () => {
  const item = { id: "r1", artifact: "code", kind: "code" as const, anchor: "return a > b;", line: 1 };
  assert.equal(reanchor([item], () => "return a  b;")[0].state, "gone");
  assert.equal(reanchor([item], () => "// changed\nreturn a > b;")[0].line, 2);
});

test("重复代码用前后文区分，前一条修改造成行号漂移后仍重新定位", () => {
  const item = { id: "r2", artifact: "code", kind: "code" as const, anchor: "return null;", line: 2,
    context_before: "function second() {", context_after: "}" };
  const current = "// inserted\nfunction first() {\nreturn null;\n}\nfunction second() {\nreturn null;\n}";
  const check = reanchor([item], () => current)[0];
  assert.equal(check.state, "moved"); assert.equal(check.line, 6);
  assert.equal(reanchor([{ ...item, context_before: undefined, context_after: undefined }], () => current)[0].state, "ambiguous");
});

test("新增意见的上下文持久化并随 Agent 清单发送，明确历史与重新读取", () => {
  const target = store();
  seed(target, "补空值处理", { context_before: "function find() {", context_after: "}", anchor: "return value;", kind: "code" });
  const saved = target.list()[0];
  assert.equal(saved.context_before, "function find() {");
  const prompt = renderAnnotations([saved], "T-context");
  for (const text of ["批注时原文", "批注时前文", "批注时后文", "每条修改前读取当前文件", "不猜位置", "历史第"]) assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /当前代码/);
});

test("跨行代码原文保留换行，重复首行通过整块原文定位", () => {
  const item = { id: "multi", artifact: "code", kind: "code" as const, anchor: "if (ready) {", line: 1, line_end: 3,
    quote: "if (ready) {\n  return a > b;\n}" };
  const check = reanchor([item], () => "if (ready) {\n  return false;\n}\nif (ready) {\n  return a > b;\n}")[0];
  assert.equal(check.state, "moved");
  assert.equal(check.line, 4);
  assert.equal(check.line_end, 6);
});
