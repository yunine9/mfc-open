/**
 * mdHtml 转换器单元矩阵(#271 修订版):markdown→HTML 方向在 node 直测;
 * HTML→markdown 方向依赖浏览器 DOMParser,由真浏览器 E2E(登记页粘贴
 * 断言)与契约钉覆盖。硬约束:模板 md 经转换不丢字(原样拦截剥空白
 * 比较依赖它)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToEditorHtml } from "../web/src/issues/mdHtml.ts";
import { ISSUE_DESCRIPTION_TEMPLATE } from "../web/src/issues/descriptionTemplate.ts";

const strip = (html: string) => html.replace(/<[^>]+>/g, "");

test("模板逐字保留:转换只加壳不动字(原样拦截依赖)", () => {
  const html = markdownToEditorHtml(ISSUE_DESCRIPTION_TEMPLATE);
  // 片段清单从常量逐行派生,不重述模板文案:模板再改本测试零维护,
  // 「转换不丢字」的保证照旧(空行转分段,有字行为最小断言单元)。
  const fragments = ISSUE_DESCRIPTION_TEMPLATE.split("\n")
    .map((line) => line.trim()).filter(Boolean);
  assert.ok(fragments.length >= 3, "模板至少三栏,派生片段不应为空");
  for (const fragment of fragments) {
    assert.ok(strip(html).includes(fragment), `模板片段丢失: ${fragment}`);
  }
  assert.match(html, /<p>/);
});

test("子集映射:标题/粗斜码/链接/图片引用/列表/引用/代码块", () => {
  const html = markdownToEditorHtml(
    "# 标题\n\n**粗** *斜* `码`\n\n[文](https://x.y)\n\n![截图](issue-images/abc.png)\n\n"
    + "- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用行\n\n```\ncode line\n```",
    (src) => src === "issue-images/abc.png" ? "/issues/issue-image?path=issue-images/abc.png" : src);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<code>码<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.y">文<\/a>/);
  assert.match(html,
    /<img src="\/issues\/issue-image\?path=issue-images\/abc\.png" alt="截图">/);
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /<blockquote>引用行<\/blockquote>/);
  assert.match(html, /<pre><code>code line<\/code><\/pre>/);
});

test("段落内单换行成 <br>;空行分段", () => {
  const html = markdownToEditorHtml("第一行\n第二行\n\n第三行");
  assert.match(html, /<p>第一行<br>第二行<\/p><p>第三行<\/p>/);
});
