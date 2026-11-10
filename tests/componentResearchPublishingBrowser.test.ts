import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { componentGuideOverview, componentGuideSection } from "./fixtures/componentGuide.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function publishingFixtures() {
  const record = { id: "cr-publish", topic: "文件组件使用指南", language: "cpp", status: "done", stage: "待审查", operator: "dev", created_at: "2026-09-30T00:00:00Z", evidence: [],
    document: { overview: componentGuideOverview(), sections: ["打开与关闭", "异步读取"].map((title, index) => ({ ...componentGuideSection(`section-${index}`, ["file"], { title, component: index === 0 ? "file-open" : "file-read", content: "由调用方负责释放句柄。" }), selected: true, revision: 3 })) } } as unknown as ResearchRecord;
  record.review_turns = record.document!.sections.map((section, index) => ({ id: `proposal-${index}`, section_id: section.id, mode: "rework", message: "请明确资源释放顺序", operator: "dev", status: "done", created_at: record.created_at,
    proposal: { base_revision: index === 0 ? section.revision : section.revision - 1, status: "pending", section: { ...section, content: `${section.content}\n\n最新修改：先取消回调，再释放句柄。` } } }));
  const initial = projectKnowledgeProduction({ kind: "component", record });
  record.document!.sections.forEach(section => { section.selected = false; });
  const none = projectKnowledgeProduction({ kind: "component", record });
  record.document!.sections[0].selected = true;
  const selected = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns.push({ ...structuredClone(record.review_turns[0]), id: "proposal-late" });
  const late = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns[2].status = "failed";
  const failed = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns[2].status = "done";
  record.document!.sections[0].revision = 4;
  record.review_turns[0].proposal!.status = "discarded";
  record.review_turns[2].proposal!.status = "accepted";
  const accepted = projectKnowledgeProduction({ kind: "component", record });
  record.document_id = "kd-published";
  const adopted = projectKnowledgeProduction({ kind: "component", record });
  return { projections: { initial, none, selected, late, failed, accepted, adopted } };
}
test("生产线验收8、10、14：组件候选乐观校验后一次请求确认并入库，归档等人点击", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-publishing-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/componentResearchPublishing.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>window.__COMPONENT_PUBLISHING_FIXTURES__=' + JSON.stringify(publishingFixtures()).replaceAll("</script", "<\\/script") + ';</script><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dump = join(dir, `${width}.html`);
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=12000", "--dump-dom", `file://${html}`], dump);
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
