import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("真实浏览器：工作过程、合并日志、终态弹窗回放、同号事件与阅读位置", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-buildfix-browser-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/buildFixProgress.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const css = readdirSync("web/dist/assets").filter((p) => p.endsWith(".css"))
      .map((p) => readFileSync(join("web/dist/assets", p), "utf8")).join("\n");
    const html = join(dir, "check.html"), dump = join(dir, "result.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css
      + '</style><div id="app" style="max-width:1200px;margin:30px auto"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${join(dir, "chrome")}`, "--window-size=1920,1080",
        "--screenshot=/tmp/build-fix-progress.png", "--virtual-time-budget=6000", "--dump-dom", `file://${html}`], dump);
    const raw = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(raw, "browser did not finish");
    const result = JSON.parse(raw);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.passed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
