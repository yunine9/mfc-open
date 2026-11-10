import { projectKnowledgeProduction } from "../../src/knowledgeProductionState.ts";
import { domainKnowledgeTask } from "../../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes.ts";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../../src/domainKnowledgeExtraction.ts";
import { saveKnowledgeDocument } from "../../src/knowledgeDocuments.ts";

/** 外层 Node 测试生成 HTTP 响应；浏览器只接收 JSON，不导入后端模块。 */
export async function knowledgeLibraryProductionFixtures() {
  const repository = { id: "orders", name: "订单服务", repository: "https://example.test/orders.git", branch: "master", path: "", docs_path: "docs/business" };
  const job: DomainKnowledgeJob = { id: "dkx-00000000-0000-4000-8000-000000000001", module_id: "trade", title: "交易规则更新", scope: "订单取消与回补", issue_no: "REQ-447", issue_description: "核对订单取消与回补规则", operator: "dev", created_at: "2026-09-30T01:00:00Z", repositories: [repository], knowledge_target: { ...repository, id: "domain", name: "领域模块知识", repository: "https://example.test/knowledge.git" }, material_ids: [], status: "done", stage: "待审查", revisions: {}, turns: [], publications: [], evidence: [], documents: [
    { id: "states", title: "订单状态规则", target_id: "domain", path: "docs/business/states.md", layer: "domain", content: "# 订单状态规则\n\n取消前核对发货状态。", sources: "业务规格（测试夹具）", revision: 2, selected: true, base_content: null, base_revision: "fixture", history: [] },
    { id: "integration", title: "订单服务职责", target_id: "orders", path: "docs/business/integration.md", layer: "repository", content: "# 订单服务职责\n\n库存回补需要幂等。", sources: "订单接口（测试夹具）", revision: 1, selected: true, base_content: null, base_revision: "fixture", history: [] },
    { id: "unchanged", title: "现行交易规则", target_id: "domain", path: "docs/business/current.md", layer: "domain", content: "# 现行交易规则\n\n当前正式知识仍可使用。", sources: "正式基线", revision: 1, selected: true, published_document_revision: 1, published_revision: "formal-1", knowledge_document_id: "kd-current", base_content: null, base_revision: "fixture", history: [] },
  ] };
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-library-production-"));
  let manager: DomainKnowledgeExtraction | undefined;
  try {
  const formal = job.documents.map(document => saveKnowledgeDocument(dir, { title: document.title, content: document.content }, "dev"));
  Object.assign(job.documents[2], { knowledge_document_id: formal[2].id, published_revision: formal[2].revision });
  const running: DomainKnowledgeJob = { ...structuredClone(job), id: "dkx-00000000-0000-4000-8000-000000000002", title: "支付规则研究中", status: "running", stage: "正在核对源码", documents: [], evidence: [{ tool: "research_note", preview: "正在核对退款与取消的边界。", status: "returned" }] };
  const created: DomainKnowledgeJob = { ...structuredClone(running), id: "dkx-00000000-0000-4000-8000-000000000003", title: "告警管理研究", module_id: "alarm" };
  const initial = projectKnowledgeProduction({ kind: "domain", record: job });
  const noneJob = structuredClone(job);
  noneJob.documents.filter(document => initial.documents.find(item => item.id === document.id)?.changed).forEach(document => { document.selected = false; });
  const publishedJob = structuredClone(job);
  for (const [index, document] of publishedJob.documents.entries()) Object.assign(document, { knowledge_document_id: formal[index].id, published_document_revision: document.revision, published_revision: formal[index].revision });
  const folder = join(dir, "domain-extraction", publishedJob.id); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(join(folder, "job.json"), JSON.stringify(publishedJob));
  manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("浏览器夹具不运行研究"); }, { publish: async (archive, target) => ({ target_id: target.id,
    branch: "codex/knowledge-fixture", state: "opened", mr_id: target.id === "domain" ? 1 : 2, url: `https://example.test/mr/${target.id === "domain" ? 1 : 2}`,
    documents: archive.documents.filter(document => document.target_id === target.id).map(document => ({ id: document.id, path: document.path, content: document.content,
      revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) }) });
  const archivePreview = manager.previewArchive(publishedJob.id);
  const archivedPreview = await manager.createArchive(publishedJob.id, { issue_no: job.issue_no!, issue_description: job.issue_description, expected_revisions: archivePreview.expected_revisions }, "dev");
  const openedJob = manager.get(publishedJob.id);
  job.production = initial;
  running.production = projectKnowledgeProduction({ kind: "domain", record: running });
  created.production = projectKnowledgeProduction({ kind: "domain", record: created });
  return { job, running, created, publishedJob, openedJob, archivePreview, archivedPreview, taskRows: Object.fromEntries([job, running, created].map(record => [record.id, domainKnowledgeTask(record)])),
    projections: { initial, none: projectKnowledgeProduction({ kind: "domain", record: noneJob }),
      published: projectKnowledgeProduction({ kind: "domain", record: publishedJob }), opened: openedJob.production } };
  } finally { await manager?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
}
