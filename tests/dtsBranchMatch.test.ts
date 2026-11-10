/**
 * 分支匹配(ADR-0038)的契约钉:配置中心版本→分支映射按「单据版本
 * 包含配置版本,多命中取最长」生效于三条缝——
 * 1. 纯函数口径(configurationCenter 的 matchProductVersion);
 * 2. HTTP 缝:列表/详情逐单带分支,dts 来源发起未配置即拒(静默兜底
 *    "未匹配沿用原基线"退役),显式 product_version(手工登记)不认包含;
 * 3. 拉仓缝:基线分支在远端缺失即硬失败,不再退默认分支继续。
 * HTTP 缝的夹具先例:configurationCenter.test.ts;拉仓直驱先例:
 * issuePullRepoOwnership.test.ts 的 handcraftLive。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { matchProductVersion, saveProductVersion } from "../src/configurationCenter.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import {
  MockDtsGateway,
  type DtsTicketBrief,
  type DtsTicketDetail,
} from "../src/issueFlow/gateways.ts";
import {
  FIXED_TICKET_STAGES,
  saveState,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { MODULE_ID, seedModule } from "./issueFlowFixed.helpers.ts";

const settings = { provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };

/** 版本组与更短的段互为包含,正好钉"最长命中"。 */
const GROUP = "V100R025C10SPC010";
const GROUP_BRANCH = "release/V100R025C10SPC010";
const SHORT = "V100R025C10";
const SHORT_BRANCH = "release/V100R025C10";
const B_VERSION = `${GROUP}B009`;

test("matchProductVersion:包含命中,多命中取最长,未命中与无版本返回 undefined", () => {
  const rows = [
    { id: "1", version: GROUP, branch: GROUP_BRANCH },
    { id: "2", version: SHORT, branch: SHORT_BRANCH },
  ];
  const best = matchProductVersion(rows, B_VERSION);
  assert.equal(best?.version, GROUP, "更长的配置段是更具体的命中");
  assert.equal(best?.branch, GROUP_BRANCH);
  assert.equal(matchProductVersion(rows, `${SHORT}B001`)?.version, SHORT);
  assert.equal(matchProductVersion(rows, "V9R1C99X"), undefined,
    "不包含任何配置版本即未命中");
  assert.equal(matchProductVersion(rows, undefined), undefined);
  assert.equal(matchProductVersion(rows, ""), undefined);
  assert.equal(matchProductVersion([], B_VERSION), undefined);
});

test("mock 详情必须携带版本:发起的分支硬闸按 detail.version 解析基线", async () => {
  // 回归钉(8787 实测):mock 列表带版本、详情不带,列上明明有分支,
  // 发起却被硬闸以「未能读取单据版本」打回——详情与列表必须同源。
  const dts = new MockDtsGateway();
  const briefs = await dts.listByOwner("dev");
  const withVersion = briefs.find(t => t.version);
  assert.ok(withVersion?.version, "mock 数据集里应有带版本的单");
  const detail = await dts.detail(withVersion.ticket);
  assert.equal(detail.version, withVersion.version,
    "detail.version 必须与列表同源(分支硬闸的解析输入)");
});

