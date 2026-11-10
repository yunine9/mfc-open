import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("工作台后台轮询保留文档、图表和差异正文，真实改动仍更新", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-workspace-refresh-"));
  try {
    const built = await build({
      entryPoints: [resolve("tests/browser/workspaceRefresh.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const mode of ["doc", "diff"]) {
      const dump = join(dir, `${mode}.html`);
      
      await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
          "--disable-extensions", `--user-data-dir=${join(dir, mode)}`,
          "--window-size=1920,1080", "--virtual-time-budget=6000", "--dump-dom",
          `file://${html}?mode=${mode}`], dump);
      const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${mode}: browser did not finish`);
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${mode}: ${value.error}`);
      assert.equal(value.stable, true);
      assert.equal(value.updated, true);
      if (mode === "doc") {
        assert.equal(value.storyFullscreen, true);
        assert.equal(value.documentBeforeGit, true);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("任务深链与状态刷新不等待 2.5 秒的旁栏接口", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-entry-"));
  try {
    const built = await build({
      entryPoints: [resolve("tests/browser/taskEntry.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const html = join(dir, "check.html"), dump = join(dir, "result.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${join(dir, "chrome")}`, "--window-size=1920,1080", "--virtual-time-budget=5000",
        "--dump-dom", `file://${html}?task=entry`], dump);
    const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "browser did not finish");
    const value = JSON.parse(result);
    assert.equal(value.error, undefined, value.error);
    assert.equal(value.taskBeforeSidebars, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
