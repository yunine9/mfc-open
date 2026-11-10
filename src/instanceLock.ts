/**
 * 数据目录独占锁:一个 dataDir 同一时刻只能有一个 Cloud 实例。
 *
 * 为什么必须有:实例身份就是 `sha256(realpath(dataDir))`,启动期
 * `sweepOrphanContainers()` 按这个指纹把"本实例的"容器 TERM→KILL→rm。
 * 两个进程指同一个 --data,后起的那个会把先起的**活容器全杀掉**
 * (正在跑的编译、prepush 一起没),而且两边还共写同一套 task.json。
 * 这不是资源浪费,是数据和执行现场同时被踩。
 *
 * Node 没有内建 flock,这里用"存在即持有 + pid 存活判定"的锁文件。
 * 抢占陈旧锁不走 unlink(会和并发抢占者互删),走 rename 覆盖后**回读
 * 验明是不是自己**——两个进程同时抢占时,后 rename 的赢,另一个回读
 * 发现不是自己就如实拒绝启动。宁可多拒一次,不能两个实例同时活着。
 */

import { hostname } from "node:os";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const INSTANCE_LOCK_FILE = "instance.lock";

export interface InstanceLockRecord {
  pid: number;
  host: string;
  nonce: string;
  startedAt: string;
}

export interface InstanceLock {
  path: string;
  record: InstanceLockRecord;
  /** 幂等;不是自己的锁绝不删(可能是抢占赢家的)。 */
  release(): void;
}

export interface InstanceLockOptions {
  /** 判定另一个 pid 是否还活着。默认 process.kill(pid, 0)。 */
  alive?: (pid: number) => boolean;
  log?: (message: string) => void;
}

export class InstanceLockedError extends Error {
  constructor(readonly holder: InstanceLockRecord | undefined, detail: string) {
    super(detail);
    this.name = "InstanceLockedError";
  }
}

/** ESRCH=进程不在;EPERM=在但不是本用户的,那也算活着,不能抢。 */
function defaultAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readRecord(path: string): InstanceLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as InstanceLockRecord;
    if (typeof parsed?.pid !== "number" || typeof parsed?.nonce !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    // 半行 JSON / 空文件 = 上次写锁时被 kill -9 打断。按陈旧处理。
    return undefined;
  }
}

function describe(record: InstanceLockRecord | undefined): string {
  if (!record) return "锁文件内容不可解析";
  return `pid=${record.pid} host=${record.host} 起于 ${record.startedAt}`;
}

/**
 * 取得 dataDir 的独占权。拿不到就抛 InstanceLockedError,由调用方
 * 拒绝启动——绝不"先跑起来再说",那会立刻杀掉在跑实例的容器。
 */
export function acquireInstanceLock(
  dataDir: string,
  options: InstanceLockOptions = {},
): InstanceLock {
  const alive = options.alive ?? defaultAlive;
  const path = join(dataDir, INSTANCE_LOCK_FILE);
  const record: InstanceLockRecord = {
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(record);

  const own = (): InstanceLock => ({
    path,
    record,
    release: () => {
      // 回读确认还是自己的锁。被别人抢占过就撒手,删掉等于帮倒忙。
      if (readRecord(path)?.nonce !== record.nonce) return;
      rmSync(path, { force: true });
    },
  });

  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    return own();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const holder = readRecord(path);
  if (holder && holder.host !== record.host) {
    // 跨机共享 dataDir(NFS 之类):本机判不了对端 pid 死活,判不了就
    // 不许猜。这个形态本身不受支持,如实说清而不是赌一把。
    throw new InstanceLockedError(holder,
      `数据目录被另一台机器的实例占用(${describe(holder)});`
      + "跨机共享同一个 --data 目录不受支持——实例身份、容器清扫和"
      + "任务状态都会互相踩。请给每台机器各自的数据目录。");
  }
  if (holder && alive(holder.pid)) {
    throw new InstanceLockedError(holder,
      `数据目录已被本机另一个实例占用(${describe(holder)})。`
      + "同一个 --data 目录不能起两个服务:后起的会按实例指纹清掉"
      + "先起那个正在跑的任务容器,两边还会共写同一套 task.json。"
      + `确认对方已停止后可删除 ${path} 重试。`);
  }

  // 陈旧锁:持有者已经不在了(崩溃/kill -9)。rename 是原子覆盖,
  // 不和并发抢占者互删;写完回读验明正身才算拿到。
  options.log?.(`发现上次实例遗留的锁(${describe(holder)}),接管`);
  const staging = `${path}.${process.pid}.${record.nonce.slice(0, 8)}`;
  writeFileSync(staging, payload, { mode: 0o600 });
  try {
    renameSync(staging, path);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  const settled = readRecord(path);
  if (settled?.nonce !== record.nonce) {
    throw new InstanceLockedError(settled,
      `接管陈旧锁时被另一个正在启动的实例抢先(${describe(settled)}),`
      + "本次启动放弃。两个实例同时抢同一个数据目录时只能有一个活下来,"
      + "请确认预期的那个已经起来。");
  }
  return own();
}
