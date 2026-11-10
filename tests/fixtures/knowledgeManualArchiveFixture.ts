import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../../src/domainKnowledgeExtraction.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../../src/componentResearch.ts";
import { saveKnowledgeDocument } from "../../src/knowledgeDocuments.ts";
import { projectKnowledgeProduction } from "../../src/knowledgeProductionState.ts";
import { seedTechnologyStacks } from "./technologyStacks.ts";

/** 浏览器收到真实管理器的文案与动作，不在夹具里复制状态机。 */
export async function knowledgeManualArchiveFixtures() {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-manual-archive-fixture-"));
  seedTechnologyStacks(dir, ["cpp"]);
  const component = { id: "file", name: "文件组件", repository: "https://example.test/file.git", branch: "main", path: "src", languages: ["cpp"], description: "文件句柄", enabled: true };
  const target = { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs" };
  const sourceTarget = { ...target, id: "source", name: "业务仓", repository: "https://example.test/business.git", docs_path: "docs/business" };
  try {
    const guide = saveKnowledgeDocument(dir, { title: "正式组件指引", content: '---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: []\n---\n\n# 正式组件指引\n\n先停止回调，再释放句柄。', technologies: ["cpp"] }, "alice");
    const business = saveKnowledgeDocument(dir, { title: "正式业务规则", content: "# 正式业务规则\n\n订单取消后保留审计记录。" }, "alice");
    const local = saveKnowledgeDocument(dir, { title: "正式仓内说明", content: "# 正式仓内说明\n\n调用方处理超时。" }, "alice");
    const nextGuide = saveKnowledgeDocument(dir, { title: "新任务的正式组件指引", content: '---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: []\n---\n\n# 新任务的正式组件指引\n\n新任务已审查的正式正文。', technologies: ["cpp"] }, "alice");
    const base = { id: "dkx-00000000-0000-4000-8000-000000000001", title: "知识手动归档", scope: "知识生产", operator: "alice", created_at: "2026-10-03T00:00:00Z",
      status: "done" as const, stage: "已入库", issue_no: "REQ-MANUAL", issue_description: "保存已审查的正式知识版本", revisions: {}, material_ids: [], knowledge_target: target, repositories: [], archive_configured: true, turns: [], evidence: [], publications: [], archive_batches: [] };
    const doc = (formal: typeof guide, id: string, targetId: string, path: string) => ({ id, title: formal.title, target_id: targetId, path, layer: "domain" as const,
      content: "尚未发布的新草稿，不能出现在归档弹窗", sources: "src/file.cpp", revision: 2, selected: false, history: [], base_content: null, base_revision: "",
      knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 });
    const componentRecord = { id: "cr-00000000-0000-4000-8000-000000000001", key: "manual-browser", topic: "文件组件知识", language: "cpp", mode: "all", operator: "alice", status: "done", stage: "已入库",
      created_at: base.created_at, component, components: [component], evidence: [], document_id: guide.id, published_revision: guide.revision, draft: "待发布草稿" } as ResearchRecord;
    async function project(job: DomainKnowledgeJob) {
      const folder = join(dir, "domain-extraction", job.id); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(join(folder, "job.json"), JSON.stringify(job));
      const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("浏览器夹具不运行模型"); });
      try {
        const preview = manager.previewArchive(job.id), projected = manager.get(job.id);
        return { preview, job: projected, record: { ...componentRecord, production: projectKnowledgeProduction({ kind: "component", record: componentRecord, archive: projected }) } };
      } finally { await manager.shutdown(); }
    }
    const componentJob: DomainKnowledgeJob = { ...base, component_research_id: componentRecord.id, documents: [doc(guide, "guide", "domain", "docs/guide.md")] };
    const componentReady = await project(componentJob);
    const nextRecord = { ...componentRecord, id: "cr-00000000-0000-4000-8000-000000000002", topic: "另一个组件任务", document_id: nextGuide.id, published_revision: nextGuide.revision };
    const componentNextReady = await project({ ...componentJob, id: "dkx-00000000-0000-4000-8000-000000000003", component_research_id: nextRecord.id,
      title: nextRecord.topic, documents: [doc(nextGuide, "next-guide", "domain", "docs/next-guide.md")] });
    componentNextReady.record = { ...nextRecord, production: projectKnowledgeProduction({ kind: "component", record: nextRecord, archive: componentNextReady.job }) };
    const componentNextUnpublished = { ...nextRecord, document_id: undefined, published_revision: undefined };
    const componentUnpublished = { ...componentNextUnpublished, production: projectKnowledgeProduction({ kind: "component", record: componentNextUnpublished }) };
    const unconfigured = await project({ ...componentJob, knowledge_target: { ...target, repository: "" }, archive_configured: false });
    const domainJob: DomainKnowledgeJob = { ...base, documents: [doc(business, "rules", "domain", "docs/rules.md"), doc(local, "local", "source", "docs/business/local.md")], repositories: [sourceTarget] };
    const domainReady = await project(domainJob);
    const domainNext = await project({ ...domainJob, id: "dkx-00000000-0000-4000-8000-000000000002", title: "另一个任务的正式知识" });
    const receipts: DomainPublication[] = [target, sourceTarget].map((repository, index) => ({ target_id: repository.id, state: index ? "opened" as const : "failed" as const,
      branch: `codex/manual-${repository.id}`, ...(index ? { url: "https://example.test/mr/business", mr_id: 2 } : { error: "Git 网络暂时中断，请重试此仓归档。" }),
      documents: domainJob.documents.filter(document => document.target_id === repository.id).map(document => ({ id: document.id, path: document.path,
        content: document.target_id === "domain" ? business.content : local.content, revision: 1, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) }));
    const partialJob = { ...domainJob, publications: receipts, archive_batches: [{ id: "batch-manual", created_at: base.created_at, operator: "alice", state: "failed" as const,
      documents: domainJob.documents.map(document => ({ ...document, content: document.target_id === "domain" ? business.content : local.content, revision: 1 })), targets: [target, sourceTarget], issue_no: base.issue_no, issue_description: base.issue_description, publications: receipts }] };
    const partial = await project(partialJob);
    const doneReceipts = receipts.map(receipt => ({ ...receipt, state: "opened" as const, error: undefined, url: receipt.url ?? "https://example.test/mr/knowledge", mr_id: receipt.mr_id ?? 1 }));
    const completed = await project({ ...partialJob, publications: doneReceipts, archive_batches: [{ ...partialJob.archive_batches[0], state: "done", publications: doneReceipts }] });
    const domainNextCompleted = await project({ ...completed.job, id: domainNext.job.id, title: domainNext.job.title });
    return { componentReady, unconfigured, domainReady, partial, completed, domainNext, domainNextCompleted, componentNextReady, componentUnpublished };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
