"""Read-only execution plan projection for the current Mae-Flow step.

The state machine owns what must be true.  A Playbook supplies the standard
method; an optional task-pinned structural profile supplies one final method.
Neither representation can advance state or weaken evidence and permissions.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os

from .authority import PROMPT_ONLY_EVIDENCE
from .workflow_profile import (
    WORKFLOW_PROFILE_SCHEMA,
    has_final_plan,
    load_workflow_profile,
    render_workflow_supplements,
    structural_selection,
    workflow_profile_errors,
)


SCHEMA = "mae-flow-execution-plan/1"
CATALOG_SCHEMA = "mae-flow-playbook-catalog/1"
_PLUGIN_ROOT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", ".."))
CATALOG_PATH = os.path.join(_PLUGIN_ROOT, "flow", "playbooks.json")

_EVIDENCE_LABELS = {
    "agent_ran": "指定 Agent 已真实执行",
    "branch_ok": "任务分支已经创建并验证",
    "content_free": "产物没有未完成占位或待裁决项",
    "glob": "必需产物已经生成",
    "local_spec_valid": "本单 Spec 已通过结构校验",
    "pipeline": "权威流水线结果已核销",
}
_USE_LABELS = {
    "available": "可用时按需读取",
    "when_needed": "需要时使用",
    "on_stage_enter": "进入阶段时使用",
    "before_item": "指定动作前使用",
}
_RESOURCE_USAGE_LABELS = {
    "required": "必用",
    "when_needed": "按情况",
    "on_demand": "按需读取",
}


def load_catalog(path=CATALOG_PATH):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def _structural_marker(item):
    if item.get("locked"):
        return "平台下限"
    if item.get("source") == "platform":
        return "标准方案"
    return "工作流定制"


def _use_text(item):
    use = item.get("use") or {}
    result = _USE_LABELS.get(use.get("mode"), "")
    if use.get("mode") == "before_item" and use.get("anchor"):
        result += "（%s 之前）" % use["anchor"]
    return result


def _resolved_asset_text(item):
    asset = item.get("resolved_asset") or {}
    if not asset:
        return ""
    if asset.get("state") != "available":
        return "固定资产不可用（已由最终方案降级记录说明）"
    path = str(asset.get("snapshot_path") or "").strip()
    if path:
        return "正文按需读取：%s" % path
    if asset.get("registry") in ("team_skill", "repository_skill"):
        return "固定 Skill：%s@%s（从任务 Skill 索引读取）" % (
            asset.get("id"), asset.get("version"))
    return ""


def _render_structural_items(plan):
    lines = []
    for item in plan.get("workflow_items") or ():
        detail = "；".join(value for value in (
            str(item.get("description") or "").strip(),
            str(item.get("instructions") or "").strip(),
            _use_text(item),
            _resolved_asset_text(item),
        ) if value)
        lines.append("- [%s] %s%s" % (
            _structural_marker(item), item["title"],
            "：" + detail if detail else ""))
    return lines


def _render_legacy_activities(plan):
    return ["- [%s] %s：%s" % (
        "定制新增" if item.get("source") == "customized" else "平台必做",
        item["title"], item["description"])
        for item in plan.get("activities") or ()]


def _render_supplement_layers(plan):
    """v2 supplements(plan 里仍叫 layers)的方案内提示——细节在
    current 的"已固定的执行补充"专区,这里只点名生效事实。"""
    layers = plan.get("customization", {}).get("layers") or ()
    if not layers:
        return []
    return ["已叠加的执行补充（建议层，低于平台兜底）：" + "、".join(
        str(item.get("title") or "补充") for item in layers)]


def _render_resource(item):
    detail = _resolved_asset_text(item)
    return "- [%s%s] %s%s" % (
        _RESOURCE_USAGE_LABELS.get(item.get("usage"), "按情况"),
        " · 定制优先" if item.get("preferred") else "", item["name"],
        "：" + detail if detail else "")


def _render_resources(plan):
    resources = plan.get("resources") or ()
    if not resources:
        return []
    return ["能力索引（列出不等于把正文注入上下文）："] + [
        _render_resource(item) for item in resources]


def _render_diagnostics(plan):
    records = plan.get("customization", {}).get("diagnostics") or ()
    if not records:
        return []
    return ["定制降级（其余有效项继续执行）："] + [
        "- %s%s" % (item.get("message") or "未知定制问题",
                     "；" + item["fallback"] if item.get("fallback") else "")
        for item in records]


def render_agent_execution_plan(plan):
    """Render the visible final plan as compact non-gating Agent guidance."""
    structural = bool(plan.get("workflow_items"))
    strategy = plan["strategy"]
    lines = [
        "──── %s（%s） ────" % (
            "本任务已固定的最终执行方案" if structural
            else "平台默认执行方案", plan["plan_id"]),
        "%s：%s" % (strategy["title"], strategy["summary"]),
        "本阶段最终顺序：" if structural else "本阶段动作：",
    ]
    lines.extend(_render_structural_items(plan) if structural
                 else _render_legacy_activities(plan))
    lines.extend(_render_supplement_layers(plan))
    lines.extend(_render_resources(plan))
    lines.extend(_render_diagnostics(plan))
    outputs = plan.get("contract", {}).get("outputs") or ()
    if outputs:
        lines.append("完成时应得到：" + "、".join(outputs))
    lines.append("平台兜底：" + "、".join(
        plan.get("customization", {}).get("locked") or ()))
    return "\n".join(lines)


def _identity_errors(item, identities):
    identity = (item.get("id"), item.get("version"))
    errors = []
    if not all(isinstance(value, str) and value.strip() for value in identity):
        errors.append("playbook id and version are required")
    elif identity in identities:
        errors.append("duplicate playbook: %s@%s" % identity)
    identities.add(identity)
    return errors


def _metadata_errors(item):
    identity = item.get("id") or "?"
    errors = []
    if not str(item.get("title", "")).strip():
        errors.append("playbook %s has no title" % identity)
    if not str(item.get("summary", "")).strip():
        errors.append("playbook %s has no summary" % identity)
    return errors


def _step_binding_errors(item, known_steps, bound):
    errors = []
    identity = item.get("id") or "?"
    for step in item.get("steps") or ():
        if step not in known_steps:
            errors.append("playbook %s binds unknown step %s" % (identity, step))
        elif step in bound:
            errors.append("step %s is bound by both %s and %s" % (
                step, bound[step], identity))
        else:
            bound[step] = identity
    return errors


def _named_item_errors(item, field, name_key):
    identity = item.get("id") or "?"
    errors = []
    seen = set()
    for value in item.get(field) or ():
        valid = (isinstance(value, dict) and
                 str(value.get(name_key, "")).strip() and
                 str(value.get("id", "")).strip())
        if not valid:
            errors.append("playbook %s has an invalid %s" %
                          (identity, field[:-1]))
            continue
        value_id = str(value["id"])
        if value_id in seen:
            errors.append("playbook %s has duplicate %s id %s" %
                          (identity, field[:-1], value_id))
        seen.add(value_id)
    return errors


def _catalog_entry_errors(item, known_steps, bound, identities):
    if not isinstance(item, dict):
        return ["playbook entry must be an object"]
    return (_identity_errors(item, identities) + _metadata_errors(item) +
            _step_binding_errors(item, known_steps, bound) +
            _named_item_errors(item, "activities", "title") +
            _named_item_errors(item, "resources", "name"))


def catalog_errors(flow, catalog):
    """Return stable errors instead of partially explaining a catalog."""
    errors = ([] if catalog.get("schema") == CATALOG_SCHEMA else
              ["playbook catalog schema must be %s" % CATALOG_SCHEMA])
    playbooks = catalog.get("playbooks")
    if not isinstance(playbooks, list) or not playbooks:
        return errors + ["playbook catalog must contain playbooks"]
    known_steps = set((flow.get("steps") or {}).keys())
    bound = {}
    identities = set()
    errors.extend(error for item in playbooks for error in
                  _catalog_entry_errors(item, known_steps, bound, identities))
    missing = sorted(known_steps - set(bound))
    if missing:
        errors.append("steps without a default playbook: " + ", ".join(missing))
    return errors


def _playbook_for(catalog, step_id):
    return next((item for item in catalog.get("playbooks") or ()
                 if step_id in (item.get("steps") or ())), None)


def _evidence_contract(step):
    contract = []
    seen = set()
    for evidence in step.get("evidence") or ():
        kind = str(evidence.get("type") or "unknown")
        if kind in PROMPT_ONLY_EVIDENCE:
            continue
        label = _EVIDENCE_LABELS.get(kind, "内核要求的 %s 证据" % kind)
        key = (kind, label)
        if key not in seen:
            seen.add(key)
            contract.append({"type": kind, "label": label})
    return contract


def _selection_reason(state, playbook):
    workflow = str(((state.get("choices") or {}).get("workflow")) or "")
    reason = "当前处于%s阶段，采用平台为该阶段验证过的默认做法。" % (
        playbook.get("phase") or "当前")
    return reason + ("本单交付方式为 %s。" % workflow if workflow else "")


def _validated_selection(flow, state, catalog, workflow_profile):
    errors = catalog_errors(flow, catalog)
    if workflow_profile:
        errors.extend(workflow_profile_errors(workflow_profile))
    if errors:
        raise ValueError("; ".join(errors))
    step_id = str(state.get("current") or "")
    step = (flow.get("steps") or {}).get(step_id)
    if step is None:
        raise ValueError("current step is not present in flow: " + step_id)
    playbook = _playbook_for(catalog, step_id)
    if playbook is None:
        raise ValueError("current step has no default playbook: " + step_id)
    return step_id, step, playbook


def _platform_selection(playbook):
    """平台默认方案:只列必做动作。v1 的"有界勾选可选动作/偏好资源"
    已随 v1 整体退役——想改结构走 v2 结构化定制。"""
    selected = copy.deepcopy(playbook)
    selected.pop("steps", None)
    selected["activities"] = [
        {**item, "source": "platform_default"}
        for item in selected.get("activities") or () if item.get("required")]
    selected["resources"] = list(selected.get("resources") or ())
    return selected


def _selected_playbook(playbook, workflow_profile=None):
    return (structural_selection(playbook, workflow_profile)
            if has_final_plan(workflow_profile)
            else _platform_selection(playbook))


def _plan_revision(selected, step_id, step, workflow_profile=None):
    source = json.dumps({
        "playbook": selected, "step": step_id, "contract": step,
        "workflow_profile_revision": (workflow_profile or {}).get("revision"),
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def _plan_outputs(selected, step):
    outputs = list(selected.pop("outputs", ()))
    artifacts = list((step.get("approval_subject") or {}).get("artifacts") or ())
    outputs.extend(item for item in artifacts if item not in outputs)
    return outputs


def _effective_source(workflow_profile, supplements):
    if has_final_plan(workflow_profile):
        return "compiled_final_plan"
    return "platform_default+overrides" if supplements else "platform_default"


def _customization(defaults, workflow_profile=None):
    # plan 契约里的 layers 字段沿用旧名,内容来自 v2 supplements——
    # 消费端(cloud/前端/CLI 渲染)零改动。
    supplements = copy.deepcopy(
        (workflow_profile or {}).get("supplements") or [])
    structural = has_final_plan(workflow_profile)
    source = (workflow_profile or {}).get("source") or {}
    return {
        "mode": "structural" if structural else "bounded",
        "customizable": list(defaults.get("customizable") or ()),
        "locked": list(defaults.get("locked") or ()),
        "effective_source": _effective_source(workflow_profile, supplements),
        "layers": supplements,
        "workflow_source": copy.deepcopy(source) if structural else None,
        "diagnostics": copy.deepcopy(
            (workflow_profile or {}).get("diagnostics") or []),
    }


def _strategy_source(workflow_profile):
    if not has_final_plan(workflow_profile):
        return "platform_default"
    return str((workflow_profile.get("source") or {}).get("kind") or "workflow")


def _supplements_only(workflow_profile):
    """结构化部分退化时保留文字补充:失配只关结构,建议层照常生效。"""
    if not (workflow_profile or {}).get("supplements"):
        return None
    return {key: copy.deepcopy(value)
            for key, value in workflow_profile.items()
            if key in ("schema", "source", "supplements", "revision")}


def build_execution_plan(flow, state, catalog=None, workflow_profile=None):
    """Build one immutable, JSON-safe explanation for the current state."""
    catalog = catalog or load_catalog()
    step_id, step, playbook = _validated_selection(
        flow, state, catalog, workflow_profile)
    degrade = None
    try:
        selected = _selected_playbook(playbook, workflow_profile)
    except ValueError as exc:
        # 定格方案缺当前 playbook 对应的 stage(cloud 编译器写 id、
        # 内核消费,跨仓 id 失配等):fail-open 退回平台默认做法,但
        # 必须留下 diagnostics——静默退化正是"界面显示定格方案、
        # Agent 实际跑默认"的事故源(2026-08-30 审计 P0)。
        degrade = {
            "code": "profile_invalid",
            "severity": "warning",
            "message": "定格工作流缺少本阶段方案(%s);该阶段已退回"
                       "平台默认做法" % exc,
            "stage_id": str(playbook.get("id") or ""),
        }
        workflow_profile = _supplements_only(workflow_profile)
        selected = _selected_playbook(playbook, workflow_profile)
    outputs = _plan_outputs(selected, step)
    defaults = catalog.get("defaults") or {}
    plan = {
        "schema": SCHEMA,
        "plan_id": "%s@%s" % (selected["id"], selected["version"]),
        "plan_revision": _plan_revision(
            selected, step_id, step, workflow_profile),
        "step": {"id": step_id, "title": str(step.get("title") or step_id),
                 "phase": selected.get("phase") or "",
                 "state_revision": state.get("revision")},
        "strategy": {"id": selected["id"], "version": selected["version"],
                     "title": selected["title"], "summary": selected["summary"],
                     "source": _strategy_source(workflow_profile),
                     "selection_reason": _selection_reason(state, selected)},
        "contract": {"human_decision": bool(
            step.get("user_ack") or step.get("approval_subject")),
            "evidence": _evidence_contract(step), "outputs": outputs},
        "activities": selected.get("activities") or [],
        "resources": selected.get("resources") or [],
        "workflow_items": selected.get("workflow_items") or [],
        "knowledge": {"loading": defaults.get(
            "knowledge_loading", "indexed_on_demand"),
            "explanation": "选中的知识和 Skill 先提供轻量索引，Agent 按任务需要读取正文；选中不等于全文注入。"},
        "customization": _customization(defaults, workflow_profile),
    }
    if degrade is not None:
        # 退化后 workflow_profile 已置 None,mode/effective_source/
        # strategy.source 全按平台默认如实计算;唯一的定制痕迹就是
        # 这条 diagnostics——它是宿主上浮告警的锚点,不许省。
        plan["customization"]["diagnostics"].append(degrade)
    return plan
