#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""symbol-refs:改动收口的递工具——只读、不拦、任何模式可用。

它服务最贵的失效类:动了共享符号,漏改编译器看不见的文件(XML/YAML/SQL)。
契约:词边界精确匹配、覆盖未跟踪文件、忽略 git 忽略的文件、
编译器看不见的命中排最前、工具自身失败绝不抛错变成新卡点。
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

TESTS = os.path.abspath(os.path.dirname(__file__))
SCRIPTS = os.path.abspath(os.path.join(TESTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_commands.symbol_refs import symbol_hits  # noqa: E402


def write(root, relative, body):
    path = os.path.join(root, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(body)


class SymbolRefsTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="symrefs-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        subprocess.run(["git", "-C", self.root, "init", "-q"], check=True)
        write(self.root, ".gitignore", "target/\n")
        write(self.root, "src/OrderService.java",
              "class OrderService {\n"
              "  void queryOrder(long id) {}\n"
              "  void queryOrderById(long id) {}\n"
              "}\n")
        write(self.root, "mapper/Order.xml",
              '<select id="queryOrder">select 1</select>\n')
        write(self.root, "target/Gen.java", "// queryOrder generated\n")
        subprocess.run(["git", "-C", self.root, "add", "-A"], check=True)
        # 未跟踪的新文件也必须进清单:交付中的改动本来就未提交
        write(self.root, "config/routes.yaml", "handler: queryOrder\n")
        self.before = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.before)

    def test_word_boundary_untracked_and_opaque_grouping(self):
        code, opaque, names = symbol_hits("queryOrder")
        joined = "\n".join(code + opaque)
        # 词边界:queryOrderById 不算 queryOrder 的引用
        self.assertNotIn("queryOrderById", joined)
        self.assertEqual(1, len(code), code)
        self.assertIn("src/OrderService.java", code[0])
        # 编译器看不见的两处:已跟踪 XML + 未跟踪 YAML
        opaque_paths = sorted(line.split(":", 1)[0] for line in opaque)
        self.assertEqual(
            ["config/routes.yaml", "mapper/Order.xml"], opaque_paths)
        # git 忽略的产物目录不进清单
        self.assertNotIn("target/", joined)
        self.assertEqual([], names)

    def test_filename_hits_are_reported(self):
        _code, _opaque, names = symbol_hits("OrderService")
        self.assertEqual(["src/OrderService.java"], names)

    def test_zero_hit_symbol_returns_empty_not_error(self):
        self.assertEqual(([], [], []), symbol_hits("noSuchSymbolAnywhere"))

    def test_outside_git_repo_fails_soft(self):
        outside = tempfile.mkdtemp(prefix="symrefs-nogit-")
        self.addCleanup(shutil.rmtree, outside, True)
        os.chdir(outside)
        try:
            self.assertEqual(([], [], []), symbol_hits("anything"))
        finally:
            os.chdir(self.root)


if __name__ == "__main__":
    unittest.main()
