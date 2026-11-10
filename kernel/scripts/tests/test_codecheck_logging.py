import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core import cli_runtime as mf
from mae_flow_core import codecheck_log as log_core
from mae_flow_core.adapters.hook_runtime import create_hook_runtime


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, text=True,
        capture_output=True).stdout.strip()


def read_log(path):
    with open(path, encoding="utf-8") as stream:
        return stream.read()


def artifacts(path, contains):
    directory = os.path.join(
        os.path.dirname(path),
        os.path.splitext(os.path.basename(path))[0] + ".d")
    return [
        os.path.join(directory, name)
        for name in os.listdir(directory)
        if contains in name
    ]


class CodeCheckLoggingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mae-flow-codecheck-log-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "codecheck-log@test.invalid")
        git(self.repo, "config", "user.name", "CodeCheck Log Test")
        os.makedirs(os.path.join(self.repo, "src"))
        with open(os.path.join(self.repo, "src", "main.cpp"),
                  "w", encoding="utf-8") as stream:
            stream.write("int value = 1;\n")
        git(self.repo, "add", "src/main.cpp")
        git(self.repo, "commit", "-qm", "base")
        self.head = git(self.repo, "rev-parse", "HEAD")
        self.old_cwd = os.getcwd()
        os.chdir(self.repo)

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def state(self):
        return {
            "current": "tw_codecheck",
            "config": {"单号": "REQ-LOG-1"},
        }

    def test_paths_and_bounded_artifact(self):
        state = self.state()
        flow_path = log_core.codecheck_log_path(self.repo, state)
        self.assertEqual(
            flow_path,
            os.path.join(
                self.repo, ".mae-flow-work", "codecheck-logs",
                "REQ-LOG-1-tw_codecheck.md"))

        standalone = {
            "kind": "codecheck",
            "work_dir": os.path.join(
                self.repo, ".mae-flow-work", "standalone", "A1"),
        }
        self.assertEqual(
            log_core.codecheck_log_path(self.repo, standalone),
            os.path.join(
                self.repo, ".mae-flow-work", "standalone", "A1",
                "codecheck-debug.md"))

        old_limit = log_core.MAX_ARTIFACT_BYTES
        try:
            log_core.MAX_ARTIFACT_BYTES = 1024
            content = "A" * 2048 + "TAIL"
            artifact = log_core.save_codecheck_artifact(
                self.repo, state, "large-output", content)
        finally:
            log_core.MAX_ARTIFACT_BYTES = old_limit
        self.assertTrue(artifact["truncated"])
        self.assertEqual(
            artifact["sha256"],
            hashlib.sha256(content.encode("utf-8")).hexdigest())
        with open(artifact["path"], encoding="utf-8") as stream:
            stored = stream.read()
        self.assertIn("MAE-FLOW LOG TRUNCATED", stored)
        self.assertTrue(stored.endswith("TAIL"))

        blocked_root = os.path.join(self.tmp, "not-a-directory")
        with open(blocked_root, "w", encoding="utf-8") as stream:
            stream.write("file")
        self.assertEqual(
            log_core.append_codecheck_event(
                blocked_root, state, "must-not-raise", {"value": 1}),
            "")

    def test_harness_records_command_result_and_raw_output(self):
        state = self.state()
        real_run = mf.subprocess.run
        real_ensure = mf.ensure_codecheck

        def fake_run(args, *pargs, **kwargs):
            if ((isinstance(args, list) and "fullcheck" in args)
                    or (isinstance(args, str)
                        and "codecheck fullcheck" in args)):
                return types.SimpleNamespace(
                    returncode=1,
                    stdout="[CodeCheck] 完成\n💡 提示: 共有 2 条告警。\n",
                    stderr="scanner-note\n")
            return real_run(args, *pargs, **kwargs)

        try:
            mf.ensure_codecheck = lambda install=True: {
                "available": True,
                "path": "/fake/codecheck",
                "detail": "resolved from test",
                "installed": False,
            }
            mf.subprocess.run = fake_run
            result, error = mf._run_codecheck(
                ["src/main.cpp"], state, "test-scan")
        finally:
            mf.subprocess.run = real_run
            mf.ensure_codecheck = real_ensure

        self.assertFalse(error)
        self.assertEqual(result["total"], 2)
        text = read_log(result["log_path"])
        self.assertTrue(text.startswith("# Mae-Flow CodeCheck 详细日志"))
        self.assertNotIn('{"schema":', text)
        for title in (
                "开始执行 CodeCheck", "检查 CodeCheck 工具",
                "开始执行检查命令", "检查命令执行完成",
                "CodeCheck 执行完成"):
            self.assertIn(title, text)
        self.assertIn("### 实际命令", text)
        self.assertIn("codecheck fullcheck -f src/main.cpp", text)
        self.assertIn("**返回码**：1", text)
        self.assertIn("**解析告警数**：2", text)
        self.assertIn("共有 2 条告警", text)
        stdout_files = artifacts(result["log_path"], "stdout")
        stderr_files = artifacts(result["log_path"], "stderr")
        self.assertEqual(len(stdout_files), 1)
        self.assertEqual(len(stderr_files), 1)
        with open(stdout_files[0], encoding="utf-8") as stream:
            self.assertIn("共有 2 条告警", stream.read())
        with open(stderr_files[0], encoding="utf-8") as stream:
            self.assertEqual(stream.read(), "scanner-note\n")

    def test_hook_records_agent_commands_report_and_git_diff(self):
        state = self.state()
        state["agent_tasks"] = {"CODECHECK": {
            "step": "tw_codecheck",
            "head": self.head,
            "sha256": "a" * 64,
            "path": os.path.join(self.repo, ".mae-flow-work", "task.md"),
            "allowed_files": ["src/main.cpp"],
        }}
        with open("src/main.cpp", "a", encoding="utf-8") as stream:
            stream.write("int fixed = 2;\n")
        transcript = os.path.join(self.repo, "agent-transcript.jsonl")
        with open(transcript, "w", encoding="utf-8") as stream:
            stream.write("{}\n")
        tool_calls = [{
            "name": "Bash",
            "input": {
                "command": "codecheck fullcheck -f src/main.cpp",
            },
            "result_seen": True,
            "is_error": False,
            "result": "共有 0 条告警",
        }, {
            "name": "Edit",
            "input": {
                "file_path": os.path.join(self.repo, "src", "main.cpp"),
                "old_string": "int value = 1;",
                "new_string": "int value = 1;\nint fixed = 2;",
            },
            "result_seen": True,
            "is_error": False,
            "result": "updated",
        }]
        report = (
            "CODECHECK_RESULT: CLEAN\n"
            "FIXED_CHANGES:\n"
            "- src/main.cpp | R.ONE | 提取重复值\n")
        runtime = create_hook_runtime(
            os.path.join(ROOT, "scripts", "mae-flow.py"),
            lambda _message: None,
        )
        runtime._codecheck_log_state = lambda: state
        runtime._record_codecheck_agent_trace(
            "CLEAN", report, tool_calls, transcript, retry=False)

        log_path = log_core.codecheck_log_path(self.repo, state)
        text = read_log(log_path)
        self.assertEqual(text.count("CodeCheck Agent 工具调用"), 2)
        self.assertIn("codecheck fullcheck -f src/main.cpp", text)
        self.assertIn("CodeCheck Agent 已停止", text)
        self.assertIn("src/main.cpp", text)
        self.assertIn("R.ONE", text)
        self.assertIn("共有 0 条告警", text)
        result_files = artifacts(log_path, "agent-tool-001-result")
        self.assertEqual(len(result_files), 1)
        with open(result_files[0], encoding="utf-8") as stream:
            self.assertIn("共有 0 条告警", stream.read())
        reports = artifacts(log_path, "agent-final-report")
        diffs = artifacts(log_path, "agent-working-tree")
        self.assertEqual(len(reports), 1)
        self.assertEqual(len(diffs), 1)
        with open(reports[0], encoding="utf-8") as stream:
            self.assertIn("CODECHECK_RESULT: CLEAN", stream.read())
        with open(diffs[0], encoding="utf-8") as stream:
            self.assertIn("+int fixed = 2;", stream.read())


if __name__ == "__main__":
    unittest.main()
