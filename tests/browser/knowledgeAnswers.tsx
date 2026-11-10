import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { App } from "../../web/src/App";
import { openKnowledgeAnswer } from "../../web/src/KnowledgeAnswerPage";
import type { KnowledgeAnswerRecord } from "../../src/knowledgeAnswerTypes";

const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const composePreview = new URLSearchParams(location.search).get("preview") === "compose";
const errors: string[] = [], calls: Array<{ path: string; method: string; input?: any }> = [];
const previewRecord = (window as typeof window & { __knowledgeAnswerPreview?: KnowledgeAnswerRecord }).__knowledgeAnswerPreview;
let copied = "", failCopy = false;
if (!previewRecord) Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { if (failCopy) throw new Error("clipboard blocked"); copied = text; } } });
let role = "developer";
let account = "alice", serial = 0, rejectStart = false;
let failRead = false, failDelete = false;
let holdHistory = false, releaseHistory: (() => void) | undefined;
const timestamp = (increment = 0) => new Date(Date.parse("2026-10-10T08:00:00Z") + increment).toISOString();
const quotedText = String.raw`thread_local <Task> & Pool.submit() \path [literal](#evidence-other)`;
const evidence = { id: "ev-fixed", kind: "code" as const, title: "任务池重试实现", content: `// 本次固定版本原文\nretryLimit = 3;\n${quotedText}\n`, digest: "fixed-digest", retrieved_at: timestamp(), revision: "a".repeat(40), repository: "https://example.test/tasks.git", path: "src/retry.ts", start_line: 42, end_line: 45 };
const escapedQuote = String.raw`thread\_local &lt;Task&gt; &amp; Pool\.submit\(\) \\path \[literal\]\(\#evidence\-other\)`;
const completedAnswer = (body: string) => ({ markdown: `${body} 当前读取提交中的任务池重试实现；集成环境配置尚未确认。\n\n${"`".repeat(4)}ts\nretryLimit = 3;\n${"`".repeat(5)}\n\n**来源原句：**\n\n> retryLimit = 3;\n> ${escapedQuote}\n\n[实现依据 C\\+\\+ \\[固定版\\]](#evidence-ev-fixed)`, evidence_ids: [evidence.id], unknowns: ["集成环境是否覆盖该配置仍需确认。"] });
const records: KnowledgeAnswerRecord[] = [{ id: "qa-existing", owner: account, question: "任务失败怎么重试？", context: { module_ids: ["trade"] }, status: "done", stage: "done", created_at: timestamp(), updated_at: timestamp(), evidence: [evidence], activity: [{ at: timestamp(), stage: "checking", message: "已检查回答结构、引用编号和原文片段" }], warnings: [], answer: completedAnswer("该提交中的重试次数上限为三次。") }];

if (previewRecord) records.splice(0, records.length, previewRecord);

