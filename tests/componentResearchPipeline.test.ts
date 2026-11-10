import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentResearchPipeline, type ComponentWork, type ComponentWorkResult } from "../src/componentResearchPipeline.ts";
const result = (t: ComponentWork): ComponentWorkResult => ({ findings: "读取代码与实际调用后的结论", open_questions: [],
  ...(t.phase === "inventory" ? { components: [{ id: "pool", title: "异步任务", repository_ids: ["base"], scope: "src/pool.cpp" }] } : {}),
  ...(t.phase === "plan" ? { paradigms: [{ id: "submit", title: "提交任务", need: "后台执行" }] } : {}) });
test("持久任务：评审失败最多三次，接续保留完成项；不丢失范式、不混用方法版本", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-pipeline-")), file = join(dir, "state.json"); const counts = new Map<string, number>();
  try {
    const execute = async (t: ComponentWork) => { counts.set(t.id, (counts.get(t.id) ?? 0) + 1); return result(t); };
    const first = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await assert.rejects(first.run({ signal: new AbortController().signal, execute, review: async t => t.phase === "paradigm" ? "来源不支持示例" : undefined, changed() {} }), /来源不支持/);
    assert.equal(counts.get("paradigm-pool-submit"), 3); assert.equal(counts.get("contracts-pool"), 1);
    const next = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await next.run({ signal: new AbortController().signal, execute, review: async () => undefined, changed() {} });
    assert.equal(counts.get("contracts-pool"), 1); assert.equal(counts.get("paradigm-pool-submit"), 4);
    assert.ok(next.state.tasks.every(t => t.status === "done")); assert.equal(next.state.tasks.length, 7);
    assert.throws(() => new ComponentResearchPipeline(file, "skill2", ["base"]), /方法版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("评审中断接续已落盘作者结果，只有明确退回才重新研究", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-review-resume-")), file = join(dir, "state.json");
  const counts = new Map<string, number>();
  const execute = async (t: ComponentWork) => { counts.set(t.id, (counts.get(t.id) ?? 0) + 1); return result(t); };
  try {
    const initial = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await assert.rejects(initial.run({ signal: new AbortController().signal, execute,
      review: async t => { if (t.phase === "paradigm") throw new Error("评审连接中断"); return undefined; }, changed() {} }), /评审连接中断/);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(counts.get("paradigm-pool-submit"), 1);
    assert.ok(persisted.tasks.find((t: ComponentWork) => t.phase === "paradigm").result);
    const completed = persisted.tasks.filter((t: ComponentWork) => t.status === "done");
    const resumed = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await resumed.run({ signal: new AbortController().signal, execute,
      review: async t => t.phase === "paradigm" && t.attempts === 1 ? "需修正示例" : undefined, changed() {} });
    assert.equal(counts.get("paradigm-pool-submit"), 2, "保存的结果先接续评审，明确退回后仅重做本项");
    assert.deepEqual(resumed.state.tasks.filter(t => completed.some((c: ComponentWork) => c.id === t.id)), completed);
    assert.ok(resumed.state.tasks.every(t => t.status === "done"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("旧单方法状态只迁移对应固定萃取包，完成项不重跑且陌生版本仍拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-method-upgrade-")), file = join(dir, "state.json");
  try {
    const original = new ComponentResearchPipeline(file, "pinned-extraction", ["base"]);
    await assert.rejects(original.run({ signal: new AbortController().signal, execute: async t => result(t),
      review: async t => t.phase === "paradigm" ? "未完成用法" : undefined, changed() {} }), /未完成用法/);
    const completed = JSON.parse(readFileSync(file, "utf8")).tasks.filter((t: ComponentWork) => t.status === "done") as ComponentWork[];
    const loaded = new ComponentResearchPipeline(file, "analysis-plus-pinned-extraction", ["base"], "pinned-extraction");
    assert.deepEqual(loaded.state.tasks.filter(t => t.status === "done"), completed);
    assert.equal(loaded.state.skill, "analysis-plus-pinned-extraction");
    const executed: string[] = [];
    await loaded.run({ signal: new AbortController().signal, execute: async t => { executed.push(t.id); return result(t); },
      review: async () => undefined, changed() {} });
    assert.ok(completed.every(t => !executed.includes(t.id)));
    assert.ok(loaded.state.tasks.every(t => t.status === "done"));
    assert.throws(() => new ComponentResearchPipeline(file, "another-pair", ["base"], "pinned-extraction"), /方法版本/);
    writeFileSync(file, JSON.stringify({ ...loaded.state, skill: "unknown-extraction" }));
    assert.throws(() => new ComponentResearchPipeline(file, "analysis-plus-pinned-extraction", ["base"], "pinned-extraction"), /方法版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const modules = (...ids: string[]) => ids.map(id => ({ id, title: id, repository_ids: ["base"], scope: `src/${id}.cpp` }));
const withPipeline = async (body: (pipeline: ComponentResearchPipeline, file: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "component-pipeline-")), file = join(dir, "state.json");
  try { await body(new ComponentResearchPipeline(file, "skill1", ["base"]), file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

test("两个来源仓盘点三个功能组件，P2P 跨仓，按能力独立规划而不是逐仓建组件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "component-capability-boundaries-"));
  const sourceIds = ["reference-a", "reference-b"];
  const capabilities = [
    { id: "file-operations", title: "文件操作", repository_ids: [sourceIds[0]], scope: "读取、写入和关闭文件；reference-a:src/files.cpp" },
    { id: "database-operations", title: "数据库操作", repository_ids: [sourceIds[0]], scope: "连接、查询和事务；reference-a:src/database.cpp" },
    { id: "p2p", title: "P2P 通信", repository_ids: sourceIds, scope: "发现节点并收发数据；reference-a:src/peer.cpp、reference-b:src/transport.cpp" },
  ];
  const pipeline = new ComponentResearchPipeline(join(directory, "state.json"), "capability-analysis", sourceIds);
  const executed: ComponentWork[] = [];
  const plans = deferred();
  let startedPlans = 0;
  try {
    await pipeline.run({ signal: new AbortController().signal,
      execute: async task => {
        executed.push(task);
        if (task.phase === "inventory") return { findings: "文件和数据库能力共用来源仓，P2P 的门面与传输实现跨仓协作。", open_questions: [], components: capabilities };
        if (task.phase === "plan") {
          if (++startedPlans === capabilities.length) plans.resolve();
          await plans.promise;
        }
        return { findings: `已核对 ${task.title} 的源码、调用与测试`, open_questions: [],
          ...(task.phase === "plan" ? { paradigms: [{ id: "use", title: `${task.title}完整用法`, need: `完成${task.title}` }] } : {}) };
      }, review: async () => undefined, changed() {},
    });
    assert.equal(executed.filter(task => task.phase === "inventory").length, 1);
    assert.deepEqual(executed.filter(task => task.phase === "plan").map(task => task.component), capabilities.map(component => component.id));
    assert.ok(executed.filter(task => task.component).every(task => !sourceIds.includes(task.component!)));
    for (const capability of capabilities) {
      assert.deepEqual(JSON.parse(pipeline.state.tasks.find(task => task.id === `plan-${capability.id}`)!.spec), capability);
      const usage = pipeline.state.tasks.find(task => task.id === `paradigm-${capability.id}-use`)!;
      assert.deepEqual(JSON.parse(usage.spec).module.repository_ids, capability.repository_ids);
    }
    assert.deepEqual(pipeline.state.tasks.find(task => task.id === "synthesis")!.dependencies, capabilities.map(component => `index-${component.id}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("默认三个独立模块并行，评审占用并发位置且通过后才释放后续任务", async () => {
  await withPipeline(async pipeline => {
    const firstThreeStarted = deferred(), fourthStarted = deferred(), firstReviewStarted = deferred();
    const authors = new Map(["a", "b", "c", "d"].map(id => [id, deferred()]));
    const firstReview = deferred();
    const started: string[] = [], reviewed: string[] = [];
    let maxRunning = 0;
    const run = pipeline.run({ signal: new AbortController().signal,
      execute: async t => {
        if (t.phase === "inventory") return { ...result(t), components: modules("a", "b", "c", "d") };
        if (t.phase === "plan") {
          started.push(t.id);
          if (started.length === 3) firstThreeStarted.resolve();
          if (t.component === "d") fourthStarted.resolve();
          await authors.get(t.component!)!.promise;
        }
        return result(t);
      },
      review: async t => {
        if (t.id === "plan-a") { firstReviewStarted.resolve(); await firstReview.promise; }
        reviewed.push(t.id);
        return undefined;
      },
      changed: state => { maxRunning = Math.max(maxRunning, state.tasks.filter(t => t.status === "running").length); },
    });
    try {
      await firstThreeStarted.promise;
      assert.deepEqual(started, ["plan-a", "plan-b", "plan-c"]);
      authors.get("a")!.resolve();
      await firstReviewStarted.promise;
      assert.equal(started.length, 3);
      assert.ok(!pipeline.state.tasks.some(t => t.id === "contracts-a"));
      firstReview.resolve();
      await fourthStarted.promise;
      assert.ok(reviewed.includes("plan-a"));
      authors.forEach(gate => gate.resolve());
      await run;
      assert.equal(maxRunning, 3);
      assert.ok(pipeline.state.tasks.every(t => t.status === "done"));
      assert.equal(pipeline.state.tasks.find(t => t.id === "synthesis")!.title, "汇总组件使用指南");
    } finally {
      authors.forEach(gate => gate.resolve()); firstReview.resolve(); await run.catch(() => {});
    }
  });
});

test("一个模块失败不阻塞其它模块，恢复只执行未完成任务", async () => {
  await withPipeline(async (pipeline, file) => {
    const counts = new Map<string, number>();
    const execute = async (t: ComponentWork) => {
      counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
      return { ...result(t), ...(t.phase === "inventory" ? { components: modules("bad", "good") } : {}) };
    };
    await assert.rejects(pipeline.run({ signal: new AbortController().signal, execute,
      review: async t => t.id === "plan-bad" ? "模块计划缺少实际用法" : undefined, changed() {} }), /模块计划缺少实际用法/);
    assert.equal(counts.get("plan-bad"), 3);
    assert.equal(pipeline.state.tasks.find(t => t.id === "index-good")!.status, "done");
    const recovered = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await recovered.run({ signal: new AbortController().signal, execute, review: async () => undefined, changed() {} });
    assert.equal(counts.get("plan-bad"), 4);
    assert.equal(counts.get("index-good"), 1);
    assert.ok(recovered.state.tasks.every(t => t.status === "done"));
  });
});

test("取消等待在途会话退出，取消后不发布结果、不评审、不改持久状态", async () => {
  await withPipeline(async (pipeline, file) => {
    const controller = new AbortController(), started = deferred();
    const authors = new Map(["a", "b"].map(id => [id, deferred()]));
    let active = 0, reviews = 0, changes = 0, settled = false;
    const run = pipeline.run({ signal: controller.signal,
      execute: async t => {
        if (t.phase === "inventory") return { ...result(t), components: modules("a", "b") };
        if (t.phase === "plan") {
          if (++active === 2) started.resolve();
          await authors.get(t.component!)!.promise;
        }
        return result(t);
      },
      review: async () => { reviews++; return undefined; }, changed: () => { changes++; },
    });
    const completion = run.then(() => { settled = true; }, error => { settled = true; throw error; });
    const rejected = assert.rejects(completion, { name: "AbortError" });
    try {
      await started.promise;
      controller.abort();
      const snapshot = JSON.stringify(pipeline.state), persisted = readFileSync(file, "utf8"), changesAtAbort = changes;
      authors.get("a")!.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(JSON.stringify(pipeline.state), snapshot);
      assert.equal(readFileSync(file, "utf8"), persisted);
      assert.equal(changes, changesAtAbort);
      assert.equal(reviews, 1);
      authors.get("b")!.resolve();
      await rejected;
      assert.equal(JSON.stringify(pipeline.state), snapshot);
      assert.equal(changes, changesAtAbort);
      const recovered = new ComponentResearchPipeline(file, "skill1", ["base"]);
      assert.ok(recovered.state.tasks.filter(t => t.phase === "plan").every(t => t.status === "pending" && t.attempts === 0));
    } finally { authors.forEach(gate => gate.resolve()); await rejected; }
  });
});

test("并发计划完成时再次检查全局编号，禁止跨模块编号碰撞", async () => {
  await withPipeline(async pipeline => {
    const readyForReview = deferred(), firstReview = deferred(), secondReview = deferred();
    let plansInReview = 0;
    const run = pipeline.run({ signal: new AbortController().signal,
      execute: async t => ({ ...result(t),
        ...(t.phase === "inventory" ? { components: modules("a", "a-b") } : {}),
        ...(t.phase === "plan" ? { paradigms: [{ id: t.component === "a" ? "b-c" : "c", title: "提交任务", need: "后台执行" }] } : {}),
      }),
      review: async t => {
        if (t.phase === "plan" && t.attempts === 1) {
          if (++plansInReview === 2) readyForReview.resolve();
          await (t.component === "a" ? firstReview : secondReview).promise;
        }
        return undefined;
      }, changed() {},
    });
    const rejected = assert.rejects(run, /任务编号与已有产物重复/);
    try {
      await readyForReview.promise;
      firstReview.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      secondReview.resolve();
      await rejected;
      assert.equal(new Set(pipeline.state.tasks.map(t => t.id)).size, pipeline.state.tasks.length);
      assert.equal(pipeline.state.tasks.find(t => t.id === "plan-a-b")!.status, "failed");
      assert.equal(pipeline.state.tasks.find(t => t.id === "index-a")!.status, "done");
    } finally { firstReview.resolve(); secondReview.resolve(); await rejected; }
  });
});

test("模块关系保留在独立任务范围中，未知、自身、重复及循环依赖被拒绝", async () => {
  await withPipeline(async pipeline => {
    const components = modules("a", "b").map(c => ({ ...c, dependencies: c.id === "b" ? ["a"] : [] }));
    await pipeline.run({ signal: new AbortController().signal,
      execute: async t => ({ ...result(t), ...(t.phase === "inventory" ? { components } : {}) }),
      review: async () => undefined, changed() {},
    });
    const plan = pipeline.state.tasks.find(t => t.id === "plan-b")!;
    assert.deepEqual(plan.dependencies, ["inventory"]);
    assert.deepEqual(JSON.parse(plan.spec), components[1]);
    assert.deepEqual(JSON.parse(pipeline.state.tasks.find(t => t.id === "paradigm-b-submit")!.spec).module, components[1]);
  });
  for (const dependencies of [["missing"], ["a"], ["b", "b"], ["b"]]) {
    await withPipeline(async pipeline => {
      const components = modules("a", "b").map(c => ({ ...c, dependencies: c.id === "a" ? dependencies : ["a"] }));
      await assert.rejects(pipeline.run({ signal: new AbortController().signal,
        execute: async t => ({ ...result(t), ...(t.phase === "inventory" ? { components } : {}) }),
        review: async () => undefined, changed() {},
      }), /模块依赖/);
      assert.equal(pipeline.state.tasks.length, 1);
    });
  }
});

test("并发数明确可配置，拒绝无效值且不启动任务", async () => {
  for (const concurrency of [0, -1, 1.5, 11, NaN]) {
    await withPipeline(async pipeline => {
      await assert.rejects(pipeline.run({ signal: new AbortController().signal, concurrency,
        execute: async () => { throw new Error("不应执行"); }, review: async () => undefined, changed() {},
      }), /并发数/);
      assert.equal(pipeline.state.tasks[0].attempts, 0);
    });
  }
  await withPipeline(async pipeline => {
    let maximum = 0;
    await pipeline.run({ signal: new AbortController().signal, concurrency: 1,
      execute: async t => ({ ...result(t), ...(t.phase === "inventory" ? { components: modules("a", "b") } : {}) }),
      review: async () => undefined,
      changed: state => { maximum = Math.max(maximum, state.tasks.filter(t => t.status === "running").length); },
    });
    assert.equal(maximum, 1);
  });
});
