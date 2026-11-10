import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, knowledgeIssueDescription, type DomainExecution, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { runGenericDomainKnowledge as runDomainKnowledge } from "./helpers/extractionSkillFixture.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";
import { listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";

const config = { issue_no: "REQ-knowledge-123", title: "订单", scope: "状态与取消规则", repositories: [{ name: "交易仓", repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/business" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/orders" } };
const document = { id: "states", title: "订单状态", target_id: "domain", path: "domains/orders/states.md", layer: "domain" as const, content: "# 订单\n原始规则", sources: "repo-1 / src/state.ts @ 123" };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("任务未完成"); }
function extract(input: DomainExecution) { input.save(document, { content: null, revision: "a".repeat(40) }); return "草稿已保存"; }

test("工作草稿持续修正，手动重试保留原轮次；人工修改不能被 Agent 覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-working-draft-")); let first = true, turnId = "";
  const service = new DomainKnowledgeExtraction(dir, async input => {
    assert.equal(input.job.instructions, "只研究订单取消；不要读取 legacy/payment.ts");
    if (first) {
      first = false; turnId = input.turn.id; extract(input);
      input.save({ ...document, content: "补证后修正" });
      await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    } else {
      assert.equal(input.turn.id, turnId);
      input.save({ ...document, content: "Agent 新建议" });
      assert.equal(input.read()[0].content, "Agent 新建议", "可继续处理人工文稿，结果仍等待审阅");
    }
    return "研究结束";
  });
  try {
    const job = service.create({ ...config, instructions: "只研究订单取消；不要读取 legacy/payment.ts" }, "expert"); await until(() => service.get(job.id).documents[0]?.revision === 2);
    service.stop(job.id); await new Promise(resolve => setTimeout(resolve, 20));
    service.edit(job.id, { document: { ...document, content: "人工修改" }, base_revision: 2 }, "editor");
    service.resume(job.id, "expert"); await until(() => service.get(job.id).status === "done");
    assert.equal(service.get(job.id).turns.length, 1); assert.equal(service.get(job.id).documents[0].content, "人工修改");
    assert.equal(service.get(job.id).turns[0].proposals[0].document.content, "Agent 新建议");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14（F23）：研究中拒绝编辑，结束后的人工修改仍受版本冲突、恢复与重启保护", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-extraction-"));
  let release: () => void = () => {};
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    if (input.turn.mode === "discuss") { assert.throws(() => input.save(document), /讨论/); return "只回答问题"; }
    await new Promise<void>(resolve => release = resolve);
    input.save({ ...document, content: "AI 修订" }); return "建议已保存";
  });
  try {
    for (const issue_no of [undefined, "", "  ", "REQ-1,REQ-2", "REQ-1\nREQ-2", "x".repeat(121)]) assert.throws(() => service.create({ ...config, issue_no }, "expert"), /关联单号/);
    for (const instructions of [123, {}, "x".repeat(20001)]) assert.throws(() => service.create({ ...config, instructions }, "expert"), /本次要求/);
    for (const issue_description of [null, 123, {}, "", "  ", "第一行\n第二行", "x".repeat(2001)]) assert.throws(() => service.create({ ...config, issue_description }, "expert"), /描述/);
    const job = service.create({ ...config, issue_no: "  REQ-knowledge-123  ", issue_description: "  支持订单取消与状态核对  ", instructions: "只说明取消条件\n不要读取 legacy/payment.ts" }, "expert");
    assert.equal(job.issue_no, "REQ-knowledge-123");
    assert.equal(job.issue_description, "支持订单取消与状态核对");
    assert.equal(service.setIssueNumber(job.id, "REQ-another").issue_description, undefined, "更改单号不沿用旧单据描述");
    assert.equal(service.setIssueNumber(job.id, config.issue_no, "支持订单取消与状态核对").issue_description, "支持订单取消与状态核对");
    await until(() => service.get(job.id).status === "done");
    service.run(job.id, { mode: "discuss", document_ids: [document.id], message: "依据是什么" }, "expert");
    await until(() => service.get(job.id).status === "done");
    assert.equal(service.get(job.id).documents[0].revision, 1);
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "核对取消" }, "expert");
    await until(() => service.get(job.id).status === "running"); await new Promise(resolve => setTimeout(resolve, 5));
    assert.throws(() => service.edit(job.id, { document: { ...document, content: "人工修订" }, base_revision: 1 }, "editor"), /研究进行中：请先停止，或等本轮结束后再改/);
    assert.equal(service.get(job.id).documents[0].content, document.content);
    release(); await until(() => service.get(job.id).status === "done");
    service.edit(job.id, { document: { ...document, content: "人工修订" }, base_revision: 1 }, "editor");
    const turn = service.get(job.id).turns.at(-1)!;
    assert.equal(turn.proposals[0].base_revision, 1);
    assert.equal(service.get(job.id).documents[0].content, "人工修订");
    assert.throws(() => service.decide(job.id, turn.id, document.id, "accept", "expert"), /新版本/);
    service.decide(job.id, turn.id, document.id, "discard", "expert");
    const restored = service.restore(job.id, document.id, 1, 2, "editor");
    assert.equal(restored.documents[0].revision, 3); assert.equal(restored.documents[0].content, document.content);
    const restart = new DomainKnowledgeExtraction(dir, async () => "unused");
    assert.deepEqual(restart.get(job.id), JSON.parse(JSON.stringify(restored))); await restart.shutdown();
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
test("生产线验收14：停止后迟到结果不复活；路径和归档目标不能通过模型或人工编辑越界", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-extraction-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    assert.throws(() => input.save({ ...document, path: "../../README.md" }), /路径/);
    assert.throws(() => input.save({ ...document, target_id: "repo-1" }), /领域文档/);
    extract(input);
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    assert.throws(() => input.save(document), /停止/); return "迟到答复";
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).documents.length > 0);
    service.stop(job.id); await service.shutdown();
    const stopped = service.get(job.id); assert.equal(stopped.status, "cancelled"); assert.equal(stopped.documents.length, 1); assert.equal(stopped.turns[0].reply, undefined); assert.ok(stopped.turns[0].started_at && stopped.turns[0].finished_at);
    const renamed = service.edit(job.id, { document: { ...document, path: "domains/orders/new.md" }, base_revision: 1 }, "editor");
    assert.equal(renamed.documents[0].path, "domains/orders/new.md", "停止后允许在原文档目录内改名");
    assert.equal(renamed.documents[0].base_path, document.path);
    assert.throws(() => service.edit(job.id, { document: { ...document, path: "../../README.md" }, base_revision: 2 }, "editor"), /路径/);
    assert.throws(() => service.edit(job.id, { document: { ...document, target_id: "repo-1", layer: "repository", path: "docs/business/new.md" }, base_revision: 2 }, "editor"), /归档仓/);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
