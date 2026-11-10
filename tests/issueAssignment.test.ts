/**
 * 登记指派(ADR-0031)的后端契约:会话归属=责任人,登记人只读跟踪。
 * - 带责任人登记:归属=责任人、登记人=登录态用户,wire 钉住;
 * - 手工登记缺责任人 409 人话;责任人是管理员/不存在拒绝(指派校验);
 * - Git 凭据门改查责任人并点名(登记人≠责任人时文案换人称,自登记
 *   维持"你");
 * - 指派通知发给责任人(FakeLubanServer),自登记不发、登记人不收;
 * - 单一列表:归属或登记人是自己,推进与跟踪同列;
 * - 存量 issue.json 无登记人字段回填=归属;挂起转正拷贝登记人。
 *
 * 行为断言走真路由(先例:issueViewMode/issueFlowContract),通知走
 * FakeLubanServer(先例:issueFlowNotify);会话夹具直接落 issue.json。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import {
  handleIssueRoutes,
  type IssueViewer,
} from "../src/issueFlow/routes.ts";
import { issueFixedOpeningPrompt, issueResumePrompt } from "../src/issueFlow/prompt.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveProductVersion } from "../src/configurationCenter.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { mfcTemp } from "./mfcTmp.ts";

const LINK_BASE = "https://mfc.example.com";

/** 登记人视角(测试):发现并描述问题、指派责任人。 */
const TESTER: IssueViewer = { username: "tester", role: "developer" };
/** 责任人视角(开发):被指派后的问题归属人。 */
const OWNER_VIEWER: IssueViewer = { username: "dev", role: "developer" };

interface RouteResult {
  status: number;
  body: Record<string, any>;
}

/** 走一遍真路由(无 HTTP 服务器,先例 issueViewMode.callIssueRoute)。 */
function callIssueRoute(
  method: "GET" | "POST",
  parts: string[],
  options: {
    service: IssueFlowService;
    viewer?: IssueViewer;
    payload?: unknown;
    query?: string;
  },
): Promise<RouteResult> {
  return new Promise((resolve, reject) => {
    let status = 0;
    const finish = (text?: string): void => {
      resolve({ status, body: JSON.parse(text || "{}") });
    };
    const response: any = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (output?: string) => finish(output),
    };
    let request: any = { method, url: `/${parts.join("/")}${options.query ?? ""}` };
    if (method === "POST") {
      const emitter = new EventEmitter() as any;
      emitter.method = method;
      emitter.url = request.url;
      request = emitter;
    }
    void handleIssueRoutes(request, response, parts, {
      issueFlow: options.service,
      authEnabled: false,
      viewer: options.viewer,
    }).then(() => finish()).catch(reject);
    if (typeof request.emit === "function") {
      request.emit("data", Buffer.from(JSON.stringify(options.payload ?? {})));
      request.emit("end");
    }
  });
}

function writeSession(dataDir: string, state: Record<string, unknown>): void {
  mkdirSync(join(dataDir, "issues", String(state.id)), { recursive: true });
  writeFileSync(
    join(dataDir, "issues", String(state.id), "issue.json"),
    JSON.stringify(state));
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeService(
  dataDir: string,
  extra: Partial<ConstructorParameters<typeof IssueFlowService>[0]> = {},
): IssueFlowService {
  // 版本必填(2026-09-18)且须为配置中心在册版本:夹具统一播种一枚。
  saveProductVersion(dataDir, { version: "V100R027C10B005",
    branch: "release/V100R027C10B005" });
  return new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    ...extra,
  });
}

