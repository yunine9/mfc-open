#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""被拦下的人必须知道下一步做什么。

实战教训:CodeCheck 步的门禁只说"旧首检不背新代码的书,重新执行
codecheck-scan"——而工具当时正好跑不起来,于是模型没有出路,在
"改—扫—又改"里空转几轮,最后自己回退了 5 个文件才脱身。

只说"不许"的拦截,对弱模型等同于死路。本文件把"每条拒绝都得给出路"
钉成红线:门禁层严格全覆盖,推进层用棘轮防新增。
"""

import ast
import io
import os
import re
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

# 出路长什么样:一条命令、一个动作、或一处明确指引。
WAY_OUT = re.compile(
    r"重新执行|重跑|重新|重试|先.{0,20}再|.{0,20}后再|回退|改成|改为|改用|换成|"
    r"删除|去掉|补齐|合并为|执行|运行|直接 |请|应|需|必须|参见|见 |走 |使用|"
    r"用 |维护人|--|`|<[^>]+>|\{MAEFLOW_PATH\}|mae-flow")

# 推进层现存的"只说不许"条数。只许降不许升——新写的拒绝必须带出路。
# 剩下这些多是诊断分支("无法…:⟨错误原文⟩"),模型很少撞上;热路径已清零。
# 每次顺手清掉几条就把数字调小,别让它涨回去。
_DEAD_END_BUDGET = 31


def _literal(node):
    """把 '甲' + 变量 + '乙' 还原成整句;变量段用 ⟨⟩ 占位,不参与判定。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _literal(node.left), _literal(node.right)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.JoinedStr):
        return "".join(_literal(part) or "⟨⟩" for part in node.values)
    if isinstance(node, (ast.FormattedValue, ast.Call, ast.Name,
                         ast.Attribute)):
        return "⟨⟩"
    return None


def _refusals(path, kind):
    tree = ast.parse(io.open(path, encoding="utf-8").read())
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        label = getattr(node.func, "attr", None) or getattr(node.func, "id",
                                                            None)
        if kind == "gate" and label == "EvidenceResult" and len(node.args) > 1:
            first = node.args[0]
            if isinstance(first, ast.Constant) and first.value is False:
                text = _literal(node.args[1])
                if text:
                    out.append((node.lineno, text))
        if kind == "advance" and label == "die" and node.args:
            text = _literal(node.args[0])
            if text:
                out.append((node.lineno, text))
    return out


def _judgeable(rows):
    """文本几乎全是变量的,静态判不了——不冤枉它,也不给它记功。"""
    return [(line, text) for line, text in rows
            if len(text.replace("⟨⟩", "").strip()) >= 10]


class RefusalTests(unittest.TestCase):
    def test_every_gate_refusal_tells_you_what_to_do(self):
        path = os.path.join(SCRIPTS, "mae_flow_core", "quality",
                            "evidence.py")
        stuck = [(line, text) for line, text
                 in _judgeable(_refusals(path, "gate"))
                 if not WAY_OUT.search(text)]
        self.assertEqual(
            [], stuck,
            "门禁拒绝了却没说下一步做什么: %s"
            % [(line, text[:60]) for line, text in stuck])

    def test_advancement_refusals_do_not_regress(self):
        stuck = []
        base = os.path.join(SCRIPTS, "mae_flow_core", "cli_commands")
        for name in sorted(os.listdir(base)):
            if not name.endswith(".py"):
                continue
            path = os.path.join(base, name)
            stuck += [(name, line, text) for line, text
                      in _judgeable(_refusals(path, "advance"))
                      if not WAY_OUT.search(text)]
        self.assertLessEqual(
            len(stuck), _DEAD_END_BUDGET,
            "新增了只说「不许」不说出路的拒绝: %s"
            % [(name, line, text[:50]) for name, line, text in stuck])


if __name__ == "__main__":
    unittest.main()


class SuggestedCommandsAreRealTests(unittest.TestCase):
    """教出去的命令必须是真命令——出路不能靠模型拼参数。

    实战:用户点选批准后 allow 被拒,模型转头拼了 `allow --paths pom.xml …`,
    这个参数从来不存在,又撞一层参数错误。拦了不给出路是死路,
    给的出路里含不存在的参数是**假出路**,比死路更费轮次。
    """

    _SUGGEST = re.compile(
        r"(?:allow|done|goto|unlock|accept-risk|messages|manifest|"
        r"codecheck-(?:scan|scope|record)|requirement-record|moonlight|"
        r"domain-archive|action|spec|config-review|lightcheck|agent-task|"
        r"role-task|story-localize|local-spec|init|current|status|doctor|"
        r"report|exit|skip|approve-exemption)"
        r"((?:\s+(?:--[a-z][a-z-]*|-[a-zA-Z])\b)+)")

    def _flags_by_subcommand(self):
        from mae_flow_core.cli_parser import build_parser
        parser = build_parser()
        subs = next(
            action.choices for action in parser._actions
            if getattr(action, "choices", None))
        return {
            name: {flag for action in sub._actions
                   for flag in action.option_strings}
            for name, sub in subs.items()
        }

    @staticmethod
    def _docstrings(tree):
        """文档字符串不是发给模型的消息(有的正是在讲述历史 bug),不参与判定。"""
        out = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef,
                                 ast.AsyncFunctionDef, ast.ClassDef)):
                body = getattr(node, "body", [])
                if (body and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    out.add(id(body[0].value))
        return out

    def test_every_suggested_flag_exists_in_the_real_parser(self):
        real = self._flags_by_subcommand()
        offenders = []
        base = os.path.join(SCRIPTS, "mae_flow_core")
        for here, _dirs, names in os.walk(base):
            for name in sorted(names):
                if not name.endswith(".py"):
                    continue
                path = os.path.join(here, name)
                with io.open(path, encoding="utf-8") as stream:
                    tree = ast.parse(stream.read())
                skip = self._docstrings(tree)
                for node in ast.walk(tree):
                    if not (isinstance(node, ast.Constant)
                            and isinstance(node.value, str)):
                        continue
                    if id(node) in skip:
                        continue
                    for hit in self._SUGGEST.finditer(node.value):
                        # git 也有 status/…:前文有 git 的不是 mae-flow 命令
                        # (窗口给足 40 字,盖住 `git -c core.quotepath=false status`)
                        lead = node.value[max(0, hit.start() - 40):hit.start()]
                        if "git" in lead:
                            continue
                        sub = hit.group(0).split()[0]
                        if sub not in real:
                            continue
                        for flag in re.findall(r"--?[a-zA-Z][a-z-]*",
                                               hit.group(1)):
                            if flag not in real[sub]:
                                offenders.append(
                                    "%s:%d %s %s"
                                    % (os.path.relpath(path, ROOT),
                                       node.lineno, sub, flag))
        self.assertEqual(
            [], offenders,
            "消息里建议了不存在的参数(假出路,比死路更费轮次): %s" % offenders)

    def test_parse_error_tells_the_model_not_to_invent_flags(self):
        with io.open(os.path.join(SCRIPTS, "mae_flow_core",
                                  "cli_parser.py"), encoding="utf-8") as s:
            self.assertIn("不要自己发明参数", s.read())
