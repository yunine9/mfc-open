import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { createMemoryTools } from "../src/memoryTools.ts";
import { memoryReviewFocus } from "../web/src/memoryPresentation.ts";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

test("主动沉淀的指引进入 PI 提示词，区分临时开发要求与跨任务经验", () => {
  const write = createMemoryTools({ repo: "demo", write: () => ({ id: "c-a-111" }), search: async () => [], expand: async () => undefined })
    .find(tool => tool.name === "corpus_write")!;
  const prompt = buildSystemPrompt({ cwd: "/test", selectedTools: [write.name], toolSnippets: { [write.name]: write.promptSnippet! }, promptGuidelines: write.promptGuidelines });
  assert.match(prompt, /帮我沉淀一下/);
  assert.match(prompt, /普通‘这次这样改’不是要求沉淀/);
  assert.match(prompt, /不要求先有检视意见/);
  assert.match(prompt, /只有 corpus_write 确认保存成功后/);
  assert.match(prompt, /不擅自扩大范围/);
  assert.match(prompt, /不会授权修改代码、推送/);
});

test("对话记录无需文件或检视意见：保留原话、只生成候选、回执直达同一条经验", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory-chat-"));
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const task = service.create("实现订单接口");
    const state = (service as any).tasks.get(task.id);
    const before = structuredClone(state.summary);
    const write = (service as any).memoryTools(state).find((tool: any) => tool.name === "corpus_write");
    const original = "我们跨仓协作时先明确接口契约。帮我把这个沉淀一下。";
    const result = await write.execute("call-natural-memory", {
      trigger: "跨仓协作拆分任务时", conclusion: "先明确接口契约。\n\n适用例外：实现细节仍由各仓自行决定。",
      user_statement: original, scope: "platform",
    });
    const records = service.listTaskMemories(task.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].quote, original);
    assert.deepEqual(records[0].paths, []);
    assert.equal(records[0].review?.status, "pending");
    assert.equal(records[0].judged_by, "agent", "转述人话不伪造人工采纳事实");
    assert.equal(records[0].evidence, "agent:call-natural-memory");
    assert.equal(result.details.memory_id, records[0].id);
    const link = new URL(result.details.review_url, "http://localhost");
    assert.equal(link.searchParams.get("kbPage"), "experience");
    assert.equal(memoryReviewFocus(link.search), records[0].id);
    assert.match(result.content[0].text, /已保存到「知识库 → 团队经验」/);
    assert.match(result.content[0].text, /\[查看这条经验\]\(\/\?kbPage=experience&memory_id=c-/);
    assert.equal(service.readMemoryInsight(memoryReviewFocus(link.search)!)?.record.quote, original);
    assert.equal(state.summary.status, before.status);
    assert.deepEqual(state.summary.waiting, before.waiting);
    assert.deepEqual(state.summary.delivery, before.delivery);
  } finally { await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("保存失败不伪造成功回执和审查链接", async () => {
  const write = createMemoryTools({ repo: "demo", write: () => { throw new Error("磁盘写入失败"); }, search: async () => [], expand: async () => undefined })
    .find(tool => tool.name === "corpus_write")!;
  await assert.rejects(write.execute("call", { trigger: "跨仓协作时", conclusion: "先确认接口" }, undefined as any, undefined as any, undefined as any), /磁盘写入失败/);
});

test("经验深链只接受有效记录 ID，不把任意参数当导航目标", () => {
  assert.equal(memoryReviewFocus("?kbPage=experience&memory_id=c-abc-012def"), "c-abc-012def");
  for (const search of ["", "?memory_id=", "?memory_id=../../secret", "?memory_id=https://outside.example", "?memory_id=c-abc-XYZ"]) {
    assert.equal(memoryReviewFocus(search), undefined);
  }
});
