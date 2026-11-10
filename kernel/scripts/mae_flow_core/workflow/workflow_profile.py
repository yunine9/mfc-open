"""Validation and projection of the task-pinned structural workflow plan."""

import copy
import hashlib
import json
import os


WORKFLOW_PROFILE_SCHEMA = "mae-flow-execution-profile/2"
WORKFLOW_PROFILE_PATH = os.path.join(
    ".mae-flow-work", "workflow-profile.json")
_ITEM_KINDS = {
    "activity", "knowledge", "skill", "agent", "tool", "instruction",
}
_ASSET_STATES = {"available", "unavailable", "incompatible"}
# v1 execution-profile 退役后(2026-08-29,趁无存量统一),文字建议层
# 以 supplements 并入本文件:任务补充说明/仓库约定/团队指引都走这里,
# 定制只剩一个文件、一条加载路、一处门禁。
_SUPPLEMENT_SCOPES = ("team", "business_module", "repository", "task")


def _workflow_profile_revision(profile):
    payload = {key: value for key, value in profile.items()
               if key not in ("schema", "revision")}
    source = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                        separators=(",", ":"))
    return "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()


def _identity_errors(item, label, keys):
    return ["%s has no %s" % (label, key) for key in keys
            if not isinstance(item.get(key), str) or not item.get(key).strip()]


def _item_errors(item, label):
    if not isinstance(item, dict):
        return ["%s item must be an object" % label]
    item_id = str(item.get("id") or "")
    errors = _identity_errors(item, "%s item %s" % (label, item_id),
                              ("id", "title"))
    if item.get("kind") not in _ITEM_KINDS:
        errors.append("%s item %s has invalid kind" % (label, item_id))
    if not isinstance(item.get("locked"), bool):
        errors.append("%s item %s has invalid locked" % (label, item_id))
    if not isinstance(item.get("editable"), bool):
        errors.append("%s item %s has invalid editable" % (label, item_id))
    return errors


def _items_errors(items, label):
    if not isinstance(items, list):
        return ["%s items must be a list" % label]
    errors = [] if len(items) <= 128 else ["%s has too many items" % label]
    errors.extend(error for item in items
                  for error in _item_errors(item, label))
    ids = [str(item.get("id") or "") for item in items
           if isinstance(item, dict)]
    if len(ids) != len(set(ids)):
        errors.append("%s has duplicate items" % label)
    return errors


def _stage_errors(stage, label):
    if not isinstance(stage, dict):
        return ["%s stage must be an object" % label]
    stage_id = str(stage.get("id") or "")
    stage_label = "%s stage %s" % (label, stage_id)
    errors = _identity_errors(stage, stage_label, ("id", "title", "phase"))
    if not isinstance(stage.get("steps"), list):
        errors.append("%s steps must be a list" % stage_label)
    if not isinstance(stage.get("slots"), list):
        errors.append("%s slots must be a list" % stage_label)
    errors.extend(_items_errors(stage.get("items"), stage_label))
    return errors


def _stages_errors(stages, label):
    if not isinstance(stages, list):
        return ["%s stages must be a list" % label]
    errors = [] if len(stages) <= 32 else ["%s has too many stages" % label]
    errors.extend(error for stage in stages
                  for error in _stage_errors(stage, label))
    ids = [str(stage.get("id") or "") for stage in stages
           if isinstance(stage, dict)]
    if len(ids) != len(set(ids)):
        errors.append("%s has duplicate stages" % label)
    return errors


def _snapshot_errors(snapshot, label):
    if not isinstance(snapshot, dict):
        return ["%s must be an object" % label]
    errors = _identity_errors(
        snapshot, label, ("standard_id", "standard_version", "catalog_digest"))
    errors.extend(_stages_errors(snapshot.get("stages"), label))
    return errors


def _item_map(stage):
    return {str(item.get("id") or ""): item
            for item in stage.get("items") or () if isinstance(item, dict)}


def _locked_item_errors(stage_id, base_items, final_items):
    errors = ["workflow final snapshot changed locked item %s/%s" %
              (stage_id, item_id)
              for item_id, item in base_items.items()
              if item.get("locked") and final_items.get(item_id) != item]
    errors.extend(
        "workflow final snapshot invented locked item %s/%s" %
        (stage_id, item_id)
        for item_id, item in final_items.items()
        if item.get("locked") and not base_items.get(item_id, {}).get("locked"))
    return errors


def _stage_floor_errors(stage, target):
    stage_id = str(stage.get("id") or "")
    errors = []
    if (stage.get("steps") != target.get("steps") or
            stage.get("phase") != target.get("phase")):
        errors.append("workflow final snapshot changed stage contract %s" %
                      stage_id)
    errors.extend(_locked_item_errors(
        stage_id, _item_map(stage), _item_map(target)))
    return errors


