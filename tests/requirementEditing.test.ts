import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import { EventLog } from "../src/semanticEvents.ts";

const CONFIRM_STEP = "cloud_requirement_analysis_confirm";
const CONFIRM_OPTION = "需求已确认，进入需求分析";

// 经验起草旁路(afaba44)现在复用任务主模型,会向同一个剧本模型多发一次
// 独立请求,把 linear 剧本的下一幕吃掉;测试注入假件让旁路不碰剧本。
const memoryDrafter = async () =>
  JSON.stringify({ trigger: "闭环意见", scope: "one_off", conclusion: "测试候选，待人工确认。" });

function confirmationQuestion(task: ReturnType<TaskService["get"]>): string {
  const questions = task?.waiting?.question?.questions as
    | Array<{ question: string }> | undefined;
  assert.ok(questions?.[0]?.question);
  return questions[0].question;
}

test("修改需求时新意见立即入队，串行落实全部意见后仍需责任人逐条处置", async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const model = new ScriptedModelServer([
    { tool: { name: "edit", input: { path: "requirement.md",
      edits: [{ oldText: "第一段旧口径", newText: "第一段新口径\n新增一行说明" }] } } },
    { tool: { name: "write", input: { path: "receipts.json", content: "" } } },
    { text: "第一批已完成" },
    { tool: { name: "edit", input: { path: "requirement.md",
      edits: [{ oldText: "第二段旧口径", newText: "第二段新口径" }] } } },
    { tool: { name: "write", input: { path: "receipts.json", content: "" } } },
    { text: "第二批已完成" },
  ], "scripted-v1", { linear: true, beforeScene: async ({ index }) => {
    if (index === 1) { entered(); await held; }
  } });
  await model.start();
  let first: Promise<unknown> | undefined;
  try {
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-requirement-queue-")),
      provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
      memoryDrafter, maxConcurrent: 0,
    });
    const task = service.create("第一段旧口径\n\n第二段旧口径", {
      account: "owner", collaborators: ["reviewer"], requirementAnalysis: true,
      requirementAnalysisConfirmation: true,
    });
    const a = service.addAnnotation(task.id, { author: "owner",
      artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
      anchor: "第一段旧口径", note: "修改第一段", kind: "doc" });
    const b = service.addAnnotation(task.id, { author: "reviewer",
      artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 3,
      anchor: "第二段旧口径", note: "修改第二段", kind: "doc" });
    for (const [index, note] of [[1, a], [4, b]] as const) {
      model.script[index].tool!.input.content = JSON.stringify([{
        annotation_id: note.id, outcome: "fixed", summary: "已修改指定段落",
        evidence: [`requirement.md:${note.line}`],
      }]);
    }
    first = service.sendAnnotations(task.id, [a.id], "owner");
    await started;
    const processing = service.listAnnotations(task.id).items.find((item) => item.id === a.id)!;
    assert.equal(processing.status, "sent", "正在处理的意见不能仍被展示为草稿");
    assert.equal(processing.sent_via, "requirement_review");
    const repeated = await service.sendAnnotations(task.id, [a.id], "owner");
    assert.match(repeated.receipt ?? "", /1 条正在由 Agent 处理/);
    await assert.rejects(service.sendAnnotations(task.id, [a.id], "reviewer"), /只有当前任务责任人/);
    await assert.rejects(service.sendAnnotations(task.id, ["missing-id"], "owner"), /不存在/);
    const liveEvents = new EventLog(service.eventLogPath(task.id)).replay();
    assert.ok(liveEvents.some((event) => event.kind === "tool_requested"),
      "Agent 仍在处理时，执行日志接口读取的主日志里就应有工具调用");
    assert.ok(liveEvents.every((event) => event.taskId === task.id));
    await assert.rejects(service.sendAnnotations(task.id, [a.id], "owner", false, false, "后补的新要求"),
      /已经送出/, "重试不能把新增说明静默丢掉");
    const queued = await service.sendAnnotations(task.id, [a.id, b.id], "owner");
    assert.deepEqual(queued.sent, [a.id, b.id], "混合重试只把新意见入队，旧意见复用回执");
    assert.match(queued.receipt ?? "", /1 条正在由 Agent 处理.*1 条已排队/);
    const queuedNote = service.listAnnotations(task.id).items.find((item) => item.id === b.id)!;
    assert.equal(queuedNote.sent_via, "requirement_queue");
    assert.equal(queuedNote.status, "sent");
    const repeatedQueue = await service.sendAnnotations(task.id, [b.id], "owner");
    assert.match(repeatedQueue.receipt ?? "", /1 条已排队/);
    assert.throws(() => service.verifyAnnotation(task.id, b.id, "owner"), /处理依据/);
    const confirm = () => service.decide(task.id, {
      state_version: service.get(task.id)!.waiting!.state_version,
      selected_options: { [confirmationQuestion(service.get(task.id))]: CONFIRM_OPTION },
      actor: "owner",
    });
    await assert.rejects(confirm(), /正在修改需求文档/);
    release();
    await first;
    assert.deepEqual((model.requests[0].tools as Array<{ name: string }>).map((tool) => tool.name).sort(),
      ["edit", "read", "write"], "未配置视觉模型时只有三种文件工具，不影响排队修订");
    assert.doesNotMatch(JSON.stringify(model.requests[0].system), /Use bash for file operations like ls, rg, find/);
    const repeatedDone = await service.sendAnnotations(task.id, [b.id], "owner");
    assert.match(repeatedDone.receipt ?? "", /已有处理回执/);
    assert.equal(service.get(task.id)?.requirement, "第一段新口径\n新增一行说明\n\n第二段新口径");
    assert.match(JSON.stringify(model.requests[3]), /第 4 行/,
      "第一批插入一行后，下一批使命应使用当前行号");
    assert.equal(service.listAnnotations(task.id).items.find((item) => item.id === b.id)?.line, 3,
      "本轮使命使用重定位坐标，但原始批注的历史行号不改写");
    assert.deepEqual(service.get(task.id)?.requirement_revisions?.map((item) => item.annotation_ids), [[a.id], [b.id]]);
    const events = new EventLog(service.eventLogPath(task.id)).replay();
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length,
      "多轮事件编号不能重复，否则页面会去重丢掉后一轮");
    assert.equal(new Set(events.map((event) => event.sessionId)).size, 2);
    for (const revision of service.get(task.id)!.requirement_revisions!) {
      assert.ok(events.some((event) => event.sessionId === `requirement-review:${revision.id}`
        && event.kind === "tool_finished"));
      assert.ok(readFileSync(join(task.workspace, "requirement-history",
        `${revision.id}.transcript.jsonl`), "utf-8").length > 0,
      "临时副本清理后，每轮会话记录必须仍可读取");
      assert.equal(existsSync(join(task.workspace, "requirement-review", revision.id)), false);
    }
    assert.equal(service.listAnnotations(task.id).items.find((item) => item.id === b.id)?.response?.outcome, "fixed");
    await assert.rejects(confirm(), /2 条意见仍待责任人逐条处置/);
    await service.verifyAnnotation(task.id, a.id, "owner");
    await service.verifyAnnotation(task.id, b.id, "owner");
    await confirm();
  } finally {
    release();
    await first?.catch(() => undefined);
    await model.stop();
  }
});

