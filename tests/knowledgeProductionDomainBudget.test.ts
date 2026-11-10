import { KnowledgeTaskCapacity } from "../src/knowledgeTaskCapacity.ts";
// repros/r1 实测：停止后的执行体可能忽略 abort，状态不能代替并发槽位释放。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DomainKnowledgeExtraction, type DomainExecution } from "../src/domainKnowledgeExtraction.ts";

// 用两个名额构造拥塞，停止预算测试不依赖部署默认容量。
function withTwoSlots(dir: string, execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1]) {
  return new DomainKnowledgeExtraction(dir, execute, { capacity: new KnowledgeTaskCapacity(2) });
}

const config = (n: number) => ({ title: `订单${n}`, scope: "订单规则", issue_no: "REQ-1", repositories: [{ repository: `https://example.test/orders${n}.git`, branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } });
async function flush() { for (let i = 0; i < 4; i++) await setImmediate(); }

test("生产线验收2：领域执行体忽略abort，60秒释放槽位、记failed，旧完成不能释放新执行权", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "knowledge-stop-domain-"));
  const executions: Array<{ input: DomainExecution; release: (reply: string) => void }> = [];
  const service = withTwoSlots(dir, input => new Promise<string>(release => executions.push({ input, release })));
  try {
    const a = service.create(config(1), "alice"), b = service.create(config(2), "bob");
    await flush();
    const c = service.create(config(3), "carol");
    assert.equal(executions.length, 2);
    service.stop(a.id); service.stop(b.id);
    t.mock.timers.tick(59_999); await flush();
    assert.equal(service.get(c.id).status, "queued");
    t.mock.timers.tick(1); await flush();
    for (const id of [a.id, b.id]) {
      assert.equal(service.get(id).status, "failed");
      assert.match(service.get(id).error ?? "", /停止超时.*60 秒内未退出.*已强制释放/);
    }
    assert.equal(service.get(c.id).status, "running", "其他人的排队研究获得释放的槽位");
    service.resume(a.id, "alice"); await flush();
    assert.equal(executions.length, 4);
    const d = service.create(config(4), "dave");
    executions[0].input.update({ stage: "迟到的旧结果" });
    assert.notEqual(service.get(a.id).stage, "迟到的旧结果");
    executions[0].release("旧执行体终于返回"); await flush();
    assert.equal(service.get(d.id).status, "queued", "旧finally只能释放自己持有的执行权");
    assert.equal(service.get(a.id).status, "running");
  } finally {
    const closing = service.shutdown();
    for (const execution of executions) execution.release("测试结束");
    t.mock.timers.tick(60_000); await flush(); await closing;
    rmSync(dir, { recursive: true, force: true });
    t.mock.timers.reset();
  }
});

test("生产线验收2：领域shutdown对忽略abort的执行体也只有60秒预算", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "knowledge-shutdown-domain-"));
  let release!: (reply: string) => void;
  const service = withTwoSlots(dir, () => new Promise<string>(r => { release = r; }));
  try {
    const job = service.create(config(1), "alice"); await flush();
    let closed = false;
    const closing = service.shutdown().then(() => { closed = true; });
    t.mock.timers.tick(60_000); await flush();
    assert.equal(closed, true, "shutdown在预算用尽后返回");
    assert.equal(service.get(job.id).status, "failed");
    assert.match(service.get(job.id).error ?? "", /停止超时/);
    await closing;
  } finally {
    release?.("迟到的结束"); await flush();
    rmSync(dir, { recursive: true, force: true });
    t.mock.timers.reset();
  }
});

for (const action of ["stop", "shutdown"] as const) {
  test(`生产线验收2：领域${action === "stop" ? "停止" : "关停"}超时记录一次落盘 EIO，仍在60秒释放并如实说明保存失败`, { timeout: 3_000 }, async t => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dir = mkdtempSync(join(tmpdir(), "production-domain-timeout-eio-"));
    const started: string[] = [], releases: Array<() => void> = [];
    const service = withTwoSlots(dir, async input => {
      started.push(input.job.id);
      await new Promise<void>(resolve => releases.push(resolve));
      return "迟到结果";
    });
    const first = service.create(config(1), "alice"); service.create(config(2), "bob"); await flush();
    const queued = service.create(config(3), "carol");
    let returned = false, closing: Promise<void> | undefined;
    if (action === "stop") service.stop(first.id);
    else closing = service.shutdown().then(() => { returned = true; });
    const path = join(dir, "domain-extraction", first.id, "job.json"), before = fs.readFileSync(path, "utf8"), rename = fs.renameSync;
    let failures = 0;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === path && failures++ === 0) throw Object.assign(new Error("测试磁盘 EIO：超时状态未写成"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      t.mock.timers.tick(59_999); await flush();
      assert.equal(service.get(first.id).status, action === "stop" ? "cancelled" : "queued"); assert.equal(returned, false);
      assert.doesNotThrow(() => t.mock.timers.tick(1), "状态保存抛错不能冒泡或阻断预算收尾");
      await flush();
      assert.equal(failures, 1); assert.equal(service.get(first.id).status, "failed");
      assert.match(service.get(first.id).error ?? "", /停止超时.*60 秒内未退出.*已强制释放.*状态记录保存失败.*EIO/);
      assert.match(service.get(first.id).turns.at(-1)!.error ?? "", /状态记录保存失败.*EIO/);
      assert.ok(service.warnings().some(warning => warning.includes(`domain-extraction/${first.id}/job.json`) && warning.includes("EIO")));
      assert.equal(fs.readFileSync(path, "utf8"), before, "失败的原子提交保持上一份权威记录字节不变");
      if (action === "stop") assert.ok(started.includes(queued.id), "写盘失败也释放槽位给其他人");
      else { assert.equal(returned, true); assert.ok(!started.includes(queued.id), "关停不启动排队工作"); }
    } finally {
      interception.mock.restore(); syncBuiltinESMExports();
      closing ??= service.shutdown();
      for (const release of releases) release();
      t.mock.timers.tick(60_000); await flush(); await closing;
      rmSync(dir, { recursive: true, force: true }); t.mock.timers.reset();
    }
  });
}
