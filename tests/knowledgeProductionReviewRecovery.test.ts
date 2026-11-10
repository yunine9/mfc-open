import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { applyKnowledgeReviewNotes, listKnowledgeReviewNotes, resolveKnowledgeReviewNotes, saveKnowledgeReviewNote, type KnowledgeReviewSources } from "../src/knowledgeReviewNotes.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "docs/订单" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("研究未在测试预算内结束");
}

// 从 r6 搬入：修订失败后，原意见必须可以重新交给 Agent。
test("生产线验收11：真实领域修订轮失败后保留原批注，显式复制重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-review-failure-"));
  const domain = new DomainKnowledgeExtraction(dir, async (input: DomainExecution) => {
    if (input.turn.mode !== "extract") throw new Error("模型服务当前限流（429）");
    input.update({ revisions: { "repo-1": "a".repeat(40) } });
    input.save({ id: "orders", title: "orders", target_id: "domain", path: "docs/订单/orders.md", layer: "domain", content: "第一行\n第二行", sources: "源码" }, { revision: "b".repeat(40), content: null });
    return "完成";
  });
  const component = new ComponentResearch(dir, async () => "");
  const sources = { dataDir: dir, domain, component };
  try {
    const job = domain.create(config, "alice"); await until(() => domain.get(job.id).status === "done");
    const { notes } = saveKnowledgeReviewNote(sources, "domain", job.id, { document_id: "orders", scope: "document", note: "补充退款规则" }, "alice");
    const first = applyKnowledgeReviewNotes(sources, "domain", job.id, { note_ids: [notes[0].id] }, "alice");
    await until(() => domain.get(job.id).status === "failed");
    assert.equal(listKnowledgeReviewNotes(sources, "domain", job.id).notes[0].status, "submitted");
    const original = listKnowledgeReviewNotes(sources, "domain", job.id).notes[0];
    const second = applyKnowledgeReviewNotes(sources, "domain", job.id, { note_ids: [notes[0].id], retry: true }, "alice");
    assert.deepEqual(second.notes[0], original); assert.equal(second.notes[1].retry_of, original.id);
    assert.equal(second.notes[1].status, "submitted");
    assert.equal(second.notes[0].status, "submitted");
    assert.notEqual(second.turn_id, first.turn_id);
  } finally { await domain.shutdown(); await component.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

function fixture(kind: "domain" | "component") {
  const dataDir = mkdtempSync(join(tmpdir(), "production-review-turn-"));
  const domainJob = { id: "dkx-fixture", status: "done", documents: ["rules", "api"].map(id => ({ id, title: id, content: "正文", revision: 1 })), turns: [] } as unknown as DomainKnowledgeJob;
  const componentJob = { id: "cr-fixture", status: "done", document: { overview: "总览", sections: ["rules", "api"].map(id => ({ id, title: id, content: "正文", revision: 1 })) }, review_turns: [] } as unknown as ResearchRecord;
  let count = 0;
  const sources: KnowledgeReviewSources = { dataDir,
    domain: { get: () => structuredClone(domainJob), run: (_id, input, operator) => {
      domainJob.turns.push({ id: `domain-turn-${++count}`, mode: "revise", document_ids: input.document_ids!, message: input.message!, operator, status: "queued", created_at: new Date().toISOString(), proposals: [] });
      return structuredClone(domainJob);
    } },
    component: { get: () => structuredClone(componentJob), review: (_id, input, operator) => {
      componentJob.review_turns!.push({ ...input, id: `component-turn-${++count}`, operator, status: "queued", created_at: new Date().toISOString() });
      return structuredClone(componentJob);
    } },
  };
  const jobId = kind === "domain" ? domainJob.id : componentJob.id;
  const submit = (document_id = "rules") => {
    const saved = saveKnowledgeReviewNote(sources, kind, jobId, { document_id, scope: "document", note: `修改 ${document_id}` }, "alice");
    const note = saved.notes.at(-1)!;
    const result = applyKnowledgeReviewNotes(sources, kind, jobId, { note_ids: [note.id] }, "alice");
    return { note, turnId: result.turn_id! };
  };
  const turn = (id: string) => kind === "domain" ? domainJob.turns.find(turn => turn.id === id)! : componentJob.review_turns!.find(turn => turn.id === id)!;
  const proposal = (id: string, status: "pending" | "accepted" | "discarded") => {
    if (kind === "domain") {
      const current = domainJob.turns.find(turn => turn.id === id)!;
      current.proposals = current.document_ids.map(document_id => ({ document: { id: document_id, title: document_id, content: "建议", sources: "源码", path: `${document_id}.md`, target_id: "domain", layer: "domain" }, base_revision: 1, status }));
    } else {
      const current = componentJob.review_turns!.find(turn => turn.id === id)!;
      current.proposal = { section: componentJob.document!.sections.find(section => section.id === current.section_id)!, base_revision: 1, status };
    }
  };
  return { dataDir, sources, jobId, domainJob, componentJob, submit, turn, proposal, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

for (const kind of ["domain", "component"] as const) {
  for (const terminal of ["failed", "cancelled"] as const) test(`生产线验收11：${kind} 绑定轮次 ${terminal} 后保留对应历史，新轮次不掩盖旧轮且已处理意见保留`, () => {
    const f = fixture(kind);
    try {
      const first = f.submit(), resolved = f.submit("api");
      resolveKnowledgeReviewNotes(f.sources, kind, f.jobId, { note_ids: [resolved.note.id] }, "expert");
      f.turn(first.turnId).status = terminal;
      f.turn(resolved.turnId).status = terminal;
      if (kind === "domain") f.domainJob.turns.push({ ...f.domainJob.turns[0], id: "newer-done-turn", status: "done", proposals: [] });
      else f.componentJob.review_turns!.push({ ...f.componentJob.review_turns![0], id: "newer-done-turn", status: "done", proposal: undefined });
      const notes = listKnowledgeReviewNotes(f.sources, kind, f.jobId).notes;
      assert.equal(notes.find(note => note.id === first.note.id)!.status, kind === "domain" ? "submitted" : "open");
      assert.equal(notes.find(note => note.id === resolved.note.id)!.status, "resolved");
      const disk = JSON.parse(readFileSync(join(f.dataDir, "knowledge-review", kind, `${f.jobId}.json`), "utf8"));
      assert.equal(disk.find((note: { id: string }) => note.id === first.note.id).status, kind === "domain" ? "submitted" : "open", "领域保留历史提交，组件保持旧恢复行为");
      assert.equal(listKnowledgeReviewNotes({ ...f.sources }, kind, f.jobId).notes.find(note => note.id === first.note.id)!.status, kind === "domain" ? "submitted" : "open");
    } finally { f.cleanup(); }
  });

  test(`生产线验收11：${kind} 无需先刷新列表，失败意见可按对应入口重试`, () => {
    const f = fixture(kind);
    try {
      const first = f.submit(); f.turn(first.turnId).status = "failed";
      const result = applyKnowledgeReviewNotes(f.sources, kind, f.jobId, { note_ids: [first.note.id], ...(kind === "domain" ? { retry: true } : {}) }, "expert");
      assert.equal(result.notes[0].status, "submitted"); assert.notEqual(result.turn_id, first.turnId);
      assert.equal(result.notes.at(-1)!.submitted_by, "expert");
      if (kind === "domain") { assert.equal(result.notes[0].turn_id, first.turnId); assert.equal(result.notes[1].retry_of, first.note.id); }
    } finally { f.cleanup(); }
  });

  test(`生产线验收11：${kind} 放弃建议只影响所属批次的重试，待检视及已采纳意见不误回 open`, () => {
    const f = fixture(kind);
    try {
      const pending = f.submit(), discarded = f.submit("api");
      f.turn(pending.turnId).status = "done"; f.proposal(pending.turnId, "pending");
      f.turn(discarded.turnId).status = "done"; f.proposal(discarded.turnId, "discarded");
      let notes = listKnowledgeReviewNotes(f.sources, kind, f.jobId).notes;
      assert.equal(notes.find(note => note.id === discarded.note.id)!.status, kind === "domain" ? "submitted" : "open");
      assert.equal(notes.find(note => note.id === pending.note.id)!.status, "submitted");
      f.proposal(pending.turnId, "accepted");
      notes = listKnowledgeReviewNotes(f.sources, kind, f.jobId).notes;
      assert.equal(notes.find(note => note.id === pending.note.id)!.status, "submitted");
    } finally { f.cleanup(); }
  });
}

test("生产线验收11：领域同一轮放弃一篇建议，保留全部提交历史并允许显式重试", () => {
  const f = fixture("domain");
  try {
    saveKnowledgeReviewNote(f.sources, "domain", f.jobId, { document_id: "rules", scope: "document", note: "修改规则" }, "alice");
    const saved = saveKnowledgeReviewNote(f.sources, "domain", f.jobId, { document_id: "api", scope: "document", note: "修改接口" }, "alice");
    const submitted = applyKnowledgeReviewNotes(f.sources, "domain", f.jobId, { note_ids: saved.notes.map(note => note.id) }, "alice");
    f.turn(submitted.turn_id!).status = "done"; f.proposal(submitted.turn_id!, "pending");
    f.domainJob.turns.find(turn => turn.id === submitted.turn_id)!.proposals.find(proposal => proposal.document.id === "rules")!.status = "discarded";
    const notes = listKnowledgeReviewNotes(f.sources, "domain", f.jobId).notes;
    assert.equal(notes.find(note => note.document_id === "rules")!.status, "submitted");
    assert.equal(listKnowledgeReviewNotes(f.sources, "domain", f.jobId).submissions[submitted.turn_id!].retryable, true);
    const retried = applyKnowledgeReviewNotes(f.sources, "domain", f.jobId, { note_ids: [notes.find(note => note.document_id === "rules")!.id], retry: true }, "expert");
    assert.equal(retried.notes.length, 3); assert.deepEqual(retried.notes.slice(0, 2), notes);
    assert.equal(notes.find(note => note.document_id === "api")!.status, "submitted");
  } finally { f.cleanup(); }
});
