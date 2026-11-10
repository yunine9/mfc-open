import test from "node:test";
import assert from "node:assert/strict";
import { requirementDecisionContract, confirmsRequirementGraph } from "../src/requirementDecisionContract.ts";

test("分析确认卡在展示前归一自由文案，反复投影不漂移，不改原记录", () => {
  const source = { questions: [{ question: "需求分析方案确认", options: ["确认,按7单元+依赖顺序生成任务", "需要修改"], recommended: "确认,按7单元+依赖顺序生成任务" }] };
  const normalized = requirementDecisionContract(source, true) as typeof source;
  assert.deepEqual(normalized.questions[0].options, ["确认方案", "需要修改"]);
  assert.equal(normalized.questions[0].recommended, "确认方案");
  assert.deepEqual(requirementDecisionContract(normalized, true), normalized);
  assert.equal(source.questions[0].options[0], "确认,按7单元+依赖顺序生成任务");
  assert.equal(requirementDecisionContract(source, false), source);
  const clarification = { ...source, purpose: "clarification" };
  assert.equal(requirementDecisionContract(clarification, true), clarification);
  const multiple = { questions: [...source.questions, ...source.questions] };
  assert.equal(requirementDecisionContract(multiple, true), multiple);
});

test("确认判断不将否定、备注引用或历史自由文案当作拆单授权", () => {
  for (const answer of ["不确认并生成任务", "暂不确认分析结论", "不要选择确认并生成任务", "确认,按7单元+依赖顺序生成任务"]) {
    assert.equal(confirmsRequirementGraph(answer), false);
  }
  assert.equal(confirmsRequirementGraph("确认并生成任务"), true);
  assert.equal(confirmsRequirementGraph("确认分析结论"), true);
  assert.equal(confirmsRequirementGraph("确认并继续开发"), true);
  assert.equal(confirmsRequirementGraph("暂不确认并继续开发"), false);
  const source = { questions: [{ question: "处理方式", options: ["确认不生成任务", "暂不确认，生成任务前先修改"] }] };
  assert.deepEqual(requirementDecisionContract(source, true), source);
});


test("三个旧确认选项与自由文案合并为一个规范选项，推荐同步归一并按首次出现排序", () => {
  const source = { purpose: "confirmation", questions: [{ question: "确认方案？",
    options: ["确认并生成任务", "确认并继续开发", "确认分析结论", "需要修改", "确认方案", "确认采用设计", "需要修改"],
    recommended: "确认分析结论" }] };
  const normalized = requirementDecisionContract(source, true) as typeof source;
  assert.deepEqual(normalized.questions[0].options, ["确认方案", "需要修改"]);
  assert.equal(normalized.questions[0].recommended, "确认方案");
  for (const answer of ["确认方案", "确认并生成任务", "确认并继续开发", "确认分析结论"]) {
    assert.equal(confirmsRequirementGraph(`  ${answer}  `), true);
  }
  for (const answer of ["确认不修改", "确认暂缓", "确认取消", "确认拒绝"]) {
    assert.equal(confirmsRequirementGraph(answer), false);
    const card = { questions: [{ question: "方案？", options: [answer, "需要修改"] }] };
    assert.deepEqual(requirementDecisionContract(card, true), card);
  }
  const reversed = { questions: [{ question: "方案？", options: ["需要修改", "确认分析结论", "确认并继续开发"] }] };
  assert.deepEqual((requirementDecisionContract(reversed, true) as typeof reversed).questions[0].options, ["需要修改", "确认方案"]);
});

test("澄清、多题、无选项及非分析卡保持原记录", () => {
  const item = { question: "方案？", options: ["确认并生成任务", "确认分析结论"] };
  for (const card of [{ purpose: "clarification", questions: [item] }, { questions: [item, item] },
    { questions: [{ question: "补充说明" }] }, { questions: [] }, {}]) {
    assert.equal(requirementDecisionContract(card, true), card);
  }
  assert.equal(requirementDecisionContract({ questions: [item] }, false).questions instanceof Array, true);
});
