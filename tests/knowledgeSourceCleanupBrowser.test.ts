import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const scenario of ["preview", "created", "partial", "start", "return", "module"]) test(`萃取前清理桌面走查：${scenario}`, { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeSourceCleanup.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html"), screenshots = process.env.MFC_CLEANUP_SCREENSHOT_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>window.__KEEP_CLEANUP_PREVIEW__=${!!screenshots};</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=10000", "--dump-dom",
        ...(screenshots ? [`--screenshot=${join(screenshots, `cleanup-${scenario}-${width}.png`)}`] : []), `file://${html}?scenario=${scenario}`], join(dir, `${width}.html`));
      const output = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(output, `${width} 浏览器未完成`); const result = JSON.parse(output);
      assert.equal(result.error, undefined, `${width}: ${result.error}`); assert.equal(result.passed, true);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
