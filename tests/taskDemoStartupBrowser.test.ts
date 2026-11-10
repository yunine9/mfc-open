import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("正式演示切换定位最新真实卡与同轮回复；当前卡、归档历史和会话边界不依赖模型", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-demo-startup-"));
  let server: ReturnType<typeof createServer> | undefined;
  const unexpectedRequests: string[] = [];
  try {
    const built = await build({
      entryPoints: [resolve("tests/browser/taskDemoStartup.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "demo-startup-raw-fixture", setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "raw-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "raw-fixture" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
      } }],
    });
    const assets = resolve("web/dist/assets");
    const assetFiles = new Set(existsSync(assets) ? readdirSync(assets) : []);
    const css = [...assetFiles].filter(file => file.endsWith(".css"))
      .map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const layerOrder = readFileSync(resolve("web/src/tailwind.css"), "utf8").match(/^@layer [^;\n]+;/m)?.[0];
    assert.ok(layerOrder, "production stylesheet has no declared layer order");
    const html = '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + layerOrder + css
      + readFileSync(resolve("web/src/TaskDemo.css"), "utf8")
      + '</style><style>#result{display:none}</style><div class="tw-root" id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script></html>";
    server = createServer((request, response) => {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html);
      } else if (request.method === "GET" && request.url?.startsWith("/assets/") && assetFiles.has(request.url.slice(8))) {
        response.end(readFileSync(join(assets, request.url.slice(8))));
      } else {
        if (request.url !== "/favicon.ico") unexpectedRequests.push(`${request.method} ${request.url}`);
        response.statusCode = 404; response.end("No production transport is available in this fixture.");
      }
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const dom = await browserResultDump(chrome, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
      `--user-data-dir=${join(dir, "chrome")}`, "--window-size=1920,1080",
      "--virtual-time-budget=12000", "--dump-dom", `http://127.0.0.1:${address.port}/`,
    ], join(dir, "result.html"));
    const raw = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
    assert.ok(raw, "browser did not finish the formal demo startup and task navigation");
    const result = JSON.parse(raw);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.equal(result.formalEntry, true);
    assert.equal(result.phases, 7);
    assert.equal(result.parentChildRoundTrip, true);
    assert.equal(result.currentCardOverridesOlderHistory, true);
    assert.equal(result.latestHistoricalRoundFocused, true);
    assert.equal(result.currentCardWithoutHistoryFocused, true);
    assert.equal(result.previousSessionReplyNotBorrowed, true);
    assert.equal(result.generationRequests, 0);
    assert.equal(result.sourceWrites, 0);
    assert.equal(result.snapshotReads, 4);
    assert.deepEqual(unexpectedRequests, []);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
