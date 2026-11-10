import re
"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    ACTION_PATH, EXIT_INTENT_PATH, EXIT_PATH, HISTORY_PATH, STATE_PATH,
    ensure_direct_mode_compat, hashlib, json, load_json, os, read_lines,
    remove_with_retry, save_versioned_json, shutil, sys, time,
)
from .wiring import api

def cmd_report_all():
    """聚合历史交付账本:每单一行 + 均值,团队度量/推广数据出口。无状态命令,无在途单也可用。"""
    if not os.path.exists(HISTORY_PATH):
        print("[mae-flow] 暂无历史交付记录(每单交付完成后开下一单时自动记账)。")
        return
    recs = []
    for line in read_lines(HISTORY_PATH, errors="replace"):
        try:
            recs.append(json.loads(line))
        except Exception:
            pass   # 坏行跳过,不因单行损坏丢整本账
    if not recs:
        print("[mae-flow] 账本为空或不可解析: " + HISTORY_PATH)
        return

    def fmt(sec):
        sec = int(sec)
        return f"{sec // 3600}h{sec % 3600 // 60:02d}m" if sec >= 3600 else f"{sec // 60}m{sec % 60:02d}s"

    print(f"{'单号':<16} {'workflow':<8} {'耗时':>7} {'gate拦':>5} {'打回':>4} {'goto':>4} {'风险':>4}  完成时间")
    for r in recs:
        print(f"{r.get('单号', '?'):<16} {r.get('workflow', '?'):<8} {fmt(r.get('耗时秒', 0)):>7} "
              f"{str(r.get('gate拦截', '-')):>5} {str(r.get('契约打回', '-')):>4} "
              f"{str(r.get('goto次数', '-')):>4} {str(r.get('风险放行次数', '-')):>4}  {r.get('结束', '?')}")
    n = len(recs)
    print(f"合计 {n} 单 · 平均耗时 {fmt(sum(r.get('耗时秒', 0) for r in recs) / n)}"
          f" · goto 总计 {sum(r.get('goto次数', 0) for r in recs)} 次"
          f" · 风险放行总计 {sum(r.get('风险放行次数', 0) for r in recs)} 次")

def cmd_reloaded(flow, st, args):
    """Backward-compatible no-op for scripts written before embedded runtime."""
    print("[mae-flow] 能力随插件直接加载，不再需要 reload。执行 current 继续。")

def _prepare_spec_for_goto(st, target):
    """Synchronize the embedded spec phase when a user-approved goto rewinds work."""
    if target not in ("open", "design"):
        return True, ""
    data = api._spec_data(st)
    phase = api._spec_phase(st)
    if not phase:
        return False, (
            "尚未初始化本单交付登记，不能直接 goto %s。"
            "请先回到对应的 open 步创建变更记录。" % target
        )
    if phase == "archived":
        return False, (
            "本单规格已经完成不可逆定稿，不能在同一轮 goto %s 回写。"
            "请开启新的修订轮次。" % target
        )
    desired = "open" if target == "open" else "design"
    if target == "open":
        clear = (
            "design_doc", "plan", "verification_report",
            "verify_result", "verified_at", "archived_to", "archived_at",
        )
    else:
        clear = (
            "design_doc", "plan", "verification_report",
            "verify_result", "verified_at",
        )
    removed = [key for key in clear if key in data]
    for key in clear:
        data.pop(key, None)
    previous = phase
    data["phase"] = desired
    workflow = (st.get("choices", {}) or {}).get("workflow", "")
    if workflow:
        data["workflow"] = workflow
    if previous == desired and not removed:
        return True, ""
    detail = "规格阶段 %s → %s" % (previous, desired)
    if removed:
        detail += "，作废下游登记 " + "、".join(removed)
    return True, detail

