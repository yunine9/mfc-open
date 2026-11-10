/**
 * 环境管理台账的契约测试(票 #149,ADR-0020)。照 tests/issueFlowService
 * 的方式直接驱动路由(假请求/假响应,不起真端口、不占固定端口),覆盖:
 * CRUD 往返、IP 查重、加密落盘与解密往返、root 密码继承解析、权限矩阵
 * 与删除隔离。每个用例各自独立的临时 dataDir。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mfcTemp } from "./mfcTmp.ts";
import {
  EnvironmentRegistry,
  upsertEnvironmentByIp,
} from "../src/environmentRegistry.ts";
import { handleEnvironmentRoutes } from "../src/environmentRegistryRoutes.ts";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";

type Viewer = { username: string; role?: string };

interface RouteOptions {
  registry: EnvironmentRegistry;
  viewer?: Viewer;
  authEnabled: boolean;
}

interface RouteResult {
  status: number;
  body: Record<string, any>;
}

/** 走一遍真路由(/environments/*),拿到 {status, body}——与
 * issueFlowService.test.ts 的 issueGet/issuePost 同款假请求/假响应。 */
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
const admin = (username: string): Viewer => ({ username, role: "admin" });

function fresh(): { dataDir: string; registry: EnvironmentRegistry } {
  const dataDir = mfcTemp("mfc-env-registry-");
  return { dataDir, registry: new EnvironmentRegistry(dataDir) };
}

function entryInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ip: "192.0.2.8",
    port: 22,
    form: "virtualized",
    backend_password: "backend-secret",
    tags: ["v5"],
    ...overrides,
  };
}

test("CRUD 往返:非密字段回读一致,探活默认 unverified,视图永不回显密码", async () => {
  const { registry } = fresh();
  const opts: RouteOptions = { registry, viewer: developer("dev"), authEnabled: true };

  const created = await drive("POST", ["environments"], opts, entryInput({
    tags: ["v5", "西班牙语", "v5", "  "],
  }));
  assert.equal(created.status, 201);
  assert.ok(created.body.id);
  assert.equal(created.body.ip, "192.0.2.8");
  assert.equal(created.body.port, 22);
  assert.equal(created.body.form, "virtualized");
  assert.deepEqual(created.body.tags, ["v5", "西班牙语"], "标签去重、丢空、保序");
  assert.deepEqual(created.body.probe, { state: "unverified" },
    "探测是 #151,本票只留字段:默认未验证");
  assert.equal(created.body.root_password_inherited, true, "未录 root 密码即继承");
  assert.equal(created.body.password_configured, true, "机密只出已配置布尔");
  assert.equal(created.body.created_by, "dev");
  assert.equal(created.body.updated_by, "dev");
  assert.ok(created.body.created_at);
  assert.ok(created.body.updated_at);
  assert.ok(!JSON.stringify(created.body).includes("backend-secret"),
    "录入回执不回显密码");

  const listed = await drive("GET", ["environments"], opts);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.environments.length, 1);
  const row = listed.body.environments[0];
  assert.equal(row.id, created.body.id);
  assert.equal(row.ip, "192.0.2.8");
  assert.equal(row.port, 22);
  assert.equal(row.form, "virtualized");
  assert.deepEqual(row.tags, ["v5", "西班牙语"]);
  assert.deepEqual(row.probe, { state: "unverified" });
  assert.equal(row.created_by, "dev");
  assert.ok(!JSON.stringify(listed.body).includes("backend-secret"),
    "列表只出非密字段");

  const updated = await drive("PUT", ["environments", created.body.id], opts, {
    port: 2222,
    form: "k8s",
    tags: ["v6", "容器化"],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ip, "192.0.2.8", "未带的字段保持不变");
  assert.equal(updated.body.port, 2222);
  assert.equal(updated.body.form, "k8s");
  assert.deepEqual(updated.body.tags, ["v6", "容器化"]);
  assert.equal(updated.body.created_by, "dev", "created_by 不被编辑改写");

  // null = 缺席(评审 P2 回归钉):客户端按对称直觉送 null,不能串化成
  // 字面 "null" 毁密码/改 IP;唯一例外 root_password:null 有清除语义。
  const nulled = await drive("PUT", ["environments", created.body.id], opts, {
    ip: null,
    backend_password: null,
  });
  assert.equal(nulled.status, 200);
  assert.equal(nulled.body.ip, "192.0.2.8", "ip: null 视为缺席,不是字面 \"null\"");
  assert.equal(nulled.body.password_configured, true, "密码不被 null 改写");

  // 校验打回小样:缺主 IP / 坏形态 / 坏端口都是 400 带人话。
  const noIp = await drive("POST", ["environments"], opts,
    entryInput({ ip: "   " }));
  assert.equal(noIp.status, 400);
  assert.match(noIp.body.error, /主 IP/);
  const badForm = await drive("POST", ["environments"], opts,
    entryInput({ ip: "192.0.2.9", form: "bare-metal" }));
  assert.equal(badForm.status, 400);
  assert.match(badForm.body.error, /环境形态/);
  const badPort = await drive("PUT", ["environments", created.body.id], opts,
    { port: 70000 });
  assert.equal(badPort.status, 400);
  assert.match(badPort.body.error, /端口/);
});

