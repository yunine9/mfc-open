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

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("桌面领域与组件任务支持重新萃取、取消、创建失败重试和切换新任务研究过程，无需重新填单或上传", {
  skip: !existsSync(chrome) && "需要真实 Chrome", timeout: 120_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-reextract-browser-"));
  try {
    const repository = { id: "source", name: "源码", repository: "https://example.test/source.git", branch: "release/1", path: "src", docs_path: "docs" };
    const domain: DomainKnowledgeJob = { id: "dkx-old", issue_no: "REQ-REEXTRACT", title: "文件知识", scope: "文件操作", operator: "alice", created_at: "2026-10-12T00:00:00Z",
      status: "failed", stage: "研究失败", revisions: {}, repositories: [repository], knowledge_target: { ...repository, id: "domain" },
      material_ids: ["material-old"], documents: [], turns: [], publications: [], evidence: [] };
    const domainNext: DomainKnowledgeJob = { ...domain, id: "dkx-new", reextract_of: domain.id, status: "queued", stage: "等待新研究" };
    const component: ResearchRecord = { id: "cr-old", language: "cpp", topic: "文件组件知识", operator: "alice", key: "fixture", status: "running",
      created_at: "2026-10-12T00:00:00Z", stage: "研究中", evidence: [], source_repositories: [{ ...repository, enabled: true, description: "", languages: ["cpp"] }],
      document: { overview: "", sections: [] } };
    const componentNext: ResearchRecord = { ...component, id: "cr-new", reextract_of: component.id, status: "queued", stage: "等待新研究" };
    for (const item of [domain, domainNext]) item.production = projectKnowledgeProduction({ kind: "domain", record: item });
    for (const item of [component, componentNext]) item.production = projectKnowledgeProduction({ kind: "component", record: item });
    const bundled = await build({ entryPoints: [resolve("tests/browser/knowledgeReextraction.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html"), fixture = { domain: { original: domain, next: domainNext }, component: { original: component, next: componentNext } };
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>window.__REEXTRACT__='
      + JSON.stringify(fixture).replaceAll("</script", "<\\/script") + ';</script><script>' + bundled.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    for (const kind of ["domain", "component"]) for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `${kind}-${width}`)}`,
        `--window-size=${width},${height}`, "--virtual-time-budget=12000", "--dump-dom", `file://${html}?kbPage=task&kbKind=${kind}&kbTask=${fixture[kind as keyof typeof fixture].original.id}`], join(dir, `${kind}-${width}.html`));
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${kind} ${width}: browser did not finish`); const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${kind} ${width}: ${value.error}`); assert.equal(value.passed, true); assert.equal(value.attempts, 2);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
