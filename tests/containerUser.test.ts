/**
 * 容器用户选取的语义契约。
 *
 * 这条在 macOS 上永远看不到真故障(Colima 在 VM 边界做 uid 映射),
 * 但内网就是 Linux:容器 uid 和服务账号对不上时,Agent 干完活、宿主
 * 接手 git add/commit 才 EACCES——炸在最贵的位置。所以判据必须按
 * platform 显式参数化,不能依赖当前跑测试的机器。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveContainerUser } from "../src/containerRuntime.ts";

test("显式配置永远优先,不被平台兜底改写", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const choice = resolveContainerUser({
      configured: "10001:10001", platform, uid: 501, gid: 20,
    });
    assert.equal(choice.user, "10001:10001");
    assert.match(choice.reason, /--isolate-user/);
  }
});

test("Linux 不配时兜到服务进程自己的 uid:gid,容器写出的文件宿主可写", () => {
  const choice = resolveContainerUser({ platform: "linux", uid: 1500, gid: 1500 });
  assert.equal(choice.user, "1500:1500");
  assert.match(choice.reason, /宿主可读写/);
});

test("macOS/Windows 不兜本机 uid:VM 里没这个用户,套上去反而起不来", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const choice = resolveContainerUser({ platform, uid: 501, gid: 20 });
    assert.equal(choice.user, undefined);
    assert.match(choice.reason, /镜像内置非 root 用户/);
  }
});

test("服务以 root 跑且没配用户时拒绝启动,不许把 root 兜进容器", () => {
  assert.throws(
    () => resolveContainerUser({ platform: "linux", uid: 0, gid: 0 }),
    /正以 root 运行/);
  assert.throws(
    () => resolveContainerUser({ platform: "linux", uid: 1000, gid: 0 }),
    /正以 root 运行/);
});

test("服务以 root 跑时显式用户必须是可供宿主 chown 的数字 uid:gid", () => {
  assert.equal(resolveContainerUser({
    configured: "10001:10001", platform: "linux", uid: 0, gid: 0,
  }).user, "10001:10001");
  for (const configured of ["builder:builder", "10001", "10001:0", "0:10001"]) {
    assert.throws(() => resolveContainerUser({
      configured, platform: "linux", uid: 0, gid: 0,
    }), /数字 uid:gid/);
  }
});

test("Linux 上取不到 uid 就直说,不静默沿用镜像默认", () => {
  assert.throws(
    () => resolveContainerUser({ platform: "linux" }),
    /取不到服务进程的 uid\/gid/);
});

test("空白 --isolate-user 视同未配置,按平台兜底而不是传个空串给 docker", () => {
  assert.equal(
    resolveContainerUser({ configured: "   ", platform: "linux", uid: 7, gid: 7 }).user,
    "7:7");
});
