import React from "react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { flushSync } from "../../web/node_modules/react-dom";
import { ComponentKnowledgeWorkspace } from "../../web/src/ComponentKnowledgeWorkspace";
import type { ComponentGovernanceSnapshot, ComponentGovernanceItem } from "../../src/componentKnowledgeTypes";

declare global { interface Window { __COMPONENT_GIT_DELETION_MESSAGE__: string } }
const gitMessage = window.__COMPONENT_GIT_DELETION_MESSAGE__;

const rule: ComponentGovernanceItem = { id: "rule-thread", kind: "rule", original: "std::thread", source_digest: "abc",
  policy: { level: "shadow", source_digest: "abc", owner: "", scope: [], reason: "新候选，尚未人工启用", operator: "", updated_at: "" },
  paradigm: { component: "线程池", title: "后台任务的提交与等待", language: "cpp", need: "执行后台任务", api: ["Pool::Submit"], applicability: "已链接 Pool v2；底层线程适配器保留原生线程。",
    replaces: { identifiers: ["std::thread"], imports: [], patterns: [] }, document_id: "kd-pool", start_line: 24,
    evidence: [{ repository_id: "base", path: "src/pool.cpp", revision: "a".repeat(40), start: 30, end: 55 }], usage_evidence: ["everycode-example"] },
  samples: [{ id: "sample", repository: "https://code.example/consumer.git", checked_at: "2026-09-29", path: "src/work.cpp", line: 42, end_line: 42, rule_id: "rule-thread", need: "执行后台任务", component: "线程池", api: ["Pool::Submit"], applicability: "普通工作线程", document_id: "kd-pool", document_revision: "v1", document_line: 24, paradigm_id: "pool-submit", context: "void start() {\n  std::thread worker(run);\n  worker.join();\n}" }],
  stats: { observed: 1, reviewed: 0, exempt: 0, exemption_rate: null }, feedback: [], needs_review: false };
