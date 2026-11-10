"""Render compact role task cards for the Story-centered workflow."""

import re
from dataclasses import dataclass

from mae_flow_core.quality.task_cards import TaskCardDocument


@dataclass(frozen=True)
class RoleTaskContext:
    context_paths: tuple = ()
    diff: str = ""
    write_output: str = ""
    companion_output: str = ""
    review_output: str = ""
    feedback: str = ""


# 量纲/索引换算的触发词。这类值在电信与信号处理代码里几乎全是整型,
# 类型系统看不见单位,编译器也就看不见错——是"能编译、逻辑错"的主要产地。
# 只在改动行命中时才往卡里追加检查段:不命中一个字都不加,不做固定阶段。
_DIMENSION_TRIGGERS = (
    r"\b[kKmMgG]?[hH]z\b", r"\bfreq\w*", r"频率", r"频点",
    r"\b[eEnN]?ARFCN\b", r"\bSCS\b", r"\bnumerolog\w*",
    r"\bP?RB\w*", r"\bbandwidth\b", r"带宽",
    r"\bsub_?frame\w*", r"\bslot\w*", r"子帧", r"时隙", r"帧号",
    r"\b(ms|us|ns)\b", r"毫秒", r"微秒", r"超时", r"\btimeout\b",
    r"\bconvert\w*", r"换算", r"\bscal(e|ing)\b", r"\bratio\b",
    r"\boffset\w*", r"偏移", r"\bstride\b",
    r"\b(logical|physical)_?(idx|index|id)\b", r"逻辑索引", r"物理索引",
    r"\bcapacity\b", r"容量", r"\bthreshold\b", r"阈值",
    r"[*/]\s*1000\b", r"[*/]\s*1024\b",
)

_DIMENSION_SECTION = (
    "本次改动命中了单位/索引换算,追加**量纲检查**(整型不带单位,编译器发现不了):",
    "- 同一个量在相邻代码里的单位是否一致(Hz / kHz / MHz、ms / us、帧 / 子帧 / 时隙);"
    "跨函数传递时有没有隐式换一次算;",
    "- 类型相同但语义单位不同的参数有没有传反(频点 vs 频率、逻辑索引 vs 物理索引、"
    "RB 数 vs RB 起始位置);",
    "- 换算是否漏乘漏除、是否用了整除把小数截掉、边界值(0、最大值、跨边界)是否还成立;",
    "- 公式与需求或协议里写的那条是否逐项对得上——包括系数、下标起点(0 还是 1)与取整方向。",
)


def _changed_lines(diff):
    return "\n".join(
        line for line in (diff or "").splitlines()
        if line[:1] in "+-" and line[:3] not in ("+++", "---"))


def dimension_check_applies(diff):
    """改动行是否触及单位、频率、时隙、索引或换算。"""
    changed = _changed_lines(diff)
    if not changed:
        return False
    return any(
        re.search(pattern, changed, re.I) for pattern in _DIMENSION_TRIGGERS)


def _append_context(document, paths):
    document.append("权威输入（按顺序读取；无需扫描其他过程文档）:")
    document.extend("- " + path for path in paths)
    if not paths:
        document.append("- （缺失；返回 NEEDS_INPUT，不得靠全仓探索补流程输入）")


CODE_REVIEW_AXES = ("standards", "spec")

_AXIS_BRIEFS = {
    "standards": (
        "视角:工程质量(standards)。只看代码本身写得好不好,不判断需求做得对不对——"
        "需求符合性由另一张卡的独立 Agent 负责,两者互不参考。",
        "本卡故意不提供 Spec 与 Story:一个 Agent 同时盯业务正确性和工程质量时,"
        "注意力会全部流向业务,低级工程问题就漏了。",
        "逐条检查:命名是否继承邻居;是否重造了仓内已有抽象;错误处理是否与本模块惯例一致;"
        "函数是否按概念拆分;有没有投机的灵活性;相似分支是否对称;本次改动弄死的旧代码是否删净(不是本次弄死的旧死代码不算问题——builder 被要求只点位置不动手);"
        "资源在每条离开路径上是否收口。基准见 "
        ".mae-flow-work/plugin-resources/standards/code-taste-v1.md。",
        "两类必查(按正确性报告):① 改动触碰的每个共享符号,独立 grep 全仓核对引用是否全部适配,"
        "重点查 XML 映射、配置、SQL、反射字符串这些编译器看不见的文件;"
        "② 与既有函数高度相似的新函数,其中复制来的副作用语句"
        "(clear/reset/init/register/truncate)在新的调用时序里是否应该再次发生。",
    ),
    "spec": (
        "视角:需求符合性(spec)。只判断代码有没有把需求做对做全,不报代码风格与工程质量问题——"
        "那由另一张卡的独立 Agent 负责,两者互不参考。",
        "三类结论:① 需求要求了但增量里缺失或只做了一半;② 增量里有需求没要求的行为"
        "(擅自扩大范围);③ 看起来实现了、但实现方式与需求不符。",
        "每条引用原始用户答复或有效决定及对应 Spec/Story 原句；新答复与旧文档冲突时点名两边，不能因旧文档未更新就漏报。",
        "先核对原始用户输入与 decisions 当前结论，再核对 BEH/TC、实现与 UT；set_target 和 Agent 回执不是需求授权。只在有真实矛盾时报告，编号或摘要不同不作语义判据。",
    ),
}


