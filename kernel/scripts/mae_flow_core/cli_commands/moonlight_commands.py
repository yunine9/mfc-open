"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    AGENT_WRITES_PATH, CapabilityError, EXIT_PATH, MOONLIGHT_INTENT_PATH,
    MOONLIGHT_REPAIR_ENTRY, MOONLIGHT_REPORT_PATH, MoonlightDeferPorts, STATE_PATH,
    activate_moonlight, atomic_write_json, atomic_write_text, defer_moonlight_quality,
    disable_moonlight, finalize_moonlight, json, load_json, os, prepare_project, re,
    read_text, record_blocker, record_push_failure, repair_moonlight,
    thaw_delivery_payload, time, validate_blocker,
    validate_finalize, validate_finalize_step, validate_push_failure,
)
from .wiring import api

def _moonlight_report_text(flow, st):
    ml = api._moonlight_data(st)
    cfg = st.get("config", {}) or {}
    branch = api.sh("git branch --show-current") or "未知"
    head = api.sh("git rev-parse --verify HEAD") or "未知"
    upstream = api.sh("git rev-parse --abbrev-ref --symbolic-full-name @{u}") or "未设置"
    unresolved = api._moonlight_unresolved(st)
    resolved = [x for x in (ml.get("issues") or []) if x.get("resolved_at")]
    lines = [
        "# 月光宝盒执行报告",
        "",
        f"- 单号：{cfg.get('单号', '未设置')}",
        f"- 工作流：{(st.get('choices', {}) or {}).get('workflow', '未选择')}",
        f"- 当前步骤：{st.get('current', '?')}",
        f"- 分支：{branch}",
        f"- HEAD：{head}",
        f"- 上游：{upstream}",
        f"- 启动时间：{ml.get('activated_at', '未知')}",
        f"- 最近推送：{ml.get('pushed_at', '尚未完成')}",
        f"- 无人值守轮次：{ml.get('cycle', 1)}",
        "",
        "## 启动需求原话",
        "",
        str(ml.get("request", "")).strip() or "旧状态未记录；以已确认需求文档和当前配置为准。",
        "",
        "## 当前结论",
        "",
    ]
    if st.get("current") == "moonlight_review":
        lines.append("夜间执行已经走到推送，规格尚未自动归档。")
    elif ml.get("hard_blocked"):
        lines.append("夜间执行遇到无法自行补齐的硬阻塞，已如实停在当前步骤，尚未推送。")
    else:
        lines.append("仍在执行中或尚未成功推送；可执行 moonlight report 随时刷新本报告。")
    lines += ["", "## 尚未解决的问题", ""]
    if unresolved:
        for x in unresolved:
            lines += [
                f"### {x.get('id', '?')} · {x.get('kind', '?')} · {x.get('step', '?')}",
                "",
                f"- 记录时间：{x.get('at', '')}",
                f"- 代码版本：{x.get('head', '')}",
                f"- 问题与已尝试处理：{x.get('reason', '')}",
            ]
            if x.get("rejection"):
                lines.append(f"- Harness 诊断：{x['rejection']}")
            if x.get("dirty_paths"):
                lines.append("- 未提交现场：" + "、".join(x["dirty_paths"]))
            lines.append("")
    else:
        lines += ["无。", ""]
    lines += ["## 已在后续复验中解决的问题", ""]
    if resolved:
        for x in resolved:
            lines.append(
                f"- {x.get('id', '?')} [{x.get('kind', '?')}] {x.get('reason', '')} "
                f"→ {x.get('resolved_at', '')} 已复验")
    else:
        lines.append("无。")
    lines += ["", "## 夜间推进记录", ""]
    activated = ml.get("activated_at", "")
    rows = [h for h in st.get("history", []) if not activated or h.get("at", "") >= activated]
    if rows:
        for h in rows:
            note = f"：{h.get('note')}" if h.get("note") else ""
            lines.append(f"- {h.get('at', '')} `{h.get('step', '?')}` {h.get('result', '')}{note}")
    else:
        lines.append("暂无。")
    lines += [
        "",
        "## 早晨操作",
        "",
        "- 继续修复遗留：`moonlight repair`",
        "- 重新查看报告：`moonlight report`",
        "- 结果满意并进入规格定稿：`moonlight finalize`",
        "",
        "报告位于 `.mae-flow-work/`，不会进入业务提交。",
    ]
    return "\n".join(lines).rstrip() + "\n"

def _write_moonlight_report(flow, st):
    os.makedirs(os.path.dirname(MOONLIGHT_REPORT_PATH), exist_ok=True)
    text = _moonlight_report_text(flow, st)
    atomic_write_text(MOONLIGHT_REPORT_PATH, text)
    return text

