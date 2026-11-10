import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DomainKnowledgeExtraction } from "../../web/src/DomainKnowledgeExtraction";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

const fixture = (window as any).__DOMAIN_HUMAN_INPUT__ as { first: DomainKnowledgeJob; second: DomainKnowledgeJob; running: DomainKnowledgeJob };
let current = structuredClone(fixture.first), root = createRoot(document.getElementById("app")!);
const errors: string[] = [], calls: any[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 80));
const visible = (element: Element) => !!element.getClientRects().length;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === label);
async function click(label: string) { const target = button(label); check(target && !target.disabled, `missing or disabled ${label}`); target!.click(); await pause(); }
async function waitFor(selector: string) { for (let i = 0; i < 60 && !document.querySelector(selector); i++) await pause(); check(document.querySelector(selector), `missing ${selector}: ${document.querySelector('[role="alert"]')?.textContent}`); }
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined;
  let result: unknown;
  if (path === "/business-modules") result = { modules: [] };
  else if (path === "/domain-extraction") result = { records: [current] };
  else if (path === `/domain-extraction/${current.id}/reader`) result = current;
  else if (path.startsWith("/knowledge-review/")) result = { notes: [] };
  else if (path === `/domain-extraction/${current.id}/resume`) {
    calls.push(input);
    if (calls.length === 1) {
      check(input.request_id === fixture.first.turns[0].waiting!.id, "opinion is bound to this request");
      check(input.message === "只生成一个模块，先给我审阅。", "opinion arrives verbatim");
      current = structuredClone(fixture.second);
    } else {
      check(input.request_id === fixture.second.turns[0].waiting!.id, "confirmation is bound to the second request");
      check(input.message === "确认当前内容，请按此继续。", "confirmation is explicit");
      current = structuredClone(fixture.running);
    }
    result = current;
  } else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
function render() { root.render(<DomainKnowledgeExtraction focusId={current.id} surface="workbench" focused />); }
render();
async function run() {
  await waitFor('[aria-label="待确认内容"]');
  check(!document.querySelector('.knowledge-review-notes .animate-spin'), "等待人工确认时不冒充 Agent 正在修改");
  check(document.querySelector('.studio-job-status')?.textContent === "等待你确认", "pause is displayed as waiting");
  check(!document.querySelector('[role="alert"]'), "normal pause has no error banner");
  const documentTab = [...document.querySelectorAll<HTMLButtonElement>('.knowledge-task-view-tabs button')].find(item => item.textContent?.startsWith("文稿"));
  check(documentTab && !documentTab.disabled, "document tab works with process documents and zero knowledge drafts");
  documentTab!.click(); await pause();
  await waitFor('.research-document-content .md');
  check(document.querySelector('.research-document-content')?.textContent?.includes("全文末尾标记"), "entire document is rendered without preview truncation");
  const pane = document.querySelector<HTMLElement>('.research-document-content')!;
  check(pane.scrollHeight > pane.clientHeight && pane.clientHeight > 100, `document has a usable scrollable reader: ${pane.clientHeight}/${pane.scrollHeight}`);
  pane.scrollTop = pane.scrollHeight;
  check(pane.scrollTop > 0, "intermediate document scrolls to its end");
  check(document.documentElement.scrollWidth <= innerWidth + 1, "desktop page fits its width");
  await click("我想调整或补充");
  const field = document.querySelector<HTMLTextAreaElement>('[aria-label="研究确认意见"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "只生成一个模块，先给我审阅。");
  field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  await click("提交意见");
  check(calls.length === 1 && current.status === "paused", "new confirmation can follow an opinion");
  root.unmount(); root = createRoot(document.getElementById("app")!); render();
  await waitFor('[aria-label="待确认内容"]');
  check(button("确认并继续"), "reopening retains the pending request");
  await click("审阅 · 初步知识草稿");
  check(document.querySelector('.research-document-content')?.textContent?.includes("中间知识草稿也可审阅"), "knowledge draft can be read before final completion");
  await click("确认并继续");
  check(current.status === "running" && calls.length === 2, "confirmation resumes execution");
  check(!document.querySelector('[aria-label="待确认内容"]'), "answered card is removed from pending area");
  check(document.querySelector('.research-document-content')?.textContent?.includes("中间知识草稿也可审阅"), "reading remains available while execution runs");
  check(!button("确认并发布（1）"), "intermediate confirmation does not expose final publication");
  check(!errors.length, errors.join("; "));
  // 桌面截图保留待确认时的全文阅读状态，便于核对卡片和阅读面积。
  current = structuredClone(fixture.second); root.unmount(); root = createRoot(document.getElementById("app")!); render();
  await waitFor('[aria-label="待确认内容"]'); await click("审阅 · 自定义方法文稿");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), errors }); });
