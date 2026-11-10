/**
 * 问题会话「查看模式」的后端契约(spec: docs/issue-session-view-mode.md):
 * - 读(概要/时间线/材料/事件/SSE 事件流)对登录用户全开放——非归属
 *   开发者与管理员都能看他人会话的现场(终态/挂起同样可读);
 * - 写(每条 /issues/:id 写路由)仅会话归属人,管理员也不写,403 文案
 *   指明动作与归属限制,不再有笼统的「只能访问自己的问题会话」盖全部;
 * - 源码契约钉死不变量:/issues/:id 下每条写路由分支都自带 own() 归属
 *   闸,新增写路由漏配时测试当场红。
 *
 * 行为断言走真路由(合成 request/response 打 handleIssueRoutes,先例:
 * issueFlowService.test.ts / dtsModuleBindings.test.ts);会话用 dataDir
 * 落 issue.json 状态文件造,不打模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import {
  handleIssueRoutes,
  type IssueViewer,
} from "../src/issueFlow/routes.ts";
import { mfcTemp } from "./mfcTmp.ts";

const OWNER = "dev";
/** 非归属开发者(看板里点开同事卡片的普通人)。 */
const PEER: IssueViewer = { username: "peer", role: "developer" };
/** 管理员:读视野保持,写权限为零。 */
const ADMIN: IssueViewer = { username: "boss", role: "admin" };
/** 归属人本人。 */
const OWNER_VIEWER: IssueViewer = { username: OWNER, role: "developer" };

const LIVE = "issue-101";
const ARCHIVED = "issue-102";
const CANCELED = "issue-103";
/** 盘面写旧词 suspended:存量挂起读盘归取消(ADR-0048/0057)的回归样。 */
const LEGACY_SUSPENDED = "issue-104";

interface RouteResult {
  status: number;
  body: Record<string, any>;
  headers: Record<string, string>;
  text: string;
}

/** 走一遍真路由(无 HTTP 服务器):viewer 直接注入 routeOptions,
 * readBody 需要 data/end 监听,写方法用 EventEmitter 造请求。 */
function callIssueRoute(
  method: "GET" | "POST" | "PUT" | "DELETE",
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
    let headers: Record<string, string> = {};
    const finish = (text?: string | Buffer): void => {
      const raw = text === undefined ? "" : String(text);
      let body: Record<string, any>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { raw };
      }
      resolve({ status, headers, body, text: raw });
    };
    const response: any = {
      writeHead: (code: number, heads?: Record<string, string>) => {
        status = code;
        headers = heads ?? {};
      },
      end: (output?: string | Buffer) => finish(output),
      write: () => {},
    };
    let request: any = {
      method,
      url: `/${parts.join("/")}${options.query ?? ""}`,
    };
    if (method === "POST" || method === "PUT") {
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

/** SSE 事件流路由:流是长连的,这里只取响应头与流是否自行收口——
 * 断言点是"登录即可订阅(不再提前 403)",不持流。非终态流由测试
 * emit close 停掉 300ms 轮询,不留活计时器。 */
function issueSse(
  parts: string[],
  service: IssueFlowService,
  viewer: IssueViewer,
): Promise<{ status: number; ended: boolean; response: any }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    let ended = false;
    const response: any = new EventEmitter();
    response.writeHead = (code: number) => {
      status = code;
    };
    response.write = () => {};
    response.end = () => {
      ended = true;
    };
    void handleIssueRoutes(
      { method: "GET", url: `/${parts.join("/")}` } as any,
      response,
      parts,
      { issueFlow: service, authEnabled: false, viewer },
    ).then(() => resolve({ status, ended, response })).catch(reject);
  });
}

function writeSession(dataDir: string, state: Record<string, unknown>): void {
  mkdirSync(join(dataDir, "issues", String(state.id)), { recursive: true });
  writeFileSync(
    join(dataDir, "issues", String(state.id), "issue.json"),
    JSON.stringify(state));
}

/** 四个会话:在途 + 归档 + 取消 + 挂起,全归 dev 名下(状态文件直接
 * 落盘,服务重启恢复逻辑把它们原样载入,不打模型)。 */
function makeFixture(): { dataDir: string; service: IssueFlowService } {
  const dataDir = mfcTemp("mfc-issue-viewmode-");
  const base = {
    account: OWNER,
    title: "播放器偶发黑屏",
    description: "",
    source: "manual",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T01:00:00Z",
    stage_note: "",
    stage_at: "2026-09-01T01:00:00Z",
  };
  writeSession(dataDir, {
    ...base, id: LIVE, status: "idle", stage: "analyze",
    scenario: "no_ticket", round: 1,
  });
  writeSession(dataDir, {
    ...base, id: ARCHIVED, status: "archived", stage: "done",
    conclusion: { kind: "non_issue", summary: "误报", at: base.updated_at },
  });
  writeSession(dataDir, {
    ...base, id: CANCELED, status: "canceled", stage: "done",
  });
  writeSession(dataDir, {
    ...base, id: LEGACY_SUSPENDED, status: "suspended", stage: "analyze",
    scenario: "no_ticket",
  });
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return { dataDir, service };
}

