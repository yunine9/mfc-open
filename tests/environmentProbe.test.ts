/**
 * 环境台账探活的契约测试(票 #151,ADR-0020)。探测全部经注入的假
 * 连接器驱动——绝不真连 SSH、不测 ssh2 库本身;二分口径用合成错误
 * 对象钉在自家分类器上。照 tests/environmentRegistry.test.ts 的方式
 * 直接驱动路由(假请求/假响应),覆盖:三态分类与写回持久化、
 * /environments/test 不落存储与鉴权、/:id/probe 持久化与 404、轮询
 * 单轮的全量扫描与单条故障隔离。每个用例各自独立的临时 dataDir。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mfcTemp } from "./mfcTmp.ts";
import {
  EnvironmentRegistry,
} from "../src/environmentRegistry.ts";
import { handleEnvironmentRoutes } from "../src/environmentRegistryRoutes.ts";
import {
  buildProbeTarget,
  environmentProbeIntervalMs,
  DEFAULT_ENVIRONMENT_PROBE_INTERVAL_MS,
  ENVIRONMENT_PROBE_INTERVAL_MS_ENV,
  isSshAuthFailure,
  probeAllEnvironments,
  probeEnvironmentEntry,
  PROBE_USERNAME,
  startEnvironmentProbePolling,
  type ProbeConnector,
  type ProbeTarget,
} from "../src/environmentProbe.ts";

type Viewer = { username: string; role?: string };

interface RouteOptions {
  registry: EnvironmentRegistry;
  viewer?: Viewer;
  authEnabled: boolean;
  probeConnector?: ProbeConnector;
}

interface RouteResult {
  status: number;
  body: Record<string, any>;
}

/** 走一遍真路由(/environments/*),拿到 {status, body}——与
 * environmentRegistry.test.ts 同款假请求/假响应,不起真端口。 */
function drive(
  method: string,
  parts: string[],
  options: RouteOptions,
  payload?: unknown,
): Promise<RouteResult> {
  return new Promise((resolve, reject) => {
    // readBody 在 request 上挂 data/end 监听,带体的请求得是 EventEmitter。
    const request = payload === undefined
      ? { method } as any
      : Object.assign(new EventEmitter(), { method });
    let status = 0;
    void handleEnvironmentRoutes(
      request,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      options,
    ).catch(reject);
    if (payload !== undefined) {
      request.emit("data", Buffer.from(JSON.stringify(payload)));
      request.emit("end");
    }
  });
}

const developer = (username: string): Viewer => ({ username, role: "developer" });

function fresh(): { dataDir: string; registry: EnvironmentRegistry } {
  const dataDir = mfcTemp("mfc-env-probe-");
  return { dataDir, registry: new EnvironmentRegistry(dataDir) };
}

function seededEntry(
  registry: EnvironmentRegistry,
  overrides: Record<string, unknown> = {},
): { id: string; ip: string; port: number } {
  const view = registry.create({
    ip: String(overrides.ip ?? "192.0.2.8"),
    port: overrides.port as number | undefined,
    form: "virtualized",
    backendPassword: String(overrides.backendPassword ?? "backend-secret"),
    tags: ["v5"],
  }, "dev");
  return { id: view.id, ip: view.ip, port: view.port };
}

/** 假连接器:记录收到的目标,结论由剧本按次给出。 */
function fakeConnector(
  reply: (target: ProbeTarget, call: number) =>
    | { ok: true }
    | { ok: false; reason: "auth" | "unreachable" },
): { connector: ProbeConnector; targets: ProbeTarget[] } {
  const targets: ProbeTarget[] = [];
  let call = 0;
  return {
    targets,
    connector: async (target) => {
      call += 1;
      targets.push(target);
      return reply(target, call);
    },
  };
}

const okConnector: ProbeConnector = async () => ({ ok: true });

