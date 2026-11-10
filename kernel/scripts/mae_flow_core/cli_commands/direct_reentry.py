"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CapabilityError, EXIT_PATH, STATE_PATH, atomic_write_json, load_json, os,
    prepare_project, re, remove_with_retry, shutil, time,
)
from .wiring import api

def _reopen_spec_archive(st):
    """把交付阶段从 archive 退回 verify（源码返工时验证结论必须重做）。

    v3:阶段是自家状态里的一个字段,回退就是改它 + 作废验证结论——不再需要调外部
    引擎的 archive-reopen 转换(那条链在纯内嵌项目上曾必死:只找 .cac/.claude 旧脚本)。"""
    data = api._spec_data(st)
    if data.get("phase") != "archive":
        return True, ""
    data["phase"] = "verify"
    data.pop("verify_result", None)
    data.pop("verified_at", None)
    st.setdefault("history", []).append(
        {"step": st.get("current", ""), "result": "spec:archive-reopen",
         "note": "源码返工,验证结论作废", "at": time.strftime("%Y-%m-%d %H:%M:%S")})
    return True, ""


def _explicit_direct_reentry(text):
    """Whether captured user text explicitly asks Mae-Flow to take control again."""
    return _direct_reentry_decision(text) == "allow"

def _looks_like_control_question(value):
    return bool(re.search(
        r"(是什么|什么意思|怎么(?:用|恢复|开启|进入|接回)?|如何|能不能|"
        r"可以吗|是否|要不要|会不会|会怎样|有什么影响|[?？])",
        value, re.I))

def _targeted_flow_denial(value):
    """Reject only negation aimed at workflow control, not business wording."""
    target = r"(?:mae[- ]?flow|review-fix|这个工作流|原流程|月光宝盒|moonlight)"
    negative = r"(?:不确认|不要|不想|不再|不用|暂不|暂时不要|先别|别|拒绝|取消|停止|关闭|退出)"
    control = r"(?:重新)?(?:恢复|启用|接回|进入|使用|执行|开启|启动|切回|继续使用|用)"
    return bool(
        re.search(negative + r"\s*" + control + r"?\s*" + target, value, re.I)
        or re.search(target + r"[^，。！？,;；]{0,12}" + negative
                     + r"\s*" + control, value, re.I)
        or re.search(target + r"\s*(?:不要了|不用了|先别了?|取消|停止|关闭|退出)",
                     value, re.I)
    )

def _moonlight_activation_decision(text):
    """Return allow/deny/neutral for an unattended-mode activation request."""
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    lower = value.lower()
    command = re.match(r"^/mae-flow(?::mae-flow)?(?:\s+([^\s]+))?", lower)
    if command:
        action = (command.group(1) or "").strip()
        return "allow" if action in ("moonlight", "月光宝盒") else "neutral"
    if not re.search(r"月光宝盒|moonlight", value, re.I):
        return "neutral"
    if _targeted_flow_denial(value):
        return "deny"
    activation = bool(
        re.search(
            r"(?:开启|启动|启用|进入|切换到?|使用|用|继续|恢复)\s*(?:一下|这个)?\s*"
            r"(?:月光宝盒|moonlight)",
            value, re.I)
        or re.search(
            r"(?:月光宝盒|moonlight)(?:模式)?\s*(?:开启|启动|启用|继续|运行|接着|恢复)",
            value, re.I)
    )
    strong = bool(re.search(
        r"(?:请|帮我|直接|立即|马上|务必)\s*"
        r"(?:开启|启动|启用|进入|切换到?|使用|用|继续|恢复)\s*"
        r"(?:一下|这个)?\s*(?:月光宝盒|moonlight)",
        value, re.I))
    if _looks_like_control_question(value) and not strong:
        return "neutral"
    return "allow" if activation else "neutral"

