import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("模块迁移桌面入口：预览范围、取消、失败重试、迁移后隐藏旧模块", { skip: !existsSync(chrome) && "需要真实 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-module-migration-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/businessModuleMigration.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + ' #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>'
      + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    for (const mode of ["preview", "complete"]) {
      const screenshot = process.env.MFC_MODULE_SCREENSHOT_DIR;
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, mode)}`,
        "--window-size=1920,1080", "--virtual-time-budget=10000", "--dump-dom", ...(screenshot ? [`--screenshot=${join(screenshot, `module-migration-${mode}.png`)}`] : []),
        `file://${html}?tab=modules${mode === "preview" ? "&preview=1" : ""}`], join(dir, `${mode}.html`));
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1]; assert.ok(result, "浏览器未完成迁移验证");
      const value = JSON.parse(result); assert.equal(value.error, undefined, value.error);
      assert.deepEqual(value, { passed: true, width: 1920, mode });
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
