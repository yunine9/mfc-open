#!/usr/bin/env python3
"""Cloud continuous-review is opt-in, durable and never a fresh workflow."""

import contextlib
import hashlib
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import cli_runtime  # noqa: E402,F401
from mae_flow_core.cli_commands import delivery_commands as delivery  # noqa: E402
from mae_flow_core.cli_commands.pipeline_commands import (  # noqa: E402
    _route_external_verification, cmd_pipeline,
)
from mae_flow_core.cli_commands.host_capability import verify_host_proof  # noqa: E402
from mae_flow_core.cli_commands import host_capability  # noqa: E402
from mae_flow_core.cli_commands import host_receipts  # noqa: E402
from mae_flow_core.workflow.execution_contract import SCHEMA  # noqa: E402


HEAD = "a" * 40


def contract(enabled=True):
    return {
        "schema": SCHEMA,
        "host": "cloud",
        "compile": "pipeline",
        "ut_write": "agent",
        "ut_run": "pipeline",
        "codecheck": "pipeline",
        "git_push": "host",
        "continuous_review": enabled,
        "source": "order",
    }


def state(step="delivery_watch"):
    return {
        "current": step,
        "execution_contract": contract(),
        "config": {"单号": "REQ-7", "分支名": "main_u_REQ-7"},
        "choices": {"workflow": "full"},
        "history": [{"step": "external_verify", "result": "pipeline:pass"}],
        "step_heads": {step: HEAD},
        "quality": {"external_verification": {
            "verdict": "PASS", "sha": HEAD,
        }},
        "initial_dirty": [],
    }


def batch(batch_id="fb-1", base=HEAD):
    return {
        "schema": delivery.BATCH_SCHEMA,
        "batch_id": batch_id,
        "task_id": "task-7",
        "base_sha": base,
        "opened_at": "2026-09-01T12:00:00+08:00",
        "items": [{
            "id": "workspace:an-1",
            "source": "workspace",
            "source_id": "an-1",
            "source_revision": 0,
            "kind": "code_review",
            "summary": "空值场景需要处理",
            "material": "../feedback/fb-1/an-1.json",
            "verification": "author",
        }],
    }


def without_host_nonces(value):
    copied = json.loads(json.dumps(value, ensure_ascii=False))
    for key in ("host_capability_nonces", "state_version", "revision", "updated_at"):
        copied.pop(key, None)
    return copied


