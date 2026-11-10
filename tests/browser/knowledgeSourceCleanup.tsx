import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DomainKnowledgeExtraction } from "../../web/src/DomainKnowledgeExtraction";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import { projectKnowledgeProduction } from "../../src/knowledgeProductionState";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

const scenario = new URLSearchParams(location.search).get("scenario");
const repositories = [1, 2].map(id => ({ id: `repo-${id}`, name: id === 1 ? "订单仓" : "交易仓", repository: `https://example.test/业务来源仓库-${id}.git`, branch: "main", path: "", docs_path: scenario === "module" ? "docs/knowledge/orders" : "docs/old" }));
let job: DomainKnowledgeJob = { id: "dkx-browser", title: "订单业务知识", scope: "订单规则", issue_no: "REQ-cleanup", issue_description: "清理旧知识并重新萃取",
  ...(scenario === "module" ? { module_id: "orders", knowledge_layout: "module-v1" as const } : {}),
  operator: "alice", created_at: "2026-10-08T00:00:00Z", knowledge_target: repositories[0], repositories: [repositories[1]], status: "idle", stage: "等待人工清理旧知识",
  material_ids: [], revisions: {}, documents: [], turns: [], evidence: [], publications: [], source_cleanup: { repositories, plans: [], publications: [] } };
const calls: Array<{ path: string; body: any }> = [];
let published = 0;
const projected = () => ({ ...structuredClone(job), production: projectKnowledgeProduction({ kind: "domain", record: job }) });
window.fetch = async (url, options) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, body }); let value: unknown;
  if (path === "/business-modules") value = { modules: [] };
  else if (path === "/knowledge-tasks") value = { summary: { running: 0, attention: 1, total: 1 }, tasks: [], warnings: [] };
  else if (path === "/memory-insights") value = { memories: [] };
  else if (path === "/domain-extraction") value = { records: [projected()] };
  else if (path === `/domain-extraction/${job.id}/reader`) value = projected();
  else if (path.endsWith("/source-cleanup/preview")) {
    job.source_cleanup!.plans = repositories.map(repo => {
      const entries = Array.from({ length: 28 }, (_, index) => ({ path: `docs/old/业务规则-${index + 1}/历史知识及关联接口说明.md`, mode: "100644", oid: "a".repeat(40) }));
      return { id: `plan-${repo.id}`, target_id: repo.id, paths: body.paths_by_target[repo.id], target_revision: "a".repeat(40), entries, selected_paths: entries.map(entry => entry.path) };
    }); value = projected();
  } else if (path.endsWith("/source-cleanup/publish")) {
    published++;
    job.source_cleanup!.plans.forEach(plan => { plan.selected_paths = body.selected_paths_by_target[plan.target_id]; });
    job.source_cleanup!.publications = repositories.map(repo => ({ target_id: repo.id, cleanup_plan_id: `plan-${repo.id}`, removed_paths: body.selected_paths_by_target[repo.id],
      documents: [], branch: `codex/cleanup-${repo.id}`, revision: "b".repeat(40), state: scenario === "partial" && published === 1 && repo.id === "repo-2" ? "failed" : "opened",
      ...(scenario === "partial" && published === 1 && repo.id === "repo-2" ? { error: "交易仓暂时无法创建 MR，请重试" } : { url: `https://example.test/mr/${repo.id}` }) })); value = projected();
  } else if (path.endsWith("/source-cleanup/start")) { job.source_cleanup!.started = true; job.status = "running"; value = projected(); }
  else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
