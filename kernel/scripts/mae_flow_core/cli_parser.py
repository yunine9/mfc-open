"""Command-line surface for the Mae-Flow driver.

Keeping the parser out of the state machine makes user-facing command growth
visible and prevents routing code from being buried under argparse plumbing.
"""

import argparse
import os
import sys


class MFParser(argparse.ArgumentParser):
    """Turn argument errors into copyable guidance for weaker models."""

    def error(self, message):
        me = os.path.abspath(sys.argv[0])
        print("[mae-flow] 参数错误: " + message, file=sys.stderr)
        print(
            "正确用法(高频三条,直接复制):\n"
            '  python3 "%s" current\n'
            '  python3 "%s" done [--choice 值] [--set 键=值]\n'
            '  python3 "%s" init\n'
            "其余子命令: status|panel|doctor|report|envcheck|skip|goto|unlock|allow|spec|template|"
            "lightcheck|accept-risk|moonlight|action|messages|config-review|requirement-record|"
            "story-localize|local-spec|domain-docs|domain-archive|manifest|"
            "pipeline|delivery|milestone|intervention|execution-plan|"
            "migrate-flow|exit"
            "(用法见 current/exit 指令)。\n"
            "注意:子命令不带连字符(是 current 不是 --current);"
            "done 的 --set 可重复,值含空格要加引号；"
            "高风险裁决先用 messages 取得回答 ID，再传 --message-id；"
            "不要把用户原话复制进 shell。"
            "**不要自己发明参数**:每条拦截/指引消息给出的命令都是完整可复制的,"
            "参数以它和 --help 为准;拼一个不存在的参数只会再撞一层错误。" % (me, me, me),
            file=sys.stderr)
        sys.exit(2)


