"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CapabilityError, DEFAULTS_PATH, HERE, MOONLIGHT_QUALITY_STEPS, ORDER_PATH,
    STATE_PATH,
    STEPS_DIR, json, load_json, load_order_facts, os, re, read_text,
    render_pack, resolve_order_workflow, subst, sys,
    time, workflow_transitions,
)
from ..workflow.advisories import pending_advisories, render_advisories
from .wiring import api
from mae_flow_core import host_env
from mae_flow_core.workflow.execution_contract import (
    effective_config_keys,
    uses_pipeline,
    validation_environment,
)
from mae_flow_core.cli_commands.delivery_commands import render_delivery_feedback
from mae_flow_core.workflow.execution_plan import (
    build_execution_plan,
    load_workflow_profile,
    render_agent_execution_plan,
    render_workflow_supplements,
)
from mae_flow_core.cli_commands.user_intervention import render_user_intervention

def perms_line(step):
    """本步的写入范围提示——只陈述真实成立的事。

    步骤级源码授权 2026-08-28 退役(用户拍板"编码阶段自由"):交付链
    内编辑自由,完整性由头部纪律/绝对保护/提交侧范围闸把守。提示与
    机器裁决保持同一套语义——闸不拦的事,这里绝不再吓人(实锤:流水线
    修复 Agent 被"仅本步产物"一句话困在 external_verify 原地打转)。
    """
    scope = "源码与测试"
    if step.get("allow_specs_write"):
        scope += " + docs/specs/ 领域真相源"
    return "写入范围: " + scope

def _spec_data(st):
    """本单的交付登记(阶段与产物指针)。

    v3:阶段状态收归 .mae-flow.json 单一裁决源——此前它活在 comet 的 .comet.yaml 里,
    形成第二状态机:phase 掉队、僵尸 change、Bash 直写伪造、CRLF 双脑分裂全部源于此。
    现在与流程状态同文件、同一把锁、同一份 gate 保护,不需要哨兵对账。"""
    return st.setdefault("spec", {})

def _spec_phase(st):
    return str(_spec_data(st).get("phase", "") or "")

def _active_change_count():
    """在建区活跃 change 计数(排除 archive/ 与已归档)。>1 = 有历史残留未归档。"""
    from mae_flow_core import specengine
    return len(specengine._list_active_changes(os.getcwd()))

def _sentinel_lines(sid, st):
    """在建区残留诊断。阶段错位这一整类随 v3 消失(阶段与流程同源,不可能不一致)。"""
    out = []
    return out
    n = _active_change_count()
    if n > 1:
        out.append(f"⚠ 在建区有 {n} 个 change 目录(应只有当前单一个)。当前单为 "
                   f"{(st.get('config', {}) or {}).get('CHANGE_NAME', '?')},其余是历史残留——"
                   "做完没定稿的补定稿,废弃的经用户确认移除,以免规格产物混淆。")
    return out

def _next_from_step(step, st, choice_override=""):
    """解析步骤去向；月光旁路可显式指定其保守分支而不伪造用户选择。"""
    return workflow_transitions.next_step(step, st, choice_override)

def _resolved_next(flow, st, sid):
    """按当前 choices 解析某历史步骤的去向，供旧状态恢复入口 HEAD。"""
    return workflow_transitions.resolved_next(flow, st, sid)

def _ensure_step_entry_head(flow, st, sid):
    """为旧版在途质量步骤恢复入口 HEAD(月光 defer 仍用)。

    新版 advance 会直接记录精确 HEAD。旧状态只能从“上一阶段进入当前步骤”的历史时间反推，
    使用该时间之前最后一个 commit；时间同秒时最多多包含一笔旧改动，只会多验，不会漏验。
    绝不以当前 HEAD 兜底，因为当前 HEAD 可能已经包含 UT 阶段偷偷修改的源码。
    """
    old = (st.get("step_heads", {}) or {}).get(sid, "")
    if old and api.argv_out(["git", "cat-file", "-t", old]) == "commit":
        return old, ""
    entered_at = ""
    for h in reversed(st.get("history", [])):
        result = str(h.get("result", ""))
        if result == "goto:" + sid or _resolved_next(flow, st, h.get("step", "")) == sid:
            entered_at = h.get("at", "")
            break
    if not entered_at:
        return "", f"历史中找不到进入 {sid} 的转换记录"
    base = api.argv_out(["git", "rev-list", "-1", "--before=" + entered_at, "HEAD"])
    if not base or api.argv_out(["git", "cat-file", "-t", base]) != "commit":
        return "", f"无法按进入时间 {entered_at} 解析安全基点"
    st.setdefault("step_heads", {})[sid] = base
    st.setdefault("migrations", []).append({
        "type": "recover-step-head", "step": sid, "head": base,
        "from_history_at": entered_at, "at": time.strftime("%Y-%m-%d %H:%M:%S")})
    api.save_state(st)
    return base, ""

