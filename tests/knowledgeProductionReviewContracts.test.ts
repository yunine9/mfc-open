import assert from "node:assert/strict";
import { componentGuideContent, componentGuideEvidence, componentGuideOverview, componentGuideSection, componentGuideText } from "./fixtures/componentGuide.ts";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { listKnowledgeDocuments, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

type Item = { id: string; content: string; revision: number; selected: boolean };
type Suggestion = { turn_id: string; document_id: string; status: "pending" | "accepted" | "discarded"; base_revision: number; content: string };
type Snapshot = { status: string; documents: Item[]; suggestions: Suggestion[]; submitted_id?: string };
interface ReviewAdapter {
  read(): Snapshot;
  revise(message: string, documentId?: string): Promise<string>;
  decide(turnId: string, decision: "accept" | "discard", documentId?: string): void;
  edit(content: string, expectedRevision: number, documentId?: string): void;
  restore(revision: number, expectedRevision: number, documentId?: string): void;
  select(documentId: string, selected: boolean): void;
  submit(input?: { confirmations?: Record<string, string>; revisions?: Record<string, number> }): Promise<void>;
  delivered(): string | undefined;
  seen: Array<{ message: string; content: string }>;
  close(): Promise<void>;
}

const original = "原始规则", neighbor = "未选正文";
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label}未在5秒预算内完成`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 0));
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}未在5秒预算内完成`)), 5_000);
  })]); } finally { clearTimeout(timer); }
}
const section = (id: string, repositoryId: string, content: string) => componentGuideSection(id, [repositoryId], {
  title: id === "rules" ? "规则" : "相邻能力", content,
});

async function domainAdapter(): Promise<ReviewAdapter> {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-review-contract-domain-")), seen: ReviewAdapter["seen"] = [];
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") {
      for (const [id, content] of [["rules", original], ["neighbor", neighbor]]) input.save({ id, title: id, target_id: "domain", path: `domains/${id}.md`, layer: "domain", content, sources: "固定版本源码" });
    } else {
      const document = input.read().find(document => document.id === input.turn.document_ids[0])!;
      seen.push({ message: input.turn.message, content: document.content });
      input.save({ ...document, content: `${document.content}\n${input.turn.message}` });
      if (input.turn.message === "核对失败") throw new Error("来源核对未完成");
    }
    return "研究完成";
  }, { publish: async (job, target, previous) => ({ target_id: target.id, branch: previous?.branch || "codex/review-contract", state: "opened", url: previous?.url || "https://example.test/mr/review-contract",
    documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) }) });
  let jobId = "";
  const adapter: ReviewAdapter = {
    seen,
    read() {
      const job = manager.get(jobId);
      return { status: job.status, documents: job.documents.map(({ id, content, revision, selected }) => ({ id, content, revision, selected })),
        suggestions: job.turns.flatMap(turn => turn.proposals.map(proposal => ({ turn_id: turn.id, document_id: proposal.document.id, status: proposal.status,
          base_revision: proposal.base_revision, content: proposal.document.content }))), submitted_id: job.publications.find(publication => publication.state === "opened")?.url };
    },
    async revise(message, documentId = "rules") {
      const job = manager.run(jobId, { mode: "revise", document_ids: [documentId], message }, "reviewer"), turnId = job.turns.at(-1)!.id;
      await until(() => ["done", "failed"].includes(manager.get(jobId).turns.find(turn => turn.id === turnId)!.status), "领域修订");
      return turnId;
    },
    decide(turnId, decision, documentId = "rules") { manager.decide(jobId, turnId, documentId, decision, "reviewer"); },
    edit(content, expectedRevision, documentId = "rules") {
      const document = manager.get(jobId).documents.find(document => document.id === documentId)!;
      manager.edit(jobId, { document: { ...document, content }, base_revision: expectedRevision }, "editor");
    },
    restore(revision, expectedRevision, documentId = "rules") { manager.restore(jobId, documentId, revision, expectedRevision, "editor"); },
    select(documentId, selected) { manager.select(jobId, [documentId], selected); },
    async submit(input = {}) {
      for (const [documentId, turnId] of Object.entries(input.confirmations ?? {})) manager.decide(jobId, turnId, documentId, "accept", "publisher");
      const preview = manager.previewArchive(jobId);
      await manager.createArchive(jobId, { issue_no: "REQ-REVIEW-CONTRACT", expected_revisions: { ...preview.expected_revisions,
        ...Object.fromEntries(Object.entries(input.revisions ?? {}).map(([id, revision]) => [id, String(revision)])) } }, "publisher");
      assert.deepEqual(listKnowledgeDocuments(dir), [], "领域 MR 提交不提前更新正式知识库");
    },
    delivered() { const publications = manager.get(jobId).publications.filter(publication => publication.state === "opened"); return publications.length ? publications.flatMap(publication => publication.documents.map(document => document.content)).join("\n") : undefined; },
    async close() { await bounded(manager.shutdown(), "领域管理器关停"); rmSync(dir, { recursive: true, force: true }); },
  };
  try {
    const job = manager.create({ title: "审阅契约", scope: "规则和相邻能力", issue_no: "REQ-REVIEW-CONTRACT", repositories: [],
      knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "researcher");
    jobId = job.id; await until(() => manager.get(jobId).status === "done", "领域初始研究"); return adapter;
  } catch (error) { await adapter.close(); throw error; }
}

