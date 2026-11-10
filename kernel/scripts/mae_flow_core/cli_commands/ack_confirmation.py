"""配置确认的判定。单独成文件:ack.py 已顶到 500 行红线。"""

import json
import re


def is_full_config_confirmation(value, config=None):
    """用户这句话是不是"整份配置都认了"。

    原来是措辞白名单(只认"确认以上全部配置"/"全部正确"那几句)。可选项文字是
    模型写的,弱模型必然换说法——用户点了「配置无误,开始交付」照样被判不通过。
    用户高于一切:他说可以了就该放行,机器不该嫌措辞不对。

    但当初要防的那件事仍然要防:"确认 master"这种**单项**回答不能给整份配置
    背书。判据换成事实——回答里点了某个配置项的值、又没说"以上/全部/所有",
    那就是在确认单项。
    """
    compact = re.sub(r"[\s,，。；;：:、!！]+", "", value or "")
    if not compact or re.search(
            r"不确认|不同意|不是|不要|不能|没有|没法|否认|拒绝|暂不|取消|"
            r"修改|调整|不对|有误|有问题|什么意思|怎么|是否|能否|为什么|[?？]",
            compact):
        return False
    # 肯定的说法不设前缀白名单:模型换个措辞就判不通过,是拿用户当机器。
    if not re.search(r"确认|同意|可以|没问题|无异议|无误|正确|继续|按此|"
                     r"放行|批准|通过|开始|ok|yes|y$", compact, re.I):
        return False
    whole = bool(re.search(r"以上|全部|所有|整份|都对|都正确|无误", compact))
    if whole:
        return True
    named = [
        str(item) for item in (config or {}).values()
        if str(item).strip() and len(str(item).strip()) >= 2
        and str(item).strip() in compact
    ]
    return not named


def whole_card_values(text, config):
    """→ 这条收据里"有资格替整份配置背书"的回答值;不适用则返回 None。

    最笨也最可靠的判据是看结构,不猜措辞:一轮提问里可以既有单项回答、又有
    整份确认——
        {"answers": {"基线分支": "确认 master",      ← 单项,永不算整份
                     "最终确认": "确认以上全部配置"}}  ← 独立确认题,才算
    键是配置项名的,回答的就是那一项;键是别的(专门的确认题),才可能是整份。
    自然语言表达肯定的方式千奇百怪,而结构只有这一种。
    """
    keys = set(config or {})
    if not keys:
        return None
    try:
        payload = json.loads(str(text or ""))
    except Exception:                      # noqa: BLE001 —— 不是 JSON 就不判
        return None
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        return None
    return [
        re.sub(r"\s+", "", str(value or ""))
        for key, value in answers.items()
        if key not in keys
    ]


def _trusted_answer_candidates(text):
    """Return actual answer values, excluding question/option metadata."""
    return [
        re.sub(r"\s+", "", value)
        for value in _trusted_answer_values(text)
        if re.sub(r"\s+", "", value)
    ]


def _trusted_answer_values(text):
    """Return answer values with their original wording and whitespace."""
    try:
        parsed = json.loads(text)
    except Exception:
        return [(text or "").strip()] if (text or "").strip() else []
    if isinstance(parsed, str):
        return [parsed.strip()] if parsed.strip() else []
    out = []
    answer_keys = {
        "answer", "answers", "response", "responses", "selected",
        "selection", "selectedoption", "selectedoptions", "result",
    }

    def walk(value, trusted=False):
        if isinstance(value, str) and trusted and value.strip():
            out.append(value.strip())
        elif isinstance(value, dict):
            for key, item in value.items():
                normalized = re.sub(
                    r"[^a-z]", "", str(key).lower())
                walk(item, trusted or normalized in answer_keys)
        elif isinstance(value, list):
            for item in value:
                walk(item, trusted)

    if isinstance(parsed, list):
        walk(parsed, trusted=True)
    else:
        walk(parsed)
    return out


def reviewed_config(st):
    """待确认的配置在 config_review.config 里;此刻 st["config"] 往往还是空的。
    取错地方的后果:单项回答("确认 master")找不到可比对的值,就被当成整份确认。"""
    state = st or {}
    review = (state.get("config_review") or {}).get("config") or {}
    return review or (state.get("config") or {})


def whole_card_answers(messages, reviewed, fallback):
    """这些收据里"有资格替整份配置背书"的回答值(去空白)。

    结构判据:宿主按问题分开记录回答,键是配置项名的只代表那一项。
    """
    out = set()
    for item in messages:
        eligible = whole_card_values(item.get("text", ""), reviewed)
        for value in (eligible if eligible is not None
                      else fallback(item.get("text", ""))):
            out.add(re.sub(r"\s+", "", str(value or "")))
    return out


def _is_positive_confirmation(value):
    compact = re.sub(r"[\s,，。；;：:、!！]+", "", value or "")
    compact = re.sub(r"[（(]推荐[）)]", "", compact)
    if not compact or re.search(
            r"不确认|不同意|不是|不要|不能|没有|没法|拒绝|暂不|取消|"
            r"需要修改|需要调整|先别|等等|不对|有误|有问题|但是|不过|"
            r"什么意思|怎么|是否|能否|为什么|[?？]",
            compact, re.I):
        return False
    return (
        compact.lower() in {
            "确认", "确认并继续", "确认范围并继续", "确认定稿",
            "同意", "可以", "没问题", "继续", "按此执行", "以上正确",
            "无异议", "yes", "y", "ok",
        }
        or bool(re.match(
            r"^(?:确认|同意|可以|没问题|继续|按此|无异议)", compact, re.I))
    )

def _button_confirmation_alias(item, candidate, expected):
    """用户点的是这一屏真实存在的选项,而且不是拒绝——就算确认。

    原来要剥掉"确认…并继续"前缀、再算主题词与 expected 的包含关系。可选项文字
    是模型写的,换个说法就判不出来(实战:"choice 问了两遍")。判据换成结构:
    标签在宿主记录的候选项里(Agent 伪造不了),内容不是拒绝。
    """
    del expected                 # 精确匹配已在调用方先试过;这里只兜别名
    from mae_flow_core.workflow.consent import is_refusal, option_labels
    normalized = re.sub(
        r"[\s,，。；;：:、!！]+", "", str(candidate or "")).lower()
    if not normalized or normalized not in option_labels(item.get("text", "")):
        return False
    return not is_refusal(candidate)
