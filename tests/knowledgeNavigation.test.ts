import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeAssetPath,
  extractionSkillSearch,
  readKnowledgeAssetFocus,
} from "../web/src/knowledgeNavigation.ts";

test("B1验收3：保留业务资产与 Skill 的稳定身份深链", () => {
  const business = { kind: "business" as const,
    moduleId: "order experience", assetId: "state/rule", version: 7,
    digest: "a".repeat(64) };
  const skill = { kind: "skill" as const, directory: "release-safety",
    digest: "c".repeat(64), packageDigest: "d".repeat(64) };

  for (const target of [business, skill]) {
    const path = knowledgeAssetPath(target);
    assert.ok(path.startsWith("/?"));
    assert.deepEqual(readKnowledgeAssetFocus(new URL(path, "http://local").search),
      target);
  }
});

test("残缺或未知知识深链不会误导航", () => {
  assert.equal(readKnowledgeAssetFocus("?knowledge=business&asset=state"),
    undefined);
  assert.equal(readKnowledgeAssetFocus(
    `?knowledge=business&module=orders&asset=state&version=0&digest=${"a".repeat(64)}`),
    undefined);
  assert.equal(readKnowledgeAssetFocus(
    "?knowledge=engineering&asset=x&digest=not-a-digest"), undefined);
  assert.equal(readKnowledgeAssetFocus(
    `?knowledge=skill&asset=x&digest=${"a".repeat(64)}`), undefined);
  assert.equal(readKnowledgeAssetFocus("?knowledge=unknown&asset=x"), undefined);
  assert.equal(readKnowledgeAssetFocus("?knowledge=skill"), undefined);
});

test("下单预览的正式仓库文档直接进入对应模块阅读页", () => {
  const id = `kg-${"a".repeat(64)}`;
  const url = new URL(knowledgeAssetPath({ kind: "business", moduleId: "orders", assetId: id,
    version: 1, digest: "b".repeat(64) }), "http://local");
  assert.equal(url.searchParams.get("kbPage"), "module");
  assert.equal(url.searchParams.get("kbModule"), "business:orders");
  assert.equal(url.searchParams.get("knowledgeDocument"), id);
  assert.equal(readKnowledgeAssetFocus(url.search), undefined);
});


test("B6验收：管理员和开发者均有独立的一级知识库入口，团队资产视图已拆散", () => {
  const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  const nav = app.slice(app.indexOf('<SidebarContent aria-label="视图切换"'), app.indexOf('</SidebarContent>'));
  const sections = nav.split('</> : <>');
  assert.equal(sections.length, 2, "侧栏仍分管理员与开发者两套");
  // #447 拍板:知识库是知识与团队资产的唯一一级入口,侧栏不再并列「团队资产」
  // (原断言要求两个按钮并存,是收口前的旧口径)。
  for (const section of sections) {
    assert.match(section, /<NavButton view="library"[^>]+label="知识库"/);
    assert.match(section, /<NavButton view="answers"[^>]+label="知识问答"/);
    assert.doesNotMatch(section, /<NavButton view="knowledge"/);
  }
  // B6（2026-10 团队资产视图拆散）：经验进知识库，工作流只在配置中心，使用效能进交付分析。
  assert.doesNotMatch(app, /experience=1|team-assets-tabs|selectTeamAssetTab|<MemoryBoard|KnowledgeInsightsBoard|<WorkflowAssetWorkspace/,
    "App 不再有团队资产页签、经验旧深链或重复的工作流/效能页面");
  assert.match(app, /\/configuration\?tab=workflows/, "发起页「编辑工作流」改跳配置中心");
  const library = readFileSync(new URL("../web/src/KnowledgeLibrary.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(library, /团队经验与维护|onManage/, "＋新增菜单不再挂团队经验与维护");
  assert.equal(library.match(/className="knowledge-hub-add-option"/g)?.length, 2, "＋新增菜单只有研究知识、导入 Skill 两项");
  assert.match(library, /<KnowledgeExperienceCapsule [^\n]*onClick=\{\(\) => navigate\("experience"\)\} \/>/, "知识库页头的团队经验与知识任务同款状态卡（2026-10-08 用户选定）");
  assert.match(library, /route\.page === "experience" && [^\n]*<MemoryBoard onOpenTask=\{onOpenTask\} \/>/, "团队经验页就在知识库内");
  const delivery = readFileSync(new URL("../web/src/DeliveryAnalytics.tsx", import.meta.url), "utf8");
  assert.match(delivery, /\["knowledge", "知识使用效能"\]/, "使用效能是交付分析的一个页签");
});


test("领域与组件的两个方法均使用现有阅读页，导航清除旧任务并保留页面参数", () => {
  const current = "?kbPage=research&kbKind=domain&kbModule=business%3Atrade&kbTask=dkx-old&kbReview=1&knowledgeDocument=kd-old&theme=cloud";
  for (const kind of ["domain", "component", "component-analysis"] as const) {
    const search = extractionSkillSearch(current, kind), query = new URLSearchParams(search);
    assert.equal(query.get("kbPage"), "module");
    assert.equal(query.get("kbModule"), "platform");
    assert.equal(query.get("knowledgeDocument"), `platform-skill-${kind}`);
    assert.equal(query.get("theme"), "cloud");
    for (const key of ["kbKind", "kbTask", "kbReview"]) assert.equal(query.has(key), false, key);
    assert.equal(extractionSkillSearch(search, kind), search);
  }
});

test("B1验收1：任务和配置链接打开当前阅读页，不经过旧页面", () => {
  for (const filename of ["KnowledgeFootprint", "ComponentKnowledgeCheck"]) {
    const source = readFileSync(new URL(`../web/src/${filename}.tsx`, import.meta.url), "utf8");
    assert.match(source, /kbPage=module&kbModule=unassigned&knowledgeDocument=/);
  }
  const config = readFileSync(new URL("../web/src/ComponentRepositories.tsx", import.meta.url), "utf8");
  assert.match(config, /kbPage=module&kbModule=engineering/);
});
