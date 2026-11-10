"""Pure COMPILE Agent final-report contract."""

import re

from mae_flow_core import host_env
from mae_flow_core.quality.agent_contracts import (
    accept,
    build_summary_matches,
    embedded_build_command,
    reject,
    required_skill,
    same_config,
)
from mae_flow_core.quality.agent_reports import (
    empty_section,
    report_section,
)
from mae_flow_core.quality.tool_transcript import (
    bash_call,
    call_failed,
    skill_call,
)


def _line_field(report, name):
    match = re.search(
        r"^\s*" + re.escape(name) + r":\s*(.+?)\s*$",
        report,
        re.M,
    )
    return match.group(1).strip() if match else ""


def _successful_bash_evidence(calls, expected):
    call = bash_call(calls, expected)
    if not call:
        return None, (
            "transcript 中没有真实执行配置的编译命令；echo/文字提及不算执行。")
    if not call.result_seen:
        return None, (
            "最后一次编译命令缺少 tool_result，无法证明执行完成；"
            "请恢复完整 transcript，旧宿主无法提供时由用户走 accept-risk 裁决。")
    if call_failed(call):
        return None, "最后一次编译命令的工具结果明确失败，不能报告成功。"
    return call, ""


def _matching_receipt(context, build_config):
    receipt = context.reusable_receipts.get("COMPILE_RUN")
    if not receipt:
        return None
    task = context.task
    if (
            receipt.get("step") != task.get("step")
            or str(receipt.get("task_sha256") or "")
            != str(task.get("sha256") or "")
            or str(receipt.get("task_issuance_id") or "")
            != str(task.get("issuance_id") or "")
            or receipt.get("status") != context.status
            or not same_config(receipt.get("build", ""), build_config)):
        return None
    return receipt


def _execution_decision(context, build_config):
    need = required_skill(build_config)
    if need:
        call = skill_call(context.calls, need)
        if call:
            if context.status != "BLOCKED" and call_failed(call):
                return reject(
                    "%s Skill 的工具结果明确失败，不能报告编译成功。" % need)
            return accept(details={"reused_execution": False})
        if _matching_receipt(context, build_config):
            return accept(details={"reused_execution": True})
        return reject(
            "%s Skill,但 transcript 中没有对应 Skill 工具调用或可复用凭证。"
            % ("编译配置要求 " + need))
    expected = embedded_build_command(build_config) or build_config
    call = bash_call(context.calls, expected)
    if context.status == "BLOCKED":
        if call:
            return accept(details={"reused_execution": False})
        if _matching_receipt(context, build_config):
            return accept(details={"reused_execution": True})
        return reject(
            "标记 BLOCKED 但 transcript 中没有配置编译命令的真实调用或"
            "可复用凭证——弃权也必须先真实尝试过编译。")
    if not call and _matching_receipt(context, build_config):
        return accept(details={"reused_execution": True})
    _call, reason = _successful_bash_evidence(context.calls, expected)
    return (
        reject(reason)
        if reason else accept(details={"reused_execution": False})
    )


def evaluate_compile_contract(context):
    """Return the existing COMPILE decision without performing I/O."""
    if context.status == "FAIL":
        return accept()
    build_config = context.config.get("编译方式", "")
    if not host_env.build_runs_locally():
        # 云端形态:本地不编译,机器把关移交交付点的权威流水线(绑 SHA)。
        # 只放开"本地执行证据"这一项——净删行守卫留在下面照旧生效,
        # 删代码换通过在哪种形态下都是作弊。
        details = {"deferred_to_pipeline": True}
    else:
        execution = _execution_decision(context, build_config)
        if not execution.accepted:
            return execution
        details = dict(execution.details)
        build_summary = _line_field(context.report, "EXECUTED_BUILD")
        details["build_summary_inaccurate"] = bool(
            build_summary
            and not build_summary_matches(build_summary, build_config)
        )
    match = re.search(
        r"^\s*BUILD_ERRORS:\s*(\d+)", context.report, re.M)
    errors = int(match.group(1)) if match else None
    details["reported_error_conflict"] = bool(
        errors is not None
        and (
            (context.status == "OK" and errors != 0)
            or (context.status == "BLOCKED" and errors == 0)
        )
    )
    shrink = report_section(context.report, "SHRINK_EXEMPT")
    if (
            context.compile_net < 0
            and (shrink is None or empty_section(shrink))):
        return reject(
            "代码净删 %s 行(git 亲算:未提交+修复编译 commit)"
            "且无 SHRINK_EXEMPT 声明——禁止删代码/注释代码换编译通过;"
            "确属合理精简须逐项声明并接受下游评审复核。"
            % -context.compile_net
        )
    return accept(details=details)
