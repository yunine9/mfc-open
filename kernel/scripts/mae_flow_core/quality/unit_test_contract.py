"""Pure UT Agent final-report and execution-risk contract."""

from mae_flow_core import host_env
from mae_flow_core.quality.agent_contracts import (
    accept,
    reject,
    required_skill,
    same_config,
)
from mae_flow_core.quality.agent_reports import (
    empty_section,
    report_field,
)
from mae_flow_core.quality.tool_transcript import (
    call_failed,
    reported_bash_call,
    skill_call,
)
from mae_flow_core.quality.unit_test_execution import (
    report_counts,
    unit_test_execution_risk,
)


def _generator_decision(context):
    configured = context.config.get("UT生成方式", "")
    need = required_skill(configured)
    if need:
        call = skill_call(context.calls, need)
        reused = (
            context.reusable_receipts.get("UT_GENERATOR")
            if context.facts.get("soft") and not call else None
        )
        if call and call_failed(call):
            return (
                "%s Skill 的工具结果明确失败，不能报告 PASS。" % need,
                {},
            )
        if not call and not reused:
            return (
                "UT 配置要求 %s Skill，但 transcript 中没有成功调用，"
                "也没有同任务卡、同源码版本的可复用生成凭证。"
                "若宿主确实未暴露子会话工具调用，主会话应展示风险并使用 "
                "accept-risk，不要重启长任务形成循环。" % need,
                {},
            )
        label = report_field(context.report, "GENERATOR_USED") or ""
        return "", {
            "generator_summary_inaccurate": bool(
                call and not same_config(label, configured)),
            "reused_generator": bool(reused),
        }
    label = report_field(context.report, "GENERATOR_USED") or ""
    if not same_config(label, configured):
        return "GENERATOR_USED 与任务卡的 UT生成方式不一致。", {}
    return "", {"reused_generator": False}


def _run_decision(context):
    configured = context.config.get("UT运行命令", "")
    executed = report_field(context.report, "EXECUTED_UT") or ""
    if not executed:
        return (
            "PASS 报告缺少 EXECUTED_UT: <实际执行的 UT 命令>。",
            {},
        )
    run = reported_bash_call(context.calls, executed)
    reused = (
        context.reusable_receipts.get("UT_RUN")
        if context.facts.get("soft") and not run else None
    )
    if run:
        reason = unit_test_execution_risk(
            context.report,
            run,
            configured,
            context.calls,
            bool(context.changed_paths),
        )
        if reason:
            return reason, {}
    elif reused:
        bound = reused.get("reported_counts", {}) or {}
        current = report_counts(context.report)
        if bound and current != bound:
            return (
                "报告重答的 TESTS_TOTAL/PASSED/FAILED "
                "与已绑定的真实执行凭证不一致；只修格式不得改写测试事实。",
                {},
            )
    if run and call_failed(run):
        return (
            "UT运行命令的工具结果明确失败，不能报告 PASS。",
            {},
        )
    if not run and not reused:
        return (
            "EXECUTED_UT 未对应到 transcript 中真实执行成功的 Bash 命令，"
            "也没有同任务卡、同源码版本的可复用测试凭证。",
            {},
        )
    return "", {"reused_run": bool(reused)}


def _honesty_decision(report):
    """带着待答问题/已知失败不许报 PASS——与本地是否跑过测试无关,
    两种形态共用(云端分支也走这一条)。"""
    for name in (
            "PENDING_QUESTIONS", "KNOWN_FAILURES", "SUSPECTED_BUGS"):
        value = report_field(report, name)
        if value is not None and not empty_section(value):
            return (
                "标记 PASS 但 %s 非空；必须先交主会话和用户处理，"
                "不能带问题过关。" % name
            )
    return ""


def _report_decision(report):
    reason = _honesty_decision(report)
    if reason:
        return reason, None
    counts = report_counts(report)
    for key, field in (
            ("total", "TESTS_TOTAL"),
            ("passed", "TESTS_PASSED"),
            ("failed", "TESTS_FAILED")):
        if counts[key] is None:
            return "PASS 报告缺少 %s: <数字>。" % field, None
    if (
            counts["failed"] != 0
            or counts["total"] != counts["passed"]):
        return (
            "UT 数字对账不通过：PASS 必须 TESTS_FAILED=0 且 TOTAL=PASSED。",
            None,
        )
    if counts["total"] < 1:
        return (
            "UT PASS 要求至少运行 1 个测试(TESTS_TOTAL>=1);"
            "0 条=空跑,不能证明任何回归保证。收口批跑全量,真实仓库恒成立。",
            None,
        )
    return "", counts


def evaluate_unit_test_contract(context):
    """Evaluate UT using only frozen report, transcript and receipt facts."""
    if context.status not in ("PASS", "NEEDS_INPUT", "FAIL"):
        return reject("未知结果状态 " + context.status)
    if context.status != "PASS":
        return accept(details={"result": "accepted-honest-nonpass"})
    details = {}
    if not host_env.unit_tests_run_locally():
        # 云端形态:测试照常生成,运行交给流水线(绑 SHA)。
        # 放开的是"本地跑过"这一类证据:EXECUTED_UT、真实 Bash 调用、
        # 数字对账——没跑就不该有数字,要求它反而是逼模型编。
        # 诚实检查一条不减:带着待答问题/已知失败不许报 PASS。
        reason = _honesty_decision(context.report)
        if reason:
            return reject(reason, details=details)
        details["run_deferred_to_pipeline"] = True
        return accept(details=details)
    reason, generator = _generator_decision(context)
    details.update(generator)
    if reason:
        return reject(reason, details=details)
    reason, run = _run_decision(context)
    details.update(run)
    if reason:
        return reject(reason, details=details)
    reason, counts = _report_decision(context.report)
    if reason:
        return reject(reason, details=details)
    details["reported_counts"] = counts
    return accept(details=details)
