/**
 * 自动接单(ADR-0061)单拍扫描契约测试。
 *
 * runAutoClaimTick 是纯旁路的扫描-过滤-发起一拍,依赖已收窄成结构
 * 接口(AutoClaimIssueFlow/Auth/Settings),这里用记录器假件驱动:
 * - 同尺过滤矩阵:状态/版本映射/参与标记/模块强匹配逐闸断言,
 *   宁可漏发不可错发;
 * - 发起身份:责任人自登记(account=assignee=reporter)+ 发起方式=
 *   自动标记,create 硬闸抛错即静默跳过;
 * - 名单现读现判:空名单不碰网关,加名单下一拍生效;
 * - 审计账:claimed/skipped/list_failed 落 issue-auto-claim.jsonl
 *   (configureAudit 注入进程账目录,断言落盘行)。
 *
 * 不起真 IssueFlowService:create 的硬闸语义(去重/凭据门)由服务侧
 * 测试覆盖,这里断言的是"调度器把对的输入交给 create、把拒绝如实
 * 记账"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { configureAudit } from "../src/issueFlow/audit.ts";
import {
  DTS_CLAIMABLE_STATUS,
  autoClaimNextRunAt,
  runAutoClaimTick,
  startAutoClaimScheduler,
  type AutoClaimIssueFlow,
} from "../src/issueFlow/autoClaim.ts";
import type { DtsGateway, DtsTicketBrief } from "../src/issueFlow/gateways.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueCreateInput, IssueSummary } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

const CLAIMABLE = DTS_CLAIMABLE_STATUS;
const VERSION_GROUP = "V100R025C10SPC010";
const B_VERSION = `${VERSION_GROUP}B009`;

function seedFixture(dataDir: string): void {
  // 版本与分支映射(配置中心数据面):v1 参与自动接单,v2 不参与。
  writeFileSync(join(dataDir, "product-versions.json"), JSON.stringify([
    { id: "v1", version: VERSION_GROUP, branch: "master", auto_claim: true },
    { id: "v2", version: "V90R001", branch: "legacy" },
  ]));
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev1", repositories: ["https://codehub.example.com/pay/core.git"],
  }, "tester");
}

/** 单据行夹具:字段即 DTS listByOwner 的 brief 形状。 */
function brief(overrides: Partial<DtsTicketBrief> & { ticket: string }): DtsTicketBrief {
  return {
    title: `问题 ${overrides.ticket}`,
    status: CLAIMABLE,
    version: B_VERSION,
    featureName: "支付核心",
    ...overrides,
  };
}

interface FakeDepsOptions {
  accounts?: string[];
  briefs?: DtsTicketBrief[];
  /** 按账号抛错模拟网关异常。 */
  failAccounts?: string[];
  /** create 抛错模拟服务端硬闸(去重/凭据门等)。 */
  createError?: Error;
  knobs?: Record<string, unknown>;
}

function fakeDeps(dataDir: string, options: FakeDepsOptions = {}) {
  const created: IssueCreateInput[] = [];
  const listed: string[] = [];
  const summary = (input: IssueCreateInput): IssueSummary => ({
    id: `issue-${created.length + 1}`, account: input.account,
    created_at: "", updated_at: "", title: input.title,
    description: "", source: input.source ?? "dts",
    status: "queued", stage: "dts_info",
    ...(input.ticket ? { ticket: input.ticket } : {}),
  } as unknown as IssueSummary);
  const deps = {
    dts: {
      async listByOwner(account: string) {
        listed.push(account);
        if (options.failAccounts?.includes(account)) {
          throw new Error("MCP 网关超时");
        }
        return options.briefs ?? [];
      },
      async detail() {
        throw new Error("测试不查详情");
      },
      async proxyFile() {
        throw new Error("测试不取文件");
      },
    } satisfies DtsGateway,
    issueFlow: {
      dataDir,
      create(input: IssueCreateInput): IssueSummary {
        if (options.createError) throw options.createError;
        created.push(input);
        return summary(input);
      },
    } satisfies AutoClaimIssueFlow,
    auth: { issueAutoClaimAccounts: () => options.accounts ?? [] },
    settings: { runtime: () => ({ ...(options.knobs ?? {}) }) },
  };
  return { deps, created, listed };
}

