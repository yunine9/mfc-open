/**
 * 事件日志崩溃残迹自愈(issue-31/32/33 复盘,2026-09-10):进程/文件
 * 系统在 appendFileSync 落盘瞬间死掉留下断写尾巴——全零块或半行。
 * 契约:末行残迹截断修复+大声记账;中间坏行维持 fail-loud;完好行
 * 缺换行补 \n 愈合(防下一次 append 粘行成中间损坏)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog, EventLogError } from "../src/semanticEvents.ts";
import { mfcTemp } from "./mfcTmp.ts";

function goodEvent(eventId: number) {
  return {
    eventId,
    taskId: "task-1",
    sessionId: "session-1",
    ts: `2026-09-10T11:13:${String(eventId).padStart(2, "0")}Z`,
    kind: "turn_finished" as const,
    payload: { reason: "end_turn" },
  };
}

const GOOD_LINE = (eventId: number) => JSON.stringify(goodEvent(eventId));

function logPath(root: string): string {
  return join(root, "events.jsonl");
}

test("末行全零块:replay 截断修复返回完好行,文件回到健康边界,记账大声", () => {
  const root = mfcTemp("mfc-eventlog-zero-");
  writeFileSync(logPath(root),
    `${GOOD_LINE(1)}\n${GOOD_LINE(2)}\n${"\u0000".repeat(1359)}`);
  const noted: string[] = [];
  const log = new EventLog(logPath(root), undefined, (m) => noted.push(m));
  const rows = log.replay();
  assert.equal(rows.length, 2, "全零尾巴不算事件");
  assert.equal(rows[1].eventId, 2);
  assert.match(noted.join("\n"), /末行崩溃残迹已截断/);
  assert.match(noted.join("\n"), /1359 字节/);
  // 文件落回最后一条完好事件的换行边界:修复是持久的,不是读时过滤。
  assert.equal(readFileSync(logPath(root), "utf-8"),
    `${GOOD_LINE(1)}\n${GOOD_LINE(2)}\n`);
});

test("末行全零块带换行:同样按残迹截断(残迹不因带了 \\n 变成中间行)", () => {
  const root = mfcTemp("mfc-eventlog-zeronl-");
  writeFileSync(logPath(root),
    `${GOOD_LINE(1)}\n${"\u0000".repeat(64)}\n`);
  const log = new EventLog(logPath(root));
  const rows = log.replay();
  assert.equal(rows.length, 1);
  assert.equal(readFileSync(logPath(root), "utf-8"), `${GOOD_LINE(1)}\n`);
});

test("末行半写残迹(JSON 前缀无换行):截断丢弃,不抛 EventLogError", () => {
  const root = mfcTemp("mfc-eventlog-half-");
  writeFileSync(logPath(root), `${GOOD_LINE(1)}\n{"eventId":2,"taskId":"t`);
  const log = new EventLog(logPath(root));
  const rows = log.replay();
  assert.equal(rows.length, 1, "半行不是事件");
  assert.equal(readFileSync(logPath(root), "utf-8"), `${GOOD_LINE(1)}\n`);
});

test("完好末行缺换行:事件保留并补 \\n 愈合,后续 append 不粘行", () => {
  const root = mfcTemp("mfc-eventlog-heal-");
  writeFileSync(logPath(root), `${GOOD_LINE(1)}\n${GOOD_LINE(2)}`);
  const noted: string[] = [];
  const log = new EventLog(logPath(root), undefined, (m) => noted.push(m));
  const rows = log.replay();
  assert.equal(rows.length, 2, "缺换行的完好事件不丢");
  assert.match(noted.join("\n"), /末行缺换行已愈合/);
  // 愈合后继续追加:两条事件各自成行,文件整体可解析。
  assert.equal(log.append(goodEvent(3)), true);
  const after = readFileSync(logPath(root), "utf-8");
  assert.equal(after, `${GOOD_LINE(1)}\n${GOOD_LINE(2)}\n${GOOD_LINE(3)}\n`);
  assert.equal(new EventLog(logPath(root)).replay().length, 3);
});

test("修复后可继续追加:崩溃→自愈→新事件,账本连续且健康", () => {
  const root = mfcTemp("mfc-eventlog-append-");
  writeFileSync(logPath(root), `${GOOD_LINE(1)}\n${"\u0000".repeat(99)}`);
  const log = new EventLog(logPath(root));
  assert.equal(log.lastEventId(), 1, "残迹不参与水位");
  assert.equal(log.append(goodEvent(2)), true);
  const rows = new EventLog(logPath(root)).replay();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].eventId, 2);
});

test("中间坏行:仍 fail-loud 抛 EventLogError,且不动文件", () => {
  const root = mfcTemp("mfc-eventlog-mid-");
  const corrupt = `${GOOD_LINE(1)}\n${"\u0000".repeat(32)}\n${GOOD_LINE(3)}\n`;
  writeFileSync(logPath(root), corrupt);
  const before = statSync(logPath(root)).size;
  const log = new EventLog(logPath(root));
  assert.throws(() => log.replay(), EventLogError);
  assert.equal(statSync(logPath(root)).size, before,
    "真损坏不截断——留给人工查");
});

test("整文件全零(无完好行):截断到空,记账不静默", () => {
  const root = mfcTemp("mfc-eventlog-allzero-");
  writeFileSync(logPath(root), "\u0000".repeat(100));
  const noted: string[] = [];
  const log = new EventLog(logPath(root), undefined, (m) => noted.push(m));
  assert.deepEqual(log.replay(), []);
  assert.match(noted.join("\n"), /末行崩溃残迹已截断/);
  assert.equal(readFileSync(logPath(root), "utf-8"), "");
});
