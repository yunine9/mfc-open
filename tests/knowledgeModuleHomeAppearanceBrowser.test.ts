import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("知识库首页桌面外观：多模块与技术栈、路径隐藏、搜索分类和打开入口", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-home-appearance-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeModuleHomeAppearance.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html"), screenshots = process.env.MFC_HOME_SCREENSHOT_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    writeFileSync(html, `<!doctype html><html data-theme="light" data-density="comfortable"><meta charset="utf-8"><style>${css} #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>document.documentElement.dataset.theme=new URLSearchParams(location.search).get("theme")||"light";</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`);
    const cases = [{ width: 1920, height: 1080, theme: "light", category: "all" }, { width: 1366, height: 768, theme: "light", category: "all" },
      ...(screenshots ? [{ width: 1920, height: 1080, theme: "light", category: "engineering" }, { width: 1366, height: 768, theme: "light", category: "engineering" }, { width: 1920, height: 1080, theme: "dark", category: "all" }] : [])];
    for (const { width, height, theme, category } of cases) {
      const name = `knowledge-home-${category}-${width}-${theme}`;
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, name)}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom",
        ...(screenshots ? [`--screenshot=${join(screenshots, `${name}.png`)}`] : []), `file://${html}?category=${category}&theme=${theme}`], join(dir, `${name}.html`));
      const output = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(output, `${name}: 浏览器未完成`); const result = JSON.parse(output);
      assert.equal(result.error, undefined, `${name}: ${result.error}`); assert.equal(result.passed, true);
      assert.equal(result.width, width); assert.equal(result.cards, category === "engineering" ? 4 : 12);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
