"""Local-only Spec command and validation."""

from .shared import atomic_write_text, os, read_text
from .wiring import api
from mae_flow_core.orchestration.work_package import ensure_work_package


_HEADINGS = (
    "## 范围",
    "## 可观察行为",
    "## 验收条件",
    "## 不在范围",
    "## Grill 决策",
)
_TEMPLATE = """# 需求规格

<!-- 本单 Spec：在“验收条件”内设计测试；主任务全局 Story 不在这里重复维护。
先统一说明被测模块入口、真实执行范围、外部依赖替身和公共环境，再逐条写：
[TC-01｜模块 UT（MST）] **条件：**外部查询返回有效记录；**操作：**调用本模块同步入口；**预期：**按契约转换并保存记录，返回同步结果。
函数 UT 用于具体逻辑（如 SQL 拼接）；模块 UT（MST）真实执行模块协作，仅替换相关外部边界。MST 就是模块 UT，不是额外测试层级。
每条用例标明函数 UT 或模块 UT（MST）级别；有模块行为变化时写出具体条件、操作和预期，不能只写后续补充；确实不适用时说明原因。
按实际风险选择正常、边界和异常场景，不为简单透传凑用例；UT 无法证明的真实环境行为注明证据边界，不自动增加单独接口调试、跨模块集成或部署验证任务。
Grill 决策按“原始答复编号与当前结论 → 相关 BEH/TC”逐项简述；改变口径时注明取代了哪条旧结论。
用户原话优先于旧文档与 set_target 摘要；原话的语义由 Agent 核对，不按关键词或哈希判断。
编号稳定，不逐条标优先级；尚缺环境的用例注明验证缺口，不把预期当执行结果。
本段是填写说明，生成正文后可删除。 -->

## 范围

## 可观察行为

## 验收条件

## 不在范围

## Grill 决策
"""


def local_spec_errors(content):
    if not isinstance(content, str):
        return _HEADINGS
    errors = []
    for index, heading in enumerate(_HEADINGS):
        start = content.find(heading)
        if start < 0:
            errors.append(heading)
            continue
        body_start = start + len(heading)
        later = [
            content.find(other, body_start)
            for other in _HEADINGS[index + 1:]
        ]
        ends = [position for position in later if position >= 0]
        body = content[body_start:min(ends) if ends else len(content)]
        if not body.strip():
            errors.append(heading)
    return tuple(errors)


def initialize_local_spec(project_root, ticket):
    package = ensure_work_package(project_root, ticket)
    if not os.path.exists(package.spec):
        atomic_write_text(package.spec, _TEMPLATE)
    return package.spec


def _ticket(state):
    return str(((state or {}).get("config") or {}).get("单号", "")).strip()


def cmd_local_spec(state, args):
    ticket = _ticket(state)
    if not ticket:
        api.die("当前流程没有有效单号，不能定位本地 Spec。", 2)
    path = initialize_local_spec(os.getcwd(), ticket)
    if args.local_spec_action == "init":
        print("[mae-flow] 本地 Spec: " + path)
        return path
    content = read_text(path, encoding="utf-8")
    if args.local_spec_action == "show":
        print("[mae-flow] 本地 Spec: " + path)
        print(content, end="" if content.endswith("\n") else "\n")
        return path
    errors = local_spec_errors(content)
    if errors:
        api.die("本地 Spec 缺少有效章节内容: " + "、".join(errors), 2)
    print("[mae-flow] 本地 Spec 结构校验通过: " + path)
    print("仅检查章节非空，不代表决定/行为/用例语义一致；由 Agent 对照最终用户原话核对，真实冲突直接修正，不增加确认或循环校验。")
    return path
