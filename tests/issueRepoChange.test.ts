/**
 * 会话仓清单的用户调整口(#241,POST /issues/:id/repos →
 * service.requestRepoChanges)契约测试。
 *
 * 设计裁定(spec 拍板链):端点不直改 repo_urls——只校验+留痕+发送通知,
 * 清单由 Agent 经 pull_repo(新增,幂等入列)/remove_repo(移除,#240)
 * 执行后变化。测试钉三面:
 * - 校验拦截面:全空 diff / 非 https(validateRepoUrl 还放行 file://,
 *   端点在它之前加 https 限定)/ 与清单重复(归一比对)/ 超上限 /
 *   remove 不在册 / remove 模块绑定仓(与 #240 门禁①同款查法)——
 *   打回一律零副作用(清单、转移账、事件账都不动);
 * - 端到端 tracer(范式照 issuePushConfirm:种子会话+ScriptedModelServer
 *   剧本+until 轮询+events.jsonl 断言):空闲提交增删 diff → 通知开续聊
 *   回合 → 剧本 Agent 依次 pull_repo/remove_repo → 清单终态与转移账;
 * - 发送通道:startPlatformTurn 的三态——等人=park 便签(stage_note),
 *   运行中=steer 送达(话必须进模型上下文)。
 *
 * 管理员拒写/非归属的 403 在路由 own() 闸,不在服务层——行为级盘点
 * 在 issueViewMode 的 WRITE_ROUTES(每条写路由都让非归属与管理员吃
 * 403),路由分支形状另由 issueUiContracts 源码契约钉住;这里只测服务层。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS2026091300241";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端;文件名(alpha.git)即工作区仓名来源。 */
function bareOriginAt(root: string, fileName: string): string {
  mkdirSync(root, { recursive: true });
  const seed = join(root, "seed", fileName.replace(/\.git$/i, ""));
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, fileName);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

/** 在会话工作区落地克隆(issues/<id>/repo/<仓名>/,与 pull_repo 同布局)。 */
function cloneWorkspaceRepo(
  dataDir: string, issueId: string, name: string, origin: string,
): string {
  const dir = join(dataDir, "issues", issueId, "repo", name);
  execFileSync("git", ["clone", "-q", origin, dir], { env: GIT_ENV });
  return dir;
}

interface SeedOptions {
  id?: string;
  repoUrls: string[];
  status?: string;
  moduleId?: string;
  moduleName?: string;
}

/** 盘上种子一个固定流程会话(analyze 阶段已收口——收口态不牵催办,
 * 剧本回合正常落 idle)。必须在构造服务之前调用。 */
function seedIssue(dataDir: string, options: SeedOptions): string {
  const id = options.id ?? "issue-1";
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: "仓清单调整", description: "", source: "dts",
    ticket: TICKET,
    repo_url: options.repoUrls[0], repo_urls: options.repoUrls,
    // 修复分支以基线为前缀(ADR-0063):有单会话拉仓的硬前提;夹具用
    // 定死的假时间戳代表"会话已定名"。
    baseline: "master", fix_branch: `master_dev_${TICKET}_20261015090000`,
    ...(options.moduleId ? { module_id: options.moduleId } : {}),
    ...(options.moduleName ? { module: options.moduleName } : {}),
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "pending", "pending"],
    status: options.status ?? "idle",
    stage: "analyze", stage_note: "", stage_at: now,
  }));
  return id;
}

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

/** 会话事件账(校验拦截面的零副作用断言与发送通道断言共用)。 */
function readEvents(dataDir: string, id: string):
  Array<{ kind: string; payload: Record<string, any> }> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .map((event) => ({ kind: String(event.kind),
      payload: (event.payload ?? {}) as Record<string, any> }));
}

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

function baseOptions(dataDir: string, model: ScriptedModelServer): IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  };
}

/** 模型收到的全部用户消息文本(跨请求、跨回合;interrupt.test.ts 同款)。 */
function userTexts(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .filter((message: any) => message?.role === "user")
    .map((message: any) => typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
        .map((block: any) => block?.text ?? "").join(" "))
    .join("\n");
}

