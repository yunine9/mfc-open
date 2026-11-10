import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { RequirementGraph } from "../../web/src/RequirementGraph";
import { WaitingCard, TaskCard } from "../../web/src/TaskCard";
import { TaskContinueDelivery } from "../../web/src/TaskContinueDelivery";

const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const root = createRoot(document.getElementById("app")!);
let browserError = "";
window.addEventListener("error", event => { browserError = event.message; });
let submitted: any;
window.fetch = async (input, init) => {
  if (String(input).endsWith("/decision")) submitted = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ items: [], accounts: [] }), { headers: { "Content-Type": "application/json" } });
};
const task: any = { id: "task-455", title: "完成通知偏好过滤", requirement: "一个任务完整实现并验证", luban_account: "owner", status: "waiting_for_human",
  created_at: "2026-10-09", updated_at: "2026-10-09", repositories: ["repo-a", "repo-b"],
  requirement_graph: { stage: "analysis", projection_state: "ready", repositories: [{ id: "only", name: "通知过滤", url: "repo-b", scope: { name: "通知过滤", paths: [] }, assignee: "owner", ticket: "REQ455" }],
    repository_assessments: [{ name: "参考仓", url: "repo-a", outcome: "no_change", reason: "当前接口已满足" }, { name: "业务仓", url: "repo-b", outcome: "change_required", reason: "实现过滤" }], dependencies: [] },
  waiting: { waiting_id: "wait-455", state_version: 1, status: "waiting", step: "requirement-analysis", question: { questions: [{ question: "是否确认开发方案？", options: ["确认方案", "需要修改"] }] } },
};
async function findButton(text: string) {
  for (let i = 0; i < 80; i++) {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text && !item.disabled);
    if (button) return button;
    await pause();
  }
  throw new Error(`没有可操作的按钮: ${text}; ${browserError}; ${document.getElementById("app")?.textContent}`);
}
async function run() {
  root.render(<div style={{ display: "grid", gridTemplateColumns: "1fr 440px", gap: 24, padding: 24 }}>
    <RequirementGraph task={task} /><WaitingCard task={task} onDecided={() => {}} /></div>);
  // 卡片按需求图把同一个确认选项展示成场景文案；提交的仍是规范选项。
  (await findButton("同意不拆分，继续开发")).click();
  (await findButton("确认并在本任务继续开发")).click();
  for (let i = 0; i < 80 && !submitted; i++) await pause();
  if (submitted?.selected_options?.["是否确认开发方案？"] !== "确认方案") throw new Error(`确认语义未送达: ${JSON.stringify(submitted)}`);
  const confirmed = { ...task, status: "queued", waiting: undefined, repositories: ["repo-b"], requirement_graph: {
    ...task.requirement_graph, stage: "confirmed", repositories: [{ ...task.requirement_graph.repositories[0], task_id: task.id, task_status: "queued" }] } };
  root.render(<div style={{ padding: 24 }}><RequirementGraph task={confirmed} /><TaskCard task={confirmed} onChanged={() => {}} /></div>);
  for (let i = 0; i < 80 && !document.body.textContent?.includes("由本任务完成开发与交付"); i++) await pause();
  if (!document.body.textContent?.includes("由本任务完成开发与交付")) throw new Error("未显示在主任务交付");
  if (document.body.textContent?.includes("查看子任务") || document.querySelector('[aria-label="主任务下的子任务"]')) throw new Error("把当前任务误显示成自己的子任务");
  if (!document.body.textContent?.includes("当前接口已满足")) throw new Error("候选仓结论丢失");
  if (document.documentElement.scrollWidth > innerWidth + 1) throw new Error("页面横向溢出");
  root.render(<TaskContinueDelivery task={{ ...confirmed, status: "completed", delivery: { mr_state: "merged" } }} canOperate onChanged={() => {}} />);
  await findButton("继续修改");
  return { confirmation: true, mainTaskDelivery: true, noSelfChild: true, continueDelivery: true, width: innerWidth };
}
run().then(result => document.getElementById("result")!.textContent = JSON.stringify(result))
  .catch(error => document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }));
