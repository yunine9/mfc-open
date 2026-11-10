import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { IssueNavGroup } from "../../web/src/App";
import { IssueBoard, type IssueChildTab } from "../../web/src/issues/IssueBoard";
import type { IssueDetail } from "../../web/src/api";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarProvider } from "../../web/src/components/ui/sidebar";

const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function until(test: () => unknown, message: string) { for (let i = 0; i < 60 && !test(); i++) await pause(); check(test(), message); }
function button(text: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text);
  check(value, `按钮不存在：${text}`); return value!;
}
const calls: Array<{ url: string; method: string }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const now = "2026-11-02T08:00:00Z";
const mr = { url: "https://codehub.test/team/repo/merge_requests/1288", iid: "1288", title: "认证模块配置修复", repo: "https://codehub.test/team/repo.git", source_branch: "feature/fix", target_branch: "main", sha: "a".repeat(40), state: "opened" as const };
const detail: IssueDetail = { id: "mr-repair-1288", account: "alice", reporter: "alice", title: mr.title, description: "修复已有 MR 的编译、测试和代码质量失败", source: "manual", scenario: "mr_repair", imported_mr: mr, stage: "mr_green", stage_states: ["in_progress"], round: 1,
  status: "running", stage_note: "已读取编译失败日志，正在原工作区验证修复", stage_at: now, created_at: now, updated_at: now,
  repo_url: mr.repo, repo_urls: [mr.repo], baseline: mr.target_branch, has_analysis: false,
  mrs: [{ repo: mr.repo, branch: mr.source_branch, target: mr.target_branch, title: mr.title, url: mr.url, iid: mr.iid, at: now }],
  pipelines: { [mr.repo]: { sha: mr.sha, status: "failed", watching: false, round: 1, started_at: now, deadline: now } } };
const oldIssue = { ...detail, id: "issue-old", title: "原有问题处理会话", scenario: "ticket", imported_mr: undefined, stage: "analyze", ticket: "DTS-123", stage_states: ["done", "done", "in_progress", "pending", "pending"] };
let imported = false, failImport = true;
window.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? "GET"; calls.push({ url, method });
  if (url === "/pipeline-repairs" && method === "POST") {
    check(JSON.parse(String(init?.body)).mr_url === mr.url, "提交 MR 链接");
    if (failImport) { failImport = false; return Response.json({ error: "MR 详情暂时不可用，请重试" }, { status: 503 }); }
    imported = true; return Response.json(detail, { status: 201 });
  }
  if (url === "/issues") return Response.json({ issues: [oldIssue] });
  if (url === "/pipeline-repairs") return Response.json({ issues: imported ? [detail] : [] });
  if (url === `/pipeline-repairs/${detail.id}`) return Response.json(detail);
  if (url.endsWith("/reviews")) return Response.json({ reviews: [], checks: [], review_active: false });
  if (url.endsWith("/materials")) return Response.json({ pushes: [], mrs: detail.mrs, changes: [], logs: { entries: [], truncated: false } });
  if (url.endsWith("/conversation")) return Response.json({ items: [{ kind: "session", id: "start", ts: now, phase: "started", detail: "从已有 MR 开始" }], events_seen: 1, truncated: false });
  if (url.includes("/diff")) return Response.json({ diff: "" });
  if (url.endsWith("/code-origin")) return Response.json({ unavailable: "尚无本轮推送" });
  if (url === "/business-modules") return Response.json({ modules: [] });
  throw new Error(`未预期的接口：${method} ${url}`);
};
function Shell() {
  const [tab, setTab] = useState<IssueChildTab>("sessions"), [id, setId] = useState("");
  return <SidebarProvider style={{ "--sidebar-width": "228px" } as React.CSSProperties}>
    <Sidebar collapsible="none" className="sticky top-0 h-svh">
      <SidebarHeader><div className="px-4 py-5 text-base font-semibold">Mae-Flow</div></SidebarHeader>
      <SidebarContent className="sidebar-reset"><SidebarGroup><SidebarGroupLabel>个人工作台</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
        <IssueNavGroup view="issues" current="issues" childTab={tab} onSelectChild={next => { setId(""); setTab(next); }} onSelect={() => {}} />
      </SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
    </Sidebar>
    <SidebarInset><main className={id ? "px-6 py-5" : "mx-auto w-full max-w-(--page-width) px-10 py-8"}>
      {!id && <><h1 className="mb-2 text-[28px] font-semibold text-text-strong">{tab === "pipeline" ? "流水线修复" : "问题会话"}</h1>
      <p className="mb-7 text-sm text-muted-foreground">{tab === "pipeline" ? "独立修复已有 MR 的流水线，不计入 DTS 交付数据。" : "你的问题会话进展一览。"}</p></>}
      <IssueBoard viewer={{ username: "alice", role: "developer" }} childTab={tab} initialOpenId={id} onOpenIssue={setId} onCloseIssue={() => setId("")} onChildTabChange={setTab} />
    </main></SidebarInset>
  </SidebarProvider>;
}
const root = createRoot(document.getElementById("app")!);
document.body.dataset.view = "issues";
root.render(<Shell />);
async function run() {
  await until(() => document.body.textContent?.includes("原有问题处理会话"), "原有问题列表正常显示");
  const toolStart = calls.length;
  button("流水线修复").click();
  await until(() => document.querySelector<HTMLFormElement>('[aria-label="从已有 MR 开始"]')?.hidden === false, "导入入口可见");
  check(!document.querySelector("#issue-mine-title")?.parentElement?.parentElement?.parentElement?.textContent?.includes("原有问题处理会话"), "修复列表不混入其他问题");
  check(document.body.textContent?.includes("还没有流水线修复记录"), "复用列表的空态说明");
  const input = document.getElementById("issue-mr-url") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, mr.url);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  button("开始修复").click();
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("MR 详情暂时不可用"), "失败留在原表单可重试");
  check(input.value === mr.url && !button("开始修复").disabled, "输入保留且按钮恢复");
  if (!location.search.includes("import")) {
    button("开始修复").click();
    await until(() => document.querySelector(`[aria-label="流水线修复:${mr.title}"]`), "导入后打开真正的问题工作台");
    check(document.querySelector('[aria-label="与 Agent 协作"]'), "复用协作区域");
    check(document.body.textContent?.includes("流水线修复工具 · 独立记录"), "不伪装前置步骤已完成");
    check(!document.querySelector(".ws-head .ws-progress"), "单阶段工具不显示右上角进度条");
    for (const label of ["元信息", "分析报告", "工作区变更", "对话现场"]) check(document.querySelector(`[role="tab"]`) && document.body.textContent?.includes(label), `复用${label}页签`);
    check(document.querySelector('[aria-label="会话内容"] a[href="' + mr.url + '"]'), "原 MR 链接在原工作台显示");
    check(!document.querySelector('[aria-label="调整关联仓"]'), "已有 MR 固定源仓库不显示增删入口");
    check(!document.body.textContent?.includes("无单场景"), "场景标识准确");
    check(!document.body.textContent?.includes("DTS单据"), "已有 MR 不伪造单据");
    check(calls.some(call => call.url.endsWith("/conversation")), "使用原生协作接口");
  }
  check(calls.slice(toolStart).every(call => !call.url.startsWith("/issues")), "工具只使用独立 API，不读取问题列表或 DTS");
  check(errors.length === 0, errors.join("; "));
  const controls = [...document.querySelectorAll<HTMLElement>('button,input,[role="tab"]')].filter(el => el.getBoundingClientRect().width > 0);
  check(controls.every(el => el.getBoundingClientRect().right <= innerWidth + 1), "桌面控件没有横向溢出");
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
