"""Delta validation and public validation queries."""

from .specengine_base import (
    SpecEngineError, _change_dir, _read_text, _require_change_dir,
    _validate_change_name, os, re,
)
from .specengine_markdown import (
    _contains_shall_or_must, _count_scenarios, _extract_requirement_body,
    _parse_delta_spec,
)
from .specengine_v5 import (
    V5_SECTION_SPEC, V5_SECTION_TASKS, V5_TIER_REQUIRED, _change_layout,
    _collect_v5_structural_issues, _has_delta_specs,
    _iter_delta_validation_sources, _read_change_doc, _require_layout_pure,
    _shall_error_text,
)

def _collect_delta_issues(change_dir):
    """对一个 change 目录执行 delta 校验，返回 (level, message) 列表。"""
    issues = []
    is_v5 = _change_layout(change_dir) == "v5"
    if is_v5:
        v5_issues, fatal = _collect_v5_structural_issues(change_dir)
        issues.extend(v5_issues)
        if fatal:
            return issues
    total_deltas = 0
    missing_header_specs = []
    empty_section_specs = []
    for entry, content in _iter_delta_validation_sources(change_dir):
        plan = _parse_delta_spec(content)
        for stray in plan["skipped"]:
            if re.match(r"^requirement:?$", stray["header"], re.I):
                message = ("%s 第 %d 行：%s 里的 \"### %s\" 缺少 requirement 名称，"
                           "已被校验忽略；请写成 \"### Requirement: <名称>\""
                           % (entry, stray["line"], stray["section"], stray["header"]))
            else:
                message = ("%s 第 %d 行：%s 里的 \"### %s\" 不是 \"### Requirement:\" 头，"
                           "已被校验忽略；若它应当是 requirement，请写成 "
                           "\"### Requirement: %s\"；若它是场景，请用四个井号 "
                           "\"#### Scenario:\""
                           % (entry, stray["line"], stray["section"],
                              stray["header"], stray["header"]))
            issues.append(("INFO", message))
        section_names = []
        if plan["presence"]["added"]:
            section_names.append("## ADDED Requirements")
        if plan["presence"]["modified"]:
            section_names.append("## MODIFIED Requirements")
        if plan["presence"]["removed"]:
            section_names.append("## REMOVED Requirements")
        if plan["presence"]["renamed"]:
            section_names.append("## RENAMED Requirements")
        has_entries = bool(plan["added"] or plan["modified"]
                           or plan["removed"] or plan["renamed"])
        if not has_entries:
            if section_names:
                empty_section_specs.append((entry, section_names))
            else:
                missing_header_specs.append(entry)
        added_names = set()
        modified_names = set()
        removed_names = set()
        renamed_from = set()
        renamed_to = set()
        for block in plan["added"]:
            total_deltas += 1
            key = block["name"]
            if key in added_names:
                issues.append(("ERROR", "%s：ADDED 段重复 requirement \"%s\""
                               % (entry, block["name"])))
            else:
                added_names.add(key)
            body = _extract_requirement_body(block["raw"].split("\n")[1:])
            if not body:
                if _contains_shall_or_must(block["name"]):
                    issues.append(("ERROR", "%s：%s" % (
                        entry, _shall_error_text("ADDED \"%s\"" % block["name"],
                                                 block["name"]))))
                else:
                    issues.append(("ERROR", "%s：ADDED \"%s\" 缺少正文"
                                   % (entry, block["name"])))
            elif not _contains_shall_or_must(body):
                issues.append(("ERROR", "%s：%s" % (
                    entry, _shall_error_text("ADDED \"%s\"" % block["name"],
                                             block["name"]))))
            if _count_scenarios(block["raw"].split("\n")[1:]) < 1:
                issues.append(("ERROR",
                               "%s：ADDED \"%s\" 至少要有一个场景（\"#### Scenario:\" "
                               "恰好四个井号）" % (entry, block["name"])))
        for block in plan["modified"]:
            total_deltas += 1
            key = block["name"]
            if key in modified_names:
                issues.append(("ERROR", "%s：MODIFIED 段重复 requirement \"%s\""
                               % (entry, block["name"])))
            else:
                modified_names.add(key)
            body = _extract_requirement_body(block["raw"].split("\n")[1:])
            if not body:
                if _contains_shall_or_must(block["name"]):
                    issues.append(("ERROR", "%s：%s" % (
                        entry, _shall_error_text("MODIFIED \"%s\"" % block["name"],
                                                 block["name"]))))
                else:
                    issues.append(("ERROR", "%s：MODIFIED \"%s\" 缺少正文"
                                   % (entry, block["name"])))
            elif not _contains_shall_or_must(body):
                issues.append(("ERROR", "%s：%s" % (
                    entry, _shall_error_text("MODIFIED \"%s\"" % block["name"],
                                             block["name"]))))
            if _count_scenarios(block["raw"].split("\n")[1:]) < 1:
                issues.append(("ERROR",
                               "%s：MODIFIED \"%s\" 至少要有一个场景（\"#### Scenario:\" "
                               "恰好四个井号）" % (entry, block["name"])))
        for name in plan["removed"]:
            total_deltas += 1
            if name in removed_names:
                issues.append(("ERROR", "%s：REMOVED 段重复 requirement \"%s\""
                               % (entry, name)))
            else:
                removed_names.add(name)
        for pair in plan["renamed"]:
            total_deltas += 1
            if pair["from"] in renamed_from:
                issues.append(("ERROR", "%s：RENAMED 段重复 FROM \"%s\""
                               % (entry, pair["from"])))
            else:
                renamed_from.add(pair["from"])
            if pair["to"] in renamed_to:
                issues.append(("ERROR", "%s：RENAMED 段重复 TO \"%s\""
                               % (entry, pair["to"])))
            else:
                renamed_to.add(pair["to"])
        for name in modified_names:
            if name in removed_names:
                issues.append(("ERROR",
                               "%s：requirement \"%s\" 同时出现在 MODIFIED 和 REMOVED"
                               % (entry, name)))
            if name in added_names:
                issues.append(("ERROR",
                               "%s：requirement \"%s\" 同时出现在 MODIFIED 和 ADDED"
                               % (entry, name)))
        for name in added_names:
            if name in removed_names:
                issues.append(("ERROR",
                               "%s：requirement \"%s\" 同时出现在 ADDED 和 REMOVED"
                               % (entry, name)))
        for pair in plan["renamed"]:
            if pair["from"] in modified_names:
                issues.append(("ERROR",
                               "%s：存在改名时 MODIFIED 必须引用新名，请用 \"%s\""
                               % (entry, pair["to"])))
            if pair["to"] in added_names:
                issues.append(("ERROR", "%s：RENAMED 的 TO \"%s\" 与 ADDED 冲突"
                               % (entry, pair["to"])))
    for entry, section_names in empty_section_specs:
        if len(section_names) == 1:
            rendered = section_names[0]
        else:
            rendered = "、".join(section_names[:-1]) + " 和 " + section_names[-1]
        issues.append(("ERROR",
                       "%s：找到了分节 %s，但没有解析出任何 requirement；每节至少要有"
                       "一个 \"### Requirement:\" 块（REMOVED 可用 \"- ### Requirement: "
                       "名\" 列表）" % (entry, rendered)))
    for entry in missing_header_specs:
        issues.append(("ERROR",
                       "%s：没有任何 delta 分节头；请添加 \"## ADDED Requirements\" 等，"
                       "或把非 delta 内容移出 specs/ 目录" % entry))
    if total_deltas == 0:
        if is_v5:
            issues.append(("ERROR",
                           "change 至少要有一个 delta：请在 change.md 里加 "
                           "\"# 规格条目：<域名>\" 节，节内用 "
                           "\"## ADDED/MODIFIED/REMOVED/RENAMED Requirements\" 分节，"
                           "且每个 requirement 至少带一个 \"#### Scenario:\" 场景"))
        else:
            issues.append(("ERROR",
                           "change 至少要有一个 delta：请在 specs/<域>/spec.md 里用 "
                           "\"## ADDED/MODIFIED/REMOVED/RENAMED Requirements\" 分节，"
                           "且每个 requirement 至少带一个 \"#### Scenario:\" 场景"))
    return issues