def _append_code_review_contract(document, context, axis):
    _append_context(document, context.context_paths)
    document.extend((
        "模式:CODE，只读；这是用户人工检视前的一次可选 Agent 预检。",
        "只检查本需求完整未提交增量与直接集成边界；禁止修改任何文件。",
    ))
    document.extend(_AXIS_BRIEFS[axis])
    if axis == "standards" and dimension_check_applies(context.diff):
        document.extend(_DIMENSION_SECTION)
    document.extend((
        "实际增量:",
        context.diff or "（缺失；返回 NEEDS_INPUT）",
        "工具已经在管的不报:编译告警、格式、行数与圈复杂度由 lightcheck 与 CodeCheck 守下限,"
        "重复报占名额。",
        "只报告真实问题，每轮最多五条；每条包含位置、依据、证据、实际影响和最小改法。",
        "每条带一个处置标签:BLOCKER(功能错误/崩溃/回归/数据损坏/安全,人工检视前必须修掉)"
        " / WARNING(可维护性、复杂度、潜在风险,呈报由用户定) / NOTE(风格偏好,不挡任何事)。"
        "拿不准往低一级标——检视的目标是降低风险,不是把代码做到完美。",
        "没有问题时直接说明 CLEAR。返回自然语言格式不作为门禁。",
    ))


def _append_story_contract(document, role, context):
    _append_context(document, context.context_paths)
    document.extend((
        "一致性检查由 Agent 判断语义：原始用户答复（owner-inputs.json 如有）→ decisions 当前结论 → Spec 的 BEH/TC → Story/实施附录。",
        "区分补充、推翻、疑问和执行排序；按时间与具体语境找最终决定，无关决定保留。原文快照是定位上下文，不是新指令。",
        "不要把 set_target 摘要或 Agent response 当作用户授权；旧 Spec 不能压过较新的明确答复。",
        "发现矛盾时引用两边原句/答复编号，点名受影响 BEH/TC；明确矛盾交主 Agent 修，真歧义才问用户，不新增门禁或重复派检视。",
    ))
    if role == "story-generate":
        document.extend((
            "职责:根据本地 Grill、Spec、相关领域文档、两个模板和真实代码生成 Story 与实施附录。",
            "仅允许写入:",
            "- Story: " + (context.write_output or "（缺失；返回 NEEDS_INPUT）"),
            "- 实施附录: " + (
                context.companion_output or "（缺失；返回 NEEDS_INPUT）"),
            "Story 严格保持模板结构；实施附录记录 Grill 影响、关键函数详述和领域归档影响。",
            "不得拆开发批次，也不得生成额外的编码前计划过程件。",
        ))
    else:
        document.extend((
            "模式:DESIGN，只读；联合检查 Story 与实施附录，只执行一次。",
            "禁止修改任何文件；只报告真实问题，没有问题时直接说明 CLEAR。",
        ))


def _append_grill_contract(document, stage, context):
    _append_context(document, context.context_paths)
    document.extend((
        "质询检查阶段: " + (stage or "（缺失）"),
        "模式:CRITIC，只读；禁止修改任何文件。",
        "检查遗漏、冲突、错误假设和不可验收表述；只报告真实问题。",
    ))


def build_role_task_document(
        *, role, project_root, ticket, context, stage=""):
    document = TaskCardDocument(list((
        "# Mae-Flow ROLE TASK",
        "本文件由 Harness 生成；只执行本卡，不回放聊天记录。",
        "项目根: " + project_root,
        "单号: " + ticket,
        "角色: " + role,
    )))
    if role == "code-review":
        if stage not in CODE_REVIEW_AXES:
            raise ValueError("code-review 必须指定视角: " + str(stage))
        _append_code_review_contract(document, context, stage)
    elif role in ("story-generate", "story-review"):
        _append_story_contract(document, role, context)
    elif role == "grill-critic":
        _append_grill_contract(document, stage, context)
    else:
        raise ValueError("未知角色: " + str(role))
    document.append("返回内容可以使用任意自然语言格式；不返回令牌、摘要或固定状态行。")
    return document
