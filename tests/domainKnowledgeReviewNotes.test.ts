import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainKnowledgeReviewNotesTool, readDomainReviewNoteBatch } from "../src/domainKnowledgeReviewNotes.ts";
import type { KnowledgeReviewNote } from "../src/knowledgeReviewNoteTypes.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { applyKnowledgeReviewNotes, saveKnowledgeReviewNote } from "../src/knowledgeReviewNotes.ts";

async function call(tool: ReturnType<typeof domainKnowledgeReviewNotesTool>, id: string, args: Parameters<typeof tool.execute>[1]) {
  const result = await tool.execute(id, args, undefined, undefined, {} as never), block = result.content[0];
  if (block.type !== "text") throw new Error("意见工具应返回文本");
  return { ...result, content: [block] as const };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "domain-review-batch-"));
  const notes: KnowledgeReviewNote[] = Array.from({ length: 64 }, (_, index) => ({
    id: `feedback-${index}`, kind: "domain", job_id: "dkx-batch", document_id: `document-${index % 3}`, document_title: `业务文稿 ${index % 3}`,
    scope: index % 3 === 0 ? "line" : index % 3 === 1 ? "document" : "study", line: index + 1, line_end: index + 2,
    anchor: "保存时的位置", quote: `原引用 ${index}：${"条件不能被省略。".repeat(200)}`, context_before: `前文 ${index}`, context_after: `后文 ${index}`,
    note: `检视意见 ${index}：${"完整条件与来源。".repeat(300)}`, operator: "expert", created_at: "2026-10-16T00:00:00.000Z", status: "submitted", turn_id: "turn-current",
  }));
  const directory = join(dataDir, "knowledge-review", "domain"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "dkx-batch.json"); writeFileSync(path, JSON.stringify(notes));
  return { dataDir, notes, path, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("本轮意见摘要有界分页，按稳定 ID 读取完整原意见、引用与历史行号", async () => {
  const f = fixture();
  try {
    const selected = f.notes.slice(0, 63).map(note => note.id), tool = domainKnowledgeReviewNotesTool(f.dataDir, "dkx-batch", selected);
    const before = readFileSync(f.path, "utf8");
    const ids: string[] = [];
    let start: number | undefined = 0;
    do {
      const result = await call(tool, "list", { action: "list", start });
      assert.equal(result.isError, undefined);
      const page = JSON.parse(result.content[0].text);
      assert.equal(page.total, 63);
      assert.ok(page.notes.length <= 20);
      for (const note of page.notes) {
        ids.push(note.id);
        assert.ok(note.note_excerpt.length <= 240);
        assert.equal(note.note, undefined); assert.equal(note.quote, undefined); assert.equal(note.context_before, undefined);
      }
      start = page.next_start;
    } while (start !== undefined);
    assert.deepEqual(ids, selected);
    const full = await call(tool, "read", { action: "read", id: f.notes[0].id });
    const read = JSON.parse(full.content[0].text);
    assert.deepEqual(read.note, f.notes[0]);
    assert.match(read.line_reference, /保存批注时/);
    assert.equal(readFileSync(f.path, "utf8"), before, "只读工具不会改变意见或处理状态");
    assert.equal((await call(tool, "bad-page", { action: "list", limit: 51 })).isError, true);
    assert.equal((await call(tool, "negative", { action: "list", start: -1 })).isError, true);
  } finally { f.cleanup(); }
});

test("意见工具隔离其他任务、本轮未选和未提交意见，调用方改写数组不能扩大范围", async () => {
  const f = fixture();
  try {
    f.notes[63].status = "open"; writeFileSync(f.path, JSON.stringify(f.notes));
    const selected = [f.notes[0].id], tool = domainKnowledgeReviewNotesTool(f.dataDir, "dkx-batch", selected);
    selected.push(f.notes[63].id);
    for (const id of [f.notes[1].id, f.notes[63].id, "foreign-feedback", "../dkx-batch"]) {
      const response = await call(tool, "outside", { action: "read", id });
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /不在本任务本轮/);
      assert.doesNotMatch(response.content[0].text, /完整条件/);
    }
    const otherJobPath = join(f.dataDir, "knowledge-review", "domain", "dkx-other.json");
    writeFileSync(otherJobPath, JSON.stringify(f.notes));
    assert.throws(() => readDomainReviewNoteBatch(f.dataDir, "dkx-other", [f.notes[0].id]), /已不存在/);
    assert.throws(() => readDomainReviewNoteBatch(f.dataDir, "../dkx-batch", [f.notes[0].id]), /编号无效/);
    assert.throws(() => readDomainReviewNoteBatch(f.dataDir, "dkx-batch", ["missing"]), /已不存在/);
    assert.deepEqual(JSON.parse((await call(tool, "list", { action: "list" })).content[0].text).notes.map(note => note.id), [f.notes[0].id]);
  } finally { f.cleanup(); }
});

