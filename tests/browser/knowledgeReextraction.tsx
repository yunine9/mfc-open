import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";

const fixture = (window as unknown as { __REEXTRACT__: Record<string, { original: DomainKnowledgeJob | ComponentResearchRecord; next: DomainKnowledgeJob | ComponentResearchRecord }> }).__REEXTRACT__;
const kind = new URLSearchParams(location.search).get("kbKind")!, { original, next } = fixture[kind];
const endpoint = `/${kind === "domain" ? "domain-extraction" : "component-research"}`;
const requests: string[] = [], errors: string[] = [];
let attempts = 0;
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async (input, init) => {
  const path = String(input); requests.push(path);
  let value: unknown;
  if (path === `${endpoint}/${original.id}/reextract`) {
    if (init?.method !== "POST" || init.body !== "{}") throw new Error("重新萃取不应要求重复填写或上传");
    attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ error: "暂时无法创建新任务，请重试" }), { status: 400 });
    value = next;
  } else if (path === `${endpoint}/${original.id}`) value = original;
  else if (path === `${endpoint}/${next.id}`) value = next;
  else if (path.startsWith("/knowledge-review/")) value = { notes: [], submissions: {} };
  else if (path === "/technology-stacks") value = { stacks: [{ id: "cpp", name: "C++", enabled: true }] };
  else if (path === "/knowledge-tasks") value = { tasks: [], warnings: [], module_activity: [], summary: { running: 0, attention: 0, total: 0 } };
  else if (path === "/business-modules") value = { modules: [] };
  else if (path === endpoint) value = { records: [attempts >= 2 ? next : original] };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
createRoot(document.getElementById("app")!).render(<KnowledgeLibrary onOpenTask={() => {}} />);
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const visible = (element: Element) => !!element.getClientRects().length;
async function until(predicate: () => boolean, message: string) { for (let i = 0; i < 80 && !predicate(); i++) await pause(); check(predicate(), message); }
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === text); }
async function click(text: string) { const target = button(text); check(target && !target.disabled, `missing or disabled button ${text}`); target!.click(); await pause(); }
async function openReextract() {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${kind === "domain" ? "更多萃取操作" : "更多组件萃取操作"}"]`)!;
  trigger.click();
  await until(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => visible(item) && item.textContent?.trim() === "重新萃取"), "missing reextract menu item");
  ([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => visible(item) && item.textContent?.trim() === "重新萃取")!).click();
  await until(() => !!button("确认重新萃取"), "missing confirmation");
}
(async () => {
  await until(() => !!document.querySelector(`[aria-label="${kind === "domain" ? "更多萃取操作" : "更多组件萃取操作"}"]`), "task did not render");
  await openReextract(); await click("取消"); check(attempts === 0, "cancel created a task");
  await openReextract(); await click("确认重新萃取");
  await until(() => !!document.querySelector('[role="dialog"]')?.textContent?.includes("暂时无法创建新任务"), "failed creation did not remain reviewable");
  check(new URLSearchParams(location.search).get("kbTask") === original.id, "failed creation left old task");
  await click("确认重新萃取");
  await until(() => new URLSearchParams(location.search).get("kbTask") === next.id && requests.includes(`${endpoint}/${next.id}`), "did not navigate to replacement task");
  await until(() => !document.querySelector('[role="dialog"]'), "confirmation stayed open after success");
  check(!!document.querySelector('[aria-label="研究过程记录"]'), "replacement should open research progress");
  check(attempts === 2, "unexpected number of creation attempts");
  check(!requests.some(path => path.startsWith("/knowledge-materials") || path === "/memory-insights"), "reextraction repeated input/upload flows");
  check(errors.length === 0, errors.join("; "));
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop horizontal overflow");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, kind, attempts });
})().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), requests }); });
