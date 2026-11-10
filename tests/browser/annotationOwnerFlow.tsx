import { annotationSubmissionView } from "../../src/annotationSubmissionView";
import type { TaskStatus } from "../../web/src/api";
import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { AnnotationPanel } from "../../web/src/AnnotationPanel";
import { annotationClosures } from "../../src/feedbackPolicy";
import type { Annotation } from "../../src/annotations";

let rows: Annotation[] = [{ id: "one", author: "reviewer", created_at: new Date().toISOString(), artifact: "design.md",
  file: "design.md", line: 1, anchor: "订单同步", note: "请明确上游超时后的处理方式", kind: "doc", route: "owner_reply", assignee: "owner", status: "draft" }];
let refresh = () => {};
let viewer = "owner";
let status: TaskStatus = "running";
let reviewDecision = true;
let submissionCount = 0;
let lastReceipt = "";
const view = () => annotationSubmissionView({ status, openMr: false, evidenceAwaiting: false,
  publishedStory: false, reviewDecision, requirementReview: false });
window.fetch = async (input, init) => {
  const url = String(input), item = rows[0], body = JSON.parse(String(init?.body || "{}"));
  if (url.endsWith("/annotations/send")) {
    submissionCount++;
    const queued = status === "paused" || (status === "waiting_for_human" && !reviewDecision);
    rows.forEach(row => { row.route = "agent"; row.status = "sent"; row.agent_assigned = true;
      row.sent_via = queued ? "queued_decision" : "interrupt"; });
    lastReceipt = queued ? "意见已排队，等待答复或恢复任务。" : "已接收修改意见，无需重复提交。";
    return new Response(JSON.stringify({ sent: rows.map(row => row.id), receipt: lastReceipt }));
  }
  if (init?.method === "DELETE") rows = [];
  else if (url.endsWith("/reply")) { item.owner_reply = { author: "owner", text: body.text, replied_at: new Date().toISOString() }; item.status = "sent"; item.sent_via = "owner_pending"; }
  else if (url.endsWith("/resolve")) { item.status = "verified"; item.resolution = { ...body, by: "owner", at: new Date().toISOString() }; }
  else if (url.endsWith("/reopen")) { item.status = "draft"; item.resolution = undefined; item.owner_reply = undefined; item.sent_via = undefined; item.rework = (item.rework || 0) + 1; }
  return new Response(JSON.stringify({ sent: ["one"] }));
};
function App() {
  const [, update] = useState(0); refresh = () => update((n) => n + 1);
  const closures = annotationClosures(rows, { task_status: status, task_owner: "owner", owner_controlled: true,
    review_ready: false, review_annotation_ids: [], archival: false }, { username: viewer, can_override: false, can_route_others: viewer === "owner" });
  return <AnnotationPanel taskId="task" viewerUsername={viewer} items={rows} checks={[]} closures={closures}
    canOperate={viewer === "owner"} taskStatus={status} submission={view()} onChanged={refresh} />;
}
createRoot(document.getElementById("app")!).render(<App />);
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label);
async function run() {
  await pause();
  if (!button("删除") || !button("修改 / 补充") || !button("自行答复")
      || button("交给 Agent") || button("确认闭环")) throw Error("待处理按钮不正确");
  button("自行答复")!.click(); await pause();
  const input = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "超时保持原数据，允许稍后重试");
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  button("保存答复")!.click(); await pause();
  if (!button("确认闭环")) throw Error("答复后未出现闭环");
  button("确认闭环")!.click(); await pause();
  if (!button("重新处理")) throw Error("闭环后不能变卦");
  button("重新处理")!.click(); await pause();
  if (!button("自行答复") || !button("删除") || button("确认闭环")) throw Error("重新处理未回到待处理");
  viewer = "reviewer"; refresh(); await pause();
  if (button("删除") || button("自行答复") || button("交给 Agent")) throw Error("非责任人出现操作入口");
  viewer = "owner"; refresh(); await pause();
  // 批量提交与逐条处置保持同一入口；处理中的意见不重复提交。
  rows = [{ ...rows[0], route: "agent", status: "sent", sent_via: "interrupt",
    agent_assigned: true, owner_reply: undefined }]; refresh(); await pause();
  if (button("删除") || button("确认闭环")) throw Error("Agent 处理中仍可删除或闭环");
  rows = [{ ...rows[0], id: "two", status: "draft", agent_assigned: false, sent_via: undefined }]; refresh(); await pause();
  button("删除")!.click(); await pause();
  if (document.querySelector(".annot-item")) throw Error("删除后意见仍留在列表");
  rows = [{ id: "preview", author: "reviewer", created_at: new Date().toISOString(), artifact: "design.md", file: "design.md",
    line: 12, anchor: "订单同步", note: "请明确上游超时后的处理方式", kind: "doc", route: "owner_reply", assignee: "owner",
    status: "sent", sent_via: "owner_pending", owner_reply: { author: "owner", text: "超时保持原数据，允许稍后重试。", replied_at: new Date().toISOString() } }];
  refresh(); await pause();
  for (const [nextStatus, canDecide, expected] of [
    ["running", true, "加入当前工作"],
    ["waiting_for_human", true, "无需再点卡片"],
    ["waiting_for_human", false, "请先回答当前问题"],
    ["paused", false, "不会自动恢复任务"],
  ] as const) {
    status = nextStatus; reviewDecision = canDecide;
    rows = [{ ...rows[0], id: `batch-${submissionCount}`, status: "draft", route: "owner_reply",
      owner_reply: undefined, resolution: undefined, sent_via: undefined, agent_assigned: false }];
    refresh(); await pause();
    if (!document.body.textContent?.includes(expected)) throw Error(`提交前说明缺失：${expected}`);
    const before = submissionCount;
    const submit = button("提交修改意见");
    if (!submit || submit.disabled) throw Error(`无法提交：${status}`);
    submit.click(); await pause();
    if (submissionCount !== before + 1) throw Error("一次点击重复提交");
    if (!document.body.textContent?.includes(lastReceipt)) throw Error("未显示服务端提交结果");
    if (button("提交修改意见")) throw Error("已提交意见仍要求重复提交");
  }
  viewer = "reviewer";
  rows = [{ ...rows[0], status: "draft", sent_via: undefined, agent_assigned: false }];
  refresh(); await pause();
  if (button("提交修改意见")) throw Error("检视人被错误授权提交");
  if (!document.body.textContent?.includes("统一由任务责任人")) throw Error("权限说明不明确");
  return "passed";
}
run().then((result) => document.getElementById("result")!.textContent = result)
  .catch((error) => document.getElementById("result")!.textContent = String(error));
