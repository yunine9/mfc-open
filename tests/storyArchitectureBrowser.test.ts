import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { renderArchify } from "../src/archifyRender.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("架构视图真实浏览器：迟到旧图不能覆盖新版，读取失败卸载旧图，空态可回 Story", {
  skip: !existsSync(chrome) && "需要 Chrome，设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-archify-browser-"));
  try {
    const html: string[] = [];
    for (const title of ["旧版订单模块", "新版订单模块"]) {
      const rendered = await renderArchify({ schema_version: 1, diagram_type: "architecture", meta: { title, locale: "zh-CN" },
        components: [{ id: "sync", type: "backend", label: title, pos: [40, 40], size: [180, 64] }], connections: [] });
      assert.equal(rendered.error, undefined); html.push(rendered.html!);
    }
    const result = await build({ entryPoints: [resolve("tests/browser/storyArchitecture.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"', ARCHIFY_HTML_ONE: JSON.stringify(html[0]), ARCHIFY_HTML_TWO: JSON.stringify(html[1]) } });
    const path = join(dir, "test.html");
    writeFileSync(path, '<!doctype html><meta charset="utf-8"><style>:root { --line:#e3e3ef; --surface:#fff; --surface-soft:#f7f7fc; --text:#292a40; --muted:#777b91; --accent:#6256df; --attention:#b87910; --z-modal:100; } body { margin:0; font:14px system-ui; color:var(--text); } #result, #jump-class { display:none; }</style><style>' + readFileSync(resolve("web/src/tailwind.css"), "utf8") + '</style><div id="app"></div><pre id="result"></pre><script>'
      + result.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    if (process.env.MFC_ARCHITECTURE_EVIDENCE) writeFileSync(process.env.MFC_ARCHITECTURE_EVIDENCE, readFileSync(path));
    const dump = join(dir, "dump.html");
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${join(dir, "chrome")}`, "--virtual-time-budget=10000", "--dump-dom", `file://${path}`], dump);
    const outcome = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(outcome, "浏览器未完成测试");
    assert.deepEqual(JSON.parse(outcome), { onlyArchify: true, missingTabsHidden: true, raceProtected: true, staleRemoved: true, failureReadable: true, emptyReadable: true, opened: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