def _stage_map(snapshot):
    return {str(stage.get("id") or ""): stage
            for stage in snapshot.get("stages") or ()
            if isinstance(stage, dict)}


def _locked_floor_errors(base, final):
    base_stages = _stage_map(base)
    final_stages = _stage_map(final)
    errors = []
    if set(base_stages) != set(final_stages):
        errors.append("workflow final snapshot changed platform stages")
    errors.extend(error for stage_id, stage in base_stages.items()
                  for error in _stage_floor_errors(
                      stage, final_stages.get(stage_id) or {}))
    return errors


def _snapshot_identity_match_errors(base, final):
    return ["workflow final snapshot changed %s" % key
            for key in ("standard_id", "standard_version", "catalog_digest")
            if base.get(key) != final.get(key)]


def _profile_field_errors(profile, structural):
    errors = []
    if not isinstance(profile.get("source"), dict):
        errors.append("workflow profile has no source")
    for key, label in (
            ("edits", "edits"),
            ("asset_manifest", "asset manifest"),
            ("diagnostics", "diagnostics")):
        value = profile.get(key)
        # supplement-only 档没有结构化记账义务;字段一旦出现仍须成形。
        if value is None and not structural:
            continue
        if not isinstance(value, list):
            errors.append("workflow profile %s must be a list" % label)
    return errors


def _safe_snapshot_path(path):
    if not path or not isinstance(path, str) or os.path.isabs(path):
        return False
    normalized = os.path.normpath(path)
    return (normalized == ".mae-flow-work" or
            normalized.startswith(".mae-flow-work" + os.sep))


def _asset_manifest_errors(profile):
    errors = []
    for index, asset in enumerate(profile.get("asset_manifest") or ()):
        label = "workflow asset manifest item %s" % (index + 1)
        if not isinstance(asset, dict):
            errors.append("%s must be an object" % label)
            continue
        errors.extend(_identity_errors(
            asset, label, ("registry", "id", "version", "digest", "state")))
        if asset.get("state") not in _ASSET_STATES:
            errors.append("%s has invalid state" % label)
        path = asset.get("snapshot_path")
        if path is not None and not _safe_snapshot_path(path):
            errors.append("%s has unsafe snapshot path" % label)
    return errors


def _supplement_item_errors(item, label):
    if not isinstance(item, dict):
        return ["%s must be an object" % label]
    errors = _identity_errors(
        item, label, ("source_id", "title", "instructions"))
    scope = str(item.get("scope") or "")
    if scope not in _SUPPLEMENT_SCOPES:
        errors.append("%s has unknown scope %s" % (label, scope))
    if len(str(item.get("instructions") or "")) > 2000:
        errors.append("%s exceeds 2000 characters" % label)
    return errors


def _supplement_errors(profile):
    supplements = profile.get("supplements")
    if supplements is None:
        return []
    if not isinstance(supplements, list):
        return ["workflow profile supplements must be a list"]
    errors = [] if len(supplements) <= 12 else [
        "workflow profile has too many supplements"]
    for index, item in enumerate(supplements):
        errors.extend(_supplement_item_errors(
            item, "workflow supplement %s" % (index + 1)))
    order = [_SUPPLEMENT_SCOPES.index(str(item.get("scope")))
             for item in supplements
             if isinstance(item, dict)
             and str(item.get("scope") or "") in _SUPPLEMENT_SCOPES]
    if order != sorted(order):
        errors.append("workflow profile supplements are out of precedence order")
    return errors


def has_final_plan(profile):
    """结构化定格是否在场。补充建议(supplements)可以单独存在——
    supplement-only 的任务按平台默认方案执行,只叠文字建议。"""
    return bool((profile or {}).get("final_snapshot"))


def workflow_profile_errors(profile):
    if not isinstance(profile, dict):
        return ["workflow profile must be an object"]
    errors = ([] if profile.get("schema") == WORKFLOW_PROFILE_SCHEMA else
              ["workflow profile schema must be %s" % WORKFLOW_PROFILE_SCHEMA])
    base = profile.get("base_snapshot")
    final = profile.get("final_snapshot")
    # 结构化部分可整体缺席(supplement-only);一旦出现就必须完整成对。
    if base is not None or final is not None:
        errors.extend(_snapshot_errors(base, "workflow base snapshot"))
        errors.extend(_snapshot_errors(final, "workflow final snapshot"))
    elif not profile.get("supplements"):
        errors.append(
            "workflow profile must carry a final snapshot or supplements")
    if isinstance(base, dict) and isinstance(final, dict):
        errors.extend(_snapshot_identity_match_errors(base, final))
        errors.extend(_locked_floor_errors(base, final))
    errors.extend(_supplement_errors(profile))
    errors.extend(_profile_field_errors(
        profile, base is not None or final is not None))
    errors.extend(_asset_manifest_errors(profile))
    if profile.get("revision") != _workflow_profile_revision(profile):
        errors.append("workflow profile revision does not match its snapshot")
    return errors