test("探测分类与写回:成功→ok;认证拒/不可达→failed 带原因;失败一次再成功翻回 ok,at 随每拍更新", async () => {
  const { dataDir, registry } = fresh();
  const { id, ip, port } = seededEntry(registry);

  // 成功:连接器收到 seam 入参——用户名恒为 operator,密码是台账后台
  // 密码(经 secrets 解密路径),不是表单现输的任何东西。
  const ok = fakeConnector(() => ({ ok: true }));
  const okView = await probeEnvironmentEntry(registry, id, ok.connector);
  assert.equal(ok.targets.length, 1);
  assert.deepEqual(ok.targets[0], {
    host: ip, port, username: PROBE_USERNAME, password: "backend-secret",
  });
  assert.equal(okView.probe.state, "ok");
  assert.equal(okView.probe.reason, undefined, "成功不带原因");
  assert.ok(okView.probe.at);
  const okAt = okView.probe.at;

  // 写回持久化:新实例(同 dataDir)读回同一结论。
  assert.deepEqual(
    new EnvironmentRegistry(dataDir).list()[0].probe,
    { state: "ok", at: okAt });

  // 认证拒:failed/auth,失败一次即标,不等第二轮确认。
  const auth = fakeConnector(() => ({ ok: false, reason: "auth" }));
  const authView = await probeEnvironmentEntry(registry, id, auth.connector);
  assert.equal(authView.probe.state, "failed");
  assert.equal(authView.probe.reason, "auth");
  assert.ok(authView.probe.at);
  const failedAt = authView.probe.at;
  // 探活是后台观察,不是人工编辑:审计与台账字段一概不碰。
  assert.equal(authView.updated_by, "dev");
  assert.equal(authView.created_by, "dev");
  assert.deepEqual(authView.tags, ["v5"]);

  // 不可达(连接拒绝/超时都归这里):failed/unreachable。
  const unreachable = fakeConnector(() => ({
    ok: false, reason: "unreachable",
  }));
  const unreachableView = await probeEnvironmentEntry(
    registry, id, unreachable.connector);
  assert.equal(unreachableView.probe.state, "failed");
  assert.equal(unreachableView.probe.reason, "unreachable");

  // 下一次成功翻回 ok,原因一并清掉;at 是新一轮的时间戳(隔开几毫秒)。
  await new Promise((tick) => setTimeout(tick, 15));
  const flip = fakeConnector(() => ({ ok: true }));
  const flipView = await probeEnvironmentEntry(registry, id, flip.connector);
  assert.equal(flipView.probe.state, "ok");
  assert.equal(flipView.probe.reason, undefined);
  assert.notEqual(flipView.probe.at, failedAt, "at 随探测轮次更新");
  assert.deepEqual(
    registry.list()[0].probe,
    { state: "ok", at: flipView.probe.at },
    "翻回 ok 后落盘");
});

test("失败二分口径:认证失败有专属 level/措辞;连接拒绝与超时归 unreachable(合成错误对象,不测 ssh2 库)", () => {
  // 认证拒:ssh2 的专属 level 与人话措辞都认。
  assert.equal(isSshAuthFailure(
    Object.assign(new Error("All configured authentication methods failed"),
      { level: "client-authentication" })), true);
  assert.equal(isSshAuthFailure(
    { message: "All configured authentication methods failed" }), true);
  // 连接拒绝:套接字错,机器关了/端口不通,不是密码错了。
  assert.equal(isSshAuthFailure(
    Object.assign(new Error("connect ECONNREFUSED 192.0.2.8:22"),
      { level: "client-socket" })), false);
  // 超时:同样归 unreachable。
  assert.equal(isSshAuthFailure(
    Object.assign(new Error("Timed out while waiting for handshake"),
      { level: "client-timeout" })), false);
});

