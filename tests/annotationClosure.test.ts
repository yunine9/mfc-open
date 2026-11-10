/**
 * 一条检视意见此刻在哪、球在谁脚下、谁能动它——唯一判定处的契约。
 *
 * 这段逻辑原来服务端和前端各推一遍,每加一个入口就多一份推法,也就
 * 多一条 bug(2026-09-04 盘账:本周 111 条 fix 有 42 条落在这个概念上)。
 * 收成一处之后,它的每个分支都必须在这里钉死:以后加 sent_via、加路由,
 * 先在这里补一条用例,所有界面自动跟上。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationClosure,
  annotationClosures,
  annotationVerdictReady,
  workspaceReviewReady,
  type AnnotationClosureFacts,
  type AnnotationViewerFacts,
} from "../src/feedbackPolicy.ts";
import type { Annotation } from "../src/annotations.ts";

function note(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "an-1",
    author: "alice",
    created_at: "2026-09-04T00:00:00.000Z",
    artifact: "design.md",
    file: "design.md",
    line: 3,
    anchor: "原文",
    note: "这里要改",
    kind: "doc",
    status: "sent",
    ...over,
  };
}

const FACTS: AnnotationClosureFacts = {
  task_status: "waiting_for_human",
  review_ready: false,
  review_annotation_ids: [],
  archival: false,
};
const ALICE: AnnotationViewerFacts = {
  username: "alice", can_override: false, can_route_others: false,
};
const BOB: AnnotationViewerFacts = {
  username: "bob", can_override: false, can_route_others: false,
};
const ADMIN: AnnotationViewerFacts = {
  username: "admin", can_override: true, can_route_others: true,
};

test("普通检视:Agent 再次等人就是作者可以裁决的权威事实", () => {
  const closure = annotationClosure(note({ sent_via: "decision" }), FACTS, ALICE);
  assert.equal(closure.verdict_ready, true);
  assert.equal(closure.can_verify, true);
  assert.equal(closure.bucket, "mine");
  assert.equal(closure.text, "待你确认");
});

test("任务还在跑:谁都不能裁决,面板说清在等什么", () => {
  const closure = annotationClosure(note({ sent_via: "decision" }),
    { ...FACTS, task_status: "running" }, ALICE);
  assert.equal(closure.verdict_ready, false);
  assert.equal(closure.can_verify, false);
  assert.equal(closure.text, "已交给 Agent");
  assert.equal(closure.bucket, "agent");
});

test("MR 修复轮:没有本轮回执就不许裁决,文案不冒充已修好", () => {
  const closure = annotationClosure(note({ sent_via: "review_repair" }),
    FACTS, ALICE);
  assert.equal(closure.verdict_ready, false);
  assert.equal(closure.text, "等待 Agent 回执");
});

test("MR 修复轮:回执到了但复检卡没到,报回执不报可确认", () => {
  const item = note({
    sent_via: "review_repair",
    response: { revision: 0, outcome: "fixed", summary: "已按意见改",
      evidence: [], responded_at: "2026-09-04T01:00:00.000Z" },
  });
  const closure = annotationClosure(item, FACTS, ALICE);
  assert.equal(closure.verdict_ready, false);
  assert.match(closure.text, /Agent 回执：已修改·等复检/);
  // 回执正文卡上已有,提示只说等谁、到哪步能点;对作者说"你",对旁人点名作者
  assert.doesNotMatch(closure.hint ?? "", /已按意见改/);
  assert.match(closure.hint ?? "", /最终推送确认卡出现后，由你点「确认已修复」/);
  const bystander = annotationClosure(item, FACTS, { ...ALICE, username: "someone-else" });
  assert.match(bystander.hint ?? "", /由意见作者 alice 点「确认已修复」/);
  assert.doesNotMatch(bystander.hint ?? "", /由你/);
});

test("MR 修复轮:复检卡到了+本轮回执 → 作者可裁决", () => {
  const item = note({
    sent_via: "review_repair",
    response: { revision: 0, outcome: "fixed", summary: "改好了",
      evidence: [], responded_at: "2026-09-04T01:00:00.000Z" },
  });
  const closure = annotationClosure(item, { ...FACTS, review_ready: true }, ALICE);
  assert.equal(closure.verdict_ready, true);
  assert.equal(closure.text, "待你确认");
});

test("旧回执不背书新一轮:revision 对不上等于没有回执", () => {
  const item = note({
    sent_via: "review_repair", rework: 1,
    response: { revision: 0, outcome: "fixed", summary: "上一轮的",
      evidence: [], responded_at: "2026-09-04T01:00:00.000Z" },
  });
  assert.equal(annotationVerdictReady(item, { ...FACTS, review_ready: true }),
    false);
});

test("需要补充说明:球已经在作者脚下,不必等最终推送卡", () => {
  const item = note({
    sent_via: "review_repair",
    response: { revision: 0, outcome: "needs_clarification",
      summary: "这条指哪个函数？", evidence: [],
      responded_at: "2026-09-04T01:00:00.000Z" },
  });
  const closure = annotationClosure(item, FACTS, ALICE);
  assert.equal(closure.verdict_ready, true);
  assert.equal(closure.text, "Agent 需要你补充说明");
  assert.match(closure.hint ?? "", /哪个函数/);
});

test("等决定期间提交:只是团队事实,没送到 Agent,也不能自称验收", () => {
  const closure = annotationClosure(note({ sent_via: "queued_decision" }),
    FACTS, ALICE);
  assert.equal(closure.verdict_ready, false);
  assert.equal(closure.text, "已排队·等决定");
  assert.equal(closure.delivery_text, "已排队，随决定送达");
});

test("流水线证据不是检视闭环:不进裁决,也不报等待回执", () => {
  const closure = annotationClosure(note({ sent_via: "pipeline_evidence" }),
    FACTS, ALICE);
  assert.equal(closure.verdict_ready, false);
  assert.equal(closure.delivery_text, "作为流水线证据提交");
});

test("问责任人:没答复等责任人,答复了由提出人确认", () => {
  const waiting = annotationClosure(
    note({ route: "owner_reply", assignee: "bob" }), FACTS, ALICE);
  assert.equal(waiting.text, "等待责任人答复");
  assert.equal(waiting.verdict_ready, false);
  const answered = annotationClosure(note({
    route: "owner_reply", assignee: "bob",
    owner_reply: { author: "bob", text: "是这样", replied_at: "2026-09-04T02:00:00.000Z" },
  }), FACTS, ALICE);
  assert.equal(answered.verdict_ready, true);
  assert.equal(answered.can_verify, true);
});

test("责任人答复不受任务阶段限制:任务在跑也能确认", () => {
  const answered = note({
    route: "owner_reply", assignee: "bob",
    owner_reply: { author: "bob", text: "是这样", replied_at: "2026-09-04T02:00:00.000Z" },
  });
  assert.equal(annotationVerdictReady(answered,
    { ...FACTS, task_status: "running" }), true);
});

test("决策后处理:责任人给了结论仍要等 Agent 真做", () => {
  const closure = annotationClosure(note({
    route: "owner_decision", assignee: "bob", sent_via: "decision",
    owner_reply: { author: "bob", text: "按方案二", replied_at: "2026-09-04T02:00:00.000Z" },
  }), { ...FACTS, task_status: "running" }, ALICE);
  assert.equal(closure.text, "决策已交给 Agent");
  assert.equal(closure.verdict_ready, false);
});

test("记为记忆:不发给任何人,直接闭环", () => {
  const closure = annotationClosure(note({ route: "memory", status: "draft" }),
    FACTS, ALICE);
  assert.equal(closure.text, "已记为记忆");
  assert.equal(closure.delivery_text, "已记为记忆，不发给任何人");
});

test("确认通过与管理员代确认分得开", () => {
  const own = annotationClosure(
    note({ status: "verified", verified_at: "x" }), FACTS, ALICE);
  assert.equal(own.text, "确认通过");
  assert.equal(own.bucket, "closed");
  const proxy = annotationClosure(note({
    status: "verified", verified_at: "x", verified_by: "admin",
  }), FACTS, ALICE, { person_name: (u) => u === "admin" ? "管理员老王" : u });
  assert.equal(proxy.text, "管理员代确认");
  assert.match(proxy.hint ?? "", /管理员老王/);
});

test("原文没了但回执没到:说已有改动,不说已修好", () => {
  const closure = annotationClosure(note({ sent_via: "review_repair" }),
    FACTS, ALICE, { anchor_gone: true });
  assert.equal(closure.text, "已有改动·待验证");
  assert.equal(closure.verdict_ready, false);
});

test("到点了但看的人不是作者:不对旁人说请你确认", () => {
  const closure = annotationClosure(note({ sent_via: "decision" }), FACTS, BOB,
    { person_name: (u) => u === "alice" ? "小爱" : u });
  assert.equal(closure.can_verify, false);
  assert.equal(closure.text, "等作者确认");
  assert.match(closure.hint ?? "", /小爱/);
  assert.equal(closure.bucket, "agent");
});

test("管理员代办:只对本轮复检白名单里的他人意见开放", () => {
  const item = note({
    sent_via: "review_repair",
    response: { revision: 0, outcome: "fixed", summary: "改好了",
      evidence: [], responded_at: "2026-09-04T01:00:00.000Z" },
  });
  const off = annotationClosure(item, { ...FACTS, review_ready: true }, ADMIN);
  assert.equal(off.can_override_verify, false, "不在白名单里不给代办");
  const on = annotationClosure(item, {
    ...FACTS, review_ready: true, review_annotation_ids: ["an-1"],
  }, ADMIN);
  assert.equal(on.can_override_verify, true);
  assert.equal(on.can_override_drop, true);
  assert.equal(on.bucket, "mine");
  assert.equal(on.actionable, true);
});

test("管理员代办不碰自己的意见,也不越过需要补充说明", () => {
  const mine = note({ author: "admin", sent_via: "review_repair" });
  assert.equal(annotationClosure(mine, {
    ...FACTS, review_ready: true, review_annotation_ids: ["an-1"],
  }, ADMIN).can_override_drop, false);
  const asking = note({
    sent_via: "review_repair",
    response: { revision: 0, outcome: "needs_clarification", summary: "?",
      evidence: [], responded_at: "2026-09-04T01:00:00.000Z" },
  });
  const closure = annotationClosure(asking, {
    ...FACTS, review_ready: true, review_annotation_ids: ["an-1"],
  }, ADMIN);
  assert.equal(closure.can_override_drop, true, "撤下仍可以");
  assert.equal(closure.can_override_verify, false, "代确认不行:球在作者那");
});

test("草稿:自己的归我,别人的看有没有转交权", () => {
  const mine = annotationClosure(note({ status: "draft" }), FACTS, ALICE);
  assert.equal(mine.bucket, "mine");
  assert.equal(mine.text, "待提交");
  const others = annotationClosure(note({ status: "draft" }), FACTS, BOB);
  assert.equal(others.bucket, "agent");
  assert.equal(others.can_route, false);
  const routable = annotationClosure(note({ status: "draft" }), FACTS,
    { ...BOB, can_route_others: true });
  assert.equal(routable.can_route, true);
  assert.equal(routable.bucket, "mine");
});

test("任务已完成:别人的草稿不再可转交", () => {
  const closure = annotationClosure(note({ status: "draft" }),
    { ...FACTS, task_status: "completed" }, { ...BOB, can_route_others: true });
  assert.equal(closure.can_route, false);
});

test("返工轮次与交付后归档各有各的说法", () => {
  // rework 是正文版本号(改字重提也会加),"第几轮"看的是人退回的次数 returned。
  const rework = annotationClosure(note({ status: "draft", rework: 1, returned: 1 }),
    FACTS, ALICE);
  assert.equal(rework.text, "第 2 轮·待提交");
  const edited = annotationClosure(note({ status: "draft", rework: 1 }), FACTS, ALICE);
  assert.equal(edited.text, "待提交", "作者补充说明重提不是返工,不许说成上一轮改坏了");
  const archived = annotationClosure(note({ status: "draft" }),
    { ...FACTS, archival: true }, ALICE);
  assert.equal(archived.text, "交付后记录");
  assert.equal(archived.delivery_text, "交付后记录");
});

test("回执缺口只对本人、且只在本轮复检点名的意见上成立", () => {
  const item = note({ sent_via: "review_repair" });
  const facts = { ...FACTS, review_ready: true,
    review_annotation_ids: ["an-1"] };
  assert.equal(annotationClosure(item, facts, ALICE).receipt_missing, true);
  assert.equal(annotationClosure(item, facts, BOB).receipt_missing, false,
    "别人的缺口不摆在我这");
  assert.equal(annotationClosure(item,
    { ...facts, review_annotation_ids: [] }, ALICE).receipt_missing, false,
    "不在本轮复检里的不算");
  const answered = note({
    sent_via: "review_repair",
    response: { revision: 0, outcome: "fixed", summary: "改好了",
      evidence: [], responded_at: "2026-09-04T01:00:00.000Z" },
  });
  assert.equal(annotationClosure(answered, facts, ALICE).receipt_missing, false);
});

test("工作台复检卡:四个条件缺一不可", () => {
  const full = {
    task_status: "waiting_for_human", waiting_step: "cloud_push_confirm",
    review_source: "workspace", recheck_required: true,
  };
  assert.equal(workspaceReviewReady(full), true);
  assert.equal(workspaceReviewReady({ ...full, task_status: "running" }), false);
  assert.equal(workspaceReviewReady({ ...full, waiting_step: "hf_open" }), false);
  assert.equal(workspaceReviewReady({ ...full, review_source: "platform" }), false);
  assert.equal(workspaceReviewReady({ ...full, recheck_required: false }), false);
});

test("批量口径与单条一致,锚点消失按 id 对上", () => {
  const items = [note({ id: "an-1" }), note({ id: "an-2", author: "bob" })];
  const closures = annotationClosures(items, FACTS, ALICE,
    { anchor_gone_ids: ["an-2"] });
  assert.equal(closures.length, 2);
  assert.equal(closures[0].id, "an-1");
  assert.equal(closures[0].can_verify, true);
  assert.equal(closures[1].text, "已被改动·等作者确认");
});