// ---- 校验拦截面:打回零副作用(清单/转移账/事件账全不动) ----

test("终态守卫:archived/canceled/failed 会话拒绝调整仓清单(死信防线)", async () => {
  const dataDir = mfcTemp("mfc-issue-repochange-terminal-");
  const alpha = "https://git.example.com/org/alpha.git";
  // 2026-09-18 三服务合一去冗:三个终态种子先落盘,一个服务一次恢复
  // 全加载;requestRepoChanges 是同步打回,不耗模型回合。
  const statuses = ["archived", "canceled", "failed"];
  const ids = statuses.map((status) =>
    seedIssue(dataDir, {
      id: `issue-${status}`, repoUrls: [alpha], status,
    }));
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    for (const [index, id] of ids.entries()) {
      const status = statuses[index];
      assert.throws(
        () => service.requestRepoChanges(id, {
          add: ["https://git.example.com/org/beta.git"], remove: [],
        }),
        /已结束\(终态\)/,
        `${status} 会话应被终态守卫打回`);
      // 零副作用:转移账不因被拒的提交留痕。
      const state = JSON.parse(readFileSync(
        join(dataDir, "issues", id, "issue.json"), "utf-8")) as {
        transitions?: Array<{ note?: string }>;
      };
      assert.ok(!(state.transitions ?? []).some((entry) =>
        /用户调整会话仓清单/.test(entry.note ?? "")),
        `${status} 被拒提交不得留痕`);
    }
  } finally {
    void service.shutdown().catch(() => undefined);
    void model.stop();
  }
});

