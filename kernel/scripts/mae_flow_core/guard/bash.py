"""Pure general Bash and Git Gate policies."""

from dataclasses import dataclass
import re

from ..foundation.git_execution import executed_git_invocations
from .gate import GateDecision
from ..workflow.authority import ADVISORY_TOOL_RULES


@dataclass(frozen=True)
class BashGateContext:
    command: str
    has_internal_state_path: bool
    branch_name: str
    branch_creating: bool
    step: str
    wanted_branch: str
    base_branch: str
    ticket: str
    commit_message_present: bool
    commit_message: str
    current_branch: str
    add_paths: tuple
    recursive_delete_targets: tuple
    state_active: bool
    user_scene_discards: tuple = ()


def _absolute(rule, message):
    return GateDecision("absolute", rule=rule, message=message)


def _block(rule, message):
    return GateDecision("block", rule=rule, message=message)


def _pre_repository(context):
    if context.has_internal_state_path:
        return _absolute(
            "bash-internal-state-read",
            "流程状态、令牌、历史账本、待重启标记和月光宝盒报告禁止经 Bash "
            "直接访问；查看请执行 current 输出中的 status/doctor/moonlight report 命令，"
            "修改只能走对应子命令。")
    return None


def _pre_wide_add(context):
    command = context.command
    if re.search(r"git\s+add\s+(-A\b|--all\b|\.(\s|$))", command):
        return _absolute(
            "bash-wide-add",
            "禁止宽提交(git add -A / --all / .):会把无关文件与不入库产物卷进"
            "交付分支(实战:STORY 选了不入库仍被卷进 MR)。git add 必须精确到"
            "文件/明确的产物目录。")
    return None


def _pre_commit_format(context):
    if not context.commit_message_present:
        return None
    message = context.commit_message
    if (
        context.ticket
        and not re.match(
            r"^\[" + re.escape(context.ticket)
            + r"\]\[(feat|fix)\]", message)
    ):
        return _block(
            "bash-commit-format",
            "commit message「%s」不符合 [%s][feat|fix]描述 格式。"
            "本次 Bash 工具调用是整体阻止的:**命令里的 git add 等前置段"
            "也没有执行**。先用 git status 核对现场,再把原来的精确 git add"
            "和修正后的 git commit 一起重新执行;例如 `git commit -m "
            "'[%s][fix]修正问题描述'`。"
            "类型只有 feat 与 fix 两种:**单元测试提交也用它们**"
            "(新增能力配套的测试写 feat,修缺陷配套的测试写 fix)。"
            "无人值守八条线里这条拦截出现最多,原因几乎都是在补测试时"
            "顺手写了 [test]——那不是格式笔误,是类型表里根本没有的值。"
            % (message, context.ticket, context.ticket),
        )
    return None


def decide_commit_branch(context):
    """分支名一旦定下来,就不许在别的分支上提交——尤其不许提交在基线分支上。

    原来对 config_confirm/workflow_select/branch_create 等头部步骤
    显式跳过,理由是"工作分支还没建"。可跳过的后果是这四步里的提交一律无人阻挡,
    而它们只有一个去处:基线分支。实战撞到了:无人值守跑到 workflow_select(第 3 步)
    时,模型把整个需求写完、提交、推送,三个提交全落在 sim_developer_base 上,
    branch_create 压根没跑过。步骤级源码 Gate 已于 2026-08-28 二次退役,
    这条独立的分支提交边界因此更是唯一防线:多层防线不能依赖上游永不失效。

    不需要按步骤开天窗:分支名还没定时 wanted_branch 为空,本来就放行;
    定了之后 current==wanted 才放行,这正是我们要的。
    """
    if (
        not context.commit_message_present
        or not context.wanted_branch
        or not context.current_branch
        or context.current_branch == context.wanted_branch
    ):
        return GateDecision("allow")
    return _block(
        "bash-commit-branch",
        "提交前拦截:当前分支 %s != 本单约定分支 %s。"
        "先 git checkout %s 再提交(分支还没建就先走完 branch_create,"
        "别把本单提交落在基线分支上);在错分支上积累提交,"
        "done 时才发现要整步返工。"
        % (
            context.current_branch,
            context.wanted_branch,
            context.wanted_branch,
        ),
    )


def decide_pre_commit(context):
    advisory = None
    for evaluator in (
        _pre_repository,
        _pre_wide_add,
        _pre_commit_format,
    ):
        decision = evaluator(context)
        if decision is not None:
            if decision.rule in ADVISORY_TOOL_RULES:
                advisory = advisory or decision
            else:
                return decision
    return advisory or GateDecision("allow")


def _post_early(context):
    command = context.command
    if any(
            operation == "push" and any(
                argument == "-f"
                or argument.startswith("--force")
                or argument.startswith("+")
                for argument in arguments)
            for operation, arguments in executed_git_invocations(command)):
        return _absolute(
            "bash-force-push",
            "禁止 force push(含 +refspec 形式):它会覆盖远端历史，不可逆。"
            "改用普通 push;远端确实需要被覆盖时，把命令和风险交给用户，"
            "由用户在自己的终端执行。")
    if re.search(r"dispatch\.py", command):
        return _absolute(
            "bash-manual-dispatch",
            "hook 分发器(dispatch.py)由 harness 自动调用,禁止手动执行——"
            "这是伪造 agent 收尾令牌的通道。本来也不需要手动调用:"
            "看流程现场执行 current 输出中的 status/doctor 命令即可。")
    if re.search(
            r"mae-flow\.py[^;&|]*\bexit\b[^;&|]*--interactive\b",
            command, re.I):
        return _absolute(
            "bash-agent-interactive-exit",
            "exit --interactive 是 Hook/ack 全坏时给用户的真实终端逃生口，"
            "Agent 的 Bash 禁止调用或代答；把完整命令展示给用户手动执行。")
    return None


