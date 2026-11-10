import { test } from "node:test";
import assert from "node:assert/strict";
import { requirementNodeLabel } from "../web/src/requirementGraphLabel.ts";

test("模块图名称相同或已经互相包含时不重复展示", () => {
  assert.equal(requirementNodeLabel({
    name: "TRANFMAService 跨制式自侦测编排实现",
    scope: { name: "TRANFMAService 跨制式自侦测编排实现" },
  }), "TRANFMAService 跨制式自侦测编排实现");
  assert.equal(requirementNodeLabel({
    name: "TRANFMAService",
    scope: { name: "TRANFMAService 跨制式自侦测契约骨架" },
  }), "TRANFMAService 跨制式自侦测契约骨架");
});

test("仓名与模块名各有信息时仍保留两层含义", () => {
  assert.equal(requirementNodeLabel({
    name: "TRANFMAService",
    scope: { name: "跨制式自侦测编排实现" },
  }), "TRANFMAService · 跨制式自侦测编排实现");
  assert.equal(requirementNodeLabel({ name: "TRANFMAService" }),
    "TRANFMAService");
});
