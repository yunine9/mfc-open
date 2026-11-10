"""Read-only CLI projection for the current phase execution plan."""

from .shared import json, sys
from mae_flow_core.workflow.execution_plan import (
    build_execution_plan,
    load_workflow_profile,
)


def cmd_execution_plan(flow, state, args):
    workflow_profile, workflow_warning = load_workflow_profile()
    try:
        plan = build_execution_plan(
            flow, state, workflow_profile=workflow_profile)
    except ValueError as exc:
        # 定制/偏好文件病到组装不出方案(catalog 校验失败、字段畸形等):
        # 本命令是只读投影,崩溃退非 0 只会让宿主看到 plan=undefined、
        # 原因全灭(2026-08-30 审计 P1-6)。丢掉两份定制按纯平台默认
        # 重组,并把降级记进 diagnostics 供宿主上浮;连平台默认都组不出
        # 才是真异常,让它照常抛——那说明 flow/catalog 本身坏了。
        print("⚠ 定制执行方案不可用(%s),已退回平台默认。" % exc,
              file=sys.stderr)
        plan = build_execution_plan(flow, state)
        plan["customization"]["diagnostics"].append({
            "code": "profile_invalid",
            "severity": "warning",
            "message": "定制执行方案不可用(%s);本阶段已退回平台默认做法"
                       % exc,
        })
    if workflow_warning:
        print(workflow_warning, file=sys.stderr)
    if getattr(args, "json", False):
        print(json.dumps(plan, ensure_ascii=False, sort_keys=True))
        return
    strategy = plan["strategy"]
    step = plan["step"]
    print("═══ 本阶段执行方案: %s ═══" % strategy["title"])
    print("当前阶段: %s / %s" % (step["phase"], step["title"]))
    print(strategy["summary"])
    print("选择原因: " + strategy["selection_reason"])
    print("本阶段最终会做:")
    for activity in plan["activities"]:
        print("- %s: %s" % (activity["title"], activity["description"]))
    print("知识装载: " + plan["knowledge"]["explanation"])
    for layer in plan["customization"].get("layers") or ():
        print("%s: %s" % (layer["title"], layer["instructions"]))
    print("不可调整: " + "、".join(plan["customization"]["locked"]))
