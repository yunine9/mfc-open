import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { LocalAuth } from "../src/auth.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

function definition(base?: {
  standard_id: string;
  standard_version: string;
  catalog_digest: string;
}) {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: base ?? {
      standard_id: "mae-flow.standard",
      standard_version: "test",
      catalog_digest: `sha256:${"a".repeat(64)}`,
    },
    applicability: {
      business_module_ids: [], repositories: [], technologies: [],
    },
    edits: [],
  };
}

async function listen(service: TaskService, auth?: LocalAuth) {
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

async function close(server: ReturnType<typeof createTaskServer>) {
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
}

async function login(base: string, username: string, password: string) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

test("工作流方案路由：团队方案由所有者编辑、管理员终审，个人副本隔离",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "mfc-workflow-routes-"));
    const auth = new LocalAuth(join(root, "auth.json"));
    auth.bootstrapAdmin("boss", "administrator-pass");
    auth.createUser("alice", "alice-password-11", "developer");
    auth.createUser("bob", "bob-password-123", "developer");
    const kernelRoot = discoverKernelRoot(process.cwd());
    assert.ok(kernelRoot, "测试需要随 Cloud 发布的 Mae-Flow 快照");
    const service = new TaskService({
      dataDir: join(root, "data"), provider: "test", model: "test",
      modelsJson: {}, maxConcurrent: 0, workflowCatalogRoot: kernelRoot,
    });
    const { server, base } = await listen(service, auth);
    try {
      assert.equal((await fetch(`${base}/workflow-assets`)).status, 401);
      const [boss, alice, bob] = await Promise.all([
        login(base, "boss", "administrator-pass"),
        login(base, "alice", "alice-password-11"),
        login(base, "bob", "bob-password-123"),
      ]);
      const standardResponse = await fetch(`${base}/workflow-assets/standard`,
        { headers: { cookie: boss } });
      assert.equal(standardResponse.status, 200,
        "管理员不下单，但仍必须能读取资产编辑器标准基线");
      const standard = await standardResponse.json() as {
        standard_id: string; standard_version: string; catalog_digest: string };
      assert.match(standard.catalog_digest, /^sha256:/);
      const created = await fetch(`${base}/workflow-assets`, {
        method: "POST", headers: { cookie: alice }, body: JSON.stringify({
          id: "team-review", name: "团队检视方案", scope: "team",
          maintainers: ["bob"], definition: definition(standard),
        }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      assert.equal((await created.json() as { owner: string }).owner, "alice",
        "Owner 必须取登录者，不能由请求体冒认");

      const listed = await fetch(`${base}/workflow-assets`,
        { headers: { cookie: bob } }).then((response) => response.json()) as {
          items: Array<{ id: string }> };
      assert.deepEqual(listed.items.map((item) => item.id), ["team-review"]);

      const submitted = await fetch(`${base}/workflow-assets/team-review/submit`,
        { method: "POST", headers: { cookie: bob } });
      assert.equal(submitted.status, 200, await submitted.text());
      const ownerCannotApprove = await fetch(
        `${base}/workflow-assets/team-review/approve`,
        { method: "POST", headers: { cookie: alice } });
      assert.equal(ownerCannotApprove.status, 403, "团队方案必须经过管理员终审");
      const approved = await fetch(`${base}/workflow-assets/team-review/approve`,
        { method: "POST", headers: { cookie: boss } });
      assert.equal(approved.status, 200, await approved.clone().text());
      assert.equal((await approved.json() as { selectable_for_tasks: boolean })
        .selectable_for_tasks, true);

      const copied = await fetch(`${base}/workflow-assets/team-review/copy`, {
        method: "POST", headers: { cookie: bob }, body: JSON.stringify({
          name: "Bob 的实验方案", scope: "personal",
        }),
      });
      assert.equal(copied.status, 201, await copied.clone().text());
      const copy = await copied.json() as { id: string; owner: string };
      assert.equal(copy.owner, "bob");
      const aliceList = await fetch(`${base}/workflow-assets`,
        { headers: { cookie: alice } }).then((response) => response.json()) as {
          items: Array<{ id: string }> };
      assert.equal(aliceList.items.some((item) => item.id === copy.id), false,
        "别人的个人方案不能出现在列表里");
    } finally {
      await close(server);
    }
  });

test("任务选择已发布方案时固定精确版本；归档后不允许新任务继续选",
  async () => {
    const kernelRoot = discoverKernelRoot(process.cwd());
    assert.ok(kernelRoot, "测试需要随 Cloud 发布的 Mae-Flow 快照");
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-workflow-task-select-")),
      provider: "test", model: "test-1", maxConcurrent: 0,
      modelsJson: { providers: { test: { models: [{ id: "test-1" }] } } },
      host: { kernelRoot, repoPath: "/tmp/repo" },
      delivery: { platformUrl: "http://127.0.0.1:1" },
    });
    const standard = service.launchOptions().workflow_standard!;
    const { server, base } = await listen(service);
    try {
      const created = await fetch(`${base}/workflow-assets`, {
        method: "POST", body: JSON.stringify({
          id: "published-flow", name: "已发布方案", scope: "team",
          definition: definition(standard),
        }),
      });
      assert.equal(created.status, 201, await created.text());
      assert.equal((await fetch(`${base}/workflow-assets/published-flow/submit`,
        { method: "POST" })).status, 200);
      assert.equal((await fetch(`${base}/workflow-assets/published-flow/approve`,
        { method: "POST" })).status, 200);

      const taskResponse = await fetch(`${base}/tasks`, {
        method: "POST", body: JSON.stringify({
          requirement: "使用团队方案完成任务",
          workflow_selection: { id: "published-flow", version: "v1" },
        }),
      });
      assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
      const task = await taskResponse.json() as {
        workflow_profile?: { source: {
          kind: string; id: string; label?: string; version: string; digest: string } } };
      assert.equal(task.workflow_profile?.source.kind, "workflow");
      assert.equal(task.workflow_profile?.source.id, "published-flow");
      assert.equal(task.workflow_profile?.source.label, "已发布方案");
      assert.equal(task.workflow_profile?.source.version, "v1");
      assert.match(task.workflow_profile?.source.digest ?? "", /^sha256:/);

      assert.equal((await fetch(`${base}/workflow-assets/published-flow/archive`,
        { method: "POST" })).status, 200);
      const afterArchive = await fetch(`${base}/tasks`, {
        method: "POST", body: JSON.stringify({
          requirement: "不能再用归档方案",
          workflow_selection: { id: "published-flow", version: 1 },
        }),
      });
      assert.equal(afterArchive.status, 409);
      assert.match(await afterArchive.text(), /不可用|未发布|归档/);
    } finally {
      await close(server);
    }
  });
