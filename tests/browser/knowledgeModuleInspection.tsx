import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleReader } from "../../web/src/KnowledgeModuleReader";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";

const source = { repository: "https://example.test/knowledge.git", branch: "main", revision: "commit-1" };
const doc = (id: string, path: string, moduleId = "trade", extra: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({
  id, title: path, content: `# ${path}\n\n正式知识正文。`, scope: "module", module_ids: [moduleId], repositories: [],
  technologies: [], product_versions: [], when_to_use: "", active: true, revision: `${id}-revision`,
  source: { ...source, path }, history: [], ...extra,
});
const documents = [
  doc("kg-agents", "AGENTS.md"), doc("kg-nested-agents", "docs/agents.MD"),
  doc("kg-skill", "docs/SKILL.md", "trade", { form: "skill" }),
  doc("kg-inactive", "docs/obsolete.md", "trade", { active: false }),
  doc("kg-body", "Function_Knowledge/Access Function/交易/规则.md"),
  doc("kg-other", "docs/其他模块规则.md", "other"),
  doc("kg-empty-agents", "AGENTS.md", "empty"),
];
const opened: Array<{ jobId: string; documentId?: string }> = [], requests: Array<{ path: string; body?: any }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (input, options) => {
  const path = String(input), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  requests.push({ path, body });
  let result: unknown;
  if (path === "/knowledge-documents?view=directory") result = { documents, revision: "directory-1" };
  else if (path.endsWith("/inspection")) {
    check(path === "/knowledge-documents/kg-body/inspection", "从模块正文创建任务，不能使用导航、Skill、停用或其他模块文件");
    check(body.module_id === "trade" && body.expected_revision === "kg-body-revision", "提交模块归属及正文目录版本");
    check(body.issue_no === "REQ-REVIEW" && body.issue_description === "核对订单规则", "保留关联单号与描述");
    result = { id: "dkx-review", inspection_source: { document_id: "kg-body" } };
  } else if (path.startsWith("/knowledge-documents/")) {
    if (path === "/knowledge-documents/kg-agents") return new Response(JSON.stringify({ error: "导航正文暂时读取失败" }), { status: 503 });
    result = documents.find(document => document.id === path.split("/")[2]);
  } else if (path === "/business-modules") result = { modules: ["trade", "empty", "other"].map(id => ({
    id, name: id === "trade" ? "交易业务" : id === "empty" ? "仅导航模块" : "其他模块", status: "active",
    description: "", repositories: [], assets: [],
  })) };
  else if (path.endsWith("/knowledge-location")) result = { configured: true, location: { ...source, docs_path: "Function_Knowledge/Access Function/交易" }, sync: { state: "ready" } };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/skills?view=directory") result = { skills: [], operations: [] };
  else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
let generation = 0;
async function mount(moduleId: string, documentId: string) {
  const mountedGeneration = ++generation;
  root.render(<div className="tw-root knowledge-hub" data-generation={mountedGeneration} style={{ padding: 24, minHeight: "100vh" }}>
    <KnowledgeModuleReader key={mountedGeneration} moduleKey={`business:${moduleId}`} selectedDocumentId={documentId}
      onBack={() => {}} onResearch={(jobId, documentId) => opened.push({ jobId, documentId })} />
  </div>);
  await until(() => document.querySelector(`[data-generation="${mountedGeneration}"]`), "等待当前模块阅读器挂载");
}
const pause = () => new Promise(resolve => setTimeout(resolve, 65));
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function until(predicate: () => unknown, message: string) {
  for (let i = 0; i < 75 && !predicate(); i++) await pause();
  check(predicate(), message);
}
function button(label: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getClientRects().length && node.textContent?.trim() === label); }
async function click(label: string) { const node = button(label); check(node && !node.disabled, `入口不可用：${label}`); node!.click(); await pause(); }
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function inspectSelected(documentId: string) {
  await mount("trade", documentId);
  await until(() => button("开始检视") && !button("开始检视")!.disabled, `${documentId} 选中时模块仍可检视`);
  await click("开始检视");
  check(button("创建任务并开始检视")?.disabled, "关联信息未填完整时保留提交校验");
  await fill("检视关联单号", "REQ-REVIEW"); await fill("检视单号描述", "核对订单规则");
  check(!button("创建任务并开始检视")?.disabled, "模块检视无需等待当前文件的正文读取");
}
async function run() {
  await inspectSelected("kg-agents");
  await until(() => document.body.textContent?.includes("导航正文暂时读取失败"), "已模拟当前导航正文读取失败");
  await click("创建任务并开始检视");
  await until(() => opened.length === 1, "进入新检视任务");
  check(opened[0].documentId === "kg-body", "任务进入可检视正文，不定位导航文件");
  check(!requests.some(request => request.path === "/knowledge-documents/kg-body" && !request.body), "创建任务使用模块目录版本，无需额外读取当前正文");
  await inspectSelected("kg-nested-agents"); await click("创建任务并开始检视"); await until(() => opened.length === 2, "子目录导航同样可发起模块检视");
  await inspectSelected("kg-skill"); await click("创建任务并开始检视"); await until(() => opened.length === 3, "选中 Skill 时仍可检视模块正文");
  await mount("empty", "kg-empty-agents");
  await until(() => button("暂无可检视正文"), "没有正文时说明不可用原因");
  check(button("暂无可检视正文")?.disabled && !button("开始检视"), "只有导航的模块不能借用其他模块正文发起空任务");
  await inspectSelected("kg-agents");
  if (!new URLSearchParams(location.search).has("visual")) await click("取消");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面不横向溢出");
  check(!errors.length, errors.join("\n"));
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, created: opened.length, width: innerWidth });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
