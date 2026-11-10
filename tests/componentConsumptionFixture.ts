import { componentKnowledgeCatalog } from "../src/componentKnowledgeCatalog.ts";
import { readComponentPolicies, saveComponentPolicy } from "../src/componentKnowledgePolicy.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchSection } from "../src/componentResearchDocument.ts";
import { researchDocumentMarkdown } from "../src/componentResearchDocument.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

export function componentSection(language = "cpp", id = "pool-submit"): ResearchSection {
  return { id, title: "后台任务统一执行", revision: 1, selected: true, repository_ids: ["base"], related_ids: [],
    content: "### 适用场景\n业务需要后台执行有限任务。\n\n### 使用步骤\n创建任务池，提交任务；退出前等待任务完成。\n\n### 使用约束\n任务结束前不能释放捕获的对象。", interfaces: "Pool.submit", integration: "链接已发布的 pool target", example: "```cpp\nPool pool; pool.submit(work);\n```",
    unit_tests: "使用 GoogleTest；链接 pool 与 gtest_main，运行 ctest。\n```cpp\nTEST(Pool, ExecutesTask) {\n  Pool pool;\n  int result = 0;\n  pool.submit([&] { result = 1; });\n  pool.wait();\n  EXPECT_EQ(result, 1);\n}\n```", sources: "基础仓固定版本与 everycode", paradigm: {
      kind: "paradigm", component: "pool", language, status: "recommended", need: "执行后台任务", api: ["Pool.submit"], applicability: "使用 pool v2 的业务代码；底层适配器允许使用原生线程。",
      replaces: { identifiers: [language === "cpp" ? "std::thread" : language === "c" ? "malloc" : "Thread"], imports: [], patterns: [] },
      evidence: [{ repository_id: "base", path: "src/pool.cpp", revision: "a".repeat(40), start: 1, end: 2 }],
      usage_evidence: ["everycode-" + "b".repeat(24)], test_evidence: ["everycode-" + "c".repeat(24)], open_questions: [],
    } };
}
export function consumptionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "component-consume-")), cwd = join(dir, "repo"), data = join(dir, "data"); mkdirSync(cwd); mkdirSync(data);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
  writeFileSync(join(cwd, "existing.cpp"), "void old() { std::thread old_thread; }\nvoid unrelated() {}\n");
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD"); git("checkout", "-qb", "feature");
  const context = { repo: "consumer", repositories: ["https://example.test/consumer.git"], moduleIds: [], productVersion: "v2" };
  const publish = (sections = [componentSection()], extra: Record<string, unknown> = {}) => saveKnowledgeDocument(data, {
    title: "组件使用指南", scope: "platform", content: researchDocumentMarkdown("组件使用指南", { overview: "## 组件用途\n后台任务的提交与退出管理。\n\n## 接入配置\n使用 pool v2 并保持统一生命周期。", sections }, true), ...extra,
  }, "expert");
  return { dir, cwd, data, git, base, context, publish, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function enableComponentHints(f: ReturnType<typeof consumptionFixture>) {
  const catalog = componentKnowledgeCatalog(f.data, f.context);
  for (const item of catalog.rules) {
    saveComponentPolicy(f.data, item.id, item.source_digest, { revision: readComponentPolicies(f.data).revision,
      source_digest: item.source_digest, level: "warning", owner: "组件负责人", reason: "已对照实际代码核对适用条件", scope: [] }, "expert");
  }
}
