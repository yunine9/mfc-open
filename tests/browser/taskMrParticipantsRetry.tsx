import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
import type { TaskSummary } from "../../web/src/api";

const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async input => {
  const path = String(input);
  check(!path.endsWith("/mr-participants"), "静默失败不应触发人员设置请求");
  let value: unknown;
  if (/\/artifacts(?:\?|$)/.test(path) || path.endsWith("/reviews") || path === "/auth/committers") value = [];
  else if (path.endsWith("/conversation")) value = { items: [], problems: [], events_seen: 0 };
  else if (path.endsWith("/annotations")) value = { items: [], checks: [], closures: [] };
  else if (path === "/auth/people") value = [{ username: "owner" }, { username: "admin" }, { username: "observer" }];
  else if (path.endsWith("/developer-assistant")) value = {
    state: "idle", messages: [], tools: [],
    availability: { available: false, code: "core_unavailable", mode: "unavailable", reason: "界面验证" },
  };
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
};

const scenarios: { name: string; viewer: string; canOperate: boolean; status?: TaskSummary["status"]; mrState?: string; resultStatus?: "failed" | "applied" | "skipped" }[] = [
  { name: "owner-open", viewer: "owner", canOperate: true },
  { name: "admin-other-task", viewer: "admin", canOperate: true },
  { name: "observer", viewer: "observer", canOperate: false },
  { name: "owner-readonly", viewer: "owner", canOperate: false },
  { name: "completed", viewer: "owner", canOperate: true, status: "completed" },
  { name: "canceled", viewer: "owner", canOperate: true, status: "canceled" },
  ...["merged", "closed", "已合入", "已关闭"].map(mrState => ({
    name: mrState, viewer: "owner", canOperate: true, mrState,
  })),
  { name: "applied", viewer: "owner", canOperate: true, resultStatus: "applied" },
  { name: "skipped", viewer: "owner", canOperate: true, resultStatus: "skipped" },
];
const root = createRoot(document.getElementById("app")!);
const buttons = (within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")];
const retryButtons = (within: ParentNode = document) => buttons(within)
  .filter(button => button.textContent?.trim() === "重试设置人员");
async function until(test: () => unknown, message: string) {
  for (let i = 0; i < 70 && !test(); i++) await pause();
  check(test(), message);
}

async function run() {
  for (const scenario of scenarios) {
    const task: TaskSummary = {
      id: `task-479-${scenario.name}`, title: `模块交付 ${scenario.name}`, requirement: "核对交付",
      status: scenario.status ?? "verifying", luban_account: "owner",
      created_at: "2026-10-13T08:00:00Z", updated_at: "2026-10-13T08:00:00Z",
      progress: { phases: [], current_index: -1, current_phase: "交付验证", step: "核对人员设置" },
      delivery: { mr_url: "https://codehub.example.test/merge_requests/479", mr_state: scenario.mrState ?? "opened",
        mr_participants: { status: scenario.resultStatus ?? "failed", requested: { reviewers: ["reviewer"], approval_approvers: [] },
          ...(scenario.resultStatus ? {} : { message: "账号未添加" }) } },
    };
    root.render(<TaskWorkspace key={task.id} task={task} viewerUsername={scenario.viewer}
      canOperate={scenario.canOperate} canOverride={scenario.viewer === "admin"} canCollaborate={false}
      canRequestReview={false} onChanged={() => {}} onClose={() => {}} />);
    await until(() => document.getElementById("app")?.textContent?.includes(task.title!), `${scenario.name}: workspace missing`);
    check(!retryButtons().length, `${scenario.name}: workspace still offers a participant retry`);
    check(!document.getElementById("app")?.textContent?.includes("账号未添加"), `${scenario.name}: workspace displays the participant error`);
    const details = buttons().find(button => button.textContent?.trim().startsWith("任务详情"));
    check(details, `${scenario.name}: details action missing`);
    details!.click();
    await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes("合入请求"), `${scenario.name}: MR details missing`);
    const dialog = document.querySelector('[role="dialog"]')!;
    check(!retryButtons(dialog).length, `${scenario.name}: inspector still offers a participant retry`);
    check(dialog.querySelector(`a[href="${task.delivery!.mr_url}"]`), `${scenario.name}: MR link missing`);
    if (!scenario.resultStatus) {
      check(!dialog.textContent?.includes("账号未添加") && !dialog.textContent?.includes("MR 人员设置未完成"), `${scenario.name}: inspector displays participant failure`);
      check(![...dialog.querySelectorAll("dt")].some(row => row.textContent === "MR 人员"), `${scenario.name}: blank failure row remains`);
    } else {
      check(dialog.textContent?.includes(scenario.resultStatus === "applied" ? "已按模块配置设置 MR 人员。" : "已有 MR 保留原人员设置。"), `${scenario.name}: success or existing MR message missing`);
    }
    if (scenario.name === "admin-other-task") {
      check(buttons(dialog).some(button => button.textContent?.trim() === "纠正单号"), "MR permission changed unrelated administrator actions");
    }
    root.render(null);
    await until(() => !document.querySelector('[role="dialog"]'), `${scenario.name}: dialog did not close`);
  }
  check(!errors.length, errors.join("; "));
  return { passed: true, scenarios: scenarios.map(scenario => scenario.name), width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); })
  .finally(() => root.unmount());
