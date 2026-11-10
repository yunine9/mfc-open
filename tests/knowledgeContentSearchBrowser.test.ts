import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("正文查找：中文与行内匹配、上下项、文件切换、键盘快捷键及清理高亮", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-content-search-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeContentSearch.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const html = join(dir, "check.html"), output = join(dir, "dom.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="app"></div><pre id="result"></pre><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, "profile")}`, "--window-size=1366,768", "--virtual-time-budget=6000", "--dump-dom", `file://${html}`], output);
    const result = readFileSync(output, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "browser did not finish"); const value = JSON.parse(result); assert.equal(value.error, undefined); assert.equal(value.passed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