test("生产线验收14：MR 部分失败保存已经发生的分支事实，重试复用分支且不影响其他仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-extraction-"));
  let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), {
    publish: async (_job, target, previous, _operator, save) => {
      calls++;
      const publication: DomainPublication = previous ?? { target_id: target.id, branch: "codex/knowledge-persisted", state: "pending", documents: [] };
      save(publication);
      if (calls === 1) throw new Error("MR 响应丢失");
      assert.equal(previous?.branch, "codex/knowledge-persisted");
      return { ...publication, state: "opened", url: "https://example.test/mr/1", mr_id: 1 };
    },
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    const preview = service.previewArchive(job.id);
    await service.createArchive(job.id, { issue_no: config.issue_no, expected_revisions: preview.expected_revisions }, "expert");
    assert.equal(service.get(job.id).publications[0].state, "failed");
    const batch = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!;
    await service.retryArchive(job.id, "expert", { batch_id: batch.id });
    assert.equal(service.get(job.id).publications[0].state, "opened");
    assert.equal(calls, 2);
    assert.equal(service.setIssueNumber(job.id, "REQ-other").issue_no, "REQ-other");
    assert.equal(service.get(job.id).archive_batches!.find(row => row.id === batch.id)!.issue_no, config.issue_no);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域 Skill 在真实 Pi 会话中读取固定源码和引用，保存两层草稿且无发布权限", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-agent-")), source = join(dir, "source");
  mkdirSync(source); const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "state.ts"), "export const initial = 'pending';\n"); git("add", "."); git("commit", "-m", "fixture");
  const staleRevision = git("rev-parse", "HEAD");
  writeFileSync(join(source, "state.ts"), "export const initial = 'latest-ready';\n"); git("add", "."); git("commit", "-m", "latest business change");
  const revision = git("rev-parse", "HEAD");
  const material = await businessMaterial(dir);
  const draft = { ...document, path: "docs/订单/states.md" };
  const model = new ScriptedModelServer([
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "extraction_skill", input: { path: "references/domain.md" } } },
    { tool: { name: "component_source", input: { component_id: "repo-1", action: "read", path: "state.ts" } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document: draft } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document: { ...draft, id: "implementation", target_id: "repo-1", path: "docs/business/states.md", layer: "repository" } } } },
    { text: "这里只完成了初步草稿。" },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { text: "研究完成，准备核对证据。" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: "states" } } },
    { tool: { name: "knowledge_draft", input: { action: "read", id: "implementation" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work_result", input: { summary: "已保存领域规则及仓内实现知识（依据 repo-1:README.md），等待审查。", document_ids: ["states", "implementation"] } } },
    { text: "业务知识已保存" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new DomainKnowledgeExtraction(dir, input => { input.job.revisions = { "repo-1": staleRevision }; return runDomainKnowledge(input, { dataDir: dir, model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async repository => { assert.equal(repository.id, "repo-1", "归档前只读取研究仓"); return { root: source, revision }; } }); });
  try {
    const { knowledge_target: _, ...researchOnly } = config;
    const job = service.create({ ...researchOnly, material_ids: [material.id] }, "expert");
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    const result = service.get(job.id); assert.equal(result.status, "done", result.error);
    assert.equal(result.turns[0].research?.phase, "complete"); assert.match(JSON.stringify(model.requests), /尚未收到 knowledge_work_result 的 saved:true/);
    assert.equal(result.documents.length, 2); assert.equal(result.documents[0].base_revision, ""); assert.equal(result.archive_configured, false); assert.equal(result.revisions["repo-1"], revision);
    assert.match(JSON.stringify(result.evidence), /latest-ready/); assert.notEqual(revision, staleRevision);
    assert.equal(result.turns[0].skill?.name, "generic-domain-fixture");
    const tools = (model.requests[0].tools as Array<{ name: string }>).map(t => t.name);
    assert.ok(tools.includes("extraction_skill")); assert.ok(tools.includes("knowledge_material"));
    assert.ok(!tools.includes("bash") && !tools.includes("write") && tools.includes("business_knowledge"));
    assert.ok(result.turns[0].reply?.includes("等待审查"));
    // 答复给人看：仓内编号换成仓名，并记下本轮实际开跑与收口时间供任务中心算历时。
    assert.ok(result.turns[0].reply?.includes("交易仓:README.md") && !result.turns[0].reply.includes("repo-1:"), result.turns[0].reply);
    assert.ok(Date.parse(result.turns[0].finished_at!) >= Date.parse(result.turns[0].started_at!));
    assert.equal(git("rev-parse", "HEAD"), revision); assert.equal(result.publications.length, 0);
  } finally { await service.shutdown(); await model.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Skill 连续完善草稿，超过四轮保留原上下文，明确提交结果才结束", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-long-research-")), source = join(dir, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); writeFileSync(join(source, "rule.ts"), "export const initial = 'pending';\n"); git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  const revision = git("rev-parse", "HEAD");
  const material = await businessMaterial(dir);
  const script: ConstructorParameters<typeof ScriptedModelServer>[0] = [
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "component_source", input: { action: "read", component_id: "repo-1", path: "rule.ts" } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document } } },
  ];
  for (let i = 0; i < 12; i++) script.push(
    { tool: { name: "knowledge_draft", input: { action: "save", document: { ...document, content: `# 知识\n补充第 ${i} 条规则` } } } },
    { text: `阶段性报告 ${i}，其余能力还需研究` },
  );
  script.push({ tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } }, { text: "申请证据核对" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: document.id } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } }, { tool: { name: "knowledge_work_result", input: { summary: "证据核对完成", document_ids: [document.id] } } }, { text: "完成" });
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true }); await model.start();
  const service = new DomainKnowledgeExtraction(dir, input => runDomainKnowledge(input, { dataDir: dir,
    model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async () => ({ root: source, revision }) }));
  try {
    const job = service.create({ ...config, material_ids: [material.id] }, "expert");
    for (let i = 0; i < 1000 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const result = service.get(job.id); assert.equal(result.status, "done", result.error);
    assert.equal(result.turns.length, 1); assert.equal(result.documents[0].revision, 13);
    assert.equal(result.turns[0].research?.phase, "complete"); assert.equal(result.turns[0].reply, "证据核对完成");
    assert.equal(result.evidence.filter(e => e.tool === "component_source" && e.action === "read").length, 1);
    assert.match(JSON.stringify(model.requests.at(-1)), /阶段性报告 0/);
  } finally { await service.shutdown(); await model.stop(); rmSync(dir, { recursive: true, force: true }); }
});