const data: ComponentGovernanceSnapshot = { revision: 0, items: [rule, { ...structuredClone(rule), id: "mapping-pool", kind: "mapping", samples: [] }], warnings: [], challenges: [], retention: "按当前版本与去重样本统计；尚未判断的样本不计入误报率。" };
const calls: string[] = []; let adopted = "";
let deletion = { git_message: gitMessage, documents: [{ id: "kd-pool", title: "旧版线程池知识", revision: "v1", active: true }], pending: [] as Array<{id:string;title:string}> };
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input); calls.push(path);
  if (init?.method === "POST") {
    const value = JSON.parse(init.body as string);
    if (path === "/component-knowledge/delete") {
      if (value.documents.length !== 1 || value.documents[0].revision !== "v1") throw new Error("删除缺少来源版本");
      data.items = []; deletion = { ...deletion, documents: [], pending: [{ id:"kd-pool", title:"旧版线程池知识" }] };
      return {ok:true,json:async () => structuredClone(deletion)} as Response;
    }
    if (path === "/component-knowledge/retry-deletions") { deletion.pending = []; return {ok:true,json:async () => structuredClone(deletion)} as Response; }
    if (path.endsWith("/policy")) { if (value.revision !== data.revision || !value.reason) throw new Error("策略字段缺失"); rule.policy = { ...rule.policy, ...value, operator: "组件负责人", updated_at: String(++data.revision) }; }
    if (path.endsWith("/feedback")) { rule.needs_review = true; rule.feedback.push({ ...value, id: "feedback", item_id: rule.id, at: "today", operator: "组件负责人" }); }
    if (path.endsWith("/challenge")) data.challenges.push({ id: "challenge", status: "done", stage: "反例研究已完成，请人工判断", draft: "## 找到合理反例\n基础仓启动适配器在任务池创建前需要原生线程。请收窄规则范围。", challenge: { item_id: rule.id, source_digest: rule.source_digest } });
    return {ok:true,json:async () => ({})} as Response;
  }
  if (path === "/component-knowledge/documents") return {ok:true,json:async () => structuredClone(deletion)} as Response;
  if (path.startsWith("/knowledge-documents/")) return {ok:true,json:async () => ({id:"kd-pool", content: "\n".repeat(23) + "## 后台任务的提交与等待\n### 怎么用\n先提交，退出前等待。\n## 来源\n正文中部的源码说明\n### 公共接口\nPool.submit\n### 最佳示例\n```cpp\nPool pool; pool.submit(work);\n```\n### 来源\n最后来源元数据", revision:"v1"})} as Response;
  if (path.endsWith("/artifacts")) return {ok:true,json:async () => ({document_id:"kd-pool",document_revision:"v1",source_digest:"abc",files:{"derived/ast-grep/rules/component-thread.yml":"language: Cpp\nrule:\n  kind: qualified_identifier", "source.md":"原始知识"}})} as Response;
  return {ok:true,json:async () => structuredClone(path === "/component-knowledge" ? data : path === "/tasks" ? [] : {})} as Response;
};
const delay = async () => { await new Promise(r => setTimeout(r, 20)); flushSync(() => {}); };
function button(text: string) { const el = [...document.querySelectorAll("button")].find(e => e.textContent?.trim() === text); if (!el) throw new Error("找不到按钮 " + text); flushSync(() => el.click()); }
function labelledButton(label: string) { const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); if (!el) throw new Error("找不到按钮 " + label); flushSync(() => el.click()); }
function menuItem(text: string) { const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.textContent === text); if (!el) throw new Error("找不到菜单项 " + text); flushSync(() => el.click()); }
function type(label: string, value: string) { const el = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement; if (!el) throw new Error("找不到字段 " + label); const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; flushSync(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); }
function choose(label: string, value: string) { const el = document.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement; if (!el) throw new Error("找不到选项 " + label); flushSync(() => { el.value = value; el.dispatchEvent(new Event("change", {bubbles:true})); }); }
function expand(text: string) { const el = [...document.querySelectorAll("summary")].find(e => e.textContent?.trim().startsWith(text)); if (!el) throw new Error("找不到展开项 " + text); el.click(); }
function closeDialog() { const el = [...document.querySelectorAll('[data-slot="dialog-content"][data-open] button')].filter(e => e.textContent?.trim() === "Close").at(-1); if (!el) throw new Error("找不到关闭按钮"); flushSync(() => el.click()); }
async function main() {
  const root = createRoot(document.getElementById("app")!);
  flushSync(() => root.render(<ComponentKnowledgeWorkspace open onClose={() => {}} onAdopt={id => { adopted = id; }} />));
  for (let i = 0; i < 40 && !document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("pool.submit(work)"); i++) await delay();
  if (!document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("pool.submit(work)")) throw new Error("未直接展示知识正文与示例：" + document.getElementById("app")?.textContent?.slice(0, 1200) + " calls=" + calls.join());
  const body = document.querySelector('[aria-label="知识正文"]')?.textContent ?? "";
  if (body.includes("正文中部的源码说明") || body.includes("最后来源元数据")) throw new Error("来源记录仍出现在知识正文");
  if (/替代规则|选型映射|文档抽查/.test(document.getElementById("app")?.textContent ?? "")) throw new Error("旧页签仍在");
  if (document.querySelectorAll('[aria-label="组件列表"] button[aria-current]').length !== 1) throw new Error("派生规则被重复列作知识");
  document.getElementById("result")!.textContent = JSON.stringify({progress:"打开设置"});
  // 目录折叠、搜索、全屏与滚动恢复是阅读主流程。
  const folder = document.querySelector<HTMLButtonElement>('[aria-label="组件列表"] button[aria-expanded]')!;
  flushSync(() => folder.click());
  if (document.querySelector('[aria-label="组件列表"] button[aria-current]')) throw new Error("目录没有折叠");
  flushSync(() => folder.click());
  type("搜索文档", "不存在的文档"); if (!document.body.textContent?.includes("没有匹配的文档")) throw new Error("搜索未筛选"); type("搜索文档", "");
  if (document.querySelector('[aria-label="组件列表"] [aria-label*="章节"]')) throw new Error("文件不应展开章节");
  if (document.querySelector('[aria-label="组件列表"]')?.textContent?.includes("最佳示例")) throw new Error("文件目录不应混入正文标题");
  labelledButton("全屏阅读"); await delay();
  labelledButton("收起目录"); await delay();
  for (let i = 0; i < 10; i++) await delay();
  const full = document.querySelector('[aria-label="知识正文"]')!.getBoundingClientRect();
  // e6749677 起全屏阅读器统一留 16px 面板边(.knowledge-reader-dialog .component-document-reader),
  // 1366 下 32px 边距就超过了旧的"正文≥98% 视口"比例。这里要守的是"没有其他面板挤占":
  // 阅读框铺满视口,收起目录后正文占满阅读框的内容区。
  const frame = document.querySelector<HTMLElement>('.knowledge-reader-dialog .component-document-reader');
  if (!frame) throw new Error("全屏阅读器未挂进全屏对话框");
  const box = frame.getBoundingClientRect(), style = getComputedStyle(frame);
  const contentWidth = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (box.width < innerWidth - 4 || box.height < innerHeight - 4) throw new Error(`全屏阅读框未铺满视口 ${box.width}x${box.height}, viewport ${innerWidth}x${innerHeight}`);
  if (full.width < contentWidth - 2 || full.height < innerHeight * 0.85) throw new Error(`全屏阅读仍被其他面板挤占 ${full.width}x${full.height}, 阅读框内容宽 ${contentWidth}, viewport ${innerWidth}x${innerHeight}`);
  if (document.querySelector('[aria-label="组件列表"]')) throw new Error("目录未收起");
  labelledButton("展开目录"); labelledButton("退出全屏"); await delay();
  labelledButton("文档操作"); await delay(); menuItem("代码检查"); await delay(); expand("检查 std::thread");
  if (!document.body.textContent?.includes("src/work.cpp:42")) throw new Error("未显示实际命中位置");
  document.getElementById("result")!.textContent = JSON.stringify({progress:"编辑规则"});
  button("设置检查"); await delay(); choose("使用状态", "warning"); type("组件负责人", "线程池负责人"); type("策略变更理由", "对照样本与实现确认普通工作线程适用"); type("适用路径", "src/**");
  button("保存"); await delay(); await delay();
  if (rule.policy.level !== "warning" || rule.policy.scope[0] !== "src/**") throw new Error("未保存人工策略");
  document.getElementById("result")!.textContent = JSON.stringify({progress:"样本纠错"});
  button("这处提示有误"); await delay(); type("反馈依据", "启动适配器必须使用原生线程，存在合法例外"); button("提交纠错"); await delay(); await delay();
  if (!rule.feedback.some(f => f.observation_id === "sample")) throw new Error("反馈未关联实际样本");
  document.getElementById("result")!.textContent = JSON.stringify({progress:"例外与产物"});
  button("核对例外"); await delay(); await delay();
  if (!calls.some(c => c.endsWith("/challenge"))) throw new Error("未启动反例研究");
  // 当前设置面板中的产物入口；主页面入口处于关闭的 details 中。
  const artifactButton = [...document.querySelectorAll('[data-slot="dialog-content"] button')].find(e => e.textContent === "查看程序化产物") as HTMLButtonElement;
  flushSync(() => artifactButton.click()); await delay(); await delay();
  if (!document.querySelector('[aria-label="产物内容"]')?.textContent?.includes("qualified_identifier")) throw new Error("未显示可执行规则产物");
  button("source.md"); if (!document.querySelector('[aria-label="产物内容"]')?.textContent?.includes("原始知识")) throw new Error("产物切换错误");
  button("原文"); if (!document.querySelector('[aria-label="产物内容"] pre')) throw new Error("Markdown 原文不可读"); button("阅读");
  document.getElementById("result")!.textContent = JSON.stringify({progress:"关闭产物"});
  closeDialog(); await delay();
  button("设置检查"); await delay(); choose("使用状态", "off"); type("策略变更理由", "存在反例，先停用并收窄范围"); button("保存"); await delay(); await delay();
  if (String(rule.policy.level) !== "off") throw new Error("未停用规则");
  closeDialog(); await delay(); labelledButton("文档操作"); await delay(); menuItem("来源与纠错记录"); await delay(); button("打开源文档"); if (adopted !== "kd-pool") throw new Error("源文档导航错误");
  if (document.documentElement.scrollWidth > innerWidth) throw new Error("桌面横向溢出");
  closeDialog(); await delay(); labelledButton("管理组件知识"); await delay(); menuItem("删除知识"); await delay(); await delay();
  const all = document.querySelector('[aria-label="全选组件知识"]') as HTMLInputElement;
  flushSync(() => all.click()); button("删除所选（1）"); await delay();
  if (!gitMessage || !document.body.textContent?.includes(gitMessage)) throw new Error("未显示后端的 Git 删除说明");
  button("返回选择"); await delay(); if (calls.includes("/component-knowledge/delete")) throw new Error("取消也执行了删除");
  button("删除所选（1）"); button("确认删除知识及索引"); await delay(); await delay();
  if (!document.body.textContent?.includes("索引清理待重试")) throw new Error("未显示索引清理失败");
  if (document.querySelectorAll('[aria-label="组件列表"] button').length) throw new Error("已删除知识仍在列表");
  button("重试清理索引"); await delay(); await delay();
  if (!document.body.textContent?.includes("memsearch 索引已清理")) throw new Error("未完成索引清理");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
main().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
