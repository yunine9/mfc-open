import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("桌面上传通用 Skill，目录与 CLI 二进制完整传递", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-general-skill-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/generalSkillImport.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, `<!doctype html><html data-theme="light" data-density="comfortable"><meta charset="utf-8"><style>${css} #result{display:none}</style><div id="app"></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`);
    const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, "chrome")}`, "--window-size=1920,1080", "--virtual-time-budget=15000", "--dump-dom",
      ...(process.env.MFC_GENERAL_SKILL_SCREENSHOT ? [`--screenshot=${process.env.MFC_GENERAL_SKILL_SCREENSHOT}`] : []), `file://${html}`], join(dir, "result.html"));
    const output = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
    assert.ok(output, "浏览器未完成断言"); const result = JSON.parse(output);
    assert.equal(result.error, undefined); assert.equal(result.passed, true); assert.equal(result.width, 1920);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
