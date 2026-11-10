/**
 * 人工接管(2026-09-07 走查拍板)的契约测试:接管=打断 AI(settle/
 * runTurn 让路,不标 failed)、期间人工记录(via=takeover 只记账不
 * 投喂)、交还时 AI 带着记录继续(续聊词回灌账本原文)。
 *
 * 范式:服务级走 ScriptedModelServer(issueFlowFixed 同款),纯函数
 * 直测 shouldNudgeFixed 的让路豁免,路由照 issueConversation 的
 * handleIssueRoutes 直调 stub(401/200)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import {
  shouldNudgeFixed,
  type IssueSessionState,
  type IssueSummary,
} from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const NOTE = "手工把网管侧 hosts 指回了备用环境,并重启了登录服务";
const HANDOVER = "已按上面的记录核实现场,继续推进";

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readEvents(root: string): Array<Record<string, any>> {
  const path = join(root, "events.jsonl");
  // 旁路纪律(与 readConversationEvents 同款):账本还没落(回合刚启动)
  // 给空,不炸轮询。
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** 一个首轮"卡在长 bash 里"的会话:模型第一幕跑 sleep,给接管留出
 * 干净的运行中窗口;第二幕是交还后续跑的收口词。 */
async function runningSession(dataDir: string, model: ScriptedModelServer) {
  const origin = join(dataDir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const created = service.create({
    account: "dev", title: "登录超时", ticket: "DTS-2026-1001", source: "dts",
  });
  const root = join(dataDir, "issues", created.id);
  await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "running" ? issue : undefined;
  }, "首轮回合进入 running");
  // 接管要掐在工具在跑的时候(abort 才有事可干):等 tool_requested
  // 落账,而不是只看 status=running(beginTurn 一进回合就是 running,
  // 那会儿 driver 可能还没开——abort 会落空)。工具名不猜大小写。
  await until(() =>
    readEvents(root).some((event) =>
      event.kind === "tool_requested"
      && String(event.payload?.name ?? "").toLowerCase() === "bash")
      ? true : undefined,
  "回合内 bash 工具已开跑");
  return { service, created, root };
}

test("人工接管全链:running 中接管→AI 回合中止不标 failed;人工记录只记账;交还带着记录继续", async () => {
  const dataDir = mfcTemp("mfc-issue-takeover-");
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: "sleep 30" } } },
    { text: HANDOVER },
  ], "scripted-v1", { linear: true });
  await model.start();
  const { service, created, root } = await runningSession(dataDir, model);
  try {
    // ① 接管:状态定格 idle、takeover 在场、转移账留痕。
    const taken = service.takeover(created.id);
    assert.equal(taken.status, "idle");
    assert.equal(taken.stage_note, "人工接管中——AI 已暂停,交还后带着人工记录继续");
    assert.ok(taken.takeover, "接管后 takeover 字段必须在场");
    assert.equal(taken.takeover!.by, "dev");
    assert.ok(taken.transitions?.some((entry) =>
      entry.source === "platform" && /人工接管/.test(entry.note)),
    "转移账必须有「人工接管」一条");
    // 幂等闸/状态闸。
    assert.throws(() => service.takeover(created.id), /已在人工接管中/);
    assert.throws(() => service.addTakeoverNote(created.id, "  "), /不能为空/);

    // ② 接管期间的人工记录:只记账不投喂——事件账本出现 via=takeover
    //    的 user_message,模型请求不因此多一拍。
    const requestsAtNote = model.requests.length;
    service.addTakeoverNote(created.id, NOTE);
    const noted = readEvents(root).filter((event) =>
      event.kind === "user_message" && event.payload?.via === "takeover");
    assert.equal(noted.length, 1, "接管期人工记录应入事件账本");
    assert.equal(noted[0].payload?.text, NOTE);
    assert.equal(model.requests.length, requestsAtNote,
      "人工记录只记账,不得投喂模型");

    // ③ abort 收尾落地:被掐死的回合总会留下收尾事件(turn_finished
    //    或失败链路的 session_ended)——它落账后 settle/catch 已走过,
    //    让路守卫必须保住接管现场:idle、takeover 在场、无失败账。
    const takeoverAt = taken.takeover!.at;
    await until(() => readEvents(root).some((event) =>
      (event.kind === "turn_finished" || event.kind === "session_ended")
      && String(event.ts ?? "") >= takeoverAt) ? true : undefined,
    "被中止回合的收尾事件落账");
    const settled = service.get(created.id);
    assert.equal(settled.status, "idle",
      "接管让路:abort 收尾后状态仍 idle(不标 failed)");
    assert.ok(settled.takeover, "让路后 takeover 仍在场");
    assert.equal(settled.error, undefined, "被中止的回合不得留失败账");

    // ④ 交还:有"上一回合还在收尾"的守卫,重试到能开新回合为止;
    //    每次撞守卫都复核接管现场没被收口路径污染。
    const deadline = Date.now() + 60_000;
    let resumed: IssueSummary | undefined;
    for (;;) {
      try {
        resumed = service.resumeFromTakeover(created.id,
          { note: "配置已回滚,以现场为准" });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/收尾/.test(message)) throw error;
        const now = service.get(created.id);
        assert.equal(now.status, "idle", "接管期间 settle/catch 不得标 failed");
        assert.ok(now.takeover, "交还成功前 takeover 必须一直在场");
        if (Date.now() >= deadline) throw new Error("交还一直撞上收尾守卫");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(resumed);
    assert.equal(resumed.status, "running", "交还即开新回合");
    assert.equal(resumed.takeover, undefined, "交还后 takeover 清失");
    assert.equal(resumed.stage_note, "人工接管中——AI 已暂停,交还后带着人工记录继续",
      "交还不改写阶段现场说明(语境保留给续跑回合)");

    // ⑤ 续跑回合的提示词:交还说明+人工记录原文都要在,给"先核实现状"
    //    的纪律句也在。交还后的启动请求是第二拍(requests[1];其后还有
    //    催办续跑的请求,不能取 at(-1))。
    await until(() => model.requests.length >= 2 ? true : undefined,
      "交还请求到达模型");
    const resumePrompt = JSON.stringify(model.requests[1]);
    assert.match(resumePrompt, /人工接管结束,现场交还 AI 继续/);
    assert.match(resumePrompt, /交还说明:配置已回滚,以现场为准/);
    assert.match(resumePrompt, new RegExp(NOTE), "人工记录原文必须回灌");
    assert.match(resumePrompt, /人工改动以人的原话为准,先核实现状再继续推进当前阶段/);
    // 续跑回合收口(剧本第二幕+催办预算走完)落 idle,现场照常可用;
    // 接管三口的守卫对"不在接管中"如实打回。
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "交还后续跑回合收口");
    assert.equal(service.get(created.id).takeover, undefined);
    assert.throws(() => service.addTakeoverNote(created.id, NOTE),
      /不在人工接管中/);
    assert.throws(() => service.resumeFromTakeover(created.id),
      /不在人工接管中/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("shouldNudgeFixed:人工接管在场平台不催(让路给人工驾驶),交还后恢复催办", () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "T1",
    scenario: "ticket", round: 1,
    stage_states: ["in_progress", "pending", "pending", "pending", "pending"],
    status: "idle", stage: "analyze", stage_note: "", stage_at: new Date().toISOString(),
  };
  assert.equal(shouldNudgeFixed(base), true, "阶段没走完就该催(基准)");
  assert.equal(shouldNudgeFixed({
    ...base,
    takeover: { at: new Date().toISOString(), by: "dev" },
  }), false, "人工驾驶中平台不催");
});

