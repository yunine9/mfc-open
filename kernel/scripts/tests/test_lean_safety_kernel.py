#!/usr/bin/env python3
"""Public behavior contract for the lean workflow safety kernel."""

import json
import os
import shlex
import sys
import unittest
from dataclasses import replace


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.guard.manifest import DeliveryManifest  # noqa: E402
from mae_flow_core.guard.safety_kernel import (  # noqa: E402
    SafetyContext,
    SafetyDecision,
    decide_pretool,
)
from mae_flow_core.orchestration import (  # noqa: E402
    CapabilityAttempt,
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
)


FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "fixtures", "lean_git_cases.json"
)


def _command(argv):
    """Adapt fixture argv to the command-string parser boundary."""
    return " ".join(shlex.quote(str(token)) for token in argv)


def _paths(paths, repository_root):
    return DeliveryManifest.from_paths(
        paths, repository_root=repository_root).files


def _state(
        path=DeliveryPath.FULL,
        phase=Phase.CONSTRUCTION,
        decisions=(),
        delivery_files=(),
        initial_dirty=(),
        capabilities=()):
    return FlowState(
        ticket="REQ-7",
        path=path,
        phase=phase,
        commit_pace=CommitPace.STAGED,
        decisions=decisions,
        delivery_files=delivery_files,
        initial_dirty=initial_dirty,
        capabilities=capabilities,
    )


def _context(state, repository_root="/repo", **overrides):
    values = {
        "state": state,
        "repository_root": repository_root,
        "staged_files": (),
        "commit_files": (),
        "initial_dirty": (),
        "current_dirty_fingerprints": (),
    }
    values.update(overrides)
    return SafetyContext(**values)


