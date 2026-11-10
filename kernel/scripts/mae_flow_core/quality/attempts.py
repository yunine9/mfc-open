"""Small persisted counters for bounded quality work."""

from dataclasses import dataclass


@dataclass(frozen=True)
class AttemptDecision:
    started: bool = False
    reused: bool = False
    exhausted: bool = False
    count: int = 0


def _record(state, kind):
    attempts = state.setdefault("quality_attempts", {})
    record = attempts.setdefault(kind, {"count": 0, "inputs": []})
    if not isinstance(record.get("inputs"), list):
        record["inputs"] = []
    if not isinstance(record.get("count"), int):
        record["count"] = len(record["inputs"])
    return record


def attempt_count(state, kind):
    record = ((state or {}).get("quality_attempts") or {}).get(kind) or {}
    count = record.get("count", 0)
    return count if isinstance(count, int) and count >= 0 else 0


def begin_attempt(state, kind, input_identity, limit):
    """Record a distinct real input once and reject work beyond ``limit``."""
    if not isinstance(state, dict):
        raise TypeError("state must be a mapping")
    if not isinstance(limit, int) or limit < 1:
        raise ValueError("attempt limit must be positive")
    identity = str(input_identity or "").strip()
    if not identity:
        raise ValueError("attempt input identity must not be empty")
    record = _record(state, str(kind))
    if identity in record["inputs"]:
        return AttemptDecision(reused=True, count=record["count"])
    if record["count"] >= limit:
        return AttemptDecision(exhausted=True, count=record["count"])
    record["inputs"].append(identity)
    record["count"] += 1
    return AttemptDecision(started=True, count=record["count"])
