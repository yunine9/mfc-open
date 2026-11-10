/**
 * 发起态卡壳与协作域按钮收编锚点(#254):
 * - RepositorySkillPicker launch 分支卡片壳:launch-form-section 的规则随
 *   换装删除、类名却还在拼(卡壳丢失)。壳直译成 utilities(与
 *   LaunchWorkspace 的 SECTION 词典同口径),launch-form-section 类退役;
 * - 裸 button 收编:Composer/RepositorySkillPicker/GitDiff 换 shadcn
 *   Button(运行时带 data-slot="button")。GitDiff 的 .diff-fold 折叠条
 *   是 diff 渲染机构的一部分,皮由 legacy/studio CSS 承担且被
 *   reviewWorkspaceLayout 的 CSS 锚定,记录不动(#253 领地)。
 * 渲染冒烟走根侧 renderToStaticMarkup(workflowLibraryUi 同款装载);
 * 收编进度用源码扫描(issueUiContracts 同款)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";

// 根测试运行器按 classic JSX 装载 web 组件(uiDialogSmoke 用例同款)。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { RepositorySkillPicker, EMPTY_REPOSITORY_SKILL_PICKER_STATE } =
  await import("../web/src/RepositorySkillPicker.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const src = (path: string) =>
  readFileSync(join(here, "..", "web", "src", path), "utf-8");

function renderPicker(presentation: "launch" | "decision"): string {
  return renderToStaticMarkup(React.createElement(RepositorySkillPicker, {
    repositories: ["https://example.com/demo.git"],
    presentation,
    state: EMPTY_REPOSITORY_SKILL_PICKER_STATE,
  }));
}

test("launch 分支卡片壳:壳 utilities 在位,launch-form-section 类退役", () => {
  const html = renderPicker("launch");
  assert.doesNotMatch(html, /launch-form-section/,
    "规则已删的死类不得再拼上(卡壳丢失根因)");
  // 与 LaunchWorkspace SECTION 词典同口径:padding/border/radius/bg 齐全。
  assert.match(html,
    /min-w-0 rounded-lg border border-line px-\[18px\] pt-\[17px\] pb-\[18px\] bg-\[color-mix\(in_srgb,var\(--surface-soft\)_72%,var\(--surface\)\)\]/,
    "launch 态能力读取卡片必须有完整卡壳(padding/border/radius/bg)");
  assert.match(html, /repository-skills-launch/, "launch 摆位类保留");
});

test("decision 分支不带 launch 卡壳,避免双层壳", () => {
  const html = renderPicker("decision");
  assert.doesNotMatch(html, /launch-form-section/);
  assert.doesNotMatch(html, /px-\[18px\] pt-\[17px\]/,
    "decision 卡有自己的皮,不叠 launch 壳 utilities");
});

test("读取 Skill 走 shadcn Button(data-slot=\"button\")", () => {
  const html = renderPicker("launch");
  assert.match(html, /data-slot="button"/, "扫描入口必须是 shadcn Button");
  assert.match(html, /读取 Skill/, "文案保留");
});

test("裸 button 清零:Composer 与 RepositorySkillPicker 无裸 button", () => {
  for (const path of ["Composer.tsx", "RepositorySkillPicker.tsx"]) {
    assert.doesNotMatch(src(path), /<button[\s>]/,
      `${path} 仍有裸 button,应换 shadcn Button`);
  }
});

test("裸 button 清零:GitDiff 仅存 diff-fold 一处(记录不动,归 #253)", () => {
  const source = src("GitDiff.tsx");
  const rawButtons = source.match(/<button[\s>]/g) ?? [];
  assert.equal(rawButtons.length, 1,
    "GitDiff 只允许 .diff-fold 一处裸 button(折叠条属 diff 渲染机构)");
  const at = source.indexOf("<button");
  const line = source.slice(source.lastIndexOf("\n", at) + 1,
    source.indexOf("\n", at));
  assert.match(line, /diff-fold/, "裸 button 只能是 diff-fold 折叠条");
});
