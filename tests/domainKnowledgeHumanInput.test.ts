import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) { await new Promise(resolve => setTimeout(resolve, 0)); return; } await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("任务未在2秒内到达预期状态");
}

test("#451 任意 Skill 的中间文稿可即时审阅，多次人工答复沿原会话继续，重启不代答", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-human-input-"));
  const method = { "SKILL.md": "---\nname: opaque-method\ndescription: 任意三段方法。\n---\nBLACK_BOX_METHOD，没有固定模块或阶段名称。" };
  const content = "# 中间文稿\n\n" + "完整正文不能截断。\n".repeat(1500) + "\n全文末尾标记";
  let sessions = 0, childRuns = 0, release!: () => void, saved = false;
  const hold = new Promise<void>(resolve => release = resolve);
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      sessions++;
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      assert.match(prompt, /BLACK_BOX_METHOD/);
      const call = async (name: string, args: unknown) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name);
        assert.ok(tool, name);
        const response = await tool.execute("fixture", args);
        assert.equal(!!response.isError, false, JSON.stringify(response));
        return JSON.parse(response.content[0].text);
      };
      if (context.step) {
        childRuns++;
        await call("knowledge_work_result", { summary: "已调查", document_ids: [], data: { arbitrary: true } });
      } else if (!context.continued) {
        await call("knowledge_work", { action: "schedule", steps: [{ id: "opaque", title: "自定义调查", instructions: "调查自己的问题", depends_on: [], readonly: false }] });
        await call("knowledge_work", { action: "run", id: "opaque" });
        await call("knowledge_work", { action: "save_document", document: { id: "plan", title: "任意方法的中间文稿", content } });
        saved = true; await hold;
        await call("knowledge_work_result", { status: "paused", summary: "请检查这份中间文稿并回答。", document_ids: [], work_document_ids: ["plan"] });
      } else if (context.continued === 1) {
        assert.equal(context.human_replies.at(-1).message, "只研究仓5的 sau/LteTrace；不要把此答复当作批准原规划。");
        await call("knowledge_work", { action: "run", id: "opaque" });
        await call("knowledge_work_result", { status: "paused", summary: "已按意见调整，请再次确认。", document_ids: [], work_document_ids: ["plan"] });
      } else {
        assert.equal(context.human_replies.at(-1).message, "确认调整后的内容，请继续。");
        await call("knowledge_draft", { action: "save", document: { id: "rules", title: "知识草稿", target_id: "domain", path: `${context.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "完整知识正文", sources: "用户提供的研究范围" } });
        await call("knowledge_work_result", { summary: "本轮完成", document_ids: ["rules"] });
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("不应反复催促已保存暂停结果的会话"); },
  }) as any);
  const execute = (input: Parameters<typeof runDomainKnowledge>[0]) => runDomainKnowledgeFixture(method, input, {
    dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => { throw new Error("方法不要求读取源码"); },
  });
  let service = new DomainKnowledgeExtraction(root, execute);
  try {
    const created = service.create({ issue_no: "451", title: "任意方法", scope: "用户范围", repositories: [] }, "expert");
    await until(() => saved);
    let job = service.get(created.id);
    assert.equal(job.status, "running");
    assert.equal(job.documents.length, 0);
    assert.equal(job.work_documents?.[0].content, content, "知识草稿尚未生成时，过程文稿全文已能读取");
    release(); await until(() => service.get(created.id).status !== "running");
    job = service.get(created.id);
    assert.equal(job.status, "paused", job.error);
    assert.equal(job.production?.status_label, "等待你确认");
    assert.equal(job.error, undefined);
    assert.equal(job.production?.next_action.view, "progress", "待确认内容从原研究过程进入");
    assert.match(job.production?.next_action.href ?? "", new RegExp(`kbTask=${job.id}`));
    assert.equal(job.production?.review.turns[0].status_label, "等待你的答复");
    const turnId = job.turns[0].id, first = job.turns[0].waiting!;
    assert.deepEqual(first.work_document_ids, ["plan"]);
    assert.throws(() => service.resume(job.id, "expert"), /答复/);
    assert.throws(() => service.resume(job.id, "expert", false, { request_id: "wrong", message: "继续" }), /已变化/);
    await service.shutdown();
    const before = sessions;
    service = new DomainKnowledgeExtraction(root, execute);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sessions, before, "重启保留等待，不唤醒模型");
    assert.equal(service.get(job.id).work_documents?.[0].content, content);
    let responseCode = 0;
    await domainKnowledgeRoute({ method: "POST" } as any, {} as any, ["domain-extraction", job.id, "resume"],
      { options: { dataDir: root }, getDomainKnowledgeExtraction: () => service } as any, "reviewer", async () => ({
        request_id: first.id, message: "只研究仓5的 sau/LteTrace；不要把此答复当作批准原规划。",
      }), (_response, status) => { responseCode = status; });
    assert.equal(responseCode, 202);
    await until(() => service.get(job.id).status === "paused");
    job = service.get(job.id);
    assert.equal(childRuns, 1, "继续时不重复已完成的独立调查");
    assert.equal(job.turns.length, 1); assert.equal(job.turns[0].id, turnId);
    assert.equal(job.turns[0].human_replies?.[0].operator, "reviewer");
    assert.notEqual(job.turns[0].waiting!.id, first.id);
    assert.throws(() => service.resume(job.id, "reviewer", false, { request_id: first.id, message: "旧确认" }), /已变化/);
    service.resume(job.id, "reviewer", false, { request_id: job.turns[0].waiting!.id, message: "确认调整后的内容，请继续。" });
    await until(() => service.get(job.id).status === "done");
    job = service.get(job.id);
    assert.equal(job.turns[0].waiting, undefined);
    assert.equal(job.turns[0].human_replies?.length, 2);
    assert.equal(job.documents.length, 1);
    assert.equal(job.documents[0].path, `${job.knowledge_target.docs_path}/rules.md`);
    assert.equal(job.work_documents?.[0].content, content);
    assert.equal(job.documents[0].knowledge_document_id, undefined, "中间确认不会替人发布知识");
  } finally { release(); await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("#451 只有明确 paused 才等待确认，真实异常仍失败，普通暂停说明可完整审阅", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-human-error-"));
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async () => {
      const result = await config.extraTools.find((tool: any) => tool.name === "knowledge_work_result").execute("pause", { status: "paused", summary: "# 待确认事项\n\n请补充业务范围。", document_ids: [] });
      assert.equal(!!result.isError, false); return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {},
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => { throw new Error("不读源码"); } }));
  const broken = new DomainKnowledgeExtraction(join(root, "broken"), async () => { throw new Error("工具实际失败，等待确认字样不改变结果"); });
  try {
    const job = service.create({ issue_no: "451", title: "缺输入", scope: "范围", repositories: [] }, "expert");
    const failed = broken.create({ issue_no: "451", title: "实际失败", scope: "范围", repositories: [] }, "expert");
    await until(() => !["queued", "running"].includes(service.get(job.id).status));
    await until(() => broken.get(failed.id).status === "failed");
    assert.equal(service.get(job.id).status, "paused");
    assert.match(service.get(job.id).work_documents![0].content, /请补充业务范围/);
    assert.equal(broken.get(failed.id).production?.status_label, "执行失败");
  } finally { await service.shutdown(); await broken.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
