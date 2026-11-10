"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    BashGateContext, BashWriteContext, EditGateContext, HERE,
    STATE_PATH, WRITEISH_STRONG, WRITEISH_WEAK, decide_bash_write,
    decide_commit_branch, decide_edit,
    decide_post_commit, decide_pre_commit, git_intent,
    guard_intent, os, re, replace, source_unlocked_for, sys, time,
    workflow_chosen,
)
from ..workflow.advisories import lightcheck_advisory, record_advisory
from mae_flow_core.foundation.worktree_intent import worktree_discard_paths
from .wiring import api
from ..workflow.authority import ADVISORY_TOOL_RULES, advisory_message


# Bash 侧内部状态保护清单(与 guard/gate.py 的 Edit 侧同一份名单)。
# workflow-profile.json 的 revision 是确定性 sha256,篡改后可重算自洽,
# 文件模式 0o440 只挡得住误操作——这条正则是"任务只执行这一份定格
# 方案"的唯一机器保证(2026-08-30 审计 P0-2)。v1 execution-profile
# 已整体退役并入 v2 supplements(2026-08-29,无存量窗口统一)。
# 测试按此常量断言。
INTERNAL_STATE_PATTERN = (
    r"\.mae-flow(\.json|-history\.jsonl|-need-reload|-defaults\.json)"
    r"|\.mae-flow-work/(?:moonlight-report\.md|"
    r"workflow-profile\.json|"
    r"(?:plugin-resources|repository-skills|host-skills)(?:/|$))")


def _hook_rule_message(rule, message):
    if os.environ.get("MAE_FLOW_HOOK_TRACE") == "1":
        return "[mae-flow-rule=%s]\n%s" % (
            rule or "absolute-policy", message)
    return message


def _die_rule(rule, message, st=None):
    if rule in ADVISORY_TOOL_RULES:
        _keep_advisory(st, rule, advisory_message(message))
        return
    api.die(_hook_rule_message(rule, message), 2)


def _die_decision(decision, st=None):
    _die_rule(getattr(decision, "rule", ""), decision.message, st)


def _advisory_lightcheck_before_commit(st, snapshot):
    """Check exact commit candidates; any timeout/crash remains non-blocking."""
    try:
        result = api._pending_lightcheck_scope(st, snapshot)
    except BaseException as exc:
        result = api._lightcheck_tool_error(
            "提交前轻量检查启动失败；已记录诊断，不阻断流程: " + str(exc))
        result["report_path"] = api._save_lightcheck_result(
            result, "提交前：异常安全降级")
    api._print_lightcheck_result(result, quiet=True)
    _keep_advisory(st, "lightcheck", lightcheck_advisory(result))


def _relay_hint(block_id):
    """告诉 Agent 怎么征求许可:编号必须写进问用户的那句话。

    授权验真只认"这条回答里有本次编号"——所以编号不能只印在报错里给 Agent 看,
    必须转述给用户。不说这一句,Agent 就会拿别处的同意来试,试不通再瞎猜参数
    (实战里它去传了 allow --paths,而这个参数不存在)。
    """
    return ("\n如需放行:用 AskUserQuestion 征求用户许可,"
            "**把放行编号 %s 原样写进问题正文**(选项照旧简短,如「允许」「不允许」),"
            "再执行 allow %s --message-id <那条消息的 ID>。"
            % (block_id, block_id))


def _keep_advisory(st, kind, message):
    """Non-blocking Gate signals must survive the exit-0 stderr black hole."""
    if not message:
        return
    try:
        record_advisory(
            STATE_PATH, (st or {}).get("current", ""), kind, message,
            time.strftime("%Y-%m-%d %H:%M:%S"))
    except Exception:
        pass

def _redirect_targets(c):
    """提取 >/>> 的真实落盘目标。fd 复制(2>&1)与空设备不算写文件。

    校准实锤:目标带引号(`> "src/a.c"`,Windows 习惯写法)曾整体逃逸捕获,
    源码保护与 specs 真相源双拦全部短路——引号形态必须同样捕获。"""
    out = []
    for m in re.finditer(
            r"""\d*>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>'"]+))""", c):
        t = (m.group(1) or m.group(2) or m.group(3) or "").strip()
        if not t or t.lower() in ("/dev/null", "nul"):
            continue
        out.append(t)
    return out

def _gate_edit(flow, st, sid, step, intent, jdie):
    p = intent.subject
    plugin_root = api.norm(os.path.abspath(os.path.join(HERE, ".."))).lower()
    decision = decide_edit(EditGateContext(
        path=p,
        step=sid or "",
        inside_plugin=api.norm(os.path.abspath(p)).lower().startswith(
            plugin_root + "/"),
        is_source=api._is_source_path(p, st, flow),
        source_unlocked=source_unlocked_for(st, sid),
        workflow_chosen=workflow_chosen(st),
    ))
    if decision.kind == "absolute":
        _die_decision(decision, st)
    if decision.kind == "block":
        jdie(decision.rule, decision.message)
    if decision.kind == "advisory":
        _keep_advisory(st, decision.rule, decision.message)
    sys.exit(0)