async function componentAdapter(): Promise<ReviewAdapter> {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-review-contract-component-")), seen: ReviewAdapter["seen"] = [];
  seedTechnologyStacks(dir, ["cpp"]);
  const repository = saveComponentRepository(dir, { name: "规则库", repository: "https://example.test/rules.git", branch: "main", path: "src", languages: ["cpp"] }, "researcher");
  const manager = new ComponentResearch(dir, async input => {
    if (!input.review) {
      for (const event of componentGuideEvidence("cpp", [repository.id])) input.evidence(event);
      input.editDocument!({ action: "overview", overview: componentGuideOverview("规则与相邻能力的使用说明。") });
      input.editDocument!({ action: "outline", entries: [section("rules", repository.id, original), section("neighbor", repository.id, neighbor)].map(({ id, title, repository_ids }) => ({ id, title, repository_ids })) });
      input.editDocument!({ action: "section", section: section("rules", repository.id, original) });
      input.editDocument!({ action: "section", section: section("neighbor", repository.id, neighbor) });
    } else {
      const current = input.readDocument!().sections.find(section => section.id === input.review!.section_id)!;
      seen.push({ message: input.review.message, content: componentGuideText(current.content) });
      input.editDocument!({ action: "section", section: { ...current, content: `${current.content}\n${input.review.message}` } });
      if (input.review.message === "核对失败") throw new Error("来源核对未完成");
    }
    return "研究完成";
  });
  let jobId = "";
  const adapter: ReviewAdapter = {
    seen,
    read() {
      const record = manager.get(jobId);
      return { status: record.status, documents: record.document!.sections.map(({ id, content, revision, selected }) => ({ id, content: componentGuideText(content), revision, selected })),
        suggestions: (record.review_turns ?? []).flatMap(turn => turn.proposal ? [{ turn_id: turn.id, document_id: turn.section_id, status: turn.proposal.status,
          base_revision: turn.proposal.base_revision, content: componentGuideText(turn.proposal.section.content) }] : []), submitted_id: record.document_id };
    },
    async revise(message, documentId = "rules") {
      const record = manager.review(jobId, { section_id: documentId, mode: "rework", message }, "reviewer"), turnId = record.review_turns!.at(-1)!.id;
      await until(() => ["done", "failed"].includes(manager.get(jobId).review_turns!.find(turn => turn.id === turnId)!.status), "组件修订");
      return turnId;
    },
    decide(turnId, decision) { manager.decideProposal(jobId, turnId, decision, "reviewer"); },
    edit(content, expectedRevision, documentId = "rules") {
      const section = manager.get(jobId).document!.sections.find(section => section.id === documentId)!;
      manager.editSection(jobId, { section: { ...section, content: componentGuideContent(content) }, base_revision: expectedRevision }, "editor");
    },
    restore(revision, expectedRevision, documentId = "rules") { manager.restoreSection(jobId, documentId, revision, expectedRevision, "editor"); },
    select(documentId, selected) { manager.selectSections(jobId, [documentId], selected); },
    async submit(input = {}) {
      const record = manager.get(jobId);
      manager.publish(jobId, { title: record.topic, document_id: record.document_id ?? null, update_document_id: record.update_document_id ?? null,
        update_document_revision: record.update_document_revision,
        sections: record.document!.sections.filter(section => section.selected).map(section => ({ id: section.id,
          revision: input.revisions?.[section.id] ?? section.revision, proposal_id: input.confirmations?.[section.id] ?? null })) }, "publisher");
    },
    delivered() { const id = adapter.read().submitted_id; return id ? readKnowledgeDocument(dir, id).content : undefined; },
    async close() { await bounded(manager.shutdown(), "组件管理器关停"); rmSync(dir, { recursive: true, force: true }); },
  };
  try {
    const record = manager.start({ repository_ids: [repository.id], language: "cpp" }, "researcher");
    jobId = record.id; await until(() => manager.get(jobId).status === "done", "组件初始研究"); return adapter;
  } catch (error) { await adapter.close(); throw error; }
}