_LEVEL_PREFIX = {"ERROR": "[错误] ", "WARNING": "[警告] ", "INFO": "[提示] "}


def _format_issues(issues):
    return [_LEVEL_PREFIX.get(level, "") + text for level, text in issues]


def validate(root, change):
    """校验一个 change 的 delta specs；返回 ``(ok, messages)``。

    verdict 与 ``openspec validate <change>``（非 strict）一致：只有 ERROR 级
    问题才判 False；messages 里同时包含 [提示]/[警告] 级条目供人阅读。
    v5 布局对 change.md 的规格条目节执行同一套校验（外加布局混用、域名、
    重复节等 v5 结构检查）。
    change 不存在时抛 SpecEngineError（对应 CLI 的 "Unknown item"，非校验报告）。
    """
    change_dir = _require_change_dir(root, change)
    issues = _collect_delta_issues(change_dir)
    ok = not any(level == "ERROR" for level, _ in issues)
    return ok, _format_issues(issues)


def has_delta(root, change):
    """change 是否声明了规格变化（v5 看规格条目节，legacy 看 specs/ delta 头）。

    供流程侧区分"无规格变化的轻量单"（hotfix/tweak 允许）与"有规格但格式
    未过"——前者跳过 delta 校验，后者必须修到过。布局混用时这个问题没有
    可信答案，直接抛错（与 archive 的混用拒绝同一判据）。"""
    change_dir = _require_change_dir(root, change)
    _require_layout_pure(change_dir)
    return _has_delta_specs(change_dir)


