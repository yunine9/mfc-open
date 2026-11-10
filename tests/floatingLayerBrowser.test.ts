import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("公共浮层真实命中测试：全屏上可点击、弹窗内下拉可选", {
  skip: !existsSync(chrome) && "需要 Chrome，设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-floating-layer-"));
  try {
    const result = await build({ entryPoints: [resolve("tests/browser/floatingLayers.tsx")], bundle:true, write:false,
      tsconfig:resolve("web/tsconfig.json"), format:"iife", jsx:"automatic", jsxImportSource:resolve("web/node_modules/react"),
      define:{"process.env.NODE_ENV":'"production"'} });
    const assets = resolve("web/dist/assets");
    assert.ok(existsSync(assets), "先运行 npm --prefix web run build，必须使用真实构建样式");
    const css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets,name),"utf8")).join("\n");
    const path=join(dir,"test.html");
    writeFileSync(path, '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>'+css+'</style><div id="app"></div><pre id="result" style="display:none"></pre><script>'+result.outputFiles[0].text.replaceAll("</script","<\\/script")+'</script></html>');
    const output = await browserResultDump(chrome,["--headless=new","--disable-gpu","--no-first-run","--disable-extensions",`--user-data-dir=${join(dir,"profile")}`,"--window-size=1100,850","--virtual-time-budget=10000","--dump-dom",`file://${path}`],join(dir,"dump.html"));
    const actual = output.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
    const expected=["popover","select","menu","sheet","alert","nested"].map(kind=>`${kind}:passed`).join("\n");
    assert.equal(actual,expected);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
