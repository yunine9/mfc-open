import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("桌面任务关联最终 MR 并在交付分析中查看初版之后的代码变化", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "final-mr-ui-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/finalMrDelivery.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = existsSync(assets) ? readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n") : "";
    const layers = readFileSync(resolve("web/src/tailwind.css"), "utf8").match(/^@layer [^;\n]+;/m)?.[0] ?? "";
    const page = join(dir, "page.html");
    writeFileSync(page, '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + layers + css + '</style><div id="app"></div><pre id="result" hidden></pre><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script></html>");
    const preview = process.env.MFC_FINAL_MR_PREVIEW;
    if (preview) mkdirSync(preview, { recursive: true });
    for (const scenario of ["task", "no-initial-link", "no-initial-merged", "tracking", "closed", "verifying", "completed", "different-target", "unknown-target", "analysis", "final-only-analysis", "platform-push", "local-snapshot", "origin-team", "origin-detail", "origin-count-only"]) {
      const query = new URLSearchParams({ scenario });
      if (["analysis", "final-only-analysis", "platform-push", "local-snapshot"].includes(scenario)) query.set("deliveryTask", "task-orders");
      if (scenario === "origin-detail") query.set("deliveryTask", "task-money");
      if (scenario === "origin-count-only") query.set("deliveryTask", "task-timeout");
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, scenario)}`,
        "--window-size=1920,1080", "--virtual-time-budget=18000", ...(preview ? [`--screenshot=${resolve(preview, scenario + ".png")}`] : []),
        "--dump-dom", `file://${page}?${query}`], join(dir, scenario + ".html"));
      const raw = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(raw, scenario + " 浏览器没有完成验证");
      const result = JSON.parse(raw); assert.equal(result.error, undefined, result.error); assert.equal(result.passed, true); assert.equal(result.width, 1920);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
