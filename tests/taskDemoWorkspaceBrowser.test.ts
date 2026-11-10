import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
import { findJava, PLANTUML_JAR, renderPlantUml } from "../src/plantumlRender.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("演示副本真实工作台：主子任务、阶段材料、批注闭环、交付分析与知识效能隔离", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-demo-workspace-"));
  let server: ReturnType<typeof createServer> | undefined;
  const serverWrites: string[] = [];
  const diagramSources: string[] = [];
  const diagramErrors: string[] = [];
  try {
    assert.ok(findJava() && existsSync(PLANTUML_JAR), "需要 Java 与仓内 PlantUML 运行库验证真实出图");
    const built = await build({
      entryPoints: [resolve("tests/browser/taskDemoWorkspace.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "preview-raw-fixture", setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "raw-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "raw-fixture" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
      } }],
    });
    const assets = resolve("web/dist/assets");
    const css = existsSync(assets) ? readdirSync(assets).filter(file => file.endsWith(".css"))
      .map(file => readFileSync(join(assets, file), "utf8")).join("\n") : "";
    const layerOrder = readFileSync(resolve("web/src/tailwind.css"), "utf8").match(/^@layer [^;\n]+;/m)?.[0];
    assert.ok(layerOrder, "production stylesheet has no declared layer order");
    const html = '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + layerOrder + css
      + readFileSync(resolve("web/src/TaskDemo.css"), "utf8")
      + '</style><style>#result{display:none}</style><div class="tw-root" id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script></html>";
    writeFileSync(join(dir, "check.html"), html);
    // The sandbox checks origin, so use an ephemeral local HTTP page rather than file://.
    server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/diagrams/plantuml") {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const { source } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          diagramSources.push(source);
          const rendered = await renderPlantUml(source, { cacheDir: join(dir, "diagram-cache") });
          if (rendered.error || rendered.syntax_error) diagramErrors.push(rendered.error ?? "PlantUML syntax error");
          response.setHeader("content-type", "application/json"); response.end(JSON.stringify(rendered));
        } catch (error) { diagramErrors.push(String(error)); response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
        return;
      }
      if (!["GET", "HEAD"].includes(request.method ?? "GET")) serverWrites.push(`${request.method} ${request.url}`);
      if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); }
      else { response.statusCode = 404; response.end("Preview fixture has no network API."); }
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const dom = await browserResultDump(chrome, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
      `--user-data-dir=${join(dir, "chrome")}`, "--window-size=1920,1080",
      "--virtual-time-budget=18000", "--dump-dom", `http://127.0.0.1:${address.port}/`,
    ], join(dir, "result.html"));
    const raw = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
    assert.ok(raw, "browser did not finish the demo workflow");
    const result = JSON.parse(raw);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.equal(result.historicalCards, true);
    assert.equal(result.historicalRoundFocus, true);
    assert.equal(result.comparisonReportFocus, true);
    assert.equal(result.codingUsesActualFinalReview, true);
    assert.equal(result.plantUmlRendered, true);
    assert.equal(result.diagramRequests, 1);
    assert.equal(diagramSources.length, 1);
    assert.match(diagramSources[0], /^@startuml\n/);
    assert.match(diagramSources[0], /\nOrder -> Stock: 释放库存（新增）\nStock --> Order: 幂等结果\n@enduml$/);
    assert.deepEqual(diagramErrors, []);
    assert.equal(result.phases, 7);
    assert.equal(result.parentChildRoundTrip, true);
    assert.equal(result.navigationRetry, true);
    assert.equal(result.materialAlwaysVisible, true);
    assert.equal(result.directDocumentAnnotations, true);
    assert.equal(result.knowledgeAnalytics, true);
    assert.equal(result.productionFrame, true);
    assert.ok(result.localWrites >= 3);
    assert.equal(result.memoryDecisions, 2);
    assert.equal(result.sourceWrites, 0);
    assert.equal(result.realRequests, 0);
    assert.deepEqual(serverWrites, []);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
