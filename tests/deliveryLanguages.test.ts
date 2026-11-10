import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryAnalysis } from "../src/deliveryAnalytics.ts";
import type { TaskSummary } from "../src/taskService.ts";
import type { RepositoryProfile } from "../src/repositoryProfiles.ts";
const profile = (repository: string, technologies: string[]): RepositoryProfile => ({
  repository, technologies, confirmed: true, updated_at: "2026-09-20", updated_by: "dev",
});
const task = (id: string, repo: string, extra: Partial<TaskSummary> = {}) => ({
  id, requirement: id, repo_url: repo, workspace: `/nonexistent-delivery-language-test/${id}`,
  status: "running", created_at: "2026-09-20", ...extra,
}) as TaskSummary;

test("交付语言只读本仓技术栈，保持多语言，不把同需求其他仓的语言串入", () => {
  const profiles = [profile("https://git/a.git", ["cpp"]), profile("https://git/b", ["java"]), profile("https://git/web", ["typescript", "javascript"])];
  const rows = buildDeliveryAnalysis([
    task("parent", "https://git/a", { repository_profiles: profiles }),
    task("cpp", "https://git/a", { parent_task_id: "parent", repository_profiles: profiles }),
    task("java", "https://git/b", { parent_task_id: "parent" }),
    task("web", "https://git/web"), task("old", "https://git/unknown"),
  ], [], profiles).rows;
  assert.deepEqual(rows.map(r => [r.id, r.languages]), [["cpp", ["cpp"]], ["java", ["java"]], ["web", ["typescript", "javascript"]], ["old", []]]);
});

test("优先保留任务已有技术栈，旧任务未记录时复用仓库配置，无需刷新代码统计", () => {
  const configured = [profile("https://git/a", ["java"])];
  const rows = buildDeliveryAnalysis([
    task("saved", "https://git/a.git/", { repository_profiles: [profile("https://git/a", ["cpp"])] }),
    task("legacy", "https://git/a"),
    task("empty", "https://git/a", { repository_profiles: [profile("https://git/a", [])] }),
  ], [], configured).rows;
  assert.deepEqual(rows.map(r => r.languages), [["cpp"], ["java"], ["java"]]);
  assert.ok(rows.every(r => !r.metric));
});
