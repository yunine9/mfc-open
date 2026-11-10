"""用户是否同意——只回答两件事，不猜措辞。

为什么要收成一处:同一个概念曾散在四个文件七个函数里(是不是肯定、措辞对不对、
路径覆盖没覆盖、是不是在答别的题…),每撞一个症状就在撞到的地方新加一个判据,
是教科书式的霰弹修改。更糟的是那些判据在干一件机器干不了的事:替用户判断
"你有没有看懂自己批的东西"。

只留两条:

1. **这话是对这次动作说的**——把流程自己生成的随机编号(拦截编号/确认单编号)
   要求出现在用户看见的问答里。编号是流程发的,Agent 编不出来、只能从拦截
   消息里抄;抄了就意味着它真把这次动作摆给用户看过。这是字符串包含判断,
   不是语义判断。实战撞过反例:用户在回答"交付方式"时顺口写了
   "选择 1（退出 Mae-Flow，直接开发）",被拿去当退出流程的授权——那条回答里
   没有退出动作的编号,现在拿不过来。

2. **这话不是拒绝**——一张否定词表。肯定的说法千奇百怪("配置无误,开始交付"
   "没问题,继续""都正确"),不该逐句白名单;而拒绝的说法有限且明确。

其余一概不管。路径列没列全、问题问得清不清楚,是"问得好不好"的问题,
属于提示层;拿门禁拦用户,等于机器替用户做决定。
"""

import json
import re

# 拒绝分两档,这个区分是实测逼出来的:「考虑过了,放行」「核对过了,没问题,放行」
# 被一刀切判成拒绝——用户明明说了放行,机器嫌他前面带了"考虑/核对"。
#
# 硬拒:说了就是不行,再多肯定词也救不回("先放行,不对,别")。
# "不X"通用式豁免常用褒义:不错/不赖(它们是"好"的意思)。
_HARD_REFUSAL = re.compile(
    r"不(?!错|赖)[\u4e00-\u9fa5]{1,3}|"
    r"没有|没法|否认|拒绝|暂不|先不|别|等等|取消|有误|有问题|"
    r"需要修改|需要调整|重新|再想|"
    r"(?<![A-Za-z])(?:no|nope|deny|cancel|reject)(?![A-Za-z])",
    re.I,
)
# 犹豫:单独出现算没同意("看看再说");同一句里有明确的放行词就不作数
# ("考虑过了,放行"——考虑是过程,放行才是结论)。
_HESITATION = re.compile(
    r"看看|再说|回头|稍后|待定|观察|考虑|研究|讨论|确认一下|核对|"
    r"什么意思|怎么|是否|能否|为什么")
_GRANT = re.compile(
    r"放行|允许|同意|批准|通过|可以|确认|没问题|无异议|采纳|执行吧|去吧|"
    r"(?<![A-Za-z])(?:ok|yes|approve|allow)(?![A-Za-z])", re.I)

_TRIVIAL = re.compile(r"^[\s,，。；;：:、!！?？.]*$")


def is_refusal(answer):
    """这句话是拒绝吗。空话、反问、犹豫都按"没同意"处理——机器不替用户表态;
    但用户明确说了放行/同意,前面的过程词(考虑过了/核对过了)不作数。"""
    said = str(answer or "")
    if _TRIVIAL.match(said):
        return True
    if _HARD_REFUSAL.search(said):
        return True
    # 问句是在问,不是在答:「是否可以?」里有"可以",但那是把决定抛回来
    if re.search(r"[?？]\s*$", said.strip()) or re.match(
            r"^\s*(?:是否|能否|可不可以|行不行)", said.strip()):
        return True
    if _HESITATION.search(said) and not _GRANT.search(said):
        return True
    return False


def mentions_token(shown, token):
    """用户看见的问答里出现了这次动作的编号吗。

    shown 传收据全文(宿主记录的问题 + 答案)。编号大小写不敏感,比对前去掉
    空白与常见分隔符——Agent 转述时可能写成 `ce14-04d2ec` 或加了空格。
    """
    wanted = re.sub(r"[\s\-_/]+", "", str(token or "")).lower()
    if not wanted:
        return False
    seen = re.sub(r"[\s\-_/]+", "", str(shown or "")).lower()
    return wanted in seen


