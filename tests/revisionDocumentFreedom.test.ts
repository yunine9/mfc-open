import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { searchDomainKnowledgeDocuments } from "../src/domainKnowledgeDocumentSearch.ts";
import { domainDocumentFingerprint } from "../src/domainKnowledgeExecution.ts";
import type { DomainDocument } from "../src/domainKnowledgeTypes.ts";
import { DomainSkillWork } from "../src/domainSkillWork.ts";

const draft = (id: string, content = `# ${id}\n未结算取消才释放库存。`) => ({ id, title: id, target_id: "domain", path: `docs/取消业务/${id}.md`, layer: "domain" as const, content, sources: "用户提供的取消规则" });
const step = (id: string) => ({ id, title: id, instructions: "按意见修改重点文稿及关联文稿", depends_on: [], readonly: false,
  expected_document_ids: [id], review: { instructions: "回读本步骤实际修改的全部文稿与来源，核对适用范围及删除理由" } });
type Call = (name: string, args: any, expectedError?: boolean) => Promise<any>;

async function fixture(ids: string[], handler: (context: any, call: Call) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "revision-freedom-"));
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call: Call = async (name, args, expectedError = false) => {
        const response = await config.extraTools.find((tool: any) => tool.name === name).execute("test", args, new AbortController().signal);
        assert.equal(!!response.isError, expectedError, `${name}: ${JSON.stringify(response)}`);
        try { return JSON.parse(response.content[0].text); } catch { return { error: response.content[0].text }; }
      };
      await handler(context, call); return { status: "turn_finished" };
    }, startResume: async () => { throw new Error("测试应提交结果"); }, dispose() {}, abort: async () => {},
  }) as any);
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      for (const id of ids) input.save(draft(id, id === "obsolete" ? "# 旧文稿\n```plantuml\n@startuml\nA -> B\n```" : undefined));
      return { summary: "已有多日研究成果", document_ids: ids };
    }
    return runDomainKnowledge(input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
      source: async () => { throw new Error("修订复用已有成果，不应重跑来源准备"); } });
  });
  const wait = async (id: string) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (!["queued", "running"].includes(service.get(id).status)) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("修订未结束");
  };
  try {
    const job = service.create({ title: "取消业务", scope: "未结算取消才释放库存", issue_no: "REV-1", repositories: [] }, "reviewer");
    await wait(job.id); assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    service.run(job.id, { mode: "revise", document_ids: [ids[0]], message: "统一取消术语和目录，必要时拆分、删除重复稿，关联文稿一起修订" }, "reviewer");
    await wait(job.id); return service.get(job.id);
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
}

test("200 篇文稿的字面检索有界分页，按任一关键词搜索正文及来源，不输出全文", () => {
  const documents = Array.from({ length: 205 }, (_, index) => ({ ...draft(`doc-${index}`, "无关正文".repeat(2000) + `\n统一术语-${index}\n` + "更多正文".repeat(1000)),
    revision: 1, selected: true, base_content: null, base_revision: "", history: [] } satisfies DomainDocument));
  const ids: string[] = [];
  for (let start: number | undefined = 0; start !== undefined;) {
    const page = searchDomainKnowledgeDocuments(documents, { query: "统一术语-", start, limit: 100 });
    assert.equal(page.total, 205); assert.ok(page.documents.length <= 100);
    assert.ok(JSON.stringify(page).length < 45_000, "摘要不包含完整正文");
    assert.ok(!JSON.stringify(page).includes("无关正文"));
    ids.push(...page.documents.map(document => document.id)); start = page.next_start;
  }
  assert.deepEqual(ids, documents.map(document => document.id));
  assert.equal(searchDomainKnowledgeDocuments(documents, { keywords: ["不命中", "用户提供的取消规则"] }).total, 205);
  assert.equal(searchDomainKnowledgeDocuments(documents, { query: "统一术语-204" }).documents[0].id, "doc-204");
  assert.throws(() => searchDomainKnowledgeDocuments(documents, { query: " ", keywords: ["取消"] }), /只填写一种/);
  assert.throws(() => searchDomainKnowledgeDocuments(documents, { query: " " }), /非空/);
});

