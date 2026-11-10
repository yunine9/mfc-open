import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { DomainKnowledgeExtraction, type DomainDocumentContent, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledgeFixture, genericDomainSkillFixture } from "./helpers/extractionSkillFixture.ts";
import { createHash } from "node:crypto";
import { HostGitSandbox } from "../src/hostGitSandbox.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { writeGitKnowledgeSnapshot } from "../src/knowledgeRepositorySnapshots.ts";
import { syncModuleKnowledge } from "../src/knowledgeRepositorySync.ts";
import { listFormalKnowledgeDocuments, readKnowledgeDocument, type KnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

async function finished(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 600; i++) {
    const job = service.get(id);
    if (!["queued", "running"].includes(job.status)) {
      assert.equal(job.status, "done", job.error);
      await new Promise(resolve => setTimeout(resolve, 0));
      return service.get(id);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("领域研究未在 6 秒内结束");
}

const businessRepository = (number: number) => ({ name: `业务仓 ${number}`, repository: `https://example.test/business-${number}.git`, branch: "main", docs_path: "docs/business" });
const knowledgeTarget = { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" };
const originalPath = "docs/business/30/transport.md";
const renamedPath = "docs/business/文件传输管理/传输任务.md";
const originalBody = "# 传输任务\n\n传输完成后记录业务结果。";
const originalMap = "# 模块目录\n\n[传输任务](30/transport.md)";
const originalIndex = "# 业务知识入口\n\n阅读 docs/business/30/transport.md。";

function businessDocuments(number: number): DomainDocumentContent[] {
  const common = { target_id: `repo-${number}`, layer: "repository" as const, sources: `repo-${number}:src/transfer.ts:1-1` };
  return [
    { ...common, id: `guide-${number}`, title: "传输任务", path: originalPath, content: originalBody },
    { ...common, id: `map-${number}`, title: "模块目录", path: "docs/business/module-map.md", content: originalMap },
    { ...common, id: `index-${number}`, title: "业务知识入口", path: "docs/business/README.md", content: originalIndex },
  ];
}

function document(job: DomainKnowledgeJob, id: string) {
  const found = job.documents.find(document => document.id === id);
  assert.ok(found, `文档 ${id} 应当存在`);
  return found;
}

test("#466 Agent 用原编号改业务路径并更新三仓目录与 README：建议、重启、采纳、恢复和任务身份一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-agent-")), repo = join(root, "repo");
  mkdirSync(repo);
  const files = { "src/transfer.ts": "export function transfer() { return 'completed'; }\n", [originalPath]: originalBody,
    "docs/business/module-map.md": originalMap, "docs/business/README.md": originalIndex, "AGENTS.md": originalIndex };
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const method = { "SKILL.md": "---\nname: business-paths\ndescription: 按业务概念组织文稿。\n---\n使用稳定文档编号维护正文与路径，更新相关目录和阅读入口。" };
  let phase: "extract" | "rename" | "refine" | "discard" = "extract", readonlyChecks = 0;
  const allIds = [1, 2, 3].flatMap(number => businessDocuments(number).map(document => document.id));
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call = async (name: string, args: unknown, error = false) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name); assert.ok(tool, name);
        const response = await tool.execute("fixture", args, new AbortController().signal);
        assert.equal(!!response.isError, error, JSON.stringify(response));
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      if (context.step) {
        readonlyChecks++;
        const proposed = await call("knowledge_draft", { action: "read", id: "guide-1" });
        assert.equal(proposed.path, phase === "discard" ? "docs/business/放弃的名称.md" : renamedPath);
        await call("knowledge_draft", { action: "save", document: { ...proposed, path: "docs/business/不能写.md" } }, true);
        const reviewed = phase === "discard" ? ["guide-1"] : allIds;
        for (const id of reviewed) await call("knowledge_draft", { action: "read", id });
        await call("knowledge_work_result", { summary: "已回读业务路径与引用", document_ids: reviewed, ...(context.reviewing ? { review: { pass: true, feedback: "已逐篇核对当前路径、正文与关联导航引用" } } : {}) });
      } else if (phase === "extract") {
        await call("component_source", { action: "read", component_id: "repo-1", path: "src/transfer.ts" });
        for (const number of [1, 2, 3]) for (const draft of businessDocuments(number)) await call("knowledge_draft", { action: "save", document: draft });
        await call("knowledge_work_result", { summary: "已保存三仓业务文稿", document_ids: allIds });
      } else if (phase === "rename" || phase === "refine") {
        assert.deepEqual(context.selected_document_ids, allIds);
        for (const number of [1, 2, 3]) {
          const guide = await call("knowledge_draft", { action: "read", id: `guide-${number}` });
          assert.equal(guide.path, phase === "rename" ? originalPath : renamedPath, "后续轮读取前一轮未采纳的新路径");
          const map = await call("knowledge_draft", { action: "read", id: `map-${number}` });
          const agents = await call("knowledge_draft", { action: "read", id: `index-${number}` });
          assert.equal(agents.path, "docs/business/README.md", "业务目录内的导航文稿可继续更新内容");
          const content = phase === "rename" ? originalBody : `${originalBody}\n\n核对失败任务的重试边界。`;
          await call("knowledge_draft", { action: "save", document: { ...guide, path: renamedPath, content } });
          await call("knowledge_draft", { action: "save", document: { ...map, content: "# 模块目录\n\n[传输任务](文件传输管理/传输任务.md)" } });
          await call("knowledge_draft", { action: "save", document: { ...agents, content: `# 业务知识入口\n\n阅读 ${renamedPath}。` } });
          assert.equal((await call("knowledge_draft", { action: "read", id: guide.id })).path, renamedPath);
        }
        {
          await call("knowledge_work", { action: "schedule", steps: [{ id: "verify-paths", title: "回读关联文稿", instructions: "核对新路径与关联入口", depends_on: [], readonly: true, expected_document_ids: allIds, review: { instructions: "独立核对所有改名及导航文稿" } }] });
          await call("knowledge_work", { action: "run", id: "verify-paths" });
        }
        await call("knowledge_work_result", { summary: "改名与关联入口修改已保存，等待审查", document_ids: allIds });
      } else {
        const guide = await call("knowledge_draft", { action: "read", id: "guide-1" });
        assert.equal(guide.path, originalPath);
        await call("knowledge_draft", { action: "save", document: { ...guide, path: "docs/business/放弃的名称.md" } });
        await call("knowledge_work", { action: "schedule", steps: [{ id: "verify-discard", title: "独立核对另一名称", instructions: "只读核对当前改名候选", readonly: true, depends_on: [], expected_document_ids: [guide.id], review: { instructions: "独立核对改名候选" } }] });
        await call("knowledge_work", { action: "run", id: "verify-discard" });
        await call("knowledge_work_result", { summary: "另一改名建议，等待审查", document_ids: [guide.id] });
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("已保存结果不应再次补充会话"); },
  }) as any);
  const execute = (input: Parameters<typeof runDomainKnowledge>[0]) => runDomainKnowledgeFixture(method, input, { dataDir: root,
    model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision }) });
  let service = new DomainKnowledgeExtraction(root, execute);
  try {
    let job = await finished(service, service.create({ issue_no: "466", title: "文件传输", scope: "业务文档命名和目录入口", knowledge_target: knowledgeTarget,
      repositories: [1, 2, 3].map(businessRepository) }, "expert").id);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories], documents: [
      { id: "guide-1", path: originalPath }, ...[1, 2, 3].map(number => ({ id: `index-${number}`, path: "docs/business/README.md" })),
    ] });
    await assert.rejects(service.publish(job.id, "expert"), /直接创建 MR/);
    const originals = structuredClone(job.documents);
    assert.equal(listFormalKnowledgeDocuments(root).length, 0, "候选不得进入正式库");
    phase = "rename";
    service.run(job.id, { mode: "revise", document_ids: allIds, message: "按业务概念改名，并更新三仓的 module-map 和 README 引用" }, "expert");
    job = await finished(service, job.id);
    assert.equal(readonlyChecks, 2, "只读核查及独立评审都不能修改文稿");
    assert.deepEqual(job.documents, originals, "改名只生成建议，旧正文与归档路径没有直接改变");
    assert.equal(job.turns.at(-1)!.proposals.length, 9);
    assert.equal(job.turns.at(-1)!.proposals.find(proposal => proposal.document.id === "guide-1")!.document.path, renamedPath);
    await assert.rejects(() => service.publish(job.id, "expert"), /直接创建 MR/);
    await service.shutdown(); service = new DomainKnowledgeExtraction(root, execute);
    job = service.get(job.id);
    assert.deepEqual(job.documents, originals);
    assert.equal(job.turns.at(-1)!.proposals.find(proposal => proposal.document.id === "guide-1")!.document.path, renamedPath, "重启不丢改名建议");
    phase = "refine";
    service.run(job.id, { mode: "revise", document_ids: allIds, message: "沿用业务名称，再补充失败任务的重试边界" }, "expert");
    job = await finished(service, job.id);
    const latest = job.turns.at(-1)!;
    for (const proposal of latest.proposals) service.decide(job.id, latest.id, proposal.document.id, "accept", "expert");
    job = service.get(job.id);
    for (const number of [1, 2, 3]) {
      assert.equal(document(job, `guide-${number}`).path, renamedPath);
      assert.match(document(job, `guide-${number}`).content, /重试边界/);
      assert.match(document(job, `map-${number}`).content, /文件传输管理\/传输任务\.md/);
      assert.equal(document(job, `index-${number}`).path, "docs/business/README.md");
      assert.match(document(job, `index-${number}`).content, /文件传输管理\/传输任务\.md/);
    }
    assert.equal(document(job, "guide-1").archive_path, renamedPath, "已有逐文件归档设置跟随人工采纳的新名称");
    assert.equal(document(job, "guide-2").base_path, originalPath, "首次改名保留原 Git 基线所在路径");
    assert.equal(document(job, "guide-2").base_content, originalBody);
    assert.equal(document(job, "guide-2").history[0].path, originalPath);
    assert.equal(listFormalKnowledgeDocuments(root).length, 0, "采纳改名仍只更新任务候选");
    assert.equal(service.previewArchive(job.id).targets.flatMap(target => target.files).find(file => file.id === "guide-1")?.path, renamedPath);
    for (const draft of job.documents) assert.equal(draft.knowledge_document_id, undefined, "未合入候选不伪造正式身份");
    job = service.restore(job.id, "guide-1", 1, document(job, "guide-1").revision, "expert");
    assert.equal(document(job, "guide-1").path, originalPath);
    assert.equal(document(job, "guide-1").archive_path, originalPath);
    assert.equal(document(job, "guide-1").content, originalBody);
    assert.equal(document(job, "guide-1").revision, 3);
    assert.equal(document(job, "guide-1").id, "guide-1");
    phase = "discard";
    service.run(job.id, { mode: "revise", document_ids: ["guide-1"], message: "试一个其他名称" }, "expert");
    job = await finished(service, job.id);
    const discarded = job.turns.at(-1)!;
    job = service.decide(job.id, discarded.id, "guide-1", "discard", "expert");
    assert.equal(document(job, "guide-1").path, originalPath);
    assert.equal(document(job, "guide-1").revision, 3, "放弃不会改变当前草稿版本");
    assert.equal(discarded.proposals[0].document.path, "docs/business/放弃的名称.md");
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "", "研究工具没有直接搬动源码仓的文件");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 Agent 可新增文档及修改未选文档，改名保留首次基线，非法路径与归档目标和候选冲突仍受保护", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-boundaries-"));
  const guide = businessDocuments(1)[0], second = { ...guide, id: "second", path: "docs/business/other.md", title: "另一业务" },
    unselected = { ...guide, id: "unselected", path: "docs/business/unselected.md" };
  const initialPath = "docs/business/萃取时修正的业务名.md", proposedPath = "docs/business/共同业务名.md";
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      input.save(guide, { content: originalBody, revision: "a".repeat(40) });
      input.save({ ...guide, path: initialPath });
      input.save({ ...guide, path: originalPath });
      input.save(second); input.save(unselected);
      return "同轮自有草稿可修正业务名称";
    }
    const current = input.read().find(document => document.id === guide.id)!;
    input.save({ ...current, id: "new-id", path: "docs/business/guides/新业务文档.md", title: "新增业务文档", content: "新文档完整正文" });
    input.save({ ...unselected, content: "本任务未选文档也可以生成修订建议" });
    assert.throws(() => input.save({ ...current, target_id: "domain", layer: "domain", path: "domains/rename.md" }), /归档位置|归档目标|归档仓|目标与层级/);
    assert.throws(() => input.save({ ...current, layer: "domain" }), /领域文档|层级/);
    for (const path of ["../outside.md", ".git/rename.md", "docs/business/../outside.md", "docs/business/code.ts"]) {
      assert.throws(() => input.save({ ...current, path }), /路径|目录|\.md/);
    }
    assert.throws(() => input.save({ ...current, path: second.path }), /已有草稿|同一个目标|路径.*冲突/);
    assert.throws(() => input.save({ ...current, path: "AGENTS.md" }), /AGENTS|归档目录/);
    input.save({ ...current, path: "docs/business/README.md" });
    assert.equal(input.read().find(document => document.id === guide.id)!.path, "docs/business/README.md", "可在任务业务目录内维护 README 导航");
    input.save({ ...current, path: proposedPath });
    assert.equal(input.read().find(document => document.id === guide.id)!.path, proposedPath);
    assert.throws(() => input.save({ ...second, path: proposedPath }), /已有草稿|同一个目标|路径.*冲突/);
    return "仅保存合法改名建议";
  });
  try {
    let job = await finished(service, service.create({ issue_no: "466-boundary", title: "业务名称", scope: "维护已有业务文档", knowledge_target: knowledgeTarget, repositories: [businessRepository(1)] }, "expert").id);
    const draft = document(job, guide.id);
    assert.equal(draft.path, originalPath); assert.equal(draft.revision, 3);
    assert.equal(draft.base_path, originalPath); assert.equal(draft.base_content, originalBody);
    assert.deepEqual(draft.history.map(history => history.path), [originalPath, initialPath]);
    const before = structuredClone(job.documents);
    service.run(job.id, { mode: "revise", document_ids: [guide.id, second.id], message: "只为选中业务改名" }, "expert");
    job = await finished(service, job.id);
    assert.deepEqual(job.documents.filter(document => document.id !== "new-id"), before, "已有文档只生成待确认建议");
    assert.equal(document(job, "new-id").path, "docs/business/guides/新业务文档.md");
    assert.equal(document(job, "new-id").content, "新文档完整正文");
    assert.equal(document(job, "new-id").selected, true, "新增文档直接成为待审查草稿");
    assert.deepEqual(job.turns.at(-1)!.proposals.map(proposal => proposal.document.id).sort(), [guide.id, unselected.id].sort());
    assert.equal(job.turns.at(-1)!.proposals.find(proposal => proposal.document.id === unselected.id)!.document.content, "本任务未选文档也可以生成修订建议");
    const turnId = job.turns.at(-1)!.id;
    job = service.edit(job.id, { document: { ...document(job, guide.id), content: "人工补充的业务规则" }, base_revision: 3 }, "editor");
    assert.throws(() => service.decide(job.id, turnId, guide.id, "accept", "expert"), /新版本|差异/);
    assert.equal(document(service.get(job.id), guide.id).path, originalPath);
    assert.equal(document(service.get(job.id), guide.id).content, "人工补充的业务规则");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 候选改名自动避让其他正式文档，提交 MR 不覆盖正式路径及正文", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-formal-collision-"));
  const location = { ...knowledgeTarget, docs_path: "docs/business" }, revision = "a".repeat(40);
  saveKnowledgeRepoConfig(root, location.repository, { branch: location.branch });
  createBusinessModule(root, { id: "transport", name: "传输", owner: "expert", description: "正式知识", repositories: [businessRepository(1).repository], knowledge_path: location.docs_path }, "expert");
  const formal = (path: string, content: string, moduleId: string): KnowledgeDocument => ({ id: `kg-${createHash("sha256").update(path).digest("hex")}`, title: path, content, scope: "module", module_ids: [moduleId], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision: createHash("sha256").update(content).digest("hex"), source: { repository: location.repository, branch: location.branch, path, revision }, archive_target: { repository: location.repository, branch: location.branch, path }, history: [] });
  const original = formal(originalPath, originalBody, "transport"), occupied = formal(renamedPath, "# 独立业务规则\n\n其他模块已经维护的正式内容。", "other-module");
  writeGitKnowledgeSnapshot(root, { module_id: "transport", location, synced_at: new Date().toISOString(), documents: [original, occupied], resources: {}, repositories: [{ repository: location.repository, branch: location.branch, revision }] });
  let archived: DomainKnowledgeJob | undefined;
  const service = new DomainKnowledgeExtraction(root, async input => {
    const current = input.read().find(document => document.id === original.id)!;
    input.save({ ...current, path: renamedPath, content: "# 修改后的规则\n\n使用新的业务名称。" });
    return "改名建议已保存";
  }, { publish: async (job, target) => { archived = structuredClone(job); return { target_id: target.id, branch: "codex/rename-safe", state: "opened", url: "https://example.test/mr/rename-safe", documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) }; } });
  try {
    let job = service.beginInspection(original.id, { module_id: "transport", issue_no: "466-formal", expected_revision: original.revision }, "expert");
    assert.deepEqual(job.documents.map(document => document.id), [original.id]);
    service.run(job.id, { mode: "revise", document_ids: [original.id], message: "将原文档改为新的业务路径" }, "expert");
    job = await finished(service, job.id);
    job = service.decide(job.id, job.turns.at(-1)!.id, original.id, "accept", "expert");
    assert.equal(document(job, original.id).path, renamedPath);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision ?? 0, targets: [job.knowledge_target], use_directory_layout: true, documents: [] });
    const safePath = document(job, original.id).path;
    assert.notEqual(safePath, renamedPath, "归档路径自动避让其他正式文件");
    assert.match(safePath, /传输任务/);
    await service.createArchive(job.id, { issue_no: "466-formal", expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    assert.equal(archived!.documents[0].path, safePath);
    assert.deepEqual(readKnowledgeDocument(root, original.id), original);
    assert.deepEqual(readKnowledgeDocument(root, occupied.id), occupied, "其他模块正式文档不能被覆盖");
    assert.equal(listFormalKnowledgeDocuments(root).length, 2, "MR 未合入时不新增候选进正式库");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 目录入口改名后人工历史恢复原路径，Agent 可维护业务目录内的其他 Markdown 路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-root-restore-"));
  const initial = businessDocuments(1)[2], renamed = "docs/business/业务阅读入口.md";
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") { input.save(initial); return "阅读入口已保存"; }
    const current = input.read().find(document => document.id === initial.id)!;
    if (input.turn.message === "将根阅读入口改到业务文档目录") input.save({ ...current, path: renamed });
    else {
      assert.equal(current.path, renamed);
      assert.ok(current.history.some(history => history.path === "docs/business/README.md"));
      for (const path of ["docs/business/README.md", "docs/business/OTHER.md"]) input.save({ ...current, path });
    }
    return "本轮检查完成";
  });
  try {
    let job = await finished(service, service.create({ issue_no: "466-restore-root", title: "阅读入口", scope: "维护本篇入口路径", knowledge_target: knowledgeTarget, repositories: [businessRepository(1)] }, "expert").id);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories], documents: [{ id: initial.id, path: "docs/business/README.md" }] });
    service.run(job.id, { mode: "revise", document_ids: [initial.id], message: "将根阅读入口改到业务文档目录" }, "expert");
    job = await finished(service, job.id);
    job = service.decide(job.id, job.turns.at(-1)!.id, initial.id, "accept", "expert");
    assert.equal(document(job, initial.id).path, renamed); assert.equal(document(job, initial.id).archive_path, renamed);
    assert.equal(document(job, initial.id).history[0].path, "docs/business/README.md");
    service.run(job.id, { mode: "revise", document_ids: [initial.id], message: "检查 Agent 可维护当前任务目标内的根文档" }, "expert");
    job = await finished(service, job.id);
    assert.equal(job.turns.at(-1)!.proposals.length, 1);
    assert.equal(job.turns.at(-1)!.proposals[0].document.path, "docs/business/OTHER.md");
    job = service.restore(job.id, initial.id, 1, document(job, initial.id).revision, "expert");
    assert.equal(document(job, initial.id).path, "docs/business/README.md", "恢复历史路径和正文，新的未采纳建议不改变当前文稿");
    assert.equal(document(job, initial.id).archive_path, "docs/business/README.md");
    assert.equal(document(job, initial.id).revision, 3);
    assert.equal(document(job, initial.id).content, initial.content);
    job = service.edit(job.id, { document: { ...document(job, initial.id), path: "docs/business/OTHER.md" }, base_revision: 3 }, "expert");
    assert.equal(document(job, initial.id).path, "docs/business/OTHER.md"); assert.equal(document(job, initial.id).archive_path, "docs/business/OTHER.md");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 合入同步后从正式 Git 版本独立检视，改名保留原任务快照并通过新 MR 更新", async t => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-git-inspection-")), repo = join(root, "repo");
  const sourceBaseline = "# 最初已有的文稿\n\n尚未整理的旧内容。";
  mkdirSync(dirname(join(repo, originalPath)), { recursive: true }); writeFileSync(join(repo, originalPath), sourceBaseline);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "initial source");
  const initialRevision = git("rev-parse", "HEAD"), location = { repository: "https://example.test/rename-knowledge.git", branch: "main", docs_path: "docs/business" };
  const prepare = HostGitSandbox.prototype.prepare;
  // 保持真实 Git 提交、分支和同步；仅将测试 HTTPS 地址映射到本地临时仓，避免外网依赖。
  t.mock.method(HostGitSandbox.prototype, "prepare", function(this: HostGitSandbox, credential: Parameters<HostGitSandbox["prepare"]>[0]) { const result = prepare.call(this, credential); result.args.push("-c", `url.${repo}.insteadOf=${location.repository}`); return result; });
  saveKnowledgeRepoConfig(root, location.repository, { branch: location.branch });
  createBusinessModule(root, { id: "transport", name: "传输", owner: "expert", description: "传输规则", repositories: [location.repository], knowledge_path: location.docs_path }, "expert");
  await syncModuleKnowledge(root, "transport", "expert");
  const firstFormal = listFormalKnowledgeDocuments(root)[0]; assert.equal(firstFormal.content, sourceBaseline);
  let archiveCalls = 0, mergedRevision = "";
  const mergedBranches = new Set<string>();
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      input.update({ revisions: { domain: initialRevision } });
      input.save({ id: "guide", title: "传输任务", target_id: "domain", layer: "domain", path: originalPath, content: originalBody, sources: "资料与 Git 基线" }, { content: sourceBaseline, revision: initialRevision });
    } else {
      assert.equal(input.job.task_kind, "inspection");
      const current = input.read()[0];
      assert.equal(current.base_content, originalBody, "新检视读取已合入正文，而不是首次萃取的旧基线");
      assert.equal(current.base_revision, mergedRevision);
      input.save({ ...current, path: renamedPath, content: `${originalBody}\n\n补充任务失败后的重试规则。` });
    }
    return "研究或修订完成";
  }, { refreshPublication: async (_target, publication) => ({ ...publication, mr_state: mergedBranches.has(publication.branch) ? "merged" : "opened" }),
    publish: async (job, target, previous) => {
      archiveCalls++;
      const branch = previous?.branch ?? `codex/knowledge-${job.id}`;
      git("checkout", "-q", "-B", branch, "main");
      for (const document of job.documents) {
        if (document.base_path && document.base_path !== document.path) rmSync(join(repo, document.base_path), { force: true });
        mkdirSync(dirname(join(repo, document.path)), { recursive: true }); writeFileSync(join(repo, document.path), document.content);
      }
      git("add", "."); git("commit", "-qm", "knowledge candidate");
      const revision = git("rev-parse", "HEAD"); git("checkout", "-q", "main");
      return { target_id: target.id, branch, revision, state: "opened", url: `https://example.test/mr/${archiveCalls}`, documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
    } });
  try {
    let original = await finished(service, service.create({ module_id: "transport", issue_no: "466-update" }, "expert").id);
    assert.equal(document(original, "guide").base_content, sourceBaseline);
    await service.createArchive(original.id, { issue_no: "466-update", expected_revisions: service.previewArchive(original.id).expected_revisions }, "expert");
    original = service.get(original.id);
    assert.equal(readKnowledgeDocument(root, firstFormal.id).content, sourceBaseline, "提交 MR 不更新正式知识");
    const originalPublication = original.publications[0];
    git("merge", "--ff-only", originalPublication.branch); mergedRevision = git("rev-parse", "HEAD"); mergedBranches.add(originalPublication.branch);
    await service.refreshPublications(original.id, "expert"); await syncModuleKnowledge(root, "transport", "expert");
    original = service.get(original.id);
    const snapshots = structuredClone(original.archive_batches!), formal = readKnowledgeDocument(root, firstFormal.id);
    assert.equal(formal.content, originalBody); assert.equal(formal.source?.revision, mergedRevision);
    assert.equal(original.production?.review.readonly, true);
    assert.throws(() => service.edit(original.id, { document: { ...document(original, "guide"), content: "覆盖" }, base_revision: 1 }, "expert"), /已合入/);
    let update = service.beginInspection(formal.id, { module_id: "transport", expected_revision: formal.revision, issue_no: "466-new-inspection" }, "expert");
    assert.notEqual(update.id, original.id); assert.equal(update.turns.length, 0);
    assert.deepEqual(update.archive_batches, []); assert.deepEqual(update.publications, []);
    service.run(update.id, { mode: "revise", document_ids: [formal.id], message: "沿用原文稿编号改为业务目录名称" }, "expert");
    update = await finished(service, update.id); update = service.decide(update.id, update.turns.at(-1)!.id, formal.id, "accept", "expert");
    await service.createArchive(update.id, { issue_no: "466-new-inspection", expected_revisions: service.previewArchive(update.id).expected_revisions }, "expert");
    update = service.get(update.id);
    assert.equal(document(update, formal.id).path, renamedPath);
    assert.equal(document(update, formal.id).knowledge_document_id, formal.id, "候选保留正式来源身份");
    assert.equal(readKnowledgeDocument(root, formal.id).content, originalBody, "新 MR 未合入前原正式版本仍可读");
    assert.deepEqual(service.get(original.id).archive_batches, snapshots, "新任务不会重写旧任务 MR 证据");
    git("merge", "--ff-only", update.publications[0].branch); mergedBranches.add(update.publications[0].branch);
    await syncModuleKnowledge(root, "transport", "expert");
    assert.throws(() => readKnowledgeDocument(root, formal.id), /不存在|删除/);
    const renamed = listFormalKnowledgeDocuments(root).find(document => document.source?.path === renamedPath)!;
    assert.ok(renamed); assert.notEqual(renamed.id, formal.id, "Git 文件改名后按新路径生成正式索引，任务来源身份仍可追溯");
    assert.match(renamed.content, /重试规则/); assert.equal(listFormalKnowledgeDocuments(root).length, 1);
    assert.deepEqual(service.get(original.id).archive_batches, snapshots); assert.equal(archiveCalls, 2);
    assert.equal(git("status", "--porcelain"), "");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
