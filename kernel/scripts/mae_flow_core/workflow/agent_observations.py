"""Opaque Agent lifecycle observations used as workflow evidence."""

from dataclasses import asdict, dataclass
import os
from typing import Optional

from mae_flow_core.state_store import safe_read_json, update_json


_LIFECYCLES = {"started", "returned", "interrupted", "timeout"}


@dataclass(frozen=True)
class AgentObservation:
    kind: str
    step: str
    invocation_id: str
    lifecycle: str
    at: str
    detail: str = ""


def observation_path(state_path):
    return str(state_path) + ".agent-observations"


def _raw_data(state_path):
    data, error = safe_read_json(observation_path(state_path))
    if error and os.environ.get("MAE_FLOW_HOOK_STRICT") == "1":
        raise ValueError("Agent 观察记录不可读: " + error)
    if error or not isinstance(data, dict):
        return {}
    return data


def _resolve_unique_orphans(records):
    """Read old mismatched-ID records as the lifecycle they represented.

    Stable-v2 used a PreToolUse ``tool_use_id`` as the start identifier but
    accepted SubagentStop ``agent_id`` as though it were the same namespace.
    Repair only when exactly one invocation was open at that point; ambiguous
    concurrent histories remain unaccepted instead of guessing.
    """
    resolved = []
    open_starts = {}
    for raw in records:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        invocation_id = str(item.get("invocation_id", "") or "")
        lifecycle = item.get("lifecycle")
        if lifecycle == "started":
            open_starts[invocation_id] = item
        elif lifecycle in _LIFECYCLES - {"started"}:
            if invocation_id in open_starts:
                open_starts.pop(invocation_id, None)
            elif not item.get("kind") and not item.get("step") and (
                    len(open_starts) == 1):
                start_id, start = next(iter(open_starts.items()))
                item["source_invocation_id"] = invocation_id
                item["invocation_id"] = start_id
                item["kind"] = str(start.get("kind", ""))
                item["step"] = str(start.get("step", ""))
                open_starts.pop(start_id, None)
        resolved.append(item)
    return resolved


def _records(state_path):
    data = _raw_data(state_path)
    records = data.get("observations", [])
    return _resolve_unique_orphans(records) if isinstance(records, list) else []


def bind_agent_alias(state_path, agent_id, invocation_id):
    agent_id = str(agent_id or "")
    invocation_id = str(invocation_id or "")
    if not agent_id or not invocation_id:
        return ""

    def mutate(data):
        aliases = data.setdefault("aliases", {})
        aliases[agent_id] = invocation_id
        if len(aliases) > 1000:
            for key in tuple(aliases)[:-1000]:
                aliases.pop(key, None)
        return data

    update_json(
        observation_path(state_path), mutate,
        default={"observations": [], "aliases": {}}, recover_corrupt=os.environ.get("MAE_FLOW_HOOK_STRICT") != "1")
    return invocation_id


def aliased_invocation(state_path, agent_id):
    aliases = _raw_data(state_path).get("aliases", {})
    if not isinstance(aliases, dict):
        return ""
    return str(aliases.get(str(agent_id or ""), "") or "")


def _append(state_path, observation):
    def mutate(data):
        if not isinstance(data, dict):
            data = {}
        records = data.setdefault("observations", [])
        if not isinstance(records, list):
            records = []
            data["observations"] = records
        duplicate = any(
            item.get("invocation_id") == observation.invocation_id
            and item.get("lifecycle") == observation.lifecycle
            for item in records if isinstance(item, dict)
        )
        if not duplicate:
            records.append(asdict(observation))
            if len(records) > 1000:
                del records[:-1000]
        return data

    update_json(
        observation_path(state_path), mutate,
        default={"observations": []}, recover_corrupt=os.environ.get("MAE_FLOW_HOOK_STRICT") != "1")
    return observation


def record_agent_started(state_path, kind, step, invocation_id, at):
    observation = AgentObservation(
        kind=str(kind or ""), step=str(step or ""),
        invocation_id=str(invocation_id or ""), lifecycle="started",
        at=str(at or ""),
    )
    if not observation.invocation_id:
        raise ValueError("Agent invocation_id 不能为空")
    return _append(state_path, observation)


def _started_for(records, invocation_id):
    return next((
        item for item in reversed(records)
        if isinstance(item, dict)
        and item.get("invocation_id") == invocation_id
        and item.get("lifecycle") == "started"
    ), {})


def started_observation(state_path, invocation_id):
    started = _started_for(_records(state_path), str(invocation_id or ""))
    return dict(started) if started else None


def record_agent_finished(
        state_path, invocation_id, lifecycle, at, detail=""):
    lifecycle = str(lifecycle or "returned").lower()
    if lifecycle not in _LIFECYCLES - {"started"}:
        raise ValueError("未知 Agent lifecycle: " + lifecycle)
    records = _records(state_path)
    started = _started_for(records, str(invocation_id or ""))
    observation = AgentObservation(
        kind=str(started.get("kind", "")),
        step=str(started.get("step", "")),
        invocation_id=str(invocation_id or ""), lifecycle=lifecycle,
        at=str(at or ""), detail=str(detail or ""),
    )
    if not observation.invocation_id:
        raise ValueError("Agent invocation_id 不能为空")
    return _append(state_path, observation)


def latest_started_invocation(state_path, kind="", step=""):
    records = _records(state_path)
    finished = {
        item.get("invocation_id")
        for item in records if isinstance(item, dict)
        and item.get("lifecycle") in ("returned", "interrupted", "timeout")
    }
    for item in reversed(records):
        if not isinstance(item, dict) or item.get("lifecycle") != "started":
            continue
        if item.get("invocation_id") in finished:
            continue
        if kind and item.get("kind") != kind:
            continue
        if step and item.get("step") != step:
            continue
        return str(item.get("invocation_id", ""))
    return ""


def open_started_observations(state_path, kind="", step=""):
    records = _records(state_path)
    finished = {
        item.get("invocation_id")
        for item in records if isinstance(item, dict)
        and item.get("lifecycle") in ("returned", "interrupted", "timeout")
    }
    result = []
    seen = set()
    for item in reversed(records):
        if not isinstance(item, dict) or item.get("lifecycle") != "started":
            continue
        invocation_id = str(item.get("invocation_id", "") or "")
        if invocation_id in finished or invocation_id in seen:
            continue
        if kind and item.get("kind") != kind:
            continue
        if step and item.get("step") != step:
            continue
        result.append(dict(item))
        seen.add(invocation_id)
    return tuple(result)


def finished_observation(
        state_path, kind, step, since="") -> Optional[dict]:
    for item in reversed(_records(state_path)):
        if not isinstance(item, dict):
            continue
        if (item.get("kind") == kind
                and item.get("step") == step
                and item.get("lifecycle") == "returned"
                and str(item.get("at", "")) >= str(since or "")):
            return dict(item)
    return None


def has_finished_observation(state_path, kind, step, since=""):
    return finished_observation(state_path, kind, step, since) is not None


def finished_observations(state_path, kind, step, since=""):
    """本步该 kind 的全部 returned 记录(时间序)。证据层据此数覆盖、辨拒绝。"""
    return tuple(
        dict(item) for item in _records(state_path)
        if isinstance(item, dict)
        and item.get("kind") == kind
        and item.get("step") == step
        and item.get("lifecycle") == "returned"
        and str(item.get("at", "")) >= str(since or "")
    )
