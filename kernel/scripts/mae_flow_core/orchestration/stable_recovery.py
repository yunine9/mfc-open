"""Conservative Lean-v3 to stable-v2 semantic recovery."""

from dataclasses import dataclass

from .models import DeliveryPath
from .state_schema import decode_flow_state


@dataclass(frozen=True)
class StableRecoveryResult:
    state: object
    safe_boundary: str
    terminal: bool = False
    warning: str = ""


SAFE_BOUNDARY_BY_PHASE = {
    "startup": "config_confirm",
    "spec": "open",
    "story": "story",
    "construction": "build",
    "quality": "build",
    "delivery": "delivery_review",
}


def recover_lean_flow(raw):
    """Project durable semantics without importing any evidence contract."""
    # Lean v3 once persisted a batch-development cursor.  It has no semantic
    # value in the whole-change workflow, so the one-way recovery bridge drops
    # it before strict decoding instead of reintroducing it into active state.
    document = dict(raw) if isinstance(raw, dict) else raw
    if isinstance(document, dict):
        document.pop("current_cp", None)
    lean = decode_flow_state(document)
    if lean.status in {"complete", "exited"}:
        return StableRecoveryResult(None, "", terminal=True)
    phase = lean.phase.value
    boundary = SAFE_BOUNDARY_BY_PHASE.get(phase)
    if not boundary:
        return StableRecoveryResult(
            None, "", warning="无法确定安全恢复阶段，保留原现场等待人工判断。")

    semantic = {key: value for key, value in lean.decisions}
    config = {"单号": lean.ticket}
    choices = {}
    for key, value in semantic.items():
        if key.startswith("config."):
            config[key[len("config."):]] = value
        elif key in {
                "workflow", "grill", "STORY入库", "code_reviewer",
                }:
            choices[key] = value
    choices.setdefault(
        "workflow", "full" if lean.path == DeliveryPath.FULL else "tweak")

    artifact_fields = {
        "request": "需求文档", "spec": "SPEC路径", "story": "STORY路径",
    }
    artifacts = {}
    for kind, path in lean.artifacts:
        field = artifact_fields.get(kind)
        if field and path:
            config[field] = path
            artifacts[kind] = path

    workflow = choices["workflow"]
    if lean.path == DeliveryPath.FOCUSED:
        if phase == "spec":
            boundary = {
                "hotfix": "hf_open", "review": "rf_triage",
            }.get(workflow, "tw_open")
        elif phase == "construction":
            boundary = "build"
        elif phase == "quality":
            boundary = "rf_verify" if workflow == "review" else "tw_codecheck"

    stable = {
        "schema_version": 2,
        "revision": 0,
        "current": boundary,
        "config": config,
        "choices": choices,
        "protocols": {},
        "history": [{
            "step": boundary,
            "result": "从 Lean v3 安全恢复；旧质量证据未复用",
        }],
        "started": "",
        "initial_dirty": list(lean.initial_dirty),
        "initial_dirty_fingerprints": {},
        "recovered_artifacts": artifacts,
        "recovery_risks": list(lean.risks),
    }
    return StableRecoveryResult(stable, boundary)
