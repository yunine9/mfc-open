import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { PipelineRun } from "../src/pipelineClient.ts";
import type { IssuePipelineWatch } from "../src/issueFlow/state.ts";
import { seedMrGreenWatch, until } from "./issueFlowFixed.helpers.ts";
import { mfcTemp } from "./mfcTmp.ts";

const repo = "https://example.test/son.git";
const sha = "c".repeat(40);
const red: PipelineRun = { status: "failed", log: "DT=1(期望=0)",
  checks: [{ dimension: "UT", status: "failed", tool: "CPP_UT" }] };
const coverage = { name: "codecheck_detail.json", text: JSON.stringify({ defects: [
  { indicatorName: "clike diff coverage rate(%)", actualValue: "0.0", threshold: 70 },
] }) };

async function fixture(reply: (attempt: number) => { status?: number; files?: typeof coverage[] },
  budgetMs = 500, watch: Partial<IssuePipelineWatch> = {}) {
  const dataDir = mfcTemp("mfc-issue-evidence-retry-");
  seedMrGreenWatch(dataDir, repo, { watching: false, ...watch });
  let attempts = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const body = request.url?.startsWith("/pipeline/artifacts") ? reply(++attempts) : {};
    response.writeHead("status" in body ? body.status ?? 200 : 200,
      { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const service: any = new IssueFlowService({ dataDir, provider: "fixture", model: "fixture",
    modelsJson: {}, deferRecovery: true,
    platformUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    settings: { models: () => ({}), runtime: () => ({ poll_timeout_s: budgetMs / 1000 }) },
  });
  const prompts: string[] = [];
  service.watchMergeStates = () => {};
  service.watchMrDiscussions = () => {};
  service.startPlatformTurn = (_live: unknown, prompt: string) => prompts.push(prompt);
  service.pipelineEvidenceDelayMs = () => 5;
  service.start();
  const live = service.live.get("issue-1");
  return { service, live, prompts, requests, attempts: () => attempts,
    settle: (run = red) => service.settlePipeline(live, repo, sha, run),
    disk: () => JSON.parse(readFileSync(join(live.root, "issue.json"), "utf8")),
    async stop() { await service.shutdown(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("#578 瞬时产物失败后自动重试，取证期间不发回合、不扣轮次", async () => {
  let observedRetry = false;
  const f = await fixture(attempt => {
    if (attempt === 1) return { status: 502 };
    observedRetry = true;
    assert.equal(f.prompts.length, 0);
    assert.equal(f.live.state.pipelines[repo].reds ?? 0, 0);
    assert.equal(f.disk().pipelines[repo].watching, true, "重启可继续取证");
    return { files: [coverage] };
  });
  try {
    await f.settle();
    assert.equal(observedRetry, true, "一次失败不能直接交给用户贴报错");
    assert.equal(f.attempts(), 2);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.live.state.pipelines[repo].reds, 1);
    assert.match(f.prompts[0], /clike diff coverage rate/);
    assert.match(f.prompts[0], /0\.0/);
    assert.match(f.prompts[0], /70/);
    assert.equal(f.live.state.gate, undefined);
  } finally { await f.stop(); }
});

test("#578 持续缺证到期才交 Agent 举卡，提供缺失维度和上游原因", async () => {
  const f = await fixture(() => ({ files: [{ name: "pipeline_log_summary.json",
    text: JSON.stringify({ strategies: { coverage: { status: "failed", note: "coverage HTTP 502" } } }),
  }] }), 100);
  try {
    await f.settle();
    assert.ok(f.attempts() > 1);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /取证重试已到期/);
    assert.match(f.prompts[0], /UT\/覆盖率.*coverage HTTP 502/s);
    assert.match(f.prompts[0], /pipeline_evidence/);
  } finally { await f.stop(); }
});

test("#578 部分维度有证据立即交付，缺失维度单独说明", async () => {
  const f = await fixture(() => ({ files: [coverage] }));
  try {
    await f.settle({ ...red, checks: [...red.checks!, { dimension: "COMPILE", status: "failed" }] });
    assert.equal(f.attempts(), 1);
    assert.match(f.prompts[0], /编译\/构建 红灯，但没有可定位的具体报错/);
    assert.match(f.prompts[0], /UT\/覆盖率.*codecheck_detail/s);
  } finally { await f.stop(); }
});

for (const change of ["cancel", "replace", "epoch", "merged"] as const) {
  test(`#578 镜像请求期间 ${change}，旧结果不得发回合或消耗轮次`, async () => {
    const f = await fixture(() => {
      if (change === "cancel") f.live.state.status = "canceled";
      if (change === "replace") f.live.state.pipelines[repo] = {
        ...f.live.state.pipelines[repo], sha: "d".repeat(40), reds: 0,
      };
      if (change === "epoch") f.live.controlEpoch++;
      if (change === "merged") f.live.state.mrs[0].merged_at = new Date().toISOString();
      return { files: [coverage] };
    });
    try {
      await f.settle();
      assert.equal(f.prompts.length, 0);
      assert.equal(f.live.state.pipelines[repo].reds ?? 0, 0);
    } finally { await f.stop(); }
  });
}

test("#578 进程恢复保留取证截止时间，到期直接发送缺口且不触发流水线", async () => {
  const deadline = new Date(Date.now() - 1000).toISOString();
  let seenDeadline: string | undefined;
  const f = await fixture(() => {
    seenDeadline = f.disk().pipelines[repo].evidence_retry_deadline;
    return { files: [] };
  }, 500, { status: "failed", watching: true, checks: red.checks,
    evidence_retry_deadline: deadline, evidence_retry_attempts: 2, evidence_failure_log: red.log });
  try {
    await until(() => f.prompts.length || undefined, "恢复取证到期后发送缺口", 2000);
    assert.equal(seenDeadline, deadline);
    assert.equal(f.attempts(), 1, "已到期不能重开重试预算");
    assert.equal(f.requests.some(url => url.startsWith("/pipeline/trigger")), false);
    assert.match(f.prompts[0], /取证重试已到期/);
    assert.equal(f.live.state.pipelines[repo].reds, 1);
  } finally { await f.stop(); }
});

test("#578 摘要已有编译错误时不等待产物，直接进入修复", async () => {
  const f = await fixture(() => ({ status: 502 }));
  try {
    await f.settle({ status: "failed", log: "src/main.cpp:12: error: missing member",
      checks: [{ dimension: "COMPILE", status: "failed" }] });
    assert.equal(f.attempts(), 1);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /流水线终态失败摘要/);
  } finally { await f.stop(); }
});

const statusNoise = "devtest_hdt.sh\n" + "processing stage\n".repeat(400) + "构建失败=1\n";
const gateFailure = "access_control.py 门禁检查 exit code 1, Error message is empty";

test("#583 无失败维度和具体报错，502 后补取同一提交的产物", async () => {
  const f = await fixture(n => n === 1 ? { status: 502 } : {
    files: [{ name: "build_log_gate.txt", text: gateFailure }],
  });
  try {
    await f.settle({ status: "failed", log: statusNoise, checks: [] });
    assert.equal(f.attempts(), 2);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /build_log_gate\.txt/);
    assert.equal(readFileSync(join(f.live.root, "pipeline", "build_log_gate.txt"), "utf8"), gateFailure);
    assert.equal(f.live.state.pipelines[repo].reds, 1);
  } finally { await f.stop(); }
});

test("#583 长摘要末尾已有报错，Agent 收到原文且不等待空镜像", async () => {
  for (const [checks, cause] of [
    [[], gateFailure],
    [[{ dimension: "COMPILE", status: "failed" }], gateFailure],
    [[{ dimension: "COMPILE", status: "failed" }], "   L94: python access_control.py\n>> L95: exit code 1, Error message is empty"],
    [[{ dimension: "COMPILE", status: "failed" }], "src/parser.cc:212: error: missing return"],
  ] as const) {
    const f = await fixture(() => ({ status: 502 }));
    try {
      await f.settle({ status: "failed", log: statusNoise + cause, checks: [...checks] });
      assert.equal(f.attempts(), 1);
      assert.ok(f.prompts[0].includes(cause), "判断有证据的错误必须交给 Agent");
    } finally { await f.stop(); }
  }
});

test("#583 只有失败计数但产物查询正常为空或未配置，不新增重试", async () => {
  for (const result of [{ files: [] }, { status: 404 }, { status: 403 }]) {
    const f = await fixture(() => result);
    try {
      await f.settle({ status: "failed", log: statusNoise, checks: [] });
      assert.equal(f.attempts(), 1);
      assert.equal(f.prompts.length, 1);
    } finally { await f.stop(); }
  }
});

test("#583 自定义适配器的大日志保留中间错误，恢复用的内容与修复消息一致", async () => {
  const noise = "normal output\n".repeat(2500);
  const cause = "src/parser.cc:212: error: missing return";
  let persisted: string | undefined;
  const f = await fixture(() => {
    persisted = f.disk().pipelines[repo].evidence_failure_log;
    return { status: 502 };
  });
  try {
    await f.settle({ status: "failed", checks: [{ dimension: "COMPILE", status: "failed" }],
      log: noise + cause + "\n" + noise });
    assert.equal(f.attempts(), 1);
    assert.ok(persisted && persisted.length <= 16_000 && persisted.includes(cause));
    assert.ok(f.prompts[0].includes(persisted));
  } finally { await f.stop(); }
});
