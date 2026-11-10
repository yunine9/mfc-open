/**
 * 责任人缺省规则(ADR-0031)纯函数契约:模块指向谁,问题就流向谁——
 * 未选模块置空;未手选跟随模块责任人(可指派才填,换模块跟随);
 * 手选即冻结。登记页的提交校验与自动填全走这一个函数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAssignee } from "../web/src/issues/assigneeDefault.ts";

test("未选模块置空;模块责任人可指派时自动填、换模块跟随", () => {
  assert.equal(resolveAssignee({
    manualPick: "", moduleOwner: undefined, ownerAssignable: false,
  }), "", "未选模块:置空,不回退登记人自己(指派是显式移交)");
  assert.equal(resolveAssignee({
    manualPick: "", moduleOwner: "dev", ownerAssignable: true,
  }), "dev", "选了模块且未手选:自动填模块责任人");
  // 自动填的是缺省不是意愿:换了模块,跟着新模块的责任人走。
  assert.equal(resolveAssignee({
    manualPick: "", moduleOwner: "dev", ownerAssignable: true,
  }), "dev");
  assert.equal(resolveAssignee({
    manualPick: "", moduleOwner: "dev2", ownerAssignable: true,
  }), "dev2");
});

test("模块责任人是管理员/停用账号(不在候选)不自动填,保持置空", () => {
  assert.equal(resolveAssignee({
    manualPick: "", moduleOwner: "boss", ownerAssignable: false,
  }), "", "自动填一个没人能推进的会话,宁缺勿错——置空让登记人改选");
});

test("手选即冻结:换模块不再覆盖用户的选择", () => {
  assert.equal(resolveAssignee({
    manualPick: "dev2", moduleOwner: "dev", ownerAssignable: true,
  }), "dev2", "手选优先于模块责任人");
  assert.equal(resolveAssignee({
    manualPick: "dev2", moduleOwner: undefined, ownerAssignable: false,
  }), "dev2", "手选后清掉模块也不丢用户的选择");
});