function auditRows(dataDir: string): Array<Record<string, unknown>> {
  const file = join(dataDir, "logs", "issue-auto-claim.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line));
}

/** 种排除存储(ADR-0070):直接落 dts-auto-claim-exclusions.json 的
 * 真实形状,条目在场=排除;空对象=全部取消(条目删除,不留墓碑)。 */
function seedExclusions(
  dataDir: string,
  exclusions: Record<string, { updated_by: string; updated_at: string }>,
): void {
  writeFileSync(join(dataDir, "dts-auto-claim-exclusions.json"),
    JSON.stringify({ version: 1, exclusions }));
}

test("同尺过滤矩阵:各闸各挡,全过的单才发起", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-");
  seedFixture(dataDir);
  const { deps, created } = fakeDeps(dataDir, {
    accounts: ["dev1"],
    briefs: [
      brief({ ticket: "DTS1", status: "待验证" }),
      brief({ ticket: "DTS2", status: undefined }),
      brief({ ticket: "DTS3", version: "V88R001C00" }),
      brief({ ticket: "DTS4", version: "V90R001C10B002" }),
      brief({ ticket: "DTS5", featureName: "未登记的特性" }),
      brief({ ticket: "DTS6" }),
    ],
  });
  const outcome = await runAutoClaimTick(deps);
  // 六张单只有一张全过:宁可漏发不可错发。
  assert.equal(created.length, 1);
  assert.equal(outcome.claimed.length, 1);
  assert.equal(outcome.skipped, 5);
  const input = created[0];
  assert.equal(input.ticket, "DTS6");
  // 发起身份=责任人自登记(ADR-0031),发起方式=自动(ADR-0061)。
  assert.equal(input.account, "dev1");
  assert.equal(input.assignee, "dev1");
  assert.equal(input.reporter, "dev1");
  assert.equal(input.source, "dts");
  assert.equal(input.autoClaim, true);
  assert.equal(input.moduleId, "pay-core");
  // 产品版本取配置中心命中的版本组(不是单据的 B 版原文)。
  assert.equal(input.productVersion, VERSION_GROUP);
});

test("create 硬闸拒绝(如凭据门)→ 静默跳过并落审计原因", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-");
  seedFixture(dataDir);
  configureAudit(join(dataDir, "logs"));
  const { deps, created } = fakeDeps(dataDir, {
    accounts: ["dev1"],
    briefs: [brief({ ticket: "DTSOK" })],
    createError: new Error(
      "责任人 dev1 的 Git 令牌未配置(个人设置 → 个人接入)"),
  });
  const outcome = await runAutoClaimTick(deps);
  assert.equal(created.length, 0);
  assert.equal(outcome.skipped, 1);
  const rows = auditRows(dataDir).filter((row) => row.ticket === "DTSOK");
  assert.ok(rows.some((row) => row.kind === "auto_claim.skipped"
    && String(row.reason).includes("发起被拒")
    && String(row.reason).includes("Git 令牌未配置")));
});

test("开关现读现判:未开启不碰网关,开启后下一拍生效", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-");
  seedFixture(dataDir);
  let accounts: string[] = [];
  const { deps, listed, created } = fakeDeps(dataDir, {
    briefs: [brief({ ticket: "DTSOK" })],
  });
  const live = deps as typeof deps & {
    auth: { issueAutoClaimAccounts(): string[] };
  };
  live.auth.issueAutoClaimAccounts = () => accounts;
  await runAutoClaimTick(deps);
  assert.deepEqual(listed, []);
  assert.equal(created.length, 0);
  accounts = ["dev1"];
  const outcome = await runAutoClaimTick(deps);
  assert.deepEqual(listed, ["dev1"]);
  assert.equal(outcome.claimed.length, 1);
});

test("DTS 网关异常只跳过该账号,其他名单用户照扫", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-");
  seedFixture(dataDir);
  configureAudit(join(dataDir, "logs"));
  const { deps, listed, created } = fakeDeps(dataDir, {
    accounts: ["dev1", "dev2"],
    failAccounts: ["dev1"],
    briefs: [brief({ ticket: "DTSOK" })],
  });
  const outcome = await runAutoClaimTick(deps);
  assert.deepEqual(listed, ["dev1", "dev2"]);
  assert.equal(created.length, 1);
  assert.equal(created[0].account, "dev2");
  assert.equal(outcome.claimed.length, 1);
  const failures = auditRows(dataDir)
    .filter((row) => row.kind === "auto_claim.list_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].account, "dev1");
});

test("审计账:claimed 带会话 id,skipped 带可读原因", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-");
  seedFixture(dataDir);
  configureAudit(join(dataDir, "logs"));
  await runAutoClaimTick(fakeDeps(dataDir, {
    accounts: ["dev1"],
    briefs: [
      brief({ ticket: "DTSPASS" }),
      brief({ ticket: "DTSOLD", version: "V90R001C10B002" }),
    ],
  }).deps);
  const rows = auditRows(dataDir);
  const claimed = rows.find((row) => row.kind === "auto_claim.claimed");
  assert.ok(claimed);
  assert.equal(claimed.ticket, "DTSPASS");
  assert.match(String(claimed.issue_id), /^issue-\d+$/);
  assert.match(String(claimed.msg), /自动接单发起 DTSPASS/);
  const skipped = rows.find((row) => row.kind === "auto_claim.skipped");
  assert.ok(skipped);
  assert.equal(skipped.reason, "版本组未标记参与自动接单");
});