def load_workflow_profile(root=None):
    """Load customization separately; invalid optional input fails visibly open."""
    path = os.path.join(root or os.getcwd(), WORKFLOW_PROFILE_PATH)
    if not os.path.exists(path):
        return None, ""
    try:
        with open(path, encoding="utf-8-sig") as stream:
            profile = json.load(stream)
        errors = workflow_profile_errors(profile)
        if errors:
            return None, ("⚠ 本任务工作流定制无效，已采用既有 Mae-Flow 方案：" +
                          "；".join(errors))
        return profile, ""
    except Exception as exc:
        return None, ("⚠ 本任务工作流定制无法读取，已采用既有 Mae-Flow 方案：%s" %
                      exc)


def render_workflow_supplements(profile):
    """Render layered text guidance for ``current`` and fallback sessions.

    v1 render_execution_profile 的直系后继:同一段边界声明原文保留——
    建议层永远低于阶段指令/真实证据/人工决定/权限,冲突部分无效。"""
    supplements = (profile or {}).get("supplements") or ()
    if not supplements:
        return ""
    lines = ["──── 已固定的执行补充（建议层） ────"]
    for item in supplements:
        lines.extend(("【%s】" % item["title"], item["instructions"]))
    lines.append(
        "边界：这些补充只调整关注点、执行顺序和协作方式；若与当前阶段指令、"
        "真实证据、人工决定或 Git/写入/交付权限冲突，冲突部分无效，"
        "继续按平台规则执行并明确说明。")
    return "\n".join(lines)


def workflow_stage(profile, playbook_id):
    stages = ((profile or {}).get("final_snapshot") or {}).get("stages") or ()
    return next((stage for stage in stages
                 if isinstance(stage, dict) and stage.get("id") == playbook_id),
                None)


def _resource_kind(kind):
    return {"instruction": "guidance", "knowledge": "knowledge",
            "skill": "skill", "agent": "agent", "tool": "tool"}.get(
                kind, "tool")


def _resource_usage(item):
    mode = (item.get("use") or {}).get("mode")
    return {"on_stage_enter": "required", "when_needed": "when_needed",
            "available": "on_demand", "before_item": "when_needed"}.get(
                mode, "when_needed")


def _activity(item):
    result = {
        "id": item["id"], "title": item["title"],
        "description": item.get("description") or item.get("instructions")
        or "按最终方案完成该项。",
        "required": bool(item.get("locked")),
        "locked": bool(item.get("locked")),
        "editable": bool(item.get("editable")),
        "source": ("platform_default" if item.get("source") == "platform"
                   else "customized"),
    }
    if item.get("instructions"):
        result["instructions"] = item["instructions"]
    return result


def _resource(item):
    result = {
        "id": item["id"], "kind": _resource_kind(item.get("kind")),
        "name": item["title"], "usage": _resource_usage(item),
        "locked": bool(item.get("locked")),
        "editable": bool(item.get("editable")),
        "source": item.get("source") or "workflow",
    }
    if item.get("instructions"):
        result["instructions"] = item["instructions"]
    if item.get("resolved_asset"):
        result["resolved_asset"] = copy.deepcopy(item["resolved_asset"])
    return result


def _asset_identity(asset):
    return tuple(asset.get(key) for key in (
        "registry", "id", "version", "digest", "business_module_id",
        "repository", "revision", "relative_path"))


def _attach_resolved_assets(items, workflow_profile):
    manifest = {_asset_identity(asset): asset
                for asset in workflow_profile.get("asset_manifest") or ()
                if isinstance(asset, dict)}
    for item in items:
        ref = item.get("asset_ref")
        if not isinstance(ref, dict):
            continue
        asset = manifest.get(_asset_identity(ref))
        if asset:
            item["resolved_asset"] = copy.deepcopy(asset)
    return items


def structural_selection(playbook, workflow_profile):
    selected = copy.deepcopy(playbook)
    selected.pop("steps", None)
    stage = workflow_stage(workflow_profile, selected.get("id"))
    if stage is None:
        raise ValueError("workflow final snapshot has no stage %s" %
                         selected.get("id"))
    items = _attach_resolved_assets(
        copy.deepcopy(stage.get("items") or []), workflow_profile)
    selected["workflow_items"] = items
    selected["activities"] = [_activity(item) for item in items
                              if item.get("kind") == "activity"]
    selected["resources"] = [_resource(item) for item in items
                             if item.get("kind") != "activity"]
    return selected