test("修订可跨初选与步骤清单修改、移动、新增、删除，实际写集自动独立评审且不发布原稿", async () => {
  let reviewed: string[] = [];
  const job = await fixture(["one", "two", "obsolete"], async (context, call) => {
    assert.equal(context.mode, "revise");
    if (!context.step) {
      const found = await call("knowledge_draft", { action: "search", keywords: ["取消"] });
      assert.equal(found.total, 3);
      await call("knowledge_work", { action: "schedule", steps: [step("one")] });
      const batch = await call("knowledge_work", { action: "run" });
      assert.equal(batch.complete, true);
      await call("knowledge_work_result", { summary: "关联稿及删除草稿均已核对，等待人工审阅", document_ids: ["one"] });
    } else if (context.reviewing) {
      const forbidden = await call("knowledge_draft", { action: "delete", id: "two" }, true);
      assert.match(forbidden.error, /只读/);
      assert.equal((await call("knowledge_draft", { action: "search", query: "拆出的相关规则" })).total, 1);
      const missing = await call("knowledge_work_result", { summary: "只核对重点稿", document_ids: ["one"], review: { pass: true, feedback: "假定其他未改" } }, true);
      assert.match(missing.error, /完整正文/);
      reviewed = context.step.document_ids;
      assert.deepEqual(new Set(reviewed), new Set(["one", "two", "split", "obsolete"]));
      for (const id of reviewed) {
        const current = await call("knowledge_draft", { action: "read", id });
        if (id === "obsolete") {
          assert.equal(current.deleted, true);
          const diagram = await call("knowledge_diagram_check", { document_id: id });
          assert.equal(diagram.status, "valid"); assert.equal(diagram.total, 0);
        }
      }
      await call("knowledge_work_result", { summary: "关联文稿和删除理由均已核对", document_ids: reviewed, review: { pass: true, feedback: "实际写集四篇已回读；旧稿是重复内容，删除待人工确认" } });
    } else {
      await call("knowledge_draft", { action: "read", id: "one" });
      await call("knowledge_draft", { action: "read", id: "two" });
      await call("knowledge_draft", { action: "read", id: "obsolete" });
      await call("knowledge_draft", { action: "save", document: draft("one", "# 统一取消规则\n仍限未结算订单。") });
      await call("knowledge_draft", { action: "save", document: { ...draft("two", "# 关联导航\n见 [拆分稿](split.md)。"), path: "docs/取消业务/navigation.md" } });
      await call("knowledge_draft", { action: "save", document: draft("split", "# 拆出的相关规则\n仍限未结算订单。") });
      await call("knowledge_draft", { action: "delete", id: "obsolete" });
      await call("knowledge_work_result", { summary: "已修改并拆分关联稿，旧重复稿建议删除", document_ids: ["one"] });
    }
  });
  assert.equal(job.status, "done", job.error); assert.equal(reviewed.length, 4);
  assert.equal(job.documents.find(document => document.id === "two")?.path, "docs/取消业务/two.md", "原路径等待人工采纳建议");
  assert.equal(job.turns.at(-1)?.proposals.find(proposal => proposal.document.id === "two")?.document.path, "docs/取消业务/navigation.md");
  assert.equal(job.documents.find(document => document.id === "obsolete")?.deleted, true);
  assert.equal(job.documents.find(document => document.id === "obsolete")?.history.length, 1);
  assert.ok(job.documents.every(document => !document.knowledge_document_id), "修订未发布正式知识");
});

test("并发关联修改不覆盖：活跃写集阻止冲突，结束后旧读取仍需回读，新版本再次评审", async () => {
  let sawFirstRead!: () => void, sawSecondRead!: () => void, firstReviewed!: () => void;
  const firstRead = new Promise<void>(resolve => sawFirstRead = resolve), secondRead = new Promise<void>(resolve => sawSecondRead = resolve),
    firstDone = new Promise<void>(resolve => firstReviewed = resolve);
  let firstReviews = 0, firstWrites = 0;
  const job = await fixture(["one", "two", "shared"], async (context, call) => {
    if (!context.step) {
      await call("knowledge_work", { action: "schedule", steps: [step("one"), step("two")] });
      const batch = await call("knowledge_work", { action: "run", concurrency: 2 });
      assert.equal(batch.complete, true);
      const current = await call("knowledge_draft", { action: "read", id: "shared" });
      assert.match(current.content, /第一项修改/); assert.match(current.content, /第二项修改/);
      await call("knowledge_work_result", { summary: "并发关联稿已整合，所有版本已评审", document_ids: ["one", "two", "shared"] });
    } else if (context.reviewing) {
      for (const id of context.step.document_ids) await call("knowledge_draft", { action: "read", id });
      await call("knowledge_work_result", { summary: "当前实际改动已核对", document_ids: context.step.document_ids, review: { pass: true, feedback: "当前完整正文保留适用条件及两步修改" } });
      if (context.step.id === "one" && ++firstReviews === 1) firstReviewed();
    } else if (context.step.id === "one") {
      firstWrites++;
      await call("knowledge_draft", { action: "read", id: "shared" }); sawFirstRead(); await secondRead;
      await call("knowledge_draft", { action: "save", document: draft("shared", "# 共享规则\n第一项修改。") });
      await call("knowledge_work_result", { summary: "第一项关联修改已保存", document_ids: ["one"] });
    } else {
      await firstRead;
      await call("knowledge_draft", { action: "read", id: "shared" });
      // 第一作者必须仍处于写作阶段，才能稳定覆盖活跃写集保护分支。
      const firstSaved = call("knowledge_draft", { action: "save", document: draft("one", "越过其他步骤预定稿") }, true);
      assert.match((await firstSaved).error, /并发修改/); sawSecondRead();
      await firstDone;
      // 评审会话已保存结果，作者所属 work.run 可能尚在返回，因此等待一个事件循环。
      await new Promise(resolve => setTimeout(resolve, 0));
      const stale = await call("knowledge_draft", { action: "save", document: draft("shared", "# 共享规则\n第二项覆盖旧稿。") }, true);
      assert.match(stale.error, /变化.*回读/);
      const current = await call("knowledge_draft", { action: "read", id: "shared" });
      await call("knowledge_draft", { action: "save", document: draft("shared", current.content + "\n第二项修改。") });
      await call("knowledge_work_result", { summary: "第二项读取新版本后整合", document_ids: ["two"] });
    }
  });
  assert.equal(job.status, "done", job.error); assert.equal(firstWrites, 1); assert.equal(firstReviews, 2, "第一项旧评审不能覆盖后来修改的正文");
});

