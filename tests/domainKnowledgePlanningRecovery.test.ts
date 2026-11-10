import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { domainDocumentFingerprint } from "../src/domainKnowledgeExecution.ts";
import { pinDomainSkillFixture, runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";

type Call = (name: string, input: Record<string, unknown>, expectedError?: boolean) => Promise<any>;
function toolFinished(config: any, name: string, input: Record<string, unknown>, isError: boolean, result: string) {
  const eventId = config.eventLog.lastEventId() + 1;
  config.eventLog.append({ eventId, taskId: config.taskId, sessionId: "main", ts: new Date().toISOString(), kind: "tool_finished",
    payload: { call_id: `fixture-tool-${eventId}`, name, input, is_error: isError, result } });
}
function sessionCall(config: any, emitEvents = false): Call {
  return async (name, input, expectedError = false) => {
    const tool = config.extraTools.find((candidate: any) => candidate.name === name);
    assert.ok(tool, name);
    const result = await tool.execute("planning-recovery", input, new AbortController().signal);
    // Pi 0.84.1 对正常 resolve 的 execute 记录 is_error=false，即使工具结果自带 isError。
    // 宿主的提交失败计数仍须识别结果正文中的 error；只有参数校验拒绝另发 true 事件。
    if (emitEvents) toolFinished(config, name, input, false, result.content[0].text);
    assert.equal(!!result.isError, expectedError, `${name}: ${JSON.stringify(result)}`);
    const text = result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };
}
async function terminal(service: DomainKnowledgeExtraction, id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const job = service.get(id);
    if (["done", "paused", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`规划核查未在限定时间返回：${service.get(id).stage}`);
}

const legacyMethod = {
  "SKILL.md": "---\nname: legacy-planning-review\ndescription: 保留旧任务的方法与规划。\nexecution: reviewed-document-plan\n---\n规划核查按 [原方法](references/plan.md) 返回结论，主会话读取结论后决定是否继续。",
  "references/plan.md": "LEGACY_PINNED_METHOD：核对完整规划和已保存调查，返回 document_ids=[] 与 review:{pass,feedback}。",
};
const documentForTask = (title: string) => ({ id: "cancel-rules", title: "取消规则", target_id: "domain", path: `docs/${title}/cancel-rules.md`, layer: "domain" as const,
  content: "# 取消规则\n\n未结算订单取消才释放库存。", sources: "原调查已读取的取消入口和业务资料" });
const currentPlan = { id: "current-plan", title: "原完整规划", content: "# 原完整规划\n\n- cancel-rules：已完成未结算取消规则的写作与独立评审。\n- review-plan：独立核对调查覆盖与规划，保留原步骤编号。" };

for (const pass of [true, false]) test(`旧规划核查误配文稿评审后沿原任务恢复，核查 ${pass ? "通过" : "不通过"} 不重做已有调查与文稿`, async () => {
  const existingDocument = documentForTask("原业务知识任务");
  const root = mkdtempSync(join(tmpdir(), "domain-planning-recovery-"));
  let workFile = "", skillFile = "", initialState: any, initialSkill = "", initialExecutions = 0;
  // 通过真实服务保存任务、文稿和方法，再写入修复前已经存在的工作记录。
  // 不经当前 schedule 创建旧错误配置，避免新版本规范化遮掉恢复场景。
  let service = new DomainKnowledgeExtraction(root, async input => {
    initialExecutions++;
    const skill = pinDomainSkillFixture(input.root, legacyMethod);
    input.update({ skill: { name: skill.name, digest: skill.digest } });
    input.save(existingDocument, { content: null, revision: "a".repeat(40) });
    input.evidence({ tool: "component_source", action: "read", repository_id: "repo-1", path: "src/cancel.ts", preview: "ORIGINAL_RESEARCH_EVIDENCE" });
    const fingerprint = domainDocumentFingerprint(input.read(), [existingDocument.id]);
    const written = { summary: "原文稿已写作并独立核对", document_ids: [existingDocument.id], review: { pass: true, feedback: "原评审已核对未结算条件" } };
    initialState = {
      version: 1, skill: skill.digest, continued: 0,
      documents: [currentPlan], plan: { document_ids: [existingDocument.id], work_document_id: currentPlan.id },
      steps: [
        { id: "research-cancel", title: "调查取消入口", instructions: "读取取消入口与业务资料", depends_on: [], readonly: true, status: "done", attempts: 1,
          result: { summary: "原调查已完成", document_ids: [], data: { marker: "ORIGINAL_RESEARCH", source_index: [{ path: "src/cancel.ts", finding: "未结算才释放库存" }] } } },
        { id: "write-cancel", title: "写作并核对取消规则", instructions: "依据原调查写作取消规则", depends_on: ["research-cancel"], readonly: false,
          expected_document_ids: [existingDocument.id], review: { instructions: "独立回读完整文稿及来源" }, status: "done", attempts: 1, review_attempts: 1,
          candidate: written, result: written, candidate_fingerprint: fingerprint, reviewed_fingerprint: fingerprint },
        { id: "review-plan", title: "核查完整规划", instructions: "读取原调查、完整规划和文稿，核查范围后返回空 document_ids 与 review 结论", depends_on: ["research-cancel", "write-cancel"],
          readonly: true, review: { instructions: "核查规划覆盖是否完整" }, status: "failed", attempts: 3, review_attempts: 0,
          error: "独立评审需要至少一份待评审文稿" },
      ],
    };
    workFile = join(input.root, "skill-runs", input.turn.id, "work.json");
    mkdirSync(join(input.root, "skill-runs", input.turn.id), { recursive: true });
    writeFileSync(workFile, JSON.stringify(initialState));
    skillFile = join(input.root, "skill.json"); initialSkill = readFileSync(skillFile, "utf8");
    throw new Error("旧运行在规划核查结果提交处失败，已有成果保留");
  });
  let restore: (() => void) | undefined;
  try {
    const created = service.create({ title: "原业务知识任务", scope: "取消规则与规划覆盖", issue_no: "REQ-478", repositories: [] }, "expert");
    const before = await terminal(service, created.id);
    assert.equal(before.status, "failed"); assert.equal(initialExecutions, 1);
    const turnId = before.turns[0].id, savedDocument = before.documents[0];
    assert.ok(savedDocument); assert.equal(savedDocument.revision, 1);
    await service.shutdown();

    const sessions: string[] = [];
    const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
      start: async (prompt: string) => {
        const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
        const call = sessionCall(config);
        sessions.push(context.step?.id ?? "coordinator");
        assert.equal(config.resumeSession, true);
        assert.equal(await call("extraction_skill", { path: "references/plan.md" }), legacyMethod["references/plan.md"]);
        if (!context.step) {
          const research = await call("knowledge_work", { action: "read", id: "research-cancel" });
          assert.equal(research.result.data.marker, "ORIGINAL_RESEARCH");
          assert.equal((await call("knowledge_work", { action: "read_document", id: "current-plan" })).content, currentPlan.content);
          const batch = await call("knowledge_work", { action: "run" });
          assert.equal(batch.complete, true);
          const checked = await call("knowledge_work", { action: "read", id: "review-plan" });
          assert.equal(checked.result.review.pass, pass);
          assert.deepEqual(checked.depends_on, ["research-cancel", "write-cancel"]);
          await call("knowledge_work_result", { status: pass ? "complete" : "paused", summary: pass ? "沿用已有成果，规划核查已通过" : "核查发现尚缺业务范围说明，请补充后接续原任务",
            document_ids: [existingDocument.id], work_document_ids: [currentPlan.id] });
        } else {
          assert.equal(context.step.id, "review-plan", "已完成调查与文稿不得再次启动子会话");
          assert.equal(context.readonly, true); assert.equal(context.reviewing, false);
          const research = await call("knowledge_work", { action: "read", id: "research-cancel" });
          assert.equal(research.result.data.marker, "ORIGINAL_RESEARCH");
          assert.equal((await call("knowledge_work", { action: "read_document", id: "current-plan" })).content, currentPlan.content);
          assert.equal((await call("knowledge_draft", { action: "read", id: existingDocument.id })).content, existingDocument.content);
          await call("knowledge_work_result", { summary: "已核查原调查与规划覆盖", document_ids: [],
            review: { pass, feedback: pass ? "已核对范围与已有文稿一致" : "来源未说明另一取消入口是否属于本次范围" }, data: { checked_plan: currentPlan.id } });
        }
        return { status: "turn_finished" };
      },
      startResume: async () => { throw new Error("核查应一次提交，不应反复补问"); }, dispose() {}, abort: async () => {},
    }) as any);
    restore = () => intercepted.mock.restore();
    const replacement = { ...legacyMethod, "references/plan.md": "NEW_METHOD_MUST_NOT_REPLACE_RUNNING_TASK" };
    service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(replacement, input, {
      dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
      source: async () => { throw new Error("恢复规划核查不得重新启动已完成源码调查"); },
    }));
    service.resume(created.id, "expert");
    const after = await terminal(service, created.id);
    assert.equal(after.status, pass ? "done" : "paused", after.error);
    assert.equal(after.id, before.id); assert.equal(after.turns.length, 1); assert.equal(after.turns[0].id, turnId);
    assert.equal(after.turns[0].skill?.digest, before.turns[0].skill?.digest);
    assert.equal(readFileSync(skillFile, "utf8"), initialSkill);
    assert.deepEqual(after.documents, [savedDocument]);
    assert.deepEqual(sessions, ["coordinator", "review-plan"]);
    assert.equal(after.evidence.filter(event => event.preview === "ORIGINAL_RESEARCH_EVIDENCE").length, 1);
    const persisted = JSON.parse(readFileSync(workFile, "utf8"));
    assert.deepEqual(persisted.plan, initialState.plan); assert.deepEqual(persisted.documents, initialState.documents);
    assert.deepEqual(persisted.steps.map((step: any) => ({ id: step.id, depends_on: step.depends_on })),
      initialState.steps.map((step: any) => ({ id: step.id, depends_on: step.depends_on })));
    for (const id of ["research-cancel", "write-cancel"]) {
      const current = persisted.steps.find((step: any) => step.id === id), original = initialState.steps.find((step: any) => step.id === id);
      assert.equal(current.attempts, original.attempts); assert.deepEqual(current.result, original.result);
    }
    const checked = persisted.steps.find((step: any) => step.id === "review-plan");
    assert.equal(checked.status, "done"); assert.equal(checked.attempts, 4);
    assert.equal(checked.review, undefined); assert.equal(checked.review_attempts, 0);
    assert.deepEqual(checked.result.document_ids, []); assert.equal(checked.result.review.pass, pass);
  } finally { await service.shutdown(); restore?.(); rmSync(root, { recursive: true, force: true }); }
});