def _moonlight_latest_rejection(kind):
    try:
        data = load_json(STATE_PATH + ".agent-rejections")
    except Exception:
        return ""
    label = {"compile": "COMPILE", "codecheck": "CODECHECK", "ut": "UT"}.get(kind, "")
    rec = data.get(label, {}) if label else {}
    return str((rec or {}).get("reason", ""))[:1500]

def _new_state():
    api._gitignore()
    dirty = api._dirty_paths()
    atomic_write_json(AGENT_WRITES_PATH, {"paths": {}})
    return {
        "current": api.FLOW["start"], "config": {}, "choices": {},
        "history": [], "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        "initial_dirty": dirty,
        "initial_dirty_fingerprints": {p: api._path_fingerprint(p) for p in dirty},
    }

def _consume_preinit_moonlight_intent(ack):
    """消费 UserPromptSubmit Hook 在 STATE 创建前留下的一次性授权。

    仅接受十分钟内的记录，且命令携带的 ack 必须来自原始用户消息。这样既支持“一句话
    开启月光宝盒”，也不会把历史残留文件当成永久授权。
    """
    if not ack:
        return False, "命令未携带 --ack", ""
    try:
        rec = load_json(MOONLIGHT_INTENT_PATH)
    except Exception:
        return False, ("未捕获到本轮用户的月光宝盒授权。请让用户用普通消息明确说一次"
                       "“开启月光宝盒”，再执行本命令。"), ""
    try:
        age = time.time() - float(rec.get("epoch", 0))
    except Exception:
        age = 999999
    if age < -30 or age > 600:
        try:
            os.remove(MOONLIGHT_INTENT_PATH)
        except OSError:
            pass
        return False, "捕获到的月光宝盒授权已超过十分钟，请让用户重新明确授权。", ""

    def compact(value):
        return re.sub(r"\s+", "", value or "")

    text = rec.get("text", "")
    if not re.search(r"月光宝盒|moonlight", text, re.I):
        return False, "捕获的用户原话没有明确提到月光宝盒。", ""
    if compact(ack) not in compact(text):
        return False, "--ack 不在本轮用户原话中，禁止由 Agent 自行补授权。", ""
    decision = api._moonlight_activation_decision(text)
    if decision != "allow":
        return False, (
            "捕获的用户原话没有明确要求开启月光宝盒"
            + ("，且表达了拒绝/关闭意图。" if decision == "deny"
               else "；咨询、介绍或仅提到名称都不算授权。")), ""
    try:
        os.remove(MOONLIGHT_INTENT_PATH)
    except OSError:
        pass
    return True, "", text

def _moonlight_request_from_messages(st, ack):
    """从当前步骤捕获的真实用户消息中取出完整启动原话，供断点恢复。"""
    try:
        msgs = json.loads(read_text(STATE_PATH + ".usermsg") or "[]")
    except Exception:
        msgs = []
    needle = re.sub(r"\s+", "", ack or "")
    entered = api._step_entered_at(st)
    sid = st.get("current", "")
    for msg in reversed(msgs):
        text = msg.get("text", "")
        if (needle and needle in re.sub(r"\s+", "", text)
                and msg.get("at", "") >= entered
                and (not msg.get("step") or msg.get("step") == sid)):
            return text
    return ""

def _apply_moonlight_result(flow, st, result):
    if result.exit_code:
        api.die(result.stderr[0], result.exit_code)
    write_report = False
    show_current = False
    changed = False
    deferred = None
    for effect in result.effects:
        if effect.kind == "set_state":
            updated = thaw_delivery_payload(effect.payload)
            st.clear()
            st.update(updated)
            changed = True
        elif effect.kind == "write_report":
            write_report = True
        elif effect.kind == "print_current":
            show_current = True
        elif effect.kind == "advance_deferred":
            deferred = thaw_delivery_payload(effect.payload)
        else:
            raise RuntimeError(
                "unsupported moonlight effect: " + effect.kind)
    if changed:
        api.save_state(st)
    if write_report:
        _write_moonlight_report(flow, st)
    for line in result.stdout:
        print(line)
    if show_current:
        api.print_current(flow, st)
    return deferred

def _persist_moonlight_defer_issue(flow, st, updated):
    st.clear()
    st.update(updated)
    api.save_state(st)
    _write_moonlight_report(flow, st)

def _moonlight_build_defer_boundary(st):
    for evaluator in (
            api.ev_tasks_checked, api.ev_commit_tagged_after_entry):
        ok, why = evaluator({}, st)
        if not ok:
            return False, why
    return True, ""

