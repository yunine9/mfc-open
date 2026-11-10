import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleHome } from "../../web/src/KnowledgeModuleHome";
import { HistoryBoard } from "../../web/src/HistoryBoard";
import type { KnowledgeTaskRow } from "../../src/knowledgeTaskCenterTypes";
import type { TaskSummary, TaskHistoryEntry } from "../../web/src/api";

const scene = new URLSearchParams(location.search).get("scene") ?? "home";
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 100 && !predicate(); i++) await pause(); check(predicate(), message); }
const errors: string[] = [];
addEventListener("error", event => errors.push(event.message));
addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const modules = [
  { id: "empty", name: "待建模块", description: "尚未开始知识建设" },
  { id: "trade", name: "交易业务", description: "订单取消、支付回调与库存回补" },
  { id: "archived", name: "告警管理", description: "告警订阅、收敛与恢复" },
  { id: "research", name: "数据采集", description: "能力盘点与边界核对" },
  { id: "published", name: "设备管理", description: "现有知识已发布，等待 Git 归档" },
].map(module => ({ ...module, status: "active", repositories: [], assets: [] }));
const task = (id: string, module_id: string, count: number, patch: Partial<KnowledgeTaskRow> = {}): KnowledgeTaskRow => ({ id, module_id, title: id, kind: "domain", status: "running", status_label: "研究中", group: "running", created_at: "2026-10-16", next_action: { id: "progress", label: "查看进展", view: "progress" }, document_summary: { total: count, published: 0, drafts: count, process: 0 }, module_entry: { kind: "task" }, ...patch });
let tasks = [
  task("old-trade", "trade", 90, { created_at: "2026-10-01" }),
  task("new-trade", "trade", 10, { document_summary: { total: 10, published: 0, drafts: 8, process: 2 } }),
  task("archived-task", "archived", 12, { status: "done", status_label: "已归档", module_entry: { kind: "document", document_id: "kd-alarm" }, document_summary: { total: 12, published: 12, drafts: 0, process: 0 } }),
  task("research-task", "research", 3, { document_summary: { total: 3, published: 0, drafts: 0, process: 3 } }),
  task("published-task", "published", 8, { status_label: "已发布（未归档）", document_summary: { total: 8, published: 8, drafts: 0, process: 0 } }),
];
const saved = (id: string, title: string, parent_task_id?: string): TaskHistoryEntry => ({ id, title, parent_task_id, requirement: title, status: "completed", created_at: "2026-10-01", updated_at: "2026-10-16", workspace: `/w/${id}`, luban_account: "alice", event_count: 4 } as TaskHistoryEntry);
const entries = [saved("child-a", "订单服务变更", "parent"), saved("other", "单仓独立需求"), saved("parent", "跨仓订单能力优化"), saved("child-b", "库存服务变更", "parent"), saved("orphan", "已回收主任务的子任务", "removed-parent")];
const current = scene === "archive-pg" ? [] : entries;
const calls: string[] = [], opened: string[] = [];
window.fetch = async url => {
  const path = String(url); calls.push(path);
  let result: unknown;
  if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/business-modules") result = { modules, warnings: [], operations: [] };
  else if (path === "/skills") result = { skills: [], warnings: [], operations: [] };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/history") {
    if (scene === "archive-local") return new Response(JSON.stringify({ error: "未启用历史投影" }), { status: 404, headers: { "content-type": "application/json" } });
    result = entries;
  } else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