def _with_lightcheck_prompt(sid, text):
    if sid != "build":
        return text
    prompt = (
        "\n\n──── 轻量编码预防（建议层，不新增门禁） ────\n"
        "写每个函数时主动控制：正式入参≤5（Python self/cls 不计）、"
        "有效代码行≤50（空行/纯注释/仅括号分隔行不计）、控制结构最大嵌套深度≤5、"
        "本次新增/修改代码行≤120字符。长行禁止机械切字符串：优先仓库 formatter 配置，"
        "否则参考同文件附近同类参数列表/条件/链式调用的换行方式。\n"
        "提交 Hook 会自动执行轻量检查，无需主动调用或向用户展示 CLEAN 结果；"
        "只修 Hook 提示中高置信且属于本次范围的建议，最多修复并复查两轮。"
        "工具异常、超时、解析不确定或仅为基线旧债时直接留痕继续，"
        "不得扩大需求、不得让用户确认、不得把它当正式 CodeCheck。"
    )
    return text + prompt

def _build_execution_mode():
    """仓库预设「编码执行方式」: 主会话(默认) / 新上下文。"""
    defaults, _warn = _defaults()
    value = str((defaults or {}).get("编码执行方式", "") or "").strip()
    return "新上下文" if value in ("新上下文", "fresh", "fresh-context") else "主会话"


def _apply_build_execution_mode(sid, txt):
    """开启 L3 时把协议顶到 build 指令最前——它改变的是"谁来写码"这件根本事,
    埋在文末等于没说(弱模型读长文档,首段权重最高)。"""
    if sid != "build" or _build_execution_mode() != "新上下文":
        return txt
    protocol = os.path.join(
        ".mae-flow-work", "plugin-resources", "guidance",
        "build-fresh-context.md")
    banner = (
        "【本仓预设「编码执行方式: 新上下文」】本步改为:主 Agent **不写生产代码**,\n"
        "只按下述任务边界拆自包含工单、逐任务派实现子 Agent、逐份验收其 diff。\n"
        "**工单喂到嘴边,不给路径**:验收项原文、接口契约两栏逐字、文件清单与职责、\n"
        "必要的既有代码摘录全部内嵌;明令子 Agent 不读 spec/story/领域文档、\n"
        "不通读代码库、不探索式 grep——新鲜上下文是本模式唯一的资产,\n"
        "让它自己去读就是当场挥霍掉,写码时的注意力和主会话再无区别。\n"
        "协议全文(必读,含工单格式与退回条件): %s\n"
        "下文的判据、四项自查、跨块漂移、改动收口全部照常适用——它们是**验收标准**;\n"
        "工单写不成自包含的任务,回主 Agent 亲写。门禁与证据一个都不变。\n"
        "────────\n" % protocol)
    return banner + txt