def _moonlight_blocked(flow, st, args):
    can_block = api._moonlight_can_block(st["current"])
    step_kind = api._moonlight_step_kind(st["current"])
    validation = validate_blocker(
        st, can_block, args.reason or "", step_kind)
    if validation.exit_code:
        api.die(validation.stderr[0], validation.exit_code)
    result = record_blocker(
        st,
        can_block=can_block,
        step_kind=step_kind,
        reason=args.reason or "",
        head=api.sh("git rev-parse --verify HEAD"),
        dirty_paths=tuple(api._dirty_paths()[:100]),
        now=time.strftime("%Y-%m-%d %H:%M:%S"),
    )
    _apply_moonlight_result(flow, st, result)

def _moonlight_push_failed(flow, st, args):
    validation = validate_push_failure(st, args.reason or "")
    if validation.exit_code:
        api.die(validation.stderr[0], validation.exit_code)
    result = record_push_failure(
        st,
        reason=args.reason or "",
        head=api.sh("git rev-parse --verify HEAD"),
        now=time.strftime("%Y-%m-%d %H:%M:%S"),
    )
    _apply_moonlight_result(flow, st, result)

def _moonlight_finalize(flow, st, args):
    step_validation = validate_finalize_step(st)
    if step_validation.exit_code:
        api.die(step_validation.stderr[0], step_validation.exit_code)
    issues = api._moonlight_unresolved(st)
    ack_verified = (
        api._ack_verified(st, args.ack, exact=True)
        if issues and args.ack else (True, "")
    )
    validation = validate_finalize(st, args.ack, ack_verified)
    if validation.exit_code:
        api.die(validation.stderr[0], validation.exit_code)
    result = finalize_moonlight(
        st,
        ack=args.ack,
        ack_verified=ack_verified,
        head=api.sh("git rev-parse --verify HEAD"),
        now=time.strftime("%Y-%m-%d %H:%M:%S"),
    )
    _apply_moonlight_result(flow, st, result)