test("删除状态纳入版本指纹，保留原文以支持独立评审删除建议", () => {
  const document: DomainDocument = { ...draft("obsolete"), revision: 1, selected: true, base_content: null, base_revision: "", history: [] };
  const original = domainDocumentFingerprint([document], [document.id]);
  assert.notEqual(domainDocumentFingerprint([{ ...document, deleted: true }], [document.id]), original);
  assert.throws(() => domainDocumentFingerprint([], [document.id]), /尚未保存/);
});

test("删除后保存恢复稿再删除，以最后一次意图为准，不复活候选或新增删除历史", async () => {
  const job = await fixture(["one", "obsolete"], async (context, call) => {
    if (!context.step) {
      await call("knowledge_work", { action: "schedule", steps: [step("obsolete")] });
      assert.equal((await call("knowledge_work", { action: "run" })).complete, true);
      await call("knowledge_work_result", { summary: "重复稿最终标记待删除", document_ids: ["obsolete"] });
    } else if (context.reviewing) {
      assert.equal((await call("knowledge_draft", { action: "read", id: "obsolete" })).deleted, true);
      await call("knowledge_work_result", { summary: "已核实最终删除候选", document_ids: ["obsolete"], review: { pass: true, feedback: "删除理由及最终状态已核对" } });
    } else {
      await call("knowledge_draft", { action: "read", id: "obsolete" });
      await call("knowledge_draft", { action: "delete", id: "obsolete" });
      await call("knowledge_draft", { action: "save", document: draft("obsolete", "暂时恢复的候选") });
      assert.equal((await call("knowledge_draft", { action: "read", id: "obsolete" })).deleted, false);
      await call("knowledge_draft", { action: "delete", id: "obsolete" });
      assert.equal((await call("knowledge_draft", { action: "read", id: "obsolete" })).deleted, true);
      await call("knowledge_work_result", { summary: "仍应删除，不保留恢复建议", document_ids: ["obsolete"] });
    }
  });
  assert.equal(job.status, "done", job.error);
  assert.equal(job.documents.find(document => document.id === "obsolete")?.history.length, 1);
  assert.equal(job.turns.at(-1)?.proposals.find(proposal => proposal.document.id === "obsolete")?.status, "discarded");
});

test("主会话漏报实际修改不能跳过独立评审，可安排只读核查已有候选而不重写", async () => {
  let writers = 0;
  const job = await fixture(["one", "two"], async (context, call) => {
    if (!context.step) {
      await call("knowledge_draft", { action: "read", id: "two" });
      await call("knowledge_draft", { action: "save", document: draft("two", "# 关联修订\n保留未结算前提。") });
      const rejected = await call("knowledge_work_result", { summary: "省略实际改动", document_ids: [] }, true);
      assert.match(rejected.error, /实际修改.*two/);
      await call("knowledge_work", { action: "schedule", steps: [{ ...step("two"), readonly: true }] });
      assert.equal((await call("knowledge_work", { action: "run" })).complete, true);
      await call("knowledge_work_result", { summary: "关联候选已独立核查，等待人工采纳", document_ids: [] });
    } else {
      await call("knowledge_draft", { action: "read", id: "two" });
      if (!context.reviewing) writers++;
      await call("knowledge_work_result", { summary: "已有候选已回读，无需重写", document_ids: ["two"],
        ...(context.reviewing ? { review: { pass: true, feedback: "保留未结算前提，修改符合意见" } } : {}) });
    }
  });
  assert.equal(job.status, "done", job.error); assert.equal(writers, 1);
  assert.equal(job.turns.at(-1)?.proposals.length, 1);
});