const frame = (child: React.ReactNode) => <div className="tw-root"><header style={{ padding: "20px 32px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}><strong>MAE-Flow Cloud</strong><span style={{ marginLeft: 30, color: "var(--muted)" }}>{scene === "home" ? "知识库" : "成果档案 · 需求交付"}</span></header><main style={{ margin: "28px auto", padding: "0 32px", maxWidth: 1560 }}>{child}</main></div>;
function mountHome() { root.render(frame(<KnowledgeModuleHome researchTasks={tasks} onOpenResearch={id => opened.push(`task:${id}`)} onOpenDocument={id => opened.push(`document:${id}`)} onOpenModule={key => opened.push(`module:${key}`)} />)); }
async function run() {
  if (scene === "home") {
    mountHome();
    await until(() => document.querySelectorAll(".km-module-card").length === 5, "模块卡片加载");
    const cards = [...document.querySelectorAll<HTMLElement>(".km-module-card")];
    check(cards[0].textContent?.includes("告警管理") && cards[0].textContent?.includes("已归档"), "已归档排最前");
    check(cards.slice(1, -1).every(card => card.textContent?.includes("建设中")) && cards.at(-1)?.textContent?.includes("未建设"), "建设中排中间，未建设排最后");
    const trade = cards.find(card => card.textContent?.includes("交易业务"))!;
    check(/文档：10/.test(trade.textContent!) && !/文档：100/.test(trade.textContent!), "最新任务显示10篇，不与旧任务90篇累加");
    check(trade.textContent?.includes("建设中") && !/最新一次|待审文稿|过程记录|统计口径/.test(document.querySelector(".km-home")!.textContent!), "卡片保持文档数量与建设中简洁展示");
    trade.querySelector<HTMLButtonElement>("button")!.click();
    cards[0].querySelector<HTMLButtonElement>("button")!.click();
    cards.find(card => card.textContent?.includes("设备管理"))!.querySelector<HTMLButtonElement>("button")!.click();
    check(opened.join(",") === "task:new-trade,document:kd-alarm,task:published-task", "未归档进最新任务，已归档进对应正式文档，已发布未归档仍进任务");
    check(new Set(cards.map(card => getComputedStyle(card).borderTopColor)).size >= 3, "卡片有可辨认的状态色块");
    tasks = [...tasks, task("newest-empty", "trade", 0, { created_at: "2026-10-17" })]; mountHome(); await pause();
    const latestCard = [...document.querySelectorAll(".km-module-card")].find(card => card.textContent?.includes("交易业务"))!;
    check(/文档：0/.test(latestCard.textContent!), "新任务还没产稿时如实显示0");
    latestCard.querySelector<HTMLButtonElement>("button")!.click(); check(opened.at(-1) === "task:newest-empty", "数量与跳转使用同一任务");
    tasks = tasks.filter(task => task.id !== "newest-empty"); mountHome(); await pause();
    check(!calls.some(path => path.startsWith("/domain-extraction")), "卡片不加载研究全文，不启动研究");
  } else {
    root.render(frame(<HistoryBoard tasks={current as TaskSummary[]} viewer={{ username: "viewer", role: "user" } as any} onChanged={() => {}} onOpenTask={task => opened.push(task.id)} />));
    await until(() => document.querySelectorAll("[data-task-id]").length === 5, "归档列表加载");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-task-id]")];
    check(rows.map(row => row.dataset.taskId).join(",") === "other,parent,child-a,child-b,orphan", "主子任务连续展示");
    check(rows[1].textContent?.includes("主任务 · 2 个子任务"), "显示主任务与子任务数");
    check(rows[2].textContent?.includes("子任务") && rows[2].textContent?.includes("跨仓订单能力优化"), "子任务标明所属主任务");
    check(rows[2].getBoundingClientRect().left > rows[1].getBoundingClientRect().left, "子任务缩进");
    check(rows[4].textContent?.includes("removed-parent"), "主任务不在列表时保留来源编号");
    const parent = rows[2].querySelector<HTMLButtonElement>('[aria-label="返回主任务：parent"]')!;
    if (scene === "archive-local") { check(!parent.disabled, "本地父任务可打开"); parent.click(); check(opened[0] === "parent", "点击返回正确主任务"); }
    else check(parent.disabled, "现场回收后不提供不可用的跳转");
  }
  check(document.documentElement.scrollWidth <= innerWidth, "桌面无横向溢出");
  check(!errors.length, errors.join("; "));
  return { passed: true, scene, width: innerWidth, opened };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
