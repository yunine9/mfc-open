import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

function fixture(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "mfc-auth-persistence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "fixture-admin-password");
  return { directory, file, auth };
}

test("登录不随时间到期，超过八小时和长期闲置后重启仍有效", t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { auth, file } = fixture(t);
  const token = auth.createSession(auth.listUsers()[0]);
  now += 9 * 60 * 60_000;
  assert.equal(auth.sessionUser(token)?.username, "admin");
  now += 2 * 365 * 24 * 60 * 60_000;
  const restarted = new LocalAuth(file);
  assert.equal(restarted.sessionUser(token)?.username, "admin");
  const raw = readFileSync(`${file}.sessions`, "utf8");
  assert.ok(!raw.includes(token), "文件不能保存可直接登录的原始令牌");
  assert.equal(statSync(`${file}.sessions`).mode & 0o777, 0o600);
  const saved = JSON.parse(raw);
  assert.equal(saved.version, 2);
  assert.equal(saved.sessions.length, 1);
  assert.equal("expiresAt" in saved.sessions[0], false);
});

test("升级仍有效的旧八小时登录，过期或无效账号的旧会话不重新启用", t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { auth, file } = fixture(t);
  auth.createUser("disabled-user", "fixture-disabled-password", "developer");
  const users = JSON.parse(readFileSync(file, "utf8"));
  users.users.find((user: { username: string }) => user.username === "disabled-user").disabled = true;
  writeFileSync(file, JSON.stringify(users));
  const key = (token: string) => createHash("sha256").update(token).digest("hex");
  const row = (token: string, username: string, expiresAt: unknown) => ({
    token_sha256: key(token), username, expiresAt,
  });
  writeFileSync(`${file}.sessions`, JSON.stringify({ version: 1, sessions: [
    row("live-fixture", "admin", now + 8 * 60 * 60_000),
    row("expired-fixture", "admin", now - 1),
    row("disabled-fixture", "disabled-user", now + 8 * 60 * 60_000),
    row("missing-fixture", "missing-user", now + 8 * 60 * 60_000),
    row("malformed-fixture", "admin", null),
  ] }));
  const upgraded = new LocalAuth(file);
  assert.equal(upgraded.sessionUser("live-fixture")?.username, "admin");
  for (const invalid of ["expired-fixture", "disabled-fixture", "missing-fixture", "malformed-fixture"]) {
    assert.equal(upgraded.sessionUser(invalid), undefined);
  }
  const saved = JSON.parse(readFileSync(`${file}.sessions`, "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.sessions.length, 1);
  assert.equal("expiresAt" in saved.sessions[0], false);
  now += 9 * 60 * 60_000;
  assert.equal(new LocalAuth(file).sessionUser("live-fixture")?.username, "admin");
});

test("持久会话在主动退出、密码重置和账号删除后仍撤销，重启不能恢复", t => {
  const { auth, file } = fixture(t);
  auth.createUser("alice", "fixture-alice-password", "developer");
  const alice = auth.listUsers().find(user => user.username === "alice")!;
  const logout = auth.createSession(alice);
  auth.endSession(logout);
  assert.equal(new LocalAuth(file).sessionUser(logout), undefined);
  const reset = auth.createSession(alice);
  auth.resetPassword("alice", "fixture-alice-new-password");
  assert.equal(auth.sessionUser(reset), undefined);
  assert.equal(new LocalAuth(file).sessionUser(reset), undefined);
  const deleted = auth.createSession(alice);
  auth.deleteUser("alice", "admin");
  assert.equal(new LocalAuth(file).sessionUser(deleted), undefined);
});

test("密码重置即使会话文件写失败，重启也不能恢复旧登录", t => {
  const { auth, file } = fixture(t);
  const token = auth.createSession(auth.listUsers()[0]);
  mkdirSync(`${file}.sessions.tmp`);
  auth.resetPassword("admin", "fixture-admin-new-password");
  assert.equal(auth.sessionUser(token), undefined);
  assert.equal(new LocalAuth(file).sessionUser(token), undefined);
  assert.equal(new LocalAuth(file).authenticate("admin", "fixture-admin-new-password", "test").user?.username, "admin");
});

test("旧会话升级写失败后重置密码，也不能在重启时重新升级旧令牌", t => {
  const { file } = fixture(t);
  writeFileSync(`${file}.sessions`, JSON.stringify({ version: 1, sessions: [{
    token_sha256: createHash("sha256").update("legacy-fixture").digest("hex"),
    username: "admin", expiresAt: Date.now() + 8 * 60 * 60_000,
  }] }));
  mkdirSync(`${file}.sessions.tmp`);
  const upgraded = new LocalAuth(file);
  assert.equal(upgraded.sessionUser("legacy-fixture")?.username, "admin");
  upgraded.resetPassword("admin", "fixture-admin-new-password");
  assert.equal(new LocalAuth(file).sessionUser("legacy-fixture"), undefined);
});

test("登录和身份检查续期一年 Cookie，慢请求不续写，退出清除且匿名不能续期", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mfc-auth-cookie-"));
  const auth = new LocalAuth(join(directory, "auth.json"));
  auth.bootstrapAdmin("admin", "fixture-admin-password");
  const service = new TaskService({ dataDir: directory, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service, { auth });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "x-forwarded-proto": "https" },
      body: JSON.stringify({ username: "admin", password: "fixture-admin-password" }),
    });
    assert.equal(login.status, 200);
    const initial = login.headers.get("set-cookie")!;
    for (const attribute of ["Max-Age=31536000", "HttpOnly", "SameSite=Strict", "Path=/", "Secure"]) {
      assert.ok(initial.includes(attribute), `登录 Cookie 缺少 ${attribute}`);
    }
    const cookie = initial.split(";")[0];
    const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const renewed = me.headers.get("set-cookie")!;
    assert.ok(renewed.startsWith(`${cookie};`), "身份查询须续用当前令牌");
    assert.ok(renewed.includes("Max-Age=31536000"));
    const tasks = await fetch(`${base}/tasks`, { headers: { cookie } });
    assert.equal(tasks.status, 200);
    assert.equal(tasks.headers.get("set-cookie"), null, "业务请求不能迟到覆盖新登录 Cookie");
    const anonymous = await fetch(`${base}/auth/me`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("set-cookie"), null);
    const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.get("set-cookie")!.includes("Max-Age=0"));
    const revoked = await fetch(`${base}/auth/me`, { headers: { cookie } });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get("set-cookie"), null);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await service.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
