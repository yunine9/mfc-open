import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeAnswerCitations } from "../src/knowledgeAnswerCitations.ts";
import { parseKnowledgeAnswer } from "../src/knowledgeAnswerRunner.ts";

test("正文、强调与表格中的约定引用被提取，重复引用保留供调用方校验", () => {
  assert.deepEqual(knowledgeAnswerCitations("条件。[原文](#evidence-e1)\n**[另一份](#evidence-ev-abc_12)**\n| 依据 |\n| [同一份](#evidence-e1) |"), ["e1", "ev-abc_12", "e1"]);
});

test("代码块、未闭合代码块和行内代码中的引用不当正文依据", () => {
  for (const markdown of [
    "```text\n[原文](#evidence-e1)\n```",
    "~~~text\n[原文](#evidence-e1)\n~~~",
    "````text\n```\n[原文](#evidence-e1)\n```\n````",
    "```text\n[原文](#evidence-e1)",
    "`[原文](#evidence-e1)`",
    "``含有`符号 [原文](#evidence-e1)``",
    "`跨行\n[原文](#evidence-e1)\n代码`",
  ]) assert.deepEqual(knowledgeAnswerCitations(markdown), [], markdown);
  assert.deepEqual(knowledgeAnswerCitations("```text\n[示例](#evidence-e1)\n```\n实际结论。[正文](#evidence-e2)"), ["e2"]);
  assert.deepEqual(knowledgeAnswerCitations("未闭合字面符号 `，随后[正文](#evidence-e2)"), ["e2"]);
});

test("转义链接与图片不算引用，偶数转义和转义感叹号后的真实链接仍有效", () => {
  assert.deepEqual(knowledgeAnswerCitations("\\[原文](#evidence-e1) ![图片](#evidence-e2) [正文]\\(#evidence-e3)"), []);
  assert.deepEqual(knowledgeAnswerCitations("\\\\[正文](#evidence-e1) \\![正文](#evidence-e2)"), ["e1", "e2"]);
  assert.deepEqual(knowledgeAnswerCitations("[普通](https://example.test) [伪造](#evidence-e1.bad)"), []);
});

test("纯代码或图片引用不能绕过回答校验，代码中伪造编号仍拒绝", () => {
  const evidence = [{ id: "e1" }] as any;
  for (const markdown of ["必须使用。\n```text\n[原文](#evidence-e1)\n```", "必须使用。\\[原文](#evidence-e1)", "必须使用。![原文](#evidence-e1)"])
    assert.throws(() => parseKnowledgeAnswer(JSON.stringify({ markdown, evidence_ids: ["e1"], unknowns: [] }), evidence));
  const markdown = "有依据。[原文](#evidence-e1)\n```text\n[伪造](#evidence-other)\n```";
  assert.throws(() => parseKnowledgeAnswer(JSON.stringify({ markdown, evidence_ids: ["e1"], unknowns: [] }), evidence));
});