def cmd_goto(flow, st, args):
    if not args.force:
        api.die("goto 是人工修复通道,必须 --force。")
    ok, authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("goto 授权验真失败:" + why
            + "。证据不足应修证据或重跑 Agent，禁止用 goto 绕过关卡。", 2)
    if args.step not in flow["steps"]:
        api.die("未知步骤: " + args.step)
    source = st.get("current", "")
    branch_context = source == "branch_create" or args.step == "branch_create"
    branch_adoption = (
        branch_context and api._branch_adoption_requested(authorization))
    if args.step == source and not branch_adoption:
        api.die("当前已经在步骤 %s；同一步 goto 不会修复任何证据，反而会让本步旧授权失效。"
            "请按 current 的补救指引处理。若是在 branch_create 明确沿用现有分支，"
            "用户原话必须包含“沿用/在当前（现有）分支继续”。" % source, 2)
    notes = []
    if branch_adoption:
        adopted, detail = api._adopt_current_branch(
            st, authorization)
        if not adopted:
            api.die("沿用现有分支失败:" + detail, 2)
        notes.append(detail)
    elif args.step == "branch_create":
        # A fresh branch attempt must not inherit a previous branch exception.
        st.pop("branch_resolution", None)
    if source == "branch_create" and args.step != "branch_create":
        branch_ok, branch_why = api.ev_branch_ok({}, st)
        if not branch_ok:
            api.die(
                "goto 不能只跳过 branch_create：后续提交和推进仍会校验本单分支。"
                + branch_why
                + " 若用户决定保留现有非基线分支，请让原话明确包含"
                  "“在现有分支上继续”，再执行本次 goto；系统会同步登记分支裁决。",
                2)
    workflow = (st.get("choices", {}) or {}).get("workflow", "")
    if args.step == "design" and workflow in ("hotfix", "tweak"):
        st.setdefault("choices", {})["workflow"] = "full"
        notes.append("工作流 %s → full（进入方案设计即完成升级）" % workflow)
    spec_ok, spec_note = _prepare_spec_for_goto(st, args.step)
    if not spec_ok:
        api.die("goto 转移准备失败:" + spec_note, 2)
    if spec_note:
        notes.append(spec_note)
    if args.step == "config_confirm":
        st.pop("branch_resolution", None)
    if args.step in {
            "config_confirm", "workflow_select",
            "branch_create", "grill_ask",
            "grill", "open", "design", "story_ask", "story",
            "hf_open", "tw_open", "rf_triage",
            "build"}:
        st.pop("implementation_base_head", None)
    st.pop("unlock", None)   # 跳转同样使解锁失效
    st.pop("risk_acceptances", None)
    st.pop("config_review", None)
    st["history"].append({"step": st["current"], "result": "goto:" + args.step,
                          "note": (
                              "；".join(notes) if notes else "manual")
                          + "；message-id:"
                          + authorization_receipt["message_id"],
                          "at": time.strftime("%Y-%m-%d %H:%M:%S")})
    st["current"] = args.step
    st.setdefault("step_heads", {})[args.step] = api.sh("git rev-parse --verify HEAD")
    api.save_state(st)
    for note in notes:
        print("[mae-flow] goto 同步处理：" + note)
    api.print_current(flow, st)

def cmd_unlock(flow, st, args):
    """用户裁决通道。步骤级源码闸 2026-08-28 退役后,unlock source 的
    实际效力只剩一种:流程头部(交付方式未选定)经用户裁决提前放行
    源码修改;交付链内改码本就自由,此时执行只是留痕。仅本步有效,
    done/goto 自动失效。不是绕过 gate 的后门:message-id 必须指向
    本步骤捕获的真实用户裁决。"""
    if not args.reason:
        api.die("unlock 必须 --reason 说明裁决结论(如\"SUSPECTED_BUG#1 确认为代码缺陷\"),留痕供审计。", 2)
    ok, _authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("unlock 授权验真失败:" + why, 2)
    sid = st["current"]
    step = flow["steps"][sid]
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    st["unlock"] = {
        "scope": args.what,
        "step": sid,
        "at": now,
        "reason": args.reason,
        "authorization": authorization_receipt,
    }
    st["history"].append({"step": sid, "result": "unlock:" + args.what, "note": args.reason, "at": now})
    api.save_state(st)
    print(f"[mae-flow] 裁决已留痕(本步 {sid},推进后失效)。流程头部的"
          "源码修改因此放行;交付链内改码本就自由,无需 unlock。"
          "修复并自查后按本步指引继续,推送前验证与权威流水线会复验。")

