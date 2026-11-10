import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("web/src/LaunchWorkspace.tsx"), "utf-8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const businessSource = readFileSync(
  resolve("web/src/BusinessModuleLibrary.tsx"), "utf-8");
const pickerSource = readFileSync(
  resolve("web/src/RepositoryTechnologyPicker.tsx"), "utf-8");
const apiSource = readFileSync(resolve("web/src/api.ts"), "utf-8");

test("自动匹配知识必须展示逐项清单和匹配依据，不能退回只显示数量", () => {
  // #229 去 legacy 后区块类名退役,锚改用区头文案(文案受控不变)。
  const start = source.indexOf("仅展示业务知识与平台团队 Skill");
  const end = source.indexOf("</details>}", start);
  assert.ok(start >= 0 && end > start, "找不到发起页知识区");
  const section = source.slice(start, end);

  assert.match(section, /matchingModuleKnowledge\.map/);
  assert.match(section, /matchingTeamSkills\.map/);
  assert.match(source, /命中依据/);
  assert.match(source, /查看全文/);
  assert.doesNotMatch(section, /type="checkbox"/,
    "知识名单只用于核对，不能偷偷恢复手工勾选");
});

test("发起页展示知识库已同步保留的模块文档，仓内运行规则仍由 Agent 按需读取", () => {
  assert.match(source, /平台管理的本任务知识/);
  assert.match(source,
    /仅展示业务知识与平台团队 Skill/);
  // #229 去 legacy 后分组头带工具类,锚放宽到"header 内的分组标题"。
  assert.match(source, /<header[^>]*><strong[^>]*>业务知识<\/strong>/);
  assert.match(source, /<header[^>]*><strong[^>]*>平台团队 Skill<\/strong>/);

  // 边界注记的排版随 #229 工具类化,消费其文案锚即可(下方已有)。
  assert.match(source,
    /下单页自动带入知识库已同步并保留的模块文档与平台 Skill/);
  assert.match(source,
    /AGENTS\.md[\s\S]*其他未纳入知识库的项目规则[\s\S]*Agent 运行时自行读取/);
  assert.equal(source.match(/AGENTS\.md/g)?.length, 1,
    "AGENTS.md 只能出现在低强调边界说明中，不能成为清单项或独立卡片");
  assert.doesNotMatch(source, /仓库原生能力/);
  assert.doesNotMatch(source, /className="launch-git-context"/);
  assert.doesNotMatch(source, /RepositorySkillPicker/);

  const contractStart = apiSource.indexOf(
    "export interface LaunchKnowledgePreview {");
  const contractEnd = apiSource.indexOf("\n}\n\nexport async function", contractStart);
  assert.ok(contractStart >= 0 && contractEnd > contractStart,
    "找不到发起页知识预览契约");
  const contract = apiSource.slice(contractStart, contractEnd);
  assert.match(contract, /business_knowledge:/);
  assert.doesNotMatch(contract, /engineering_knowledge:/);
  assert.match(contract, /team_skills:/);
  assert.doesNotMatch(contract, /repository_skills|platform_capabilit/,
    "仓库原生 Skill 与运行时平台能力不能混入可见知识清单");

  // MFC-033 后仓库输入按 repo.enabled 裁字段:固定仓部署不许把草稿
  // 旧仓暗带进预览/提交。匹配条件语义不变,但表达式带了开关。
  assert.match(source, /repos: repoFieldsEnabled\s*\n?\s*\? repos\.map/,
    "仓库仍须保留为平台知识的匹配条件(按 repo.enabled 裁剪)");
  assert.match(source, /repositoryProfiles:/,
    "语言技术画像仍须保留为平台工程知识的匹配条件");
});

test("知识多时清单内部滚动，不把发起页无限撑长", () => {
  // 契约随 #229 迁到清单壳的工具类上(max-h 限高 + 内部滚动)。
  assert.match(source, /max-h-\[410px\] overflow-auto/);
});

test("清单行是真实深链，创建时绑定权威指纹且变化后强制刷新", () => {
  // 行壳类名退役后,锚对准知识行组件的深链锚点(<a> + href 直传)。
  assert.match(source, /<a className="grid w-full min-h-\[62px\]/);
  assert.match(source, /href=\{href\}/);
  assert.match(source, /href=\{knowledgeAssetPath\(/);
  assert.match(source,
    /knowledgePreviewDigest: knowledgePreview\?\.selection_digest/);
  assert.match(source,
    /setKnowledgePreviewKey\(""\)[\s\S]*setKnowledgePreviewRefresh/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /setTimeout\([\s\S]*getLaunchKnowledgePreview/);
});

test("查看全文前保存技术画像草稿，返回根路径恢复来源视图", () => {
  assert.match(source, /repositoryTechnologies\?: RepositoryTechnologyDraft\[\]/);
  assert.match(source,
    /repositoryTechnologies: repositoryTechnologies\.map/);
  assert.match(pickerSource,
    /草稿代表“本单已经采用”的选择[\s\S]*if \(current\) return/);
  assert.match(appSource,
    /history\.replaceState\(appHistoryState\(view/);
  assert.match(appSource,
    /const restoredView = viewFromHistoryState\(event\.state\)/);
  assert.match(appSource,
    /history\.pushState\(appHistoryState\("environments"\), "",\s*`\/configuration\?tab=workflows/,
    "编辑工作流改去配置中心，并压入历史，后退能回到来源视图");
  assert.match(appSource,
    /else if \(\/\^\\\/help[\s\S]*history\.pushState\(appHistoryState\(next/,
    "从帮助页进入根视图也必须记录目标，前进不能掉回角色默认页");
});

test("仓库技术栈是新任务必填项，直接跟随交付仓且不能藏在按需配置里", () => {
  const picker = source.indexOf("<RepositoryTechnologyPicker");
  const advanced = source.indexOf('<details className="group col-span-full');
  assert.ok(picker >= 0 && advanced > picker,
    "技术栈选择应在交付定位中先出现，不能藏进按需配置");
  assert.match(source, /repositoryTechnologyBlocked/);
  assert.match(source, /每个代码仓至少选择一种技术栈/);
  assert.match(pickerSource, /选择即生效，无需再次确认/);
  assert.doesNotMatch(pickerSource, /确认技术栈<\/button>/);
  assert.doesNotMatch(pickerSource, /暂不确定，也继续/);
  assert.match(pickerSource, /本单仍采用你刚选的结果/);
});

test("历史全文使用响应版本元数据，进入帮助前记住来源视图", () => {
  assert.match(businessSource,
    /title: value\.asset\.title, content: value\.content/,
    "历史正文不能套用当前目录行的标题");
  assert.match(businessSource,
    /value\.asset\.digest !== expected\.digest[\s\S]*value\.asset\.version !== expected\.version/,
    "正文、版本和发布指纹必须同时对拍");
  assert.match(appSource,
    /if \(next === "help"\)[\s\S]*history\.replaceState\(appHistoryState\(view,[\s\S]*history\.pushState\(appHistoryState\("help"\)/,
    "进入帮助前必须把来源视图写回当前历史项");
});