for (const failureMode of ["paused", "missing-document", "schema-paused"] as const) test(`只读子会话反复提交 ${failureMode} 三次后交回主会话，成功读取不清零且保留已有成果`, async () => {
  const existingDocument = documentForTask("核查提交失败处理");
  const root = mkdtempSync(join(tmpdir(), "domain-planning-submit-limit-"));
  const sessions: string[] = [], aborted: string[] = [];
  let rejectedSubmissions = 0, independentRuns = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    let role = "unstarted";
    return {
      start: async (prompt: string) => {
        const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
        role = context.step?.id ?? "coordinator"; sessions.push(role);
        const call = sessionCall(config, true);
        if (!context.step) {
          await call("knowledge_draft", { action: "save", document: existingDocument });
          await call("knowledge_work", { action: "save_document", document: currentPlan });
          await call("knowledge_work", { action: "plan", document_ids: [existingDocument.id], work_document_id: currentPlan.id });
          await call("knowledge_work", { action: "schedule", steps: [
            { id: "blocked-check", title: "存在来源缺口的核查", instructions: "保留已读事实，将具体来源缺口交回主会话", readonly: true, depends_on: [] },
            { id: "independent-check", title: "其他已知范围核查", instructions: "回读已有文稿，提交自身范围的结论", readonly: true, depends_on: [] },
          ] });
          // 主会话需要处理全局计划；子会话的提交次数限制不应终止它。
          for (let attempt = 0; attempt < 4; attempt++) await call("knowledge_work_result", { summary: "尚未完成文稿评审，不能提前结束", document_ids: [existingDocument.id] }, true);
          const failed = await call("knowledge_work", { action: "run", id: "blocked-check" }, true);
          assert.match(failed.error, /blocked-check/); assert.match(failed.error, /3.*提交结果.*拒绝/); assert.match(failed.error, /主会话/);
          const blocked = await call("knowledge_work", { action: "read", id: "blocked-check" });
          assert.equal(blocked.status, "failed"); assert.equal(blocked.attempts, 1);
          assert.equal(blocked.result, undefined);
          const independent = await call("knowledge_work", { action: "run", id: "independent-check" });
          assert.equal(independent.summary, "其他范围已核查");
          assert.equal((await call("knowledge_draft", { action: "read", id: existingDocument.id })).content, existingDocument.content);
          await call("knowledge_work_result", { status: "paused", summary: "已保留草稿、规划及其他核查结果；待补充来源后接续受阻步骤",
            document_ids: [existingDocument.id], work_document_ids: [currentPlan.id] });
        } else if (context.step.id === "blocked-check") {
          const resultSchema = config.extraTools.find((tool: any) => tool.name === "knowledge_work_result").parameters;
          assert.equal(resultSchema.properties.status.const, "complete", "子会话工具不提供主会话暂停选项");
          for (let attempt = 0; attempt < 3; attempt++) {
            assert.equal((await call("knowledge_work", { action: "read_document", id: currentPlan.id })).content, currentPlan.content);
            assert.equal((await call("knowledge_draft", { action: "read", id: existingDocument.id })).content, existingDocument.content);
            const input = failureMode !== "missing-document"
              ? { status: "paused", summary: "仍缺另一入口的范围说明，请主会话处理", document_ids: [] }
              : { summary: "误报尚未存在的文稿", document_ids: ["not-saved"] };
            if (failureMode === "schema-paused") {
              // Pi 参数校验在 execute 前拒绝 paused，仅工具结束事件可被宿主观察。
              toolFinished(config, "knowledge_work_result", input, true, "Validation failed for tool knowledge_work_result: status must be complete");
            } else await call("knowledge_work_result", input, true);
            rejectedSubmissions++;
          }
          assert.deepEqual(aborted, ["blocked-check"], "三次失败只中断当前子会话，不中断主会话");
        } else {
          assert.equal(context.step.id, "independent-check"); independentRuns++;
          await call("knowledge_draft", { action: "read", id: existingDocument.id });
          await call("knowledge_work_result", { summary: "其他范围已核查", document_ids: [], data: { existing_document: existingDocument.id } });
        }
        return { status: "turn_finished" };
      },
      startResume: async () => { throw new Error("三次拒绝须立即交回，不应再补问子会话"); },
      dispose() {}, abort: async () => { aborted.push(role); },
    } as any;
  });
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(legacyMethod, input, {
    dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => { throw new Error("本用例不访问源码"); },
  }));
  try {
    const created = service.create({ title: "核查提交失败处理", scope: "保留现有成果并返回主会话", issue_no: "REQ-478", repositories: [] }, "expert");
    const final = await terminal(service, created.id);
    assert.equal(final.status, "paused", final.error);
    assert.equal(rejectedSubmissions, 3); assert.equal(independentRuns, 1);
    assert.deepEqual(sessions, ["coordinator", "blocked-check", "independent-check"]);
    assert.deepEqual(aborted, ["blocked-check"]);
    assert.equal(final.documents.length, 1); assert.equal(final.documents[0].revision, 1);
    assert.equal(final.documents[0].content, existingDocument.content);
    const state = JSON.parse(readFileSync(join(root, "domain-extraction", final.id, "skill-runs", final.turns[0].id, "work.json"), "utf8"));
    assert.deepEqual(state.documents, [currentPlan]);
    assert.equal(state.steps.find((step: any) => step.id === "blocked-check").status, "failed");
    assert.equal(state.steps.find((step: any) => step.id === "independent-check").status, "done");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