_MAX_LISTED_DIRTY = 40


def _print_exit_preview(flow, st):
    sid = st.get("current", "?")
    title = (flow.get("steps", {}).get(sid, {}) or {}).get("title", "未知步骤")
    branch = api.sh("git branch --show-current") or "(无法读取)"
    head = api.sh("git rev-parse --short HEAD") or "(无法读取)"
    dirty = api._dirty_paths()
    print("[mae-flow] 准备退出流程（尚未执行）")
    print("  当前步骤: %s — %s" % (sid, title))
    print("  当前分支/HEAD: %s / %s" % (branch, head))
    # 全量 join 会拼出一行几万字符:_dirty_paths 用的是 --untracked-files=all,
    # 仓里没忽略 node_modules 时实测 3000 个文件拼成 105000 字符的一行。
    # 这里是给人看的退出预览,截断无害——但要说出来,不然看着像"就这几个"。
    shown = "、".join(dirty[:_MAX_LISTED_DIRTY])
    if len(dirty) > _MAX_LISTED_DIRTY:
        shown += "…（共 %d 个，另有 %d 个未列出）" % (
            len(dirty), len(dirty) - _MAX_LISTED_DIRTY)
    print("  未提交文件: %s" % (shown if dirty else "无"))
    print("  退出会保留全部代码、提交和文档，不回滚、不删除业务文件。")
    print("  退出后按普通开发处理，不再强制执行本流程的编译、CodeCheck、UT、归档和提交检查。")
    print("  若之后明确重新接回 mae-flow，会恢复原断点；源码变过则回退质量链，旧质量结果不会复用。")

