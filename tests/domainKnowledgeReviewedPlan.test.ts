import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { type DomainAgentOptions } from "../src/domainKnowledgeAgent.ts";
import { runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";
import { domainExecutionContract, workOverview, pageRows, runnableWave } from "../src/domainKnowledgeExecution.ts";

const document = (id: string, content = "# 规则\n未结算取消才释放库存。") => ({ id, title: id, target_id: "domain", path: `docs/业务知识/${id}.md`, layer: "domain" as const, content, sources: "本次资料中的取消规则" });
const step = (id: string, depends_on: string[] = []) => ({ id, title: id, instructions: "按模板生成并核对取消规则", depends_on, readonly: false,
  expected_document_ids: [id], review: { instructions: "独立核对当前文稿的条件与依据" } });
type Call = (name: string, args: any, expectedError?: boolean) => Promise<any>;

async function fixture(handler: (context: any, call: Call, config: any) => Promise<void>, source?: DomainAgentOptions["source"], repositories: any[] = [], nextTurn?: Parameters<DomainKnowledgeExtraction["run"]>[1]) {
  const root = mkdtempSync(join(tmpdir(), "domain-reviewed-plan-"));
  const method = { "SKILL.md": "---\nname: reviewed-documents\ndescription: 完整规划并逐篇核对。\nexecution: reviewed-document-plan\n---\n生成全部已规划文稿。" };
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call: Call = async (name, args, expectedError = false) => {
        const response = await config.extraTools.find((tool: any) => tool.name === name).execute("test", args, new AbortController().signal);
        assert.equal(!!response.isError, expectedError, `${name}: ${JSON.stringify(response)}`);
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      await handler(context, call, config);
      return { status: "turn_finished" };
    }, startResume: async () => { throw new Error("本用例应保存结果或暂停"); }, dispose() {}, abort: async () => {},
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(method, input, { dataDir: root,
    model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: source ?? (async () => { throw new Error("本用例不访问源码"); }) }));
  try {
    const job = service.create({ title: "业务知识", scope: "完整研究", issue_no: "REQ-475", repositories }, "tester");
    const wait = async () => {
      for (let attempt = 0; attempt < 1000 && !["done", "failed", "paused"].includes(service.get(job.id).status); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    };
    await wait();
    if (nextTurn) {
      assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
      service.run(job.id, nextTurn, "tester");
      await wait();
    }
    return service.get(job.id);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
}

test("可靠文稿方法不能用一篇直接完成绕过计划；普通方法不按名字或附件猜执行方式", async () => {
  assert.equal(domainExecutionContract({ "SKILL.md": "---\nname: business-docs-generator\n---\n" }), undefined);
  assert.throws(() => domainExecutionContract({ "SKILL.md": "---\nexecution: unknown\n---\n" }), /不支持/);
  const job = await fixture(async (context, call) => {
    assert.equal(context.step, undefined);
    await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整清单", content: "需要第一篇、第二篇及独立评审" } });
    await call("knowledge_draft", { action: "save", document: document("one") });
    const rejected = await call("knowledge_work_result", { summary: "全部完成", document_ids: ["one"] }, true);
    assert.match(rejected.error, /完整文稿计划/);
    await call("knowledge_work_result", { status: "paused", summary: "规划尚未落实，已有第一篇草稿", document_ids: ["one"] });
  });
  assert.equal(job.status, "paused", job.error);
});

test("已登记计划串行生成全部文稿，独立评审必须回读，退回后修订再审", async () => {
  const writes = new Map<string, number>(), reviews = new Map<string, number>(), directories: string[] = [];
  const job = await fixture(async (context, call, config) => {
    directories.push(config.workspace);
    assert.equal(config.resumeSession, true);
    assert.match(config.additionalSystemInstructions.join("\n"), /平台研究执行方式/);
    if (!context.step) {
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: "one、two 两篇文稿" } });
      await call("knowledge_work", { action: "plan", document_ids: ["one", "two"], work_document_id: "plan" });
      await call("knowledge_work", { action: "schedule", steps: [step("one"), step("two", ["one"])] });
      const result = await call("knowledge_work", { action: "run" });
      assert.equal(result.complete, true);
      assert.equal(result.counts.done, 2);
      await call("knowledge_work_result", { summary: "两篇已独立核对", document_ids: ["one", "two"] });
    } else if (context.reviewing) {
      const id = context.step.id;
      reviews.set(id, (reviews.get(id) ?? 0) + 1);
      const rejected = await call("knowledge_work_result", { summary: "评审", document_ids: [id], review: { pass: true, feedback: "声称已核对" } }, true);
      assert.match(rejected.error, /当前完整正文/);
      const draft = await call("knowledge_draft", { action: "read", id });
      const pass = draft.content.includes("未结算");
      await call("knowledge_work_result", { summary: "核对条件", document_ids: [id], review: { pass, feedback: pass ? "已读当前正文，取消条件正确" : "取消需要限定未结算，请补上适用条件" } });
    } else {
      const id = context.step.id;
      writes.set(id, (writes.get(id) ?? 0) + 1);
      const firstIncorrect = id === "one" && writes.get(id) === 1;
      if (id === "one" && writes.get(id)! > 1) assert.match(context.step.error, /未结算/);
      await call("knowledge_draft", { action: "save", document: document(id, firstIncorrect ? "# 规则\n取消时释放库存。" : undefined) });
      await call("knowledge_work_result", { summary: "已保存文稿", document_ids: [id] });
    }
  });
  assert.equal(job.status, "done", job.error);
  assert.equal(job.documents.length, 2);
  assert.equal(writes.get("one"), 2); assert.equal(reviews.get("one"), 2);
  assert.equal(writes.get("two"), 1); assert.equal(reviews.get("two"), 1);
  assert.ok(directories.some(path => path.endsWith("/writer")));
  assert.ok(directories.some(path => path.includes("/review-")));
});

