import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ComponentResearch } from "../../web/src/ComponentResearch";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";
import type { KnowledgeProductionView } from "../../src/knowledgeProductionTypes";
import { componentGuideOverview, componentGuideSection } from "../fixtures/componentGuide";

const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const repos = ["文件基础库", "异步调用库"].map((name, i) => ({id:`repo-${i}`,name,repository:`https://code.example/r${i}.git`,branch:"main",path:"",languages:["cpp"],description:"",enabled:true}));
const projections = (window as unknown as { __COMPONENT_REVIEW_PRODUCTIONS__: Record<string, KnowledgeProductionView> }).__COMPONENT_REVIEW_PRODUCTIONS__;
const record: ComponentResearchRecord = {
  id:"cr-browser",format:"joint-document",topic:"基础组件联合使用指南",language:"cpp",operator:"专家",production: projections.initial,
  component:repos[0],components:repos,status:"done",stage:"草稿待审查",created_at:"2026-09-21T08:00:00Z",evidence:[],
  document:{overview:componentGuideOverview("文件基础库提供句柄管理，异步调用库在其上实现取消与回调。", "调用方先初始化资源，再提交异步操作，最后等待回调释放。"),sections:["安全打开与关闭", "异步读取与取消", "批量写入与错误恢复", ...Array.from({length:32}, (_,i) => `组件能力 ${i+4}：资源管理与错误恢复`)].map((title,i) => ({
    ...componentGuideSection(`cap-${i}`, i === 1 ? ["repo-0","repo-1"] : ["repo-0"], { title,
      content: Array.from({length:12}, () => "适用于需要明确资源所有权的操作。失败时先检查错误码，关闭已获得的资源；不得在回调结束前销毁句柄。").join("\n\n") }),
    selected:true,revision:1,related_ids:i === 1 ? ["cap-0"] : [],
  }))},review_turns:[],
};
for (const kind of ["contracts", "pitfalls", "index"] as const) {
  const section = componentGuideSection(`research-${kind}`, ["repo-0"], { title: `研究材料-${kind}`, component: "research" });
  record.document!.sections.push({ ...section, revision: 1, selected: true, content: `仅研究材料-${kind}`, interfaces: "", integration: "", example: "", unit_tests: "", paradigm: { ...section.paradigm!, kind } });
}
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const calls: any[] = [];
window.fetch = async (url, options) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  let result: unknown;
  if (path === "/component-repositories") result = {components:repos};
  else if (path.startsWith("/knowledge-review/")) result = { notes: [], submissions: {} };
  else if (path === "/business-modules") result = {modules:[]};
  else if (path === "/component-research") result = {records:[record]};
  else if (path.endsWith("/artifacts")) result = { mapping: "# 组件选择表\n\n需要安全释放资源 → Close（SDK v2）", rules: [], files: { "components/file/paradigms/close.md": "# 安全释放\n正文" } };
  else if (path.endsWith("/selection")) {
    calls.push({action:"selection",...body});
    for (const section of record.document!.sections) if (body.ids.includes(section.id)) section.selected = body.selected;
    record.production = body.ids.length === record.document!.sections.length ? body.selected ? projections.initial : projections.none : projections.excluded;
    result = record;
  } else if (path.endsWith("/review")) {
    calls.push({action:"review",...body});
    if (body.mode === "supplement") {
      const base = record.document!.sections[0];
      record.document!.sections.push({ ...base, id: "cap-pool", title: "连接池超时回收", revision: 1, selected: true, related_ids: [] });
      record.review_turns!.push({ id: `turn-${calls.length}`, ...body, added_section_ids: ["cap-pool"], operator: "专家", status: "done", reply: "补充了连接池超时回收。", created_at: new Date().toISOString() });
      return new Response(JSON.stringify(record), { headers: { "Content-Type": "application/json" } });
    }
    const section = record.document!.sections.find(s => s.id === body.section_id)!;
    const proposal = body.mode === "rework" ? { base_revision: section.revision, section: { ...section, revision: section.revision + 1, content: section.content + " 返工已补充取消时的资源释放说明。" }, status: "pending" as const } : undefined;
    record.review_turns!.push({proposal,id:`turn-${calls.length}`,...body,operator:"专家",status:"done",reply:"已核对来源，仅处理当前能力，其他组件保持原样。",created_at:new Date().toISOString()});
    record.production = body.mode === "rework" ? projections.proposed : projections.discussed;
    result = record;
  } else if (path.endsWith("/proposal")) {
    const turn = record.review_turns!.find(t => t.id === body.turn_id)!;
    const index = record.document!.sections.findIndex(s => s.id === turn.proposal!.section.id);
    record.document!.sections[index] = turn.proposal!.section; turn.proposal!.status = "accepted"; record.production = projections.accepted; result = record;
  } else if (path === "/component-research/cr-browser") result = record;
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result),{headers:{"Content-Type":"application/json"}});
};
const root = createRoot(document.getElementById("app")!);
root.render(<ComponentResearch open onClose={() => {}} onAdopt={() => {}} />);
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
async function click(text: string) {check(button(text),`missing button ${text}`);button(text).click();await pause();}
async function message(value: string) {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="组件讨论或返工意见"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,value);
  field.dispatchEvent(new Event("input",{bubbles:true}));await pause();
}
async function run() {
  for (let i=0;i<60 && !document.querySelector('[aria-label="组件萃取文档"]');i++) await pause();
  check(document.querySelector('[aria-label="文档目录"]'), "result opens as a document tree");
  check(!document.querySelector('[aria-label="组件专家对话"]'), "discussion stays out of the reading view");
  await click("审阅与修订");
  const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[aria-label="组件能力目录"] input[type="checkbox"]')];
  check(boxes().length === record.document!.sections.length && boxes().every(b => b.checked), "all discovered capabilities must default selected");
  await click("全不选");check(boxes().every(b => !b.checked),"unselect all");
  await click("全选");boxes()[2].click();await pause();check(!boxes()[2].checked,"single checkbox selection");
  const capability = [...document.querySelectorAll<HTMLButtonElement>('button.knowledge-outline-title')].find(b => b.textContent?.includes("异步读取"))!;
  capability.click();await pause();
  const itemText = document.querySelector('[aria-label="组件详细文档"] .knowledge-markdown')?.textContent ?? "";
  check(itemText.includes("单元测试示例") && itemText.includes("assert(std::fread(buffer, 1, 5, file) == 5)"), "item review exposes actual unit test code and assertions");
  check(!/推荐|待核实|待研究|未编译验证/.test(itemText), "item manuscript does not prepend internal status labels");
  const outline = document.querySelector('[aria-label="知识文档列表"]')!;
  check(!outline.textContent?.includes("include/file.h"), "knowledge outline excludes source paths");
  check(!outline.querySelector("[aria-expanded]") && !outline.textContent?.includes("公共接口"), "document navigation has no chapter expansion");
  const before = JSON.stringify(record.document!.sections[0]);
  await message("为什么取消后仍需要等待回调？");await click("仅讨论");
  check(record.document!.sections[1].revision === 1,"discussion must not mutate draft");
  await message("请补充取消后的资源释放顺序");await click("生成修订建议");
  check(record.document!.sections[1].revision === 1,"unaccepted proposal must not mutate draft");
  await click("修订差异");await click("采纳此建议");await click("正文");
  check(record.document!.sections[1].revision === 2,"target must be revised");
  check(JSON.stringify(record.document!.sections[0]) === before,"other capability must remain unchanged");
  check(calls.filter(c => c.action === "review").every(c => c.section_id === "cap-1"),"dialogue must target selected capability");
  check(document.querySelector('[aria-label="组件专家对话"]')?.textContent?.includes("为什么取消"),"conversation history retained");
  await click("完整文档");
  const fullDocument = document.querySelector('[aria-label="完整文档阅读区"] .knowledge-markdown')!;
  const selectedUsages = record.document!.sections.filter(section => section.selected && section.paradigm?.kind === "paradigm" && section.paradigm.status === "recommended");
  check([...fullDocument.querySelectorAll(".md-h3")].filter(heading => heading.textContent === "单元测试示例").length === selectedUsages.length, "complete guide includes only selected recommended usages");
  check(fullDocument.textContent?.includes("单元测试示例") && fullDocument.textContent.includes("assert(std::fread(buffer, 1, 5, file) == 5)"), "complete guide includes the same unit test code");
  check(!/研究材料-|推荐|待核实|待研究|未编译验证/.test(fullDocument.textContent ?? ""), "complete guide excludes research phase chapters and internal labels");
  check(["组件用途", "接入配置", "用法导航"].every(title => [...fullDocument.querySelectorAll(".md-h2")].some(heading => heading.textContent === title)), "component-level template is visible");
  check(document.querySelector('[aria-label="文档组件目录"]'),"navigable directory");
  const fullNavigation = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="文档组件目录"] .knowledge-outline-title')].find(button => button.textContent?.includes("异步读取"))!;
  fullNavigation.click(); await pause();
  check(document.querySelector<HTMLElement>('[aria-label="完整文档阅读区"]')!.scrollTop > 0 && !fullDocument.querySelector('[role="status"]'), "full guide directory locates the selected usage");
  await click("逐项审核");
  check(!document.querySelector('[aria-label="组件详细文档"] [role="status"]'), "returning to item review clears the full-guide anchor");
  const list = document.querySelector<HTMLElement>('[aria-label="知识文档列表"]')!;
  const reader = document.querySelector<HTMLElement>('[aria-label="组件详细文档"]')!;
  const outer = document.querySelector("main")!;
  const outerTop = outer.scrollTop;
  check(list.scrollHeight > list.clientHeight && reader.scrollHeight > reader.clientHeight, "both long panes must have bounded independent scroll areas");
  list.scrollTop = 180;
  reader.scrollTop = 220;
  await pause();
  check(list.scrollTop === 180 && reader.scrollTop === 220 && outer.scrollTop === outerTop, "scroll positions must stay independent");
  check(getComputedStyle(list).overscrollBehaviorY === "auto" && getComputedStyle(reader).overscrollBehaviorY === "auto", "wheel at a boundary can continue scrolling the parent");
  const next = [...list.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("批量写入"))!;
  next.click();await pause();
  check(reader.scrollTop === 0 && list.scrollTop === 180, "switching component resets document only");
  list.scrollTop = 0;
  const sectionCount = record.document!.sections.length;
  await click("补充遗漏能力");
  check(document.querySelector('[role="dialog"]')?.textContent?.includes("文件基础库、异步调用库"), "supplement dialog names the research scope");
  const gap = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="遗漏的能力说明"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(gap,"漏了连接池的超时回收");
  gap.dispatchEvent(new Event("input",{bubbles:true}));await pause();
  await click("开始补充");
  const supplement = calls.filter(c => c.action === "review").at(-1);
  check(supplement.mode === "supplement" && supplement.section_id === "" && supplement.message === "漏了连接池的超时回收", "supplement is a review turn bound to no existing capability");
  check(record.document!.sections.length === sectionCount + 1, "supplement adds a capability");
  const addedLink = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.trim() === "连接池超时回收");
  check(addedLink, `dialog lists the added capability: ${document.querySelector('[role="dialog"]')?.textContent}`); addedLink!.click(); await pause();
  check(!document.querySelector('[role="dialog"]:not([data-closed])'), "jumping to the added capability closes the dialog");
  check(document.querySelector('[aria-label="组件详细文档"]')?.textContent?.includes("连接池超时回收"), `added capability opens for item review: ${document.querySelector('[aria-label="组件详细文档"]')?.textContent?.slice(0, 80)}`);
  check(boxes().length === sectionCount + 1 && record.document!.sections.find(section => section.id === "cap-pool")!.selected, "added capability appears selected in the directory");
  const workspace = document.querySelector('[aria-label="组件审核工作区"]')!;
  check(workspace.scrollWidth <= workspace.clientWidth + 2,"desktop workspace horizontal overflow");
  check(document.documentElement.scrollWidth <= innerWidth + 2,"desktop page horizontal overflow");
  check(!document.querySelector('input[type="file"]'), "component research must not expose uploads");
  document.querySelector<HTMLButtonElement>('[aria-label="文稿更多操作"]')!.click(); await pause();
  const artifactsAction = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes("查看派生产物"));
  check(artifactsAction, "artifact preview remains in the more menu"); artifactsAction!.click(); await pause();
  check(document.querySelector('[role="dialog"]:not([data-closed])')?.textContent?.includes("规则未启用"), "derived candidates cannot claim enabled");
  check(button("下载结构化产物"), "structured artifact export available");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "artifact preview does not overflow desktop");
  // 知识库阅读页的统一审查：开研究对话时让出目录，正文宽度基本不缩水；收起后目录回来。
  root.render(<ComponentResearch key="knowledge" open focused focusId="cr-browser" surface="knowledge" onClose={() => {}} onAdopt={() => {}} />);
  for (let i=0;i<60 && !button("研究对话");i++) await pause();
  const readerWidth = () => document.querySelector<HTMLElement>('[aria-label="组件详细文档"]')!.getBoundingClientRect().width;
  const widthBefore = readerWidth();
  await click("研究对话");
  check(document.querySelector('[aria-label="组件专家对话"]') && !document.querySelector('[aria-label="组件能力目录"]'), "opening the dialogue yields the directory to the body");
  check(readerWidth() >= widthBefore - 120, `body keeps most of its width while the dialogue is open: ${widthBefore} -> ${readerWidth()}`);
  await click("研究对话 · 收起");
  check(document.querySelector('[aria-label="组件能力目录"]'), "closing the dialogue restores the directory");
  check(!errors.length,errors.join(";"));

  return {passed:true,width:innerWidth,selected:boxes().filter(b => b.checked).length,turns:record.review_turns!.length};
}
if (!new URLSearchParams(location.search).has("scrollCheck")) run().then(value => {document.getElementById("result")!.textContent = JSON.stringify(value);})
  .catch(error => {document.getElementById("result")!.textContent = JSON.stringify({error:String(error)});});
