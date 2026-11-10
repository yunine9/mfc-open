"""Platform effects for the pure Hook runtime-mode router."""

import os
import re

from mae_flow_core.application.hooks.events import HookEventPorts
from mae_flow_core.application.hooks.models import HookResponse


def _exit_code(error):
    return error.code if isinstance(error.code, int) else 0


class HookEventAdapter:
    """Map routed Hook use cases onto the existing platform operations."""

    def __init__(
            self, *, state, action_state, runtime_adapter, log,
            session_notice_due, pretool, standalone_pretool, inject,
            subagentstop, posttool, stop):
        self.state = state
        self.action_state = action_state
        self.runtime = runtime_adapter
        self.log = log
        self.session_notice_due = session_notice_due
        self.pretool_handler = pretool
        self.standalone_pretool_handler = standalone_pretool
        self.inject_handler = inject
        self.subagentstop_handler = subagentstop
        self.posttool_handler = posttool
        self.stop_handler = stop

    def _invoke(self, handler, *args, **kwargs):
        try:
            response = handler(*args, **kwargs)
        except SystemExit as error:
            return HookResponse(exit_code=_exit_code(error))
        return (
            response
            if isinstance(response, HookResponse)
            else HookResponse()
        )

    def conflict(self, event, _payload, runtime):
        self.log("runtime conflict: " + ",".join(runtime.conflicts))
        if (
                not runtime.flow_terminal
                and event in ("userprompt", "sessionstart")):
            print(
                "[mae-flow] ⚠ 检测到流程状态冲突：%s。完整流程继续作为唯一控制源；"
                "请执行 current 输出中的 doctor 命令查看并清理陈旧独立任务。"
                % "、".join(runtime.conflicts))
        return HookResponse()

    def corrupt(self, event, payload, runtime):
        self.log("runtime corrupt: " + ";".join(runtime.errors))
        if (
                event not in ("userprompt", "sessionstart")
                or not self.session_notice_due("corrupt", payload, event)):
            return HookResponse()
        if os.path.isfile(self.state):
            print(
                "[mae-flow] ⚠ 完整流程状态损坏，Hook 已按 fail-open 放行普通开发。"
                "发送 `/mae-flow:mae-flow exit` 可保存坏现场并解除流程；不要手删状态。")
        elif os.path.isfile(self.action_state):
            print(
                "[mae-flow] ⚠ 独立任务状态损坏，Hook 已按 fail-open 放行普通开发。"
                "执行 `python3 \".mae-flow-work/bin/mae-flow.py\" action cancel` "
                "可保存坏现场并清理控制指针。")
        else:
            print(
                "[mae-flow] ⚠ 退出标记损坏，Hook 已按 fail-open 放行普通开发。"
                "执行 `python3 \".mae-flow-work/bin/mae-flow.py\" doctor` "
                "查看现场；不要直接删除文件。")
        if os.path.isfile(self.state):
            return self._invoke(
                self.inject_handler,
                payload,
                session_start=(event == "sessionstart"),
            )
        return HookResponse()

    def _offer_first_entry(self, event, payload):
        """全新仓里,用户明确发起交付时——hook 直接把转发壳铺好,不递路径。

        acd904b 的铁律"不往没开工的仓写文件"防的是随便一条消息就写脏任意仓;
        但用户点名要交付时顾虑不成立:他就是要在这个仓开工。第一版修法是打印
        插件绝对路径让 Agent 抄——内网实测 Agent 把 Windows 长路径抄错了两处
        (mae-flow\\.py、丢反斜杠)。路径接力本身就是错的:铺桥是机器的活,
        Agent 从头到尾只该知道 .mae-flow-work/bin/mae-flow.py 这一个短路径。
        只有铺不动(权限/只读)才降级递路径——那是宿主故障,本就不该常见。
        """
        if event not in ("userprompt", "sessionstart"):
            return
        if os.path.isfile(self.state):
            return                         # 已在途,桥由既有路径维护
        # 判据要宽:铺一个转发壳的代价是过程目录里多一个文件(且 .gitignore 已
        # 覆盖),而判严的代价是用户开不了工。原来复用了 _explicit_flow_start_prompt
        # ——那是给"终态重入"设计的,只认裸 /mae-flow 命令;真实输入
        # "/mae-flow\n交付 REQ…" 里 action 取到"交付",不在白名单,于是一律不铺。
        # 内网首战就是栽在这:判据永远 False,模型只好自己去找 python 和插件路径。
        from .project_launcher import wants_delivery
        if not wants_delivery(payload.get("prompt") or ""):
            return
        from .project_launcher import (
            install_project_launcher, plugin_entry_path, wants_delivery)
        bridge = install_project_launcher()
        if bridge:
            print("[mae-flow] 转发壳已就位: .mae-flow-work/bin/mae-flow.py。"
                  "首次开工直接执行:\n"
                  '  python3 ".mae-flow-work/bin/mae-flow.py" init')
            return
        print("[mae-flow] ⚠ 转发壳写入失败(权限或只读目录?)。本次用插件入口"
              "的绝对路径顶上:\n"
              '  python3 "%s" init\n'
              "这不该经常出现;若反复出现,检查项目目录的写权限。"
              % plugin_entry_path())

    def terminal(self, event, payload, _runtime):
        if event == "userprompt":
            prompt = payload.get("prompt") or ""
            if self.runtime._explicit_exit_prompt(prompt):
                print(
                    "[mae-flow] 流程已经完成且 Hook 门禁已解除，无需再次退出；"
                    "终态记录会保留给 current/status/report 和下一单自动滚动。"
                    "不要再执行 exit 或 exit --interactive。")
                self.log("terminal flow: idempotent exit")
                return HookResponse()
            if (
                    self.runtime._explicit_flow_start_prompt(prompt)
                    or re.search(r"月光宝盒|moonlight", prompt, re.I)):
                self.runtime._capture_usermsg(prompt)
        if (
                event in ("userprompt", "sessionstart")
                and self.session_notice_due("terminal", payload, event)):
            print(
                "[mae-flow] 上一单已交付完成，Hook 门禁已全部解除；"
                "当前按普通开发处理。终态记录仍可用 current/status/report 查看，"
                "发起下一单时 init 会自动归档并开启新流程。")
        self.log("terminal flow: bypass " + event)
        return HookResponse()

    def direct(self, event, payload, _runtime):
        if event in ("userprompt", "sessionstart"):
            if event == "userprompt":
                self.runtime._capture_direct_prompt(
                    payload.get("prompt") or "")
            if self.session_notice_due("direct", payload, event):
                print(
                    "[mae-flow] 本项目已退出交付流程，按用户的普通开发请求执行；"
                    "不要运行 current/done。用户明确要求恢复原流程或执行 "
                    "/mae-flow:mae-flow review-fix 时，先运行 messages "
                    "取得真实消息 ID，再按命令说明执行 init；"
                    ".mae-flow.json.exited 是退出指针，不是主状态，禁止移动或改名。")
        elif (
                event == "posttooluse"
                and payload.get("tool_name") == "AskUserQuestion"):
            self.runtime._capture_direct_prompt(
                self.runtime._text_of(payload.get("tool_response")))
        self.log("direct mode: bypass " + event)
        return HookResponse()

    def inactive(self, event, _payload):
        self.log("inactive: bypass " + event)
        return HookResponse()

    def pretool(self, payload):
        return self._invoke(self.pretool_handler, payload)

    def standalone_pretool(self, payload):
        return self._invoke(self.standalone_pretool_handler, payload)

    def inject(self, payload, session_start):
        # 全新仓(INACTIVE)的 userprompt/sessionstart 也落在这里——首次铺桥必须
        # 挂在这条路上。之前误挂进 corrupt 分支(只在状态文件损坏时走),
        # 于是内网首战完全没生效:模型照旧自己去找 python 和插件路径。
        # 教训:验证要打真实入口,不能只测自己新写的那段函数。
        self._offer_first_entry(
            "sessionstart" if session_start else "userprompt", payload)
        return self._invoke(
            self.inject_handler, payload, session_start=session_start)

    def standalone_inject(self, payload, session_start):
        return self.inject(payload, session_start)

    def subagentstop(self, payload):
        return self._invoke(self.subagentstop_handler, payload)

    def posttool(self, payload):
        return self._invoke(self.posttool_handler, payload)

    def stop(self, payload):
        return self._invoke(self.stop_handler, payload)

    def _log_port(self, message):
        self.log(message)
        return HookResponse()

    def ports(self):
        return HookEventPorts(
            conflict=self.conflict,
            corrupt=self.corrupt,
            terminal=self.terminal,
            standalone_pretool=self.standalone_pretool,
            standalone_inject=self.standalone_inject,
            direct=self.direct,
            inactive=self.inactive,
            pretool=self.pretool,
            inject=self.inject,
            subagentstop=self.subagentstop,
            posttool=self.posttool,
            stop=self.stop,
            log=self._log_port,
        )
