"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    RuntimeMode, _COMMAND_UNHANDLED, command_dispatch, os, parse_args, resolve_runtime,
    sys,
)
from .wiring import api

def _dispatch_action(flow, state, args):
    route = command_dispatch.action_route(args.action)
    if route is None:
        return _COMMAND_UNHANDLED
    return command_dispatch.invoke(
        route, api.exports(), flow=flow, state=state, args=args)

def _dispatch_story_localize(flow, state, runtime, args):
    if runtime.mode == RuntimeMode.STANDALONE:
        api.die("当前有 UT/CodeCheck/Grill 独立任务正在运行，"
            "先 finish/cancel 后再整理 STORY。", 2)
    if (
        state is not None
        and not flow.get("steps", {}).get(
            state.get("current", ""), {}).get("terminal")
    ):
        api.die("完整流程中的 STORY 不入库由 story 步 done 自动处理，"
            "无需手工执行 story-localize。", 2)
    return api.cmd_story_localize(args)

def _dispatch_init(flow, runtime, args):
    if runtime.mode == RuntimeMode.STANDALONE:
        api.die("当前有独立任务正在运行，不能同时初始化完整流程。"
            "先执行 action finish 或 action cancel。", 2)
    return api.cmd_init(flow, args)

def _dispatch_moonlight_start(flow, state, runtime, args):
    if runtime.mode == RuntimeMode.STANDALONE:
        api.die("当前有独立任务正在运行，不能叠加月光宝盒。"
            "先执行 action finish 或 action cancel。", 2)
    return api.cmd_moonlight(flow, state, args)

def _dispatch_global_command(flow, state, runtime, args):
    if args.cmd == "envcheck":
        return api.cmd_envcheck(flow, args)
    # 只吃 args 的无状态命令(symbol-refs 是递工具不是门禁:只读、任何模式可用)
    args_only_handler = {
        "symbol-refs": api.cmd_symbol_refs,
        "capability": api.cmd_capability,
    }.get(args.cmd)
    if args_only_handler is not None:
        return args_only_handler(args)
    if args.cmd == "steps":
        return api.cmd_steps(flow, state, args)
    if args.cmd == "template":
        return api.cmd_template(flow, args)
    if args.cmd == "story-localize":
        return _dispatch_story_localize(flow, state, runtime, args)
    if args.cmd == "init":
        return _dispatch_init(flow, runtime, args)
    if args.cmd == "moonlight" and args.action in ("on", "continue"):
        return _dispatch_moonlight_start(
            flow, state, runtime, args)
    document_handler = {
        "panel": api.cmd_panel,          # 只读展示层:不写状态、不拦任何东西
        "lightcheck": api.cmd_lightcheck,
        "local-spec": api.cmd_local_spec,
        "domain-docs": api.cmd_domain_docs,
        "domain-archive": api.cmd_domain_archive,
        "manifest": api.cmd_delivery_manifest,
    }.get(args.cmd)
    if document_handler is not None:
        return document_handler(state, args)
    if args.cmd == "gate":
        return api.cmd_gate(flow, state, args)
    if args.cmd == "action":
        return _dispatch_action(flow, state, args)
    if args.cmd == "report" and args.all:
        return api.cmd_report_all()   # 账本聚合是无状态命令,不要求存在在途单
    return _COMMAND_UNHANDLED

def _dispatch_runtime_mode(runtime, args):
    if runtime.mode == RuntimeMode.DIRECT:
        if args.cmd == "messages":
            return api.cmd_direct_messages(args)
        if args.cmd in ("current", "status", "doctor", "exit"):
            return api.print_direct_mode_status()
        api.die("当前项目已退出 mae-flow，普通开发不需要执行流程命令。"
            "若用户明确要重新进入流程，先执行 messages，再按输出使用 init；"
            "旧质量证据不会复用。禁止移动或改名 .mae-flow.json.exited。", 2)
    if runtime.mode == RuntimeMode.STANDALONE:
        if args.cmd in ("current", "status", "doctor"):
            return api.cmd_action_status()
        api.die("当前只运行独立任务，不存在可推进的完整交付步骤。"
            "执行 action status 查看，或 action finish/action cancel 结束。", 2)
    if runtime.mode == RuntimeMode.CORRUPT and args.cmd in ("current", "status", "doctor"):
        return api.cmd_runtime_doctor(runtime, args)
    return _COMMAND_UNHANDLED

def _dispatch_flow_command(flow, state, args):
    if state is None:
        api.die("流程未初始化,先执行 init。")
    route = command_dispatch.flow_route(args.cmd)
    if route is None:
        return _COMMAND_UNHANDLED
    return command_dispatch.invoke(
        route, api.exports(), flow=flow, state=state, args=args)

def _load_dispatch_state(runtime, args):
    try:
        return api.load_state(), _COMMAND_UNHANDLED
    except Exception as state_error:
        if args.cmd == "exit":
            return None, api.cmd_exit_corrupt_state(args, state_error)
        if args.cmd == "doctor":
            return None, api.cmd_runtime_doctor(runtime, args, state_error)
        api.die("流程状态文件损坏，不能安全判断当前步骤：%s。不要删除或手改状态；"
            "用户可直接发送 `/mae-flow:mae-flow exit`，Hook 会保存坏文件并退出；"
            "Hook 也异常时在真实终端执行 exit --interactive。" % state_error, 2)

def main():
    args = parse_args()

    root, _ = api.find_project_root()
    if root != os.getcwd():
        os.chdir(root)
        if args.cmd != "gate":   # gate 保持输出纯净(stderr 会回传模型)
            print(f"[mae-flow] 调用目录非项目根,已定位到: {root}", file=sys.stderr)

    pass
    flow = api.load_flow()
    api.FLOW = flow
    runtime = resolve_runtime(os.getcwd())
    state, state_result = _load_dispatch_state(runtime, args)
    if state_result is not _COMMAND_UNHANDLED:
        return state_result

    result = _dispatch_global_command(flow, state, runtime, args)
    if result is not _COMMAND_UNHANDLED:
        return result
    result = _dispatch_runtime_mode(runtime, args)
    if result is not _COMMAND_UNHANDLED:
        return result
    return _dispatch_flow_command(flow, state, args)