const factories = [{ name: "领域", create: domainAdapter }, { name: "组件", create: componentAdapter }];
for (const factory of factories) {
  const contract = (name: string, run: (adapter: ReviewAdapter) => Promise<void>) => test(`B5验收1/生产线验收14（${factory.name}）：${name}`, { timeout: 20_000 }, async () => {
    const adapter = await factory.create(); try { await run(adapter); } finally { await adapter.close(); }
  });

  contract("只接受最新建议，旧建议确认失败不改正文；明确确认最新建议后提交对应版本", async adapter => {
    const old = await adapter.revise("第一份建议"), latest = await adapter.revise("最新建议");
    const before = adapter.read();
    assert.throws(() => adapter.decide(old, "accept"), /更新的修改建议/);
    assert.deepEqual(adapter.read(), before, "拒绝旧建议必须保留正文与所有待确认建议");
    await assert.rejects(adapter.submit({ confirmations: { rules: old } }), /更新的修改建议|建议已有变化/);
    assert.deepEqual(adapter.read(), before); assert.equal(adapter.delivered(), undefined);
    await adapter.submit({ confirmations: { rules: latest } });
    assert.ok(adapter.read().submitted_id); assert.match(adapter.delivered()!, /原始规则\n第一份建议\n最新建议/);
    assert.deepEqual(adapter.read().suggestions.map(suggestion => suggestion.status), ["discarded", "accepted"]);
  });

  contract("人工保存改变基线后旧建议不能采纳或发布，保留新正文和待确认建议", async adapter => {
    const turn = await adapter.revise("旧基线建议");
    adapter.edit("人工最新正文", 1); const before = adapter.read();
    assert.throws(() => adapter.decide(turn, "accept"), /新版本/);
    await assert.rejects(adapter.submit({ confirmations: { rules: turn } }), /新版本|基线冲突/);
    assert.deepEqual(adapter.read(), before); assert.equal(adapter.delivered(), undefined);
    assert.equal(before.documents[0].content, "人工最新正文"); assert.equal(before.suggestions[0].status, "pending");
  });

  contract("未选文稿的建议不阻塞其他文稿，组件选中修改仍需明确确认", async adapter => {
    await adapter.revise("尚未确认的修改"); const before = adapter.read();
    if (factory.name === "组件") {
      await assert.rejects(adapter.submit(), /尚未确认的修改|建议已有变化/);
      assert.deepEqual(adapter.read(), before); assert.equal(adapter.delivered(), undefined);
    }
    adapter.select("rules", false); await adapter.submit();
    assert.ok(adapter.read().submitted_id); assert.match(adapter.delivered()!, /未选正文/); assert.doesNotMatch(adapter.delivered()!, /尚未确认的修改/);
    assert.equal(adapter.read().suggestions[0].status, "pending", "其他文稿发布不能替人解决未选文稿的建议");
  });

  contract("连续修订接着同基线最新候选修改，原稿保持不变直到人工确认", async adapter => {
    const before = adapter.read().documents;
    await adapter.revise("第一轮边界"); const latest = await adapter.revise("第二轮示例");
    assert.deepEqual(adapter.seen, [{ message: "第一轮边界", content: original }, { message: "第二轮示例", content: "原始规则\n第一轮边界" }]);
    assert.deepEqual(adapter.read().documents, before);
    assert.equal(adapter.read().suggestions.at(-1)!.base_revision, 1);
    await adapter.submit({ confirmations: { rules: latest } });
    assert.equal(adapter.read().documents[0].content, "原始规则\n第一轮边界\n第二轮示例"); assert.equal(adapter.read().documents[0].revision, 2);
  });

  contract("正文版本变化后修订从人工新稿开始，不能接续过期候选覆盖人工内容", async adapter => {
    await adapter.revise("过期候选"); adapter.edit("人工最新正文", 1);
    const latest = await adapter.revise("核对最新正文");
    assert.deepEqual(adapter.seen.at(-1), { message: "核对最新正文", content: "人工最新正文" });
    assert.equal(adapter.read().suggestions.at(-1)!.base_revision, 2); assert.equal(adapter.read().documents[0].content, "人工最新正文");
    await adapter.submit({ confirmations: { rules: latest } });
    assert.equal(adapter.read().documents[0].content, "人工最新正文\n核对最新正文"); assert.equal(adapter.read().documents[0].revision, 3);
  });

  contract("编辑恢复和提交均受乐观版本锁保护，冲突不改正文或生成交付记录", async adapter => {
    adapter.edit("人工保存", 1); const edited = adapter.read();
    assert.throws(() => adapter.edit("旧页面覆盖", 1), /新版本/); assert.deepEqual(adapter.read(), edited);
    assert.throws(() => adapter.restore(1, 1), /新版本/); assert.deepEqual(adapter.read(), edited);
    adapter.restore(1, 2); assert.equal(adapter.read().documents[0].content, original); assert.equal(adapter.read().documents[0].revision, 3);
    const restored = adapter.read();
    await assert.rejects(adapter.submit({ revisions: { rules: 2 } }), /版本/);
    assert.deepEqual(adapter.read(), restored); assert.equal(adapter.delivered(), undefined);
    await adapter.submit(); assert.ok(adapter.read().submitted_id);
  });

  contract("失败回合的部分建议不能采纳，后续完整修订不会接续失败的半稿", async adapter => {
    const failed = await adapter.revise("核对失败"); assert.equal(adapter.read().status, "failed");
    assert.throws(() => adapter.decide(failed, "accept"), /尚未完成|尚未完成独立评审/);
    assert.equal(adapter.read().documents[0].content, original); assert.equal(adapter.delivered(), undefined);
    const latest = await adapter.revise("完整核对");
    assert.deepEqual(adapter.seen.at(-1), { message: "完整核对", content: original });
    await adapter.submit({ confirmations: { rules: latest } });
    assert.match(adapter.delivered()!, /原始规则\n完整核对/); assert.doesNotMatch(adapter.delivered()!, /核对失败/);
  });
}