def cmd_exit(flow, st, args):
    """保留现场并解除项目接管；确认链损坏时仍必须有独立出口。"""
    if flow.get("steps", {}).get(st.get("current", ""), {}).get("terminal"):
        # end 已经由 Hook 全面旁路，保留主状态是为了报告和下一单 init 自动
        # 滚动。终态再转 Direct 不增加自由，只会让下一次启动多一道 message-id
        # 授权；即使 Agent 忽略 Hook 提示又调用裸 CLI，也必须幂等成功。
        print("[mae-flow] 流程已经完成且 Hook 门禁已解除，无需再次退出；"
              "终态记录会保留给 current/status/report 和下一单自动滚动。"
              "不要执行 exit --interactive。")
        return
    ack = args.ack or ""
    reason = args.reason or ""
    auth = "ack"

    intent_arg = getattr(args, "intent", None)
    interactive = bool(getattr(args, "interactive", False))
    # Hook 级退出受 12 秒看门狗约束，不能先跑可能很慢的 git status 预览；
    # 用户已经通过本条明确命令授权，退出后完整现场仍会落盘。
    if not intent_arg:
        _print_exit_preview(flow, st)
    if intent_arg:
        try:
            intent = load_json(EXIT_INTENT_PATH)
        except Exception as exc:
            api.die("退出事件凭据不可读或已消费：%s。不要循环重试；"
                "用户可在真实终端执行 exit --interactive。" % exc, 2)
        valid = (
            intent.get("id") == intent_arg
            and intent.get("step") == st.get("current")
            and time.time() - float(intent.get("epoch", 0)) <= 30
            and intent.get("sha256") == hashlib.sha256(
                str(intent.get("text", "")).encode("utf-8")).hexdigest()
        )
        try:
            os.remove(EXIT_INTENT_PATH)
        except OSError:
            pass
        if not valid:
            api.die("退出事件凭据已过期、步骤不符或内容损坏。重新发送 `/mae-flow:mae-flow exit`，"
                "或在真实终端执行 exit --interactive；不要再次要求用户说“我确认”。", 2)
        ack = str(intent.get("text", ""))
        reason = reason or "用户通过明确退出指令切换为普通开发"
        auth = "userprompt-hook"
    elif interactive:
        if not sys.stdin.isatty():
            api.die("exit --interactive 只允许用户在真实交互终端执行，Agent/Bash 管道不能代答。"
                "请把命令原样展示给用户手动运行。", 2)
        print("\n这是紧急逃生通道。请输入大写 EXIT 确认保留现场并解除 mae-flow 门禁：",
              end=" ", flush=True)
        if input().strip() != "EXIT":
            api.die("输入不匹配，未退出。", 2)
        ack = "TTY:EXIT"
        reason = reason or "用户通过真实终端紧急退出"
        auth = "interactive-tty"
    elif not ack:
        print("\n直接发送 `/mae-flow:mae-flow exit` 即可退出，UserPromptSubmit Hook 会把该用户事件作为授权，"
              "不再要求二次确认。")
        print("若 Hook 已损坏，请用户在真实终端手动执行：")
        print('python3 "%s" exit --interactive --reason "切换为普通开发"'
              % os.path.abspath(sys.argv[0]))
        return

    if auth == "ack":
        if not reason:
            api.die("exit 必须 --reason 记录为什么退出。也可让用户直接发送 `/mae-flow:mae-flow exit`。", 2)
        # 这话必须是"要退出"这件事本身的回答。实战撞过反例:用户回答交付方式时
        # 顺口写「选择 1（退出 Mae-Flow，直接开发）」,精确匹配照样对得上,于是
        # 一次正常答题把流程退掉了。判据不是猜"他是不是在答别的题",而是正向要求
        # 这条回答提到本次动作——与 allow 绑随机编号同一形状(退出没有编号,
        # 用动作名当标识)。
        from mae_flow_core.workflow.consent import (
            is_refusal, relates_to_action)
        if is_refusal(ack):
            api.die("用户这条回答不是同意退出(原话: %s)。"
                    "请重新征求明确许可。" % (ack or "(空)")[:60], 2)
        relevant = relates_to_action(
            api._current_ack_messages(st), ("退出", "exit"))
        if not relevant:
            api.die(
                "用户是在回答别的问题(原话: %s),这次问的不是要不要退出流程——"
                "别处的同意不能挪用到不可逆动作上。"
                "请让用户直接发送 `/mae-flow:mae-flow exit`,"
                "Hook 会把那次用户事件本身当作授权,无需二次确认。"
                % (ack or "(空)")[:60], 2)
        ok, why = api._ack_verified(st, ack, exact=True)
        if not ok:
            api.die("exit 对话授权验真失败:" + why
                + "。不要让用户重复确认；请直接发送 `/mae-flow:mae-flow exit`，"
                "或在真实终端执行 exit --interactive。", 2)

    # 兼容补丁尽力完成，但绝不能反过来把逃生通道卡死。退出标记仍会原子落盘；
    # 未发现 Comet Hook 通常表示它尚未初始化或没有项目级拦截。
    found, patched, errors = ensure_direct_mode_compat(os.getcwd())
    compat_warnings = list(errors)
    if api._active_change_count() > 0 and not found:
        compat_warnings.append(
            "存在在建规格但未发现旧版项目级 Comet Hook（新版本内嵌运行时下属正常现象）；"
            "若退出后仍被其他旧插件拦截，请更新或移除旧插件，不要运行 setup")

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    sid = st.get("current", "")
    st.pop("unlock", None)
    st.setdefault("history", []).append(
        {"step": sid, "result": "exited", "note": reason, "at": now})
    api.save_state(st)
    if auth != "userprompt-hook":
        api._append_history(st, outcome="用户主动退出")

    snapshot = api._unique_exit_dir(st)
    copied = api._snapshot_state_files(snapshot)
    record = {
        "version": 1,
        "status": "exited",
        "at": now,
        "reason": reason,
        "ack": ack,
        "authorization": auth,
        "step": sid,
        "title": (flow.get("steps", {}).get(sid, {}) or {}).get("title", ""),
        "ticket": (st.get("config", {}) or {}).get("单号", ""),
        "workflow": (st.get("choices", {}) or {}).get("workflow", ""),
        "head": api.sh("git rev-parse --verify HEAD"),
        "branch": api.sh("git branch --show-current"),
        "dirty_paths": ([] if auth == "userprompt-hook" else api._dirty_paths()),
        "dirty_paths_deferred": auth == "userprompt-hook",
        "snapshot": api.norm(snapshot),
        "comet_guard_paths": [api.norm(p) for p in found],
        "compat_warnings": compat_warnings,
    }
    api._write_json_atomic(os.path.join(snapshot, "exit-record.json"), record)
    api._clear_broken_exit_marker()
    save_versioned_json(EXIT_PATH, record, "exit")
    cleanup_errors = []
    state_removed = True
    for src, _ in copied:
        try:
            remove_with_retry(src)
        except OSError as exc:
            cleanup_errors.append("%s: %s" % (src, exc))
            if os.path.basename(src) == STATE_PATH:
                state_removed = False
    if not state_removed:
        # 运行模式裁决是「完整流程优先于退出标记」:主状态还在=门禁仍然生效。
        # 此时宣布"退出标记已生效"是谎报,用户会以为退了却继续被拦。
        api.die("退出未生效:主状态文件 %s 未能删除(可能被杀软/编辑器占用),完整流程门禁仍在。"
            "请关闭占用后重新发送 /mae-flow:mae-flow exit;现场已保存到 %s。清理失败明细: %s"
            % (STATE_PATH, api.norm(snapshot), "；".join(cleanup_errors)), 2)

    print("\n[mae-flow] 已退出流程。代码、提交和文档均已保留；流程现场已保存到 " + api.norm(snapshot))
    if patched:
        print("已让项目阶段门禁识别直接开发模式：" + "、".join(api.norm(p) for p in patched))
    if cleanup_errors:
        print("⚠ 部分附属状态文件未清理(退出已生效,不影响普通开发)：" + "；".join(cleanup_errors),
              file=sys.stderr)
    if compat_warnings:
        print("⚠ 退出兼容提示：" + "；".join(compat_warnings), file=sys.stderr)
    print("现在可以直接让 AI 修改代码或补 UT。后续质量检查由用户自行决定。")

