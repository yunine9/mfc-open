#!/usr/bin/env python3
"""捕获真实人工回答不再计算、绑定内容指纹。"""

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import save_versioned_json  # noqa: E402
from mae_flow_core.adapters.hook_runtime import HookRuntimeAdapter  # noqa: E402
from mae_flow_core.state_store import safe_read_json  # noqa: E402


@contextlib.contextmanager
def in_directory(path):
    original = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(original)


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


def message_rows(path):
    raw, err = safe_read_json(path)
    assert not err, err
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("data", "messages"):
            if isinstance(raw.get(key), list):
                return raw[key]
    raise AssertionError("无法识别的消息账本形态: %r" % type(raw))


class HookUsermsgApprovalBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        subprocess.run(["git", "init", "-q", self.root], check=True)
        subprocess.run(["git", "-C", self.root, "config", "user.email",
                        "test@example.com"], check=True)
        subprocess.run(["git", "-C", self.root, "config", "user.name",
                        "Test"], check=True)
        self.state = {"current": "open", "config": {"单号": "REQ-1"}}
        save_versioned_json(
            os.path.join(self.root, ".mae-flow.json"), self.state, "flow",
            project_root=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_answer_is_captured_without_content_binding(self):
        folder = os.path.join(self.root, ".mae-flow-work", "REQ-1")
        os.makedirs(folder)
        with open(os.path.join(folder, "spec.md"), "w",
                  encoding="utf-8") as out:
            out.write("v1\n")
        runtime = runtime_for(self.root)
        with in_directory(self.root):
            runtime._capture_usermsg("Spec 无需再调整，确认生成 Story")
        rows = message_rows(os.path.join(self.root, ".mae-flow.json.usermsg"))
        self.assertTrue(rows, "答案必须落账")
        row = rows[-1]
        self.assertEqual("open", row["step"])
        self.assertIn("确认生成 Story", row["text"])
        self.assertNotIn("approval_subject_sha256", row)
        self.assertNotIn("approval_subject_id", row)
        state_raw, err = safe_read_json(
            os.path.join(self.root, ".mae-flow.json"))
        self.assertFalse(err)
        text = json.dumps(state_raw, ensure_ascii=False)
        self.assertNotIn("approval_subject", text,
                         "捕获回答不创建审批指纹")

    def test_missing_artifacts_leave_answer_unstamped(self):
        logs = []
        runtime = runtime_for(self.root, logs)
        with in_directory(self.root):
            runtime._capture_usermsg("Spec 无需再调整，确认生成 Story")
        rows = message_rows(os.path.join(self.root, ".mae-flow.json.usermsg"))
        self.assertTrue(rows)
        self.assertNotIn("approval_subject_sha256", rows[-1],
                         "缺少产物也不影响捕获真实回答")


if __name__ == "__main__":
    unittest.main()
