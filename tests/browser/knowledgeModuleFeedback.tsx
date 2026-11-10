import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleReader } from "../../web/src/KnowledgeModuleReader";
import { KnowledgeReviewNotes } from "../../web/src/KnowledgeReviewNotes";
import { KnowledgeMarkdown } from "../../web/src/KnowledgeMarkdown";
import { invalidateKnowledgeReads } from "../../web/src/knowledgeReadCache";
import { DomainKnowledgeInspectionBar, DomainKnowledgeInspectionContext, DomainKnowledgeInspectionStart, useDomainKnowledgeInspection } from "../../web/src/DomainKnowledgeInspection";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";
import type { KnowledgeReviewKind, KnowledgeReviewNote } from "../../src/knowledgeReviewNoteTypes";

const pause = () => new Promise(resolve => setTimeout(resolve, 85));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const ordersId = `kg-${"1".repeat(64)}`, stockId = `kg-${"2".repeat(64)}`;
const documents: KnowledgeDocument[] = [
  { id: ordersId, title: "订单规则", content: "# 订单规则\n\n取消订单之前核对发货状态。\n\n支付回调只更新一次。\n\n退款需要通知调用方。", scope: "module", module_ids: ["trade"], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision: "published-v1", history: [], source: { repository: "https://example.test/knowledge.git", branch: "main", path: "docs/orders.md", revision: "v1" } },
  { id: stockId, title: "库存规则", content: "# 库存规则\n\n订单取消后只回补一次库存。", scope: "module", module_ids: ["trade"], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision: "stock-v1", history: [], source: { repository: "https://example.test/knowledge.git", branch: "main", path: "docs/stock.md", revision: "v1" } },
];
const skillFiles = [{ path: "SKILL.md", content: "# 订单核对\n\n先核对关联订单。" }, { path: "references/checks.md", content: "# 核对清单\n\n核对支付与库存。" }];
let skillRevision = "skill-v1", directoryRevision = "directory-v1", domainSubmissions = 0;
const openedTasks: Array<{ jobId: string; documentId?: string }> = [];
const submissions: Record<string, { working: boolean; status_label: string }> = {};
const notes = new Map<string, KnowledgeReviewNote[]>(), calls: Array<{ path: string; body?: any }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (url, options) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, body }); let result: unknown;
  if (path === "/knowledge-documents?view=directory") result = { documents: documents.map(({ content, ...document }) => ({ ...document, lines: content?.split("\n").length ?? 0 })), revision: directoryRevision };
  else if (path === "/knowledge-documents?view=revision") result = { revision: directoryRevision };
  else if (/^\/knowledge-documents\/[^/]+\/inspection$/.test(path)) {
    const document = documents.find(item => item.id === path.split("/")[2]);
    check(document && body.expected_revision === document.revision && body.module_id === "trade", "检视固定当前正式版本及业务模块");
    check(body.issue_no === "REQ-REVIEW" && body.issue_description === "核对交易规则", "检视携带关联单号和描述");
    result = { id: `dkx-review-${openedTasks.length + 1}`, inspection_source: { document_id: document!.id } };
  }
  else if (path.startsWith("/knowledge-documents/")) result = documents.find(item => item.id === path.split("/")[2]);
  else if (path === "/business-modules") result = { modules: [{ id: "trade", name: "交易业务", status: "active", description: "", repositories: [], assets: [] }], warnings: [], operations: [] };
  else if (path === "/business-modules/trade/knowledge-location") result = { configured: true, location: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "docs" }, sync: { state: "ready", synced_at: "2026-10-21T01:00:00Z" } };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/skills?view=directory") result = { skills: [{ path: "order-check/SKILL.md", name: "订单核对", description: "核对关联业务", loadable: true, digest: skillRevision, business_module_ids: ["trade"], repositories: [], technologies: [] }], warnings: [], operations: [] };
  else if (path === "/skills/order-check/package") result = { content: skillFiles[0].content, digest: skillRevision, package_digest: skillRevision, files: skillFiles };
  else if (path.startsWith("/knowledge-review/")) {
    const [,, kind, owner, action] = path.split("/"), key = `${kind}/${decodeURIComponent(owner)}`;
    const saved = notes.get(key) ?? [];
    if (action === "resolve") {
      check(!("revision" in body), "resolve does not bind to a document revision");
      for (const item of saved) if (body.note_ids.includes(item.id)) { item.status = "resolved"; item.resolved_by = "dev"; item.resolved_at = "2026-09-30T10:00:00Z"; }
    } else if (action === "apply") {
      check(!("revision" in body), "Agent revision request does not bind a document revision");
      for (const item of saved) if (body.note_ids.includes(item.id)) { item.status = "submitted"; item.turn_id = `${owner}-turn`; }
      submissions[`${owner}-turn`] = { working: true, status_label: "Agent 正在修改文稿" };
    } else if (body) {
      check(!("revision" in body), "published and Skill comments must not include a revision");
      saved.push({ ...body, id: `note-${calls.length}`, kind: kind as KnowledgeReviewKind, job_id: owner, document_title: body.document_id, operator: "dev", created_at: "2026-09-30T09:00:00Z", status: "open" });
    }
    notes.set(key, saved); result = { notes: saved, submissions };
  } else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
