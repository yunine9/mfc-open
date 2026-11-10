import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { knowledgeManualArchiveFixtures } from "./fixtures/knowledgeManualArchiveFixture.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
async function within<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function archiveBrowserContract(scenario: "manual" | "switch" | "unpublished" | "paths" | "issue" = "manual") {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-manual-archive-browser-"));
  let lastOutput = "";
  try {
    const fixture = await knowledgeManualArchiveFixtures();
    const sourceRoot = process.env.MFC_KNOWLEDGE_WEB_SOURCE_ROOT;
    const bundled = await within(build({ entryPoints: [resolve("tests/browser/knowledgeProductionComponentArchiveActions.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' },
      plugins: sourceRoot ? [{ name: "frozen-knowledge-ui", setup(builder) {
        builder.onResolve({ filter: /^\.\.\/\.\.\/web\/src\// }, args => ({ path: join(sourceRoot, "web/src", `${args.path.split("/").at(-1)}.tsx`) }));
      } }] : [],
    }), 5_000, "手动归档浏览器构建超过5秒预算");
    const assets = resolve("web/dist/assets"), css = fs.readdirSync(assets).filter(name => name.endsWith(".css")).map(name => fs.readFileSync(join(assets, name), "utf8")).join("\n");
    const html = join(dir, "check.html");
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="app" style="padding:24px"></div><pre id="result"></pre><pre id="phase" style="display:none">before bundle</pre><script>window.addEventListener("error",event=>{document.getElementById("phase").textContent="script error: "+event.message});</script><script id="fixture" type="application/json">${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script><script>${bundled.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(dir, `dom-${width}.html`); lastOutput = output;
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--force-device-scale-factor=1", `--user-data-dir=${join(dir, `profile-${width}`)}`,
        `--window-size=${width},${height}`, `--virtual-time-budget=${scenario === "manual" ? 700000 : 12000}`, "--timeout=15000", "--dump-dom", `file://${html}${scenario === "issue" ? "?domainIssueInput=1" : scenario === "paths" ? "?componentPaths=1" : scenario === "switch" ? "?endpointSwitch=1" : scenario === "unpublished" ? "?unpublishedArchive=1" : ""}`], output);
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1]; assert.ok(result, `${width}: 浏览器没有结果`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true); assert.equal(value.width, width);
    }
  } catch (error) {
    const evidence = fs.mkdtempSync(join(tmpdir(), "knowledge-archive-browser-evidence-"));
    for (const file of fs.readdirSync(dir).filter(file => file.endsWith(".html"))) fs.copyFileSync(join(dir, file), join(evidence, file));
    const phase = lastOutput && fs.existsSync(lastOutput) ? fs.readFileSync(lastOutput, "utf8").match(/<pre[^>]*id="phase"[^>]*>([^<]*)<\/pre>/)?.[1] : "no DOM";
    throw new Error(`${error instanceof Error ? error.message : String(error)}；阶段=${phase ?? "unknown"}；失败HTML=${evidence}`, { cause: error });
  } finally {
    stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("生产线验收5/8/10/14：桌面手动归档只导出正式版本，创建MR即结束，多仓失败仅重试失败仓", { timeout: 70_000, skip: !fs.existsSync(chrome) && "需要 Chrome" }, () => archiveBrowserContract());
test("生产线验收2/5/10：归档等待中换任务不继承busy，迟到旧结果不覆盖或释放新操作", { timeout: 70_000, skip: !fs.existsSync(chrome) && "需要 Chrome" }, () => archiveBrowserContract("switch"));
test("生产线验收5/10/14：无正式知识不请求归档预览，平台发布后只在用户点击时读取新事实", { timeout: 70_000, skip: !fs.existsSync(chrome) && "需要 Chrome" }, () => archiveBrowserContract("unpublished"));
test("组件110项能力归档：桌面直接指定仓内相对目录，预览完成后确认并创建MR", { timeout: 70_000, skip: !fs.existsSync(chrome) && "需要 Chrome" }, () => archiveBrowserContract("paths"));
test("领域重新创建MR：跨路径确认窗口保留本次单号和描述，旧预览不覆盖新输入", { timeout: 70_000, skip: !fs.existsSync(chrome) && "需要 Chrome" }, () => archiveBrowserContract("issue"));
