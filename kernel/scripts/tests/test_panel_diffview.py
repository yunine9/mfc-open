#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双排 diff 契约。

双排的全部价值在配对:改写型变更必须左右同排,否则和单排没区别。
截断必须报数——显示不全却看着像全部,是最坏的一种"通过"。
"""

import os
import re
import sys
import unittest

TESTS = os.path.abspath(os.path.dirname(__file__))
SCRIPTS = os.path.abspath(os.path.join(TESTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.panel import diffview  # noqa: E402

PATCH = """--- a/notify.py
+++ b/notify.py
@@ -1,4 +1,5 @@ def send(channel):
 \"\"\"入口\"\"\"
-from demo import email_handler
+from demo import email_handler, sms_handler
+from demo.permission import channel_enabled

 TOKEN = 16
"""

ROW_RE = re.compile(
    r'<div class="dr(?P<cls>[^"]*)">'
    r'<span class="ln">(?P<old>\d*)</span><code class="c (?P<lk>[\w]+)">'
    r'(?P<left>.*?)</code>'
    r'<span class="ln">(?P<new>\d*)</span><code class="c (?P<rk>[\w]+)">'
    r'(?P<right>.*?)</code></div>')


def rows(html):
    return [match.groupdict() for match in ROW_RE.finditer(html)]


class DiffViewTests(unittest.TestCase):
    def test_rewrite_pairs_on_the_same_row(self):
        found = rows(diffview.render(PATCH))
        paired = [row for row in found
                  if row["lk"] == "del" and row["rk"] == "add"]
        self.assertEqual(1, len(paired), "改写行必须左右同排")
        self.assertIn("email_handler", paired[0]["left"])
        self.assertIn("sms_handler", paired[0]["right"])

    def test_pure_addition_leaves_the_left_side_empty(self):
        found = rows(diffview.render(PATCH))
        pure = [row for row in found
                if row["lk"] == "nil" and row["rk"] == "add"]
        self.assertEqual(1, len(pure))
        self.assertIn("channel_enabled", pure[0]["right"])
        self.assertEqual("", pure[0]["old"])

    def test_line_numbers_advance_independently_on_each_side(self):
        found = rows(diffview.render(PATCH))
        context = [row for row in found if row["lk"] == "ctx"]
        self.assertEqual([("1", "1"), ("3", "4"), ("4", "5")],
                         [(row["old"], row["new"]) for row in context])

    def test_hunk_header_keeps_ranges_and_function_context(self):
        html = diffview.render(PATCH)
        self.assertIn("-1,4 +1,5", html)
        self.assertIn("def send(channel)", html)

    def test_metadata_lines_are_not_rendered_as_content(self):
        html = diffview.render(PATCH)
        self.assertNotIn("+++ b/notify.py", html)
        self.assertNotIn("--- a/notify.py", html)

    def test_truncation_announces_the_dropped_count(self):
        body = "\n".join("+line %d" % index for index in range(900))
        html = diffview.render("@@ -1,1 +1,900 @@\n" + body)
        self.assertIn("还有 200 行未显示", html)
        self.assertIn("面板上限 700 行", html)

    def test_content_is_escaped(self):
        html = diffview.render("@@ -1,1 +1,1 @@\n+<script>x</script>")
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_split_patch_keys_by_new_path(self):
        raw = ("diff --git a/a.py b/a.py\n@@ -1 +1 @@\n-1\n+2\n"
               "diff --git a/b.py b/b.py\n@@ -1 +1 @@\n-3\n+4\n")
        parts = diffview.split_patch(raw)
        self.assertEqual(["a.py", "b.py"], sorted(parts))
        self.assertIn("+2", parts["a.py"])

    def test_numstat_handles_binary_dashes(self):
        stats = diffview.numstat("12\t3\tsrc/a.py\n-\t-\timg/logo.png\n")
        self.assertEqual((12, 3), stats["src/a.py"])
        self.assertEqual((0, 0), stats["img/logo.png"])

    def test_empty_patch_is_not_an_error(self):
        self.assertIn("变更前", diffview.render(""))

    def test_long_unchanged_run_collapses_into_an_expander(self):
        """全量上下文的 patch:未改动长段折叠,内容埋在 hidden 容器里可点开。"""
        ctx = "\n".join(" line %d" % index for index in range(1, 41))
        html = diffview.render("@@ -1,41 +1,41 @@\n" + ctx + "\n-old\n+new")
        # 文件头 40 行:头部不留可见行(前面没有改动),尾部留 3 行 → 折 37
        self.assertIn("展开 37 行未改动", html)
        self.assertIn("<div hidden>", html)
        self.assertIn('onclick="dx(this)"', html)
        # 折叠区间是 1..37(在 hidden 容器里),尾部可见 3 行(38..40)在其后
        hidden_start = html.index("<div hidden>")
        self.assertNotIn("line 1<", html[:hidden_start])
        self.assertGreater(html.index("line 37"), hidden_start)
        self.assertGreater(html.index("line 38"), hidden_start)
        for visible in ("line 38", "line 39", "line 40"):
            # 双排:同一行内容左右各一格,恰好出现两次(且只有一行)
            self.assertEqual(2, html.count(visible))

    def test_short_unchanged_run_is_not_worth_a_button(self):
        ctx = "\n".join(" line %d" % index for index in range(1, 6))
        html = diffview.render("@@ -1,6 +1,6 @@\n" + ctx + "\n+new")
        self.assertNotIn("展开", html)
        self.assertNotIn("hidden", html)

    def test_oversized_gap_is_announced_not_embedded(self):
        """超过内嵌上限的段不塞进页面——大文件会把面板撑爆,但必须说出来。"""
        ctx = "\n".join(" x%d" % index for index in range(1, 402))
        html = diffview.render("@@ -1,402 +1,402 @@\n" + ctx + "\n+new")
        self.assertIn("行未改动（过长未内嵌，完整内容看源文件）", html)
        self.assertNotIn("展开", html)
        self.assertNotIn("<div hidden>", html)


if __name__ == "__main__":
    unittest.main()
