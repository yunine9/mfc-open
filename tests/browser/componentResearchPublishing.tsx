import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ComponentResearch } from "../../web/src/ComponentResearch";
import { KnowledgeStudioContext } from "../../web/src/KnowledgeStudioContext";
import type { ComponentResearchRecord } from "../../web/src/componentResearchApi";
import type { KnowledgeProductionView } from "../../src/knowledgeProductionTypes";
import { componentGuideOverview, componentGuideSection } from "../fixtures/componentGuide";

const pause = () => new Promise(resolve => setTimeout(resolve, 80));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const repository = { id: "file", name: "文件组件", repository: "https://example.test/file.git", branch: "master", path: "", languages: ["cpp"], description: "", enabled: true };
const fixtures = (window as unknown as { __COMPONENT_PUBLISHING_FIXTURES__: { projections: Record<string, KnowledgeProductionView> } }).__COMPONENT_PUBLISHING_FIXTURES__;
const projections = fixtures.projections;
const record: ComponentResearchRecord = { id: "cr-publish", topic: "文件组件使用指南", language: "cpp", status: "done", stage: "待审查", operator: "dev", created_at: "2026-09-30T00:00:00Z", component: repository, components: [repository], evidence: [], production: projections.initial, format: "joint-document", document: {
  overview: componentGuideOverview(), sections: ["打开与关闭", "异步读取"].map((title, index) => ({ ...componentGuideSection(`section-${index}`, [repository.id], { title, component: index === 0 ? "file-open" : "file-read", content: "由调用方负责释放句柄。\n\n".repeat(40) }), selected: true, revision: 3 })),
} };
record.review_turns = record.document!.sections.map((section, index) => ({
  id: `proposal-${index}`, section_id: section.id, mode: "rework", message: "请明确资源释放顺序", operator: "dev", status: "done", created_at: record.created_at,
  proposal: { base_revision: index === 0 ? section.revision : section.revision - 1, status: "pending", section: { ...section, content: section.content + "\n\n最新修改：先取消回调，再释放句柄。" } },
}));
const calls: Array<{ path: string; body: any }> = [], errors: string[] = [];
let openedDocument = "";
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async (url, options) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, body });
  let result: unknown;
  if (path === "/component-research") result = { records: [record] };
  else if (path === "/component-repositories") result = { components: [repository] };
  else if (path === "/business-modules") result = { modules: [] };
  else if (path === "/component-research/cr-publish") result = record;
  else if (path.startsWith("/knowledge-review/")) result = { notes: [] };
  else if (path.endsWith("/selection")) { record.document!.sections.forEach(section => { if (body.ids.includes(section.id)) section.selected = body.selected; }); record.production = body.ids.length === 2 ? body.selected ? projections.initial : projections.none : projections.selected; result = record; }
  else if (path === "/component-research/cr-publish/publish") {
    const rejected = (error: string) => new Response(JSON.stringify({ error }), { status: 400, headers: { "content-type": "application/json" } });
    const selected = record.document!.sections.filter(section => section.selected);
    if (body.document_id !== (record.document_id ?? null) || body.update_document_id !== (record.update_document_id ?? null)
      || body.update_document_revision !== record.update_document_revision || body.sections.length !== selected.length) return rejected("文稿已有新修改，请重新检视后发布");
    const proposals = selected.map(section => ({ section, turn: [...record.review_turns!].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending") }));
    for (const { section, turn } of proposals) {
      const inspected = body.sections.find((item: { id: string }) => item.id === section.id);
      if (!inspected || inspected.revision !== section.revision || inspected.proposal_id !== (turn?.id ?? null)) return rejected("文稿已有新修改，请重新检视后发布");
      if (turn && turn.status !== "done") return rejected(`“${section.title}”的修改尚未完成，请先查看研究过程`);
      if (turn?.proposal && turn.proposal.base_revision !== section.revision) return rejected(`“${section.title}”已发生变化，请先查看修订差异，处理冲突后再发布`);
    }
    check(body.archive === undefined, "平台发布不接收归档设置");
    for (const { section, turn } of proposals) if (turn?.proposal) {
      Object.assign(section, turn.proposal.section, { revision: section.revision + 1 });
      turn.proposal.status = "accepted";
      for (const other of record.review_turns!) if (other.id !== turn.id && other.section_id === turn.section_id && other.proposal?.status === "pending") other.proposal.status = "discarded";
    }
    record.document_id = "kd-published";
    record.production = projections.adopted;
    result = record;
  } else throw new Error(`unexpected request ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
function Task() {
  const [surface, setSurface] = React.useState<"knowledge" | "workbench">("knowledge");
  return <KnowledgeStudioContext.Provider value={{ view: surface, openExecution: () => setSurface("workbench"), openResult: () => setSurface("knowledge") }}>
    <div className="knowledge-hub is-focused"><div className="knowledge-hub-task"><ComponentResearch open focused focusId={record.id} surface={surface} onClose={() => {}} onAdopt={id => { openedDocument = id; }} /></div></div>
  </KnowledgeStudioContext.Provider>;
}
createRoot(document.getElementById("app")!).render(<Task />);
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
async function click(text: string) { const button = buttons().find(item => item.textContent?.trim() === text); check(button, `missing ${text}`); button!.click(); await pause(); }
async function run() {
  for (let i = 0; i < 60 && !document.querySelector('[aria-label="组件能力目录"]'); i++) await pause();
  check(document.querySelector('h2')?.textContent === record.topic, "same task title opens directly above the manuscript");
  check(!buttons().some(button => button.textContent === "审阅与修订"), "no second review entry");
  check(!document.body.textContent?.includes("查看 Skill"), "platform skill controls stay hidden");
  check(calls.some(call => call.path === "/knowledge-review/component/cr-publish"), "existing annotation wrapper connected");
  let originalReader = document.querySelector<HTMLElement>('[aria-label="组件详细文档"]')!;
  check(originalReader.textContent?.includes("单元测试示例") && originalReader.textContent.includes("assert(std::fread(buffer, 1, 5, file) == 5)"), "candidate review includes concrete unit-test assertions");
  check(originalReader.textContent?.includes("最新修改：先取消回调，再释放句柄。"), "current complete candidate appears directly in manuscript");
  check(record.document!.sections[0].revision === 3 && !record.document!.sections[0].content.includes("最新修改"), "preview leaves the accepted draft unchanged");
  originalReader.scrollTop = 210; await pause();
  check(originalReader.scrollTop === 210, "manuscript has a bounded scroll area");
  await click("研究过程");
  check(document.querySelector('[aria-label="研究过程记录"]')?.getClientRects().length, "progress remains in the same task shell");
  check(!originalReader.getClientRects().length, "manuscript is hidden while progress is open");
  check(!buttons().find(button => button.textContent?.trim() === "确认并发布")?.getClientRects().length, "progress offers manuscript inspection before publication");
  check(projections.initial.navigation.ready_action_label, "completed draft supplies a backend navigation action");
  await click(projections.initial.navigation.ready_action_label!);
  check(document.querySelector('[aria-label="组件详细文档"]') === originalReader && originalReader.scrollTop === 210, "switching back preserves manuscript DOM and reading position");
  check(document.querySelectorAll('[aria-label="组件审核工作区"]').length === 1, "switching does not append duplicate review instances");
  await click("完整文档");
  const fullGuide = document.querySelector('[aria-label="完整文档阅读区"] .knowledge-markdown')!;
  check(fullGuide.textContent?.includes("单元测试示例") && fullGuide.textContent.includes("assert(std::fread(buffer, 1, 5, file) == 5)"), "full candidate guide preserves UT code");
  check(!/推荐|待核实|待研究|未编译验证/.test(fullGuide.textContent ?? ""), "full candidate guide contains no internal status labels");
  await click("逐项审查");
  originalReader = document.querySelector<HTMLElement>('[aria-label="组件详细文档"]')!;
  await click("确认并发布");
  check(document.querySelector('[role="alert"]')?.textContent?.includes("异步读取"), "stale selected candidate explains which capability conflicts");
  check(!calls.some(call => /\/(proposal|adopt)$/.test(call.path)), "preflight validates every selected candidate before any write");
  await click("全不选");
  check(buttons().find(button => button.textContent?.trim() === "确认并发布")?.disabled, "zero selected prevents publishing");
  await click("全选");
  const boxes = [...document.querySelectorAll<HTMLInputElement>('[aria-label="组件能力目录"] input[type="checkbox"]')];
  boxes[1].click(); await pause();
  const title = [...document.querySelectorAll<HTMLButtonElement>(".knowledge-outline-title")][1];
  title.click(); await pause();
  check(!boxes[1].checked, "opening content does not select it");
  record.review_turns!.push({ ...record.review_turns![0], id: "proposal-late", proposal: { ...record.review_turns![0].proposal!, section: { ...record.review_turns![0].proposal!.section, content: record.review_turns![0].proposal!.section.content + "\n\n新的后台修改：记录等待回调的超时。" } } });
  record.production = projections.late;
  await click("确认并发布");
  check(document.querySelector('[role="alert"]')?.textContent?.includes("文稿已有新修改，请重新检视后发布"), "a candidate arriving after inspection requires another inspection");
  check(!calls.some(call => /\/(proposal|adopt)$/.test(call.path)), "a newer unseen candidate is never accepted automatically");
  [...document.querySelectorAll<HTMLButtonElement>(".knowledge-outline-title")][0].click(); await pause();
  check(originalReader.textContent?.includes("新的后台修改：记录等待回调的超时。"), "the refreshed manuscript now shows the latest candidate");
  record.review_turns!.at(-1)!.status = "failed";
  record.production = projections.failed;
  await click("确认并发布");
  check(!calls.some(call => /\/(proposal|adopt)$/.test(call.path)), "an incomplete proposal cannot silently publish the old body");
  record.review_turns!.at(-1)!.status = "done";
  record.production = projections.late;
  const confirm = buttons().find(button => button.textContent?.trim() === "确认并发布")!;
  const validPublishStart = calls.length;
  confirm.click(); confirm.click(); await pause();
  for (let i = 0; i < 20 && !buttons().some(button => button.textContent?.trim() === "归档"); i++) await pause();
  const publicationPosts = calls.slice(validPublishStart).filter(call => call.body !== undefined && /\/cr-publish\/(?:proposal|adopt|publish|archive(?:\/publish)?)$/.test(call.path));
  check(publicationPosts.length === 1 && publicationPosts[0].path === "/component-research/cr-publish/publish", "生产线验收10：一次确认只发送一个发布 POST，不再串行确认建议、入库和准备归档");
  check(!calls.some(call => call.body !== undefined && /\/(?:proposal|adopt|archive(?:\/publish)?)$/.test(call.path)), "publication never sends the legacy mutation chain");
  check(JSON.stringify(publicationPosts[0].body.sections) === JSON.stringify([{ id: "section-0", revision: 3, proposal_id: "proposal-late" }]), "one request preserves the inspected section revision and latest proposal identity");
  check(publicationPosts[0].body.document_id === null && publicationPosts[0].body.update_document_id === null, "first publication explicitly preserves the absent formal binding");
  check(record.review_turns!.find(turn => turn.id === "proposal-late")?.proposal?.status === "accepted", "one confirmation accepts the inspected candidate before publishing");
  check(record.document!.sections[0].content.includes("最新修改") && record.document!.sections[0].revision === 4, "publication uses the reviewed new body");
  check(record.review_turns![1].proposal!.status === "pending", "unselected candidate remains available for later work");
  check(!calls.some(call => /\/archive(?:\/|$)/.test(call.path)), "平台发布后不准备归档、创建MR或查询归档；等待人点击归档");
  check(buttons().filter(button => button.textContent?.trim() === "归档").length === 1, "正式版本就绪后提供唯一归档入口");
  check(document.querySelector('[aria-label="组件文稿审查"]'), "publication stays on the review page");
  check(document.body.textContent?.includes(projections.adopted.status_label) && document.body.textContent?.includes(projections.adopted.review.sections[0].status_label), "backend 入库 status visible");
  check(!document.querySelector('a[href="https://example.test/mr/128"]'), "只完成平台发布时不展示虚构MR");
  check(!document.querySelector('[aria-label="组件能力目录"] input[type="checkbox"]'), "published content is read only");
  check(!openedDocument, "publication does not navigate away");
  check(!buttons().some(button => button.textContent?.trim() === "确认并发布"), "published task offers update instead of repeat publication");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "focused desktop workspace has no horizontal overflow");
  await click("查看知识"); check(openedDocument === "kd-published", "explicit view opens formal knowledge");
  check(!errors.length, errors.join("; "));
  return { passed: true };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
