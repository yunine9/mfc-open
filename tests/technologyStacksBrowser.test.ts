import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("技术栈桌面配置：增改、停用启用、删除、搜索和选择器实时同步", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "mfc-technology-stacks-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/technologyStacks.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = readdirSync(assets).filter(file => file.endsWith(".css"))
      .map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(directory, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css
      + ' #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>'
      + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    const screenshot = process.env.MFC_TECHNOLOGY_SCREENSHOT;
    const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
      `--user-data-dir=${join(directory, "profile")}`, "--window-size=1920,1080", "--virtual-time-budget=12000", "--dump-dom",
      ...(screenshot ? [`--screenshot=${resolve(screenshot)}`] : []), `file://${html}?tab=technologies`], join(directory, "result.html"));
    const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "桌面浏览器未完成技术栈配置验证");
    const value = JSON.parse(result);
    assert.equal(value.error, undefined, value.error);
    assert.deepEqual(value, { passed: true, stableId: true, liveOptions: true, saveError: true, deletion: true, width: 1920 });
  } finally { stop(); rmSync(directory, { recursive: true, force: true }); }
});
