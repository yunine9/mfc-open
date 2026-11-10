"""Pure main-spec merge rendering for archive application."""

from .specengine_base import SpecEngineError, _REQ_HEADER_RE, _norm_newlines, re
from .specengine_markdown import (
    _extract_requirements_section, _find_main_spec_structure_issues,
    _parse_delta_spec, _parse_scenario_blocks, _validate_main_spec_content,
)

def _build_spec_skeleton(spec_name, change_name):
    """镜像 buildSpecSkeleton（新建域时的主 spec 骨架）。"""
    return ("# %s Specification\n\n## Purpose\nTBD - created by archiving change "
            "%s. Update Purpose after archive.\n\n## Requirements\n"
            % (spec_name, change_name))


def _build_updated_spec(source_content, target_content, spec_name, change_name):
    """镜像 buildUpdatedSpec：纯内存计算重建后的主 spec 内容。

    返回 ``(rebuilt, counts, warnings)``；target_content 传 None 表示目标域
    尚不存在。所有失败点的触发条件与顺序与 CLI 相同，消息中文化。
    """
    plan = _parse_delta_spec(source_content)
    warnings = []
    # —— 段内重复检查（与 CLI 相同的先后顺序，先出现者先报错） ——
    seen = set()
    for block in plan["added"]:
        if block["name"] in seen:
            raise SpecEngineError(
                "%s 校验失败：ADDED 段重复 requirement \"### Requirement: %s\""
                % (spec_name, block["name"]))
        seen.add(block["name"])
    added_names = seen
    seen = set()
    for block in plan["modified"]:
        if block["name"] in seen:
            raise SpecEngineError(
                "%s 校验失败：MODIFIED 段重复 requirement \"### Requirement: %s\""
                % (spec_name, block["name"]))
        seen.add(block["name"])
    modified_names = seen
    seen = set()
    for name in plan["removed"]:
        if name in seen:
            raise SpecEngineError(
                "%s 校验失败：REMOVED 段重复 requirement \"### Requirement: %s\""
                % (spec_name, name))
        seen.add(name)
    removed_names = seen
    renamed_from = set()
    renamed_to = set()
    for pair in plan["renamed"]:
        if pair["from"] in renamed_from:
            raise SpecEngineError(
                "%s 校验失败：RENAMED 段重复 FROM \"### Requirement: %s\""
                % (spec_name, pair["from"]))
        if pair["to"] in renamed_to:
            raise SpecEngineError(
                "%s 校验失败：RENAMED 段重复 TO \"### Requirement: %s\""
                % (spec_name, pair["to"]))
        renamed_from.add(pair["from"])
        renamed_to.add(pair["to"])
    # —— 跨段冲突（收集后统一抛第一个；RENAMED 相关的两类先抛，与 CLI 一致） ——
    conflicts = []
    for name in modified_names:
        if name in removed_names:
            conflicts.append((name, "MODIFIED", "REMOVED"))
        if name in added_names:
            conflicts.append((name, "MODIFIED", "ADDED"))
    for name in added_names:
        if name in removed_names:
            conflicts.append((name, "ADDED", "REMOVED"))
    for pair in plan["renamed"]:
        if pair["from"] in modified_names:
            raise SpecEngineError(
                "%s 校验失败：存在改名时 MODIFIED 必须引用新名 \"### Requirement: %s\""
                % (spec_name, pair["to"]))
        if pair["to"] in added_names:
            raise SpecEngineError(
                "%s 校验失败：RENAMED 的 TO 与 ADDED 冲突 \"### Requirement: %s\""
                % (spec_name, pair["to"]))
    if conflicts:
        name, section_a, section_b = conflicts[0]
        raise SpecEngineError(
            "%s 校验失败：requirement \"### Requirement: %s\" 同时出现在 %s 和 %s"
            % (spec_name, name, section_a, section_b))
    if not (plan["added"] or plan["modified"] or plan["removed"] or plan["renamed"]):
        raise SpecEngineError(
            "%s 的 delta spec 没有解析出任何操作；请提供 ADDED/MODIFIED/REMOVED/"
            "RENAMED 分节" % spec_name)
    # —— 目标读取 / 新建域骨架 ——
    is_new_spec = False
    if target_content is None:
        if plan["modified"] or plan["renamed"]:
            raise SpecEngineError(
                "%s：目标主 spec 不存在；新建域只允许 ADDED，MODIFIED/RENAMED 需要"
                "已有 spec（openspec/specs/%s/spec.md）" % (spec_name, spec_name))
        if plan["removed"]:
            warnings.append(
                "%s：目标是新建域，%d 个 REMOVED 被忽略（没有可删对象）"
                % (spec_name, len(plan["removed"])))
        is_new_spec = True
        target_content = _build_spec_skeleton(spec_name, change_name)
    structure_issues = _find_main_spec_structure_issues(target_content)
    if structure_issues:
        details = "\n".join("第 %d 行：%s" % (item["line"], item["message"])
                            for item in structure_issues)
        raise SpecEngineError(
            "%s：目标主 spec 结构非法，修复前无法合并：\n%s" % (spec_name, details))
    parts = _extract_requirements_section(target_content)
    # dict 保插入序，等价 JS Map（改名块与新增块都追加到尾部）。
    name_to_block = {}
    for block in parts["body_blocks"]:
        name_to_block[block["name"]] = block
    for pair in plan["renamed"]:
        if pair["from"] not in name_to_block:
            raise SpecEngineError(
                "%s RENAMED 失败：\"### Requirement: %s\" 在主 spec 里找不到"
                % (spec_name, pair["from"]))
        if pair["to"] in name_to_block:
            raise SpecEngineError(
                "%s RENAMED 失败：目标名 \"### Requirement: %s\" 已存在"
                % (spec_name, pair["to"]))
        block = name_to_block.pop(pair["from"])
        raw_lines = block["raw"].split("\n")
        raw_lines[0] = "### Requirement: %s" % pair["to"]
        name_to_block[pair["to"]] = {
            "header_line": raw_lines[0],
            "name": pair["to"],
            "raw": "\n".join(raw_lines),
        }
    for name in plan["removed"]:
        if name not in name_to_block:
            if not is_new_spec:
                raise SpecEngineError(
                    "%s REMOVED 失败：\"### Requirement: %s\" 在主 spec 里找不到"
                    % (spec_name, name))
            continue
        name_to_block.pop(name)
    for block in plan["modified"]:
        current = name_to_block.get(block["name"])
        if current is None:
            raise SpecEngineError(
                "%s MODIFIED 失败：\"### Requirement: %s\" 在主 spec 里找不到；"
                "MODIFIED 必须整段替换同名 requirement" % (spec_name, block["name"]))
        head = _REQ_HEADER_RE.match(block["raw"].split("\n")[0])
        if not head or head.group(1).strip() != block["name"]:
            raise SpecEngineError(
                "%s MODIFIED 失败：\"### Requirement: %s\" 内容首行头不匹配"
                % (spec_name, block["name"]))
        current_scenarios = _parse_scenario_blocks(current["raw"])
        incoming_scenarios = set(_parse_scenario_blocks(block["raw"]))
        dropped = [name for name in current_scenarios
                   if name not in incoming_scenarios]
        if dropped:
            raise SpecEngineError(
                "%s MODIFIED 失败：\"### Requirement: %s\" 的现有场景 %s 没有出现在"
                "修改块里；MODIFIED 必须携带整段内容，否则归档会丢场景"
                % (spec_name, block["name"],
                   ", ".join('"%s"' % item for item in dropped)))
        # JS Map.set 对已有键不改变位置——dict 同语义，原位替换。
        name_to_block[block["name"]] = block
    for block in plan["added"]:
        if block["name"] in name_to_block:
            raise SpecEngineError(
                "%s ADDED 失败：\"### Requirement: %s\" 已存在；新增不能与现有"
                "requirement 重名" % (spec_name, block["name"]))
        name_to_block[block["name"]] = block
    # —— 重建（顺序：原文顺序的存留块 → 改名块 → 新增块，同 CLI） ——
    kept = []
    seen_keys = set()
    for block in parts["body_blocks"]:
        replacement = name_to_block.get(block["name"])
        if replacement is not None:
            kept.append(replacement)
            seen_keys.add(block["name"])
    for key, block in name_to_block.items():
        if key not in seen_keys:
            kept.append(block)
    pieces = []
    if parts["preamble"].strip():
        pieces.append(parts["preamble"].rstrip())
    pieces.extend(block["raw"] for block in kept)
    req_body = "\n\n".join(pieces).rstrip()
    segments = [parts["before"].rstrip(), parts["header_line"], req_body,
                parts["after"]]
    if segments[0] == "":
        segments = segments[1:]
    rebuilt = re.sub(r"\n{3,}", "\n\n", "\n".join(segments))
    counts = {
        "added": len(plan["added"]),
        "modified": len(plan["modified"]),
        "removed": len(plan["removed"]),
        "renamed": len(plan["renamed"]),
    }
    return rebuilt, counts, warnings
