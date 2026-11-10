import test from "node:test";
import assert from "node:assert/strict";
import { visibleMemoryUsage } from "../web/src/memoryUsageView.ts";
import type { MemoryUsageRow } from "../web/src/api.ts";

const row = (over: Partial<MemoryUsageRow>): MemoryUsageRow => ({
  ts: "2026-11-09T00:00:00.000Z", moment: "context", ids: [], ...over,
});

test("知识使用记录只展示真正取到内容或报告结果的记录", () => {
  const rows: MemoryUsageRow[] = [
    row({ moment: "context", status: "ready", ids: ["c-1"] }),
    row({ moment: "context", status: "empty" }),
    row({ moment: "context", status: "unavailable" }),
    row({ moment: "search", status: "ready", ids: ["c-2"], query: "超时重试" }),
    row({ moment: "search", status: "ready", query: "超时重试" }),
    row({ moment: "expand", status: "rejected", ids: ["doc-1"] }),
    row({ moment: "expand", status: "ready", ids: ["doc-2"] }),
    row({ moment: "edit", dir: "src", digest: true }),
    row({ moment: "edit", dir: "src" }),
    row({ moment: "component_check", status: "unavailable",
      check: { trigger: "edit", findings: 0, hints: 0, rules_digest: "d" } }),
    row({ moment: "launch", ids: ["c-3"] }),
    row({ moment: "launch" }),
    row({ moment: "phase", phase: "build", ids: ["c-4"] }),
  ];
  assert.deepEqual(visibleMemoryUsage(rows).map((item) => [item.moment, item.ids]),
    [["context", ["c-1"]], ["search", ["c-2"]], ["expand", ["doc-2"]],
      ["edit", []], ["component_check", []], ["launch", ["c-3"]], ["phase", ["c-4"]]]);
});

test("全部是未命中或检索不可用时，面板应为空", () => {
  assert.deepEqual(visibleMemoryUsage([
    row({ status: "empty" }),
    row({ status: "unavailable" }),
    row({ moment: "search", status: "ready" }),
    row({ moment: "expand", status: "rejected", ids: ["doc-1"] }),
  ]), []);
});
