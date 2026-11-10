#!/usr/bin/env python3
"""Tests for Hook task-card freshness and Agent source scope."""

import os
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.application.hooks.task_cards import (  # noqa: E402
    TaskCardPorts,
    verify_agent_scope,
    verify_completion_task,
    verify_dispatch_task,
)


HEAD = "a" * 40


class TaskCardContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.card_path = os.path.join(
            self.temporary.name, "compile-task.md")
        self.body = "# compile task\n"
        with open(
                self.card_path, "w", encoding="utf-8",
                newline="\n") as stream:
            stream.write(self.body)
        self.state = {
            "current": "build",
            "agent_tasks": {
                "COMPILE": {
                    "step": "build",
                    "head": HEAD,
                    "path": self.card_path,
                },
            },
            "initial_dirty": [],
            "initial_dirty_fingerprints": {},
        }

    def ports(self, **overrides):
        values = {
            "read_text": lambda path: Path(path).read_text(encoding="utf-8"),
            "current_head": lambda: HEAD,
            "merge_base": lambda _base, _current: HEAD,
            "changed_paths_since": lambda _head: (),
            "source_changed_since": lambda _head, _state: ([], ""),
            "source_snapshot": lambda _head: {},
            "path_fingerprint": lambda path: "fp:" + path,
            "review_path_fingerprint": lambda path: "review:" + path,
            "source_like": lambda path: path.endswith(
                (".py", ".cpp", ".h")),
            "test_like": lambda path: "test" in path.lower(),
            "build_like": lambda path: path.endswith(
                ("pom.xml", "CMakeLists.txt")),
            "path_exists": os.path.exists,
            "script_path": lambda: "/repo/scripts/mae-flow.py",
        }
        values.update(overrides)
        return TaskCardPorts(**values)

    def test_completion_accepts_current_card_with_opaque_report(self):
        decision = verify_completion_task(
            "COMPILE", "任意自然语言返回", self.state, self.ports())
        self.assertTrue(decision.accepted)
        self.assertEqual(self.state["agent_tasks"]["COMPILE"], decision.task)

    def test_completion_rejects_only_missing_or_wrong_step_card(self):
        missing = verify_completion_task(
            "UT", "", self.state, self.ports())
        self.assertFalse(missing.accepted)
        self.assertIn("未生成 harness 任务卡", missing.reason)
        self.assertIn("主流程已不签发 UT 任务卡", missing.reason)

        wrong_step = dict(self.state)
        wrong_step["current"] = "verify_ut"
        decision = verify_completion_task(
            "COMPILE", "status=FAIL", wrong_step, self.ports())
        self.assertFalse(decision.accepted)
        self.assertIn("旧步骤", decision.reason)

    def test_dispatch_says_so_when_the_step_issues_no_such_card(self):
        """出路必须真走得通。

        云端实锤(2026-08-21):交付后的流水线修复轮停在 external_verify,
        会话拿 verify_ut 的旧 UT 卡派发被拦,照着"生成当前步骤的新任务卡"
        去执行 agent-task ut,又被"当前步骤不允许生成"打回,再 current
        回到"在等流水线"——三条命令来回空转。本步压根不签发这类卡时,
        必须直说生成不出来,并给出真正的做法。
        """
        state = dict(self.state)
        state["current"] = "external_verify"
        state["agent_tasks"] = {"UT": {"step": "standalone_ut", "head": HEAD}}
        decision = verify_dispatch_task("UT", state, self.ports())
        self.assertFalse(decision.accepted)
        self.assertIn("不签发 UT 任务卡", decision.reason)
        self.assertIn("生成不出来", decision.reason)
        self.assertIn("自己动手", decision.reason, "得给出真正的做法")
        self.assertNotIn("生成当前步骤的新任务卡", decision.reason,
                         "不许再把会话支去走死路")

        # 本步确实签发这类卡时,旧卡换新卡的指引照旧(standalone_ut 签 UT 卡)。
        live = dict(self.state)
        live["current"] = "standalone_ut"
        live["agent_tasks"] = {"UT": {"step": "standalone_codecheck",
                                      "head": HEAD}}
        usual = verify_dispatch_task("UT", live, self.ports())
        self.assertFalse(usual.accepted)
        self.assertIn("生成当前步骤的新任务卡", usual.reason)

    def test_scope_enforces_each_agent_write_boundary(self):
        cases = (
            (
                "COMPILE",
                {"head": HEAD},
                ("tests/test_main.py",),
                "compile-agent 越权修改了测试文件",
            ),
            (
                "CODECHECK",
                {"head": HEAD, "allowed_files": ["src/allowed.py"]},
                ("src/other.py",),
                "codecheck-fix-agent 修改了首检范围外文件",
            ),
            (
                "UT",
                {"head": HEAD},
                ("src/main.py",),
                "ut-generator-agent 修改了非测试源码",
            ),
            (
                "GRILL",
                {"head": HEAD},
                ("src/main.py",),
                "grill-critic-agent 是只读审查角色",
            ),
            (
                "REVIEWER",
                {"head": HEAD},
                ("src/main.py",),
                "craft-reviewer-agent 是只读审查角色",
            ),
            (
                "STORY",
                {"head": HEAD},
                ("src/main.py",),
                "story-generator-agent 修改了业务源码",
            ),
        )
        for kind, task, changed, reason in cases:
            with self.subTest(kind=kind):
                decision = verify_agent_scope(
                    kind,
                    task,
                    self.state,
                    self.ports(changed_paths_since=lambda _head: changed),
                    direct_write_paths=changed if kind == "UT" else (),
                )
                self.assertFalse(decision.accepted)
                self.assertIn(reason, decision.reason)

    def test_scope_preserves_unchanged_initial_dirty_exemption(self):
        self.state["initial_dirty"] = ["src/main.py"]
        self.state["initial_dirty_fingerprints"] = {
            "src/main.py": "fp:src/main.py",
        }
        decision = verify_agent_scope(
            "GRILL",
            {"head": HEAD},
            self.state,
            self.ports(
                changed_paths_since=lambda _head: ("src/main.py",)),
        )
        self.assertTrue(decision.accepted)
        self.assertEqual((), decision.changed_paths)

    def test_writable_agent_scopes_compare_canonical_repository_paths(self):
        cases = (
            (
                "CODECHECK",
                {"head": HEAD, "allowed_files": [r"SRC\allowed.py"]},
                (),
            ),
            (
                "UT",
                {"head": HEAD},
                (r"SRC\allowed.py",),
            ),
        )
        for kind, task, direct_paths in cases:
            with self.subTest(kind=kind):
                decision = verify_agent_scope(
                    kind,
                    task,
                    self.state,
                    self.ports(
                        changed_paths_since=lambda _head: (
                            "./src/allowed.py",),
                        test_like=lambda path: path.lower().endswith(".py"),
                        path_exists=lambda _path: True,
                    ),
                    direct_write_paths=direct_paths,
                )
                self.assertTrue(decision.accepted)

    def test_ut_command_side_effects_have_non_unlock_recovery(self):
        changed = ("src/main/resources/audit.properties",)
        command_effect = verify_agent_scope(
            "UT",
            {"head": HEAD},
            self.state,
            self.ports(
                changed_paths_since=lambda _head: changed,
                source_like=lambda _path: True,
            ),
            direct_write_paths=(),
        )
        self.assertFalse(command_effect.accepted)
        self.assertIn("UT 命令产生了非测试文件副作用", command_effect.reason)
        self.assertIn("不要使用 unlock source 或 accept-risk", command_effect.reason)
        self.assertIn("不要询问用户", command_effect.reason)
        self.assertIn("任务签发时干净", command_effect.reason)
        self.assertIn("恢复性移出交付范围", command_effect.reason)

        direct_edit = verify_agent_scope(
            "UT",
            {"head": HEAD},
            self.state,
            self.ports(
                changed_paths_since=lambda _head: changed,
                source_like=lambda _path: True,
            ),
            direct_write_paths=changed,
        )
        self.assertFalse(direct_edit.accepted)
        self.assertIn(
            "ut-generator-agent 修改了非测试源码",
            direct_edit.reason,
        )
        self.assertIn("源码缺陷必须先交用户裁决", direct_edit.reason)
        self.assertNotIn("UT 命令产生了非测试文件副作用", direct_edit.reason)

    def test_dispatch_rejects_missing_but_not_fingerprint_drift(self):
        missing = verify_dispatch_task(
            "COMPILE",
            {"current": "build", "agent_tasks": {}},
            self.ports(),
        )
        self.assertFalse(missing.accepted)
        self.assertIn("尚无本步任务卡", missing.reason)
        # 主流程 COMPILE 卡已退役,恢复指引不再指向已删除的 agent-task 命令。
        self.assertNotIn("agent-task", missing.reason)

        changed = verify_dispatch_task(
            "COMPILE",
            self.state,
            self.ports(current_head=lambda: "b" * 40),
        )
        self.assertTrue(changed.accepted)

    def test_missing_role_cards_show_only_real_recovery_commands(self):
        cases = (
            ("STORY", "story", "role-task story-generate"),
            ("REVIEWER", "story", "role-task story-review"),
            ("GRILL_PREP", "grill", "role-task grill-critic --stage prep"),
            ("GRILL_FINAL", "grill", "role-task grill-critic --stage final"),
        )
        for kind, step, command in cases:
            state = {
                "current": step,
                "config": {"单号": "REQ-1"},
                "agent_tasks": {},
            }
            decision = verify_dispatch_task(kind, state, self.ports())
            self.assertFalse(decision.accepted)
            self.assertIn(command, decision.reason)


if __name__ == "__main__":
    unittest.main()
