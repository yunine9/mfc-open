#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""源码路径判定。"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


class FlowOwnedFilesAreNeverSourceTests(unittest.TestCase):
    """流程自己的过程文件永远不是交付源码——哪怕后缀是 .js/.py。

    实测:面板每次推进都会写 .mae-flow-work/panel-stamp.js。它以 .js 结尾,
    源码判定光看后缀就把它算成业务源码,流程随即认定"源码变了必须重编译",
    把一次正常交付拐进重编译回环。而面板的铁律恰恰是永不影响推进。
    同类还有 .mae-flow-work/bin/mae-flow.py。
    """

    def test_process_files_with_code_extensions_are_excluded(self):
        from mae_flow_core.foundation.source_paths import (
            known_source_classification)
        for path in (".mae-flow-work/panel-stamp.js",
                     ".mae-flow-work/panel-pulse.js",
                     ".mae-flow-work/bin/mae-flow.py",
                     ".mae-flow.json.tokens",
                     ".mae-flow-history.jsonl"):
            self.assertIs(
                False, known_source_classification(path),
                "流程过程文件不该被当成交付源码: %s" % path)

    def test_real_source_still_counts(self):
        from mae_flow_core.foundation.source_paths import (
            known_source_classification)
        for path in ("service/src/demo_service/sms_handler.py",
                     "src/main/java/A.java", "web/app.js"):
            self.assertIs(True, known_source_classification(path), path)

    def test_uncommitted_suffix_does_not_defeat_the_check(self):
        from mae_flow_core.foundation.source_paths import (
            known_source_classification)
        self.assertIs(False, known_source_classification(
            ".mae-flow-work/panel-stamp.js(未提交)"))
