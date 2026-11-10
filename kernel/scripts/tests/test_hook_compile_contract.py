#!/usr/bin/env python3
"""Tests for the pure COMPILE Agent contract."""

import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.agent_contracts import (  # noqa: E402
    AgentContractContext,
)
from mae_flow_core.quality.compile_contract import (  # noqa: E402
    evaluate_compile_contract,
)
from mae_flow_core.quality.tool_transcript import ToolCall  # noqa: E402
from mae_flow_core import save_versioned_json  # noqa: E402
from mae_flow_core.adapters.hook_runtime import HookRuntimeAdapter  # noqa: E402


def call(name, value, result="", seen=True, error=False):
    return ToolCall(
        call_id="fixture",
        name=name,
        input=value,
        result_seen=seen,
        is_error=error,
        result=result,
    )


@contextlib.contextmanager
def in_directory(path):
    original = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(original)


def initialize_repository(root):
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "mae-flow@test.invalid"],
        cwd=root, check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Mae Flow Test"],
        cwd=root, check=True,
    )
    with open(os.path.join(root, ".gitignore"), "w", encoding="utf-8") as stream:
        stream.write(".mae-flow*\n")
    config_path = os.path.join(root, "config", "runtime.json")
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as stream:
        stream.write('{"runtime": "before"}\n')
    subprocess.run(
        ["git", "add", ".gitignore", "config/runtime.json"],
        cwd=root, check=True,
    )
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()


def runtime_for(root, logs=None):
    return HookRuntimeAdapter(
        state=os.path.join(root, ".mae-flow.json"),
        exit_state=os.path.join(root, ".mae-flow.json.exited"),
        action_state=os.path.join(root, ".mae-flow-work", "action.json"),
        rejection_state=os.path.join(root, ".mae-flow.json.agent-rejections"),
        evidence_state=os.path.join(root, ".mae-flow.json.agent-evidence"),
        agent_writes_state=os.path.join(root, ".mae-flow.json.agent-writes"),
        moonlight_intent=os.path.join(root, ".mae-flow.json.moonlight-intent"),
        exit_intent=os.path.join(root, ".mae-flow.json.exit-intent"),
        maeflow=os.path.join(ROOT, "scripts", "mae-flow.py"),
        log=logs.append if logs is not None else lambda _message: None,
    )