def _direct_reentry_decision(text):
    """Return allow/deny/neutral for a captured Direct-mode user message."""
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    lower = value.lower()
    command = re.match(r"^/mae-flow(?::mae-flow)?(?:\s+([^\s]+))?", lower)
    if command:
        action = (command.group(1) or "").strip()
        # 独立 ut/codecheck/grill/story/chain/help 不应重新启用完整流程；
        # review-fix、月光宝盒和无参数完整入口都是明确的重新接管意图。
        return ("allow" if action in ("", "review-fix", "moonlight", "月光宝盒")
                else "neutral")
    # 否定只在明确指向流程控制时生效。业务请求里的“不要用长度判断”
    # 不应反过来否定开头已经明确发起的 review-fix。
    if _targeted_flow_denial(value):
        return "deny"
    if "review-fix" in lower:
        # 兼容宿主去掉 slash 前缀后只留下 action + 参数的形态，但“review-fix
        # 是什么/怎么用”只是咨询，不能因包含关键词就恢复门禁。
        asks_only = _looks_like_control_question(value)
        directs_action = bool(re.search(
            r"(请|帮我|执行|开启|进入|使用|处理|修复|调整|改成|改为|方案.{0,12}变)",
            value, re.I))
        strong_directive = bool(re.search(
            r"(?:(?:请(?!问|告诉|说明|介绍)|帮我|直接|立即|马上|务必)\s*"
            r"(?:执行|开启|进入|使用|用|处理|修复|调整|改成|改为)|"
            r"(?:处理|修复|调整)一下|改成|改为)",
            value, re.I))
        if asks_only and not strong_directive:
            return "neutral"
        return ("allow" if re.match(r"^review-fix(?:\s|$)", lower)
                or directs_action else "neutral")
    moonlight = _moonlight_activation_decision(value)
    if moonlight != "neutral":
        return moonlight
    names_flow = (
        "mae-flow" in lower or "mae flow" in lower or "这个工作流" in value
        or bool(re.search(r"(?:原|之前|先前)流程", value))
        or bool(re.fullmatch(r"(?:确认)?重新启用(?:流程)?", value))
    )
    action = bool(re.search(
        r"重新(?:使用|启用|进入|接回)?|恢复|接回|继续使用|确认重新|切回",
        value, re.I))
    strong_directive = bool(re.search(
        r"(?:请(?!问|告诉|说明|介绍)|帮我|直接|立即|马上|务必)\s*"
        r"(?:重新)?(?:恢复|启用|接回|进入|切回|继续使用)",
        value, re.I))
    if _looks_like_control_question(value) and not strong_directive:
        return "neutral"
    return "allow" if names_flow and action else "neutral"

def _direct_message_decision(text):
    """Classify only trusted answer fields from one captured message."""
    decisions = [
        _direct_reentry_decision(candidate)
        for candidate in api._trusted_answer_candidates(str(text or ""))
    ]
    if "deny" in decisions:
        return "deny"
    if "allow" in decisions:
        return "allow"
    return "neutral"

def _direct_reentry_authorization(rec, ack="", message_id=""):
    """Resolve a real Direct-mode user message and verify explicit re-entry intent."""
    all_rows = list((rec or {}).get("direct_messages", []) or [])
    rows = list(enumerate(all_rows))
    if message_id:
        rows = [(index, row) for index, row in rows
                if row.get("id") == message_id]
        if not rows:
            return "", "退出记录中不存在消息 ID %s" % message_id
    needle = re.sub(r"\s+", "", ack or "")
    matched_without_intent = False
    for index, row in reversed(rows):
        text = str(row.get("text", "") or "")
        candidates = api._trusted_answer_candidates(text)
        for candidate in candidates:
            if message_id or (needle and needle == candidate):
                decision = _direct_reentry_decision(candidate)
                if decision == "allow":
                    later_decisions = [
                        _direct_message_decision(item.get("text", ""))
                        for item in all_rows[index + 1:]
                    ]
                    later_decisive = [
                        item for item in later_decisions if item != "neutral"
                    ]
                    if later_decisive and later_decisive[-1] == "deny":
                        return "", (
                            "该授权之后用户又明确表示不要恢复/启用 Mae-Flow；"
                            "旧消息 ID 已撤销，请以最新用户意图为准")
                    return text, ""
                matched_without_intent = True
    if matched_without_intent:
        return "", ("对应用户消息没有明确要求恢复/重新启用 Mae-Flow；"
                    "普通改码请求不能被 Agent 解释成重新接管")
    if message_id:
        return "", "消息 ID %s 没有可验证的用户答案" % message_id
    return "", ("--ack 必须与 Direct 模式捕获到的完整用户原话或按钮答案精确一致")

def _read_exit_record():
    try:
        rec = load_json(EXIT_PATH)
        return rec if isinstance(rec, dict) else {}
    except Exception:
        return {}

def _exit_snapshot_path(rec):
    dst = str((rec or {}).get("snapshot", "") or "")
    return dst, (os.path.join(dst, STATE_PATH) if dst else "")