def _post_repository(context):
    command = context.command
    if any(
        re.sub(r"/+$", "", path) == "openspec"
        for path in context.add_paths
    ):
        return _block(
            "bash-wide-openspec-add",
            "禁止整目录 git add openspec/：它会把其他单遗留的 change/STORY "
            "一起卷入提交。open/design 只 add 当前 "
            "openspec/changes/{CHANGE_NAME}；archive 只 add spec archive "
            "输出的本次精确产物清单。",
        )
    return None


def _git_clean_ignored(git_commands):
    return any(
        operation == "clean" and any(
            argument.startswith("-")
            and not argument.startswith("--")
            and "x" in argument[1:].casefold()
            for argument in arguments)
        for operation, arguments in git_commands
    )


def _git_wipes_worktree(git_commands):
    return (
        any(
            operation == "reset" and "--hard" in arguments
            for operation, arguments in git_commands)
        or any(
            operation in ("checkout", "restore")
            and any(argument in (".", ":/") for argument in arguments)
            for operation, arguments in git_commands)
    )


def _git_adds_worktree(git_commands):
    return any(
        operation == "worktree" and "add" in arguments
        for operation, arguments in git_commands)


def _post_dangerous(context):
    command = context.command
    if re.search(
        r"(curl|wget|iwr|invoke-webrequest)[^|&;]*\|\s*"
        r"(sudo\s+)?(sh|bash|zsh|iex|powershell)",
        command,
        re.I,
    ):
        return _absolute(
            "bash-remote-script-pipe",
            "危险命令拦截:管道执行远程脚本(供应链风险)。确需执行请用户手动运行。")
    # Git 对象库/崩溃证据的手术动作(MFC-019 实锤:对象读取异常时
    # Agent 批量复制重写 loose object、删掉 core,随后宣称 fsck 全绿——
    # hardlink 在场时这会污染源仓,证据也没了)。只读诊断(git fsck、
    # stat、ls)不受限;改写类必须停给人:这是环境/基础设施故障,
    # 不是业务 Agent 该自愈的层。
    if re.search(
        r"(?:^|[|&;]\s*)(?:rm|mv|cp|chmod|chown|truncate|ln|dd)\b"
        r"[^|&;]*\.git/objects", command):
        return _block(
            "bash-git-objects-surgery",
            "Git 对象库手术拦截:复制/重写/删除 .git/objects 下的对象属于"
            "基础设施级动作——若对象与其他仓共享硬链接,这会直接污染源仓,"
            "还会销毁故障证据。只做只读诊断(git fsck --full、stat、ls);"
            "确认是环境故障就原样停下,把现象交给用户或平台处理。")
    if re.search(
        r"(?:^|[|&;]\s*)(?:chmod|chown)\b[^|&;]*-[a-zA-Z]*R[^|&;]*\.git\b",
        command):
        return _block(
            "bash-git-recursive-perms",
            "对 .git 递归改权限/属主被拦截:硬链接在场时会改到源仓同一"
            "inode。权限异常属于环境故障,交给平台的 ownership 机制处理。")
    git_commands = executed_git_invocations(command)
    if _git_clean_ignored(git_commands):
        return _absolute(
            "bash-git-clean-ignored",
            "危险命令拦截:git clean -x 会删除 ignore 文件(含 mae-flow 状态与令牌)，"
            "不可逆。改用精确路径删除真正要清的文件;确需整树清理，"
            "把命令和风险交给用户手动运行。")
    if context.state_active and context.user_scene_discards:
        return _block(
            "bash-discard-user-scene",
            "用户现场保护:%s 带着流程启动前就存在的未提交改动,本单 Agent 没有"
            "改写过它——丢弃它就是销毁用户自己的工作,与提交它进交付同样越界"
            "(carryover 拦截保护它不被卷进提交,这里保护它不被抹掉)。"
            "不要动它,让它保持原样;确要丢弃,把文件与改动内容摆给用户裁决。"
            % "、".join(context.user_scene_discards[:4]))
    if context.state_active and _git_wipes_worktree(git_commands):
        return _block(
            "bash-wipe-worktree",
            "全树不可逆清除拦截(git reset --hard / checkout -- .):未提交的"
            "工作区改动会全部蒸发。回退**本单 Agent 自己写**的文件可以精确到文件:"
            "git checkout HEAD -- <文件>;流程启动前就存在改动的文件一律不许动"
            "(那是用户现场);确需全树清除,把风险展示给用户裁决。",
        )
    if context.recursive_delete_targets:
        return _absolute(
            "bash-recursive-delete",
            "危险命令拦截:对「%s」的递归删除。确需执行请用户手动运行。"
            % context.recursive_delete_targets[0])
    return None


def decide_post_commit(context):
    advisory = None
    for evaluator in (
        _post_early,
        _post_repository,
        _post_dangerous,
    ):
        decision = evaluator(context)
        if decision is not None:
            if decision.rule in ADVISORY_TOOL_RULES:
                advisory = advisory or decision
            else:
                return decision
    return advisory or GateDecision("allow")
