#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地验证报告的结论判定。"""

import os
import re
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

class VerificationVerdictTests(unittest.TestCase):
    """机器只拦谎言,不拦用词。

    实战:验证报告里逐条列了实现位置,其中写着 `SendResult.fail("sms: …")`。
    旧判法整篇搜 \\bFAIL\\b,当场把这份老实报告判成"结论为 FAIL",done 卡死。
    而这一单的需求恰恰就是"失败要重试"——报告里必然到处是 fail。
    """

    def _write(self, folder, body):
        import io as _io
        with _io.open(os.path.join(folder, "verification.md"), "w",
                      encoding="utf-8") as stream:
            stream.write(body)

    def test_code_named_fail_is_not_a_verdict(self):
        from mae_flow_core.cli_commands import evidence_registry
        room = tempfile.mkdtemp(prefix="verify-")
        self.addCleanup(shutil.rmtree, room, True)
        body = ("| 验收项 | 实现位置 | 结论 |\n"
                "| --- | --- | --- |\n"
                "| 校验失败不重试 | 返回 SendResult.fail(\"缺少目标\") | 满足 |\n"
                "\nPASS\n")
        self._write(room, body)
        self.assertIsNone(evidence_registry._VERDICT_FAIL.search(body),
                          "正文里的 SendResult.fail( 不是结论")
        self.assertTrue(evidence_registry._VERDICT_PASS.search(body))
        for line in ("返回 SendResult.fail(\"sms: 会话未建立\")",
                     "测试 test_validate_fail",
                     "| AC-1 | SendResult.fail(...) | 满足 |"):
            self.assertIsNone(evidence_registry._VERDICT_FAIL.search(line),
                              "误判成结论: %s" % line)

    def test_a_real_fail_verdict_still_blocks(self):
        from mae_flow_core.cli_commands import evidence_registry
        for body in ("矩阵略\n\nFAIL\n", "结论：FAIL\n", "总体: fail\n",
                     "矩阵略\nPASS\n发现回归：FAIL\n"):
            self.assertTrue(evidence_registry._VERDICT_FAIL.search(body),
                            "真结论行仍要拦: %r" % body)
