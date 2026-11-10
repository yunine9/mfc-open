"""Standalone task lifecycle use cases."""

import hashlib
import json
import re
from copy import deepcopy

from mae_flow_core.delivery.models import DeliveryEffect, DeliveryResult


def _result(effects=(), stdout=(), stderr=(), exit_code=0):
    return DeliveryResult(
        effects=tuple(effects),
        stdout=tuple(stdout),
        stderr=tuple(stderr),
        exit_code=exit_code,
    )


def _failure(message):
    return _result(stderr=(message,), exit_code=2)


def standalone_scope_fingerprint(action):
    """Identify the exact standalone scope presented for confirmation."""
    payload = {
        "kind": str((action or {}).get("kind", "") or ""),
        "files": list((action or {}).get("files", []) or []),
        "base_head": str((action or {}).get("base_head", "") or ""),
        "scope_proposed_epoch": float(
            (action or {}).get("scope_proposed_epoch", 0) or 0),
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_standalone_start(
        live_flow, current_action, kind, config,
        request, has_source, check_only):
    """Validate start arguments before adapters inspect files or write input."""
    if live_flow:
        return _failure(
            "当前有完整交付流程正在运行，不能叠加独立任务。"
            "若确定只做单项工作，先发送 `/mae-flow:mae-flow exit`，"
            "退出后重试。")
    if current_action:
        return _failure(
            "已有独立任务 %s(%s) 未收尾。它不会拦普通开发；"
            "继续用 action status，放弃用 action cancel。"
            % (
                current_action.get("id", "?"),
                current_action.get("kind", "?"),
            ))
    if kind == "ut":
        missing = [
            key for key in ("UT生成方式", "UT运行命令")
            if not config.get(key)
        ]
        if missing:
            return _failure(
                "独立 UT 缺少 %s。先从项目实际能力确认后，"
                "用 --generator/--ut-command 传入；禁止让 Agent 猜。"
                % "、".join(missing))
    if (
            kind == "codecheck"
            and not check_only
            and not config.get("编译方式")):
        return _failure(
            "独立 CodeCheck 修复模式缺少编译方式。"
            "用 --build 传入项目真实编译方式；"
            "如果只想看报告，使用 --check-only。")
    if kind == "grill" and not (request.strip() or has_source):
        return _failure(
            "独立质询必须提供 --request 用户需求原话"
            "或 --source 需求文本路径。")
    return _result()


def start_standalone(
        live_flow, current_action, kind, config, files, request,
        check_only, action_id, created_at, expires_epoch, work_dir,
        base_head, sources, inferred_scope, scope_epoch,
        terminal_flow=False, scope_proposed_at=None):
    """Create one standalone action after adapters collect its facts."""
    validation = validate_standalone_start(
        live_flow, current_action, kind, config,
        request, bool(sources), check_only)
    if validation.exit_code:
        return validation

    action = {
        "version": 1,
        "id": action_id,
        "kind": kind,
        "status": (
            "awaiting_scope_confirmation"
            if kind in ("ut", "codecheck")
            else "active"
        ),
        "created_at": created_at,
        "expires_epoch": expires_epoch,
        "work_dir": work_dir,
        "request": request.strip(),
        "config": deepcopy(config),
        "check_only": bool(check_only),
        "base_head": base_head,
        "commit_policy": "forbid",
        "tokens": {},
        "rejections": {},
        "quality": {},
        "sources": list(sources),
        "files": list(files),
    }
    effects = []
    if terminal_flow:
        effects.append(DeliveryEffect("archive_terminal_flow", {}))
    effects.append(DeliveryEffect("save_action", action))
    if kind in ("ut", "codecheck"):
        action["scope_source"] = (
            "dirty-worktree" if inferred_scope else "explicit")
        action["scope_proposed_at"] = scope_proposed_at or created_at
        action["scope_proposed_epoch"] = scope_epoch
        action["scope_sha256"] = standalone_scope_fingerprint(action)
        effects[-1] = DeliveryEffect("save_action", action)
        effects.append(DeliveryEffect("show_scope", {
            "inferred": inferred_scope,
        }))
    else:
        effects.append(DeliveryEffect("setup_grill", {}))
    return _result(effects=effects)


def confirm_standalone_scope(
        action, confirmation_receipt, ack_verified, validated_files, now):
    """Confirm exactly the scope that was previously displayed."""
    validation = validate_scope_confirmation(action, ack_verified)
    if validation.exit_code:
        return validation
    if list(validated_files) != action.get("files", []):
        return _failure(
            "确认后的文件范围与展示内容不一致，已拒绝执行；"
            "取消后重新发起。")
    updated = deepcopy(action)
    updated["status"] = "active"
    updated["scope_confirmed_at"] = now
    updated["scope_confirmation_receipt"] = deepcopy(
        confirmation_receipt)
    next_effect = (
        DeliveryEffect("run_standalone_codecheck", {})
        if updated["kind"] == "codecheck"
        else DeliveryEffect("create_task_card", {"kind": "ut"})
    )
    return _result(effects=(
        DeliveryEffect("save_action", updated),
        next_effect,
    ))


def validate_scope_confirmation(action, ack_verified):
    """Validate confirmation before adapters re-read the frozen files."""
    if not action or action.get("kind") not in ("ut", "codecheck"):
        return _failure(
            "当前没有等待范围确认的独立 UT/CodeCheck 任务。")
    if action.get("status") != "awaiting_scope_confirmation":
        return _failure(
            "当前独立任务已经确认过范围，不能重复确认或改写范围。")
    ok, why = ack_verified
    if not ok:
        return _failure("独立任务范围确认验真失败：" + why)
    return _result()


def finish_standalone(
        action, report_path, report_exists, report_text, report_error):
    """Validate terminal evidence and request a recoverable archive."""
    if not action:
        return _failure("当前没有独立任务。")
    kind = action.get("kind")
    if kind == "grill":
        return _finish_grill(
            action, report_path, report_exists,
            report_text, report_error)
    label = str(kind or "").upper()
    token = (action.get("tokens") or {}).get(label, {})
    if not token:
        rejection = (action.get("rejections") or {}).get(label, {})
        detail = rejection.get(
            "reason", "尚未收到专项 Agent 的合法收尾")
        return _failure(
            detail
            + "。继续修正 Agent 报告，或执行 action cancel "
            "结束独立任务；无论哪种情况都不会拦普通开发。")
    status = token.get("status", "")
    report = token.get("report_path", "")
    output = [
        "[mae-flow] 独立 %s 已结束，结果：%s"
        % (label, status or "?"),
    ]
    effects = (DeliveryEffect("archive_action", {
        "outcome": "completed",
        "note": "%s/%s" % (label, status),
        "report": report,
    }),)
    if status not in ("PASS", "CLEAN", "CLEAR"):
        warning = (
            "⚠ 结果包含失败、待确认或遗留项；已如实保留，"
            "但不会自动豁免，也不会卡住普通开发。")
    else:
        warning = ""
    output.extend((
        "report_after_archive",
        warning,
        "本任务没有自动提交或推送代码。",
    ))
    return _result(effects=effects, stdout=tuple(
        line for line in output if line))


def _finish_grill(
        action, report_path, report_exists, report_text, report_error):
    if not report_exists:
        return _failure(
            "独立质询结果文档不存在；"
            "用 --report 指定最终澄清文档。")
    if report_error:
        return _failure("独立质询结果不可读：" + report_error)
    if re.search(r"\{\{[^}]+\}\}|待确认|TODO|TBD", report_text, re.I):
        return _failure(
            "澄清文档仍有待确认项，不能宣称质询完成。"
            "继续追问或把未决项明确列为用户决定暂缓。")
    grill = action.get("grill", {}) or {}
    if not grill.get("prep_critic_done"):
        return _failure(
            "备课后的第一轮对抗检查(prep critic)没有执行过——"
            "双查是独立质询的质量承诺,不能只做收尾那次。"
            "先 action critic --stage prep --document <备课文件>,"
            "补齐它找出的缺口后再收尾。")
    token = (action.get("tokens") or {}).get("GRILL", {})
    task = (action.get("agent_tasks") or {}).get("GRILL", {})
    if not token or task.get("stage") != "final":
        return _failure(
            "收尾前还没有执行 final 对抗检查。"
            "先 action critic --stage final --document <澄清文档>；"
            "它只找遗漏，不会阻塞普通开发。")
    output = [
        "[mae-flow] 独立需求质询已完成：" + report_path,
    ]
    if token.get("status") == "GAPS":
        output.append("grill_gaps_after_archive")
    output.append(
        "没有启动完整交付流程，也没有自动进入设计或编码。")
    return _result(
        effects=(DeliveryEffect("archive_action", {
            "outcome": "completed",
            "note": "独立需求质询完成",
            "report": report_path,
            "grill_report": token.get("report_path", ""),
        }),),
        stdout=output,
    )


def cancel_standalone(action, error):
    """Return cancellation effects without deleting source or reports."""
    if error:
        return _result(effects=(
            DeliveryEffect("archive_corrupt_action", {
                "error": error,
            }),
        ))
    if not action:
        return _result(stdout=(
            "[mae-flow] 当前没有独立任务，无需取消。",
        ))
    return _result(effects=(
        DeliveryEffect("archive_action", {
            "outcome": "cancelled",
            "note": "用户取消独立任务",
        }),
    ))


def inspect_standalone(action):
    """Render standalone state without changing it."""
    if not action:
        return _result(stdout=(
            "[mae-flow] 当前没有独立任务；普通开发完全不受 mae-flow 接管。",
        ))
    return _result(stdout=tuple(
        json.dumps(action, ensure_ascii=False, indent=2).splitlines()))


def prepare_standalone_critic(action, document, exists, stage):
    """Bind a Grill critic task to an existing document."""
    if not action or action.get("kind") != "grill":
        return _failure("当前没有独立 Grill 任务。")
    if not exists:
        return _failure("质询检查材料不存在：" + (document or "(空)"))
    updated = deepcopy(action)
    grill = updated.setdefault("grill", {})
    grill["last_critic_document"] = document
    grill["last_critic_stage"] = stage
    if stage == "prep":
        grill["prep_critic_done"] = True
    if document not in updated.setdefault("sources", []):
        updated["sources"].append(document)
    return _result(effects=(DeliveryEffect("create_critic_task_card", {
        "action": updated,
        "stage": stage,
    }),))