test("源码准备失败可重试；显式跨仓扫描提供跨仓依赖候选", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-dependencies-"));
  const revisions: Record<string, string> = {};
  for (const name of ["one", "two"]) {
    const dir = join(root, name); mkdirSync(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies: name === "one" ? { two: "1.0.0" } : {} }));
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture");
    revisions[name] = git("rev-parse", "HEAD");
  }
  let failed = false;
  try {
    const job = await fixture(async (_context, call) => {
      await call("component_source", { repository_id: "repo-1", action: "read", path: "package.json" }, true);
      assert.match(await call("component_source", { repository_id: "repo-1", action: "read", path: "package.json" }), /one/);
      const local = await call("knowledge_structure", { repository_id: "repo-1" });
      assert.equal(local.cross_repository_dependencies_scanned, false);
      const cross = await call("knowledge_structure", { repository_id: "repo-1", include_dependencies: true });
      assert.equal(cross.cross_repository_dependencies_scanned, true);
      assert.deepEqual(cross.dependency_edges.map((edge: any) => [edge.from, edge.to]), [["repo-1:package.json", "repo-2:package.json"]]);
      await call("knowledge_work_result", { status: "paused", summary: "仅验证源码准备及跨仓关系", document_ids: [] });
    }, async repository => {
      if (!failed) { failed = true; throw new Error("临时源码准备失败"); }
      const name = repository.id === "repo-1" ? "one" : "two";
      return { root: join(root, name), revision: revisions[name] };
    }, [{ name: "one", repository: "https://example.test/one.git", branch: "main" }, { name: "two", repository: "https://example.test/two.git", branch: "main" }]);
    assert.equal(job.status, "paused", job.error);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("完整计划独立于已调度步骤，漏排项不能伪装完成；明确排除可保留范围说明", async () => {
  const job = await fixture(async (context, call) => {
    if (!context.step) {
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: "需要 one 与 two 文稿" } });
      await call("knowledge_work", { action: "plan", document_ids: ["one", "two"], work_document_id: "plan" });
      await call("knowledge_work", { action: "schedule", steps: [step("one")] });
      await call("knowledge_work", { action: "run" });
      const rejected = await call("knowledge_work_result", { summary: "已排的都完成", document_ids: ["one"] }, true);
      assert.match(rejected.error, /two/);
      await call("knowledge_work", { action: "plan", document_ids: ["one"], work_document_id: "plan" }, true);
      await call("knowledge_work", { action: "plan", document_ids: ["one"], work_document_id: "plan", exclusions: [{ document_id: "two", reason: "用户范围不包含此归档仓" }] });
      assert.equal((await call("knowledge_work", { action: "read_plan" })).exclusions.items[0].document_id, "two");
      await call("knowledge_work_result", { summary: "one 完成；two 因用户范围排除，见规划说明", document_ids: ["one"] });
    } else if (context.reviewing) {
      await call("knowledge_draft", { action: "read", id: "one" });
      await call("knowledge_work_result", { summary: "核对完成", document_ids: ["one"], review: { pass: true, feedback: "适用条件完整" } });
    } else {
      await call("knowledge_draft", { action: "save", document: document("one") });
      await call("knowledge_work_result", { summary: "文稿已保存", document_ids: ["one"] });
    }
  });
  assert.equal(job.status, "done", job.error);
});

