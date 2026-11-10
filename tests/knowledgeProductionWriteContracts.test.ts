import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveKnowledgeDocument, readKnowledgeDocument, listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { componentDeletionView, deleteComponentDocuments } from "../src/componentKnowledgeDeletion.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

async function within<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const domainRequest = { title: "订单域", scope: "核对订单规则", issue_no: "REQ-WRITE", issue_description: "订单领域知识研究", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };

test("领域重复点击复用在途任务，已完成后及重启后显式创建均生成新任务", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-create-contract-"));
  let calls = 0, restarted: DomainKnowledgeExtraction | undefined;
  const execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1] = async input => {
    calls++;
    input.save({ id: "orders", title: "订单规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/orders.md`, layer: "domain", content: "有效规则正文", sources: "固定版本源码" }, { revision: "a".repeat(40), content: null });
    return "研究完成";
  };
  const manager = new DomainKnowledgeExtraction(dir, execute);
  try {
    const first = manager.create(domainRequest, "alice");
    const repeated = manager.create({ ...domainRequest, title: "  订单域  ", scope: "  核对订单规则  ", issue_no: " REQ-WRITE " }, "alice");
    assert.equal(repeated.id, first.id, "重复点击不得生成第二个研究实体");
    await until(() => manager.get(first.id).status === "done", "领域研究未在5秒内完成");
    assert.equal(calls, 1, "重复请求不得重复调用研究执行体");
    const next = manager.create(domainRequest, "alice");
    assert.notEqual(next.id, first.id, "完成后主动发起研究不能永久返回旧任务");
    const changed = manager.create({ ...domainRequest, instructions: "只研究退款规则" }, "alice");
    const anotherPerson = manager.create(domainRequest, "bob");
    assert.notEqual(changed.id, first.id); assert.notEqual(anotherPerson.id, first.id);
    await until(() => manager.list().every(job => !["queued", "running"].includes(job.status)), "独立领域研究未在5秒内完成");
    assert.equal(manager.list().length, 4); assert.equal(calls, 4);
    await within(manager.shutdown(), "原领域管理器未在5秒内关停");
    restarted = new DomainKnowledgeExtraction(dir, execute);
    const afterRestart = restarted.create(domainRequest, "alice");
    assert.notEqual(afterRestart.id, first.id);
    await until(() => restarted!.get(afterRestart.id).status === "done", "重启后新任务未完成");
    assert.equal(calls, 5); assert.equal(restarted.list().length, 5);
    assert.equal(restarted.get(first.id).documents.length, 1, "旧任务仍独立保留");
  } finally {
    await within(manager.shutdown(), "测试原领域管理器未关停");
    if (restarted) await within(restarted.shutdown(), "测试重启领域管理器未关停");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档与资料维护保留旧任务及创建键，新研究不会覆盖其人工信息", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-create-key-drift-"));
  let calls = 0, restarted: DomainKnowledgeExtraction | undefined;
  const execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1] = async input => {
    calls++;
    input.save({ id: "orders", title: "订单规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/orders.md`, layer: "domain", content: "有效规则正文", sources: "固定版本源码" }, { revision: "a".repeat(40), content: null });
    return "研究完成";
  };
  const manager = new DomainKnowledgeExtraction(dir, execute);
  try {
    const first = manager.create(domainRequest, "alice");
    await until(() => manager.get(first.id).status === "done", "首轮研究未在5秒内完成");
    manager.configureArchive(first.id, { base_revision: 0, targets: [{ ...first.knowledge_target, repository: "https://example.test/another-knowledge.git", docs_path: "reviewed-domains" }] });
    manager.setIssueNumber(first.id, "REQ-EDITED", "人工补充关联描述");
    const materialId = `material-${randomUUID()}`, material = "补充订单规则";
    mkdirSync(join(dir, "knowledge-materials", materialId), { recursive: true });
    writeFileSync(join(dir, "knowledge-materials", materialId, "material.json"), JSON.stringify({ id: materialId, name: "订单补充.txt", scope: "本次萃取任务", version: "", bytes: Buffer.byteLength(material), digest: createHash("sha256").update(material).digest("hex"), state: "ready", sections: [{ location: "全文", text: material }] }));
    manager.run(first.id, { mode: "update", document_ids: ["orders"], message: "核对补充订单资料", material_ids: [materialId] }, "alice");
    await until(() => manager.get(first.id).status === "done", "补充资料研究未在5秒内完成");
    const another = manager.create(domainRequest, "alice");
    assert.notEqual(another.id, first.id);
    await until(() => manager.get(another.id).status === "done", "新研究未完成");
    assert.equal(calls, 3); assert.equal(manager.list().length, 2);
    await within(manager.shutdown(), "领域管理器未在5秒内关停");
    const stored = JSON.parse(readFileSync(join(dir, "domain-extraction", first.id, "job.json"), "utf8"));
    assert.equal(typeof stored.key, "string", "创建键必须耐久保存，不能按已变化的任务重新计算");
    restarted = new DomainKnowledgeExtraction(dir, execute);
    const latest = restarted.create(domainRequest, "alice");
    assert.notEqual(latest.id, first.id);
    await until(() => restarted!.get(latest.id).status === "done", "重启后新研究未完成");
    assert.equal(calls, 4); assert.equal(restarted.list().length, 3);
    assert.equal(restarted.get(first.id).issue_no, "REQ-EDITED", "重击原请求不得覆盖后续人工维护信息");
    assert.deepEqual(restarted.get(first.id).material_ids, [materialId]);
  } finally {
    await within(manager.shutdown(), "原领域管理器未在5秒内关停");
    if (restarted) await within(restarted.shutdown(), "重启领域管理器未在5秒内关停");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收13/F21：领域失败后重新创建同请求可发起新研究，边界与组件 topic start 一致", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-create-failed-"));
  let calls = 0;
  const manager = new DomainKnowledgeExtraction(dir, async () => { calls++; throw new Error("测试研究确定失败"); });
  try {
    const first = manager.create(domainRequest, "alice");
    await until(() => manager.get(first.id).status === "failed", "首个失败研究未在5秒内收口");
    const second = manager.create(domainRequest, "alice");
    assert.notEqual(second.id, first.id);
    await until(() => manager.get(second.id).status === "failed", "新研究未在5秒内收口");
    assert.equal(calls, 2); assert.equal(manager.list().length, 2);
  } finally { await within(manager.shutdown(), "失败研究管理器未在5秒内关停"); rmSync(dir, { recursive: true, force: true }); }
});

