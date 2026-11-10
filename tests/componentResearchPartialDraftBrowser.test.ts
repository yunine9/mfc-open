import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
import { componentGuideSection } from "./fixtures/componentGuide.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function partialDraftFixtures() {
  const base = {
    id: "cr-partial-draft", format: "joint-document", topic: "C++ 组件知识", language: "cpp",
    status: "running", stage: "分项研究与独立评审", operator: "专家", created_at: "2026-10-10T00:00:00Z",
    source_repositories: [{ id: "source-core", name: "基础能力源码", repository: "https://code.example/core.git", branch: "main", path: "", languages: ["cpp"], description: "", enabled: true }],
    evidence: [], review_turns: [], pipeline: { tasks: [{ id: "files", title: "文件操作", status: "running" }, { id: "database", title: "数据库操作", status: "pending" }] },
  };
  const inventory = { id: "work-inventory", title: "组件能力分析", content: "# 组件能力分析\n\n初步识别文件操作和数据库操作两个功能组件。\n\n过程文稿第一版：独立研究仍在进行。", status_label: "已生成 · 后续内容仍在研究" };
  const file = { ...componentGuideSection("file-open", ["source-core"], { title: "文件打开与关闭", component: "file-operations" }), selected: true, revision: 1 };
  const partialFile = {
    ...componentGuideSection("file-atomic", ["source-core"], { title: "文件原子替换", component: "file-operations" }),
    selected: true, revision: 1, content: "原子替换草稿：先写临时文件，再替换目标文件。", interfaces: "", integration: "",
    example: "```cpp\nreplace_file_atomically(source, destination);\n```", unit_tests: "```cpp\nassert(destination_exists);\n```",
  };
  const database = {
    ...componentGuideSection("database-retry", ["source-core"], { title: "数据库失败重试", component: "database-operations" }),
    selected: true, revision: 1, content: "数据库草稿第一版：失败后按剩余预算重试。",
    interfaces: "", integration: "",
    example: "```cpp\nint db_retry_budget(int attempts) { return attempts; }\n```",
    unit_tests: "```cpp\n#include <cassert>\nassert(db_retry_budget(2) == 2);\n```",
  };
  database.paradigm!.status = "unverified";
  const p2p = {
    ...componentGuideSection("p2p-heartbeat", ["source-core"], { title: "P2P 心跳", component: "p2p-networking" }),
    selected: true, revision: 1, content: "P2P 草稿：按约定周期发送一次心跳。", interfaces: "", integration: "",
    example: "```cpp\nsend_p2p_heartbeat(peer);\n```", unit_tests: "```cpp\nassert(heartbeat_count == 1);\n```",
  };
  p2p.paradigm!.status = "unverified";
  const records = [
    { ...base, work_documents: [inventory] },
    {
      ...base,
      work_documents: [{ ...inventory, content: `${inventory.content}\n\n分析目录已更新：发现 P2P 心跳能力。` }],
      document: { overview: "", sections: [file, partialFile, database] },
    },
    {
      ...base,
      work_documents: [{ ...inventory, content: `${inventory.content}\n\n分析目录已更新：发现 P2P 心跳能力。` }],
      document: { overview: "", sections: [file, partialFile, { ...database, revision: 2, content: "数据库草稿第二版：重试耗尽后返回错误，避免无限循环。" }, p2p] },
    },
  ];
  records.push({ ...records[2], status: "cancelled", stage: "本轮已停止，草稿保留" });
  return records.map(record => ({ ...record, production: projectKnowledgeProduction({ kind: "component", record: record as unknown as ResearchRecord }) }));
}

test("过程文稿及未完成能力草稿可读，真实四秒详情轮询保留选择，停止后草稿仍可读", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-partial-draft-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/componentResearchPartialDraft.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    assert.ok(existsSync(assets), "请先构建 web，以真实桌面样式验证布局");
    const css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app" style="height:100vh"></div><pre id="result" style="display:none"></pre><script>window.__COMPONENT_PARTIAL_DRAFT_FIXTURES__='
      + JSON.stringify(partialDraftFixtures()).replaceAll("</script", "<\\/script") + ';</script><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dump = join(dir, `${width}.html`);
      const dom = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
        `--user-data-dir=${join(dir, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=20000", "--dump-dom",
        `file://${html}?kbPage=task&kbKind=component&kbTask=cr-partial-draft`], dump);
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`);
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${width}: ${value.error}`);
      assert.equal(value.passed, true);
      assert.ok(value.detailRequests >= 4, `${width}: must use selected-record detail polling through task cancellation`);
      assert.ok(value.pollIntervals.every((ms: number) => ms >= 3900), `${width}: detail updates must come from the real four-second interval`);
    }
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