async function until(check: () => boolean) {
  for (let index = 0; index < 400; index++) {
    if (check()) { await new Promise(resolve => setTimeout(resolve, 0)); return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("测试回合未完成");
}

test("原领域任务按批次编号创建单轮修订，重启后恢复同一批原意见", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "domain-review-restart-"));
  let revisionRuns = 0;
  let service = new DomainKnowledgeExtraction(dataDir, async input => {
    if (input.turn.mode === "extract") input.save({ id: "rules", title: "业务规则", target_id: "domain", path: "docs/批注测试/rules.md", layer: "domain", content: "# 业务规则\n原文", sources: "已有来源" });
    else {
      revisionRuns++;
      assert.equal(input.turn.review_note_ids?.length, 3);
    }
    return "已完成本轮";
  });
  try {
    const job = service.create({ issue_no: "475", title: "批注测试", scope: "已有业务", repositories: [] }, "expert");
    await until(() => service.get(job.id).status === "done");
    const sources = { dataDir, domain: service, component: {} as any };
    for (const input of [{ scope: "line" as const, line: 2, quote: "原文", context_before: "# 业务规则", context_after: "末尾", note: "补充这一行" }, { scope: "document" as const, note: "整篇补充来源" }, { scope: "study" as const, note: "跨文稿术语统一" }])
      saveKnowledgeReviewNote(sources, "domain", job.id, { document_id: input.scope === "study" ? "" : "rules", ...input }, "expert");
    const path = join(dataDir, "knowledge-review", "domain", `${job.id}.json`), original: KnowledgeReviewNote[] = JSON.parse(readFileSync(path, "utf8"));
    const ids = original.map(note => note.id);
    const submitted = applyKnowledgeReviewNotes(sources, "domain", job.id, { note_ids: ids }, "expert");
    await until(() => service.get(job.id).status === "done");
    assert.equal(revisionRuns, 1);
    await service.shutdown();
    service = new DomainKnowledgeExtraction(dataDir, async () => { throw new Error("已完成回合不能重跑"); });
    const restored = service.get(job.id), turn = restored.turns.at(-1)!;
    assert.equal(turn.id, submitted.turn_id); assert.deepEqual(turn.review_note_ids, ids);
    assert.equal(restored.turns.length, 2); assert.equal(restored.documents[0].content, "# 业务规则\n原文");
    const tool = domainKnowledgeReviewNotesTool(dataDir, job.id, turn.review_note_ids!);
    const result = await call(tool, "read", { action: "read", id: ids[0] });
    const note = JSON.parse(result.content[0].text).note;
    assert.equal(note.note, original[0].note); assert.equal(note.quote, original[0].quote);
    assert.equal(note.context_before, original[0].context_before); assert.equal(note.context_after, original[0].context_after);
    assert.equal(note.line, 2); assert.equal(note.id, ids[0]);
    assert.throws(() => service.run(job.id, { mode: "revise", document_ids: ["rules"], message: "其他任务意见", review_note_ids: ["foreign-feedback"] }, "expert"), /已不存在/);
    assert.equal(service.get(job.id).turns.length, 2);
  } finally { await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});