def _step_md_text(sid, st):
    """步骤指令文本:模板路径与已确认配置全部替换后返回(无该 md 返回 None)。
    占位符替换 = 把"需要模型去拿"的信息直接喂到嘴边(弱模型会跳过"去拿"的动作);
    未确认的配置键保持 {原样},不误伤。"""
    md = os.path.join(STEPS_DIR, sid + ".md")
    if not os.path.exists(md):
        return None
    txt = read_text(md).rstrip()
    conditions = {
        "LOCAL_COMPILE": host_env.build_runs_locally(st),
        "PIPELINE_COMPILE": not host_env.build_runs_locally(st),
        "LOCAL_UT_RUN": host_env.unit_tests_run_locally(st),
        "PIPELINE_UT_RUN": not host_env.unit_tests_run_locally(st),
        "LOCAL_CODECHECK": host_env.codecheck_runs_locally(st),
        "PIPELINE_CODECHECK": not host_env.codecheck_runs_locally(st),
        "LOCAL_PUSH": host_env.git_push_runs_locally(st),
        "HOST_PUSH": not host_env.git_push_runs_locally(st),
        # 云端宿主没有"坐在终端前的用户":确认类指令走自动路径,
        # 人工裁决在工作台批注与 MR 检视(2026-08-25 编排瘦身)。
        "CLOUD_HOST": not host_env.user_on_this_machine(),
        "LOCAL_HOST": host_env.user_on_this_machine(),
    }
    for name, enabled in conditions.items():
        pattern = r"\{\{#%s\}\}(.*?)\{\{/%s\}\}" % (name, name)
        txt = re.sub(
            pattern, (lambda match: match.group(1) if enabled else ""),
            txt, flags=re.S)
    for ph, name in (("{STORY_TEMPLATE_PATH}", "STORY-TEMPLATE.md"),
                     ("{GRILL_PREP_TEMPLATE_PATH}", "GRILL-PREP-TEMPLATE.md"),
                     ("{REVIEW_TEMPLATE_PATH}", "REVIEW-TEMPLATE.md")):
        txt = txt.replace(ph, os.path.abspath(
            os.path.join(
                ".mae-flow-work", "plugin-resources", "assets", name)))
    txt = txt.replace("{MAEFLOW_PATH}", os.path.abspath(sys.argv[0]))
    txt = _apply_build_execution_mode(sid, txt)
    for pack in re.findall(r"\{\{CAPABILITY_PACK:([a-z0-9-]+)\}\}", txt):
        marker = "{{CAPABILITY_PACK:%s}}" % pack
        try:
            txt = txt.replace(marker, render_pack(pack))
        except CapabilityError as exc:
            api.die("插件内嵌能力包损坏，当前步骤不能可靠执行: %s。"
                "请升级/重装 Mae-Flow；流程状态尚未推进。" % exc, 2)
    return subst(_with_lightcheck_prompt(sid, txt), st)

def _defaults():
    """读仓库预设 .mae-flow-defaults.json。解析失败必须可见(fail-open 但可观测,不静默吞)。"""
    if not os.path.exists(DEFAULTS_PATH):
        return None, ""
    try:
        # utf-8-sig:Windows 编辑器手写的 JSON 常带 BOM,对无 BOM 文件无害
        return load_json(DEFAULTS_PATH, encoding="utf-8-sig"), ""
    except Exception as e:
        return None, f"⚠ {DEFAULTS_PATH} 解析失败,已忽略(修复该 JSON 或删除): {e}"

