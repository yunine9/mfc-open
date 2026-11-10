import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("交付改进报告：版本、失败重试、轮询生命周期、任务隔离与阈值保存", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-improvement-ui-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/deliveryImprovement.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = existsSync(assets) ? readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n") : "";
    const layers = readFileSync(resolve("web/src/tailwind.css"), "utf8").match(/^@layer [^;\n]+;/m)?.[0] ?? "";
    const html = '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + layers + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script></html>";
    const file = join(dir, "check.html"); writeFileSync(file, html);
    const preview = process.env.MFC_DELIVERY_IMPROVEMENT_PREVIEW;
    if (preview) { mkdirSync(preview, { recursive: true }); writeFileSync(join(preview, "delivery-improvement.html"), html); }
    for (const mode of ["controls", "full-sheet"]) {
      const output = join(dir, `${mode}.html`), screenshot = mode === "controls" ? "delivery-improvement.png" : "full-sheet.png";
      await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${mode}`)}`, "--window-size=1920,1080", "--virtual-time-budget=18000", ...(preview ? [`--screenshot=${resolve(preview, screenshot)}`] : []), "--dump-dom", `file://${file}${mode === "full-sheet" ? "?full=1&deliveryTask=task-full" : ""}`], output);
      const result = readFileSync(output, "utf8").match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${mode}: browser did not finish`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, value.error); assert.equal(value.passed, true); assert.equal(value.width, 1920);
      if (preview) assert.ok(existsSync(resolve(preview, screenshot)));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