test("/environments/test:用现输密码探测、不落任何存储;坏入参 400;未登录 401 且连接器不被调用", async () => {
  const { registry } = fresh();
  const { id } = seededEntry(registry, { ip: "192.0.2.8" });
  const opts: RouteOptions = {
    registry, viewer: developer("dev"), authEnabled: true,
  };

  // 成功:连接器拿到 trim 后的 IP、显式端口与用户现输的密码;响应只带
  // 结论;台账探活状态纹丝不动。
  const ok = fakeConnector(() => ({ ok: true }));
  const passed = await drive("POST", ["environments", "test"],
    { ...opts, probeConnector: ok.connector }, {
      ip: " 192.0.2.99 ", port: 2222, form: "k8s", backend_password: "typed-pw",
    });
  assert.equal(passed.status, 200);
  assert.deepEqual(passed.body, { ok: true });
  assert.deepEqual(ok.targets, [{
    host: "192.0.2.99", port: 2222, username: PROBE_USERNAME,
    password: "typed-pw",
  }]);
  assert.deepEqual(registry.list().find((row) => row.id === id)?.probe,
    { state: "unverified" }, "测试连接不写台账探活状态");
  assert.equal(registry.list().length, 1, "测试连接不产生新条目");

  // 失败:200 带原因(探测失败是正常结论,不是 HTTP 错误),同样不落。
  const auth = fakeConnector(() => ({ ok: false, reason: "auth" }));
  const rejected = await drive("POST", ["environments", "test"],
    { ...opts, probeConnector: auth.connector },
    { ip: "192.0.2.99", backend_password: "wrong" });
  assert.equal(rejected.status, 200);
  assert.deepEqual(rejected.body, { ok: false, reason: "auth" });
  assert.deepEqual(registry.list().find((row) => row.id === id)?.probe,
    { state: "unverified" });

  // 缺端口回落 22(与台账录入同一缺省)。
  const defaultPort = fakeConnector(() => ({ ok: true }));
  await drive("POST", ["environments", "test"],
    { ...opts, probeConnector: defaultPort.connector },
    { ip: "192.0.2.99", backend_password: "typed-pw" });
  assert.equal(defaultPort.targets[0]?.port, 22);

  // 坏入参:缺 IP / 坏端口 / 缺密码,一律 400 带人话,连接器不出手。
  for (const [payload, fragment] of [
    [{ port: 2222, backend_password: "x" } as any, "主 IP"],
    [{ ip: "192.0.2.99", port: 70000, backend_password: "x" }, "端口"],
    [{ ip: "192.0.2.99", port: 0, backend_password: "x" }, "端口"],
    [{ ip: "192.0.2.99" }, "后台密码"],
    [{ ip: "192.0.2.99", backend_password: "   " }, "后台密码"],
  ] as const) {
    const untouched = fakeConnector(() => ({ ok: true }));
    const bad = await drive("POST", ["environments", "test"],
      { ...opts, probeConnector: untouched.connector }, payload);
    assert.equal(bad.status, 400, `坏入参应 400: ${JSON.stringify(payload)}`);
    assert.match(bad.body.error, new RegExp(fragment));
    assert.equal(untouched.targets.length, 0, "校验打回时不发起探测");
  }

  // 未登录:与 CRUD 同一口径 401,连接器不被调用(匿名不能借接口扫内网)。
  const anonProbe = fakeConnector(() => ({ ok: true }));
  const anon = await drive("POST", ["environments", "test"],
    { registry, authEnabled: true, probeConnector: anonProbe.connector },
    { ip: "192.0.2.99", backend_password: "x" });
  assert.equal(anon.status, 401);
  assert.equal(anonProbe.targets.length, 0);
});

test("/environments/:id/probe:用台账后台密码探测并持久化,返回更新后的视图;未知条目 404 且连接器不出手", async () => {
  const { dataDir, registry } = fresh();
  const { id, ip, port } = seededEntry(registry, {
    ip: "192.0.2.8", port: 2222, backendPassword: "backend-secret",
  });
  const opts: RouteOptions = {
    registry, viewer: developer("dev"), authEnabled: true,
  };

  const probe = fakeConnector((target) => {
    assert.deepEqual(target, {
      host: ip, port, username: PROBE_USERNAME, password: "backend-secret",
    }, "手动探活用台账后台密码,不是请求体里任何东西");
    return { ok: false, reason: "unreachable" };
  });
  const probed = await drive("POST", ["environments", `${id}`, "probe"],
    { ...opts, probeConnector: probe.connector });
  assert.equal(probed.status, 200);
  assert.equal(probed.body.id, id);
  assert.equal(probed.body.probe.state, "failed");
  assert.equal(probed.body.probe.reason, "unreachable");
  assert.ok(probed.body.probe.at);
  // 持久化:列表与新实例读回同一结论。
  assert.deepEqual(registry.list().find((row) => row.id === id)?.probe,
    probed.body.probe);
  assert.deepEqual(
    new EnvironmentRegistry(dataDir).list().find((row) => row.id === id)?.probe,
    probed.body.probe, "探活结论落盘(重启不丢)");

  const missing = fakeConnector(() => ({ ok: true }));
  const unknown = await drive("POST", ["environments", "no-such-id", "probe"],
    { ...opts, probeConnector: missing.connector });
  assert.equal(unknown.status, 404);
  assert.equal(missing.targets.length, 0, "未知条目不发起探测");

  // 未登录同样 401(探活写台账,属写操作)。
  const anon = await drive("POST", ["environments", `${id}`, "probe"],
    { registry, authEnabled: true, probeConnector: okConnector });
  assert.equal(anon.status, 401);
});

