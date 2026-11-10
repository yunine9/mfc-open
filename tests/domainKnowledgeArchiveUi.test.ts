import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { archiveRequest } from "../web/src/knowledgeArchiveAction.ts";
import type { KnowledgeArchivePreview } from "../src/knowledgeProductionTypes.ts";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgePublicationStatus } = await vite.ssrLoadModule("/src/DomainKnowledgePublicationStatus.tsx");
const { DomainKnowledgeArchiveTargets, DomainKnowledgeArchivePathPreview } = await vite.ssrLoadModule("/src/DomainKnowledgeArchiveTargets.tsx");
const { KnowledgeArchiveHistory } = await vite.ssrLoadModule("/src/KnowledgeArchiveDialog.tsx");
after(() => vite.close());

test("Issue488：一次归档动作使用已有单号和最新候选版本直接创建MR", () => {
  const preview: KnowledgeArchivePreview = { job_id: "dkx-488", title: "归档知识", status_label: "文稿已就绪", message: "", targets: [],
    issue_no: "DTS-488", issue_description: "归档知识", expected_revisions: { "entry": "2" },
    actions: [{ id: "create-archive", label: "创建 MR", view: "archive" }] };
  assert.deepEqual(archiveRequest(preview), { action: "create", input: { issue_no: "DTS-488", issue_description: "归档知识", expected_revisions: { "entry": "2" } } });
  assert.equal(archiveRequest({ ...preview, issue_no: " " }), undefined);
  for (const id of ["configure", "review"]) assert.equal(archiveRequest({ ...preview, actions: [{ id, label: id, view: "review" }] }), undefined);
  assert.equal(archiveRequest({ ...preview, actions: [] }), undefined, "已有MR只展示记录，不重复创建");
  assert.equal(archiveRequest({ ...preview, actions: [{ id: "replace-archive", label: "重新归档", view: "archive" }] }), undefined,
    "查看已有MR不会自动撤销，替换须点击明确动作");
  assert.deepEqual(archiveRequest({ ...preview, actions: [{ id: "retry-archive", label: "重试", view: "archive", batch_id: "original" }] }),
    { action: "retry", input: { batch_id: "original", target_id: undefined } });
});

function fixture(): DomainKnowledgeJob {
  return { id: "dkx-archive-ui", title: "订单知识", scope: "订单", module_id: "orders", operator: "alice", created_at: "2026-10-14T00:00:00Z",
    knowledge_layout: "directory-v1", repositories: [], knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "business/orders" },
    material_ids: [], status: "done", stage: "研究完成", revisions: {}, turns: [], evidence: [], publications: [],
    documents: [{ id: "entry", target_id: "domain", layer: "domain", title: "订单入口", path: "business/orders/README.md", content: "已有业务知识", sources: "代码", revision: 1, selected: true,
      base_content: null, base_revision: "", history: [] }] };
}

test("任务候选可直接创建 MR，不依赖本地发布，也不增加独立设置入口", () => {
  const job = fixture(); job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(job.production.archive.visible, true);
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact: true, onConfigure() {} }));
  assert.match(html, /创建 MR<\/button>/);
  assert.doesNotMatch(html, /确认并发布|归档路径设置/);
});

test("Issue489：旧任务展示最终仓内目录，模块ID不进入归档目录", () => {
  const job = fixture();
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /仓内相对目录/);
  assert.match(html, /确认后自动创建或更新 MR/);
  assert.match(html, />确认并创建 MR<\/button>/);
  assert.match(html, /value="business\/orders"/);
  assert.doesNotMatch(html, /先按业务模块整理目录/);
});

test("创建 MR 使用统一按钮，研究期间路径确认表单只读", () => {
  const job = fixture(); Object.assign(job.documents[0], { knowledge_document_id: "kd-order", published_revision: "formal", published_document_revision: 1 });
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  const render = () => renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact: true, onConfigure() {} }));
  assert.match(render(), /创建 MR<\/button>/);
  job.status = "running"; job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.match(render(), /创建 MR<\/button>/);
  assert.doesNotMatch(render(), /归档路径设置/);
  const settings = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, disabled: true, onChange() {} }));
  assert.match(settings, /<fieldset[^>]*disabled/);
});

test("Issue488：65篇候选且只有恢复占位批次时，详情和归档页明确显示创建MR入口", () => {
  const job = fixture(); job.knowledge_layout = "directory-v1";
  job.documents = Array.from({ length: 65 }, (_, index) => ({ ...job.documents[0], id: `doc-${index}`,
    path: `${job.knowledge_target.docs_path}/doc-${index}.md` }));
  job.archive_batches = [{ id: "recovery", created_at: job.created_at, operator: "alice", state: "pending", knowledge_layout: "directory-v1",
    documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: [] }];
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(job.production.next_action.label, "创建 MR");
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact }));
    assert.match(html, /创建 MR<\/button>/);
    assert.doesNotMatch(html, /<button[^>]*\sdisabled(?:=|\s|>)/);
    if (!compact) { assert.match(html, /创建 MR 后仍可在原任务修改/); assert.doesNotMatch(html, /平台知识已发布/); }
  }
  assert.equal(job.archive_batches.length, 1);
  assert.equal(job.archive_batches[0].issue_no, undefined, "展示入口不会自动创建MR或替人确认单号");
});

