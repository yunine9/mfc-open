import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { readDomainArchiveProgress } from "../src/domainArchiveProgress.ts";
import { listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// 模块停用必须在任何目标 MR 创建前统一检查，候选仍保留。
test("生产线验收4：跨仓 MR 提交遇到停用模块，预检失败且无外部操作或正式知识生效", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-publish-precheck-"));
  createBusinessModule(dir, { id: "orders", name: "订单", description: "订单域", owner: "alice", repositories: ["https://example.test/orders.git"] }, "admin");
  let archiveCalls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    const repo = input.job.repositories[0];
    input.save({ id: "repo-doc", title: "仓内", target_id: repo.id, path: `${repo.docs_path}/repo.md`, layer: "repository", content: "仓内规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
    input.save({ id: "domain-doc", title: "领域", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/domain.md`, layer: "domain", content: "领域规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
    return "完成";
  }, { publish: async (_job, target) => { archiveCalls++; return { target_id: target.id, branch: "b", state: "opened", documents: [] }; } });
  try {
    const job = service.create({ issue_no: "REQ-1", module_id: "orders", knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => service.get(job.id).status === "done", "本地研究未在5秒内完成");
    assert.deepEqual(service.get(job.id).documents.map(doc => doc.id), ["repo-doc", "domain-doc"]);
    updateBusinessModule(dir, "orders", { status: "archived" }, "admin");
    const path = join(dir, "domain-extraction", job.id, "job.json"), before = readFileSync(path, "utf8");
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ-1", expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice"), /所选业务模块已停用/);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.ok(service.get(job.id).documents.every(doc => doc.knowledge_document_id === undefined));
    assert.equal(service.get(job.id).archive_batches, undefined);
    assert.equal(archiveCalls, 0);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("第二个目标 MR 回执耐久写 EIO 时保留首仓成功与失败仓分支，重启只重试失败目标", { timeout: 20_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-partial-publish-"));
  const seen: Array<{ target: string; documents: DomainPublication["documents"] }> = [];
  let indexed = 0, restarted: DomainKnowledgeExtraction | undefined;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id === "domain" ? "one" : "two", title: target.name,
      target_id: target.id, path: `${target.docs_path}/rules.md`, layer: target.id === "domain" ? "domain" : "repository", content: `# ${target.id}\r\n有效规则正文`, sources: "固定版本源码" }, { revision: "a".repeat(40), content: null });
    return "研究完成";
  }, {
    onIndexed: () => { indexed++; },
    publish: async (job, target, previous, _operator, save) => {
      const documents = job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision }));
      seen.push({ target: target.id, documents });
      const branch = previous?.branch || `codex/partial-${target.id}`;
      save({ target_id: target.id, branch, state: "pending", documents: [], attempted_documents: documents, mr_attempted: true });
      return { target_id: target.id, branch, state: "opened", url: `https://example.test/mr/${target.id}`, documents };
    },
  });
  try {
    const job = service.create({ title: "订单域", scope: "核对订单规则", issue_no: "REQ-PARTIAL", repositories: [{ repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/orders" }],
      knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => service.get(job.id).status === "done", "测试研究未在5秒内完成");
    const originals = structuredClone(service.get(job.id).documents), path = join(dir, "domain-extraction", job.id, "job.json"),
      checkpoint = join(dirname(path), "archive-progress.json"), rename = fs.renameSync;
    let failed = false;
    const intercepted = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      // 回执的耐久写落在归档检查点(archive-progress.json)。
      if (!failed && String(args[1]) === checkpoint) {
        const record = JSON.parse(readFileSync(String(args[0]), "utf8")) as { batches?: Array<{ publications: DomainPublication[] }> };
        if (record.batches?.some(batch => batch.publications.filter(publication => publication.state === "opened").length === 2)) {
          failed = true; throw Object.assign(new Error("测试磁盘 EIO：第二个 MR 回执未写成"), { code: "EIO" });
        }
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      await service.createArchive(job.id, { issue_no: "REQ-PARTIAL", expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice");
    } finally { intercepted.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(failed, true); assert.equal(seen.length, 2); assert.equal(indexed, 0, "候选提交不提前更新正式索引");
    assert.deepEqual(listKnowledgeDocuments(dir), []);
    // 检查点把正文换成摘要引用,用正式读取口还原后再断言。
    const disk = readDomainArchiveProgress(path, JSON.parse(readFileSync(path, "utf8")) as DomainKnowledgeJob), batch = disk.archive_batches![0];
    const first = batch.publications.find(publication => publication.target_id === "domain")!, second = batch.publications.find(publication => publication.target_id === "repo-1")!;
    assert.equal(batch.state, "failed"); assert.equal(first.state, "opened"); assert.equal(first.url, "https://example.test/mr/domain");
    assert.equal(second.state, "failed"); assert.match(second.error ?? "", /EIO/); assert.equal(second.branch, "codex/partial-repo-1");
    assert.equal(second.mr_attempted, true, "失败目标保留真实 MR 请求事实供恢复查询");
    assert.deepEqual(disk.documents, originals, "失败不会污染任意候选正文、版本或来源");
    assert.deepEqual(first.documents[0].content, originals[0].content, "已提交快照与候选保持相同字节");
    await within(service.shutdown(), 5000, "原管理器未在5秒内关停");
    let researchCalls = 0, retries = 0;
    restarted = new DomainKnowledgeExtraction(dir, async () => { researchCalls++; throw new Error("重启不应重新研究"); }, {
      publish: async (snapshot, target, previous) => {
        retries++; assert.equal(target.id, "repo-1"); assert.equal(previous?.branch, second.branch);
        return { target_id: target.id, branch: previous!.branch, state: "opened", url: "https://example.test/mr/recovered",
          documents: snapshot.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
      },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(researchCalls, 0); assert.equal(retries, 0, "重启不自动进行外部提交");
    await restarted.retryArchive(job.id, "alice", { batch_id: batch.id });
    const completed = restarted.get(job.id).archive_batches![0];
    assert.equal(completed.state, "done"); assert.equal(retries, 1);
    { const kept = completed.publications.find(publication => publication.target_id === "domain")!;
      assert.equal(kept.state, first.state); assert.equal(kept.url, first.url); assert.deepEqual(kept.documents, first.documents); }
    await restarted.retryArchive(job.id, "alice", { batch_id: batch.id });
    assert.equal(retries, 1); assert.deepEqual(restarted.get(job.id).documents, originals); assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally {
    await within(service.shutdown(), 5000, "测试清理期间原管理器未关停");
    if (restarted) await within(restarted.shutdown(), 5000, "测试清理期间重启管理器未关停");
    rmSync(dir, { recursive: true, force: true });
  }
});
