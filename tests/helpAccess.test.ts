import assert from "node:assert/strict";
import test from "node:test";
import {
  filterVisibleHelpItems,
  resolveVisibleHelpItem,
  visibleHelpItemsById,
  type AudienceScopedHelpItem,
} from "../web/src/helpAccess.ts";

const ARTICLES = [
  { id: "shared", audience: "所有人" },
  { id: "developer-only", audience: "开发成员" },
  { id: "admin-only", audience: "管理员" },
] as const satisfies readonly AudienceScopedHelpItem[];

test("帮助文章可见性在目录层按角色收口", () => {
  assert.deepEqual(
    filterVisibleHelpItems(ARTICLES, "developer").map((item) => item.id),
    ["shared", "developer-only"],
  );
  assert.deepEqual(
    filterVisibleHelpItems(ARTICLES, "admin").map((item) => item.id),
    ["shared", "admin-only"],
  );
});

test("不可见或不存在的直链回退到该角色第一篇可见文章", () => {
  assert.equal(
    resolveVisibleHelpItem(ARTICLES, "admin-only", "developer")?.id,
    "shared",
  );
  assert.equal(
    resolveVisibleHelpItem(ARTICLES, "developer-only", "admin")?.id,
    "shared",
  );
  assert.equal(
    resolveVisibleHelpItem(ARTICLES, "missing", "admin")?.id,
    "shared",
  );
  assert.equal(
    resolveVisibleHelpItem(ARTICLES, "admin-only", "admin")?.id,
    "admin-only",
  );
});

test("快捷入口和相关推荐只保留精确匹配的可见文章", () => {
  assert.deepEqual(
    visibleHelpItemsById(
      ARTICLES,
      ["developer-only", "missing", "shared", "admin-only"],
      "admin",
    ).map((item) => item.id),
    ["shared", "admin-only"],
  );
});
