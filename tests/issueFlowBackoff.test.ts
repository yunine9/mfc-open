import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, extendDeadlineByBackoff, ConsecutiveFailureLog, MAX_BACKOFF_MS } from "../src/issueFlow/backoff.ts";
import { fetchMrDiscussions } from "../src/issueFlow/mrDiscussions.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";

test("连续失败按 2 的幂退避并封顶，成功复位", () => {
  assert.equal(backoffMs(30_000, 0), 30_000);
  assert.equal(backoffMs(30_000, 1), 60_000);
  assert.equal(backoffMs(30_000, 2), 120_000);
  assert.equal(backoffMs(30_000, 3), 240_000);
  assert.equal(backoffMs(30_000, 4), MAX_BACKOFF_MS);
  assert.equal(backoffMs(30_000, 99), MAX_BACKOFF_MS);
});

test("退避多等的时间补回截止时间，不提前耗尽预算", () => {
  const deadline = new Date("2026-11-09T00:30:00Z").toISOString();
  assert.equal(extendDeadlineByBackoff(deadline, 30_000, 0), deadline);
  assert.equal(extendDeadlineByBackoff(deadline, 30_000, 1),
    new Date("2026-11-09T00:30:30Z").toISOString());
  assert.equal(extendDeadlineByBackoff(deadline, 30_000, 3),
    new Date("2026-11-09T00:33:30Z").toISOString());
});

test("同一错误连续出现只记首条全文，每 10 次记一条计数；变化后重新记全文", () => {
  const lines: string[] = [];
  const log = new ConsecutiveFailureLog(message => lines.push(message));
  for (let index = 0; index < 9; index++) log.fail("k", "查询失败: HTTP 502");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "查询失败: HTTP 502");
  log.fail("k", "查询失败: HTTP 502");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /同错误已连续 10 次/);
  log.fail("k", "查询失败: HTTP 429");
  assert.equal(lines[2], "查询失败: HTTP 429");
  log.reset("k");
  log.fail("k", "查询失败: HTTP 429");
  assert.equal(lines[3], "查询失败: HTTP 429");
});

test("监看默认 30 秒一轮，配置覆盖仍然生效且保留下限", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-backoff-"));
  try {
    const make = (runtime: Record<string, number>) => new IssueFlowService({
      dataDir: dir, provider: "test", model: "test", modelsJson: {},
      deferRecovery: true, settings: { models: () => ({}), runtime: () => runtime },
    });
    const defaults = make({}) as any;
    assert.equal(defaults.pipelineKnobs().pollMs, 30_000);
    assert.equal(defaults.pipelineKnobs().budgetMs, 1_800_000);
    const configured = make({ poll_interval_s: 7 }) as any;
    assert.equal(configured.pipelineKnobs().pollMs, 7_000);
    const floored = make({ poll_interval_s: 0 }) as any;
    assert.equal(floored.pipelineKnobs().pollMs, 1_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("检视明细 502 带出适配器返回的 stderr 摘要，便于归因", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "CLI 失败: codehub 退出异常(Command failed)\nstderr: HTTP 429 rate limit" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const fetched = await fetchMrDiscussions({
      platformUrl: `http://127.0.0.1:${port}`, repo: "repo", mr: 1,
    });
    assert.equal(fetched.kind, "unavailable");
    assert.match(fetched.reason!, /HTTP 502/);
    assert.match(fetched.reason!, /stderr/);
    assert.match(fetched.reason!, /429/);
  } finally { server.close(); }
});
