import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentResearch, researchSourceRepositories, type ResearchExecution } from "../src/componentResearch.ts";
import { ComponentResearchPipeline } from "../src/componentResearchPipeline.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import { collectSearchableKnowledge } from "../src/knowledgeSearch.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { fixtureCaller, fixtureEvidence, fixtureUnitTest, recordFixtureEvidence, usageContent } from "./componentPipelineFixture.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("等待组件研究状态超时");
    await new Promise(done => setTimeout(done, 5));
  }
};
const waitForAbort = async (signal: AbortSignal) => {
  if (!signal.aborted) await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
  signal.throwIfAborted();
};
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "component-incremental-drafts-"));
  createTechnologyStack(dir, { name: "C++" }, "fixture");
  const source = saveComponentRepository(dir, { name: "参考来源", repository: "https://code.example/reference.git", branch: "main", path: "src", languages: ["cpp"] }, "fixture");
  return { dir, source };
};

test("组件研究过程文稿：计划先可见、等待评审可读、未写结果不造文稿，读取不改记录且重启可恢复", async () => {
  const { dir, source } = fixture();
  const inventoryStarted = deferred(), inventoryRelease = deferred(), planReviewStarted = deferred(), planReviewRelease = deferred();
  const research = new ComponentResearch(dir, async input => {
    input.update({ format: "joint-document", document: { overview: "", sections: [] } });
    const pipeline = new ComponentResearchPipeline(join(input.root, "pipeline.json"), "incremental-fixture", [source.id]);
    await pipeline.run({ signal: input.signal, concurrency: 1,
      execute: async task => {
        if (task.phase === "inventory") {
          inventoryStarted.resolve();
          await inventoryRelease.promise;
          return { findings: "盘点得到文件操作、数据库操作和 P2P 通信三项功能能力。", open_questions: [], components: [
            { id: "file-operations", title: "文件操作", repository_ids: [source.id], scope: "读取和关闭文件" },
            { id: "database-operations", title: "数据库操作", repository_ids: [source.id], scope: "数据库连接与事务" },
            { id: "p2p", title: "P2P 通信", repository_ids: [source.id], scope: "发现节点并收发数据" },
          ] };
        }
        if (task.id === "plan-file-operations") return { findings: "文件操作先初始化句柄，再关闭并检查状态。", open_questions: [],
          paradigms: [{ id: "close-file", title: "关闭文件句柄", need: "释放文件句柄" }] };
        await waitForAbort(input.signal);
        throw new Error("本次验证不会继续萃取");
      },
      review: async task => {
        if (task.id === "plan-file-operations") { planReviewStarted.resolve(); await planReviewRelease.promise; }
        return undefined;
      },
      changed: pipeline => input.update({ pipeline }),
    });
    return "组件研究完整文稿";
  });
  let reloaded: ComponentResearch | undefined;
  try {
    const started = research.start({ language: "cpp" }, "alice");
    await inventoryStarted.promise;
    const pending = research.get(started.id);
    assert.deepEqual(pending.work_documents, [], "尚未保存结果的进行中任务没有虚构过程文稿");
    assert.equal(pending.production?.navigation.ready_action_label, undefined);
    inventoryRelease.resolve();
    await planReviewStarted.promise;
    const reviewing = research.get(started.id);
    assert.equal(reviewing.status, "running");
    assert.deepEqual(reviewing.document?.sections, [], "目录和计划不能混入正式用法章节");
    assert.equal(reviewing.work_documents?.length, 2);
    assert.ok(reviewing.work_documents?.some(document => document.id === "inventory" && /文件操作/.test(document.content) && /数据库操作/.test(document.content) && /数据库连接与事务/.test(document.content)), "盘点结果包含结论与结构化功能目录");
    const plan = reviewing.work_documents?.find(document => document.id === "plan-file-operations");
    assert.ok(plan && /文件操作先初始化/.test(plan.content) && /关闭文件句柄/.test(plan.content), "作者保存后的计划无需等评审完成即可读取");
    assert.equal(plan.status_label, "研究中");
    assert.ok(!reviewing.work_documents?.some(document => document.id === "plan-database-operations" || document.id === "plan-p2p"));
    assert.equal(reviewing.production?.navigation.ready_action_label, "查看文稿");
    assert.ok(!reviewing.production?.research_actions.some(action => action.id === "publish"));
    assert.ok(!projectKnowledgeProduction({ kind: "component", record: { ...reviewing, status: "done" } }).research_actions.some(action => action.id === "publish"), "只有过程文稿时，即使研究结束也不能出现发布入口");
    assert.equal(reviewing.production?.knowledge_document_id, undefined);
    assert.throws(() => research.publish(started.id, {} as never, "alice"), /等待组件草稿完成/);

    const path = join(dir, "component-research", started.id, "record.json");
    const before = readFileSync(path, "utf8"), modified = statSync(path).mtimeMs;
    assert.deepEqual(research.list().find(record => record.id === started.id)?.work_documents, reviewing.work_documents);
    reviewing.work_documents![0].content = "调用方不能改内存记录";
    assert.notEqual(research.get(started.id).work_documents![0].content, "调用方不能改内存记录");
    assert.equal(readFileSync(path, "utf8"), before, "get/list 仅派生展示数据，不写磁盘");
    assert.equal(statSync(path).mtimeMs, modified);
    assert.equal(JSON.parse(before).work_documents, undefined, "过程文稿仍从已持久化的 pipeline 结果派生");
    assert.equal(collectSearchableKnowledge(dir, { repo: "", repositories: [], moduleIds: [] }).assets.length, 0, "过程文稿不进入正式知识消费");

    planReviewRelease.resolve();
    await until(() => research.get(started.id).pipeline?.tasks.find(task => task.id === "plan-file-operations")?.status === "done");
    const completedPlan = research.get(started.id).work_documents!.find(document => document.id === "plan-file-operations")!;
    assert.match(completedPlan.status_label, /通过|完成/);
    await research.shutdown();
    reloaded = new ComponentResearch(dir, async input => { await waitForAbort(input.signal); return ""; });
    const restored = reloaded.get(started.id);
    assert.deepEqual(restored.work_documents, research.get(started.id).work_documents);
    assert.deepEqual(restored.document?.sections, []);
    assert.equal(restored.production?.navigation.ready_action_label, "查看文稿");
    assert.equal(reloaded.warnings().length, 0);
  } finally {
    inventoryRelease.resolve(); planReviewRelease.resolve();
    await research.shutdown();
    await reloaded?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("组件研究已保存契约和完整用法即时可读，不必等待导航和概述汇总", async () => {
  const { dir, source } = fixture();
  const contractsSaved = deferred(), writeUsage = deferred(), usageSaved = deferred();
  const research = new ComponentResearch(dir, async (input: ResearchExecution) => {
    input.update({ format: "joint-document", document: { overview: "", sections: [] } });
    const ids = researchSourceRepositories(input.record).map(repository => repository.id);
    const evidence = fixtureEvidence(source.id);
    recordFixtureEvidence(input);
    const metadata = { component: "file-operations", language: "cpp", status: "recommended" as const, need: "释放文件句柄", api: ["Close"], applicability: "当前文件句柄实现", replaces: { identifiers: [], imports: [], patterns: [] }, evidence: [evidence.reference], usage_evidence: [evidence.usageId], test_evidence: [evidence.testId], open_questions: [] };
    input.editDocument!({ action: "outline", entries: [{ id: "contracts-file", title: "文件操作契约", repository_ids: ids }] });
    input.editDocument!({ action: "section", section: { id: "contracts-file", title: "文件操作契约", repository_ids: ids, content: "Close 修改句柄的关闭状态。", interfaces: "", integration: "", example: "", unit_tests: "", sources: "", related_ids: [], paradigm: { ...metadata, kind: "contracts" } } });
    contractsSaved.resolve();
    await writeUsage.promise;
    input.editDocument!({ action: "outline", entries: [{ id: "close-file", title: "关闭文件句柄", repository_ids: ids }] });
    input.editDocument!({ action: "section", section: { id: "close-file", title: "关闭文件句柄", repository_ids: ids, content: usageContent("不再使用文件时关闭句柄。"), interfaces: "Close(Handle& handle) 设置 closed 为 true。", integration: "包含 file.h，链接 libfile.so。", example: "```cpp\n" + fixtureCaller + "```", unit_tests: "```cpp\n" + fixtureUnitTest + "```", sources: "", related_ids: [], paradigm: { ...metadata, kind: "paradigm" } } });
    usageSaved.resolve();
    await waitForAbort(input.signal);
    return "完整用法";
  });
  try {
    const started = research.start({ language: "cpp" }, "alice");
    await contractsSaved.promise;
    const contract = research.get(started.id);
    assert.equal(contract.status, "running");
    assert.equal(contract.document?.overview, "");
    assert.equal(contract.document?.sections[0].content, "Close 修改句柄的关闭状态。");
    assert.equal(contract.production?.navigation.ready_action_label, "查看文稿");
    writeUsage.resolve();
    await usageSaved.promise;
    const usage = research.get(started.id);
    assert.equal(usage.status, "running");
    assert.equal(usage.document?.overview, "");
    assert.equal(usage.document?.sections.length, 2);
    assert.match(usage.draft!, /## 关闭文件句柄/);
    assert.match(usage.draft!, /单元测试示例/);
    const saved = JSON.parse(readFileSync(join(dir, "component-research", started.id, "record.json"), "utf8"));
    assert.deepEqual(saved.document, usage.document);
    assert.equal(saved.draft, usage.draft);
    assert.throws(() => research.publish(started.id, {} as never, "alice"), /等待组件草稿完成/);
  } finally {
    writeUsage.resolve();
    await research.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
