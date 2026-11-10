/**
 * 免登录允许清单契约(ADR-0069,#566):一小撮与人无关的参考数据接口
 * 匿名可读(拉单/单据详情/单号绑定/模块目录/人员名单),绑定改选匿名
 * 写以请求体 account 自报操作人;清单之外一切路由(含新增)默认仍在
 * 登录闸后。两级验证:问题域路由直调(先例 issueConversation)+ 真
 * 服务 HTTP(business-modules 按方法拆闸、/auth/people、默认拒绝)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { TaskService } from "../src/taskService.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import {
  readDtsModuleBindings,
} from "../src/dtsModuleBindings.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

const settings = { provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };

test("问题域允许清单:匿名可读拉单/详情/绑定,PUT 自报 account,清单外仍 401", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-anon-allowlist-"));
  createBusinessModule(dir, {
    id: "mod-msg", name: "消息中心", description: "测试模块",
    owner: "expert", repositories: ["https://example.test/msg.git"],
  }, "expert");
  const service = new IssueFlowService({
    dataDir: dir, ...settings, deferRecovery: true, maxConcurrentTurns: 0,
  });
  const routes = { issueFlow: service, dts: new MockDtsGateway(), authEnabled: true };
  const call = (method: string, url: string, body?: unknown,
    viewer?: object, base: Record<string, unknown> = routes) =>
    new Promise<{ status: number; body: Record<string, any> }>(
      (resolve, reject) => {
        let status = 0;
        const request = new EventEmitter() as never as Record<string, unknown>;
        request.method = method;
        request.url = url;
        const response = {
          writeHead: (code: number) => { status = code; },
          end: (payload?: string) => {
            try {
              resolve({ status, body: JSON.parse(payload ?? "{}") });
            } catch (error) { reject(error); }
          },
        } as never;
        void handleIssueRoutes(
          request as never, response,
          // 与服务端同尺:按 pathname 切段,查询串不进路由段。
          new URL(url, "http://x").pathname.split("/").filter(Boolean),
          { ...base, ...(viewer ? { viewer } : {}) } as never,
        ).catch(reject);
        // 请求体在监听器挂好后投递(readBody 同步挂监听,microtask 之后必在)。
        queueMicrotask(() => {
          const req = request as never as EventEmitter;
          if (body !== undefined) {
            (req as never as { emit: (e: string, d?: Buffer) => boolean })
              .emit("data", Buffer.from(JSON.stringify(body)));
          }
          req.emit("end");
        });
      });
  try {
    // 匿名拉单:owner 必填,缺省不再静默查空。
    const noOwner = await call("GET", "/issues/dts");
    assert.equal(noOwner.status, 400);
    assert.match(String(noOwner.body.error), /缺少 owner/);
    const list = await call("GET", "/issues/dts?owner=zhangsan");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.tickets) && list.body.tickets.length > 0,
      "匿名按 owner 拉到名下问题单");

    // 匿名单据详情:按单号直查,与登录用户同尺。
    const detail = await call("GET", "/issues/dts/DTS-2026-1002");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.ticket, "DTS-2026-1002");

    // 匿名读绑定映射与写改选:account 自报,缺席打回。
    assert.equal(
      (await call("GET", "/issues/dts-bindings")).status, 200);
    const noAccount = await call("PUT", "/issues/dts-bindings/DTS-2026-1002",
      { module_id: "mod-msg" });
    assert.equal(noAccount.status, 400);
    assert.match(String(noAccount.body.error), /操作人账号/);
    const bound = await call("PUT", "/issues/dts-bindings/DTS-2026-1002",
      { module_id: "mod-msg", account: "zhangsan" });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.equal(
      readDtsModuleBindings(dir)["DTS-2026-1002"]?.updated_by, "zhangsan",
      "匿名改选的 updated_by 来自请求体 account");

    // 登录态优先:客户端改写不收,与 POST /issues 登记人同哲学。
    const spoof = await call("PUT", "/issues/dts-bindings/DTS-2026-1003",
      { module_id: "mod-msg", account: "someoneelse" },
      { username: "dev", role: "developer" });
    assert.equal(spoof.status, 200, JSON.stringify(spoof.body));
    assert.equal(
      readDtsModuleBindings(dir)["DTS-2026-1003"]?.updated_by, "dev",
      "登录在场时 updated_by 恒取登录身份");

    // 清单之外:读侧(会话列表/内嵌图代理)与写侧(登记)默认仍闸。
    assert.equal((await call("GET", "/issues")).status, 401);
    assert.equal(
      (await call("GET", "/issues/dts-file?path=/x")).status, 401);
    assert.equal((await call("POST", "/issues", {})).status, 401);

    // 无鉴权本地单人形态不受匿名契约影响:缺 owner 仍走原缺省。
    const local = await call("GET", "/issues/dts", undefined, undefined,
      { issueFlow: service, dts: routes.dts, authEnabled: false });
    assert.equal(local.status, 200,
      "authEnabled:false 的本地形态缺 owner 不打回");
  } finally {
    await service.shutdown().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("服务级:business-modules 仅 GET 列表放行,people 匿名可读,其余保护路由仍 401", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-anon-allowlist-http-"));
  createBusinessModule(dir, {
    id: "mod-msg", name: "消息中心", description: "测试模块",
    owner: "expert", repositories: ["https://example.test/msg.git"],
  }, "expert");
  const tasks = new TaskService({ dataDir: dir, ...settings });
  const issues = new IssueFlowService({
    dataDir: dir, ...settings, dts: new MockDtsGateway(),
    deferRecovery: true, maxConcurrentTurns: 0,
  });
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("expert", "expert-password", "developer");
  const server = createTaskServer(tasks, {
    auth, issueFlow: issues, dts: new MockDtsGateway(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const modules = await fetch(`${base}/business-modules`);
    assert.equal(modules.status, 200, "模块目录匿名可读");
    const catalog = await modules.json() as { modules: unknown[] };
    assert.ok(catalog.modules.some((m) =>
      (m as { id?: string }).id === "mod-msg"));

    // 同前缀的其余动作(写、逐模块读)不放行——允许清单精确到 method+path。
    assert.equal((await fetch(`${base}/business-modules`, {
      method: "POST", body: JSON.stringify({ name: "x" }),
    })).status, 401);
    assert.equal((await fetch(`${base}/business-modules/mod-msg`, {
      method: "PUT", body: JSON.stringify({ name: "x" }),
    })).status, 401);
    assert.equal((await fetch(`${base}/business-modules/mod-msg`)).status, 401,
      "只有列表 GET 放行,逐模块读仍在闸后");

    const people = await fetch(`${base}/auth/people`);
    assert.equal(people.status, 200, "人员名单匿名可读(工号→姓名翻译)");
    const identities = await people.json() as Array<Record<string, unknown>>;
    assert.ok(identities.some((p) => p.username === "expert"));
    assert.equal((await fetch(`${base}/auth/me`)).status, 401,
      "people 之外的 auth 读仍需登录");
    assert.equal((await fetch(`${base}/auth/users`)).status, 401);

    // 默认拒绝的抽样:任务域与会话列表不因本改动松闸。
    assert.equal((await fetch(`${base}/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/issues`)).status, 401);

    // 端到端穿一次真服务:匿名拉单与绑定读。
    const list = await fetch(`${base}/issues/dts?owner=zhangsan`);
    assert.equal(list.status, 200);
    const payload = await list.json() as { tickets: unknown[] };
    assert.ok(payload.tickets.length > 0);
    assert.equal((await fetch(`${base}/issues/dts-bindings`)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await issues.shutdown().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
