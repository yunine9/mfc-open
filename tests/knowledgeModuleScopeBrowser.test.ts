import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("正式知识文档筛选：单文件与目录、多仓滚动、恢复、冲突、目录数据与模块隔离", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-scope-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeModuleScope.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html"), screenshots = process.env.MFC_SCOPE_SCREENSHOT_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    writeFileSync(html, `<!doctype html><html data-theme="light" data-density="comfortable"><meta charset="utf-8"><style>${css} #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`);
    for (const position of screenshots ? ["top", "bottom"] : ["top"]) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, position)}`, "--window-size=1920,1080", "--virtual-time-budget=15000", "--dump-dom",
        ...(screenshots ? [`--screenshot=${join(screenshots, `knowledge-scope-${position}-1920.png`)}`] : []), `file://${html}?position=${position}`], join(dir, `${position}.html`));
      const output = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(output, "浏览器未完成"); const result = JSON.parse(output);
      assert.equal(result.error, undefined, result.error); assert.equal(result.passed, true);
      assert.equal(result.width, 1920); assert.ok(result.height >= 900 && result.height <= 1080, "1920×1080 桌面窗口");
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
