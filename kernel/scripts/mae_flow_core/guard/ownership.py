"""Pure commit-candidate ownership decisions."""

from dataclasses import dataclass

from .gate import GateDecision


@dataclass(frozen=True)
class OwnershipFacts:
    candidate_paths: tuple
    inherited: tuple
    foreign_openspec: tuple
    compile_side_effects: tuple
    staged_compile_side_effects: tuple
    command_compile_side_effects: tuple
    strong_artifacts: tuple
    unproven_paths: tuple
    artifact_hints: tuple


@dataclass(frozen=True)
class OwnershipDecision:
    block: object = None
    advisories: tuple = ()


def _compile_side_effect_block(facts):
    all_paths = tuple(dict.fromkeys(facts.compile_side_effects))
    staged = tuple(dict.fromkeys(facts.staged_compile_side_effects))
    command = tuple(dict.fromkeys(facts.command_compile_side_effects))
    if not staged and not command:
        staged = all_paths
    staged_set = set(staged)
    command_set = set(command)
    staged_only = tuple(path for path in all_paths
                        if path in staged_set and path not in command_set)
    command_only = tuple(path for path in all_paths
                         if path in command_set and path not in staged_set)
    both = tuple(path for path in all_paths
                 if path in staged_set and path in command_set)
    message = (
        "提交前检测到由 COMPILE 命令产生或改写、且 Agent 未直接修改的文件: "
        + "、".join(all_paths)
        + "。这些文件只能保留在本地构建现场，禁止进入本次提交。")
    if staged_only:
        message += (
            "已在暂存区的路径: " + "、".join(staged_only)
            + "。执行 git restore --staged -- <上述路径> 只移出暂存区，"
            "不删除本地文件。")
    if command_only:
        message += (
            "当前命令尚未执行但会纳入提交的路径: "
            + "、".join(command_only)
            + "。从当前 git add 清单、git commit -a 或 commit pathspec 中"
            "移除这些路径后重试。")
    if both:
        message += (
            "以下路径已暂存且当前命令会再次纳入提交: " + "、".join(both)
            + "。先执行 git restore --staged -- <上述路径> 只移出暂存区，"
            "不删除本地文件；再从当前 git add 清单、git commit -a 或 "
            "commit pathspec 中移除这些路径后重试。")
    return GateDecision(
        "block",
        "bash-compile-side-effects",
        message,
    )


def _inherited_block(facts):
    if facts.inherited:
        return GateDecision(
            "block",
            "bash-cross-delivery-carryover",
            "提交前检测到流程启动前已经存在、内容至今未变，且本单 Agent "
            "没有实际改写的文件: "
            + "、".join(facts.inherited[:8])
            + ("…" if len(facts.inherited) > 8 else "")
            + "。它们属于上一单/用户现场，不能因为本次暂存而变成本单交付。"
            "执行 git restore --staged -- <上述路径> 只移出暂存区；"
            "若本单确实需要某文件，让 Agent 按本单需求实际修改并检视后再提交。",
        )
    return None


def _foreign_block(facts):
    if facts.foreign_openspec:
        return GateDecision(
            "block",
            "bash-foreign-openspec",
            "提交前检测到不属于当前 CHANGE_NAME 或本次定稿产物的 OpenSpec "
            "文件: "
            + "、".join(facts.foreign_openspec[:8])
            + ("…" if len(facts.foreign_openspec) > 8 else "")
            + "。请从暂存区移除；STORY 只能写到 docs/story/STORY-<单号>.md，"
            "选择不入库后由流程移入 .mae-flow-work/story。",
        )
    return None


def _strong_artifact_block(facts):
    if facts.strong_artifacts:
        return GateDecision(
            "block",
            "bash-build-artifacts",
            "提交前检测到既非 Agent 直接改写、又属于本次新增的高置信临时"
            "编译产物或显式 force-add 的忽略文件: "
            + "、".join(facts.strong_artifacts[:8])
            + ("…" if len(facts.strong_artifacts) > 8 else "")
            + "。这些文件通常不应进入 MR。若已暂存，执行 "
            "git restore --staged -- <上述路径>（只移出暂存区，不删除本地文件），"
            "若命令是 git add && git commit，从 git add 清单中移除这些路径。"
            "保留在本地不会影响 push，不要仅为本轮产物修改业务仓 .gitignore。",
        )
    return None