let generation = 0;
async function mount(selectedDocumentId = ordersId) {
  const mountedGeneration = ++generation;
  root.render(<div data-generation={mountedGeneration} className="tw-root knowledge-hub is-focused"><KnowledgeModuleReader key={mountedGeneration} moduleKey="business:trade" selectedDocumentId={selectedDocumentId} onBack={() => {}} onResearch={(jobId, documentId) => openedTasks.push({ jobId, documentId })} /></div>);
  await until(() => document.querySelector(`[data-generation="${mountedGeneration}"]`), "current reader has mounted");
}
mount();
const visible = (element: Element) => !!element.getClientRects().length;
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 70 && !predicate(); i++) await pause(); check(predicate(), message); }
async function click(selector: string, context: ParentNode = document) { const target = context.querySelector<HTMLElement>(selector); check(target && visible(target), `missing visible ${selector}`); target!.click(); await pause(); }
async function clickText(text: string, context: ParentNode = document) { const target = [...context.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === text); check(target && !target.disabled, `missing enabled ${text}`); target!.click(); await pause(); }
async function fill(selector: string, value: string) { const field = document.querySelector<HTMLTextAreaElement>(selector); check(field, `missing ${selector}`); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field!.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
async function fillInput(label: string, value: string) { const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); check(field, `missing ${label}`); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field!.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
async function hover(line: number) { const row = document.querySelector<HTMLElement>(`.knowledge-markdown [data-l="${line}"]`); check(row, `missing text line ${line}`); row!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); await pause(); }
async function openNotes() { const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && /^提意见(?: · \d+)?$/.test(item.textContent?.trim() || "")); check(target, "module toolbar has a clear feedback entry"); target!.click(); await until(() => document.querySelector('[role="dialog"][data-open] [aria-label="文稿修改意见"]'), "notes dialog opens"); }
async function closeNotes() { await click('[role="dialog"] [data-slot="dialog-close"]'); await until(() => !document.querySelector('[role="dialog"][data-open]'), "notes dialog closes"); }
function submitted(path: string) { return calls.filter(call => call.path === path && call.body); }
async function createInspection(documentId: string) {
  const count = openedTasks.length;
  await clickText("开始检视"); await fillInput("检视关联单号", "REQ-REVIEW"); await fillInput("检视单号描述", "核对交易规则");
  await clickText("创建任务并开始检视"); await until(() => openedTasks.length === count + 1, "正式知识进入独立检视任务");
  check(openedTasks[count].documentId === documentId && openedTasks[count].jobId === `dkx-review-${count + 1}`, "新任务保留选中文稿定位");
  await until(() => !document.querySelector('[role="dialog"][data-open]'), "创建后关闭检视配置弹窗");
}
function DomainTaskReview() {
  const inspection = useDomainKnowledgeInspection({ jobId: "dkx-original", working: false, onSubmitted: () => { domainSubmissions++; } });
  return <div className="tw-root"><DomainKnowledgeInspectionContext.Provider value={inspection}>
    <DomainKnowledgeInspectionStart inspection={inspection} />
    <DomainKnowledgeInspectionBar inspection={inspection} onOverall={() => {}} onProgress={() => {}} />
    <KnowledgeReviewNotes kind="domain" jobId="dkx-original" documentId="task-rules"><KnowledgeMarkdown text={"# 未合入的任务文稿\n\n取消订单之前核对状态。"} /></KnowledgeReviewNotes>
  </DomainKnowledgeInspectionContext.Provider></div>;
}
async function run() {
  await until(() => document.querySelector('.knowledge-markdown [data-l="3"]'), "module text is available on entry");
  check(!document.querySelector('[role="dialog"]'), "reading starts with the document");
  await hover(3);
  check(!document.querySelector(".annot-fab, .annot-editor"), "hovering text does not expose line annotation UI");
  const from = document.querySelector<HTMLElement>('.knowledge-markdown [data-l="3"]')!, to = document.querySelector<HTMLElement>('.knowledge-markdown [data-l="5"]')!;
  const range = document.createRange(); range.setStart(from.firstChild!, 0); range.setEnd(to.lastChild!, to.lastChild!.textContent!.length);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); await pause();
  check(selection.toString().includes("支付回调") && !document.querySelector(".annot-fab, .annot-editor"), "selecting text remains copyable without selection annotation controls");
  selection.removeAllRanges();
  check(!document.querySelector(".knowledge-review-notes"), "正式 Git 文稿只读，不再直接承载平台批注");
  await createInspection(ordersId);
  check(document.querySelector(".knowledge-markdown")?.textContent?.includes("取消订单之前核对发货状态"), "检视任务未合入前正式正文保持原内容");
  check(!calls.some(call => call.path.startsWith("/knowledge-review/published/")), "正式文稿不调用旧的直接批注接口");
  await click('button[title="docs/stock.md"]'); await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("只回补一次"), "第二份正式文稿可直接阅读");
  await createInspection(stockId);
  check(submitted(`/knowledge-documents/${ordersId}/inspection`).length === 1 && submitted(`/knowledge-documents/${stockId}/inspection`).length === 1, "不同文稿使用各自版本创建检视任务");
  documents[0].revision = "published-v2"; documents[0].source!.revision = "commit-v2";
  documents[0].content += "\n\n合入后补充了退款通知约定。"; directoryRevision = "directory-v2";
  invalidateKnowledgeReads(); await mount();
  await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("合入后补充"), "正式快照更新后阅读新正文");
  check(!document.querySelector(".knowledge-review-notes"), "快照刷新不恢复旧批注入口");

  const skill = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="模块知识目录"] button')].find(item => item.textContent?.includes("订单核对") && item.querySelector(".lucide-puzzle"));
  check(skill, "module Skill is available"); skill!.click(); await until(() => document.querySelector('.knowledge-markdown [data-l="3"]')?.textContent?.includes("关联订单"), "Skill markdown opens");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "说明读取哪个订单字段。"); await clickText("保存意见");
  const skillNote = submitted("/knowledge-review/skill/order-check").at(-1)!;
  check(skillNote?.body.document_id === "SKILL.md" && skillNote.body.scope === "document" && !("revision" in skillNote.body), "Skill feedback is scoped by package file without a digest"); await closeNotes();
  skillFiles[0].content += "\n\n已补充订单字段。"; skillRevision = "skill-v2";
  const skillReadsBefore = calls.filter(call => call.path === "/knowledge-review/skill/order-check" && !call.body).length;
  invalidateKnowledgeReads(); await mount("skill:order-check/SKILL.md");
  await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("已补充订单字段") && calls.filter(call => call.path === "/knowledge-review/skill/order-check" && !call.body).length > skillReadsBefore, "Skill 更新后重新加载正文与已保存意见");
  await openNotes();
  const notesPanel = document.querySelector('[role="dialog"][data-open] [aria-label="文稿修改意见"]')!;
  check(notesPanel.textContent?.includes("读取哪个订单字段") && !notesPanel.textContent?.includes("旧版本"), "已保存的 Skill 意见跨版本保留，不设旧版本门槛");
  const firstArticle = [...notesPanel.querySelectorAll("article")].find(item => item.textContent?.includes("读取哪个订单字段"))!;
  await clickText("标记已处理", firstArticle);
  check(notes.get("skill/order-check")![0].status === "resolved" && document.querySelector('[role="dialog"]')?.textContent?.includes("已处理"), "Skill 修改完成后可处理意见");
  check(submitted("/knowledge-review/skill/order-check/resolve").at(-1)?.body.note_ids.length === 1, "Skill 意见处理调用 resolve，不启动研究");
  await closeNotes();
  const reference = document.querySelector<HTMLButtonElement>('button[title="references/checks.md"]');
  if (!reference) { const folder = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="模块知识目录"] button')].find(item => item.textContent?.trim() === "references"); check(folder, "Skill references folder is available"); folder!.click(); await pause(); }
  await click('button[title="references/checks.md"]'); await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("核对支付与库存"), "Skill reference file opens");
  await openNotes(); check(!document.querySelector('[role="dialog"]')?.textContent?.includes("读取哪个订单字段"), "feedback remains isolated between files in the same Skill package");
  await fill('textarea[aria-label="整体修改意见"]', "补充清单中的库存释放条件。"); await clickText("保存意见");
  check(submitted("/knowledge-review/skill/order-check").at(-1)?.body.document_id === "references/checks.md", "参考文件意见保存到自己的相对路径"); await closeNotes();
  await click('button[title="SKILL.md"]'); await until(() => document.querySelector(".knowledge-markdown")?.textContent?.includes("已补充订单字段"), "返回 Skill 主文件");
  await openNotes(); check(document.querySelector('[role="dialog"]')?.textContent?.includes("已处理") && !document.querySelector('[role="dialog"]')?.textContent?.includes("库存释放条件"), "返回主文件保留处理状态且不混入其他文件意见"); await closeNotes();

  root.render(<DomainTaskReview />);
  await until(() => { const start = document.querySelector<HTMLButtonElement>(".domain-inspection-entry button"); return start && !start.disabled; }, "原任务文稿加载检视意见");
  await clickText("开始检视"); await hover(3); await click('[aria-label="给第 3 行添加批注"]');
  await fill('.annot-editor textarea', "核对未发货订单的取消边界。"); await clickText("记下");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "合入前在原任务补齐取消条件。");
  await clickText("完成");
  check(!calls.some(call => call.path.endsWith("/apply")), "任务内连续保存意见和草稿不会立即启动修改");
  await clickText("结束检视并修改"); await until(() => domainSubmissions === 1, "结束检视统一提交原任务");
  const domainApply = submitted("/knowledge-review/domain/dkx-original/apply")[0], domainNotes = notes.get("domain/dkx-original")!;
  check(domainApply?.body.note_ids.length === 2 && domainNotes.every(note => domainApply.body.note_ids.includes(note.id) && note.status === "submitted"), "未合入任务的行意见与整篇草稿一起提交原任务");
  check(domainNotes.some(note => note.scope === "line" && note.quote?.includes("取消订单")) && domainNotes.some(note => note.scope === "document"), "原任务检视保留行引用和整篇意见");
  check(openedTasks.length === 2, "原任务检视不再创建一个独立任务");

  const draftView = (token: number) => <div className="tw-root"><KnowledgeReviewNotes refreshToken={token} kind="component" jobId="cr-feedback" documentId="component-rules"><KnowledgeMarkdown text={"# 组件规则\n\n请完善取消与回调的处理。"} /></KnowledgeReviewNotes></div>;
  root.render(draftView(0));
  await until(() => calls.some(call => call.path === "/knowledge-review/component/cr-feedback" && !call.body), "draft feedback component loads");
  await hover(3); await click('[aria-label="给第 3 行添加批注"]');
  await fill('.annot-editor textarea', "补充重复回调的处理。"); await clickText("记下");
  check(!calls.some(call => call.path === "/knowledge-review/component/cr-feedback/apply"), "记下一行组件意见不会立即启动 Agent");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "由 Agent 补齐取消与重复回调的边界，并整理文稿。");
  await clickText("发送并修改");
  const saveIndex = calls.findIndex(call => call.path === "/knowledge-review/component/cr-feedback" && call.body);
  const applyIndex = calls.findIndex(call => call.path === "/knowledge-review/component/cr-feedback/apply" && call.body);
  check(saveIndex >= 0 && applyIndex > saveIndex, "one click saves the typed feedback before requesting Agent changes");
  const line = calls[saveIndex].body, draft = submitted("/knowledge-review/component/cr-feedback").at(-1)!.body, applied = calls[applyIndex].body, saved = notes.get("component/cr-feedback")!;
  check(draft.scope === "document" && draft.note.includes("由 Agent") && !("revision" in draft), "draft feedback is overall guidance without revision binding");
  check(line.scope === "line" && line.line === 3 && line.quote.includes("取消"), "逐行意见带上行号及原文");
  check(applied.note_ids.length === 2 && saved.every(note => applied.note_ids.includes(note.id) && note.status === "submitted"), "逐行和整篇意见一次提交");
  await closeNotes();
  check(document.querySelector('[role="status"]')?.textContent?.includes("Agent 正在修改文稿"), "关闭意见弹窗后仍能看见 Agent 正在修改");
  root.render(<div />); await pause(); root.render(draftView(1)); await pause();
  check(document.querySelector('[role="status"]')?.textContent?.includes("Agent 正在修改文稿"), "重新进入文稿仍显示真实修改状态");
  submissions["cr-feedback-turn"] = { working: false, status_label: "修改完成，请审阅文稿" };
  root.render(draftView(2)); await pause();
  check(document.querySelector('[role="status"]')?.textContent?.includes("修改完成"), "轮询完成后提示审阅");
  check(!document.querySelector('.animate-spin'), "完成后不再显示修改动画");
  root.render(<div className="tw-root"><KnowledgeReviewNotes kind="component" jobId="whole-feedback" documentId="" scope="study" /></div>); await pause();
  await clickText("整体文稿意见"); await fill('textarea[aria-label="整体修改意见"]', "缺少异常处理，概述中有重复。"); await clickText("发送并修改");
  check(submitted("/knowledge-review/component/whole-feedback").at(-1)?.body.scope === "study", "整体意见无需选择具体文档");
  await closeNotes();

  const workingView = (working: boolean) => <div className="tw-root"><KnowledgeReviewNotes kind="component" jobId="cr-working-feedback" documentId="active-rules" working={working}><KnowledgeMarkdown text={"# 运行中的研究\n\n当前文稿仍可阅读。"} /></KnowledgeReviewNotes></div>;
  root.render(workingView(true));
  await until(() => calls.some(call => call.path === "/knowledge-review/component/cr-working-feedback" && !call.body), "active research feedback loads");
  await openNotes(); await fill('textarea[aria-label="整体修改意见"]', "本轮结束后补充异常分支的说明。");
  const activeSubmit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.textContent?.trim() === "Agent 正在修改…");
  check(activeSubmit?.disabled, "active research cannot start a concurrent Agent revision");
  check(document.querySelector('[role="dialog"]')?.textContent?.includes("本轮正在处理"), "active research explains when feedback can be applied");
  await clickText("保存意见");
  check(submitted("/knowledge-review/component/cr-working-feedback").length === 1 && !calls.some(call => call.path === "/knowledge-review/component/cr-working-feedback/apply"), "feedback may be saved while research runs without launching an Agent");
  root.render(workingView(false)); await pause();
  await clickText("发送并修改");
  const laterApply = calls.find(call => call.path === "/knowledge-review/component/cr-working-feedback/apply");
  check(laterApply?.body.note_ids[0] === notes.get("component/cr-working-feedback")?.[0].id && submitted("/knowledge-review/component/cr-working-feedback").length === 1, "after execution completes the saved feedback can be submitted without retyping or duplicate save");
  check(!errors.length, errors.join("; "));
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面不横向溢出");
  root.unmount(); return { passed: true, width: innerWidth, inspectionTasks: openedTasks.length, domainSubmissions, publishedWrites: calls.filter(call => call.path.startsWith("/knowledge-review/published/") && call.body).length, skillNotes: notes.get("skill/order-check")?.length, agentRequests: calls.filter(call => call.path.endsWith("/apply")).length };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });
