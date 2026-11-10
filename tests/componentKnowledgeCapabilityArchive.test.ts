import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { componentArchiveFiles } from "../src/componentKnowledgeArchiveFormat.ts";
import { researchDocumentMarkdown, type ResearchSection } from "../src/componentResearchDocument.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { fixtureCaller, fixtureUnitTest, fixtureEvidence, guideOverview, usageContent } from "./componentPipelineFixture.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { componentResearchRoute } from "../src/componentResearchRoutes.ts";

function guide(count = 110) {
  const evidence = fixtureEvidence("base");
  const sections: ResearchSection[] = Array.from({ length: count }, (_, index) => ({
    id: `paradigm-files-use-${index}`, title: index < 2 ? "同名能力" : `能力 ${index}`, selected: true, revision: 3, repository_ids: ["base"], related_ids: [],
    content: usageContent(`保留第 ${index} 项已确认知识；[关联能力](#component-paradigm-files-use-0)`), interfaces: "Close(Handle& handle)", integration: "包含 file.h，链接 libfile.so。",
    example: `\`\`\`cpp\n${fixtureCaller}\`\`\``, unit_tests: `\`\`\`cpp\n${fixtureUnitTest}\`\`\``, sources: "固定版本源码及已核对证据",
    paradigm: { kind: "paradigm", component: index % 2 ? "files" : "errors", language: "cpp", status: "recommended", need: `能力 ${index}`, applicability: "当前固定版本",
      api: ["Close"], replaces: { identifiers: [], imports: [], patterns: [] }, evidence: [evidence.reference], usage_evidence: [evidence.usageId], test_evidence: [evidence.testId], open_questions: [] },
  }));
  return { sections, content: researchDocumentMarkdown("基础组件", { overview: guideOverview("110 项已研究的能力"), sections }, true) };
}

test("110项已发布能力按稳定编号拆分，保留完整代码和单元测试，目录链接全部可达", () => {
  const input = guide(), original = input.content;
  const files = componentArchiveFiles(input.content, "teams/platform/cpp/基础组件.md");
  assert.equal(files.length, 111); assert.equal(new Set(files.map(file => file.path)).size, 111);
  assert.equal(new Set(files.map(file => file.id)).size, 111);
  assert.equal(files[0].path, "teams/platform/cpp/基础组件/README.md");
  assert.doesNotMatch(files[0].content, /#include|### 完整示例/);
  for (const section of input.sections) {
    const file = files.find(file => file.path.endsWith(`/${section.id}.md`))!;
    assert.ok(file); assert.ok(file.path.includes(`/${section.paradigm!.component}/`));
    assert.ok(file.content.includes(fixtureCaller)); assert.ok(file.content.includes(fixtureUnitTest));
    assert.match(file.content, new RegExp(`第 ${section.id.split("-").at(-1)} 项已确认知识`));
    assert.doesNotMatch(file.content, /component_paradigms:|content_sha256:/);
    for (const match of file.content.matchAll(/\]\(([^)]+)\)/g)) {
      const path = match[1].split("#")[0];
      assert.ok(files.some(candidate => candidate.path === posix.normalize(posix.join(posix.dirname(file.path), path))), match[0]);
    }
  }
  assert.equal(input.content, original);
});

