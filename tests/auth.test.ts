/**
 * 本地登录契约：密码不落明文、账号持久化、角色登录，
 * 开发可看全局但只能操作自己的任务。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";

test("账号库:scrypt 哈希落盘且重启后仍可登录", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "correct-horse-battery");
  auth.createUser("alice", "developer-password", "developer");

  const raw = readFileSync(file, "utf-8");
  assert.doesNotMatch(raw, /correct-horse-battery|developer-password/);
  assert.match(raw, /scrypt\$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const restored = new LocalAuth(file);
  assert.deepEqual(
    restored.authenticate("alice", "developer-password", "test").user,
    { username: "alice", role: "developer" },
  );
  assert.equal(
    restored.authenticate("alice", "wrong-password", "test").user,
    undefined,
  );
});

test("显示姓名:只影响展示和人员候选,工号继续作为登录身份", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-display-name-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "correct-horse-battery");
  assert.deepEqual(
    auth.createUser("z00899322", "developer-password", "developer", " 张三 "),
    { username: "z00899322", display_name: "张三", role: "developer" },
  );
  assert.deepEqual(auth.collaborationAssignees({
    git_token: false, luban_token: false,
  }), [{
    username: "z00899322", display_name: "张三", ready: true, missing: [],
  }]);
  assert.equal(auth.authenticate(
    "z00899322", "developer-password", "test").user?.display_name, "张三");
  assert.deepEqual(auth.setDisplayName("z00899322", "李四"), {
    username: "z00899322", display_name: "李四", role: "developer",
  });
  assert.equal(new LocalAuth(file).listUsers().find((user) =>
    user.username === "z00899322")?.display_name, "李四");
});

test("会话落盘:重启后 cookie 仍有效,磁盘上没有原始令牌", () => {
  // 2026-08-29 部署审计实锤:会话纯内存时,每次改 bug 重新部署都把
  // 全员踢回登录页。落盘的是令牌 sha256——令牌只写不读的纪律对自家
  // 令牌同样成立。
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-session-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "correct-horse-battery");
  const token = auth.createSession(
    auth.authenticate("admin", "correct-horse-battery", "test").user!);
  const sessionsFile = `${file}.sessions`;
  const raw = readFileSync(sessionsFile, "utf-8");
  assert.ok(!raw.includes(token), "磁盘不许出现可直接使用的令牌");
  assert.equal(statSync(sessionsFile).mode & 0o777, 0o600);
  // "重启":新实例从缓存接回会话,用户不被踢回登录页。
  const restored = new LocalAuth(file);
  assert.equal(restored.sessionUser(token)?.username, "admin");
  // 注销也落盘:再次"重启"带不回已退出的会话。
  restored.endSession(token);
  const again = new LocalAuth(file);
  assert.equal(again.sessionUser(token), undefined);
});

test("个人配置:退出重登与账号库重载后仍在,且不同用户严格隔离", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-profile-"));
  const file = join(dir, "auth.json");
  const original = new LocalAuth(file);
  original.bootstrapAdmin("admin", "administrator-pass");
  original.createUser("alice", "alice-password-1", "developer");
  original.createUser("bob", "bob-password-123", "developer");
  original.setGitToken("alice", "alice-codehub-secret", "alice@example.com");
  original.setLubanToken("alice", "alice-luban-secret");
  original.setMoonlight("alice", true);
  original.setGitToken("bob", "bob-codehub-secret", "bob@example.com");
  original.setLubanToken("bob", "bob-luban-secret");
  original.createUser("carol", "carol-password-123", "developer");
  original.setDisplayName("admin", "平台管理员");

  // 用新的 LocalAuth 模拟服务重启，证明事实来自账号文件而非前端内存。
  const auth = new LocalAuth(file);
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      text: await response.text(),
    };
  }

  try {
    const alice = await login("alice", "alice-password-1");
    const aliceView = JSON.parse(alice.text) as Record<string, unknown>;
    assert.deepEqual(aliceView, {
      username: "alice",
      role: "developer",
      git_token_hint: "••••cret",
      git_email: "alice@example.com",
      luban_token_hint: "••••cret",
      moonlight: true,
      // push 前清单过目:真人缺省即开(2026-08-26 拍板)。
      push_confirmation: true,
      // 按流剥离(2026-09-09):问题处理介入档位独立,缺省二档。
      issue_intervention_tier: "2",
      // 自动接单(ADR-0061 修订):本人当前态,缺省关闭。
      issue_auto_claim: false,
      // 个人模型网关(ADR-0068):没配只剩"未配置"事实,不带任何密钥影子。
      personal_models: { configured: false },
    });
    // 自由探索入口已下线(#97):会话视图不再携带 issue_flow 字段。
    assert.equal("issue_flow" in aliceView, false,
      "登录视图不得再有探索方式字段");
    assert.doesNotMatch(alice.text,
      /alice-codehub-secret|alice-luban-secret|bob-codehub-secret|bob@example/,
      "登录响应不得泄露本人明文或他人配置");

    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST", headers: { cookie: alice.cookie },
    });
    assert.equal(logout.status, 200);
    const aliceAgain = await login("alice", "alice-password-1");
    assert.deepEqual(JSON.parse(aliceAgain.text), aliceView,
      "退出再登录后个人配置视图必须完整恢复");

    const bob = await login("bob", "bob-password-123");
    const bobView = JSON.parse(bob.text) as Record<string, unknown>;
    assert.deepEqual(bobView, {
      username: "bob",
      role: "developer",
      git_token_hint: "••••cret",
      git_email: "bob@example.com",
      luban_token_hint: "••••cret",
      moonlight: false,
      push_confirmation: true,
      issue_intervention_tier: "2",
      issue_auto_claim: false,
      personal_models: { configured: false },
    });
    assert.equal(bobView.git_email, "bob@example.com");
    assert.notEqual(bobView.git_email, aliceView.git_email);

    const me = await fetch(`${base}/auth/me`, {
      headers: { cookie: aliceAgain.cookie },
    });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), aliceView,
      "登录响应与 /auth/me 不得再出现字段漂移");

    const users = await fetch(`${base}/auth/users`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(users.status, 403,
      "普通开发不能借账号管理接口读取其他用户信息");

    const people = await fetch(`${base}/auth/people`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(people.status, 200, "登录成员可以把协作账号翻译成显示姓名");
    const identities = await people.json() as Array<Record<string, unknown>>;
    assert.deepEqual(identities.find((person) => person.username === "admin"), {
      username: "admin", display_name: "平台管理员",
    });
    assert.equal("role" in identities[0], false,
      "姓名接口不顺带暴露角色或个人配置");

    // 探索方式设置端点已下线(#97):PUT /auth/me/issue-flow 必须是 404,
    // 任何人都不能再切换/产生新的自由模式会话。
    const issueFlowSetting = await fetch(`${base}/auth/me/issue-flow`, {
      method: "PUT", headers: { cookie: alice.cookie },
      body: JSON.stringify({ mode: "free" }),
    });
    assert.equal(issueFlowSetting.status, 404,
      "探索方式端点已下线,必须 404");

    const candidates = await fetch(`${base}/auth/collaboration-assignees`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(candidates.status, 200);
    const candidateText = await candidates.text();
    const candidateRows = JSON.parse(candidateText) as Array<{
      username: string; ready: boolean; missing: string[];
    }>;
    assert.deepEqual(candidateRows.find((row) => row.username === "alice"), {
      username: "alice", ready: true, missing: [],
    });
    assert.deepEqual(candidateRows.find((row) => row.username === "carol"), {
      username: "carol", ready: true, missing: [],
    }, "纯会话部署不需要 Git/通知令牌，不能造一道假门");
    assert.doesNotMatch(candidateText,
      /alice@example\.com|alice-codehub-secret|alice-luban-secret|cret/,
      "委派候选接口只能暴露就绪状态，不能带邮箱或任何令牌提示");

    // 问题登记的指派候选(ADR-0031):flow=issue 固定只认 Git 令牌+
    // 邮箱,与本部署形态的 launch 需求脱钩(此测试服务无 host,launch
    // 口径人人 ready;issue 口径照实标 carol 未就绪)。管理员不在候选。
    const issueCandidates = await fetch(
      `${base}/auth/collaboration-assignees?flow=issue`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(issueCandidates.status, 200);
    const issueRows = JSON.parse(await issueCandidates.text()) as Array<{
      username: string; ready: boolean; missing: string[];
    }>;
    assert.equal(issueRows.some((row) => row.username === "admin"), false,
      "管理员不能被指派为问题责任人(管理员不写问题会话)");
    assert.deepEqual(issueRows.find((row) => row.username === "alice"), {
      username: "alice", ready: true, missing: [],
    });
    assert.deepEqual(issueRows.find((row) => row.username === "carol"), {
      username: "carol", ready: false,
      missing: ["CodeHub Token", "提交邮箱"],
    }, "问题指派只认 Git 凭据:没配齐就如实标未就绪并点名缺项");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("介入档位:问题处理缺省二档,存取稀疏落盘,需求侧轴不受影响", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-issue-tier-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  // 缺省二档(优先报告),无账号/禁用账号也按缺省。
  assert.equal(auth.issueInterventionTier("alice"), "2");
  assert.equal(auth.issueInterventionTier(undefined), "2");
  // 设一档/三档落盘,重启后保持。
  auth.setIssueInterventionTier("alice", "1");
  assert.equal(auth.issueInterventionTier("alice"), "1");
  auth.setIssueInterventionTier("alice", "3");
  assert.equal(auth.issueInterventionTier("alice"), "3");
  assert.equal(new LocalAuth(file).issueInterventionTier("alice"), "3");
  // 稀疏存储:缺省档删字段,不落显式 "2"。
  auth.setIssueInterventionTier("alice", "2");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as {
    users: Array<{ username: string; issue_intervention_tier?: string }>;
  };
  assert.equal(
    raw.users.find((user) => user.username === "alice")!
      .issue_intervention_tier, undefined);
  // 需求侧月光/过目与档位互不带动。
  auth.setMoonlight("alice", true);
  auth.setPushConfirmation("alice", false);
  assert.equal(auth.moonlightEnabled("alice"), true);
  assert.equal(auth.pushConfirmationEnabled("alice"), false);
  assert.equal(auth.issueInterventionTier("alice"), "2");
  // 非法档位拒绝。
  assert.throws(() => auth.setIssueInterventionTier("alice", "4" as "1"));
});

test("介入档位:v1 账号文件升级不继承——问题处理全员从二档起步", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-issue-tier-mig-"));
  const file = join(dir, "auth.json");
  // 造一份真实 scrypt 哈希,手写 v1 文件(剥离前夜的存量部署快照)。
  const seed = new LocalAuth(join(dir, "seed.json"));
  seed.bootstrapAdmin("admin", "administrator-pass");
  seed.createUser("alice", "alice-password-1", "developer");
  const seedRaw = JSON.parse(readFileSync(join(dir, "seed.json"), "utf-8")) as
    { users: Array<{ username: string; password_hash: string; created_at: string }> };
  const seeded = seedRaw.users.find((user) => user.username === "alice")!;
  writeFileSync(file, JSON.stringify({
    version: 1,
    users: [{
      username: "alice", role: "developer", password_hash: seeded.password_hash,
      created_at: seeded.created_at, disabled: false,
      // 剥离前:需求侧月光开着、过目显式关了。
      moonlight: true, push_confirmation: false,
    }],
  }), { encoding: "utf-8", mode: 0o600 });

  const auth = new LocalAuth(file);
  // 升级不继承:问题处理档位全员缺省二档(ADR-0019 拍板),需求侧原值不动。
  assert.equal(auth.issueInterventionTier("alice"), "2");
  assert.equal(auth.moonlightEnabled("alice"), true);
  assert.equal(auth.pushConfirmationEnabled("alice"), false);
  // 升级即落盘 v2。
  const raw = JSON.parse(readFileSync(file, "utf-8")) as { version: number };
  assert.equal(raw.version, 2);
});

test("介入档位:issue 路由写档位,需求侧轴不动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-issue-tier-routes-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "alice-password-1" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const put = await fetch(`${base}/auth/me/issue-intervention`, {
      method: "PUT", headers: { cookie }, body: JSON.stringify({ tier: "1" }),
    });
    assert.equal(put.status, 200);
    const view = await put.json() as Record<string, unknown>;
    assert.equal(view.issue_intervention_tier, "1");
    assert.equal(view.moonlight, false, "档位不得带动需求侧月光");
    assert.equal(view.push_confirmation, true, "档位不得带动需求侧过目");

    const bad = await fetch(`${base}/auth/me/issue-intervention`, {
      method: "PUT", headers: { cookie }, body: JSON.stringify({ tier: "9" }),
    });
    assert.equal(bad.status, 400, "非法档位拒绝");

    const anon = await fetch(`${base}/auth/me/issue-intervention`, {
      method: "PUT", body: JSON.stringify({ tier: "1" }),
    });
    assert.equal(anon.status, 401, "未登录不得改个人设置");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("个人设置可用已保存 Token 真实测试小鲁班连通性", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-luban-test-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  auth.setLubanToken("alice", "alice-luban-secret");
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
    notifier: new Notifier({
      endpoint: luban.endpoint,
      personalToken: (account) => auth.lubanToken(account),
    }),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const unauthenticated = await fetch(`${base}/auth/me/luban-test`, {
      method: "POST",
    });
    assert.equal(unauthenticated.status, 401);

    const bob = await login("bob", "bob-password-123");
    const missing = await fetch(`${base}/auth/me/luban-test`, {
      method: "POST", headers: { cookie: bob },
    });
    assert.equal(missing.status, 409);
    assert.match(await missing.text(), /请先保存小鲁班 Token/);

    const alice = await login("alice", "alice-password-1");
    const tested = await fetch(`${base}/auth/me/luban-test`, {
      method: "POST", headers: { cookie: alice },
    });
    assert.equal(tested.status, 200);
    assert.deepEqual(await tested.json(), {
      ok: true,
      message: "测试消息已发送，请在小鲁班中确认是否收到。",
    });
    assert.equal(luban.messages.length, 1);
    assert.equal(luban.messages[0].account, "alice");
    assert.equal(luban.requestHeaders[0]["x-mfc-luban-token"],
      encodeURIComponent("alice-luban-secret"));

    luban.failFirst = 1;
    const failed = await fetch(`${base}/auth/me/luban-test`, {
      method: "POST", headers: { cookie: alice },
    });
    assert.equal(failed.status, 502);
    const failureText = await failed.text();
    assert.match(failureText, /测试消息未送达（HTTP 500）/);
    assert.doesNotMatch(failureText, /alice-luban-secret/,
      "测试失败响应不得回显个人 Token");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await luban.stop();
  }
});

test("HTTP 登录:开发看全部任务,创建归自己,不能操作别人任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"),
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const bob = await login("bob", "bob-password-123");
    const createdResponse = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { cookie: bob },
      body: JSON.stringify({
        requirement: "Bob 的任务",
        account: "alice",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await readJson(createdResponse) as {
      id: string;
      luban_account: string;
    };
    assert.equal(created.luban_account, "bob", "开发不能把任务冒领给别人");

    const alice = await login("alice", "alice-password-1");
    const list = await fetch(`${base}/tasks`, {
      headers: { cookie: alice },
    });
    assert.equal(list.status, 200, "开发可查看团队全部任务");
    assert.equal((await readJson(list) as unknown[]).length, 1);

    // 这个权限测试用的是纯会话部署（按产品约束不能从 HTTP 下代码仓单），
    // 因而直接种一张跨仓摘要，只验证多人协作的 HTTP 权限边界。
    const cross = service.create("Bob 发起的跨仓主任务", { account: "bob" });
    const crossState = (service as any).tasks.get(cross.id);
    crossState.summary.repositories = [
      "https://codehub/team/api.git", "https://codehub/team/web.git",
    ];
    crossState.summary.requirement_graph = {
      stage: "analysis",
      repositories: [
        { id: "api", name: "api", url: "https://codehub/team/api.git" },
        { id: "web", name: "web", url: "https://codehub/team/web.git" },
      ],
      dependencies: [],
    };
    const invite = await fetch(`${base}/tasks/${cross.id}/collaborators`, {
      method: "PUT",
      headers: { cookie: bob },
      body: JSON.stringify({ collaborators: ["alice"] }),
    });
    assert.equal(invite.status, 200);
    assert.deepEqual((await readJson(invite) as { collaborators: string[] })
      .collaborators, ["alice"]);
    crossState.summary.status = "running";
    let steered = "";
    crossState.driver = { steer: async (text: string) => { steered = text; } };
    const collaborate = await fetch(`${base}/tasks/${cross.id}/interrupt`, {
      method: "POST",
      headers: { cookie: alice },
      body: JSON.stringify({ text: "接口字段还需要一起确认" }),
    });
    assert.equal(collaborate.status, 200,
      "受邀开发者可以进入同一个主任务和 AI 讨论");
    assert.match(steered, /协作者 alice 插话.*接口字段还需要一起确认/,
      "插话前缀只标身份;\"跨仓协作\"标签曾污染单仓任务的交付件(MFC-021)");
    // 受邀参与讨论的人可以答卡(2026-09-04 用户拍板)。这张假现场没有
    // 待办:过了权限闸落到 404,而不是被 403 挡在门外。
    const participantDecision = await fetch(
      `${base}/tasks/${cross.id}/decision`, {
        method: "POST", headers: { cookie: alice },
        body: JSON.stringify({ state_version: 1, decision: "需要修改" }),
      });
    assert.equal(participantDecision.status, 404,
      "受邀参与讨论的人过权限闸(无待办→404,不是 403)");
    const collaboratorCannotInvite = await fetch(
      `${base}/tasks/${cross.id}/collaborators`, {
        method: "PUT", headers: { cookie: alice },
        body: JSON.stringify({ collaborators: [] }),
      });
    assert.equal(collaboratorCannotInvite.status, 403,
      "共同开发者不能改写主任务团队边界");

    const forbidden = await fetch(
      `${base}/tasks/${created.id}/decision`,
      {
        method: "POST",
        headers: { cookie: alice },
        body: JSON.stringify({ state_version: 1, decision: "通过" }),
      },
    );
    assert.equal(forbidden.status, 403);

    const forbiddenPause = await fetch(
      `${base}/tasks/${created.id}/pause`, {
        method: "POST", headers: { cookie: alice },
      });
    assert.equal(forbiddenPause.status, 403,
      "普通开发不能暂停别人的任务");
    const ownerPause = await fetch(
      `${base}/tasks/${created.id}/pause`, {
        method: "POST", headers: { cookie: bob },
      });
    assert.equal(ownerPause.status, 200);
    assert.equal((await ownerPause.json() as { status: string }).status, "paused");
    const admin = await login("admin", "administrator-pass");
    const adminResume = await fetch(
      `${base}/tasks/${created.id}/resume`, {
        method: "POST", headers: { cookie: admin },
      });
    assert.equal(adminResume.status, 200, "管理员可兜底恢复任务");

    const users = await fetch(`${base}/auth/users`, {
      headers: { cookie: alice },
    });
    assert.equal(users.status, 403, "普通开发不能管理账号");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("管理员特权:免旧密码重置 + 删号;底线是删自己/末位管理员/越权", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-admin-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200, `${username} 登录该成功`);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const alice = await login("alice", "alice-password-1");
    const admin = await login("admin", "administrator-pass");

    // 越权先堵死:开发既不能重置别人密码,也不能删号。
    const stolen = await fetch(`${base}/auth/users/bob/password`, {
      method: "PUT", headers: { cookie: alice },
      body: JSON.stringify({ password: "hacked-password-1" }),
    });
    assert.equal(stolen.status, 403);
    const stab = await fetch(`${base}/auth/users/bob`, {
      method: "DELETE", headers: { cookie: alice },
    });
    assert.equal(stab.status, 403);

    // 管理员免旧密码重置:旧密码作废、旧会话下线、新密码可登录。
    const reset = await fetch(`${base}/auth/users/alice/password`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ password: "alice-new-pass-9" }),
    });
    assert.equal(reset.status, 200);
    const staleSession = await fetch(`${base}/auth/me`, {
      headers: { cookie: alice },
    });
    assert.equal(staleSession.status, 401, "重置后旧会话必须下线");
    const oldLogin = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "alice-password-1" }),
    });
    assert.equal(oldLogin.status, 401, "旧密码必须作废");
    await login("alice", "alice-new-pass-9");
    // 弱密码照旧被同一套校验拦住,特权不豁免长度底线。
    const weak = await fetch(`${base}/auth/users/alice/password`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ password: "short" }),
    });
    assert.equal(weak.status, 400);

    // 删号:人没了,登录当然也没了;名单如实收缩。
    const removed = await fetch(`${base}/auth/users/bob`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(removed.status, 200);
    const ghost = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "bob-password-123" }),
    });
    assert.equal(ghost.status, 401);
    const reused = await fetch(`${base}/auth/users`, {
      method: "POST", headers: { cookie: admin },
      body: JSON.stringify({
        username: "bob", password: "different-person-1", role: "developer",
      }),
    });
    assert.equal(reused.status, 400,
      "删除后的同名账号不能重建，否则会继承旧任务操作权");
    assert.match(await reused.text(), /不能同名重建/);
    const restoredAfterDelete = new LocalAuth(join(dir, "auth.json"));
    assert.throws(() => restoredAfterDelete.createUser(
      "bob", "different-person-1", "developer"), /不能同名重建/,
    "用户名墓碑必须跨服务重启保留");
    const roster = await fetch(`${base}/auth/users`, {
      headers: { cookie: admin },
    });
    assert.deepEqual(
      (await readJson(roster) as Array<{ username: string }>)
        .map((user) => user.username).sort(),
      ["admin", "alice"]);

    // 两条底线:不能删自己;不能删掉最后一个管理员。
    const suicide = await fetch(`${base}/auth/users/admin`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(suicide.status, 400, "不能删除自己");
    auth.createUser("admin2", "second-admin-pass", "admin");
    const admin2 = await login("admin2", "second-admin-pass");
    const removeAdmin = await fetch(`${base}/auth/users/admin`, {
      method: "DELETE", headers: { cookie: admin2 },
    });
    assert.equal(removeAdmin.status, 200, "还有别的管理员时可以删管理员");
    const lastStand = await fetch(`${base}/auth/users/admin2`, {
      method: "DELETE", headers: { cookie: admin2 },
    });
    assert.equal(lastStand.status, 400, "最后一个管理员必须删不掉");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Committer 检视:管理员只配名单,仅任务责任人主动邀请后才通知", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-review-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  // 接了通知端点的部署,下单前要求本人配过通知令牌(消息以本人身份
  // 发,管理员代配不了)——这里是走产品面下单,规矩照吃。
  auth.setLubanToken("alice", "luban-alice");
  const luban = new FakeLubanServer();
  await luban.start();
  const tokenLookups: string[] = [];
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
    notifier: new Notifier({
      endpoint: luban.endpoint,
      backoffMs: [0],
      personalToken: (account) => {
        tokenLookups.push(account);
        return auth.lubanToken(account);
      },
    }),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const admin = await login("admin", "administrator-pass");
    const alice = await login("alice", "alice-password-1");
    const bob = await login("bob", "bob-password-123");
    const configured = await fetch(`${base}/auth/users/bob/committer`, {
      method: "PUT", headers: { cookie: admin }, body: JSON.stringify({ on: true }),
    });
    assert.equal(configured.status, 200);
    assert.equal((await configured.json() as { committer?: boolean }).committer, true);

    const committers = await fetch(`${base}/auth/committers`, {
      headers: { cookie: alice },
    });
    assert.equal(committers.status, 200, "普通开发可读取可选检视人");
    assert.deepEqual(await committers.json(), [
      { username: "bob", role: "developer", committer: true },
    ]);

    const createdResponse = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: alice },
      body: JSON.stringify({ requirement: "实现订单检索" }),
    });
    const created = await createdResponse.json() as { id: string };
    assert.equal(luban.messages.filter((message) => message.account === "bob").length, 0,
      "配置 Committer 后创建任务仍不会自动通知他；需求确认只通知责任人");

    const adminCannotInvite = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: admin },
        body: JSON.stringify({ committer: "bob" }),
      });
    assert.equal(adminCannotInvite.status, 403,
      "管理员不能替责任人主动发起检视");
    const otherDeveloperCannotInvite = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: bob },
        body: JSON.stringify({ committer: "bob" }),
      });
    assert.equal(otherDeveloperCannotInvite.status, 403);

    const invalid = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: alice },
        body: JSON.stringify({ committer: "admin" }),
      });
    assert.equal(invalid.status, 400, "只能选择管理员配置的 Committer");
    assert.equal(luban.messages.filter((message) => message.account === "bob").length, 0);

    const invited = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: {
          cookie: alice,
          // 后端 Host 即使是回环地址，也必须以浏览器实际访问的内网
          // Origin 为准；部署无需把某台机器 IP 硬编码进代码或启动项。
          origin: "http://mae-flow.intra:8787",
          "x-forwarded-host": "127.0.0.1:8787",
        },
        body: JSON.stringify({ committer: "bob" }),
    });
    assert.equal(invited.status, 200);
    const review = await invited.json() as {
      id: string; delivered: boolean; status: string;
    };
    assert.equal(review.delivered, true);
    assert.equal(review.status, "pending");
    const reviewMessages = luban.messages.filter((message) =>
      message.account === "bob");
    assert.equal(reviewMessages.length, 1);
    const reviewMessage = reviewMessages[0];
    assert.deepEqual([...new Set(tokenLookups)], ["alice"],
      "用责任人的发送 Token 投给 Committer 工号，收件人无需配置 Token");
    assert.equal(reviewMessage.text,
      `【Mae-Flow】任务 ${created.id} 邀请你检视：实现订单检索\n`
      + "手机端操作：先输入“/mfc”激活 Mae-Flow 插件；"
      + "未激活时，直接回复本消息不会进入 Mae-Flow。");
    assert.equal(reviewMessage.link,
      `http://mae-flow.intra:8787/work/${created.id}/review/${review.id}`,
      "未配置 public-url 时按浏览器实际访问的内网 Origin 生成链接");

    // 回环地址不许污染学到的入口:管理员在服务器本机(或 SSH 隧道,
    // Host 就是 127.0.0.1)登录一次,不能把之后所有人的通知链接带沟里
    // ——内网实锤过"邀请检视发的是 127.0.0.1,别人点不开"。
    await fetch(`${base}/tasks`, {
      headers: { cookie: admin, origin: "http://127.0.0.1:8787" },
    });
    const reinvited = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: alice },
        body: JSON.stringify({ committer: "bob" }),
      });
    assert.equal(reinvited.status, 200);
    const latestReviewMessage = luban.messages.filter((message) =>
      message.account === "bob").at(-1)!;
    assert.match(String(latestReviewMessage.link),
      /^http:\/\/mae-flow\.intra:8787\//,
      "回环访问之后,通知链接仍是此前学到的内网地址");

    const inbox = await fetch(`${base}/reviews/mine`, {
      headers: { cookie: bob },
    });
    assert.equal(inbox.status, 200);
    assert.equal((await inbox.json() as Array<{ id: string }>)[0].id, review.id,
      "通知之外还有持久化的待我检视收件箱");
    const adminCannotComplete = await fetch(
      `${base}/reviews/${review.id}/complete`, {
        method: "POST", headers: { cookie: admin },
      });
    assert.equal(adminCannotComplete.status, 403);
    const completed = await fetch(
      `${base}/reviews/${review.id}/complete`, {
        method: "POST", headers: { cookie: bob },
      });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json() as { status: string }).status, "completed");

    const afterRestart = new TaskService({
      dataDir: join(dir, "tasks"), provider: "test", model: "test",
      modelsJson: {}, maxConcurrent: 0,
    });
    assert.equal(afterRestart.listReviewsFor("bob")[0]?.status, "completed",
      "检视记录与完成状态跨进程保留");

    const restored = new LocalAuth(join(dir, "auth.json"));
    assert.equal(restored.listUsers().find((user) => user.username === "bob")
      ?.committer, true, "Committer 名单持久化");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await luban.stop();
  }
});