def print_direct_mode_status():
    try:
        rec = load_json(EXIT_PATH)
    except Exception:
        rec = {}
    print("[mae-flow] 当前项目已退出流程，正在按普通开发方式工作。")
    print("退出时间: %s  原步骤: %s  原因: %s" %
          (rec.get("at", "?"), rec.get("step", "?"), rec.get("reason", "?")))
    print("现场保留在: " + rec.get("snapshot", ".mae-flow-work/exited/"))
    print("用户明确要求恢复或开启评审修复时，先执行 messages 取得真实消息 ID："
          "恢复原断点用 init --message-id <ID>；保留旧现场开启另一流程用 "
          "init --new --message-id <ID>。不同单并行时再另开 worktree。")

def cmd_runtime_doctor(runtime, args, state_error=""):
    """No-state diagnostic path: auxiliary corruption must never deadlock repair."""
    print("项目根(状态文件所在): " + os.getcwd())
    print("❌ 运行模式: corrupt（Hook 已 fail-open，普通改码不受阻）")
    for error in runtime.errors:
        print("   - " + error)
    if os.path.isfile(STATE_PATH):
        print("完整流程状态损坏。发送 `/mae-flow:mae-flow exit` 可保存坏现场并退出；"
              "Hook 同时损坏时由用户在真实终端执行 exit --interactive。")
        if getattr(args, "repair_state", False):
            api.die("完整流程状态包含唯一断点，doctor 不会自动覆盖。"
                "请使用独立 exit 逃生链保存现场。", 2)
        return
    if os.path.isfile(ACTION_PATH):
        print("独立任务控制指针损坏；普通开发已放行。"
              "可执行 doctor --repair-state 保存坏文件并清理指针。")
        if getattr(args, "repair_state", False):
            return api.cmd_action_cancel()
        return
    if os.path.isfile(EXIT_PATH):
        print("退出标记损坏；普通开发已放行，但重新接回流程前需要修复。"
              "可执行 doctor --repair-state 保存坏文件并重建退出标记。")
        if not getattr(args, "repair_state", False):
            return
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.abspath(os.path.join(
            ".mae-flow-work", "state-recovery", stamp))
        recovery, suffix = base, 2
        while os.path.exists(recovery):
            recovery, suffix = base + "-" + str(suffix), suffix + 1
        os.makedirs(recovery, exist_ok=False)
        bad = os.path.join(recovery, os.path.basename(EXIT_PATH) + ".bad")
        shutil.move(EXIT_PATH, bad)
        record = {
            "status": "exited",
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "reason": "doctor 修复损坏退出标记",
            "snapshot": "",
            "recovered_bad_marker": api.norm(bad),
        }
        api._clear_broken_exit_marker()
        save_versioned_json(EXIT_PATH, record, "exit")
        print("[mae-flow] 损坏退出标记已保存到 %s，并重建普通开发模式标记。" % api.norm(bad))
        return
    print("未找到可识别的 Mae-Flow 标记；可按未初始化项目处理。")