test("新下单先在工作台确认需求，不会提前进入执行队列", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-confirm-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, memoryDrafter, maxConcurrent: 0,
  });
  const created = service.create("# 用户需求\n先共同核对", {
    account: "owner",
    requirementDocumentName: "业务需求.md",
    requirementAnalysisConfirmation: true,
  });

  assert.equal(created.status, "waiting_for_human");
  assert.equal(created.waiting?.step, CONFIRM_STEP);
  assert.equal(service.get(created.id)?.waiting?.recommended_view, "source");
  assert.equal(created.requirement_analysis_confirmed_at, undefined);

  const saved = JSON.parse(readFileSync(
    join(created.workspace, "task.json"), "utf-8"));
  assert.equal(saved.summary.status, "waiting_for_human");
  assert.equal(saved.summary.waiting.step, CONFIRM_STEP);
});

test("多人检视意见由 Agent 修改同一份需求，全部闭环后才能确认分析", async () => {
  // 剧本按请求顺序演:第 1 个会话没有写回执 → 整轮拒收；后两轮都
  // 用 Edit 修改副本、用 Write 单独留下小型 JSON 回执。
  const model = new ScriptedModelServer([{
    text: "我没有完成逐条回执。",
  }, {
    tool: { name: "edit", input: {
      path: "requirement.md",
      edits: [{ oldText: "原始口径", newText: "已补充验收口径" }],
    } },
  }, {
    tool: { name: "write", input: {
      path: "receipts.json",
      content: '[{"annotation_id":"__OWNER__","outcome":"fixed","summary":"补了验收口径","evidence":["requirement.md:2"]}]',
    } },
  }, {
    text: "已修改文档并留下逐条回执。",
  }, {
    tool: { name: "edit", input: {
      path: "requirement.md",
      edits: [{
        oldText: "已补充验收口径",
        newText: "已补充验收口径\n已明确异常场景",
      }],
    } },
  }, {
    tool: { name: "write", input: {
      path: "receipts.json",
      content: '[{"annotation_id":"__REVIEWER__","outcome":"fixed","summary":"补了异常场景","evidence":["requirement.md:4"]}]',
    } },
  }, {
    text: "已修改文档并留下逐条回执。",
  }], "scripted-v1", { linear: true });
  await model.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-review-"));
    const service = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), memoryDrafter, maxConcurrent: 0,
    });
    const created = service.create("# 用户需求\n原始口径", {
      account: "owner", collaborators: ["reviewer"],
      requirementAnalysis: true,
      requirementAnalysisConfirmation: true,
    });
    const ownerNote = service.addAnnotation(created.id, {
      author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 2, anchor: "原始口径",
      note: "补充可核对的验收口径", kind: "doc",
    });
    const reviewerNote = service.addAnnotation(created.id, {
      author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 2, anchor: "原始口径",
      note: "再明确异常场景", kind: "doc",
    });
    const question = confirmationQuestion(service.get(created.id));

    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "reviewer",
    }), (error) => error instanceof TaskControlError
      && /只有主责任人 owner/.test(error.message));

    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    }), (error) => error instanceof TaskControlError
      && /2 条意见尚未提交/.test(error.message));

    // 剧本里的占位 id 换成真实 id:回执必须能指回同一条意见。
    for (const scene of model.script) {
      if (scene.text) {
        scene.text = scene.text
          .replace("__OWNER__", ownerNote.id)
          .replace("__REVIEWER__", reviewerNote.id);
      }
      const content = scene.tool?.input.content;
      if (typeof content === "string") {
        scene.tool!.input.content = content
          .replace("__OWNER__", ownerNote.id)
          .replace("__REVIEWER__", reviewerNote.id);
      }
    }
    // 第 1 轮:没落回执 → 整轮拒收,文档一个字不动,意见还是草稿。
    await assert.rejects(
      service.sendAnnotations(created.id, [ownerNote.id], "owner"),
      (error) => error instanceof TaskControlError
        && /没有留下逐条检视回执/.test(error.message));
    assert.equal(service.get(created.id)?.requirement, "# 用户需求\n原始口径");
    assert.equal(service.listAnnotations(created.id).items
      .find((item) => item.id === ownerNote.id)?.status, "draft");
    assert.equal(service.get(created.id)?.requirement_revision?.state, "failed");

    await service.sendAnnotations(created.id, [ownerNote.id], "owner");
    assert.equal(service.get(created.id)?.requirement,
      "# 用户需求\n已补充验收口径");
    assert.equal(service.get(created.id)?.status, "waiting_for_human");
    const ownerSent = service.listAnnotations(created.id).items
      .find((item) => item.id === ownerNote.id)!;
    assert.equal(ownerSent.status, "sent");
    assert.equal(ownerSent.response?.outcome, "fixed",
      "逐条回执要落到意见上,页面才有'Agent:已处理'可看");
    assert.equal(ownerSent.response?.summary, "补了验收口径");
    // 改前全文和 diff 留了底,页面按 id 取对比。
    const revisions = service.get(created.id)?.requirement_revisions ?? [];
    assert.equal(revisions.length, 1);
    assert.deepEqual(revisions[0].annotation_ids, [ownerNote.id]);
    assert.equal(revisions[0].additions, 1);
    assert.equal(revisions[0].deletions, 1);
    const stored = service.requirementRevision(created.id, revisions[0].id)!;
    assert.equal(stored.before, "# 用户需求\n原始口径");
    assert.match(stored.diff, /^diff --git a\/需求原文\.md b\/需求原文\.md/m);
    assert.match(stored.diff, /^-原始口径$/m);
    assert.match(stored.diff, /^\+已补充验收口径$/m);
    assert.equal(service.requirementRevision(created.id, "../etc"), undefined);

    await service.verifyAnnotation(created.id, ownerNote.id, "owner");
    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    }), (error) => error instanceof TaskControlError
      && /1 条意见尚未提交/.test(error.message),
    "受邀参与者留下的草稿也不能被责任人越过");

    await service.sendAnnotations(created.id, [reviewerNote.id], "owner");
    assert.equal(service.get(created.id)?.requirement,
      "# 用户需求\n已补充验收口径\n已明确异常场景");
    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    }), (error) => error instanceof TaskControlError
      && /1 条意见仍待责任人逐条处置/.test(error.message));

    await service.verifyAnnotation(created.id, reviewerNote.id, "owner");
    await service.decide(created.id, {
      waiting_id: service.get(created.id)!.waiting!.waiting_id,
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    });

    const confirmed = service.get(created.id)!;
    assert.equal(confirmed.status, "queued");
    assert.equal(confirmed.waiting, undefined);
    assert.ok(confirmed.requirement_analysis_confirmed_at);
    assert.equal(confirmed.requirement,
      "# 用户需求\n已补充验收口径\n已明确异常场景");
    assert.equal(service.listAnnotations(created.id).items
      .find((item) => item.id === reviewerNote.id)?.response?.outcome, "fixed");
    assert.equal(model.requests.length, 7,
      "需求确认只启动专用文件编辑会话(含被拒收的一轮)，不会提前启动主执行会话");
    const firstRequest = JSON.stringify(model.requests[0]);
    assert.doesNotMatch(firstRequest, /## 当前需求文档/,
      "使命只给文件位置和意见，不再把完整原文塞进模型请求");
    assert.match(firstRequest, /requirement\.md/);
  } finally {
    await model.stop();
  }
});

