/**
 * 流水线契约纯函数:防过期结果选取、结构化失败摘要、不可修工具分诊。
 * 全部来自 2026-08-28 内网对比报告(mae-flow-cloud vs toolkit)的
 * 差距修复——修复环"一直拿不全/拿不准流水线信息"的根子。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import {
  onlyUnfixableToolFailures,
  parsePipelineChecks,
  selectTerminalRun,
  summarizeFailedChecks,
} from "../src/pipelineContract.ts";
import { getPipelineStatus } from "../src/pipelineClient.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

test("超限指标不被普通缺陷摘要预算挤掉，不解释 DT 的含义", () => {
  const lines = summarizeFailedChecks([{
    dimension: "COMPILE", status: "failed",
    details: [
      ...Array.from({ length: 12 }, (_, i) => ({ message: `错误 ${i}` })),
      { message: "构建失败=1 [超限]", rule: "quality_metric", severity: "error" },
      { message: "DT=2 [超限]", rule: "quality_metric", severity: "error" },
    ],
  }], 1).join("\n");
  assert.match(lines, /构建失败=1/);
  assert.match(lines, /DT=2/);
  assert.match(lines, /还有 11 条/);
  assert.doesNotMatch(lines, /部署测试/);
});

test("防过期结果:is_valid=false 与绑错 SHA 的 run 一律拒收", () => {
  // MR 头上无有效流水线时平台挂旧分支的灯(对比报告头号根因):
  // 旧绿灯不背书新代码,旧红灯也不许触发白烧的修复轮。
  const stale = selectTerminalRun([
    { status: "success", is_valid: false },
    { status: "failed", sha: OTHER },
  ], SHA);
  assert.equal(stale.run, undefined);
  assert.equal(stale.rejected.length, 2);
  assert.match(stale.rejected[0], /is_valid/);
  assert.match(stale.rejected[1], /过期结果/);

  // 绑对 SHA 的终态照常选中;不带回显字段的老配置保持旧行为。
  const good = selectTerminalRun([
    { status: "running" },
    { status: "failed", sha: SHA, is_valid: true },
  ], SHA);
  assert.equal(good.run?.status, "failed");
  const legacy = selectTerminalRun([{ status: "success" }], SHA);
  assert.equal(legacy.run?.status, "success");
  assert.equal(legacy.rejected.length, 0);
});

test("checks 粒度:stage/tool/details 宽进,畸形明细丢弃不整包作废", () => {
  const checks = parsePipelineChecks([
    {
      dimension: "CODECHECK", status: "failed",
      job: "codecheck", stage: "quality", tool: "CodeCheck",
      details: [
        { rule: "G.FMT.01", file: "src/a.cpp", line: 42,
          severity: "major", tool: "CodeCheck", message: "缺少空格" },
        { message: "" },              // 空 message 丢弃
        "not-an-object",              // 畸形丢弃
        { message: "无定位也算数" },
      ],
    },
    { dimension: "COMPILE", status: "success" },
  ]);
  assert.ok(checks);
  assert.equal(checks![0].stage, "quality");
  assert.equal(checks![0].tool, "CodeCheck");
  assert.equal(checks![0].details?.length, 2);
  assert.equal(checks![0].details?.[0].line, 42);
  const mrLevel = parsePipelineChecks([{
    dimension: "CODECHECK", status: "failed",
    details: [{ file: "src/a.cpp", line: 0, message: "MR 级规则命中" }],
  }]);
  assert.equal(mrLevel?.[0].details?.[0].line, 0,
    "line=0 是整文件/MR 级定位，契约层不能丢掉");
  // 核心字段仍然严格:dimension 认不出=整包作废(核销不许猜)。
  assert.equal(parsePipelineChecks([
    { dimension: "LINT", status: "failed" }]), undefined);
});

test("结构化失败摘要:点名 stage/job/工具与缺陷定位,超量截断", () => {
  const lines = summarizeFailedChecks([
    {
      dimension: "CODECHECK", status: "failed", stage: "quality",
      job: "codecheck-job", tool: "CodeCheck",
      details: Array.from({ length: 10 }, (_ignored, index) => ({
        rule: "R" + index, file: "src/f.cpp", line: index + 1,
        message: "问题 " + index,
      })),
    },
    { dimension: "UT", status: "success" },
  ], 3);
  assert.match(lines[0], /CODECHECK\(stage=quality job=codecheck-job tool=CodeCheck\)/);
  assert.match(lines[0], /缺陷 10 条/);
  assert.match(lines[1], /src\/f\.cpp:1 \[R0\] 问题 0/);
  assert.match(lines[4], /还有 7 条/);
  // 全绿=无话可说,不造噪音。
  assert.equal(summarizeFailedChecks([
    { dimension: "UT", status: "success" }]).length, 0);
});

test("不可修工具分诊:全体命中且有证据才成立,拿不准照常派发修复", () => {
  const superOnly = [{
    dimension: "CODECHECK" as const, status: "failed" as const,
    tool: "SuperChecker",
  }];
  assert.equal(onlyUnfixableToolFailures(superOnly, ["superchecker"]), true);
  // 缺 tool 证据 → 不成立(宁可多修一轮,不误判等人)。
  assert.equal(onlyUnfixableToolFailures([
    { dimension: "CODECHECK", status: "failed" }], ["superchecker"]), false);
  // 混着可修维度 → 不成立(照常派发修复,使命里单独点名不可修部分)。
  assert.equal(onlyUnfixableToolFailures([
    ...superOnly,
    { dimension: "COMPILE", status: "failed" },
  ], ["superchecker"]), false);
  // details 里的 tool 也算证据;混入未知工具 → 不成立。
  assert.equal(onlyUnfixableToolFailures([{
    dimension: "CODECHECK", status: "failed",
    details: [{ tool: "SuperChecker", message: "x" }],
  }], ["SuperChecker"]), true);
  assert.equal(onlyUnfixableToolFailures([{
    dimension: "CODECHECK", status: "failed",
    details: [
      { tool: "SuperChecker", message: "x" },
      { tool: "CodeCheck", message: "y" },
    ],
  }], ["SuperChecker"]), false);
  // 名单没配 = 分诊关闭。
  assert.equal(onlyUnfixableToolFailures(superOnly, undefined), false);
});

test("client 解析透传 run 级 sha/is_valid,缺席字段不造默认值", async () => {
  const seen: unknown[] = [];
  const server = createServer((request, response) => {
    seen.push(new URL(request.url ?? "", "http://x").searchParams.get("sha"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "failed",
      runs: [
        { status: "failed", sha: "a".repeat(40), is_valid: false, log: "陈灯" },
        { status: "running", sha: "b".repeat(40) },
      ],
    }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = await getPipelineStatus({ platformUrl: base, sha: "b".repeat(40) });
    assert.equal(status.runs.length, 2);
    assert.equal(status.runs[0].sha, "a".repeat(40));
    assert.equal(status.runs[0].is_valid, false, "过期结果标记要透传");
    assert.equal(status.runs[1].is_valid, undefined,
      "缺席的 is_valid 不造默认值(缺席=旧适配层)");
    assert.equal(status.runs[1].sha, "b".repeat(40));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
