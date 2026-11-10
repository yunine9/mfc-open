import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { knowledgeLibraryProductionFixtures } from "./fixtures/knowledgeLibraryProduction.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("生产线验收8：知识库桌面使用后端投影，模块深链接、任务进度、变化文稿批量发布、研究归属和 Skill 整包导入", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-library-browser-"));
  try {
    const fixture = await knowledgeLibraryProductionFixtures();
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeLibrary.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n");
    const html = join(root, "check.html");
    // 知识库样式已并回 tailwind.css,随 web/dist 构建产物一起加载,不再单独读取源样式文件。
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result { display: none; }</style><aside style="position:fixed;width:180px;padding:24px">MAEFlow Cloud<br><br><strong>知识库</strong></aside><div style="margin-left:180px"><div id="app"></div></div><pre id="result"></pre><script>window.__KNOWLEDGE_LIBRARY_FIXTURES__=${JSON.stringify(fixture).replaceAll("</script", "<\\/script")};</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(root, `${width}.html`);
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(root, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `knowledge-library-${width}.png`)}`] : []), `file://${html}?kbPage=module&kbModule=business%3Atrade&knowledgeDocument=${fixture.job.documents[2].knowledge_document_id}`], output);
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { stop(); rmSync(root, { recursive: true, force: true }); }
});
