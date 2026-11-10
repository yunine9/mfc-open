/**
 * 问题会话容器的用户透传回归(2026-08-29 真实环境实测事故):
 * issueFlow 的 isolation.user 在 ensureContainer 构造 TaskContainer 时
 * 被漏掉,docker run 不带 --user,容器落回镜像默认用户——node 等默认
 * root 的镜像直接命中安全自检"Config.User 为空或为 root/0,拒绝运行"。
 * 无 docker 也跑:TaskContainer 的 run 参数组装必须含 --user(锁运行时)。
 * 端到端 docker 冒烟层已于 2026-09-17 测试精简专题删除(本地无 docker,
 * 恒 skip)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskContainer } from "../src/containerRuntime.ts";

test("任务容器 run 参数:user 随 limits 透传为 --user", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-user-arg-"));
  const container = new TaskContainer(
    "fixture/builder:test", workspace, "mfc-fixture-user-1",
    () => undefined, [],
    { memory: "512m", cpus: "1", pidsLimit: 128, user: "10001:10001" },
    { network: "bridge" },
  );
  // dockerArgs 是组装 docker run 参数的内部方法;测试以 as any 直取,
  // 锁的是"limits.user 必须出现在 --user 之后"这条透传契约。
  const args = (container as unknown as {
    runArgs: () => string[];
  }).runArgs();
  const at = args.indexOf("--user");
  assert.ok(at >= 0, "run 参数必须包含 --user");
  assert.equal(args[at + 1], "10001:10001", "--user 取 limits.user 原值");
});
