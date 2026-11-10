import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { completedDomainTask as done, domainArchiveFixture, publicationFor, submitDomainCandidates as submit } from "./fixtures/domainKnowledgeArchive.ts";

const target = { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" };
const execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1] = async input => { input.save({ id: "rules", title: "规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "# 原规则", sources: "资料" }); return "完成"; };
function receipt(job: DomainKnowledgeJob, targetId: string, previous?: DomainPublication): DomainPublication {
  return { target_id: targetId, state: "opened", branch: previous?.branch || "codex/original", mr_id: previous?.mr_id || 1, url: previous?.url || "https://example.test/mr/1", revision: "a".repeat(40),
    documents: job.documents.filter(document => document.target_id === targetId).map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
}
async function initial(service: DomainKnowledgeExtraction) {
  const job = await done(service, service.create({ title: "知识", scope: "规则", repositories: [], knowledge_target: target, issue_no: "REQ-489" }, "user").id);
  await submit(service, job.id); return service.get(job.id);
}

test("重复提交及 replace_existing 旧参数不会另建或撤销 MR，修改后续推同一 MR", async () => {
  const f = await domainArchiveFixture("archive-continuation-real-"); f.module("orders"); const service = f.manager(execute);
  try {
    const created = await done(service, service.create({ module_id: "orders", baseline_branch: "main", issue_no: "REQ-continuation" }, "user").id); await submit(service, created.id);
    let job = service.get(created.id); const first = publicationFor(job);
    await submit(service, job.id, { replace_existing: true }); assert.equal(f.creates, 1); assert.equal(f.closed, 0);
    job = service.edit(job.id, { document: { ...job.documents[0], content: "# 第二版规则" }, base_revision: job.documents[0].revision }, "user"); await submit(service, job.id);
    const second = publicationFor(service.get(job.id)); assert.equal(second.url, first.url); assert.equal(second.branch, first.branch); assert.equal(f.creates, 1); assert.equal(f.closed, 0);
    assert.equal(f.content(f.knowledge, second.branch, job.documents[0].path), "# 第二版规则"); assert.equal(listKnowledgeDocuments(f.dataDir).length, 0);
    f.setState("merged"); await service.refreshPublications(job.id, "user");
    assert.throws(() => service.edit(job.id, { document: job.documents[0], base_revision: job.documents[0].revision }, "user"), /已合入/);
    assert.equal(f.content(f.knowledge, second.branch, job.documents[0].path), "# 第二版规则");
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("MR 续推失败后重启只重试原批次，不重新研究、建单或关闭原 MR", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-continuation-retry-")); let calls = 0, failed = true, research = 0; const previous: Array<DomainPublication | undefined> = [];
  const options: ConstructorParameters<typeof DomainKnowledgeExtraction>[2] = { publish: async (job, target, old) => { calls++; previous.push(old); if (calls > 1 && failed) throw new Error("临时连接故障"); return receipt(job, target.id, old); }, closePublication: async () => { throw new Error("不能关闭原 MR"); } };
  let service = new DomainKnowledgeExtraction(root, async input => { research++; return execute(input); }, options);
  try {
    let job = await initial(service); job = service.edit(job.id, { document: { ...job.documents[0], content: "# 修订" }, base_revision: job.documents[0].revision }, "user");
    const preview = await submit(service, job.id); assert.equal(preview.status_label, "MR 创建失败"); assert.equal(previous[1]?.url, "https://example.test/mr/1");
    const batch = service.get(job.id).archive_batches!.at(-1)!; await service.shutdown(); failed = false;
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("重试不能重新研究"); }, options);
    await service.retryArchive(job.id, "user", { batch_id: batch.id }); const restored = service.get(job.id).archive_batches!.find(item => item.id === batch.id)!;
    assert.equal(restored.state, "done"); assert.equal(restored.publications[0].url, "https://example.test/mr/1"); assert.equal(calls, 3); assert.equal(research, 1);
    await service.retryArchive(job.id, "user", { batch_id: batch.id }); assert.equal(calls, 3);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("失败批次重试使用创建时的单号和描述，不被任务后来设置覆盖", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-frozen-issue-")); let calls = 0; const seen: Array<[string | undefined, string | undefined]> = [];
  const service = new DomainKnowledgeExtraction(root, execute, { publish: async (job, target, previous) => { seen.push([job.issue_no, job.issue_description]); if (++calls === 2) throw new Error("临时故障"); return receipt(job, target.id, previous); } });
  try {
    let job = await initial(service); job = service.edit(job.id, { document: { ...job.documents[0], content: "# 更新" }, base_revision: job.documents[0].revision }, "user");
    await submit(service, job.id, { issue_no: "REQ-NOW", issue_description: "本次修改描述" }); const batch = service.get(job.id).archive_batches!.at(-1)!;
    service.setIssueNumber(job.id, "REQ-LATER", "以后描述"); await service.retryArchive(job.id, "user", { batch_id: batch.id });
    assert.deepEqual(seen, [["REQ-489", undefined], ["REQ-NOW", "本次修改描述"], ["REQ-NOW", "本次修改描述"]]);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("原 MR 已关闭时保留修订稿并明确拒绝续推，不悄悄换一个新 MR", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-closed-")); let calls = 0;
  const service = new DomainKnowledgeExtraction(root, execute, { publish: async (job, target, previous) => { calls++; return receipt(job, target.id, previous); },
    refreshPublication: async (_target, publication) => ({ ...publication, mr_state: "closed", checked_at: new Date().toISOString() }) });
  try {
    let job = await initial(service); job = service.edit(job.id, { document: { ...job.documents[0], content: "# 待提交修订" }, base_revision: job.documents[0].revision }, "user");
    await assert.rejects(submit(service, job.id), /已关闭/); assert.equal(calls, 1); assert.equal(service.get(job.id).documents[0].content, "# 待提交修订");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("同一 MR 分批改名 A、B，未选文稿保留原文件，最后统一保留新路径", async () => {
  const f = await domainArchiveFixture("archive-partial-paths-"); f.module("orders");
  const service = f.manager(async input => { for (const id of ["a", "b"]) input.save({ id, title: id, target_id: "domain", path: `${input.job.knowledge_target.docs_path}/${id}.md`, layer: "domain", content: `# ${id}`, sources: "资料" }); return "完成"; });
  try {
    let job = await done(service, service.create({ module_id: "orders", baseline_branch: "main", issue_no: "REQ-partial" }, "user").id); await submit(service, job.id); const first = publicationFor(service.get(job.id));
    job = service.configureArchive(job.id, { base_revision: 0, use_directory_layout: true, targets: [job.knowledge_target], documents: [{ id: "a", path: "domains/orders/a-new.md" }, { id: "b", path: "domains/orders/b-new.md" }] });
    service.select(job.id, ["b"], false); await submit(service, job.id); const middle = publicationFor(service.get(job.id));
    assert.equal(middle.url, first.url); assert.equal(f.exists(f.knowledge, middle.branch, "domains/orders/a.md"), false);
    assert.ok(f.exists(f.knowledge, middle.branch, "domains/orders/a-new.md")); assert.ok(f.exists(f.knowledge, middle.branch, "domains/orders/b.md")); assert.equal(f.exists(f.knowledge, middle.branch, "domains/orders/b-new.md"), false);
    service.select(job.id, ["a"], false); service.select(job.id, ["b"], true); await submit(service, job.id); const last = publicationFor(service.get(job.id));
    assert.equal(last.url, first.url); assert.equal(last.branch, first.branch); assert.equal(f.creates, 1); assert.equal(f.closed, 0);
    for (const id of ["a", "b"]) { assert.equal(f.exists(f.knowledge, last.branch, `domains/orders/${id}.md`), false); assert.equal(f.content(f.knowledge, last.branch, `domains/orders/${id}-new.md`), `# ${id}`); }
    assert.equal(service.get(job.id).documents.length, 2);
  } finally { await service.shutdown(); await f.cleanup(); }
});
