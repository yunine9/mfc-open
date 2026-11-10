"""Pure GRILL Agent final-report contract."""

from mae_flow_core.quality.agent_contracts import accept, reject
from mae_flow_core.quality.agent_reports import (
    empty_section,
    report_field,
    report_number,
)


def _successful_read(calls):
    return any(
        call.name.lower() in ("read", "grep", "glob")
        and call.result_seen
        and not call.is_error
        for call in calls
    )


def evaluate_grill_contract(context):
    """Return the existing GRILL critic decision without performing I/O."""
    status = context.status
    if status not in ("CLEAR", "GAPS", "FAIL"):
        return reject(
            "未知结果状态 %s；只能是 CLEAR/GAPS/FAIL。" % status)
    if status == "FAIL":
        return accept()
    if not _successful_read(context.calls):
        return reject(
            "grill critic 报 %s 但 transcript 无任何成功的 Read/Grep/Glob "
            "调用——'没有遗漏'的结论必须建立在真读过需求/代码材料之上,"
            "而非样板输出。若宿主确未暴露子会话工具调用,主会话展示风险后"
            "用 accept-risk grill。" % status)
    stage = report_field(context.report, "STAGE") or ""
    if stage.lower() != str(context.task.get("stage", "")).lower():
        return reject("STAGE 与任务卡的质询检查阶段不一致。")
    count = report_number(context.report, "GAPS_FOUND")
    if count is None:
        return reject("缺少 GAPS_FOUND: <数字>。")
    if status == "CLEAR" and count != 0:
        return reject("标记 CLEAR 但 GAPS_FOUND 不是 0。")
    if status == "GAPS" and count == 0:
        return reject("标记 GAPS 但 GAPS_FOUND=0。")
    branches = report_field(context.report, "MISSING_BRANCHES")
    if status == "GAPS" and (
            branches is None or empty_section(branches)):
        return reject(
            "发现遗漏时必须在 MISSING_BRANCHES 中列出可继续追问的决策分支。")
    return accept()
