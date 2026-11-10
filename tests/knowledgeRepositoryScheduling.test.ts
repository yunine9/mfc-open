import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { readModuleKnowledgeSync, writeModuleKnowledgeSync } from "../src/knowledgeRepositorySnapshots.ts";
import { TaskService } from "../src/taskService.ts";

type SchedulingHost = {
  refreshKnowledgeRepositories(): void;
  knowledgeRepositorySyncs: Map<string, { abort: AbortController; work: Promise<unknown> }>;
  knowledgeRepositoryCompletedAt: Map<string, number>;
  knowledgeRepositoryTimer?: ReturnType<typeof setTimeout>;
};

function fixture(t: TestContext, ids = ["a"]) {
  const root = mkdtempSync(join(tmpdir(), "mfc-knowledge-scheduling-"));
  const dataDir = join(root, "data"), repository = join(root, "repository");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), content);
  };
  const commit = () => { git("add", "-A"); git("commit", "-qm", "fixture"); };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  put("AGENTS.md", "# 仓库说明\n");
  for (const id of ids) {
    put(`domains/${id}/README.md`, `# ${id} 领域\n\n正式规则。\n`);
    createBusinessModule(dataDir, { id, name: id, description: id, owner: "owner",
      repositories: [repository], knowledge_path: `domains/${id}` }, "owner");
  }
  commit();
  saveKnowledgeRepoConfig(dataDir, repository, { branch: "main" });
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const host = service as unknown as SchedulingHost;
  clearTimeout(host.knowledgeRepositoryTimer);
  t.after(async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const drain = async () => {
    while (host.knowledgeRepositorySyncs.size) await Promise.all([...host.knowledgeRepositorySyncs.values()].map(sync => sync.work));
  };
  const sync = async (id = "a") => { service.startModuleKnowledgeSync(id, "owner"); await drain(); };
  return { dataDir, repository, service, host, git, put, commit, drain, sync };
}

test("后台知识同步先服务未尝试及等待最久的模块，并受两个并发名额限制", t => {
  const f = fixture(t, ["a", "b", "c"]);
  const now = Date.now();
  for (const [id, delay] of [["a", 120_000], ["b", 600_000]] as const) {
    writeModuleKnowledgeSync(f.dataDir, { module_id: id, state: "failed",
      location: { repository: f.repository, branch: "main", docs_path: `domains/${id}` },
      attempted_at: new Date(now - delay).toISOString(), document_count: 0 });
  }
  const started: string[] = [];
  t.mock.method(f.service, "startModuleKnowledgeSync", (id: string) => {
    started.push(id);
    f.host.knowledgeRepositorySyncs.set(id, { abort: new AbortController(), work: Promise.resolve() });
  });
  f.host.refreshKnowledgeRepositories();
  assert.deepEqual(started, ["c", "b"], "名称靠前的 a 不能越过等待更久的模块");
  f.host.refreshKnowledgeRepositories();
  assert.equal(started.length, 2, "后台并发已满时不能继续启动");
  f.host.knowledgeRepositorySyncs.clear();
  f.host.knowledgeRepositoryCompletedAt.set("b", now);
  f.host.knowledgeRepositoryCompletedAt.set("c", now);
  f.host.refreshKnowledgeRepositories();
  assert.deepEqual(started, ["c", "b", "a"]);
});

test("超过一分钟的同步结束后仍冷却，后续模块可以接续；手动同步可立即执行", async t => {
  const f = fixture(t, ["a", "b", "c"]);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const started: string[] = [];
  const start = f.service.startModuleKnowledgeSync.bind(f.service);
  t.mock.method(f.service, "startModuleKnowledgeSync", (id: string, operator: string) => {
    started.push(id); start(id, operator);
  });
  f.host.refreshKnowledgeRepositories();
  assert.deepEqual(started, ["a", "b"]);
  now += 120_000;
  await f.drain();
  assert.deepEqual(started, ["a", "b", "c"], "慢模块完成后应让后面的模块运行，不能立即重跑自身");
  for (const id of ["a", "b", "c"]) assert.equal(readModuleKnowledgeSync(f.dataDir, id)?.state, "ready");
  f.host.refreshKnowledgeRepositories();
  assert.equal(started.length, 3, "冷却从完成时起算");
  await f.sync("a");
  assert.deepEqual(started, ["a", "b", "c", "a"], "显式手动刷新不受后台冷却阻挡");
  now += 60_001;
  f.host.refreshKnowledgeRepositories();
  await f.drain();
  assert.equal(started.length, 7, "冷却到期后的每个模块仍能继续自动同步");
  await f.service.shutdown();
  f.host.refreshKnowledgeRepositories();
  assert.equal(started.length, 7, "服务停止后不能重新调度");
  assert.throws(() => start("a", "owner"), /服务正在停止/);
});

test("后台同步只在有效文稿增改删时重建索引，重复同步、无关提交及失败均复用索引", async t => {
  const f = fixture(t);
  let preparations = 0;
  t.mock.method(f.service, "prepareKnowledgeIndex", () => { preparations++; });
  await f.sync();
  assert.equal(preparations, 1);
  await f.sync();
  assert.equal(preparations, 1, "远端提交没变时不用重建全部知识索引");
  f.put("src/implementation.txt", "不属于知识目录的代码变更\n"); f.commit();
  await f.sync();
  assert.equal(preparations, 1, "source.revision 更新不能被当作正文更新");
  f.put("domains/a/README.md", "# a 领域\n\n合入后的新规则。\n"); f.commit();
  await f.sync();
  assert.equal(preparations, 2);
  f.put("domains/a/new.md", "# 新增规则\n"); f.commit();
  await f.sync();
  assert.equal(preparations, 3);
  f.git("rm", "-q", "domains/a/new.md"); f.commit();
  await f.sync();
  assert.equal(preparations, 4, "删除文稿必须让索引移除旧内容");
  renameSync(f.repository, `${f.repository}-offline`);
  await f.sync();
  assert.equal(preparations, 4, "失败并保留原快照时不能重建索引");
});