test("路径预览明确领域入口位于选定目录、代码仓根入口负责导航", () => {
  const preview = { archive_revision: 2, targets: [
    { ...fixture().knowledge_target, docs_path: "teams/orders" },
    { id: "repo-1", name: "订单服务", repository: "https://example.test/orders.git", branch: "main", path: "", docs_path: "docs/orders" },
  ], documents: [
    { id: "domain", title: "领域规则", target_id: "domain", path: "teams/orders/rules.md" },
    { id: "map", title: "模块索引", target_id: "repo-1", path: "docs/orders/module-map.md" },
  ] };
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchivePathPreview, { preview }));
  assert.match(html, /teams\/orders\/AGENTS.md/);
  assert.match(html, /docs\/orders\/module-map.md/);
  assert.match(html, /<code>AGENTS.md<\/code>/);
  assert.match(html, /aria-label="文档路径预览"/);
  assert.doesNotMatch(html, /<details/);
});

test("整理目录后保留旧失败批次的重试入口和原 MR 链接", () => {
  const job = fixture(); Object.assign(job.documents[0], { knowledge_document_id: "kd-order", published_revision: "formal", published_document_revision: 1 });
  job.archive_batches = [{ id: "old-batch", issue_no: "REQ-OLD", created_at: job.created_at, operator: "alice", state: "failed",
    documents: structuredClone(job.documents), targets: [structuredClone(job.knowledge_target)], publications: [{ target_id: "domain", branch: "codex/old", state: "failed",
      url: "https://example.test/mr/old", error: "网络中断", documents: [] }] }];
  job.knowledge_layout = "module-v1"; job.knowledge_target.docs_path = "domains/orders";
  job.documents[0].path = "domains/orders/README.md";
  const view = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(view.archive.state, "done", "旧失败批次不冒充当前版本的归档失败");
  assert.deepEqual(view.archive.batches[0].actions, [{ id: "retry-archive", label: "重试原批次", view: "archive", batch_id: "old-batch" }]);
  const html = renderToStaticMarkup(React.createElement(KnowledgeArchiveHistory, { batches: view.archive.batches, onRetry() {} }));
  assert.match(html, /REQ-OLD/); assert.match(html, />重试原批次<\/button>/);
  assert.match(html, /href="https:\/\/example.test\/mr\/old"/);
  assert.match(html, /不带入后续目录调整或未发布修改/);
});

test("Issue489：旧 UUID 和工作区仓名从预览去除，代码文稿统一进入 docs 业务目录", () => {
  const job = fixture();
  job.module_id = "module-5d312e96-7b1f-4a75-b3f4-ab4624a831ce"; job.knowledge_layout = "module-v1";
  const repo = { id: "repo-1", name: "FMProductFrontendService", repository: "https://example.test/FMProductFrontendService.git", branch: "master", path: "", docs_path: `docs/knowledge/${job.module_id}` };
  job.repositories = [repo];
  job.documents = [{ ...job.documents[0], target_id: repo.id, layer: "repository", path: `${repo.docs_path}/${repo.name}/docs/module-map.md` }];
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /value="docs\/订单知识"/);
  assert.match(html, /正在计算各文档的最终路径/);
  assert.doesNotMatch(html, /value="\."/);
  assert.doesNotMatch(html, /value="[^"]*module-5d312e96/);
});

