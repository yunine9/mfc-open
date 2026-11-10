import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("领域检视：跨篇批注、轮次隔离、历史整批重试、读取恢复与统一提交", { skip: !existsSync(chrome) && "需要真实 Chrome", timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-inspection-browser-"));
  try {
    const repository = { id: "source", name: "业务代码仓", repository: "https://example.test/source.git", branch: "main", path: "src", docs_path: "docs" };
    const job: DomainKnowledgeJob = { id: "dkx-inspection", title: "交易业务领域知识", scope: "订单与库存", operator: "alice", created_at: "2026-10-12T00:00:00Z", issue_no: "REQ-INSPECTION", status: "done", stage: "研究完成", revisions: {}, repositories: [repository], knowledge_target: { ...repository, id: "domain", name: "领域知识仓" }, material_ids: [], documents: [
      { id: "orders", title: "订单规则", target_id: "domain", layer: "domain", path: "docs/业务知识/orders.md", content: "# 订单规则\n\n取消订单之前先核对发货状态。\n\n支付回调只处理一次。", sources: "来源：订单模块", base_content: "", base_revision: "", revision: 4, history: [], selected: true },
      { id: "stock", title: "库存规则", target_id: "domain", layer: "domain", path: "docs/业务知识/stock.md", content: "# 库存规则\n\n订单取消后回补库存。", sources: "来源：库存模块", base_content: "", base_revision: "", revision: 4, history: [], selected: true },
    ], turns: [], publications: [], evidence: [] };
    job.production = projectKnowledgeProduction({ kind: "domain", record: job });
    const bundle = await build({ entryPoints: [resolve("tests/browser/domainKnowledgeInspection.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const css = readdirSync(resolve("web/dist/assets")).filter(name => name.endsWith(".css")).map(name => readFileSync(resolve("web/dist/assets", name), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>body{margin:0}' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>window.__INSPECTION__=' + JSON.stringify(job).replaceAll("</script", "<\\/script") + ';</script><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    const screenshots = process.env.MFC_INSPECTION_SCREENSHOT_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    const cases = [1920, 1366].flatMap(width => ["workflow", "recovery"].map(scenario => ({ width, height: width === 1920 ? 1080 : 768, scenario, visual: "" })));
    if (screenshots) for (const visual of ["initial-error", "started-error"]) cases.push({ width: 1920, height: 1080, scenario: "recovery", visual });
    if (screenshots) cases.push({ width: 1920, height: 1080, scenario: "workflow", visual: "history" });
    for (const { width, height, scenario, visual } of cases) {
      const name = `${scenario}-${visual || "checks"}-${width}`, image = screenshots && visual ? join(resolve(screenshots), `inspection-${visual}-${width}.png`) : undefined;
      const query = new URLSearchParams({ scenario, ...(visual ? { visual } : {}) });
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${name}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", ...(image ? [`--screenshot=${image}`] : []), "--dump-dom", `file://${html}?${query}`], join(dir, `${name}.html`));
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1]; assert.ok(result, `${name}: browser did not finish`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${name}: ${value.error}`); assert.equal(value.passed, true);
      if (visual) { assert.equal(value.visual, visual); assert.ok(image && existsSync(image), `${name}: missing screenshot`); }
      else if (scenario === "recovery") { assert.equal(value.recovery, true); assert.equal(value.requestIsolation, true); }
      else { assert.equal(value.notes, 5); assert.equal(value.independentFinished, true); assert.equal(value.roundIsolation, true); assert.equal(value.historyRetry, true); }
    }

  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
