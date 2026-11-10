import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeSkillTask } from "../../web/src/KnowledgeSkillTask";
import { ComponentKnowledgeDelete } from "../../web/src/ComponentKnowledgeDelete";
import { ComponentResearch } from "../../web/src/ComponentResearch";

// 截图内容由 Node 端真实状态投影提供；浏览器只接收 HTTP 契约。
const fixture = JSON.parse(document.getElementById("visual-fixture")!.textContent!);
window.fetch = async input => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://fixture.test").pathname;
  if (fixture.kind === "component-research") {
    let response: unknown;
    if (path === "/component-research") response = { records: [fixture.response] };
    else if (path === "/component-repositories") response = { components: fixture.response.components ?? [fixture.response.component] };
    else if (path === "/business-modules") response = { modules: [] };
    else if (path === `/component-research/${fixture.id}/reader`) response = fixture.response;
    else if (path === `/component-research/${fixture.id}/archive/preview`) response = fixture.archive_preview;
    else if (path.startsWith("/knowledge-review/component/")) response = { notes: [] };
    else throw new Error(`未配置的组件截图请求：${path}`);
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  }
  if (path.startsWith("/skills/") || path.startsWith("/knowledge/skill-extract/") || path === "/component-knowledge/documents") return new Response(JSON.stringify(fixture.response), { headers: { "content-type": "application/json" } });
  throw new Error(`未配置的截图请求：${path}`);
};
createRoot(document.getElementById("visual-app")!).render(fixture.kind === "component-deletion"
  ? <ComponentKnowledgeDelete open onClose={() => {}} onChanged={() => {}} />
  : fixture.kind === "component-research"
    ? <div className="knowledge-hub is-focused" style={{ height: "100%" }}><div className="knowledge-hub-task" style={{ height: "100%" }}><ComponentResearch open focused focusId={fixture.id} surface="knowledge" onClose={() => {}} onAdopt={() => {}} /></div></div>
    : <KnowledgeSkillTask kind={fixture.kind} id={fixture.id} onBack={() => {}} onSubmitted={() => {}} />);
if (fixture.kind === "component-research") {
  const deadline = Date.now() + 1_000;
  const timer = setInterval(() => {
    if (Date.now() >= deadline) { clearInterval(timer); return; }
    const button = fixture.interaction === "publication-settings"
      ? [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "发布设置")
      : [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "归档");
    if (button) { button.click(); clearInterval(timer); }
  }, 25);
}
if (fixture.kind === "component-deletion") {
  const deadline = Date.now() + 1_000;
  let selected = false;
  const timer = setInterval(() => {
    if (Date.now() >= deadline) { clearInterval(timer); return; }
    const all = document.querySelector<HTMLInputElement>('[aria-label="全选组件知识"]');
    if (all && !selected) { all.click(); selected = true; return; }
    const button = [...document.querySelectorAll("button")].find(item => item.textContent === "删除所选（1）");
    if (button && selected) { button.click(); clearInterval(timer); }
  }, 50);
}