test("服务重启会恢复被中断的需求修改，不留下永久 running", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-recover-"));
  const first = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, memoryDrafter, maxConcurrent: 0,
  });
  const created = first.create("待修改需求", {
    account: "owner", requirementAnalysisConfirmation: true,
  });
  const note = first.addAnnotation(created.id, {
    author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "待修改需求",
    note: "补充验收条件", kind: "doc",
  });
  const internal = (first as any).tasks.get(created.id);
  (first as any).annotations(internal).markSent([note.id], "interrupt");
  const queued = first.addAnnotation(created.id, {
    author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "待修改需求",
    note: "还要补异常场景", kind: "doc",
  });
  (first as any).annotations(internal).markSent([queued.id], "requirement_queue");
  internal.summary.requirement_revision = {
    id: "revision-before-restart", state: "running",
    annotation_ids: [note.id], started_at: new Date().toISOString(),
  };
  (first as any).persist(internal);

  const recovered = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, memoryDrafter, maxConcurrent: 0,
  });
  assert.equal(recovered.recover().restored, 1);
  const task = recovered.get(created.id)!;
  assert.equal(task.status, "waiting_for_human");
  assert.equal(task.waiting?.step, CONFIRM_STEP);
  assert.equal(task.requirement_revision?.state, "failed");
  assert.match(task.requirement_revision?.error ?? "", /重新提交/);
  assert.equal(recovered.listAnnotations(created.id).items[0].status, "draft");
  assert.equal(recovered.listAnnotations(created.id).items[1].status, "draft");
  assert.equal(recovered.listAnnotations(created.id).items[1].note, "还要补异常场景");
});

