import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

function kernelAt(path: string): string {
  mkdirSync(join(path, "hooks"), { recursive: true });
  writeFileSync(join(path, "hooks", "dispatch.py"), "# marker\n");
  return path;
}

test("默认优先使用随 Cloud 发布的内核，兄弟活内核只作兜底", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-kernel-discovery-"));
  const cloud = join(root, "mae-flow-cloud");
  const bundled = kernelAt(join(cloud, "kernel"));
  kernelAt(join(root, "mae-flow"));

  assert.equal(discoverKernelRoot(cloud), bundled);
});

test("显式 MAE_FLOW_HOME 仍可选择联调中的活内核", () => {
  const previous = process.env.MAE_FLOW_HOME;
  const explicit = join(tmpdir(), "mfc-explicit-kernel-does-not-need-probe");
  process.env.MAE_FLOW_HOME = explicit;
  try {
    assert.equal(discoverKernelRoot("/unused/cloud"), explicit);
  } finally {
    if (previous === undefined) delete process.env.MAE_FLOW_HOME;
    else process.env.MAE_FLOW_HOME = previous;
  }
});

test("正式模式缺少内核必须报错，不能启动后让代码仓入口消失", () => {
  const previous = process.env.MAE_FLOW_HOME;
  delete process.env.MAE_FLOW_HOME;
  try {
    const root = mkdtempSync(join(tmpdir(), "mfc-kernel-required-"));
    const cloud = join(root, "cloud");
    assert.equal(discoverKernelRoot(cloud), undefined, "演示模式仍可不加载内核");
    assert.throws(() => discoverKernelRoot(cloud, true), /拒绝降级为演示模式/);
    const bundled = kernelAt(join(cloud, "kernel"));
    assert.equal(discoverKernelRoot(cloud, true), bundled);
  } finally {
    if (previous === undefined) delete process.env.MAE_FLOW_HOME;
    else process.env.MAE_FLOW_HOME = previous;
  }
});
