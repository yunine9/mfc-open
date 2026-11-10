import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
import { componentGuideOverview, componentGuideSection } from "./fixtures/componentGuide.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function reviewProductionFixtures() {
  const record = { id: "cr-browser", topic: "基础组件联合使用指南", status: "done", stage: "草稿待审查", language: "cpp", operator: "专家", created_at: "2026-09-21T08:00:00Z", evidence: [], review_turns: [],
    document: { overview: componentGuideOverview(), sections: ["安全打开与关闭", "异步读取与取消", "批量写入与错误恢复", ...Array.from({ length: 32 }, (_, i) => `组件能力 ${i + 4}：资源管理与错误恢复`)].map((title, i) => ({ ...componentGuideSection(`cap-${i}`, i === 1 ? ["repo-0", "repo-1"] : ["repo-0"], { title }), revision: 1, selected: true, related_ids: i === 1 ? ["cap-0"] : [] })) } } as unknown as ResearchRecord;
  for (const kind of ["contracts", "pitfalls", "index"] as const) {
    const section = componentGuideSection(`research-${kind}`, ["repo-0"], { title: `研究材料-${kind}`, component: "research" });
    record.document!.sections.push({ ...section, revision: 1, selected: true, content: `仅研究材料-${kind}`, interfaces: "", integration: "", example: "", unit_tests: "", paradigm: { ...section.paradigm!, kind } });
  }
  const initial = projectKnowledgeProduction({ kind: "component", record });
  record.document!.sections.forEach(section => { section.selected = false; });
  const none = projectKnowledgeProduction({ kind: "component", record });
  record.document!.sections.forEach(section => { section.selected = true; });
  record.document!.sections[2].selected = false;
  const excluded = projectKnowledgeProduction({ kind: "component", record });
  const section = record.document!.sections[1];
  record.review_turns!.push({ id: "turn-4", section_id: section.id, mode: "discuss", message: "为什么取消后仍需要等待回调？", operator: "专家", status: "done", created_at: record.created_at });
  const discussed = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns!.push({ id: "turn-5", section_id: section.id, mode: "rework", message: "请补充取消后的资源释放顺序", operator: "专家", status: "done", created_at: record.created_at, proposal: { status: "pending", base_revision: 1, section: { ...section, revision: 2 } } });
  const proposed = projectKnowledgeProduction({ kind: "component", record });
  section.revision = 2; record.review_turns![1].proposal!.status = "accepted";
  const accepted = projectKnowledgeProduction({ kind: "component", record });
  return { initial, none, excluded, discussed, proposed, accepted };
}
test("生产线验收8：桌面审核使用后端投影，默认全选、单项排除、专家对话和局部返工、单篇完整预览", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(),"mfc-component-review-"));
  try {
    const built = await build({entryPoints:[resolve("tests/browser/componentResearchReview.tsx")],bundle:true,write:false,
      format:"iife",jsx:"automatic",loader:{".css":"empty"},jsxImportSource:resolve("web/node_modules/react"),
      define:{"process.env.NODE_ENV":'"production"'}});
    const assets = resolve("web/dist/assets");
    assert.ok(existsSync(assets),"请先构建 web，以真实桌面样式验证布局");
    const css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets,name),"utf8")).join("\n");
    const html = join(dir,"check.html");
    writeFileSync(html,'<!doctype html><meta charset="utf-8"><style>'+css+'</style><div id="app" style="padding:24px"></div><pre id="result"></pre><script>window.__COMPONENT_REVIEW_PRODUCTIONS__='
      +JSON.stringify(reviewProductionFixtures()).replaceAll("</script","<\\/script")+';</script><script>'
      +built.outputFiles[0].text.replaceAll("</script","<\\/script")+"</script>");
    for (const [width,height] of [[1920,1080],[1366,768]]) {
      const dump = join(dir,`${width}.html`);
      await browserResultDump(chrome, ["--headless=new","--disable-gpu","--no-first-run","--disable-extensions",`--user-data-dir=${join(dir,String(width))}`,
          `--window-size=${width},${height}`,"--virtual-time-budget=7000","--dump-dom",
          ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR,`research-${width}.png`)}`] : []),
          `file://${html}?kbPage=task&kbKind=component&kbTask=cr-browser`], dump);
      const output = readFileSync(dump,"utf8");
      if (process.env.MFC_RESEARCH_SCREENSHOT_DIR) writeFileSync(join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `research-${width}.html`), output);
      const result = output.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result,`${width}: browser did not finish`);
      const value = JSON.parse(result);assert.equal(value.error,undefined,`${width}: ${value.error}`);assert.equal(value.passed,true);
    }
  } finally {stop();rmSync(dir,{recursive:true,force:true});}
});
