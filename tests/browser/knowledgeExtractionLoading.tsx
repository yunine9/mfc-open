import { researchEvidencePage } from "../../src/knowledgeResearchEvidence";
import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";

const fixture = (window as unknown as { __EXTRACTION_LOADING__: { domain: DomainKnowledgeJob; component: ComponentResearchRecord } }).__EXTRACTION_LOADING__;
const kind = new URLSearchParams(location.search).get("kbKind")!;
const record = kind === "domain" ? fixture.domain : fixture.component;
const endpoint = `/${kind === "domain" ? "domain-extraction" : "component-research"}/${record.id}`;
const requests: string[] = [], errors: string[] = [];
let detailRequests = 0, inFlight = 0, maximumInFlight = 0, aborted = 0;
const started = performance.now();
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async (input, init) => {
  const path = String(input); requests.push(path);
  let value: unknown;
  if (path === endpoint + "/reader") {
    detailRequests++; inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); aborted++; reject(new DOMException("任务已离开", "AbortError")); };
        const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", onAbort); resolve(); }, detailRequests === 1 ? 50 : 6000);
        init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally { inFlight--; }
    value = { ...record, deferred_details: true, evidence: [],
      ...(kind === "domain" ? { documents: fixture.domain.documents.map(d => ({ ...d, history: [] })),
        work_documents: fixture.domain.work_documents?.map(d => ({ ...d, content: "" })) }
        : { section_history: [], work_documents: fixture.component.work_documents?.map(d => ({ ...d, content: "" })) }) };
  } else if (path.startsWith(endpoint + "/evidence/")) value = record.evidence[Number(path.split("/").at(-1))];
  else if (path.startsWith(endpoint + "/evidence")) value = researchEvidencePage(record.evidence, new URL(path, "http://localhost").searchParams.get("before") ?? undefined);
  else if (path.startsWith(endpoint + "/work-document/")) value = record.work_documents?.[0];
  else if (path.startsWith(endpoint + "/history/")) value = kind === "domain" ? fixture.domain.documents[0].history : fixture.component.section_history;
  else if (path.startsWith("/knowledge-review/")) value = { notes: [], submissions: {} };
  else if (path === "/technology-stacks") value = { stacks: [{ id: "cpp", name: "C++", enabled: true }] };
  else if (path === "/knowledge-tasks") value = { tasks: [], warnings: [], module_activity: [], summary: { running: 0, attention: 0, total: 0 } };
  else if (path === "/memory-insights") value = { memories: [], repos: [] };
  else if (path === "/business-modules") value = { modules: [] };
  else if (path === "/domain-extraction" || path === "/component-research") value = { records: [] };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};

createRoot(document.getElementById("app")!).render(<KnowledgeLibrary onOpenTask={() => {}} />);
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function until(predicate: () => boolean, message: string, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (!predicate() && performance.now() < deadline) await pause();
  check(predicate(), message);
}
function progress() { return document.querySelector<HTMLElement>('[aria-label="研究过程记录"]')!; }

