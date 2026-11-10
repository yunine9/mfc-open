import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { applyKnowledgeReviewNotes, saveKnowledgeReviewNote } from "../src/knowledgeReviewNotes.ts";
import { pinDomainSkillFixture } from "./helpers/extractionSkillFixture.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) { await new Promise(resolve => setTimeout(resolve, 0)); return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("任务未在2秒内完成");
}

test("旧长任务行级与整体意见统一使用专用修订方法，过程可见且保留原稿历史", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-review-method-"));
  const method = { "SKILL.md": "---\nname: long-original-method\ndescription: 旧长任务方法\n---\nOLD_EXTRACTION_ONLY" };
  let extractRuns = 0, reviseRuns = 0, revisionReviews = 0, jobId = "";
  let expectedNoteIds: string[] = [];
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call = async (name: string, args: unknown) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name);
        assert.ok(tool, name);
        const result = await tool.execute("fixture", args);
        assert.equal(!!result.isError, false, JSON.stringify(result));
        return JSON.parse(result.content[0].text);
      };
      if (context.step) {
        assert.equal(context.mode, "revise");
        const existing = await call("knowledge_draft", { action: "read", id: "scope" });
        if (context.reviewing) {
          revisionReviews++;
          assert.match(existing.content, /只保留公共仓中本业务/);
          await call("knowledge_diagram_check", { document_id: "scope" });
          await call("knowledge_work_result", { summary: "已独立核对范围与来源", document_ids: ["scope"], review: { pass: true, feedback: "已核对本轮指定范围" } });
        } else {
          await call("knowledge_draft", { action: "save", document: {
            id: existing.id, title: existing.title, target_id: existing.target_id, path: existing.path, layer: existing.layer,
            content: "只保留公共仓中本业务的相关目录说明", sources: "原来源记录；按检视意见核对范围",
          } });
          await call("knowledge_work_result", { summary: "已按意见局部修订", document_ids: ["scope"] });
        }
      } else if (context.mode === "extract") {
        extractRuns++;
        assert.match(prompt, /OLD_EXTRACTION_ONLY/);
        for (const id of ["scope", "unaffected"]) await call("knowledge_draft", { action: "save", document: {
          id, title: id, target_id: "domain", path: `docs/测试业务/${id}.md`, layer: "domain", content: `原正文 ${id}`, sources: "已有来源记录",
        } });
        await call("knowledge_work_result", { summary: "长任务已完成", document_ids: ["scope", "unaffected"] });
      } else {
        reviseRuns++;
        assert.equal(context.mode, "revise");
        assert.match(prompt, /方法版本：business-docs-reviser@/);
        assert.doesNotMatch(prompt, /OLD_EXTRACTION_ONLY/);
        assert.match(context.message, /只保留公共仓的相关目录/);
        assert.deepEqual(context.selected_document_ids, ["scope", "unaffected"]);
        assert.equal(context.review_notes.total, 3);
        const first = await call("knowledge_review_notes", { action: "list", limit: 2 });
        const second = await call("knowledge_review_notes", { action: "list", start: first.next_start, limit: 2 });
        assert.deepEqual([...first.notes, ...second.notes].map(note => note.id), expectedNoteIds);
        const originalNote = await call("knowledge_review_notes", { action: "read", id: expectedNoteIds[0] });
        assert.equal(originalNote.note.quote, "原正文 scope");
        assert.equal(originalNote.note.context_before, "批注时的前文");
        assert.match(originalNote.line_reference, /保存批注时/);
        await call("knowledge_work", { action: "save_document", document: { id: "revision-plan", title: "检视意见修订进度", content: "| 意见 | 阶段 |\n|---|---|\n| 收窄公共仓范围 | 待定位 |" } });
        const during = service.get(jobId);
        assert.equal(during.status, "running");
        assert.match(during.work_documents?.find(document => document.id === "revision-plan")?.content ?? "", /待定位/,
          "原研究过程在修订完成前已经能读取过程文稿");
        await call("knowledge_work", { action: "schedule", steps: [{ id: "scope-fix", title: "修正公共仓业务范围", instructions: "只修scope文稿中越界内容，保留原编号与来源", depends_on: [], readonly: false,
          expected_document_ids: ["scope"], review: { instructions: "独立核对scope文稿是否按本轮意见收窄业务范围" } }] });
        await call("knowledge_work", { action: "run", id: "scope-fix" });
        const progress = service.get(jobId);
        assert.equal(progress.turns.at(-1)?.research?.capabilities.find(item => item.id === "scope-fix")?.state, "researched",
          "单步骤结束后研究过程立即同步完成状态");
        assert.ok(progress.evidence.some(item => String(item.preview).includes("已保存修订候选")));
        assert.ok(progress.evidence.some(item => item.review && String(item.preview).includes("开始独立评审")));
        await call("knowledge_work_result", { summary: "已按意见局部修订", document_ids: ["scope"] });
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("结果已保存"); },
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => {
    if (input.turn.mode === "extract") pinDomainSkillFixture(input.root, method);
    return runDomainKnowledge(input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
      source: async () => { throw new Error("本测试不得重新扫描源码"); } });
  });
  try {
    const job = service.create({ issue_no: "475", title: "测试业务", scope: "公共仓中本业务目录", repositories: [] }, "expert");
    jobId = job.id;
    await until(() => !["queued", "running"].includes(service.get(job.id).status));
    assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    const original = service.get(job.id), snapshot = join(root, "domain-extraction", job.id, "skill.json");
    const oldSkill = readFileSync(snapshot, "utf8"), oldDocuments = structuredClone(original.documents);
    const sources = { dataDir: root, domain: service, component: {} as any };
    saveKnowledgeReviewNote(sources, "domain", job.id, { document_id: "scope", scope: "line", line: 1, quote: "原正文 scope", context_before: "批注时的前文", note: "这一处范围过宽，请按实际业务收窄。" }, "expert");
    saveKnowledgeReviewNote(sources, "domain", job.id, { document_id: "unaffected", scope: "line", line: 1, quote: "原正文 unaffected", note: "核对这篇仍然正确即可，不要重写。" }, "expert");
    const saved = saveKnowledgeReviewNote(sources, "domain", job.id, { document_id: "", scope: "study", note: "只保留公共仓的相关目录，修正越界内容，不重新萃取。" }, "expert");
    expectedNoteIds = saved.notes.map(note => note.id);
    applyKnowledgeReviewNotes(sources, "domain", job.id, { note_ids: saved.notes.map(note => note.id) }, "expert");
    await until(() => !["queued", "running"].includes(service.get(job.id).status));
    const next = service.get(job.id);
    assert.equal(next.status, "done", next.error);
    assert.equal(extractRuns, 1); assert.equal(reviseRuns, 1); assert.equal(revisionReviews, 1);
    assert.equal(next.turns.length, 2);
    assert.equal(next.turns[0].skill?.name, "long-original-method");
    assert.equal(next.turns[1].skill?.name, "business-docs-reviser");
    assert.equal(readFileSync(snapshot, "utf8"), oldSkill);
    assert.deepEqual(next.documents, oldDocuments, "修订建议待人工确认，原文稿及历史不被覆盖");
    assert.deepEqual(next.turns[1].proposals.map(item => item.document.id), ["scope"]);
    service.decide(job.id, next.turns[1].id, "scope", "accept", "expert");
    const accepted = service.get(job.id);
    const changed = accepted.documents.find(item => item.id === "scope")!;
    assert.equal(changed.revision, 2); assert.equal(changed.history[0].content, "原正文 scope");
    assert.deepEqual(accepted.documents.find(item => item.id === "unaffected"), oldDocuments.find(item => item.id === "unaffected"));
    assert.equal(accepted.documents.length, 2);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
