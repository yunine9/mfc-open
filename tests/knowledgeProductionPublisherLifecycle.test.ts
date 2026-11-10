import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { runGitProcess } from "../src/hostGitSandbox.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    const status = `/proc/${pid}/status`;
    return !existsSync(status) || !/^State:\s+Z/m.test(readFileSync(status, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
const credentials = { username: "fixture", password: "fixture-password", email: "fixture@example.test" };
function publisher(dir: string) {
  return new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => "http://127.0.0.1:1", credential: () => credentials });
}
interface GitMarker { pid: number; child: number; cwd: string; helper?: string }
function fixture(block: "push" | "fetch") {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-publisher-lifecycle-"));
  const source = join(dir, "source"), remote = join(dir, "remote.git"), bin = join(dir, "bin"), marker = join(dir, "git-marker.json"), heartbeat = join(dir, "heartbeat");
  const originalPath = process.env.PATH;
  const realGit = (originalPath ?? "").split(delimiter).map(path => join(path, "git")).find(path => existsSync(path));
  assert.ok(realGit, "本地 Git 不可用");
  mkdirSync(source); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync(realGit, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  git("-C", source, "init", "-b", "main");
  writeFileSync(join(source, "code.ts"), "原有源码\n");
  git("-C", source, "add", ".");
  git("-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  git("clone", "--bare", source, remote);
  const script = join(bin, "git");
  // 真 Git 完成组装提交；仅将传输挂住，并用同组子进程持续写入来验证没有孤儿操作。
  writeFileSync(script, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes(${JSON.stringify(block)})) {
  const child=cp.spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),20);`)}],{stdio:'ignore'});
  const helper=args.find(arg=>arg.startsWith('credential.helper=')&&arg!=='credential.helper=')?.slice('credential.helper='.length);
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,child:child.pid,cwd:process.cwd(),helper}));
  setInterval(()=>{},1000);
} else { const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1); }
`, { mode: 0o700 });
  chmodSync(script, 0o700);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  const target = { id: "domain", name: "知识仓", repository: remote, branch: "main", path: "", docs_path: "domains" };
  const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title: "领域规则", scope: "订单", issue_no: "REQ-1", issue_description: "领域知识归档", operator: "alice", created_at: "2026-10-02T00:00:00Z", status: "done", stage: "待审查", knowledge_target: target, repositories: [], material_ids: [], revisions: {}, turns: [], evidence: [], publications: [],
    documents: [{ id: "orders", title: "订单规则", path: "domains/orders.md", target_id: "domain", layer: "domain", content: "# 订单\n规则正文", sources: "固定版本源码", revision: 1, selected: true, base_content: null, base_revision: "", history: [] }] };
  const formal = saveKnowledgeDocument(dir, { title: job.title, content: job.documents[0].content, scope: "platform" }, "alice");
  Object.assign(job.documents[0], { knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 });
  return {
    dir, remote, marker, heartbeat, job, target,
    info: () => JSON.parse(readFileSync(marker, "utf8")) as GitMarker,
    cleanup: async (work?: Promise<unknown>) => {
      if (existsSync(marker)) {
        const info = JSON.parse(readFileSync(marker, "utf8")) as GitMarker;
        try { process.kill(-info.pid, "SIGKILL"); } catch { /* 已由被测接口终止。 */ }
        try { process.kill(info.child, "SIGKILL"); } catch { /* 已由进程组终止。 */ }
      }
      if (work) await within(work.catch(() => undefined), 3000, "测试清理期间 Git 未退出");
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("生产线验收14/F26：启动清扫知识归档旧仓与凭据，保留问题流和需求流共享 Git 现场", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-publisher-sweep-"));
  try {
    const stale = join(dir, "knowledge-publication-tmp", "publish-stale"), shared = ["host-git", "issue-git"].map(lane => join(dir, ".runtime", lane, "operation-live", "credential"));
    const staleCredential = join(stale, ".runtime", "host-git", "operation-stale", "credential");
    for (const path of [staleCredential, ...shared]) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "不得留在磁盘的临时凭据"); }
    publisher(dir);
    assert.equal(existsSync(stale), false, "启动须清掉硬崩溃遗留的归档现场及内部凭据");
    for (const path of shared) assert.equal(readFileSync(path, "utf8"), "不得留在磁盘的临时凭据", "共享 Git 目录不属于知识归档清扫范围");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14/F26：可选 abort 信号在预算内结束整个 Git 进程组", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = fixture("push"), controller = new AbortController();
  const work = runGitProcess(["push"], { cwd: f.dir, env: process.env, timeoutMs: 90000, signal: controller.signal });
  try {
    await until(() => existsSync(f.marker) && existsSync(f.heartbeat), "Git 传输及子进程未启动");
    const info = f.info();
    controller.abort();
    const result = await within(work, 1500, "abort 后 Git 未在预算内退出");
    assert.equal(result.status, null); assert.equal(result.timedOut, false);
    await until(() => !running(info.pid) && !running(info.child), "Git 或同组子进程仍在运行");
  } finally { await f.cleanup(work); }
});

