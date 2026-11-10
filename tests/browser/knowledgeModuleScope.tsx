import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleReader } from "../../web/src/KnowledgeModuleReader";
import { KnowledgeModuleHome } from "../../web/src/KnowledgeModuleHome";
import { cachedKnowledgeModules } from "../../web/src/knowledgeModules";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";
import type { BusinessModuleKnowledgeScope } from "../../web/src/api";

const repositories = Array.from({ length: 6 }, (_, index) => `https://git.example.test/platform/${["shared-service", "order-service", "payment-service", "inventory-service", "gateway-service", "notification-service"][index]}.git`);
let scope: BusinessModuleKnowledgeScope = { module_revision: 1, repositories: repositories.map((repository, index) => ({
  repository, directories: ["docs", "docs/交易", "docs/交易/接口说明", ...Array.from({ length: 16 }, (_, item) => `docs/公共能力-${String(item + 1).padStart(2, "0")}`)],
  files: ["docs/README.md", "docs/FAQ.md", "docs/交易.md", "docs/交易/规则.md", "docs/交易/接口说明/查询接口.md"],
  excluded_paths: index === 1 ? ["docs/历史目录"] : [],
})) };
const shared = (id: string, path: string): KnowledgeDocument => ({
  id, title: path === "AGENTS.md" ? "仓库导航" : "交易规则", content: `# ${path === "AGENTS.md" ? "仓库导航" : "交易规则"}\n\n这是已经合入代码仓的正式知识。`, scope: "repository",
  module_ids: ["trade", "inventory"], repositories: [repositories[0]], technologies: [], product_versions: [], active: true,
  when_to_use: "", revision: "body-1", history: [], source: { repository: repositories[0], branch: "main", path, revision: "commit-1" },
});
const documents = [shared("kg-trade", "docs/交易/规则.md"), shared("kg-agents", "AGENTS.md"), shared("kg-readme", "docs/README.md"), shared("kg-faq", "docs/FAQ.md"),
  ...["trade", "inventory"].map(id => ({ ...shared(`kg-${id}-domain`, `Function_Knowledge/Access Function/${id}/README.md`), title: "领域概览", content: "# 领域概览\n\n正式领域文档。", scope: "module" as const, module_ids: [id], repositories: [] }))];