(async () => {
  await until(() => !!progress(), "current task did not render");
  const firstRenderMs = Math.round(performance.now() - started);
  check(requests[0] === endpoint + "/reader" || requests[0] === "/technology-stacks", "task detail must start immediately");
  check(!requests.some(path => ["/domain-extraction", "/component-research", "/knowledge-tasks", "/business-modules", "/memory-insights"].includes(path)), `task page scanned unrelated data: ${requests}`);
  check(document.querySelector('[aria-label="知识任务中心"]'), "paused task counts must not display invented zero values");
  check(progress().querySelectorAll(".knowledge-progress-entry").length === 40, "latest progress records must remain available");
  check(!requests.some(path => path.startsWith(endpoint + "/history/") || path.startsWith(endpoint + "/work-document/") || path.startsWith(endpoint + "/evidence/")), "initial render loaded deferred full content");
  check(!document.querySelector(".knowledge-task-review .md, .research-review .md"), "hidden reader rendered Markdown before opening");
  check(progress().querySelectorAll("pre").length === 0, "collapsed research output must not render full payloads");
  const entry = progress().querySelector<HTMLDetailsElement>(".knowledge-progress-entry")!;
  (entry.querySelector("summary") as HTMLElement).click();
  await until(() => !!entry.querySelector(".knowledge-progress-detail pre"), "expanded result is not readable");
  const raw = entry.querySelector<HTMLDetailsElement>(".knowledge-progress-detail details")!;
  check(!raw.querySelector("pre"), "raw record must wait for explicit expansion");
  (raw.querySelector("summary") as HTMLElement).click();
  await until(() => !!raw.querySelector("pre"), "full record cannot be inspected");
  check(raw.textContent?.includes('"tool"') && raw.textContent.includes("FULL_OUTPUT"), "raw record was truncated");
  const collapse = [...progress().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "全部折叠")!;
  collapse.click(); await until(() => progress().querySelectorAll("pre").length === 0, "collapse must release rendered output");
  (entry.querySelector("summary") as HTMLElement).click();
  await until(() => !!entry.querySelector(".knowledge-progress-detail"), "closed entry cannot be reopened");
  check(!entry.querySelector(".knowledge-progress-detail details pre"), "reopened entry must keep raw record collapsed");
  collapse.click();
  const earlier = [...progress().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("查看更早"))!;
  earlier.click(); await until(() => progress().querySelectorAll(".knowledge-progress-entry").length === 60, "older records cannot be read");
  check(requests.includes(endpoint + "/evidence?before=20"), "older records were not requested by cursor");
  const workButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="已生成的过程文稿"] button')][0];
  workButton.click(); await until(() => !!document.querySelector(".md")?.textContent?.includes("DEFERRED_WORK_BODY"), "process document was not fetched on demand");
  check(requests.some(path => path.startsWith(endpoint + "/work-document/")), "process document used an empty summary");
  // Return to the current document and open only its history.
  const docButton = [...document.querySelectorAll<HTMLButtonElement>(kind === "domain" ? '[aria-label="领域知识文件导航"] button' : '[aria-label="组件能力目录"] button')]
    .find(button => (button.title + button.textContent).includes("文件操作"));
  check(docButton, "current document is missing from the outline"); docButton!.click();
  if (kind === "domain") {
    await until(() => !!document.querySelector('[aria-label="更多领域文档操作"]'), "current document toolbar did not render");
    document.querySelector<HTMLButtonElement>('[aria-label="更多领域文档操作"]')!.click();
    await until(() => !![...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === "历史版本"), "document menu did not open");
    ([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === "历史版本")!).click();
  } else {
    await until(() => !!document.querySelector('[aria-label="章节内容视图"]'), "current section toolbar did not render");
    ([...document.querySelectorAll<HTMLButtonElement>('[aria-label="章节内容视图"] button')].find(node => node.textContent === "历史版本")!).click();
  }
  await until(() => [...document.querySelectorAll("details")].some(node => node.textContent?.includes("DEFERRED_HISTORY_BODY")), "history body cannot be read");
  check(requests.some(path => path.startsWith(endpoint + "/history/")), "history did not load separately");
  const progressButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="研究过程与文稿"] button')].find(button => button.textContent?.includes("研究过程"))!;
  progressButton.click(); await until(() => !!progress(), "return to progress failed");
  await until(() => detailRequests === 2, "detail polling stopped", 5000);
  await pause(4200);
  check(detailRequests === 2 && maximumInFlight === 1, "slow requests must not accumulate every four seconds");
  check(!requests.includes("/knowledge-tasks") && !requests.includes("/memory-insights"), "background scans must remain paused while reading");
  history.pushState(history.state, "", "?kbPage=tasks"); dispatchEvent(new PopStateEvent("popstate"));
  await until(() => aborted === 1 && requests.includes("/knowledge-tasks"), "leaving task must abort detail and restore task-center loading");
  check(!requests.includes("/memory-insights"), "opening task center must not scan experience records");
  check(errors.length === 0, errors.join("; "));
  check(document.documentElement.scrollWidth <= innerWidth + 2, "desktop page overflows horizontally");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, kind, firstRenderMs, detailRequests, maximumInFlight, aborted });
})().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), requests }); });
