/**
 * 运行时设置(管理页后端)的契约:
 * - 密钥只写不读:view() 永远掩码,API 不回明文——这是后面 Git token
 *   等一切密钥的模板,这里破例一次,后面全线泄漏;
 * - 覆盖语义:设置压过部署值,消费点即时读(并发/修复轮/模型);
 * - 读坏 fail-open 回部署值(它是旁路覆盖,不许挡服务);
 * - 路由权限:admin 才能改,开发成员 403。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RuntimeSettings, SettingsError } from "../src/settings.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

function store(): RuntimeSettings {
  return new RuntimeSettings(mkdtempSync(join(tmpdir(), "mfc-set-")));
}

test("模型密钥只写不读:视图永远掩码,明文只进 0600 的文件", () => {
  const settings = store();
  settings.updateModels({
    url: "http://gw", api_key: "sk-live-abcd4321", model: "glm-5.1",
  });

  const view = JSON.stringify(settings.view());
  assert.ok(!view.includes("sk-live-abcd4321"), "apiKey 明文漏进视图");
  assert.match(view, /••••4321/);
  // 明文在文件里(权限 600),消费点读得到;接口格式默认 OpenAI Chat
  // (2026-08-26 拍板),显式选了才写 Anthropic。
  const provider = (settings.models().json as any).providers.maeflow;
  assert.equal(provider.api, "openai-completions",
    "三项表单未指定格式时应落默认 OpenAI Chat");
  assert.equal(settings.view().models.api, "openai-completions",
    "视图要回显接口格式给表单");
  assert.equal(provider.models[0].id, "glm-5.1");
  settings.updateModels({ url: "http://gw-v2", api_key: "", model: "glm-5.2" });
  assert.equal((settings.models().json as any).providers.maeflow.apiKey,
    "sk-live-abcd4321", "编辑时 API Key 留空应保留原密钥");
  assert.equal((settings.models().json as any).providers.maeflow.api,
    "openai-completions", "未送 api 字段时沿用已存格式");
});

test("接口格式:显式 Anthropic 可选,非法值当场拒绝", () => {
  const settings = store();
  settings.updateModels({
    url: "http://gw", api_key: "sk-1", model: "m-1",
    api: "anthropic-messages",
  });
  assert.equal((settings.models().json as any).providers.maeflow.api,
    "anthropic-messages");
  // 已存 Anthropic 的配置,表单没送 api 再存一次:不惊扰老格式
  settings.updateModels({ url: "http://gw", api_key: "", model: "m-2" });
  assert.equal((settings.models().json as any).providers.maeflow.api,
    "anthropic-messages", "老配置的格式在无 api 字段保存时保留");
  assert.throws(() => settings.updateModels({
    url: "http://gw", api_key: "sk-1", model: "m-1", api: "google-generative-ai",
  }), /接口格式只能是/);
});

test("图片识别角色独立保存，主模型与视觉模型互不覆盖", () => {
  const settings = store();
  settings.updateModels({
    url: "http://main-gw", api_key: "main-secret-1111", model: "glm-main",
  });
  settings.updateVision({
    url: "http://vision-gw/v1", api_key: "vision-secret-2222",
    model: "glm-5.3-flash", api: "openai-completions",
  });
  let stored = settings.models() as any;
  assert.equal(stored.provider, "maeflow");
  assert.equal(stored.model, "glm-main");
  assert.equal(stored.vision.provider, "maeflow-vision");
  assert.deepEqual(stored.json.providers["maeflow-vision"].models[0].input,
    ["text", "image"]);

  settings.updateModels({
    url: "http://main-gw-v2", api_key: "", model: "glm-main-v2",
  });
  stored = settings.models() as any;
  assert.equal(stored.json.providers["maeflow-vision"].apiKey,
    "vision-secret-2222", "修改主模型不能删掉视觉 provider");
  const view = JSON.stringify(settings.view());
  assert.doesNotMatch(view, /vision-secret-2222|main-secret-1111/);
  assert.match(view, /••••2222/);
});

test("图片识别可复用部署 provider，保存后仍保留主模型与部署密钥", () => {
  const settings = store();
  const base = { providers: { glm: {
    baseUrl: "http://shared-gw", api: "anthropic-messages",
    apiKey: "deployment-secret-4444",
    models: [{ id: "glm-main" },
      { id: "glm-5.3-flash", input: ["text", "image"] }],
  } } };
  settings.updateVision({
    url: "http://shared-gw", api_key: "", model: "glm-5.3-flash",
    api: "anthropic-messages", base_json: base,
    base_vision: { provider: "glm", model: "glm-5.3-flash" },
  });
  const stored = settings.models() as any;
  assert.equal(stored.vision.provider, "glm");
  assert.equal(stored.json.providers.glm.apiKey, "deployment-secret-4444");
  assert.deepEqual(stored.json.providers.glm.models.map((item: any) => item.id),
    ["glm-main", "glm-5.3-flash"]);
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-set-shared-provider-")),
    provider: "glm", model: "glm-main", modelsJson: base, settings,
    vision: { provider: "glm", model: "glm-5.3-flash" },
  });
  assert.deepEqual(service.launchOptions().model,
    { provider: "glm", model: "glm-main" });
});

test("数值校验:无限等待没有语法;models 必须真实存在才能选", () => {
  const settings = store();
  assert.throws(() => settings.updateRuntime({ repair_rounds: -1 }),
    SettingsError);
  assert.throws(() => settings.updateRuntime({ poll_interval_s: "abc" }),
    SettingsError);
  settings.updateRuntime({
    build_cache_retention_days: 21,
    build_cache_max_gb: 80,
  });
  assert.equal(settings.runtime().build_cache_retention_days, 21);
  assert.equal(settings.runtime().build_cache_max_gb, 80);
  // 问题单并发数:≥1 的整数,现读现判(问题流泵每次启动时读取)。
  settings.updateRuntime({ issue_max_turns: 5 });
  assert.equal(settings.runtime().issue_max_turns, 5);
  assert.throws(() => settings.updateRuntime({ issue_max_turns: 0 }),
    /问题单并发/);
  assert.throws(() => settings.updateRuntime({ issue_max_turns: "abc" }),
    /问题单并发/);
  assert.throws(() => settings.updateRuntime({ build_cache_max_gb: -1 }),
    /构建缓存容量上限/);
  assert.throws(() => settings.updateModels({ provider: "gpt" }),
    /先提供 models.json/);
  assert.throws(() => settings.updateModels({
    json: { providers: { glm: { models: [{ id: "glm-5.1" }] } } },
    provider: "glm", model: "no-such",
  }), /没有模型 no-such/);
});

test("问题单环境预热开关只接受 0/1，支持持久保存和恢复默认", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-set-warmup-"));
  const settings = new RuntimeSettings(dataDir);
  assert.equal(settings.runtime().issue_warmup_enabled, undefined);

  settings.updateRuntime({ issue_warmup_enabled: 1 });
  settings.updateRuntime({ issue_max_turns: 3 });
  assert.equal(settings.runtime().issue_warmup_enabled, 1,
    "更新其他参数不能覆盖预热开关");
  assert.equal(new RuntimeSettings(dataDir).runtime().issue_warmup_enabled, 1,
    "重启后保留管理员设置");

  for (const invalid of [-1, 2, 0.5, "true", "2", true, false, [], {}]) {
    assert.throws(() => settings.updateRuntime({ issue_warmup_enabled: invalid }),
      /问题单环境预热开关只能是 0 或 1/);
    assert.equal(settings.runtime().issue_warmup_enabled, 1,
      "非法更新不能改写已有设置");
  }
  settings.updateRuntime({ issue_warmup_enabled: "0" });
  assert.equal(settings.runtime().issue_warmup_enabled, 0);
  settings.updateRuntime({ issue_warmup_enabled: "1" });
  assert.equal(settings.runtime().issue_warmup_enabled, 1);
  settings.updateRuntime({ issue_warmup_enabled: "" });
  assert.equal(new RuntimeSettings(dataDir).runtime().issue_warmup_enabled,
    undefined, "留空清除覆盖，使用服务默认值");
});

test("团队执行约定只影响新任务，并与任务补充按层固定", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-set-policy-"));
  const settings = new RuntimeSettings(dataDir);
  settings.updateExecutionPolicy({
    team_instructions: "公共契约变化要点名影响方",
  });
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    settings,
  });
  const first = service.create("调整接口", {
    taskInstructions: "先核对旧客户端",
  });
  const firstSupplements = first.workflow_profile?.supplements ?? [];
  assert.deepEqual(firstSupplements.map((item) => item.scope),
    ["team", "task"]);
  assert.equal(firstSupplements[0].instructions, "公共契约变化要点名影响方");

  settings.updateExecutionPolicy({ team_instructions: "新团队约定" });
  const second = service.create("另一个任务");
  assert.equal((first.workflow_profile?.supplements ?? [])[0].instructions,
    "公共契约变化要点名影响方", "运行中/历史任务不得随设置漂移");
  assert.equal((second.workflow_profile?.supplements ?? [])[0].instructions,
    "新团队约定");
  assert.throws(() => settings.updateExecutionPolicy({
    team_instructions: "x".repeat(2001),
  }), /团队执行约定不能超过 2000/);
});

test("旧版服务形态配置自动忽略:部署链路不再从管理页覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-set-old-repo-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    service: { default_repo: "https://codehub/old.git", platform_url: "http://git" },
  }));
  const settings = new RuntimeSettings(dir);
  assert.ok(!JSON.stringify(settings.view()).includes("service"));
});

test("读坏 fail-open:settings.json 损坏按无覆盖处理,不挡服务", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-set-"));
  writeFileSync(join(dir, "settings.json"), "{ 坏掉的");
  const settings = new RuntimeSettings(dir);
  assert.deepEqual(settings.runtime(), {});
  // 坏文件之上还能正常写入恢复
  settings.updateRuntime({ repair_rounds: 3 });
  assert.equal(settings.runtime().repair_rounds, 3);
});

const SCRIPT: Scene[] = [{ text: "完成。" }];

test("模型热改:下一个新会话用设置里的网关,部署值退位", async () => {
  // 部署给的是一个连不上的假地址;设置覆盖成真剧本服务器。
  // 任务能收口 = launch 写 agentDir/models.json 时读的是设置。
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-set-run-"));
  const settings = new RuntimeSettings(dataDir);
  settings.updateModels({
    json: model.modelsJson(),
    provider: "maeflow",
    model: "scripted-v1",
  });
  const service = new TaskService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: { providers: { maeflow: {
      baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
      apiKey: "dead", models: [{ id: "scripted-v1" }],
    } } },
    settings,
  });
  const id = service.create("验证模型热改").id;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  assert.equal(service.get(id)!.status, "completed",
    service.get(id)!.detail ?? "");
  await model.stop();
});

test("路由权限:admin 可读改,开发成员 403,密钥不出网", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-set-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const settings = new RuntimeSettings(dataDir);
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), settings,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return String(response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  try {
    const admin = await login("admin", "admin-password-1");
    const dev = await login("dev", "dev-password-11");

    const anonymousTiming = await fetch(`${base}/browser-timing`, { method: "POST", body: JSON.stringify({ entries: [] }) });
    assert.equal(anonymousTiming.status, 401);
    const timing = await fetch(`${base}/browser-timing`, { method: "POST", headers: { cookie: dev },
      body: JSON.stringify({ entries: [{ kind: "longtask", duration_ms: 350 }] }) });
    assert.equal(timing.status, 204, "已登录成员可上报经过白名单过滤的耗时");

    const denied = await fetch(`${base}/settings`, {
      headers: { cookie: dev } });
    assert.equal(denied.status, 403);
    const deniedCheck = await fetch(`${base}/settings/check`, {
      headers: { cookie: dev } });
    assert.equal(deniedCheck.status, 403, "部署自检也只允许管理员查看");

    const initialSettings = await fetch(`${base}/settings`, {
      headers: { cookie: admin },
    }).then((response) => response.json()) as {
      defaults: { runtime: { issue_warmup_enabled: number;
        issue_build_products_cooldown_hours: number } };
    };
    assert.equal(initialSettings.defaults.runtime.issue_warmup_enabled, 0,
      "管理页默认关闭问题单环境预热");
    assert.equal(initialSettings.defaults.runtime.issue_build_products_cooldown_hours,
      24, "管理页与实际清理策略采用同一个 24 小时默认值");
    const deniedWarmup = await fetch(`${base}/settings/runtime`, {
      method: "PUT", headers: { cookie: dev },
      body: JSON.stringify({ issue_warmup_enabled: 1 }),
    });
    assert.equal(deniedWarmup.status, 403);
    const enabledWarmup = await fetch(`${base}/settings/runtime`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ issue_warmup_enabled: 1 }),
    });
    assert.equal(enabledWarmup.status, 200);
    const enabledView = await enabledWarmup.json() as {
      runtime: { issue_warmup_enabled: number };
    };
    assert.equal(enabledView.runtime.issue_warmup_enabled, 1);
    const invalidWarmup = await fetch(`${base}/settings/runtime`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ issue_warmup_enabled: 2 }),
    });
    assert.equal(invalidWarmup.status, 400);
    assert.equal(settings.runtime().issue_warmup_enabled, 1);

    const checked = await fetch(`${base}/settings/check`, {
      headers: { cookie: admin },
    });
    assert.equal(checked.status, 200);
    const checkBody = await checked.json() as {
      overall: string;
      items: Array<{ key: string; status: string }>;
    };
    assert.ok(["ok", "warning", "error"].includes(checkBody.overall));
    assert.deepEqual(checkBody.items.map((item) => item.key),
      ["runtime", "data", "model", "vision", "notify", "link", "postgres", "git", "prepush",
       "container"]);
    assert.equal(checkBody.items.find((item) => item.key === "model")?.status,
      "ok");
    // 通知链接地址:未配 --public-url、也没人从内网地址访问过 → 警告
    // 并说清两条出路(内网实锤:回环入口发出去的邀请别人打不开)。
    const link = checkBody.items.find((item) => item.key === "link")!;
    assert.equal(link.status, "warning");

    const put = await fetch(`${base}/settings/models`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({
        url: "http://model.internal",
        api_key: "secret-9999",
        model: "glm-5.1",
      }),
    });
    assert.equal(put.status, 200);
    const body = await fetch(`${base}/settings`, {
      headers: { cookie: admin } }).then((r) => r.text());
    assert.ok(!body.includes("secret-9999"), "明文密钥出网了");
    assert.match(body, /••••9999/);

    const visionPut = await fetch(`${base}/settings/vision`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({
        url: model.baseUrl,
        api_key: "vision-secret-3333",
        model: "scripted-v1",
        api: "anthropic-messages",
      }),
    });
    assert.equal(visionPut.status, 200);
    const visionView = await visionPut.text();
    assert.doesNotMatch(visionView, /vision-secret-3333/);
    assert.match(visionView, /••••3333/);
    const policyPut = await fetch(`${base}/settings/execution-policy`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ team_instructions: "不确定时明确说明，不要猜" }),
    });
    assert.equal(policyPut.status, 200);
    const policyView = await policyPut.json() as {
      execution_policy: { team_instructions?: string };
    };
    assert.equal(policyView.execution_policy.team_instructions,
      "不确定时明确说明，不要猜");
    // v1 团队阶段勾选定制已退役:老客户端还传就明确打回并指路,
    // 绝不静默吞掉让人以为配置生效了。
    const retiredPolicy = await fetch(`${base}/settings/execution-policy`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ stage_customizations: [{
        playbook_id: "platform.made-up",
        optional_activities: ["skip-all-gates"],
      }] }),
    });
    assert.equal(retiredPolicy.status, 400);
    assert.match(await retiredPolicy.text(), /已退役.*工作流资产/);
    const visionTest = await fetch(`${base}/settings/vision/test`, {
      method: "POST", headers: { cookie: admin },
    });
    assert.equal(visionTest.status, 200);
    const visionTestBody = await visionTest.json() as { status: string };
    assert.equal(visionTestBody.status, "failed",
      "假模型没识别色块时必须判失败，不能只凭 HTTP 200 宣称就绪");
    assert.ok(model.requests.some((request: any) =>
      request.messages?.some((message: any) =>
        message.content?.some?.((block: any) => block.type === "image"))));

    const deniedCache = await fetch(`${base}/settings/build-cache`, {
      headers: { cookie: dev },
    });
    assert.equal(deniedCache.status, 403);
    const cache = await fetch(`${base}/settings/build-cache`, {
      headers: { cookie: admin },
    });
    assert.equal(cache.status, 200);
    assert.equal((await cache.json() as { configured: boolean }).configured, false);
    const reclaimed = await fetch(`${base}/settings/build-cache/reclaim`, {
      method: "POST", headers: { cookie: admin },
      body: JSON.stringify({ all_unused: true }),
    });
    assert.equal(reclaimed.status, 200);
    assert.equal((await reclaimed.json() as { reclaimed: number }).reclaimed, 0);

    const bad = await fetch(`${base}/settings/runtime`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ repair_rounds: -5 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    await model.stop();
  }
});