window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (url, options) => {
  const path = String(url), method = options?.method || "GET", input = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, method, input }); let result: unknown;
  if (path === "/auth/me") result = { username: account, role };
  else if (["/tasks", "/auth/users", "/auth/people", "/reviews/mine"].includes(path)) result = [];
  else if (path.startsWith("/issues")) result = { issues: [] };
  else if (path === "/launch-options") result = { blockers: [] };
  else if (path === "/build-info") result = { build_hash: "UI-DEMO" };
  else if (path === "/knowledge-tasks") result = { summary: { running: 0, attention: 0, total: 0 }, module_activity: [] };
  else if (path === "/memory-insights") result = { memories: [] };
  else if (path === "/knowledge-answers/catalog") result = {
    modules: [{ id: "trade", name: "交易业务" }],
    documents: [{ id: "kd-pool", title: "任务池组件指南", module_ids: [], revision: "pool-v1" }],
    sources: [{ kind: "knowledge", label: "知识文档", available: true, detail: "正式知识与组件指南" }],
  };
  else if (path === "/knowledge-answers" && method === "GET") {
    const snapshot = records.filter(item => item.owner === account).map(({ id, question, status, stage, created_at, updated_at }) => ({ id, question, status, stage, created_at, updated_at }));
    if (holdHistory) await new Promise<void>(resolve => { releaseHistory = resolve; });
    result = { answers: snapshot };
  }
  else if (path === "/knowledge-answers" && method === "POST") {
    if (previewRecord) return new Response(JSON.stringify({ error: "这是本地阅读示例。新问题请到正式服务中提交。" }), { status: 400 });
    if (rejectStart) return new Response(JSON.stringify({ error: "服务暂时不可用" }), { status: 503 });
    serial += 1;
    const record: KnowledgeAnswerRecord = { id: `qa-${serial}`, owner: account, question: input.question, context: input.context, status: "running", stage: "checking", created_at: timestamp(serial * 1000), updated_at: timestamp(serial * 1000), evidence: [evidence], warnings: [], activity: [{ at: timestamp(), stage: "checking", message: "正在检查回答结构、引用编号和原文片段" }], answer: { markdown: "尚未完成的中间回答不能展示", evidence_ids: [evidence.id], unknowns: [] } };
    records.push(record); result = record;
  }
  else if (path.startsWith("/knowledge-answers/")) {
    const [id, action] = path.slice("/knowledge-answers/".length).split("/");
    if (failRead && method === "GET") { failRead = false; return new Response(JSON.stringify({ error: "临时网络异常" }), { status: 503 }); }
    const record = records.find(item => item.id === id && item.owner === account);
    check(record, "only the current account can read its answers");
    if (method === "DELETE") {
      if (failDelete) return new Response(JSON.stringify({ error: "暂时无法删除，请重试" }), { status: 503 });
      records.splice(records.indexOf(record!), 1); return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    if (action === "cancel") { record!.status = "cancelled"; record!.updated_at = timestamp(20000); }
    if (action === "feedback") record!.feedback = { useful: input.useful, comment: input.comment, at: timestamp(21000) };
    result = record;
  }
  else if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/business-modules") result = { modules: [], operations: [], warnings: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/skills") result = { skills: [], operations: [], warnings: [] };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { status: method === "POST" && path === "/knowledge-answers" ? 202 : 200, headers: { "content-type": "application/json" } });
};

