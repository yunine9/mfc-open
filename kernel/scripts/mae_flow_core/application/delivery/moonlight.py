"""Moonlight delivery state transitions."""

from copy import deepcopy

from mae_flow_core.delivery.models import DeliveryEffect, DeliveryResult
from mae_flow_core.delivery.moonlight import (
    block_notice, finalize_target, issue_id, repeat_count,
    step_block_count)


def _result(effects=(), stdout=(), stderr=(), exit_code=0):
    return DeliveryResult(
        effects=tuple(effects),
        stdout=tuple(stdout),
        stderr=tuple(stderr),
        exit_code=exit_code,
    )


def _failure(message):
    return _result(stderr=(message,), exit_code=2)


def _state_effect(state):
    return DeliveryEffect("set_state", state)


def _effects(state, *extra):
    return (
        _state_effect(state),
        DeliveryEffect("write_report", {}),
        *extra,
    )


def _moonlight(state):
    return state.setdefault("moonlight", {})


def _unresolved(state):
    return [
        issue for issue in (_moonlight(state).get("issues") or [])
        if not issue.get("resolved_at")
    ]


def _history(state, step, result, note, now):
    state.setdefault("history", []).append({
        "step": step,
        "result": result,
        "note": note,
        "at": now,
    })


def activate_moonlight(
        state, ack, request, activated_at, history_at,
        head, active_change_exists):
    """Enable unattended delivery and defer unsafe archive work."""
    updated = deepcopy(state)
    moonlight = _moonlight(updated)
    if not moonlight.get("enabled"):
        updated.pop("config_review", None)
        moonlight.update({
            "enabled": True,
            "activated_at": activated_at,
            "ack": ack,
            "request": (request or "")[:4000],
            "cycle": max(
                1, int(moonlight.get("cycle", 0) or 0) + 1),
        })
        _history(
            updated,
            updated.get("current", ""),
            "moonlight:on",
            "用户授权无人值守、尽力修复并推送",
            history_at,
        )
    current = updated.get("current")
    if current == "archive_confirm":
        _history(
            updated,
            "archive_confirm",
            "moonlight:archive-deferred",
            "中途切换月光宝盒，规格定稿留到早晨",
            history_at,
        )
        updated["current"] = "push"
        updated.setdefault("step_heads", {})["push"] = head
    elif current == "archive":
        if active_change_exists:
            _history(
                updated,
                "archive",
                "moonlight:archive-deferred",
                "定稿尚未执行，夜间先推送",
                history_at,
            )
            updated["current"] = "push"
            updated.setdefault("step_heads", {})["push"] = head
        else:
            issues = moonlight.setdefault("issues", [])
            reason = (
                "切换月光宝盒时规格定稿可能已经开始，"
                "活跃 change 已不存在或无法定位；不可自动回滚、"
                "补做或假定完成，需要早晨核对定稿现场。")
            issue = {
                "id": issue_id(len(issues)),
                "step": "archive",
                "kind": "blocker",
                "at": history_at,
                "head": head,
                "reason": reason,
            }
            issues.append(issue)
            moonlight["hard_blocked"] = {
                "at": history_at,
                "step": "archive",
                "head": head,
                "issue": issue["id"],
                "reason": reason,
            }
            _history(
                updated,
                "archive",
                "moonlight:blocked",
                issue["id"] + " " + reason,
                history_at,
            )
    return _result(
        effects=_effects(
            updated, DeliveryEffect("print_current", {})),
        stdout=(
            "[mae-flow] 🌙 月光宝盒已开启。后续不再询问用户；"
            "质量问题尽力修复后可登记遗留继续，"
            "目标是推送分支并停在晨间检查。",
        ),
    )


def disable_moonlight(state, ack, ack_verified, now):
    """Restore interactive mode only with a captured user authorization."""
    if not bool(((state or {}).get("moonlight") or {}).get("enabled")):
        return _result(
            effects=(DeliveryEffect("print_current", {}),),
            stdout=(
                "[mae-flow] 月光宝盒已关闭，当前断点保留；"
                "后续恢复普通确认和严格门禁。",
            ),
        )
    if not ack:
        return _failure(
            '关闭月光宝盒需要 --ack "用户要求关闭/恢复交互的原话"。'
            "无人值守运行中不允许 Agent 自行关闭;"
            "质量问题走 moonlight defer,客观阻塞走 moonlight blocked。")
    ok, why = ack_verified
    if not ok:
        return _failure("月光宝盒关闭授权验真失败:" + why)
    updated = deepcopy(state)
    moonlight = _moonlight(updated)
    moonlight["enabled"] = False
    moonlight["disabled_at"] = now
    _history(
        updated,
        updated.get("current", ""),
        "moonlight:off",
        "恢复普通交互模式",
        now,
    )
    return _result(
        effects=_effects(
            updated, DeliveryEffect("print_current", {})),
        stdout=(
            "[mae-flow] 月光宝盒已关闭，当前断点保留；"
            "后续恢复普通确认和严格门禁。",
        ),
    )


