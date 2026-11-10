/**
 * 登记描述预填模板(#273):原样判定纯函数契约——模板原样、仅空白
 * 流转(编辑器序列化往返)都算未填;真实填写/清空不算。登记页靠它
 * 拦「空模板绕过必填、白跑首轮会话」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUE_DESCRIPTION_TEMPLATE,
  isUntouchedTemplate,
} from "../web/src/issues/descriptionTemplate.ts";

test("模板原样与仅空白流转都判未填(剥空白比较)", () => {
  assert.equal(isUntouchedTemplate(ISSUE_DESCRIPTION_TEMPLATE), true);
  // 编辑器序列化往返会动空白:换行归一、列表空隙增删,内容一字未动。
  assert.equal(isUntouchedTemplate(
    ISSUE_DESCRIPTION_TEMPLATE.replace(/\n/g, "\n\n")), true);
  assert.equal(isUntouchedTemplate(
    ISSUE_DESCRIPTION_TEMPLATE.replace(/[ \t]+/g, " ")), true);
  assert.equal(isUntouchedTemplate(`  ${ISSUE_DESCRIPTION_TEMPLATE}  `), true);
});

test("真实填写与清空都判已填", () => {
  assert.equal(isUntouchedTemplate(""), false);
  assert.equal(isUntouchedTemplate("   \n  "), false);
  assert.equal(isUntouchedTemplate(
    ISSUE_DESCRIPTION_TEMPLATE.replace("问题描述：", "问题描述：服务重启后持续 500")),
  false);
  assert.equal(isUntouchedTemplate(
    "## 现象\n\n服务重启后持续 500,截图如下。\n"), false);
});

test("模板只含三栏引导槽位:问题描述/触发步骤/预期结果", () => {
  for (const slot of ["问题描述", "触发步骤", "预期结果"]) {
    assert.match(ISSUE_DESCRIPTION_TEMPLATE, new RegExp(slot),
      `模板缺引导槽位: ${slot}`);
  }
  // 表单已采集与拍板删去的栏目不再进模板(#273 拍板 + 2026-10-15 精简)。
  assert.doesNotMatch(ISSUE_DESCRIPTION_TEMPLATE,
    /业务模块|网管环境|基本信息|发生时间|版本|复现概率|实际现象/);
});