test("登记指派:带责任人创建——归属=责任人、登记人=登录态,wire 钉住", async () => {
  const dataDir = mfcTemp("mfc-issue-assign-create-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  const service = makeService(dataDir);
  try {
    const created = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", assignee: "dev", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(created.status, 201);
    // 归属=责任人;登记人=登录态(客户端改写 body.account 不收)。
    assert.equal(created.body.account, "dev",
      "归属账号必须是责任人,不是登记人");
    assert.equal(created.body.reporter, "tester",
      "登记人必须取自登录态,服务端不信客户端");
    // 单一列表(ADR-0031,2026-09-16 修订):归属**或**登记人是自己。
    // 责任人看得到(归属);登记人也看得到(登记人),同列跟踪。
    const mine = await callIssueRoute("GET", ["issues"], {
      service, viewer: OWNER_VIEWER,
    });
    assert.deepEqual((mine.body.issues as Array<{ id: string }>)
      .map((row) => row.id), [created.body.id]);
    const testerList = await callIssueRoute("GET", ["issues"], {
      service, viewer: TESTER,
    });
    assert.deepEqual((testerList.body.issues as Array<{ id: string }>)
      .map((row) => row.id), [created.body.id],
      "登记给他人的会话在登记人的「我的问题」列表里,无需切换范围");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("登记指派:手工登记缺责任人 409 人话;DTS 发起不带=自登记", async () => {
  const dataDir = mfcTemp("mfc-issue-assign-required-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  const service = makeService(dataDir);
  try {
    const missing = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /指名责任人/,
      "手工登记必填责任人:登记完成即移交,没有责任人就没有人接");
    // DTS 页签发起原样:不带责任人,归属=发起人(自助流程零变化)。
    const dtsLaunch = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: OWNER_VIEWER,
      payload: {
        title: "下单超时", source: "dts", ticket: "DTS20260901001",
        module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(dtsLaunch.status, 201);
    assert.equal(dtsLaunch.body.account, "dev");
    assert.equal(dtsLaunch.body.reporter, "dev",
      "DTS 发起登记人=发起人(自登记),归属不变");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("登记指派:管理员/不存在的账号不能当责任人", async () => {
  const dataDir = mfcTemp("mfc-issue-assign-role-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  // 角色回调=生产接线(auth.roleOf)的测试替身:boss 是管理员,
  // dev 是开发,其他账号不存在。回调缺席的裸构造不校验(测试世界
  // 无身份体系的既有纪律),这里显式注入才钉得住拒绝分支。
  const service = makeService(dataDir, {
    userRole: (username) =>
      username === "boss" ? "admin"
        : username === "dev" ? "developer"
        : undefined,
  });
  try {
    const admin = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", assignee: "boss", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(admin.status, 409);
    assert.match(admin.body.error, /管理员/);
    assert.match(admin.body.error, /没有人能推进/);
    const ghost = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", assignee: "ghost", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(ghost.status, 409);
    assert.match(ghost.body.error, /ghost/);
    assert.match(ghost.body.error, /不存在或已停用/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("登记指派:Git 凭据门查责任人并点名,自登记文案维持「你」", async () => {
  const dataDir = mfcTemp("mfc-issue-assign-cred-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  // 凭据回调记录被查的账号:门必须查责任人(dev2),不查登记人(tester)。
  const checked: string[] = [];
  const service = makeService(dataDir, {
    gitCredential: (account) => {
      checked.push(account);
      if (account === "dev2") return { username: account, password: "tok" };
      return undefined;
    },
  });
  try {
    // 登记人 tester(无凭据)替 dev2(有令牌没邮箱)登记:门查 dev2。
    const noEmail = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", assignee: "dev2", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(noEmail.status, 409);
    assert.match(noEmail.body.error, /责任人 dev2 的个人邮箱未配置/,
      "登记人≠责任人时文案点名责任人,不是「你」");
    assert.deepEqual(checked, ["dev2"],
      "凭据门只查责任人账号,登记人不需要配 Git 凭据");
    // 自登记(登记人=责任人):文案维持对「你」说话。
    const self = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: OWNER_VIEWER,
      payload: {
        title: "下单超时", assignee: "dev", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(self.status, 409);
    assert.match(self.body.error, /Git 令牌未配置/);
    assert.doesNotMatch(self.body.error, /责任人 dev 的/,
      "自登记两号同一,「你」的文案不换人称");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("登记指派:小鲁班通知发给责任人;自登记不发、登记人不收", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  const dataDir = mfcTemp("mfc-issue-assign-notify-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  const service = makeService(dataDir, {
    notifier: new Notifier({
      endpoint: luban.endpoint, backoffMs: [0],
    }),
    linkBase: LINK_BASE,
  });
  try {
    const created = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", assignee: "dev", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(created.status, 201);
    const assigned = await until(
      () => luban.messages.find((message) =>
        message.account === "dev") as
        { account: string; text: string; link: string } | undefined,
      "责任人收到指派通知");
    assert.match(assigned.text, /tester 登记了问题「下单超时」并指派你为责任人/,
      "通知点名登记人与问题标题");
    assert.equal(assigned.link,
      `${LINK_BASE}/issues/${created.body.id}`,
      "通知带会话工作台深链");
    // 自登记:登记人=责任人,不发(自己通知自己是噪音)。
    await callIssueRoute("POST", ["issues"], {
      service,
      viewer: OWNER_VIEWER,
      payload: {
        title: "自登记的问题", assignee: "dev", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(luban.messages.length, 1,
      "自登记不发指派通知,登记人(tester)也不收任何通知");
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("登记指派:--public-url 缺席时从请求 Host 学通知入口,回环不入账", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  const dataDir = mfcTemp("mfc-issue-assign-observe-link-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  const service = makeService(dataDir, {
    notifier: new Notifier({
      endpoint: luban.endpoint, backoffMs: [0],
    }),
    // 故意不配 linkBase:与生产缺省部署同形态,深链全靠自学兜底
    // (与需求侧 TaskService.observeLinkBase 对齐,2026-09)。
  });
  try {
    // 有个用户从内网地址登录过,服务学到这个入口。
    service.observeLinkBase("http://192.0.2.5:8080");
    const first = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "下单超时", assignee: "dev", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(first.status, 201);
    const assigned = await until(
      () => luban.messages.find((message) =>
        message.account === "dev") as
        { account: string; text: string; link: string } | undefined,
      "责任人收到指派通知");
    assert.equal(assigned.link,
      `http://192.0.2.5:8080/issues/${first.body.id}`,
      "没配 --public-url 也有完整深链,不再只剩 /issues/<id> 后缀");
    // 服务器本机或 SSH 隧道的回环访问不得冲掉学过的可用地址。
    service.observeLinkBase("http://127.0.0.1:9999");
    const second = await callIssueRoute("POST", ["issues"], {
      service,
      viewer: TESTER,
      payload: {
        title: "导出失败", assignee: "dev", module_id: "pay-core", product_version: "V100R027C10B005",
        environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
      },
    });
    assert.equal(second.status, 201);
    const secondAssigned = await until(
      () => luban.messages.find((message) =>
        message.account === "dev"
        && String(message.link).includes(String(second.body.id))) as
        { account: string; text: string; link: string } | undefined,
      "第二个问题的指派通知");
    assert.equal(secondAssigned.link,
      `http://192.0.2.5:8080/issues/${second.body.id}`,
      "回环访问不覆盖学过的入口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("登记指派:登记人进 AI 元信息——指派会话带、自登记不带", async () => {
  // 元信息是开场词/续聊词/get_issue_meta 三处的同一事实源
  // (issueRegistrationMeta 单源):这里钉提示词块的最小事实,
  // 工具返回随同一对象自动带上。
  const base = {
    id: "issue-9", account: "dev", reporter: "tester",
    title: "播放器偶发黑屏", description: "重启后黑屏",
    source: "manual" as const,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T01:00:00Z",
    stage_note: "", stage_at: "2026-09-01T01:00:00Z",
    status: "running" as const, stage: "analyze" as const,
    scenario: "no_ticket" as const,
  };
  const assigned = issueFixedOpeningPrompt(base);
  assert.match(assigned, /- 登记人: tester/,
    "指派会话的开场词点名登记人:现象描述出自其视角");
  assert.match(assigned, /- 工号: dev/);
  const self = issueFixedOpeningPrompt({ ...base, reporter: "dev" });
  assert.doesNotMatch(self, /登记人/,
    "自登记两号同一,元信息不赘述登记人");
  assert.match(issueResumePrompt({ ...base }, "继续"), /- 登记人: tester/,
    "续聊词同样带登记人(重启重建的上下文不流失)");
});

test("登记指派:单一列表——存量回填与挂起转正都认登记人", async () => {
  const dataDir = mfcTemp("mfc-issue-assign-scope-");
  const base = {
    title: "播放器偶发黑屏",
    description: "",
    source: "manual",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T01:00:00Z",
    stage_note: "",
    stage_at: "2026-09-01T01:00:00Z",
  };
  // 指派会话:登记人 tester、归属 dev。老会话:无 reporter 字段
  // (指派机制前),读盘回填=归属。自登记:两号同一。
  writeSession(dataDir, {
    ...base, id: "issue-1", account: "dev", reporter: "tester",
    status: "idle", stage: "analyze", scenario: "no_ticket", round: 1,
  });
  writeSession(dataDir, {
    ...base, id: "issue-2", account: "tester",
    status: "idle", stage: "analyze", scenario: "no_ticket", round: 1,
  });
  const service = makeService(dataDir);
  try {
    // 单一列表:登记人(test)能同时看到登记给 dev 的 issue-1 与自己
    // 名下的 issue-2;老会话回填登记人=归属,同列不丢。
    const testerList = await callIssueRoute("GET", ["issues"], {
      service, viewer: TESTER,
    });
    assert.deepEqual(
      (testerList.body.issues as Array<{ id: string }>)
        .map((row) => row.id).sort(),
      ["issue-1", "issue-2"],
      "归属或登记人是自己都进列表;老会话回填登记人=归属后也在");
    const devList = await callIssueRoute("GET", ["issues"], {
      service, viewer: OWNER_VIEWER,
    });
    assert.deepEqual(
      (devList.body.issues as Array<{ id: string }>).map((row) => row.id),
      ["issue-1"], "dev 只看归属是自己或自己登记的");
    // 盘面旧词 suspended(转正与手动归档双退役,ADR-0048/0057):重启
    // 装载读盘即归取消,登记人留痕不丢。
    writeSession(dataDir, {
      ...base, id: "issue-3", account: "dev", reporter: "tester",
      status: "suspended", stage: "analyze", scenario: "no_ticket",
    });
    const revived = new IssueFlowService({
      dataDir, provider: "p", model: "m", modelsJson: {},
      dts: new MockDtsGateway(),
    });
    try {
      const closed = revived.get("issue-3");
      assert.equal(closed.status, "canceled", "存量挂起读盘归取消");
      assert.equal(closed.reporter, "tester", "登记人留痕不丢");
    } finally {
      await revived.shutdown().catch(() => undefined);
    }
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
