import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
test("说给 Agent 上传、重试、发送和历史下载，1920×1080 桌面布局", { timeout: 60000 }, async (t) => {
  // 两件环境件:构建产物(全量分片不建 web,只有 gate 建)与真 Chrome。
  // 缺件跳过——与容器真件/PG/JDK 缺环境跳过同款分层纪律。
  const assets = resolve("web/dist/assets");
  if (!existsSync(assets)) {
    return t.skip("缺 web 构建产物,真浏览器布局用例跳过(先 cd web && npm run build)");
  }
  const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome)) {
    return t.skip("宿主无 Chrome,真浏览器布局用例跳过(MFC_TEST_CHROME 可指定)");
  }
  const dir = mkdtempSync(join(tmpdir(), "mfc-attachment-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/taskAttachments.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const css = readdirSync(assets).filter(name => name.startsWith("index-") && name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = "/tmp/mfc-task-attachments-preview.html";
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + ' #result{display:none}</style><div class="tw-root" id="app"></div><pre id="result"></pre><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    const dom = await browserResultDump(chrome,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${dir}/profile`, "--window-size=1920,1080", "--virtual-time-budget=10000", "--screenshot=/tmp/mfc-task-attachments-1920.png", "--dump-dom", `file://${html}`], join(dir, "result.html"));
    const result = JSON.parse(dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] ?? '{}');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.passed, true);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