def check_required_sections(root, change, tier):
    """v5 分档必须节的机器校验：返回缺失小节名列表（合规为空列表）。

    审计实锤：V5_TIER_REQUIRED 声明后一直无人消费，"full=四节"的分档合同
    在机器侧未接线——整节删除可静默过全部门禁。本函数由 ev_spec_validate
    在 done 时调用；legacy 布局或未知档位不查（返回空）。规格条目按
    "至少一个 # 规格条目：<域> 节"判定。"""
    change_dir = _require_change_dir(root, change)
    if tier not in V5_TIER_REQUIRED or _change_layout(change_dir) != "v5":
        return []
    doc = _read_change_doc(change_dir)
    missing = []
    for section in V5_TIER_REQUIRED[tier]:
        if section == V5_SECTION_SPEC:
            if not doc["domains"]:
                missing.append("%s：<域名>" % V5_SECTION_SPEC)
        elif section not in doc["sections"]:
            missing.append(section)
    return missing


def tasks_source(root, change):
    """实现清单的内容源：返回 ``(标签, 文本或 None)``。

    v5 = change.md 的 "# 实现清单" 节；legacy = tasks.md。None 表示源缺失
    （目录/文件/小节不在），报错文案由调用方组织。只统一"从哪来"——引擎
    _count_tasks 的顶层复选框语义与 gate 证据的宽松缩进语义历史上就不同，
    计数正则留在各自调用方。"""
    _validate_change_name(change)
    change_dir = _change_dir(root, change)
    # 混用（change.md 与 tasks.md 并存）时"清单从哪来"没有可信答案，
    # 与 has_delta 同一判据拒绝——静默偏向任何一边都可能读错进度。
    _require_layout_pure(change_dir)
    if _change_layout(change_dir) == "v5":
        label = ("openspec/changes/%s/change.md 的 \"# %s\" 节"
                 % (change, V5_SECTION_TASKS))
        # 坏编码传播为带 UTF-8 指引的引擎错误——吞成 None 会被调用方当
        # "实现清单缺失"报出，引导补节而不是修编码（审计实锤的错误指引）。
        doc = _read_change_doc(change_dir)
        return label, doc["sections"].get(V5_SECTION_TASKS)
    label = "openspec/changes/%s/tasks.md" % change
    try:
        return label, _read_text(os.path.join(change_dir, "tasks.md"))
    except OSError:
        return label, None
    except UnicodeDecodeError as exc:
        # 与 v5 的 _read_change_doc 对称:坏编码是"读取失败要修",不是"源缺失",
        # 收口为带指引的引擎错误,证据层转拒+可重试,不裸 traceback。
        raise SpecEngineError(
            "tasks.md 读取失败（文件须为 UTF-8 编码）：%s" % exc)
