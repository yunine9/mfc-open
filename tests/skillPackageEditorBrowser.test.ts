import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("Skill 详情的编辑与替换入口：文件保留、冲突草稿、二进制上传和保存刷新", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-package-editor-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/skillPackageEditor.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html"), screenshots = process.env.MFC_SKILL_EDITOR_SCREENSHOT_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    writeFileSync(html, `<!doctype html><html data-theme="light" data-density="comfortable"><meta charset="utf-8"><style>${css} #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`);
    for (const mode of ["edit", "replace"]) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, mode)}`, "--window-size=1920,1080", "--virtual-time-budget=15000", "--dump-dom",
        ...(screenshots ? [`--screenshot=${join(screenshots, `${mode}.png`)}`] : []), `file://${html}?mode=${mode}`], join(dir, `${mode}.html`));
      const output = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(output, `${mode}: 浏览器未完成断言`); const result = JSON.parse(output);
      assert.equal(result.error, undefined, `${mode}: ${result.error}`); assert.equal(result.passed, true); assert.equal(result.width, 1920);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
