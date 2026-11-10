"""One-way conversion of schema-v2 flows into lean recovery cursors."""

import json
import os
import re
from dataclasses import dataclass

from .models import (
    CapabilityAttempt,
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
)


@dataclass(frozen=True)
class MigrationResult:
    state: FlowState
    warnings: tuple
    backup_required: bool = True




_STEP_PHASES = {
    "config_confirm": Phase.STARTUP,
    "workflow_select": Phase.STARTUP,
    "code_reviewer_ask": Phase.STARTUP,
    "branch_create": Phase.STARTUP,
    "grill_ask": Phase.SPEC,
    "grill": Phase.SPEC,
    "open": Phase.SPEC,
    "hf_open": Phase.SPEC,
    "tw_open": Phase.SPEC,
    "rf_triage": Phase.SPEC,
    "design": Phase.STORY,
    "test_blueprint": Phase.STORY,
    "story_ask": Phase.STORY,
    "story": Phase.STORY,
    "build_plan": Phase.STORY,
    "build_pace": Phase.CONSTRUCTION,
    "build": Phase.CONSTRUCTION,
    "build_review": Phase.CONSTRUCTION,
    "tw_pace": Phase.CONSTRUCTION,
    "tw_change": Phase.CONSTRUCTION,
    "rf_pace": Phase.CONSTRUCTION,
    "rf_fix": Phase.CONSTRUCTION,
    "verify_ponytail": Phase.QUALITY,
    "verify_codecheck": Phase.QUALITY,
    "verify_ut": Phase.QUALITY,
    "verify_spec": Phase.QUALITY,
    "verify_codecheck_compile": Phase.QUALITY,
    "verify_comet": Phase.QUALITY,
    "verify_recompile": Phase.QUALITY,
    "tw_compile": Phase.QUALITY,
    "tw_review": Phase.QUALITY,
    "tw_codecheck": Phase.QUALITY,
    "tw_ut": Phase.QUALITY,
    "tw_verify": Phase.QUALITY,
    "rf_verify": Phase.QUALITY,
    "rf_compile": Phase.QUALITY,
    "rf_review": Phase.QUALITY,
    "rf_codecheck": Phase.QUALITY,
    "rf_ut": Phase.QUALITY,
    "delivery_review": Phase.DELIVERY,
    "archive_confirm": Phase.DELIVERY,
    "archive": Phase.DELIVERY,
    "push": Phase.DELIVERY,
    "end": Phase.DELIVERY,
}

_FOCUSED_WORKFLOWS = {"hotfix", "tweak", "review"}
_ARTIFACT_ALIASES = {
    "request": ("需求文档", "request_path", "requirement_path"),
    "spec": ("SPEC路径", "spec_path", "spec"),
    "story": ("STORY路径", "story_path", "story"),
}
_EVIDENCE_KEYS = {
    "ack",
    "ack_cursor",
    "actual_ack",
    "adoption_ack",
    "agent_tasks",
    "all_ack",
    "authorization_ack",
    "authorization_receipt",
    "cc_ack",
    "checkpoint_ack",
    "confirmation_receipt",
    "confirmation_receipts",
    "config_ack",
    "cp_receipt",
    "current_ack",
    "evidence",
    "exact_ack",
    "failure_lock",
    "failure_locks",
    "freshness_hash",
    "freshness_hashes",
    "full_ack",
    "fullcheck_receipt",
    "implicit_ack",
    "moon_ack",
    "out_of_scope_ack",
    "plan_receipt",
    "receipt",
    "receipts",
    "recovery_ack",
    "requirement_sha256",
    "report_hash",
    "report_hashes",
    "result_hash",
    "result_hashes",
    "risk_ack",
    "scope_ack",
    "scope_confirmation_receipt",
    "scope_confirmed_ack",
    "short_ack",
    "source_tokens",
    "step_head",
    "step_heads",
    "stephead",
    "stepheads",
    "structured_ack",
    "task_card",
    "task_cards",
    "token",
    "tokens",
    "user_ack",
    "verify_ack",
}


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _string(value):
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple, bool, int, float)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value).strip()


def _strings(value):
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(text for text in (_string(item) for item in value) if text)


def _sequence(value):
    return value if isinstance(value, (list, tuple)) else ()