test("长需求由 Agent 原位编辑，不再要求模型往回复里搬运全文", async () => {
  const model = new ScriptedModelServer([{
    tool: { name: "edit", input: {
      path: "requirement.md",
      edits: [{ oldText: "验收口径：旧", newText: "验收口径：新" }],
    } },
  }, {
    tool: { name: "write", input: {
      path: "receipts.json",
      content: '[{"annotation_id":"__NOTE__","outcome":"fixed","summary":"更新验收口径","evidence":["requirement.md:2"]}]',
    } },
  }, {
    text: "已完成一处原位修改。",
  }], "scripted-v1", { linear: true });
  await model.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-long-"));
    const service = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), memoryDrafter, maxConcurrent: 0,
    });
    const tail = `正文保持不变-${"长内容".repeat(45_000)}-LONG-DOCUMENT-TAIL`;
    const created = service.create(`验收口径：旧\n\n${tail}`, {
      account: "owner", requirementAnalysisConfirmation: true,
    });
    const note = service.addAnnotation(created.id, {
      author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "验收口径：旧",
      note: "改成新口径", kind: "doc",
    });
    model.script[1].tool!.input.content = String(
      model.script[1].tool!.input.content).replace("__NOTE__", note.id);

    await service.sendAnnotations(created.id, [note.id], "owner");
    assert.equal(service.get(created.id)?.requirement,
      `验收口径：新\n\n${tail}`, "未命中的十几万字必须逐字保留");
    assert.doesNotMatch(JSON.stringify(model.requests[0]), /LONG-DOCUMENT-TAIL/,
      "首轮模型请求不能再内联完整需求文档");
    assert.equal(existsSync(join(created.workspace, "requirement-review",
      service.get(created.id)!.requirement_revisions![0].id)), false,
    "成功后清掉临时副本，权威历史只保留在 requirement-history");
  } finally {
    await model.stop();
  }
});

