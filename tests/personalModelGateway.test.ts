/**
 * 个人模型网关(ADR-0068)契约:
 * - 解析规则:归属人四字段配齐→其名下任务的模型调用整体换装个人网关;
 *   未配/残缺 fail-open 走平台并出一行日志;任务级 model_choice 让位;
 * - 视觉绑定不换装:平台 vision 的 provider 条目并入个人现场 json,
 *   个人通道会话照样能解析出视觉模型;
 * - 密钥纪律与个人令牌(Git/小鲁班)同款:明文只进 0600 的 auth.json,
 *   视图永远掩码;留空=沿用已存,四字段全空/clear=删除回落平台;
 * - 端点:PUT /auth/me/models 谁登录配谁(非 admin 可用),
 *   POST /auth/me/models/check 只测本人配置(草稿>已存),无部署层兜底;
 * - Beta 网关(ADR-0039)已退役:settings 不再有 models_beta,端点 404,
 *   存量 settings.json 残留的 beta 键读取时自然忽略。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { RuntimeSettings, type ModelsSettings } from "../src/settings.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { resolveModelConfig } from "../src/modelResolution.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

const PERSONAL_KEY = "sk-personal-abcd4321";

function personalConfig(overrides: {
  url?: string; apiKey?: string; model?: string;
} = {}): ModelsSettings {
  const model = overrides.model ?? "personal-max";
  return {
    provider: "maeflow-personal",
    model,
    json: { providers: { "maeflow-personal": {
      baseUrl: overrides.url ?? "http://personal-gw",
      api: "anthropic-messages",
      apiKey: overrides.apiKey ?? PERSONAL_KEY,
      models: [{ id: model }],
    } } },
  };
}

function store(): RuntimeSettings {
  return new RuntimeSettings(mkdtempSync(join(tmpdir(), "mfc-personal-")));
}

const DEPLOYMENT = {
  modelsJson: { providers: { maeflow: {
    baseUrl: "http://deploy-gw", api: "openai-completions",
    apiKey: "sk-deploy", models: [{ id: "scripted-v1" }],
  } } },
  provider: "maeflow",
  model: "scripted-v1",
};

test("解析器:配齐即整体换装个人网关,平台配置与部署参数不掺和", () => {
  const settings = store();
  settings.updateModels({
    url: "http://platform-gw", api_key: "sk-platform", model: "glm-5.1",
  });
  const resolved = resolveModelConfig({
    settings, deployment: DEPLOYMENT,
    personal: personalConfig(), operator: "张三",
  });
  assert.equal(resolved.lane, "personal");
  assert.equal(resolved.provider, "maeflow-personal");
  assert.equal(resolved.model, "personal-max");
  const spec = (resolved.json as any).providers["maeflow-personal"];
  assert.equal(spec.baseUrl, "http://personal-gw");
  assert.equal(spec.apiKey, PERSONAL_KEY,
    "个人通道会话的现场 json 必须带本人的密钥");
  assert.ok(!("maeflow" in (resolved.json as any).providers),
    "平台网关的 provider 不该整目录带进个人现场");
});

test("解析器:个人网关未传/未配=平台口径(无归属的调用照旧)", () => {
  const settings = store();
  settings.updateModels({
    url: "http://platform-gw", api_key: "sk-platform", model: "glm-5.1",
  });
  for (const personal of [undefined, null]) {
    const resolved = resolveModelConfig({
      settings, deployment: DEPLOYMENT,
      ...(personal !== undefined ? { personal } : {}),
      operator: "张三",
    });
    assert.equal(resolved.lane, "platform");
    assert.equal(resolved.model, "glm-5.1");
  }
  const noOperator = resolveModelConfig({ settings, deployment: DEPLOYMENT });
  assert.equal(noOperator.lane, "platform");
  assert.deepEqual(noOperator.json, settings.models().json);
});

test("解析器:配置残缺 fail-open 走平台,并出一行日志", () => {
  const settings = store();
  // 残缺口味一:providers 里没有 apiKey。
  const noKey = personalConfig({ apiKey: "" });
  // 残缺口味二:model 不在 provider 目录里。
  const noModel = personalConfig();
  noModel.model = "not-listed";
  for (const broken of [noKey, noModel]) {
    const logs: string[] = [];
    const resolved = resolveModelConfig({
      settings, deployment: DEPLOYMENT, personal: broken, operator: "张三",
      log: (message) => logs.push(message),
    });
    assert.equal(resolved.lane, "platform");
    assert.equal(logs.length, 1, "残缺回落只出一行日志");
    assert.match(logs[0], /fail-open/);
  }
});

test("解析器:平台 vision 的 provider 条目并入个人现场 json,视觉绑定不换装", () => {
  const settings = store();
  settings.updateModels({
    url: "http://platform-gw", api_key: "sk-platform", model: "glm-5.1",
  });
  settings.updateVision({
    url: "http://vision-gw", api_key: "sk-vision", model: "vision-1",
    api: "openai-completions",
  });
  const resolved = resolveModelConfig({
    settings, deployment: DEPLOYMENT,
    personal: personalConfig(), operator: "张三",
  });
  assert.equal(resolved.lane, "personal");
  const visionSpec = (resolved.json as any).providers["maeflow-vision"];
  assert.ok(visionSpec, "个人现场 json 必须含平台 vision provider");
  assert.equal(visionSpec.apiKey, "sk-vision");
  assert.ok(visionSpec.models.some((item: any) => item.id === "vision-1"));
});

test("解析器:换装不改传入配置对象(深拷贝纪律)", () => {
  const settings = store();
  const personal = personalConfig();
  const before = JSON.stringify(personal);
  resolveModelConfig({ settings, deployment: DEPLOYMENT, personal, operator: "张三" });
  resolveModelConfig({ settings, deployment: DEPLOYMENT, personal, operator: "张三" });
  assert.equal(JSON.stringify(personal), before);
});

test("存储:四字段保存/留空沿用密钥/清空回落,重启仍在 0600 文件里", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-personal-auth-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("zhang", "zhang-password-1", "developer");

  auth.setPersonalModels("zhang", {
    url: "http://personal-gw", api_key: PERSONAL_KEY,
    model: "personal-max", api: "anthropic-messages",
  });
  // 消费口拿到完整配置(解析器用),密钥在 json 里。
  const stored = auth.personalModels("zhang");
  assert.equal(stored?.provider, "maeflow-personal");
  assert.equal(stored?.model, "personal-max");
  assert.equal(
    (stored?.json as any).providers["maeflow-personal"].apiKey,
    PERSONAL_KEY);
  // 密钥留空=沿用已存(界面永远不回填明文)。
  auth.setPersonalModels("zhang", {
    url: "http://personal-gw-v2", api_key: "",
    model: "personal-max", api: "anthropic-messages",
  });
  assert.equal(
    (auth.personalModels("zhang")?.json as any)
      .providers["maeflow-personal"].apiKey,
    PERSONAL_KEY, "编辑时 API Key 留空应保留原密钥");
  // 掩码视图:是否已配、url/model/api 明文、密钥只回末 4 位。
  assert.deepEqual(auth.personalModelsView("zhang"), {
    configured: true,
    url: "http://personal-gw-v2",
    model: "personal-max",
    api: "anthropic-messages",
    key_hint: "••••4321",
  });
  assert.ok(!JSON.stringify(auth.personalModelsView("zhang"))
    .includes(PERSONAL_KEY), "视图不得出现密钥明文");
  assert.ok(!JSON.stringify(auth.listUsers()).includes(PERSONAL_KEY),
    "账号列表不得出现密钥明文");
  assert.ok(!JSON.stringify(auth.sessionView("zhang")).includes(PERSONAL_KEY),
    "本人会话视图不得出现密钥明文");
  // 重启(重新加载文件)后配置还在——auth.json 是真相;密钥明文只住
  // 0600 的账号文件,这是与 Git/小鲁班令牌同一纪律。
  const revived = new LocalAuth(file);
  assert.equal(revived.personalModels("zhang")?.model, "personal-max");
  assert.ok(readFileSync(file, "utf-8").includes(PERSONAL_KEY),
    "个人网关密钥按设计明文住 auth.json(0600)");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // 清空口味一:四字段全空 → 删除,回落平台网关。
  auth.setPersonalModels("zhang",
    { url: "", api_key: "", model: "", api: "" });
  assert.equal(auth.personalModels("zhang"), undefined);
  assert.equal(auth.personalModelsView("zhang").configured, false);
  // 清空口味二:显式 clear → 删除。
  auth.setPersonalModels("zhang", {
    url: "http://personal-gw", api_key: PERSONAL_KEY,
    model: "personal-max", api: "anthropic-messages",
  });
  auth.setPersonalModels("zhang", { clear: true });
  assert.equal(auth.personalModels("zhang"), undefined);
  // 停用账号不给消费口(与 gitCredential/lubanToken 同纪律)。
  auth.setPersonalModels("zhang", {
    url: "http://personal-gw", api_key: PERSONAL_KEY,
    model: "personal-max", api: "anthropic-messages",
  });
  const raw = JSON.parse(readFileSync(file, "utf-8")) as {
    users: Array<{ username: string; disabled?: boolean }> };
  raw.users.find((user) => user.username === "zhang")!.disabled = true;
  writeFileSync(file, JSON.stringify(raw));
  assert.equal(new LocalAuth(file).personalModels("zhang"), undefined,
    "停用账号不该继续走个人网关");
  // 没配的、不存在的账号都安静返回 undefined。
  assert.equal(auth.personalModels("admin"), undefined);
  assert.equal(auth.personalModels(undefined), undefined);
});

test("校验:坏接口格式/坏 URL/缺项照平台网关同款拒绝", () => {
  const auth = new LocalAuth(join(
    mkdtempSync(join(tmpdir(), "mfc-personal-valid-")), "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("zhang", "zhang-password-1", "developer");
  assert.throws(() => auth.setPersonalModels("zhang", {
    url: "http://gw", api_key: "sk", model: "m", api: "gemini",
  }), /接口格式/);
  assert.throws(() => auth.setPersonalModels("zhang", {
    url: "not-a-url", api_key: "sk", model: "m",
  }), /合法 URL/);
  assert.throws(() => auth.setPersonalModels("zhang", {
    url: "", api_key: "sk", model: "m",
  }), /完整填写/);
  assert.equal(auth.personalModels("zhang"), undefined,
    "校验失败不得留下半截配置");
});

test("Beta 退役:端点 404,视图无 beta 块,存量残留键读取时忽略", async () => {
  // 存量 settings.json 残留 models_beta:JSON parse 不报错,读取自然
  // 忽略,不写迁移(ADR-0068)。
  const dir = mkdtempSync(join(tmpdir(), "mfc-personal-beta-gone-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    models: { provider: "maeflow", model: "glm-5.1", json: {
      providers: { maeflow: { baseUrl: "http://platform-gw",
        api: "openai-completions", apiKey: "sk-platform",
        models: [{ id: "glm-5.1" }] } } } },
    models_beta: { provider: "maeflow-beta", model: "beta-max",
      json: { providers: { "maeflow-beta": { baseUrl: "http://beta-gw",
        apiKey: "sk-beta", api: "openai-completions",
        models: [{ id: "beta-max" }] } } }, members: ["张三"] },
  }));
  const settings = new RuntimeSettings(dir);
  assert.ok(!("models_beta" in settings.view()),
    "退役后视图不得再有 beta 块");
  assert.equal(settings.view().models.model, "glm-5.1");

  const dataDir = mkdtempSync(join(tmpdir(), "mfc-personal-beta-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  const service = new TaskService({
    dataDir, provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0, settings,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "administrator-pass" }),
    });
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
    const put = await fetch(`${base}/settings/models-beta`, {
      method: "PUT", headers: { cookie }, body: "{}",
    });
    assert.equal(put.status, 404, "Beta 保存端点必须退役");
    const check = await fetch(`${base}/settings/models-beta/check`, {
      method: "POST", headers: { cookie }, body: "{}",
    });
    assert.equal(check.status, 404, "Beta 测试端点必须退役");
    const view = await fetch(`${base}/settings`, { headers: { cookie } })
      .then((response) => response.text());
    assert.ok(!view.includes("models_beta") && !view.includes("sk-beta"),
      "设置视图不得再带 beta 块或 beta 密钥");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("端点:PUT /auth/me/models 谁登录配谁,响应只带掩码;check 只测本人配置", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-personal-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("dev", "dev-password-11", "developer");
  // 本人网关用剧本服务器演"健康的 Anthropic 兼容网关"。
  const gateway = new ScriptedModelServer([{ text: "正常" }], "personal-max");
  await gateway.start();
  const service = new TaskService({
    dataDir, provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "dev", password: "dev-password-11" }),
    });
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];

    const put = await fetch(`${base}/auth/me/models`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({
        url: gateway.baseUrl, api_key: "sk-personal-9988",
        model: "personal-max", api: "anthropic-messages",
      }),
    });
    assert.equal(put.status, 200, "个人网关全员可用,不需要 admin");
    const putBody = await put.text();
    assert.ok(!putBody.includes("sk-personal-9988"),
      "PUT 响应带出了密钥明文");
    assert.match(putBody, /••••9988/);
    assert.equal(auth.personalModels("dev")?.model, "personal-max");

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } })
      .then((response) => response.text());
    assert.ok(!me.includes("sk-personal-9988"), "/auth/me 带出了密钥明文");
    assert.match(me, /••••9988/);

    // 连通测试:没草稿就测已存(密钥留空=沿用),真发一次请求。
    const before = gateway.requests.length;
    const check = await fetch(`${base}/auth/me/models/check`, {
      method: "POST", headers: { cookie }, body: "{}",
    });
    assert.equal(check.status, 200);
    const checked = await check.json() as { overall: string };
    assert.equal(checked.overall, "ok");
    assert.equal(gateway.requests.length, before + 1,
      "check 必须真发到本人网关,不编结果");

    // 清空后再 check:个人通道没有部署层兜底,"没得测"就该明说。
    const clear = await fetch(`${base}/auth/me/models`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ clear: true }),
    });
    assert.equal(clear.status, 200);
    assert.equal(
      ((await clear.json()) as { configured: boolean }).configured, false);
    const emptyCheck = await fetch(`${base}/auth/me/models/check`, {
      method: "POST", headers: { cookie }, body: "{}",
    });
    assert.equal(emptyCheck.status, 400, "没配置就该 400,不拿平台网关凑数");

    // 坏表单当场打回;未登录不能写。
    const badApi = await fetch(`${base}/auth/me/models`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({
        url: "http://gw", api_key: "sk", model: "m", api: "gemini",
      }),
    });
    assert.equal(badApi.status, 400);
    const anonymous = await fetch(`${base}/auth/me/models`, {
      method: "PUT", body: "{}",
    });
    assert.equal(anonymous.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.stop();
  }
});

test("任务链路:个人网关命中即整体换装,model_choice 让位,通道留痕", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-personal-lane-"));
  const platform = new ScriptedModelServer([{ text: "完成。" }], "scripted-v1");
  const personal = new ScriptedModelServer([{ text: "完成。" }], "personal-max");
  await platform.start();
  await personal.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: platform.modelsJson(),
    // serve 生产接 LocalAuth.personalModels;这里按账号直接给同样的形态。
    personalModels: (account) => account === "zhang"
      ? personalConfig({ url: personal.baseUrl }) : undefined,
  });

  async function settle(id: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = service.get(id)!.status;
      if (status === "completed" || status === "failed") {
        assert.equal(status, "completed", "剧本任务应正常收口");
        return;
      }
      await new Promise((tick) => setTimeout(tick, 100));
    }
    throw new Error("任务没收口");
  }

  try {
    // 张三配了个人网关:任务级 model_choice 选了平台模型也让位
    // (ADR-0068,承 Beta 旧例),全部请求走个人网关。
    const zhang = service.create("个人网关演练", {
      account: "zhang",
      model: { provider: "maeflow", model: "scripted-v1" },
    }).id;
    await settle(zhang);
    assert.equal(service.get(zhang)!.model_lane, "personal",
      "任务台账必须留个人通道痕");
    assert.ok(personal.requests.length > 0, "主会话必须打到个人网关");
    assert.ok(personal.requests.every((body) => body.model === "personal-max"),
      "个人通道会话的模型名以个人网关配置为准(model_choice 让位)");
    assert.equal(platform.requests.length, 0,
      "配了个人网关的人,名下任务不该再打平台网关");

    // 李四没配:照旧平台口径。
    const li = service.create("平台口径演练", { account: "li" }).id;
    await settle(li);
    assert.equal(service.get(li)!.model_lane, "platform");
    assert.ok(platform.requests.length > 0, "没配的人照旧走平台网关");
  } finally {
    await platform.stop();
    await personal.stop();
  }
});

test("知识问答:个人网关用户的问答解析到个人通道的 provider/model/json", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-personal-qa-"));
  const platform = new ScriptedModelServer([{ text: "平台不该被问到" }], "scripted-v1");
  // 回答阶段的唯一终结工具(submit_knowledge_answer):引用第一手
  // 证据 ev-1 的第 1 行原文。
  const personal = new ScriptedModelServer([{
    tool: { name: "submit_knowledge_answer", input: { points: [{
      kind: "answer",
      basis: [{ evidence_id: "ev-1", start_line: 1, end_line: 1 }],
      body: "当前测试规则见[规则原文](#evidence-ev-1)。",
    }] } },
  }], "personal-max");
  await platform.start();
  await personal.start();
  // document_id 直读小文档,检索不依赖向量索引。
  const document = saveKnowledgeDocument(dataDir, {
    title: "示例规则", content: "# 规则\n当前测试规则",
  }, "zhang");
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: platform.modelsJson(),
    personalModels: (account) => account === "zhang"
      ? personalConfig({ url: personal.baseUrl }) : undefined,
  });
  const answers = service.getKnowledgeAnswers();
  try {
    const { record } = answers.create(
      { question: "当前测试规则是什么？", context: { document_id: document.id } },
      "zhang");
    let final = record;
    for (let n = 0; n < 300; n++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      final = answers.get(record.id, "zhang");
      if (["done", "failed", "cancelled"].includes(final.status)) break;
    }
    // Beta 期旧伤的钉子:choice 的 provider/model 取平台通道时,pi 在
    // 个人现场 json(只有 maeflow-personal 一个 provider)里查不到所选
    // 模型,问答当场失败——必须三件套同源走到个人网关。
    assert.equal(final.status, "done", final.error);
    assert.ok(personal.requests.length > 0, "知识问答必须打到个人网关");
    assert.ok(personal.requests.every(body => body.model === "personal-max"),
      "个人通道问答的模型名以个人网关配置为准");
    assert.equal(platform.requests.length, 0,
      "配了个人网关的人,知识问答不该打平台网关");
  } finally {
    await answers.shutdown();
    await service.shutdown();
    await platform.stop();
    await personal.stop();
  }
});