def _gate_bash_writes(flow, st, sid, step, intent, jdie):
    c = intent.subject
    toks = intent.tokens
    redirects = _redirect_targets(c)
    strong_write = bool(re.search(WRITEISH_STRONG, c, re.I))
    weak_write = bool(re.search(WRITEISH_WEAK, c, re.I))
    writeish = strong_write or weak_write or bool(redirects)
    source_toks = [t for t in toks if api._is_source_path(t, st, flow)]
    redirect_sources = [t for t in redirects if api._is_source_path(t, st, flow)]
    offenders = list(dict.fromkeys(
        redirect_sources + (source_toks if strong_write else [])))
    source_unlocked = source_unlocked_for(st, sid)
    decision = decide_bash_write(BashWriteContext(
        command=c,
        tokens=tuple(toks),
        writeish=writeish,
        hits_internal_state=guard_intent.hits_path(
            intent, INTERNAL_STATE_PATTERN),
        step=sid or "",
        offenders=tuple(offenders),
        source_unlocked=source_unlocked,
        workflow_chosen=workflow_chosen(st),
    ))
    if decision.kind == "absolute":
        _die_decision(decision, st)
    if decision.kind == "block":
        jdie(decision.rule, decision.message)
    if decision.kind == "advisory":
        print(decision.message, file=sys.stderr)
    sys.exit(0)


def cmd_gate(flow, st, args):
    # 全局安装只是提供能力，不代表用户授权接管当前仓库。没有状态时必须 fail-open；
    # 真正启用流程只认 init 创建的 .mae-flow.json。
    if st is None:
        sys.exit(0)
    sid = st["current"] if st else None
    step = flow["steps"].get(sid, {}) if st else {}
    # end 状态保留在主文件中是为了报告与下一单滚动，不代表流程门禁仍活跃。
    # Hook 主路由已整体旁路；这里再做一次 CLI 级防御，避免旧 Hook、手工 gate
    # 调用或并发终态迁移继续拦截普通开发。
    if step.get("terminal"):
        sys.exit(0)

    intent = guard_intent.parse_intent(args.what, args.arg)

    def jdie(rule, msg):
        # 裁决类规则统一走 break-glass 出口(放行令+三振熔断);绝对类仍用裸 die
        if rule in ADVISORY_TOOL_RULES:
            _keep_advisory(st, rule, advisory_message(msg))
            return
        api._gate_die(st, sid, rule, intent.subject, msg)
    # NTFS 不区分大小写:所有路径匹配一律 re.I
    if args.what == "edit":
        return _gate_edit(flow, st, sid, step, intent, jdie)
    if args.what == "bash":
        c = intent.subject
        git_command = args.arg
        # 按 token 匹配路径类 pattern:整串匹配时 `(^|/)src/` 对空格后的相对路径
        # (如 `sed -i ... src/main.c`)永远不命中
        toks = intent.tokens

        def hits_path(pat):
            return guard_intent.hits_path(intent, pat)

        internal_state = hits_path(
            r"(^|/)(\.mae-flow\.json(?:\.[\w-]+)*|"
            r"\.mae-flow-history\.jsonl|\.mae-flow-need-reload"
            r"|\.mae-flow-work/moonlight-report\.md)$")
        branch = intent.branch
        message_present, commit_message = (
            git_intent.git_commit_message(git_command))
        wanted = st["config"].get("分支名", "")
        add_paths, _add_force = api._git_add_pathspecs(
            git_command)
        context = BashGateContext(
            command=c,
            has_internal_state_path=False,
            branch_name=branch.name if branch else "",
            branch_creating=bool(branch.creating) if branch else False,
            step=sid or "",
            wanted_branch=wanted,
            base_branch=st["config"].get("基线分支", ""),
            ticket=st["config"].get("单号", ""),
            commit_message_present=message_present,
            commit_message=commit_message,
            current_branch="",
            add_paths=tuple(add_paths),
            recursive_delete_targets=
                guard_intent.recursive_delete_targets(intent),
            state_active=bool(st),
            # 带着用户流程启动前未提交改动的文件,被 checkout/restore 瞄准丢弃
            user_scene_discards=tuple(
                path for path in worktree_discard_paths(c)
                if api._unchanged_initial_dirty(path, st or {})),
        )
        pre = decide_pre_commit(context)
        if pre.kind == "absolute":
            _die_decision(pre, st)
        if pre.kind == "block":
            jdie(pre.rule, pre.message)
        # 不给头部步骤开天窗:decide_commit_branch 的 docstring 记载过
        # 实锤——无人值守跑到 workflow_select 时模型把三个提交全落在
        # 基线分支上,恰恰因为这里曾按步骤跳过。分支名还没定时纯函数
        # 本来就放行(wanted 为空),不需要任何步骤白名单。
        if message_present and wanted:
            context = replace(
                context,
                current_branch=api.sh("git branch --show-current"),
            )
            branch_decision = decide_commit_branch(context)
            if branch_decision.kind == "block":
                jdie(branch_decision.rule, branch_decision.message)
        post = decide_post_commit(context)
        if post.kind == "absolute":
            _die_decision(post, st)
        if post.kind == "block":
            jdie(post.rule, post.message)
        return _gate_bash_writes(flow, st, sid, step, intent, jdie)
    api.die("gate 用法: gate edit <路径> | gate bash <命令>")