test("个人自助开关(2026-10-10 修订):本人翻转生效,管理员拒收,下次发起接口未装配为已暂停", async () => {
  const dir = mfcTemp("mfc-autoclaim-http-");
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("dev", "dev-password", "developer");
  const issues = new IssueFlowService({
    dataDir: dir, provider: "test", model: "test", modelsJson: {},
    deferRecovery: true, maxConcurrentTurns: 0,
  });
  const server = createTaskServer(
    new TaskService({
      dataDir: dir, provider: "test", model: "test", modelsJson: {},
    }), {
      auth, issueFlow: issues,
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cookieOf = async (username: string, password: string) =>
      (await fetch(`${base}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username, password }),
      })).headers.get("set-cookie")!.split(";")[0];
    const dev = await cookieOf("dev", "dev-password");
    const admin = await cookieOf("admin", "admin-password");

    // 缺省关闭:sessionView 带当前态。
    const me = await fetch(`${base}/auth/me`, { headers: { cookie: dev } });
    assert.equal((await me.json() as { issue_auto_claim: boolean })
      .issue_auto_claim, false);

    // 下次发起接口:调度器未装配(测试形态)→ null,前端显示已暂停;
    // 未登录 401。
    const next = await fetch(`${base}/issues/auto-claim`, {
      headers: { cookie: dev },
    });
    assert.equal(next.status, 200);
    assert.equal((await next.json() as { next_run_at: string | null })
      .next_run_at, null);
    assert.equal((await fetch(`${base}/issues/auto-claim`)).status, 401);

    // 本人开启:自助路由翻转,扫描读取口随即看到他(现读现判)。
    const put = await fetch(`${base}/auth/me/issue-auto-claim`, {
      method: "PUT", headers: { cookie: dev },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json() as { issue_auto_claim: boolean })
      .issue_auto_claim, true);
    assert.deepEqual(auth.issueAutoClaimAccounts(), ["dev"]);

    // 管理员给自己开 → LocalAuth 拒收转 400。
    const adminPut = await fetch(`${base}/auth/me/issue-auto-claim`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(adminPut.status, 400);

    // 关闭即移出。
    await fetch(`${base}/auth/me/issue-auto-claim`, {
      method: "PUT", headers: { cookie: dev },
      body: JSON.stringify({ on: false }),
    });
    assert.deepEqual(auth.issueAutoClaimAccounts(), []);

    // 退役的管理员名单路由:落回 404 未知身份接口,防复活回归。
    const legacy = await fetch(`${base}/auth/users/dev/issue-auto-claim`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(legacy.status, 404);
  } finally {
    await issues.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("单级排除闸(ADR-0070):三闸全过的单被排除即跳过并落「用户排除」审计,取消下一拍恢复", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-");
  seedFixture(dataDir);
  configureAudit(join(dataDir, "logs"));
  const { deps, created } = fakeDeps(dataDir, {
    accounts: ["dev1"],
    briefs: [brief({ ticket: "DTSX" }), brief({ ticket: "DTSY" })],
  });
  // DTSX 三道预筛全过,但被用户标记排除:本拍跳过,只 DTSY 被接。
  seedExclusions(dataDir, {
    DTSX: { updated_by: "someone", updated_at: "2026-10-31T08:00:00Z" },
  });
  const first = await runAutoClaimTick(deps);
  assert.deepEqual(first.claimed.map((c) => c.ticket), ["DTSY"]);
  assert.equal(first.skipped, 1);
  assert.equal(created.length, 1);
  // 审计行与其他跳过可区分:原因单列「用户排除」语义,带操作人。
  const skipped = auditRows(dataDir)
    .filter((row) => row.ticket === "DTSX" && row.kind === "auto_claim.skipped");
  assert.equal(skipped.length, 1);
  assert.match(String(skipped[0].reason), /用户排除/);
  assert.match(String(skipped[0].reason), /someone/);
  // 取消排除(条目删除):同一单下一拍恢复自动接单。
  seedExclusions(dataDir, {});
  const second = await runAutoClaimTick(deps);
  assert.deepEqual(second.claimed.map((c) => c.ticket), ["DTSX", "DTSY"]);
  assert.equal(second.skipped, 0);
});

test("调度器排程:装配即有下次扫描时刻,间隔改 0 重排后转入已暂停", async () => {
  const dataDir = mfcTemp("mfc-autoclaim-sched-");
  // knobs 对象在闭包里被 runtime() 现读,测试中途改值即模拟管理页热改。
  const knobs: Record<string, unknown> = { issue_auto_claim_interval_s: 1 };
  const { deps } = fakeDeps(dataDir, { accounts: ["dev1"], knobs });
  startAutoClaimScheduler(deps);
  // 排程同步完成:装配即有时刻;1 秒一拍,重排持续在刷。
  assert.ok(autoClaimNextRunAt(), "装配后应有下次扫描时刻");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(autoClaimNextRunAt());
  // 旋钮改 0:下一拍到点(≤1s)重排后为 null——个人开关不动,扫描暂停。
  knobs.issue_auto_claim_interval_s = 0;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(autoClaimNextRunAt(), null);
});
