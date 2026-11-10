import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { genericDomainSkillFixture, pinDomainSkillFixture, runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";

const document = { id: "scope", title: "取消范围", target_id: "domain", path: "docs/取消业务/scope.md", layer: "domain" as const,
  content: "# 取消范围\n\n原有业务规则。", sources: "此前已读取的取消入口和业务资料" };
const finished = { status: "turn_finished", reason: "end_turn" };
const model = () => ({ provider: "fixture", model: "fixture", json: {} });
const source = async () => { throw new Error("补交结果不得重新萃取源码"); };
const contextOf = (prompt: string) => JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);

async function terminal(service: DomainKnowledgeExtraction, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = service.get(id);
    if (["done", "paused", "failed", "cancelled"].includes(job.status)) {
      await new Promise(resolve => setTimeout(resolve, 0));
      return service.get(id);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`任务未及时结束：${service.get(id).stage}`);
}

function caller(config: any) {
  return async (name: string, input: Record<string, unknown>, expectedError = false) => {
    const tool = config.extraTools.find((candidate: any) => candidate.name === name);
    assert.ok(tool, name);
    const response = await tool.execute("completion-recovery", input, new AbortController().signal);
    const text = response.content[0].text;
    const eventId = config.eventLog.lastEventId() + 1;
    // Pi 对工具正常返回的业务错误也记录 is_error=false；宿主还须读取结果中的 error。
    config.eventLog.append({ eventId, taskId: config.taskId, sessionId: "main", ts: new Date().toISOString(), kind: "tool_finished",
      payload: { call_id: `completion-${eventId}`, name, input, is_error: false, result: text } });
    assert.equal(!!response.isError, expectedError, `${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

function genericService(root: string) {
  return new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(genericDomainSkillFixture, input, { dataDir: root, model, source }));
}
function create(service: DomainKnowledgeExtraction) {
  return service.create({ issue_no: "REQ-completion", title: "取消业务", scope: "保留既有调查并完成本轮", repositories: [] }, "expert");
}

test("检视主会话、只读调查、写作和评审普通回复结束后补交各自结果，已保存修改不重写", async () => {
  const root = mkdtempSync(join(tmpdir(), "revision-completion-"));
  const resumed: string[] = [], started: string[] = [];
  let writes = 0, originalExecutions = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    let context: any, role = "";
    const call = caller(config);
    return {
      start: async (prompt: string) => {
        context = contextOf(prompt); role = context.reviewing ? "reviewer" : context.step?.id ?? "coordinator";
        started.push(role);
        assert.equal(context.mode, "revise");
        if (role === "coordinator") {
          await call("knowledge_work", { action: "save_document", document: { id: "revision-plan", title: "本轮修订进度", content: "只修正取消范围，沿用原调查与文稿。" } });
          await call("knowledge_work", { action: "schedule", steps: [
            { id: "research", title: "核实意见", instructions: "回读既有取消规则，保存核实结论", readonly: true, depends_on: [] },
            { id: "writer", title: "修正取消范围", instructions: "只修正范围，不重新研究", readonly: false, depends_on: ["research"],
              expected_document_ids: [document.id], review: { instructions: "完整回读修改后的取消范围并独立核查" } },
          ] });
          assert.equal((await call("knowledge_work", { action: "run" })).complete, true);
        } else {
          const existing = await call("knowledge_draft", { action: "read", id: document.id });
          if (role === "writer") {
            writes++;
            await call("knowledge_draft", { action: "save", document: { ...document, content: "# 取消范围\n\n仅未结算订单支持取消。" } });
          } else if (role === "reviewer") {
            assert.match(existing.content, /仅未结算订单/);
            await call("knowledge_diagram_check", { document_id: document.id });
          }
        }
        return finished;
      },
      startResume: async (prompt: string) => {
        resumed.push(role);
        assert.match(prompt, /knowledge_work_result/);
        assert.match(prompt, /research|writer|scope|revision-plan/, "补交提示须包含当前工作记录，而非重复泛化提醒");
        await call("knowledge_work_result", {
          summary: `${role} 已核对并保存本轮结果`, document_ids: role === "research" ? [] : [document.id],
          ...(role === "reviewer" ? { review: { pass: true, feedback: "完整回读取消范围，与本轮意见及原来源一致。" } } : {}),
        });
        return finished;
      }, dispose() {}, abort: async () => {},
    } as any;
  });
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      originalExecutions++;
      const skill = pinDomainSkillFixture(input.root, genericDomainSkillFixture);
      input.update({ skill: { name: skill.name, digest: skill.digest } });
      input.save(document, { content: null, revision: "a".repeat(40) });
      return "已有长任务萃取完成";
    }
    return runDomainKnowledge(input, { dataDir: root, model, source });
  });
  try {
    const job = create(service);
    const original = await terminal(service, job.id);
    assert.equal(original.status, "done", original.error);
    const skillPath = join(root, "domain-extraction", job.id, "skill.json"), originalSkill = readFileSync(skillPath, "utf8");
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "仅保留未结算订单的取消范围，沿用原调查" }, "expert");
    const after = await terminal(service, job.id);
    assert.equal(after.status, "done", after.error);
    assert.equal(originalExecutions, 1); assert.equal(writes, 1);
    assert.deepEqual(started, ["coordinator", "research", "writer", "reviewer"]);
    assert.deepEqual(resumed, ["research", "writer", "reviewer", "coordinator"]);
    assert.deepEqual(after.documents, original.documents, "人工确认前保留原稿和历史");
    assert.equal(after.turns.length, 2); assert.equal(after.turns[0].id, original.turns[0].id);
    assert.equal(after.turns[1].skill?.name, "business-docs-reviser");
    assert.equal(after.turns[1].proposals.length, 1);
    assert.match(after.turns[1].proposals[0].document.content, /仅未结算订单/);
    assert.equal(readFileSync(skillPath, "utf8"), originalSkill);
    assert.equal(after.work_documents?.find(item => item.id === "revision-plan")?.content, "只修正取消范围，沿用原调查与文稿。");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("重复读取无新进展时仅重建一次模型上下文，读取已保存文稿补交而不重新萃取", async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-fresh-context-"));
  const sessions: boolean[] = [];
  let reads = 0, writes = 0, firstContext: any;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    sessions.push(config.resumeSession);
    const call = caller(config);
    return {
      start: async (prompt: string) => {
        const context = contextOf(prompt);
        if (config.resumeSession) {
          firstContext = context; writes++;
          await call("knowledge_draft", { action: "save", document });
          await call("knowledge_work", { action: "save_document", document: { id: "saved-plan", title: "原调查进度", content: "原研究已完成，只待保存结论。" } });
        } else {
          assert.equal(context.mode, firstContext.mode);
          assert.equal(context.continued, firstContext.continued, "模型上下文重建不创建任务接续回合");
          assert.match(prompt, /generic-domain-fixture/);
          assert.equal((await call("knowledge_draft", { action: "read", id: document.id })).content, document.content);
          assert.equal((await call("knowledge_work", { action: "read_document", id: "saved-plan" })).content, "原研究已完成，只待保存结论。");
          await call("knowledge_work_result", { summary: "基于原保存内容完成", document_ids: [document.id], work_document_ids: ["saved-plan"] });
        }
        return finished;
      },
      startResume: async () => {
        assert.ok(++reads <= 8, "同一读取不能无限延长补交循环");
        await call("knowledge_draft", { action: "read", id: document.id });
        return finished;
      }, dispose() {}, abort: async () => {},
    } as any;
  });
  const service = genericService(root);
  try {
    const job = create(service), after = await terminal(service, job.id);
    assert.equal(after.status, "done", after.error);
    assert.deepEqual(sessions, [true, false]); assert.equal(writes, 1);
    assert.ok(reads >= 3 && reads <= 5);
    assert.equal(after.turns.length, 1); assert.equal(after.turns[0].id, job.turns[0].id);
    assert.equal(after.turns[0].pipeline_continue ?? 0, 0);
    assert.equal(after.documents[0].revision, 1); assert.deepEqual(after.documents[0].history, []);
    assert.equal(after.documents[0].content, document.content);
    assert.equal(after.turns[0].skill?.name, "generic-domain-fixture");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("补交仍失败时保留真正的工具拒绝原因，重复读取有界且不伪造完成或等待用户", async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-real-cause-"));
  const sessions: boolean[] = [], reminders: string[] = [];
  let reads = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    sessions.push(config.resumeSession);
    const call = caller(config);
    return {
      start: async () => {
        if (config.resumeSession) await call("knowledge_draft", { action: "save", document });
        await call("knowledge_work_result", { summary: "误引不存在的文稿", document_ids: ["missing-document"] }, true);
        return finished;
      },
      startResume: async (prompt: string) => {
        reminders.push(prompt);
        assert.ok(++reads <= 12, "相同读取不能掩盖未解决的提交失败");
        await call("knowledge_draft", { action: "read", id: document.id });
        return finished;
      }, dispose() {}, abort: async () => {},
    } as any;
  });
  const service = genericService(root);
  try {
    const job = create(service), after = await terminal(service, job.id);
    assert.equal(after.status, "failed");
    assert.deepEqual(sessions, [true, false]);
    assert.ok(reads <= 10, `重复读取次数 ${reads}`);
    assert.match(after.error ?? "", /请填写执行结论并引用已有文档/);
    assert.ok(reminders.every(prompt => /请填写执行结论并引用已有文档/.test(prompt)), "恢复提示必须携带具体拒绝原因");
    assert.equal(after.turns[0].waiting, undefined);
    assert.equal(after.turns[0].reply, undefined);
    assert.equal(after.documents[0].content, document.content);
    assert.equal(after.documents[0].revision, 1);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

for (const tail of ["throw", "failed-outcome"] as const) test(`结果已保存后模型末尾回复 ${tail} 不抹掉已通过校验的结论`, async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-saved-tail-"));
  let sessions = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async () => {
      sessions++;
      const call = caller(config);
      await call("knowledge_draft", { action: "save", document });
      await call("knowledge_work_result", { summary: "业务规则和文稿已保存", document_ids: [document.id] });
      if (tail === "throw") throw new Error("模型末尾说明连接断开");
      return { status: "session_ended", reason: "failed", detail: "模型末尾说明连接断开" };
    }, startResume: async () => { throw new Error("已保存结果不得重新请求模型"); }, dispose() {}, abort: async () => {},
  }) as any);
  const service = genericService(root);
  try {
    const job = create(service), after = await terminal(service, job.id);
    assert.equal(after.status, "done", after.error); assert.equal(sessions, 1);
    assert.equal(after.turns[0].reply, "业务规则和文稿已保存");
    assert.equal(after.error, undefined); assert.equal(after.documents[0].revision, 1);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("保存结果后用户停止仍保持取消，迟到的普通回复不能改成完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-user-stop-"));
  let saved!: () => void, release!: () => void;
  const savedResult = new Promise<void>(resolve => saved = resolve), held = new Promise<void>(resolve => release = resolve);
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async () => {
      const call = caller(config);
      await call("knowledge_draft", { action: "save", document });
      await call("knowledge_work_result", { summary: "文稿和结论已保存", document_ids: [document.id] });
      saved(); await held;
      return finished;
    }, startResume: async () => { throw new Error("停止后不得补交"); }, dispose() {}, abort: async () => { release(); },
  }) as any);
  const service = genericService(root);
  try {
    const job = create(service); await savedResult;
    service.stop(job.id); release(); await service.shutdown();
    const after = service.get(job.id);
    assert.equal(after.status, "cancelled"); assert.equal(after.turns[0].status, "cancelled");
    assert.equal(after.turns[0].reply, undefined); assert.equal(after.documents[0].content, document.content);
  } finally { release(); await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("子会话逐项纠正不同的提交错误后正常保存，不因累计三次拒绝中断", async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-corrected-rejections-"));
  const rejected: string[] = [], aborted: string[] = [];
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    let role = "";
    const call = caller(config);
    return {
      start: async (prompt: string) => {
        const context = contextOf(prompt); role = context.step?.id ?? "coordinator";
        if (!context.step) {
          await call("knowledge_draft", { action: "save", document });
          await call("knowledge_work", { action: "schedule", steps: [{ id: "check", title: "核对已有规则", instructions: "核对已有规则后保存核查结论", readonly: true, depends_on: [] }] });
          const checked = await call("knowledge_work", { action: "run", id: "check" });
          assert.equal(checked.summary, "已核对取消条件，未发现来源缺项");
          await call("knowledge_work_result", { summary: "规则与核查结果均已保存", document_ids: [document.id] });
        } else {
          assert.equal(context.readonly, true);
          for (const input of [
            { summary: "", document_ids: [] },
            { summary: "已核对取消条件", document_ids: [], status: "paused" },
            { summary: "已核对取消条件", document_ids: [], work_document_ids: ["not-saved"] },
          ]) rejected.push((await call("knowledge_work_result", input, true)).error);
          assert.equal(new Set(rejected).size, 3, "每次拒绝对应不同的实际缺项");
          await call("knowledge_work_result", { summary: "已核对取消条件，未发现来源缺项", document_ids: [] });
        }
        return finished;
      }, startResume: async () => { throw new Error("逐项修正后已保存，无须再补交"); }, dispose() {}, abort: async () => { aborted.push(role); },
    } as any;
  });
  const service = genericService(root);
  try {
    const job = create(service), after = await terminal(service, job.id);
    assert.equal(after.status, "done", after.error);
    assert.equal(rejected.length, 3); assert.deepEqual(aborted, []);
    assert.equal(after.documents[0].revision, 1);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("评审一次列出所有未完整读取的文稿，全部回读后补交通过且不重写候选", async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-review-missing-documents-"));
  const documents = [document, { ...document, id: "exceptions", title: "取消例外", path: "docs/取消业务/exceptions.md", content: "# 取消例外\n\n已结算订单不可取消。" }];
  let writerRuns = 0, reviewRuns = 0, rejection = "";
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    const call = caller(config);
    return {
      start: async (prompt: string) => {
        const context = contextOf(prompt), ids = documents.map(item => item.id);
        if (!context.step) {
          for (const item of documents) await call("knowledge_draft", { action: "save", document: item });
          await call("knowledge_work", { action: "schedule", steps: [{ id: "writer", title: "保存取消规则与例外", instructions: "保留两份已有文稿，交独立评审核对", readonly: false, depends_on: [], expected_document_ids: ids,
            review: { instructions: "完整回读两份文稿并核对范围一致" } }] });
          await call("knowledge_work", { action: "run", id: "writer" });
          await call("knowledge_work_result", { summary: "两份规则与独立评审结果已保存", document_ids: ids });
        } else if (!context.reviewing) {
          writerRuns++;
          await call("knowledge_work_result", { summary: "两份候选已保存，待独立评审", document_ids: ids });
        } else {
          reviewRuns++;
          rejection = (await call("knowledge_work_result", { summary: "尝试提交评审", document_ids: ids, review: { pass: true, feedback: "文稿范围一致" } }, true)).error;
          for (const item of documents) assert.ok(rejection.includes(item.id), `一次列全未读文稿：${item.id}；实际：${rejection}`);
          for (const item of documents) {
            assert.equal((await call("knowledge_draft", { action: "read", id: item.id })).content, item.content);
            await call("knowledge_diagram_check", { document_id: item.id });
          }
          await call("knowledge_work_result", { summary: "已完整回读两份文稿", document_ids: ids, review: { pass: true, feedback: "取消范围与已结算例外互相一致，来源支持当前规则。" } });
        }
        return finished;
      }, startResume: async () => { throw new Error("缺项修正后应直接保存结果"); }, dispose() {}, abort: async () => {},
    } as any;
  });
  const service = genericService(root);
  try {
    const job = create(service), after = await terminal(service, job.id);
    assert.equal(after.status, "done", after.error);
    assert.equal(writerRuns, 1); assert.equal(reviewRuns, 1);
    assert.equal(after.documents.length, 2); assert.ok(after.documents.every(item => item.revision === 1));
    assert.match(rejection, /scope/); assert.match(rejection, /exceptions/);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