def cmd_moonlight(flow, st, args):
    action = args.action
    if action in ("on", "continue"):
        if not args.ack:
            api.die("开启月光宝盒必须携带用户原话: --ack \"用户要求无人值守开发的原话\"。", 2)
        resumed_from_direct = False
        authorized_preinit = False
        activation_request = ""
        if os.path.exists(EXIT_PATH) and st is None:
            # 直接开发模式的用户消息保存在退出记录中。允许 shell 只传“月光宝盒/moonlight”
            # 这个短词，但恢复函数仍使用捕获到的完整原文验真。
            try:
                rec = load_json(EXIT_PATH)
                needle = re.sub(r"\s+", "", args.ack or "")
                full_ack = next(
                    (m.get("text", "") for m in reversed(rec.get("direct_messages", []) or [])
                     if needle and needle in re.sub(r"\s+", "", m.get("text", ""))),
                    args.ack or "")
            except Exception:
                full_ack = args.ack or ""
            st = api._resume_direct_mode(full_ack)
            resumed_from_direct = True
            activation_request = full_ack
        if st is None:
            authorized_preinit, why, activation_request = _consume_preinit_moonlight_intent(args.ack)
            if not authorized_preinit:
                api.die("月光宝盒授权验真失败:" + why, 2)
            # 与 init 同一套前检:启动瞬间是无人值守唯一有人在场的时刻。跳过它,
            # node/git 缺失这类环境炸弹会留到凌晨 open 步才爆,整夜产出为零。
            try:
                prepare_project(os.getcwd())
            except CapabilityError as exc:
                api.die("插件运行时预检失败,月光宝盒未开启、未创建流程状态: %s。"
                    "请现在解决环境问题后重新发起。" % exc, 2)
            st = _new_state()
            api.save_state(st)
        # 一键入口允许 --ack 取本轮用户消息中的“月光宝盒/moonlight”短语，
        # 避免把整段需求塞进 shell；仍必须命中当前步骤后的真实用户输入。
        if not resumed_from_direct and not authorized_preinit:
            ok, why = api._ack_verified(st, args.ack, exact=False)
            if not ok:
                api.die("月光宝盒授权验真失败:" + why, 2)
            activation_request = _moonlight_request_from_messages(st, args.ack)
            decision = api._moonlight_activation_decision(activation_request)
            if decision != "allow":
                api.die("月光宝盒授权验真失败:用户原话没有明确要求开启无人值守模式"
                    + ("，且表达了拒绝/关闭意图。" if decision == "deny"
                       else "；咨询、介绍或仅提到名称都不算授权。"), 2)
        if flow["steps"].get(st.get("current", ""), {}).get("terminal"):
            # 上一单已交付完成:必须像 init 一样换单滚动。否则月光在终态(安全停点)上
            # 启用,整夜什么都不发生;授权已在旧状态的消息上验真通过,滚动后直接开新单。
            try:
                prepare_project(os.getcwd())
            except CapabilityError as exc:
                api.die("插件运行时预检失败，上一单状态仍保持可用：%s" % exc, 2)
            api._clear_auxiliary_state()
            api._append_history(st)
            os.replace(STATE_PATH, STATE_PATH + ".last")
            st = _new_state()
            api.save_state(st)
            print(f"[mae-flow] 上一单已完成,旧状态备份为 {STATE_PATH}.last;月光宝盒在新单上开启。")
        current = st.get("current")
        active_change_exists = False
        if current == "archive":
            change_name = (st.get("config", {}) or {}).get("CHANGE_NAME", "")
            from mae_flow_core import specengine
            active_change = (os.path.relpath(os.path.join(
                specengine._changes_dir(os.getcwd()), change_name))
                if change_name else "")
            active_change_exists = bool(
                active_change and os.path.isdir(active_change))
        result = activate_moonlight(
            st,
            ack=args.ack,
            request=activation_request,
            activated_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            history_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            head=(
                api.sh("git rev-parse --verify HEAD")
                if current in ("archive_confirm", "archive")
                else ""),
            active_change_exists=active_change_exists,
        )
        _apply_moonlight_result(flow, st, result)
        return

    if st is None:
        api.die("流程未初始化；开启新任务请先执行 moonlight on。", 2)
    if action == "report":
        text = _write_moonlight_report(flow, st)
        print(text, end="")
        print(f"\n[mae-flow] 报告已写入: {os.path.abspath(MOONLIGHT_REPORT_PATH)}")
        # 无人值守是转述断链的最坏场景:用户一整夜不在场,报告是他唯一的现场。
        # 与配置确认单同款纪律——内容进回复正文,不靠模型自觉摘要。
        print("⚠ 用户看不见工具输出:把报告中的「遗留问题」与「人工裁决」项"
              "**逐条复制进你的回复正文**,并附上面这个报告路径;"
              "只报'夜间已完成'而不列遗留,等于替用户签收了风险。")
        return
    if action == "off":
        enabled = api._moonlight(st)
        ack_verified = (
            api._ack_verified(st, args.ack, exact=False)
            if enabled and args.ack else (True, "")
        )
        result = disable_moonlight(
            st,
            ack=args.ack,
            ack_verified=ack_verified,
            now=time.strftime("%Y-%m-%d %H:%M:%S"),
        )
        _apply_moonlight_result(flow, st, result)
        return
    if action in ("repair", "finalize") and st.get("current") == "moonlight_review":
        # 晨间入口不依赖 enabled 标记:off 之后 done 在 moonlight_review 仍会指向
        # repair/finalize,若这里再要求"已开启"就形成互相踢皮球,用户没有出路。
        pass
    elif not api._moonlight(st):
        api.die("当前未开启月光宝盒。", 2)
    if action == "blocked":
        return _moonlight_blocked(flow, st, args)
    if action == "push-failed":
        return _moonlight_push_failed(flow, st, args)
    if action == "defer":
        sid = st["current"]
        kind = api._moonlight_step_kind(sid)
        reason = args.reason or ""
        result = defer_moonlight_quality(
            st,
            kind=kind,
            reason=reason,
            rejection=_moonlight_latest_rejection(kind),
            recheck="",
            ports=MoonlightDeferPorts(
                build_boundary=lambda: (
                    _moonlight_build_defer_boundary(st)),
                dirty_paths=lambda: tuple(
                    api._blocking_dirty_source_paths(st, flow)),
                head=lambda: api.sh(
                    "git rev-parse --verify HEAD"),
                now=lambda: time.strftime(
                    "%Y-%m-%d %H:%M:%S"),
                persist_issue=lambda updated: (
                    _persist_moonlight_defer_issue(
                        flow, st, updated)),
                ensure_step_entry=lambda: (
                    api._ensure_step_entry_head(
                        flow, st, sid)[1]),
                source_changes=lambda: (
                    api._business_source_changed_since_step(
                        st, sid)),
                state_after_entry=lambda: st,
            ),
        )
        deferred = _apply_moonlight_result(flow, st, result)
        if deferred:
            api.advance(
                flow, st, sid, flow["steps"][sid],
                "moonlight-deferred", deferred["issue_id"])
        return
    if action == "repair":
        issues = api._moonlight_unresolved(st)
        workflow = (st.get("choices", {}) or {}).get("workflow", "")
        target = MOONLIGHT_REPAIR_ENTRY.get(workflow)
        needs_head = bool(
            not api._moonlight_data(st).get("hard_blocked")
            and st.get("current") == "moonlight_review"
            and issues
            and target)
        result = repair_moonlight(
            st,
            repair_target=target,
            head=(
                api.sh("git rev-parse --verify HEAD")
                if needs_head else ""),
            now=time.strftime("%Y-%m-%d %H:%M:%S"),
        )
        _apply_moonlight_result(flow, st, result)
        return
    if action == "finalize":
        return _moonlight_finalize(flow, st, args)
    api.die("未知 moonlight 动作: " + action, 2)
