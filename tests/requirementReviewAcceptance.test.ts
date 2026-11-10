import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

test("需求意见可连带修改三个未圈选表格，保留全部 diff 与回执并等待人工检视", async () => {
  const tables = ["user_id", "account_id", "owner_id"].map((name) =>
    `| 字段名 | 类型 | 约束 | 说明 |\n|--------|------|------|------|\n| ${name} | string | 可选 | 标识 |`);
  const updated = tables.map((table) => table.replace("可选", "必填").replace(/--------/g, "----------"));
  const original = `# 用户需求\n\n三个接口的标识要求待补充。\n\n${tables.join("\n\n")}`;
  const expected = `# 用户需求\n\n三个接口的标识均为必填。\n\n${updated.join("\n\n")}`;
  const model = new ScriptedModelServer([{
    tool: { name: "edit", input: { path: "requirement.md", edits: [
      { oldText: "三个接口的标识要求待补充。", newText: "三个接口的标识均为必填。" },
      ...tables.map((table, index) => ({ oldText: table, newText: updated[index] })),
    ] } },
  }, {
    tool: { name: "write", input: { path: "receipts.json", content: JSON.stringify([{
      annotation_id: "__NOTE__", outcome: "fixed",
      summary: "统一标识约束，同时更新三个接口表格，供人工检视。",
      evidence: ["requirement.md:3", "requirement.md:5-15"],
    }]) } },
  }, { text: "已补齐要求及三个表格，等待人工检视。" }], "scripted-v1", { linear: true });
  await model.start();
  try {
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-review-acceptance-")),
      provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(), maxConcurrent: 0,
    });
    const task = service.create(original, {
      account: "owner", requirementAnalysis: true, requirementAnalysisConfirmation: true,
    });
    const note = service.addAnnotation(task.id, {
      author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文",
      line: 3, anchor: "三个接口的标识要求待补充。", note: "统一三个接口，标识必须填写。", kind: "doc",
    });
    model.script[1].tool!.input.content = String(model.script[1].tool!.input.content).replace("__NOTE__", note.id);
    await service.sendAnnotations(task.id, [note.id], "owner");
    assert.match(JSON.stringify(model.requests[0]), /必要的相关表格、定义和上下文一起调整/);
    assert.doesNotMatch(JSON.stringify(model.requests[0]), /只改这些地方|未被意见要求改变的段落必须保留/,
      "专项使命不能一边允许连带修改、一边仍要求固定段落不动");
    const current = service.get(task.id)!;
    assert.equal(current.requirement, expected, "连带修改不再整轮撤销");
    assert.equal(current.requirement_revision, undefined, "不标为失败或待重新提交");
    assert.equal(current.status, "waiting_for_human", "写入原文并不等于人工已确认");
    const revision = current.requirement_revisions!.at(-1)!;
    const history = join(task.workspace, "requirement-history", revision.id);
    assert.equal(readFileSync(`${history}.before.md`, "utf8"), original);
    const diff = readFileSync(`${history}.diff`, "utf8");
    for (const name of ["user_id", "account_id", "owner_id"]) {
      assert.ok(diff.includes(`-${tables.find((table) => table.includes(name))!.split("\n")[2]}`));
      assert.ok(diff.includes(`+${updated.find((table) => table.includes(name))!.split("\n")[2]}`));
    }
    const item = service.listAnnotations(task.id).items.find((item) => item.id === note.id)!;
    assert.equal(item.status, "sent", "由人复检，不自动把意见标成已确认");
    assert.equal(item.response?.outcome, "fixed");
    assert.equal(item.returned ?? 0, 0);
    assert.equal(item.verified_at, undefined);
    assert.match(item.response!.summary, /三个接口表格/);
  } finally {
    await model.stop();
  }
});

for (const action of ["reopen", "edit", "resolve"] as const) {
  test(`需求修订中禁止抢先 ${action}，收到回执后责任人可继续处理`, async () => {
    let service: TaskService;
    let taskId = "", annotationId = "";
    const model = new ScriptedModelServer([
      { tool: { name: "edit", input: { path: "requirement.md", edits: [{ oldText: "返回值说明待补充。", newText: "返回值包含错误码和明确说明。" }] } } },
      { tool: { name: "write", input: { path: "receipts.json", content: "[]" } } },
      { text: "已补充返回值约定，请核对修改。" },
    ], "scripted-v1", { linear: true, beforeScene: async ({ index }) => {
      if (index !== 2) return;
      // 写出 receipts.json 还不等于宿主已接收回执；不能在此窗口改掉正在处理的版本。
      if (action === "reopen") await assert.rejects(service.reopenAnnotation(taskId, annotationId, "owner", 0), /尚在处理/);
      else if (action === "edit") assert.throws(() => service.editAnnotation(taskId, annotationId, "请再补充返回值的具体示例", "owner"), /已交给 Agent/);
      else assert.throws(() => service.verifyAnnotation(taskId, annotationId, "owner", false,
        { revision: 0, outcome: "deferred", reason: "已确认后续版本补充该约定" }), /取得处理依据/);
    } });
    await model.start();
    try {
      service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "mfc-review-late-")),
        provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(), maxConcurrent: 0 });
      const task = service.create("# 接口要求\n返回值说明待补充。", {
        account: "owner", requirementAnalysis: true, requirementAnalysisConfirmation: true });
      taskId = task.id;
      const item = service.addAnnotation(taskId, { author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
        file: "需求原文", line: 2, anchor: "返回值说明待补充。", note: "补充返回值说明", kind: "doc" });
      annotationId = item.id;
      model.script[1].tool!.input.content = JSON.stringify([{ annotation_id: item.id, revision: 0,
        outcome: "fixed", summary: "已补充返回值必须包含错误码和明确说明的约定", evidence: ["requirement.md:2"] }]);
      await service.sendAnnotations(taskId, [item.id], "owner");
      assert.equal(service.listAnnotations(taskId).items[0].response?.outcome, "fixed");
      if (action === "resolve") service.verifyAnnotation(taskId, annotationId, "owner", false,
        { revision: 0, outcome: "deferred", reason: "已确认后续版本补充该约定" });
      else {
        await service.reopenAnnotation(taskId, annotationId, "owner", 0);
        if (action === "edit") service.editAnnotation(taskId, annotationId, "请再补充返回值的具体示例", "owner");
      }
      const saved = service.listAnnotations(taskId).items[0];
      assert.equal(saved.status, action === "resolve" ? "verified" : "draft");
      assert.equal(saved.response?.outcome, action === "resolve" ? "fixed" : undefined);
      assert.equal(saved.rework ?? 0, action === "resolve" ? 0 : action === "edit" ? 2 : 1);
      assert.equal(service.get(taskId)!.requirement_revision, undefined);
      assert.match(service.get(taskId)!.requirement, /错误码和明确说明/);
      if (action === "resolve") assert.equal(saved.resolution?.outcome, "deferred");
    } finally { await model.stop(); }
  });
}
