import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const apiSource = readFileSync(resolve("web/src/api.ts"), "utf-8");
// 2026-09-02:资产管理从 KnowledgeFlywheel(现在只剩只读效能)搬到
// KnowledgeAssets 的主从版式,双指纹对拍也跟着搬。断言跟着实现走,
// 守的仍是同一条契约:没对拍过的正文一个字都不许渲染。
const panelSource = readFileSync(
  resolve("web/src/KnowledgeAssets.tsx"), "utf-8");

test("Skill 正文接口前端契约同时携带正文与整包指纹", () => {
  assert.match(apiSource,
    /interface HostSkillDocument \{[\s\S]*digest: string;[\s\S]*package_digest: string;/);
});

test("Skill 清单深链同时对拍正文与整包后才展示全文", () => {
  // 深链与手点共用一个 loadDocument 入口,三道闸都在里面:
  // 展开前先比货架摘要,读回来再比货架、再比清单。
  assert.match(panelSource,
    /current\.digest !== expected\.digest\s*\|\| packageDigestOf\(current\) !== expected\.packageDigest/,
    "展开前必须先确认货架上就是清单那一版");
  assert.match(panelSource,
    /value\.digest !== current\.digest\s*\|\| value\.package_digest !== packageDigestOf\(current\)/,
    "读回来的正文要与货架摘要对得上");
  assert.match(panelSource,
    /value\.digest !== expected\.digest\s*\|\| value\.package_digest !== expected\.packageDigest/,
    "读取期间清单版本变了也要拦下");
  assert.match(panelSource,
    /const verified = focus && document\?\.digest === focus\.digest\s*&& document\.package_digest === focus\.packageDigest/,
    "「已对拍」的判定必须两个指纹都相等");
  // 2d605991 起 Skill 正文按 Markdown 排版(原 <DocBlock> 等宽原样),渲染件换了,
  // 守的仍是"documentReady 之前一个字都不渲染"这道闸。
  assert.match(panelSource,
    /\{document && documentReady\s*\n\s*\? <Markdown text=\{document\.content\} \/>/,
    "未完成双指纹核对时不能先渲染正文");
  // 对拍没过时页面得说"已停止展开",不能永远转圈假装还在读。
  assert.match(panelSource, /blocked\s*\n?\s*\? <p className="text-sm\/relaxed text-muted-foreground">已停止展开/);
});