test("独立子任务有限并发，隔离写入与过程笔记；依赖在完成后执行", async () => {
  let active = 0, peak = 0;
  const done = new Set<string>();
  const job = await fixture(async (context, call) => {
    if (!context.step) {
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: "one two three，four 依赖前三篇" } });
      await call("knowledge_work", { action: "plan", document_ids: ["one", "two", "three", "four"], work_document_id: "plan" });
      await call("knowledge_work", { action: "schedule", steps: [step("one"), step("two"), step("three"), step("four", ["one", "two", "three"])] });
      const running = call("knowledge_work", { action: "run", concurrency: 3 });
      await call("knowledge_work", { action: "schedule", steps: [step("race")] }, true);
      await call("knowledge_draft", { action: "save", document: document("one", "并发覆盖") }, true);
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "并发覆盖", content: "不能覆盖" } }, true);
      await call("knowledge_work_result", { summary: "过早提交", document_ids: [] }, true);
      const completed = await running;
      assert.equal(completed.complete, true);
      assert.equal(completed.counts.done, 4);
      await call("knowledge_work_result", { summary: "四篇完成", document_ids: [...done] });
    } else {
      const id = context.step.id;
      if (context.reviewing) {
        await call("knowledge_draft", { action: "read", id });
        await call("knowledge_work_result", { summary: "核对完成", document_ids: [id], review: { pass: true, feedback: "已核对当前正文" } });
        done.add(id);
      } else {
        active++; peak = Math.max(peak, active);
        if (id === "four") assert.equal(done.size, 3);
        await call("knowledge_draft", { action: "save", document: document("outside") }, true);
        await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "覆盖主规划", content: "不能覆盖" } }, true);
        await call("knowledge_work", { action: "save_document", document: { id: `${id}--evidence`, title: "依据", content: "保留当前步骤证据" } });
        await new Promise(resolve => setTimeout(resolve, 30));
        await call("knowledge_draft", { action: "save", document: document(id) });
        await call("knowledge_work_result", { summary: "已保存", document_ids: [id] });
        active--;
      }
    }
  });
  assert.equal(job.status, "done", job.error);
  assert.equal(peak, 3);
});

test("大计划上下文有界，分页无遗漏，不把历史正文与大数据复制到协调上下文", () => {
  const steps = Array.from({ length: 1200 }, (_, i) => ({ ...step(`doc-${i}`), status: i < 1150 ? "done" as const : "pending" as const,
    attempts: 1, result: { summary: "已研究".repeat(1000), document_ids: [`doc-${i}`], data: "历史数据".repeat(10000) } }));
  const overview = workOverview({ version: 1, skill: "fixture", steps, plan: { document_ids: steps.map(step => step.id), work_document_id: "plan" },
    documents: [{ id: "plan", title: "完整规划", content: "超长规划正文".repeat(100000) }] });
  assert.equal(overview.total, 1200); assert.equal(overview.counts.done, 1150); assert.equal(overview.steps.length, 30);
  assert.equal(overview.plan?.total, 1200);
  assert.ok(JSON.stringify(overview).length < 50000);
  assert.ok(!JSON.stringify(overview).includes("历史数据"));
  const received: string[] = [];
  for (let start: number | undefined = 0; start !== undefined;) {
    const page = pageRows(steps.map(step => step.id), start, 100, "document_ids");
    received.push(...page.document_ids as string[]); start = page.next_start as number | undefined;
  }
  assert.deepEqual(received, steps.map(step => step.id));
});


test("已完成文稿重评与依赖它的后续步骤不在同一并发批次", () => {
  const a = { ...step("a"), status: "done" as const, attempts: 1 }, b = { ...step("b", ["a"]), status: "pending" as const, attempts: 0 };
  assert.deepEqual(runnableWave([a, b], new Set(), 3).map(step => step.id), ["a"]);
  assert.deepEqual(runnableWave([a, b], new Set(["a"]), 3).map(step => step.id), ["b"]);
  assert.equal(runnableWave([b, a], new Set(), 3).length, 1);
});

const diagramMissingEnd = "# 取消规则\n```plantuml\n@startuml\nAlice -> Bob : 取消\n```";

