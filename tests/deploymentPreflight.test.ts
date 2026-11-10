import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeploymentRuntime } from "../src/deploymentPreflight.ts";

test("Linux 容器必须让服务成为 PID 1，避免重启留下脏现场", () => {
  const bad = checkDeploymentRuntime({
    platform: "linux", container: true, pid: 18,
  });
  assert.equal(bad.status, "error");
  assert.match(bad.detail, /不是 PID 1/);
  assert.match(bad.suggestion ?? "", /node --import tsx/);

  const good = checkDeploymentRuntime({
    platform: "linux", container: true, pid: 1,
  });
  assert.equal(good.status, "ok");
  assert.match(good.detail, /停止信号/);
});

test("Linux 宿主部署可用，非 Linux 开发环境只提醒不误拦", () => {
  assert.equal(checkDeploymentRuntime({
    platform: "linux", container: false, pid: 123,
  }).status, "ok");
  assert.equal(checkDeploymentRuntime({
    platform: "darwin", container: false, pid: 123,
  }).status, "warning");
});