test("未配置 Git 时研究成果保留在任务，预览明确配置缺失且旧发布入口不能写正式库", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-config-"));
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    input.save({ id: "orders", title: "订单规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/orders.md`, layer: "domain", content: "有效规则正文", sources: "固定版本源码" });
    return "研究完成";
  });
  try {
    const { knowledge_target: _, ...request } = domainRequest;
    const job = manager.create(request, "alice");
    await until(() => manager.get(job.id).status === "done", "无归档配置的研究未在5秒内完成");
    assert.equal(manager.get(job.id).archive_configured, false);
    await assert.rejects(manager.publish(job.id, "alice"), /直接创建 MR/);
    assert.equal(manager.get(job.id).documents[0].published_revision, undefined);
    assert.equal(listKnowledgeDocuments(dir).length, 0);
    const preview = manager.previewArchive(job.id);
    assert.notEqual(preview.status_label, "已发布（未归档）");
    assert.deepEqual(preview.expected_revisions, { orders: "1" });
    assert.match(preview.targets[0].message, /未配置 Git 归档仓/);
    assert.equal(preview.actions[0].id, "configure");
    assert.equal([...preview.actions, ...preview.targets.flatMap(target => target.actions)].filter(action => action.label === "Git 归档设置").length, 1, "设置入口只出现一次");
    assert.equal(preview.actions[0].href, undefined, "领域任务沿用任务内归档设置，不跳到不能更改现任务目标的全局页");
  } finally { await within(manager.shutdown(), "无归档配置的管理器未在5秒内关停"); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14/F25：领域删除确认列出未完成及失败归档，保留每篇路径、MR和原因", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-domain-delete-view-"));
  let restored: DomainKnowledgeExtraction | undefined;
  const names = ["pending", "failed", "opened", "complete", "superseded"];
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    for (const id of names) input.save({ id, title: `${id}规则`, target_id: "domain", path: `domains/${id}.md`, layer: "domain", content: `${id}正文`, sources: "固定版本源码" }, { revision: "a".repeat(40), content: null });
    return "研究完成";
  });
  try {
    const original = manager.create(domainRequest, "alice");
    await until(() => manager.get(original.id).status === "done", "删除预览夹具未在5秒内研究完成");
    await within(manager.shutdown(), "删除预览夹具管理器未关停");
    const path = join(dir, "domain-extraction", original.id, "job.json"), job = JSON.parse(readFileSync(path, "utf8")) as DomainKnowledgeJob;
    const locations = { pending: "pending", failed: "failed", opened: "opened", complete: "opened", superseded: "failed" } as const;
    job.archive_batches = job.documents.map(document => {
      const formal = saveKnowledgeDocument(dir, { title: document.title, content: document.content, research_source: { job_id: job.id, document_id: document.id, repository: job.knowledge_target.repository, branch: "main", path: document.path } }, "alice");
      Object.assign(document, { knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: document.revision, published_at: formal.history.at(-1)!.at });
      const name = document.id as keyof typeof locations;
      const publications: DomainPublication[] = name === "pending" ? [] : [{ target_id: "domain", branch: `codex/${name}`, state: locations[name], url: `https://example.test/mr/${name}`, documents: [{ id: document.id, path: document.path, content: document.content, revision: document.revision, knowledge_document_id: formal.id, knowledge_revision: formal.revision }],
        ...(name === "failed" ? { error: "测试归档鉴权失败" } : {}) }];
      return { id: `batch-${name}`, created_at: new Date().toISOString(), operator: "alice", state: name === "pending" ? "pending" as const : name === "failed" ? "failed" as const : name === "superseded" ? "superseded" as const : "done" as const, error: name === "failed" ? "测试归档鉴权失败" : undefined,
        documents: [structuredClone(document)], targets: [structuredClone(job.knowledge_target)], issue_no: job.issue_no, issue_description: job.issue_description, publications };
    });
    writeFileSync(path, JSON.stringify(job));
    restored = new DomainKnowledgeExtraction(dir, async () => { throw new Error("删除预览不应开始研究"); });
    const view = restored.deletionView(job.id);
    assert.equal(view.title, job.title); assert.match(view.message, /归档/);
    assert.deepEqual(new Set(view.archive_batches.map(batch => batch.id)), new Set(["batch-pending", "batch-failed"]), "已完成和已被新版替代的批次不应重复列为删除风险");
    const failed = view.archive_batches.find(batch => batch.id === "batch-failed")!;
    assert.equal(failed.error, "测试归档鉴权失败");
    assert.deepEqual(failed.documents.map(document => [document.id, document.title, document.path]), [["failed", "failed规则", "domains/failed.md"]]);
    assert.equal(failed.publications[0].url, "https://example.test/mr/failed");
    const beforePreview = readFileSync(path, "utf8"); restored.deletionView(job.id);
    assert.equal(readFileSync(path, "utf8"), beforePreview, "查看删除确认不能改写来源或归档记录");
  } finally {
    await within(manager.shutdown(), "测试原删除预览管理器未关停");
    if (restored) await within(restored.shutdown(), "测试删除预览管理器未关停");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收14/F25：组件删除确认和删除结果明确 Git 由人决定，来源删除记录保留", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-component-delete-view-"));
  try {
    const source = { job_id: "cr-manual-decision", repository: "https://example.test/component.git", branch: "main", path: "src" };
    const archive_target = { repository: "https://example.test/archive.git", branch: "main", path: "guides/components.md" };
    const document = saveKnowledgeDocument(dir, { title: "组件知识", content: "有效组件知识正文", research_source: source, archive_target }, "alice");
    const before = componentDeletionView(dir);
    assert.match(before.git_message, /Git/); assert.match(before.git_message, /自行决定|由人决定|人工决定/);
    assert.deepEqual(before.documents.find(row => row.id === document.id)!.archive_target, archive_target, "删除确认必须展示归档位置供人判断");
    const result = await deleteComponentDocuments(dir, [{ id: document.id, revision: document.revision }], "alice", { removeFromIndex: async () => false });
    assert.equal(result.git_message, before.git_message, "删除结果继续说明 Git 处理边界");
    assert.equal(result.documents.length, 0);
    assert.equal(result.pending[0].research_job_id, source.job_id, "删除记录保留知识来源，不抹掉研究关联");
    assert.equal(result.pending[0].revision, document.revision);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14/F22：正式文稿 HTTP 正文、范围、标题与启停写入都要求当前 expected_revision", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-write-contract-"));
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  // 本例只核对正式文稿 HTTP 写入与磁盘版本；索引准备不连接外部服务。
  service.prepareKnowledgeIndex = () => {};
  const server = createTaskServer(service);
  await within(new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)), "测试 HTTP 服务未在5秒内启动");
  const base = `http://127.0.0.1:${(server.address() as any).port}/knowledge-documents`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  try {
    const saved = saveKnowledgeDocument(dir, { title: "订单规则", content: "原正文" }, "alice");
    const original = readKnowledgeDocument(dir, saved.id);
    const writes = [{ content: "覆盖正文" }, { title: "新标题" }, { active: false }, { scope: "repository", repositories: ["https://example.test/orders.git"] }, { product_versions: ["2.0"] }];
    for (const patch of writes) {
      const response = await post(`/${original.id}`, patch);
      assert.equal(response.status, 400, `${Object.keys(patch).join("/")} 不能省略正式版本`);
      assert.match((await response.json() as any).error, /当前知识版本|编辑时的知识版本|expected_revision/);
      assert.deepEqual(readKnowledgeDocument(dir, original.id), original, "缺少版本的写入不能改变正文、范围、状态或历史");
    }
    const missingRestore = await post(`/${original.id}/restore`, { revision: original.revision });
    assert.equal(missingRestore.status, 400);
    assert.deepEqual(readKnowledgeDocument(dir, original.id), original);

    const changed = await post(`/${original.id}`, { active: false, expected_revision: original.revision });
    assert.equal(changed.status, 200); const current = await changed.json() as any;
    assert.notEqual(current.revision, original.revision);
    for (const patch of writes) {
      const response = await post(`/${original.id}`, { ...patch, expected_revision: original.revision });
      assert.equal(response.status, 400, "过期正式版本不能覆盖其他人刚完成的修改");
      assert.match((await response.json() as any).error, /已有新版本/);
      assert.deepEqual(readKnowledgeDocument(dir, original.id), current);
    }
    const correct = await post(`/${original.id}`, { scope: "repository", repositories: ["https://example.test/orders.git"], expected_revision: current.revision });
    assert.equal(correct.status, 200);
    const final = readKnowledgeDocument(dir, original.id);
    assert.equal(final.content, original.content); assert.equal(final.active, false); assert.equal(final.scope, "repository");
  } finally {
    await within(service.shutdown(), "测试管理器未在5秒内关停");
    server.closeIdleConnections();
    await within(new Promise<void>(resolve => server.close(() => resolve())), "测试 HTTP 服务未在5秒内退出");
    rmSync(dir, { recursive: true, force: true });
  }
});