test("校验拦截面:全空/非 https(file:// 与 ssh 也拦)/与清单重复/remove 不在册——打回零副作用", async () => {
  const dataDir = mfcTemp("mfc-issue-repochange-invalid-");
  const alpha = "https://git.example.com/org/Alpha.git";
  const id = seedIssue(dataDir, { repoUrls: [alpha] });
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 全空 diff:两边都没货,人话打回。
    assert.throws(
      () => service.requestRepoChanges(id, { add: [], remove: [] }),
      /没有要调整的仓/);
    // 非 https:http、无协议本地路径都在拦截面内;file:// 是
    // validateRepoUrl 放行、端点必须在它之前拦下的形态;ssh 一并拒。
    for (const bad of ["http://git.example.com/org/x.git",
      "/tmp/some/repo.git", "file:///tmp/repo.git",
      "ssh://git@git.example.com/org/x.git"]) {
      assert.throws(
        () => service.requestRepoChanges(id, { add: [bad], remove: [] }),
        (error: Error) => {
          assert.match(error.message, /https/);
          assert.match(error.message, new RegExp(bad.replace(/\//g, "\\/")
            .replace(/\./g, "\\.")), "打回要点名惹事的地址");
          return true;
        });
    }
    // 与清单重复:原样与归一变体(去 .git/尾斜杠/大小写)都算重复——
    // 与模块绑定门禁同一把归一尺。
    assert.throws(
      () => service.requestRepoChanges(id, { add: [alpha], remove: [] }),
      /已在会话仓清单/);
    assert.throws(
      () => service.requestRepoChanges(id,
        { add: ["https://git.example.com/org/alpha/"], remove: [] }),
      /已在会话仓清单/);
    // remove 不在册:清单里没有的仓无从移除,报错带当前清单。
    assert.throws(
      () => service.requestRepoChanges(id,
        { add: [], remove: ["https://git.example.com/org/ghost.git"] }),
      (error: Error) => {
        assert.match(error.message, /不在当前会话仓清单/);
        assert.match(error.message, /Alpha/, "报错要带当前清单供人核对");
        return true;
      });
    // 组内重复地址不算两边都空:同地址写两遍按一个算,仍走新增链。
    assert.throws(
      () => service.requestRepoChanges(id, { add: [alpha, alpha], remove: [] }),
      /已在会话仓清单/);

    // 零副作用:清单一字不动,转移账/事件账/model 零请求。
    const state = readStateFile(dataDir, id);
    assert.deepEqual(state.repo_urls, [alpha]);
    assert.equal(state.repo_url, alpha);
    assert.equal(state.transitions?.length ?? 0, 0, "打回不留转移账");
    assert.equal(existsSync(join(dataDir, "issues", id, "events.jsonl")),
      false, "打回不落事件账");
    assert.equal(model.requests.length, 0, "打回不开任何回合");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("上限已废除(ADR-0054):现有 8 + 新增 1 照常放行,超旧上限不再打回", async () => {
  const dataDir = mfcTemp("mfc-issue-repochange-cap-");
  const eight = Array.from({ length: 8 }, (_, index) =>
    `https://git.example.com/org/r${index}.git`);
  const id = seedIssue(dataDir, { repoUrls: eight });
  const model = new ScriptedModelServer(
    [{ text: "已收到指令。" }], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 旧上限 8 的位置直接放行:校验通过,开回合发送,不报「最多拉取」。
    const ok = service.requestRepoChanges(id,
      { add: ["https://git.example.com/org/one-more.git"], remove: [] });
    assert.equal(ok.id, id);
    await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "超旧上限回合收口");
    const texts = userTexts(model);
    assert.match(texts, /新增了代码仓|新增本会话的代码仓/);
    assert.doesNotMatch(texts, /最多拉取/);
    // 清单仍 8 个:端点没直改,Agent 剧本也没有执行工具(留痕不代执)。
    assert.equal(readStateFile(dataDir, id).repo_urls?.length, 8);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("remove 模块绑定仓打回(端点门禁与 #240 工具①同款);未绑定仓通过=留痕+park 便签,清单一字不动", async () => {
  const dataDir = mfcTemp("mfc-issue-repochange-module-");
  const alpha = bareOriginAt(join(dataDir, "origins"), "alpha.git");
  const beta = bareOriginAt(join(dataDir, "origins"), "beta.git");
  const delta = bareOriginAt(join(dataDir, "origins"), "delta.git");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [alpha],
  }, "tester");
  const id = seedIssue(dataDir, {
    repoUrls: [alpha, beta, delta],
    status: "waiting_user",
    moduleId: "pay-core",
    moduleName: "支付核心",
  });
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 门禁①同款查法:模块带出的仓端点就拒,不劳 Agent 跑一趟。
    assert.throws(
      () => service.requestRepoChanges(id,
        { add: [], remove: [alpha] }),
      (error: Error) => {
        assert.match(error.message, /模块绑定仓不可移除/);
        assert.match(error.message, /支付核心/);
        return true;
      });
    // 打回零副作用。
    assert.deepEqual(readStateFile(dataDir, id).repo_urls, [alpha, beta, delta]);

    // 未绑定仓通过(等人会话=park 便签,不抢回合):增删两段都在。
    const summary = service.requestRepoChanges(id, {
      add: ["https://git.example.com/org/gamma.git"],
      remove: [beta],
    });
    assert.equal(summary.id, id, "返回会话概要(reply 类端点同形状)");
    assert.deepEqual(summary.repo_urls, [alpha, beta, delta],
      "端点不直改清单——repo_urls 原样");
    const state = readStateFile(dataDir, id);
    assert.deepEqual(state.repo_urls, [alpha, beta, delta], "盘上清单也不动");
    assert.equal(state.status, "waiting_user", "等人会话不开回合");
    assert.equal(model.requests.length, 0, "park 路不打扰模型");
    // 便签=通知首行(增段在前):带新增仓与 pull_repo 指路。
    assert.match(state.stage_note ?? "", /新增了代码仓/);
    assert.match(state.stage_note ?? "", /gamma\.git/);
    // 转移账:用户操作留痕,写明"清单随 Agent 执行变化"。
    const last = (state.transitions ?? []).at(-1)!;
    assert.match(last.note, /用户调整会话仓清单/);
    assert.match(last.note, /新增 /);
    assert.match(last.note, /移除 .*beta/);
    assert.match(last.note, /pull_repo\/remove_repo/);
    // 事件账:user_message via=repos 留痕(协作流以用户气泡回放)。
    const events = readEvents(dataDir, id);
    assert.ok(events.some((event) => event.kind === "user_message"
      && event.payload.via === "repos"
      && String(event.payload.text).includes("beta")), "事件账留痕");

    // 单方向 diff(只移除):增段不得出现空段落——便签换成移除段首行,
    // 带拍板语义。模块绑定仓(alpha)之外都可移除。
    service.requestRepoChanges(id, { add: [], remove: [delta] });
    const afterRemove = readStateFile(dataDir, id);
    const note = afterRemove.stage_note ?? "";
    assert.match(note, /移除本会话的代码仓/);
    assert.doesNotMatch(note, /新增了代码仓/, "空方向不出空段");
    // 拍板语义钉在便签全文(parked_notices,续跑随行注入模型):stage_note
    // 是首行截 120 字的展示摘要,macOS $TMPDIR 路径(/var/folders/…约 100 字)
    // 会把拍板句挤出截断窗(Linux /tmp 下才侥幸可见)。
    const parked = afterRemove.parked_notices?.at(-1) ?? "";
    assert.match(parked, /移除本会话的代码仓/);
    assert.match(parked, /与本问题无关/, "便签带拍板语义");
    assert.doesNotMatch(parked, /新增了代码仓/, "空方向不出空段");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 端到端 tracer:空闲提交增删 diff → 通知开回合 → Agent 执行 ----

/** https 假远端的传输垫片:端点只收 https://,端到端的 pull_repo 就得
 * 真克隆一个 https 地址;但服务端拉仓走 git 子进程,而本机(WSL2)环境
 * 跨进程回环不可达,起本地 https 服务是死路。垫片把唯一的测试地址
 * (git-mfc-test.local)重写到本地裸仓后 exec 真 git——URL 在产品代码
 * 里全程保持 https(通知/清单/校验都认它),只有传输层被替身,与
 * ScriptedModelServer 顶替模型同一精神。 */
const FAKE_REMOTE = "https://git-mfc-test.local/gamma.git";

function installGitUrlShim(target: string): () => void {
  const realGit = execFileSync("sh", ["-c", "command -v git"])
    .toString().trim();
  const dir = mfcTemp("mfc-issue-repochange-shim-");
  writeFileSync(join(dir, "git"), [
    "#!/usr/bin/env node",
    "const { spawnSync } = require(\"node:child_process\");",
    `const BAD = ${JSON.stringify(FAKE_REMOTE)};`,
    `const TARGET = ${JSON.stringify(target)};`,
    "const args = process.argv.slice(2).map((a) => a === BAD ? TARGET : a);",
    `const done = spawnSync(${JSON.stringify(realGit)}, args,`
      + " { stdio: \"inherit\" });",
    "process.exit(done.status ?? 1);",
    "",
  ].join("\n"), { mode: 0o755 });
  const savedPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${savedPath}`;
  return () => { process.env.PATH = savedPath; };
}

test("端到端:空闲会话提交增删 diff → 通知开续聊回合 → Agent 依次 pull_repo/remove_repo → 清单终态与转移账", async () => {
  const dataDir = mfcTemp("mfc-issue-repochange-e2e-");
  const origins = join(dataDir, "origins");
  const alpha = bareOriginAt(origins, "alpha.git");
  const beta = bareOriginAt(origins, "beta.git");
  const gamma = bareOriginAt(origins, "gamma.git");
  const restorePath = installGitUrlShim(gamma);
  const id = seedIssue(dataDir, { repoUrls: [alpha, beta] });
  // 工作区先有 alpha 克隆:移除要真删目录(与 #240 工具同一执行体)。
  const alphaDir = cloneWorkspaceRepo(dataDir, id, "alpha", alpha);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: FAKE_REMOTE } } },
    { tool: { name: "remove_repo", input: { repo: alpha } } },
    { text: "已拉入用户指派的新仓,并移除无关仓。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 空闲会话:continueTurn 通道——通知以续聊词开新回合。
    const summary = service.requestRepoChanges(id, {
      add: [FAKE_REMOTE],
      remove: [alpha],
    });
    assert.equal(summary.id, id);
    assert.equal(summary.status, "running", "空闲=开续聊回合");

    // 通知词两段都进模型上下文:增段指路 pull_repo、删段带拍板语义。
    await until(() => model.requests.length >= 1 ? true : undefined,
      "通知回合启动");
    const texts = userTexts(model);
    assert.ok(texts.includes(FAKE_REMOTE), `增段要带新仓地址(实际:${texts.slice(0, 400)})`);
    assert.match(texts, /补充分析该仓/);
    assert.match(texts, /remove_repo/);
    assert.match(texts, /与本问题无关/, "删段带拍板语义");
    assert.match(texts, new RegExp(alpha.replace(/\//g, "\\/")), "删段点名旧仓");

    // Agent 依次执行:pull_repo 入列、remove_repo 出列(回执成功)。
    const final = await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "增删回合收口");
    // 清单终态:alpha 出列、gamma 入列、beta 不动;首位字段接替新首位。
    assert.deepEqual(final.repo_urls, [beta, FAKE_REMOTE]);
    assert.equal(final.repo_url, beta);
    // 工作区:alpha 目录真没了,gamma 落地。
    assert.equal(existsSync(alphaDir), false, "被移除的仓目录真删");
    assert.equal(existsSync(join(dataDir, "issues", id, "repo", "gamma")),
      true, "新仓已克隆落地");
    // 回执:两个工具都成功走完。
    const receipts = readEvents(dataDir, id)
      .filter((event) => event.kind === "tool_finished");
    const pulled = receipts.find((event) => event.payload.name === "pull_repo");
    const removed = receipts.find((event) => event.payload.name === "remove_repo");
    assert.equal(pulled?.payload.is_error, false, "pull_repo 应成功");
    assert.equal(removed?.payload.is_error, false, "remove_repo 应成功");
    // 转移账三笔:用户调整留痕 + 拉取 + 移除(带"用户指派"语义)。
    const notes = (readStateFile(dataDir, id).transitions ?? [])
      .map((entry) => entry.note);
    assert.ok(notes.some((note) => /用户调整会话仓清单/.test(note)),
      "端点留痕在场");
    assert.ok(notes.some((note) => /代码仓已拉取/.test(note)
      && note.includes("gamma")), "Agent 拉取入列留痕");
    assert.ok(notes.some((note) => /代码仓已移除/.test(note)
      && /用户指派/.test(note)), "Agent 移除留痕带用户指派语义");
  } finally {
    restorePath();
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 发送通道:运行中提交=steer 送达(话必须进模型上下文) ----

test("运行中提交=steer 送达:通知递进正在跑的回合,不抢方向盘也不落便签", async () => {
  const dataDir = mfcTemp("mfc-issue-repochange-steer-");
  const alpha = bareOriginAt(join(dataDir, "origins"), "alpha.git");
  const gamma = "https://git.example.com/org/gamma.git";
  // 种 running(重启续跑形态):第一幕故意跑慢命令,给 steer 留忙时窗口。
  const id = seedIssue(dataDir, { repoUrls: [alpha], status: "running" });
  const script: Scene[] = [
    { tool: { name: "bash", input: { command: "sleep 5" } } },
    { text: "收到仓清单调整,稍后执行。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 等模型真的开跑(请求已发出=现场 driver 必在)再提交调整。
    await until(() => model.requests.length >= 1 ? true : undefined,
      "重启续跑回合启动");
    const summary = service.requestRepoChanges(id, {
      add: [gamma], remove: [alpha],
    });
    assert.equal(summary.status, "running", "不打断正在跑的回合");
    // steer 送达事件(user_message via=interrupt)与模型收到的正文。
    await until(() => readEvents(dataDir, id).some((event) =>
      event.kind === "user_message"
      && event.payload.via === "interrupt"
      && String(event.payload.text).includes(gamma)) ? true : undefined,
    "steer 送达事件落账");
    await until(() => {
      const texts = userTexts(model);
      return texts.includes(gamma)
        && texts.includes("与本问题无关") ? true : undefined;
    }, "通知正文进模型上下文");
    // 落的是 steer 不是便签:stage_note 不被 park 覆写。
    await until(() => {
      const state = readStateFile(dataDir, id);
      return state.status === "idle" ? state : undefined;
    }, "回合收口");
    assert.doesNotMatch(readStateFile(dataDir, id).stage_note ?? "",
      /新增了代码仓/, "送达了就不落便签");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