let conflict = false, saves = 0;
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (url, options) => {
  const path = String(url);
  let result: unknown, status = 200;
  if (path === "/business-modules/trade/knowledge-scope") {
    if (options?.method === "PUT") {
      if (conflict) { status = 409; result = { error: "模块已被更新，请重新读取目录" }; }
      else {
        const body = JSON.parse(String(options.body)); check(body.expected_revision === scope.module_revision, "保存必须携带当前模块版本");
        scope = { ...scope, module_revision: scope.module_revision + 1, repositories: scope.repositories.map(repo => ({ ...repo, excluded_paths: body.repositories.find((next: any) => next.repository === repo.repository).excluded_paths })) };
        saves++;
      }
    }
    result ??= scope;
  } else if (path === "/knowledge-documents?view=directory") result = { revision: String(scope.module_revision), documents: documents.map(doc => {
    const excluded = doc.repositories.includes(repositories[0]) && scope.repositories[0].excluded_paths.some(parent => doc.source!.path === parent || doc.source!.path.startsWith(`${parent}/`));
    return { ...doc, module_ids: excluded ? ["inventory"] : doc.module_ids };
  }) };
  else if (path.startsWith("/knowledge-documents/")) result = documents.find(doc => doc.id === path.split("/")[2]);
  else if (path === "/business-modules") result = { modules: ["trade", "inventory"].map(id => ({ id, name: id === "trade" ? "交易业务" : "库存业务", status: "active", description: "关联代码仓中的正式知识", revision: scope.module_revision, repositories, assets: [] })) };
  else if (path.endsWith("/knowledge-location")) result = { configured: true, location: { repository: "https://git.example.test/knowledge.git", branch: "main", docs_path: "Function_Knowledge/Access Function/交易业务" }, sync: { state: "ready", document_count: 999, synced_at: "2026-10-20T08:00:00Z" } };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/skills?view=directory") result = { skills: [], operations: [] };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
};
function Preview() {
  const [moduleKey, setModule] = useState("");
  return <div className="tw-root knowledge-hub is-focused" style={{ height: "100vh", padding: 24 }}>
    {moduleKey ? <KnowledgeModuleReader moduleKey={moduleKey} selectedDocumentId="kg-trade" onBack={() => setModule("")} onResearch={() => {}} onAsk={() => {}} />
      : <KnowledgeModuleHome onOpenModule={setModule} />}
  </div>;
}
const root = createRoot(document.getElementById("app")!); root.render(<Preview />);
const pause = () => new Promise(resolve => setTimeout(resolve, 70));
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 60 && !predicate(); i++) await pause(); check(predicate(), message); }
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getClientRects().length && node.textContent?.trim() === label);
async function click(label: string) { const node = button(label); check(node && !node.disabled, `按钮不可用：${label}`); node!.click(); await pause(); }
function checkbox(repository: string, path: string) { return document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${repository} ${path}"]`)!; }
function counts(trade: number) {
  const card = (name: string) => document.querySelector(`[aria-label="打开${name}知识目录"]`);
  const modules = cachedKnowledgeModules()?.modules;
  return card("交易业务") && card("库存业务")
    && modules?.find(module => module.id === "trade")?.documentCount === trade
    && modules?.find(module => module.id === "inventory")?.documentCount === 5;
}
async function openReader() {
  const entry = document.querySelector<HTMLElement>('[aria-label="打开交易业务知识目录"]'); check(entry, "交易模块入口"); entry!.click();
  await until(() => button("筛选文档"), "正式阅读页提供筛选入口");
}
async function openFilter() { await click("筛选文档"); await until(() => checkbox(repositories[0], "docs"), "读取未过滤目录与文件"); }
async function run() {
  await until(() => counts(5), "初始两个模块文档数量各为 5，不使用同步状态的原始计数");
  await openReader(); await openFilter();
  check(document.querySelectorAll('[aria-label="代码仓文档筛选"] section').length === 6, "6 个关联仓全部可编辑");
  check(checkbox(repositories[0], "docs/README.md").closest("label")?.querySelector('svg[aria-label="文件"]'), "docs 根下独立文件可选且显示文件图标");
  check(checkbox(repositories[0], "docs/交易").closest("label")?.querySelector('svg[aria-label="目录"]'), "目录显示目录图标");
  check(checkbox(repositories[0], "docs/交易/规则.md").compareDocumentPosition(checkbox(repositories[0], "docs/交易.md")) & Node.DOCUMENT_POSITION_FOLLOWING, "同级文件不能插入目录子树中间");
  check(!checkbox(repositories[0], "AGENTS.md"), "仓根 AGENTS.md 不可排除");
  checkbox(repositories[0], "docs/交易").click(); await pause();
  check(checkbox(repositories[0], "docs/交易/接口说明").getAttribute("aria-disabled") === "true" || checkbox(repositories[0], "docs/交易/接口说明").hasAttribute("disabled"), "排除父目录后子目录禁用");
  check(checkbox(repositories[0], "docs/交易/接口说明/查询接口.md").getAttribute("aria-disabled") === "true" || checkbox(repositories[0], "docs/交易/接口说明/查询接口.md").hasAttribute("disabled"), "排除父目录同时排除并禁用嵌套文件");
  check(checkbox(repositories[0], "docs").getAttribute("aria-checked") === "mixed", "父目录显示部分选择");
  await click("保存"); await until(() => !document.querySelector('[role="dialog"][data-open]'), "保存自动关闭弹窗");
  await until(() => document.querySelector('[aria-label="交易业务知识阅读器"] .knowledge-markdown')?.textContent?.includes("正式领域文档"), "排除当前共享文稿后仍在当前模块，自动阅读保留的文稿");
  check(!document.querySelector('[aria-label="库存业务知识阅读器"]'), "不能因为共享文稿被排除而切到其他模块");
  await click("返回知识库"); await until(() => counts(4), "目录筛选保存后目录数据减少且另一模块不变");
  await openReader(); await openFilter();
  check(checkbox(repositories[0], "docs/交易").getAttribute("aria-checked") === "false", "再次打开仍能看到被排除目录");
  check(checkbox(repositories[1], "docs/历史目录"), "已存但当前快照不存在的排除项也可恢复");
  await click("恢复全部"); await click("取消");
  await openFilter();
  check(checkbox(repositories[0], "docs/交易").getAttribute("aria-checked") === "false", "取消不持久化恢复全部");
  await click("恢复全部"); await click("保存"); await until(() => saves === 2 && !document.querySelector('[role="dialog"][data-open]'), "恢复全部已保存");
  check(scope.repositories.every(repo => !repo.excluded_paths.length), "恢复全部清空本模块各仓排除项");
  await click("返回知识库"); await until(() => counts(5), "恢复后目录数据恢复，另一模块不变");
  await openReader(); await openFilter();
  checkbox(repositories[0], "docs/README.md").click(); await pause();
  check(checkbox(repositories[0], "docs/FAQ.md").getAttribute("aria-checked") === "true", "单文件排除不影响相邻文件");
  check(checkbox(repositories[0], "docs/交易/规则.md").getAttribute("aria-checked") === "true", "单文件排除不影响其他目录文件");
  await click("保存"); await until(() => saves === 3 && !document.querySelector('[role="dialog"][data-open]'), "单文件排除已保存");
  check(scope.repositories[0].excluded_paths.length === 1 && scope.repositories[0].excluded_paths[0] === "docs/README.md", "仅保存被排除的文件路径");
  await click("返回知识库"); await until(() => counts(4), "单文件排除后目录数据减少，另一模块不变");
  await openReader(); await openFilter();
  check(checkbox(repositories[0], "docs/README.md").getAttribute("aria-checked") === "false", "已排除文件仍可见并可恢复");
  check(checkbox(repositories[0], "docs/FAQ.md").getAttribute("aria-checked") === "true", "重新打开相邻文件仍保持勾选");
  checkbox(repositories[0], "docs/README.md").click(); await pause();
  await click("保存"); await until(() => saves === 4 && !document.querySelector('[role="dialog"][data-open]'), "单文件重新勾选已保存");
  await click("返回知识库"); await until(() => counts(5), "恢复单文件后目录数据恢复，另一模块不变");
  await openReader(); await openFilter();
  checkbox(repositories[0], "docs/交易").click(); await pause(); conflict = true;
  await click("保存");
  check(document.querySelector('[role="alert"]')?.textContent?.includes("模块已被更新"), "并发冲突留在弹窗中明确显示");
  check(checkbox(repositories[0], "docs/交易").getAttribute("aria-checked") === "false", "失败保留待保存选择");
  conflict = false; await click("重新读取"); await until(() => checkbox(repositories[0], "docs/交易")?.getAttribute("aria-checked") === "true", "重新读取取得已保存状态");
  checkbox(repositories[0], "docs/交易").click(); await pause();
  checkbox(repositories[0], "docs/README.md").click(); await pause();
  const panel = document.querySelector<HTMLElement>('[aria-label="代码仓文档筛选"]')!;
  check(panel.scrollHeight > panel.clientHeight, "长目录在弹窗内滚动");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-open]')!.getBoundingClientRect();
  check(dialog.top >= 0 && dialog.bottom <= innerHeight, "弹窗处于桌面视区内");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "无横向溢出");
  for (const label of ["保存", "取消", "恢复全部"]) { const box = button(label)!.getBoundingClientRect(); check(box.top >= 0 && box.bottom <= innerHeight, `${label}始终可见`); }
  if (new URLSearchParams(location.search).get("position") === "bottom") panel.scrollTop = panel.scrollHeight;
  check(!errors.length, errors.join("\n"));
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth, height: innerHeight, saves });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
