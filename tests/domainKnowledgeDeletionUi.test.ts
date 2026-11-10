import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { domainPublicationInput, domainReviewDocument } from "../web/src/domainKnowledgePublication.ts";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgeDeletionNotice } = await vite.ssrLoadModule("/src/DomainKnowledgeExtraction.tsx");
const { DomainKnowledgeFileTree } = await vite.ssrLoadModule("/src/DomainKnowledgeFileTree.tsx");
after(() => vite.close());

function fixture(confirmed = false, mixed = false): DomainKnowledgeJob {
  const removed = { id: "old-rules", title: "旧规则", target_id: "domain", path: "domains/old-rules.md", layer: "domain",
    content: "# 旧规则\n\n原正文继续保留用于删除审查。", sources: "原证据", revision: 2, selected: true, deleted: true,
    base_content: "# 旧规则", base_revision: "source-sha", history: [], knowledge_document_id: "kd-old",
    published_revision: confirmed ? "tombstone-sha" : "original-sha", published_document_revision: confirmed ? 2 : 1 };
  const record = { id: "dkx-delete-review", title: "知识调整", scope: "规则", status: "done", documents: [removed], turns: [],
    repositories: [], publications: [], archive_batches: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs" },
  } as unknown as DomainKnowledgeJob;
  if (mixed) record.documents.push({ ...record.documents[0], id: "current-rules", path: "domains/current-rules.md", deleted: false,
    knowledge_document_id: "kd-current", published_revision: "current-sha", published_document_revision: 2 });
  record.production = projectKnowledgeProduction({ kind: "domain", record,
    current_revisions: { "kd-old": removed.published_revision, ...(mixed ? { "kd-current": "current-sha" } : {}) } });
  return record;
}
function tree(job: DomainKnowledgeJob) {
  return renderToStaticMarkup(React.createElement(DomainKnowledgeFileTree, { job,
    onNavigate() {}, onSelection() {}, onSelections() {} }));
}

test("待删除文稿直接进入 MR，目录明确标记并保留原正文", () => {
  const job = fixture();
  assert.equal(job.production!.documents[0].changed, true);
  assert.equal(job.production!.documents[0].status_label, "待删除");
  assert.ok(job.production!.archive.actions.some(action => action.id === "archive"));
  assert.ok(!job.production!.research_actions.some(action => action.id === "publish"));
  assert.deepEqual(domainPublicationInput(job), { document_ids: ["old-rules"], expected_revisions: { "old-rules": 2 } });
  assert.match(tree(job), /待删除/);
  assert.match(tree(job), /aria-label="确认删除 domains\/old-rules\.md"/);
  const notice = renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { deleted: true, pending: true }));
  assert.match(notice, /知识文稿待删除/);
  assert.match(notice, /MR 合入并同步后从正式知识库移除/);
  assert.match(notice, /保留原正文供检视/);
  assert.doesNotMatch(notice, /<button|<input|删除任务/);
  assert.equal(job.documents[0].content, "# 旧规则\n\n原正文继续保留用于删除审查。");
});

test("旧平台发布标记不代表远端删除已合入，仍保留任务修改和 MR 入口", () => {
  const job = fixture(true);
  assert.equal(job.production!.documents[0].changed, true);
  assert.equal(job.production!.documents[0].status_label, "待删除");
  assert.deepEqual(domainPublicationInput(job).document_ids, ["old-rules"]);
  assert.match(tree(job), /待删除/);
  assert.equal(job.production!.review.readonly, false);
  assert.ok(job.production!.archive.actions.some(action => action.id === "archive"));
  assert.doesNotMatch(job.production!.archive.message, /平台立即可读|知识已发布/);
  const notice = renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { deleted: true, pending: false }));
  assert.match(notice, /知识文稿已删除/);
  assert.match(notice, /保留原正文供追溯/);
  assert.doesNotMatch(notice, /<button|<input|删除任务/);
});

test("正文与删除都保留在任务中，MR 合入前正式知识不改变", () => {
  const job = fixture(true, true);
  assert.match(job.production!.archive.title, /2 份任务文稿/);
  assert.match(job.production!.archive.message, /创建 MR 后仍可在原任务修改/);
  assert.doesNotMatch(job.production!.archive.title, /平台立即可读/);
  assert.equal(renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { pending: false })), "");
});


for (const state of ["done", "running", "failed", "conflict"] as const) test(`历史删除后重新保存候选：${state}，正文、目录与删除状态一致`, () => {
  const job = fixture();
  const original = structuredClone(job.documents[0]);
  job.turns = [{ id: "restore", mode: "revise", document_ids: [original.id], message: "保留并补充正文", operator: "reviewer", created_at: "2026-10-26T00:00:00Z",
    status: state === "conflict" ? "done" : state, proposals: [{ status: "pending", base_revision: state === "conflict" ? original.revision - 1 : original.revision,
      document: { id: original.id, title: "保留的规则", path: "docs/rules.md", target_id: original.target_id, layer: original.layer, content: "# 保留的规则", sources: "当前证据" } }] }];
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  const preview = domainReviewDocument(job, job.documents[0]);
  const restored = state === "done";
  assert.equal(preview.deleted, !restored);
  assert.equal(job.production.documents[0].status_label, restored ? "任务文稿" : "待删除");
  assert.equal(preview.content, restored ? "# 保留的规则" : original.content);
  const html = tree(job);
  assert.match(html, restored ? /发布 docs\/rules.md/ : /确认删除 domains\/old-rules.md/);
  const notice = renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { deleted: preview.deleted, pending: true }));
  assert.equal(notice.includes("知识文稿待删除"), !restored);
  assert.deepEqual(job.documents[0], original, "预览不提前接受候选或覆盖历史删除基线");
});
