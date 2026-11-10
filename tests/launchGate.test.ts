import assert from "node:assert/strict";
import test from "node:test";
import { launchGateCopy } from "../web/src/launchGate.ts";

test("发起入口:服务端没有 blocker 才真正可用", () => {
  assert.deepEqual(launchGateCopy({ kind: "ready" }), {
    enabled: true,
    title: "发起新任务",
    ariaLabel: "发起新任务",
  });
});

test("发起入口:个人缺项引导到个人设置并保留完整原因", () => {
  const copy = launchGateCopy({
    kind: "blocked",
    blockers: [{
      key: "git_email",
      where: "me",
      label: "个人邮箱未配置（个人设置 → 个人接入）",
    }],
  });
  assert.equal(copy.enabled, false);
  assert.equal(copy.action, "profile");
  assert.equal(copy.helper, "完善个人设置后解锁");
  assert.match(copy.title, /个人邮箱未配置/);
});

test("发起入口:服务缺项不再错误归咎个人", () => {
  const copy = launchGateCopy({
    kind: "blocked",
    blockers: [{
      key: "model",
      where: "admin",
      label: "模型网关未配置（管理页 → 模型网关）",
    }],
  });
  assert.equal(copy.action, "retry");
  assert.equal(copy.helper, "服务配置未就绪 · 点击重试");
  assert.match(copy.ariaLabel, /服务配置/);
});

test("发起入口:混合缺项优先给开发可执行的个人动作", () => {
  const copy = launchGateCopy({
    kind: "blocked",
    blockers: [
      { key: "platform", where: "admin", label: "交付服务未就绪" },
      { key: "git_token", where: "me", label: "CodeHub Token 未配置" },
    ],
  });
  assert.equal(copy.action, "profile");
  assert.match(copy.title, /交付服务未就绪；CodeHub Token 未配置/);
});

test("发起入口:检查中和读取失败都不会误放行", () => {
  assert.equal(launchGateCopy({ kind: "checking" }).enabled, false);
  const failed = launchGateCopy({ kind: "error", detail: "网络中断" });
  assert.equal(failed.enabled, false);
  assert.equal(failed.action, "retry");
  assert.match(failed.title, /网络中断/);
});
