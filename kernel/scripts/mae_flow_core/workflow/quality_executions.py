"""Structural quality execution facts independent of Agent return prose."""

from mae_flow_core.state_store import safe_read_json, update_json


def quality_execution_path(state_path):
    return str(state_path) + ".quality-executions"


def quality_input_snapshot(state, kind, step):
    task = (state.get("agent_tasks", {}) or {}).get(kind, {}) or {}
    config = state.get("config", {}) or {}
    return {
        "kind": kind,
        "step": step,
        "head": str(task.get("head", "")),
        "task_files": sorted(str(path) for path in task.get("task_files", [])),
        "execution_roots": sorted(
            str(path) for path in task.get("execution_roots", [])),
        "build": str(config.get("编译方式", "")),
        "ut": str(config.get("UT运行命令", "")),
    }


def _supersedes(existing, incoming):
    """Whether a later lifecycle event may replace an earlier execution fact.

    SubagentStop and the PostToolUse fallback both report the same Agent
    invocation, and only one of them may be able to resolve the subagent
    transcript. A second event that observed no quality call at all
    (``command`` empty) carries strictly less evidence than a proven success:
    letting it overwrite the record would erase real machine evidence and
    leave ``done`` demanding a rerun that can never be recorded either.
    Genuine new evidence (a command that actually failed) still wins.
    """
    if not (existing.get("succeeded") is True
            and str(existing.get("lifecycle", "")) == "returned"):
        return True
    return bool(incoming.get("succeeded")) or bool(incoming.get("command"))


def record_quality_execution(
        state_path, kind, step, invocation_id, command, succeeded,
        input_snapshot, at, lifecycle="returned", details=None):
    record = {
        "kind": str(kind), "step": str(step),
        "invocation_id": str(invocation_id), "command": str(command or ""),
        "succeeded": bool(succeeded), "input_snapshot": dict(input_snapshot),
        "at": str(at), "lifecycle": str(lifecycle),
    }
    if details:
        record["details"] = dict(details)

    def same_invocation(item):
        return (
            isinstance(item, dict)
            and item.get("invocation_id") == record["invocation_id"]
            and item.get("kind") == record["kind"]
        )

    def mutate(data):
        records = data.setdefault("executions", [])
        if any(
                same_invocation(item) and not _supersedes(item, record)
                for item in records):
            return data
        records[:] = [
            item for item in records if not same_invocation(item)]
        records.append(record)
        if len(records) > 500:
            del records[:-500]
        return data

    update_json(
        quality_execution_path(state_path), mutate,
        default={"executions": []}, recover_corrupt=True)
    return record


def successful_quality_execution(state_path, kind, step, input_snapshot):
    data, error = safe_read_json(quality_execution_path(state_path))
    if error or not isinstance(data, dict):
        return None
    for item in reversed(data.get("executions", [])):
        if (item.get("kind") == kind and item.get("step") == step
                and item.get("succeeded") is True
                and item.get("lifecycle") == "returned"
                and item.get("input_snapshot") == input_snapshot):
            return dict(item)
    return None


def ut_artifact_receipts(state_path, step, input_snapshot=None):
    """Return task-bound UT-writing receipts, irrespective of run location."""
    data, error = safe_read_json(quality_execution_path(state_path))
    if error or not isinstance(data, dict):
        return ()
    found = []
    for item in data.get("executions", []):
        if (not isinstance(item, dict)
                or item.get("kind") != "UT"
                or item.get("step") != step
                or item.get("lifecycle") != "returned"):
            continue
        if (input_snapshot is not None
                and item.get("input_snapshot") != input_snapshot):
            continue
        receipt = (item.get("details") or {}).get("ut_artifact")
        if isinstance(receipt, dict):
            found.append(dict(receipt))
    return tuple(found)


def invalidate_quality_executions(state_path, kind, step):
    """A newly issued task requires a new real execution, without hashes."""
    def mutate(data):
        records = data.setdefault("executions", [])
        records[:] = [
            item for item in records
            if not (item.get("kind") == kind and item.get("step") == step)
        ]
        return data

    update_json(
        quality_execution_path(state_path), mutate,
        default={"executions": []}, recover_corrupt=True)