let root = createRoot(document.getElementById("app")!);
const render = () => root.render(<App />);
render();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
async function click(label: string) { const item = button(label); check(item, `missing button: ${label}`); item!.focus(); item!.click(); await pause(); }
async function openReadEvidence() {
  const item = document.querySelector<HTMLButtonElement>('[aria-label="本次已查阅资料"] button');
  check(item, "already-read source has an original snapshot entry"); item!.click(); await pause();
}
async function waitFor(selector: string) {
  for (let index = 0; index < 35; index += 1) { if (document.querySelector(selector)) return; await pause(); }
  throw new Error(`missing selector: ${selector}`);
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  check(input, `missing field ${label}`);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input!.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function choose(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
async function remount() { root.unmount(); await pause(); root = createRoot(document.getElementById("app")!); render(); await waitFor('[aria-label="知识问答工作区"]'); await pause(); }
function navigateAnswer(id = "") {
  const url = new URL(location.href); url.search = new URLSearchParams({ kbPage: "ask", ...(id ? { kbAsk: id } : {}) }).toString();
  history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate"));
}

async function run() {
  await waitFor('[aria-label="知识问答问题"]'); await pause();
  check(button("知识问答")?.hasAttribute("data-active"), "top level Q&A entry is active");
  check(!document.querySelector('section[aria-label="知识库"]'), "Q&A is independent of the library management workspace");
  check(!calls.some(call => call.path === "/knowledge-tasks" || call.path === "/memory-insights"), "opening Q&A does not poll the library task catalog");
  await click("知识库"); await waitFor('[aria-label="知识目录"]');
  await click("知识问答"); await waitFor('[aria-label="知识问答问题"]');
  history.back(); await waitFor('[aria-label="知识目录"]');
  history.forward(); await waitFor('[aria-label="知识问答问题"]');
  openKnowledgeAnswer("", "business:trade", "kd-pool"); await remount();
  check(document.querySelector<HTMLSelectElement>('[aria-label="问答相关模块"]')?.value === "trade" && document.querySelector<HTMLSelectElement>('[aria-label="问答参考文档"]')?.value === "kd-pool", "document question scope survives direct entry and reload");
  await click("补充范围与参考文档（已补充）");
  check(document.body.textContent?.includes("根据相关章节原文回答") && !document.body.textContent?.includes("核对依据后"), "composer describes source-based answering without claiming semantic approval");
  await fill("知识问答问题", "异步任务重试的 UT 怎么写？");
  await click("补充范围与参考文档（已补充）"); await choose("问答相关模块", "trade"); await choose("问答参考文档", "kd-pool");
  check(!document.querySelector('[aria-label="上传问答资料"]') && !document.querySelector('[aria-label="问答相关仓库"]'), "composer only offers knowledge documents and modules");
  check(!document.querySelector(".ka-compose")?.textContent?.includes("Every Code") && !document.querySelector(".ka-compose")?.textContent?.includes("无线豆包"), "external sources are absent from the new question page");
  const submitBox = button("提问")!.getBoundingClientRect(), mainBox = document.querySelector(".ka-main")!.getBoundingClientRect();
  check(submitBox.top >= mainBox.top && submitBox.bottom <= mainBox.bottom, "question action remains visible with document scope expanded on desktop");
  const oldDraft = JSON.parse(sessionStorage.getItem("mae-flow:knowledge-answer:draft:alice")!);
  oldDraft.context.material_ids = ["material-removed"]; oldDraft.context.repository_ids = ["repo-removed"];
  oldDraft.materials = [{ id: "material-removed", name: "旧附件" }];
  sessionStorage.setItem("mae-flow:knowledge-answer:draft:alice", JSON.stringify(oldDraft));
  await remount();
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "异步任务重试的 UT 怎么写？", "question text survives draft restoration");
  await click("提问"); await waitFor('[aria-label="回答进度"]');
  const creation = calls.find(call => call.path === "/knowledge-answers" && call.method === "POST")!;
  check(creation.input.context.module_ids[0] === "trade" && creation.input.context.document_id === "kd-pool", "request preserves optional module and reference document");
  check(!creation.input.context.material_ids && !creation.input.context.repository_ids && !creation.input.materials, "retired scopes in old drafts are removed before submission");
  check(new URLSearchParams(location.search).get("kbAsk") === "qa-1", "created record has a refreshable URL");
  check(document.body.textContent?.includes("检查引用") && !document.body.textContent?.includes("尚未完成的中间回答不能展示"), "checking stage shows real progress and hides draft answers");
  check(document.querySelector('[aria-label="本次已等待时长"]')?.textContent?.startsWith("已等待 "), "running answer reports elapsed time without promising a completion estimate");
  await waitFor('[aria-label="本次已查阅资料"]'); await openReadEvidence();
  check(document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文") && !document.querySelector('[aria-label="知识回答"]'), "running answers expose only already-read source snapshots, without an unfinished answer");
  await click("知识库"); await waitFor('[aria-label="知识目录"]');
  check(!calls.some(call => call.path.endsWith("/cancel")), "leaving Q&A does not cancel server execution");
  navigateAnswer("qa-1"); await waitFor('[aria-label="回答进度"]');
  await remount(); await waitFor('[aria-label="回答进度"]');
  check(document.body.textContent?.includes("异步任务重试的 UT 怎么写？"), "refresh restores selected record");
  const first = records.find(item => item.id === "qa-1")!;
  Object.assign(first, { status: "done", stage: "done", updated_at: timestamp(10000), answer: completedAnswer("使用任务池的可控时钟测试重试边界。") });
  await waitFor('[aria-label="知识回答"]');
  check(!document.querySelector('[aria-label="回答进度"]'), "polling automatically reaches the completed response");
  check(!document.querySelector('[aria-label="本次已查阅资料"]') && document.querySelector('[aria-label="回答依据"]'), "completed answers show their actual citations rather than all research materials");
  await click("复制回答");
  check(copied.includes("使用任务池的可控时钟测试重试边界") && copied.includes("集成环境是否覆盖该配置仍需确认") && copied.includes("回答依据") && !copied.includes("来源原句"), "copy keeps the answer, uncertainty, and source list without embedded quotations");
  failCopy = true; await click("复制回答");
  check(document.querySelector(".ka-copy-status")?.textContent?.includes("复制失败"), "blocked clipboard reports failure without losing the answer"); failCopy = false;
  const renderedAnswer = document.querySelector('[aria-label="知识回答"]')!;
  check(!renderedAnswer.querySelector("blockquote") && !renderedAnswer.textContent?.includes("来源原句"), "original quotations stay outside the answer body");
  check(renderedAnswer.querySelector("pre")?.textContent?.includes("retryLimit = 3;"), "answer code examples remain readable");
  await click("查看来源：实现依据 C++ [固定版]"); await waitFor('[aria-label="本次引用原文"]');
  check(document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文") && document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("a".repeat(40)), "citation opens the actual preserved snapshot and version");
  check(!calls.some(call => call.path.startsWith("/knowledge-documents/")), "citation does not substitute a current source document");
  const workspace = document.querySelector<HTMLElement>('[aria-label="知识问答工作区"]')!;
  check(workspace.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 2, "desktop layout has no horizontal overflow");
  check(workspace.querySelector(".ka-main")!.getBoundingClientRect().width > 290, "answer remains readable with citation pane open");
  first.answer!.markdown = "完整结论及例外保持原样。\n\n**来源原文（点击查看）：**\n\n[原文 ev-fixed，第 42–45 行](#evidence-ev-fixed)";
  await remount(); await waitFor('[aria-label="知识回答"]');
  check(document.querySelector('[aria-label="知识回答"]')?.textContent?.includes("完整结论及例外保持原样。"), "compact citations retain the full answer body");
  await click("查看来源：原文 ev-fixed，第 42–45 行"); await waitFor('[aria-label="本次引用原文"]');
  check(document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes(quotedText), "compact line-range citation opens the complete original snapshot");
  check(document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("a".repeat(40)), "compact citation preserves the original revision");
  first.evidence.push({ id: "ev-image", kind: "material", title: "已读取的流程图", content: "图中显示重试三次后停止。",
    digest: "image-digest", retrieved_at: timestamp(), image: { path: "images/flow.png", digest: "image-digest", mime_type: "image/png" } });
  first.answer!.evidence_ids.push("ev-image");
  first.answer!.markdown += "\n\n> 不应伪装成图片原句\n\n[流程图](#evidence-ev-image)";
  await remount(); await waitFor('[aria-label="知识回答"]');
  const imageCitation = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="回答依据"] button')].find(item => item.textContent?.includes("已读取的流程图"));
  check(imageCitation, "image source appears in the answer evidence list"); imageCitation!.click(); await waitFor('[aria-label="本次查阅图片"]');
  check(document.querySelector<HTMLImageElement>('[aria-label="本次查阅图片"] img')?.getAttribute("src") === "/knowledge-answers/qa-1/evidence/ev-image/image", "image evidence uses this answer's preserved image route");
  check(document.querySelector('[aria-label="本次查阅图片"]')?.textContent?.includes("图片核对说明") && !document.querySelector('[aria-label="本段引用原句"]'), "image interpretation is not presented as an exact source quotation");
  await click("有问题"); await fill("回答反馈说明", "还需要确认时间推进的测试工具"); await click("提交反馈");
  check(first.feedback?.useful === false && first.feedback.comment.includes("测试工具"), "feedback is saved for the answer");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "不能丢掉的新问题");
  check(!document.querySelector('[aria-label="移除 规则说明.md"]'), "starting a new question does not silently inherit attachments from a submitted answer");
  rejectStart = true; await click("提问"); await pause();
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "不能丢掉的新问题" && document.querySelector('[role="alert"]')?.textContent?.includes("服务暂时不可用"), "failed submission preserves draft and reports error");
  rejectStart = false; await click("提问"); await waitFor('[aria-label="回答进度"]'); await click("停止"); await waitFor('[aria-label="问答未完成"]');
  check(records.find(item => item.id === "qa-2")?.status === "cancelled", "explicit stop cancels selected execution");
  await openReadEvidence();
  check(document.querySelector('[aria-label="本次已查阅资料"]') && document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文") && !document.querySelector('[aria-label="知识回答"]'), "stopped answers keep the original source snapshot accessible and hide drafts");
  await click("重新提问"); await waitFor('[aria-label="回答进度"]');
  check(records.find(item => item.id === "qa-3")?.question === "不能丢掉的新问题", "retry creates a new execution for the original question");
  Object.assign(records.find(item => item.id === "qa-3")!, { status: "failed", error: "来源查询超时，未生成完整回答", updated_at: timestamp(30000) });
  await remount(); await waitFor('[aria-label="问答未完成"]');
  check(document.body.textContent?.includes("来源查询超时") && !document.querySelector('[aria-label="知识回答"]'), "failed execution preserves the cause without showing an unfinished draft");
  await openReadEvidence();
  check(document.querySelector('[aria-label="本次已查阅资料"]') && document.querySelector('[aria-label="本次引用原文"]')?.textContent?.includes("本次固定版本原文"), "failed answers preserve access to already-read original evidence after refresh");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "还没提交的另一份问题");
  records.find(item => item.id === "qa-3")!.context = { material_ids: ["old-attachment"], repository_ids: ["old-repo"] };
  navigateAnswer("qa-3"); await waitFor('[aria-label="问答未完成"]');
  await click("重新提问"); await waitFor('[aria-label="回答进度"]');
  check(!records.find(item => item.id === "qa-4")?.context?.material_ids && !records.find(item => item.id === "qa-4")?.context?.repository_ids, "retrying historical questions drops retired source scopes");
  check(records.find(item => item.id === "qa-4")?.question === "不能丢掉的新问题", "failed execution can be retried as a new answer");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await remount(); await waitFor('[aria-label="知识问答问题"]');
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "还没提交的另一份问题", "retrying an older answer preserves a separate unsent question across refresh");
  await click("新问题"); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "Alice 的私人草稿");
  account = "bob"; await remount();
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "", "draft storage is isolated by logged-in account");
  check(!document.querySelector(".ka-history-item"), "history only contains the current account's records");
  check(!document.querySelector('[aria-label="移除 私人参考.md"]'), "attachments are not restored into another account's question draft");
  account = "alice"; await remount(); await waitFor('[aria-label="知识问答问题"]');
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "Alice 的私人草稿", "returning to the original account restores its question");
  const existing = records.find(item => item.id === "qa-existing")!, completed = structuredClone(existing);
  Object.assign(existing, { status: "running", stage: "researching", updated_at: timestamp(40000), answer: undefined });
  holdHistory = true; releaseHistory = undefined;
  navigateAnswer(existing.id); await remount(); await waitFor('[aria-label="回答进度"]');
  check(releaseHistory, "initial history response can be held after taking its running snapshot");
  Object.assign(existing, completed, { updated_at: timestamp(40000) });
  await waitFor('[aria-label="知识回答"]');
  const selectedHistory = () => document.querySelector('.ka-history-item[aria-current="page"]')?.textContent;
  check(selectedHistory()?.includes("回答完成"), "selected answer updates history to completed even when timestamps are equal");
  holdHistory = false; releaseHistory!(); await pause();
  check(selectedHistory()?.includes("回答完成") && !selectedHistory()?.includes("查阅资料"), "late history snapshot cannot replace a completed answer with its previous running status");
  failRead = true; await remount();
  await waitFor('[role="alert"]');
  check(document.querySelector('[role="alert"]')?.textContent?.includes("正在自动重连"), "transient read failure explains automatic recovery");
  await waitFor('[aria-label="知识回答"]');
  check(!document.querySelector('[role="alert"]'), "polling recovers after one transient failure without user reload");
  for (const id of ["qa-2", "qa-3", "qa-4", "qa-1"]) {
    const target = records.find(item => item.id === id)!;
    navigateAnswer(id); await pause(); await waitFor('.ka-question');
    if (id === "qa-4") { holdHistory = true; releaseHistory = undefined; await remount(); await waitFor('[aria-label="回答进度"]'); }
    await click("删除问题"); await waitFor('[role="dialog"]');
    check(document.querySelector('[role="dialog"]')?.textContent?.includes("上传原件仍保留"), "delete dialog states which data is retained");
    if (id === "qa-4") check(document.querySelector('[role="dialog"]')?.textContent?.includes("问答也会停止"), "running deletion also explains cancellation");
    if (id === "qa-2") {
      await click("取消"); check(records.includes(target), "canceling deletion keeps the question"); await click("删除问题");
    }
    if (id === "qa-3") {
      failDelete = true; await click("确认删除");
      check(document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.includes("暂时无法删除") && records.includes(target), "failed deletion keeps the question and offers retry");
      failDelete = false;
    }
    await click("确认删除"); await waitFor('[aria-label="知识问答问题"]');
    check(!records.includes(target), "delete supports completed, failed, cancelled, and running questions");
    if (id === "qa-4") { holdHistory = false; releaseHistory!(); await pause(); }
    check(document.querySelectorAll(".ka-history-item").length === records.filter(item => item.owner === account).length, "late list responses cannot restore deleted history");
  }
  await remount(); await waitFor('[aria-label="知识问答问题"]');
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="知识问答问题"]')?.value === "Alice 的私人草稿", "deletion preserves the unsent question draft");
  account = "alice"; navigateAnswer("qa-existing"); await remount(); await waitFor('[aria-label="知识回答"]'); await click("查看来源：实现依据 C++ [固定版]");
  check(document.querySelector('[aria-label="本段引用原句"]')?.textContent?.includes(quotedText), "clicked paragraph exposes its exact literal quotation in the side panel");
  document.querySelector('[aria-label="本次引用原文"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause();
  check(!document.querySelector('[aria-label="本次引用原文"]') && document.activeElement?.getAttribute("aria-label") === "查看来源：实现依据 C++ [固定版]", "Escape closes source panel and restores source button focus");
  role = "admin"; await remount(); await waitFor('[aria-label="知识回答"]');
  check(button("知识问答")?.hasAttribute("data-active"), "admin can also directly enter Q&A");
  await click("新问题"); await fill("搜索历史问题", "不存在的历史问题");
  check(!document.querySelector(".ka-history-item") && document.body.textContent?.includes("没有找到相关问题"), "history can be filtered without changing the draft");
  await fill("搜索历史问题", "");
  navigateAnswer("qa-existing"); await waitFor('[aria-label="知识回答"]'); await click("查看来源：实现依据 C++ [固定版]");
  check(!errors.length, errors.join("; "));
  if (composePreview) {
    navigateAnswer(); await waitFor('[aria-label="知识问答问题"]'); await fill("知识问答问题", "");
    if (!document.querySelector('[aria-label="问答相关模块"]')) await click("补充范围与参考文档（已补充）");
  }
  return { passed: true, width: innerWidth, created: serial, references: records[0].answer?.evidence_ids.length };
}

if (!previewRecord) run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });
