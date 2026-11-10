/**
 * 数据目录独占锁的语义契约。
 *
 * 真正要防的事故写在这里:两个实例指同一个 --data 时,后起的会按
 * 实例指纹清掉先起那个正在跑的任务容器。所以"活着就必须拒绝"是硬
 * 判据,"崩溃后能接管"是可用性判据,两条都得有裁判。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireInstanceLock,
  INSTANCE_LOCK_FILE,
  InstanceLockedError,
} from "../src/instanceLock.ts";

function newDataDir(): string {
  return mkdtempSync(join(tmpdir(), "mae-flow-lock-"));
}

test("第一个实例拿到锁,锁文件记着 pid 与主机", () => {
  const dir = newDataDir();
  const lock = acquireInstanceLock(dir);
  const written = JSON.parse(
    readFileSync(join(dir, INSTANCE_LOCK_FILE), "utf-8"));
  assert.equal(written.pid, process.pid);
  assert.equal(written.nonce, lock.record.nonce);
  assert.ok(written.host);
  lock.release();
  assert.equal(existsSync(join(dir, INSTANCE_LOCK_FILE)), false);
});

test("持有者还活着时,第二个实例必须被拒——不能起来杀对方容器", () => {
  const dir = newDataDir();
  const first = acquireInstanceLock(dir);
  assert.throws(
    () => acquireInstanceLock(dir, { alive: () => true }),
    (error: unknown) => {
      assert.ok(error instanceof InstanceLockedError);
      assert.match(error.message, /已被本机另一个实例占用/);
      // 拒绝理由要说清后果,不能只说"被占用"。
      assert.match(error.message, /清掉.*正在跑的任务容器/);
      assert.equal(error.holder?.pid, process.pid);
      return true;
    },
  );
  first.release();
});

test("持有者已死时接管陈旧锁,锁文件换成新实例", () => {
  const dir = newDataDir();
  const crashed = acquireInstanceLock(dir);
  const messages: string[] = [];
  const taken = acquireInstanceLock(dir, {
    alive: () => false,
    log: (message) => messages.push(message),
  });
  assert.notEqual(taken.record.nonce, crashed.record.nonce);
  assert.equal(
    JSON.parse(readFileSync(join(dir, INSTANCE_LOCK_FILE), "utf-8")).nonce,
    taken.record.nonce);
  assert.match(messages.join("\n"), /遗留的锁/);
  taken.release();
});

test("锁文件被 kill -9 打断成半行 JSON,也当陈旧锁接管而不是卡死", () => {
  const dir = newDataDir();
  writeFileSync(join(dir, INSTANCE_LOCK_FILE), '{"pid":123,"ho');
  const taken = acquireInstanceLock(dir, { alive: () => true });
  assert.equal(taken.record.pid, process.pid);
  taken.release();
});

test("跨机共享数据目录直接拒绝:本机判不了对端 pid 死活,判不了就不许猜", () => {
  const dir = newDataDir();
  writeFileSync(join(dir, INSTANCE_LOCK_FILE), JSON.stringify({
    pid: 4242,
    host: "另一台内网机器",
    nonce: "n",
    startedAt: new Date().toISOString(),
  }));
  assert.throws(
    // alive 恒 false:即便"看起来死了",跨机也不许接管。
    () => acquireInstanceLock(dir, { alive: () => false }),
    (error: unknown) => {
      assert.ok(error instanceof InstanceLockedError);
      assert.match(error.message, /另一台机器/);
      assert.match(error.message, /不受支持/);
      return true;
    },
  );
});

test("release 只删自己的锁:被抢占过就撒手,不误删赢家的", () => {
  const dir = newDataDir();
  const crashed = acquireInstanceLock(dir);
  const winner = acquireInstanceLock(dir, { alive: () => false });
  crashed.release();
  assert.equal(
    JSON.parse(readFileSync(join(dir, INSTANCE_LOCK_FILE), "utf-8")).nonce,
    winner.record.nonce,
    "崩溃实例的迟到 release 不能把接管者的锁删掉");
  winner.release();
});

test("release 幂等,重复调用不炸", () => {
  const dir = newDataDir();
  const lock = acquireInstanceLock(dir);
  lock.release();
  lock.release();
  assert.equal(existsSync(join(dir, INSTANCE_LOCK_FILE)), false);
});
