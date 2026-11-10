"""Quality execution and UT-artifact recording for active Agent lifecycle."""

import subprocess
import time

from mae_flow_core import host_env
from mae_flow_core.adapters.hook_transcript_paths import transcript_quality_call
from mae_flow_core.quality.agent_contracts import required_skill
from mae_flow_core.quality.tool_transcript import (
    bash_call,
    bash_calls,
    call_failed,
    exact_skill_call,
    parse_transcript,
    skill_call,
)
from mae_flow_core.quality.ut_artifacts import (
    build_receipt as build_ut_artifact_receipt,
    receipt_has_artifact,
    successful_direct_paths,
)
from mae_flow_core.workflow.agent_observations import started_observation
from mae_flow_core.workflow.quality_executions import (
    quality_input_snapshot,
    record_quality_execution,
)


class HookQualityExecutionMixin:
    @staticmethod
    def _quality_call(kind, calls, config, task=None, run_locally=True):
        if kind == "COMPILE":
            build = str(config.get("编译方式", "") or "")
            return (
                skill_call(calls, "build-fix")
                if "build-fix" in build.lower()
                else bash_call(calls, build))
        if kind == "UT":
            return HookQualityExecutionMixin._ut_quality_call(
                calls, config, task, run_locally)
        if kind == "CODECHECK":
            matches = bash_calls(calls, "codecheck fullcheck")
            return matches[-1][0] if matches else None
        return None

    @staticmethod
    def _ut_quality_call(calls, config, task, run_locally):
        generator = str(config.get("UT生成方式", "") or "")
        need = required_skill(generator)
        generator_call = None
        if str((task or {}).get("ut_phase", "")) != "final" and need:
            generator_call = exact_skill_call(calls, need)
            if not generator_call or call_failed(generator_call):
                return None
        if run_locally:
            return bash_call(
                calls, str(config.get("UT运行命令", "") or ""))
        # Cloud still needs a real UT-writing/audit Agent, but must not invent a
        # local run. Repository artifacts below provide the durable proof.
        return next((
            candidate for candidate in reversed(calls or ())
            if str(candidate.name).lower() in (
                "read", "write", "edit", "multiedit", "skill")
            and candidate.result_seen and not call_failed(candidate)
        ), generator_call)

    def _record_quality_execution(self, payload, invocation_id, lifecycle):
        started = started_observation(self.state, invocation_id) or {}
        kind = started.get("kind", "")
        if kind not in ("COMPILE", "CODECHECK", "UT"):
            return
        state = self.runtime._contract_state()
        task = (state.get("agent_tasks", {}) or {}).get(kind, {}) or {}
        calls = []

        def load_calls(path):
            parsed = parse_transcript(
                self._load_agent_transcript(path)).tool_calls
            calls[:] = parsed
            return parsed

        run_locally = not (
            kind == "UT" and not host_env.unit_tests_run_locally(state))
        call = transcript_quality_call(
            payload, invocation_id, load_calls,
            lambda rows: self._quality_call(
                kind, rows, state.get("config", {}) or {}, task,
                run_locally=run_locally),
            log=self.log, project_root=self.repository_root)
        if call is None and lifecycle == "returned":
            self.log("quality transcript unresolved after retries"
                     "(fail-closed evidence)")
        details = self._quality_details(
            kind, lifecycle, task, calls, invocation_id)
        succeeded = bool(
            lifecycle == "returned" and call and not call_failed(call))
        if kind == "UT" and not run_locally:
            succeeded = bool(
                succeeded and receipt_has_artifact(
                    details.get("ut_artifact")))
        record_quality_execution(
            self.state, kind, started.get("step", ""), invocation_id,
            self._quality_command(call), succeeded,
            quality_input_snapshot(state, kind, started.get("step", "")),
            time.strftime("%Y-%m-%d %H:%M:%S"), lifecycle=lifecycle,
            details=details)

    def _quality_details(self, kind, lifecycle, task, calls, invocation_id):
        if kind != "UT" or lifecycle != "returned" or not calls:
            return {}
        return {"ut_artifact": self._ut_artifact_receipt(
            task, calls, invocation_id)}

    @staticmethod
    def _quality_command(call):
        if not call:
            return ""
        value = call.input
        command = (
            value.get("command", "") if isinstance(value, dict)
            else str(value))
        return "Skill:" + str(value) if call.name.lower() == "skill" else command

    def _ut_artifact_receipt(self, task, calls, invocation_id):
        ports = self.task_card_ports()
        inspected, _written = successful_direct_paths(
            calls, self.repository_root)
        changed = tuple(
            path for path in ports.changed_paths_since(task.get("head", ""))
            if ports.test_like(path) and ports.path_exists(path))
        head = str(task.get("head", "") or "")

        def existed_at_head(path):
            if not head:
                return False
            result = subprocess.run(
                ["git", "-C", self.repository_root, "cat-file", "-e",
                 "%s:%s" % (head, path)],
                shell=False, capture_output=True, timeout=8)
            return result.returncode == 0

        return build_ut_artifact_receipt(
            task,
            inspected_paths=tuple(
                path for path in inspected if ports.test_like(path)),
            changed_test_paths=changed,
            existed_at_head=existed_at_head,
            fingerprint=ports.review_path_fingerprint,
            invocation_id=invocation_id,
            at=time.strftime("%Y-%m-%d %H:%M:%S"))