def _preserve_exit_pointer(rec):
    """Archive the latest pointer, including Direct-mode authorization messages."""
    dst, _saved = _exit_snapshot_path(rec)
    recovery = (dst if dst and os.path.isdir(dst)
                else api._unique_exit_dir({"config": {"单号": "restarted"}}))
    os.makedirs(recovery, exist_ok=True)
    target = os.path.join(recovery, "exit-record.json")
    if rec:
        atomic_write_json(target, rec)
    elif not os.path.isfile(target):
        # 损坏指针无法结构化保存时保留原始字节，避免 doctor/冲突收敛丢现场。
        shutil.copy2(EXIT_PATH, target)
    return recovery

def _resume_direct_mode(ack="", message_id=""):
    """恢复退出前现场；直接开发期间若改过源码，只回退到必要的质量链入口。"""
    if not os.path.exists(EXIT_PATH):
        return None
    rec = _read_exit_record()
    _authorized, auth_why = _direct_reentry_authorization(
        rec, ack=ack, message_id=message_id)
    if not _authorized:
        api.die("当前项目处于普通开发模式，重新启用会恢复门禁，但授权验真失败："
            + auth_why
            + "。先执行 messages 查看真实消息 ID，再使用 "
              "init --message-id <ID>；恢复原流程不要加 --new，开启另一流程加 --new。"
              "禁止移动、重命名或复制 .mae-flow.json.exited——它只是退出指针，"
              "真正状态位于其 snapshot 指向的目录。", 2)
    dst, saved_state = _exit_snapshot_path(rec)
    if not saved_state or not os.path.isfile(saved_state):
        api.die("退出现场缺少状态快照，不能自动恢复：%s。退出标记仍保留，请交维护人处理。" %
            (saved_state or "(无 snapshot)")
            + " 如用户明确要放弃旧现场开启另一流程，执行 "
              "init --new --message-id <messages输出的ID>；"
              "禁止把 .mae-flow.json.exited 改名成 .mae-flow.json。", 2)
    try:
        st = load_json(saved_state)
    except Exception as exc:
        api.die("退出状态快照不可解析，不能自动恢复：%s" % exc, 2)

    current_branch = api.sh("git branch --show-current")
    recorded_branch = str(rec.get("branch", "") or "")
    if recorded_branch and current_branch != recorded_branch:
        api.die("退出前流程位于分支 %s，当前分支是 %s，不能把旧断点恢复到错误分支。"
            "要续原流程请先 git checkout %s；要保留旧现场开启另一流程则使用 "
            "init --new --message-id <ID>。退出指针尚未消费。"
            % (recorded_branch, current_branch or "(detached/不可读)", recorded_branch), 2)

    changed, err = api._source_changed_since(rec.get("head", ""), st)
    if err:
        api.die("无法判断退出期间的源码变化，不能安全恢复：" + err, 2)
    source_changed = any(api._is_source_path(
        p[:-len("(未提交)")] if p.endswith("(未提交)") else p, st)
        for p in (changed or []))
    old_step = st.get("current", "")
    target = old_step
    if source_changed:
        # 2026-08-25 编排瘦身:任何工作流,退出期间改过源码就退回宽 build
        # 步重新收口;定稿阶段的 spec 归档要先正规重开,不能带着已定稿
        # 的规格回去改代码。
        if old_step in ("domain_archive", "delivery_review", "archive_confirm",
                        "archive", "push", "external_verify",
                        "moonlight_review", "end"):
            if api._spec_phase(st) == "archive":
                ok, why = _reopen_spec_archive(st)
                if not ok:
                    api.die("源码已变化且交付处于定稿阶段，但正规回退失败；尚未重新启用：" + why, 2)
            target = "build"

    for path in api._state_sidecars():
        if os.path.exists(path):
            os.remove(path)
    st.pop("unlock", None)
    st.pop("agent_tasks", None)
    st.pop("quality", None)
    st.pop("risk_acceptances", None)
    # 接回的是普通交互模式:退出快照可能带着月光宝盒标记(夜跑中途 exit)。
    # 不清掉的话恢复后每次 AskUserQuestion 都被 hook 硬拦,用户毫无提示。
    # 想继续无人值守应重新明确执行 moonlight on。
    if (st.get("moonlight") or {}).get("enabled"):
        st.pop("moonlight", None)
        print("[mae-flow] 退出前处于月光宝盒模式,已随恢复切回普通交互;"
              "需要继续无人值守请重新执行 moonlight on。")
    st["current"] = target
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    st.setdefault("history", []).append({"step": old_step, "result": "resumed:" + target,
                                          "note": "direct-source-changed" if source_changed else "no-source-change",
                                          "at": now})
    if target != old_step:
        st.setdefault("step_heads", {})[target] = rec.get("head", "")
    dst = _preserve_exit_pointer(rec)
    api.save_state(st)
    remove_with_retry(EXIT_PATH)
    print("[mae-flow] 已重新启用流程，退出现场仍保留在 %s；旧 agent/CodeCheck 令牌已清空。"
          % (dst or ".mae-flow-work/exited/"))
    if target != old_step:
        print("检测到退出期间改过源码：%s → %s，重新执行后续质量链。" % (old_step, target))
    return st

