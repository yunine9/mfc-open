"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    HERE, REQ_SHA_MARKER, STATE_PATH, append_codecheck_event, atomic_write_text,
    cancel_standalone, codecheck_log_path, confirm_standalone_scope,
    core_archive_corrupt_action, core_load_action, finish_standalone, hashlib,
    inspect_standalone, os, prepare_standalone_critic, re, start_standalone,
    thaw_delivery_payload, time, validate_scope_confirmation,
    validate_standalone_start,
)
from .wiring import api

def cmd_action_start(flow, st, args):
    terminal_state = bool(
        st and flow.get("steps", {}).get(
            st.get("current", ""), {}).get("terminal"))
    current = api._load_action()
    kind = args.kind
    defaults = api._standalone_config(st if terminal_state else None)
    config = {
        "编译方式": args.build or defaults.get("编译方式", ""),
        "UT生成方式": args.generator or defaults.get("UT生成方式", ""),
        "UT运行命令": args.ut_command or defaults.get("UT运行命令", ""),
        "测试路径": defaults.get("测试路径", ""),
    }
    validation = validate_standalone_start(
        live_flow=st is not None and not terminal_state,
        current_action=current,
        kind=kind,
        config=config,
        request=args.request or "",
        has_source=bool(args.source),
        check_only=bool(args.check_only),
    )
    if validation.exit_code:
        api.die(validation.stderr[0], validation.exit_code)
    raw_files = api._action_files(args.files)
    inferred_scope = not bool(args.files)
    if kind in ("ut", "codecheck"):
        scoped_files = api._action_target_files(raw_files, kind, config, flow)
        if not scoped_files:
            label = "CodeCheck" if kind == "codecheck" else "UT"
            api.die("独立 %s 没有可执行的业务代码范围。请先定位文件，再用 --files 明确指定；"
                "不会自动扩大到全仓。" % label, 2)
    else:
        scoped_files = raw_files
    if terminal_state:
        # end 只是一份待归档的完成记录，不应冒充“在途流程”阻断独立任务。
        # 在所有参数/范围校验通过后再归档，避免一次无效 action start 改变状态。
        api._clear_auxiliary_state()
        api._append_history(st, outcome="已完成后开启独立任务")
        os.replace(STATE_PATH, STATE_PATH + ".last")
        print("[mae-flow] 上一单已交付完成并归档为 .mae-flow.json.last；"
              "现在启动独立任务，无需 exit。")
    api._git_local_runtime_ignore()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    # 同一秒内取消后重开同类任务也必须使用全新目录，避免旧任务卡/报告混入新现场。
    nonce = hashlib.sha256(("%s:%s" % (time.time_ns(), os.getpid())).encode()).hexdigest()[:8]
    action_id = f"{stamp}-{nonce}-{kind}"
    work_dir = os.path.abspath(os.path.join(
        ".mae-flow-work", "standalone", action_id))
    sources = api._action_request(
        {"id": action_id, "work_dir": work_dir},
        args.request or "",
        args.source or "",
    )
    result = start_standalone(
        live_flow=False,
        current_action=None,
        kind=kind,
        config=config,
        files=tuple(scoped_files),
        request=args.request or "",
        check_only=bool(args.check_only),
        action_id=action_id,
        created_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        expires_epoch=time.time() + 24 * 3600,
        work_dir=work_dir,
        base_head=api.sh("git rev-parse --verify HEAD"),
        sources=tuple(sources),
        inferred_scope=inferred_scope,
        scope_epoch=time.time(),
        scope_proposed_at=time.strftime("%Y-%m-%d %H:%M:%S"),
    )
    if result.exit_code:
        api.die(result.stderr[0], result.exit_code)
    action = None
    for effect in result.effects:
        if effect.kind == "save_action":
            action = thaw_delivery_payload(effect.payload)
            api._save_action(action)
        elif effect.kind == "show_scope":
            api._print_action_scope(
                action, bool(effect.payload.get("inferred")))
        elif effect.kind == "setup_grill":
            work = api._action_dir(action)
            prep = os.path.join(work, "grill-prep.md")
            clarification = os.path.join(work, "clarifications.md")
            action["grill"] = {
                "prep": prep,
                "clarifications": clarification,
                "questions_answered": 0,
            }
            api._save_action(action)
            print("[mae-flow] 独立需求质询已开启，不会进入设计或编码。")
            print("先定向阅读需求与相关代码，把八维检查和候选问题写入：%s" % prep)
            print(
                "备课工作表必须按模板结构填写"
                "(hook 会校验章节,自由发挥会被打回):%s"
                % os.path.abspath(os.path.join(
                    ".mae-flow-work", "plugin-resources", "assets",
                    "GRILL-PREP-TEMPLATE.md")))
            print(
                "随后一次只问用户一个问题，每次回答后先检查模糊词、"
                "新名词、矛盾和衍生边界，答案增量写入：%s"
                % clarification)
            print(
                '备课完成后执行 action critic --stage prep --document "%s" '
                "做第一次对抗检查。" % prep)
        else:
            raise RuntimeError(
                "unsupported standalone start effect: " + effect.kind)