def print_current(flow, st):
    from .lean_migration import migrate_legacy_spec_workspace
    moved, note = migrate_legacy_spec_workspace(os.getcwd())
    if moved:
        st.setdefault("migrations", []).append({
            "type": "spec-workspace-relocated",
            "at": time.strftime("%Y-%m-%d %H:%M:%S")})
        api.save_state(st)
        print(note)
    sid = st["current"]
    step = flow["steps"][sid]
    workflow_profile, workflow_profile_warning = load_workflow_profile()
    try:
        execution_plan_text = render_agent_execution_plan(
            build_execution_plan(
                flow, st, workflow_profile=workflow_profile))
        execution_plan_warning = ""
    except Exception as exc:
        execution_plan_text = ""
        execution_plan_warning = (
            "⚠ 平台默认执行方案暂不可用，当前阶段仍按内核指令推进：%s" % exc)
    print(f"═══ 当前步骤: {sid} — {step['title']} ═══")
    if step.get("user_ack") or step.get("confirmation_answers"):
        print("人工确认沿用本步已记录的真实回答；实质变化由 Agent 说明，按既有授权继续，"
              "只有超出授权或需业务裁定才提问。不因内容指纹、提交或会话恢复重复索要确认。")
    if workflow_profile_warning:
        print(workflow_profile_warning)
    if execution_plan_warning:
        print(execution_plan_warning)
    if api._moonlight(st):
        ml = api._moonlight_data(st)
        print(f"🌙 月光宝盒运行中（第 {ml.get('cycle', 1)} 轮）：禁止询问用户；"
              "能从需求、代码和仓库规则判断的直接采用保守结论并留痕。")
        print("目标：尽力完成并推送当前分支。质量问题先真实修复；有限尝试后仍失败则登记遗留并继续，"
              "禁止伪装通过、删除测试、缩小测试范围或自动豁免。")
        print("覆盖规则：下方普通步骤文字里的“询问用户 / AskUserQuestion / 等用户拍板”在本模式下一律不执行。"
              "分析和配置从用户原话、仓库预设、当前分支及代码事实中保守推断；"
              "质量裁决拿不准时不得替用户选择豁免，走本步的 moonlight defer。")
        request = str(ml.get("request", "")).strip()
        if request:
            preview = request[:800] + ("…" if len(request) > 800 else "")
            print("──── 月光宝盒启动需求（已持久化，断点恢复以此为准） ────")
            print(preview)
        unresolved = api._moonlight_unresolved(st)
        if unresolved:
            print("──── 当前遗留（修复轮必须优先处理） ────")
            print(api._moonlight_issue_context(st))
    print("内核减权：以下模板、Agent 分工、文档归档和质量检查是工作建议。"
          "缺失或不一致要如实记录，交给 AI 与人检视，不阻断 done；"
          "不要为了内部凭证重复提问。用户决定、工作区权限与真实推送/流水线事实仍有效。")
    print(perms_line(step))
    intervention = render_user_intervention(st)
    if intervention:
        print(intervention)
    delivery_feedback = render_delivery_feedback(st)
    if delivery_feedback:
        print(delivery_feedback)
    for _w in _sentinel_lines(sid, st):
        print(_w)
    # 门禁放行时写的非阻断提示走不到模型(退 0 的 stderr 只给人看),在这里补送。
    notices = render_advisories(pending_advisories(
        STATE_PATH, sid, api._step_entered_at(st)))
    if notices:
        print(notices, end="")
    ul = st.get("unlock") or {}
    if ul.get("step") == sid:
        # 措辞不许暗示"没解锁的步骤是锁的"——步骤级源码闸已退役,
        # 交付链内改码本就自由;unlock 的实际效力只在流程头部。
        print(f"🔓 用户裁决已留痕: {ul.get('reason', '')}"
              "(流程头部的源码限制因此放行;推进后失效)")
    for kind, rec in sorted((st.get("risk_acceptances", {}) or {}).items()):
        if rec.get("step") != sid:
            continue
        valid, why = api._risk_acceptance(kind, st)
        if valid:
            print(f"⚠ 用户已承担 {kind} 令牌缺失风险，本步按放行继续；其他证据仍会检查。")
        else:
            print(f"⚠ {kind} 风险放行已失效: {why}；需要重新取证或重新让用户确认。")
    if step.get("clear_hint"):
        print("💡 会话卫生:本步开始前若会话已较长,建议 /clear 后说「继续」——状态在磁盘,进度不丢,防长上下文行为漂移。")
    if sid == "config_confirm" and not api._moonlight(st):
        print("⚠ 本步先收集配置值，再由 config-review 生成完整确认单。"
              "只有确认单后的最终回答能推进；基线分支、单号等局部回答不能代替整单确认。")
    elif step.get("user_ack") and not api._moonlight(st):
        print("⚠ 本步有真实用户决策:用 AskUserQuestion 呈现固定选项，用户点选后同轮直接 done。"
              "按钮结果由 harness 自动读取，不要再要求用户手动输入“确认××”；"
              "只有宿主确实不回传按钮结果时才退回一次纯文本选择。")
        answers = [
            str(value).strip()
            for value in step.get("confirmation_answers", [])
            if str(value).strip()
        ]
        if answers:
            print("   确认按钮标签必须原样使用：" + " / ".join(
                "「%s」" % value for value in answers))
            print("   另一个按钮必须明确表达需要修改；禁止缩写或改写上述确认按钮。")
    elif step.get("user_ack") and api._moonlight(st):
        print("🌙 本步原本需要用户确认，现由月光宝盒启动授权代替；禁止调用 AskUserQuestion。"
              "按最保守且不扩大需求的选项继续，并把决定写入阶段产物。")
    if step.get("terminal"):
        print("流程已完成。")
        txt = _step_md_text(sid, st)
        if txt:
            print(txt)
        if execution_plan_text:
            print(execution_plan_text)
        supplement = render_workflow_supplements(workflow_profile)
        if supplement:
            print(supplement)
        return
    txt = _step_md_text(sid, st)
    if txt is not None:
        print("──── 执行指令 ────")
        print(txt)
    if execution_plan_text:
        print(execution_plan_text)
    supplement = render_workflow_supplements(workflow_profile)
    if supplement:
        print(supplement)
    if api._moonlight(st) and sid in MOONLIGHT_QUALITY_STEPS:
        print("──── 尽力而为出口 ────")
        print("先真实执行本步并尝试修复；确认继续尝试只会重复消耗后，提交当前有效改动，然后执行：")
        print(f"python3 \"{os.path.abspath(sys.argv[0])}\" moonlight defer "
              "--reason \"<遗留现象、已尝试修复、当前风险>\"")
        print("该命令会把问题写入晨间报告并继续下一阶段，不会把失败伪装成通过。")
    if api._moonlight(st) and sid == "push":
        print("push 若因认证、网络或冲突在有限重试后仍失败，禁止询问或谎报成功；执行：")
        print(f"python3 \"{os.path.abspath(sys.argv[0])}\" moonlight push-failed "
              "--reason \"<错误原文和已尝试处理>\"")
        print("状态会停在 push，早晨修好远端问题后直接重新 push + done。")
    if api._moonlight(st) and api._moonlight_can_block(sid):
        print("若不是质量失败，而是需求材料、权限或外部依赖客观缺失，继续执行已无意义，执行：")
        print(f"python3 \"{os.path.abspath(sys.argv[0])}\" moonlight blocked "
              "--reason \"<缺失条件、已尝试确认、为什么无法继续>\"")
        print("它会生成晨间报告并允许本轮正常停止，不会让 Stop Hook 无限打回。")
    if sid == "moonlight_review":
        return
    if sid == "workflow_select":
        # 下单事实在场:交付方式用户下单时已选,这一步不出卡不提问——
        # "被问第二遍"的病根就在这儿,指令必须由内核自己说(prompt 转述
        # 靠不住,弱模型会漏,车道实战)。
        facts, order_warn = load_order_facts()
        if order_warn:
            print(order_warn)
        order_wf = resolve_order_workflow(step, facts)
        if order_wf:
            label = (step.get("choice_answers", {}).get(order_wf)
                     or [order_wf])[0]
            print(f"📌 交付方式已由下单事实选定({ORDER_PATH}):"
                  f"{label}({order_wf})。直接执行 done --choice {order_wf},"
                  "**不要**再用 AskUserQuestion 提问;用户要换道须回配置"
                  "确认卡打回改选。")
    config_keys = effective_config_keys(
        step, st, host_env.host_kind())
    if config_keys:
        dft, warn = _defaults()
        if warn:
            print(warn)
        facts, order_warn = load_order_facts()
        if order_warn:
            print(order_warn)
        order_show = {k: v for k, v in facts.items()
                      if k in config_keys and str(v).strip()}
        if order_show:
            print(f"──── 下单事实({ORDER_PATH},用户下单时已提供,"
                  "config-review 自动采用,**不要再问用户**) ────")
            for k, v in order_show.items():
                print(f"  {k} = {v}")
        show = {k: v for k, v in (dft or {}).items() if k in config_keys}
        if show:
            suffix = ("月光模式下须结合用户原话与仓库事实自行核验后 --set，不得询问或编造"
                      if api._moonlight(st) else
                      "候选值;缺项时只询问取值，最后随完整配置确认单一次确认")
            print(f"──── 仓库预设({DEFAULTS_PATH},{suffix}) ────")
            for k, v in show.items():
                print(f"  {k} = {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}")
        if uses_pipeline(st, host_env.host_kind()):
            print("──── 部署执行契约（只读，不需要用户填写） ────")
            print("  验证环境 = "
                  + validation_environment(st, host_env.host_kind()))
    print("──── 完成后执行 ────")
    if sid == "config_confirm" and not api._moonlight(st):
        review = st.get("config_review") or {}
        if isinstance(review.get("config"), dict):
            api._print_config_review(review, step, st)
            print("把上述确认单逐项复制进你的回复正文(用户看不见工具输出),"
                  "已有完整配置确认就沿用；尚未确认时只问一次，不拼接单项回答。")
            print('python3 "%s" done' % os.path.abspath(sys.argv[0]))
        else:
            sets = " --set ".join(
                key + "=<值>" for key in config_keys)
            print('python3 "%s" config-review --set %s' % (
                os.path.abspath(sys.argv[0]), sets))
            print("该命令会一次性校验并展示完整配置；用户最终确认后再执行它输出的简短 done 命令。")
        return
    extra = ""
    if step.get("choice_key"):
        extra += f" --choice <{'|'.join(step['choices'])}>"
    if config_keys:
        missing_sets = [
            k for k in config_keys
            if not (st.get("config", {}) or {}).get(k)
        ]
        if missing_sets:
            extra += " --set " + " --set ".join(k + "=<值>" for k in missing_sets)
    # python(非 python3:Windows 无此命令);abspath(非 relpath:跨盘符 relpath 抛 ValueError)
    print(f"python3 \"{os.path.abspath(sys.argv[0])}\" done{extra}")
    if step.get("skippable"):
        print(f"(可跳过: ... skip --reason \"<理由>\")")
