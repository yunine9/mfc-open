import test from "node:test";
import assert from "node:assert/strict";
import { memoryCounts, memoryPreparation, memorySearchPresentation } from "../web/src/memoryPresentation.ts";

test("检索加载和请求失败不能冒充未启用；刷新失败不能冒充仍然在线", () => {
  assert.equal(memorySearchPresentation().state, "unknown");
  assert.equal(memorySearchPresentation(undefined, true).label, "检索状态读取失败");
  assert.equal(memorySearchPresentation("ready", true).state, "unknown");
  assert.equal(memorySearchPresentation("absent").label, "语义检索未启用");
  assert.match(memorySearchPresentation("absent").title, /自动推荐需启用语义检索/);
  assert.equal(memorySearchPresentation("unavailable").label, "语义检索暂不可用");
  assert.equal(memorySearchPresentation("ready").label, "语义检索在线");
});

test("模板、旧记录以及重启遗留的模板都表示待确认，不虚构在途整理", () => {
  for (const draft of [undefined, "template"] as const) {
    const result = memoryPreparation({ source: "annotation", draft });
    assert.equal(result.label, "待确认");
    assert.match(result.title, /尚无明确采纳记录/);
    assert.doesNotMatch(result.label, /起草中|整理中/);
  }
});

test("模型正在整理、成功和失败分别呈现；失败仍保留记忆", () => {
  assert.equal(memoryPreparation({ source: "prepush_fix", drafting: true }).label, "整理中 · 待确认");
  assert.equal(memoryPreparation({ source: "annotation", draft: "model", drafting: false }).label, "待确认");
  const failed = memoryPreparation({ source: "annotation", draft: "failed", drafting: false });
  assert.equal(failed.label, "待确认");
  assert.match(failed.title, /原记录保留/);
  assert.equal(memoryPreparation({ source: "user_note" }).label, "待确认");
});

test("页头经验卡与「待确认」页签同一口径：停用、并入、归档不计；无审查权的候选不算待我确认", () => {
  assert.deepEqual(memoryCounts([
    { can_review: true },
    { can_review: true, review: { status: "pending" } },
    { can_review: false },
    { review: { status: "accepted" } },
    { review: { status: "accepted" }, withdrawn: true },
    { can_review: true, superseded_by: "c-merged-1" },
    { review: { status: "accepted" }, archived: true },
    { review: { status: "rejected" } },
  ]), { pending: 2, accepted: 1 });
});
