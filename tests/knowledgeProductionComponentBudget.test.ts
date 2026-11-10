import { componentGuideContent, componentGuideEvidence, componentGuideOverview, componentGuideSection } from "./fixtures/componentGuide.ts";
import { KnowledgeTaskCapacity } from "../src/knowledgeTaskCapacity.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentResearch, researchSourceRepositories, type ResearchExecution } from "../src/componentResearch.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { saveKnowledgeReviewNote, type KnowledgeReviewSources } from "../src/knowledgeReviewNotes.ts";

// 用两个名额构造拥塞，停止预算测试不依赖部署默认容量。
function withTwoSlots(...args: ConstructorParameters<typeof ComponentResearch>) {
  return new ComponentResearch(args[0], args[1], args[2], args[3], new KnowledgeTaskCapacity(2));
}

const timeoutReason = "停止超时：执行体 60 秒内未退出，已强制释放";
const config = { name: "文件组件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["cpp"] };
const section = (ids: string[]) => componentGuideSection("files", ids, { title: "文件处理", content: "文件处理约束。" });
/** 用不同参考来源范围构造独立研究，验证共享调度预算。 */
function componentIds(dataDir: string, count: number) {
  seedTechnologyStacks(dataDir, config.languages);
  return Array.from({ length: count }, (_, i) => saveComponentRepository(dataDir, { ...config, name: `文件组件 ${i}`, repository: `https://example.test/files-${i}.git` }, "alice").id);
}
function writeDocument(input: ResearchExecution) {
  const ids = researchSourceRepositories(input.record).map(component => component.id);
  for (const event of componentGuideEvidence("cpp", ids)) input.evidence(event);
  input.editDocument!({ action: "overview", overview: componentGuideOverview("文件处理组件的依赖关系。") });
  input.editDocument!({ action: "outline", entries: [{ id: "files", title: "文件处理", repository_ids: ids }] });
  input.editDocument!({ action: "section", section: section(ids) });
}
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

test("生产线验收2（F3）：组件执行体忽略 abort，60 秒释放槽位、记失败且不通知，原任务可继续且迟到结果不影响新一轮", { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-stop-budget-"));
  const ids = componentIds(dataDir, 4);
  const started: ResearchExecution[] = [], finish: Array<() => void> = [];
  const research = withTwoSlots(dataDir, async input => {
    started.push(input);
    writeDocument(input);
    await new Promise<void>(resolve => finish.push(resolve));
    input.update({ stage: "迟到执行体试图覆盖状态" });
    input.evidence({ tool: "late-result" });
    return "迟到的草稿";
  });
  try {
    const first = research.start({ language: "cpp", repository_ids: [ids[0]]}, "alice");
    const second = research.start({ language: "cpp", repository_ids: [ids[1]]}, "bob");
    await settle();
    const third = research.start({ language: "cpp", repository_ids: [ids[2]]}, "carol");
    assert.equal(started.length, 2);
    assert.equal(research.get(third.id).status, "queued");
    research.stop(first.id); research.stop(second.id);
    assert.ok(started.every(input => input.signal.aborted));
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(started.length, 2, "预算到期前仍等原执行体退出");
    t.mock.timers.tick(1);
    await settle();
    for (const id of [first.id, second.id]) {
      const failed = research.get(id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, timeoutReason);
    }
    assert.ok(started.some(input => input.record.id === third.id), "别人的排队研究获得释放的槽位");
    assert.equal(research.retry(first.id, "alice").id, first.id, "原研究可在保留已有草稿的基础上继续");
    await settle();
    assert.equal(started.filter(input => input.record.id === first.id).length, 2);
    const resumed = research.get(first.id);
    finish[0](); finish[1]();
    await settle();
    assert.deepEqual(research.get(first.id), resumed, "旧执行体迟到返回不能改状态、草稿或证据");
    assert.throws(() => research.review(first.id, { section_id: "files", mode: "discuss", message: "不要并发新一轮" }, "alice"), /本轮完成|停止后/,
      "旧执行体 finally 不能释放新执行体的槽位");
    const fourth = research.start({ language: "cpp", repository_ids: [ids[3]]}, "dave");
    await settle();
    assert.equal(research.get(fourth.id).status, "queued", "第三个研究和接续中的研究仍占两个有效槽位");
    assert.equal(started.length, 4);
  } finally {
    const stopping = research.shutdown();
    t.mock.timers.tick(60_000);
    for (const release of finish) release();
    await settle();
    await stopping;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("生产线验收2（F3）：组件服务关停同样只等待 60 秒，不响应 abort 的任务如实失败", { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-shutdown-budget-"));
  seedTechnologyStacks(dataDir, config.languages);
  saveComponentRepository(dataDir, config, "alice");
  let release = () => {}, returned = false;
  const research = withTwoSlots(dataDir, async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return "关停后的迟到草稿";
  });
  const job = research.start({ language: "cpp" }, "alice");
  await settle();
  const stopping = research.shutdown().then(() => { returned = true; });
  try {
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(returned, false);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(returned, true, "关停不能无限等待执行体");
    assert.equal(research.get(job.id).status, "failed");
    assert.equal(research.get(job.id).error, timeoutReason);
    const failed = research.get(job.id);
    release(); await settle();
    assert.deepEqual(research.get(job.id), failed, "关停预算后的结果丢弃");
  } finally {
    release(); await stopping;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("生产线验收2（F3）：组件执行体响应 abort 时保持已停止，预算后不误记失败", { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-stop-responsive-"));
  seedTechnologyStacks(dataDir, config.languages);
  saveComponentRepository(dataDir, config, "alice");
  const research = withTwoSlots(dataDir, async input => {
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return "已响应停止";
  });
  try {
    const job = research.start({ language: "cpp" }, "alice");
    await settle(); research.stop(job.id); await settle();
    t.mock.timers.tick(60_000); await settle();
    assert.equal(research.get(job.id).status, "cancelled");
    assert.equal(research.get(job.id).stage, "已停止");
    assert.equal(research.get(job.id).error, undefined);
  } finally {
    await research.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const action of ["edit", "restore"] as const) {
  test(`生产线验收14（F23）：组件研究进行中拒绝${action === "edit" ? "人工编辑" : "恢复历史版本"}，意见仍能保存且不改草稿`, { timeout: 3_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-running-edit-"));
    seedTechnologyStacks(dataDir, config.languages);
    saveComponentRepository(dataDir, config, "alice");
    let release = () => {};
    const research = withTwoSlots(dataDir, async input => {
      if (!input.review) { writeDocument(input); return "初稿已保存"; }
      await new Promise<void>(resolve => { release = resolve; });
      return "讨论结束";
    });
    try {
      const job = research.start({ language: "cpp" }, "alice");
      await settle();
      const original = research.get(job.id).document!.sections[0];
      research.editSection(job.id, { section: { ...original, content: componentGuideContent("人工保存的第二版") }, base_revision: original.revision }, "alice");
      research.review(job.id, { section_id: "files", mode: "discuss", message: "讨论当前版本" }, "alice");
      await settle();
      const before = research.get(job.id);
      const sources: KnowledgeReviewSources = { dataDir, component: research, domain: {
        get: () => { throw new Error("本例不能访问领域研究"); }, run: () => { throw new Error("本例不能启动领域研究"); },
      } };
      const notes = saveKnowledgeReviewNote(sources, "component", job.id, {
        document_id: "files", scope: "document", note: "研究结束后补充错误处理说明。",
      }, "bob");
      assert.equal(notes.notes[0].status, "open", "研究中仍能提意见");
      assert.throws(() => action === "edit"
        ? research.editSection(job.id, { section: { ...before.document!.sections[0], content: componentGuideContent("研究中人工改写") }, base_revision: before.document!.sections[0].revision }, "bob")
        : research.restoreSection(job.id, "files", original.revision, before.document!.sections[0].revision, "bob"),
      /研究进行中：请先停止，或等本轮结束后再改/);
      assert.deepEqual(research.get(job.id), before, "被拒绝的操作不改正文、版本或研究状态");
    } finally {
      release(); await research.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

for (const action of ["stop", "shutdown"] as const) {
  test(`生产线验收2/3：组件${action === "stop" ? "停止" : "关停"}首次记录EIO也立即取消执行并在60秒释放，不跳过其他研究`, { timeout: 3_000 }, async t => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-initial-stop-eio-"));
    const ids = componentIds(dataDir, 4);
    const started: ResearchExecution[] = [], releases: Array<() => void> = [];
    const research = withTwoSlots(dataDir, async input => {
      started.push(input);
      await new Promise<void>(resolve => releases.push(resolve));
      input.update({ stage: "迟到状态" }); input.evidence({ tool: "迟到证据" });
      return "迟到正文";
    });
    const rename = fs.renameSync;
    let injected = false, stopping: Promise<unknown> | undefined;
    try {
      const first = research.start({ language: "cpp", repository_ids: [ids[0]]}, "alice");
      const second = research.start({ language: "cpp", repository_ids: [ids[1]]}, "bob");
      await settle();
      fs.renameSync = ((from, to) => {
        if (!injected && String(to) === join(dataDir, "component-research", first.id, "record.json")) {
          injected = true; throw Object.assign(new Error("模拟首条停止记录EIO"), { code: "EIO" });
        }
        return rename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      if (action === "stop") { try { research.stop(first.id); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "EIO"); } }
      else stopping = research.shutdown().catch(error => error);
      assert.ok(injected);
      assert.ok(started[0].signal.aborted, "停止写盘失败也必须取消执行并安装预算");
      if (action === "shutdown") assert.ok(started[1].signal.aborted, "单条写盘失败不能跳过其他执行体");
      fs.renameSync = rename; syncBuiltinESMExports();
      t.mock.timers.tick(60_000); await settle();
      if (stopping) await stopping;
      assert.equal(research.get(first.id).status, "failed");
      assert.match(research.get(first.id).error!, /60 秒/);
      const failed = research.get(first.id);
      releases[0](); await settle();
      assert.deepEqual(research.get(first.id), failed, "迟到写入不覆盖失败事实");
      if (action === "stop") {
        research.start({ language: "cpp", repository_ids: [ids[2]]}, "carol");
        await settle(); assert.equal(started.length, 3, "预算释放后其他研究获得槽位");
      } else assert.equal(research.get(second.id).status, "failed");
      assert.ok(research.warnings().some(warning => warning.includes(`component-research/${first.id}/record.json`) && warning.includes("EIO")));
    } finally {
      fs.renameSync = rename; syncBuiltinESMExports();
      const shutdown = research.shutdown(); for (const release of releases) release();
      t.mock.timers.tick(60_000); await settle(); await shutdown;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

for (const action of ["stop", "shutdown"] as const) {
  test(`生产线验收2（F3）：组件${action === "stop" ? "停止" : "关停"}超时记录一次落盘 EIO，仍在60秒释放槽位并保留失败原因`, { timeout: 3_000 }, async t => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-timeout-eio-"));
    const ids = componentIds(dataDir, 4);
    const started: string[] = [], releases: Array<() => void> = [];
    const research = withTwoSlots(dataDir, async input => {
      started.push(input.record.id);
      await new Promise<void>(resolve => releases.push(resolve));
      return "迟到结果";
    });
    const first = research.start({ language: "cpp", repository_ids: [ids[0]]}, "alice");
    research.start({ language: "cpp", repository_ids: [ids[1]]}, "bob");
    await settle();
    const queued = research.start({ language: "cpp", repository_ids: [ids[2]]}, "carol");
    let returned = false;
    let closing: Promise<void> | undefined;
    if (action === "stop") research.stop(first.id);
    else closing = research.shutdown().then(() => { returned = true; });
    const path = join(dataDir, "component-research", first.id, "record.json");
    const before = fs.readFileSync(path, "utf8"), rename = fs.renameSync;
    let failures = 0;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === path && failures++ === 0) throw Object.assign(new Error("测试磁盘 EIO：超时状态未写成"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      t.mock.timers.tick(59_999); await settle();
      assert.equal(research.get(first.id).status, action === "stop" ? "cancelled" : "queued");
      assert.equal(returned, false);
      assert.doesNotThrow(() => t.mock.timers.tick(1), "写盘故障不能从预算回调冒泡并阻断释放");
      await settle();
      assert.equal(failures, 1);
      assert.equal(research.get(first.id).status, "failed");
      assert.match(research.get(first.id).error ?? "", /停止超时.*EIO/);
      assert.ok(research.warnings().some(warning => warning.includes(`component-research/${first.id}/record.json`) && warning.includes("EIO")));
      assert.equal(fs.readFileSync(path, "utf8"), before, "失败的原子提交没有损坏上一份权威记录");
      if (action === "stop") assert.ok(started.includes(queued.id), "写盘失败也释放槽位给其他人");
      else {
        assert.equal(returned, true, "关停在60秒返回");
        assert.ok(!started.includes(queued.id), "关停不启动排队工作");
      }
    } finally {
      interception.mock.restore(); syncBuiltinESMExports();
      closing ??= research.shutdown();
      for (const release of releases) release();
      await settle(); await closing;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
