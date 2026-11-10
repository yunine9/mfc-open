/** Local-only demo: real Git commits + production collector, no fabricated counts.
 * Run: npx tsx scripts/seed-delivery-analysis-demo.ts
 * Then: MAE_FLOW_UI_FIXTURE_MODE=1 npx tsx src/serve.ts --data .e2e-fixtures/delivery-analysis --port 8851
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { LocalAuth } from "../src/auth.ts";
import { collectDeliveryCode } from "../src/deliveryAnalytics.ts";
import type { TaskSummary } from "../src/taskService.ts";

const data = resolve(process.argv[2] ?? ".e2e-fixtures/delivery-analysis");
if (existsSync(data)) throw new Error(`演示目录已存在，请沿用或手工移走：${data}`);
mkdirSync(data, { recursive: true });
new LocalAuth(join(data, "auth.json")).bootstrapAdmin("admin", "mae-flow-demo");
for (const [id, name] of [["alarm", "告警管理"], ["platform", "平台配置"]]) {
  createBusinessModule(data, { id, name, description: "本地演示模块", owner: "admin", repositories: ["https://code.example/team/mae-demo.git"] }, "admin");
}
const date = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
function persist(summary: TaskSummary, cwd?: string) {
  mkdirSync(summary.workspace, { recursive: true });
  writeFileSync(join(summary.workspace, "task.json"), JSON.stringify({ summary, cwd }));
}
persist({ id: "task-1", title: "统一告警检索能力", requirement: "统一告警检索能力", status: "completed", ui_fixture: true,
  business_module: { id: "alarm", name: "告警管理" }, workspace: join(data, "task-1"), created_at: date(28), completed_at: date(7) } as TaskSummary);
for (const [id, title, parent, days, firstSize, ciCount, reviewCount, otherCount] of [
  [2, "告警查询服务与分页接口", "task-1", 21, 160, 12, 8, 4],
  [3, "告警工作台筛选与结果展示", "task-1", 7, 120, 4, 10, 3],
  [4, "配置中心版本分支映射", undefined, 1, 180, 5, 6, 2],
] as const) {
  const workspace = join(data, `task-${id}`), cwd = join(workspace, "repo"); mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: date(days), GIT_COMMITTER_DATE: date(days) } }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Local Analytics Demo"); git("config", "user.email", "demo@example.test");
  writeFileSync(join(cwd, "base.ts"), "export const existing = true;\n"); git("add", "."); git("commit", "-m", "existing target code");
  const base = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", base); git("checkout", "-b", `feature/task-${id}`);
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: base } }));
  const summary = { id: `task-${id}`, title, requirement: title, parent_task_id: parent, ui_fixture: true, status: "await_merge", workspace,
    created_at: date(days + 2), completed_at: date(days), repo_url: "https://code.example/team/mae-demo.git",
    business_module: parent ? undefined : { id: "platform", name: "平台配置" }, delivery: { target_branch: "main", source_branch: `feature/task-${id}` } } as TaskSummary;
  const lines = Array.from({ length: firstSize }, (_, i) => `export const value${i} = ${i};`);
  async function publish(message: string) {
    writeFileSync(join(cwd, "feature.ts"), lines.join("\n") + "\n"); git("add", "."); git("commit", "-m", message);
    const sha = git("rev-parse", "HEAD"); summary.delivery!.git_push = { sha, ref: `refs/heads/feature/task-${id}`, remote: "origin" };
    await collectDeliveryCode(summary, cwd, sha); return sha;
  }
  let head = await publish("实现业务接口与测试辅助逻辑");
  summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: head };
  for (let i = 0; i < ciCount; i++) lines[i] = `export const value${i} = ${i + 1000};`;
  head = await publish("修复流水线静态检查");
  summary.delivery!.loop = { round: 1, state: "repairing", kind: "review", last_sha: head };
  for (let i = ciCount; i < ciCount + reviewCount; i++) lines[i] = `export const value${i} = ${i + 2000};`;
  head = await publish("按责任人意见完善边界处理");
  summary.delivery!.loop = undefined;
  for (let i = ciCount + reviewCount; i < ciCount + reviewCount + otherCount; i++) lines[i] = `export const value${i} = ${i + 3000};`;
  head = await publish("补充修改（没有单一归因证据）");
  summary.status = "completed"; summary.delivery!.mr_state = "merged"; summary.delivery!.merged_sha = head;
  git("checkout", "main"); git("merge", "--ff-only", `feature/task-${id}`); git("update-ref", "refs/remotes/origin/main", head);
  persist(summary, cwd);
}
persist({ id: "task-5", title: "历史交付 · 缺少快照示例", requirement: "历史交付 · 缺少快照示例", status: "completed", ui_fixture: true,
  workspace: join(data, "task-5"), created_at: date(4), completed_at: date(2),
  delivery: { mr_state: "merged", merged_sha: "a".repeat(40), git_push: { sha: "a".repeat(40), remote: "origin", ref: "refs/heads/history" } } } as TaskSummary);
console.log(`真实 Git 演示数据已生成：${data}\n登录：admin / mae-flow-demo（仅本地演示）`);
