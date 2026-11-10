/** 审计账写入原语契约(ADR-0053):JSON lines 双时间、fail-open、
 *  滚动压缩、两级账面路径。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAudit, auditLogsDir, configureAudit, newRequestId,
  processAudit, rotateAuditFile, sessionAudit,
} from "../src/issueFlow/audit.ts";

test("appendAudit:JSON 行带双时间与默认级别,entry 字段可覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-audit-"));
  const file = join(dir, "audit", "delivery.jsonl");
  const before = new Date(Date.now() - 60_000).toISOString();
  appendAudit(file, {
    kind: "delivery.turn", msg: "意见清单注入",
    ts: before, level: "warn", count: 2,
  });
  const row = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(row.ts, before, "补记的 ts 保留");
  assert.notEqual(row.written_at, before, "written_at 是落账时刻,双时间分叉");
  assert.equal(row.level, "warn");
  assert.equal(row.count, 2);
  assert.equal(row.kind, "delivery.turn");
  // 实时写:双时间相等,level 默认 info。
  appendAudit(file, { kind: "decision.x", msg: "现场决策" });
  const row2 = JSON.parse(readFileSync(file, "utf-8").trim().split("\n").at(-1)!);
  assert.equal(row2.ts, row2.written_at);
  assert.equal(row2.level, "info");
  rmSync(dir, { recursive: true, force: true });
});

test("appendAudit fail-open:写不动不抛,stderr 降级", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-audit-"));
  // 把落点造成目录:appendFileSync 必 EISDIR。
  const file = join(dir, "blocker");
  writeFileSync(file, "");
  rmSync(file);
  writeFileSync(file, "");
  assert.doesNotThrow(() =>
    appendAudit(file, { kind: "x.y", msg: "m" }));
  rmSync(dir, { recursive: true, force: true });
});

test("rotateAuditFile:过限滚动压缩,旧档 .gz 在、明文删,不过限不动", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-audit-"));
  const file = join(dir, "host-calls.jsonl");
  writeFileSync(file, "x".repeat(100));
  rotateAuditFile(file, 50);
  assert.equal(existsSync(file), false, "过限明文滚走");
  const gz = readdirSync(dir).find((f) => f.startsWith("host-calls.jsonl-")
    && f.endsWith(".gz"));
  assert.ok(gz, "旧档压缩在档");
  rotateAuditFile(file, 50);
  assert.equal(existsSync(file), false, "新写不存在仍无档可滚");
  writeFileSync(file, "small");
  rotateAuditFile(file, 50);
  assert.equal(readFileSync(file, "utf-8"), "small", "不过限不滚动");
  rmSync(dir, { recursive: true, force: true });
});

test("两级账面:sessionAudit 带 issue_id 落 audit/,processAudit 未配置弃写", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-audit-issue-"));
  sessionAudit(root, "issue-9", "dispatch",
    { kind: "dispatch.box", msg: "装箱", request_id: "mrr-1" });
  const row = JSON.parse(readFileSync(
    join(root, "audit", "dispatch.jsonl"), "utf-8"));
  assert.equal(row.issue_id, "issue-9");
  assert.equal(row.request_id, "mrr-1");

  assert.equal(auditLogsDir(), "", "测试世界默认无进程账");
  processAudit("host-calls", { kind: "call.x", msg: "不应落盘" });
  assert.equal(existsSync(join(root, "logs")), false,
    "未 configureAudit 时进程账弃写");
  const logs = mkdtempSync(join(tmpdir(), "mfc-audit-logs-"));
  configureAudit(logs);
  try {
    processAudit("host-calls", { kind: "call.x", msg: "落盘", ms: 12 });
    const prow = JSON.parse(readFileSync(
      join(logs, "host-calls.jsonl"), "utf-8"));
    assert.equal(prow.ms, 12);
  } finally {
    configureAudit(""); // 还原:别把进程账漏进其他用例
    rmSync(root, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
});

test("newRequestId:r- 前缀短 id", () => {
  const id = newRequestId();
  assert.match(id, /^r-[0-9a-f]{8}$/);
});
