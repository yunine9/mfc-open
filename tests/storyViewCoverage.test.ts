import { test } from "node:test";
import assert from "node:assert/strict";
import { storyViewCoverage } from "../src/storyViewCoverage.ts";

test("五类始终保留，缺失和旧文档不自动视为不涉及或完成", () => {
  const missing = storyViewCoverage("");
  assert.equal(missing.length, 5);
  assert.ok(missing.every((view) => view.status === "待补充"));
  const legacy = storyViewCoverage("## 逻辑模型设计\n```plantuml\nclass Order\n```\n## 运行视图设计\n顺序调用");
  assert.equal(legacy[0].status, "待补充");
  assert.equal(legacy[0].classDiagram?.line, 2);
  assert.equal(legacy[2].classDiagram, undefined);
});

test("完成须有设计，略过须有依据，重复与缺失说明不能静默通过", () => {
  const story = "| 视图 | 状态 | 说明 |\n| 逻辑视图 | 已完成 | 职责已明确 |\n| 开发视图 | 已完成 | 已完成 |\n| 物理视图 | 不涉及 | 沿用现有部署，本次无变更 |\n| 进程视图 | 不涉及 | |\n## 逻辑模型设计\n### 逻辑视图\n模块职责与协作\n";
  const views = storyViewCoverage(story + "| 类图 | 不涉及 | 仅函数组合，无对象模型 |\n");
  assert.equal(views[0].status, "已完成");
  assert.equal(storyViewCoverage(story)[0].status, "待补充");
  assert.equal(views[0].line, 7);
  assert.equal(views[1].status, "待补充");
  assert.equal(views[2].status, "待补充");
  assert.equal(views[3].status, "不涉及");
  assert.match(views[3].reason, /沿用现有部署/);
  assert.equal(storyViewCoverage(story + "| 物理视图 | 不涉及 | 冲突 |\n")[3].status, "待补充");
});

test("代码中的覆盖声明不采纳，类图略过也必须明确说明", () => {
  const source = "```text\n| 物理视图 | 不涉及 | 示例 |\n```\n| 类图 | 不涉及 | 仅静态资源，无对象模型 |\n## 逻辑视图\n静态页面";
  const views = storyViewCoverage(source);
  assert.equal(views[3].status, "待补充");
  assert.match(views[0].classDiagram!.reason, /类图不涉及：仅静态资源/);
  assert.equal(storyViewCoverage("新增一行\n" + source)[0].line, views[0].line! + 1);
});

test("原 Story 章节中的显式视图段落可定位，模块图和部署图不被误标为缺失", () => {
  const source = [
    "| 逻辑视图 | 已完成 | 见 2.2.1 类图 |",
    "| 开发视图 | 已完成 | 见 2.2.1 模块架构 |",
    "| 物理视图 | 已完成 | 见 2.2.4 部署图 |",
    "#### 2.2.1 逻辑模型设计", "开发视图：仓库内代码模块", "```archify", "{}", "```",
    "逻辑视图——关键类图", "```plantuml", "class Order", "```",
    "#### 2.2.4 运行视图设计", "物理视图——部署", "```plantuml", "node Server", "```",
    "#### 2.2.5 UI交互设计", "不涉及",
  ].join("\n");
  const views = storyViewCoverage(source);
  assert.deepEqual([views[0], views[1], views[3]].map((v) => v.status), ["已完成", "已完成", "已完成"]);
  assert.equal(views[0].classDiagram?.line, 10);
  assert.equal(views[1].line, 5);
  assert.equal(views[1].endLine, 8, "模块范围不包含后面的类图段落");
  assert.equal(views[3].line, 14);
  assert.equal(views[3].endLine, 17);
  assert.equal(storyViewCoverage(source + "\n开发视图：另一份\n内容")[1].status, "待补充", "重复标记不能猜测");
  assert.equal(storyViewCoverage("| 物理视图 | 已完成 | 见其他章节 |\n普通引用物理视图：部署")[3].status, "待补充");
  const sequences = storyViewCoverage("| 进程视图 | 已完成 | 两张时序 |\n#### 运行视图设计\n进程视图：同步\n同步时序\n进程视图：查询\n查询时序");
  assert.equal(sequences[2].status, "已完成");
  assert.equal(sequences[2].line, 2);
  assert.equal(sequences[2].endLine, 6);
});

test("设计内容已完成与已完成等价，渲染状态不混入设计覆盖结论", () => {
  const source = [
    "| 进程视图 | 设计内容已完成 | 并发互斥时序见运行设计 |",
    "#### 运行视图设计", "进程视图：存储事务互斥时序", "事务 A 与事务 B 串行进入临界区",
  ].join("\n");
  const process = storyViewCoverage(source)[2];
  assert.equal(process.status, "已完成");
  assert.match(process.reason, /并发互斥时序/);
});
