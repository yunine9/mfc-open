/** 拆分子任务的材料合同：自己的任务书是执行入口；整体 Chain 与用户
 * 原始需求是参考。长原文不能再把任务书挤到上下文末尾。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

function repository(root: string): string {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"], {
    env: GIT_ENV,
  });
  return repo;
}

function kernel(root: string): string {
  const target = join(root, "kernel");
  mkdirSync(join(target, "scripts"), { recursive: true });
  mkdirSync(join(target, "hooks"), { recursive: true });
  mkdirSync(join(target, "flow"), { recursive: true });
  writeFileSync(join(target, "flow", "flow.json"), JSON.stringify({
    start: "config_confirm",
    steps: {
      config_confirm: { terminal: false },
      end: { terminal: true },
    },
  }));
  writeFileSync(join(target, "hooks", "dispatch.py"),
    "import sys\nsys.exit(0)\n");
  writeFileSync(join(target, "scripts", "mae-flow.py"), [
    "import json, os, sys",
    "command = sys.argv[1] if len(sys.argv) > 1 else ''",
    "if command == 'init':",
    "    with open('.mae-flow.json', 'w') as f:",
    "        json.dump({'current': 'config_confirm'}, f)",
    "if command == 'current':",
    "    print('CURRENT: 先确认当前单元配置')",
  ].join("\n"));
  return target;
}

async function until(probe: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test("子任务首屏先给任务书，内核入口指向任务书，原始长文档保持原样", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-delivery-unit-materials-"));
  const original = `# 原始需求\n\n${"很长的业务背景。".repeat(8_000)}\nORIGINAL_TAIL`;
  const unit = "# 当前单元任务书：订单接口\n\n只实现 src/api/ 下的订单接口。\n";
  const chain = "# 整体拆分方案\n\n订单页面依赖订单接口。\n";
  const model = new ScriptedModelServer([{ text: "已收到当前单元任务。" }]);
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot: kernel(dataDir) },
  });
  try {
    const child = service.create(original, {
      title: "订单接口交付",
      account: "alice",
      repo: repository(dataDir),
      ticket: "REQ-UNIT-1",
      baseline: "master",
      parentTaskId: "task-parent",
      internalRequirement: true,
      requirementDocumentName: "原始需求.md",
      deliveryScope: { name: "订单接口", paths: ["src/api/"] },
      deliveryUnitMaterials: { chain, unit },
    });
    await until(() => model.requests.length > 0, "子任务首轮提示词");

    assert.equal(service.get(child.id)?.requirement, original,
      "页面上的需求原文不能混入平台任务书");
    const state = (service as any).tasks.get(child.id);
    const cwd = String(state.cwd);
    assert.equal(readFileSync(join(cwd, ".mae-flow-unit.md"), "utf-8"), unit);
    assert.equal(readFileSync(join(cwd, ".mae-flow-chain.md"), "utf-8"), chain);
    assert.equal(readFileSync(join(cwd, ".mae-flow-requirement.md"), "utf-8"),
      original, "短文档或长文档都必须有独立原文文件");
    const order = JSON.parse(readFileSync(
      join(cwd, ".mae-flow-order.json"), "utf-8"));
    assert.equal(order["需求文档"], ".mae-flow-unit.md",
      "内核执行入口必须是当前单元任务书，不是整份 Chain");

    const opening = JSON.stringify(model.requests[0]);
    const entry = opening.indexOf("当前交付单元 · 必读顺序");
    const originalPreview = opening.indexOf("# 原始需求");
    assert.ok(entry >= 0 && originalPreview > entry,
      "任务书阅读顺序必须出现在长原文预览之前");
    assert.match(opening, /先完整读取 \.mae-flow-unit\.md/);
    assert.match(opening, /后两份是背景与约束参考，不得据此擅自扩大/);
    assert.doesNotMatch(opening, /ORIGINAL_TAIL/,
      "长需求保留在文件中分段读，不把全文塞进首轮上下文");
  } finally {
    await service.cancel(service.list()[0]?.id ?? "", "test").catch(() => undefined);
    await model.stop();
  }
});
