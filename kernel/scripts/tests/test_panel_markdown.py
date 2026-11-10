#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""markdown 子集渲染器契约。

它只服务我们自己的模板,所以契约是"模板里出现的写法必须正确渲染,
没出现的写法必须安全退化"——绝不吞内容,也绝不把用户文本当标签。
"""

import os
import re
import sys
import unittest

TESTS = os.path.abspath(os.path.dirname(__file__))
SCRIPTS = os.path.abspath(os.path.join(TESTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.panel import markdown  # noqa: E402


class MarkdownSubsetTests(unittest.TestCase):
    def test_headings_paragraphs_and_inline_marks(self):
        html = markdown.render(
            "# 标题\n\n正文**粗**与 `code` 与 [链接](http://x)\n")
        self.assertIn("<h1>标题</h1>", html)
        self.assertIn("<strong>粗</strong>", html)
        self.assertIn("<code>code</code>", html)
        self.assertIn('<a href="http://x">链接</a>', html)

    def test_user_text_is_escaped_before_marks(self):
        """先转义再替换:用户写的尖括号不能变成真标签。"""
        html = markdown.render("<script>alert(1)</script>")
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_nested_lists_are_valid_nesting_not_sibling_soup(self):
        html = markdown.render("- 一\n  - 一甲\n  - 一乙\n- 二\n")
        # 子列表必须在父 li 内部,而不是和它并列
        self.assertRegex(html, r"<li>一<ul><li>一甲</li><li>一乙</li></ul></li>")
        self.assertEqual(html.count("<ul>"), html.count("</ul>"))
        self.assertEqual(html.count("<li>"), html.count("</li>"))

    def test_ordered_and_unordered_lists_both_render(self):
        html = markdown.render("1. 甲\n2. 乙\n")
        self.assertIn("<ol>", html)
        self.assertIn("<li>甲</li>", html)

    def test_table_with_separator_row_drops_the_separator(self):
        html = markdown.render(
            "| 场景 | 返回 |\n| --- | --- |\n| 未开通 | fail |\n")
        self.assertIn("<th>场景</th>", html)
        self.assertIn("<td>未开通</td>", html)
        self.assertNotIn("---", html)

    def test_fence_keeps_content_and_language(self):
        html = markdown.render("```python\nx = 1\n```\n")
        self.assertIn('<span class="fl">python</span>', html)
        self.assertIn("x = 1", html)

    def test_fence_hook_can_take_over_and_none_falls_back(self):
        taken = markdown.render(
            "```plantuml\n@startuml\n@enduml\n```",
            lambda language, body: "<figure>图</figure>"
            if language == "plantuml" else None)
        self.assertIn("<figure>图</figure>", taken)
        fallback = markdown.render(
            "```json\n{}\n```", lambda language, body: None)
        self.assertIn("<pre><code>", fallback)

    def test_horizontal_rule_and_blank_lines(self):
        html = markdown.render("上\n\n---\n\n下\n")
        self.assertIn("<hr>", html)
        self.assertIn("<p>上</p>", html)
        self.assertIn("<p>下</p>", html)

    def test_real_templates_render_without_losing_visible_text(self):
        """喂真实模板:不崩、不吞内容、不漏出裸标题。"""
        root = os.path.abspath(os.path.join(SCRIPTS, ".."))
        assets = os.path.join(root, "skills", "mae-flow", "assets")
        seen = 0
        for name in sorted(os.listdir(assets)):
            if not name.endswith(".md"):
                continue
            seen += 1
            with open(os.path.join(assets, name), encoding="utf-8") as stream:
                source = stream.read()
            html = markdown.render(source)
            outside_code = re.sub(r"<pre><code>.*?</code></pre>", "", html,
                                  flags=re.S)
            self.assertEqual(
                [], re.findall(r"(?m)^#{1,6} ", outside_code),
                "%s: 代码块之外仍有未渲染的裸标题" % name)
            self.assertEqual(
                [], re.findall(r"(?m)^\|\s", outside_code),
                "%s: 代码块之外仍有未渲染的表格行" % name)
        self.assertTrue(seen, "没找到任何模板,断言失去意义")


if __name__ == "__main__":
    unittest.main()