test("HTTP:列表与详情逐单带分支(最长命中),未配置的单不带分支字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-branch-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("dev", "dev-password", "developer");
  const dts = new MockDtsGateway();
  dts.listByOwner = async () => [
    { ticket: "DTS-B009", title: "带 B 段的单", version: B_VERSION },
    { ticket: "DTS-NOMATCH", title: "版本没配过", version: "V9R1C99X" },
    { ticket: "DTS-NOVERSION", title: "老单没有版本" },
  ] as DtsTicketBrief[];
  const issues = new IssueFlowService({ dataDir: dir, ...settings, dts, deferRecovery: true, maxConcurrentTurns: 0 });
  const server = createTaskServer(new TaskService({ dataDir: dir, ...settings }), { auth, issueFlow: issues, dts });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    saveProductVersion(dir, { version: GROUP, branch: GROUP_BRANCH });
    saveProductVersion(dir, { version: SHORT, branch: SHORT_BRANCH });
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "dev", password: "dev-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const list = await fetch(`${base}/issues/dts`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const { tickets } = await list.json() as { tickets: DtsTicketBrief[] };
    const byTicket = new Map(tickets.map(t => [t.ticket, t]));
    assert.equal(byTicket.get("DTS-B009")?.branch, GROUP_BRANCH,
      "B 段单据同时包含两个配置版本,取最长命中");
    assert.equal("branch" in byTicket.get("DTS-NOMATCH")!, false,
      "未配置版本不加分支字段(前端按未配置分支呈现)");
    assert.equal("branch" in byTicket.get("DTS-NOVERSION")!, false);

    dts.detail = async () => ({
      ticket: "DTS-B009", title: "带 B 段的单", content: "【单据原文】",
      version: B_VERSION,
    });
    const detail = await fetch(`${base}/issues/dts/DTS-B009`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as DtsTicketDetail).branch, GROUP_BRANCH,
      "详情与列表同源补分支:远程查单入列不缺席");
  } finally {
    await issues.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP:dts 发起按包含匹配快照分支,未配置即 400,显式版本仍精确解析", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-branch-create-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("dev", "dev-password", "developer");
  const dts = new MockDtsGateway();
  const originalDetail = dts.detail.bind(dts);
  dts.detail = async ticket => ({ ...await originalDetail(ticket), version: B_VERSION });
  const issues = new IssueFlowService({ dataDir: dir, ...settings, dts, deferRecovery: true, maxConcurrentTurns: 0 });
  const server = createTaskServer(new TaskService({ dataDir: dir, ...settings }), { auth, issueFlow: issues, dts });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    saveProductVersion(dir, { version: GROUP, branch: GROUP_BRANCH });
    saveProductVersion(dir, { version: SHORT, branch: SHORT_BRANCH });
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "dev", password: "dev-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const create = (body: Record<string, unknown>) => fetch(`${base}/issues`, {
      method: "POST", headers: { cookie }, body: JSON.stringify(body),
    });

    // 模块发起闸(ADR-0056,65532d4f):DTS 来源必带模块且闸在分支闸之前,
    // 夹具先种模块并随单带 module_id,下面测的才是分支闸。
    seedModule(dir, join(dir, "seed-repo.git"));
    const ticket = (await dts.listByOwner("dev"))[0].ticket;
    const auto = await create({ title: "自动带分支", source: "dts", ticket, module_id: MODULE_ID });
    assert.equal(auto.status, 201);
    const autoState = await auto.json() as { baseline: string; product_version: string };
    assert.equal(autoState.product_version, GROUP, "多命中取最长");
    assert.equal(autoState.baseline, GROUP_BRANCH, "解析结果快照为基线");

    dts.detail = async ticket => ({ ...await originalDetail(ticket), version: "V9R1C99X" });
    const unmatched = await create({ title: "版本没配过", source: "dts", ticket, module_id: MODULE_ID });
    assert.equal(unmatched.status, 400, "未配置分支禁止发起(兜底退役)");
    assert.match((await unmatched.json() as { error: string }).error, /未配置分支/);

    dts.detail = async ticket => ({ ...await originalDetail(ticket), version: undefined });
    const noVersion = await create({ title: "老单没有版本", source: "dts", ticket, module_id: MODULE_ID });
    assert.equal(noVersion.status, 400, "读不到版本同尺拒绝:没有分支就不发车");
    assert.match((await noVersion.json() as { error: string }).error, /未配置分支/);

    // 手工登记路径不受影响:显式 product_version 仍走精确解析。
    // 无单登记有模块与环境两道既有闸(仓从模块带、现场凭据要齐),
    // 夹具按 HTTP wire 形带上(backend_password 是 routes 读的字段名)。
    const manual = await create({
      title: "手工登记", assignee: "dev", product_version: SHORT,
      module_id: MODULE_ID,
      environment: { hosts: ["192.0.2.8"], backend_password: "env-secret" },
    });
    assert.equal(manual.status, 201);
    assert.equal((await manual.json() as { baseline: string }).baseline, SHORT_BRANCH);

    // 显式给了一个包含形态但配置里没有的版本:精确解析照旧打回,不放宽。
    const explicitMiss = await create({
      title: "显式版本不存在", assignee: "dev", product_version: B_VERSION,
    });
    assert.equal(explicitMiss.status, 400);
  } finally {
    await issues.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 拉仓硬失败(ADR-0038) ---------- */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const TICKET = "DTS-2026-1038";

/** 造一个只有默认分支 master 的裸仓远端——配置的基线分支在它身上必然缺席。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"],
    { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin],
    { env: GIT_ENV });
  return origin;
}

/** 直驱 pullRepoFor(私有方法按 as 直取,先例:issuePullRepoOwnership)。 */
function handcraftLive(
  service: IssueFlowService, root: string, origin: string, baseline?: string,
): { id: string; root: string; state: IssueSessionState } {
  const state: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "分支硬失败回归", description: "", source: "dts",
    ticket: TICKET, repo_url: origin, repo_urls: [origin],
    ...(baseline ? { baseline } : {}),
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
    status: "idle", stage: "prep_repo", stage_note: "",
    stage_at: new Date().toISOString(),
  };
  saveState(root, state);
  const live = { id: "issue-1", root, state };
  (service as unknown as { live: Map<string, unknown> }).live.set(live.id, live);
  return live;
}

