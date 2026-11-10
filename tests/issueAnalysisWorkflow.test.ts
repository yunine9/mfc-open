/**
 * 问题分析工作流(ADR-0005)的机械面单测:
 * - submit_analysis 的报告四章节门票(missingAnalysisSections);
 * - 货架 skill 的问题会话匹配口径(knowledgeMatchesIssueSession,
 *   materializeHostSkills 的 knowledgeScope="issue");
 * - 问题域知识上下文(issueKnowledgeContext)与编排层技能源
 *   (assets/issue-skills/issue-analysis)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYSIS_REPORT_SECTIONS,
  missingAnalysisSections,
} from "../src/issueFlow/tools.ts";
import { issueKnowledgeContext } from "../src/issueFlow/service.ts";
import { SKILL_SOURCE_DIR } from "../src/issueFlow/prompt.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";
import {
  knowledgeMatchesIssueSession,
} from "../src/knowledgeAssetModel.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

test("分析报告四章节门票:缺章节点名打回,齐全放行,标题级别宽容", () => {
  const full = [
    "# 问题分析:登录超时", "连接池耗尽致登录超时,方案:超时回收。",
    "## 问题现象", "压测环境登录超时",
    "## 问题根因", "连接池耗尽", "## 修改方案", "超时回收",
    "### 置信度", "高", "",
  ].join("\n");
  assert.deepEqual(missingAnalysisSections(full), [],
    "四章节齐全(标题级别不限)必须放行");
  assert.deepEqual(
    missingAnalysisSections("# 分析\n\n根因:连接池耗尽,但没分章节。\n"),
    [...ANALYSIS_REPORT_SECTIONS],
    "章节淹没在正文里必须整单打回");
  assert.deepEqual(
    missingAnalysisSections("# 分析\n## 问题根因\nx\n## 置信度\ny\n"),
    ["问题现象", "修改方案"],
    "缺哪几章点名哪几章");
  assert.deepEqual(
    missingAnalysisSections("# 分析\n正文提到结论、修改方案与置信度。\n"),
    [...ANALYSIS_REPORT_SECTIONS],
    "正文里出现章节名字不算数——必须撞在标题行上");
});

test("问题会话知识口径:通用工程豁免,作用域照过滤,未分类不进", () => {
  const context = {
    repositories: ["https://git.example.com/pay.git"],
    businessModuleIds: ["pay-core"],
  };
  const meta = (over: Partial<Parameters<typeof
    knowledgeMatchesIssueSession>[0]>) => ({
    nature: "engineering" as const,
    form: "skill" as const,
    business_module_ids: [],
    repositories: [],
    technologies: ["java"],
    ...over,
  });
  // 未限定仓库/模块的工程知识=团队通用方法,豁免进所有问题会话
  // (通用问题定位 skill 就以这个形态发布)。
  assert.equal(knowledgeMatchesIssueSession(meta({}), context), true);
  // 未分类维持"不进",豁免不是无标签后门。
  assert.equal(knowledgeMatchesIssueSession(
    meta({ nature: "unclassified", technologies: [] }), context), false);
  // 业务知识按模块过滤;限定仓库的工程知识按仓过滤(地址归一)。
  assert.equal(knowledgeMatchesIssueSession(
    meta({ nature: "business", technologies: [],
      business_module_ids: ["pay-core"] }), context), true);
  assert.equal(knowledgeMatchesIssueSession(
    meta({ nature: "business", technologies: [],
      business_module_ids: ["media-core"] }), context), false);
  assert.equal(knowledgeMatchesIssueSession(
    meta({ repositories: ["https://git.example.com/pay"] }), context), true);
  assert.equal(knowledgeMatchesIssueSession(
    meta({ repositories: ["https://git.example.com/media.git"] }),
    context), false);
});

/** 货架 fixture:每个 skill 一个目录,frontmatter 带 knowledge 字段。 */
function writeFixtureSkill(
  sourceRoot: string, name: string, knowledgeFields: string,
): void {
  mkdirSync(join(sourceRoot, name), { recursive: true });
  writeFileSync(join(sourceRoot, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 的描述\n`
    + `${knowledgeFields}---\n\n正文\n`);
}

/** 快照目录被 chmod 成只读,清理前先恢复可写(与 hostSkills 测试同款)。 */
function rmRf(path: string): void {
  const makeWritable = (dir: string): void => {
    if (!existsSync(dir)) return;
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir)) makeWritable(join(dir, entry));
  };
  try {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 清不掉就留给 scripts/clean-test-tmp.ts 的临时目录清扫。
  }
}

test("货架快照按 knowledgeScope 装载:issue 放行通用 skill,task 维持原口径", () => {
  const root = mfcTemp("mfc-issue-scope-");
  const sourceRoot = join(root, "skills");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  try {
    writeFixtureSkill(sourceRoot, "universal-localization",
      "knowledge_nature: engineering\ntechnologies: [java]\n");
    writeFixtureSkill(sourceRoot, "pay-playbook",
      "knowledge_nature: engineering\nbusiness_modules: [pay-core]\n"
        + "technologies: [java]\n");
    writeFixtureSkill(sourceRoot, "media-notes",
      "knowledge_nature: business\nbusiness_modules: [media-core]\n");
    writeFixtureSkill(sourceRoot, "untagged", "");
    const base = {
      sourceRoot,
      workspaceRoot: workspace,
      snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
      context: issueKnowledgeContext({
        repo_urls: ["https://git.example.com/pay.git"],
        module_id: "pay-core",
      } as IssueSessionState),
    };
    const issue = materializeHostSkills({ ...base, knowledgeScope: "issue" });
    assert.deepEqual(issue.names.sort(),
      ["pay-playbook", "universal-localization"],
      "issue 口径:通用工程豁免 + 模块命中的作用;媒体模块与未分类不进");
    const task = materializeHostSkills({ ...base });
    assert.deepEqual(task.names, [],
      "task 口径不变:问题会话没有技术栈画像,带 technologies 的全被过滤");
  } finally {
    rmRf(root);
  }
});

test("问题域知识上下文:关联仓清单+绑定模块,无模块不造空壳", () => {
  assert.deepEqual(issueKnowledgeContext({
    repo_urls: ["https://a.example.com/x.git", "https://b.example.com/y"],
    module_id: "pay-core",
  } as IssueSessionState), {
    repositories: ["https://a.example.com/x.git", "https://b.example.com/y"],
    technologies: [],
    businessModuleIds: ["pay-core"],
  });
  assert.deepEqual(issueKnowledgeContext({
    repo_url: "https://c.example.com/z",
  } as IssueSessionState), {
    repositories: ["https://c.example.com/z"],
    technologies: [],
    businessModuleIds: [],
  });
});

test("编排层技能源:issue-analysis 在源目录,报告模板独立成档含四章节标题", () => {
  // 2026-09-11 拍板:报告模板独立成 report-template.md(issue-analysis 与
  // guard 共用),SKILL.md 只留指针——章节锚点跟着搬进模板文件。
  const body = readFileSync(
    join(SKILL_SOURCE_DIR, "issue-analysis", "SKILL.md"), "utf-8");
  const template = readFileSync(
    join(SKILL_SOURCE_DIR, "issue-analysis", "report-template.md"), "utf-8");
  assert.match(body, /^---\nname: issue-analysis\ndescription: [^\n]+\n/,
    "frontmatter 必须带 name+description(pi 靠它进技能索引)");
  // 模板文件:四章节与写作规则的单一定义源。
  for (const section of ANALYSIS_REPORT_SECTIONS) {
    assert.match(template, new RegExp(`^## ${section}`, "m"),
      `模板必须含「${section}」章节——工具门票与技能模板要同源`);
  }
  // 知识边界纪律(#258 精简后从独立章节并入定位方法):外部 skill 只供
  // 领域知识,流程/报告格式/停机节奏归平台契约与编排层——钉语义不钉
  // 标题,章节形式随技能文档口径走。
  assert.match(body, /外部 skill/, "知识边界纪律缺主体:外部 skill 的定位声明必须在");
  assert.match(body, /流程、报告格式、停机节奏/,
    "知识边界纪律缺边界:流程/报告格式/停机节奏不由外部 skill 约定");
  assert.match(body, /report-template\.md/,
    "SKILL.md 必须指向独立模板文件(不再内嵌复述)");
  // 归一拍板(2026-09-11):一个技能提示词+一份模板,guard 分身与独立
  // 提问文件删除,关键决策章节进模板(自动档必写)。
  assert.equal(existsSync(join(SKILL_SOURCE_DIR, "issue-analysis-guard")),
    false, "分析档技能已归一,不许再有 guard 分身");
  assert.equal(existsSync(join(SKILL_SOURCE_DIR, "issue-analysis", "questioning.md")),
    false, "提问纪律已收回 SKILL.md 内联,独立文件不许回潮");
  assert.match(template, /## 关键决策/,
    "模板含条件章节「关键决策」");
  assert.match(template, /自动档[^\n]*必须写/,
    "自动档必须写关键决策(用户复盘 AI 决策的唯一入口)");
  assert.match(template, /只写选中项/,
    "关键决策只写 AI 选中的答案,未选选项不写");
  assert.match(template, /报告确认即本工作流完成/,
    "生命周期钉死:报告提交即完成,交付纪律归 issue-delivery");
  // 报告可读性纪律(2026-09-03):一句话总结先行/节名即问题/证据指针化/提交前收敛。
  assert.ok(template.indexOf("一句话总结") < template.indexOf("## 问题现象"),
    "一句话总结在所有章节之前——只读首行就能拍板");
  assert.ok(template.indexOf("## 问题根因") < template.indexOf("## 修改方案")
    && template.indexOf("## 修改方案") < template.indexOf("## 置信度"),
    "节序=现象→根因→方案→置信度,节名即问题");
  assert.match(template, /原文不进报告|原文不贴/,
    "证据指针化:日志与代码原文不进报告,出处可核即可");
  assert.match(template, /结论版/,
    "提交前收敛:submit_analysis 交的是结论版,不是过程回放");
});

