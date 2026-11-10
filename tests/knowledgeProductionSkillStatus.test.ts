import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { approveSkillSubmission, readSkillSubmissionPackage, rejectSkillSubmission, submitHostSkill, type SkillSubmissionRecord } from "../src/hostSkillLibrary.ts";
import { persistExtractionJob, type ExtractionJobRecord } from "../src/knowledgeExtraction.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const metadata = { nature: "engineering" as const, business_module_ids: [], repositories: [], technologies: ["cpp"] };
const draft = "---\nname: status-skill\ndescription: Check Skill production status.\n---\n\n# Skill 状态\n\nRead the selected package and explain the result.\n";
const files = [{ path: "SKILL.md", content_base64: Buffer.from(draft).toString("base64") }];
async function within<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}
function intent(dir: string, record: SkillSubmissionRecord): SkillSubmissionRecord {
  const next = { ...record, status: "approving" as const, decided_at: "2026-10-03T00:00:00Z", decided_by: "admin" };
  writeFileSync(join(dir, "skill-submissions", record.directory, record.id, "submission.json"), JSON.stringify(next));
  return next;
}
async function samples(dir: string) {
  seedTechnologyStacks(dir, ["cpp"]);
  const records: SkillSubmissionRecord[] = [];
  for (const status of ["pending", "approving", "approved", "rejected"] as const) {
    let record = await submitHostSkill(dir, `status-${status}`, files, "alice", metadata);
    if (status === "approving") record = intent(dir, record);
    if (status === "approved") { await approveSkillSubmission(dir, record.directory, record.id, "admin"); record = readSkillSubmissionPackage(dir, record.directory, record.id).record; }
    if (status === "rejected") record = await rejectSkillSubmission(dir, record.directory, record.id, "admin", "补充使用说明");
    records.push(record);
  }
  const jobs: ExtractionJobRecord[] = [
    { id: "ke-status-done", status: "done", repo: "https://example.test/reference.git", intent: "制作参考 Skill", operator: "alice", started_at: "2026-10-03T00:00:00Z", finished_at: "2026-10-03T00:01:00Z", draft, notes: "草稿已生成，等待审查。" },
    { id: "ke-status-failed", status: "failed", repo: "https://example.test/reference.git", intent: "失败的 Skill 制作", operator: "alice", started_at: "2026-10-03T00:00:00Z", finished_at: "2026-10-03T00:01:00Z", error: "参考仓鉴权失败，请检查个人 Git 凭据" },
  ];
  for (const job of jobs) persistExtractionJob(join(dir, "knowledge-extract", job.id), job);
  return { records, jobs };
}

