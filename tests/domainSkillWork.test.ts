import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainSkillWork, type SkillWorkCallbacks, type SkillWorkResult } from "../src/domainSkillWork.ts";

const step = (id: string, depends_on: string[] = []) => ({ id, title: id, instructions: "任意 Skill 的工作说明", depends_on, readonly: false });
test("通用工作记录只执行 Skill 提供的步骤，拒绝环路，断点复用结果与显式暂停", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-work-")), file = join(dir, "state.json"), signal = new AbortController().signal;
  try {
    let work = new DomainSkillWork(file, "skill-a");
    assert.equal(work.state.steps.length, 0);
    assert.throws(() => work.schedule([step("a", ["b"]), step("b", ["a"])]), /循环/);
    assert.equal(work.state.steps.length, 0);
    assert.throws(() => work.schedule([step("a", ["absent"])]), /不存在/);
    work.schedule([step("a"), step("b", ["a"])]);
    await assert.rejects(work.run("b", async () => ({ summary: "bad", document_ids: [] }), signal), /依赖/);
    let calls = 0; const execute = async () => { calls++; return { summary: "结果", document_ids: [], data: { custom: [1] } }; };
    await work.run("a", execute, signal);
    assert.throws(() => work.finish({ summary: "伪报完成", document_ids: [] }), /未完成/);
    work.finish({ status: "paused", summary: "Skill 请求用户核对", document_ids: [] });
    work = new DomainSkillWork(file, "skill-a"); assert.equal(work.state.result?.status, "paused");
    work = new DomainSkillWork(file, "skill-a", 1); assert.equal(work.state.result, undefined);
    await work.run("a", execute, signal); assert.equal(calls, 1, "重启不重复执行已完成工作");
    await work.run("b", execute, signal); assert.equal(calls, 2);
    work.finish({ status: "complete", summary: "结束", document_ids: [] });
    assert.deepEqual(work.state.steps.map(s => s.id), ["a", "b"], "平台没有增加业务阶段或评审");
    assert.throws(() => work.schedule([{ ...step("a"), instructions: "覆盖历史" }]), /不能改写/);
    // A crashed running step can be retried without changing its dependencies or result history.
    const state = JSON.parse(readFileSync(file, "utf8")); state.steps.push({ ...step("c"), status: "running", attempts: 1 }); delete state.result;
    writeFileSync(file, JSON.stringify(state)); work = new DomainSkillWork(file, "skill-a", 1);
    assert.equal(work.state.steps.at(-1)?.status, "failed");
    await work.run("c", execute, signal); assert.equal(work.state.steps.at(-1)?.attempts, 2);
    work.schedule([step("unused")]); work.discard("unused", "Skill 确认不适用");
    work.finish({ summary: "已说明未执行项", document_ids: [] });
    work = new DomainSkillWork(file, "skill-a", 2);
    assert.equal(work.state.result, undefined, "已完成任务的显式接续也要执行 Skill，不能直接复用结束结论");
    assert.equal(work.state.previous_results?.at(-1)?.summary, "已说明未执行项");
    assert.equal(work.state.steps[0].status, "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("取消不接受迟到结果，失败记录和草稿编号保留用于接续", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-cancel-"));
  try {
    const work = new DomainSkillWork(join(dir, "state.json"), "skill"), controller = new AbortController();
    work.schedule([step("slow")]);
    await assert.rejects(work.run("slow", async () => { controller.abort(); return { summary: "迟到", document_ids: [] }; }, controller.signal));
    assert.equal(work.state.steps[0].status, "failed"); assert.equal(work.state.steps[0].result, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const reviewedStep = (id = "guide") => ({ ...step(id), expected_document_ids: [id], review: { instructions: "回读正文和来源，核对适用条件与遗漏" } });
const candidate = (id = "guide"): SkillWorkResult => ({ summary: "文稿已保存", document_ids: [id], data: { pass: "旧 Skill 自由数据" } });
function reviewedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "skill-review-")), file = join(dir, "work.json");
  const work = new DomainSkillWork(file, "skill"); work.schedule([reviewedStep()]);
  return { dir, file, work, signal: new AbortController().signal };
}