def _evidence_key(value):
    normalized = re.sub(r"[^a-z0-9]+", "_", _string(value).lower()).strip("_")
    return normalized in _EVIDENCE_KEYS


def _semantic_value(value):
    if isinstance(value, dict):
        if ("key" in value and "value" in value
                and _evidence_key(value.get("key"))):
            return None
        kept = {}
        for key, item in value.items():
            if _evidence_key(key):
                continue
            sanitized = _semantic_value(item)
            if sanitized not in (None, {}, []):
                kept[key] = sanitized
        return kept
    if isinstance(value, (list, tuple)):
        if (len(value) == 2 and not isinstance(value[0], (dict, list, tuple))
                and _evidence_key(value[0])):
            return None
        kept = []
        for item in value:
            sanitized = _semantic_value(item)
            if sanitized not in (None, {}, []):
                kept.append(sanitized)
        return kept
    return value


def _semantic_string(value):
    sanitized = _semantic_value(value)
    if sanitized in (None, {}, []):
        return ""
    return _string(sanitized)


def _first_semantic(values, default=""):
    for value in values:
        if not value:
            continue
        text = _semantic_string(value)
        if text:
            return text
    return default


def _legacy_workflow(raw):
    choices = _mapping(raw.get("choices"))
    config = _mapping(raw.get("config"))
    return _string(
        choices.get("workflow")
        or raw.get("workflow")
        or config.get("workflow")
        or "full").lower()


def _phase_from_history(raw):
    phase = Phase.STARTUP
    for item in _sequence(raw.get("history")):
        step = _string(_mapping(item).get("step"))
        candidate = _STEP_PHASES.get(step)
        if candidate is not None:
            phase = candidate
    if phase == Phase.DELIVERY:
        return Phase.QUALITY
    return phase


def _ambiguous_phase(raw, step):
    lowered = step.lower()
    words = set(re.split(r"[^a-z0-9]+", lowered))
    if words.intersection({
            "verify", "quality", "codecheck", "compile", "test", "ut",
            "review", "delivery", "archive", "push", "end"}):
        return Phase.QUALITY
    if words.intersection({"build", "change", "fix", "pace"}):
        return Phase.CONSTRUCTION
    if words.intersection({"story", "design", "blueprint"}):
        return Phase.STORY
    if words.intersection({"spec", "grill", "open", "triage"}):
        return Phase.SPEC
    return _phase_from_history(raw)


def _phase(raw):
    step = _string(raw.get("current"))
    known = _STEP_PHASES.get(step)
    if known is not None:
        return known, ()
    warning = (
        "Legacy step %r is ambiguous; resume summary required before "
        "continuing; push is not authorized." % step,
    )
    return _ambiguous_phase(raw, step), warning


def _first(config, aliases):
    for key in aliases:
        value = _string(config.get(key))
        if value:
            return value
    return ""


def _story_was_reached(raw):
    if _string(raw.get("current")) == "story":
        return True
    for item in _sequence(raw.get("history")):
        if _string(_mapping(item).get("step")) == "story":
            return True
    return False


def _artifacts(raw, ticket, workflow):
    config = _mapping(raw.get("config"))
    artifacts = []
    for kind in ("request", "spec", "story"):
        path = _first(config, _ARTIFACT_ALIASES[kind])
        if kind == "spec" and not path:
            change = _string(config.get("CHANGE_NAME"))
            if change:
                # 双根:取真实存在的那份;都不存在时保持旧指针——本迁移
                # 服务的就是旧版在途状态,它的 change 目录只可能在旧根
                path = "openspec/changes/%s/change.md" % change
                relocated = ".mae-flow-work/spec/changes/%s/change.md" % change
                if not os.path.exists(path) and os.path.exists(relocated):
                    path = relocated
        if (kind == "story" and not path and ticket
                and workflow == "full" and _story_was_reached(raw)):
            path = "docs/story/STORY-%s.md" % ticket
        if path:
            artifacts.append((kind, path))
    return tuple(artifacts)


def _pairs(value):
    pairs = []
    if isinstance(value, dict):
        source = sorted(value.items(), key=lambda item: str(item[0]))
    elif isinstance(value, (list, tuple)):
        source = []
        for item in value:
            if isinstance(item, dict) and "key" in item and "value" in item:
                source.append((item["key"], item["value"]))
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                source.append((item[0], item[1]))
    else:
        source = []
    for key, value in source:
        key_text = _string(key)
        if _evidence_key(key_text):
            continue
        value_text = _semantic_string(value)
        if key_text and value_text:
            pairs.append((key_text, value_text))
    return pairs