def cmd_action_confirm_scope(flow, args):
    action = api._load_action()
    scope_receipt = (
        api._action_scope_receipt(action)
        if action else (False, {}, "")
    )
    ack_verified = (scope_receipt[0], scope_receipt[2])
    validation = validate_scope_confirmation(action, ack_verified)
    if validation.exit_code:
        api.die(validation.stderr[0], validation.exit_code)
    # 确认与执行可能跨会话；再次验证冻结路径仍存在且仍属于允许类型。
    files = api._action_files(action.get("files", []))
    files = api._action_target_files(
        files, action["kind"], action.get("config", {}), flow)
    result = confirm_standalone_scope(
        action=action,
        confirmation_receipt=scope_receipt[1],
        ack_verified=ack_verified,
        validated_files=tuple(files),
        now=time.strftime("%Y-%m-%d %H:%M:%S"),
    )
    if result.exit_code:
        api.die(result.stderr[0], result.exit_code)
    next_effect = None
    for effect in result.effects:
        if effect.kind == "save_action":
            action = thaw_delivery_payload(effect.payload)
            api._save_action(action)
        else:
            next_effect = effect.kind
    if next_effect == "run_standalone_codecheck":
        append_codecheck_event(
            os.getcwd(), action, "standalone.scope_confirmed", {
                "head": action.get("base_head", ""),
                "files": files,
                "message_id": scope_receipt[1].get("message_id", ""),
                "scope_sha256": scope_receipt[1].get(
                    "scope_sha256", ""),
            })
        result, err = api._run_codecheck(files, action, "standalone-scan")
        if err:
            # 独立模式也遵循建议型语义：工具版本/协议不可识别不等于代码失败。
            # 保存真实诊断后正常结束，避免同一不可靠插件把用户拖进重跑循环。
            report = os.path.join(api._action_dir(action), "codecheck-report.md")
            atomic_write_text(
                report,
                "# 独立 CodeCheck 结果\n\n"
                "状态：工具不可用或输出无法解析（建议项，不代表代码失败）\n\n"
                "检查文件：\n%s\n\n"
                "原始诊断：\n```\n%s\n```\n"
                % ("\n".join("- `" + x + "`" for x in files), err))
            action["quality"]["codecheck_scan"] = {
                "step": "standalone_codecheck", "head": action["base_head"],
                "count": None, "status": "TOOL_ERROR", "files": files,
                "pairs": [], "commands": [], "error": err,
                "log_path": codecheck_log_path(os.getcwd(), action),
                "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            append_codecheck_event(
                os.getcwd(), action, "standalone.scan_failed", {
                    "head": action.get("base_head", ""),
                    "files": files, "error": err,
                })
            api._save_action(action)
            work = api._archive_action(
                action, "tool-error",
                "CodeCheck 已真实尝试；工具不可用或输出无法解析，按建议项结束")
            print("[mae-flow] ⚠ 独立 CodeCheck 已真实尝试，但工具不可用或输出无法解析。")
            print("诊断已保留在 %s；本任务按建议项结束，不派修复 Agent，也不要求重跑。"
                  % api.norm(os.path.join(work, "codecheck-report.md")))
            print("[mae-flow] CodeCheck 详细日志: %s"
                  % api.norm(os.path.join(work, "codecheck-debug.md")))
            print("未启动完整流程，也没有修改或提交代码。")
            return
        scan = {
            "step": "standalone_codecheck", "head": action["base_head"],
            "count": result["total"], "files": files, "pairs": result["pairs"],
            "commands": result["commands"], "log_path": result.get("log_path", ""),
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        action["quality"]["codecheck_scan"] = scan
        api._save_action(action)
        if result["total"] == 0 or action.get("check_only"):
            report = os.path.join(api._action_dir(action), "codecheck-report.md")
            atomic_write_text(
                report,
                "# 独立 CodeCheck 结果\n\n检查文件：%d\n\n告警：%d\n\n命令：\n%s\n"
                % (len(files), result["total"],
                   "\n".join("- `" + x + "`" for x in result["commands"])))
            outcome = "clean" if result["total"] == 0 else "check-only"
            append_codecheck_event(
                os.getcwd(), action, "standalone.scan_completed", {
                    "head": action.get("base_head", ""),
                    "files": files, "count": result["total"],
                    "commands": result["commands"], "outcome": outcome,
                })
            work = api._archive_action(action, outcome, "机器首检完成")
            print("[mae-flow] 独立 CodeCheck 已完成：%d 条告警。报告：%s"
                  % (result["total"], api.norm(report)))
            print("[mae-flow] CodeCheck 详细日志: %s"
                  % api.norm(os.path.join(work, "codecheck-debug.md")))
            print("未启动完整流程，也没有修改或提交代码。")
            return
        append_codecheck_event(
            os.getcwd(), action, "standalone.scan_completed", {
                "head": action.get("base_head", ""),
                "files": files, "count": result["total"],
                "pairs": result["pairs"], "commands": result["commands"],
                "outcome": "repair-required",
            })
        print("[mae-flow] 首检发现 %d 条告警，开始专项修复。" % result["total"])
        print("[mae-flow] CodeCheck 详细日志: %s"
              % api.norm(codecheck_log_path(os.getcwd(), action)))
        return api._action_task_card(action, "codecheck")
    if next_effect == "create_task_card":
        return api._action_task_card(action, "ut")
    raise RuntimeError(
        "unsupported standalone confirmation effect: "
        + str(next_effect))

def cmd_action_critic(args):
    action = api._load_action()
    document = os.path.abspath(args.document or "")
    result = prepare_standalone_critic(
        action, document, os.path.isfile(document), args.stage)
    if result.exit_code:
        api.die(result.stderr[0], result.exit_code)
    payload = thaw_delivery_payload(result.effects[0].payload)
    return api._action_task_card(
        payload["action"], "grill", payload["stage"])

def cmd_action_status():
    action = api._load_action()
    result = inspect_standalone(action)
    for line in result.stdout:
        print(line)

def cmd_action_finish(args):
    action = api._load_action()
    kind = action.get("kind") if action else ""
    report = ""
    report_exists = False
    report_text = ""
    report_error = ""
    if kind == "grill":
        report = os.path.abspath(args.report or action.get("grill", {}).get("clarifications", ""))
        report_exists = os.path.isfile(report)
        if report_exists:
            report_text, _, report_error = api._read_text_source(
                report, normalize=False)
    result = finish_standalone(
        action=action,
        report_path=report,
        report_exists=report_exists,
        report_text=report_text,
        report_error=report_error,
    )
    if result.exit_code:
        api.die(result.stderr[0], result.exit_code)
    work = ""
    archived_report = ""
    grill_report = ""
    for effect in result.effects:
        if effect.kind != "archive_action":
            raise RuntimeError(
                "unsupported standalone finish effect: " + effect.kind)
        payload = thaw_delivery_payload(effect.payload)
        archived_report = payload.get("report", "")
        grill_report = payload.get("grill_report", "")
        work = api._archive_action(
            action, payload["outcome"], payload.get("note", ""))
    for line in result.stdout:
        if line == "report_after_archive":
            print("报告：" + (
                api.norm(archived_report) if archived_report else api.norm(work)))
        elif line == "grill_gaps_after_archive":
            print(
                "⚠ final critic 仍报告潜在遗漏，已保留在 %s；"
                "这是风险提示，不会卡住后续开发。"
                % (grill_report or work))
        else:
            print(line)

def cmd_action_cancel():
    action, err, _ = core_load_action()
    result = cancel_standalone(action, err)
    for effect in result.effects:
        payload = thaw_delivery_payload(effect.payload)
        if effect.kind == "archive_corrupt_action":
            work = core_archive_corrupt_action()
            print(
                "[mae-flow] 独立任务状态已损坏，但取消成功；"
                "坏现场保存在 %s。普通开发从未被它拦截。原因：%s"
                % (api.norm(work or "无"), payload["error"]))
        elif effect.kind == "archive_action":
            work = api._archive_action(
                action, payload["outcome"], payload.get("note", ""))
            print(
                "[mae-flow] 独立任务已取消，现场保留在 %s；"
                "代码未回滚，普通开发继续放行。" % api.norm(work))
        else:
            raise RuntimeError(
                "unsupported standalone cancel effect: " + effect.kind)
    for line in result.stdout:
        print(line)

def _captured_user_messages(st):
    return api._current_ack_messages(st or {})

def cmd_messages(st, args):
    """Show stable IDs and trusted answer fields instead of question metadata."""
    rows = _captured_user_messages(st)
    message_id = getattr(args, "id", None)
    if message_id:
        rows = [item for item in rows if item.get("id") == message_id]
    if not rows:
        if message_id:
            old = [
                item for item in api._all_ack_messages()
                if item.get("id") == message_id
            ]
            if old:
                api.die(
                    "消息 ID %s 已被 Hook 捕获，但它属于步骤 %s，当前是 %s；"
                    "旧步骤消息不能跨步骤复用。"
                    % (message_id, old[-1].get("step", "(未标步骤)"),
                       st.get("current", "")),
                    2)
            api.die("用户消息中不存在 ID %s；请先执行 messages 查看当前可用 ID。"
                % message_id, 2)
        why = api._out_of_scope_ack_reason(st)
        if why:
            api.die("当前步骤没有可复用的用户消息。" + why, 2)
        api.die("尚未捕获到任何用户消息。检查 UserPromptSubmit hook；"
            "不要重复执行同一条确认命令；AskUserQuestion 不回传时，"
            "让用户发送当前页面要求的普通确认消息即可恢复。", 2)
    print("[mae-flow] 当前步骤捕获到的用户消息（需求落盘请使用左侧 ID）:")
    for m in rows:
        text = re.sub(r"\s+", " ", m.get("text", "")).strip()
        health = api._text_corruption_reason(m.get("text", ""))
        preview = text if getattr(args, "full", False) else text[:100]
        print("  %s  %s  %s%s" % (
            m.get("id", "(旧记录无ID)"), m.get("at", "?"), preview,
            ("  ❌疑似乱码:" + health) if health else ""))
        extracted = [
            value for value in api._ack_candidates(m.get("text", ""))
            if value != re.sub(r"\s+", "", m.get("text", ""))
        ]
        if extracted:
            print("    提取答案: " + " | ".join(extracted))

def cmd_direct_messages(args):
    """Show Direct-mode prompts/answers that may authorize a safe re-entry."""
    rec = api._read_exit_record()
    rows = list(rec.get("direct_messages", []) or [])
    if getattr(args, "id", None):
        rows = [item for item in rows if item.get("id") == args.id]
    if not rows:
        api.die("退出后尚未捕获到用户消息。让用户直接发送恢复 Mae-Flow、"
            "执行 /mae-flow:mae-flow review-fix 或开启另一流程的真实请求；"
            "不要让 Agent 自行生成授权，也不要移动 .mae-flow.json.exited。", 2)
    print("[mae-flow] Direct 模式捕获到的用户消息：")
    for m in rows:
        text = re.sub(r"\s+", " ", str(m.get("text", "") or "")).strip()
        preview = text if getattr(args, "full", False) else text[:100]
        print("  %s  %s  %s" % (
            m.get("id", "(旧记录无ID)"), m.get("at", "?"), preview))
        extracted = api._trusted_answer_candidates(str(m.get("text", "") or ""))
        compact_raw = re.sub(r"\s+", "", str(m.get("text", "") or ""))
        extracted = [value for value in extracted if value != compact_raw]
        if extracted:
            print("    提取答案: " + " | ".join(extracted))
    if any(not item.get("id") for item in rows):
        print("旧记录没有消息 ID：请直接重新发送一次明确的恢复/换单请求，"
              "Hook 会生成 ID；不需要再点一轮“确认”。")
    print("恢复原流程：init --message-id <ID>")
    print("保留旧现场并开启另一流程：init --new --message-id <ID>")

def cmd_requirement_record(st, args):
    """从 Hook 捕获原文或已有文本文件生成统一 UTF-8 需求入口，并做写后回读校验。"""
    if (st or {}).get("current") != "config_confirm":
        api.die("requirement-record 只允许在配置确认阶段使用，避免后续偷偷更换需求依据。", 2)
    ticket = (args.ticket or (st.get("config", {}) or {}).get("单号", "")).strip()
    if not re.fullmatch(r"(?:REQ|DTS)\w+", ticket):
        api.die("--ticket 必须是有效的 REQ/DTS 单号。", 2)
    if bool(args.message_id) == bool(args.source):
        api.die("必须且只能选择 --message-id <messages输出的ID> 或 --source <文本文件>。", 2)

    source_desc = ""
    if args.message_id:
        rows = _captured_user_messages(st)
        matches = [m for m in rows if m.get("id") == args.message_id]
        if not matches:
            api.die("当前步骤不存在消息 ID %s。先执行 messages 查看；"
                "不要把中文原文复制进 shell 参数。" % args.message_id, 2)
        text = matches[-1].get("text", "")
        bad = api._text_corruption_reason(text)
        if bad:
            api.die("捕获的用户原话疑似已经乱码：" + bad
                + "。不要落盘；执行 doctor 检查 Hook 输入编码，或 `/mae-flow:mae-flow exit` 退出。", 2)
        source_desc = "用户消息 " + args.message_id
    else:
        src = os.path.abspath(args.source)
        text, enc, err = api._read_text_source(src, normalize=True)
        if err:
            api.die("需求材料无法安全转成文本：" + err, 2)
        source_desc = "%s（原编码 %s）" % (api.norm(src), enc)

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    path = os.path.join("docs", "req", "REQ-" + ticket + ".md")
    if os.path.exists(path) and not args.replace:
        api.die("目标已存在：%s。先查看内容；确认旧文件确实错误后加 --replace，禁止静默覆盖。" % path, 2)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    content = (
        "# 用户提供的原始需求\n\n"
        "来源：%s\n\n"
        "<!-- %s %s -->\n"
        "%s\n" % (source_desc, REQ_SHA_MARKER, digest, text)
    )
    atomic_write_text(path, content)
    ok, why = api._validate_requirement_document(path)
    if not ok:
        api.die("需求文件写后回读校验失败：" + why + "。文件保留供诊断，禁止进入下一阶段。", 2)
    print("[mae-flow] 需求原文已确定性写入 UTF-8 并通过指纹回读：%s" % api.norm(path))
    print("来源：%s" % source_desc)
    print("正文 SHA256：%s" % digest)
    print("请展示该文件全文让用户核对；确认后将「需求文档」配置为上述路径。")
