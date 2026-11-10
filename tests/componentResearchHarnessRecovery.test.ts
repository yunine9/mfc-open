import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ComponentPipelineState } from "../src/componentResearchPipeline.ts";

interface Worker {
  process: ChildProcess;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}
interface HarnessEvent { run_id: string; pid: number; type: string; task_id?: string; session_id?: string; attempts?: number }
const workerFile = fileURLToPath(new URL("./fixtures/componentResearchHarnessWorker.ts", import.meta.url));
const read = <T>(directory: string, name: string): T => JSON.parse(readFileSync(join(directory, name), "utf8"));
const events = (directory: string): HarnessEvent[] => readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超过 12 秒预算`)), 12_000);
  })]); } finally { clearTimeout(timer); }
}
function launch(directory: string, runId: string, scenario: "interrupt" | "fail" | "complete"): Worker {
  const child = spawn(process.execPath, ["--import", "tsx", workerFile, directory, runId, scenario], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); };
  child.stdout!.on("data", collect); child.stderr!.on("data", collect);
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void completion.catch(() => {});
  return { process: child, completion, output: () => output };
}
async function marker(directory: string, worker: Worker) {
  const deadline = Date.now() + 12_000;
  while (!existsSync(join(directory, "ready-to-kill.json"))) {
    if (worker.process.exitCode !== null || worker.process.signalCode !== null) throw new Error(`强杀前子进程已退出：${worker.output()}`);
    if (Date.now() >= deadline) throw new Error(`等待强杀位置超过 12 秒预算：${worker.output()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function cleanup(workers: Worker[], directory: string) {
  try {
    for (const worker of workers) if (worker.process.exitCode === null && worker.process.signalCode === null) worker.process.kill("SIGKILL");
    const results = await Promise.allSettled(workers.map(worker => within(worker.completion, "回收模拟研究子进程")));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function assertPreserved(before: ComponentPipelineState, loaded: ComponentPipelineState) {
  assert.equal(loaded.tasks.length, before.tasks.length);
  for (const prior of before.tasks) {
    const current = loaded.tasks.find(task => task.id === prior.id)!;
    if (prior.status === "done") assert.deepEqual(current, prior, `已完成 ${prior.id} 的结果、次数与状态保持原样`);
    else if (["running", "failed"].includes(prior.status)) assert.deepEqual(current, { ...prior, status: "pending", attempts: 0 });
    else assert.deepEqual(current, prior);
  }
}
function assertRecovered(directory: string, before: ComponentPipelineState, firstRun: string) {
  const loaded = read<ComponentPipelineState>(directory, "resumed-loaded.json");
  assertPreserved(before, loaded);
  const result = read<{ status: string; state: ComponentPipelineState }>(directory, "resumed-result.json");
  assert.equal(result.status, "done");
  assert.ok(result.state.tasks.every(task => task.status === "done"));
  assert.equal(result.state.tasks.find(task => task.id === "synthesis")!.status, "done");
  const log = events(directory), authors = log.filter(event => event.type === "author-start");
  for (const task of before.tasks.filter(task => task.status === "done")) {
    assert.equal(authors.filter(event => event.task_id === task.id).length, 1, `不重新执行已通过的 ${task.id}`);
  }
  for (const task of before.tasks.filter(task => ["running", "failed"].includes(task.status))) {
    const resumed = authors.filter(event => event.run_id === "resumed" && event.task_id === task.id);
    assert.equal(resumed.length, 1, `${task.id} 在新进程中只执行一次`);
    assert.equal(resumed[0].attempts, 1);
  }
  const sessions = log.filter(event => ["author-start", "review-start"].includes(event.type));
  assert.equal(new Set(sessions.map(event => event.session_id)).size, sessions.length, "每个模拟作者和评审都有独立上下文编号");
  assert.notEqual(log.find(event => event.run_id === firstRun)!.pid, log.find(event => event.run_id === "resumed")!.pid, "恢复使用新的真实进程");
  for (const task of result.state.tasks) {
    assert.ok(log.some(event => event.type === "review-end" && event.task_id === task.id), `${task.id} 经独立模拟评审`);
  }
}

test("组件长程验收：三个任务在途时真实 SIGKILL，重启保留完成项并用新上下文接续到汇总", { timeout: 40_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "component-harness-kill-")), workers: Worker[] = [];
  try {
    const first = launch(directory, "interrupted", "interrupt"); workers.push(first);
    await marker(directory, first);
    const markerState = read<{ pid: number; state: ComponentPipelineState; maximum_running: number }>(directory, "ready-to-kill.json");
    assert.equal(markerState.pid, first.process.pid);
    assert.equal(markerState.maximum_running, 3);
    assert.equal(markerState.state.tasks.find(task => task.id === "paradigm-a-write")!.status, "done");
    assert.deepEqual(markerState.state.tasks.filter(task => task.status === "running").map(task => task.id).sort(), ["pitfalls-a", "plan-b", "plan-c"]);
    assert.equal(first.process.kill("SIGKILL"), true);
    assert.deepEqual(await within(first.completion, "等待强杀退出"), { code: null, signal: "SIGKILL" });
    const before = read<ComponentPipelineState>(directory, "state.json");
    assert.deepEqual(before, markerState.state, "强杀前后已提交的持久状态完整保留");
    const resumed = launch(directory, "resumed", "complete"); workers.push(resumed);
    assert.deepEqual(await within(resumed.completion, "恢复研究并汇总"), { code: 0, signal: null }, resumed.output());
    assertRecovered(directory, before, "interrupted");
  } finally { await cleanup(workers, directory); }
});

test("组件长程验收：模块三次评审失败时其它模块完成，新进程只重跑未完成项", { timeout: 40_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "component-harness-failure-")), workers: Worker[] = [];
  try {
    const first = launch(directory, "failed", "fail"); workers.push(first);
    assert.deepEqual(await within(first.completion, "等待失败模块和其它模块结束"), { code: 2, signal: null }, first.output());
    const report = read<{ status: string; error: string; state: ComponentPipelineState; maximum_running: number }>(directory, "failed-result.json");
    assert.equal(report.status, "incomplete");
    assert.match(report.error, /模块 b 需要补充用法依据/);
    assert.equal(report.maximum_running, 3);
    const before = read<ComponentPipelineState>(directory, "state.json"), failed = before.tasks.find(task => task.id === "plan-b")!;
    assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 3);
    for (const id of ["index-a", "index-c"]) assert.equal(before.tasks.find(task => task.id === id)!.status, "done");
    assert.equal(before.tasks.find(task => task.id === "synthesis")!.status, "pending");
    assert.equal(events(directory).filter(event => event.type === "author-start" && event.task_id === "plan-b").length, 3);
    const resumed = launch(directory, "resumed", "complete"); workers.push(resumed);
    assert.deepEqual(await within(resumed.completion, "恢复失败模块并汇总"), { code: 0, signal: null }, resumed.output());
    assertRecovered(directory, before, "failed");
    assert.equal(events(directory).filter(event => event.type === "author-start" && event.task_id === "plan-b").length, 4);
  } finally { await cleanup(workers, directory); }
});