test("无知识文稿的只读核查不启动自动评审，保留不通过结论且重复登记语义一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-readonly-review-")), file = join(dir, "work.json");
  const extraInstructions = "核查完整规划\n逐项核对事件订阅、定时入口与文稿清单，说明来源缺口。";
  const definition = { ...step("review-plan"), readonly: true, review: { instructions: extraInstructions } };
  const normalizedInstructions = `${definition.instructions}\n\n补充核查要求：\n${extraInstructions}`;
  const verdict: SkillWorkResult = { summary: "规划缺少事件入口", document_ids: [], review: { pass: false, feedback: "请补查订单事件订阅入口" }, data: { pass: "原方法自定义字段" } };
  const callbacks: SkillWorkCallbacks = {
    fingerprint: () => "no-documents",
    validate: async () => assert.fail("只读核查没有需要自动校验的知识文稿"),
    review: async () => assert.fail("规划结论不能再启动一层知识文稿评审"),
  };
  try {
    let work = new DomainSkillWork(file, "skill");
    work.schedule([definition]); work.schedule([definition]);
    assert.equal(work.state.steps.length, 1); assert.equal(work.state.steps[0].review, undefined);
    assert.equal(work.state.steps[0].instructions, normalizedInstructions, "自动评审字段中的完整核查要求转入当前步骤，重复登记不重复追加");
    assert.equal(definition.instructions, step("review-plan").instructions, "登记时保留调用方原说明");
    assert.deepEqual(definition.review, { instructions: extraInstructions }, "登记时不修改调用方对象");
    const result = await work.run("review-plan", async () => verdict, new AbortController().signal, callbacks);
    assert.deepEqual(result, verdict); assert.equal(work.state.steps[0].status, "done");
    work = new DomainSkillWork(file, "skill");
    work.schedule([definition]);
    work = new DomainSkillWork(file, "skill");
    assert.equal(work.state.steps[0].instructions, normalizedInstructions, "多次重启及再次登记原定义后，核查要求只保留一份");
    assert.deepEqual(await work.run("review-plan", async () => assert.fail("已保存的不通过结论也应直接复用"), new AbortController().signal, callbacks), verdict);
    assert.equal(work.state.steps[0].attempts, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("历史只读核查误配置在原编号原依赖恢复，不被已耗尽的文稿预算挡住", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-readonly-recovery-")), file = join(dir, "work.json");
  const extraInstructions = "核查完整规划\n必须回读订单事件注册与夜间清理入口，分别核对场景清单和排除理由。";
  const definition = { ...step("review-plan", ["research"]), readonly: true, review: { instructions: extraInstructions } };
  const normalizedInstructions = `${definition.instructions}\n\n补充核查要求：\n${extraInstructions}`;
  const original = { version: 1, skill: "fixed-old-skill", continued: 0,
    steps: [
      { ...step("research"), readonly: true, status: "done", attempts: 1, result: { summary: "已调查业务入口", document_ids: [], data: { evidence_index: ["repo-1:src/order.ts:1"] } } },
      { ...definition, status: "failed", attempts: 3, budget_start: 0, review_attempts: 0, error: "独立评审需要至少一份待评审文稿" },
      { ...reviewedStep("guide"), depends_on: ["review-plan"], status: "pending", attempts: 0 },
    ],
    documents: [{ id: "current-plan", title: "完整规划", content: "# 规划\n\n已完成调查，计划生成 guide。" }],
    plan: { document_ids: ["guide"], work_document_id: "current-plan" },
  };
  const verdict: SkillWorkResult = { summary: "原规划范围已核查", document_ids: [], review: { pass: true, feedback: "已对照真实入口与全部计划条目" } };
  try {
    writeFileSync(file, JSON.stringify(original));
    let work = new DomainSkillWork(file, "fixed-old-skill");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.steps[1].review, undefined, "兼容修正立即落盘，不等待重新执行");
    assert.equal(persisted.steps[1].instructions, normalizedInstructions, "历史 review.instructions 中独有的要求完整保留");
    assert.equal(persisted.steps[1].attempts, 3); assert.equal(persisted.steps[1].budget_start, 0);
    assert.equal(persisted.continued, 0, "恢复不冒充一次人工接续或补预算");
    assert.deepEqual(persisted.steps[0], original.steps[0]); assert.deepEqual(persisted.steps[2], original.steps[2]);
    work = new DomainSkillWork(file, "fixed-old-skill");
    work.schedule([definition]); work.schedule([definition]);
    work = new DomainSkillWork(file, "fixed-old-skill");
    assert.equal(work.state.steps[1].instructions, normalizedInstructions, "迁移后反复重启和登记原定义不再追加要求");
    let calls = 0;
    const result = await work.run("review-plan", async current => {
      calls++; assert.equal(current.id, "review-plan"); assert.deepEqual(current.depends_on, ["research"]);
      assert.equal(current.review, undefined);
      assert.equal(current.instructions, normalizedInstructions, "恢复执行仍收到原步骤及完整补充要求");
      work.recordCandidate(current.id, verdict);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).steps[1].candidate, verdict);
      return verdict;
    }, new AbortController().signal, {
      fingerprint: () => "no-documents",
      validate: async () => assert.fail("历史误配的写作预算不能约束只读核查"),
      review: async () => assert.fail("不对规划启动知识文稿评审"),
    });
    assert.deepEqual(result, verdict); assert.equal(calls, 1);
    assert.equal(work.state.steps[1].attempts, 4, "保留真实历史次数，只增加当前核查的一次执行");
    assert.equal(work.state.steps[1].error, undefined);
    assert.deepEqual(work.state.steps.map(item => item.id), original.steps.map(item => item.id));
    assert.deepEqual(work.state.steps[0], original.steps[0]); assert.deepEqual(work.state.steps[2], original.steps[2]);
    assert.deepEqual(work.state.documents, original.documents); assert.deepEqual(work.state.plan, original.plan);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("只读核查提交不通过候选后中断，重启保留结论且不重新调查", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-readonly-candidate-")), file = join(dir, "work.json"), controller = new AbortController();
  const verdict: SkillWorkResult = { summary: "核查发现缺口", document_ids: [], review: { pass: false, feedback: "计划未覆盖定时入口" } };
  const callbacks: SkillWorkCallbacks = {
    fingerprint: () => "no-documents",
    validate: async () => assert.fail("只读候选不进行文稿校验"),
    review: async () => assert.fail("不能自动重评只读结论"),
  };
  try {
    let work = new DomainSkillWork(file, "skill");
    work.schedule([{ ...step("review-plan"), readonly: true, review: { instructions: "核查完整规划" } }]);
    await assert.rejects(work.run("review-plan", async () => {
      work.recordCandidate("review-plan", verdict); controller.abort(); return verdict;
    }, controller.signal, callbacks));
    assert.deepEqual(work.state.steps[0].candidate, verdict);
    work = new DomainSkillWork(file, "skill");
    assert.deepEqual(await work.run("review-plan", async () => assert.fail("已经保存核查候选，不能重复调查"), new AbortController().signal, callbacks), verdict);
    assert.equal(work.state.steps[0].status, "done"); assert.equal(work.state.steps[0].attempts, 1);
    assert.deepEqual(new DomainSkillWork(file, "skill").state.steps[0].result, verdict);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("历史自动评审留下的负面候选保持原文与不通过判断，不伪造规划通过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-readonly-negative-")), file = join(dir, "work.json");
  const verdict: SkillWorkResult = { summary: "已读取关联文稿", document_ids: ["guide"],
    review: { pass: false, feedback: "文稿遗漏取消条件，不能通过" } };
  try {
    writeFileSync(file, JSON.stringify({ version: 1, skill: "skill", steps: [{ ...step("review-plan"), readonly: true,
      review: { instructions: "核查规划" }, status: "failed", attempts: 3, review_attempts: 3, candidate: verdict }] }));
    const work = new DomainSkillWork(file, "skill");
    const result = await work.run("review-plan", async () => assert.fail("保留已取得的负面依据，交回主会话判断"), new AbortController().signal, {
      fingerprint: () => "existing-document",
      validate: async () => assert.fail("不重新校验已解除自动评审配置的只读步骤"),
      review: async () => assert.fail("不自动重评"),
    });
    assert.deepEqual(result, verdict, "不改写结论范围、引用编号或不通过反馈");
    assert.equal(work.state.steps[0].attempts, 3); assert.equal(work.state.steps[0].review_attempts, 3);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).steps[0].result.review.pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("明确指定知识文稿的只读步骤仍保留独立评审和版本核对", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-readonly-documents-")), file = join(dir, "work.json");
  let version = "version-1", calls = 0, reviews = 0;
  const callbacks: SkillWorkCallbacks = {
    fingerprint: () => version,
    review: async (_step, value) => {
      reviews++; assert.equal(value.review, undefined, "首次核查不能代替登记的独立评审");
      return { pass: true, feedback: "独立读取当前文稿与来源，通过" };
    },
  };
  try {
    let work = new DomainSkillWork(file, "skill");
    const definition = { ...reviewedStep("guide"), readonly: true };
    work.schedule([definition, { ...step("write-without-ids"), review: { instructions: "依据实际候选编号评审" } }]);
    assert.deepEqual(work.state.steps[0].review, definition.review);
    assert.ok(work.state.steps[1].review, "可写步骤仍可按实际候选编号启动评审");
    const result = await work.run("guide", async () => { calls++; return { ...candidate(), review: { pass: true, feedback: "首次核查自报通过" } }; }, new AbortController().signal, callbacks);
    assert.equal(result.review?.feedback, "独立读取当前文稿与来源，通过"); assert.equal(reviews, 1);
    work = new DomainSkillWork(file, "skill"); version = "version-2";
    await work.run("guide", async () => assert.fail("文稿版本变化只需重评已保存候选"), new AbortController().signal, callbacks);
    assert.equal(calls, 1); assert.equal(reviews, 2); assert.equal(work.state.steps[0].reviewed_fingerprint, version);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("预定文稿不完整时不能提交结果，也不启动评审", async () => {
  const f = reviewedFixture(); let reviews = 0;
  try {
    await assert.rejects(f.work.run("guide", async () => ({ summary: "只写了别的文稿", document_ids: ["other"] }), f.signal, {
      fingerprint: () => "version-1", review: async () => { reviews++; return { pass: true, feedback: "通过" }; },
    }), /全部预定文稿/);
    assert.equal(reviews, 0); assert.equal(f.work.state.steps[0].attempts, 3);
    assert.equal(f.work.state.steps[0].status, "failed");
    assert.equal(f.work.state.steps[0].candidate, undefined);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("独立评审退回的具体意见交回写作会话，修改后重新评审才完成", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0, version = "initial";
  try {
    const result = await f.work.run("guide", async current => {
      writes++;
      if (writes === 2) {
        assert.equal(current.error, "缺少取消前必须核对结算状态的前提");
        assert.equal(current.candidate?.review?.pass, false);
      }
      version = `version-${writes}`;
      f.work.recordCandidate("guide", candidate(), version);
      assert.equal(JSON.parse(readFileSync(f.file, "utf8")).steps[0].candidate.summary, "文稿已保存");
      return candidate();
    }, f.signal, { fingerprint: () => version, review: async () => {
      reviews++; return reviews === 1 ? { pass: false, feedback: "缺少取消前必须核对结算状态的前提" } : { pass: true, feedback: "已回查来源，前提与例外一致" };
    } });
    assert.equal(writes, 2); assert.equal(reviews, 2); assert.equal(result.review?.pass, true);
    assert.deepEqual(result.data, { pass: "旧 Skill 自由数据" }, "不解释或覆盖旧 data.pass");
    assert.equal(f.work.state.steps[0].reviewed_fingerprint, "version-2");
    f.work.finish({ summary: "全部已评审", document_ids: ["guide"] }, () => version);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("提交工具已保存候选后结束回复失败，不重复写作，仍执行独立评审", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0;
  try {
    const result = await f.work.run("guide", async () => {
      writes++; f.work.recordCandidate("guide", candidate()); throw new Error("结束回复时连接中断");
    }, f.signal, { fingerprint: () => "version-1", review: async () => { reviews++; return { pass: true, feedback: "当前正文和来源一致" }; } });
    assert.equal(writes, 1); assert.equal(reviews, 1); assert.equal(result.review?.pass, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("独立评审提交成功后结束回复失败，复用已落盘结论且不重复评审", async () => {
  const f = reviewedFixture(); let reviews = 0;
  const result: SkillWorkResult = { summary: "已核对本组正文及来源", document_ids: ["guide"],
    review: { pass: true, feedback: "适用条件与来源一致" }, data: { evidence: "original-source" } };
  try {
    const completed = await f.work.run("guide", async () => candidate(), f.signal, {
      fingerprint: () => "version-1", review: async () => {
        reviews++;
        f.work.recordReview("guide", result, "version-1");
        assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).steps[0].review_submission, { result, fingerprint: "version-1" });
        throw new Error("最终回复连接中断");
      },
    });
    assert.equal(reviews, 1); assert.deepEqual(completed.review, result.review);
    assert.deepEqual(completed.data, candidate().data, "独立评审另存完整结果，不覆盖写作者的证据索引");
    assert.equal(f.work.state.steps[0].review_attempts, 1); assert.equal(f.work.state.steps[0].status, "done");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("第三次独立评审提交通过后重启，恢复当前版本结果且不补预算", async () => {
  const f = reviewedFixture(), controller = new AbortController(); let reviews = 0, writes = 0;
  try {
    await assert.rejects(f.work.run("guide", async () => { writes++; return candidate(); }, controller.signal, {
      fingerprint: () => "version-1", review: async () => {
        reviews++;
        if (reviews < 3) throw new Error("模型连接中断，尚未提交评审");
        f.work.recordReview("guide", { ...candidate(), review: { pass: true, feedback: "第三次已读取并核对当前正文" } }, "version-1");
        controller.abort(); throw new Error("服务停止");
      },
    }));
    const state = JSON.parse(readFileSync(f.file, "utf8")); state.steps[0].status = "running";
    writeFileSync(f.file, JSON.stringify(state));
    const restored = new DomainSkillWork(f.file, "skill");
    const completed = await restored.run("guide", async () => assert.fail("不能重复写作"), f.signal, {
      fingerprint: () => "version-1", validate: async () => undefined,
      review: async () => assert.fail("已提交通过结果，不能重复评审"),
    });
    assert.equal(completed.review?.pass, true); assert.equal(writes, 1); assert.equal(reviews, 3);
    assert.equal(restored.state.steps[0].review_attempts, 3); assert.equal(restored.state.steps[0].review_budget_start ?? 0, 0);
    restored.finish({ summary: "当前版本完成", document_ids: ["guide"] }, () => "version-1");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审退回提交后重启，把已保存反馈交作者修订而不重复评审旧稿", async () => {
  const f = reviewedFixture(), controller = new AbortController(); let version = "version-1", reviews = 0;
  const feedback = "R1：取消规则缺少结算状态前提";
  try {
    await assert.rejects(f.work.run("guide", async () => candidate(), controller.signal, {
      fingerprint: () => version, review: async () => {
        reviews++;
        f.work.recordReview("guide", { ...candidate(), review: { pass: false, feedback } }, version);
        controller.abort(); throw new Error("服务停止");
      },
    }));
    const restored = new DomainSkillWork(f.file, "skill");
    const completed = await restored.run("guide", async current => {
      assert.equal(current.error, feedback); assert.equal(current.candidate?.review?.feedback, feedback);
      version = "version-2"; return candidate();
    }, f.signal, { fingerprint: () => version, review: async current => {
      reviews++; assert.equal(current.review_submission, undefined, "新候选不继承旧评审结果");
      return { pass: true, feedback: "已核对补充的结算前提" };
    } });
    assert.equal(completed.review?.pass, true); assert.equal(reviews, 2);
    assert.equal(restored.state.steps[0].attempts, 2); assert.equal(restored.state.steps[0].review_attempts, 2);
    assert.equal(restored.state.steps[0].reviewed_fingerprint, "version-2");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const pass of [true, false]) test(`已提交的${pass ? "通过" : "退回"}评审重启后正文变化，只核对新版本且不采用旧判断`, async () => {
  const f = reviewedFixture(), controller = new AbortController(); let version = "version-1";
  try {
    await assert.rejects(f.work.run("guide", async () => candidate(), controller.signal, {
      fingerprint: () => version, review: async () => {
        f.work.recordReview("guide", { ...candidate(), review: { pass, feedback: "旧正文的评审判断" } }, version);
        controller.abort(); throw new Error("服务停止");
      },
    }));
    version = "version-2";
    const restored = new DomainSkillWork(f.file, "skill");
    const completed = await restored.run("guide", async () => assert.fail("新正文已经保存，不能依据旧评审覆盖"), f.signal, {
      fingerprint: () => version, review: async current => {
        assert.equal(current.review_submission, undefined);
        return { pass: true, feedback: "独立核对新版本" };
      },
    });
    assert.equal(completed.review?.feedback, "独立核对新版本"); assert.equal(restored.state.steps[0].review_attempts, 2);
    assert.equal(restored.state.steps[0].attempts, 1); assert.equal(restored.state.steps[0].reviewed_fingerprint, version);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("独立评审提交必须覆盖实际写入、匹配评审版本并处于有效评审会话", async () => {
  const f = reviewedFixture(), controller = new AbortController(); let version = "version-1";
  const result = { ...candidate(), review: { pass: true, feedback: "已核对当前正文" } };
  try {
    assert.throws(() => f.work.recordReview("guide", result, version), /不在提交独立评审/);
    await assert.rejects(f.work.run("guide", async () => {
      assert.throws(() => f.work.recordReview("guide", result, version), /不在提交独立评审/);
      f.work.recordDocumentWrite("guide", "related"); return candidate();
    }, controller.signal, { fingerprint: () => version, review: async () => {
      assert.throws(() => f.work.recordReview("guide", result, version), /全部预定及实际改动/);
      const complete = { ...result, document_ids: ["guide", "related"] };
      assert.throws(() => f.work.recordReview("guide", complete, "old-version"), /文稿已变化/);
      version = "version-2";
      assert.throws(() => f.work.recordReview("guide", complete, "version-1"), /文稿已变化/);
      assert.throws(() => f.work.recordReview("guide", complete, "version-2"), /文稿已变化/, "不能用最新指纹冒充已经读取了新版本");
      controller.abort(); assert.throws(() => f.work.recordReview("guide", complete, version));
      throw new Error("停止本用例");
    } }));
    assert.equal(f.work.state.steps[0].review_submission, undefined); assert.equal(f.work.state.steps[0].result, undefined);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("恢复已提交评审时校验期间正文变化，不把旧结论绑定到新版本", async () => {
  const f = reviewedFixture(), controller = new AbortController(); let version = "version-1";
  try {
    await assert.rejects(f.work.run("guide", async () => candidate(), controller.signal, {
      fingerprint: () => version, review: async () => {
        f.work.recordReview("guide", { ...candidate(), review: { pass: true, feedback: "旧版本核对通过" } }, version);
        controller.abort(); throw new Error("服务停止");
      },
    }));
    const restored = new DomainSkillWork(f.file, "skill"); let reviews = 0;
    const result = await restored.run("guide", async () => assert.fail("不重写已有正文"), f.signal, {
      fingerprint: () => version,
      validate: async () => { version = "version-2"; return undefined; },
      review: async current => {
        reviews++; assert.equal(current.review_submission, undefined);
        return { pass: true, feedback: "新版本重新核对通过" };
      },
    });
    assert.equal(reviews, 1); assert.equal(result.review?.feedback, "新版本重新核对通过");
    assert.equal(restored.state.steps[0].reviewed_fingerprint, "version-2");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审中断后重启复用候选文稿，预算和成功结果都保留", async () => {
  const f = reviewedFixture(), controller = new AbortController(); let writes = 0, reviews = 0;
  try {
    await assert.rejects(f.work.run("guide", async () => { writes++; return candidate(); }, controller.signal, {
      fingerprint: () => "version-1", review: async () => { reviews++; controller.abort(); return { pass: true, feedback: "迟到评审" }; },
    }));
    assert.equal(f.work.state.steps[0].status, "failed"); assert.equal(f.work.state.steps[0].result, undefined);
    assert.equal(f.work.state.steps[0].candidate?.summary, "文稿已保存");
    const stored = JSON.parse(readFileSync(f.file, "utf8")); stored.steps[0].status = "running";
    writeFileSync(f.file, JSON.stringify(stored)); // 模拟进程结束前未能保存最终状态。
    let restored = new DomainSkillWork(f.file, "skill");
    assert.equal(restored.state.steps[0].review_attempts, 1);
    const callbacks = { fingerprint: () => "version-1", review: async () => { reviews++; return { pass: true, feedback: "恢复后重新回读通过" }; } };
    await restored.run("guide", async () => { writes++; throw new Error("不能重写已经保存的候选"); }, f.signal, callbacks);
    assert.equal(writes, 1); assert.equal(reviews, 2);
    restored = new DomainSkillWork(f.file, "skill");
    await restored.run("guide", async () => { throw new Error("不能重复写作"); }, f.signal, callbacks);
    assert.equal(reviews, 2, "相同正文的已通过评审直接复用");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("正文变化不能复用旧评审，完成前也必须核对实际正文版本", async () => {
  const f = reviewedFixture(); let version = "version-1", writes = 0, reviews = 0;
  const callbacks = { fingerprint: () => version, review: async () => { reviews++; return { pass: true, feedback: `已核对 ${version}` }; } };
  try {
    await f.work.run("guide", async () => { writes++; return candidate(); }, f.signal, callbacks);
    version = "version-2";
    assert.throws(() => f.work.finish({ summary: "宣称完成", document_ids: ["guide"] }, callbacks.fingerprint), /文稿已变化/);
    const result = await f.work.run("guide", async () => { writes++; throw new Error("当前正文只需重评，不应覆盖"); }, f.signal, callbacks);
    assert.equal(writes, 1); assert.equal(reviews, 2); assert.equal(result.review?.feedback, "已核对 version-2");
    f.work.finish({ summary: "当前正文通过", document_ids: ["guide"] }, callbacks.fingerprint);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const reference of ["result", "written"] as const) test(`完成时旧步骤的 ${reference} 文稿也须有当前评审，混合步骤不能互相担保`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-excluded-review-")), file = join(dir, "state.json");
  const signal = new AbortController().signal;
  let deleted = false, version = "current";
  const fingerprint = (ids: string[]) => {
    if (deleted && ids.includes("removed")) throw new Error("旧文稿已标记删除");
    return `${ids.join(",")}:${version}`;
  };
  const callbacks = { fingerprint, review: async () => ({ pass: true, feedback: "独立回读当前正文通过" }) };
  const result = { summary: "完成当前文稿", document_ids: ["active"] };
  try {
    let work = new DomainSkillWork(file, "skill");
    work.schedule(["old-a", "old-b"].map(id => ({ ...reviewedStep(id), expected_document_ids: ["removed"] })));
    for (const id of ["old-a", "old-b"]) await work.run(id, async () => {
      if (reference === "written") work.recordDocumentWrite(id, "active");
      return { summary: "旧范围文稿已评审", document_ids: reference === "result" ? ["removed", "active"] : ["removed"] };
    }, signal, callbacks);
    const historical = structuredClone(work.state.steps);
    deleted = true;
    const excluded = new Set(["removed"]);
    assert.throws(() => work.finish(result, fingerprint), /已标记删除/, "没有显式排除范围时保持原检查");
    assert.throws(() => work.finish(result, fingerprint, excluded), /仍有效文稿.*独立评审.*active/, "两个混合步骤不能相互证明有效正文已评审");
    assert.equal(work.state.result, undefined); assert.deepEqual(work.state.steps, historical);
    work.schedule([{ ...reviewedStep("current-review"), expected_document_ids: ["active"], readonly: true }]);
    await work.run("current-review", async () => ({ summary: "只核对有效正文，不重写", document_ids: ["active"] }), signal, callbacks);
    work = new DomainSkillWork(file, "skill");
    work.finish(result, fingerprint, excluded);
    assert.deepEqual(work.state.steps.slice(0, 2), historical, "接续完成保留所有旧步骤，不修改其候选和结论");
    version = "changed-after-review";
    assert.throws(() => work.finish(result, fingerprint, excluded), /文稿已变化/, "排除旧文稿不能放过有效正文后来变化");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("评审期间正文变化时旧通过结论无效，只重评当前正文", async () => {
  const f = reviewedFixture(); let version = "version-1", reviews = 0, writes = 0;
  try {
    const result = await f.work.run("guide", async () => { writes++; return candidate(); }, f.signal, {
      fingerprint: () => version, review: async current => {
        reviews++;
        if (reviews === 1) version = "version-2";
        else assert.match(current.error ?? "", /评审期间文稿已变化/);
        return { pass: true, feedback: `核对第 ${reviews} 次读取的正文` };
      },
    });
    assert.equal(writes, 1); assert.equal(reviews, 2); assert.equal(result.review?.feedback, "核对第 2 次读取的正文");
    assert.equal(f.work.state.steps[0].reviewed_fingerprint, "version-2");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("已通过文稿多次正常更新时每版可重评，历史失败预算不限制后续新版本", async () => {
  const f = reviewedFixture(); let version = "version-0", writes = 0, reviews = 0;
  const callbacks = { fingerprint: () => version, review: async () => { reviews++; return { pass: true, feedback: `已回读 ${version}` }; } };
  try {
    let work = f.work;
    for (let i = 0; i < 6; i++) {
      version = `version-${i}`;
      const result = await work.run("guide", async () => { writes++; return candidate(); }, f.signal, callbacks);
      assert.equal(result.review?.feedback, `已回读 version-${i}`);
      assert.equal(work.state.steps[0].review_attempts, i + 1);
      work = new DomainSkillWork(f.file, "skill");
    }
    assert.equal(writes, 1, "正文已经由其他步骤更新，只重新核对，不覆盖新版本");
    assert.equal(reviews, 6);
    assert.equal(work.state.steps[0].review_budget_start, 5);
    work.finish({ summary: "全部当前版本已通过", document_ids: ["guide"] }, callbacks.fingerprint);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审连续驳回最多三轮，重启不补预算，人工明确接续才补充有限尝试", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0;
  const execute = async () => { writes++; return candidate(); };
  const callbacks = { fingerprint: () => `version-${writes}`, review: async () => { reviews++; return { pass: false, feedback: "仍缺关键例外的来源依据" }; } };
  try {
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(reviews, 3); assert.equal(f.work.state.steps[0].result, undefined);
    let restored = new DomainSkillWork(f.file, "skill");
    await assert.rejects(restored.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(reviews, 3);
    restored = new DomainSkillWork(f.file, "skill", 1);
    const result = await restored.run("guide", execute, f.signal, { ...callbacks, review: async current => {
      reviews++; assert.match(current.error ?? "", /仍缺关键例外/); return { pass: true, feedback: "已补充并回读例外来源" };
    } });
    assert.equal(writes, 4); assert.equal(reviews, 4); assert.equal(result.review?.pass, true);
    assert.equal(restored.state.steps[0].attempts, 4, "历史尝试次数保留");
    assert.equal(restored.state.steps[0].budget_start, 3);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("评审请求失败有持久上限，恢复后仅重试已保存候选的评审", async () => {
  const f = reviewedFixture(); let writes = 0, reviews = 0;
  const execute = async () => { writes++; return candidate(); };
  const callbacks = { fingerprint: () => "version-1", review: async () => { reviews++; throw new Error("模型请求连接中断"); } };
  try {
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /模型请求连接中断/);
    assert.equal(writes, 1); assert.equal(reviews, 3);
    let restored = new DomainSkillWork(f.file, "skill");
    await assert.rejects(restored.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    restored = new DomainSkillWork(f.file, "skill", 1);
    await restored.run("guide", execute, f.signal, { ...callbacks, review: async () => { reviews++; return { pass: true, feedback: "连接恢复，回读当前正文通过" }; } });
    assert.equal(writes, 1); assert.equal(reviews, 4);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("候选语法校验先于独立评审，错误反馈交回作者，修订通过后才评审", async () => {
  const f = reviewedFixture(); let writes = 0, checks = 0, reviews = 0;
  const feedback = "guide 第 2 张 PlantUML 的第 4 行语法错误，请修正参与者别名";
  try {
    const result = await f.work.run("guide", async current => {
      writes++;
      if (writes === 2) {
        assert.equal(current.error, feedback);
        assert.equal(current.candidate?.review?.pass, false);
      }
      return candidate();
    }, f.signal, {
      fingerprint: () => `version-${writes}`,
      validate: async (_step, value) => {
        checks++;
        assert.deepEqual(value.document_ids, ["guide"]);
        assert.equal(JSON.parse(readFileSync(f.file, "utf8")).steps[0].candidate.summary, "文稿已保存", "校验前候选已经落盘");
        return checks === 1 ? { pass: false, feedback } : undefined;
      },
      review: async () => { reviews++; return { pass: true, feedback: "语法通过后独立回查业务依据" }; },
    });
    assert.equal(writes, 2); assert.equal(checks, 2); assert.equal(reviews, 1);
    assert.equal(f.work.state.steps[0].attempts, 2); assert.equal(f.work.state.steps[0].review_attempts, 1);
    assert.equal(f.work.state.steps[0].reviewed_fingerprint, "version-2");
    assert.equal(result.review?.feedback, "语法通过后独立回查业务依据");
    assert.deepEqual(result.data, { pass: "旧 Skill 自由数据" });
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("语法持续失败最多三次写作，重启不会补修订预算或启动无效文稿评审", async () => {
  const f = reviewedFixture(); let writes = 0, checks = 0, reviews = 0;
  const execute = async () => { writes++; return candidate(); };
  const callbacks: SkillWorkCallbacks = {
    fingerprint: () => `version-${writes}`,
    validate: async () => { checks++; return { pass: false, feedback: "guide 第 1 张 PlantUML 仍有语法错误" }; },
    review: async () => { reviews++; return { pass: true, feedback: "不应评审未通过语法验证的文稿" }; },
  };
  try {
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(checks, 3); assert.equal(reviews, 0);
    assert.equal(f.work.state.steps[0].status, "failed"); assert.equal(f.work.state.steps[0].result, undefined);
    assert.equal(f.work.state.steps[0].review_attempts ?? 0, 0);
    assert.equal(f.work.state.steps[0].candidate?.review?.pass, false);
    const restored = new DomainSkillWork(f.file, "skill");
    await assert.rejects(restored.run("guide", execute, f.signal, callbacks), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(checks, 3); assert.equal(reviews, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("验证器不可用立即保留候选且不消耗评审或额外修订次数，重启恢复后只校验与评审", async () => {
  const f = reviewedFixture(); let writes = 0, checks = 0, reviews = 0;
  const execute = async () => { writes++; return candidate(); };
  const callbacks: SkillWorkCallbacks = {
    fingerprint: () => "version-1",
    validate: async () => { checks++; throw new Error("服务端没有 Java，PlantUML 尚未验证"); },
    review: async () => { reviews++; return { pass: true, feedback: "恢复后独立读取当前正文通过" }; },
  };
  try {
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /服务端没有 Java/);
    assert.equal(writes, 1); assert.equal(checks, 1); assert.equal(reviews, 0);
    const saved = f.work.state.steps[0];
    assert.equal(saved.status, "failed"); assert.equal(saved.attempts, 1); assert.equal(saved.review_attempts ?? 0, 0);
    assert.equal(saved.result, undefined); assert.deepEqual(saved.candidate, candidate());
    assert.equal(saved.candidate_fingerprint, "version-1");
    const restored = new DomainSkillWork(f.file, "skill");
    assert.deepEqual(restored.state.steps[0].candidate, candidate());
    const result = await restored.run("guide", execute, f.signal, { ...callbacks,
      validate: async () => { checks++; return undefined; },
    });
    assert.equal(writes, 1, "依赖恢复只重试验证，不能覆盖已保存的候选文稿");
    assert.equal(checks, 2); assert.equal(reviews, 1); assert.equal(result.review?.pass, true);
    assert.equal(restored.state.steps[0].attempts, 1); assert.equal(restored.state.steps[0].review_attempts, 1);
    assert.equal(restored.state.steps[0].reviewed_fingerprint, "version-1");
    restored.finish({ summary: "当前文稿验证与独立评审均通过", document_ids: ["guide"] }, callbacks.fingerprint);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("已用满三次评审预算的完成文稿遇临时验证故障，重启恢复后复用原评审且不重写", async () => {
  const f = reviewedFixture(); let writes = 0, checks = 0, reviews = 0, available = true;
  const execute = async () => { writes++; return candidate(); };
  const callbacks: SkillWorkCallbacks = {
    fingerprint: () => "version-1",
    validate: async () => { checks++; if (!available) throw new Error("PlantUML 进程暂时不可用"); return undefined; },
    review: async () => {
      reviews++;
      if (reviews < 3) throw new Error("评审请求连接暂时中断");
      return { pass: true, feedback: "第三次请求已回读当前正文并通过" };
    },
  };
  try {
    const completed = await f.work.run("guide", execute, f.signal, callbacks);
    f.work.finish({ status: "complete", summary: "已核对完成", document_ids: ["guide"] }, callbacks.fingerprint);
    assert.equal(writes, 1); assert.equal(reviews, 3); assert.equal(checks, 3);
    available = false;
    await assert.rejects(f.work.run("guide", execute, f.signal, callbacks), /进程暂时不可用/);
    assert.equal(f.work.state.result, undefined, "不能保留环境尚未复核时的整体完成结论");
    const restored = new DomainSkillWork(f.file, "skill");
    const saved = restored.state.steps[0];
    assert.equal(saved.status, "done"); assert.match(saved.error ?? "", /进程暂时不可用/);
    assert.deepEqual(saved.result, completed); assert.equal(saved.reviewed_fingerprint, "version-1");
    assert.equal(saved.attempts, 1); assert.equal(saved.review_attempts, 3);
    assert.equal(saved.review_budget_start ?? 0, 0, "环境故障和服务重启均不补评审预算");
    available = true;
    const reused = await restored.run("guide", execute, f.signal, callbacks);
    assert.deepEqual(reused, completed); assert.equal(saved.error, undefined);
    assert.equal(writes, 1); assert.equal(reviews, 3); assert.equal(checks, 5);
    assert.equal(saved.reviewed_fingerprint, "version-1");
    restored.finish({ status: "complete", summary: "环境恢复，复用当前版本的通过结论", document_ids: ["guide"] }, callbacks.fingerprint);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("旧方法未登记独立评审时仍执行候选校验，语法修订也限制为三次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-validation-only-"));
  const work = new DomainSkillWork(join(dir, "work.json"), "legacy-skill"); let writes = 0, checks = 0;
  work.schedule([{ ...step("guide"), expected_document_ids: ["guide"] }]);
  try {
    await assert.rejects(work.run("guide", async () => {
      writes++;
      assert.ok(writes <= 3, "旧方法不能因没有 review 而无限重写");
      return candidate();
    }, new AbortController().signal, {
      fingerprint: () => `version-${writes}`,
      validate: async () => { checks++; return { pass: false, feedback: "PlantUML 语法错误，需修改文稿" }; },
      review: async () => { throw new Error("旧方法没有登记独立评审"); },
    }), /已尝试 3 次/);
    assert.equal(writes, 3); assert.equal(checks, 3);
    assert.equal(work.state.steps[0].status, "failed"); assert.equal(work.state.steps[0].result, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("取消后提交工具拒绝迟到候选，写作者不能伪造独立评审", async () => {
  const f = reviewedFixture(), controller = new AbortController();
  try {
    await assert.rejects(f.work.run("guide", async () => {
      controller.abort();
      assert.throws(() => f.work.recordCandidate("guide", candidate()));
      return candidate();
    }, controller.signal, { fingerprint: () => "version-1", review: async () => { throw new Error("已取消不应评审"); } }));
    assert.equal(f.work.state.steps[0].candidate, undefined);
    const resumed = new DomainSkillWork(f.file, "skill", 1); let reviewed = false;
    const result = await resumed.run("guide", async () => ({ ...candidate(), review: { pass: true, feedback: "作者自报通过" } }), f.signal, {
      fingerprint: () => "version-1", review: async (_step, value) => {
        assert.equal(value.review, undefined); reviewed = true; return { pass: true, feedback: "独立回读通过" };
      },
    });
    assert.equal(reviewed, true); assert.equal(result.review?.feedback, "独立回读通过");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("完整文稿计划独立保存，引用实际规划正文，拒绝重复、越界和未说明的排除", () => {
  const f = reviewedFixture();
  try {
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan" }), /先保存完整规划正文/);
    f.work.saveDocument({ id: "plan", title: "完整文稿规划", content: "# 规划\n\n规则、例外和跨仓说明分别形成三份文稿。" });
    f.work.setPlan({ document_ids: ["guide", "exceptions", "cross-repo"], work_document_id: "plan" });
    assert.deepEqual(f.work.state.plan?.document_ids, ["guide", "exceptions", "cross-repo"]);
    assert.equal(f.work.state.steps.length, 1, "完整计划不会自动调度遗漏的文稿");
    const previous = readFileSync(f.file, "utf8");
    for (const ids of [["guide", "guide"], ["../guide"], ["space name"], Array.from({ length: 5001 }, (_, i) => `doc-${i}`)]) {
      assert.throws(() => f.work.setPlan({ document_ids: ids, work_document_id: "plan" }), /有效且不重复|最多 5000/);
    }
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan" }), /移除已规划文稿必须.*exceptions、cross-repo/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide", "exceptions", "cross-repo"], work_document_id: "plan", exclusions: [{ document_id: "guide", reason: "重复内容" }] }), /不能同时/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [{ document_id: "exceptions", reason: " " }] }), /逐项说明具体原因/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [{ document_id: "exceptions", reason: "重复" }, { document_id: "exceptions", reason: "重复" }] }), /不重复/);
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: null } as any), /排除项需要/);
    assert.equal(readFileSync(f.file, "utf8"), previous, "无效更新不改变已保存计划");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("计划缩减必须逐项解释，排除说明跨更新和重启保留，重新加入不放弃已有步骤", () => {
  const f = reviewedFixture();
  try {
    f.work.saveDocument({ id: "plan", title: "完整规划", content: "# 完整规划\n规则、例外与仓库索引。" });
    f.work.setPlan({ document_ids: ["guide", "exceptions", "index"], work_document_id: "plan" });
    f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [
      { document_id: "exceptions", reason: "例外已有独立维护文档，本次范围只引用其入口" },
      { document_id: "index", reason: "仓库索引本次不变，继续沿用既有索引" },
    ] });
    f.work.setPlan({ document_ids: ["guide", "cross-repo"], work_document_id: "plan" });
    let restored = new DomainSkillWork(f.file, "skill");
    assert.equal(restored.state.plan?.exclusions?.length, 2);
    assert.match(restored.state.plan?.exclusions?.[0].reason ?? "", /例外已有独立维护文档/);
    assert.equal(restored.state.steps[0].status, "pending", "更新计划不会自动执行或放弃任何步骤");
    assert.equal(restored.state.documents?.[0].content, "# 完整规划\n规则、例外与仓库索引。", "更新计划不会改写规划正文");
    restored.setPlan({ document_ids: ["guide", "cross-repo", "exceptions"], work_document_id: "plan" });
    restored = new DomainSkillWork(f.file, "skill");
    assert.deepEqual(restored.state.plan?.exclusions?.map(item => item.document_id), ["index"]);
    assert.deepEqual(restored.state.plan?.document_ids, ["guide", "cross-repo", "exceptions"]);
    assert.throws(() => restored.setPlan({ document_ids: ["guide", "cross-repo"], work_document_id: "plan" }), /exceptions/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("完整计划扫描排除说明中的秘密，拒绝后保留原计划", () => {
  const f = reviewedFixture();
  try {
    f.work.saveDocument({ id: "plan", title: "规划", content: "# 规划\n规则与例外。" });
    f.work.setPlan({ document_ids: ["guide", "exceptions"], work_document_id: "plan" });
    const previous = readFileSync(f.file, "utf8");
    assert.throws(() => f.work.setPlan({ document_ids: ["guide"], work_document_id: "plan", exclusions: [{ document_id: "exceptions", reason: "api_key: sk_live_fixture1234" }] }), /密钥/);
    assert.equal(readFileSync(f.file, "utf8"), previous);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("空的评审对象和评审说明返回明确错误，不抛 TypeError", () => {
  const f = reviewedFixture();
  try {
    for (const review of [null, { instructions: null }, { instructions: " " }]) {
      assert.throws(() => f.work.schedule([{ ...step("invalid"), review } as any]), error => {
        assert.ok(error instanceof Error); assert.equal(error instanceof TypeError, false); assert.match(error.message, /独立评审需要具体/); return true;
      });
    }
    assert.equal(f.work.state.steps.length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("1200份文稿完整计划与2400个分批步骤跨重启保留，已通过结果仍可复用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-plan-scale-")), file = join(dir, "work.json"), signal = new AbortController().signal;
  const ids = Array.from({ length: 1200 }, (_, i) => `doc-${String(i).padStart(4, "0")}`);
  try {
    let work = new DomainSkillWork(file, "skill");
    work.saveDocument({ id: "full-plan", title: "多仓完整文稿规划", content: "# 完整文稿清单\n\n" + ids.map((id, i) => `- ${id}：仓库 ${i % 4 + 1} 的第 ${i + 1} 项业务主题`).join("\n") });
    work.setPlan({ document_ids: ids, work_document_id: "full-plan" });
    const steps = ids.flatMap(id => [{ ...step(`source-${id}`), title: `核对 ${id} 的来源` },
      { ...reviewedStep(id), id: `write-${id}`, depends_on: [`source-${id}`] }]);
    for (let offset = 0; offset < steps.length; offset += 100) {
      work.schedule(steps.slice(offset, offset + 100));
      if (offset === 500) {
        work = new DomainSkillWork(file, "skill");
        assert.equal(work.state.plan?.document_ids.length, 1200, "分批登记步骤不会缩减完整必交清单");
        assert.equal(work.state.steps.length, 600);
      }
    }
    let calls = 0;
    await work.run(`source-${ids[0]}`, async () => { calls++; return { summary: "来源已核对", document_ids: [] }; }, signal);
    const callbacks = { fingerprint: () => "version-1", review: async () => { calls++; return { pass: true, feedback: "当前文稿与来源一致" }; } };
    await work.run(`write-${ids[0]}`, async () => { calls++; return candidate(ids[0]); }, signal, callbacks);
    work = new DomainSkillWork(file, "skill");
    assert.deepEqual(work.state.plan?.document_ids, ids);
    assert.equal(work.state.plan?.work_document_id, "full-plan");
    assert.equal(work.state.steps.length, 2400); assert.equal(new Set(work.state.steps.map(item => item.id)).size, 2400);
    assert.deepEqual(work.state.steps.at(-1)?.depends_on, [`source-${ids.at(-1)}`]);
    assert.equal(work.state.steps.filter(item => item.status === "pending").length, 2398);
    await work.run(`write-${ids[0]}`, async () => { calls++; throw new Error("不能重复成功工作"); }, signal, callbacks);
    assert.equal(calls, 3, "重启复用已通过工作，未运行其余2398项");
    assert.match(work.state.documents?.[0].content ?? "", /doc-1199/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