// ---- 路由冒烟:三条 takeover 路由的鉴权(401)与归属人放行(200)----

test("路由冒烟:takeover/note/resume 未登录 401,归属人 200 且状态翻转", async () => {
  const dataDir = mfcTemp("mfc-issue-takeover-routes-");
  const model = new ScriptedModelServer([{ text: "首轮收口。" }], "scripted-v1");
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const origin = join(dataDir, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", origin]);
    const created = service.create({
      account: "dev", title: "路由冒烟", ticket: "DTS-2026-1002", source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口(催办预算走完后落 idle)");

    const { handleIssueRoutes } = await import("../src/issueFlow/routes.ts");
    const call = (
      parts: string[],
      init?: { method?: string; body?: unknown; viewer?: object },
    ): Promise<{ status: number; body: Record<string, any> }> =>
      new Promise((resolve, reject) => {
        const request = new EventEmitter() as IncomingMessage;
        (request as { method?: string }).method = init?.method ?? "POST";
        let status = 0;
        void handleIssueRoutes(
          request,
          {
            writeHead: (code: number) => { status = code; },
            end: (payload?: string) => {
              try { resolve({ status, body: JSON.parse(payload ?? "{}") }); }
              catch (error) { reject(error); }
            },
          } as never,
          parts,
          { issueFlow: service, authEnabled: true,
            ...(init?.viewer ? { viewer: init.viewer } : {}) } as never,
        ).catch(reject);
        if (init?.body !== undefined) {
          request.emit("data", Buffer.from(JSON.stringify(init.body)));
        }
        request.emit("end");
      });
    const id = ["issues", created.id] as const;
    const auth = { username: "dev", role: "developer" };

    // 未登录一律 401(authEnabled 且无 viewer)。
    assert.equal((await call([...id, "takeover"])).status, 401);
    assert.equal((await call([...id, "takeover", "note"], { body: { text: "x" } })).status, 401);
    assert.equal((await call([...id, "takeover", "resume"], { body: {} })).status, 401);

    // 归属人:接管 → 记录 → 交还,三口 200 且状态随之翻转。
    const taken = await call([...id, "takeover"], { viewer: auth, body: {} });
    assert.equal(taken.status, 200);
    assert.ok(taken.body.takeover, "接带回执带 takeover 字段");
    assert.equal(taken.body.status, "idle");
    assert.equal((await call([...id, "takeover"], { viewer: auth, body: {} })).status,
      409, "重复接管被域守卫打回");

    const noted = await call([...id, "takeover", "note"],
      { viewer: auth, body: { text: NOTE } });
    assert.equal(noted.status, 200);
    assert.ok(readEvents(join(dataDir, "issues", created.id)).some((event) =>
      event.kind === "user_message"
      && event.payload?.via === "takeover"), "记录入了事件账本");

    const resumed = await call([...id, "takeover", "resume"],
      { viewer: auth, body: { note: "已手工恢复" } });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.takeover, undefined, "交还后 takeover 清失");
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "running" ? issue : undefined;
    }, "交还后续跑回合在跑");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
