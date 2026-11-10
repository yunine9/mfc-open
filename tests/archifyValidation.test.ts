import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndRepairArchify } from "../src/archifyValidation.ts";
import { materializeArchifyReferences } from "../src/archifyReferences.ts";

const source = { schema_version: 1, diagram_type: "architecture", meta: { title: "订单模块" },
  components: [{ id: "api", type: "backend", label: "API", pos: [40, 40], size: [180, 64] }], connections: [] };
const artifact = (value: unknown) => JSON.stringify({ schema_version: 1, diagrams: [{ id: "api", view: "logical", source: value }] });

test("真实渲染错误回到修复会话，修复后的当前图源重新渲染", async () => {
  let text = artifact({ ...source, connections: [{ from: "missing", to: "api" }] });
  const messages: string[] = [], progress: string[] = [];
  await validateAndRepairArchify({ read: () => ({ story: "# Story\n订单模块", artifact: text }),
    signal: new AbortController().signal, requireDiagrams: true, progress: (message) => progress.push(message),
    repair: async (message) => { messages.push(message); text = artifact(source); },
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /missing/);
  assert.match(messages[0], /只修改 architecture.json/);
  assert.ok(progress.some((message) => message.includes("修复（1/2）")));
});

test("错误持续时只修两轮；停止后不再请求 Agent", async () => {
  let attempts = 0;
  const read = () => ({ story: "# Story", artifact: "not json" });
  await assert.rejects(validateAndRepairArchify({ read, signal: new AbortController().signal,
    requireDiagrams: true, repair: async () => { attempts++; } }), /两轮修复仍未通过/);
  assert.equal(attempts, 2);
  const controller = new AbortController();
  await assert.rejects(validateAndRepairArchify({ read, signal: controller.signal,
    requireDiagrams: true, repair: async () => { controller.abort(); } }), /abort/i);
});

test("宿主校验资料有选图与示例指导，不要求 Agent 执行命令；复制失败明确反馈", () => {
  const root = mkdtempSync(join(tmpdir(), "archify-reference-test-"));
  try {
    const directory = join(root, "inputs");
    materializeArchifyReferences(directory, { hostValidation: true, required: true });
    const guide = readFileSync(join(directory, "README.md"), "utf8");
    assert.match(guide, /4\+1/); assert.match(guide, /cache-miss-request.sequence.json/);
    assert.match(guide, /平台执行实际渲染/); assert.doesNotMatch(guide, /node <本目录>/);
    const invalid = join(root, "not-directory"); writeFileSync(invalid, "file");
    assert.throws(() => materializeArchifyReferences(invalid, { required: true }), /参考资料准备失败/);
    assert.match(materializeArchifyReferences(invalid), /参考资料准备失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