def record_blocker(
        state, can_block, reason, head, dirty_paths, now,
        step_kind=""):
    """Record an objective blocker and keep the current safe stop."""
    validation = validate_blocker(
        state, can_block, reason, step_kind)
    if validation.exit_code:
        return validation
    current = (state or {}).get("current", "")
    reason = (reason or "").strip()
    updated = deepcopy(state)
    moonlight = _moonlight(updated)
    issues = moonlight.setdefault("issues", [])
    for old in _unresolved(updated):
        if old.get("kind") == "blocker":
            old["resolved_at"] = now
            old["resolved_as"] = "superseded"
    repeats = repeat_count(issues, current, reason)
    at_step = step_block_count(issues, current)
    issue = {
        "id": issue_id(len(issues)),
        "step": current,
        "kind": "blocker",
        "at": now,
        "head": head,
        "reason": reason,
        "repeats": repeats,
        "dirty_paths": list(dirty_paths)[:100],
    }
    issues.append(issue)
    moonlight["hard_blocked"] = {
        "at": now,
        "step": current,
        "head": head,
        "issue": issue["id"],
        "reason": reason,
    }
    _history(
        updated, current, "moonlight:blocked",
        issue["id"] + " " + reason, now)
    return _result(effects=_effects(updated),
                   stdout=(block_notice(repeats, at_step),))


def validate_blocker(state, can_block, reason, step_kind=""):
    current = (state or {}).get("current", "")
    if not can_block:
        remedy = (
            "moonlight defer"
            if step_kind
            else "moonlight push-failed"
            if current == "push"
            else "当前已经处于安全停点"
        )
        return _failure(
            "当前步骤 %s 不能使用 blocked；请使用 %s。"
            % (current, remedy))
    reason = (reason or "").strip()
    if len(reason) < 12:
        return _failure(
            "moonlight blocked 必须写清缺失条件、"
            "已经尝试的确认以及无法继续的原因。")
    return _result()


def record_push_failure(state, reason, head, now):
    """Record a failed push without claiming remote success."""
    validation = validate_push_failure(state, reason)
    if validation.exit_code:
        return validation
    reason = (reason or "").strip()
    updated = deepcopy(state)
    issues = _moonlight(updated).setdefault("issues", [])
    issue = {
        "id": issue_id(len(issues)),
        "step": "push",
        "kind": "push",
        "at": now,
        "head": head,
        "reason": reason,
    }
    issues.append(issue)
    _history(
        updated, "push", "moonlight:push-failed",
        issue["id"] + " " + reason, now)
    return _result(
        effects=_effects(updated),
        stdout=(
            "[mae-flow] push 失败已写入月光宝盒报告。"
            "保持在 push，不伪造远端成功；早晨处理认证/网络/冲突后"
            "重新 push，再执行 done。",
        ),
    )


def validate_push_failure(state, reason):
    if (state or {}).get("current") != "push":
        return _failure(
            "moonlight push-failed 只允许在 push 步骤使用。")
    reason = (reason or "").strip()
    if len(reason) < 12:
        return _failure(
            "push-failed 必须记录错误原文和已经尝试的处理。")
    return _result()


def record_deferred_quality(
        state, kind, reason, rejection, head, now):
    """Record one superseding quality issue before normal advancement."""
    validation = validate_deferred_quality(state, kind, reason)
    if validation.exit_code:
        return validation
    current = (state or {}).get("current", "")
    reason = (reason or "").strip()
    updated = deepcopy(state)
    issues = _moonlight(updated).setdefault("issues", [])
    new_id = issue_id(len(issues))
    for old in _unresolved(updated):
        if old.get("kind") == kind:
            old["resolved_at"] = now
            old["resolved_as"] = "superseded"
            old["superseded_by"] = new_id
    issue = {
        "id": new_id,
        "step": current,
        "kind": kind,
        "at": now,
        "head": head,
        "reason": reason,
        "rejection": rejection,
    }
    issues.append(issue)
    _history(
        updated, current, "moonlight:defer",
        new_id + " " + reason, now)
    return _result(effects=_effects(
        updated,
        DeliveryEffect("advance_deferred", {
            "step": current,
            "issue_id": new_id,
        }),
    ))


def validate_deferred_quality(state, kind, reason):
    current = (state or {}).get("current", "")
    if not kind:
        return _failure(
            "当前步骤 %s 不是可带遗留推进的质量步骤。"
            "分析、实现和推送本身不能伪装完成。" % current)
    if len((reason or "").strip()) < 12:
        return _failure(
            "moonlight defer 的 --reason 必须写清遗留现象、"
            "已尝试处理和风险，不能只写“失败/继续”。")
    return _result()