def _decisions(raw):
    decisions = []
    config = _mapping(raw.get("config"))
    for key, value in sorted(config.items(), key=lambda item: str(item[0])):
        if key == "单号":
            continue
        key_text = _string(key)
        if _evidence_key(key_text):
            continue
        value_text = _semantic_string(value)
        if key_text and value_text:
            decisions.append(("config." + key_text, value_text))
    decisions.extend(_pairs(raw.get("choices")))
    decisions.extend(_pairs(raw.get("decisions")))
    return tuple(decisions)


def _commit_pace(raw):
    review = _mapping(raw.get("development_review"))
    choices = _mapping(raw.get("choices"))
    config = _mapping(raw.get("config"))
    value = _string(
        review.get("mode")
        or raw.get("commit_pace")
        or choices.get("commit_pace")
        or choices.get("pace")
        or config.get("开发节奏")
        or "continuous").lower()
    return CommitPace.STAGED if value == "staged" else CommitPace.CONTINUOUS


def _capabilities(raw):
    source = raw.get("capabilities")
    if source is None:
        source = raw.get("capability_attempts")
    if not isinstance(source, (list, tuple)):
        return ()
    attempts = []
    for raw_attempt in source:
        attempt = _mapping(raw_attempt)
        kind = _first_semantic((
            attempt.get("kind"), attempt.get("name")))
        outcome = _first_semantic((
            attempt.get("outcome"),
            attempt.get("status"),
            attempt.get("result"),
        ))
        if not kind or not outcome:
            continue
        attempts.append(CapabilityAttempt(
            kind=kind,
            source_revision=_first_semantic((
                attempt.get("source_revision"), attempt.get("source"))),
            environment_revision=_first_semantic((
                attempt.get("environment_revision"),
                attempt.get("environment"),
            )),
            outcome=outcome,
            summary=_first_semantic((
                attempt.get("summary"), attempt.get("detail"))),
        ))
    return tuple(attempts)


def _delivery_files(raw):
    files = raw.get("delivery_files")
    if files is None:
        manifest = raw.get("delivery_manifest")
        files = _mapping(manifest).get("files") if isinstance(
            manifest, dict) else manifest
    return _strings(files)


def _risks(raw):
    risks = []
    for risk in _sequence(raw.get("risks")):
        text = _semantic_string(risk)
        if text:
            risks.append(text)
    moonlight = _mapping(raw.get("moonlight"))
    for issue in _sequence(moonlight.get("issues")):
        item = _mapping(issue)
        text = _first_semantic((item.get("summary"), item.get("detail")))
        if text:
            risks.append(text)
    return tuple(risks)


def migrate_legacy_flow(raw):
    """Return a lean cursor without carrying forward evidence machinery."""
    if isinstance(raw, FlowState):
        return MigrationResult(raw, ())
    if not isinstance(raw, dict):
        raise ValueError("legacy flow state must be a JSON object")
    if type(raw.get("schema_version")) is not int or raw.get(
            "schema_version") != 2:
        raise ValueError("legacy flow state schema_version must be 2")
    current = raw.get("current")
    if not isinstance(current, str) or not current:
        raise ValueError("legacy flow state must contain current")

    config = _mapping(raw.get("config"))
    ticket = _string(config.get("单号") or raw.get("ticket"))
    workflow = _legacy_workflow(raw)
    phase, warnings = _phase(raw)
    status = "complete" if current == "end" else "active"
    state = FlowState(
        ticket=ticket,
        path=(DeliveryPath.FOCUSED if workflow in _FOCUSED_WORKFLOWS
              else DeliveryPath.FULL),
        phase=phase,
        commit_pace=_commit_pace(raw),
        status=status,
        artifacts=_artifacts(raw, ticket, workflow),
        decisions=_decisions(raw),
        risks=_risks(raw),
        capabilities=_capabilities(raw),
        delivery_files=_delivery_files(raw),
        initial_dirty=_strings(raw.get("initial_dirty")),
    )
    return MigrationResult(state, warnings)
