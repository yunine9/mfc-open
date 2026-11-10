import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeTaskCapacity } from "../src/knowledgeTaskCapacity.ts";
import { DomainKnowledgeExtraction, type DomainExecution } from "../src/domainKnowledgeExtraction.ts";

const config = { title: "交易", scope: "交易规则", issue_no: "REQ-delete", repositories: [{ repository: "https://example.test/business.git", branch: "master", docs_path: "docs/knowledge" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "domains" } };
const document = { id: "rules", title: "规则", target_id: "domain", path: "domains/rules.md", layer: "domain" as const, content: "# 规则", sources: "源码" };
const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("未在预期时间完成"); };

test("删除运行与排队任务：中止执行、拒绝迟到写入、重启不恢复，保留来源记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-delete-"));
  const executions: DomainExecution[] = [];
  const service = new DomainKnowledgeExtraction(root, async input => {
    executions.push(input);
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    input.update({ stage: "迟到的状态" }); input.evidence({ tool: "late" });
    assert.throws(() => input.save(document), /已停止/);
    return "迟到的回复";
  }, { capacity: new KnowledgeTaskCapacity(2) });
  try {
    const first = service.create({ ...config, title: "运行任务一" }, "user"), second = service.create({ ...config, title: "运行任务二" }, "user"), queued = service.create({ ...config, title: "排队任务" }, "user");
    await wait(() => executions.length === 2);
    assert.equal(service.get(queued.id).status, "queued");
    assert.deepEqual(service.remove(queued.id, "user"), { deleted: true });
    for (const job of [first, second]) service.remove(job.id, "user");
    assert.ok(executions.every(input => input.signal.aborted));
    await service.shutdown();
    assert.equal(executions.length, 2); assert.equal(service.list().length, 0);
    for (const job of [first, second, queued]) {
      assert.throws(() => service.get(job.id), /已删除/);
      assert.throws(() => service.run(job.id, { mode: "extract", message: "重新执行" }, "user"), /停止|已删除/);
      const saved = JSON.parse(readFileSync(join(root, "domain-extraction", job.id, "job.json"), "utf8"));
      assert.equal(saved.deleted_by, "user"); assert.ok(saved.deleted_at); assert.equal(saved.status, "cancelled");
      assert.equal(saved.turns[0].status, "cancelled"); assert.equal(saved.evidence.length, 0); assert.equal(saved.documents.length, 0);
      assert.notEqual(saved.stage, "迟到的状态");
    }
    const restored = new DomainKnowledgeExtraction(root, async () => { throw new Error("不能执行已删除任务"); });
    assert.equal(restored.list().length, 0);
    assert.throws(() => restored.run(first.id, { mode: "extract", message: "重新执行" }, "user"), /已删除/);
    assert.deepEqual(restored.remove(first.id, "another"), { deleted: true });
    await restored.shutdown();
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("归档中拒绝删除，完成后删除保留 MR 和草稿来源", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-delete-mr-"));
  let finish!: () => void, started = false, execution: DomainExecution | undefined;
  const service = new DomainKnowledgeExtraction(root, async input => { execution = input; input.save(document, { content: null, revision: "a".repeat(40) }); return "done"; }, {
    publish: async (_job, target) => {
      started = true; await new Promise<void>(resolve => { finish = resolve; });
      return { target_id: target.id, state: "opened", branch: "codex/knowledge-test", url: "https://example.test/mr/1", documents: [] };
    },
  });
  try {
    const job = service.create(config, "user"); await wait(() => service.get(job.id).status === "done");
    await assert.rejects(service.publish(job.id, "user"), /直接创建 MR/);
    const publication = service.createArchive(job.id, { issue_no: "REQ-delete", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user"); await wait(() => started);
    assert.throws(() => service.remove(job.id, "user"), /正在发布或归档/); assert.equal(service.list().length, 1);
    finish(); await publication;
    assert.deepEqual(service.remove(job.id, "user"), { deleted: true });
    execution!.update({ stage: "已结束任务的迟到写入" }); execution!.evidence({ tool: "late" });
    assert.throws(() => execution!.save(document), /已停止/);
    const saved = JSON.parse(readFileSync(join(root, "domain-extraction", job.id, "job.json"), "utf8"));
    assert.notEqual(saved.stage, "已结束任务的迟到写入"); assert.equal(saved.evidence.length, 0);
    assert.equal(saved.publications[0].url, "https://example.test/mr/1"); assert.equal(saved.publications[0].state, "opened"); assert.equal(saved.documents[0].content, document.content);
    assert.throws(() => service.edit(job.id, { document, base_revision: 1 }, "user"), /已删除/);
  } finally { finish?.(); await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
