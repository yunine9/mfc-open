import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { LaunchWorkspace } from "../../web/src/LaunchWorkspace";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
import { KnowledgeResearchCreate, type KnowledgeResearchDraft } from "../../web/src/KnowledgeResearchCreate";

const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const uploadNames: string[] = [];
const saved = new Map<string, any>();
let omitSource = false, created: any, previewCount = 0, currentPreview: any;
let closeCount = 0, researchCreates = 0, releaseUpload: (() => void) | undefined;
let knowledgeModules: string[] = [];
const draftKey = "mae-flow:launch:draft:alice";
localStorage.setItem(draftKey, JSON.stringify({ version: 1, title: "多份需求资料", requirement: "必须保留的补充说明",
  businessModuleId: "module", selectedBusinessModuleIds: ["other"], moduleSelectionTouched: true,
  repos: [], updatedAt: new Date().toISOString() }));
window.fetch = async (input, init) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
  let result: unknown;
  if (path === "/business-modules") result = { modules: [{ id: "module", name: "测试模块", status: "active", repositories: [], knowledge: [] }], operations: [], warnings: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/skills") result = { skills: [], operations: [], warnings: [] };
  else if (path === "/domain-extraction") { researchCreates++; result = { id: "research" }; }
  else if (path === "/technology-stacks") result = { stacks: [] };
  else if (["/auth/collaboration-assignees", "/auth/people", "/auth/users"].includes(path)) result = [];
  else if (path === "/workflow-assets") result = { items: [], warnings: [] };
  else if (path === "/launch-options") result = { repo: { enabled: false, required: false }, ticket: { enabled: false, required: false }, baseline: { enabled: false, default: "" }, blockers: [], workflows: [], execution_playbooks: [], team_skills: [], business_modules: ["module", "other"].map(id => ({ id, name: id === "module" ? "测试模块" : "另一个模块", repositories: [], entries: [], knowledge: [], version: 1 })) };
  else if (path === "/launch-knowledge-preview") {
    knowledgeModules = body.selected_business_module_ids;
    result = { complete: true, degraded: false, scope: { repositories: [], technologies: [], business_module_ids: knowledgeModules, workflow_business_module_ids: [], workflow_team_skill_ids: [] }, business_knowledge: knowledgeModules.map(id => ({ module_id: id, module_name: id === "module" ? "测试模块" : "另一个模块", module_revision: 1, id: `kg-${(id === "module" ? "a" : "b").repeat(64)}`, title: `${id} 正式文档`, summary: "docs/业务规则.md", when_to_use: "修改业务规则时", form: "document", repositories: [], version: 1, digest: "c".repeat(64), bytes: 100, matched_business_module_ids: [id], matched_repositories: [], matched_technologies: [] })), team_skills: [], selection_digest: knowledgeModules.join(","), warnings: [], errors: [] };
  }
  else if (path === "/knowledge-materials") {
    uploadNames.push(body.name);
    if (body.name === "延迟.docx") await new Promise<void>(resolve => { releaseUpload = resolve; });
    if (body.name === "失败.pdf") return new Response(JSON.stringify({ error: "文件无法解析" }), { status: 400 });
    const item = { id: `material-${uploadNames.length}`, name: body.name, version: "", scope: body.scope, state: "ready", sections: 2, warnings: [], images: [] };
    saved.set(item.id, item); result = item;
  } else if (path === "/requirement-materials/preview") {
    previewCount++;
    const sources = body.material_ids.map((id: string) => ({ id, name: saved.get(id).name,
      path: `.mae-flow-work/requirement-sources/${id}/source.md`, bytes: 10, digest: id }));
    result = currentPreview = { requirement: [body.requirement, ...sources.map((source: any) => `# ${source.name}\n完整正文 ${source.id}`)].join("\n\n"),
      document_name: "需求资料汇编.md", sources: omitSource ? sources.slice(1) : sources, assets: [], warnings: [] };
  } else if (path === "/tasks" && init?.method === "POST") {
    created = body; result = { id: "created", requirement: currentPreview.requirement, status: "waiting_for_human" };
  } else if (path.includes("/artifacts")) result = [];
  else if (path.endsWith("/annotations")) result = { items: [], checks: [], closures: [] };
  else if (path.endsWith("/conversation")) result = { items: [], problems: [] };
  else if (path.endsWith("/reviews")) result = [];
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
let root = createRoot(document.getElementById("app")!);
const render = () => root.render(<LaunchWorkspace session={{ username: "alice", role: "developer" } as any}
  onCreated={() => {}} onClose={() => { closeCount++; }} onOpenKnowledgeAsset={() => {}} />);
function ResearchForm() {
  const [draft, setDraft] = useState<KnowledgeResearchDraft | undefined>({ mode: "domain", destination: "business:module", language: "", goal: "完整研究", branch: "master", issue: "REQ1", issueDescription: "研究规则", repo: "", path: "",
    materials: [{ id: "upload-failed-local", name: "损坏.pdf", state: "failed", error: "文件无法解析", version: "", scope: "", sections: 0 }] });
  return <KnowledgeResearchCreate draft={draft} onDraftChange={setDraft} onBack={() => {}} onCreated={() => {}} />;
}
async function until(predicate: () => unknown, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await pause(); }
  throw new Error(`${message}; ${errors.join(";")}; ${document.getElementById("app")?.textContent?.slice(-1200)}`);
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") || item.textContent?.trim()) === label);
const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function upload(names: string[]) {
  const files = new DataTransfer(); names.forEach(name => files.items.add(new File(["正文"], name)));
  const input = document.querySelector<HTMLInputElement>('[aria-label="上传需求资料"]')!;
  check(input.multiple, "需求支持一次多选"); input.files = files.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => !button("上传中…"), "上传没有结束");
}
async function fill(value: string) {
  const input = document.getElementById("launch-requirement") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function run() {
  render(); await until(() => document.querySelector('[aria-label="上传需求资料"]') && !submit().disabled, "发起页未就绪");
  check(!document.body.textContent?.includes("模块知识范围"), "下单不能再要求重复选择模块知识范围");
  check(JSON.stringify(knowledgeModules) === '["module"]', "旧草稿的独立知识选择覆盖了所属模块");
  check(document.body.textContent?.includes("module 正式文档"), "预览未显示服务端返回的正式文档");
  const moduleSelect = [...document.querySelectorAll<HTMLSelectElement>("select")].find(item => item.closest("label")?.textContent?.includes("所属业务模块"))!;
  moduleSelect.value = "other";
  moduleSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await pause();
  check(submit().disabled, "模块切换后不能沿用旧知识预览提交");
  await until(() => knowledgeModules[0] === "other" && !submit().disabled, "切换所属模块未同步刷新知识预览");
  await upload(["需求.md", "失败.pdf", "规则.xlsx"]);
  await until(() => button("移除 规则.xlsx"), "失败文件之后的资料未上传");
  check(uploadNames.length === 3 && submit().disabled, "单份失败不能丢失后续资料或允许遗漏发起");
  button("移除 失败.pdf")!.click();
  await until(() => !submit().disabled, "移除失败资料后未完成预览");
  check(document.querySelector('[aria-label="完整需求预览"]')?.textContent?.includes("完整正文 material-3"), "预览缺少第二份资料正文");
  check((document.getElementById("launch-requirement") as HTMLTextAreaElement).value === "必须保留的补充说明", "导入覆盖了补充说明");
  omitSource = true; await fill("后补说明");
  await until(() => button("重试预览"), "缺少材料的预览未显示错误");
  check(submit().disabled, "不完整预览允许发起");
  omitSource = false; button("重试预览")!.click(); await until(() => !submit().disabled, "重试未恢复");
  window.dispatchEvent(new Event("pagehide"));
  const stored = JSON.parse(localStorage.getItem(draftKey)!);
  check(stored.requirementMaterials.length === 2 && stored.requirement === "后补说明", "草稿没有保留资料和补充正文");
  check(stored.businessModuleId === "other" && !("selectedBusinessModuleIds" in stored), "草稿应只保存所属业务模块");
  const countBeforeRestore = previewCount;
  root.unmount(); root = createRoot(document.getElementById("app")!); render();
  await until(() => previewCount > countBeforeRestore && !submit().disabled, "恢复草稿未重新预览资料");
  check(uploadNames.length === 3 && button("移除 需求.md") && button("移除 规则.xlsx"), "恢复要求重新上传或丢失资料");
  button("移除 需求.md")!.click(); await until(() => !submit().disabled, "移除后未更新预览");
  await upload(["接口.docx"]); await until(() => !submit().disabled, "追加资料未准备就绪");
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(() => created, "创建请求未发出");
  check(created.requirement === "后补说明", "创建重复发送合成正文");
  check(created.business_module_id === "other" && JSON.stringify(created.selected_business_module_ids) === '["other"]'
    && created.knowledge_preview_digest === "other", "提交的归属模块、知识范围与预览不一致");
  check(JSON.stringify(created.requirement_material_ids) === JSON.stringify(["material-3", "material-4"]), "创建没有保留全部剩余资料或排序");
  if (new URLSearchParams(location.search).get("scenario") === "module") {
    await until(() => !button("清空草稿")?.disabled, "创建提交未结束");
    button("清空草稿")!.click();
    await until(() => knowledgeModules.length === 0, "清空草稿未同步清空模块知识范围");
    check([...document.querySelectorAll<HTMLSelectElement>("select")].find(item => item.closest("label")?.textContent?.includes("所属业务模块"))?.value === "", "清空草稿仍保留所属模块");
    check(!errors.length, errors.join(";"));
    return { moduleFollowsSelection: true, restoredDraft: true, submittedScope: true, clearedScope: true, width: innerWidth };
  }
  root.unmount(); root = createRoot(document.getElementById("app")!);
  root.render(<TaskWorkspace task={{ id: "task", title: "已创建的多份需求", requirement: currentPreview.requirement, status: "completed", created_at: "2026-10-13", updated_at: "2026-10-13", luban_account: "alice",
    requirement_document: { name: "需求资料汇编.md", bytes: 100, context_mode: "inline", sources: currentPreview.sources } } as any}
    viewerUsername="alice" canOperate canOverride={false} onChanged={async () => {}} onClose={() => {}} />);
  await until(() => document.querySelector('[aria-label="需求原始文件"]'), "工作台没有来源列表");
  const downloads = document.querySelectorAll<HTMLAnchorElement>('[aria-label="需求原始文件"] a');
  check(downloads.length === 2 && downloads[0].download === "规则.xlsx" && downloads[0].getAttribute("href")?.includes("requirement-sources?path="), "原始来源下载缺失");
  check(document.body.textContent?.includes("当前需求"), "工作台未说明当前需求与原文件的区别");
  root.unmount(); root = createRoot(document.getElementById("app")!); root.render(<ResearchForm />);
  await until(() => button("移除 损坏.pdf") && document.querySelector('[aria-label="知识归属"]')?.textContent?.includes("测试模块"), "研究创建页资料未恢复");
  check(button("开始研究")?.disabled && document.querySelector('[role="alert"]')?.textContent?.includes("解析失败"), "研究入口未解释失败资料或仍能创建");
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await pause();
  check(researchCreates === 0, "表单回车绕过失败资料检查");
  button("移除 损坏.pdf")!.click(); await until(() => !button("开始研究")?.disabled, "移除失败资料后仍无法研究");
  root.unmount(); root = createRoot(document.getElementById("app")!);
  localStorage.setItem(draftKey, JSON.stringify({ version: 1, title: "上传中的草稿", requirement: "保留正文", businessModuleId: "module", repos: [], updatedAt: new Date().toISOString() }));
  render(); await until(() => button("清空草稿") && !submit().disabled, "上传保护场景未就绪");
  const pendingUpload = upload(["延迟.docx"]);
  await until(() => releaseUpload && button("上传中…"), "延迟上传未开始");
  const closesBeforeUpload = closeCount;
  check(button("清空草稿")?.disabled && button("取消创建任务")?.disabled, "上传时仍能清空或关闭草稿");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await pause();
  check(closeCount === closesBeforeUpload, "Escape 绕过上传保护");
  window.dispatchEvent(new Event("pagehide")); root.unmount();
  releaseUpload!(); await pendingUpload; await pause();
  check(JSON.parse(localStorage.getItem(draftKey)!).requirementMaterials.length === 0, "离开后的旧上传结果污染草稿");
  check(!errors.length, errors.join(";"));
  return { multiUpload: true, retainedSupplement: true, failedFileVisible: true, completePreview: true, restoredDraft: true, sourceDownloads: true, failedResearchBlocked: true, uploadLifecycle: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