def _start_new_from_direct(flow, ack="", message_id=""):
    """Keep the exited snapshot for audit and deliberately start another flow."""
    if not os.path.exists(EXIT_PATH):
        api.die("当前没有已退出流程，init --new 无需使用；直接执行 init。", 2)
    rec = _read_exit_record()
    _authorized, auth_why = _direct_reentry_authorization(
        rec, ack=ack, message_id=message_id)
    if not _authorized:
        api.die("开启另一流程的授权验真失败：" + auth_why
            + "。先执行 messages，再用 init --new --message-id <ID>。"
              "禁止手工移动 .mae-flow.json.exited。", 2)

    # 先完成可能失败的环境前检和旧辅助状态清理，再消费退出指针。任何失败都仍
    # 保持 Direct 模式，用户可原样重试，不留下半初始化现场。
    try:
        prepare_project(os.getcwd())
    except CapabilityError as exc:
        api.die("插件运行时预检失败，旧退出现场和指针均未改动：%s。"
            "解决环境问题后原样重试 init --new。" % exc, 2)
    api._clear_auxiliary_state()

    dst, saved_state = _exit_snapshot_path(rec)
    dst = _preserve_exit_pointer(rec)
    previous = None
    if saved_state and os.path.isfile(saved_state):
        try:
            previous = load_json(saved_state)
        except Exception:
            previous = None
    if previous:
        sid = previous.get("current", "")
        terminal = bool(flow.get("steps", {}).get(sid, {}).get("terminal"))
        api._append_history(
            previous,
            outcome=("已完成后开启新流程" if terminal else
                     "用户保留退出现场并开启另一流程"))
        if terminal:
            # 终态换单仍维持 .last 语义，review-fix 可继承上一轮配置。
            atomic_write_json(STATE_PATH + ".last", previous)
    # 根指针由 cmd_init 在新主状态成功写盘后再消费；中途任何异常都会继续
    # 保持 Direct 模式，避免“旧现场还在但恢复入口消失”的半完成状态。
    return previous, dst

def _terminal_rollover_message(st, message_id="", ack=""):
    """Select a fresh terminal Slash request to carry into the next round."""
    rows = [
        item for item in api._captured_user_messages(st)
        if item.get("step") == st.get("current")
    ]
    if message_id:
        rows = [item for item in rows if item.get("id") == message_id]
        if not rows:
            api.die("终态换轮找不到消息 ID %s。无需 exit/goto/skip；执行 messages "
                "查看本条 Slash 命令 ID，或直接执行 init 自动开启下一轮。"
                % message_id, 2)
    elif ack:
        needle = re.sub(r"\s+", "", ack)
        rows = [
            item for item in rows
            if needle in api._trusted_answer_candidates(
                str(item.get("text", "") or ""))
        ]
        if not rows:
            api.die("终态换轮的 --ack 与本步骤用户原话不匹配。无需退出；"
                "直接执行 init 即可自动归档上一单并开启下一轮。", 2)
    else:
        cutoff = time.time() - 600
        rows = [
            item for item in rows
            if float(item.get("epoch", 0) or 0) >= cutoff
            and _direct_reentry_decision(
                str(item.get("text", "") or "")) == "allow"
        ]
    if not rows:
        return None
    row = dict(rows[-1])
    if _direct_reentry_decision(
            str(row.get("text", "") or "")) != "allow":
        api.die("消息没有明确要求开启 Mae-Flow 新轮次。终态门禁已解除，"
            "普通开发请求不应被 Agent 擅自解释成 init。", 2)
    return row
