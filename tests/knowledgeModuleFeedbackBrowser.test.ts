import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("知识检视：正式快照新建任务、未合入文稿沿原任务检视、Skill 文件意见隔离与处理", { skip: !existsSync(chrome) && "需要 Chrome", timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-module-feedback-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeModuleFeedback.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(dir, `${width}.html`);
      await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", `file://${html}`], output);
      const result = readFileSync(output, "utf8").match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
      assert.equal(value.inspectionTasks, 2); assert.equal(value.domainSubmissions, 1); assert.equal(value.publishedWrites, 0);
      assert.equal(value.skillNotes, 2); assert.equal(value.agentRequests, 4);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
