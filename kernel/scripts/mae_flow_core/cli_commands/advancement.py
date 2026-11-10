"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CONFIG_CONFIRM_ACK, EXIT_PATH, HISTORY_PATH, ORDER_PATH, json,
    load_order_facts, os, re, read_lines,
    read_text, resolve_order_workflow, review_status_count, review_statuses,
    sys, tempfile, time,
    workflow_advancement, workflow_transitions,
)
from uuid import uuid4

from .wiring import api
from mae_flow_core.foundation.git_excludes import append_local_excludes
from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core import host_env
from mae_flow_core.panel import notify
from mae_flow_core.workflow.build_scope import (
    build_scope_hint,
    maven_modules,
)
from mae_flow_core.workflow.execution_contract import (
    contract_for_state,
    effective_config_keys,
    uses_pipeline,
    validation_environment,
)


def _bounded_next(st, sid, nxt):
    if not nxt:
        api.die(
            f"步骤 {sid} 缺少可解析的下一步。语义恢复上下文未建立，"
            "已停止本次推进；请执行 current 查看恢复指令，禁止重复运行同一命令。",
            2)
    return nxt


def _host_transition_target(st, sid, target):
    if sid == "push" and host_env.pipeline_adjudicates(st):
        return "external_verify"
    if sid == "external_verify" and api._moonlight(st):
        return "moonlight_review"
    return target

def _gitignore():
    # Git resolves info/exclude for ordinary clones and linked worktrees alike.
    # Local runtime bookkeeping must never dirty the user's tracked .gitignore.
    gi = api.sh("git rev-parse --git-path info/exclude")
    # .mae-flow.json* 含 .tmp 原子写中间件与 .last 交付备份;历史账本单列(pattern 不覆盖)
    # openspec/config.yaml 是内置规格引擎读的本地脚手架(specengine_config 会读它),
    # 流程已不再创建或提交 OpenSpec change,它不该出现在用户的 git status 里。
    lines = [".mae-flow.json*", EXIT_PATH, HISTORY_PATH, ".mae-flow-work/",
             "openspec/config.yaml"]
    try:
        append_local_excludes(gi, lines)
    except OSError as exc:
        print("[mae-flow] 无法登记 Git 本地忽略规则（不阻断流程）：%s；请勿提交运行文件。" % exc,
              file=sys.stderr)

def _friction_from_log(st):
    """从 hook 日志统计本单起始时间之后的摩擦(gate 拦截/契约打回/hook 异常)。
    日志不可读返回空 dict(账本/报告按缺项处理,不阻塞)。"""
    gate = bounce = anom = 0
    try:
        log_path = os.path.join(tempfile.gettempdir(), "mae-flow-hook.log")
        for line in read_lines(log_path, errors="replace"):
            if line[:19] >= st.get("started", ""):
                if "end pretooluse rc=2" in line:
                    gate += 1
                elif "end subagentstop rc=2" in line:
                    bounce += 1
                elif "WATCHDOG" in line or "EXC" in line:
                    anom += 1
    except OSError:
        return {}
    return {"gate拦截": gate, "契约打回": bounce, "hook异常": anom}

