#!/usr/bin/env python3
"""Agent lifecycle observations are opaque, atomic workflow evidence."""

import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.agent_observations import (  # noqa: E402
    has_finished_observation,
    latest_started_invocation,
    observation_path,
    record_agent_finished,
    record_agent_started,
)
from mae_flow_core.adapters.hook_active_events import (  # noqa: E402
    ActiveHookEventAdapter,
)
from mae_flow_core.adapters.hook_transcript_paths import (  # noqa: E402
    resolve_agent_transcript,
)
from mae_flow_core.workflow.quality_executions import (  # noqa: E402
    quality_input_snapshot,
    successful_quality_execution,
)


class AgentObservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = os.path.join(self.temporary.name, ".mae-flow.json")

    def records(self):
        with open(observation_path(self.state), encoding="utf-8") as stream:
            return json.load(stream)["observations"]

    def test_started_and_arbitrary_return_are_recorded_atomically(self):
        record_agent_started(
            self.state, "REVIEWER", "story", "run-1",
            "2026-08-04 10:00:00")
        record_agent_finished(
            self.state, "run-1", "returned", "2026-08-04 10:01:00",
            "CLEAR；无新增问题\n**任意 Markdown 都可以**")

        self.assertTrue(has_finished_observation(
            self.state, "REVIEWER", "story"))
        self.assertEqual("CLEAR；无新增问题\n**任意 Markdown 都可以**",
                         self.records()[-1]["detail"])

    def test_append_is_idempotent_by_invocation_and_lifecycle(self):
        record_agent_started(
            self.state, "STORY", "story", "run-1", "2026-08-04 10:00:00")
        record_agent_started(
            self.state, "STORY", "story", "run-1", "2026-08-04 10:00:01")
        record_agent_finished(
            self.state, "run-1", "returned", "2026-08-04 10:01:00")
        record_agent_finished(
            self.state, "run-1", "returned", "2026-08-04 10:01:01")

        self.assertEqual(2, len(self.records()))

    def test_interrupted_and_timeout_are_not_successful_returns(self):
        for invocation, lifecycle in (("run-1", "interrupted"),
                                      ("run-2", "timeout")):
            record_agent_started(
                self.state, "COMPILE", "build", invocation,
                "2026-08-04 10:00:00")
            record_agent_finished(
                self.state, invocation, lifecycle,
                "2026-08-04 10:01:00")

        self.assertFalse(has_finished_observation(
            self.state, "COMPILE", "build"))
        self.assertEqual("", latest_started_invocation(
            self.state, "COMPILE", "build"))

    def test_latest_open_started_invocation_is_recoverable(self):
        record_agent_started(
            self.state, "STORY", "story", "older", "2026-08-04 10:00:00")
        record_agent_started(
            self.state, "REVIEWER", "story", "newer", "2026-08-04 10:01:00")
        self.assertEqual(
            "newer", latest_started_invocation(self.state, step="story"))

    def test_agent_guidance_has_no_fixed_return_receipt(self):
        agents = os.path.join(ROOT, "agents")
        for name in os.listdir(agents):
            if not name.endswith("-agent.md"):
                continue
            with self.subTest(agent=name):
                with open(os.path.join(agents, name), encoding="utf-8") as stream:
                    text = stream.read()
                self.assertNotIn("_RESULT:", text)
                self.assertNotIn("TASK_CARD_SHA256", text)

    def test_pretool_agent_and_subagentstop_form_one_lifecycle(self):
        runtime = SimpleNamespace(
            _contract_state=lambda: {
                "current": "story", "agent_tasks": {
                    "STORY": {"step": "story"},
                }},
        )
        adapter = ActiveHookEventAdapter(
            state=self.state,
            maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name,
            maeflow=lambda *_args: 0,
            runtime_adapter=runtime,
            task_card_ports=lambda: SimpleNamespace(
                script_path=lambda: "/repo/scripts/mae-flow.py"),
            log=lambda _message: None,
        )
        payload = {
            "tool_name": "Agent", "tool_use_id": "story-run",
            "tool_input": {"subagent_type": "story-generator-agent"},
        }
        self.assertEqual(0, adapter.pretool(payload).exit_code)
        self.assertEqual("story-run", latest_started_invocation(
            self.state, "STORY", "story"))
        self.assertEqual(0, adapter.subagentstop({
            "tool_use_id": "story-run", "assistant_text": "已完成",
        }).exit_code)
        self.assertTrue(has_finished_observation(
            self.state, "STORY", "story"))

    def test_official_subagentstop_agent_id_closes_pretool_tool_use_id(self):
        state = {
            "current": "grill",
            "agent_tasks": {"GRILL_FINAL": {"step": "grill"}},
        }
        runtime = SimpleNamespace(_contract_state=lambda: state)
        adapter = ActiveHookEventAdapter(
            state=self.state,
            maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name,
            maeflow=lambda *_args: 0,
            runtime_adapter=runtime,
            task_card_ports=lambda: SimpleNamespace(
                script_path=lambda: "/repo/scripts/mae-flow.py"),
            log=lambda _message: None,
        )
        self.assertEqual(0, adapter.pretool({
            "tool_name": "Agent",
            "tool_use_id": "toolu-final",
            "tool_input": {
                "subagent_type": "mae-flow:grill-critic-agent",
                "prompt": "读取 grill-critic-final.md",
            },
        }).exit_code)

        adapter.subagentstop({
            "agent_id": "agent-final",
            "agent_type": "mae-flow:grill-critic-agent",
            "last_assistant_message": "最终 Critic 已完成",
        })

        self.assertTrue(has_finished_observation(
            self.state, "GRILL_FINAL", "grill"))
        self.assertEqual(
            "最终 Critic 已完成", self.records()[-1]["detail"])

    def test_agent_posttool_completed_is_a_portable_completion_fallback(self):
        state = {
            "current": "story",
            "agent_tasks": {"STORY": {"step": "story"}},
        }
        runtime = SimpleNamespace(_contract_state=lambda: state)
        adapter = ActiveHookEventAdapter(
            state=self.state,
            maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name,
            maeflow=lambda *_args: 0,
            runtime_adapter=runtime,
            task_card_ports=lambda: SimpleNamespace(
                script_path=lambda: "/repo/scripts/mae-flow.py"),
            log=lambda _message: None,
        )
        dispatch = {
            "tool_name": "Agent",
            "tool_use_id": "toolu-story",
            "tool_input": {"subagent_type": "story-generator-agent"},
        }
        self.assertEqual(0, adapter.pretool(dispatch).exit_code)

        adapter.posttool({
            **dispatch,
            "tool_response": {
                "status": "completed",
                "agentId": "agent-story",
                "content": [{"type": "text", "text": "Story 已生成"}],
            },
        })

        self.assertTrue(has_finished_observation(
            self.state, "STORY", "story"))

    def test_historical_orphan_return_self_heals_when_pair_is_unique(self):
        record_agent_started(
            self.state, "GRILL_PREP", "grill", "toolu-prep",
            "2026-08-04 10:00:00")
        record_agent_finished(
            self.state, "agent-prep", "returned",
            "2026-08-04 10:01:00", "旧版本写出的孤儿返回")

        self.assertTrue(has_finished_observation(
            self.state, "GRILL_PREP", "grill"))
        self.assertEqual("", latest_started_invocation(
            self.state, "GRILL_PREP", "grill"))

    def test_background_agent_alias_disambiguates_parallel_grill_critics(self):
        state = {
            "current": "grill",
            "agent_tasks": {
                "GRILL_PREP": {"step": "grill"},
                "GRILL_FINAL": {"step": "grill"},
            },
        }
        runtime = SimpleNamespace(_contract_state=lambda: state)
        adapter = ActiveHookEventAdapter(
            state=self.state,
            maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name,
            maeflow=lambda *_args: 0,
            runtime_adapter=runtime,
            task_card_ports=lambda: SimpleNamespace(
                script_path=lambda: "/repo/scripts/mae-flow.py"),
            log=lambda _message: None,
        )
        prep = {
            "tool_name": "Agent", "tool_use_id": "toolu-prep",
            "tool_input": {
                "subagent_type": "mae-flow:grill-critic-agent",
                "prompt": "读取 grill-critic-prep.md",
            },
        }
        final = {
            "tool_name": "Agent", "tool_use_id": "toolu-final",
            "tool_input": {
                "subagent_type": "mae-flow:grill-critic-agent",
                "prompt": "读取 grill-critic-final.md",
            },
        }
        adapter.pretool(prep)
        adapter.pretool(final)
        adapter.posttool({
            **prep,
            "tool_response": {
                "status": "async_launched", "agentId": "agent-prep"},
        })

        adapter.subagentstop({
            "agent_id": "agent-prep",
            "agent_type": "mae-flow:grill-critic-agent",
            "last_assistant_message": "prep completed",
        })

        self.assertTrue(has_finished_observation(
            self.state, "GRILL_PREP", "grill"))
        self.assertFalse(has_finished_observation(
            self.state, "GRILL_FINAL", "grill"))

    def test_subagentstop_and_posttool_completion_are_idempotent(self):
        state = {
            "current": "story",
            "agent_tasks": {"STORY": {"step": "story"}},
        }
        runtime = SimpleNamespace(_contract_state=lambda: state)
        adapter = ActiveHookEventAdapter(
            state=self.state,
            maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name,
            maeflow=lambda *_args: 0,
            runtime_adapter=runtime,
            task_card_ports=lambda: SimpleNamespace(
                script_path=lambda: "/repo/scripts/mae-flow.py"),
            log=lambda _message: None,
        )
        dispatch = {
            "tool_name": "Agent", "tool_use_id": "toolu-story",
            "tool_input": {"subagent_type": "story-generator-agent"},
        }
        adapter.pretool(dispatch)
        adapter.subagentstop({
            "agent_id": "agent-story",
            "agent_type": "story-generator-agent",
            "last_assistant_message": "done",
        })
        adapter.posttool({
            **dispatch,
            "tool_response": {
                "status": "completed", "agentId": "agent-story",
                "content": [{"type": "text", "text": "done"}],
            },
        })

        returned = [
            item for item in self.records()
            if item.get("lifecycle") == "returned"
            and item.get("kind") == "STORY"
        ]
        self.assertEqual(1, len(returned))

    def test_quality_completion_records_real_successful_command(self):
        state = {
            "current": "build",
            "config": {"编译方式": "make module"},
            "agent_tasks": {"COMPILE": {
                "step": "build", "head": "abc",
                "task_files": ["src/a.cpp"], "execution_roots": ["src"],
            }},
        }
        runtime = SimpleNamespace(_contract_state=lambda: state)
        adapter = ActiveHookEventAdapter(
            state=self.state, maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name, maeflow=lambda *_args: 0,
            runtime_adapter=runtime,
            task_card_ports=lambda: SimpleNamespace(script_path=lambda: "mae-flow"),
            log=lambda _message: None,
        )
        transcript = os.path.join(self.temporary.name, "agent.jsonl")
        rows = (
            {"message": {"role": "assistant", "content": [{
                "type": "tool_use", "id": "build", "name": "Bash",
                "input": {"command": "make module"},
            }]}},
            {"message": {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "build",
                "content": "exit_code: 0\nbuild succeeded",
            }]}},
        )
        with open(transcript, "w", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        payload = {
            "tool_name": "Task", "tool_use_id": "compile-run",
            "tool_input": {"subagent_type": "compile-agent"},
        }
        self.assertEqual(0, adapter.pretool(payload).exit_code)
        adapter.subagentstop({
            "tool_use_id": "compile-run",
            "agent_transcript_path": transcript,
        })
        self.assertIsNotNone(successful_quality_execution(
            self.state, "COMPILE", "build",
            quality_input_snapshot(state, "COMPILE", "build")))

    def test_transcript_fallback_binds_the_returned_claude_code_agent(self):
        main = os.path.join(self.temporary.name, "session.jsonl")
        subagents = os.path.join(
            os.path.splitext(main)[0], "subagents")
        os.makedirs(subagents)
        wanted = os.path.join(subagents, "agent-agent-42.jsonl")
        unrelated = os.path.join(subagents, "agent-agent-99.jsonl")
        for path in (wanted, unrelated):
            with open(path, "w", encoding="utf-8") as stream:
                stream.write("{}\n")
        os.utime(unrelated, (2_000_000_000, 2_000_000_000))

        resolved = resolve_agent_transcript(
            {"transcript_path": main, "agent_id": "agent-42"},
            invocation_id="toolu-42",
        )

        self.assertEqual(wanted, resolved)

    def test_transcript_fallback_never_uses_latest_unrelated_agent(self):
        main = os.path.join(self.temporary.name, "session.jsonl")
        subagents = os.path.join(
            os.path.splitext(main)[0], "subagents")
        os.makedirs(subagents)
        unrelated = os.path.join(subagents, "agent-someone-else.jsonl")
        with open(unrelated, "w", encoding="utf-8") as stream:
            stream.write("{}\n")

        resolved = resolve_agent_transcript(
            {"transcript_path": main, "agent_id": "agent-42"},
            invocation_id="toolu-42",
        )

        self.assertEqual("", resolved)

    def test_codeagent_posttool_agent_id_binds_quality_transcript(self):
        state = {
            "current": "build",
            "config": {"编译方式": "make module"},
            "agent_tasks": {"COMPILE": {
                "step": "build", "head": "abc",
                "task_files": ["src/a.cpp"], "execution_roots": ["src"],
            }},
        }
        adapter = ActiveHookEventAdapter(
            state=self.state, maeflow_path="/repo/scripts/mae-flow.py",
            repository_root=self.temporary.name, maeflow=lambda *_args: 0,
            runtime_adapter=SimpleNamespace(_contract_state=lambda: state),
            task_card_ports=lambda: SimpleNamespace(
                script_path=lambda: "/repo/scripts/mae-flow.py"),
            log=lambda _message: None,
        )
        main = os.path.join(self.temporary.name, "session.jsonl")
        subagents = os.path.join(os.path.splitext(main)[0], "subagents")
        os.makedirs(subagents)
        transcript = os.path.join(subagents, "agent-build-42.jsonl")
        rows = (
            {"message": {"role": "assistant", "content": [{
                "type": "tool_use", "id": "build", "name": "Bash",
                "input": {"command": "make module"},
            }]}},
            {"message": {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "build",
                "content": "exit_code: 0\nbuild succeeded",
            }]}},
        )
        with open(transcript, "w", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")
        dispatch = {
            "tool_name": "Agent", "tool_use_id": "toolu-build-42",
            "transcript_path": main,
            "tool_input": {"subagent_type": "compile-agent"},
        }
        adapter.pretool(dispatch)

        adapter.posttool({
            **dispatch,
            "tool_response": {
                "status": "completed", "agentId": "build-42",
                "content": [{"type": "text", "text": "done"}],
            },
        })

        self.assertIsNotNone(successful_quality_execution(
            self.state, "COMPILE", "build",
            quality_input_snapshot(state, "COMPILE", "build")))


if __name__ == "__main__":
    unittest.main()