class TempProject(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.tmp.name)
        subprocess.run(["git", "init", "-q"], check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "config", "user.name", "Test"], check=True)
        with open("tracked.txt", "w", encoding="utf-8") as stream:
            stream.write("base\n")
        subprocess.run(["git", "add", "tracked.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "base"], check=True)
        self.head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip()

    def tearDown(self):
        os.chdir(self.old)
        self.tmp.cleanup()

    def write_json(self, name, value):
        with open(name, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
        return os.path.abspath(name)


class DeliveryCommandTests(TempProject):
    def setUp(self):
        super().setUp()
        self.proof = mock.patch.object(
            delivery, "_verify_host_proof", return_value={
                "root": "/host-only",
                "proof": {"nonce": "test-proof-nonce"},
                "payload": {},
            })
        self.proof.start()
        self.save_proof = mock.patch.object(delivery, "save_with_host_proof")
        self.save_proof.start()
        self.trusted = mock.patch.object(
            delivery, "trusted_pipeline_projection", return_value=True)
        self.trusted.start()

    def tearDown(self):
        self.trusted.stop()
        self.save_proof.stop()
        self.proof.stop()
        super().tearDown()

    def live_state(self, step="delivery_watch"):
        value = state(step)
        value["step_heads"] = {step: self.head}
        value["quality"]["external_verification"]["sha"] = self.head
        return value

    def control(self, value, **changes):
        from mae_flow_core.cli_commands.feedback_control import control_feedback
        payload = {"operation_id": "op-1", "target": "先处理 B", "actor": "owner",
                   "request_id": "message-1", "reason": "A 暂缓"}
        payload.update(changes)
        with mock.patch.object(host_receipts, "verify_feedback_facts"), \
                mock.patch.object(host_receipts, "save_with_host_proof"), \
                contextlib.redirect_stdout(io.StringIO()):
            control_feedback(value, payload, {})

    def test_defer_promotes_next_batch_without_falsifying_pipeline(self):
        value = self.live_state()
        first = batch(base=self.head)
        second = batch("fb-2", self.head)
        second["items"][0]["id"] = "workspace:an-2"
        with contextlib.redirect_stdout(io.StringIO()):
            delivery._open({}, value, SimpleNamespace(file=self.write_json("first.json", first)))
            delivery._open({}, value, SimpleNamespace(file=self.write_json("second.json", second)))
        original_quality = json.loads(json.dumps(value["quality"]))
        self.control(value, feedback_id="workspace:an-1")
        self.assertEqual(value["delivery_loop"]["active_batch_id"], "fb-2")
        self.assertEqual(value["delivery_loop"]["batches"][0]["status"], "deferred")
        self.assertEqual(value["quality"], original_quality)
        self.control(value, feedback_id="workspace:an-1")
        self.assertEqual(len(value["delivery_loop"]["controls"]), 1)
        with self.assertRaises(SystemExit):
            self.control(value, target="改写相同操作", feedback_id="workspace:an-1")

    def test_target_alone_does_not_silently_defer_feedback(self):
        value = self.live_state()
        with contextlib.redirect_stdout(io.StringIO()):
            delivery._open({}, value, SimpleNamespace(file=self.write_json("first.json", batch(base=self.head))))
        self.control(value)
        self.assertEqual(value["delivery_loop"]["active_batch_id"], "fb-1")
        self.assertFalse(value["delivery_loop"].get("deferred_feedback"))
        self.assertEqual(value["delivery_loop"]["target"]["target"], "先处理 B")

    def test_panel_command_rewrites_pulse_with_current_phase_vocabulary(self):
        """阶段词表升级后,老任务的脉冲还是旧名字;宿主跑一次 panel 就该
        按当前词表重写脉冲(Cloud 靠它自愈),不用等下一个 Hook 事件。"""
        from mae_flow_core.cli_commands import panel as panel_cmd
        value = self.live_state()
        self.write_json(".mae-flow.json", value)
        os.makedirs(".mae-flow-work", exist_ok=True)
        pulse_path = os.path.join(".mae-flow-work", "panel-pulse.js")
        with open(pulse_path, "w", encoding="utf-8") as stream:
            stream.write('window.__panelPulse={"phase":"交付","step":"delivery_watch"};\n')
        args = SimpleNamespace(json=False, out=os.path.join(".mae-flow-work", "panel.html"))
        with contextlib.redirect_stdout(io.StringIO()):
            panel_cmd.cmd_panel(value, args)
        with open(pulse_path, encoding="utf-8") as stream:
            pulse = stream.read().replace(" ", "")
        self.assertIn('"phase":"检视与验证"', pulse)
        self.assertIn('"step":"delivery_watch"', pulse)

    def test_feedback_open_preserves_identity_and_is_idempotent(self):
        value = self.live_state()
        before_config = json.loads(json.dumps(value["config"], ensure_ascii=False))
        before_choices = json.loads(json.dumps(value["choices"], ensure_ascii=False))
        before_history = list(value["history"])
        payload = batch(base=self.head)
        path = self.write_json("batch.json", payload)
        args = SimpleNamespace(delivery_action="feedback-open", file=path)
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual("feedback_triage", value["current"])
        self.assertEqual(before_config, value["config"])
        self.assertEqual(before_choices, value["choices"])
        self.assertEqual(before_history, value["history"][:len(before_history)])
        self.assertEqual(1, value["delivery_loop"]["delivery_round"])
        self.assertFalse(os.path.exists(".mae-flow.json.last"))
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_old_cloud_terminal_can_be_adopted_without_reinit_or_history_loss(self):
        value = self.live_state("end")
        value["execution_contract"]["continuous_review"] = False
        before = list(value["history"])
        path = self.write_json("migration.json", {
            "schema": delivery.BATCH_SCHEMA,
            "mode": "adopt-watch",
            "batch_id": "migration:task-7",
        })
        args = SimpleNamespace(delivery_action="feedback-open", file=path)
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual("delivery_watch", value["current"])
        self.assertTrue(value["execution_contract"]["continuous_review"])
        self.assertEqual(before, value["history"])
        self.assertFalse(os.path.exists(".mae-flow.json.last"))
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_feedback_open_rejects_wrong_base_and_disabled_contract(self):
        value = self.live_state()
        path = self.write_json("wrong.json", batch(base="b" * 40))
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-open", file=path))
        value = self.live_state()
        value["execution_contract"]["continuous_review"] = False
        path = self.write_json("disabled.json", batch(base=self.head))
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-open", file=path))

    def test_explained_result_returns_to_watch_without_losing_quality(self):
        value = self.live_state()
        open_path = self.write_json("batch.json", batch(base=self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=open_path))
        old_quality = json.loads(json.dumps(value["quality"]))
        result_path = self.write_json("result.json", {
            "schema": delivery.RESULT_SCHEMA,
            "batch_id": "fb-1",
            "changed": False,
            "results": [{
                "id": "workspace:an-1", "status": "explained",
                "summary": "现有空值分支已经覆盖", "evidence": "src/a.py:8",
            }],
        })
        args = SimpleNamespace(delivery_action="feedback-result", file=result_path)
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual("delivery_watch", value["current"])
        self.assertEqual(old_quality, value["quality"])
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery({"steps": {}}, value, args)
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_host_results_handoff_without_repeating_coding_steps(self):
        for step in ("feedback_triage", "build", "domain_archive", "delivery_review", "push"):
            with self.subTest(step=step):
                value = self.live_state()
                path = self.write_json("batch.json", batch(base=self.head))
                delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                    delivery_action="feedback-open", file=path))
                value["current"] = step
                path = self.write_json("result.json", {
                    "schema": delivery.RESULT_SCHEMA, "batch_id": "fb-1", "changed": True,
                    "results": [{"id": "workspace:an-1", "status": "fixed", "summary": "已修改"}],
                })
                args = SimpleNamespace(delivery_action="feedback-result", file=path)
                with mock.patch.object(delivery, "host_managed_continuous_review", return_value=True), \
                        mock.patch.object(delivery, "verify_feedback_facts"):
                    delivery.cmd_delivery({"steps": {}}, value, args)
                    self.assertEqual("external_verify", value["current"])
                    active = value["delivery_loop"]["batches"][0]
                    self.assertEqual("awaiting_verification", active["status"])
                    self.assertNotEqual("PASS", (value.get("quality", {}).get("external_verification") or {}).get("verdict"))
                    # 升级前结果已登记、步骤仍留在旧位置的现场可幂等恢复。
                    value["current"] = step
                    previous = json.loads(json.dumps(active))
                    delivery.cmd_delivery({"steps": {}}, value, args)
                    self.assertEqual("external_verify", value["current"])
                    self.assertEqual(previous, active)

    def test_host_handoff_preserves_human_questions_and_other_active_batches(self):
        value = state("feedback_triage")
        value["delivery_loop"] = {"active_batch_id": "current"}
        with mock.patch.object(delivery, "host_managed_continuous_review", return_value=True):
            for item in ({"batch_id": "current", "status": "needs_human"},
                         {"batch_id": "old", "status": "awaiting_verification"}):
                delivery._handoff_host_feedback(value, item)
                self.assertEqual("feedback_triage", value["current"])
            value["current"] = "end"
            delivery._handoff_host_feedback(value, {"batch_id": "current", "status": "awaiting_verification"})
            self.assertEqual("end", value["current"])

    def test_result_requires_one_receipt_per_item(self):
        value = self.live_state()
        open_path = self.write_json("batch.json", batch(base=self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=open_path))
        result_path = self.write_json("result.json", {
            "schema": delivery.RESULT_SCHEMA, "batch_id": "fb-1", "results": [],
        })
        with self.assertRaises(SystemExit):
            with mock.patch.object(
                    delivery, "_verify_host_proof", return_value="queue-test-proof"):
                delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                    delivery_action="feedback-result", file=result_path))

    def test_batch_replay_accepts_reordering_but_not_changed_content(self):
        value = self.live_state()
        payload = batch(base=self.head)
        payload["items"].append({**payload["items"][0], "id": "workspace:an-2", "source_id": "an-2"})
        args = SimpleNamespace(delivery_action="feedback-open", file=self.write_json("batch.json", payload))
        delivery.cmd_delivery({}, value, args)
        before = without_host_nonces(value)
        payload["items"].reverse()
        self.write_json("batch.json", payload)
        delivery.cmd_delivery({}, value, args)
        self.assertEqual(before, without_host_nonces(value))
        payload["items"][0]["summary"] = "本次改了意见正文"
        self.write_json("batch.json", payload)
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({}, value, args)

    def test_result_replay_accepts_reordering_but_not_changed_answer(self):
        value = self.live_state()
        payload = batch(base=self.head)
        payload["items"].append({**payload["items"][0], "id": "workspace:an-2", "source_id": "an-2"})
        delivery.cmd_delivery({}, value, SimpleNamespace(delivery_action="feedback-open",
            file=self.write_json("batch.json", payload)))
        receipt = {"schema": delivery.RESULT_SCHEMA, "batch_id": "fb-1", "changed": False,
                   "results": [{"id": item["id"], "status": "explained", "summary": "已核对现有实现"}
                               for item in payload["items"]]}
        args = SimpleNamespace(delivery_action="feedback-result", file=self.write_json("result.json", receipt))
        delivery.cmd_delivery({}, value, args)
        before = without_host_nonces(value)
        receipt["results"].reverse()
        self.write_json("result.json", receipt)
        delivery.cmd_delivery({}, value, args)
        self.assertEqual(before, without_host_nonces(value))
        receipt["results"][0]["status"] = "needs_human"
        self.write_json("result.json", receipt)
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({}, value, args)

    def test_composite_feedback_identity_preserves_long_valid_source_id(self):
        value = self.live_state()
        payload = batch(base=self.head)
        source_id = "discussion-" + "x" * 180
        identity = "mr_discussion:" + source_id + ":r0@" + self.head
        payload["items"] = [{**payload["items"][0], "source": "mr_discussion",
                             "source_id": source_id, "id": identity}]
        delivery.cmd_delivery({}, value, SimpleNamespace(delivery_action="feedback-open",
            file=self.write_json("batch.json", payload)))
        delivery.cmd_delivery({}, value, SimpleNamespace(delivery_action="feedback-result",
            file=self.write_json("result.json", {"schema": delivery.RESULT_SCHEMA,
                "batch_id": "fb-1", "changed": False, "results": [
                    {"id": identity, "status": "explained", "summary": "现有实现已覆盖"}]})))
        self.assertEqual(identity, value["delivery_loop"]["batches"][0]["results"][0]["id"])

    def test_red_feedback_replaces_awaiting_writer_and_later_pass_closes_both(self):
        value = self.live_state("external_verify")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "delivery_round": 1,
            "active_batch_id": "fb-old",
            "close_events": [],
            "batches": [{
                "batch_id": "fb-old", "status": "awaiting_verification",
                "base_sha": self.head, "items": [],
            }],
        }
        path = self.write_json("red.json", batch("fb-red", self.head))
        delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
            delivery_action="feedback-open", file=path))
        old, current = value["delivery_loop"]["batches"]
        self.assertEqual("addressed", old["status"])
        self.assertEqual("repairing", current["status"])
        self.assertEqual("fb-red", value["delivery_loop"]["active_batch_id"])
        self.assertEqual("feedback_triage", value["current"])
        current["status"] = "awaiting_verification"
        self.assertFalse(delivery.complete_verified_feedback(value, self.head))
        self.assertEqual(["closed", "closed"],
                         [item["status"] for item in value["delivery_loop"]["batches"]])

    def test_pass_closes_pipeline_feedback_retired_by_the_same_push(self):
        value = self.live_state("external_verify")
        old_sha = "b" * 40
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "delivery_round": 1,
            "active_batch_id": "",
            "close_events": [],
            "published": {"sha": self.head},
            "batches": [{
                "batch_id": "fb-ci", "status": "superseded",
                "base_sha": old_sha, "superseded_by_push": self.head,
                "items": [{
                    "id": "pipeline:%s:COMPILE" % old_sha,
                    "source": "pipeline",
                    "source_id": "%s:COMPILE" % old_sha,
                    "verification": "pipeline",
                }],
            }],
        }

        self.assertFalse(delivery.complete_verified_feedback(value, self.head))
        retired = value["delivery_loop"]["batches"][0]
        self.assertEqual("closed", retired["status"])
        self.assertEqual(self.head, retired["verified_sha"])
        self.assertEqual(self.head, retired["superseded_by_pipeline"])

    def test_pass_does_not_close_human_feedback_retired_by_push(self):
        value = self.live_state("external_verify")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "delivery_round": 1,
            "active_batch_id": "",
            "close_events": [],
            "published": {"sha": self.head},
            "batches": [{
                "batch_id": "fb-human", "status": "superseded",
                "base_sha": "b" * 40, "superseded_by_push": self.head,
                "items": [{
                    "id": "workspace:an-1", "source": "workspace",
                    "source_id": "an-1", "verification": "owner",
                }],
            }],
        }

        self.assertFalse(delivery.complete_verified_feedback(value, self.head))
        self.assertEqual(
            "superseded", value["delivery_loop"]["batches"][0]["status"])

    def test_merged_close_is_the_only_terminal_transition_and_is_idempotent(self):
        value = self.live_state()
        args = SimpleNamespace(
            delivery_action="close", reason="merged", sha=self.head,
            event_id="merge-7")
        flow = {"steps": {"end": {"terminal": True}}}
        delivery.cmd_delivery(flow, value, args)
        self.assertEqual("end", value["current"])
        first = json.loads(json.dumps(value, ensure_ascii=False))
        delivery.cmd_delivery(flow, value, args)
        self.assertEqual(without_host_nonces(first), without_host_nonces(value))

    def test_trusted_external_merge_closes_failed_or_missing_verification(self):
        for verdict in ("FAIL", "STALE", None):
            with self.subTest(verdict=verdict):
                value = self.live_state()
                if verdict:
                    value["quality"]["external_verification"]["verdict"] = verdict
                else:
                    value["quality"].pop("external_verification")
                before = json.loads(json.dumps(value["quality"]))
                merged = "f" * 40  # 人工外部提交无需先存在于宿主仓
                args = SimpleNamespace(delivery_action="close", reason="merged",
                    sha=merged, event_id="external-" + str(verdict))
                delivery.cmd_delivery({"steps": {"end": {"terminal": True}}}, value, args)
                self.assertEqual("end", value["current"])
                self.assertEqual(before, value["quality"])
                event = value["delivery_loop"]["close_events"][-1]
                self.assertEqual(merged, event["sha"])
                self.assertEqual("platform_merge", event["completion_basis"])

    def test_merged_close_records_clean_local_commits_not_in_mr(self):
        value = self.live_state()
        with open("tracked.txt", "a", encoding="utf-8") as stream:
            stream.write("local-only\n")
        subprocess.run(["git", "add", "tracked.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "local-only"], check=True)
        local_head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip()
        args = SimpleNamespace(
            delivery_action="close", reason="merged", sha=self.head,
            event_id="merge-with-local")
        delivery.cmd_delivery({"steps": {"end": {"terminal": True}}}, value, args)
        event = value["delivery_loop"]["close_events"][-1]
        self.assertEqual(local_head, event["local_head"])
        self.assertEqual([local_head], [
            item["sha"] for item in event["unpushed_local_commits"]])
        self.assertEqual([], event["unpushed_local_paths"])


class DeliveryHostProofTests(TempProject):
    def trusted_layout(self, exponent="AQAB"):
        root = tempfile.TemporaryDirectory()
        workspace = os.path.join(root.name, "task-7")
        repository = os.path.join(workspace, "repo")
        os.makedirs(repository)
        old = os.getcwd()
        os.chdir(repository)
        trust = os.path.join(root.name, ".host-capabilities")
        os.makedirs(trust, mode=0o700)
        trust = os.path.realpath(trust)
        os.chmod(trust, 0o700)
        n = base64.urlsafe_b64encode(b"\x80" + b"\0" * 255).decode().rstrip("=")
        authority = {
            "schema": "mae-flow-host-authority/1", "alg": "RS256",
            "key_id": hashlib.sha256((n + "." + exponent).encode()).hexdigest()[:24],
            "task_id": "task-7", "n": n, "e": exponent,
        }
        capability = os.path.join(
            trust, hashlib.sha256(b"task-7").hexdigest() + ".json")
        with open(capability, "w", encoding="utf-8") as stream:
            json.dump({"schema": "mae-flow-host-capability/1",
                       "authority": authority, "private_key": "not-readable"}, stream)
        os.chmod(capability, 0o600)
        binding = os.path.join(
            trust, "binding-" + hashlib.sha256(
                os.path.realpath(repository).encode("utf-8")).hexdigest() + ".json")
        with open(binding, "w", encoding="utf-8") as stream:
            json.dump({
                "schema": "mae-flow-host-binding/1",
                "task_id": "task-7",
                "workspace": os.path.realpath(workspace),
                "cwd": os.path.realpath(repository),
                "continuous_review": True,
            }, stream)
        os.chmod(binding, 0o600)
        return root, old, trust, authority

    def test_forged_proof_is_rejected_even_when_shell_obfuscation_evades_hint(self):
        value = state()
        value["execution_contract"]["host_authority"] = {
            "schema": "mae-flow-host-authority/1",
            "alg": "RS256", "key_id": "test", "task_id": "task-7",
            "n": "AQ", "e": "Aw",
        }
        payload = batch(base=self.head)
        payload_path = self.write_json("batch.json", payload)
        proof_path = self.write_json("forged.json", {
            "schema": "mae-flow-host-proof/1",
            "task_id": "task-7", "action": "feedback-open",
            "payload_digest": hashlib.sha256(
                json.dumps(payload, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")).hexdigest(),
            "nonce": "forged", "issued_at": int(delivery.time.time()),
            "signature": "ZmFrZQ",
        })
        with self.assertRaises(SystemExit):
            delivery.cmd_delivery({"steps": {}}, value, SimpleNamespace(
                delivery_action="feedback-open", file=payload_path,
                host_proof=proof_path))
        self.assertNotIn("delivery_loop", value)

    def test_mutated_state_authority_cannot_replace_external_trust_root(self):
        root, old, trust, authority = self.trusted_layout()
        try:
            value = state()
            value["execution_contract"]["host_authority"] = {
                **authority, "key_id": "attacker", "e": "AQ",
            }
            payload = batch(base=HEAD)
            proof = {
                "schema": "mae-flow-host-proof/1", "task_id": "task-7",
                "action": "feedback-open",
                "payload_digest": hashlib.sha256(
                    json.dumps(payload, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")).encode()).hexdigest(),
                "nonce": "forged", "issued_at": int(delivery.time.time()),
                "signature": "ZmFrZQ",
            }
            proof_path = os.path.join(trust, "proof-forged.json")
            with open(proof_path, "w", encoding="utf-8") as stream:
                json.dump(proof, stream)
            os.chmod(proof_path, 0o600)
            with self.assertRaises(SystemExit):
                verify_host_proof(value, proof_path, "feedback-open", payload)
            self.assertNotIn("delivery_loop", value)
        finally:
            os.chdir(old)
            root.cleanup()

    def test_weak_rsa_exponent_is_rejected_at_external_root(self):
        root, old, trust, authority = self.trusted_layout("AQ")
        try:
            value = state()
            value["execution_contract"]["host_authority"] = authority
            proof_path = os.path.join(trust, "proof-weak.json")
            with open(proof_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "schema": "mae-flow-host-proof/1", "task_id": "task-7",
                    "action": "feedback-open", "payload_digest": "0" * 64,
                    "nonce": "weak", "issued_at": int(delivery.time.time()),
                    "signature": "ZmFrZQ",
                }, stream)
            os.chmod(proof_path, 0o600)
            with self.assertRaises(SystemExit):
                verify_host_proof(value, proof_path, "feedback-open", batch())
        finally:
            os.chdir(old)
            root.cleanup()

    def test_continuous_pipeline_record_requires_host_proof(self):
        value = state("external_verify")
        facts = self.write_json("pipeline.json", {
            "sha": self.head, "status": "success",
        })
        with self.assertRaises(SystemExit):
            cmd_pipeline({"steps": {}}, value, SimpleNamespace(
                action="record", file=facts, host_proof=None))
        self.assertNotIn("pipeline", value.get("quality", {}))

    def test_external_binding_cannot_be_disabled_from_mutable_state(self):
        root, old, _trust, _authority = self.trusted_layout()
        try:
            value = state("external_verify")
            value["execution_contract"].pop("continuous_review", None)
            value["execution_contract"].pop("host_authority", None)
            facts = self.write_json("pipeline.json", {
                "sha": HEAD, "status": "success",
            })
            with self.assertRaises(SystemExit):
                cmd_pipeline({"steps": {}}, value, SimpleNamespace(
                    action="record", file=facts, host_proof=None))
            self.assertNotIn("pipeline", value.get("quality", {}))
        finally:
            os.chdir(old)
            root.cleanup()

    def test_host_projection_seals_complete_lifecycle(self):
        value = state("delivery_watch")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-1",
            "batches": [{
                "batch_id": "fb-1", "status": "closed",
                "results": [{"id": "one", "status": "fixed"}],
            }],
            "close_events": [],
        }
        value["quality"] = {"external_verification": {
            "verdict": "PASS", "sha": HEAD,
        }}
        projection = host_receipts.host_projection(
            value, "pipeline-record", {})
        self.assertEqual(host_receipts.LIFECYCLE_SCHEMA, projection["schema"])
        self.assertEqual("delivery_watch", projection["current"])
        self.assertEqual("fb-1", projection["active_batch_id"])
        # 封的是摘要不是正文,但每一处篡改仍然照样翻脸。
        for mutate in (
            lambda st: st["delivery_loop"]["batches"][0].__setitem__(
                "status", "awaiting_verification"),
            lambda st: st["delivery_loop"]["batches"][0]["results"][0].__setitem__(
                "status", "explained"),
            lambda st: st["quality"]["external_verification"].__setitem__(
                "sha", "b" * 40),
            lambda st: st.__setitem__("current", "end"),
            lambda st: st.__setitem__("user_intervention", {"id": "forged"}),
        ):
            tampered = json.loads(json.dumps(value, ensure_ascii=False))
            mutate(tampered)
            self.assertNotEqual(
                projection,
                host_receipts.host_projection(tampered, "pipeline-record", {}))

    def test_current_feedback_text_separates_deferred_items_from_actionable_receipts(self):
        from mae_flow_core.cli_commands.delivery_support import render_delivery_feedback
        value = state("feedback_triage")
        value["delivery_loop"] = {
            "active_batch_id": "fb-1",
            "target": {"target": "先处理 B"},
            "deferred_feedback": {"A": {"reason": "本轮延期"}},
            "batches": [{"batch_id": "fb-1", "status": "repairing", "items": [
                {"id": "A", "summary": "不应再次派修的旧问题"},
                {"id": "B", "summary": "需要执行的新问题"},
            ]}],
        }
        rendered = render_delivery_feedback(value)
        self.assertIn("执行目标摘要（不是最终需求决定）：先处理 B", rendered)
        self.assertIn("已由责任人暂缓自动修复：A", rendered)
        self.assertNotIn("不应再次派修的旧问题", rendered)
        self.assertIn('"id": "B"', rendered)
        self.assertNotIn('"id": "A"', rendered)
        value["delivery_loop"]["active_batch_id"] = ""
        self.assertIn("先处理 B", render_delivery_feedback(value))
        self.assertNotIn("写回执时", render_delivery_feedback(value))

    def test_receipt_size_stays_constant_under_heavy_feedback(self):
        """一轮量大但完全合法的检视不得把收据撑过读取上限。

        2026-09-01 实测事故:投影原来封整份 delivery_loop,12 条 350 字的
        MR 意见(内核自己允许单条 4000 字)就越过 32 KiB;此后 feedback、
        pipeline record、连 MR 合入后的 close 全部永久失败,无命令可救。
        """
        value = state("feedback_triage")
        body = "空值分支没覆盖上游返回空值的情况，请补单测并说明预期语义。" * 12
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-big",
            "close_events": [],
            "batches": [{
                "batch_id": "fb-big", "status": "repairing", "base_sha": HEAD,
                "items": [{
                    "id": "mr:d-%s" % index, "source": "mr_discussion",
                    "source_id": "d-%s" % index, "summary": body[:4000],
                    "material": "../reviews/discussions.json",
                    "verification": "reviewer",
                } for index in range(40)],
                "results": [{
                    "id": "mr:d-%s" % index, "status": "fixed",
                    "summary": body[:4000], "evidence": body[:4000],
                } for index in range(40)],
            }],
        }
        raw = len(host_capability._canonical(
            value["delivery_loop"]).encode("utf-8"))
        projection = host_receipts.host_projection(
            value, "feedback-result", {})
        sealed = len(host_capability._canonical(projection).encode("utf-8"))
        self.assertGreater(raw, host_receipts._RECEIPT_LIMIT,
                           "夹具本身必须真的超过读取上限才算复现")
        self.assertLess(sealed, 2048,
                        "投影体积必须与反馈数量无关，否则收据迟早读不回来")

    def test_trusted_receipt_accepts_utf8_projection(self):
        projection = {"summary": "流水线问题已修复", "status": "fixed"}
        payload = {"batch_id": "fb-中文"}
        proof = {
            "schema": host_capability.PROOF_SCHEMA,
            "task_id": "task-7", "action": "feedback-result",
            "payload_digest": hashlib.sha256(
                host_capability._canonical(payload).encode("utf-8")).hexdigest(),
            "nonce": "utf8", "issued_at": int(delivery.time.time()),
            "signature": "signed",
        }
        record = {
            "schema": "mae-flow-host-receipt/1",
            "proof": proof,
            "payload_digest": host_receipts._digest(payload),
            "projection": projection,
            "projection_digest": hashlib.sha256(
                host_capability._canonical(projection).encode("utf-8")).hexdigest(),
        }
        with mock.patch.object(
                host_receipts, "_verify_rsa_sha256", return_value=True):
            self.assertTrue(host_receipts._valid_stored_receipt(
                {"task_id": "task-7"}, record, "feedback-result", projection))
            # 收据绑的是这一把公钥所属的任务，换个任务立刻不认。
            self.assertFalse(host_receipts._valid_stored_receipt(
                {"task_id": "task-8"}, record, "feedback-result", projection))

    def test_proof_reaching_the_trust_root_through_a_symlink_is_accepted(self):
        """<data> 经过软链是常态(macOS 的 /var、容器挂载、盘迁移)。

        原来拿未解引用的 abspath 去和 realpath 化的信任根比,只要中间有
        一层软链就永远不相等,一条宿主命令都过不去(实测)。
        """
        root, old, trust, authority = self.trusted_layout()
        try:
            link = os.path.join(root.name, "link-to-trust")
            os.symlink(trust, link)
            proof_path = os.path.join(trust, "proof-linked.json")
            with open(proof_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "schema": host_capability.PROOF_SCHEMA,
                    "task_id": "task-7", "action": "feedback-open",
                    "payload_digest": "0" * 64, "nonce": "linked",
                    "issued_at": int(delivery.time.time()),
                    "signature": "ZmFrZQ",
                }, stream)
            os.chmod(proof_path, 0o600)
            value = state()
            # 走软链路径进来:必须走到"签名无效"才算路径这关过了；
            # 挂在"不在信任根内"就是本次修复要消灭的那种早死。
            with self.assertRaises(SystemExit):
                host_capability.verify_host_proof(
                    value, os.path.join(link, "proof-linked.json"),
                    "feedback-open", batch())
            payload, resolved = host_capability._proof_payload(
                os.path.join(link, "proof-linked.json"))
            self.assertEqual(trust, resolved)
            self.assertEqual("linked", payload["nonce"])
        finally:
            os.chdir(old)
            root.cleanup()

    def test_one_unreadable_receipt_never_kills_every_later_host_command(self):
        """历史台账体检失败不许升级成拒绝服务。

        原来三个扫描函数对每份历史收据都走严格读取,任何一份权限被动过、
        体积超限或写坏,SystemExit 会掀掉整条宿主命令——反馈、流水线登记
        乃至 MR 合入后的 close 一起永久失败,且无命令可救。
        """
        root, old, trust, _authority = self.trusted_layout()
        try:
            value = state("delivery_watch")
            projection = host_receipts.host_projection(
                value, "pipeline-record", {})
            prefix = host_receipts._receipt_prefix("task-7")
            good = os.path.join(trust, "%sgood.json" % prefix)
            with open(good, "w", encoding="utf-8") as stream:
                stream.write(host_capability._canonical({
                    "schema": host_receipts.RECEIPT_SCHEMA,
                    "proof": {
                        "schema": host_capability.PROOF_SCHEMA,
                        "task_id": "task-7", "action": "pipeline-record",
                        "payload_digest": host_receipts._digest({}),
                        "nonce": "good", "issued_at": 0, "signature": "signed",
                    },
                    "payload_digest": host_receipts._digest({}),
                    "projection": projection,
                    "projection_digest": host_receipts._digest(projection),
                }))
            os.chmod(good, 0o600)
            # 一份写坏的、一份超限的、一份权限被动过的历史收据。
            broken = os.path.join(trust, "%sbroken.json" % prefix)
            with open(broken, "w", encoding="utf-8") as stream:
                stream.write("{ not json")
            os.chmod(broken, 0o600)
            huge = os.path.join(trust, "%shuge.json" % prefix)
            with open(huge, "w", encoding="utf-8") as stream:
                stream.write("x" * (host_receipts._RECEIPT_LIMIT + 1))
            os.chmod(huge, 0o600)
            loose = os.path.join(trust, "%sloose.json" % prefix)
            with open(loose, "w", encoding="utf-8") as stream:
                stream.write("{}")
            os.chmod(loose, 0o644)
            with mock.patch.object(
                    host_receipts, "_verify_rsa_sha256", return_value=True):
                self.assertTrue(host_receipts.trusted_projection(
                    value, "pipeline-record", projection))
                self.assertTrue(host_receipts.trusted_pipeline_projection(
                    value, host_receipts.external_facts(value)))
                # 跳过坏件不等于放行伪证:签名不过照样是 False。
                with mock.patch.object(
                        host_receipts, "_verify_rsa_sha256", return_value=False):
                    self.assertFalse(host_receipts.trusted_projection(
                        value, "pipeline-record", projection))
        finally:
            os.chdir(old)
            root.cleanup()

    def _receipt(self, trust, action, projection):
        path = os.path.join(trust, "%s%s.json" % (
            host_receipts._receipt_prefix("task-7"), action))
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(host_capability._canonical({
                "schema": host_receipts.RECEIPT_SCHEMA,
                "proof": {
                    "schema": host_capability.PROOF_SCHEMA,
                    "task_id": "task-7", "action": action,
                    "payload_digest": host_receipts._digest({}),
                    "nonce": action, "issued_at": 0, "signature": "signed",
                },
                "payload_digest": host_receipts._digest({}),
                "projection": projection,
                "projection_digest": host_receipts._digest(projection),
            }))
        os.chmod(path, 0o600)

    def _attest(self, snapshot, lifecycle="", active_batch=""):
        args = SimpleNamespace(
            delivery_action="attest", lifecycle=lifecycle,
            active_batch=active_batch, snapshot_stdin=True)
        live = {"current": "end"}  # 现场文件故意与快照不同:裁决只看快照。
        with mock.patch.object(host_receipts, "_verify_rsa_sha256",
                               return_value=True), \
                mock.patch("sys.stdin", io.StringIO(json.dumps(snapshot))), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            delivery.cmd_delivery({"steps": {}}, live, args)
        self.assertEqual({"current": "end"}, live, "只读:不动状态")
        return json.loads(out.getvalue())

    def test_attest_judges_the_snapshot_cloud_sends_and_writes_nothing(self):
        """Cloud 不再自己核对收据,只把刚读到的状态送来问内核。

        同一契约原来有 Python 与 TypeScript 两份实现,内核一改投影形状,
        Cloud 镜像没跟上,三个 fail-closed 门恒假、整条链静默锁死(2026-09-02
        实锤)。裁决收回内核后,Cloud 侧再没有一行可以和这里不一致的逻辑。
        """
        root, old, trust, _authority = self.trusted_layout()
        try:
            value = state("delivery_watch")
            self._receipt(trust, "pipeline-record",
                          host_receipts.host_projection(value, "pipeline-record", {}))
            before = sorted(os.listdir(trust))
            verdict = self._attest(value, lifecycle="pipeline-record,close")
            self.assertEqual({
                "schema": host_receipts.ATTEST_SCHEMA,
                "lifecycle": True, "active_batch": None,
            }, verdict)
            # 快照被改一个字段:同一张收据不再背书。
            tampered = json.loads(json.dumps(value))
            tampered["current"] = "end"
            self.assertFalse(
                self._attest(tampered, lifecycle="pipeline-record")["lifecycle"])
            # 问的动作没有收据:False,而不是拿别的动作的收据充数。
            self.assertFalse(
                self._attest(value, lifecycle="close")["lifecycle"])
            # 活动批次:批次正文一字不差才算;current 后来合法移动不影响。
            opened = json.loads(json.dumps(value))
            opened["current"] = "feedback_triage"
            opened["delivery_loop"] = {
                "active_batch_id": "fb-1",
                "batches": [{"batch_id": "fb-1", "status": "repairing",
                             "items": [{"id": "mr:1", "summary": "补空值分支"}]}],
            }
            self._receipt(trust, "feedback-open",
                          host_receipts.host_projection(opened, "feedback-open", {}))
            before = sorted(os.listdir(trust))
            moved = json.loads(json.dumps(opened))
            moved["current"] = "build"
            self.assertTrue(self._attest(
                moved, active_batch="feedback-open")["active_batch"])
            self.assertFalse(self._attest(
                moved, lifecycle="feedback-open")["lifecycle"],
                "current 动过,整份生命周期就不再精确匹配")
            rewritten = json.loads(json.dumps(moved))
            rewritten["delivery_loop"]["batches"][0]["items"][0]["summary"] = "改了"
            self.assertFalse(self._attest(
                rewritten, active_batch="feedback-open")["active_batch"])
            self.assertEqual(before, sorted(os.listdir(trust)), "attest 不落任何文件")
            self.assertFalse(os.path.exists(".mae-flow.json"))
        finally:
            os.chdir(old)
            root.cleanup()

    def test_unrelated_host_actions_cannot_resign_forged_owner_controls(self):
        root, old, trust, authority = self.trusted_layout()
        try:
            value = state("feedback_triage")
            value["delivery_loop"] = {
                "active_batch_id": "fb-1",
                "batches": [{"batch_id": "fb-1", "status": "repairing"}],
            }
            self._receipt(trust, "feedback-open",
                          host_receipts.host_projection(value, "feedback-open", {}))
            # The active batch is unchanged. The formerly accepted successor
            # would seal this fabricated decision in an otherwise normal event.
            value["delivery_loop"]["deferred_feedback"] = {
                "mr:1": {"reason": "FORGED owner decision"}}
            value["delivery_loop"]["target"] = {"target": "FORGED target"}
            for action in ("feedback-open", "feedback-result", "pipeline-record",
                           "close", "selection-reconcile", "intervention-reconcile"):
                with self.subTest(action=action):
                    proof = {
                        "schema": host_capability.PROOF_SCHEMA,
                        "task_id": "task-7", "action": action,
                        "payload_digest": host_receipts._digest({}),
                        "nonce": "new-" + action,
                        "issued_at": int(delivery.time.time()), "signature": "signed",
                    }
                    with mock.patch.object(host_capability, "_proof_payload",
                                           return_value=(proof, trust)), \
                            mock.patch.object(host_capability, "_verify_rsa_sha256", return_value=True), \
                            mock.patch.object(host_receipts, "_verify_rsa_sha256", return_value=True), \
                            self.assertRaises(SystemExit):
                        verify_host_proof(value, "unused", action, {})
        finally:
            os.chdir(old)
            root.cleanup()

    def test_owner_controls_survive_workflow_movement_but_not_deletion_or_rollback(self):
        root, old, trust, _authority = self.trusted_layout()
        try:
            legacy = state("feedback_triage")
            self.assertNotIn("feedback_control_digest",
                             host_receipts.host_projection(legacy, "feedback-open", {}))
            value = state("feedback_triage")
            value["delivery_loop"] = {
                "controls": [{"operation_id": "decision-1"}],
                "target": {"target": "B"},
                "deferred_feedback": {"A": {"reason": "延期"}},
            }
            older = json.loads(json.dumps(value))
            self._receipt(trust, "feedback-open",
                          host_receipts.host_projection(older, "feedback-open", {}))
            value["delivery_loop"]["controls"].append({"operation_id": "decision-2"})
            value["delivery_loop"]["target"] = {"target": "C"}
            self._receipt(trust, "pipeline-record",
                          host_receipts.host_projection(value, "pipeline-record", {}))
            with mock.patch.object(host_receipts, "_verify_rsa_sha256", return_value=True):
                moved = json.loads(json.dumps(value))
                moved["current"] = "build"
                moved["delivery_loop"]["batches"] = [{"status": "awaiting_verification"}]
                host_receipts.verify_feedback_control_predecessor(moved)
                rewritten = json.loads(json.dumps(value))
                rewritten["delivery_loop"]["deferred_feedback"]["B"] = {"reason": "假的"}
                for forged in (legacy, older, rewritten):
                    with self.assertRaises(SystemExit):
                        host_receipts.verify_feedback_control_predecessor(forged)
        finally:
            os.chdir(old)
            root.cleanup()

    def test_attest_refuses_malformed_snapshots(self):
        root, old, _trust, _authority = self.trusted_layout()
        try:
            args = SimpleNamespace(
                delivery_action="attest", lifecycle="close",
                active_batch="", snapshot_stdin=True)
            for raw in ("[1, 2]", "{ not json"):
                with mock.patch("sys.stdin", io.StringIO(raw)), \
                        contextlib.redirect_stdout(io.StringIO()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        delivery.cmd_delivery({"steps": {}}, {}, args)
        finally:
            os.chdir(old)
            root.cleanup()


class PipelineRoutingTests(unittest.TestCase):
    def test_new_pass_retires_only_trusted_old_pipeline_batch(self):
        for mode in ("old", "mixed", "current", "untrusted", "red"):
            with self.subTest(mode=mode):
                value = state("feedback_triage")
                items = [{"id": "old-ci", "source": "pipeline", "verification": "pipeline",
                          "source_id": (HEAD if mode == "current" else "b" * 40) + ":COMPILE"}]
                if mode == "mixed":
                    items.append({"id": "review", "source": "workspace", "verification": "human"})
                active = {"batch_id": "old", "status": "repairing", "items": items}
                value["delivery_loop"] = {"active_batch_id": "old", "batches": [active]}
                with mock.patch.object(delivery, "trusted_active_batch", return_value=mode != "untrusted"), \
                        mock.patch.object(cli_runtime, "advance") as advance:
                    _route_external_verification({"steps": {}}, value,
                        {"verdict": "RED" if mode == "red" else "PASS", "sha": HEAD})
                if mode == "old":
                    self.assertEqual("closed", active["status"])
                    self.assertEqual(HEAD, active["superseded_by_pipeline"])
                    self.assertNotIn("results", active)
                    self.assertEqual("delivery_watch", advance.call_args.args[3]["next"])
                else:
                    self.assertEqual("repairing", active["status"])
                    advance.assert_not_called()

    def test_continuous_pass_enters_delivery_watch(self):
        value = state("external_verify")
        with mock.patch.object(
                cli_runtime, "complete_verified_feedback", return_value=False), mock.patch.object(
                cli_runtime, "advance") as advance:
            _route_external_verification(
                {"steps": {}}, value,
                {"verdict": "PASS", "sha": HEAD, "reason": "green"})
        self.assertEqual("delivery_watch", advance.call_args.args[3]["next"])

    def test_legacy_cloud_pass_keeps_end_semantics(self):
        value = state("external_verify")
        value["execution_contract"]["continuous_review"] = False
        with mock.patch.object(cli_runtime, "advance") as advance:
            _route_external_verification(
                {"steps": {}}, value,
                {"verdict": "PASS", "sha": HEAD, "reason": "green"})
        self.assertEqual("end", advance.call_args.args[3]["next"])


class FeedbackAuthorizationTests(unittest.TestCase):

    def test_named_conflict_path_can_cross_baseline_dirty_but_neighbors_cannot(self):
        value = state("feedback_triage")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-conflict",
            "batches": [{"batch_id": "fb-conflict", "status": "repairing"}],
        }
        value["delivery_repair_authorization"] = {
            "schema": "mae-flow-feedback-repair/1", "status": "ready",
            "batch_id": "fb-conflict", "base_sha": HEAD,
            "baseline_dirty": ["src/conflict.py", "user.txt"],
            "allowed_paths": ["src/conflict.py"],
        }
        from mae_flow_core.quality.external_repair import eligible_repair_paths
        self.assertEqual(
            ("src/conflict.py",),
            eligible_repair_paths(value, HEAD,
                                  ("src/conflict.py", "user.txt")),
        )

    def test_queued_batch_cannot_report_result_before_it_is_promoted(self):
        value = state("feedback_triage")
        value["delivery_loop"] = {
            "schema": delivery.STATE_SCHEMA,
            "active_batch_id": "fb-active",
            "batches": [
                {"batch_id": "fb-active", "status": "repairing", "items": []},
                {"batch_id": "fb-queued", "status": "queued", "items": [
                    {"id": "q-1"},
                ]},
            ],
        }
        payload = {
            "schema": delivery.RESULT_SCHEMA,
            "batch_id": "fb-queued",
            "changed": False,
            "results": [{
                "id": "q-1", "status": "explained", "summary": "done",
            }],
        }
        with tempfile.NamedTemporaryFile("w", encoding="utf-8",
                                         suffix=".json", delete=False) as out:
            json.dump(payload, out)
            path = out.name
        try:
            with mock.patch.object(
                    delivery, "_verify_host_proof", return_value="queue-test-proof"):
                with self.assertRaises(SystemExit):
                    delivery._result({}, value, SimpleNamespace(file=path))
            self.assertEqual("queued", value["delivery_loop"]["batches"][1]["status"])
            self.assertNotIn("result_digest", value["delivery_loop"]["batches"][1])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