type PullRepoFor = (live: unknown, url: string) => Promise<{
  dir: string; cloned: boolean; branch?: string; head: string;
}>;

function pullRepoFor(service: IssueFlowService): PullRepoFor {
  return (service as unknown as { pullRepoFor: PullRepoFor })
    .pullRepoFor.bind(service);
}

test("拉仓硬失败:基线分支在远端不存在,整次失败且不落默认分支克隆", async () => {
  const dataDir = mfcTemp("mfc-branch-pull-miss-");
  const origin = bareOrigin(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      origin, "release/missing");
    await assert.rejects(
      pullRepoFor(service)(live, origin),
      /基线分支 release\/missing 在远端不存在/,
      "硬失败并点名缺失的分支,让 AI 如实上报",
    );
    assert.equal(existsSync(join(live.root, "repo", "origin", ".git")), false,
      "不许悄悄退回默认分支克隆");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("无基线的有单会话:修复分支无从命名,克隆之前就报错点名基线(ADR-0063)", async () => {
  const dataDir = mfcTemp("mfc-branch-pull-nobaseline-");
  const origin = bareOrigin(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      origin);
    await assert.rejects(
      pullRepoFor(service)(live, origin),
      /会话没有基线分支,无法命名修复分支/,
      "人话点名缺基线:修复分支以基线为前缀,不回退默认分支",
    );
    assert.equal(existsSync(join(live.root, "repo", "origin", ".git")), false,
      "命名先行:克隆都不该发生,不留默认分支克隆");
    assert.equal(live.state.fix_branch, undefined, "不落分支名");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

/* ---------- 分支列的 UI 源码契约(ADR-0038,先例:issueUiContracts) ---------- */

const registration = readFileSync(
  new URL("../web/src/issues/Registration.tsx", import.meta.url), "utf-8");

test("UI 契约:分支列退役,未配置信号收拢到版本过滤提示条并深链配置中心,选择框在 DTS 列表退役", () => {
  // 65532d4f(2026-09-24,ADR-0038 修订):版本/分支列退役并入工具栏版本组
  // 过滤,未配置分支的信号收拢到过滤框旁的红色提示条。
  assert.doesNotMatch(registration, /colKey="branch"/, "分支列已退役");
  assert.doesNotMatch(registration, /renderCol\("branch"\)/);
  // 未命中:提示条点名版本组并深链配置中心「版本与分支」页签。
  assert.match(registration, /未配置分支映射/);
  assert.match(registration, /href="\/configuration\?tab=versions"/);
  // 勾选闸(逐单强制项不变):未配置分支的行禁勾(与已发起、未匹配模块
  // 同格,ADR-0056),全选不含它们。
  assert.match(registration,
    /disabled=\{!!mineLive \|\| !ticket\.branch \|\| !resolvedModule\}/);
  assert.match(registration,
    /\.filter\(\(t\) => !mineLiveByTicket\.has\(t\.ticket\) && !!t\.branch\b/);
  // 选择框退役:DTS 列表不再挂 ProductVersionPicker,登记表单保留
  // 唯一一处;旧的"精确匹配/沿用基线"说明文案随选择框删除。
  assert.equal(
    (registration.match(/<ProductVersionPicker/g) ?? []).length, 1,
    "ProductVersionPicker 只许住在手工登记表单一处(DTS 列表已退役)");
  assert.doesNotMatch(registration, /批量发起可统一选择版本/);
  assert.doesNotMatch(registration, /source: "dts",\s*\n\s*product_version/,
    "DTS 发起不再携带全局选择的版本,分支由服务端按单据版本解析"
    + "(手工登记表单的显式版本不受此限)");
  // 远程查单入列带分支,不然绕过列表的单子全员误报未配置。
  assert.match(registration, /branch: detail\.branch/);
});