def _append_history(st, outcome="completed"):
    """终态备份前把本单摘要追加进历史账本(团队度量/推广数据)。
    失败不阻塞开新单,但必须可见(stderr)。"""
    try:
        hist = st.get("history", [])
        ended = hist[-1]["at"] if hist else st.get("started", "")

        def ts(s):
            return time.mktime(time.strptime(s, "%Y-%m-%d %H:%M:%S"))

        rec = {"单号": st.get("config", {}).get("单号", "?"),
               "workflow": st.get("choices", {}).get("workflow", "?"),
               "结果": outcome,
               "开始": st.get("started", ""), "结束": ended,
               "耗时秒": int(max(0, ts(ended) - ts(st.get("started", ended)))),
               "goto次数": sum(1 for h in hist if str(h.get("result", "")).startswith("goto:")),
               "skip次数": sum(1 for h in hist if h.get("result") == "skipped"),
               "风险放行次数": sum(1 for h in hist if str(h.get("result", "")).startswith("accept-risk:"))}
        rec.update(_friction_from_log(st))
        with open(HISTORY_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[mae-flow] 历史账本写入失败(不影响流程): {e}", file=sys.stderr)

def advance(flow, st, sid, step, tag, note=""):
    # review 的增量边界由 harness 在进入裁决前冻结，后面任何模型都不能拿当前 HEAD 偷换基点。
    if sid == "branch_create" and st.get("choices", {}).get("workflow") == "review":
        base = api.sh("git rev-parse --verify HEAD")
        if not base:
            api.die("无法记录评审意见处理基点 HEAD,拒绝进入本轮修改；"
                    "请先执行 doctor 检查 Git 状态。", 2)
        st["review_base_head"] = base
    if sid == "rf_triage":
        review_doc = os.path.join(ensure_work_package(
            os.getcwd(), st.get("config", {}).get("单号", "")).root,
            "review.md")
        try:
            review_text = read_text(review_doc, errors="replace")
        except OSError as exc:
            print("提示（不阻断）: 无法读取评审文档快照: " + str(exc))
            review_text = ""
            st["review_snapshot_unavailable"] = str(exc)
        st["review_triage_statuses"] = review_statuses(review_text)
        st["review_triage_transfer_count"] = review_status_count(
            review_text, "转规格轮次(已确认)")
    st.pop("unlock", None)   # 源码解锁仅限本步实例,推进即失效
    st.pop("risk_acceptances", None)   # 风险放行同样只属于当前步骤实例
    st.pop("approval_subject", None)   # 清理旧版本遗留的审批指纹
    st.pop("user_intervention", None)  # 下一步已承接，避免旧介入说明反复刷屏
    st["history"].append({"step": sid, "result": tag, "note": note, "at": time.strftime("%Y-%m-%d %H:%M:%S")})
    try:
        for event in workflow_advancement.transition_events(
                flow, st, sid, step):
            if event.kind == "audit":
                st["history"].append({
                    "step": event.step,
                    "result": event.result,
                    "note": event.note,
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                })
            else:
                nxt = event.step
    except workflow_advancement.TransitionResolutionError as exc:
        api.die(f"月光旁路步骤 {exc.step_id} 缺少可解析的 moonlight_choice/next，拒绝卡死流程。", 2)
    nxt = _host_transition_target(st, sid, _bounded_next(st, sid, nxt))
    if api._moonlight(st) and sid == "push":
        api._moonlight_resolve_kind(st, "push")
        ml = api._moonlight_data(st)
        ml["pushed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        ml["pushed_head"] = api.sh("git rev-parse --verify HEAD")
    st["current"] = nxt
    if nxt:
        current_head = api.sh("git rev-parse --verify HEAD")
        st.setdefault("step_heads", {})[nxt] = current_head
        if nxt == "build" and not st.get("implementation_base_head"):
            st["implementation_base_head"] = current_head
    api.save_state(st)
    if api._moonlight(st) and nxt == "moonlight_review":
        api._write_moonlight_report(flow, st)
    print(f"[mae-flow] {sid} {tag} → 进入 {nxt}\n")
    _announce_and_sync_panel(flow, st, sid, nxt)
    api.print_current(flow, st)


def _announce_and_sync_panel(flow, st, sid, nxt):
    """每次推进都刷面板;通知只在"需要你裁决"与"跨入新阶段"两种时刻响。

    刷新与响铃解耦(实战:交付完成那一次推进既不跨阶段也不需要裁决,
    通知不响 → 面板不刷;而进入终态后 Hook 全旁路,再没有第二次机会,
    面板永远停在"推送分支")。一次 72ms,一单也就几十次,买"面板绝不
    显示与当前阶段不符的信息"这条红线,很划算。任何失败都静默。
    """
    rang = notify.announce(flow, sid, nxt, os.getcwd(),
                           st.get("config", {}).get("单号", ""))
    from mae_flow_core.cli_commands.panel import refresh as _panel_refresh
    panel_path = _panel_refresh(flow, st)
    # 面板路径只对"坐在这台机器前"的人有意义;云端控制台里用户看的是
    # 另一台机器,这条路径他打不开,而材料本来就在页面上。
    if rang and panel_path and host_env.user_on_this_machine():
        print("[mae-flow] 现场面板已同步(切回浏览器标签页即自动刷新): %s"
              % panel_path)

def _validated_pending_config(step, st, set_values):
    """Build and fully validate a candidate without touching confirmed config."""
    sid = st["current"]
    # 配置先在内存候选副本里完成全部校验；任何一步失败都不污染已确认状态。
    # 旧实现遇到需求路径不存在会先 save_state，导致下一轮继续携带半套/乱码配置。
    pending_config = dict(st.get("config", {}) or {})
    effective_keys = effective_config_keys(
        step, st, host_env.host_kind())
    allowed_sets = api._allowed_set_keys(step, st)
    for kv in set_values or []:
        if "=" not in kv:
            api.die(f"--set 需为 k=v 形式: {kv}")
        k, v = kv.split("=", 1)
        if k not in allowed_sets:
            api.die(f"当前步骤 {sid} 不允许写配置项「{k}」。已确认配置不能在后续步骤偷偷改写；"
                "确需调整请经用户确认 goto config_confirm 后修改。", 2)
        bad = api._validate_config_value(k, v)
        if bad:
            api.die(f"{k}「{v}」不合法:{bad}。", 2)
        pending_config[k] = v
    # 下单事实补缺省:云端表单收齐的三项(单号/基线分支/工号)机械落进
    # 候选——模型不必转述,也就没有"给了还问一遍"的机会(车道实战教训:
    # 靠 prompt 转述,弱模型会漏)。--set 显式给的赢:打回改口走 --set,
    # 用户改口永远压过下单时的值。同样过校验,坏值当场打回不静默。
    order_facts, order_warn = load_order_facts()
    if order_warn:
        print(order_warn)
    # 需求文档也可来自下单事实:跨仓拆单时宿主把人工检视过的方案文档
    # 落进工作区并在这里指路——不然方案只能塞进 prompt 正文,实测模型
    # 会把它当实施计划直接开写,跳过整个流程头部。
    for key in ("单号", "基线分支", "工号", "需求文档", "UT生成方式"):
        value = str(order_facts.get(key, "") or "").strip()
        if value and not pending_config.get(key) and key in allowed_sets:
            bad = api._validate_config_value(key, value)
            if bad:
                api.die(f"下单事实 {ORDER_PATH} 的 {key}「{value}」不合法:{bad}。", 2)
            pending_config[key] = value
    if pending_config.get("单号") and not pending_config.get("单号类型"):
        pending_config["单号类型"] = "feat" if pending_config["单号"].startswith("REQ") else "fix"
    # 需求文档:单号与需求完全解耦(单号只管 git 命名,需求只管做什么),内容对不对只有用户能判定,
    # 机器只拦"路径是假的"这一种硬错;"拿对文档"靠 config_confirm 的单独确认(展示摘录给用户核实)
    new_keys = [kv.split("=", 1)[0] for kv in (set_values or []) if "=" in kv]
    doc = pending_config.get("需求文档", "")
    if "需求文档" in new_keys and not os.path.exists(doc):
        api.die(f"需求文档「{doc}」不存在——路径必须真实可读。"
            "用户口述/粘贴的需求须先原文照录落盘(如 docs/req/REQ-<单号>.md)并经用户确认,再以该路径 --set。", 2)
    if doc and ("需求文档" in new_keys or sid == "config_confirm"):
        ok, why = api._validate_requirement_document(doc)
        if not ok:
            api.die(f"需求文档「{doc}」未通过严格文本校验:{why}。"
                "不要让用户重复说“我确认”，确认无法修复坏文件；"
                "用户口述用 messages + requirement-record --message-id，"
                "已有 GBK/UTF-16 文本用 requirement-record --source 规范化。", 2)
    if effective_keys:
        missing = [k for k in effective_keys if not pending_config.get(k)]
        if missing:
            remedy = ("用 --set 补齐；月光模式禁止询问用户，只能从本轮需求原话、仓库预设、"
                      "当前分支和代码事实中保守取得，不能编造"
                      if api._moonlight(st) else "用 --set 补齐;缺失项应询问用户")
            api.die("配置缺失,禁止推进: " + "、".join(missing) + "(" + remedy + ")", 2)
        if "基线分支" in effective_keys:
            derived_branch = "{基线分支}_{工号}_{单号}".format(**pending_config)
            bad = api._validate_config_value("分支名", derived_branch)
            if bad:
                api.die("脚本按基线分支、工号和单号生成的分支名「%s」不合法:%s。"
                    "请修正组成字段后重新确认，不能带着非法 ref 进入后续步骤。"
                    % (derived_branch, bad), 2)
            supplied_branch = pending_config.get("分支名", "")
            if supplied_branch and supplied_branch != derived_branch:
                api.die(
                    "分支名无需 Agent 拼接，脚本按基线分支、工号和单号确定生成。"
                    "收到的分支名「%s」与应为的「%s」不一致；删除该 --set 后重试。"
                    % (supplied_branch, derived_branch), 2)
            pending_config["分支名"] = derived_branch
    return pending_config

def _config_review_excerpt(path):
    try:
        text = read_text(path)
    except OSError:
        return ""
    lines = [re.sub(r"\s+", " ", line).strip()
             for line in text.splitlines() if line.strip()]
    return " / ".join(lines[:3])[:300]

def _root_pom_modules():
    """读根 pom 的子模块声明。读不到就返回空,提示自然不出现。"""
    try:
        return maven_modules(read_text("pom.xml", encoding="utf-8"))
    except OSError:
        return ()


def _print_config_review(review, step, st=None):
    pending = review.get("config") or {}
    contract_state = st or {
        "execution_contract": review.get("execution_contract")
    }
    effective_keys = effective_config_keys(
        step, contract_state, host_env.host_kind())
    print("[mae-flow] 完整配置确认单（收据 %s）" % review.get("id", "?"))
    for key in effective_keys:
        label = "UT 编写方式" if key == "UT生成方式" else key
        print("  %s: %s" % (label, pending.get(key, "")))
        if key == "编译方式":
            # 用户拍板编译命令的这一刻,是说"别整仓编译"的唯一合适时机。
            hint = build_scope_hint(
                pending.get(key, ""), _root_pom_modules())
            if hint:
                print(hint)
    if uses_pipeline(contract_state, host_env.host_kind()):
        print("  验证环境: %s（只读，由部署执行契约决定）" %
              validation_environment(contract_state, host_env.host_kind()))
    print("  分支名: %s" % pending.get("分支名", ""))
    excerpt = _config_review_excerpt(pending.get("需求文档", ""))
    if excerpt:
        print("  需求内容摘录: " + excerpt)

def cmd_config_review(flow, st, args):
    if st.get("current") != "config_confirm":
        api.die("config-review 只用于配置确认阶段。其他步骤的已确认配置不能偷偷改写；"
                "请执行 current 继续当前步骤。", 2)
    if api._moonlight(st):
        api.die("月光宝盒不询问用户，不需要 config-review；按 current 指令保守补齐配置后直接 done。", 2)
    step = flow["steps"]["config_confirm"]
    pending = _validated_pending_config(step, st, args.set or [])
    # 展示同一步配置不另起审批轮次；ID 只用于通知去重。
    review_id = (st.get("config_review") or {}).get("id") or uuid4().hex[:16]
    st["config_review"] = {
        "step": "config_confirm",
        "id": review_id,
        "config": pending,
        "head": api.sh("git rev-parse --verify HEAD"),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "execution_contract": contract_for_state(
            st, host_env.host_kind()),
    }
    api.save_state(st)
    api._ack_failure(st, success=True)

    _print_config_review(st["config_review"], step, st)
    # 确认单是这一刻当场打印出来的——产物就在眼前,现在叫人才准。
    # (进入 config_confirm 那一刻还没有单子,所以进门不响。)
    notify.announce_ready(flow, "config_confirm", os.getcwd(),
                          pending.get("单号", ""),
                          "config_confirm@" + review_id)
    # 面板路径并进确认单,搭"逐项复制进回复正文"的转述义务便车——
    # 实战验证过:单独一行"告诉用户"的指令会被模型跳过,进了卡就跳不过。
    local = host_env.user_on_this_machine()
    panel_page = os.path.abspath(os.path.join(".mae-flow-work", "panel.html"))
    if local and os.path.exists(panel_page):
        print("🖥 现场面板(浏览器打开一次,之后每到确认点自动刷新): %s"
              % panel_page)
    print("\n⚠ 用户看不见工具输出:先把上面的确认单**逐项复制进你的回复正文**"
          "(含分支名、需求摘录%s),再提问——只发一张没有配置内容"
          "的确认卡,用户无从确认。"
          % ("与现场面板路径" if local else ""))
    print("已有完整配置确认时直接沿用；尚未确认时用**一次** AskUserQuestion 问完开场决策"
          "（合并成一张卡，避免连着打断用户两次）：")
    print("Q1 上述完整配置是否正确？")
    print("  - " + CONFIG_CONFIRM_ACK)
    print("  - 需要修改")
    select_step = flow["steps"].get("workflow_select", {})
    order_wf = resolve_order_workflow(select_step, load_order_facts()[0])
    if order_wf:
        # 交付方式下单已选(下单事实):确认卡只问 Q1,不再重复问——
        # 这正是"车道被问两遍"的病根;用户要改口就选"需要修改"打回。
        label = (select_step.get("choice_answers", {}).get(order_wf)
                 or [order_wf])[0]
        print("Q2 不问:交付方式用户下单时已选定——%s(%s),"
              "随确认单一并转述给用户;要换就选「需要修改」打回。"
              % (label, order_wf))
        print("Q1 确认后 workflow_select 直接执行 done --choice %s,"
              "不再出卡提问。" % order_wf)
    workflow_options = [
        (key, (labels or [key])[0])
        for key, labels in (
            (flow["steps"].get("workflow_select", {})
             .get("choice_answers") or {}).items())
    ]
    if workflow_options and not order_wf:
        # 选档是全流程最贵的一次选择,却和"配置对不对"排在同一张卡里、长得
        # 一模一样,实战里被当例行公事点过去——然后小改动走了完整开发,
        # 多花三道前期工序。把代价现算出来摆在选项后面,并把"不能换道"
        # 说死:代价不对称,选重了纯亏,选轻了还能这轮交小的、大的另开一轮。
        print("Q2 交付方式？（**不给推荐、不排序、不加\"(推荐)\"**，"
              "照下面的顺序原样列出，让用户自己选；"
              "每项后面的代价必须一并转述给用户，用户看不见工具输出）")
        for key, label in workflow_options:
            cost = workflow_transitions.workflow_cost(flow, key)
            print("  - %s：%d 步，其中 %d 处要你拍板"
                  % (label, cost["steps"], cost["acks"]))
            if cost["unique"]:
                print("      与其他路不同的环节：" + "、".join(cost["unique"]))
        print("⚠ 一旦选定，本轮不能中途换道。选重了白走几道前期工序、"
              "多占你几次拍板；选轻了发现不够，这轮先把小的交付掉，"
              "大的另开一轮。编码、检视、提交、推送四条路都要走，"
              "轻的只是前期工序更少、验证形态更小，不是免检。")
        print("Q2 的答案由随后的 workflow_select 直接消费，那一步不再重复提问。")
    print("不要把前面多个单项回答拼成 ack，也不要再次调用 config-review。")
    print("用户选择确认后执行：")
    print('python3 "%s" done' % os.path.abspath(sys.argv[0]))
    print("若 AskUserQuestion 的选择结果未被宿主回传，让用户直接发送同一句普通消息后重试；"
          "无需退出或重新初始化。")
