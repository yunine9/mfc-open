import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchBusinessModuleKnowledge,
  normalizeLaunchKnowledgeCatalog,
} from
  "../web/src/launchKnowledgeModel.ts";

test("发起页知识目录容忍旧字段与坏记录，不让单项数据拖垮整页", () => {
  const catalog = normalizeLaunchKnowledgeCatalog({
    team_skills: [
      { path: "review/SKILL.md", name: "review", nature: "engineering",
        technologies: ["java"] },
      { path: "review/SKILL.md", name: "重复 Skill" },
      { path: "legacy/SKILL.md", name: "未治理历史 Skill" },
      { path: "business/SKILL.md", name: "缺业务模块",
        nature: "business" },
      { name: "没有路径" },
    ],
  });

  assert.deepEqual(catalog.skills, [{
    path: "review/SKILL.md",
    name: "review",
    description: "",
    nature: "engineering",
    business_module_ids: [],
    repositories: [],
    technologies: ["java"],
  }]);
});

test("发起页只列出已选模块里真正适用于当前仓库的知识", () => {
  const modules = [{
    id: "orders",
    name: "订单域",
    knowledge: [
      { id: "common", title: "订单状态", summary: "通用状态约束",
        when_to_use: "修改订单状态时", form: "document" as const,
        repositories: [], version: 2 },
      { id: "server", title: "服务端排障", summary: "服务端专用",
        when_to_use: "定位服务端问题时", form: "skill" as const,
        repositories: ["https://code.example/orders-server.git"], version: 1 },
      { id: "web", title: "前端规范", summary: "前端专用",
        when_to_use: "修改页面时", form: "rule" as const,
        repositories: ["https://code.example/orders-web.git"], version: 4 },
    ],
  }, {
    id: "payment", name: "支付域", knowledge: [{
      id: "refund", title: "退款", summary: "退款知识",
      when_to_use: "处理退款时", form: "document" as const,
      repositories: [], version: 1,
    }],
  }];

  const matched = matchBusinessModuleKnowledge(modules, ["orders"],
    ["https://code.example/orders-server"]);

  assert.deepEqual(matched.map((item) => ({
    id: item.id, module: item.module_name,
  })), [
    { id: "common", module: "订单域" },
    { id: "server", module: "订单域" },
  ]);
});
