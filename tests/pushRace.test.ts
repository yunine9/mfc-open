import { test } from "node:test";
import assert from "node:assert/strict";
import { pushWithFreshBranch, rejectedByBranchAdvance, RemoteBranchAdvancedError, RemoteBranchBusyError } from "../src/pushRace.ts";

test("只有 Git 非快进拒绝触发重新同步，远端规则和网络错误不冒充并发推进", () => {
  for (const reason of ["fetch first", "non-fast-forward"]) {
    assert.equal(rejectedByBranchAdvance(`To remote\n!\tHEAD:refs/heads/task\t[rejected] (${reason})\nDone`), true);
  }
  for (const text of ["network timeout", "permission denied", "behind remote",
    "!\tHEAD:refs/heads/task\t[remote rejected] (pre-receive hook declined)",
    "remote: [rejected] (non-fast-forward)"]) assert.equal(rejectedByBranchAdvance(text), false);
});

test("权限/网络故障不自动重试；同步转为人工等待后也不继续发送", async () => {
  let refreshes = 0, sends = 0;
  await assert.rejects(pushWithFreshBranch(async () => { sends++; throw new Error("permission denied"); },
    async () => { refreshes++; return true; }), /permission denied/);
  assert.equal(sends, 1); assert.equal(refreshes, 0);
  const result = await pushWithFreshBranch(async () => { sends++; throw new RemoteBranchAdvancedError("advanced"); },
    async () => { refreshes++; return false; });
  assert.equal(result, undefined); assert.equal(sends, 2); assert.equal(refreshes, 1);
});

test("远端持续变化时只允许三次发送，不把无限重试交回 Agent", async () => {
  let sends = 0, refreshes = 0;
  await assert.rejects(pushWithFreshBranch(async () => { sends++; throw new RemoteBranchAdvancedError("advanced"); },
    async () => { refreshes++; return true; }), RemoteBranchBusyError);
  assert.equal(sends, 3); assert.equal(refreshes, 2);
});