test("修订复用同一 MR，失败与成功批次保留原链接和候选快照，合入后转为只读", () => {
  const job = fixture(), originalDocuments = structuredClone(job.documents);
  const original = { target_id: "domain", branch: "codex/original", state: "opened" as const, url: "https://example.test/mr/original", documents: originalDocuments.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
  job.documents[0].revision = 2; job.documents[0].content = "修订后的候选";
  const failed = { ...original, state: "failed" as const, error: "网络中断", documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
  job.publications = [failed];
  job.archive_batches = [
    { id: "original", created_at: job.created_at, operator: "alice", issue_no: "DTS489", state: "done", knowledge_layout: "directory-v1", documents: originalDocuments, targets: [job.knowledge_target], publications: [original] },
    { id: "revision", created_at: job.created_at, operator: "alice", issue_no: "DTS489", state: "failed", knowledge_layout: "directory-v1", documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: [failed] },
  ];
  let view = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(view.archive.state, "failed");
  const html = renderToStaticMarkup(React.createElement(KnowledgeArchiveHistory, { batches: view.archive.batches, onRetry() {} }));
  assert.match(html, /href="https:\/\/example.test\/mr\/original"/);
  assert.match(html, /网络中断/); assert.match(html, />重试原批次<\/button>/);
  assert.equal(job.archive_batches[0].documents[0].revision, 1, "修订不改写原提交的候选快照");
  job.archive_batches[1].state = "done"; job.archive_batches[1].publications[0] = { ...failed, state: "opened", error: undefined }; job.publications = job.archive_batches[1].publications;
  view = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(view.archive.state, "opened"); assert.equal(view.review.readonly, false);
  assert.equal(job.publications[0].url, original.url); assert.equal(job.publications[0].branch, original.branch);
  job.publications[0].mr_state = "merged";
  view = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(view.review.readonly, true); assert.equal(view.archive.status_label, "MR 已合入");
  assert.equal(view.archive.batches[0].publications[0].url, original.url, "合入后历史 MR 链接仍可访问");
});

test("Issue489：全部文稿调整路径尚未重发，也能打开旧失败批次重试", () => {
  const job = fixture(); job.knowledge_layout = "repository-v1";
  job.archive_batches = [{ id: "old", issue_no: "DTS489", created_at: job.created_at, operator: "alice", state: "failed",
    targets: [job.knowledge_target], documents: [], publications: [] }];
  const view = projectKnowledgeProduction({ kind: "domain", record: job, current_revisions: {} });
  assert.equal(view.archive.visible, true);
  assert.equal(view.archive.actions[0].label, "创建 MR", "当前候选与历史失败批次分别可继续提交或重试");
  assert.equal(view.archive.batches[0].actions![0].id, "retry-archive");
});

test("模块名称变化不改写任务创建时保存的领域目录，后续配置入口明确可达", () => {
  const job = fixture(); job.module_name = "产品管理"; job.title = "历史产品名称";
  job.knowledge_target.docs_path = "business/products"; job.documents[0].path = "business/products/rules.md";
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /value="business\/products"/);
  assert.match(html, /配置中心 · 领域知识目录/);
  assert.match(html, /当前任务保留原目录/);
  assert.match(html, /href="\/configuration\?tab=modules&amp;module=orders&amp;section=knowledge"/);
  assert.doesNotMatch(html, /value="docs\/产品管理"/);
});

test("Issue489 最新评论：创建 MR 路径确认中，即使暂无领域文稿也展示领域仓目录", () => {
  const job = fixture(); job.knowledge_layout = "directory-v1";
  job.module_name = "订单管理"; job.knowledge_target.docs_path = "business/orders";
  job.repositories = [{ id: "repo-1", name: "订单服务", repository: "https://example.test/orders.git", branch: "main", path: "", docs_path: "docs/orders" }];
  Object.assign(job.documents[0], { target_id: "repo-1", layer: "repository", path: "docs/orders/rules.md", knowledge_document_id: "kd-order", published_revision: "formal", published_document_revision: 1 });
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  const action = renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact: true, onConfigure() {} }));
  assert.match(action, /创建 MR<\/button>/);
  assert.doesNotMatch(action, /归档路径设置|修改归档路径/);
  const confirmation = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {}, onConfirmArchive() {} }));
  assert.match(confirmation, /aria-label="domain 归档文档目录"[^>]*value="business\/orders"/);
  assert.match(confirmation, /确认后自动创建或更新 MR/);
  assert.match(confirmation, />确认并创建 MR<\/button>/);
  assert.match(confirmation, /<button[^>]*disabled[^>]*>确认并创建 MR/, "精确路径预览完成前不允许确认");
  assert.doesNotMatch(confirmation, /保存归档路径|关闭设置后/);
});

test("精确路径预览直接显示服务端避让重名后的结果", () => {
  const job = fixture();
  const preview = { archive_revision: 3, targets: [{ ...job.knowledge_target, docs_path: "docs/orders" }], documents: [
    { id: "index-a", title: "规则入口", target_id: "domain", path: "docs/orders/index.md" },
    { id: "index-b", title: "旧入口", target_id: "domain", path: "docs/orders/index-index-b.md" },
  ] };
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchivePathPreview, { preview }));
  assert.match(html, /docs\/orders\/index.md/);
  assert.match(html, /docs\/orders\/index-index-b.md/);
  assert.doesNotMatch(html, /<details/);
});

test("已确认删除的路径预览保留原文件，不生成新的入口", () => {
  const preview = { archive_revision: 1, targets: [fixture().knowledge_target], documents: [
    { id: "deleted", title: "旧知识", target_id: "domain", path: "domain-docs/old.md" },
  ] };
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchivePathPreview, { preview, deletedDocumentIds: ["deleted"] }));
  assert.match(html, /domain-docs\/old.md/); assert.match(html, /删除原文件/);
  assert.doesNotMatch(html, /平台维护入口|AGENTS.md/);
});

test("新布局明确保存的领域目录不会再次被默认目录覆盖", () => {
  const job = fixture(); job.knowledge_layout = "directory-v1";
  for (const directory of ["domains", "domain-docs", "docs/knowledge"]) {
    job.knowledge_target.docs_path = directory;
    job.documents[0].path = `${directory}/rules.md`;
    const confirmation = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
    assert.match(confirmation, new RegExp(`aria-label="domain 归档文档目录"[^>]*value="${directory}"`));
  }
});
