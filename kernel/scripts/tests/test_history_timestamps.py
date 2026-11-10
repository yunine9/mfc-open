"""New history carries the writer's timezone; legacy wall time remains intact."""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mae_flow_core.state_store import (
    atomic_write_json, read_json, save_versioned_json, update_versioned_json,
)


@unittest.skipUnless(hasattr(time, "tzset"), "requires process timezone selection")
class HistoryTimestampTests(unittest.TestCase):
    def test_append_records_writer_timezone_for_both_state_writers(self):
        for zone, offset in [("Asia/Shanghai", "+08:00"), ("UTC", "+00:00")]:
            try:
                with patch.dict(os.environ, {"TZ": zone}), tempfile.TemporaryDirectory() as root:
                    time.tzset()
                    path = os.path.join(root, ".mae-flow.json")
                    old = {"step": "config_confirm", "at": "2026-09-07 10:00:00"}
                    atomic_write_json(path, {"current": "build", "history": [old]})
                    state = read_json(path)
                    state["history"].append({"step": "build", "at": "2026-09-08 09:55:43"})
                    save_versioned_json(path, state, "flow", project_root=root)
                    self.assertEqual(state["history"][0], old)
                    self.assertEqual(state["history"][1]["at"], "2026-09-08 09:55:43")
                    self.assertEqual(state["history"][1]["at_iso"], "2026-09-08T09:55:43" + offset)
                    update_versioned_json(path, "flow", lambda s: s["history"].append(
                        {"step": "review", "at": "2026-09-08 09:56:00"}), project_root=root)
                    saved = read_json(path)
                    self.assertEqual(saved["history"][0], old)
                    self.assertEqual(saved["history"][2]["at_iso"], "2026-09-08T09:56:00" + offset)
                    # Moving the reader/writer to another timezone must not reinterpret persisted rows.
                    with patch.dict(os.environ, {"TZ": "America/New_York"}):
                        time.tzset()
                        save_versioned_json(path, saved, "flow", project_root=root)
                        self.assertEqual(saved["history"][1], state["history"][1])
                        self.assertEqual(saved["history"][0], old)
            finally:
                time.tzset()

    def test_invalid_or_replaced_history_does_not_get_guessed_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, ".mae-flow.json")
            state = {"current": "build", "history": [None, {"at": "invalid"}]}
            save_versioned_json(path, state, "flow", project_root=root)
            self.assertEqual(state["history"], [None, {"at": "invalid"}])
            state["history"] = [{"step": "imported", "at": "2026-09-08 09:55:43"}]
            save_versioned_json(path, state, "flow", project_root=root)
            self.assertNotIn("at_iso", state["history"][0])


if __name__ == "__main__":
    unittest.main()
