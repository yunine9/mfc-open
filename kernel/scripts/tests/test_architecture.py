#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Architecture boundaries for behavior-preserving Mae-Flow refactoring."""

import ast
import json
import os
import sys
import tempfile
import unittest


TESTS = os.path.abspath(os.path.dirname(__file__))
if TESTS not in sys.path:
    sys.path.insert(0, TESTS)

from architecture_rules import (  # noqa: E402
    LEGACY_OVERSIZED_CORE_MODULES,
    assert_delivery_dependencies,
    assert_foundation_dependencies,
    assert_guard_dependencies,
    assert_hook_application_dependencies,
    assert_policy_dependencies,
    assert_quality_dependencies,
    delivery_complexity_violations,
    forbidden_calls,
    function_complexity,
    guard_complexity_violations,
    hook_complexity_violations,
    line_count,
    module_imports,
    new_module_size_violations,
    private_cli_import_violations,
    private_hook_import_violations,
    quality_complexity_violations,
    unmanaged_runtime_open_violations,
    unreachable_core_modules,
    workflow_complexity_violations,
)


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class ArchitectureTests(unittest.TestCase):
    def _write_core_fixture(self, package, source):
        temporary = tempfile.TemporaryDirectory()
        path = os.path.join(
            temporary.name,
            "scripts",
            "mae_flow_core",
            package,
            "fixture.py",
        )
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(source)
        self.addCleanup(temporary.cleanup)
        return temporary.name

    def _write_foundation_fixture(self, source):
        return self._write_core_fixture("foundation", source)

    def test_existing_monoliths_do_not_grow(self):
        baseline_path = os.path.join(
            ROOT, "scripts", "tests", "architecture_baseline.json")
        with open(baseline_path, encoding="utf-8") as stream:
            baseline = json.load(stream)
        for relative, maximum in baseline["max_lines"].items():
            with self.subTest(relative=relative):
                self.assertLessEqual(
                    line_count(os.path.join(ROOT, relative)), maximum)

    def test_foundation_has_no_reverse_dependencies(self):
        self.assertEqual([], assert_foundation_dependencies(ROOT))

    def test_runtime_entrypoints_have_no_unmanaged_open_calls(self):
        self.assertEqual([], unmanaged_runtime_open_violations(ROOT))

    def test_foundation_rejects_relative_reverse_imports(self):
        root = self._write_foundation_fixture(
            "from ..workflow import engine\n")
        self.assertEqual(
            [
                "scripts/mae_flow_core/foundation/fixture.py:1: "
                "forbidden import mae_flow_core.workflow"
            ],
            assert_foundation_dependencies(root),
        )

    def test_foundation_rejects_parent_relative_module_imports(self):
        root = self._write_foundation_fixture(
            "from .. import workflow\n")
        self.assertEqual(
            [
                "scripts/mae_flow_core/foundation/fixture.py:1: "
                "forbidden import mae_flow_core.workflow"
            ],
            assert_foundation_dependencies(root),
        )

    def test_foundation_rejects_aliased_forbidden_calls(self):
        root = self._write_foundation_fixture(
            "import subprocess as sp\nsp.run(['git', 'status'])\n")
        self.assertEqual(
            [
                "scripts/mae_flow_core/foundation/fixture.py:2: "
                "forbidden call subprocess.run"
            ],
            assert_foundation_dependencies(root),
        )

    def test_workflow_policy_has_no_direct_side_effects(self):
        self.assertEqual([], assert_policy_dependencies(ROOT))

    def test_guard_policy_has_no_direct_side_effects(self):
        self.assertEqual([], assert_guard_dependencies(ROOT))

    def test_guard_functions_stay_within_complexity_limit(self):
        self.assertEqual([], guard_complexity_violations(ROOT))

    def test_quality_policy_has_no_direct_side_effects(self):
        self.assertEqual([], assert_quality_dependencies(ROOT))

    def test_quality_application_rejects_direct_process_calls(self):
        root = self._write_core_fixture(
            "application/quality",
            "import subprocess as sp\nsp.run(['codecheck'])\n",
        )
        self.assertEqual(
            [
                "scripts/mae_flow_core/application/quality/fixture.py:2: "
                "forbidden call subprocess.run"
            ],
            assert_quality_dependencies(root),
        )

    def test_quality_functions_stay_within_complexity_limit(self):
        self.assertEqual([], quality_complexity_violations(ROOT))

    def test_delivery_policy_has_no_direct_side_effects(self):
        self.assertEqual([], assert_delivery_dependencies(ROOT))

    def test_hook_application_has_no_direct_side_effects(self):
        self.assertEqual([], assert_hook_application_dependencies(ROOT))

    def test_hook_application_functions_stay_within_complexity_limit(self):
        self.assertEqual([], hook_complexity_violations(ROOT))

    def test_hook_entrypoint_is_a_bounded_protocol_adapter(self):
        path = os.path.join(ROOT, "hooks", "dispatch.py")
        self.assertLessEqual(line_count(path), 800)
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
        definitions = {
            node.name for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        migrated = {
            "_record_agent_token", "_contract_state", "_record_rejection",
            "_source_snapshot", "_source_like", "_codecheck_contract",
            "_ut_contract", "_grill_contract", "_compile_contract",
            "_gate_agent_dispatch", "ev_pretooluse",
            "ev_action_pretooluse", "ev_inject", "ev_subagentstop",
            "ev_posttooluse", "ev_stop", "_autopsy",
            "_run_agent_contract", "_agent_completion_ports",
        }
        self.assertEqual(set(), definitions & migrated)

    def test_business_tests_do_not_import_hook_private_policy(self):
        self.assertEqual([], private_hook_import_violations(ROOT))

    def test_business_tests_do_not_import_cli_private_policy(self):
        self.assertEqual([], private_cli_import_violations(ROOT))

    def test_cli_command_modules_use_explicit_shared_dependencies(self):
        commands = os.path.join(
            ROOT, "scripts", "mae_flow_core", "cli_commands")
        violations = []
        for name in sorted(os.listdir(commands)):
            if not name.endswith(".py"):
                continue
            path = os.path.join(commands, name)
            with open(path, encoding="utf-8") as stream:
                tree = ast.parse(stream.read(), filename=path)
            if any(
                isinstance(node, ast.ImportFrom)
                and node.module == "shared"
                and node.level == 1
                and any(alias.name == "*" for alias in node.names)
                for node in ast.walk(tree)
            ):
                violations.append(name)
        self.assertEqual([], violations)

    def test_delivery_functions_stay_within_complexity_limit(self):
        self.assertEqual([], delivery_complexity_violations(ROOT))

    def test_command_dispatch_has_no_direct_side_effects(self):
        path = os.path.join(
            ROOT, "scripts", "mae_flow_core", "command_dispatch.py")
        self.assertEqual([], forbidden_calls(path))

    def test_workflow_rejects_aliased_process_calls(self):
        root = self._write_core_fixture(
            "workflow",
            "import subprocess as sp\nsp.run(['git', 'status'])\n",
        )
        self.assertEqual(
            [
                "scripts/mae_flow_core/workflow/fixture.py:2: "
                "forbidden call subprocess.run"
            ],
            assert_policy_dependencies(root),
        )

    def test_no_production_module_is_unreachable_from_the_entrypoints(self):
        """插件只有两个真实入口；任何进不去的运行时模块都是排障陷阱。"""
        self.assertEqual([], unreachable_core_modules(ROOT))

    def test_refactored_core_modules_stay_within_size_limit(self):
        self.assertEqual([], new_module_size_violations(ROOT))

    def test_oversized_core_module_allowlist_is_empty(self):
        self.assertEqual(set(), LEGACY_OVERSIZED_CORE_MODULES)

    def test_cli_contains_no_evidence_policy_or_registry_dict(self):
        path = os.path.join(ROOT, "scripts", "mae-flow.py")
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
        evidence_functions = sorted(
            node.name for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name.startswith("ev_")
        )
        self.assertEqual([], evidence_functions)
        evidence_dicts = [
            node for node in ast.walk(tree)
            if isinstance(node, (ast.Assign, ast.AnnAssign))
            and any(
                isinstance(target, ast.Name) and target.id == "EVIDENCE"
                for target in (
                    node.targets if isinstance(node, ast.Assign)
                    else [node.target]
                )
            )
            and isinstance(node.value, ast.Dict)
        ]
        self.assertEqual([], evidence_dicts)

    def test_entrypoints_contain_no_extracted_guard_policy(self):
        forbidden_rules = {
            "edit-specs",
            "edit-source",
            "edit-tests-only",
            "bash-branch-name",
            "bash-commit-format",
            "bash-wipe-worktree",
            "bash-wide-openspec-add",
            "bash-cross-delivery-carryover",
            "bash-foreign-openspec",
            "bash-build-artifacts",
        }
        for relative in ("scripts/mae-flow.py", "hooks/dispatch.py"):
            with open(os.path.join(ROOT, relative), encoding="utf-8") as stream:
                tree = ast.parse(stream.read())
            constants = {
                node.value for node in ast.walk(tree)
                if isinstance(node, ast.Constant)
                and isinstance(node.value, str)
            }
            with self.subTest(relative=relative):
                self.assertEqual(
                    set(),
                    forbidden_rules & constants,
                    "Gate policy rule ids belong in mae_flow_core.guard",
                )

    def test_cli_contains_no_delivery_recovery_policy(self):
        path = os.path.join(ROOT, "scripts", "mae-flow.py")
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
        forbidden = {
            "_refresh_staged_checkpoint",
            "_accept_pushed_checkpoint",
            "_verify_reviewed_checkpoint_commit",
            "_verify_reviewed_checkpoint_push",
            "_refresh_pending_checkpoint_commit",
            "_refresh_pending_checkpoint_reset",
            "_refresh_pending_checkpoint_push",
            "_refresh_checkpoint_status",
            "_final_commit_recovery",
            "_refresh_final_pending_commit",
            "_refresh_final_pending_reset",
            "_migrate_legacy_final_push_pending",
            "_refresh_final_review_status",
            "_activate_final_rework",
        }
        definitions = {
            node.name for node in ast.walk(tree)
            if isinstance(
                node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertEqual(
            set(),
            forbidden & definitions,
            "Delivery recovery policy belongs in application.delivery",
        )

    def test_cli_contains_no_migrated_quality_policy_helpers(self):
        path = os.path.join(ROOT, "scripts", "mae-flow.py")
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
        forbidden = {
            "_parse_codecheck_count",
            "_parse_codecheck_json",
            "_scope_classify_codecheck",
            "_scope_filter_codecheck",
            "_render_warning_pairs",
            "_task_file_groups",
            "_execution_root_for_file",
            "_task_execution_roots",
            "_append_task_files",
            "_append_execution_context",
            "_requirement_sources",
            "_batches",
        }
        definitions = {
            node.name
            for node in ast.walk(tree)
            if isinstance(
                node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertEqual(
            set(),
            forbidden & definitions,
            "Quality policy belongs in mae_flow_core quality modules",
        )

    def test_workflow_functions_stay_within_complexity_limit(self):
        self.assertEqual([], workflow_complexity_violations(ROOT))

    def test_workflow_complexity_reports_oversized_function(self):
        root = self._write_core_fixture(
            "workflow",
            "def crowded(value):\n"
            + "".join(
                "    if value == %d:\n        value += 1\n" % index
                for index in range(16)
            ),
        )
        self.assertEqual(
            [
                "scripts/mae_flow_core/workflow/fixture.py:1: "
                "crowded complexity 17 exceeds 15"
            ],
            workflow_complexity_violations(root),
        )

    def test_function_complexity_counts_boolean_decisions(self):
        root = self._write_core_fixture(
            "workflow",
            "def choose(one, two, three):\n"
            "    if one and two and three:\n"
            "        return one\n"
            "    return two\n",
        )
        path = os.path.join(
            root,
            "scripts",
            "mae_flow_core",
            "workflow",
            "fixture.py",
        )
        self.assertEqual(4, function_complexity(path, "choose"))

    def test_new_core_module_rejects_more_than_500_lines(self):
        root = self._write_core_fixture(
            "workflow",
            "value = 1\n" * 501,
        )
        self.assertEqual(
            [
                "scripts/mae_flow_core/workflow/fixture.py: "
                "501 lines exceeds 500"
            ],
            new_module_size_violations(root),
        )

    def test_configured_adapter_complexity_limits_are_enforced(self):
        baseline_path = os.path.join(
            ROOT, "scripts", "tests", "architecture_baseline.json")
        with open(baseline_path, encoding="utf-8") as stream:
            baseline = json.load(stream)
        self.assertIn("max_complexity", baseline)
        for relative, functions in baseline["max_complexity"].items():
            for name, maximum in functions.items():
                with self.subTest(relative=relative, function=name):
                    self.assertLessEqual(
                        function_complexity(
                            os.path.join(ROOT, relative),
                            name,
                        ),
                        maximum,
                    )

    def test_selftest_runs_refactor_safety_suites(self):
        from selftest_suites import (
            REFACTOR_SAFETY_SUITES,
            execute_refactor_safety_suites,
        )
        commands = {
            tuple(command)
            for _label, command, _timeout, _output_limit
            in REFACTOR_SAFETY_SUITES
        }
        expected = {
            ("scripts/tests/test_architecture.py",),
            ("scripts/tests/test_guard_intent.py",),
            ("scripts/tests/test_quality_task_cards.py",),
            ("scripts/tests/test_command_dispatch.py",),
            ("scripts/tests/test_refactor_completion.py",),
            ("scripts/tests/test_fault_injection.py",),
        }
        self.assertTrue(expected.issubset(commands))

        calls = []
        reports = []

        class Result:
            stdout = ""
            stderr = ""

            def __init__(self, returncode):
                self.returncode = returncode

        def fake_run(argv, **kwargs):
            calls.append((tuple(argv), kwargs))
            return Result(9 if len(calls) == 1 else 0)

        def fake_report(label, ok, detail):
            reports.append((label, ok, detail))

        execute_refactor_safety_suites(
            ROOT, sys.executable, report=fake_report, run=fake_run)
        self.assertEqual(len(REFACTOR_SAFETY_SUITES), len(calls))
        self.assertEqual(len(REFACTOR_SAFETY_SUITES), len(reports))
        self.assertFalse(reports[0][1])
        self.assertTrue(all(ok for _label, ok, _detail in reports[1:]))
        self.assertEqual(commands, {
            tuple(os.path.relpath(argv[1], ROOT) if index == 0 else value
                  for index, value in enumerate(argv[1:]))
            for argv, _kwargs in calls
        })
        self.assertTrue(all(
            kwargs["capture_output"] and not kwargs["check"]
            for _argv, kwargs in calls
        ))

        with open(
                os.path.join(ROOT, "scripts", "selftest.py"),
                encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
        self.assertTrue(any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "execute_refactor_safety_suites"
            and any(
                keyword.arg == "report"
                and isinstance(keyword.value, ast.Name)
                and keyword.value.id == "check"
                for keyword in node.keywords
            )
            for node in ast.walk(tree)
        ), "selftest must execute suites with the real failure reporter")

    def test_import_expansion_catches_from_package_import_module(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = os.path.join(temporary, "fixture.py")
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(
                    "from scripts import tests\n"
                    "from scripts.tests import fault_injection\n"
                )
            imports = module_imports(path)
            self.assertIn("scripts.tests", imports)
            self.assertIn("scripts.tests.fault_injection", imports)

    def test_production_code_cannot_import_test_fault_injection(self):
        production = [
            os.path.join(ROOT, "scripts", "mae-flow.py"),
            os.path.join(ROOT, "scripts", "comet_compat.py"),
            os.path.join(ROOT, "scripts", "statusline.py"),
            os.path.join(ROOT, "hooks", "dispatch.py"),
        ]
        for current, _dirs, files in os.walk(
                os.path.join(ROOT, "scripts", "mae_flow_core")):
            production.extend(
                os.path.join(current, name)
                for name in files if name.endswith(".py"))
        for path in production:
            with self.subTest(path=os.path.relpath(path, ROOT)):
                imports = module_imports(path)
                self.assertFalse(any(
                    name == "fault_injection"
                    or name.startswith("scripts.tests")
                    or ".fault_injection" in name
                    for name in imports
                ), imports)


if __name__ == "__main__":
    unittest.main()
