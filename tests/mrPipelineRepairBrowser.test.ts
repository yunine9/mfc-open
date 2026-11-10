import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("流水线修复桌面界面：独立记录与接口、导入错误恢复和复用工作台", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-repair-ui-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/pipelineRepair.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script></html>";
    const file = join(dir, "check.html"); writeFileSync(file, html);
    const preview = process.env.MFC_PIPELINE_REPAIR_PREVIEW;
    if (preview) { mkdirSync(preview, { recursive: true }); writeFileSync(join(preview, "pipeline-repair-ui.html"), html); }
    for (const mode of ["import", "workbench"]) {
      const screenshot = preview ? [`--screenshot=${resolve(preview, `pipeline-repair-${mode}.png`)}`] : [];
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${join(dir, mode)}`, "--window-size=1920,1080", "--virtual-time-budget=18000", ...screenshot, "--dump-dom", `file://${file}?${mode}`], join(dir, `${mode}.html`));
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1]; assert.ok(result, `${mode} 浏览器未完成`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, value.error); assert.equal(value.passed, true); assert.equal(value.width, 1920);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
