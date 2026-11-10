import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { DomainKnowledgeExtraction, type DomainExecution } from "../src/domainKnowledgeExtraction.ts";

async function flush() { for (let index = 0; index < 20; index++) await setImmediate(); }

test("生产线验收2/14：关停记录 EIO 也取消研究与发布器，60秒结束等待，迟到研究不覆盖失败记录", { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-shutdown-recovery-"));
  let execution: DomainExecution | undefined, releaseExecution!: (reply: string) => void, releasePublisher!: () => void, shutdownCalls = 0;
  const manager = new DomainKnowledgeExtraction(dir, input => {
    execution = input;
    return new Promise<string>(resolve => { releaseExecution = resolve; });
  }, { shutdown: () => { shutdownCalls++; return new Promise<void>(resolve => { releasePublisher = resolve; }); } });
  let interception: ReturnType<typeof t.mock.method> | undefined, closing: Promise<void> | undefined;
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const job = manager.create({ title: "关停保存失败", issue_no: "REQ-SHUTDOWN", scope: "预算结束后明确失败", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }] }, "alice");
    await flush(); assert.ok(execution);
    const path = join(dir, "domain-extraction", job.id, "job.json"), rename = fs.renameSync;
    let failures = 0;
    interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === path && failures++ === 0) throw Object.assign(new Error("关停queued保存EIO"), { code: "EIO" });
      return rename(...args);
    }); syncBuiltinESMExports();
    let ended = false;
    closing = manager.shutdown().then(() => { ended = true; }, error => { assert.match(error.message, /保存失败/); ended = true; });
    await flush();
    assert.equal(execution!.signal.aborted, true); assert.equal(shutdownCalls, 1);
    t.mock.timers.tick(59_999); await flush(); assert.equal(ended, false);
    t.mock.timers.tick(1); await flush(); assert.equal(ended, true);
    assert.equal(manager.get(job.id).status, "failed"); assert.match(manager.get(job.id).error!, /停止超时/);
    assert.ok(manager.warnings().some(message => message.includes(`domain-extraction/${job.id}/job.json`) && message.includes("EIO")));
    const before = fs.readFileSync(path, "utf8");
    execution!.update({ stage: "迟到结果" }); releaseExecution("预算后才退出"); releasePublisher(); await flush();
    assert.equal(fs.readFileSync(path, "utf8"), before); assert.notEqual(manager.get(job.id).stage, "迟到结果");
  } finally {
    interception?.mock.restore(); syncBuiltinESMExports(); releaseExecution?.("结束测试"); releasePublisher?.();
    closing ??= manager.shutdown().catch(() => {}); t.mock.timers.tick(60_000); await flush(); await closing;
    t.mock.timers.reset(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
