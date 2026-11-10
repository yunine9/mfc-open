import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { DomainSkillWork } from "../src/domainSkillWork.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("#451 桌面页面在没有知识草稿时审阅完整过程文稿，审阅后提意见、多次确认，研究中也能看草稿", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-human-browser-"));
  const content = "# 自定义方法文稿\n\n" + "中间正文需要完整保存和正常滚动。\n\n".repeat(180) + "## 全文末尾标记\n\n确认范围后继续研究。";
  const service = new DomainKnowledgeExtraction(root, async input => {
    const work = new DomainSkillWork(join(input.root, "skill-runs", input.turn.id, "work.json"), "opaque", input.turn.pipeline_continue);
    work.saveDocument({ id: "plan", title: "自定义方法文稿", content });
    if (input.turn.pipeline_continue) input.save({ id: "rules", title: "初步知识草稿", target_id: "domain", path: "domains/rules.md", layer: "domain", content: "# 初步知识草稿\n\n中间知识草稿也可审阅。", sources: "用户范围" });
    return work.finish({ status: "paused", summary: input.turn.pipeline_continue ? "已按意见调整，请检查草稿后继续。" : "请检查完整文稿，确认或提出意见。", document_ids: input.turn.pipeline_continue ? ["rules"] : [], work_document_ids: ["plan"] });
  });
  try {
    const created = service.create({ issue_no: "451", title: "领域知识萃取", scope: "用户指定范围", repositories: [] }, "expert");
    const wait = async () => { for (let i = 0; i < 200 && service.get(created.id).status !== "paused"; i++) await new Promise(resolve => setTimeout(resolve, 5)); await new Promise(resolve => setTimeout(resolve, 0)); };
    await wait(); const first = service.get(created.id);
    service.resume(first.id, "reviewer", false, { request_id: first.turns[0].waiting!.id, message: "只生成一个模块，先给我审阅。" });
    await wait(); const second = service.get(created.id), running = structuredClone(second);
    assert.equal(second.status, "paused", `第二次确认的服务端夹具没有准备好：${second.error ?? second.stage}`);
    running.status = "running"; running.turns[0].status = "running"; delete running.turns[0].waiting;
    running.production = projectKnowledgeProduction({ kind: "domain", record: running });
    const fixture = { first, second, running };
    const bundle = await build({ entryPoints: [resolve("tests/browser/domainKnowledgeHumanInput.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(root, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + ' #result { display:none; }</style><div class="knowledge-hub is-focused"><div id="app" class="knowledge-hub-task"></div></div><pre id="result"></pre><script>window.__DOMAIN_HUMAN_INPUT__=' + JSON.stringify(fixture).replaceAll("</script", "<\\/script") + ';</script><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    const screenshots = process.env.MFC_RESEARCH_SCREENSHOT_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(root, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", ...(screenshots ? [`--screenshot=${join(screenshots, `domain-human-input-${width}.png`)}`] : []), `file://${html}?kbPage=task&kbKind=domain&kbTask=${first.id}`], join(root, `${width}.html`));
      const raw = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(raw, `${width}: browser did not finish`);
      const result = JSON.parse(raw); assert.equal(result.error, undefined, `${width}: ${result.error}`); assert.equal(result.passed, true);
    }
  } finally { await service.shutdown(); stop(); rmSync(root, { recursive: true, force: true }); }
});
