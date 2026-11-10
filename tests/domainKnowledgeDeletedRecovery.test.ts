import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { domainDocumentFingerprint } from "../src/domainKnowledgeExecution.ts";
import type { DomainSkillWork, SkillWorkStep } from "../src/domainSkillWork.ts";
import { pinDomainSkillFixture, runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";

const method = { "SKILL.md": "---\nname: deleted-document-recovery\ndescription: 沿原计划完成文稿。\nexecution: reviewed-document-plan\n---\n保留原调查和已评审文稿，按完整计划结束。" };
const retained = { id: "kept", title: "保留的业务规则", target_id: "domain", path: "docs/删除项恢复/kept.md", layer: "domain" as const,
  content: "# 业务规则\n\n已核对的正式业务范围。", sources: "已有源码调查与资料证据" };
const removed = { ...retained, id: "repo-5-api-services", title: "应排除的公共能力", path: "docs/删除项恢复/removed.md", content: "# 公共能力\n\n不属于本业务模块。" };
const planning = { id: "current-plan", title: "完整规划", content: "# 完整规划\n\n保留业务规则；公共能力不属于本模块，不重复写作。" };
async function terminal(service: DomainKnowledgeExtraction, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = service.get(id);
    if (["done", "failed", "paused"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("完成校验未在测试预算内返回");
}

for (const historyStatus of ["discarded", "done"] as const) for (const scenario of ["restored", "delete-on-resume", "delete-same-process", "cached-result", "required", "unexplained", "empty-reason"] as const) {
  test(`#539 历史 ${historyStatus} 步骤的已删除文稿范围：${scenario}，保留原任务、候选和独立评审`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "domain-deleted-recovery-"));
    const removedDocuments = historyStatus === "done" ? Array.from({ length: 15 }, (_, index) => index === 0 ? removed
      : { ...removed, id: `repo-5-excluded-${index}`, path: `docs/删除项恢复/removed-${index}.md` }) : [removed];
    const removedIds = removedDocuments.map(document => document.id);
    const sameProcess = scenario === "cached-result" || scenario === "delete-same-process";
    let workFile = "", initialState: DomainSkillWork["state"], calls = 0;
    const blocked = scenario === "required" || scenario === "unexplained" || scenario === "empty-reason";
    const run = (input: Parameters<typeof runDomainKnowledgeFixture>[1]) => runDomainKnowledgeFixture(method, input, {
      dataDir: dir, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
      source: async () => { throw new Error("恢复完成校验不得重新拉仓或调查"); },
    });
    let service = new DomainKnowledgeExtraction(dir, async input => {
      const skill = pinDomainSkillFixture(input.root, method);
      input.update({ skill: { name: skill.name, digest: skill.digest } });
      input.save(retained); for (const document of removedDocuments) input.save(document);
      const completed = (id: string): SkillWorkStep => {
        const result = { summary: "原文稿已通过独立评审", document_ids: [id], review: { pass: true, feedback: "已回读文稿和原始证据" } };
        const fingerprint = domainDocumentFingerprint(input.read(), [id]);
        return { id: `write-${id}`, title: id, instructions: "沿用既有调查", depends_on: [], readonly: false,
          expected_document_ids: [id], status: "done", attempts: 1, review_attempts: 1, review: { instructions: "独立核对当前正文" },
          candidate: result, result, candidate_fingerprint: fingerprint, reviewed_fingerprint: fingerprint };
      };
      const excludedSteps = removedIds.map(id => {
        const step = completed(id);
        if (historyStatus === "discarded" && scenario !== "required") Object.assign(step, { status: historyStatus, error: "公共能力不属于本模块" });
        return step;
      });
      initialState = { version: 1, skill: skill.digest, steps: [completed(retained.id), ...excludedSteps], documents: [planning],
        plan: { document_ids: scenario === "required" ? [retained.id, ...removedIds] : [retained.id], work_document_id: planning.id,
          ...(!blocked || scenario === "empty-reason" ? { exclusions: removedIds.map(document_id => ({ document_id, reason: scenario === "empty-reason" ? "  " : "公共仓通用能力不属于本模块" })) } : {}) },
        modified_document_ids: removedIds };
      if (scenario !== "delete-on-resume" && scenario !== "delete-same-process") for (const id of removedIds) input.remove!(id);
      if (scenario === "cached-result") initialState.result = { status: "complete", summary: "已完成有效规划", document_ids: [retained.id, ...removedIds] };
      workFile = join(input.root, "skill-runs", input.turn.id, "work.json");
      mkdirSync(join(input.root, "skill-runs", input.turn.id), { recursive: true });
      writeFileSync(workFile, JSON.stringify(initialState));
      if (sameProcess) return run(input);
      throw new Error("模拟旧任务在完成校验前中断，保留所有成果");
    });
    const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
      start: async (prompt: string) => {
        const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
        assert.equal(context.step, undefined, "恢复只进入主会话，不重复写作或评审"); calls++;
        const call = async (name: string, args: unknown, expectedError = false) => {
          const result = await config.extraTools.find((tool: any) => tool.name === name).execute("deleted-recovery", args);
          assert.equal(!!result.isError, expectedError, result.content[0].text);
          return JSON.parse(result.content[0].text);
        };
        if (scenario === "delete-on-resume" || scenario === "delete-same-process") for (const id of removedIds) await call("knowledge_draft", { action: "delete", id });
        const result = await call("knowledge_work_result", { status: "complete", summary: "有效范围已完成，排除项保留原记录", document_ids: [retained.id, ...removedIds] }, blocked);
        if (blocked) {
          assert.match(result.error, /已标记删除/);
          await call("knowledge_work_result", { status: "paused", summary: "删除项仍在必交清单或尚无排除依据，保留成果等待补充", document_ids: [retained.id] });
        }
        return { status: "turn_finished" };
      }, startResume: async () => { throw new Error("不能重复完成提交循环"); }, dispose() {}, abort: async () => {},
    }) as any);
    try {
      const created = service.create({ title: "删除项恢复", scope: "保留既有业务文稿", issue_no: "539", repositories: [] }, "expert");
      const before = await terminal(service, created.id), skillFile = join(dir, "domain-extraction", created.id, "skill.json");
      const pinnedSkill = readFileSync(skillFile, "utf8");
      if (!sameProcess) {
        assert.equal(before.status, "failed"); assert.match(before.error ?? "", /模拟旧任务/); await service.shutdown();
        service = new DomainKnowledgeExtraction(dir, run);
        service.resume(created.id, "expert");
      }
      const after = await terminal(service, created.id);
      assert.equal(after.status, blocked ? "paused" : "done", after.error);
      assert.equal(after.id, before.id); assert.equal(after.turns.length, 1); assert.equal(after.turns[0].id, before.turns[0].id);
      assert.equal(readFileSync(skillFile, "utf8"), pinnedSkill);
      assert.deepEqual(after.documents.find(document => document.id === retained.id), before.documents.find(document => document.id === retained.id));
      for (const document of removedDocuments) {
        const deleted = after.documents.find(value => value.id === document.id)!;
        assert.equal(deleted.deleted, true); assert.equal(deleted.revision, 2); assert.equal(deleted.content, document.content);
      }
      const persisted = JSON.parse(readFileSync(workFile, "utf8"));
      assert.deepEqual(persisted.steps.map(({ budget_start, review_budget_start, ...step }: any) => step), initialState!.steps,
        "旧步骤候选、通过结论和次数完整保留，不清理历史来绕过校验");
      assert.deepEqual(persisted.plan, initialState!.plan);
      assert.equal(calls, scenario === "cached-result" ? 0 : 1);
    } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["existing-current-review", "new-readonly-review"] as const) {
  test(`#539 混合历史步骤保留原记录，有效文稿由当前独立评审覆盖：${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "domain-mixed-deleted-recovery-"));
    let workFile = "", initialSteps: SkillWorkStep[] = [], initialPlan: DomainSkillWork["state"]["plan"];
    const sessions: Array<{ id: string; reviewing: boolean }> = [];
    const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
      start: async (prompt: string) => {
        const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
        sessions.push({ id: context.step?.id ?? "coordinator", reviewing: context.reviewing === true });
        const call = async (name: string, args: unknown, expectedError = false) => {
          const result = await config.extraTools.find((tool: any) => tool.name === name).execute("mixed-deleted-recovery", args);
          assert.equal(!!result.isError, expectedError, result.content[0].text);
          return JSON.parse(result.content[0].text);
        };
        if (context.step) {
          assert.equal(context.step.id, "review-current-kept", "不重新执行引用删除文稿的旧步骤");
          assert.equal(context.readonly, true);
          const body = await call("knowledge_draft", { action: "read", id: retained.id });
          assert.equal(body.content, retained.content);
          await call("knowledge_work_result", { summary: "保留文稿的当前正文已核对", document_ids: [retained.id],
            review: { pass: true, feedback: "已回读当前正文，业务规则与保留范围一致" } });
        } else {
          const completion = { status: "complete", summary: "保留文稿已核对，删除项已有范围说明", document_ids: [retained.id, removed.id] };
          if (scenario === "new-readonly-review") {
            const rejected = await call("knowledge_work_result", completion, true);
            assert.match(rejected.error, /仍有效文稿.*独立评审/);
            assert.match(rejected.error, /kept/);
            const afterRejection = JSON.parse(readFileSync(workFile, "utf8"));
            assert.deepEqual(afterRejection.steps.map(({ budget_start, review_budget_start, ...step }: any) => step), initialSteps,
              "缺少有效评审时不能自动废弃旧步骤或清除候选");
            await call("knowledge_work", { action: "schedule", steps: [{ id: "review-current-kept", title: "核对保留文稿", instructions: "只读取保留文稿的当前正文并核对范围",
              readonly: true, depends_on: [], expected_document_ids: [retained.id], review: { instructions: "独立回读当前保留文稿，检查适用范围" } }] });
            const reviewed = await call("knowledge_work", { action: "run", id: "review-current-kept" });
            assert.equal(reviewed.review.pass, true);
          }
          await call("knowledge_work_result", completion);
        }
        return { status: "turn_finished" };
      }, startResume: async () => { throw new Error("完成校验修正后不应反复补问"); }, dispose() {}, abort: async () => {},
    }) as any);
    const service = new DomainKnowledgeExtraction(dir, async input => {
      const skill = pinDomainSkillFixture(input.root, method);
      input.save(retained); input.save(removed);
      const completed = (id: string, ids: string[]): SkillWorkStep => {
        const result = { summary: "旧步骤已完成写作与独立评审", document_ids: ids, review: { pass: true, feedback: "已回读当时的完整正文" } };
        const fingerprint = domainDocumentFingerprint(input.read(), ids);
        return { id, title: id, instructions: "原有工作记录", depends_on: [], readonly: false, expected_document_ids: ids,
          status: "done", attempts: 2, review_attempts: 2, review: { instructions: "独立核对当时的正文" },
          candidate: result, result, candidate_fingerprint: fingerprint, reviewed_fingerprint: fingerprint };
      };
      initialSteps = [completed("mixed-old-step", [retained.id, removed.id])];
      if (scenario === "existing-current-review") initialSteps.push(completed("current-kept-review", [retained.id]));
      initialPlan = { document_ids: [retained.id], work_document_id: planning.id,
        exclusions: [{ document_id: removed.id, reason: "公共仓通用能力不属于本模块" }] };
      const state: DomainSkillWork["state"] = { version: 1, skill: skill.digest, documents: [planning], steps: initialSteps, plan: initialPlan, modified_document_ids: [removed.id] };
      input.remove!(removed.id);
      workFile = join(input.root, "skill-runs", input.turn.id, "work.json");
      mkdirSync(join(input.root, "skill-runs", input.turn.id), { recursive: true }); writeFileSync(workFile, JSON.stringify(state));
      return runDomainKnowledgeFixture(method, input, { dataDir: dir, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
        source: async () => { throw new Error("完成校验与只读评审不得重新拉仓或研究"); } });
    });
    try {
      const created = service.create({ title: "删除项恢复", scope: "保留有效正文与所有历史评审", issue_no: "539", repositories: [] }, "expert");
      const after = await terminal(service, created.id);
      assert.equal(after.status, "done", after.error); assert.equal(after.turns.length, 1);
      const kept = after.documents.find(document => document.id === retained.id)!, deleted = after.documents.find(document => document.id === removed.id)!;
      assert.equal(kept.revision, 1); assert.equal(kept.content, retained.content);
      assert.equal(deleted.deleted, true); assert.equal(deleted.revision, 2); assert.equal(deleted.content, removed.content);
      const persisted = JSON.parse(readFileSync(workFile, "utf8"));
      for (const original of initialSteps) {
        const { budget_start, review_budget_start, ...actual } = persisted.steps.find((step: SkillWorkStep) => step.id === original.id);
        assert.deepEqual(actual, original, "混合旧步骤的 done 状态、候选、通过结论、旧指纹和次数均保持原样");
      }
      assert.deepEqual(persisted.plan, initialPlan);
      if (scenario === "existing-current-review") assert.deepEqual(sessions, [{ id: "coordinator", reviewing: false }]);
      else {
        assert.deepEqual(sessions, [{ id: "coordinator", reviewing: false }, { id: "review-current-kept", reviewing: false }, { id: "review-current-kept", reviewing: true }]);
        const current = persisted.steps.find((step: SkillWorkStep) => step.id === "review-current-kept");
        assert.equal(current.status, "done"); assert.equal(current.result.review.pass, true);
        assert.equal(current.reviewed_fingerprint, domainDocumentFingerprint(after.documents, [retained.id]));
      }
    } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const [scenario, error] of [
  ["missing-body", /计划文稿 missing 尚未保存/],
  ["deleted-required", /已标记删除/],
  ["stale-review", /文稿已变化或尚未通过独立评审/],
  ["discarded-mixed-step", /未完成写作与独立评审/],
  ["done-mixed-step", /仍有效文稿.*独立评审/],
] as const) {
  test(`#539 读取已保存的完成结果仍检查当前必交正文与评审：${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "domain-cached-completion-"));
    const intercepted = mock.method(CloudSession, "create", async () => { throw new Error("已保存的完成结果不应启动模型会话"); });
    const service = new DomainKnowledgeExtraction(dir, async input => {
      const skill = pinDomainSkillFixture(input.root, method);
      input.save(retained); input.save(removed);
      const ids = scenario === "discarded-mixed-step" || scenario === "done-mixed-step" ? [retained.id, removed.id] : [retained.id];
      const fingerprint = domainDocumentFingerprint(input.read(), ids);
      const result = { status: "complete" as const, summary: "旧版本保存的完成结果", document_ids: ids, review: { pass: true, feedback: "旧正文已核对" } };
      const state: DomainSkillWork["state"] = { version: 1, skill: skill.digest, documents: [planning],
        plan: { document_ids: [retained.id], work_document_id: planning.id,
          exclusions: [{ document_id: removed.id, reason: "不属于本模块" }] },
        steps: [{ id: "old-step", title: "旧文稿评审", instructions: "核对正文", depends_on: [], readonly: false,
          expected_document_ids: ids, status: scenario === "discarded-mixed-step" ? "discarded" : "done", attempts: 1, review_attempts: 1,
          review: { instructions: "独立核对" }, candidate: result, result, candidate_fingerprint: fingerprint, reviewed_fingerprint: fingerprint }],
        result: { status: "complete", summary: "旧版本保存的完成结果", document_ids: [retained.id] } };
      input.remove!(removed.id);
      if (scenario === "missing-body") {
        state.plan!.document_ids.push("missing"); state.steps[0].expected_document_ids!.push("missing");
      }
      if (scenario === "deleted-required") input.remove!(retained.id);
      if (scenario === "stale-review") input.save({ ...retained, content: "# 业务规则\n\n评审通过后更改的正文。" });
      const root = join(input.root, "skill-runs", input.turn.id); mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "work.json"), JSON.stringify(state));
      return runDomainKnowledgeFixture(method, input, { dataDir: dir, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
        source: async () => { throw new Error("本测试不应重新研究"); } });
    });
    try {
      const job = service.create({ title: "删除项恢复", scope: "检查旧完成结果", issue_no: "539", repositories: [] }, "expert");
      const after = await terminal(service, job.id);
      assert.equal(after.status, "failed"); assert.match(after.error ?? "", error);
      assert.equal(after.documents.length, 2, "拒绝完成不应清理已有文稿");
      assert.equal(intercepted.mock.callCount(), 0);
    } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(dir, { recursive: true, force: true }); }
  });
}