def _ambiguous_artifact_paths(facts):
    """输出目录/产物后缀，且 Agent 从没直接写过的候选。

    只提示不拦曾让编译产物静默上车:提示走的是门禁放行时的 stderr，宿主不会把它
    送进模型上下文,Agent 眼里那次提交完全静默。但不能一刀切按路径拦——`bin/`
    `out/` 这些目录在有些项目里放的是正经源码。Agent 用 Write/Edit 亲手写过的
    文件是有意产出，仍然只提示;它没写过却出现在产物位置的，才是编译产出。
    """
    unproven = {path for path in facts.unproven_paths}
    return tuple(
        path for path in facts.artifact_hints if path in unproven)


def _ambiguous_artifact_block(facts):
    paths = _ambiguous_artifact_paths(facts)
    if not paths:
        return None
    return GateDecision(
        "block",
        "bash-build-output-artifacts",
        "提交前检测到位于常见输出目录或具有编译产物特征、且 Agent 从未直接改写过"
        "的候选: "
        + "、".join(paths[:8])
        + ("…" if len(paths) > 8 else "")
        + "。这类文件几乎都是编译产出，不应进入交付分支。若已暂存，执行 "
        "git restore --staged -- <上述路径>（只移出暂存区，不删除本地文件），"
        "若命令是 git add && git commit，从 git add 清单中移除这些路径。"
        "保留在本地不会影响 push，不要仅为本轮产物修改业务仓 .gitignore。"
        "确实需要交付预编译产物时，把文件和理由展示给用户，按下方拦截编号放行。",
    )


def _ownership_blocks(facts):
    # Integrity and irreversible side-effect boundaries are not user permits.
    # They must win before inherited/foreign ownership choices that do have an
    # exact authorization route.
    return tuple(block for block in (
        (
            _compile_side_effect_block(facts)
            if facts.compile_side_effects else None
        ),
        _strong_artifact_block(facts),
        _ambiguous_artifact_block(facts),
        _inherited_block(facts),
        _foreign_block(facts),
    ) if block)


def _aggregate_block(blocks):
    primary = blocks[0]
    if len(blocks) == 1:
        return primary
    details = "\n".join(
        "- [%s] %s" % (block.rule, block.message)
        for block in blocks[1:]
    )
    return GateDecision(
        primary.kind,
        primary.rule,
        primary.message
        + "\n同时检测到其他独立问题，请一次处理后再重试：\n"
        + details,
    )


def _advisories(facts):
    messages = []
    if facts.unproven_paths:
        messages.append(
            "[mae-flow] ⚠ 提交提示:以下文件不在 Agent 通过 Write/Edit/MultiEdit "
            "实际改写的候选范围内，可能是编译、格式化或生成命令的副作用；"
            "也可能是必要的移动/删除，因此本次不阻断。请逐个确认: "
            + "、".join(facts.unproven_paths[:8])
            + ("…" if len(facts.unproven_paths) > 8 else ""))
    authored_hints = tuple(
        path for path in facts.artifact_hints
        if path not in set(_ambiguous_artifact_paths(facts)))
    if authored_hints:
        messages.append(
            "[mae-flow] ⚠ 产物提示:以下候选位于常见输出目录或具有编译产物特征；"
            "即使 Agent 直接写过，也不代表必须提交，请结合 git diff 确认: "
            + "、".join(authored_hints[:8])
            + ("…" if len(authored_hints) > 8 else ""))
    return tuple(messages)


def decide_ownership(facts):
    blocks = _ownership_blocks(facts)
    block = _aggregate_block(blocks) if blocks else None
    return OwnershipDecision(
        block=block,
        advisories=() if block else _advisories(facts),
    )
