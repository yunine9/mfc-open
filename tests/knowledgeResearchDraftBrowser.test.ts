import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const scenario of ["description", "return", "reuse", "history", "method", "cleanup", "component-methods", "component-start"] as const) {
  test(`研究表单保留输入：${scenario}`, { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-research-draft-"));
    try {
      const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeResearchDraft.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
      const assets = resolve("web/dist/assets"), css = existsSync(assets) ? readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n") : "";
      const html = join(root, "check.html");
      writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>window.__KEEP_RESEARCH_PREVIEW__=${!!process.env.MFC_RESEARCH_SCREENSHOT_DIR};</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        const module = scenario.startsWith("component") ? "engineering%3Acpp" : "business%3Atrade";
        const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(root, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=10000", "--dump-dom", ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `research-${scenario}-${width}.png`)}`] : []), `file://${html}?kbPage=research&kbModule=${module}&scenario=${scenario}`], join(root, `${width}.html`));
        const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
        assert.ok(result, `${width}: browser did not finish`);
        const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
      }
    } finally { stop(); rmSync(root, { recursive: true, force: true }); }
  });
}
