#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宿主形态:用户在不在这台机器上。

这条开关存在的理由是实战反馈:接进云端控制台后,内核仍然让用户"去 IDE
里检视代码"、把现场面板的**本机绝对路径**念给他听。用户在浏览器里看的是
另一台机器,那个路径打不开、IDE 也不存在——而这些话是被模型原样转述出去
的(内核为面板路径专门加过转述义务),用户只会以为流程坏了。

默认必须是"用户就在这台机器上":本地 CLI 是主场景,不能因为加了云端支持
就让它少说话。
"""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import host_env  # noqa: E402


class HostEnvTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(host_env.ENV)
        os.environ.pop(host_env.ENV, None)

    def tearDown(self):
        os.environ.pop(host_env.ENV, None)
        if self._saved is not None:
            os.environ[host_env.ENV] = self._saved

    def test_default_is_user_on_this_machine(self):
        self.assertTrue(host_env.user_on_this_machine())

    def test_cloud_means_user_is_elsewhere(self):
        os.environ[host_env.ENV] = "cloud"
        self.assertFalse(host_env.user_on_this_machine())

    def test_cloud_is_case_and_space_tolerant(self):
        for spelling in (" Cloud ", "CLOUD", "cloud"):
            with self.subTest(spelling=spelling):
                os.environ[host_env.ENV] = spelling
                self.assertFalse(host_env.user_on_this_machine())

    def test_unknown_value_falls_back_to_local(self):
        # 认不出的取值按本地处理:少说一句话的代价,远小于给云端用户
        # 一条他做不到的指令。
        os.environ[host_env.ENV] = "kubernetes"
        self.assertTrue(host_env.user_on_this_machine())


class ReviewPromptTests(unittest.TestCase):
    """人工检视点的提示词不许指定"在哪看",也不许只顾信息密度。"""

    def _step(self, name):
        path = os.path.join(ROOT, "flow", "steps", name + ".md")
        with open(path, encoding="utf-8") as stream:
            return stream.read()

    def test_review_steps_do_not_pin_the_user_to_an_ide(self):
        for step in ("story", "delivery_review"):
            with self.subTest(step=step):
                text = self._step(step)
                self.assertNotIn("在 IDE 中检视", text)

    def test_final_review_tells_the_model_to_show_files_and_real_evidence(self):
        text = self._step("delivery_review")
        self.assertIn("人工检视", text)
        self.assertIn("实际", text)
        self.assertIn("不能编造通过", text)