test("需求修改 Agent 不能用 Write 整篇覆盖原文", async () => {
  const model = new ScriptedModelServer([{
    tool: { name: "write", input: {
      path: "requirement.md", content: "半截输出",
    } },
  }, {
    tool: { name: "edit", input: {
      path: "requirement.md",
      edits: [{ oldText: "旧口径", newText: "新口径" }],
    } },
  }, {
    tool: { name: "write", input: {
      path: "receipts.json",
      content: '[{"annotation_id":"__NOTE__","outcome":"fixed","summary":"更新了验收口径","evidence":["requirement.md:2"]}]',
    } },
  }, {
    text: "已改用 Edit 完成。",
  }], "scripted-v1", { linear: true });
  await model.start();
  try {
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-requirement-write-guard-")),
      provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), memoryDrafter, maxConcurrent: 0,
    });
    const created = service.create("旧口径\n\n必须保留", {
      account: "owner", requirementAnalysisConfirmation: true,
    });
    const note = service.addAnnotation(created.id, {
      author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "旧口径",
      note: "更新口径", kind: "doc",
    });
    model.script[2].tool!.input.content = String(
      model.script[2].tool!.input.content).replace("__NOTE__", note.id);

    await service.sendAnnotations(created.id, [note.id], "owner");
    assert.equal(service.get(created.id)?.requirement, "新口径\n\n必须保留");
    assert.match(JSON.stringify(model.requests[1]), /禁止用 Write 覆盖需求原文/,
      "模型必须真实收到门禁说明，不能只靠提示词约定");
  } finally {
    await model.stop();
  }
});