def option_labels(shown):
    """收据里宿主记录的候选项标签(去空白、小写)。

    "这句话是不是用户真点的选项"是结构问题:标签在候选项里就是,不在就不是。
    原来靠措辞体操判(剥掉"确认…并继续"前缀、再算主题词包含),模型换个说法就
    判不出来——而选项文字本来就是模型写的。
    """
    try:
        payload = json.loads(str(shown or ""))
    except Exception:                      # noqa: BLE001
        return set()
    if not isinstance(payload, dict):
        return set()
    questions = (payload.get("askuser") or payload).get("questions") or []
    out = set()
    for question in questions:
        if not isinstance(question, dict):
            continue
        for label in (question.get("options") or []):
            out.add(re.sub(r"[\s,，。；;：:、!！]+", "", str(label or "")).lower())
    return out


def question_texts(shown):
    """收据里宿主记录的问题正文(不含答案)。

    "这条同意是给哪个动作的"要看问题,不能看答案。实战反例:用户回答"交付方式"时
    写了「选择 1（退出 Mae-Flow，直接开发）」——答案里字面就有"退出",可问题问的是
    交付方式。看答案会误判,看问题才准;而问题是宿主记录的,Agent 事后改不了。
    """
    try:
        payload = json.loads(str(shown or ""))
    except Exception:                      # noqa: BLE001
        return ""
    if not isinstance(payload, dict):
        return ""
    questions = (payload.get("askuser") or payload).get("questions") or []
    return "\n".join(
        str(item.get("question", "")) + " " + str(item.get("header", ""))
        for item in questions if isinstance(item, dict))


def mentions_any(shown, tokens):
    """任一编号/关键词出现即可。exit 这类没有随机编号,用动作名当标识。"""
    return any(mentions_token(shown, item) for item in tokens if item)


def relates_to_action(rows, action_words):
    """这些用户收据里,有没有一条与该动作相关。

    按收据形态分两条:Agent 代问(结构化)看**问题**在不在问这件事——看答案会
    误判(实战:回答交付方式时写了「选择 1（退出 Mae-Flow，直接开发）」,答案
    字面有"退出",可问的根本不是退出);用户自己打字(纯文本)看他的话本身——
    没人代问,他的话就是授权,不能要求他按什么格式说。
    """
    for row in rows or ():
        text = str((row or {}).get("text", "") or "")
        asked = question_texts(text)
        if asked:
            if mentions_any(asked, action_words):
                return True
        elif mentions_any(text, action_words):
            return True
    return False


def verdict(shown, answer, token=""):
    """→ (通过?, 说明)。说明只在不通过时有内容,且必须给出下一步。"""
    if is_refusal(answer):
        return False, (
            "用户这条回答不是同意(原话: %s)。用户高于一切,但同意与否只能看"
            "用户自己的回答;请重新征求明确许可,不要替他解读。"
            % (str(answer or "").strip()[:60] or "(空)"))
    # 编号只对"Agent 代问"这条路生效,而且要出现在**问题**里:问题是 Agent 写的、
    # 宿主记录的,它把编号抄进问题才证明真把这次动作摆给用户看过。答案里出现不算——
    # 用户随口提一句不是授权(实战反例:回答交付方式时顺口写了"退出 Mae-Flow")。
    #
    # 用户自己打字的普通消息**不要求编号**:没人代问,他的话就是授权本身,
    # 让他去抄一串随机编号是荒谬的。这条消息由 hook 捕获,Agent 伪造不了,
    # 这就是它的可信来源。
    asked = question_texts(shown)
    if token and asked and not mentions_token(asked, token):
        return False, (
            "这条回答不是针对本次动作的——用户看见的问答里没有本次编号 %s。"
            "别处的同意不能挪用到这里(实战里出现过:用户回答交付方式时顺口提到"
            "退出,被当成了退出流程的授权)。\\n"
            "做法:用 AskUserQuestion 重新征求许可,**把编号 %s 原样写进问题正文**"
            "(选项照旧简短,如「允许」「不允许」),再用那条新消息的 ID 重试。"
            % (token, token))
    return True, ""
