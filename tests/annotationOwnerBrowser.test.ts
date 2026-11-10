import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("批注真实浏览器：责任人答复、闭环、重开、统一转交状态与删除", {
  skip: !existsSync(chrome) && "需要 Chrome，设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-archify-browser-"));
  try {
    const result = await build({ entryPoints: [resolve("tests/browser/annotationOwnerFlow.tsx")], bundle: true, write: false,
      plugins: [{ name: "story-constant", setup(builder) {
        builder.onResolve({ filter: /overallStoryStore\.ts$/ }, () => ({ path: "story-constant", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const OVERALL_STORY_ARTIFACT = "task-materials/overall-story.md";' }));
      } }],
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' } });
    const path = join(dir, "test.html");
    // Load the production stylesheet, including Tailwind button styles, for visual evidence.
    const assets = resolve("web/dist/assets");
    if (process.env.MFC_ANNOTATION_SCREENSHOT) assert.ok(existsSync(assets), "截图前请运行 npm --prefix web run build");
    const css = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(join(assets, name), "utf8")).join("\n")
      : readFileSync(resolve("web/src/tailwind.css"), "utf8");
    writeFileSync(path, '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + css
      + '</style><style>body { padding:32px; } #app { max-width:880px; margin:auto; } #result { display:none; }</style><div class="workspace-studio task-workspace-v2"><div id="app" class="workspace-review-notes"></div></div><pre id="result"></pre><script>'
      + result.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script></html>");
    if (process.env.MFC_ANNOTATION_EVIDENCE) writeFileSync(process.env.MFC_ANNOTATION_EVIDENCE, readFileSync(path));
    const dump = join(dir, "dump.html");
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        ...(process.env.MFC_ANNOTATION_SCREENSHOT ? [`--screenshot=${process.env.MFC_ANNOTATION_SCREENSHOT}`, "--window-size=1100,850"] : []),
        `--user-data-dir=${join(dir, "chrome")}`, "--virtual-time-budget=10000", "--dump-dom", `file://${path}`], dump);
    const outcome = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(outcome, "浏览器未完成测试");
    assert.equal(outcome, "passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
