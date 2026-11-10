"""Strict schema-v3 encoding for lean workflow recovery cursors."""

from .models import (
    CapabilityAttempt,
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
)


ENGINE = "lean-v1"
SCHEMA_VERSION = 3
_FIELDS = {
    "engine",
    "schema_version",
    "ticket",
    "path",
    "phase",
    "commit_pace",
    "status",
    "artifacts",
    "decisions",
    "risks",
    "capabilities",
    "delivery_files",
    "initial_dirty",
}
_STATUSES = {"active", "paused", "complete", "exited"}


def _string(value, field):
    if not isinstance(value, str):
        raise ValueError("%s must be a string" % field)
    return value


def _status(value):
    value = _string(value, "status")
    if value not in _STATUSES:
        raise ValueError("status must be one of %s" % sorted(_STATUSES))
    return value


def _string_list(value, field):
    if not isinstance(value, list):
        raise ValueError("%s must be a list" % field)
    return tuple(_string(item, field) for item in value)


def _enum_value(value, enum_type, field):
    if not isinstance(value, enum_type):
        raise ValueError("%s must be a %s" % (field, enum_type.__name__))
    return value.value


def _tuple(value, field):
    if not isinstance(value, tuple):
        raise ValueError("%s must be a tuple" % field)
    return value


def _encoded_pairs(value, field, first, second):
    encoded = []
    for item in _tuple(value, field):
        if not isinstance(item, tuple) or len(item) != 2:
            raise ValueError("%s entries must be two-item tuples" % field)
        encoded.append({
            first: _string(item[0], "%s.%s" % (field, first)),
            second: _string(item[1], "%s.%s" % (field, second)),
        })
    return encoded


def _encoded_strings(value, field):
    return [_string(item, field) for item in _tuple(value, field)]


def _encoded_attempts(value):
    encoded = []
    for attempt in _tuple(value, "capabilities"):
        if not isinstance(attempt, CapabilityAttempt):
            raise ValueError(
                "capabilities entries must be CapabilityAttempt values")
        encoded.append({
            "kind": _string(attempt.kind, "capabilities.kind"),
            "source_revision": _string(
                attempt.source_revision, "capabilities.source_revision"),
            "environment_revision": _string(
                attempt.environment_revision,
                "capabilities.environment_revision"),
            "outcome": _string(attempt.outcome, "capabilities.outcome"),
            "summary": _string(attempt.summary, "capabilities.summary"),
        })
    return encoded


def _pair_objects(value, field, first, second):
    if not isinstance(value, list):
        raise ValueError("%s must be a list" % field)
    pairs = []
    expected = {first, second}
    for item in value:
        if not isinstance(item, dict) or set(item) != expected:
            raise ValueError(
                "%s entries must contain exactly %s and %s" %
                (field, first, second))
        pairs.append((
            _string(item[first], "%s.%s" % (field, first)),
            _string(item[second], "%s.%s" % (field, second)),
        ))
    return tuple(pairs)


def encode_flow_state(state):
    """Encode a FlowState without adding evidence-ledger fields."""
    if not isinstance(state, FlowState):
        raise TypeError("state must be a FlowState")
    return {
        "engine": ENGINE,
        "schema_version": SCHEMA_VERSION,
        "ticket": _string(state.ticket, "ticket"),
        "path": _enum_value(state.path, DeliveryPath, "path"),
        "phase": _enum_value(state.phase, Phase, "phase"),
        "commit_pace": _enum_value(
            state.commit_pace, CommitPace, "commit_pace"),
        "status": _status(state.status),
        "artifacts": _encoded_pairs(
            state.artifacts, "artifacts", "kind", "path"),
        "decisions": _encoded_pairs(
            state.decisions, "decisions", "key", "value"),
        "risks": _encoded_strings(state.risks, "risks"),
        "capabilities": _encoded_attempts(state.capabilities),
        "delivery_files": _encoded_strings(
            state.delivery_files, "delivery_files"),
        "initial_dirty": _encoded_strings(
            state.initial_dirty, "initial_dirty"),
    }


def decode_flow_state(raw):
    """Decode an exact lean-v1 schema-v3 document into immutable values."""
    if not isinstance(raw, dict):
        raise ValueError("lean flow state must be a JSON object")
    if set(raw) != _FIELDS:
        raise ValueError("lean flow state fields do not match schema-v3")
    if raw["engine"] != ENGINE:
        raise ValueError("lean flow state engine must be %s" % ENGINE)
    if (type(raw["schema_version"]) is not int
            or raw["schema_version"] != SCHEMA_VERSION):
        raise ValueError(
            "lean flow state schema_version must be %s" % SCHEMA_VERSION)

    capabilities = raw["capabilities"]
    if not isinstance(capabilities, list):
        raise ValueError("capabilities must be a list")
    attempts = []
    attempt_fields = {
        "kind", "source_revision", "environment_revision", "outcome",
        "summary",
    }
    for item in capabilities:
        if not isinstance(item, dict) or set(item) != attempt_fields:
            raise ValueError("capability entries do not match schema-v3")
        attempts.append(CapabilityAttempt(
            kind=_string(item["kind"], "capabilities.kind"),
            source_revision=_string(
                item["source_revision"], "capabilities.source_revision"),
            environment_revision=_string(
                item["environment_revision"],
                "capabilities.environment_revision"),
            outcome=_string(item["outcome"], "capabilities.outcome"),
            summary=_string(item["summary"], "capabilities.summary"),
        ))

    try:
        path = DeliveryPath(raw["path"])
        phase = Phase(raw["phase"])
        pace = CommitPace(raw["commit_pace"])
    except (TypeError, ValueError) as exc:
        raise ValueError("lean flow state contains an invalid enum value") from exc

    return FlowState(
        ticket=_string(raw["ticket"], "ticket"),
        path=path,
        phase=phase,
        commit_pace=pace,
        status=_status(raw["status"]),
        artifacts=_pair_objects(
            raw["artifacts"], "artifacts", "kind", "path"),
        decisions=_pair_objects(
            raw["decisions"], "decisions", "key", "value"),
        risks=_string_list(raw["risks"], "risks"),
        capabilities=tuple(attempts),
        delivery_files=_string_list(
            raw["delivery_files"], "delivery_files"),
        initial_dirty=_string_list(raw["initial_dirty"], "initial_dirty"),
    )
