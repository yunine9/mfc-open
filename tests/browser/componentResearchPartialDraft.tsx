import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ComponentResearch } from "../../web/src/ComponentResearch";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";

const fixtures = (window as unknown as { __COMPONENT_PARTIAL_DRAFT_FIXTURES__: ComponentResearchRecord[] }).__COMPONENT_PARTIAL_DRAFT_FIXTURES__;
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const errors: string[] = [], mutationCalls: string[] = [], detailTimes: number[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

window.fetch = async (url, options) => {
  const path = String(url);
  if (options?.method && options.method !== "GET") {
    mutationCalls.push(path);
    throw new Error(`running draft must not mutate: ${path}`);
  }
  let result: unknown;
  if (path === "/component-research") result = { records: [fixtures[0]] };
  else if (path === "/component-research/cr-partial-draft") {
    detailTimes.push(performance.now());
    result = fixtures[Math.min(detailTimes.length - 1, fixtures.length - 1)];
  } else if (path === "/component-repositories") result = { components: fixtures[0].source_repositories };
  else if (path === "/business-modules") result = { modules: [] };
  else if (path === "/technology-stacks") result = { stacks: [{ id: "cpp", name: "C++", enabled: true }] };
  else if (path.startsWith("/knowledge-review/")) result = { notes: [], submissions: {} };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

createRoot(document.getElementById("app")!).render(<ComponentResearch open focused focusId="cr-partial-draft" surface="workbench" onClose={() => {}} onAdopt={() => {}} />);

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";
const buttons = (selector = "button") => [...document.querySelectorAll<HTMLButtonElement>(selector)];
const button = (label: string) => buttons().find(item => item.textContent?.trim() === label);
async function until(predicate: () => boolean, message: string, timeout = 2400) {
  const deadline = performance.now() + timeout;
  while (!predicate() && performance.now() < deadline) await pause();
  check(predicate(), message);
}
async function click(label: string) {
  const target = button(label);
  check(target, `missing button: ${label}`);
  check(!target!.disabled, `reading action must remain available: ${label}`);
  target!.click(); await pause();
}
async function chooseCapability(title: string) {
  const target = buttons('[aria-label="组件能力目录"] .knowledge-outline-title').find(item => item.textContent?.includes(title));
  check(target, `missing capability: ${title}`); target!.click(); await pause();
}
function cannotMutate(context: string) {
  const labels = ["全选", "全不选", "人工编辑", "仅讨论", "生成修订建议", "核对来源更新", "确认并发布", "采纳知识", "开始补充", "采纳此建议", "发送并修改"];
  const actions = buttons().filter(item => labels.includes(item.textContent?.trim() ?? ""));
  check(actions.every(item => item.disabled), `${context}: mutations must be disabled or absent`);
  for (const action of actions) action.click();
  const boxes = [...document.querySelectorAll<HTMLInputElement>('[aria-label="组件能力目录"] input[type="checkbox"]')];
  check(boxes.every(item => item.disabled), `${context}: capability selection must be disabled`);
  for (const box of boxes) box.click();
  check(!document.querySelector('[aria-label="编辑标题"]'), `${context}: editing form must stay closed`);
  check(mutationCalls.length === 0, `${context}: mutation request escaped: ${mutationCalls.join(", ")}`);
}
function checkFullGuide() {
  const guide = text('[aria-label="完整文档阅读区"]');
  check(!guide.includes("过程文稿第一版") && !guide.includes("分析目录已更新"), "process manuscripts must remain separate from the capability guide");
  const headings = [...document.querySelectorAll<HTMLElement>('[aria-label="完整文档阅读区"] .md-h2, [aria-label="完整文档阅读区"] .md-h3')];
  const start = headings.findIndex(heading => heading.classList.contains("md-h2") && heading.textContent === "文件打开与关闭");
  check(start >= 0, "complete sibling must have its own section in the guide");
  const next = headings.findIndex((heading, index) => index > start && heading.classList.contains("md-h2"));
  const children = headings.slice(start + 1, next < 0 ? undefined : next).map(heading => heading.textContent);
  check(children.indexOf("关键接口") >= 0 && children.indexOf("关键接口") < children.indexOf("使用约束"), "complete recommended sibling must retain the template order: interfaces before usage constraints");
}

async function run() {
  await until(() => !!document.querySelector('[aria-label="组件文稿审查"]'), "running task did not open");
  check(!fixtures[0].document, "initial fixture must have only a process manuscript");
  check(document.querySelector('[aria-label="研究过程记录"]'), "workbench starts in the process view");
  const shortcut = buttons('[aria-label="已生成的过程文稿"] button').find(item => item.textContent?.trim() === "组件能力分析");
  check(shortcut && !shortcut.disabled, "generated process manuscript needs an enabled reading shortcut before a guide exists");
  shortcut!.click(); await pause();
  await until(() => text('[aria-label="组件过程文稿"]').includes("过程文稿第一版"), "generated process manuscript must be readable before any capability draft exists");
  check(document.querySelector('[aria-label="过程文稿目录"]'), "process manuscripts have a separate directory");
  check(text('[aria-label="过程文稿目录"]').includes("组件能力分析"), "functional analysis appears in process directory");
  cannotMutate("process manuscript");
  await until(() => detailTimes.length >= 2 && text('[aria-label="组件过程文稿"]').includes("分析目录已更新"), "first detail poll must refresh the selected process manuscript", 5200);
  check(text('[aria-label="过程文稿目录"]').includes("组件能力分析"), "process directory survives capability generation");
  check(text('[aria-label="组件能力目录"]').includes("数据库失败重试"), "generated capability drafts appear beside process manuscripts");
  check(text('[aria-label="组件过程文稿"]').includes("组件能力分析"), "detail polling must preserve the selected process manuscript");
  await chooseCapability("数据库失败重试");
  const database = text('[aria-label="组件详细文档"]');
  check(database.includes("数据库草稿第一版"), "unverified incomplete capability body is readable");
  check(database.includes("db_retry_budget") && database.includes("assert(db_retry_budget(2) == 2)"), "unverified incomplete capability retains its example and unit tests");
  if (button("研究对话")) {
    await click("研究对话");
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="组件讨论或返工意见"]');
    if (field) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "请核对失败重试示例。");
      field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    }
    cannotMutate("nonempty review message during research");
    await click("研究对话 · 收起");
  }
  cannotMutate("generated capability");
  await click("完整文档");
  const firstGuide = text('[aria-label="完整文档阅读区"]');
  check(firstGuide.includes("文件打开与关闭") && firstGuide.includes("std::tmpfile"), "complete view retains the complete sibling draft");
  check(firstGuide.includes("原子替换草稿") && firstGuide.includes("assert(destination_exists)"), "a recommended draft with incomplete fields retains its available body and unit tests");
  check(firstGuide.includes("数据库草稿第一版") && firstGuide.includes("assert(db_retry_budget(2) == 2)"), "complete view includes incomplete unverified drafts and unit tests");
  check(!firstGuide.includes("文稿格式需要修订"), "empty overview or one incomplete item must not replace the whole manuscript with a format error");
  checkFullGuide();
  check(text('[aria-label="文档组件目录"]').includes("数据库失败重试"), "complete-view directory includes the unverified draft");
  await click("逐项审查");
  check(text('[aria-label="组件详细文档"]').includes("数据库草稿第一版"), "switching reading modes retains capability selection");
  await until(() => detailTimes.length >= 3 && text('[aria-label="组件详细文档"]').includes("数据库草稿第二版"), "second detail poll must update the current capability manuscript", 5200);
  check(text('[aria-label="组件能力目录"]').includes("P2P 心跳"), "a new capability appears after detail polling");
  const current = document.querySelector<HTMLButtonElement>('[aria-label="组件能力目录"] button[aria-current="page"]');
  check(current?.textContent?.includes("数据库失败重试"), "new items must not reset the selected capability");
  check(!text('[aria-label="组件详细文档"]').includes("数据库草稿第一版"), "current body must not remain stale after polling");
  cannotMutate("refreshed capability");
  await chooseCapability("P2P 心跳");
  check(text('[aria-label="组件详细文档"]').includes("send_p2p_heartbeat") && text('[aria-label="组件详细文档"]').includes("assert(heartbeat_count == 1)"), "new incomplete capability retains its example and unit tests");
  await click("完整文档");
  const finalGuide = text('[aria-label="完整文档阅读区"]');
  check(["std::tmpfile", "原子替换草稿", "assert(destination_exists)", "数据库草稿第二版", "assert(db_retry_budget(2) == 2)", "send_p2p_heartbeat", "assert(heartbeat_count == 1)"].every(value => finalGuide.includes(value)), "all generated fields remain readable together before overview completion");
  check(!finalGuide.includes("文稿格式需要修订"), "one partial capability must not clear its siblings");
  checkFullGuide();
  await until(() => detailTimes.length >= 4 && text('[aria-label="组件文稿审查"]').includes("已停止"), "third detail poll must show task cancellation", 5200);
  const stoppedGuide = text('[aria-label="完整文档阅读区"]');
  check(["数据库草稿第二版", "assert(db_retry_budget(2) == 2)", "P2P 草稿", "assert(heartbeat_count == 1)"].every(value => stoppedGuide.includes(value)), "cancelling research must retain generated unverified capability drafts and unit tests in the complete view");
  check(!stoppedGuide.includes("文稿格式需要修订"), "stopping a partial guide must not replace its body with strict publication validation");
  checkFullGuide();
  const stoppedCurrent = document.querySelector<HTMLButtonElement>('[aria-label="文档组件目录"] button[aria-current="page"]');
  check(stoppedCurrent?.textContent?.includes("P2P 心跳"), "cancellation must preserve the selected capability in complete view");
  await click("逐项审查");
  check(text('[aria-label="组件详细文档"]').includes("assert(heartbeat_count == 1)"), "generated P2P draft remains readable after cancellation");
  await chooseCapability("数据库失败重试");
  check(text('[aria-label="组件详细文档"]').includes("数据库草稿第二版") && text('[aria-label="组件详细文档"]').includes("assert(db_retry_budget(2) == 2)"), "generated database draft remains selectable and readable after cancellation");
  const workspace = document.querySelector<HTMLElement>('[aria-label="组件审核工作区"]')!;
  check(workspace.scrollWidth <= workspace.clientWidth + 2, "desktop research workspace overflows horizontally");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop page overflows horizontally");
  check(mutationCalls.length === 0, "running readers must issue no mutation requests");
  check(errors.length === 0, errors.join("; "));
  return { passed: true, width: innerWidth, detailRequests: detailTimes.length, pollIntervals: detailTimes.slice(1).map((time, i) => time - detailTimes[i]) };
}

run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
