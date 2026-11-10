#!/usr/bin/env python3
"""CodeCheck execution use cases independent from the CLI monolith."""

import os
import sys
import types
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.application.quality.codecheck import (  # noqa: E402
    CodeCheckRunPorts,
    run_codecheck,
)


class TimeoutErrorFromPort(Exception):
    def __init__(self, stdout="", stderr=""):
        super().__init__("timeout")
        self.stdout = stdout
        self.stderr = stderr


class CodeCheckUseCaseTests(unittest.TestCase):
    def ports(self, **overrides):
        self.events = []
        self.artifacts = []
        self.process_calls = []
        self.diagnostics = []
        times = iter((100.0, 100.25, 101.0, 101.5))

        def event(state, name, payload):
            self.events.append((name, payload))
            return "/logs/codecheck.md"

        def artifact(state, label, content, suffix=".txt"):
            value = {
                "path": "/artifacts/" + label + suffix,
                "content": content,
            }
            self.artifacts.append(value)
            return value

        def process(launch, use_shell):
            self.process_calls.append((launch, use_shell))
            return types.SimpleNamespace(
                returncode=1,
                stdout="代码检查完成\n共有 0 条告警\n",
                stderr="",
            )

        def diagnostic(command, return_code, output, report):
            self.diagnostics.append(
                (command, return_code, output, report))
            return ".mae-flow-work/codecheck-diagnostics/snapshot.txt"

        values = {
            "cwd": "/repo",
            "head": lambda: "abc123",
            "append_event": event,
            "ensure_capability": lambda: {
                "available": True,
                "path": "/tools/codecheck",
                "detail": "",
                "installed": False,
            },
            "split_batches": lambda files: [list(files)],
            "build_launch": lambda batch, executable: (
                [executable, "fullcheck", "-f", ",".join(batch)],
                False,
                "codecheck fullcheck -f " + ",".join(batch),
            ),
            "clock": lambda: next(times),
            "run_process": process,
            "is_timeout": lambda error: isinstance(
                error, TimeoutErrorFromPort),
            "save_artifact": artifact,
            "read_text": lambda path: "",
            "modified_time": lambda path: 100.0,
            "parse_json_file": lambda path: (None, ()),
            "log_path": lambda state: "/logs/fallback.md",
            "save_diagnostic": diagnostic,
            "program_path": "/repo/scripts/mae-flow.py",
        }
        values.update(overrides)
        return CodeCheckRunPorts(**values)

    def test_capability_failure_preserves_event_order_and_risk_message(self):
        ports = self.ports(ensure_capability=lambda: {
            "available": False,
            "path": "",
            "detail": "registry unavailable",
            "installed": None,
        })

        result = run_codecheck(
            ("src/a.cpp",), {"current": "tw_codecheck"}, "scan", ports)

        self.assertIsNone(result.scan)
        self.assertIn("CodeCheck CLI 当前不可用", result.error)
        self.assertIn("registry unavailable", result.error)
        self.assertEqual(
            ["run.started", "capability.checked", "run.failed"],
            [name for name, _payload in self.events],
        )
        self.assertEqual(
            "capability-unavailable", self.events[-1][1]["kind"])
        self.assertEqual([], self.process_calls)

    def test_timeout_persists_raw_streams_and_stops_the_run(self):
        def timeout(_launch, _shell):
            raise TimeoutErrorFromPort("partial-out", "partial-error")

        ports = self.ports(run_process=timeout)

        result = run_codecheck(
            ("src/a.cpp",), {}, "done", ports)

        self.assertIsNone(result.scan)
        self.assertEqual(
            "codecheck 现场检查超时(>15min)——批次过大或服务异常",
            result.error,
        )
        self.assertEqual(
            ["batch-1-timeout-stdout", "batch-1-timeout-stderr"],
            [item["path"].split("/")[-1].split(".")[0]
             for item in self.artifacts],
        )
        self.assertEqual("command.failed", self.events[-1][0])
        self.assertEqual("timeout", self.events[-1][1]["kind"])

    def test_nonzero_batches_are_aggregated_when_output_is_parseable(self):
        replies = iter((
            types.SimpleNamespace(
                returncode=1,
                stdout="代码检查完成\n共有 2 条告警\n",
                stderr="first-note",
            ),
            types.SimpleNamespace(
                returncode=7,
                stdout="代码检查完成\n共有 0 条告警\n",
                stderr="second-note",
            ),
        ))
        ports = self.ports(
            split_batches=lambda _files: [
                ["src/a.cpp"], ["src/b.cpp"]],
            run_process=lambda launch, shell: next(replies),
        )

        result = run_codecheck(
            ("src/a.cpp", "src/b.cpp"), {}, "scan", ports)

        self.assertEqual("", result.error)
        self.assertEqual(2, result.scan.total)
        self.assertEqual(
            (
                "codecheck fullcheck -f src/a.cpp",
                "codecheck fullcheck -f src/b.cpp",
            ),
            result.scan.commands,
        )
        self.assertEqual(
            [
                "run.started", "capability.checked",
                "command.started", "command.completed",
                "command.started", "command.completed",
                "run.completed",
            ],
            [name for name, _payload in self.events],
        )
        completed = [
            payload for name, payload in self.events
            if name == "command.completed"
        ]
        self.assertEqual([1, 7], [
            payload["return_code"] for payload in completed])

    def test_fresh_json_fallback_supplies_warning_details(self):
        report = "检查报告已保存到: /reports/result.md\n"
        ports = self.ports(
            run_process=lambda launch, shell: types.SimpleNamespace(
                returncode=0, stdout=report, stderr=""),
            read_text=lambda path: (
                "# opaque report" if path.endswith(".md")
                else '{"warning": true}'
            ),
            modified_time=lambda path: (
                90.0 if path.startswith(".codecheckcli") else 99.0),
            parse_json_file=lambda path: (
                1, (("RULE.ONE", "a.cpp", 9),)),
        )

        result = run_codecheck(
            ("src/a.cpp",), {}, "scan", ports)

        self.assertEqual("", result.error)
        self.assertEqual(1, result.scan.total)
        self.assertEqual(
            ("RULE.ONE", "src/a.cpp", 9),
            result.scan.warnings[0].as_tuple(),
        )
        completed = self.events[-2][1]
        self.assertEqual("json", completed["parsed_from"])
        self.assertEqual(
            "/reports/codecheck-result.json",
            completed["parsed_json_path"],
        )
        self.assertTrue(completed["parsed_json"]["path"].endswith(".json"))

    def test_stale_json_is_ignored_and_unparsed_output_is_diagnostic(self):
        ports = self.ports(
            run_process=lambda launch, shell: types.SimpleNamespace(
                returncode=0, stdout="unknown output", stderr=""),
            modified_time=lambda path: 90.0,
            parse_json_file=lambda path: self.fail(
                "stale JSON must not be parsed"),
        )

        result = run_codecheck(
            ("src/a.cpp",), {}, "scan", ports)

        self.assertIsNone(result.scan)
        self.assertIn("告警数无法解析", result.error)
        self.assertIn("codecheck-record", result.error)
        self.assertEqual(1, len(self.diagnostics))
        self.assertEqual("run.failed", self.events[-1][0])
        self.assertEqual("unparsed-output", self.events[-1][1]["kind"])

    def test_unsafe_file_name_is_rejected_before_process_launch(self):
        ports = self.ports()

        result = run_codecheck(
            ("src/a,b.cpp",), {}, "scan", ports)

        self.assertIsNone(result.scan)
        self.assertIn("无法安全传入", result.error)
        self.assertEqual([], self.process_calls)
        self.assertEqual("unsafe-file-name", self.events[-1][1]["kind"])


if __name__ == "__main__":
    unittest.main()