test("IP 查重:创建撞与更新撞都 409 并指向既有条目;trim 规范化后比对;改回自己的 IP 不算撞", async () => {
  const { registry } = fresh();
  const opts: RouteOptions = { registry, viewer: developer("dev"), authEnabled: true };

  const first = await drive("POST", ["environments"], opts, entryInput());
  assert.equal(first.status, 201);
  const second = await drive("POST", ["environments"], opts,
    entryInput({ ip: "192.0.2.9", backend_password: "other-secret" }));
  assert.equal(second.status, 201);

  // 创建撞:trim 后与既有条目同键 → 409 + 既有 id。
  const dup = await drive("POST", ["environments"], opts,
    entryInput({ ip: "  192.0.2.8  " }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.existing_id, first.body.id,
    "冲突响应体指向已有条目 id");
  assert.match(dup.body.error, /10\.0\.0\.8/);

  // 更新撞:把 192.0.2.9 改成 192.0.2.8 → 409 指向第一条。
  const clash = await drive("PUT", ["environments", second.body.id], opts, {
    ip: "192.0.2.8",
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.existing_id, first.body.id);

  // 更新撞自己的 IP(规范化前后差异)不算撞。
  const self = await drive("PUT", ["environments", second.body.id], opts, {
    ip: " 192.0.2.9 ",
    tags: ["kept"],
  });
  assert.equal(self.status, 200);
  assert.equal(self.body.ip, "192.0.2.9");
  assert.deepEqual(self.body.tags, ["kept"]);
  // 不带 ip 的编辑同样放行。
  const keep = await drive("PUT", ["environments", first.body.id], opts, {
    port: 2222,
  });
  assert.equal(keep.status, 200);
  assert.equal(keep.body.ip, "192.0.2.8");
});

test("机密加密落盘:明文不进任何普通 json,信封可解回原值,密钥 0600 且与会话 vault 相互独立", async () => {
  const { dataDir, registry } = fresh();
  const opts: RouteOptions = { registry, viewer: developer("dev"), authEnabled: true };
  const created = await drive("POST", ["environments"], opts, entryInput({
    root_password: "root-secret",
  }));
  assert.equal(created.status, 201);

  // 落盘形状:独立目录 + 信封(版本/iv/tag/ciphertext),整文件搜不到明文。
  const sealedPath = join(dataDir, ".environment-registry", "registry.json");
  const keyPath = join(dataDir, ".environment-registry", "key.bin");
  assert.ok(existsSync(sealedPath), "台账落独立加密文件");
  assert.ok(existsSync(keyPath), "独立密钥文件");
  const raw = readFileSync(sealedPath, "utf8");
  assert.ok(!raw.includes("backend-secret"), "后台密码不明文落盘");
  assert.ok(!raw.includes("root-secret"), "root 密码不明文落盘");
  const envelope = JSON.parse(raw);
  assert.equal(envelope.version, 1);
  for (const field of ["iv", "tag", "ciphertext"]) {
    assert.ok(envelope[field], `信封形状完整(${field})`);
  }
  assert.equal(statSync(sealedPath).mode & 0o777, 0o600, "信封文件 0600");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, "密钥文件 0600");

  // 会话级 vault 用的是另一把钥匙:两把 key.bin 字节不同。
  const vault = new IssueEnvironmentVault(dataDir);
  vault.store("task-1", [{
    name: "对照", purpose: "logs", host: "192.0.2.1",
    accounts: ["operator", "serviceaccount", "administrator"].map((username) => ({
      username, password: "vault-secret",
    })),
  }]);
  assert.notDeepEqual(
    [...readFileSync(keyPath)],
    [...readFileSync(join(dataDir, ".issue-environments", "key.bin"))],
    "台账密钥材料与会话 vault 相互独立");

  // 解密路径取回原值;重启(新实例同 dataDir)后依然可解。
  const secrets = registry.secrets(created.body.id);
  assert.deepEqual(secrets, {
    backendPassword: "backend-secret",
    rootPassword: "root-secret",
  });
  const reopened = new EnvironmentRegistry(dataDir);
  assert.deepEqual(reopened.secrets(created.body.id), {
    backendPassword: "backend-secret",
    rootPassword: "root-secret",
  });
  // 编辑不回显、留空 = 不变:不带 backend_password 的 PUT 密码原样保留。
  const kept = await drive("PUT", ["environments", created.body.id],
    { registry: reopened, viewer: developer("dev"), authEnabled: true },
    { tags: ["touch"] });
  assert.equal(kept.status, 200);
  assert.deepEqual(reopened.secrets(created.body.id), {
    backendPassword: "backend-secret",
    rootPassword: "root-secret",
  });
  // 显式给新密码则整串替换。
  await drive("PUT", ["environments", created.body.id],
    { registry: reopened, viewer: developer("dev"), authEnabled: true },
    { backend_password: "rotated-secret" });
  assert.equal(reopened.secrets(created.body.id)?.backendPassword,
    "rotated-secret");
});

test("root 密码继承:留空解析为后台密码、显式存解析为显式值,清空回落继承(非密标志同步)", () => {
  const { registry } = fresh();
  // 留空(缺席):数据层恒有有效值——解析语义,不落冻结拷贝。
  const inherited = registry.create({
    ip: "192.0.2.8", form: "virtualized", backendPassword: "be-secret",
  }, "dev");
  assert.equal(inherited.root_password_inherited, true);
  assert.deepEqual(registry.secrets(inherited.id), {
    backendPassword: "be-secret",
    rootPassword: "be-secret",
  }, "留空时解析值 = 后台密码");
  // 改后台密码,继承方跟着走(不落冻结拷贝的直接证据)。
  registry.update(inherited.id, { backendPassword: "be-secret-2" }, "dev");
  assert.equal(registry.secrets(inherited.id)?.rootPassword, "be-secret-2",
    "继承是解析语义:后台密码轮换,继承方解析结果随之更新");

  // 显式存:解析值 = 显式值。
  const explicit = registry.create({
    ip: "192.0.2.9", form: "k8s", backendPassword: "be-9",
    rootPassword: "root-9",
  }, "dev");
  assert.equal(explicit.root_password_inherited, false);
  assert.deepEqual(registry.secrets(explicit.id), {
    backendPassword: "be-9",
    rootPassword: "root-9",
  });

  // PUT 语义:null/空串 = 清显式值回落继承;缺席 = 不变。
  registry.update(explicit.id, { rootPassword: null }, "dev");
  assert.equal(registry.findByIp("192.0.2.9")?.root_password_inherited, true);
  assert.equal(registry.secrets(explicit.id)?.rootPassword, "be-9");
  registry.update(explicit.id, { rootPassword: "root-again" }, "dev");
  registry.update(explicit.id, { port: 2223 }, "dev");
  assert.equal(registry.findByIp("192.0.2.9")?.root_password_inherited, false,
    "缺席 root_password 的编辑不改密码");
  assert.equal(registry.secrets(explicit.id)?.rootPassword, "root-again");
});

test("权限矩阵:未登录四条路全 401;登录用户可读可写;admin 可写;写后 updated_by 记会话账号", async () => {
  const { registry } = fresh();
  const seeded = await drive("POST", ["environments"],
    { registry, viewer: developer("dev"), authEnabled: true }, entryInput());
  assert.equal(seeded.status, 201);

  // 未登录:四条路由一律 401(不做任何匿名读写)。
  const anon = { registry, authEnabled: true };
  assert.equal((await drive("GET", ["environments"], anon)).status, 401);
  const anonPost = await drive("POST", ["environments"], anon,
    entryInput({ ip: "192.0.2.9" }));
  assert.equal(anonPost.status, 401);
  assert.equal((await drive("PUT", ["environments", seeded.body.id], anon,
    { tags: ["x"] })).status, 401);
  assert.equal((await drive("DELETE", ["environments", seeded.body.id], anon))
    .status, 401);
  assert.equal(registry.list().length, 1, "匿名写没有产生任何数据");

  // 普通用户:可读可写(全局团队资源,不做归属闸)。
  const dev = { registry, viewer: developer("dev2"), authEnabled: true };
  assert.equal((await drive("GET", ["environments"], dev)).status, 200);
  const byDev = await drive("POST", ["environments"], dev,
    entryInput({ ip: "192.0.2.10" }));
  assert.equal(byDev.status, 201);
  assert.equal(byDev.body.updated_by, "dev2");

  // admin 可管理(ADR-0020:"管理员不处理问题单"不约束台账)。
  const boss = { registry, viewer: admin("boss"), authEnabled: true };
  const byBoss = await drive("PUT", ["environments", seeded.body.id], boss, {
    tags: ["adm"],
  });
  assert.equal(byBoss.status, 200);
  assert.equal(byBoss.body.updated_by, "boss", "写操作记录会话账号");
  assert.equal(byBoss.body.created_by, "dev", "created_by 保留首录人");

  // 测试直连形态(部署未接 auth):authEnabled=false 放行,与问题路由同款。
  const direct = { registry, authEnabled: false };
  assert.equal((await drive("GET", ["environments"], direct)).status, 200);
});

test("删除:列表不再含该条,其余条目原样保留;再删同一条 404", async () => {
  const { registry } = fresh();
  const opts: RouteOptions = { registry, viewer: developer("dev"), authEnabled: true };
  const a = await drive("POST", ["environments"], opts,
    entryInput({ ip: "192.0.2.1" }));
  const b = await drive("POST", ["environments"], opts,
    entryInput({ ip: "192.0.2.2", tags: ["keep-me"] }));

  const removed = await drive("DELETE", ["environments", a.body.id], opts);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);

  const listed = await drive("GET", ["environments"], opts);
  assert.deepEqual(listed.body.environments.map((row: any) => row.ip),
    ["192.0.2.2"], "列表不含已删条目");
  assert.deepEqual(listed.body.environments[0].tags, ["keep-me"],
    "其他条目原样保留");
  assert.equal(listed.body.environments[0].id, b.body.id);

  const again = await drive("DELETE", ["environments", a.body.id], opts);
  assert.equal(again.status, 404);
  const unknownPut = await drive("PUT", ["environments", "no-such-id"], opts, {
    tags: ["x"],
  });
  assert.equal(unknownPut.status, 404);
});

test("同步预留:upsertEnvironmentByIp 按 IP 幂等——同 IP 复用条目,不同 IP 新建", () => {
  const { registry } = fresh();
  const actor = "sync";
  const first = upsertEnvironmentByIp(registry, {
    ip: "192.0.2.8", form: "virtualized", backendPassword: "be",
    tags: ["v5"],
  }, actor);
  assert.equal(first.created, true);

  // 同一 IP 反复导入收敛为同一条目,不产生重复。
  const again = upsertEnvironmentByIp(registry, {
    ip: " 192.0.2.8 ", port: 2222, form: "k8s", backendPassword: "be",
    tags: ["v5"],
  }, actor);
  assert.equal(again.created, false);
  assert.equal(again.entry.id, first.entry.id);
  assert.equal(again.entry.port, 2222, "payload 全量覆盖");
  assert.equal(again.entry.form, "k8s");

  const other = upsertEnvironmentByIp(registry, {
    ip: "192.0.2.9", form: "k8s", backendPassword: "be9",
  }, actor);
  assert.equal(other.created, true);
  assert.deepEqual(registry.list().map((row) => row.ip),
    ["192.0.2.8", "192.0.2.9"]);
});
