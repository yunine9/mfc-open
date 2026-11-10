/**
 * DTS 自动接单单级排除(ADR-0070):改写接口一对(PUT 设置/DELETE
 * 取消)与列表富集的契约测试。
 * - 登录闸:新改写接口不进免登录允许清单(ADR-0069 结构性默认),
 *   匿名 PUT/DELETE 一律 401;
 * - 读写回环(登录态):PUT 落条目(操作人恒取登录身份,请求体
 *   account 改写不收)、DELETE 删条目不留墓碑且幂等、坏单号打回;
 * - 列表富集:GET /issues/dts 行数据带排除标记字段(照 branch/
 *   module_id 的富集位置:被排除才带字段,缺省允许不带);
 * - 无鉴权本地单人形态:account 自报操作人(与 dts-bindings 同哲学),
 *   缺席打回。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

const SETTINGS = {
  provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
};

/** 假 DTS 网关:名下两张可拉的单,列表富集断言用。 */
const fakeDts = {
  async listByOwner() {
    return [
      { ticket: "DTS20261031001", title: "排除标记单", status: "开发人员实施修改" },
      { ticket: "DTS20261031002", title: "缺省允许单", status: "开发人员实施修改" },
    ];
  },
  async detail() {
    throw new Error("测试不查详情");
  },
  async proxyFile() {
    throw new Error("测试不取文件");
  },
};

/** 排除存储的盘上形状(spec 定稿):{version:1, exclusions:Record}。 */
function storedExclusions(
  dataDir: string,
): Record<string, { updated_by: string; updated_at: string }> {
  const file = join(dataDir, "dts-auto-claim-exclusions.json");
  return JSON.parse(readFileSync(file, "utf-8")).exclusions;
}

test("排除改写接口:登录态读写回环、操作人取登录身份、匿名 401、列表富集", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-dts-claim-excl-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("dev", "dev-password", "developer");
  const issues = new IssueFlowService({
    dataDir: dir, ...SETTINGS, deferRecovery: true, maxConcurrentTurns: 0,
  });
  const server = createTaskServer(
    new TaskService({ dataDir: dir, ...SETTINGS }), {
      auth, issueFlow: issues, dts: fakeDts as never,
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // 匿名:改写接口不在免登录允许清单(ADR-0069),设置/取消都被
    // 登录闸拦——排除是有操作人的团队决定,不是匿名参考数据。
    assert.equal((await fetch(`${base}/issues/dts-auto-claim-exclusions/DTS20261031001`, {
      method: "PUT", body: JSON.stringify({}),
    })).status, 401);
    assert.equal((await fetch(`${base}/issues/dts-auto-claim-exclusions/DTS20261031001`, {
      method: "DELETE",
    })).status, 401);

    const dev = (await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "dev", password: "dev-password" }),
    })).headers.get("set-cookie")!.split(";")[0];

    // 设置排除:请求体 account 改写不收,操作人恒取登录身份。
    const put = await fetch(`${base}/issues/dts-auto-claim-exclusions/DTS20261031001`, {
      method: "PUT", headers: { cookie: dev },
      body: JSON.stringify({ account: "someoneelse" }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json() as Record<string, unknown>;
    assert.equal(putBody.excluded, true);
    assert.equal(putBody.updated_by, "dev");
    assert.equal(storedExclusions(dir)["DTS20261031001"]?.updated_by, "dev",
      "盘上条目记登录身份,不是请求体自报的 account");

    // 列表富集:被排除的单带 auto_claim_excluded,缺省允许的不带字段。
    const list = await fetch(`${base}/issues/dts`, { headers: { cookie: dev } });
    assert.equal(list.status, 200);
    const byTicket = new Map<string, Record<string, unknown>>(
      ((await list.json() as { tickets: Array<Record<string, unknown>> }).tickets)
        .map((row) => [String(row.ticket), row]));
    assert.equal(byTicket.get("DTS20261031001")?.auto_claim_excluded, true);
    assert.equal(byTicket.get("DTS20261031002")?.auto_claim_excluded, undefined,
      "未排除不带字段(缺省允许)");

    // 取消排除:删条目不留墓碑,幂等;列表随即回到缺省允许。
    const del = await fetch(`${base}/issues/dts-auto-claim-exclusions/DTS20261031001`, {
      method: "DELETE", headers: { cookie: dev },
    });
    assert.equal(del.status, 200);
    assert.equal((await del.json() as Record<string, unknown>).excluded, false);
    assert.equal(storedExclusions(dir)["DTS20261031001"], undefined);
    assert.equal((await fetch(`${base}/issues/dts-auto-claim-exclusions/DTS20261031001`, {
      method: "DELETE", headers: { cookie: dev },
    })).status, 200, "重复取消幂等");
    const afterCancel = await fetch(`${base}/issues/dts`, { headers: { cookie: dev } });
    const rowsAfter = ((await afterCancel.json() as { tickets: Array<Record<string, unknown>> }).tickets);
    assert.ok(rowsAfter.every((row) => row.auto_claim_excluded === undefined));

    // 坏单号:与问题流服务端同一把尺,409 人话打回。
    const badTicket = await fetch(
      `${base}/issues/dts-auto-claim-exclusions/${encodeURIComponent("坏 单号")}`,
      { method: "PUT", headers: { cookie: dev }, body: JSON.stringify({}) });
    assert.equal(badTicket.status, 409);
    assert.match(String((await badTicket.json() as { error: string }).error),
      /格式不合法/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await issues.shutdown().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无鉴权本地单人形态:account 自报操作人,缺席打回(与 dts-bindings 同哲学)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-dts-claim-excl-local-"));
  const service = new IssueFlowService({ dataDir: dir, ...SETTINGS });
  const call = (method: string, ticket: string, body?: unknown) =>
    new Promise<{ status: number; body: Record<string, any> }>(
      (resolve, reject) => {
        let status = 0;
        const request = new EventEmitter() as any;
        request.method = method;
        request.url = `/issues/dts-auto-claim-exclusions/${ticket}`;
        void handleIssueRoutes(request, {
          writeHead: (code: number) => { status = code; },
          end: (payload?: string) => {
            try {
              resolve({ status, body: JSON.parse(payload ?? "{}") });
            } catch (error) { reject(error); }
          },
        } as any,
        ["issues", "dts-auto-claim-exclusions", ticket],
        { issueFlow: service, authEnabled: false },
      ).catch(reject);
        queueMicrotask(() => {
          if (body !== undefined) {
            request.emit("data", Buffer.from(JSON.stringify(body)));
          }
          request.emit("end");
        });
      });
  try {
    // 无登录态的世界:操作人由请求体 account 自报,缺席打回。
    const noAccount = await call("PUT", "DTS20261031003");
    assert.equal(noAccount.status, 400);
    assert.match(String(noAccount.body.error), /操作人账号/);
    const self = await call("PUT", "DTS20261031003", { account: "zhangsan" });
    assert.equal(self.status, 200);
    assert.equal(self.body.updated_by, "zhangsan");
  } finally {
    await service.shutdown().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
