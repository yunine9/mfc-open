import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DeliveryAnalytics } from "../../web/src/DeliveryAnalytics";
import { KnowledgeModuleHome } from "../../web/src/KnowledgeModuleHome";

const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const errors: string[] = [], calls: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const local = (day: string) => new Date(day).toISOString();
const rows = [
  { id: "task-start", title: "旧任务本日完成", completed_at: local("2026-10-08T00:00:00"), at: "2025-01-01T00:00:00Z" },
  { id: "task-end", title: "当日末尾完成", completed_at: local("2026-10-08T23:59:59.999"), at: "2025-01-01T00:00:00Z" },
  { id: "task-next", title: "次日完成", completed_at: local("2026-10-09T00:00:00"), at: "2026-10-08T12:00:00Z" },
  { id: "task-open", title: "当日创建仍未完成", at: local("2026-10-08T12:00:00") },
].map(row => ({ ...row, repo: "orders", modules: [], merged: row.id !== "task-open", unavailable: "测试记录无代码统计" }));
window.fetch = async url => {
  const path = String(url); calls.push(path); let data: unknown;
  if (path === "/delivery-analytics") data = { rows, generated_at: new Date().toISOString() };
  else if (path.startsWith("/issues/once-generated")) data = { threshold_percent: 90, supported_since: "2026-01-01", total: 0, delivered: 0, passed: 0, rate: null, pending: 0, unsupported: 0, no_code: 0, by_repo: [], per_session: [], localization: { total: 0, passed: 0, rate: null }, verify: { total: 0, passed: 0, rate: null }, solved: { total: 0, passed: 0, rate: null } };
  else if (path.startsWith("/issues/registration-stats")) data = { total: 0, non_issue: 0, issue_confirmed: 0, localization: { passed: 0, total: 0, rate: null }, per_session: [], by_module: [], by_reporter: [] };
  else if (path === "/knowledge-documents") data = { documents: [] };
  else if (path === "/business-modules") data = { modules: [{ id: "orders", name: "订单业务", status: "active", description: "订单生命周期", repositories: [], assets: [] }], warnings: [], operations: [] };
  else if (path === "/component-repositories") data = { components: [] };
  else if (path === "/skills") data = { skills: [], warnings: [], operations: [] };
  else throw new Error(`unexpected ${path}`);
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
const visible = (element: Element) => !!element.getClientRects().length;
async function until(test: () => unknown, message: string) { for (let i = 0; i < 60 && !test(); i++) await pause(); check(test(), message); }
async function click(text: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => visible(b) && b.textContent?.trim() === text); check(button, `missing ${text}`); button!.click(); await pause(); }
async function date(label: string, value: string) { const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; check(field, label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
function tableText() { return [...document.querySelectorAll("tbody")].map(el => el.textContent).join(" "); }
async function run() {
  root.render(<div className="tw-root" style={{ padding: 24 }}><DeliveryAnalytics onOpenTask={() => {}} /></div>);
  await until(() => tableText().includes("当日创建仍未完成"), "all-time list loaded");
  await date("完成开始日期", "2026-10-08"); await date("完成结束日期", "2026-10-08");
  check(tableText().includes("旧任务本日完成") && tableText().includes("当日末尾完成"), "completion range includes both boundaries of the local day");
  check(!tableText().includes("次日完成") && !tableText().includes("仍未完成"), "creation time and the next day are excluded");
  check([...document.querySelectorAll('input[type="date"]')].every(input => input.getBoundingClientRect().right <= innerWidth && input.getBoundingClientRect().width >= 150), "date controls fit desktop width");
  await date("完成结束日期", "2026-10-07");
  check(document.querySelector('[role="alert"]')?.textContent?.includes("开始日期不能"), "invalid range explained");
  await click("全部时间"); check(tableText().includes("仍未完成"), "clear dates restores full scope");
  for (const [tab, endpoint] of [["DTS", "/issues/once-generated"], ["登记问题", "/issues/registration-stats"]]) {
    await click(tab); await date("完成开始日期", "2026-10-08"); await date("完成结束日期", "2026-10-08");
    const query = new URL(calls.filter(path => path.startsWith(endpoint)).at(-1)!, "https://test.invalid").searchParams;
    check(query.get("completed_from") === local("2026-10-08T00:00:00") && query.get("completed_before") === local("2026-10-09T00:00:00"), `${tab} sends completion dates including the whole end day`);
    check([...document.querySelectorAll('input[type="date"]')].every(input => input.getBoundingClientRect().right <= innerWidth && input.getBoundingClientRect().width >= 150), `${tab} date controls fit desktop width`);
  }
  let opened = "";
  const home = (active: boolean) => <div style={{ padding: 24 }}><KnowledgeModuleHome onOpenModule={() => { opened = "directory"; }} onOpenResearch={id => { opened = id; }} moduleActivity={active ? [{ module_id: "orders", status_label: "建设中", task_id: "research-orders" }] : []} /></div>;
  root.render(home(true));
  await until(() => document.querySelector('[aria-label="查看订单业务建设任务"]'), "active empty module exposes research task");
  check(document.querySelector('[aria-label="业务模块"]')?.textContent?.includes("建设中") && !document.querySelector('[aria-label="业务模块"]')?.textContent?.includes("待建设"), "active research replaces pending-construction label");
  document.querySelector<HTMLButtonElement>('[aria-label="查看订单业务建设任务"]')!.click(); check(opened === "research-orders", "module opens the running task");
  root.render(home(false)); await pause();
  check(document.querySelector('[aria-label="业务模块"]')?.textContent?.includes("待建设"), "completed research no longer claims construction in progress");
  check(!errors.length, errors.join("; "));
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
