/**
 * 流水线红灯公共判定层(需求流/问题流单一来源)的契约:
 * - mirrorPipelineArtifacts:拉取+先清旧目录+落盘+返回清单;
 *   404/坏响应/网络失败 fail-open 返回空，旧材料移到历史目录；
 *   根目录保持稳定，但不能在当前入口里展示上一轮材料。
 * - isBlindPipelineInput:盲输入三形态(裸链接/标签+链接/真内容)。
 *   标签+链接是内网实测原文形态——只认裸链接的第一版正好漏掉了它
 *   要防的那个场景(2026-08-21 读进场报告逮住)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type Server,
} from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBlindPipelineInput,
  mirrorPipelineArtifacts,
} from "../src/pipelineMirror.ts";
import { scopePipelineArtifacts } from "../src/pipelineArtifactScope.ts";

test("镜像默认等待 120 秒，30 秒后的慢响应仍可取证", async (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), "mfc-mirror-timeout-")), "pipeline");
  let signal: AbortSignal | undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: { signal: AbortSignal }) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
  });
  const pending = mirrorPipelineArtifacts({ platformUrl: "http://fixture", sha: "a", repo: "r", dir });
  t.mock.timers.tick(30_001);
  assert.equal(signal?.aborted, false, "不能沿用 30 秒超时");
  t.mock.timers.tick(89_999);
  assert.equal(signal?.aborted, true, "120 秒到点仍会结束请求");
  assert.deepEqual(await pending, []);
});

test("镜像延迟返回不能覆盖新版本；错误 SHA 和超时不会留下旧证据", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "mfc-mirror-race-")), "pipeline");
  let reply: ((body: unknown) => void) | undefined;
  let arrived!: () => void;
  let pending = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer((_request, response) => {
    reply = body => response.end(JSON.stringify(body));
    arrived();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const input = { platformUrl, dir, repo: "repo", sha: "old" };
  try {
    const old = mirrorPipelineArtifacts(input);
    await pending;
    scopePipelineArtifacts(dir, "new");
    writeFileSync(join(dir, "new.log"), "NEW_ONLY");
    reply!({ sha: "old", files: [{ name: "old.log", text: "OLD_ONLY" }] });
    assert.deepEqual(await old, []);
    assert.equal(readFileSync(join(dir, "new.log"), "utf8"), "NEW_ONLY");
    assert.equal(existsSync(join(dir, "old.log")), false);

    pending = new Promise<void>(resolve => { arrived = resolve; });
    const mismatch = mirrorPipelineArtifacts({ ...input, sha: "new" });
    await pending;
    reply!({ sha: "old", files: [{ name: "old.log", text: "OLD_ONLY" }] });
    assert.deepEqual(await mismatch, []);
    assert.equal(existsSync(join(dir, "old.log")), false);
    assert.deepEqual(await mirrorPipelineArtifacts({ ...input, sha: "new", timeoutMs: 40 }), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/** 可编程的假平台:记录请求行与身份头,按配置回状态码与 JSON。 */