class LeanSafetyKernelFixtureTests(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as fixture_file:
            self.fixture = json.load(fixture_file)

    def public_call(self, item):
        raw = item["context"]
        root = raw["working_directory"]
        manifest_input = raw["authorized_manifest"]
        candidate = _paths(manifest_input["files"], root)
        authorized = candidate if manifest_input["authorized"] else ()
        dirty = _paths(raw["preexisting_dirty_files"], root)
        phase = (
            Phase.CONSTRUCTION
            if raw["source_edit_confirmed"]
            else Phase.STORY
        )
        state = _state(
            phase=phase,
            delivery_files=authorized,
            initial_dirty=dirty,
        )
        context = _context(
            state,
            repository_root=root,
            staged_files=candidate,
            commit_files=candidate,
            initial_dirty=dirty,
            current_dirty_fingerprints=tuple(
                (path, "startup") for path in dirty),
        )

        argv = item["command"]["argv"]
        tool = "Bash"
        tool_input = {"command": _command(argv)}
        if argv[0] == "apply_patch":
            tool = "ApplyPatch"
            tool_input = {"targets": _paths([argv[1]], root)}
        elif item["operation_family"] == "protected_control":
            tool_input["targets"] = _paths([argv[-1]], root)
        elif item["operation_family"] == "filesystem":
            # A shell adapter owns argv parsing.  The pure kernel consumes the
            # already-parsed destructive targets that guard.bash recognizes.
            tool_input["recursive_delete_targets"] = (argv[-1],)
        return decide_pretool(context, tool, tool_input)

    def test_every_versioned_fixture_case_runs_through_the_public_api(self):
        self.assertEqual(1, self.fixture["schema_version"])
        decisions = {
            item["case"]: self.public_call(item)
            for item in self.fixture["cases"]
        }

        self.assertEqual(
            {
                item["case"]: item["expected"]["allowed"]
                for item in self.fixture["cases"]
            },
            {
                case: decision.allow
                for case, decision in decisions.items()
            },
        )
        self.assertTrue(all(
            isinstance(decision, SafetyDecision)
            for decision in decisions.values()
        ))
        for item in self.fixture["cases"]:
            if not item["expected"]["allowed"]:
                self.assertEqual(
                    item["operation_family"],
                    decisions[item["case"]].rule,
                    item["case"],
                )

    def test_windows_argv_is_adapted_without_losing_drive_or_backslashes(self):
        item = next(
            case for case in self.fixture["cases"]
            if case["case"] == "allowed_windows_exact_file_git_add"
        )

        decision = self.public_call(item)

        self.assertTrue(decision.allow)


class SourceEditAuthorizationTests(unittest.TestCase):
    def decision(self, state, target, **context_facts):
        return decide_pretool(
            _context(state, **context_facts),
            "Edit",
            {"targets": (target,)},
        )

    def test_source_edits_are_free_in_every_phase_and_path(self):
        """阶段级"源码编辑需要语义授权"已退役(2026-08-28,与步骤级源码
        闸同批):它要求的授权 key(focused.scope_approved /
        quality.source_fix_approved)全仓从无签发方——"要求的出路实际
        不存在";lean kernel 接线即复现"能提交不能编辑"事故。任何
        phase/path 下写源码与未知仓库文件一律放行,完整性由绝对保护
        (控制文件)与提交/交付侧闸把守。"""
        variants = (
            {"phase": Phase.CONSTRUCTION},
            {"phase": Phase.STORY},
            {"phase": Phase.QUALITY},
            {"phase": Phase.STARTUP},
            {"path": DeliveryPath.FOCUSED},
        )
        targets = (
            "src/main.py", "web/index.html", "web/site.css", "LICENSE",
            "config/application.yaml", "tests/page.snapshot",
        )
        for facts in variants:
            for target in targets:
                with self.subTest(target=target, **{
                        key: str(value) for key, value in facts.items()}):
                    self.assertTrue(
                        self.decision(_state(**facts), target).allow)

    def test_documentation_and_work_packages_are_allowed_outside_coding(self):
        startup = _state(phase=Phase.STARTUP)

        documentation = self.decision(startup, "docs/decision.md")
        work_package = self.decision(
            startup, ".mae-flow-work/REQ-7/plan.md")

        self.assertTrue(documentation.allow)
        self.assertTrue(work_package.allow)

    def test_windows_and_unc_write_targets_resolve_and_allow(self):
        """safe_write_targets 随阶段闸退役拆除;Windows 盘符/UNC 形态的
        写目标必须仍可解析并放行(路径解析逻辑与闸无关,不能陪葬)。"""
        startup = _state(phase=Phase.STARTUP)
        self.assertTrue(self.decision(
            startup, "Generated/Cache.bin").allow)
        self.assertTrue(self.decision(
            startup, r"C:\WORK\REPO\Generated\Cache.bin",
            repository_root=r"c:\work\repo").allow)
        self.assertTrue(self.decision(
            startup, r"\\SERVER\SHARE\REPO\Generated\Cache.bin",
            repository_root=r"\\server\share\repo").allow)

    def test_protected_controls_precede_source_authorization(self):
        approved = _state(
            phase=Phase.CONSTRUCTION,
            delivery_files=(".mae-flow.yml",),
        )

        decision = self.decision(approved, ".mae-flow.yml")

        self.assertEqual(
            (False, "protected_control"),
            (decision.allow, decision.rule),
        )

    def test_protected_control_aliases_are_normalized_before_classification(self):
        aliases = (
            "work/../.mae-flow.yml",
            "../repo/.mae-flow.yml",
            "/repo/work/../.mae-flow.yml",
            r"work\..\.MAE-FLOW.YML",
            ".MAE-FLOW.YML",
        )
        state = _state(phase=Phase.CONSTRUCTION)

        for target in aliases:
            with self.subTest(target=target):
                decision = self.decision(state, target)
                self.assertEqual(
                    (False, "protected_control"),
                    (decision.allow, decision.rule),
                )

        windows = self.decision(
            state,
            r"C:\work\repo\work\..\.MaE-Flow.YmL",
            repository_root=r"c:\work\repo",
        )
        self.assertEqual(
            (False, "protected_control"),
            (windows.allow, windows.rule),
        )

        rooted_current_drive = self.decision(
            state,
            r"\work\repo\.mae-flow.yml",
            repository_root=r"C:\work\repo",
        )
        alias_outside_root = self.decision(
            state,
            "../repo/.mae-flow.yml",
        )
        drive_relative = self.decision(
            state,
            r"C:.mae-flow.yml",
            repository_root=r"C:\work\repo",
        )

        self.assertEqual(
            (False, "protected_control"),
            (rooted_current_drive.allow, rooted_current_drive.rule),
        )
        self.assertEqual(
            (False, "protected_control"),
            (alias_outside_root.allow, alias_outside_root.rule),
        )
        # 盘符相对路径解析不了:规则名已随 source_edit 闸退役更正为
        # write_target(拦的是"写目标不可解析",不是阶段授权)。
        self.assertEqual(
            (False, "write_target"),
            (drive_relative.allow, drive_relative.rule),
        )


class GitManifestSafetyTests(unittest.TestCase):
    def manifest_state(self, **overrides):
        values = {
            "phase": Phase.DELIVERY,
            "delivery_files": ("src/a.cpp", "tests/a_test.cpp"),
        }
        values.update(overrides)
        return _state(**values)

    def bash(self, state, command, **facts):
        return decide_pretool(
            _context(state, **facts),
            "Bash",
            {"command": command},
        )


    def test_push_requires_exact_recorded_commit_manifest(self):
        state = self.manifest_state()

        exact = self.bash(
            state,
            "git push origin main",
            commit_files=("tests/a_test.cpp", "src/a.cpp"),
        )
        mismatch = self.bash(
            state,
            "git push origin main",
            commit_files=("src/a.cpp", "README.md"),
        )

        self.assertTrue(exact.allow)
        self.assertEqual((False, "git_publish"), (
            mismatch.allow, mismatch.rule))


    def test_recursive_delete_blocks_outside_and_allows_task_owned_temp(self):
        state = self.manifest_state()
        facts = {"task_owned_temp_dir": "/repo/.tmp/task-7"}

        outside = self.bash(state, "rm -rf build", **facts)
        inside = self.bash(state, "rm -rf /repo/.tmp/task-7", **facts)
        displayed = self.bash(state, "echo rm -rf build", **facts)

        self.assertEqual((False, "filesystem"), (
            outside.allow, outside.rule))
        self.assertTrue(inside.allow)
        self.assertTrue(displayed.allow)

    def test_destructive_recognition_precedes_read_only_fail_open(self):
        state = self.manifest_state()

        destructive = self.bash(state, "git reset --hard HEAD")
        read_only = self.bash(state, "git status --definitely-not-an-option")

        self.assertEqual((False, "git_destructive"), (
            destructive.allow, destructive.rule))
        self.assertTrue(read_only.allow)

    def test_destructive_git_uses_actual_execution_positions(self):
        state = self.manifest_state()
        cases = (
            ("git reset --hard HEAD", False),
            ("git status && git reset --hard HEAD", False),
            ("sh -c 'git reset --hard HEAD'", False),
            ("sudo -u root git reset --hard HEAD", False),
            ("pwsh -NoProfile -Command git reset --hard HEAD", False),
            ("cmd.exe /d /c git reset --hard HEAD", False),
            ("echo git reset --hard HEAD", True),
            ("printf 'git reset --hard HEAD'", True),
            ("git status && echo git reset --hard HEAD", True),
            ("bash -n -c 'git reset --hard HEAD'", True),
            ("bash --help -c 'git reset --hard HEAD'", True),
        )
        for command, expected_allow in cases:
            with self.subTest(command=command):
                decision = self.bash(state, command)
                self.assertIs(expected_allow, decision.allow)
                if not expected_allow:
                    self.assertEqual("git_destructive", decision.rule)

    def test_actual_substitution_positions_drive_destructive_git_gate(self):
        state = self.manifest_state()
        cases = (
            ('echo "$(git reset --hard HEAD)"', False),
            ("echo `git clean -dfx`", False),
            ("echo '$(git reset --hard HEAD)'", True),
            ('echo "\\$(git reset --hard HEAD)"', True),
            ("bash -n -c 'echo \"$(git reset --hard HEAD)\"'", True),
        )
        for command, expected_allow in cases:
            with self.subTest(command=command):
                decision = self.bash(state, command)
                self.assertIs(expected_allow, decision.allow)
                if not expected_allow:
                    self.assertEqual("git_destructive", decision.rule)


    def test_print_and_read_only_alias_text_remain_fail_open(self):
        state = self.manifest_state()
        commands = (
            'python -c "print(\'git push origin HEAD\')"',
            "git -c alias.lg='log --oneline' lg",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(self.bash(state, command).allow)


class PublicValueTests(unittest.TestCase):
    def test_guard_package_exports_the_immutable_public_values(self):
        from mae_flow_core import guard

        state = _state()
        context = guard.SafetyContext(state, "/repo")
        decision = guard.SafetyDecision(True)

        self.assertIsInstance(context, SafetyContext)
        self.assertIsInstance(decision, SafetyDecision)
        with self.assertRaises((AttributeError, TypeError)):
            decision.allow = False


if __name__ == "__main__":
    unittest.main()