test("恢复旧作者会话不能用旧上下文覆盖其他步骤的新候选，回读后可接续", async () => {
  let writerAttempts = 0, oldContent = "", firstRead!: () => void, secondReviewed!: () => void;
  const read = new Promise<void>(resolve => firstRead = resolve), updated = new Promise<void>(resolve => secondReviewed = resolve);
  const job = await fixture(["one", "two", "shared"], async (context, call) => {
    if (!context.step) {
      await call("knowledge_work", { action: "schedule", steps: [step("one"), step("two")] });
      assert.equal((await call("knowledge_work", { action: "run", concurrency: 2 })).complete, true);
      const current = await call("knowledge_draft", { action: "read", id: "shared" });
      assert.match(current.content, /另一作者的新修改/); assert.match(current.content, /恢复后整合/);
      await call("knowledge_work_result", { summary: "保留并整合了并发成果", document_ids: ["shared"] });
    } else if (context.reviewing) {
      for (const id of context.step.document_ids) await call("knowledge_draft", { action: "read", id });
      await call("knowledge_work_result", { summary: "实际候选已读取", document_ids: context.step.document_ids, review: { pass: true, feedback: "当前版本的适用范围与改动已核对" } });
      if (context.step.id === "two") secondReviewed();
    } else if (context.step.id === "one") {
      if (++writerAttempts === 1) {
        oldContent = (await call("knowledge_draft", { action: "read", id: "shared" })).content;
        firstRead(); await updated; await new Promise(resolve => setTimeout(resolve, 0));
        throw new Error("模拟写作会话中断，恢复对话仍携带旧正文");
      }
      const stale = await call("knowledge_draft", { action: "save", document: draft("shared", oldContent + "\n旧上下文覆盖。") }, true);
      assert.match(stale.error, /回读当前完整正文/);
      const current = await call("knowledge_draft", { action: "read", id: "shared" });
      await call("knowledge_draft", { action: "save", document: draft("shared", current.content + "\n恢复后整合。") });
      await call("knowledge_work_result", { summary: "恢复作者已回读整合", document_ids: ["one"] });
    } else {
      await read;
      const current = await call("knowledge_draft", { action: "read", id: "shared" });
      await call("knowledge_draft", { action: "save", document: draft("shared", current.content + "\n另一作者的新修改。") });
      await call("knowledge_work_result", { summary: "并发作者已修改", document_ids: ["two"] });
    }
  });
  assert.equal(job.status, "done", job.error); assert.equal(writerAttempts, 2);
});

test("步骤真实写集和全轮改动跨重启保留，漏报关联稿仍进入候选及版本复核", async () => {
  const root = mkdtempSync(join(tmpdir(), "revision-write-set-")), file = join(root, "work.json");
  try {
    let work = new DomainSkillWork(file, "revision"); work.schedule([step("one")]);
    const signal = new AbortController().signal, versions: Record<string, string> = { one: "1", related: "1" };
    const callbacks = { fingerprint: (ids: string[]) => ids.map(id => `${id}:${versions[id]}`).join("|"),
      review: async (_step: unknown, result: { document_ids: string[] }) => {
        assert.deepEqual(result.document_ids, ["one", "related"]);
        return { pass: true, feedback: "重点稿及实际关联改动已回读" };
      } };
    await work.run("one", async () => {
      work.recordDocumentWrite("one", "related");
      return { summary: "已修改关联稿但漏报", document_ids: ["one"] };
    }, signal, callbacks);
    work = new DomainSkillWork(file, "revision");
    assert.deepEqual(work.state.modified_document_ids, ["related"]);
    assert.deepEqual(work.state.steps[0].written_document_ids, ["related"]);
    versions.related = "2";
    assert.throws(() => work.finish({ summary: "错误复用旧评审", document_ids: [] }, callbacks.fingerprint), /文稿已变化/);
    await work.run("one", async () => assert.fail("只重新评审，不重复写作"), signal, callbacks);
    work.finish({ summary: "新版本已评审", document_ids: [] }, callbacks.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
