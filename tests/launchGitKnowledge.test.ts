import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBusinessModule, readBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { copyBusinessModuleSnapshots, materializeBusinessModuleKnowledge } from "../src/businessModuleRuntime.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { writeGitKnowledgeSnapshot, type GitKnowledgeSnapshot } from "../src/knowledgeRepositorySnapshots.ts";
import { TaskService } from "../src/taskService.ts";

const domain = "https://example.test/knowledge.git", repository = "https://example.test/shared.git";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
test("下单读取正式 Git 知识：百篇文档、模块筛选、预览创建一致、父子任务固定正文", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "launch-git-knowledge-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  saveKnowledgeRepoConfig(dataDir, domain, { branch: "main" });
  createBusinessModule(dataDir, { id: "orders", name: "订单", owner: "owner", description: "订单业务",
    repositories: [repository], knowledge_path: "domains/orders" }, "owner");
  updateBusinessModule(dataDir, "orders", { repository_knowledge_exclusions: [{ repository, paths: ["docs/other"] }] }, "owner");
  const paths = [...Array.from({ length: 100 }, (_, i) => `domains/orders/${i}.md`), "docs/orders/guide.md", "docs/other/guide.md", "AGENTS.md"];
  const snapshot: GitKnowledgeSnapshot = { module_id: "orders", location: { repository: domain, branch: "main", docs_path: "domains/orders" },
    synced_at: "2026-10-21T00:00:00Z", resources: {}, repositories: [],
    documents: paths.map(path => {
      const shared = !path.startsWith("domains/"), content = `# ${path}\n\n固定的正式正文`;
      return { id: `kg-${hash(path)}`, title: path, content, revision: hash(content), scope: shared ? "repository" : "module",
        module_ids: shared ? [] : ["orders"], repositories: shared ? [repository] : [], technologies: [], product_versions: [], when_to_use: "", active: true,
        source: { repository: shared ? repository : domain, branch: "main", path, revision: "a".repeat(40) }, history: [] };
    }),
  };
  writeGitKnowledgeSnapshot(dataDir, snapshot);
  assert.equal(readBusinessModule(dataDir, "orders").assets.length, 0, "正式仓知识无需回写旧资产库");
  const service = new TaskService({ dataDir, provider: "test", model: "test-1", maxConcurrent: 0,
    modelsJson: { providers: { test: { models: [{ id: "test-1" }] } } },
    host: { kernelRoot: "/tmp", repoPath: "/tmp/fixed-demo-repo" }, delivery: { platformUrl: "http://127.0.0.1:1" } });
  const input = { repositories: [repository], selectedBusinessModuleIds: ["orders"] };
  const preview = service.previewLaunchKnowledge(input);
  assert.equal(preview.complete, true, JSON.stringify(preview.errors));
  assert.equal(preview.business_knowledge.length, 101);
  assert.ok(!preview.business_knowledge.some(doc => doc.title === "AGENTS.md" || doc.title.includes("docs/other")));
  const task = service.create("按订单知识调整取消流程", { repo: repository, businessModuleId: "orders",
    selectedBusinessModuleIds: ["orders"], knowledgePreviewDigest: preview.selection_digest });
  const selected = task.business_modules!;
  assert.equal(selected[0].assets.length, preview.business_knowledge.length);
  const target = selected[0].assets[0];
  assert.equal(readFileSync(join(task.workspace, target.snapshot_path), "utf8"), snapshot.documents.find(doc => doc.id === target.id)!.content);
  const runtimeWorkspace = join(task.workspace, "repository"); mkdirSync(runtimeWorkspace, { recursive: true });
  const runtime = materializeBusinessModuleKnowledge({ selected, taskWorkspace: task.workspace, runtimeWorkspace });
  assert.equal(runtime.entries.length, 101);
  assert.deepEqual(runtime.warnings, []);
  assert.doesNotMatch(readFileSync(runtime.index_path!, "utf8"), /固定的正式正文/, "系统上下文只放目录");
  const updated = { ...snapshot, documents: snapshot.documents.map(doc => ({ ...doc, content: `${doc.content}\n新版本`, revision: hash(`${doc.content}\n新版本`) })) };
  writeGitKnowledgeSnapshot(dataDir, updated);
  const next = service.previewLaunchKnowledge(input);
  assert.notEqual(next.selection_digest, preview.selection_digest);
  assert.throws(() => service.create("不可混用版本", { repo: repository, selectedBusinessModuleIds: ["orders"], knowledgePreviewDigest: preview.selection_digest }), /知识清单已变化/);
  const childWorkspace = join(dataDir, "child"); mkdirSync(childWorkspace);
  const child = copyBusinessModuleSnapshots({ selected, sourceTaskWorkspace: task.workspace, targetTaskWorkspace: childWorkspace, repositories: [repository] });
  assert.equal(child[0].assets.length, 101);
  assert.doesNotMatch(readFileSync(join(childWorkspace, child[0].assets[0].snapshot_path), "utf8"), /新版本/);
});