def cmd_exit_corrupt_state(args, state_error):
    """状态 JSON 已坏时的独立逃生口；不能要求先修好状态才能退出。"""
    intent_arg = getattr(args, "intent", None)
    interactive = bool(getattr(args, "interactive", False))
    ack, auth = "", ""
    if intent_arg:
        try:
            intent = load_json(EXIT_INTENT_PATH)
            valid = (
                intent.get("id") == intent_arg
                and intent.get("step") == "__corrupt_state__"
                and time.time() - float(intent.get("epoch", 0)) <= 30
                and intent.get("sha256") == hashlib.sha256(
                    str(intent.get("text", "")).encode("utf-8")).hexdigest()
            )
        except Exception:
            valid, intent = False, {}
        try:
            os.remove(EXIT_INTENT_PATH)
        except OSError:
            pass
        if not valid:
            api.die("流程状态已损坏，退出事件凭据也不可用。请在真实终端执行 exit --interactive。", 2)
        ack, auth = str(intent.get("text", "")), "userprompt-hook-corrupt-state"
    elif interactive:
        if not sys.stdin.isatty():
            api.die("状态已损坏；exit --interactive 只能由用户在真实终端执行。", 2)
        print("[mae-flow] 状态 JSON 已损坏（%s）。输入大写 EXIT 保留坏文件并解除门禁：" % state_error,
              end=" ", flush=True)
        if input().strip() != "EXIT":
            api.die("输入不匹配，未退出。", 2)
        ack, auth = "TTY:EXIT", "interactive-tty-corrupt-state"
    else:
        api.die("流程状态已损坏，普通 ack 无法可靠验真。请重新发送 `/mae-flow:mae-flow exit`；"
            "若 Hook 也异常，在真实终端执行 exit --interactive。原状态不会删除。", 2)

    found, patched, errors = ensure_direct_mode_compat(os.getcwd())
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    snapshot = api._unique_exit_dir({"config": {"单号": "corrupt-state"}})
    copied = api._snapshot_state_files(snapshot)
    record = {
        "version": 1, "status": "exited", "at": now,
        "reason": getattr(args, "reason", None) or "流程状态损坏后紧急退出",
        "ack": ack, "authorization": auth, "step": "__corrupt_state__",
        "state_error": str(state_error), "head": api.sh("git rev-parse --verify HEAD"),
        "branch": api.sh("git branch --show-current"), "snapshot": api.norm(snapshot),
        "comet_guard_paths": [api.norm(p) for p in found], "compat_warnings": errors,
    }
    api._write_json_atomic(os.path.join(snapshot, "exit-record.json"), record)
    api._clear_broken_exit_marker()
    save_versioned_json(EXIT_PATH, record, "exit")
    leftovers = []
    for src, _ in copied:
        try:
            remove_with_retry(src)
        except OSError:
            leftovers.append(src)
    print("[mae-flow] 状态虽已损坏，但逃生成功；坏状态完整保存在 %s。现在按普通开发处理。"
          % api.norm(snapshot))
    if leftovers:
        # 损坏态 Hook 本就 fail-open,残留只影响提示横幅;但必须让用户知道文件还在。
        print("⚠ 以下坏状态文件被占用未能删除(不拦普通开发,稍后可手动清理): "
              + "、".join(api.norm(p) for p in leftovers), file=sys.stderr)
    if patched:
        print("已同步放行项目阶段门禁：" + "、".join(api.norm(p) for p in patched))
    if errors:
        print("⚠ 兼容提示：" + "；".join(errors), file=sys.stderr)