def repair_moonlight(state, repair_target, head, now):
    """Start a morning retry from a blocker or report."""
    updated = deepcopy(state)
    moonlight = _moonlight(updated)
    if moonlight.get("hard_blocked"):
        blocker = moonlight.pop("hard_blocked")
        for issue in _unresolved(updated):
            if issue.get("kind") == "blocker":
                issue["resolved_at"] = now
                issue["resolved_as"] = "morning-retry"
        moonlight["cycle"] = int(moonlight.get("cycle", 1)) + 1
        _history(
            updated,
            updated.get("current", ""),
            "moonlight:repair-blocker",
            str(blocker.get("issue", "")),
            now,
        )
        return _result(
            effects=_effects(
                updated, DeliveryEffect("print_current", {})),
            stdout=(
                "[mae-flow] 已解除夜间硬阻塞标记，开始第 %d 轮，"
                "从原步骤 %s 继续；旧质量证据仍按代码版本校验。"
                % (
                    moonlight["cycle"],
                    updated.get("current", ""),
                ),
            ),
        )
    if updated.get("current") != "moonlight_review":
        return _failure(
            "只有夜间推送完成、停在 moonlight_review 后"
            "才能按报告开启修复轮。当前仍在执行中，请先继续到 push。")
    issues = _unresolved(updated)
    if not issues:
        return _result(stdout=(
            "[mae-flow] 报告中没有尚未解决的问题，无需开启修复轮；"
            "可直接 moonlight finalize。",
        ))
    if not repair_target:
        workflow = (updated.get("choices") or {}).get("workflow", "")
        return _failure(
            "无法根据工作流选择修复入口，当前 workflow="
            + (workflow or "未设置"))
    moonlight["cycle"] = int(moonlight.get("cycle", 1)) + 1
    moonlight["repair_started_at"] = now
    for issue in issues:
        issue["repair_cycle"] = moonlight["cycle"]
    _history(
        updated,
        "moonlight_review",
        "moonlight:repair",
        "、".join(issue.get("id", "?") for issue in issues),
        now,
    )
    updated["current"] = repair_target
    updated.setdefault("step_heads", {})[repair_target] = head
    # delivery_manifest 必须一并清:上一轮 confirmed 清单若留着,第二轮
    # build 里 git add 新修文件会撞"只能包含确认清单中的精确文件",
    # 而唯一出路 manifest set 被旧清单的存在遮蔽(排查实锤的跨轮死角)。
    # 新一轮增量到 delivery_review 时重新 set + confirm。
    for key in ("unlock", "risk_acceptances", "agent_tasks", "quality",
                "delivery_manifest"):
        updated.pop(key, None)
    return _result(
        effects=_effects(
            updated, DeliveryEffect("print_current", {})),
        stdout=(
            "[mae-flow] 已根据报告开启第 %d 轮修复，从 %s 重新进入。"
            "先处理报告遗留，再完整重跑后续质量链并推送。"
            % (moonlight["cycle"], repair_target),
        ),
    )


def finalize_moonlight(state, ack, ack_verified, head, now):
    """Close morning review and restore the normal delivery path."""
    validation = validate_finalize(state, ack, ack_verified)
    if validation.exit_code:
        return validation
    issues = _unresolved(state)
    updated = deepcopy(state)
    moonlight = _moonlight(updated)
    moonlight["enabled"] = False
    moonlight["finalized_at"] = now
    target = finalize_target(updated)
    _history(
        updated,
        "moonlight_review",
        "moonlight:finalize",
        "带遗留确认" if issues else "晨间检查完成",
        now,
    )
    updated["current"] = target
    updated.setdefault("step_heads", {})[target] = head
    message = (
        "评审意见处理已完成。"
        if target == "end"
        else "已恢复普通模式并进入规格定稿；定稿提交后还要再次 push。"
    )
    return _result(
        effects=_effects(
            updated, DeliveryEffect("print_current", {})),
        stdout=("[mae-flow] 月光宝盒晨间检查已结束。" + message,),
    )


def validate_finalize(state, ack, ack_verified):
    step_validation = validate_finalize_step(state)
    if step_validation.exit_code:
        return step_validation
    issues = _unresolved(state)
    if issues:
        if not ack:
            return _failure(
                "报告仍有遗留。建议先 moonlight repair；"
                "若用户决定带遗留结束，必须 --ack "
                "携带用户明确接受这些遗留的原话。")
        ok, why = ack_verified
        if not ok:
            return _failure("带遗留 finalize 授权验真失败:" + why)
    return _result()


def validate_finalize_step(state):
    if (state or {}).get("current") != "moonlight_review":
        return _failure(
            "只有推送完成并停在 moonlight_review 时才能 finalize。")
    return _result()
