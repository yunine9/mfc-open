import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { assertRepositoryCloneAddress } from "../src/repositoryAddress.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { createBusinessModule, updateBusinessModule, readBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveComponentRepository, componentRepositories } from "../src/componentRepositories.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

const web = "https://codehub-y.example.com/MAE-M/FMEMate/FMEMateService/";
const clone = "https://codehub.example.com/MAE-M/FMEMate/FMEMateService.git";

test("Git 地址拒绝已知网页/API 域名；不把缺 .git 或尾斜杠当作普遍错误", () => {
  for (const address of [web, web.slice(0, -1), web.slice(0, -1) + ".git", web.replace("codehub-y", "CODEHUB-Y"), web.replace(".com/", ".com.:443/")]) {
    assert.throws(() => assertRepositoryCloneAddress(address), /克隆\/下载.*HTTPS/);
  }
  for (const address of [clone, clone + "/", clone.replace(/\.git$/, ""), "https://git.example/team/repo/", "/local/repo"]) {
    assert.doesNotThrow(() => assertRepositoryCloneAddress(address));
  }
});

test("配置中心模块及组件仓保存使用同一规则，失败不覆盖原配置", t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-repo-address-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = { id: "domain", name: "业务模块", description: "测试", owner: "owner", repositories: [clone] };
  assert.throws(() => createBusinessModule(dir, { ...module, repositories: [web] }, "owner"), /网页\/API/);
  createBusinessModule(dir, module, "owner");
  assert.throws(() => updateBusinessModule(dir, "domain", { repositories: [web] }, "owner"), /网页\/API/);
  assert.deepEqual(readBusinessModule(dir, "domain").repositories, [clone]);
  const component = { name: "CBB", repository: clone, branch: "master", languages: ["cpp"] };
  seedTechnologyStacks(dir, component.languages);
  assert.throws(() => saveComponentRepository(dir, { ...component, repository: web }, "owner"), /网页\/API/);
  const saved = saveComponentRepository(dir, component, "owner");
  assert.throws(() => saveComponentRepository(dir, { id: saved.id, repository: web }, "owner"), /网页\/API/);
  assert.equal(componentRepositories(dir)[0].repository, clone);
});

test("单仓、多仓、内部子任务直接建单都拒绝网页地址，不分配 task ID", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-repo-address-create-"));
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {},
    maxConcurrent: 0, host: { kernelRoot: join(dir, "no-kernel") } });
  t.after(async () => { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  for (const options of [{ repo: web }, { repos: [clone, web] }, { repo: web, parentTaskId: "task-parent", internalRequirement: true }]) {
    assert.throws(() => service.create("测试需求", { ...options, account: "owner", ticket: "REQ1" }), /网页\/API/);
  }
  assert.equal(service.list().length, 0);
  assert.equal(readdirSync(dir).filter(name => /^task-\d+$/.test(name)).length, 0);
});

test("真实下单接口拦截网页地址，探测保持逐仓结果且合法无后缀仓可访问", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-repo-address-http-"));
  const repo = join(dir, "repository");
  execFileSync("git", ["init", "--bare", "--quiet", repo]);
  const service = new TaskService({ dataDir: join(dir, "tasks"), provider: "test", model: "test", modelsJson: {},
    maxConcurrent: 0, host: { kernelRoot: join(dir, "no-kernel") } });
  seedTechnologyStacks(service.options.dataDir, ["cpp"]);
  createBusinessModule(service.options.dataDir, { id: "domain", name: "业务", description: "测试", owner: "owner", repositories: [repo] }, "owner");
  // 本例隔离无关的 MR/流水线部署检查，Git 地址探测仍运行真实命令。
  const launchOptions = service.launchOptions.bind(service);
  service.launchOptions = () => ({ ...launchOptions(), blockers: [] });
  const server = createTaskServer(service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: object) => fetch(endpoint + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const probe = await post("/repositories/probe", { repositories: [repo + "/", web, join(dir, "missing")] });
  const results = (await probe.json() as any).repositories;
  assert.deepEqual(results.map((r: any) => r.reachable), [true, false, false]);
  assert.match(results[1].message, /克隆\/下载/);
  for (const repositories of [[web], [repo, web]]) {
    const response = await post("/tasks", { requirement: "测试需求", account: "owner", business_module_id: "domain",
      ticket: "REQ1", repos: repositories,
      repository_profiles: repositories.map(repository => ({ repository, technologies: ["cpp"], confirmed: true })) });
    const body = await response.json() as any;
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(body.error, /任务未创建.*克隆\/下载/);
    assert.equal(service.list().length, 0);
  }
});