for (const mode of ["revise", "update"] as const) test(`${mode} 省略结果文稿编号仍不能绕过本轮已保存修改的图校验`, async () => {
  const job = await fixture(async (context, call) => {
    if (context.mode !== "extract") {
      assert.equal(context.mode, mode); assert.equal(context.step, undefined);
      const original = await call("knowledge_draft", { action: "read", id: "one" });
      assert.equal(original.content, document("one").content, "修改前完整回读当前正文，随后验证遗漏结果编号仍不能绕过图校验");
      await call("knowledge_draft", { action: "save", document: document("one", diagramMissingEnd) });
      const diagnostic = await call("knowledge_diagram_check", { document_id: "one" });
      assert.equal(diagnostic.document_id, "one"); assert.equal(diagnostic.status, "invalid");
      assert.equal(diagnostic.total, 1); assert.equal(diagnostic.checked, 1);
      const rejected = await call("knowledge_work_result", { summary: "已修改完成但漏报文稿", document_ids: [] }, true);
      assert.match(rejected.error, /one/); assert.match(rejected.error, /@enduml/);
      await call("knowledge_work_result", { status: "paused", summary: "候选图缺少结束标记，尚未完成修订", document_ids: [] });
    } else if (!context.step) {
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: "生成 one 并独立核对" } });
      await call("knowledge_work", { action: "plan", document_ids: ["one"], work_document_id: "plan" });
      await call("knowledge_work", { action: "schedule", steps: [step("one")] });
      await call("knowledge_work", { action: "run" });
      await call("knowledge_work_result", { summary: "第一版完整", document_ids: ["one"] });
    } else if (context.reviewing) {
      await call("knowledge_draft", { action: "read", id: "one" });
      await call("knowledge_work_result", { summary: "当前正文已核对", document_ids: ["one"], review: { pass: true, feedback: "适用条件正确" } });
    } else {
      await call("knowledge_draft", { action: "save", document: document("one") });
      await call("knowledge_work_result", { summary: "第一版已保存", document_ids: ["one"] });
    }
  }, undefined, [], { mode, document_ids: ["one"], message: "补充取消流程图" });
  assert.equal(job.status, "paused", job.error);
  assert.equal(job.turns.at(-1)?.mode, mode);
  assert.equal(job.turns.at(-1)?.proposals[0].document.content, diagramMissingEnd, "失败校验保留修订候选");
  assert.equal(job.documents[0].content, document("one").content, "尚未审阅的修订不覆盖原正文");
});

test("过程规划可以显式检查图，坏图阻止登记计划及修改规划后的完成", async () => {
  const job = await fixture(async (context, call) => {
    if (!context.step) {
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: diagramMissingEnd } });
      await call("knowledge_diagram_check", {}, true);
      await call("knowledge_diagram_check", { document_id: "one", work_document_id: "plan" }, true);
      const diagnostic = await call("knowledge_diagram_check", { work_document_id: "plan" });
      assert.equal(diagnostic.work_document_id, "plan"); assert.equal(diagnostic.status, "invalid");
      assert.equal(diagnostic.total, 1); assert.equal(diagnostic.checked, 1);
      assert.match(diagnostic.diagrams[0].error, /@enduml/);
      const rejected = await call("knowledge_work", { action: "plan", document_ids: ["one"], work_document_id: "plan" }, true);
      assert.match(rejected.error, /plan/); assert.match(rejected.error, /@enduml/);
      assert.equal(await call("knowledge_work", { action: "read_plan" }), null);
      assert.equal((await call("knowledge_work", { action: "read_document", id: "plan" })).content, diagramMissingEnd);
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: "生成 one 并独立核对" } });
      const corrected = await call("knowledge_diagram_check", { work_document_id: "plan" });
      assert.equal(corrected.status, "valid"); assert.equal(corrected.total, 0);
      assert.notEqual(corrected.fingerprint, diagnostic.fingerprint, "图诊断对应实际过程正文版本");
      await call("knowledge_work", { action: "plan", document_ids: ["one"], work_document_id: "plan" });
      await call("knowledge_work", { action: "schedule", steps: [step("one")] });
      await call("knowledge_work", { action: "run" });
      await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: diagramMissingEnd } });
      const unfinished = await call("knowledge_work_result", { summary: "文稿完成但规划图损坏", document_ids: ["one"] }, true);
      assert.match(unfinished.error, /plan/); assert.match(unfinished.error, /@enduml/);
      await call("knowledge_work_result", { status: "paused", summary: "规划图仍需修正，完整过程正文已保留", document_ids: ["one"], work_document_ids: ["plan"] });
    } else if (context.reviewing) {
      await call("knowledge_draft", { action: "read", id: "one" });
      await call("knowledge_work_result", { summary: "已核对当前正文", document_ids: ["one"], review: { pass: true, feedback: "文稿完整且适用条件正确" } });
    } else {
      await call("knowledge_draft", { action: "save", document: document("one") });
      await call("knowledge_work_result", { summary: "已保存文稿", document_ids: ["one"] });
    }
  });
  assert.equal(job.status, "paused", job.error);
  assert.deepEqual(job.turns.at(-1)?.waiting?.work_document_ids, ["plan"]);
});