def build_parser():
    """解析器工厂。单独成函数是为了让不变量测试能内省:
    拦截/指引消息里建议的每个命令参数,必须在这里真实存在——
    实战里模型被拒后去拼了 `allow --paths ...`,这个参数从来不存在,
    又撞一层参数错误。教出去的命令必须是真命令。"""
    parser = MFParser(prog="mae-flow")
    sub = parser.add_subparsers(dest="cmd", required=True)
    init = sub.add_parser("init")
    init.add_argument("--ack")
    init.add_argument(
        "--message-id",
        help="直接模式下 messages 输出的真实用户消息 ID，避免把长原话重新塞进 shell")
    init.add_argument(
        "--new", action="store_true",
        help="保留已退出的旧现场并开启另一轮流程；未指定时恢复原流程")
    sub.add_parser("current")
    execution_plan = sub.add_parser(
        "execution-plan",
        help="查看当前阶段采用的默认做法、资源和不可覆盖边界")
    execution_plan.add_argument(
        "--json", action="store_true",
        help="输出结构化执行方案，供 Cloud 工作台消费")
    intervention = sub.add_parser(
        "intervention", help="宿主登记用户接管后的代码现场（只回退，不放行质量证据）")
    intervention_actions = intervention.add_subparsers(
        dest="intervention_action", required=True)
    intervention_reconcile = intervention_actions.add_parser("reconcile")
    intervention_reconcile.add_argument("--file", required=True)
    intervention_reconcile.add_argument("--host-proof")
    delivery = sub.add_parser(
        "delivery", help="Cloud 宿主登记持续检视反馈或 MR 合入事实")
    delivery_actions = delivery.add_subparsers(
        dest="delivery_action", required=True)
    feedback_open = delivery_actions.add_parser("feedback-open")
    feedback_open.add_argument("--file", required=True)
    feedback_open.add_argument("--host-proof", required=True)
    feedback_result = delivery_actions.add_parser("feedback-result")
    feedback_result.add_argument("--file", required=True)
    feedback_result.add_argument("--host-proof", required=True)
    delivery_selection = delivery_actions.add_parser("selection-reconcile")
    delivery_selection.add_argument("--file", required=True)
    delivery_selection.add_argument("--host-proof", required=True)
    ticket_correction = delivery_actions.add_parser("ticket-correction")
    ticket_correction.add_argument("--file", required=True)
    ticket_correction.add_argument("--host-proof", required=True)
    delivery_close = delivery_actions.add_parser("close")
    delivery_close.add_argument("--reason", choices=("merged",), required=True)
    delivery_close.add_argument("--sha", required=True)
    delivery_close.add_argument("--event-id", required=True)
    delivery_close.add_argument("--host-proof", required=True)
    # 只读核对:Cloud 问"这份状态有没有宿主收据背书",裁决留在内核,
    # Cloud 侧不再抄一份核对逻辑。不需要 --host-proof:它不动状态、
    # 不消费 nonce,只读 Agent 够不着的信任根。
    delivery_attest = delivery_actions.add_parser("attest")
    delivery_attest.add_argument("--lifecycle", default="")
    delivery_attest.add_argument("--active-batch", default="")
    delivery_attest.add_argument("--feedback-loop", action="store_true")
    delivery_attest.add_argument("--snapshot-stdin", action="store_true")
    migrate = sub.add_parser(
        "migrate-flow",
        help="恢复命令：把 Lean v3 在途状态安全恢复到稳定流程")
    migrate.add_argument("--confirm", action="store_true")
    migrate.add_argument("--message-id")
    done = sub.add_parser("done")
    done.add_argument("--ack")
    done.add_argument("--choice")
    done.add_argument("--set", action="append")
    skip = sub.add_parser("skip")
    skip.add_argument("--reason")
    status = sub.add_parser("status")
    status.add_argument("--inject", action="store_true")
    gate = sub.add_parser("gate")
    gate.add_argument("what", choices=["edit", "bash"])
    gate.add_argument("arg")
    goto = sub.add_parser("goto")
    goto.add_argument("step")
    goto.add_argument("--force", action="store_true")
    goto.add_argument("--message-id", required=True)
    unlock = sub.add_parser("unlock")
    unlock.add_argument("what", choices=["source"])
    unlock.add_argument("--reason")
    unlock.add_argument("--message-id", required=True)
    risk = sub.add_parser("accept-risk")
    risk.add_argument(
        "agent", help="当前步骤报错中显示的 Agent 名称，如 compile/codecheck/ut")
    risk.add_argument("--reason", required=True)
    risk.add_argument("--message-id", required=True)
    spec = sub.add_parser("spec")
    spec_actions = spec.add_subparsers(dest="spec_action", required=True)
    spec_actions.add_parser("init")
    spec_actions.add_parser("show")
    spec_new = spec_actions.add_parser("new")
    spec_new.add_argument("value", nargs="?", help="变更目录英文短名")
    spec_instr = spec_actions.add_parser("instructions")
    spec_instr.add_argument(
        "value", help="change(v5 四合一,新单唯一入口) | "
                      "proposal | specs | design | tasks(旧布局在途单)")
    spec_actions.add_parser("validate")
    spec_actions.add_parser("archive")
    spec_set = spec_actions.add_parser("set")
    spec_set.add_argument("field", help="design_doc | plan | verification_report")
    spec_set.add_argument("value", help="产物真实路径（登记时校验存在）")
    spec_phase = spec_actions.add_parser("phase")
    spec_phase.add_argument("value", help="open|design|build|verify|archive")
    spec_verify_pass = spec_actions.add_parser("verify-pass")
    spec_verify_pass.add_argument(
        "--report", default="",
        help="可选:验证报告路径,等价于先执行 spec set verification_report")
    allow = sub.add_parser("allow")
    allow.add_argument(
        "block_id", help="gate 三振升级报错中给出的拦截编号(不要自行构造)")
    allow.add_argument("--message-id", required=True)
    moonlight = sub.add_parser("moonlight")
    moonlight.add_argument("action", choices=[
        "on", "continue", "off", "report", "push-failed",
        "defer", "blocked", "repair", "finalize"])
    moonlight.add_argument("--reason")
    moonlight.add_argument("--ack")
    exit_cmd = sub.add_parser("exit")
    exit_cmd.add_argument("--reason")
    exit_cmd.add_argument("--ack")
    exit_cmd.add_argument("--intent", help=argparse.SUPPRESS)
    exit_cmd.add_argument(
        "--interactive", action="store_true",
        help="Hook/ack 损坏时，由用户在真实终端输入 EXIT 的紧急出口")

    action = sub.add_parser("action")
    actions = action.add_subparsers(dest="action", required=True)
    action_start = actions.add_parser("start")
    action_start.add_argument("kind", choices=["ut", "codecheck", "grill"])
    action_start.add_argument("--request")
    action_start.add_argument("--source")
    action_start.add_argument("--files", action="append")
    action_start.add_argument("--build")
    action_start.add_argument("--generator")
    action_start.add_argument("--ut-command")
    action_start.add_argument("--check-only", action="store_true")
    confirm_scope = actions.add_parser("confirm-scope")
    actions.add_parser("status")
    critic = actions.add_parser("critic")
    critic.add_argument("--stage", choices=["prep", "final"], required=True)
    critic.add_argument("--document", required=True)
    finish = actions.add_parser("finish")
    finish.add_argument("--report")
    actions.add_parser("cancel")

    messages = sub.add_parser("messages")
    messages.add_argument("--full", action="store_true")
    messages.add_argument("--id")
    config_review = sub.add_parser("config-review")
    config_review.add_argument("--set", action="append", required=True)
    requirement = sub.add_parser("requirement-record")
    requirement.add_argument("--message-id")
    requirement.add_argument("--source")
    requirement.add_argument("--ticket")
    requirement.add_argument("--replace", action="store_true")
    reloaded = sub.add_parser("reloaded")
    reloaded.add_argument("--ack")
    doctor = sub.add_parser("doctor")
    doctor.add_argument(
        "--repair-state", action="store_true",
        help="仅修复损坏的辅助状态；绝不覆盖完整流程断点")
    sub.add_parser("envcheck")
    steps = sub.add_parser("steps")  # 工作流全景:各交付方式的步骤链与可裁环节
    steps.add_argument(
        "--json", action="store_true",
        help="机读目录(宿主用):交付方式代号/选项原文/步骤链。"
             "宿主的下单表单照它取选项,不要另抄一份分类")
    capability = sub.add_parser("capability")
    capabilities = capability.add_subparsers(
        dest="capability_action", required=True)
    cap_status = capabilities.add_parser("status")
    cap_status.add_argument("--codecheck", action="store_true")
    cap_status.add_argument(
        "--json", action="store_true",
        help="输出包含宿主契约能力的机读诊断")
    capabilities.add_parser("prepare")
    cap_openspec = capabilities.add_parser("openspec")
    cap_openspec.add_argument("arguments", nargs=argparse.REMAINDER)
    for action in (
            "comet-state", "comet-guard", "comet-handoff",
            "comet-archive", "comet-validate"):
        cap_comet = capabilities.add_parser(action)
        cap_comet.add_argument("arguments", nargs=argparse.REMAINDER)
    cap_codecheck = capabilities.add_parser("codecheck")
    cap_codecheck.add_argument(
        "--install", action="store_true",
        help="缺失时从公司内网仓库尽力安装")
    symbol_refs = sub.add_parser(
        "symbol-refs",
        help="全仓符号引用清单(含 XML/YAML/SQL 等编译器看不见的文件),改动收口用")
    symbol_refs.add_argument("symbols", nargs="+", help="要核对的符号,可多个")
    panel = sub.add_parser(
        "panel",
        help="交付现场只读面板(文档/变更/证据/建议);--json 输出结构化快照")
    panel.add_argument(
        "--json", action="store_true",
        help="只打印结构化快照,不生成 HTML;任何展示层都从这个出口取数")
    panel.add_argument(
        "--out", help="面板输出路径,默认 .mae-flow-work/panel.html")
    report = sub.add_parser("report")
    report.add_argument("--all", action="store_true")
    template = sub.add_parser("template")
    template.add_argument(
        "kind", nargs="?", default="story",
        choices=["story", "chain", "grill", "review"])
    story_localize = sub.add_parser("story-localize")
    story_localize.add_argument(
        "--ticket", required=True,
        help="用户选择不入库的 STORY 单号；把文档移入本地过程区")
    local_spec = sub.add_parser("local-spec")
    local_spec.add_argument(
        "local_spec_action", choices=("init", "validate", "show"))
    domain_docs = sub.add_parser("domain-docs")
    domain_actions = domain_docs.add_subparsers(
        dest="domain_docs_action", required=True)
    domain_context = domain_actions.add_parser("context")
    domain_context.add_argument("--term", action="append", default=[])
    domain_reconcile = domain_actions.add_parser("reconcile")
    domain_reconcile.add_argument("--domain", required=True)
    domain_reconcile.add_argument("--candidate", required=True)
    domain_reconcile.add_argument("--keyword", action="append", default=[])
    domain_actions.add_parser("show")
    domain_actions.add_parser("validate")
    domain_archive = sub.add_parser("domain-archive")
    archive_actions = domain_archive.add_subparsers(
        dest="domain_archive_action", required=True)
    archive_prepare = archive_actions.add_parser("prepare")
    archive_choice = archive_prepare.add_mutually_exclusive_group(required=True)
    archive_choice.add_argument("--domain")
    archive_choice.add_argument("--unchanged", action="store_true")
    archive_prepare.add_argument("--keyword", action="append", default=[])
    archive_prepare.add_argument("--adopt-existing", action="store_true")
    archive_actions.add_parser("show")
    archive_actions.add_parser("status")
    archive_apply = archive_actions.add_parser("apply")
    archive_apply_choice = archive_apply.add_mutually_exclusive_group(
        required=False)
    archive_apply_choice.add_argument("--message-id")
    archive_apply_choice.add_argument("--auto", "--moonlight-auto", dest="moonlight_auto", action="store_true")
    manifest = sub.add_parser("manifest")
    manifest_actions = manifest.add_subparsers(
        dest="manifest_action", required=True)
    manifest_set = manifest_actions.add_parser("set")
    manifest_set_choice = manifest_set.add_mutually_exclusive_group(
        required=True)
    manifest_set_choice.add_argument("--file", action="append")
    manifest_set_choice.add_argument("--unchanged", action="store_true")
    manifest_set.add_argument("--message")
    manifest_set.add_argument("--target", required=True)
    manifest_set.add_argument("--adopt-dirty", action="append", default=[])
    manifest_actions.add_parser("show")
    manifest_confirm = manifest_actions.add_parser("confirm")
    manifest_confirm_choice = manifest_confirm.add_mutually_exclusive_group(
        required=True)
    manifest_confirm_choice.add_argument("--message-id")
    manifest_confirm_choice.add_argument("--auto", "--moonlight-auto", dest="moonlight_auto", action="store_true")
    milestone = sub.add_parser(
        "milestone", help="记录 implementation.md 任务的观察进度（不参与门禁）")
    milestone_actions = milestone.add_subparsers(dest="action", required=True)
    for action_name in ("start", "complete", "block"):
        milestone_action = milestone_actions.add_parser(action_name)
        milestone_action.add_argument("--task", required=True)
        milestone_action.add_argument("--reason")
        milestone_action.set_defaults(json=False)
    milestone_show = milestone_actions.add_parser("show")
    milestone_show.add_argument("--json", action="store_true")
    milestone_show.set_defaults(task="", reason="")
    role_task = sub.add_parser("role-task")
    role_task.add_argument("role", choices=[
        "story-generate",
        "story-review",
        "grill-critic",
    ])
    role_task.add_argument("--stage", choices=["prep", "final"])
    role_task.add_argument("--document")
    role_task.add_argument("--feedback")
    lightcheck = sub.add_parser("lightcheck")
    lightcheck.add_argument(
        "--quiet", action="store_true",
        help="CLEAN/安全降级时静默；仅发现高置信问题才提示")
    pipeline = sub.add_parser("pipeline")
    pipeline_actions = pipeline.add_subparsers(dest="action", required=True)
    pipeline_record = pipeline_actions.add_parser("record")
    pipeline_record.add_argument(
        "--file", required=True,
        help="平台事实 JSON(云端宿主写):{sha, status, source?, url?}")
    pipeline_record.add_argument("--host-proof")
    pipeline_actions.add_parser("show")
    return parser


def parse_args(argv=None):
    return build_parser().parse_args(argv)