def compile_task(root, head, worktree_snapshot, baseline_valid=True):
    body = "# COMPILE fixture task\n"
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    task_path = os.path.join(root, ".mae-flow-work", "compile-task.md")
    os.makedirs(os.path.dirname(task_path), exist_ok=True)
    with open(task_path, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(body)
        stream.write("TASK_CARD_SHA256: %s\n" % digest)
    return {
        "step": "build",
        "path": task_path,
        "sha256": digest,
        "head": head,
        "worktree_snapshot": worktree_snapshot,
        "worktree_snapshot_valid": baseline_valid,
    }


def save_compile_state(root, task):
    save_versioned_json(
        os.path.join(root, ".mae-flow.json"),
        {
            "current": "build",
            "config": {"编译方式": "python build.py"},
            "choices": {},
            "history": [],
            "started": "2026-07-30 10:00:00",
            "agent_tasks": {"COMPILE": task},
        },
        "flow",
        project_root=root,
    )


def accepted_report(task):
    return (
        "COMPILE_RESULT: OK\n"
        "TASK_CARD_SHA256: %s\n"
        "EXECUTED_BUILD: python build.py\n"
        "BUILD_ERRORS: 0"
        % task["sha256"]
    )


class CompileContractTests(unittest.TestCase):
    def context(self, report, calls=(), status="OK", net=0, build=None):
        return AgentContractContext(
            kind="COMPILE",
            status=status,
            report=report,
            task={"step": "build"},
            config={"编译方式": build or "python build.py"},
            calls=tuple(calls),
            changed_paths=(),
            compile_net=net,
        )

    def test_ok_requires_the_configured_successful_build_call(self):
        report = "EXECUTED_BUILD: python build.py\nBUILD_ERRORS: 0"
        accepted = evaluate_compile_contract(self.context(
            report,
            [call(
                "Bash",
                {"command": "python build.py"},
                "build complete\nexit code: 0",
            )],
        ))
        self.assertTrue(accepted.accepted)

        missing = evaluate_compile_contract(self.context(report))
        self.assertFalse(missing.accepted)
        self.assertIn("没有真实执行配置的编译命令", missing.reason)

    def test_ok_rejects_explicit_host_tool_failure(self):
        report = "EXECUTED_BUILD: python build.py\nBUILD_ERRORS: 0"
        failed = evaluate_compile_contract(self.context(
            report,
            [call(
                "Bash",
                {"command": "python build.py"},
                "process exited with code 2",
            )],
        ))
        self.assertIn("工具结果明确失败", failed.reason)

    def test_opaque_build_fix_does_not_require_provider_output_fields(self):
        decision = evaluate_compile_contract(self.context(
            "provider diagnostics are intentionally opaque",
            [call(
                "Skill",
                {"skill": "build-fix"},
                "internal result format is not public",
            )],
            build="build-fix",
        ))

        self.assertTrue(decision.accepted, decision.reason)

    def test_reported_provider_counts_are_diagnostic_not_a_second_compiler(self):
        decision = evaluate_compile_contract(self.context(
            "EXECUTED_BUILD: internal wrapper\nBUILD_ERRORS: 3",
            [call(
                "Skill",
                {"skill": "build-fix"},
                "opaque",
            )],
            build="build-fix",
        ))

        self.assertTrue(decision.accepted, decision.reason)
        self.assertTrue(decision.details["build_summary_inaccurate"])
        self.assertTrue(decision.details["reported_error_conflict"])

    def test_matching_compile_receipt_replaces_only_missing_tool_call(self):
        decision = evaluate_compile_contract(AgentContractContext(
            kind="COMPILE",
            status="OK",
            report="corrected report without another build",
            task={"step": "build", "sha256": "task"},
            config={"编译方式": "build-fix"},
            calls=(),
            changed_paths=(),
            compile_net=0,
            reusable_receipts={
                "COMPILE_RUN": {
                    "step": "build",
                    "task_sha256": "task",
                    "build": "build-fix",
                    "status": "OK",
                },
            },
        ))

        self.assertTrue(decision.accepted, decision.reason)
        self.assertTrue(decision.details["reused_execution"])

    def test_compile_receipt_cannot_override_host_failure_or_status(self):
        receipt = {
            "step": "build",
            "task_sha256": "task",
            "build": "build-fix",
            "status": "OK",
        }
        failed = evaluate_compile_contract(AgentContractContext(
            kind="COMPILE",
            status="OK",
            report="",
            task={"step": "build", "sha256": "task"},
            config={"编译方式": "build-fix"},
            calls=(call(
                "Skill", {"skill": "build-fix"},
                "host error", error=True),),
            reusable_receipts={"COMPILE_RUN": receipt},
        ))
        wrong_status = evaluate_compile_contract(AgentContractContext(
            kind="COMPILE",
            status="BLOCKED",
            report="",
            task={"step": "build", "sha256": "task"},
            config={"编译方式": "build-fix"},
            calls=(),
            reusable_receipts={"COMPILE_RUN": receipt},
        ))
        wrong_issuance = evaluate_compile_contract(AgentContractContext(
            kind="COMPILE",
            status="OK",
            report="",
            task={
                "step": "build",
                "sha256": "task",
                "issuance_id": "issue-2",
            },
            config={"编译方式": "build-fix"},
            calls=(),
            reusable_receipts={
                "COMPILE_RUN": dict(
                    receipt, task_issuance_id="issue-1"),
            },
        ))

        self.assertFalse(failed.accepted)
        self.assertIn("工具结果明确失败", failed.reason)
        self.assertFalse(wrong_status.accepted)
        self.assertFalse(wrong_issuance.accepted)

    def test_blocked_accepts_a_real_failed_attempt_with_errors(self):
        decision = evaluate_compile_contract(self.context(
            "EXECUTED_BUILD: python build.py\nBUILD_ERRORS: 2",
            [call(
                "Bash",
                {"command": "python build.py"},
                "process exited with code 2",
            )],
            status="BLOCKED",
        ))
        self.assertTrue(decision.accepted)

    def test_skill_build_uses_the_last_matching_tool_result(self):
        decision = evaluate_compile_contract(self.context(
            "EXECUTED_BUILD: build-fix / mcde build -i\nBUILD_ERRORS: 0",
            [
                call(
                    "Skill",
                    {"skill": "build-fix"},
                    "first failed",
                    error=True,
                ),
                call(
                    "Skill",
                    {"skill": "build-fix"},
                    "fixed",
                ),
            ],
            build="build-fix",
        ))
        self.assertTrue(decision.accepted)

    def test_net_deletion_requires_a_nonempty_shrink_exemption(self):
        base = (
            "EXECUTED_BUILD: python build.py\n"
            "BUILD_ERRORS: 0\n"
        )
        calls = [call("Bash", {"command": "python build.py"}, "done")]
        rejected = evaluate_compile_contract(
            self.context(base, calls, net=-4))
        self.assertIn("代码净删 4 行", rejected.reason)

        accepted = evaluate_compile_contract(self.context(
            base + "SHRINK_EXEMPT:\nremoved duplicate wrapper\n",
            calls,
            net=-4,
        ))
        self.assertTrue(accepted.accepted)

    def test_honest_fail_does_not_require_execution_fields(self):
        decision = evaluate_compile_contract(self.context(
            "compiler unavailable",
            status="FAIL",
        ))
        self.assertTrue(decision.accepted)

    def test_runtime_reuses_successful_compile_when_only_report_is_corrected(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            logs = []
            runtime = runtime_for(td, logs)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            calls = [{
                "name": "Bash",
                "input": {"command": "python build.py"},
                "result_seen": True,
                "result": "private compiler output that must not be stored",
            }]

            with mock.patch.object(
                    runtime, "_compile_agent_net", return_value=-1):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as rejected:
                        runtime._compile_contract(
                            "OK", accepted_report(task), calls)
                self.assertEqual(2, rejected.exception.code)

                with open(runtime.EVIDENCE_STATE, encoding="utf-8") as stream:
                    evidence = json.load(stream)
                receipt = evidence["COMPILE_RUN"]
                self.assertEqual("OK", receipt["status"])
                self.assertNotIn("private compiler output", repr(receipt))

                runtime._compile_contract(
                    "OK",
                    accepted_report(task)
                    + "\nSHRINK_EXEMPT:\nremoved duplicate wrapper\n",
                    [],
                )

            self.assertTrue(any(
                "COMPILE 重答复用编译凭证" in entry
                for entry in logs))

    def test_accepted_compile_records_only_non_direct_worktree_effects(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            runtime = runtime_for(td)
            baseline = runtime._worktree_snapshot(head)
            task = compile_task(td, head, baseline)
            save_compile_state(td, task)
            generated = os.path.join(td, "generated", "build.properties")
            os.makedirs(os.path.dirname(generated), exist_ok=True)
            with open(generated, "w", encoding="utf-8") as stream:
                stream.write("compiled=true\n")
            with open(
                    os.path.join(td, "config", "runtime.json"),
                    "w", encoding="utf-8") as stream:
                stream.write('{"runtime": "after"}\n')
            with open(
                    os.path.join(td, ".mae-flow.json.agent-writes"),
                    "w", encoding="utf-8") as stream:
                json.dump(
                    {"paths": {"legacy/write.cpp": {"tool": "file-write"}}},
                    stream,
                )

            runtime._compile_contract(
                "OK",
                accepted_report(task),
                [
                    {
                        "name": "Bash",
                        "input": {"command": "python build.py"},
                        "result_seen": True,
                        "result": "build complete\nexit code: 0",
                    },
                    {
                        "name": "Edit",
                        "input": {"file_path": "config/runtime.json"},
                        "result_seen": True,
                        "result": "updated runtime",
                    },
                ],
            )

            with open(
                    os.path.join(td, ".mae-flow.json.agent-writes"),
                    encoding="utf-8") as stream:
                ledger = json.load(stream)
            self.assertEqual(["generated/build.properties"], sorted(
                ledger["compile_side_effects"]))
            self.assertEqual(
                task["sha256"],
                ledger["compile_side_effects"]
                ["generated/build.properties"]["task_sha256"],
            )
            self.assertIn("legacy/write.cpp", ledger["paths"])

            runtime._record_agent_write("generated/build.properties")
            with open(
                    os.path.join(td, ".mae-flow.json.agent-writes"),
                    encoding="utf-8") as stream:
                superseded = json.load(stream)
            self.assertNotIn(
                "generated/build.properties",
                superseded["compile_side_effects"],
            )
            self.assertIn("generated/build.properties", superseded["paths"])

    def test_tracked_repo_defaults_are_recorded_as_compile_side_effects(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            initialize_repository(td)
            defaults = os.path.join(td, ".mae-flow-defaults.json")
            with open(defaults, "w", encoding="utf-8") as stream:
                stream.write('{"编译方式": "before"}\n')
            subprocess.run(
                ["git", "add", "-f", ".mae-flow-defaults.json"],
                cwd=td,
                check=True,
            )
            subprocess.run(
                ["git", "commit", "-qm", "track repository defaults"],
                cwd=td,
                check=True,
            )
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=td,
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            runtime = runtime_for(td)
            task = compile_task(
                td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            with open(defaults, "w", encoding="utf-8") as stream:
                stream.write('{"编译方式": "compile changed"}\n')

            runtime._compile_contract(
                "OK",
                accepted_report(task),
                [{
                    "name": "Bash",
                    "input": {"command": "python build.py"},
                    "result_seen": True,
                    "result": "build complete\nexit code: 0",
                }],
            )

            with open(
                    runtime.AGENT_WRITES_STATE,
                    encoding="utf-8") as stream:
                ledger = json.load(stream)
            self.assertIn(
                ".mae-flow-defaults.json",
                ledger["compile_side_effects"],
            )
            self.assertNotIn(
                ".mae-flow.json",
                ledger["compile_side_effects"],
            )

    def test_rejected_compile_contract_does_not_record_side_effects(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            runtime = runtime_for(td)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            generated = os.path.join(td, "generated", "build.properties")
            os.makedirs(os.path.dirname(generated), exist_ok=True)
            with open(generated, "w", encoding="utf-8") as stream:
                stream.write("compiled=true\n")

            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as rejected:
                    runtime._compile_contract("OK", accepted_report(task), [])
            self.assertEqual(2, rejected.exception.code)
            self.assertFalse(os.path.exists(
                os.path.join(td, ".mae-flow.json.agent-writes")))

    def test_invalid_baseline_accepts_contract_without_attributing_existing_dirt(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            dirty = os.path.join(td, "config", "runtime.json")
            with open(dirty, "w", encoding="utf-8") as stream:
                stream.write('{"runtime": "pre-existing dirty"}\n')
            runtime = runtime_for(td)
            task = compile_task(td, head, {}, baseline_valid=False)
            save_compile_state(td, task)

            runtime._compile_contract(
                "OK",
                accepted_report(task),
                [{
                    "name": "Bash",
                    "input": {"command": "python build.py"},
                    "result_seen": True,
                    "result": "build complete\nexit code: 0",
                }],
            )

            self.assertFalse(os.path.exists(runtime.AGENT_WRITES_STATE))

    def test_transcript_direct_write_removes_old_effect_without_new_delta(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            runtime = runtime_for(td)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            with open(runtime.AGENT_WRITES_STATE, "w", encoding="utf-8") as stream:
                json.dump({
                    "paths": {},
                    "compile_side_effects": {
                        "config/runtime.json": {
                            "task_sha256": "older-compile",
                        },
                    },
                }, stream)

            runtime._compile_contract(
                "OK",
                accepted_report(task),
                [
                    {
                        "name": "Bash",
                        "input": {"command": "python build.py"},
                        "result_seen": True,
                        "result": "build complete\nexit code: 0",
                    },
                    {
                        "name": "Edit",
                        "input": {"file_path": "config/runtime.json"},
                        "result_seen": True,
                        "result": "already correct",
                    },
                ],
            )

            with open(runtime.AGENT_WRITES_STATE, encoding="utf-8") as stream:
                ledger = json.load(stream)
            self.assertNotIn(
                "config/runtime.json",
                ledger["compile_side_effects"],
            )

    def test_windows_transcript_and_posttool_writes_supersede_ledger_identity(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            runtime = runtime_for(td)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            with open(
                    os.path.join(td, "config", "runtime.json"),
                    "w", encoding="utf-8") as stream:
                stream.write('{"runtime": "after"}\n')
            windows_os = mock.Mock(wraps=os)
            windows_os.name = "nt"

            with open(runtime.AGENT_WRITES_STATE, "w", encoding="utf-8") as stream:
                json.dump({
                    "paths": {},
                    "compile_side_effects": {
                        "CONFIG\\RUNTIME.JSON": {
                            "task_sha256": "older-compile",
                        },
                    },
                }, stream)
            with mock.patch(
                    "mae_flow_core.foundation.source_paths.os",
                    windows_os,
            ):
                runtime._compile_contract(
                    "OK",
                    accepted_report(task),
                    [
                        {
                            "name": "Bash",
                            "input": {"command": "python build.py"},
                            "result_seen": True,
                            "result": "build complete\nexit code: 0",
                        },
                        {
                            "name": "Edit",
                            "input": {"file_path": "config/runtime.json"},
                            "result_seen": True,
                            "result": "updated",
                        },
                    ],
                )
            with open(runtime.AGENT_WRITES_STATE, encoding="utf-8") as stream:
                transcript_ledger = json.load(stream)
            self.assertEqual({}, transcript_ledger["compile_side_effects"])

            with open(runtime.AGENT_WRITES_STATE, "w", encoding="utf-8") as stream:
                json.dump({
                    "paths": {},
                    "compile_side_effects": {
                        "CONFIG\\RUNTIME.JSON": {
                            "task_sha256": "older-compile",
                        },
                    },
                }, stream)
            with mock.patch(
                    "mae_flow_core.foundation.source_paths.os",
                    windows_os,
            ):
                runtime._record_agent_write("config/runtime.json")
            with open(runtime.AGENT_WRITES_STATE, encoding="utf-8") as stream:
                posttool_ledger = json.load(stream)
            self.assertEqual({}, posttool_ledger["compile_side_effects"])

    def test_transcript_symlink_alias_is_the_same_repository_path(self):
        with tempfile.TemporaryDirectory() as td:
            repository = os.path.join(td, "repository")
            alias = os.path.join(td, "repository-alias")
            os.makedirs(repository)
            os.symlink(repository, alias)
            with in_directory(repository):
                head = initialize_repository(repository)
                runtime = runtime_for(repository)
                task = compile_task(
                    repository, head, runtime._worktree_snapshot(head))
                save_compile_state(repository, task)
                with open(
                        os.path.join(repository, "config", "runtime.json"),
                        "w", encoding="utf-8") as stream:
                    stream.write('{"runtime": "after"}\n')

                runtime._compile_contract(
                    "OK",
                    accepted_report(task),
                    [
                        {
                            "name": "Bash",
                            "input": {"command": "python build.py"},
                            "result_seen": True,
                            "result": "build complete\nexit code: 0",
                        },
                        {
                            "name": "Edit",
                            "input": {
                                "file_path": os.path.join(
                                    alias, "config", "runtime.json"),
                            },
                            "result_seen": True,
                            "result": "updated",
                        },
                    ],
                )

                with open(
                        runtime.AGENT_WRITES_STATE,
                        encoding="utf-8") as stream:
                    ledger = json.load(stream)
                self.assertEqual(
                    {}, ledger["compile_side_effects"])

    def test_snapshot_failure_still_applies_direct_write_supersession(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            logs = []
            runtime = runtime_for(td, logs)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            with open(runtime.AGENT_WRITES_STATE, "w", encoding="utf-8") as stream:
                json.dump({
                    "paths": {},
                    "compile_side_effects": {
                        "config/runtime.json": {
                            "task_sha256": "older-compile",
                        },
                    },
                }, stream)
            calls = [
                {
                    "name": "Bash",
                    "input": {"command": "python build.py"},
                    "result_seen": True,
                    "result": "build complete\nexit code: 0",
                },
                {
                    "name": "Edit",
                    "input": {"file_path": "config/runtime.json"},
                    "result_seen": True,
                    "result": "already correct",
                },
            ]

            with mock.patch.object(
                    runtime,
                    "_worktree_snapshot",
                    side_effect=OSError("snapshot fixture unavailable"),
            ):
                runtime._compile_contract(
                    "OK", accepted_report(task), calls)

            with open(runtime.AGENT_WRITES_STATE, encoding="utf-8") as stream:
                ledger = json.load(stream)
            self.assertNotIn(
                "config/runtime.json",
                ledger["compile_side_effects"],
            )
            self.assertTrue(any(
                "snapshot fixture unavailable" in entry
                for entry in logs))

    def test_tracked_deletion_is_excluded_from_compile_attribution(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            runtime = runtime_for(td)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            os.remove(os.path.join(td, "config", "runtime.json"))

            runtime._compile_contract(
                "OK",
                accepted_report(task),
                [{
                    "name": "Bash",
                    "input": {"command": "python build.py"},
                    "result_seen": True,
                    "result": "build complete\nexit code: 0",
                }],
            )

            self.assertFalse(os.path.exists(runtime.AGENT_WRITES_STATE))

    def test_preexisting_deletion_is_absent_from_compile_baseline(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            os.remove(os.path.join(td, "config", "runtime.json"))
            runtime = runtime_for(td)

            baseline = runtime._worktree_snapshot(head)

            self.assertNotIn("config/runtime.json", baseline)

    def test_compile_provenance_failures_are_logged_without_rejecting(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            head = initialize_repository(td)
            logs = []
            runtime = runtime_for(td, logs)
            task = compile_task(td, head, runtime._worktree_snapshot(head))
            save_compile_state(td, task)
            generated = os.path.join(td, "generated", "build.properties")
            os.makedirs(os.path.dirname(generated), exist_ok=True)
            with open(generated, "w", encoding="utf-8") as stream:
                stream.write("compiled=true\n")
            calls = [{
                "name": "Bash",
                "input": {"command": "python build.py"},
                "result_seen": True,
                "result": "build complete\nexit code: 0",
            }]

            with mock.patch.object(
                    runtime,
                    "_worktree_snapshot",
                    side_effect=OSError("snapshot fixture unavailable"),
            ):
                runtime._compile_contract("OK", accepted_report(task), calls)
            self.assertTrue(any(
                "COMPILE side-effect ledger EXC: snapshot fixture unavailable"
                in entry for entry in logs))

            logs.clear()
            with open(runtime.AGENT_WRITES_STATE, "w", encoding="utf-8") as stream:
                stream.write("{unreadable ledger")
            runtime._compile_contract("OK", accepted_report(task), calls)
            self.assertTrue(any(
                "COMPILE side-effect ledger recovering unreadable sidecar"
                in entry for entry in logs))

            logs.clear()
            with open(runtime.AGENT_WRITES_STATE, "w", encoding="utf-8") as stream:
                stream.write("{unreadable direct ledger")
            runtime._record_agent_write("config/runtime.json")
            self.assertTrue(any(
                "agent write ledger recovering unreadable sidecar" in entry
                for entry in logs))

            logs.clear()
            with mock.patch(
                    "mae_flow_core.adapters.hook_runtime_state.update_json",
                    side_effect=OSError("update fixture unavailable"),
            ):
                runtime._compile_contract("OK", accepted_report(task), calls)
            self.assertTrue(any(
                "COMPILE side-effect ledger EXC: update fixture unavailable"
                in entry for entry in logs))

    def test_worktree_snapshot_surfaces_git_failures(self):
        with tempfile.TemporaryDirectory() as td, in_directory(td):
            logs = []
            runtime = runtime_for(td, logs)
            failed_git = mock.Mock(
                returncode=1,
                stdout="",
                stderr="fixture git failure",
            )
            with mock.patch(
                    "mae_flow_core.adapters.hook_runtime_source.subprocess.run",
                    return_value=failed_git,
            ):
                with self.assertRaises(RuntimeError):
                    runtime._worktree_snapshot("fixture-head")


if __name__ == "__main__":
    unittest.main()
