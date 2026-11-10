import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
import { componentGuideSection } from "./fixtures/componentGuide.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("萃取任务优先读取当前详情，慢请求不堆叠，研究输出展开时才渲染", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-extraction-loading-"));
  try {
    const evidence = Array.from({ length: 60 }, (_, i) => ({ tool: "component_source", action: "read", path: `src/file-${i}.cpp`,
      preview: "FULL_OUTPUT\n".repeat(5000), result: { content: "FULL_OUTPUT\n".repeat(5000) }, status: "returned" }));
    const repository = { id: "source", name: "源码", repository: "https://example.test/source.git", branch: "main", path: "", docs_path: "docs" };
    const domain: DomainKnowledgeJob = { id: "dkx-loading", title: "文件操作知识", scope: "文件操作", operator: "alice", created_at: "2026-10-12T00:00:00Z",
      status: "done", stage: "等待审查", revisions: {}, repositories: [repository], knowledge_target: { ...repository, id: "domain" },
      material_ids: [], documents: [{ id: "files", title: "文件操作", target_id: "domain", path: "docs/files.md", layer: "domain", content: "# 文件操作\n保留全部文稿内容。",
        sources: "src/file.cpp", revision: 1, selected: true, base_content: null, base_revision: "", history: [] }], turns: [], publications: [], evidence };
    domain.documents[0].history = [{ revision: 0, content: "DEFERRED_HISTORY_BODY", sources: "", title: "文件操作", operator: "alice", at: domain.created_at }];
    domain.work_documents = [{ id: "plan", turn_id: "11111111-1111-4111-8111-111111111111", title: "研究规划", content: "DEFERRED_WORK_BODY" }];
    domain.production = projectKnowledgeProduction({ kind: "domain", record: domain });
    const component: ResearchRecord = { id: "cr-loading", language: "cpp", topic: "文件操作组件", operator: "alice", key: "fixture", status: "done",
      created_at: "2026-10-12T00:00:00Z", stage: "等待审查", evidence, source_repositories: [{ ...repository, enabled: true, description: "", languages: ["cpp"] }],
      document: { overview: "文件组件", sections: [{ ...componentGuideSection("files", [repository.id]), selected: true, revision: 1 }] } };
    component.document!.sections[0].title = "文件操作";
    component.section_history = [{ at: domain.created_at, operator: "alice", section: { ...component.document!.sections[0], content: "DEFERRED_HISTORY_BODY", revision: 0 } }];
    component.work_documents = [{ id: "plan", title: "研究规划", content: "DEFERRED_WORK_BODY", status_label: "已完成" }];
    component.production = projectKnowledgeProduction({ kind: "component", record: component });
    const bundled = await build({ entryPoints: [resolve("tests/browser/knowledgeExtractionLoading.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>window.__EXTRACTION_LOADING__='
      + JSON.stringify({ domain, component }).replaceAll("</script", "<\\/script") + ';</script><script>' + bundled.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    for (const kind of ["domain", "component"]) for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `${kind}-${width}`)}`,
        `--window-size=${width},${height}`, "--virtual-time-budget=16000", "--dump-dom", `file://${html}?kbPage=task&kbKind=${kind}&kbTask=${kind === "domain" ? domain.id : component.id}`], join(dir, `${kind}-${width}.html`));
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${kind} ${width}: browser did not finish`); const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${kind} ${width}: ${value.error}`); assert.equal(value.passed, true);
      assert.equal(value.maximumInFlight, 1); assert.equal(value.aborted, 1);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
