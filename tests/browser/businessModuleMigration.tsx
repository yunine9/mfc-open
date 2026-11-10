import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ConfigurationCenter } from "../../web/src/ConfigurationCenter";

const pause = () => new Promise(resolve => setTimeout(resolve, 35));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const sourceName = "原业务模块";
const targetName = "新的业务模块";
let rows = ["old", "new", "archived"].map(id => ({ id, name: id === "old" ? sourceName : id === "new" ? targetName : "已停用模块", description: "模块说明", repositories: [`https://code.example/${id}.git`],
  status: id === "archived" ? "archived" : "active", assets: [], owner: "expert", maintainers: [], can_manage: true }));
let posts = 0, fail = true;
window.fetch = async (input, options) => {
  const path = String(input);
  if (path === "/business-modules") return Response.json({ modules: rows, warnings: [], operations: [] });
  check(path === "/business-modules/old/migration", `未知请求 ${path}`);
  if (options?.method === "POST") {
    posts++; check(JSON.parse(String(options.body)).target_id === "new", "目标模块错误");
    if (fail) return Response.json({ error: "目标模块已停用，请刷新后重试" }, { status: 400 });
    rows = rows.filter(row => row.id !== "old"); return Response.json(rows.find(row => row.id === "new"));
  }
  return Response.json({ documents: 110, extraction_tasks: 3, delivery_tasks: 28, issue_sessions: 16 });
};
createRoot(document.getElementById("app")!).render(<main className="tw-root mx-auto max-w-[1480px] p-8"><h1 className="mb-6 text-2xl font-semibold">配置中心</h1><ConfigurationCenter /></main>);
const visible = (element: Element) => element.getClientRects().length > 0;
function button(label: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => visible(element) && (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label); }
async function until(predicate: () => unknown) { for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(); } throw new Error(`等待超时：${document.body.innerText}`); }
async function click(label: string) { await until(() => button(label) && !button(label)!.disabled); button(label)!.click(); await pause(); }
async function selectTarget() {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="目标模块"]')!;
  check(select, "缺少目标选择框");
  check(![...select.options].some(option => option.value === "old" || option.value === "archived"), "不能选择自己或停用模块");
  select.value = "new"; select.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
async function run() {
  await click(`迁移 ${sourceName}`);
  await until(() => document.body.innerText?.includes("文档：110"));
  check(button("确认迁移")!.disabled, "没有选择目标不能确认");
  await selectTarget();
  const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
  check(dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight, "弹窗越出桌面窗口");
  const capture = new URLSearchParams(location.search).has("preview");
  if (capture) return { passed: true, width: innerWidth, mode: "preview" };
  await click("取消"); check(posts === 0, "取消时不能提交迁移");
  await click(`迁移 ${sourceName}`); await until(() => document.body.innerText?.includes("文档：110")); await selectTarget();
  await click("确认迁移"); await until(() => document.body.innerText?.includes("目标模块已停用"));
  check(document.querySelector<HTMLSelectElement>('select[aria-label="目标模块"]')!.value === "new", "失败应保留所选目标");
  fail = false; await click("确认迁移");
  await until(() => !document.querySelector('select[aria-label="目标模块"]') && !button(`迁移 ${sourceName}`));
  check(button(`迁移 ${targetName}`), "目标模块应保留"); check(posts === 2, "提交次数不符");
  check(!document.body.innerText?.includes(sourceName), "成功后旧模块仍可见");
  return { passed: true, width: innerWidth, mode: "complete" };
}
void run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error?.stack ?? error) }); });