test("生产线验收8/D5：Skill 真实磁盘详情、列表与制作详情 HTTP 使用任务中心同一生产状态，审批通过中不误报退回", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-http-status-"));
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service);
  try {
    // 审批意图在服务启动恢复扫描之后落盘，模拟当前进程正在安装的真实中间态。
    const { records, jobs } = await samples(dir);
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "Skill HTTP 启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    async function read(path: string) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, `${path} ${await response.clone().text()}`);
      return response.json() as Promise<any>;
    }
    const [center, list] = await Promise.all([read("/knowledge-tasks"), read("/skills/submissions")]);
    for (const record of records) {
      const id = `${record.directory}/${record.id}`, expected = projectKnowledgeProduction({ kind: "skill-submission", record });
      const pack = await read(`/skills/${record.directory}/submissions/${record.id}`);
      assert.deepEqual(pack.production, expected, "完整包详情必须附服务端唯一投影");
      assert.deepEqual(list.submissions.find((value: any) => value.id === record.id).production, expected, "生产列表不能重新猜状态");
      assert.deepEqual(center.tasks.find((row: any) => row.id === id).production, expected);
      assert.equal(expected.review.readonly, record.status !== "pending");
      assert.deepEqual(expected.research_actions.map(action => action.id), record.status === "pending" ? ["reject", "publish"] : record.status === "rejected" ? ["resubmit"] : []);
      if (record.status === "rejected") assert.equal(expected.next_action.label, "修改后重新提交", "B6/D9：退回后有出路，不是只能看");
      if (record.status === "approving") assert.equal(pack.production.status_label, "审核通过中");
    }
    for (const job of jobs) {
      const detail = await read(`/knowledge/skill-extract/${job.id}`), expected = projectKnowledgeProduction({ kind: "skill-extraction", record: job });
      assert.deepEqual(detail.production, expected);
      assert.deepEqual(center.tasks.find((row: any) => row.id === job.id).production, expected);
      assert.deepEqual(expected.research_actions.map(action => action.id), job.status === "done" ? ["review"] : []);
      if (job.status === "failed") assert.equal(expected.next_action.id, "progress", "Skill 制作没有接续入口，失败下一步必须能查看原因");
      if (job.status === "done") assert.equal(expected.status_label, "待提交", "B6/D9：制作 Skill 的草稿由发起人编辑提交，不在这里再叫待审查");
    }
  } finally {
    await within(service.shutdown(), 5_000, "Skill 状态服务关停超过5秒预算");
    if (server.listening) await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "Skill HTTP 关停超过5秒预算");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收8/D5：Skill 提交、批准与退回的 HTTP 写入响应即时返回对应只读生产状态", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-http-write-status-"));
  seedTechnologyStacks(dir, ["cpp"]);
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service);
  try {
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "Skill HTTP 启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    async function post(path: string, body: unknown = {}) {
      const response = await fetch(base + path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, `${path} ${await response.clone().text()}`);
      return response.json() as Promise<any>;
    }
    for (const decision of ["approve", "reject"] as const) {
      const directory = `write-${decision}`;
      const submitted = await post(`/skills/${directory}/submissions`, { files, ...metadata });
      const pending = readSkillSubmissionPackage(dir, directory, submitted.id).record;
      assert.deepEqual(submitted.production, projectKnowledgeProduction({ kind: "skill-submission", record: pending }));
      const decided = await post(`/skills/${directory}/submissions/${submitted.id}/${decision}`, { reason: "补充使用说明" });
      const record = readSkillSubmissionPackage(dir, directory, submitted.id).record;
      assert.equal(record.status, decision === "approve" ? "approved" : "rejected");
      assert.deepEqual(decided.production, projectKnowledgeProduction({ kind: "skill-submission", record }));
    }
  } finally {
    await within(service.shutdown(), 5_000, "Skill 状态服务关停超过5秒预算");
    if (server.listening) await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "Skill HTTP 关停超过5秒预算");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收8/D5：1366桌面 Skill 唯一任务页渲染后端状态与动作，审批中只读且发布点击到达真实裁决入口", { timeout: 40_000, skip: !existsSync(chrome) ? "本机没有桌面验收 Chrome" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-browser-status-"));
  try {
    const { records, jobs } = await samples(dir);
    const pending = records.find(record => record.status === "pending")!;
    const submissions = records.map(record => ({ ...readSkillSubmissionPackage(dir, record.directory, record.id), production: projectKnowledgeProduction({ kind: "skill-submission", record }) }));
    await approveSkillSubmission(dir, pending.directory, pending.id, "admin");
    const pendingApprovedPackage = readSkillSubmissionPackage(dir, pending.directory, pending.id);
    const fixture = { submissions, pendingApproved: { ...pendingApprovedPackage, production: projectKnowledgeProduction({ kind: "skill-submission", record: pendingApprovedPackage.record }) },
      jobs: jobs.map(record => ({ ...record, production: projectKnowledgeProduction({ kind: "skill-extraction", record }) })) };
    const bundled = await within(build({ entryPoints: [resolve("tests/browser/knowledgeProductionSkillStatus.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } }), 5_000, "Skill 浏览器夹具构建超过5秒预算");
    const html = join(dir, "check.html"), output = join(dir, "dom.html");
    const json = JSON.stringify(fixture).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
    const assets = resolve("web/dist/assets");
    const css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app" style="padding:24px"></div><pre id="result"></pre><script id="fixture" type="application/json">' + json + '</script><script>' + bundled.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    const fd = openSync(output, "w");
    let pid: number | undefined, closePromise: Promise<void> | undefined;
    try {
      const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--force-device-scale-factor=1", `--user-data-dir=${join(dir, "profile")}`, "--window-size=1366,768", "--virtual-time-budget=6000", "--dump-dom", `file://${html}`], { detached: true, stdio: ["ignore", fd, "ignore"] });
      pid = child.pid;
      let childError: Error | undefined;
      child.once("error", error => { childError = error; });
      closePromise = new Promise(resolve => { child.once("close", () => resolve()); });
      await within(Promise.race([closePromise, (async () => {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          if (/<pre id="result">[^<]+<\/pre>/.test(readFileSync(output, "utf8"))) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error("Skill 桌面浏览器未在25秒内输出结果");
      })()]), 25_000, "Skill 桌面浏览器超过25秒执行预算");
      if (childError) throw childError;
    } finally {
      try {
        if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      } finally {
        try { if (closePromise) await within(closePromise, 5_000, "Skill 桌面浏览器终止超过5秒退出预算"); }
        finally { closeSync(fd); }
      }
    }
    const result = readFileSync(output, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "Skill 桌面浏览器未在预算内完成验收");
    const value = JSON.parse(result);
    assert.equal(value.error, undefined, value.error); assert.equal(value.passed, true); assert.equal(value.width, 1366);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("B6/D9：制作 Skill 提交审查后任务即结束，任务中心只剩提交那一条待审查", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-made-once-"));
  seedTechnologyStacks(dir, ["cpp"]);
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service);
  try {
    const job: ExtractionJobRecord = { id: "ke-made-once", status: "done", repo: "https://example.test/reference.git", intent: "制作参考 Skill",
      operator: "alice", started_at: "2026-10-05T00:00:00Z", finished_at: "2026-10-05T00:01:00Z", draft };
    persistExtractionJob(join(dir, "knowledge-extract", job.id), job);
    const submission = await submitHostSkill(dir, "made-once", files, "alice", metadata);
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "Skill HTTP 启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    const bad = await post(`/knowledge/skill-extract/${job.id}/submitted`, { submission_id: "made-once/not-there" });
    assert.equal(bad.status, 400, "提交号必须指向真实提交");
    const marked = await post(`/knowledge/skill-extract/${job.id}/submitted`, { submission_id: `made-once/${submission.id}` });
    assert.equal(marked.status, 200, await marked.clone().text());
    const detail = await marked.json() as any;
    assert.equal(detail.production.status_label, "已提交审查");
    assert.equal(detail.production.group, "completed");
    assert.match(detail.production.next_action.href, new RegExp(`kbKind=skill-submission&kbTask=made-once%2F${submission.id}`));
    assert.deepEqual(detail.production.research_actions, [], "已提交后不再给编辑并提交");
    const center = await (await fetch(`${base}/knowledge-tasks`, { signal: AbortSignal.timeout(5_000) })).json() as any;
    const attention = center.tasks.filter((row: any) => row.production.group === "attention").map((row: any) => row.id);
    assert.deepEqual(attention, [`made-once/${submission.id}`], "同一个 Skill 在任务中心只有一条等人处理");
    const missing = await post("/knowledge/skill-extract/ke-nope/submitted", { submission_id: `made-once/${submission.id}` });
    assert.equal(missing.status, 404);
  } finally {
    await within(service.shutdown(), 5_000, "Skill 状态服务关停超过5秒预算");
    if (server.listening) await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "Skill HTTP 关停超过5秒预算");
    rmSync(dir, { recursive: true, force: true });
  }
});
