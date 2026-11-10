import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fatalToolExecutionError,
  userFacingModelFailure,
  validateAskUserQuestionInput,
} from "../src/sessionDriver.ts";

test("输出上限截断的问题卡会显式停机，不伪装成继续推进", () => {
  assert.match(fatalToolExecutionError(
    "AskUserQuestion",
    "Tool call was not executed because assistant hit the output token limit",
    true,
  ) ?? "", /重跑续推.*不会丢失/);
  assert.equal(fatalToolExecutionError(
    "Edit", "old text not found", true), undefined,
    "普通工具失败应留给 Agent 自行修正，不能扩大成任务停机");
  assert.equal(fatalToolExecutionError(
    "AskUserQuestion",
    "Tool call was not executed because assistant hit the output token limit",
    false,
  ), undefined);
});

test("模型额度耗尽只展示恢复时间和可执行动作，不把网关 JSON 糊到任务卡", () => {
  const raw = "429 {\"type\":\"error\",\"error\":{"
    + "\"type\":\"rate_limit_error\",\"code\":\"1308\","
    + "\"message\":\"[已达到 5 小时的使用上限。您的限额将在 "
    + "2026-09-01 03:34:40 重置。]\"},"
    + "\"request_id\":\"internal-id\"}";
  const message = userFacingModelFailure(raw);
  assert.match(message, /2026-09-01 03:34:40.*重跑续推.*不会丢失/);
  assert.doesNotMatch(message, /request_id|rate_limit_error|internal-id/);
  assert.equal(userFacingModelFailure("500 upstream exploded"),
    "500 upstream exploded", "未知模型故障仍保留原文供排查");
});

test("残缺选择题不发送给用户，开放题和完整多题卡可用", () => {
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "如何处理?", options: ["只剩一个"] }],
  }) ?? "", /只有 1 个选项/);
  assert.match(validateAskUserQuestionInput({
    questions: [{
      question: "如何处理?",
      options: ["采用推荐"],
      "另一个选项": "被模型误放成对象字段",
    }],
  }) ?? "", /不支持字段/);
  assert.equal(validateAskUserQuestionInput({
    questions: [{ question: "请直接说明你的期望" }],
  }), undefined);
  assert.equal(validateAskUserQuestionInput({
    context: "当前配置会影响短信失败后的重试与记账。",
    questions: [
      { question: "范围?", options: ["仅 SMS", "全部渠道"],
        recommended: "全部渠道" },
      { question: "次数?", options: ["三次", "四次"], recommended: "三次" },
    ],
  }), undefined);
  assert.match(validateAskUserQuestionInput({
    context: "",
    questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
  }) ?? "", /context 必须是非空/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
    scratchpad: "git apply 后再问用户",
  }) ?? "", /问题卡含不支持字段/);
});

test("推荐协议:选项题必须带 recommended 且命中一个选项,开放题不得带", () => {
  // 命中放行;trim 语义:推荐与选项两边的首尾空白都不参与比对。
  assert.equal(validateAskUserQuestionInput({
    questions: [{
      question: "现象是必现还是偶发?",
      options: ["必现", "偶发"],
      recommended: "偶发",
    }],
  }), undefined);
  assert.equal(validateAskUserQuestionInput({
    questions: [{
      question: "现象是必现还是偶发?",
      options: ["必现 ", " 偶发"],
      recommended: "  偶发  ",
    }],
  }), undefined);
  // 缺失打回:recommended 缺席、空串、纯空白都算没给。
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
  }) ?? "", /第 1 题缺少推荐项/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "" }],
  }) ?? "", /第 1 题缺少推荐项/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "   " }],
  }) ?? "", /第 1 题缺少推荐项/);
  // 错配打回:文案必须逐字命中,前缀/近似都不算。
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "继续执行" }],
  }) ?? "", /第 1 题的推荐项不在选项中/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "暂停" }],
  }) ?? "", /第 1 题的推荐项不在选项中/);
  // 自由文本题误带打回。
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "请直接说明你的期望", recommended: "有" }],
  }) ?? "", /第 1 题是自由作答题.*不能带 recommended/);
  // 多题卡逐题独立:一题缺推荐整卡打回,文案点名题号。
  assert.match(validateAskUserQuestionInput({
    questions: [
      { question: "范围?", options: ["仅 SMS", "全部渠道"],
        recommended: "全部渠道" },
      { question: "次数?", options: ["三次", "四次"] },
    ],
  }) ?? "", /第 2 题缺少推荐项/);
});

test("澄清卡形状:purpose 只认两个值;annotation_ids 只能跟着 clarification,且非空无重复", () => {
  assert.equal(validateAskUserQuestionInput({
    purpose: "clarification", annotation_ids: ["an-1"],
    questions: [{ question: "空值指入参还是返回值?" }],
  }), undefined, "合规的追问卡放行");
  assert.match(validateAskUserQuestionInput({
    purpose: "approval", questions: [{ question: "请说明" }],
  }) ?? "", /purpose 只能是 confirmation 或 clarification/);
  assert.match(validateAskUserQuestionInput({
    purpose: "confirmation", annotation_ids: ["an-1"],
    questions: [{ question: "请说明" }],
  }) ?? "", /annotation_ids 只能用于 clarification/, "确认卡不能挂意见 ID 冒充追问");
  assert.match(validateAskUserQuestionInput({
    purpose: "clarification", annotation_ids: [],
    questions: [{ question: "请说明" }],
  }) ?? "", /非空、无重复/);
  assert.match(validateAskUserQuestionInput({
    purpose: "clarification", annotation_ids: ["an-1", "an-1"],
    questions: [{ question: "请说明" }],
  }) ?? "", /非空、无重复/);
  assert.match(validateAskUserQuestionInput({
    purpose: "clarification", annotation_ids: ["an-1", " "],
    questions: [{ question: "请说明" }],
  }) ?? "", /非空、无重复/);
});
