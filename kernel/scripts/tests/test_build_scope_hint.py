#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""编译范围提示:多模块仓不该整仓编译——但这是提示，不是门禁。"""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.build_scope import (  # noqa: E402
    build_scope_hint,
    is_whole_repo_maven_build,
    likely_delivery_modules,
    maven_modules,
)


POM = """
<project>
  <modules>
    <module>demo-common</module>
    <module>demo-sdk</module>
    <module>demo-model</module>
    <module>demo-service</module>
    <module>demo-web</module>
  </modules>
</project>
"""


class BuildScopeHintTests(unittest.TestCase):
    def test_root_pom_modules_are_read_in_order_without_duplicates(self):
        self.assertEqual(
            ("demo-common", "demo-sdk", "demo-model",
             "demo-service", "demo-web"),
            maven_modules(POM))
        self.assertEqual((), maven_modules("<project></project>"))
        self.assertEqual((), maven_modules(None))

    def test_only_unscoped_maven_commands_count_as_whole_repo(self):
        for command in ("mvn compile -q", "mvnw clean compile",
                        "./mvnw compile"):
            with self.subTest(command=command):
                self.assertTrue(is_whole_repo_maven_build(command))
        for command in (
                "mvn -pl demo-sdk,demo-service -am compile -q",
                "mvn --projects demo-sdk compile",
                "mvn -f demo-service/pom.xml compile -q",
                "build-fix skill",
                "cmake --build build",
                ""):
            with self.subTest(command=command):
                self.assertFalse(is_whole_repo_maven_build(command))

    def test_delivery_modules_are_ranked_not_filtered(self):
        modules = maven_modules(POM)
        ranked = likely_delivery_modules(modules)
        self.assertEqual(
            ("demo-sdk", "demo-model", "demo-service"), ranked[:3],
            "sdk/model/service 排前面，方便直接照抄")
        self.assertEqual(
            set(modules), set(likely_delivery_modules(modules, limit=99)),
            "只排序，不丢模块")

    def test_hint_is_copy_pasteable_and_explicitly_non_binding(self):
        hint = build_scope_hint("mvn compile -q", maven_modules(POM))
        self.assertIn("mvn -pl demo-sdk,demo-model,demo-service -am", hint)
        self.assertIn("会编译整仓", hint)
        self.assertIn(".mae-flow-defaults.json", hint)
        self.assertIn("只是提示", hint)
        self.assertIn("你说了算", hint)

    def test_hint_stays_silent_when_it_has_nothing_to_add(self):
        for command, modules in (
                ("mvn -pl demo-sdk -am compile", maven_modules(POM)),
                ("build-fix skill", maven_modules(POM)),
                ("mvn compile -q", ()),
                ("", ())):
            with self.subTest(command=command, modules=len(modules)):
                self.assertEqual("", build_scope_hint(command, modules))


if __name__ == "__main__":
    unittest.main()
