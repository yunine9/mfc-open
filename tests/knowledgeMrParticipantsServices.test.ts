import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { KnowledgeSourceCleanup } from "../src/knowledgeSourceCleanup.ts";
import type { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import type { MrParticipantsResult } from "../src/mrParticipants.ts";

const requested = { reviewers: ["reviewer"], approval_approvers: ["approver"] };
const failed: MrParticipantsResult = { status: "failed", requested, message: "人员服务暂不可用" };
const config = { issue_no: "REQ-479", issue_description: "归档订单知识", title: "订单", scope: "订单规则",
  repositories: [{ name: "订单仓", repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/business" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/orders" } };
const document = { id: "orders", title: "订单", target_id: "domain", path: "domains/orders/orders.md", layer: "domain" as const,
  content: "订单规则", sources: "repo-1 / order.ts" };
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("任务未完成");
}

test("归档人员失败静默保留，重启后重试也不再调用已建MR的发布器", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-people-")), calls: string[] = [];
  const publish: NonNullable<ConstructorParameters<typeof DomainKnowledgeExtraction>[2]>["publish"] = async (_job, target, previous) => {
    calls.push(target.id);
    assert.equal(previous, undefined, "已有 MR 不应再次进入发布器");
    return { target_id: target.id, branch: `main_fixture_${target.id}`, state: "opened", url: `https://example.test/mr/${target.id}`,
      documents: [], mr_participants: target.id === "domain" ? failed : { status: "applied", requested } };
  };
  let service = new DomainKnowledgeExtraction(dir, async input => {
    input.save(document, { content: null, revision: "a".repeat(40) });
    input.save({ ...document, id: "implementation", layer: "repository", target_id: "repo-1", path: "docs/business/orders.md" }, { content: null, revision: "a".repeat(40) });
    return "已完成";
  }, { publish });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.createArchive(job.id, { issue_no: config.issue_no, expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice");
    const batchId = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!.id;
    // 候选链路词表(13ff28b7):已开 MR = 「MR 待合入」,归档动作是「查看 MR」。
    assert.equal(service.get(job.id).production!.status_label, "MR 待合入");
    const preview = service.previewArchive(job.id);
    assert.equal(preview.status_label, "MR 待合入");
    assert.deepEqual(preview.targets[0].mr_participants, failed);
    assert.equal(preview.targets[0].actions.length, 0);
    assert.equal(preview.targets[0].error, undefined);
    assert.doesNotMatch(preview.targets[0].message ?? "", /人员|重试/);
    assert.equal(service.get(job.id).production!.archive.actions[0].label, "查看 MR");
    assert.equal(preview.targets[1].actions.length, 0);
    await service.shutdown(); service = new DomainKnowledgeExtraction(dir, async () => { throw new Error("不能重新执行研究"); }, { publish });
    const original = structuredClone(service.get(job.id).publications);
    await service.retryArchive(job.id, "alice", { batch_id: batchId, target_id: "domain" });
    await service.retryArchive(job.id, "alice", { batch_id: batchId });
    const retained = service.get(job.id);
    assert.equal(retained.archive_batches!.find(batch => batch.id === batchId)!.state, "done");
    assert.equal(retained.production!.status_label, "MR 待合入");
    assert.deepEqual(retained.publications, original, "复用链接并保留原内部人员结果");
    assert.deepEqual(calls, ["domain", "repo-1"]);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("归档回执校验人员结果，拒绝损坏的状态、名单和说明并保留旧格式兼容", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-people-validation-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    input.save(document, { content: null, revision: "a".repeat(40) }); return "已完成";
  }, { publish: async (_job, target) => ({ target_id: target.id, branch: "main_fixture", state: "opened", url: "https://example.test/mr/1", documents: [] }) });
  const reopened: DomainKnowledgeExtraction[] = [];
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.createArchive(job.id, { issue_no: config.issue_no, expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice");
    await service.shutdown();
    // 回执的耐久落点是归档检查点(archive-progress.json),主文件只在首发时写一次正文;
    // 校验损坏的 mr_participants 要打在检查点上,重启按检查点合并回公开记录。
    const path = join(dir, "domain-extraction", job.id, "archive-progress.json"), original = JSON.parse(readFileSync(path, "utf8"));
    for (const result of [undefined, failed, { status: "skipped", requested, message: "已有 MR" }]) {
      const stored = structuredClone(original); stored.publications[0].mr_participants = result;
      writeFileSync(path, JSON.stringify(stored));
      const reader = new DomainKnowledgeExtraction(dir, async () => "unused"); reopened.push(reader);
      assert.equal(reader.get(job.id).publications[0].state, "opened"); await reader.shutdown();
    }
    for (const result of [null, { ...failed, status: "unknown" }, { ...failed, requested: [] },
      { ...failed, requested: { reviewers: ["bad account"], approval_approvers: [] } }, { ...failed, message: 123 }]) {
      const stored = structuredClone(original); stored.publications[0].mr_participants = result;
      writeFileSync(path, JSON.stringify(stored));
      const reader = new DomainKnowledgeExtraction(dir, async () => "unused"); reopened.push(reader);
      assert.throws(() => reader.get(job.id), /不存在/); await reader.shutdown();
    }
  } finally { await service.shutdown(); await Promise.all(reopened.map(reader => reader.shutdown())); rmSync(dir, { recursive: true, force: true }); }
});

function cleanupPublisher(calls: string[]): Pick<KnowledgeMrPublisher, "previewCleanup" | "publishCleanup"> {
  return {
    async previewCleanup(target) {
      return { id: `plan-${target.id}`, target_id: target.id, paths: ["docs/old"], target_revision: "a".repeat(40),
        entries: [{ path: "docs/old/orders.md", mode: "100644", oid: "b".repeat(40) }], selected_paths: ["docs/old/orders.md"] };
    },
    async publishCleanup(_job, target, plan, paths, previous) {
      assert.ok(!previous?.url, "已有清理 MR 不应再次进入发布器");
      calls.push(target.id);
      if (target.id === "repo-2" && calls.filter(id => id === target.id).length === 1) throw new Error("第二仓尚未创建 MR");
      return { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: paths as string[], branch: "main_fixture_REQ479", revision: "c".repeat(40),
        state: "opened", url: `https://example.test/mr/${target.id}`, documents: [], mr_participants: failed };
    },
  };
}

test("清理按仓重试只处理未建成MR，已有链接不追补人员也不误跑其他仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-people-")), calls: string[] = [];
  const manager = new DomainKnowledgeExtraction(dir, async () => "已完成", { sourceCleanup: new KnowledgeSourceCleanup(cleanupPublisher(calls)) });
  try {
    const job = manager.create({ ...config, knowledge_target: undefined, prepare_cleanup: true, repositories: [...config.repositories, { ...config.repositories[0], repository: "https://example.test/payments.git" }] }, "alice");
    await manager.sourceCleanupAction(job.id, "preview", { paths_by_target: { "repo-1": ["docs/old"], "repo-2": ["docs/old"] } }, "alice");
    const selected_paths_by_target = { "repo-1": ["docs/old/orders.md"], "repo-2": ["docs/old/orders.md"] };
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target }, "alice");
    const original = structuredClone(manager.get(job.id).source_cleanup!.publications[0]);
    assert.deepEqual(calls, ["repo-1", "repo-2"]);
    await assert.rejects(manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "missing" }, "alice"), /清理目标不存在/);
    await assert.rejects(manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target: { ...selected_paths_by_target, "repo-1": [] }, target_id: "repo-1" }, "alice"), /原范围/);
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-1" }, "alice");
    assert.deepEqual(calls, ["repo-1", "repo-2"], "旧人员重试请求不会处理尚未创建 MR 的其他仓");
    assert.deepEqual(manager.get(job.id).source_cleanup!.publications[0], original);
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-2" }, "alice");
    assert.deepEqual(calls, ["repo-1", "repo-2", "repo-2"], "真正 MR 创建失败仍可以按仓重试");
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target }, "alice");
    assert.deepEqual(calls, ["repo-1", "repo-2", "repo-2"]);
    assert.equal(manager.get(job.id).production!.status_label, "待开始萃取");
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("清理人员失败不阻止开始萃取，重复请求保留原MR与名单", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-people-repeat-")), calls: string[] = [];
  let executions = 0;
  const manager = new DomainKnowledgeExtraction(dir, async () => { executions++; return "已完成"; }, { sourceCleanup: new KnowledgeSourceCleanup(cleanupPublisher(calls)) });
  try {
    const job = manager.create({ ...config, knowledge_target: undefined, prepare_cleanup: true }, "alice");
    await manager.sourceCleanupAction(job.id, "preview", { paths_by_target: { "repo-1": ["docs/old"] } }, "alice");
    const selected_paths_by_target = { "repo-1": ["docs/old/orders.md"] };
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target }, "alice");
    assert.equal(manager.get(job.id).production!.status_label, "待开始萃取");
    const original = structuredClone(manager.get(job.id).source_cleanup!.publications[0]);
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-1" }, "alice");
    assert.deepEqual(manager.get(job.id).source_cleanup!.publications[0], original);
    assert.deepEqual(calls, ["repo-1"]);
    await manager.sourceCleanupAction(job.id, "start", {}, "alice");
    await until(() => executions === 1);
    assert.equal(manager.get(job.id).source_cleanup!.started, true);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
