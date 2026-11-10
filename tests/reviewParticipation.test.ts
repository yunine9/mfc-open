import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { readJson } from "../src/jsonBody.ts";
import { isInvitedReviewParticipant } from "../src/reviewParticipation.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

test("前后端共用检视参与权限：没有分析图也能提交，分析结束也不丢邀请", () => {
  for (const stage of [undefined, "analysis", "confirmed"]) {
    const task = { collaborators: ["guest"], requirement_graph: stage
      ? { stage, repositories: [{ assignee: "assignee" }] } : undefined };
    assert.equal(isInvitedReviewParticipant(task, "guest"), true);
    assert.equal(isInvitedReviewParticipant(task, "assignee"), !!stage);
    assert.equal(isInvitedReviewParticipant(task, "outsider"), false);
    assert.equal(isInvitedReviewParticipant(task, undefined), false);
  }
});

test("受邀协作者可记下意见，仅责任人经 HTTP 交给 Agent 和确认需求", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-review-participant-"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = new ScriptedModelServer([
    { tool: { name: "edit", input: { path: "requirement.md", edits: [{ oldText: "旧口径", newText: "新口径" }] } } },
    { tool: { name: "write", input: { path: "receipts.json", content: "" } } },
    { text: "已修改需求" },
  ], "scripted-v1", { linear: true, beforeScene: async ({ index }) => {
    if (index === 0) await held;
  } });
  await model.start();
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("owner", "owner-password-1", "developer");
  auth.createUser("guest", "guest-password-1", "developer");
  auth.createUser("outsider", "outsider-password-1", "developer");
  const service = new TaskService({ dataDir: join(root, "tasks"), maxConcurrent: 0,
    provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson() });
  const task = service.create("旧口径", { account: "owner", collaborators: ["guest"],
    requirementAnalysis: true, requirementAnalysisConfirmation: true });
  assert.equal(task.requirement_graph, undefined, "复现还没进入分析阶段的需求预检");
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string) => {
    const response = await fetch(`${base}/auth/login`, { method: "POST",
      body: JSON.stringify({ username, password: `${username}-password-1` }) });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    const owner = await login("owner");
    const guest = await login("guest");
    const outsider = await login("outsider");
    const annotation = (author: string) => service.addAnnotation(task.id, { author,
      artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
      anchor: "旧口径", note: "更新口径", kind: "doc" });
    const mine = annotation("guest");
    const foreign = annotation("owner");
    const outsideNote = annotation("outsider");
    const send = (cookie: string, id: string) => fetch(`${base}/tasks/${task.id}/annotations/send`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ ids: [id] }),
      signal: AbortSignal.timeout(2000),
    });
    const denied = await send(outsider, outsideNote.id);
    assert.equal(denied.status, 403);
    const cannotForward = await send(guest, foreign.id);
    assert.equal(cannotForward.status, 403);
    assert.match(JSON.stringify(await readJson(cannotForward)), /只有当前任务责任人/);
    model.script[1].tool!.input.content = JSON.stringify([{ annotation_id: mine.id,
      outcome: "fixed", summary: "按邀请人的意见更新口径", evidence: ["requirement.md:1"] }]);
    assert.equal((await send(guest, mine.id)).status, 403, "作者身份不能代替责任人");
    const sent = await send(owner, mine.id);
    const result = await readJson(sent) as { sent: string[]; receipt?: string };
    assert.equal(sent.status, 200, JSON.stringify(result));
    assert.deepEqual(result.sent, [mine.id]);
    assert.match(result.receipt ?? "", /正在由 Agent 处理/);
    assert.equal(service.get(task.id)?.requirement, "旧口径", "Agent 尚未处理完，HTTP 就应返回回执");
    assert.equal(service.listAnnotations(task.id).items.find((item) => item.id === mine.id)?.sent_via, "requirement_review");
    const repeated = await send(owner, mine.id);
    assert.equal(repeated.status, 200, "第一轮仍在处理时，重复提交也立即回执");
    release();
    const deadline = Date.now() + 5000;
    while (service.get(task.id)?.requirement_revision?.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.get(task.id)?.requirement, "新口径");
    const own = service.listAnnotations(task.id).items.find((item) => item.id === mine.id)!;
    assert.equal(own.author, "guest");
    assert.equal(own.sent_by, "owner");
    assert.equal(own.response?.outcome, "fixed");
    const decide = await fetch(`${base}/tasks/${task.id}/decision`, { method: "POST",
      headers: { cookie: guest }, body: JSON.stringify({}) });
    assert.equal(decide.status, 403, "提交本人意见不能获得最终需求确认权限");
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await model.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
