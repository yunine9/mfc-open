import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("登录状态：连接故障恢复、按小时续期、明确撤销和旧响应隔离", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "mfc-auth-session-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/authFrontendSession.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = existsSync(assets) ? readdirSync(assets).filter(file => file.endsWith(".css"))
      .map(file => readFileSync(join(assets, file), "utf8")).join("\n") : "";
    const html = join(directory, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result"></pre><script>'
      + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    const modes = process.env.MFC_AUTH_SESSION_MODES?.split(",") ?? ["startup-503-auto", "startup-503-manual", "startup-network-auto", "startup-timeout-auto", "startup-401",
      "poll-503", "poll-network", "poll-401", "stale-401", "exit-aborts-check", "stale-tasks", "hourly-renewal", "visible-renewal", "visible-401"];
    for (const mode of modes) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${join(directory, mode)}`, "--window-size=1920,1080", "--virtual-time-budget=18000", "--dump-dom",
        `file://${html}?mode=${mode}`], join(directory, `${mode}.html`));
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${mode}: 浏览器未完成`);
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${mode}: ${value.error}`);
      assert.equal(value.passed, true, JSON.stringify(value));
      console.log(JSON.stringify(value));
    }
  } finally { stop(); rmSync(directory, { recursive: true, force: true }); }
});