test("生产线验收14/F26：已取消的 Git 调用不启动传输进程", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = fixture("push");
  const work = runGitProcess(["push"], { cwd: f.dir, env: process.env, timeoutMs: 90000, signal: AbortSignal.abort() });
  try {
    const result = await within(work, 1500, "已取消的调用仍启动了 Git");
    assert.equal(result.status, null);
    assert.equal(existsSync(f.marker), false, "已取消的调用不得开始新的远端操作");
  } finally { await f.cleanup(work); }
});

test("生产线验收14/F26：关停终止归档 push 与子进程，凭据和仓库一起清理", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const f = fixture("push"), service = publisher(f.dir);
  const work = service.publish(f.job, f.target, undefined, "alice", () => {});
  void work.catch(() => undefined);
  try {
    await until(() => existsSync(f.marker) && existsSync(f.heartbeat), "归档 push 未启动");
    const info = f.info(), root = realpathSync(join(f.dir, "knowledge-publication-tmp"));
    assert.ok(info.helper?.startsWith(`${root}/`), "知识归档凭据必须在专用临时现场内");
    assert.ok(info.cwd.startsWith(`${root}/`));
    const shutdown = service.shutdown();
    await within(shutdown, 1500, "发布器关停未在预算内结束");
    await assert.rejects(within(work, 1500, "关停后归档仍未结束"), /Git 操作失败|停止|关闭|关停/);
    await until(() => !running(info.pid) && !running(info.child), "关停留下了孤儿 push");
    const last = readFileSync(f.heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readFileSync(f.heartbeat, "utf8"), last, "关停后子进程不得继续写入");
    assert.deepEqual(readdirSync(root), [], "关停后临时仓和其中的凭据均应清空");
    assert.equal(existsSync(join(f.dir, ".runtime", "host-git")), false, "不得把知识归档凭据放回共享目录");
    await assert.rejects(service.publish(f.job, f.target, undefined, "alice", () => {}), /停止|关闭|关停/);
  } finally { await f.cleanup(work); }
});

test("生产线验收14：Git 外部命令 90 秒预算在 89,999 毫秒保持运行，90,000 毫秒杀整个进程组", {
  skip: process.platform === "win32" ? "当前系统不支持 POSIX 进程组，不能验证整组 SIGKILL" : false,
  timeout: 20_000,
}, async t => {
  const f = fixture("push"), controller = new AbortController();
  // 模拟时间只推进被测 Git 预算；等待真实进程准备和退出仍有实际的 5 秒预算。
  const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
  const pause = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms));
  async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = realSetTimeout(() => reject(new Error(message)), 5000); })]);
    } finally { if (timer) realClearTimeout(timer); }
  }
  async function ready(check: () => boolean, message: string) {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error(message);
      await pause(15);
    }
  }
  let work: ReturnType<typeof runGitProcess> | undefined;
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    work = runGitProcess(["push"], { cwd: f.dir, env: process.env, timeoutMs: 90_000, signal: controller.signal });
    let settled = false;
    void work.then(() => { settled = true; }, () => { settled = true; });
    await ready(() => existsSync(f.marker) && existsSync(f.heartbeat), "假 Git 及同组子进程未在5秒内准备好");
    const info = f.info();

    t.mock.timers.tick(89_999);
    await pause(20);
    assert.equal(settled, false, "90秒预算未用完时不得提前结束");
    assert.equal(running(info.pid), true); assert.equal(running(info.child), true);

    t.mock.timers.tick(1);
    const result = await bounded(work, "90秒预算用完后 Git 未在5秒内退出");
    assert.equal(result.timedOut, true); assert.equal(result.status, null); assert.equal(result.signal, "SIGKILL");
    await ready(() => !running(info.pid) && !running(info.child), "超时终止后仍有同组 Git 子进程运行");
    const last = readFileSync(f.heartbeat, "utf8");
    await pause(40);
    assert.equal(readFileSync(f.heartbeat, "utf8"), last, "预算用完后不能留下继续写入的孤儿操作");
  } finally {
    t.mock.timers.reset();
    controller.abort();
    await bounded(f.cleanup(work), "Git 预算测试未在5秒内完成清理");
  }
});
