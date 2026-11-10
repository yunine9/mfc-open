import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

import { domainReviewDocuments } from "../web/src/domainKnowledgePublication.ts";
import { resolveKnowledgeReference } from "../web/src/knowledgeStructure.ts";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgeFileTree } = await vite.ssrLoadModule("/src/DomainKnowledgeFileTree.tsx");
const { DomainKnowledgePathChange } = await vite.ssrLoadModule("/src/DomainKnowledgeExtraction.tsx");
after(() => vite.close());

function render(originalPath: string, proposedPath: string) {
  return renderToStaticMarkup(React.createElement(DomainKnowledgePathChange, { originalPath, proposedPath }));
}

test("领域知识改名建议完整展示原路径与建议路径，沿用现有处置流程", () => {
  const html = render("domains/order.md", "domains/order-rules.md");
  assert.match(html, /aria-label="文档路径修改建议"/);
  assert.match(html, /原路径：<code[^>]*>domains\/order\.md<\/code>/);
  assert.match(html, /→/);
  assert.match(html, /建议路径：<code[^>]*>domains\/order-rules\.md<\/code>/);
  assert.doesNotMatch(html, /<button|<input|<textarea/);
});

test("路径未变化时不增加修改提示", () => {
  assert.equal(render("domains/order.md", "domains/order.md"), "");
});

test("嵌套中文路径完整显示，路径字符作为文本安全呈现", () => {
  const html = render("domains/订单/历史/旧规则.md", "domains/订单/最新/规则与边界&例外<说明>.md");
  assert.match(html, /domains\/订单\/历史\/旧规则\.md/);
  assert.match(html, /domains\/订单\/最新\/规则与边界&amp;例外&lt;说明&gt;\.md/);
  assert.doesNotMatch(html, /line-clamp|展开|<说明>/);
});


test("#552 文件树直接显示完成修订的新文件名与标题，未创建 MR 也能核对", () => {
  const job = { knowledge_target: { id: "domain", name: "领域知识" }, repositories: [],
    documents: [{ id: "interface", target_id: "domain", path: "interfaces/repo5-repo4.md", title: "旧代号", revision: 3, selected: true }],
    turns: [{ id: "revision", status: "done", proposals: [{ status: "pending", base_revision: 3, document: { id: "interface", target_id: "domain", path: "interfaces/SONEngine-SONService.md", title: "SONEngine 与 SONService" } }] }],
    production: { documents: [{ id: "interface", changed: true, status_label: "待创建 MR" }] } };
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeFileTree, { job, onNavigate() {}, onSelection() {} }));
  assert.match(html, /SONEngine-SONService.md/);
  assert.match(html, /SONEngine 与 SONService/);
  assert.doesNotMatch(html, /repo5-repo4|旧代号/);
  assert.equal(job.documents[0].path, "interfaces/repo5-repo4.md");
  const preview = domainReviewDocuments(job as any);
  assert.equal(resolveKnowledgeReference(preview, { ...preview[0], path: "README.md" }, "interfaces/SONEngine-SONService.md")?.item.id, "interface");
  job.production.documents[0] = { ...job.production.documents[0], proposal_problem: "当前修订尚未完成" } as any;
  assert.equal(domainReviewDocuments(job as any)[0].path, job.documents[0].path);
});
