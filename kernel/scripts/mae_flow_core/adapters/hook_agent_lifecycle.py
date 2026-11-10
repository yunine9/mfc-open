"""Reconcile host Agent lifecycle events with Mae-Flow observations."""

import time
from datetime import datetime

from mae_flow_core.application.hooks.agent_completion import (
    AgentCompletionPorts,
    handle_agent_completion,
)
from mae_flow_core.application.hooks.event_policies import agent_kind
from mae_flow_core.application.hooks.models import HookResponse
from mae_flow_core.workflow.agent_observations import (
    aliased_invocation,
    bind_agent_alias,
    open_started_observations,
    record_agent_finished,
    started_observation,
)


class HookAgentLifecycle:
    """Normalize PreToolUse, PostToolUse and SubagentStop identities."""

    def __init__(
            self, *, state_path, current_step, record_execution,
            scope_violation, log):
        self.state_path = state_path
        self.current_step = current_step
        self.record_execution = record_execution
        self.scope_violation = scope_violation
        self.log = log

    def _resolve_started(self, invocation_id="", payload=None):
        payload = payload or {}
        if invocation_id and started_observation(
                self.state_path, invocation_id):
            return invocation_id
        alias = aliased_invocation(self.state_path, invocation_id)
        if alias and started_observation(self.state_path, alias):
            return alias
        # PostToolUse 自带精确调用 ID；不可拿另一位 Critic 的开放记录兜底。
        if payload.get("tool_use_id"):
            return ""
        try:
            step = str(self.current_step() or "")
        except Exception:
            step = ""
        candidates = list(open_started_observations(
            self.state_path, step=step))
        agent_type = str(payload.get("agent_type", "") or "")
        if "grill-critic-agent" in agent_type:
            candidates = [
                item for item in candidates
                if str(item.get("kind", "")).startswith("GRILL")
            ]
        elif agent_type:
            kind = agent_kind({"subagent_type": agent_type})
            if kind:
                candidates = [
                    item for item in candidates if item.get("kind") == kind
                ]
        if len(candidates) == 1:
            return str(candidates[0].get("invocation_id", "") or "")
        if len(candidates) > 1:
            self.log(
                "agent completion ambiguous: %s open starts at %s"
                % (len(candidates), step or "unknown-step"))
        return ""

    def _ports(self, completed_at=""):
        return AgentCompletionPorts(
            state_path=self.state_path,
            latest_started=self._resolve_started,
            record_finished=lambda state_path, invocation_id, lifecycle, detail:
            record_agent_finished(
                state_path, invocation_id, lifecycle,
                completed_at or time.strftime("%Y-%m-%d %H:%M:%S"), detail),
            record_execution=self.record_execution,
            scope_violation=self.scope_violation,
            log=self.log,
        )

    @staticmethod
    def _response_detail(response):
        if not isinstance(response, dict):
            return str(response or "")
        content = response.get("content", "")
        if isinstance(content, list):
            text = [
                str(item.get("text", ""))
                for item in content if isinstance(item, dict)
                and item.get("type") == "text"
            ]
            return "\n".join(value for value in text if value)
        return str(content or "")

    def complete(self, payload):
        stamp = payload.get("completed_at", "")
        if stamp:
            stamp = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        return handle_agent_completion(payload, self._ports(stamp))

    def posttool(self, payload):
        response = payload.get("tool_response")
        response = response if isinstance(response, dict) else {}
        tool_use_id = str(payload.get("tool_use_id", "") or "")
        agent_id = str(
            response.get("agentId", response.get("agent_id", "")) or "")
        if agent_id and tool_use_id and started_observation(self.state_path, tool_use_id):
            bind_agent_alias(self.state_path, agent_id, tool_use_id)
        status = str(response.get("status", "") or "").lower()
        if not response.get("is_error") and status in ("async_launched", "launched", "background"):
            return HookResponse()
        completion = dict(payload)
        completion["invocation_id"] = tool_use_id
        completion["completed_at"] = response.get("completed_at", "")
        completion["agent_type"] = (payload.get("tool_input") or {}).get("subagent_type", "")
        if agent_id:
            completion["agent_id"] = agent_id
        completion["assistant_text"] = self._response_detail(response)
        completion["lifecycle"] = (
            "interrupted"
            if response.get("is_error") or status in ("interrupted", "cancelled", "canceled", "failed")
            else "timeout" if status in ("timeout", "timed_out") else "returned"
        )
        return self.complete(completion)
