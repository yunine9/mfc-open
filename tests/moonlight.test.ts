/**
 * 两种"现成答案"的自动交卷(都走人工决定同一条通路,内核台账不缺账):
 * - 交付方式预答:下单就选好,内核举卡时对得上就交卷——送达用户早给的
 *   答案,不是宿主代做判断;对不上退回真等人;
 * - 月光模式(免审批):默认关；开启后影响后续节点，当前待办只有在
 *   预览并二次确认后才处理；有检视意见的任务永不自动放行。
 *
 * 假件说假话的教训(2026-08-18 内网实战):这里原来假的卡问"请选择本单
 * 的工作流车道",选项"快速车道/慢速车道"——内核压根没有这套词。用例
 * 于是只证明了宿主自言自语:预答按"车道"二字匹配,永远命中假卡、永远
 * 命中不了真卡,用户在真跑里被重复问一遍交付方式。现在假卡的选项**从
 * 内核 flow.json 现取**,内核改措辞用例跟着变,再没有自说自话的余地。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { workflowChoices } from "../src/kernelChoices.ts";
import { KERNEL_ROOT } from "./kernelFixture.ts";

// 内核的真选项(缺内核则空数组)。模型出卡时惯例在标签后带上代号,
// 内网实测就是"局部修改(tweak)"这种形状——假件照这个形状造。
const LANES = workflowChoices(KERNEL_ROOT);
// 推荐协议:推荐必须是选项原文之一(校验器逐字核对)。取 tweak 优先,
// 与各用例对账用的 choice 同源;缺内核(空数组)时不带该键。
const preferredLane = LANES.find((item) => item.key === "tweak") ?? LANES[0];
const LANE_CARD: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "本单采用哪种交付方式?",
    options: LANES.map((item) => `${item.label}(${item.key})`),
    ...(preferredLane
      ? { recommended: `${preferredLane.label}(${preferredLane.key})` }
      : {}),
  }] } },
};
const REVIEW_CARD: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "Diff 通过吗?", options: ["通过", "打回"],
    recommended: "通过",
  }] } },
};

async function settle(
  service: TaskService,
  id: string,
  accept: string[],
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (accept.includes(status)) return status;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return service.get(id)!.status;
}

function allSeen(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .map((message: any) => JSON.stringify(message.content ?? ""))
    .join("\n");
}

test("交付方式预答:内核举卡,下单选定的那项自动交卷,不等人", async (t) => {
  if (!LANES.length) {
    t.skip("缺内核 flow.json 的 workflow_select:仓内 kernel/ 快照不完整,"
      + "这条要停下来查(harness/sync-kernel.sh 刷新)");
    return;
  }
  const choice = LANES.find((item) => item.key === "tweak") ?? LANES[0];
  const lane = choice.label;
  const model = new ScriptedModelServer([LANE_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("交付方式预答演练", { lane }).id;
  assert.equal(service.get(id)!.lane, lane);
  assert.equal(await settle(service, id, ["completed", "failed"]),
    "completed");
  // 交上去的必须是**内核选项原样**(它按选项文本对账,"approve"这种
  // 自造词会被判"没有检测到本步骤的真实选项回答"),且标明非人工答复
  assert.match(allSeen(model), new RegExp(`${lane}\\(${choice.key}\\)`));
  assert.match(allSeen(model), /非人工现场答复/);
  await model.stop();
});

test("模型自造是/否确认卡:预答不硬猜,退回等人并写明为什么没接住", async (t) => {
  // 内网实测:模型从需求原文猜到用户想局部修改,自造了一张
  // "是否选择局部修改?"的是/否卡。是/否里没有选项原文,预答对不上号
  // ——这是对的(是/否算不算数归内核判,宿主不替);但"为什么没接住"
  // 必须留明账,否则现场只看到"又在等人",查不出原因。
  if (!LANES.length) {
    t.skip("缺内核 flow.json 的 workflow_select(kernel/ 快照不完整)");
    return;
  }
  const lane = (LANES.find((item) => item.key === "tweak") ?? LANES[0]).label;
  const logs: string[] = [];
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: `是否选择${lane}(tweak)?`, options: ["是", "否"],
      recommended: "是",
    }] } } },
    { text: "收口。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-binary-card-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (line) => logs.push(line),
  });
  const id = service.create("是否卡演练", { lane }).id;
  assert.equal(await settle(service, id, ["waiting_for_human"]),
    "waiting_for_human", "非标准卡该真等人,不硬猜是/否");
  const traced = logs.filter((line) => line.includes("不是标准形状"));
  assert.equal(traced.length, 1, `要留明账,日志:\n${logs.join("\n")}`);
  assert.match(traced[0], /是\/否/);
  await model.stop();
});

test("恢复:老单带着旧版自造的交付方式,清除留痕而不是永远命中不了", async (t) => {
  if (!LANES.length) {
    t.skip("缺内核 flow.json 的 workflow_select(kernel/ 快照不完整)");
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-old-lane-"));
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const before = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = before.create("老单演练").id;
  await settle(before, id, ["waiting_for_human"]);
  // 手写旧版现场:task.json 里的 lane 是自造的"慢速"
  const path = join(dataDir, id, "task.json");
  const saved = JSON.parse(readFileSync(path, "utf-8"));
  saved.summary.lane = "慢速";
  writeFileSync(path, JSON.stringify(saved));

  const logs: string[] = [];
  const after = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot: discoverKernelRoot(process.cwd())!, repoPath: "/tmp/r" },
    log: (line) => logs.push(line),
  });
  after.recover();
  assert.equal(after.get(id)!.lane, undefined, "内核不认的旧值要清掉");
  assert.ok(logs.some((line) => line.includes("旧版自造的词")),
    `清除要留痕,日志:\n${logs.join("\n")}`);
  await model.stop();
});

test("选项卡上交自造词:服务端拒绝自由文本冒充流程分支", async () => {
  // 内网实战:有人绕开界面直接打接口,交了个自造的 "approve",真正的
  // 选择写在备注里 → 内核按选项原文对账,判"没有检测到本步骤的真实选项
  // 回答",报错落在几步之后的 done 上,现场看着像流程卡死。
  // 宿主不替内核判定(界面允许自定义答复,那是合法用法),只把因果记明白。
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-offmenu-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("自造词演练").id;
  await settle(service, id, ["waiting_for_human"]);
  await assert.rejects(service.decide(id, {
    state_version: service.get(id)!.waiting!.state_version,
    decision: "approve",
    notes: "其实我想选通过",
  }), /必须选择卡片中的结构化选项/);
  assert.equal(service.get(id)!.status, "waiting_for_human");
  await model.stop();
});

test("月光关着:非车道卡真等人;月光开着:代答直行,答复带复盘要求", async () => {
  let moonlight = false;
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => account === "liao" && moonlight,
  });
  const id = service.create("月光演练", { account: "liao" }).id;
  assert.equal(await settle(service, id, ["waiting_for_human"]),
    "waiting_for_human", "默认关:该等人还是等人");

  // 随时开启:对已经在等的卡立刻生效
  moonlight = true;
  assert.equal(service.sweepMoonlight("liao"), 1);
  assert.equal(await settle(service, id, ["completed", "failed"]),
    "completed");
  assert.match(allSeen(model), /月光模式选择:通过/);
  assert.match(allSeen(model), /事后人工复盘/);
  await model.stop();
});

test("存在未闭环检视意见时，月光模式预览和清场都拒绝自动放行", async () => {
  let moonlight = false;
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-annotations-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: () => moonlight,
  });
  const id = service.create("带检视意见的月光单", { account: "liao" }).id;
  await settle(service, id, ["waiting_for_human"]);
  service.addAnnotation(id, {
    author: "liao", artifact: "未提交改动", file: "src/a.ts",
    line: 3, anchor: "return true", note: "这里需要校验权限", kind: "code",
  });

  moonlight = true;
  assert.deepEqual(service.previewMoonlight("liao"), {
    waiting: 1,
    eligible: 0,
    blocked_annotations: 1,
    blocked_other: 0,
  });
  assert.equal(service.sweepMoonlight("liao"), 0);
  assert.equal(service.get(id)!.status, "waiting_for_human");
  await model.stop();
});

test("任务级审批方式可以覆盖个人月光模式", async () => {
  let moonlight = false;
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-task-moonlight-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: () => moonlight,
  });
  const id = service.create("任务级审批方式", { account: "liao" }).id;
  await settle(service, id, ["waiting_for_human"]);

  service.setTaskApprovalMode(id, "manual");
  moonlight = true;
  assert.equal(service.sweepMoonlight("liao"), 0,
    "本任务逐步确认应压过个人月光模式");
  assert.equal(service.get(id)!.status, "waiting_for_human");

  const result = service.setTaskApprovalMode(id, "moonlight", true);
  assert.equal(result.swept, 1);
  assert.equal(await settle(service, id, ["completed"]), "completed");
  await model.stop();
});

test("月光开着到达的卡直接放行;别人的任务不受影响", async () => {
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  const other = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  await other.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => account === "liao",
  });
  const mine = service.create("我的月光单", { account: "liao" }).id;
  assert.equal(await settle(service, mine, ["completed"]), "completed",
    "月光开着,卡到即放行");

  const others = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: other.modelsJson(),
    moonlight: (account) => account === "liao",
  });
  const theirs = others.create("别人的单", { account: "wang" }).id;
  assert.equal(await settle(others, theirs, ["waiting_for_human"]),
    "waiting_for_human", "月光是个人开关,不放行别人的卡");
  await model.stop();
  await other.stop();
});

test("路由:开关默认仅影响后续，确认后处理当前待办，重启后记得住", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-moon-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => auth.moonlightEnabled(account),
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

    // 先有一张在等的卡
    const id = service.create("路由月光单", { account: "dev" }).id;
    await settle(service, id, ["waiting_for_human"]);

    const preview = await fetch(`${base}/auth/me/moonlight-preview`, {
      headers: { cookie },
    }).then((r) => readJson(r));
    assert.equal(preview.eligible, 1);

    const on = await fetch(`${base}/auth/me/moonlight`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ on: true }),
    }).then((r) => readJson(r));
    assert.equal(on.moonlight, true);
    assert.equal(on.swept, 0, "默认只影响后续节点");
    assert.equal(service.get(id)!.status, "waiting_for_human");

    const sweep = await fetch(`${base}/auth/me/moonlight`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({
        on: true, include_current: true, expected_eligible: 1,
      }),
    }).then((r) => readJson(r));
    assert.equal(sweep.swept, 1, "看过预览并确认后才处理当前待办");
    assert.equal(await settle(service, id, ["completed"]), "completed");

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } })
      .then((r) => readJson(r));
    assert.equal(me.moonlight, true);
    // 状态持久:重新加载账号库还开着
    assert.equal(new LocalAuth(join(dataDir, "auth.json"))
      .moonlightEnabled("dev"), true);

    const off = await fetch(`${base}/auth/me/moonlight`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ on: false }),
    }).then((r) => readJson(r));
    assert.equal(off.moonlight, false);
  } finally {
    server.close();
    await model.stop();
  }
});

test("管理员不发起任务:下单 403 说人话;开发者不能冒领给别人", async () => {
  // 用户 2026-08-19 拍板:管理平台与干活是两个角色——管理员配服务、
  // 建账号、兜底控制,任务由开发者自己发起、挂自己名下。"管理员替人
  // 下单"连同它踩过的归属人为空的坑一并退役。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-ml-admin-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.createUser("boss", "boss-password-11", "admin");
  auth.createUser("zhang", "zhang-password-11", "developer");
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    return String(response.headers.get("set-cookie") ?? "").split(";")[0];
  };
  try {
    const boss = await login("boss", "boss-password-11");
    const denied = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ requirement: "管理员想下单" }),
    });
    assert.equal(denied.status, 403);
    assert.match((await readJson(denied)).error, /管理员不发起任务/);
    // 替别人下单同样不给:发起任务本身就不是这个角色的事
    const forOther = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ requirement: "替小张下的单", account: "zhang" }),
    });
    assert.equal(forOther.status, 403);
    // 管理员不下单,个人令牌对他不咬人:缺项清单不该拿这个烦他
    const options = await fetch(`${base}/launch-options`,
      { headers: { cookie: boss } }).then((r) => readJson(r));
    assert.ok(!options.blockers.some(
      (item: { where: string }) => item.where === "me"),
      "管理员不该被要求配个人令牌");

    // 开发者:自己的单归自己,想挂别人名下也不行
    const zhang = await login("zhang", "zhang-password-11");
    const created = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: zhang },
      body: JSON.stringify({ requirement: "小张的单", account: "boss" }),
    }).then((r) => readJson(r));
    assert.equal(created.luban_account, "zhang", "归属人=登录者本人");
  } finally {
    server.close();
    await model.stop();
  }
});