async function fakePlatform(): Promise<{
  url: string;
  seen: Array<{ url: string; headers: Record<string, string> }>;
  setStatus: (status: number) => void;
  setFiles: (files: Array<{ name: string; text: string }>) => void;
  stop: () => Promise<void>;
}> {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let status = 200;
  let files: Array<{ name: string; text: string }> = [];
  const server: Server = createServer((request, response) => {
    seen.push({
      url: request.url ?? "",
      headers: request.headers as Record<string, string>,
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ files }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    setStatus: (value) => {
      status = value;
    },
    setFiles: (value) => {
      files = value;
    },
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test("盲输入判据:裸链接/标签+链接/占位符都算盲,真内容不算", () => {
  const bareLink = "https://ci.example.com/pipelines/12345";
  // 内网实测原文形态:链接抠掉后只剩 stage/job 标签 = 链接在替内容站岗。
  const labelAndLink = "FAILED stage=CodeCheck2.0 job=CodeCheck2.0"
    + "  detail: https://ci.example.com/p/12345";
  const realContent = "BUILD FAILURE: 模块 x 编译失败";
  assert.equal(isBlindPipelineInput(bareLink, false), true);
  assert.equal(isBlindPipelineInput(labelAndLink, false), true);
  assert.equal(isBlindPipelineInput(
    "(平台未提供失败详情)", false), true);
  assert.equal(isBlindPipelineInput(realContent, false), false,
    "没有链接则不论长短都是平台给的真内容,不算无证据");
  // 链接在,但抠掉后剩的诊断内容足够长(≥120 字)→ 不算盲。
  const linkPlusDetail = `detail: ${bareLink} `
    + "编译在 mae-core 模块挂了:未定义引用 pipeline_stage_run,"
    + "疑似 stage 注册表漏了新维度,请对照 CMakeLists 链接顺序检查;"
    + "同期改动还动了 scheduler 的头文件包含关系,大概率是循环依赖。";
  assert.equal(isBlindPipelineInput(linkPlusDetail, false), false);
  // 有镜像产物就不算盲——产物全文比任何摘要都可信。
  assert.equal(isBlindPipelineInput(bareLink, true), false);
  assert.equal(isBlindPipelineInput(labelAndLink, true), false);
});

test("镜像契约:落盘清单/先清旧目录/根目录 inode 不动/只读位", async () => {
  const platform = await fakePlatform();
  const dir = join(mkdtempSync(join(tmpdir(), "mfc-mirror-")), "pipeline");
  try {
    mkdirSync(join(dir, "stale-dir"), { recursive: true });
    writeFileSync(join(dir, "stale-dir", "old.log"), "old sha");
    const rootInode = lstatSync(dir).ino;
    platform.setFiles([
      { name: "build.log", text: "current sha build failure" },
    ]);
    assert.deepEqual(await mirrorPipelineArtifacts({
      platformUrl: platform.url,
      sha: "a".repeat(40),
      repo: "ssh://git@codehub/x.git",
      mrUrl: "https://codehub/x/-/merge_requests/7",
      dir,
      headers: { "x-mae-identity": "req-9" },
    }), ["build.log"]);
    // MR-first 契约:mr 参是完整 MR URL,repo 走 percent 编码;身份头透传。
    const rawQuery = platform.seen[0].url.split("?")[1] ?? "";
    assert.match(rawQuery,
      /(^|&)repo=ssh%3A%2F%2Fgit%40codehub%2Fx\.git/);
    assert.match(rawQuery,
      /(^|&)mr=https%3A%2F%2Fcodehub%2Fx%2F-%2Fmerge_requests%2F7/);
    assert.equal(new URLSearchParams(rawQuery).get("sha"), "a".repeat(40));
    assert.equal(platform.seen[0].headers["x-mae-identity"], "req-9");
    // 上一轮的旧现场清掉,但根目录本体不许换(运行中容器的 bind 源)。
    assert.equal(lstatSync(dir).ino, rootInode);
    assert.equal(existsSync(join(dir, "stale-dir")), false);
    assert.equal(readFileSync(join(dir, "build.log"), "utf-8"),
      "current sha build failure");
    assert.equal(lstatSync(join(dir, "build.log")).mode & 0o222, 0,
      "落盘材料不授予写权限");
  } finally {
    await platform.stop();
  }
});

test("镜像契约:404/坏响应/网络失败返回空，旧现场归档而不再作为当前证据", async () => {
  const platform = await fakePlatform();
  const dir = join(mkdtempSync(join(tmpdir(), "mfc-mirror-404-")), "pipeline");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.log"), "上一轮现场");
    platform.setStatus(404);
    assert.deepEqual(await mirrorPipelineArtifacts({
      platformUrl: platform.url, sha: "a", repo: "r", dir,
    }), []);
    assert.equal(existsSync(join(dir, "keep.log")), false);
    const history = join(dir, "..", "pipeline-history");
    const archive = readdirSync(history)[0];
    assert.equal(readFileSync(join(history, archive, "keep.log"), "utf8"), "上一轮现场");
    platform.setStatus(500);
    assert.deepEqual(await mirrorPipelineArtifacts({
      platformUrl: platform.url, sha: "a", repo: "r", dir,
    }), []);
    assert.equal(existsSync(join(dir, "keep.log")), false);
    // 网络失败(连接拒收):红灯主链路不因镜像中断。
    const dead = await fakePlatform();
    const deadUrl = dead.url;
    await dead.stop();
    assert.deepEqual(await mirrorPipelineArtifacts({
      platformUrl: deadUrl, sha: "a", repo: "r", dir,
    }), []);
    assert.equal(existsSync(join(dir, "keep.log")), false);
  } finally {
    await platform.stop();
  }
});

test("镜像契约:成功查询但零产物也必须清空上一轮;路径安全且保留完整日志", async () => {
  const platform = await fakePlatform();
  const dir = join(mkdtempSync(join(tmpdir(), "mfc-mirror-empty-")),
    "pipeline");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old_sha.log"), "old sha");
    platform.setFiles([]);
    assert.deepEqual(await mirrorPipelineArtifacts({
      platformUrl: platform.url, sha: "a", repo: "r", dir,
    }), []);
    assert.equal(existsSync(join(dir, "old_sha.log")), false,
      "零产物不清空,修复会话会按旧 SHA 日志改代码");
    // 路径穿越防线:文件名只留基名;长日志完整保留。
    const fullLog = "x".repeat(3 * 1024 * 1024)
      + "\nRun: 59 Failure total: 28 Failures: 28 Errors: 0\n"
      + "gcovr exit 22\n";
    platform.setFiles([
      { name: "sub/dir/build.log", text: fullLog },
      { name: ".", text: "weird" },
    ]);
    assert.deepEqual(await mirrorPipelineArtifacts({
      platformUrl: platform.url, sha: "a", repo: "r", dir,
    }), ["build.log"]);
    assert.equal(existsSync(join(dir, "sub")), false);
    assert.equal(readFileSync(join(dir, "build.log"), "utf8"), fullLog);
  } finally {
    await platform.stop();
  }
});
