"""CLI adapter for observational build milestones."""

from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.workflow.build_milestones import (
    append_event,
    build_event,
    implementation_tasks,
    select_task,
)

from .shared import (
    STATE_PATH, hashlib, json, os, read_bytes, read_text, safe_read_json,
    time, update_json,
)
from .wiring import api


_BUILD_STEPS = frozenset(("build",))


def _ledger_path():
    return STATE_PATH + ".build-milestones"


def _implementation(state):
    ticket = str((state.get("config") or {}).get("单号", "") or "")
    if not ticket:
        api.die("当前流程缺少单号，无法定位 implementation.md；请先执行 current 核对流程配置。", 2)
    package = ensure_work_package(os.getcwd(), ticket)
    if not os.path.isfile(package.implementation):
        api.die("已确认的 implementation.md 不存在: " + package.implementation
                + "；请先回到 Story 阶段补齐产物。", 2)
    body = read_text(package.implementation, encoding="utf-8", errors="strict")
    tasks = implementation_tasks(body)
    if not tasks:
        api.die(
            "implementation.md 没有可识别的“任务 N”或复选框任务；"
            "请先修正文档任务边界，不要在命令行临时发明任务。", 2)
    return package.implementation, tasks


def _print_events(data, as_json=False):
    rows = list((data or {}).get("events") or ())
    if as_json:
        print(json.dumps({"events": rows}, ensure_ascii=False, indent=2))
        return
    if not rows:
        print("[mae-flow] 尚无 build milestone；它只用于进度观察，不影响 done。")
        return
    labels = {"started": "开始", "completed": "完成", "blocked": "受阻"}
    for row in rows:
        reason = (" | " + row.get("reason", "")) if row.get("reason") else ""
        print("%s | 任务 %s | %s | rev %s%s" % (
            row.get("at", ""), row.get("task_id", "?"),
            labels.get(row.get("event"), row.get("event", "?")),
            row.get("step_revision", 0), reason))


def cmd_build_milestone(_flow, state, args):
    """Record or show milestones without participating in workflow evidence."""
    if args.action == "show":
        raw, error = safe_read_json(_ledger_path())
        if error:
            api.die("build milestone 台账不可读: " + error
                    + "；请先执行 doctor 检查旁路状态。", 2)
        _print_events(raw if isinstance(raw, dict) else {}, args.json)
        return
    if state.get("current") not in _BUILD_STEPS:
        api.die(
            "build milestone 只记录 build 步内的实现过程；"
            "它不是推进命令，也不能替代 done；请按 current 给出的当前步骤动作继续。", 2)
    path, tasks = _implementation(state)
    task = select_task(tasks, args.task)
    if task is None:
        api.die(
            "implementation.md 中没有任务 %s；可用任务: %s"
            % (args.task, "、".join(item.task_id for item in tasks)), 2)
    base = str(state.get("implementation_base_head", "") or "")
    if not base:
        api.die("缺少 implementation_base_head，无法绑定工作区快照；请先执行 doctor 检查流程状态。", 2)
    try:
        snapshot = api._worktree_snapshot_since(base)
    except Exception as exc:
        api.die("无法生成 build milestone 工作区快照: " + str(exc)
                + "；请先执行 doctor 检查 Git 基点。", 2)
    event_names = {
        "start": "started", "complete": "completed", "block": "blocked"}
    event = build_event(
        event=event_names[args.action], task=task,
        step=state.get("current", ""),
        state_revision=state.get("revision", 0),
        step_head=(state.get("step_heads") or {}).get(
            state.get("current", ""), ""),
        implementation_path=os.path.relpath(path, os.getcwd()).replace(os.sep, "/"),
        implementation_digest=hashlib.sha256(read_bytes(path)).hexdigest(),
        worktree_snapshot=snapshot,
        at=time.strftime("%Y-%m-%d %H:%M:%S"),
        reason=args.reason or "",
        nonce=time.time_ns(),
    )
    update_json(
        _ledger_path(), lambda data: append_event(data, event),
        default={"events": []}, recover_corrupt=False)
    print("[mae-flow] 已记录任务 %s %s（观察事件，不影响 done）" % (
        task.task_id, event["event"]))