test("查看模式:非归属开发者与管理员读他人会话的概要/时间线/材料/事件/文档/对话/检视/导出全 200", async () => {
  const { service } = makeFixture();
  try {
    // 概要:看得到是谁的会话、走到哪了。
    const summary = await callIssueRoute("GET", ["issues", LIVE],
      { service, viewer: PEER });
    assert.equal(summary.status, 200,
      "非归属开发者读会话概要必须是 200(查看模式),不是 403");
    assert.equal(summary.body.id, LIVE);
    assert.equal(summary.body.account, OWNER);

    // 时间线与耗时卡点。
    const timeline = await callIssueRoute("GET", ["issues", LIVE, "timeline"],
      { service, viewer: PEER });
    assert.equal(timeline.status, 200);
    assert.ok(timeline.body.span, "时间线投影在");

    // 材料页签:清单、聚合 diff、原始事件(没有仓/日志/事件时是空态
    // 200,绝不是归属 403)。
    const materials = await callIssueRoute(
      "GET", ["issues", LIVE, "materials"], { service, viewer: PEER });
    assert.equal(materials.status, 200);
    assert.deepEqual(materials.body.changes, []);
    const diff = await callIssueRoute(
      "GET", ["issues", LIVE, "materials", "diff"],
      { service, viewer: PEER, query: "?repo=" });
    assert.equal(diff.status, 200);
    assert.equal(diff.body.diff, "");
    const events = await callIssueRoute(
      "GET", ["issues", LIVE, "materials", "events"],
      { service, viewer: PEER });
    assert.equal(events.status, 200);
    assert.deepEqual(events.body.events, []);

    // 过程文档(分析报告)、检视面板(#260 起过程问答读接口随页签退役)。
    const documents = await callIssueRoute(
      "GET", ["issues", LIVE, "documents"], { service, viewer: PEER });
    assert.equal(documents.status, 200);
    assert.deepEqual(documents.body.documents, []);
    const missingDoc = await callIssueRoute(
      "GET", ["issues", LIVE, "documents", "read"],
      { service, viewer: PEER, query: "?name=issue-analysis.md" });
    assert.equal(missingDoc.status, 200);
    assert.equal(missingDoc.body.unavailable, "文档不存在");
    const reviews = await callIssueRoute(
      "GET", ["issues", LIVE, "reviews"], { service, viewer: PEER });
    assert.equal(reviews.status, 200);
    assert.deepEqual(reviews.body.reviews, []);

    // 现场记录导出(markdown 直出,不是 JSON)。
    const exported = await callIssueRoute(
      "GET", ["issues", LIVE, "export"], { service, viewer: PEER });
    assert.equal(exported.status, 200);
    assert.match(exported.headers["content-type"] ?? "", /text\/markdown/);
    assert.match(exported.text, /# 现场记录:播放器偶发黑屏/);

    // 管理员读视野保持:概要/时间线照旧 200。
    for (const parts of [["issues", LIVE], ["issues", LIVE, "timeline"]]) {
      const adminRead = await callIssueRoute("GET", parts,
        { service, viewer: ADMIN });
      assert.equal(adminRead.status, 200, `管理员读 ${parts.join("/")} 保持 200`);
    }
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("查看模式:SSE 事件流登录即可订阅,不再提前 403;终态会话的流照常收口", async () => {
  const { service } = makeFixture();
  try {
    // 在途会话:响应头 200 event-stream(曾经的"本人或管理员"整体闸
    // 在这里打 403,现在读放行),流不自行结束,测试侧 emit close 停轮询。
    const live = await issueSse(["issues", LIVE, "events"], service, PEER);
    assert.equal(live.status, 200,
      "非归属开发者订阅事件流必须放行(登录即可),不是 403");
    assert.equal(live.ended, false);
    live.response.emit("close");

    // 管理员同样可订阅。
    const adminStream = await issueSse(
      ["issues", LIVE, "events"], service, ADMIN);
    assert.equal(adminStream.status, 200);
    adminStream.response.emit("close");

    // 终态会话(已归档)对非归属人同样可读,流推完即收。
    const archived = await issueSse(
      ["issues", ARCHIVED, "events"], service, PEER);
    assert.equal(archived.status, 200);
    assert.equal(archived.ended, true, "终态会话的事件流推完即收");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("查看模式:终态(归档/取消)对非归属人可读;存量挂起读盘归取消", async () => {
  const { service } = makeFixture();
  try {
    for (const [id, expected] of [
      [ARCHIVED, "archived"],
      [CANCELED, "canceled"],
      [LEGACY_SUSPENDED, "canceled"],
    ] as const) {
      const read = await callIssueRoute("GET", ["issues", id],
        { service, viewer: PEER });
      assert.equal(read.status, 200, `${id} 对非归属人可读`);
      assert.equal(read.body.status, expected);
    }
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

/** 全量写路由盘点:每条都要让非归属开发者与管理员吃 403,且文案
 * 指明动作与归属限制(各路由既有文案;归档/取消的文案在本次收窄里
 * 从笼统的「只有归属人能操作会话」改为点名动作)。闸在业务校验之前,
 * payload 不必合法。 */
const WRITE_ROUTES: Array<{
  what: string;
  method: "POST" | "PUT" | "DELETE";
  parts: string[];
  payload?: unknown;
  denied: string;
}> = [
  {
    what: "请求拉取日志", method: "POST",
    parts: ["issues", LIVE, "logs", "fetch"],
    payload: {},
    denied: "只能请求拉取自己会话的日志",
  },
  {
    what: "记检视意见", method: "POST",
    parts: ["issues", LIVE, "reviews"],
    payload: { line: 3, anchor: "原文", note: "这里要改" },
    denied: "只有归属人能记检视意见",
  },
  {
    what: "提交检视", method: "POST",
    parts: ["issues", LIVE, "reviews", "send"],
    payload: {},
    denied: "只有归属人能提交检视",
  },
  {
    what: "移除检视意见", method: "DELETE",
    parts: ["issues", LIVE, "reviews", "rev-1"],
    denied: "只有归属人能移除检视意见",
  },
  {
    what: "续聊", method: "POST",
    parts: ["issues", LIVE, "reply"],
    payload: { text: "帮我看看" },
    denied: "只有归属人能续聊",
  },
  {
    what: "问题卡作答", method: "POST",
    parts: ["issues", LIVE, "decision"],
    payload: { state_version: 1, decision: "确认" },
    denied: "只有归属人能作答",
  },
  {
    what: "调整仓清单", method: "POST",
    parts: ["issues", LIVE, "repos"],
    payload: { add: ["https://example.com/x.git"], remove: [] },
    denied: "只有归属人能调整会话的代码仓清单",
  },
  {
    what: "网管环境配置", method: "POST",
    parts: ["issues", LIVE, "environment"],
    payload: { hosts: ["192.0.2.8"], backend_password: "pw" },
    denied: "只有归属人能作答网管环境卡(填写或拒绝)",
  },
  {
    what: "网管环境拒绝", method: "POST",
    parts: ["issues", LIVE, "environment"],
    payload: { decline: true },
    denied: "只有归属人能作答网管环境卡(填写或拒绝)",
  },
  {
    what: "补充插话", method: "POST",
    parts: ["issues", LIVE, "interrupt"],
    payload: { text: "补充一点" },
    denied: "只有归属人能补充",
  },
  {
    what: "绑定单号", method: "POST",
    parts: ["issues", LIVE, "ticket"],
    payload: { ticket: "DTS-2026-1" },
    denied: "只有归属人能绑定单号",
  },
  {
    what: "归档/取消/重跑", method: "POST",
    parts: ["issues", LIVE, "control"],
    payload: { action: "cancel" },
    denied: "只有归属人能重跑或取消会话",
  },
];

test("写闸全量:非归属开发者与管理员调每条写路由都 403 且文案指明动作与归属,会话零变动", async () => {
  const { service } = makeFixture();
  try {
    assert.ok(WRITE_ROUTES.length >= 12,
      "写路由盘点不能缩水——当前 /issues/:id 下写路由只增不减(≥12)");
    for (const viewer of [PEER, ADMIN]) {
      const who = viewer.role === "admin" ? "管理员" : "非归属开发者";
      for (const route of WRITE_ROUTES) {
        const result = await callIssueRoute(route.method, route.parts, {
          service, viewer, payload: route.payload,
        });
        assert.equal(result.status, 403,
          `${who} 调「${route.what}」(${route.method} /${route.parts.join("/")})`
            + ` 必须 403,实际 ${result.status}`);
        assert.equal(result.body.error, route.denied,
          `${who} 调「${route.what}」的 403 文案要指明动作与归属限制`);
      }
    }
    // 全部被闸下:会话原地不动,检视台账也没有多出东西。
    assert.equal(service.get(LIVE).status, "idle");
    const reviews = await callIssueRoute("GET", ["issues", LIVE, "reviews"],
      { service, viewer: OWNER_VIEWER });
    assert.deepEqual(reviews.body.reviews, []);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("归属人本人写操作不受影响:记/移检视意见、取消会话照常;他人依旧只能看", async () => {
  const { service } = makeFixture();
  try {
    const added = await callIssueRoute("POST", ["issues", LIVE, "reviews"], {
      service, viewer: OWNER_VIEWER,
      payload: { line: 3, anchor: "原文快照", note: "这里的时序要再核" },
    });
    assert.equal(added.status, 200, "归属人记检视意见不受影响");
    const reviewId = String(added.body.id ?? "");
    assert.ok(reviewId, "记账要回意见 ID");

    const listed = await callIssueRoute("GET", ["issues", LIVE, "reviews"],
      { service, viewer: OWNER_VIEWER });
    assert.equal(listed.body.reviews.length, 1);

    const dropped = await callIssueRoute(
      "DELETE", ["issues", LIVE, "reviews", reviewId],
      { service, viewer: OWNER_VIEWER });
    assert.equal(dropped.status, 200, "归属人移除检视意见不受影响");

    const canceled = await callIssueRoute("POST", ["issues", LIVE, "control"], {
      service, viewer: OWNER_VIEWER, payload: { action: "cancel" },
    });
    assert.equal(canceled.status, 200, "归属人取消会话不受影响");
    assert.equal(canceled.body.status, "canceled");

    // 取消后的终态对非归属人依旧可读(查看模式不因终态关门)。
    const peerRead = await callIssueRoute("GET", ["issues", LIVE],
      { service, viewer: PEER });
    assert.equal(peerRead.status, 200);
    assert.equal(peerRead.body.status, "canceled");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 源码契约:/issues/:id 下每条写路由分支都带 own() 归属闸 ----
// (先例:issueUiContracts.test.ts 的 readFileSync+正则风格。新增写
// 路由忘配归属闸时,这里的配对断言当场红,而不是悄悄敞开。)

test("源码契约:/issues/:id 下每条写路由分支都自带 own() 归属闸,整体归属闸不复存在", () => {
  const source = readFileSync(
    resolve("src/issueFlow/routes.ts"), "utf-8");
  const anchor = source.indexOf("const id = parts[1];");
  assert.ok(anchor > 0,
    "找不到 /issues/:id 的会话号提取点——路由结构变了,契约要跟着改");
  const tail = source.slice(anchor);

  // 逐个认出会话号之后的方法分支(GET/POST/PUT/DELETE/PATCH),按
  // "到下一个方法分支为止"切出分支体。
  const marks = [...tail.matchAll(/if \(method === "(GET|POST|PUT|DELETE|PATCH)"/g)]
    .map((match) => ({
      method: match[1],
      start: match.index ?? 0,
      head: tail.slice(match.index ?? 0,
        tail.indexOf("\n", match.index ?? 0)).trim(),
    }));
  const writeBranches = marks
    .filter((mark) => mark.method !== "GET")
    // 410 墓碑(关联转正退役,ADR-0048)不是活写路由:对所有人同答
    // 410,不承载归属写语义,不进归属闸盘点。
    .filter((mark) => !tail.slice(mark.start,
      marks.find((other) => other.start > mark.start)?.start ?? tail.length)
      .includes("410"))
    .map((mark) => ({
      ...mark,
      body: tail.slice(
        mark.start,
        marks.find((other) => other.start > mark.start)?.start ?? tail.length),
    }));

  assert.ok(writeBranches.length >= 12,
    `写路由分支至少要认出 12 条(当前 ${writeBranches.length} 条)——`
      + "认出数骤降说明路由结构变了,契约要跟着改");
  for (const branch of writeBranches) {
    assert.ok(branch.body.includes("own("),
      `写路由分支缺归属闸(${branch.head})——/issues/:id 下每条写路由`
        + "必须自带 own() 闸,不能靠(已不存在的)整体闸兜底");
    assert.match(branch.body,
      /只有归属人|只能修改自己会话|只能解压自己会话|只能请求拉取自己会话/,
      `写路由 403 文案要指明动作与归属限制(${branch.head})`);
  }

  // own() 只认用户名:不得给管理员开后门(管理员保持只读)。
  const ownDef = source.match(
    /const own = \(account: string\): boolean =>[\s\S]*?;/)?.[0] ?? "";
  assert.ok(ownDef, "own() 归属闸定义必须在场");
  assert.ok(!ownDef.includes("role"),
    "own() 不得认管理员——写仅归属人,管理员只读");

  // 笼统的旧整体闸文案不得回来盖住写场景;整体闸本体(guard)同样
  // 不许复活。
  assert.doesNotMatch(source, /只能访问自己的问题会话/);
  assert.doesNotMatch(source, /const guard\b/,
    "「本人或管理员」整体归属闸已收窄删除,不许复活盖住读写");
});
