import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { DomainKnowledgeStore } from "../src/domainKnowledgeStore.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("研究未在5秒预算内完成"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test("生产线验收4/5/14：全部MR链接已耐久而最终done写EIO，手动重试只补终态、不重复Git或MR", { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-manual-terminal-eio-")); let calls = 0;
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    input.save({ id: "rules", title: "订单", target_id: "domain", path: "domains/rules.md", layer: "domain", content: "已审查规则", sources: "源码" }); return "完成";
  }, { publish: async (job, target, _previous, _operator, save) => {
    calls++; save({ target_id: target.id, branch: "codex/terminal", state: "pending", documents: [], mr_attempted: true });
    return { target_id: target.id, branch: "codex/terminal", state: "opened", url: "https://example.test/mr/terminal", mr_id: 1,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
  } });
  try {
    const job = manager.create({ title: "订单", scope: "订单规则", issue_no: "REQ-TERMINAL", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => manager.get(job.id).status === "done");
    const path = join(dir, "domain-extraction", job.id, "job.json"), progressPath = join(dir, "domain-extraction", job.id, "archive-progress.json"), rename = fs.renameSync; let failed = false;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (!failed && String(args[1]) === progressPath) {
        const candidate = JSON.parse(fs.readFileSync(String(args[0]), "utf8")) as { batches: Array<{ state: string }> };
        if (candidate.batches.some(batch => batch.state === "done")) { failed = true; throw Object.assign(new Error("测试最终done写盘 EIO"), { code: "EIO" }); }
      }
      return rename(...args);
    }); syncBuiltinESMExports();
    try {
      await manager.createArchive(job.id, { issue_no: "REQ-TERMINAL", expected_revisions: manager.previewArchive(job.id).expected_revisions }, "alice");
      assert.equal(failed, true);
    } finally { interception.mock.restore(); syncBuiltinESMExports(); }
    const batch = manager.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!;
    assert.equal(batch.state, "done", "单次 EIO 后按已耐久 MR 事实补齐完成状态"); assert.equal(batch.publications[0].state, "opened"); assert.equal(batch.publications[0].url, "https://example.test/mr/terminal");
    const repaired = await manager.retryArchive(job.id, "alice", { batch_id: batch.id });
    assert.equal(repaired.status_label, "MR 待合入"); assert.equal(calls, 1, "已保存MR链接不能再次启动Git/MR");
    const disk = new DomainKnowledgeStore().read(path) as DomainKnowledgeJob;
    assert.equal(disk.archive_batches!.find(row => row.id === batch.id)!.state, "done");
  } finally { await manager.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收1/4/5/14：重启发现running批次已保存全部MR，人工重试只补done且保留原链接分支", { timeout: 10_000 }, async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-manual-terminal-restart-")); let calls = 0;
  const first = new DomainKnowledgeExtraction(dir, async input => {
    input.save({ id: "rules", title: "订单", target_id: "domain", path: "domains/rules.md", layer: "domain", content: "已审查规则", sources: "源码" }); return "完成";
  }, { publish: async (job, target) => {
    calls++; return { target_id: target.id, branch: "codex/restart-terminal", state: "opened", url: "https://example.test/mr/restart-terminal", mr_id: 2,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
        knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
  } });
  let restarted: DomainKnowledgeExtraction | undefined;
  try {
    const job = first.create({ title: "订单", scope: "订单规则", issue_no: "REQ-RESTART", repositories: [],
      knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => first.get(job.id).status === "done");
    await first.createArchive(job.id, { issue_no: "REQ-RESTART", expected_revisions: first.previewArchive(job.id).expected_revisions }, "alice");
    await first.shutdown();
    const path = join(dir, "domain-extraction", job.id, "job.json"), store = new DomainKnowledgeStore(), disk = store.read(path) as DomainKnowledgeJob;
    const batch = disk.archive_batches!.find(batch => !!batch.issue_no)!;
    batch.state = "running";
    // 写入新主文件版本，旧的 done 检查点不能覆盖“回执已保存但终态未保存”的恢复现场。
    store.save(path, disk);
    restarted = new DomainKnowledgeExtraction(dir, async () => { throw new Error("不得重启已完成研究"); }, { publish: async () => {
      calls++; throw new Error("已有耐久MR回执，不得重新调用Git或MR");
    } });
    assert.equal(restarted.get(job.id).archive_batches!.find(row => row.id === batch.id)!.state, "failed");
    const repaired = await restarted.retryArchive(job.id, "alice", { batch_id: batch.id });
    assert.equal(repaired.status_label, "MR 待合入"); assert.equal(calls, 1);
    const repairedDisk = new DomainKnowledgeStore().read(path) as DomainKnowledgeJob;
    const repairedBatch = repairedDisk.archive_batches!.find(row => row.id === batch.id)!;
    assert.equal(repairedBatch.state, "done"); assert.equal(repairedBatch.publications[0].branch, "codex/restart-terminal");
    assert.equal(repairedBatch.publications[0].url, "https://example.test/mr/restart-terminal");
  } finally { await first.shutdown(); await restarted?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
