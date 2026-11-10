"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CONFIG_CONFIRM_ACK, FAILURE_PATH, STATE_PATH, hashlib, json,
    order_workflow_verdict, re, read_text, time,
    update_json, workflow_completion,
)
from .ack_confirmation import (
    _button_confirmation_alias, _is_positive_confirmation,
    _trusted_answer_candidates, _trusted_answer_values,
    reviewed_config, whole_card_answers, whole_card_values)
from .wiring import api

def _evidence_failure_count(sid, success=False):
    """按步骤统计 done 证据连拒次数;成功推进即清零。与 _ack_failure 同一存储。"""
    key = "evidence:" + (sid or "")
    result = [0]

    def mutate(data):
        if not isinstance(data, dict):
            data = {}
        if success:
            data.pop(key, None)
            return data
        result[0] = int((data.get(key, {}) or {}).get("count", 0)) + 1
        data[key] = {"count": result[0],
                     "at": time.strftime("%Y-%m-%d %H:%M:%S")}
        return data

    try:
        update_json(FAILURE_PATH, mutate, default={}, recover_corrupt=True)
    except Exception:
        return 1 if not success else 0
    return result[0]

def _ack_failure(st, reason="", success=False):
    """记录确认通道失败；只停止盲目重试，不制造不可恢复的锁。"""
    sid = (st or {}).get("current", "")
    key = "ack:" + sid
    result = [0]

    def mutate(data):
        if not isinstance(data, dict):
            data = {}
        if success:
            data.pop(key, None)
            return data
        previous = data.get(key, {})
        result[0] = int(previous.get("count", 0)) + 1
        data[key] = {
            "count": result[0],
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "reason": reason[:1000],
        }
        return data

    update_json(
        FAILURE_PATH, mutate, default={}, recover_corrupt=True)
    return result[0]

def _ack_candidates(text):
    """Extract exact user answers without treating prompt/options metadata as consent."""
    out = [text or ""]
    try:
        value = json.loads(text)
        answer_keys = {
            "answer", "answers", "response", "responses", "selected",
            "selection", "selectedoption", "selectedoptions", "result",
        }

        def walk(v, trusted=False):
            if isinstance(v, str) and trusted:
                out.append(v)
            elif isinstance(v, dict):
                for key, item in v.items():
                    normalized_key = re.sub(r"[^a-z]", "", str(key).lower())
                    walk(item, trusted or normalized_key in answer_keys)
            elif isinstance(v, list):
                for item in v:
                    walk(item, trusted)

        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, list):
            walk(value, trusted=True)
        else:
            walk(value)
    except Exception:
        pass
    return [re.sub(r"\s+", "", v) for v in out if re.sub(r"\s+", "", v)]

def _all_ack_messages():
    try:
        msgs = json.loads(read_text(STATE_PATH + ".usermsg") or "[]")
    except Exception:
        return []
    return msgs if isinstance(msgs, list) else []

