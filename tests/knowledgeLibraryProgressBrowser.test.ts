import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("#517 桌面模块数量、最新任务跳转、治理排序和归档主子关系", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-library-progress-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeLibraryProgress.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const scene of ["home", "archive-pg", "archive-local"]) for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(dir, `${scene}-${width}.html`), screenshots = process.env.MFC_UI_SCREENSHOT_DIR;
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `${scene}-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", ...(screenshots ? [`--screenshot=${join(screenshots, `issue-517-${scene}-${width}.png`)}`] : []), `file://${html}?scene=${scene}`], output);
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${scene} ${width}: 浏览器未输出结果`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${scene} ${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
