import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("单单元桌面确认：提交继续开发、无自身子任务、交付后可继续修改", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-single-delivery-browser-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/requirementSingleDelivery.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' } });
    const css = readdirSync("web/dist/assets").filter(p => p.endsWith(".css")).map(p => readFileSync(join("web/dist/assets", p), "utf8")).join("\n");
    const html = join(dir, "check.html"), dump = join(dir, "result.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
      `--user-data-dir=${join(dir, "profile")}`, "--window-size=1920,1080", "--virtual-time-budget=12000", "--dump-dom", `file://${html}`], dump);
    const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "桌面浏览器未完成验证");
    assert.deepEqual(JSON.parse(result), { confirmation: true, mainTaskDelivery: true, noSelfChild: true, continueDelivery: true, width: 1920 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