test("轮询单轮:全量快照逐条串行;单条抛错只跳过不抛出,不影响其余条目写回", async () => {
  const { registry } = fresh();
  const a = seededEntry(registry, { ip: "192.0.2.1" });
  const b = seededEntry(registry, { ip: "192.0.2.2", backendPassword: "be-2" });
  const c = seededEntry(registry, { ip: "192.0.2.3", backendPassword: "be-3" });

  // A 成功;B 的连接器直接抛(坏凭据/意外异常的最坏形态);C 不可达。
  const log: string[] = [];
  const connector: ProbeConnector = async (target) => {
    if (target.host === "192.0.2.2") throw new Error("连接器内部炸了");
    if (target.host === "192.0.2.3") return { ok: false, reason: "unreachable" };
    return { ok: true };
  };
  const round = await probeAllEnvironments(registry, connector,
    (message) => log.push(message));
  assert.deepEqual(round, { total: 3, probed: 2, ok: 1, failed: 1 });
  const states = new Map(registry.list().map((row) => [row.id, row.probe]));
  assert.equal(states.get(a.id)?.state, "ok");
  assert.equal(states.get(b.id)?.state, "unverified",
    "抛错条目保持原状,不误标");
  assert.equal(states.get(c.id)?.state, "failed");
  assert.equal(states.get(c.id)?.reason, "unreachable");
  assert.equal(log.length, 1, "单条失败记了日志");
  assert.match(log[0], /192\.0\.2\.2/);

  // 空台账:一轮空跑,零探测零异常。
  const empty = fresh();
  const emptyRound = await probeAllEnvironments(
    empty.registry, okConnector);
  assert.deepEqual(emptyRound, { total: 0, probed: 0, ok: 0, failed: 0 });
});

test("轮询节奏:间隔常量约 10 分钟,正整数环境变量可覆盖,坏值回落常量;start/stop 真停", async () => {
  assert.equal(DEFAULT_ENVIRONMENT_PROBE_INTERVAL_MS, 10 * 60_000);
  assert.equal(environmentProbeIntervalMs({}),
    DEFAULT_ENVIRONMENT_PROBE_INTERVAL_MS, "无环境变量用常量");
  assert.equal(environmentProbeIntervalMs(
    { [ENVIRONMENT_PROBE_INTERVAL_MS_ENV]: "60000" } as NodeJS.ProcessEnv),
    60000, "正整数环境变量生效");
  for (const bad of ["", "abc", "0", "-5", "1.5"]) {
    assert.equal(environmentProbeIntervalMs(
      { [ENVIRONMENT_PROBE_INTERVAL_MS_ENV]: bad } as NodeJS.ProcessEnv),
      DEFAULT_ENVIRONMENT_PROBE_INTERVAL_MS, `坏值回落常量: ${bad}`);
  }

  // start 后到点起轮、stop 后真停(毫秒级小间隔,stop 后不再增拍)。
  const { registry } = fresh();
  seededEntry(registry);
  let fired = 0;
  const counting: ProbeConnector = async () => {
    fired += 1;
    return { ok: true };
  };
  const poller = startEnvironmentProbePolling({
    registry, connector: counting, intervalMs: 20,
  });
  await new Promise((tick) => setTimeout(tick, 120));
  assert.ok(fired >= 1, "到点起了轮");
  const afterStop = fired;
  poller.stop();
  await new Promise((tick) => setTimeout(tick, 120));
  assert.equal(fired, afterStop, "stop 后不再起轮");
});

test("buildProbeTarget:用户名恒为 operator——表单草稿与台账条目走同一条 seam", () => {
  assert.deepEqual(buildProbeTarget("192.0.2.8", 22, "pw"), {
    host: "192.0.2.8", port: 22, username: "operator", password: "pw",
  });
});
