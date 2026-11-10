"""Pure CODECHECK Agent final-report and transcript contract."""

import hashlib
import re

from mae_flow_core import host_env
from mae_flow_core.quality.agent_contracts import (
    accept,
    build_summary_matches,
    embedded_build_command,
    reject,
    required_skill,
)
from mae_flow_core.quality.tool_transcript import (
    bash_call,
    bash_calls,
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


def _report_numbers(report):
    values = {}
    for name in ("FOUND", "FIXED", "REMAINING_COUNT"):
        match = re.search(
            r"^\s*" + name + r":\s*(\d+)\s*$",
            report,
            re.M,
        )
        if not match:
            return None, "缺少机器对账字段 %s: <数字>。" % name
        values[name] = int(match.group(1))
    return values, ""


def _number_decision(status, numbers, scan, current):
    if (
            scan.get("step") == current
            and numbers["FOUND"] != scan.get("count")):
        return (
            "FOUND(%s)与 harness 首检(%s)不一致。"
            "禁止主会话先修后让 agent 补手续；"
            "回到首检状态并由 agent 处理原告警。"
            % (numbers["FOUND"], scan.get("count"))
        )
    if numbers["FOUND"] != (
            numbers["FIXED"] + numbers["REMAINING_COUNT"]):
        return (
            "对账不平:FOUND(%s) != FIXED(%s) + REMAINING_COUNT(%s),"
            "有告警被吞掉或数字失实。"
            % (
                numbers["FOUND"],
                numbers["FIXED"],
                numbers["REMAINING_COUNT"],
            )
        )
    if status == "CLEAN" and numbers["REMAINING_COUNT"] != 0:
        return (
            "标记 CLEAN 但 REMAINING_COUNT=%s,自相矛盾。"
            % numbers["REMAINING_COUNT"]
        )
    if status == "REMAINING" and numbers["REMAINING_COUNT"] == 0:
        return "标记 REMAINING 但 REMAINING_COUNT=0,自相矛盾。"
    return ""


def _command_swallows_failure(command):
    return bool(re.search(
        r"(?:\|\||;|&)\s*(?:true|exit(?:\s+/b)?\s+0|"
        r"\$(?:global:)?LASTEXITCODE\s*=\s*0)\b",
        command or "",
        re.I,
    ))


def _counts_from_text(text):
    value = str(text or "")
    counts = [
        int(item)
        for item in re.findall(r"共有\s*(\d+)\s*条告警", value)
    ]
    if counts:
        return counts
    counts = [int(item) for item in re.findall(
        r"\|\s*\*{0,2}总计\*{0,2}\s*\|"
        r"\s*\*{0,2}(\d+)\*{0,2}\s*\|",
        value,
    )]
    if counts:
        return counts
    details = re.findall(
        r"^###\s+\d+\.\s+\[(?:Critical|Major|Minor|Suggestion|"
        r"致命级|严重级|一般级|提示级)\]",
        value,
        re.M | re.I,
    )
    if details:
        return [len(details)]
    completed = (
        "代码检查完成" in value
        or "CodeCheck 检查报告" in value
        or "检查结果汇总" in value
    )
    zero_patterns = (
        r"未发现(?:任何)?(?:代码)?告警",
        r"没有发现(?:任何)?(?:代码)?告警",
        r"(?:告警|问题)(?:总数)?\s*[:：]?\s*0\b",
        r"0\s*条告警",
    )
    return [0] if completed and any(
        re.search(pattern, value, re.I)
        for pattern in zero_patterns
    ) else []


def _command_of(call):
    value = call.input
    return value.get("command", "") if isinstance(value, dict) else str(value)


def _selected_fullcheck_calls(calls, command_count):
    selected = []
    invocations = 0
    for call, count in reversed(
            bash_calls(calls, "codecheck fullcheck")):
        selected.append((call, count))
        invocations += count
        if invocations >= command_count:
            break
    return selected, invocations


def _inspect_selected_calls(selected):
    real_counts = []
    result_hashes = []
    for call, count in reversed(selected):
        if _command_swallows_failure(_command_of(call)):
            return {}, (
                "CodeCheck 命令使用了 || true / ; exit 0 等方式吞掉失败退出码。")
        if not call.result_seen:
            return {}, (
                "最终一轮 CodeCheck 分批调用缺少 tool_result，不能报告成功。")
        hits = _counts_from_text(call.result)
        if call_failed(call) and not hits:
            return {}, (
                "最终一轮 CodeCheck 分批调用失败，且 tool_result "
                "没有可验证的告警计数，不能报告成功。")
        result_hashes.append(hashlib.sha256(
            str(call.result or "").encode(
                "utf-8", errors="replace")).hexdigest())
        real_counts.extend(hits[-count:])
    return {
        "real_counts": real_counts,
        "result_hashes": result_hashes,
    }, ""


def _fullcheck_evidence(context, command_count):
    selected, invocations = _selected_fullcheck_calls(
        context.calls, command_count)
    if selected and invocations < command_count:
        return {}, (
            "最终一轮 CodeCheck 只找到 %s/%s 个 fullcheck 分批调用；"
            "不能跳过前面批次后只拿最后一批收尾。"
            % (invocations, command_count)
        )
    if selected:
        evidence, reason = _inspect_selected_calls(selected)
        if reason:
            return {}, reason
        evidence.update({
            "calls_present": True,
            "reused": False,
        })
        return evidence, ""
    receipt = (
        context.reusable_receipts.get("CODECHECK_FULLCHECK")
        if context.facts.get("soft") else None
    )
    if receipt:
        return {
            "calls_present": False,
            "reused": True,
            "real_counts": list(receipt.get("raw_counts") or []),
            "result_hashes": list(receipt.get("result_hashes") or []),
        }, ""
    return {}, (
        "transcript 中没有完整执行本轮 CodeCheck fullcheck，"
        "且没有同任务卡、同源码版本、同分批口径的可复用机器凭证。")


def _expected_raw(numbers, scan):
    stock = scan.get("stock_excluded")
    return (
        numbers["REMAINING_COUNT"] + stock
        if isinstance(stock, int)
        else numbers["REMAINING_COUNT"]
    )


def _machine_count_decision(
        evidence, command_count, numbers, scan):
    counts = evidence["real_counts"]
    if len(counts) < command_count:
        receipt = (
            {
                "command_count": command_count,
                "raw_counts": [],
                "scan": scan,
                "expected_raw": None,
                "result_hashes": evidence["result_hashes"],
            }
            if evidence["calls_present"] else None
        )
        return "", receipt
    final_counts = counts[-command_count:]
    actual = sum(final_counts)
    expected = _expected_raw(numbers, scan)
    if actual != expected:
        stock = scan.get("stock_excluded")
        suffix = (
            "+用户确认不涉及(%s)=%s" % (stock, expected)
            if isinstance(stock, int) else "=%s" % expected
        )
        return (
            "真实 fullcheck 最终 %s 批合计 %s 条告警，"
            "但本单遗留(%s)%s；复验摘录不能自说自话，"
            "修完或如实上报后重答。"
            % (
                command_count,
                actual,
                numbers["REMAINING_COUNT"],
                suffix,
            )
        ), None
    receipt = None
    if evidence["calls_present"]:
        receipt = {
            "command_count": command_count,
            "raw_counts": final_counts,
            "scan": scan,
            "expected_raw": expected,
            "result_hashes": evidence["result_hashes"],
        }
    return "", receipt


def _build_call(context, build_config):
    need = required_skill(build_config)
    if need:
        return skill_call(context.calls, need)
    embedded = embedded_build_command(build_config)
    return bash_call(context.calls, embedded or build_config)


def _build_decision(context, numbers):
    if numbers["FIXED"] <= 0:
        return "", {}
    if not host_env.build_runs_locally():
        # 云端形态:本地不编译(见 host_env.build_runs_locally)。
        # CodeCheck 修完不再要求"本轮已编译"的本地证据——那台机器上
        # 根本没有构建链;修复的成效由交付点流水线绑 SHA 裁决。
        return "", {"build_deferred_to_pipeline": True}
    build_config = context.config.get("编译方式", "")
    call = _build_call(context, build_config)
    successful = call if call and not call_failed(call) else None
    reused = (
        context.reusable_receipts.get("CODECHECK_BUILD")
        if context.facts.get("soft") and not successful else None
    )
    if successful:
        summary = _line_field(context.report, "EXECUTED_BUILD")
        return "", {
            "build_summary_inaccurate": not build_summary_matches(
                summary, build_config),
            "reused_build": False,
        }
    if reused:
        return "", {"reused_build": True}
    need = required_skill(build_config)
    if need:
        failed = skill_call(context.calls, need)
        if failed and call_failed(failed):
            return (
                "%s Skill 的工具结果明确失败，"
                "不能把本轮修复计为已编译。" % need
            ), {}
        return (
            "编译配置要求 %s Skill，但本轮 transcript 中没有成功调用，"
            "也没有同任务卡、同源码版本的可复用编译凭证。" % need
        ), {}
    failed = _build_call(context, build_config)
    if failed and call_failed(failed):
        return (
            "配置的编译命令明确失败，不能把本轮修复计为已编译。"
        ), {}
    return (
        "本轮 transcript 中没有成功执行配置的编译命令，"
        "也没有同任务卡、同源码版本的可复用编译凭证。"
    ), {}


def _excerpt_decision(report, numbers, scan, command_count):
    excerpts = re.findall(r"共有\s*(\d+)\s*条告警", report)
    actual = (
        sum(int(value) for value in excerpts[-command_count:])
        if command_count > 1 and len(excerpts) >= command_count
        else int(excerpts[-1]) if excerpts else None
    )
    expected = _expected_raw(numbers, scan)
    if actual is None or actual == expected:
        return ""
    stock = scan.get("stock_excluded")
    stock_text = (
        " + 用户确认不涉及 %s" % stock
        if isinstance(stock, int) else ""
    )
    return (
        "复验摘录合计 %s 条告警与真实对账口径"
        "（本单遗留 %s%s = %s）矛盾。"
        % (
            actual,
            numbers["REMAINING_COUNT"],
            stock_text,
            expected,
        )
    )


def evaluate_codecheck_contract(context):
    """Evaluate CODECHECK using frozen task, scan and transcript facts."""
    scan = context.facts.get("scan") or {}
    current = context.facts.get("current", "")
    if context.status == "FAIL":
        return accept(details={
            "result": "accepted-honest-failure",
            "status": context.status,
            "changed_source_paths": list(context.changed_paths),
        })
    if not re.search(
            r"EXECUTED_COMMAND.*fullcheck", context.report, re.I):
        return reject(
            "必须包含 EXECUTED_COMMAND 字段且实际执行的是 fullcheck"
            "(用 increcheck 或未执行 = FAIL)。")
    numbers, reason = _report_numbers(context.report)
    if reason:
        return reject(reason)
    reason = _number_decision(
        context.status, numbers, scan, current)
    if reason:
        return reject(reason)
    command_count = (
        len(scan.get("commands") or [])
        if scan.get("step") == current else 1
    )
    command_count = max(1, command_count)
    evidence, reason = _fullcheck_evidence(context, command_count)
    if reason:
        return reject(reason)
    reason, receipt = _machine_count_decision(
        evidence, command_count, numbers, scan)
    details = {
        "status": context.status,
        "changed_source_paths": list(context.changed_paths),
        "found": numbers["FOUND"],
        "fixed": numbers["FIXED"],
        "remaining": numbers["REMAINING_COUNT"],
        "fullcheck_raw_counts": (
            receipt["raw_counts"]
            if receipt is not None else evidence["real_counts"]),
        "fullcheck_expected_raw": _expected_raw(numbers, scan),
        "command_count": command_count,
        "reused_fullcheck": evidence["reused"],
        "result": "accepted",
    }
    if receipt is not None:
        details["fullcheck_receipt"] = receipt
    if reason:
        return reject(reason, details=details)
    reason, build_details = _build_decision(context, numbers)
    details.update(build_details)
    if reason:
        return reject(reason, details=details)
    reason = _excerpt_decision(
        context.report, numbers, scan, command_count)
    if reason:
        return reject(reason, details=details)
    return accept(details=details)
