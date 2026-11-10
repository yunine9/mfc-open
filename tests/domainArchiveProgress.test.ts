import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainArchiveProgressStore, copyDomainArchiveState, readDomainArchiveProgress } from "../src/domainArchiveProgress.ts";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { completedDomainTask, submitDomainCandidates } from "./fixtures/domainKnowledgeArchive.ts";

test("多次归档进度保存不重写主文件，重启保留最后 MR 和完整正文", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-archive-progress-"));
  let jobPath = "", mainAtPublish = "", calls = 0;
  let service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "rules", title: "规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "# 规则\n" + "业务内容".repeat(100_000), sources: "资料" });
    return "完成";
  }, { publish: async (job, target, _previous, _operator, save) => {
    calls++; mainAtPublish = readFileSync(jobPath, "utf8");
    const result: DomainPublication = { target_id: target.id, state: "pending", branch: "codex/archive", documents: job.documents.map(({ id, path, content, revision }) => ({ id, path, content, revision })) };
    for (let index = 0; index < 9; index++) {
      save!({ ...result, revision: String(index) });
      assert.equal(readFileSync(jobPath, "utf8"), mainAtPublish, "发布过程不能反复重写整份 job.json");
    }
    return { ...result, state: "opened", url: "https://example.test/mr/8", revision: "final" };
  } });
  try {
    const job = await completedDomainTask(service, service.create({ title: "知识", scope: "规则", issue_no: "REQ-8", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "user").id);
    jobPath = join(root, "domain-extraction", job.id, "job.json");
    await submitDomainCandidates(service, job.id);
    const progressPath = join(root, "domain-extraction", job.id, "archive-progress.json");
    assert.ok(statSync(progressPath).size < 10_000, "检查点不包含文稿正文");
    assert.equal(readdirSync(join(root, "domain-extraction", job.id, "archive-progress-bodies")).length, 1);
    assert.equal(service.get(job.id).archive_batches!.at(-1)!.state, "done");
    await service.shutdown();
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不重新研究"); }, { publish: async () => { throw new Error("不重复创建 MR"); } });
    const restored = service.get(job.id), batch = restored.archive_batches!.at(-1)!;
    assert.equal(batch.state, "done"); assert.equal(restored.publications[0].revision, "final");
    assert.equal(restored.publications[0].documents[0].content, job.documents[0].content);
    await service.retryArchive(job.id, "user", { batch_id: batch.id });
    assert.equal(calls, 1);
    service.setIssueNumber(job.id, "REQ-new");
    await service.shutdown();
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不重新研究"); });
    assert.equal(service.get(job.id).issue_no, "REQ-new");
    assert.equal(service.get(job.id).publications[0].revision, "final", "整任务保存后仍保留归档检查点的最终结果");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("137 MB 级任务的归档进度忽略研究大字段，旧检查点不覆盖新主文件", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-large-state-")), path = join(root, "job.json");
  const body = "x".repeat(84 * 1024 * 1024), evidence = "e".repeat(54 * 1024 * 1024);
  const publication = { target_id: "domain", state: "opened", branch: "codex/archive", url: "https://example.test/mr/8", documents: [{ id: "rules", path: "rules.md", content: body, revision: 1 }] } as DomainPublication;
  const job = { id: "large", archive_progress_revision: "old", evidence: [{ text: evidence }], turns: [], documents: [], publications: [publication], archive_batches: [{ id: "batch", state: "done", publications: [publication], documents: [], targets: [], replacements: [] }] } as unknown as DomainKnowledgeJob;
  try {
    writeFileSync(path, "主文件保持原样");
    const store = new DomainArchiveProgressStore();
    for (let index = 0; index < 9; index++) { const copy = copyDomainArchiveState(job); copy.publications[0].revision = String(index); store.save(path, copy); }
    assert.equal(readFileSync(path, "utf8"), "主文件保持原样");
    assert.ok(statSync(join(root, "archive-progress.json")).size < 2000);
    assert.equal(readdirSync(join(root, "archive-progress-bodies")).length, 1);
    const restored = readDomainArchiveProgress(path, { ...job, publications: [] });
    assert.equal(restored.publications[0].revision, "8"); assert.equal(restored.publications[0].documents[0].content.length, body.length);
    const newer = { ...job, archive_progress_revision: "new", publications: [] };
    assert.equal(readDomainArchiveProgress(path, newer).publications.length, 0);
    assert.equal(job.evidence[0].text, evidence);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("归档可超过旧 180 秒预算，600 秒后终止且忽略迟到的 MR 进度", async context => {
  const root = mkdtempSync(join(tmpdir(), "archive-time-budget-"));
  let save: ((publication: DomainPublication) => void) | undefined, signal: AbortSignal | undefined;
  let publication: DomainPublication | undefined;
  const service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "rules", title: "规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "# 规则", sources: "资料" }); return "完成";
  }, { publish: async (job, target, _previous, _operator, progress, abort) => {
    save = progress; signal = abort;
    publication = { target_id: target.id, state: "opened", branch: "codex/archive", url: "https://example.test/mr/late", documents: job.documents.map(({ id, path, content, revision }) => ({ id, path, content, revision })) };
    return new Promise(() => {});
  } });
  try {
    const job = await completedDomainTask(service, service.create({ title: "知识", scope: "规则", issue_no: "REQ-8", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "user").id);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const archived = submitDomainCandidates(service, job.id);
    await Promise.resolve();
    assert.ok(save); context.mock.timers.tick(180_001); await Promise.resolve();
    assert.equal(signal!.aborted, false);
    context.mock.timers.tick(420_000); await archived;
    assert.equal(signal!.aborted, true);
    assert.match(service.get(job.id).archive_batches!.at(-1)!.error!, /600 秒/);
    save!(publication!);
    assert.equal(service.get(job.id).publications[0].state, "failed");
    assert.equal(service.get(job.id).publications[0].url, undefined);
  } finally { context.mock.timers.reset(); await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