def _ack_message_signature(item):
    payload = json.dumps({
        "id": item.get("id", ""),
        "step": item.get("step", ""),
        "at": item.get("at", ""),
        "text": item.get("text", ""),
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def _ack_message_cursor():
    return [_ack_message_signature(item) for item in _all_ack_messages()]

def _current_ack_messages(st, extra_steps=()):
    msgs = _all_ack_messages()
    sid = st.get("current", "")
    entered = api._step_entered_at(st)
    started = st.get("started", "")
    out = []
    for item in msgs:
        if (item.get("at", "") >= entered
                and (not item.get("step") or item.get("step") == sid)):
            out.append(item)
        elif (extra_steps and item.get("step") in extra_steps
              and item.get("at", "") >= started):
            # 一卡合一预答通道:配置确认卡合并收集的选择(交付方式/质询/STORY),
            # 供随后的选择步直接消费,免逐步重复提问;仍是本单内真实捕获的用户答案。
            out.append(item)
    return out


def _authorization_message(st, message_id):
    """Resolve one current-step user message without shell text transport."""
    wanted = str(message_id or "").strip()
    if not wanted:
        return False, "", {}, (
            "缺少 --message-id。先执行 messages，使用当前步骤用户授权消息左侧的 ID；"
            "不要把用户原话复制进 shell。")
    current = [
        item for item in _current_ack_messages(st)
        if str(item.get("id", "") or "") == wanted
    ]
    if not current:
        old = [
            item for item in _all_ack_messages()
            if str(item.get("id", "") or "") == wanted
        ]
        if old:
            return False, "", {}, (
                "消息 ID %s 属于步骤 %s，当前是 %s；"
                "高风险授权不能跨步骤复用。"
                % (wanted, old[-1].get("step", "(未标步骤)"),
                   st.get("current", "")))
        return False, "", {}, (
            "当前步骤不存在消息 ID %s。先执行 messages 查看可用 ID；"
            "不要自行构造或复用旧 ID。" % wanted)
    row = current[-1]
    values = _trusted_answer_values(str(row.get("text", "") or ""))
    if not values:
        return False, "", {}, (
            "消息 ID %s 的结构中没有可信回答字段。执行 messages --id %s --full "
            "核对宿主回传；不得用问题或候选项文本冒充用户回答。"
            % (wanted, wanted))
    answer = "\n".join(dict.fromkeys(values))
    receipt = {
        "message_id": wanted,
        "answer_sha256": hashlib.sha256(
            answer.encode("utf-8")).hexdigest(),
        "captured_at": str(row.get("at", "") or ""),
        "step": str(row.get("step", "") or st.get("current", "")),
        # 用户点选时"看见的那一屏"原样留档:多路径 Git 放行要靠它界定范围。
        # 回答本身是个短选项标签(流程明令选项要短),装不下十几个路径;
        # 而问题文本是宿主记录的、Agent 事后改不了的。点选授权的是所见内容。
        "shown": str(row.get("text", "") or "")[:8000],
    }
    _ack_failure(st, success=True)
    return True, answer, receipt, ""

def _out_of_scope_ack_reason(st):
    """Explain captured-but-stale answers without blaming the Hook."""
    rows = _all_ack_messages()
    if not rows:
        return ""
    sid = st.get("current", "")
    entered = api._step_entered_at(st)
    latest = rows[-1]
    old_step = str(latest.get("step", "") or "(未标步骤)")
    old_at = str(latest.get("at", "") or "?")
    if old_step != sid:
        return (
            "Hook 已捕获用户回复，但最新一条绑定在步骤 %s；当前已是 %s。"
            "步骤切换后旧回答按设计失效，不能再次授权新的 done/goto；"
            "请展示当前步骤需要的决定并取得一次新回复（旧回复时间 %s）。"
            % (old_step, sid, old_at)
        )
    if old_at < entered:
        return (
            "Hook 已捕获用户回复，但它早于当前步骤这一轮的进入时间 %s；"
            "旧轮回答按设计失效，不能为重进后的新一轮背书。"
            "请展示当前步骤需要的决定并取得一次新回复。"
            % entered
        )
    return (
        "Hook 已捕获用户回复，但其结构中没有当前命令可验真的答案字段。"
        "先执行 messages --full 查看原始回传；若按钮正文确实缺失，"
        "让用户发送当前页面要求的普通确认消息。"
    )

def _fresh_askuser(st):
    ok, _ = api.ev_agent_ran({"agent": "ASKUSER"}, st)
    return ok

def _implicit_ack_verified(step, st):
    """Use a fresh button/plain-text answer directly; no second typed ACK."""
    expected = {
        re.sub(r"[\s,，。；;：:、!！]+", "", str(value)).lower()
        for value in step.get("confirmation_answers", [])
        if str(value).strip()
    }
    from mae_flow_core.workflow.consent import is_refusal
    rows = _current_ack_messages(st)
    refused_card = False
    for item in reversed(rows):
        candidates = _trusted_answer_candidates(item.get("text", ""))
        # 同一张卡上用户按过"需要修改"类按钮:这张卡整体是打回。
        # 卡上其他问题的回答(如"交付方式: 完整开发")不是拒绝词,
        # 但不能替确认题背书——独立判每个答案会把否定卡放行
        # (云端实测:配置卡答"需要修改"+"完整开发",done 曾照样推进)。
        # break 不是 continue:从新到旧遍历,最新的打回封路,
        # 更旧的确认不能越过它复活。
        if any(is_refusal(value) for value in candidates):
            refused_card = True
            break
        for candidate in reversed(candidates):
            normalized = re.sub(r"[\s,，。；;：:、!！]+", "", candidate)
            normalized = re.sub(
                r"[（(]推荐[）)]", "", normalized).lower()
            if expected and normalized in expected:
                _ack_failure(st, success=True)
                return True, ""
            if expected and _button_confirmation_alias(
                    item, candidate, expected):
                _ack_failure(st, success=True)
                return True, ""
            if not is_refusal(candidate):
                # A current-step direct reply need not copy a button.
                if expected and not (re.sub(r"\s+", "", item.get("text", "")) == candidate
                                     and _is_positive_confirmation(candidate)):
                    continue
                _ack_failure(st, success=True)
                return True, ""
    wanted = " / ".join(step.get("confirmation_answers", []))
    actual = " / ".join(dict.fromkeys(value for item in rows for value in
        _trusted_answer_values(item.get("text", ""))))
    why = (_out_of_scope_ack_reason(st) if not rows else "") or (
        ("用户在确认卡上选择了修改/打回(%s)。按用户意见修订后重新用 "
         "AskUserQuestion 出卡确认;不能直接 done,也不要原样重复提问。"
         % (actual or "无")) if refused_card else
        ("已捕获当前步骤答案「%s」，但未匹配标准确认按钮「%s」。"
         "不要猜 --choice 或重复询问；按 current 输出原样展示标准按钮。"
         % (actual or "无", wanted or "肯定")) if rows else
        ("尚未捕获到本步骤的%s选择。正常情况下直接使用 AskUserQuestion 让用户点选即可，"
         "done 会自动读取结果；只有宿主确实没有回传按钮结果时，才让用户发送一次标准选项。"
         % (("「" + wanted + "」") if wanted else "肯定")))
    count = _ack_failure(st, why)
    return False, why + _ack_retry_guidance(count)


def _choice_verified(step, st, choice, ack_cursor=None):
    """Bind --choice to the concrete answer returned by Claude Code/CodeAgent."""
    # 一卡合一:开场三个选择步同时接受配置确认卡期间捕获的真实答案。
    extra = (("config_confirm",)
             if st.get("current") in (
                 "workflow_select", "grill_ask", "story_ask")
             else ())
    alias_rows = []
    for key, values in (step.get("choice_answers") or {}).items():
        for value in [key] + list(values or []):
            normalized = re.sub(r"[\s,，。；;：:、!！]+", "", str(value))
            normalized = re.sub(r"[（(]推荐[）)]", "", normalized)
            if normalized:
                alias_rows.append((key, normalized.lower()))

    rows = _current_ack_messages(st, extra_steps=extra)
    if ack_cursor is not None:
        cursor = set(ack_cursor or [])
        rows = [item for item in rows
                if _ack_message_signature(item) not in cursor]
    readable = []
    for item in rows:
        readable.extend(
            (item, candidate)
            for candidate in _trusted_answer_candidates(
                item.get("text", "")))
    for item, candidate in reversed(readable):
        normalized = re.sub(r"[\s,，。；;：:、!！]+", "", candidate)
        normalized = re.sub(r"[（(]推荐[）)]", "", normalized).lower()
        # 全等,或"标签开头+补充说明"(按钮文案常带括号注释)。禁止全文子串搜索:
        # 「这次不是 hotfix,走完整开发」会命中 hotfix、消息里出现 docs/review/ 路径
        # 会命中 review——把用户的合法回答误判成 Agent 替用户改选。
        # 纯 ASCII 代号(full/hotfix/tweak/review)只认全等,防叙述句里的英文词误触。
        matches = [
            (key, alias) for key, alias in alias_rows
            if normalized == alias
            or (not re.fullmatch(r"[a-z0-9_-]+", alias)
                and normalized.startswith(alias))
        ]
        if not matches:
            selected = (
                workflow_completion.receipt_choice(
                    step, item, candidate)
                or workflow_completion.natural_binary_choice(
                    step, candidate, _is_positive_confirmation)
            )
        else:
            longest = max(len(alias) for _, alias in matches)
            keys = {key for key, alias in matches if len(alias) == longest}
            selected = next(iter(keys)) if len(keys) == 1 else ""
        if selected:
            if selected == choice:
                _ack_failure(st, success=True)
                return True, ""
            return False, (
                "用户点选的是「%s」，但 Agent 准备提交 --choice %s。"
                "请按按钮真实结果执行，禁止替用户改选。" % (candidate, choice)
            )

    # 没捕获到卡上答案:退到**下单事实**(.mae-flow-order.json,和捕获
    # 答案同级真实——都是用户亲手给的)。捕获答案上面已优先消费(中途
    # 改口赢);这里只兜"确认卡没问 Q2、也没人再出卡"的正常新路。
    handled, accepted, why = order_workflow_verdict(step, choice)
    if handled:
        if accepted:
            _ack_failure(st, success=True)
            return True, ""
        return False, why
    scope_why = _out_of_scope_ack_reason(st) if not rows else ""
    if scope_why:
        return False, scope_why
    return False, (
        "没有检测到本步骤的真实选项回答。请用 AskUserQuestion 展示固定选项；"
        "用户点选后直接执行 done --choice %s，不需要再输入确认句。" % choice
    )

def _ack_retry_guidance(count):
    if count < 2:
        return ""
    return (
        " 同一确认自动校验已连续失败 %d 次，现停止重复执行同一条命令。"
        "流程没有锁死，也不需要 exit/init：先运行 messages 查看实际捕获答案；"
        "若结构化选择未回传，让用户发送一条当前页面要求的普通确认消息，再原样提交。"
    ) % count

def _ack_verified(st, ack, exact=True):
    """ack 必须来自当前步骤之后的真实用户输入；旧步骤的“可以”不能循环使用。

    如果宿主拿不到 AskUserQuestion 的应答正文，用户再发一条普通消息即可恢复；不允许静默降级为
    “模型自己写一句 --ack 也算用户确认”。
    """
    msgs = _current_ack_messages(st)
    if not msgs:
        why = _out_of_scope_ack_reason(st) or (
            "harness 尚未记录到任何用户回复。先执行 doctor 检查 UserPromptSubmit 输入，"
            "不要重复执行相同 done，也无需退出重开。")
        count = _ack_failure(st, why)
        return False, why + _ack_retry_guidance(count)

    def nt(s):
        return re.sub(r"\s+", "", s or "")

    na = nt(ack)
    actual = [v for m in msgs for v in _ack_candidates(m.get("text", ""))]
    matched = any((na == v if exact else na in v) for v in actual) if na else False
    if matched:
        _ack_failure(st, success=True)
        return True, ""
    why = ("--ack 与当前步骤开始后的用户真实输入不匹配。"
           "ack 必须是用户回复/选项的原文复制；先执行 messages 核对实际捕获答案，"
           "不要再次执行相同命令。")
    count = _ack_failure(st, why)
    return False, why + _ack_retry_guidance(count)

def _config_ack_verified(st, ack):
    """Verify the user's full-config decision without content fingerprint expiry."""
    messages = _current_ack_messages(st)
    normalized_ack = re.sub(r"\s+", "", ack or "")
    reviewed = reviewed_config(st)
    matched = False
    refused_card = False
    from mae_flow_core.workflow.consent import is_refusal
    # 从新到旧:用户的最新意志优先——最新一张卡若是打回,更旧的确认
    # 不能越过它复活。
    for item in reversed(messages):
        # 结构上有资格替整份背书的回答优先;拿不到结构就退回全部候选值
        eligible = whole_card_values(item.get("text", ""), reviewed)
        candidates = (
            eligible if eligible is not None
            else _trusted_answer_candidates(item.get("text", "")))
        # 同一张卡上有"需要修改"类回答=整卡打回:卡上其他问题的回答
        # (如"交付方式: 完整开发")不是拒绝词,但不能替确认题背书。
        # 独立判每个答案曾把否定卡放行(云端宿主实测)。
        if any(is_refusal(value) for value in candidates):
            refused_card = True
            break
        for candidate in candidates:
            same_answer = (
                normalized_ack == candidate if normalized_ack else True)
            if same_answer and not is_refusal(candidate):
                matched = True
                break
        if matched:
            break
    if matched:
        _ack_failure(st, success=True)
        return True, ""
    if refused_card:
        why = (
            "用户在配置确认卡上选择了修改/打回。按用户意见修正配置后"
            "重新 config-review 并出卡确认;不能直接 done,也不要原样重复提问。"
        )
        count = _ack_failure(st, why)
        return False, why + _ack_retry_guidance(count)

    if normalized_ack and messages and normalized_ack not in whole_card_answers(
            messages, reviewed, _trusted_answer_candidates):
        why = (
            "配置确认必须针对完整配置:这条回答只针对配置单里的某一项(如“确认 master”),不能替整份背书。"
            "判据不是措辞而是结构:宿主把回答按问题分开记录,键是配置项名的就只代表"
            "那一项。做法:用 AskUserQuestion 展示 config-review 输出后,"
            "只问一次“是否确认以上全部配置”,选项照旧简短。"
        )
    elif not messages and _out_of_scope_ack_reason(st):
        why = _out_of_scope_ack_reason(st)
    elif not messages:
        why = (
            "没有捕获到当前步骤的完整配置确认。AskUserQuestion 的应答可能未被宿主回传；"
            "无需退出或重新初始化，让用户发送一条普通消息“%s”即可恢复。"
            % CONFIG_CONFIRM_ACK
        )
    else:
        why = (
            "当前配置确认单之后没有肯定的完整配置选择。用户在 AskUserQuestion 点选后可直接 done，"
            "不需要再手动输入或由 Agent 拼接 --ack。"
        )
    count = _ack_failure(st, why)
    return False, why + _ack_retry_guidance(count)

def check_evidence(step, st):
    return workflow_completion.evidence_failures(
        step, st, api._EVIDENCE_REGISTRY)