test("组件归档可指定目标代码仓和相对目录，预览只读，正式知识不改，旧失败批次按冻结路径接续", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-capability-archive-"));
  const calls: DomainKnowledgeJob[] = []; let fail = true;
  seedTechnologyStacks(dir, ["cpp"]);
  saveKnowledgeRepoConfig(dir, "https://example.test/knowledge.git", { branch: "main", docs_path: "docs/components" });
  const formal = saveKnowledgeDocument(dir, { title: "基础组件", content: guide().content, technologies: ["cpp"] }, "author");
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("整理归档不能重新萃取"); }, {
    closePublication: async () => {}, publish: async (job, target, previous) => {
      calls.push(structuredClone(job));
      if (fail) { fail = false; throw new Error("暂时网络故障"); }
      return { target_id: target.id, state: "opened", branch: previous?.branch || "main_author_DTS1", url: "https://example.test/mr/1",
        documents: job.documents.map(doc => ({ id: doc.id, path: doc.path, content: doc.content, revision: doc.revision, knowledge_document_id: doc.knowledge_document_id, knowledge_revision: doc.published_revision })) };
    },
  });
  try {
    const initial = manager.previewComponentArchive({ research_id: "cr-existing-five-days", knowledge_document_id: formal.id }, "author");
    assert.equal(initial.targets[0].files.length, 111);
    const snapshot = readFileSync(join(dir, "domain-extraction", initial.job_id, "job.json"), "utf8");
    const input = { base_revision: initial.archive_revision, targets: [{ ...initial.targets[0], repository: "https://example.test/code.git", branch: "release", docs_path: "docs/team-selected" }] };
    let response: { status: number; value: any } | undefined;
    await componentResearchRoute({ method: "POST" } as any, {} as any, ["component-research", "cr-existing-five-days", "archive", "targets", "preview"],
      { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => manager, getComponentResearch: () => ({ get: () => ({ id: "cr-existing-five-days", document_id: formal.id }) }) } as any,
      "author", async () => input, (_out, status, value) => { response = { status, value }; });
    assert.equal(response!.status, 200); assert.equal(response!.value.documents.length, 111);
    const preview = manager.previewArchiveTargets(initial.job_id, input);
    assert.ok(preview.documents.every(doc => doc.path.startsWith("docs/team-selected/")));
    assert.equal(preview.archive_preview!.targets[0].repository, "https://example.test/code.git");
    assert.equal(readFileSync(join(dir, "domain-extraction", initial.job_id, "job.json"), "utf8"), snapshot);
    assert.throws(() => manager.previewArchiveTargets(initial.job_id, { ...input, targets: [{ ...input.targets[0], docs_path: "../escape" }] }), /相对路径/);
    const configured = manager.configureArchive(initial.job_id, input);
    assert.equal(configured.id, initial.job_id); assert.equal(configured.component_research_id, "cr-existing-five-days");
    assert.equal(configured.documents.length, 111);
    assert.throws(() => manager.configureArchive(initial.job_id, input), /已被修改/);
    await assert.rejects(manager.createArchive(initial.job_id, { issue_no: "DTS1", expected_revisions: initial.expected_revisions, expected_archive_revision: 0 }, "author"), /归档位置已被修改/);
    const failed = await manager.createArchive(initial.job_id, { issue_no: "DTS1", expected_revisions: initial.expected_revisions, expected_archive_revision: configured.archive_revision }, "author");
    assert.equal(failed.status_label, "归档失败");
    const batch = manager.get(initial.job_id).archive_batches!.at(-1)!;
    manager.configureArchive(initial.job_id, { base_revision: configured.archive_revision, targets: [{ ...input.targets[0], docs_path: "docs/next-place" }] });
    const retried = await manager.retryArchive(initial.job_id, "author", { batch_id: batch.id });
    assert.equal(retried.status_label, "已归档");
    assert.ok(calls.every(call => call.documents.every(doc => doc.path.startsWith("docs/team-selected/"))), "失败批次不采用后来改过的路径");
    assert.ok(calls.every(call => call.knowledge_target.repository === "https://example.test/code.git"));
    assert.equal(readKnowledgeDocument(dir, formal.id).revision, formal.revision);
    assert.equal(readKnowledgeDocument(dir, formal.id).content, formal.content);
    assert.equal(manager.get(initial.job_id).knowledge_target.docs_path, "docs/next-place");
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("真实Git归档逐项核对正式版本，指定目录包含能力文档和导航，篡改正文被拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-capability-git-")), source = join(dir, "source"), remote = join(dir, "remote.git");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(source); git("init", "-b", "main", source);
  writeFileSync(join(source, "source.cpp"), "// keep source\n"); git("-C", source, "add", ".");
  git("-C", source, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "source"); git("clone", "--bare", source, remote);
  seedTechnologyStacks(dir, ["cpp"]);
  const formal = saveKnowledgeDocument(dir, { title: "基础组件", content: guide(2).content, technologies: ["cpp"] }, "author");
  const target = { id: "domain", name: "组件归档仓", repository: remote, branch: "main", path: "", docs_path: "docs/chosen-by-user" };
  const files = componentArchiveFiles(formal.content, `${target.docs_path}/cpp/基础组件.md`);
  const job: DomainKnowledgeJob = { id: "archive-real-git", component_research_id: "cr-five-days", issue_no: "DTS1", title: formal.title, scope: "组件", operator: "author", created_at: new Date().toISOString(),
    knowledge_layout: "directory-v1", knowledge_target: target, repositories: [], status: "done", stage: "已发布", revisions: {}, material_ids: [], turns: [], evidence: [], publications: [],
    documents: files.map(file => ({ ...file, target_id: target.id, layer: "domain", revision: 1, selected: true, sources: "正式知识", history: [], base_content: null, base_revision: "",
      knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 })) };
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => "https://example.test/platform", credential: () => ({ username: "author", password: "fixture", email: "test@example.test" }) });
  const mr = mock.method(publisher as any, "openMr", async (_job: unknown, _target: unknown, publication: any) => ({ ...publication, state: "opened", url: "https://example.test/mr/1" }));
  try {
    const result = await publisher.publish(job, target, undefined, "author", () => {});
    for (const file of files) assert.equal(git("--git-dir", remote, "show", `${result.revision}:${file.path}`), file.content);
    const paths = git("-c", "core.quotePath=false", "--git-dir", remote, "ls-tree", "-r", "--name-only", result.revision!).trim().split("\n");
    assert.ok(paths.includes(`${target.docs_path}/AGENTS.md`));
    assert.ok(paths.every(path => path === "source.cpp" || path.startsWith(`${target.docs_path}/`)));
    assert.equal(paths.filter(path => path.endsWith(".md")).length, files.length + 1);
    job.documents[1].content += "\n未经发布的修改\n";
    await assert.rejects(publisher.publish(job, target, undefined, "author", () => {}), /正式版本不一致/);
    assert.equal(mr.mock.callCount(), 1);
  } finally { mr.mock.restore(); await publisher.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
