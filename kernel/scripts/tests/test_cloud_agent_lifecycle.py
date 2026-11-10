"""Cloud evidence writes survive restart and never turn failure into success."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from mae_flow_core.adapters.hook_active_events import ActiveHookEventAdapter
from mae_flow_core.adapters.hook_agent_lifecycle import HookAgentLifecycle
from mae_flow_core.workflow.agent_observations import record_agent_started


class CloudAgentLifecycleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = str(Path(temp.name) / ".mae-flow.json")
        patch = mock.patch.dict(os.environ, {"MAE_FLOW_HOOK_STRICT": "1"})
        patch.start()
        self.addCleanup(patch.stop)

    def adapter(self):
        return HookAgentLifecycle(
            state_path=self.state, current_step=lambda: "grill",
            record_execution=lambda *_args: None,
            scope_violation=lambda *_args: "", log=lambda *_args: None)

    def started(self, invocation="critic-prep", kind="GRILL_PREP"):
        record_agent_started(self.state, kind, "grill", invocation,
                             "2026-09-08 10:00:00")

    def post(self, invocation="critic-prep", response=None):
        return self.adapter().posttool({
            "tool_name": "Task", "tool_use_id": invocation,
            "tool_input": {"subagent_type": "grill-critic-agent", "prompt": "prep"},
            "tool_response": response or {"status": "returned", "agentId": "child-1"}})

    def records(self):
        return json.loads(Path(self.state + ".agent-observations").read_text())["observations"]

    def test_restart_and_duplicate_completion_preserve_both_critics(self):
        self.started()
        self.assertEqual(0, self.post(response={"completed_at": "2026-09-08T10:01:00+00:00"}).exit_code)
        self.started("critic-final", "GRILL_FINAL")
        self.assertEqual(0, self.post("critic-final").exit_code)
        # New adapter/process and redelivery of the same event cannot overwrite or inflate evidence.
        self.assertEqual(0, self.post().exit_code)
        finished = [r for r in self.records() if r["lifecycle"] == "returned"]
        self.assertEqual(["GRILL_PREP", "GRILL_FINAL"], [r["kind"] for r in finished])
        self.assertNotEqual(finished[0]["at"], finished[1]["at"])

    def test_missing_start_does_not_bind_to_other_critic(self):
        self.started("unrelated", "GRILL_FINAL")
        result = self.post()
        self.assertEqual(2, result.exit_code)
        self.assertIn("缺少对应启动观察", result.stderr)
        self.assertEqual(1, len(self.records()))

    def test_error_flag_and_status_cannot_become_success(self):
        for index, response in enumerate((
            {"is_error": True}, {"status": "failed"},
            {"status": "interrupted"}, {"status": "timeout"},
            {"status": "completed", "is_error": True},
            {"status": "async_launched", "is_error": True},
        )):
            call = str(index)
            self.started(call)
            self.assertEqual(0, self.post(call, response).exit_code)
            self.assertNotEqual("returned", self.records()[-1]["lifecycle"])

    def test_start_write_failure_denies_dispatch(self):
        adapter = ActiveHookEventAdapter(
            state=self.state, maeflow_path="/kernel/scripts/mae-flow.py",
            repository_root=str(Path(self.state).parent),
            maeflow=lambda *_args: 0,
            runtime_adapter=SimpleNamespace(_contract_state=lambda: {"current": "build"}),
            task_card_ports=lambda: None, log=lambda *_args: None)
        with mock.patch("mae_flow_core.adapters.hook_active_events.record_agent_started",
                        side_effect=OSError("disk full")):
            response = adapter.pretool({"tool_name": "Task", "tool_use_id": "compile",
                                       "tool_input": {"subagent_type": "compile-agent"}})
        self.assertEqual(75, response.exit_code)

    def test_finished_write_and_scope_failure_are_visible(self):
        self.started()
        with mock.patch("mae_flow_core.adapters.hook_agent_lifecycle.record_agent_finished",
                        side_effect=OSError("disk full")):
            result = self.post()
        self.assertEqual(75, result.exit_code)
        self.assertIn("disk full", result.stderr)
        adapter = self.adapter()
        adapter.scope_violation = mock.Mock(side_effect=OSError("unreadable"))
        self.assertEqual(75, adapter.complete({"invocation_id": "critic-prep"}).exit_code)

    def test_corrupt_observations_are_not_silently_erased(self):
        path = Path(self.state + ".agent-observations")
        path.write_text("{broken evidence")
        with self.assertRaises(Exception):
            self.started()
        self.assertEqual("{broken evidence", path.read_text())
        with self.assertRaises(ValueError):
            self.post()

    def test_unknown_agent_does_not_need_kernel_quality_observation(self):
        self.assertEqual(0, self.adapter().posttool({"tool_name": "Task",
            "tool_use_id": "explore", "tool_input": {"subagent_type": "explore"}}).exit_code)




if __name__ == "__main__":
    unittest.main()
