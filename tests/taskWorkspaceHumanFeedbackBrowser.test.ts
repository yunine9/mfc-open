import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const scenario of ["pipeline", "build_fix", "readonly", "imported"] as const) {
  test(`任务验证人工反馈展示与处置：${scenario}`, {
    skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mfc-task-human-feedback-"));
    try {
      const built = await build({
        entryPoints: [resolve("tests/browser/taskWorkspaceHumanFeedback.tsx")],
        bundle: true, write: false, format: "iife", jsx: "automatic",
        loader: { ".css": "empty" },
        jsxImportSource: resolve("web/node_modules/react"),
        define: { "process.env.NODE_ENV": '"production"' },
      });
      const assets = resolve("web/dist/assets");
      const css = existsSync(assets) ? readdirSync(assets)
        .filter(file => file.endsWith(".css"))
        .map(file => readFileSync(join(assets, file), "utf8")).join("\n") : "";
      const html = join(dir, "check.html");
      writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css
        + ' #result{display:none}</style><div class="tw-root" id="app"></div><pre id="result"></pre><script>'
        + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        const dom = await browserResultDump(chrome, [
          "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
          `--user-data-dir=${join(dir, String(width))}`,
          `--window-size=${width},${height}`, "--virtual-time-budget=10000", "--dump-dom",
          `file://${html}?scenario=${scenario}`,
        ], join(dir, `${width}.html`));
        const raw = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
        assert.ok(raw, `${scenario}/${width}: browser did not finish`);
        const result = JSON.parse(raw);
        assert.equal(result.error, undefined, `${scenario}/${width}: ${result.error}`);
        assert.equal(result.passed, true);
        assert.equal(result.width, width);
      }
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
