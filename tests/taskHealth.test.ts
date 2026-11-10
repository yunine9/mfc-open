import { test } from "node:test";
import assert from "node:assert/strict";
import { taskHealthFacts } from "../web/src/taskHealth.ts";

test("任务健康:当前、下一步和责任方全部来自同一服务端焦点", () => {
  const facts = taskHealthFacts({
    created_at: "2026-08-23T00:00:00.000Z",
    last_progress_at: "2026-08-23T01:00:00.000Z",
    luban_account: "alice",
    focus: {
      headline: "需要确认 2 个决策项",
      next_action: "提交决定后 Agent 自动继续",
      owner: "responsible",
      needs_attention: true,
    },
  }, "alice");
  assert.deepEqual(facts, {
    current: "需要确认 2 个决策项",
    next: "提交决定后 Agent 自动继续",
    actor: "你 · alice",
    last_progress_at: "2026-08-23T01:00:00.000Z",
    needs_attention: true,
  });
});

test("任务健康:Agent、平台与旧后端安全降级", () => {
  const base = { created_at: "2026-08-23T00:00:00.000Z" };
  assert.equal(taskHealthFacts(base, "alice"), undefined);
  assert.equal(taskHealthFacts({
    ...base,
    focus: {
      headline: "正在编码",
      next_action: "完成后进入下一步",
      owner: "agent",
      needs_attention: false,
    },
  }, "alice")?.actor, "Agent 自动推进");
  assert.equal(taskHealthFacts({
    ...base,
    focus: {
      headline: "等待流水线",
      next_action: "通过后等待合入",
      owner: "platform",
      needs_attention: false,
    },
  }, "alice")?.actor, "平台 / 外部系统");
});