function showLibrary() {
  history.replaceState({}, "", `?kbPage=task&kbKind=domain&kbTask=${job.id}&scenario=${scenario}`);
  root.render(<div className="tw-root" style={{ height: "100vh" }}><KnowledgeLibrary onOpenTask={() => {}} /></div>);
}
if (scenario === "return") showLibrary();
else root.render(<div className="tw-root knowledge-hub is-focused" style={{ height: "100vh" }}><div className="knowledge-hub-task"><DomainKnowledgeExtraction focused focusId={job.id} onBack={() => {}} /></div></div>);
const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getClientRects().length && node.textContent?.trim() === label);
async function click(label: string) { const node = button(label); check(node && !node.disabled, `按钮不可用：${label}`); node!.click(); await pause(); }
function desktop(label: string) {
  const node = button(label)!; const box = node.getBoundingClientRect();
  check(box.top >= 0 && box.bottom <= innerHeight + 1, `主按钮离开桌面可视区：${label} ${JSON.stringify(box.toJSON())}`);
  check(document.documentElement.scrollWidth <= innerWidth + 2, "横向溢出");
  check(!button("保存") && !button("确认保存"), "清理不应增加额外保存环节");
}
async function run() {
  for (let attempt = 0; attempt < 40 && !button("预览待删文件"); attempt++) await pause();
  desktop("预览待删文件"); check(!calls.some(call => call.path.includes("source-cleanup/start")), "清理前不能自动研究");
  if (scenario === "module") {
    for (const repo of repositories) {
      const input = document.querySelector<HTMLTextAreaElement>(`[aria-label="${repo.name}清理路径"]`);
      check(input?.value === repo.docs_path, "模块任务清理默认只包含自己的独占目录，不能包含根AGENTS");
    }
    check(document.body.textContent?.includes("仓根 AGENTS.md、公共目录和其他模块文档保留"), "明确说明共享仓清理边界");
    root.unmount(); return { passed: true };
  }
  await click("预览待删文件");
  const checkbox = document.querySelector<HTMLInputElement>('[aria-label="删除 订单仓 docs/old/业务规则-1/历史知识及关联接口说明.md"]')!;
  checkbox.click(); await pause(); check(!checkbox.checked, "取消勾选应保留文件");
  desktop("创建 2 个清理 MR");
  if (scenario === "return") {
    // 使用真实知识库父页面离开再进入任务，不能只模拟组件内刷新。
    await click("返回任务中心");
    history.pushState(history.state, "", `?kbPage=task&kbKind=domain&kbTask=${job.id}&scenario=${scenario}`); dispatchEvent(new PopStateEvent("popstate"));
    for (let attempt = 0; attempt < 40 && !button("创建 2 个清理 MR"); attempt++) await pause();
    check(!document.querySelector<HTMLInputElement>('[aria-label="删除 订单仓 docs/old/业务规则-1/历史知识及关联接口说明.md"]')!.checked, "离开任务再返回不能清空保留选择");
    desktop("创建 2 个清理 MR");
  }
  if (scenario !== "preview") {
    await click("创建 2 个清理 MR");
    const body = calls.find(call => call.path.endsWith("/source-cleanup/publish"))!.body;
    check(body.selected_paths_by_target["repo-1"].length === 27 && body.selected_paths_by_target["repo-2"].length === 28, "仅提交用户选中的文件");
    check(!calls.some(call => call.path.endsWith("/source-cleanup/start")), "创建 MR 后仍由人开始萃取");
    if (scenario === "partial") {
      desktop("重试 1 个清理 MR"); check(document.querySelector<HTMLInputElement>('[aria-label="删除 订单仓 docs/old/业务规则-1/历史知识及关联接口说明.md"]')!.disabled, "成功仓的删除选择应锁定");
      await click("重试 1 个清理 MR");
    }
    desktop("开始萃取"); check(document.querySelectorAll('a[href^="https://example.test/mr/"]').length === 2, "两仓 MR 结果应直接可达");
    for (const link of document.querySelectorAll('a[href^="https://example.test/mr/"]')) { const box = link.getBoundingClientRect(); check(box.top >= 0 && box.bottom <= innerHeight, "清理 MR 链接应直接可见"); }
    if (scenario === "start") { await click("开始萃取"); check(job.source_cleanup!.started, "人工开始后才进入研究"); check(!document.querySelector('[aria-label="萃取前清理旧知识"]'), "已开始研究应离开清理界面"); }
  }
  if (!(window as any).__KEEP_CLEANUP_PREVIEW__) root.unmount();
  return { passed: true };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
