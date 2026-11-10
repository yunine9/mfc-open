#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""结论关键词不许拿去整篇搜，测试也不许污染整机共用的文件。

两条都是从实战里长出来的，而且都能机器守住：

一、`(?i)\\bFAIL\\b` 整篇搜验证报告，把正文里的 `SendResult.fail("sms: …")`
    当成了结论——需求本身就是"失败要重试"，报告越老实越像在说谎。
    这类关键词短、含义强、又天然会出现在代码标识符里(fail/pass/ok/error)，
    判结论时必须锚到行，不能满篇捞。

二、hook 的日志是整机共用的一份，真流程的 doctor 就读它。测试往里注入
    RuntimeError("boom") 却没隔离，用户那边的 Agent 因此认定"hook 每次
    调用都在崩"，白查了半天。跑测试不许改动别人的现场。
"""

import ast
import io
import os
import re
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

# 短、强、又必然出现在代码标识符里的词。判结论时必须锚行。
VERDICT_WORDS = ("FAIL", "PASS", "CLEAN", "ERROR", "OK", "DONE", "SKIP")
# 只盯"整条正则就是一个结论词"的那种——`(?i)\bFAIL\b`。
# 解析测试工具输出的模式(`\[\s*FAILED\s*\]\s*(\d+)\s+tests?`)带着上下文,
# 不锚行是对的:它读的是结构化输出,不是人写的文档。
ANCHORED = re.compile(r"\(\?[a-z]*m[a-z]*\)|\^|\$")
# 只测正文一次的模式(如 status == "CLEAN")不在此列——那是比对，不是搜。
SEARCHY = ("search", "findall", "finditer", "match", "fullmatch", "sub")


def _bare_verdict(pattern):
    """整条正则剥掉语法后只剩一个结论词 → 它是在满篇捞结论。"""
    letters = re.findall(r"[A-Za-z]+", re.sub(r"\\[a-zA-Z]", " ", pattern))
    meaningful = [word for word in letters
                  if word.lower() not in ("i", "m", "s", "x", "mi", "im")]
    return (len(meaningful) == 1
            and meaningful[0].upper() in VERDICT_WORDS)


def _regex_literals(path):
    """→ [(行号, 正则原文)]：出现在 re.* 调用第一个参数里的字面量。"""
    tree = ast.parse(io.open(path, encoding="utf-8").read())
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        name = getattr(func, "attr", None)
        if name not in SEARCHY and name != "compile":
            continue
        if not (isinstance(getattr(func, "value", None), ast.Name)
                and func.value.id == "re"):
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            found.append((node.lineno, first.value))
    return found


class VerdictMatchingTests(unittest.TestCase):
    def test_verdict_keywords_are_anchored_to_a_line(self):
        loose = []
        for here, _dirs, names in os.walk(os.path.join(SCRIPTS,
                                                       "mae_flow_core")):
            for name in sorted(names):
                if not name.endswith(".py"):
                    continue
                path = os.path.join(here, name)
                for line, pattern in _regex_literals(path):
                    if not _bare_verdict(pattern):
                        continue
                    if ANCHORED.search(pattern):
                        continue
                    loose.append("%s:%d %s"
                                 % (os.path.relpath(path, ROOT), line,
                                    pattern[:60]))
        self.assertEqual(
            [], loose,
            "结论关键词被拿去整篇搜,正文里的 fail(/pass_ 都会误判: %s" % loose)


class TestIsolationTests(unittest.TestCase):
    """整机共用的日志,测试不许写进去。

    hook 入口只许它自己的协议用例动(架构红线),所以这里不加载 dispatch,
    改成静态核对:凡是往 hook 入口注故障的用例,必须同时把 LOG 挪开。
    """

    def test_fault_injection_redirects_the_shared_log(self):
        tests = os.path.join(SCRIPTS, "tests")
        offenders = []
        for name in sorted(os.listdir(tests)):
            if not name.startswith("test_") or not name.endswith(".py"):
                continue
            with io.open(os.path.join(tests, name),
                         encoding="utf-8") as stream:
                source = stream.read()
            injects = ("self.dispatch" in source and "side_effect" in source)
            if injects and '"LOG"' not in source:
                offenders.append(name)
        self.assertEqual(
            [], offenders,
            "往 hook 注故障却没把日志挪开——那份日志真流程的 doctor 在读: %s"
            % offenders)

    def test_the_shared_log_is_a_single_machine_wide_file(self):
        """这条不变量正是上面那条存在的理由:日志只有一份,谁写都串。"""
        with io.open(os.path.join(ROOT, "hooks", "dispatch.py"),
                     encoding="utf-8") as stream:
            source = stream.read()
        self.assertIn('LOG = os.path.join(tempfile.gettempdir()', source)


if __name__ == "__main__":
    unittest.main()