test("旧草稿可补填单号，创建 MR 前拦截缺失单号且重启保留补填结果", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-legacy-issue-"));
  const original = new DomainKnowledgeExtraction(dir, async input => extract(input));
  let service: DomainKnowledgeExtraction | undefined;
  try {
    const job = original.create(config, "expert"); await until(() => original.get(job.id).status === "done");
    await original.shutdown();
    const path = join(dir, "domain-extraction", job.id, "job.json"), stored = JSON.parse(readFileSync(path, "utf8"));
    delete stored.issue_no; writeFileSync(path, JSON.stringify(stored));
    service = new DomainKnowledgeExtraction(dir, async () => "unused", { publish: async () => { throw new Error("不应执行发布"); } });
    assert.ok(service.get(job.id).documents[0].content, "缺少单号也保留已完成候选");
    assert.deepEqual(listKnowledgeDocuments(dir), []);
    await assert.rejects(service.createArchive(job.id, { issue_no: "", expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert"), /关联单号/);
    assert.equal(service.setIssueNumber(job.id, "  REQ-legacy  ").issue_no, "REQ-legacy");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).issue_no, "REQ-legacy");
  } finally { await original.shutdown(); await service?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/14：人工归档原样保存单号描述，后续预填修改不改变已创建MR的标题，重启及增量研究保留预填", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-issue-description-")), description = "修复订单取消后的状态回退";
  const createdTitles: string[] = [];
  let service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (job, target) => {
    createdTitles.push(knowledgeIssueDescription(job.issue_description, { required: true })!);
    return { target_id: target.id, branch: "codex/description", state: "opened", url: "https://example.test/mr/description", documents: [] };
  } });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    service.setIssueNumber(job.id, config.issue_no, `  ${description}  `);
    await service.createArchive(job.id, { issue_no: config.issue_no, issue_description: description, expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    assert.deepEqual(createdTitles, [description]);
    const batch = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!;
    service.setIssueNumber(job.id, config.issue_no, "后续预填描述");
    assert.equal(service.get(job.id).archive_batches!.find(row => row.id === batch.id)!.issue_description, description);
    const documentId = service.get(job.id).documents[0].id;
    await service.shutdown(); service = new DomainKnowledgeExtraction(dir, async () => "已核对");
    assert.equal(service.get(job.id).issue_description, "后续预填描述");
    assert.equal(service.get(job.id).archive_batches!.find(row => row.id === batch.id)!.issue_description, description);
    const update = service.run(job.id, { mode: "update", document_ids: [documentId], message: "核对来源的新版本" }, "expert");
    assert.equal(update.issue_description, "后续预填描述"); assert.equal(update.id, job.id, "未合入产物继续原任务维护");
    await until(() => service.get(update.id).status === "done");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域 MR 预览只读最新候选，明确采纳清理旧建议，未选文稿建议保持原样", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-confirm-publish-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") {
      extract(input);
      input.save({ ...document, id: "other", path: "domains/orders/other.md" }, { content: null, revision: "a".repeat(40) });
    } else {
      const current = input.read().find(doc => input.turn.document_ids.includes(doc.id))!;
      input.save({ ...current, content: input.turn.message });
    }
    return "已完成";
  }, { publish: async (snapshot, target) => ({ target_id: target.id, branch: "codex/latest-review", state: "opened", url: "https://example.test/mr/latest-review",
    documents: snapshot.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) }) });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    for (const message of ["旧修改", "最新修改"]) {
      service.run(job.id, { mode: "revise", document_ids: [document.id], message }, "expert");
      await until(() => service.get(job.id).status === "done");
    }
    assert.equal(service.previewArchive(job.id).targets[0].files.find(file => file.id === document.id)?.content, "最新修改");
    assert.equal(service.get(job.id).documents[0].content, document.content, "MR 预览不提前采纳或修改原稿");
    assert.equal(listKnowledgeDocuments(dir).length, 0);
    const latest = service.get(job.id).turns.at(-1)!;
    const accepted = service.decide(job.id, latest.id, document.id, "accept", "expert");
    assert.deepEqual(accepted.turns.slice(1).map(turn => turn.proposals[0].status), ["discarded", "accepted"]);
    service.run(job.id, { mode: "revise", document_ids: ["other"], message: "未选文档的建议" }, "expert");
    await until(() => service.get(job.id).status === "done");
    service.select(job.id, ["other"], false);
    await service.createArchive(job.id, { issue_no: config.issue_no, expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    assert.equal(service.get(job.id).publications[0].documents[0].content, "最新修改");
    assert.deepEqual(listKnowledgeDocuments(dir), []);
    assert.equal(service.get(job.id).turns.at(-1)!.proposals[0].status, "pending");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域失败回合不能采纳部分建议，并发正文修改不清理建议也不发布", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-confirm-conflict-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    input.save({ ...input.read()[0], content: input.turn.message });
    if (input.turn.message === "失败修改") throw new Error("核对未完成");
    return "已完成";
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "失败修改" }, "expert");
    await until(() => service.get(job.id).status === "failed");
    assert.throws(() => service.decide(job.id, service.get(job.id).turns.at(-1)!.id, document.id, "accept", "expert"), /尚未完成/);
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "完整建议" }, "expert");
    await until(() => service.get(job.id).status === "done");
    const current = service.get(job.id), latest = current.turns.at(-1)!;
    service.edit(job.id, { document: { ...current.documents[0], content: "其他人刚保存的正文" }, base_revision: current.documents[0].revision }, "other");
    assert.throws(() => service.decide(job.id, latest.id, document.id, "accept", "expert"), /新版本/);
    assert.deepEqual(service.get(job.id).turns.slice(1).map(turn => turn.proposals[0].status), ["pending", "pending"]);
    assert.throws(() => service.previewArchive(job.id), /正文已变化/);
    assert.equal(listKnowledgeDocuments(dir).length, 0);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域确认竞态：不覆盖较新建议，研究进行中不能确认，放弃新建议后可确认旧建议", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-confirm-race-"));
  let release = () => {}, discussing = false;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    if (input.turn.mode === "discuss") { await new Promise<void>(resolve => { release = resolve; discussing = true; }); return "讨论完成"; }
    input.save({ ...input.read()[0], content: input.turn.message }); return "修改完成";
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    for (const message of ["已阅读的旧建议", "刚生成的新建议"]) {
      service.run(job.id, { mode: "revise", document_ids: [document.id], message }, "expert");
      await until(() => service.get(job.id).status === "done");
    }
    const [old, latest] = service.get(job.id).turns.slice(1);
    assert.throws(() => service.decide(job.id, old.id, document.id, "accept", "expert"), /更新的修改建议/);
    assert.deepEqual(service.get(job.id).turns.slice(1).map(turn => turn.proposals[0].status), ["pending", "pending"]);
    assert.equal(service.get(job.id).documents[0].revision, 1);
    service.run(job.id, { mode: "discuss", document_ids: [document.id], message: "继续讨论" }, "expert");
    await until(() => discussing);
    assert.throws(() => service.decide(job.id, latest.id, document.id, "accept", "expert"), /当前研究仍在进行/);
    release(); await until(() => service.get(job.id).status === "done");
    service.decide(job.id, latest.id, document.id, "discard", "expert");
    const accepted = service.decide(job.id, old.id, document.id, "accept", "expert");
    assert.equal(accepted.documents[0].content, "已阅读的旧建议");
    assert.deepEqual(accepted.turns.slice(1, 3).map(turn => turn.proposals[0].status), ["accepted", "discarded"]);
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域连续整体意见接着上一轮候选修改，原稿与发布基线保留到确认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-feedback-continuation-"));
  const seen: string[] = [];
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    const current = input.read()[0];
    assert.deepEqual(input.job.documents, input.read(), "执行快照和读取工具使用同一份候选内容");
    seen.push(current.content);
    input.save({ ...current, content: current.content + `\n${input.turn.message}` });
    assert.equal(input.read()[0].content, current.content + `\n${input.turn.message}`, "同一轮继续读取已修改的新稿");
    return "修改完成";
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    const original = service.get(job.id).documents[0];
    for (const message of ["补充第一轮边界", "补充第二轮示例"]) {
      service.run(job.id, { mode: "revise", document_ids: [document.id], message }, "expert");
      await until(() => ["done", "failed"].includes(service.get(job.id).status));
      assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    }
    const pending = service.get(job.id);
    assert.deepEqual(seen, [document.content, document.content + "\n补充第一轮边界"]);
    assert.deepEqual(pending.documents[0], original, "待确认候选不会修改原稿及归档基线");
    assert.equal(pending.turns.at(-1)!.proposals[0].base_revision, original.revision);
    assert.equal(pending.turns.at(-1)!.proposals[0].document.content, document.content + "\n补充第一轮边界\n补充第二轮示例");
    service.edit(job.id, { document: { ...original, content: "人工保存的新正文" }, base_revision: original.revision }, "editor");
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "核对人工正文" }, "expert");
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    assert.equal(seen.at(-1), "人工保存的新正文", "版本已变更时不会沿用过期候选");
    const latest = service.get(job.id).turns.at(-1)!;
    const confirmed = service.decide(job.id, latest.id, document.id, "accept", "expert");
    assert.equal(confirmed.documents[0].content, "人工保存的新正文\n核对人工正文");
    assert.equal(confirmed.documents[0].revision, original.revision + 2);
    assert.equal(confirmed.documents[0].base_revision, original.base_revision);
    assert.equal(confirmed.documents[0].base_content, original.base_content);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
