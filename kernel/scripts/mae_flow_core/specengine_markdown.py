"""Markdown and delta-spec parsing for the specification engine."""

from .specengine_base import (
    SpecEngineError, _ANY_HEADER_RE, _DELTA_HEADER_RE, _HEADER_LINE_RE,
    _METADATA_LINE_RE, _REMOVED_BULLET_RE, _RENAME_FROM_RE, _RENAME_TO_RE,
    _REQUIREMENTS_SECTION_RE, _REQ_HEADER_RE, _REQ_HEADER_STRICT_RE,
    _SCENARIO_ANY_RE, _SCENARIO_NAMED_RE, _SECTION_H2_RE, _SHALL_RE,
    _TOP_LEVEL_SECTION_RE, _norm_newlines, re,
)

def _build_code_fence_mask(lines):
    """镜像 buildCodeFenceMask：围栏行与围栏内行标 True。"""
    mask = [False] * len(lines)
    active = None
    for i, line in enumerate(lines):
        fence = re.match(r"^\s*(`{3,}|~{3,})", line)
        if active is None:
            if fence:
                active = (fence.group(1)[0], len(fence.group(1)))
                mask[i] = True
            continue
        mask[i] = True
        closing = re.match(r"^\s*(`{3,}|~{3,})\s*$", line)
        if closing and closing.group(1)[0] == active[0] and len(closing.group(1)) >= active[1]:
            active = None
    return mask


def _strip_fenced_blocks_preserving_lines(content):
    """镜像 stripFencedCodeBlocksPreservingLines：围栏区间替换为空行，行号不变。"""
    lines = content.split("\n")
    output = []
    active = None
    for line in lines:
        fence = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
        if active is None:
            if fence:
                active = (fence.group(1)[0], len(fence.group(1)))
                output.append("")
            else:
                output.append(line)
            continue
        output.append("")
        closing = re.match(r"^\s*(`{3,}|~{3,})\s*$", line)
        if closing and closing.group(1)[0] == active[0] and len(closing.group(1)) >= active[1]:
            active = None
    return "\n".join(output)


def _contains_shall_or_must(text):
    return bool(_SHALL_RE.search(text))


def _extract_requirement_body(body_lines):
    """镜像 extractRequirementBody：取正文非空行（元数据行兜底），遇任何标题行停。"""
    mask = _build_code_fence_mask(body_lines)
    captured = []
    metadata = []
    for i, line in enumerate(body_lines):
        if mask[i]:
            continue
        if _HEADER_LINE_RE.match(line):
            break
        trimmed = line.strip()
        if not trimmed:
            continue
        if _METADATA_LINE_RE.match(trimmed):
            metadata.append(trimmed)
            continue
        captured.append(trimmed)
    if captured:
        return "\n".join(captured)
    return "\n".join(metadata)


def _count_scenarios(body_lines):
    """镜像 countScenarios：非围栏内、任意 ``#### `` 头都计数（恰好四个井号）。"""
    mask = _build_code_fence_mask(body_lines)
    count = 0
    for i, line in enumerate(body_lines):
        if not mask[i] and _SCENARIO_ANY_RE.match(line):
            count += 1
    return count


def _split_top_level_sections(content):
    """镜像 splitTopLevelSections：仅二级标题分节；重名节保留首位置、正文取末次。"""
    lines = content.split("\n")
    headers = []
    for i, line in enumerate(lines):
        match = _SECTION_H2_RE.match(line)
        if match:
            headers.append((match.group(2).strip(), i))
    sections = {}
    order = []
    for pos, (title, index) in enumerate(headers):
        end = headers[pos + 1][1] if pos + 1 < len(headers) else len(lines)
        body = "\n".join(lines[index + 1:end])
        if title not in sections:
            order.append(title)
        sections[title] = {"body": body, "body_start_line": index + 2}
    return [(title, sections[title]) for title in order]


def _section_case_insensitive(sections, desired):
    target = desired.lower()
    for title, info in sections:
        if title.lower() == target:
            return {"title": title, "body": info["body"],
                    "body_start_line": info["body_start_line"], "found": True}
    return {"title": desired, "body": "", "body_start_line": 0, "found": False}


def _parse_requirement_blocks(section_body, section_title, body_start_line, sink):
    """镜像 parseRequirementBlocksFromSection。

    注意：与 CLI 相同，块识别不看围栏；围栏掩码只用于“被忽略的三级标题”记录。
    块边界 = 下一个 ``### Requirement:`` 或任何二级标题。
    """
    if not section_body:
        return []
    lines = _norm_newlines(section_body).split("\n")
    mask = _build_code_fence_mask(lines) if sink is not None else None

    def record_skipped(index):
        if sink is None or mask[index]:
            return
        h3 = re.match(r"^###\s+(.+?)\s*$", lines[index])
        if h3 and not _REQ_HEADER_RE.match(lines[index]):
            sink.append({
                "header": h3.group(1).strip(),
                "section": section_title,
                "line": body_start_line + index,
            })

    blocks = []
    i = 0
    while i < len(lines):
        while i < len(lines) and not _REQ_HEADER_RE.match(lines[i]):
            record_skipped(i)
            i += 1
        if i >= len(lines):
            break
        header_line = lines[i]
        name = _REQ_HEADER_RE.match(header_line).group(1).strip()
        buf = [header_line]
        i += 1
        while i < len(lines) and not _REQ_HEADER_RE.match(lines[i]) \
                and not re.match(r"^##\s+", lines[i]):
            record_skipped(i)
            buf.append(lines[i])
            i += 1
        blocks.append({
            "header_line": header_line,
            "name": name,
            "raw": "\n".join(buf).rstrip(),
        })
    return blocks


def _parse_removed_names(section_body):
    if not section_body:
        return []
    names = []
    for line in _norm_newlines(section_body).split("\n"):
        match = _REQ_HEADER_RE.match(line)
        if match:
            names.append(match.group(1).strip())
            continue
        bullet = _REMOVED_BULLET_RE.match(line)
        if bullet:
            names.append(bullet.group(1).strip())
    return names


def _parse_renamed_pairs(section_body):
    if not section_body:
        return []
    pairs = []
    current = {}
    for line in _norm_newlines(section_body).split("\n"):
        from_match = _RENAME_FROM_RE.match(line)
        to_match = _RENAME_TO_RE.match(line)
        if from_match:
            current["from"] = from_match.group(1).strip()
        elif to_match:
            current["to"] = to_match.group(1).strip()
            if current.get("from") and current.get("to"):
                pairs.append({"from": current["from"], "to": current["to"]})
                current = {}
    return pairs


def _parse_delta_spec(content):
    """镜像 parseDeltaSpec：四个分节 → added/modified 块、removed 名、renamed 对。"""
    normalized = _norm_newlines(content)
    sections = _split_top_level_sections(normalized)
    added_sec = _section_case_insensitive(sections, "ADDED Requirements")
    modified_sec = _section_case_insensitive(sections, "MODIFIED Requirements")
    removed_sec = _section_case_insensitive(sections, "REMOVED Requirements")
    renamed_sec = _section_case_insensitive(sections, "RENAMED Requirements")
    skipped = []
    added = _parse_requirement_blocks(
        added_sec["body"], added_sec["title"], added_sec["body_start_line"], skipped)
    modified = _parse_requirement_blocks(
        modified_sec["body"], modified_sec["title"], modified_sec["body_start_line"],
        skipped)
    removed = _parse_removed_names(removed_sec["body"])
    renamed = _parse_renamed_pairs(renamed_sec["body"])
    skipped.sort(key=lambda item: item["line"])
    return {
        "added": added,
        "modified": modified,
        "removed": removed,
        "renamed": renamed,
        "skipped": skipped,
        "presence": {
            "added": added_sec["found"],
            "modified": modified_sec["found"],
            "removed": removed_sec["found"],
            "renamed": renamed_sec["found"],
        },
    }


def _find_main_spec_structure_issues(content):
    """镜像 findMainSpecStructureIssues：主 spec 里的 delta 头 / 越界 requirement 头。"""
    normalized = _norm_newlines(content)
    stripped = _strip_fenced_blocks_preserving_lines(normalized)
    lines = stripped.split("\n")
    issues = []
    req_header_index = -1
    for i, line in enumerate(lines):
        if _REQUIREMENTS_SECTION_RE.match(line):
            req_header_index = i
            break
    req_end_index = len(lines)
    if req_header_index != -1:
        for i in range(req_header_index + 1, len(lines)):
            if _TOP_LEVEL_SECTION_RE.match(lines[i]):
                req_end_index = i
                break
    for i, line in enumerate(lines):
        trimmed = line.strip()
        if not trimmed:
            continue
        if _DELTA_HEADER_RE.match(line):
            issues.append({
                "line": i + 1,
                "message": "主 spec 出现 delta 专用分节头 \"%s\"；该类头只允许出现在 "
                           "openspec/changes/<name>/specs/<域>/spec.md 里" % trimmed,
            })
            continue
        if not _REQ_HEADER_STRICT_RE.match(line):
            continue
        inside = req_header_index != -1 and req_header_index < i < req_end_index
        if not inside:
            issues.append({
                "line": i + 1,
                "message": "requirement 头 \"%s\" 出现在 \"## Requirements\" 分节之外，"
                           "校验/归档都看不到它" % trimmed,
            })
    return issues


def _extract_requirements_section(content):
    """镜像 extractRequirementsSection：拆出 before/标题行/前言/块列表/after。

    保留 CLI 的两个怪癖：
    - 找不到 ``## Requirements`` 时，before 用原始（未归一行尾）内容 trimEnd；
    - before 非空时补一个换行，after 不以换行开头时补一个换行。
    """
    normalized = _norm_newlines(content)
    lines = normalized.split("\n")
    req_index = -1
    for i, line in enumerate(lines):
        if _REQUIREMENTS_SECTION_RE.match(line):
            req_index = i
            break
    if req_index == -1:
        before = content.rstrip()
        return {
            "before": (before + "\n\n") if before else "",
            "header_line": "## Requirements",
            "preamble": "",
            "body_blocks": [],
            "after": "\n",
        }
    end_index = len(lines)
    for i in range(req_index + 1, len(lines)):
        if re.match(r"^##\s+", lines[i]):
            end_index = i
            break
    before = "\n".join(lines[:req_index])
    header_line = lines[req_index]
    body_lines = lines[req_index + 1:end_index]
    blocks = []
    cursor = 0
    preamble_lines = []
    while cursor < len(body_lines) and not _REQ_HEADER_RE.match(body_lines[cursor]):
        preamble_lines.append(body_lines[cursor])
        cursor += 1
    while cursor < len(body_lines):
        header_candidate = body_lines[cursor]
        match = _REQ_HEADER_RE.match(header_candidate)
        if not match:
            cursor += 1
            continue
        name = match.group(1).strip()
        cursor += 1
        block_lines = [header_candidate]
        while cursor < len(body_lines) and not _REQ_HEADER_RE.match(body_lines[cursor]) \
                and not re.match(r"^##\s+", body_lines[cursor]):
            block_lines.append(body_lines[cursor])
            cursor += 1
        blocks.append({
            "header_line": header_candidate,
            "name": name,
            "raw": "\n".join(block_lines).rstrip(),
        })
    after = "\n".join(lines[end_index:])
    return {
        "before": (before + "\n") if before.rstrip() else before,
        "header_line": header_line,
        "preamble": "\n".join(preamble_lines).rstrip(),
        "body_blocks": blocks,
        "after": after if after.startswith("\n") else "\n" + after,
    }


def _parse_scenario_blocks(requirement_raw):
    """镜像 parseScenarioBlocks：按 ``#### Scenario: 名`` 切块（区分大小写）。"""
    lines = _norm_newlines(requirement_raw).split("\n")
    scenarios = []
    index = 0
    while index < len(lines):
        match = _SCENARIO_NAMED_RE.match(lines[index])
        if not match:
            index += 1
            continue
        name = match.group(1).strip()
        index += 1
        while index < len(lines) and not _SCENARIO_NAMED_RE.match(lines[index]):
            index += 1
        scenarios.append(name)
    return scenarios


# --- 主 spec 的层级解析（镜像 MarkdownParser，用于重建结果的 spec 级校验） ---

def _parse_section_tree(content):
    normalized = _norm_newlines(content)
    lines = normalized.split("\n")
    mask = _build_code_fence_mask(lines)

    def content_until_next_header(start, level):
        collected = []
        for i in range(start, len(lines)):
            header = None if mask[i] else re.match(r"^(#{1,6})\s+", lines[i])
            if header and len(header.group(1)) <= level:
                break
            collected.append(lines[i])
        return "\n".join(collected).strip()

    sections = []
    stack = []
    for i, line in enumerate(lines):
        if mask[i]:
            continue
        match = _ANY_HEADER_RE.match(line)
        if not match:
            continue
        level = len(match.group(1))
        section = {
            "level": level,
            "title": match.group(2).strip(),
            "content": content_until_next_header(i + 1, level),
            "children": [],
        }
        while stack and stack[-1]["level"] >= level:
            stack.pop()
        if stack:
            stack[-1]["children"].append(section)
        else:
            sections.append(section)
        stack.append(section)
    return sections


def _find_section(sections, title):
    """镜像 findSection：先序深度优先，标题整体不区分大小写精确匹配。"""
    target = title.lower()
    for section in sections:
        if section["title"].lower() == target:
            return section
        child = _find_section(section["children"], title)
        if child is not None:
            return child
    return None


def _validate_main_spec_content(spec_name, content):
    """镜像 validateSpecContent + applySpecRules：返回 (level, message) 列表。

    归档前对重建后的主 spec 内容做该校验，任何 ERROR 都会中止归档且不写盘。
    """
    issues = []
    try:
        tree = _parse_section_tree(content)
        purpose_sec = _find_section(tree, "Purpose")
        purpose = purpose_sec["content"] if purpose_sec else ""
        requirements_sec = _find_section(tree, "Requirements")
        if not purpose:
            raise SpecEngineError(
                "spec 缺少 \"## Purpose\" 分节（或该分节为空）")
        if requirements_sec is None:
            raise SpecEngineError("spec 缺少 \"## Requirements\" 分节")
        overview = purpose.strip()
        requirements = []
        for child in requirements_sec["children"]:
            body_lines = child["content"].split("\n")
            text = _extract_requirement_body(body_lines) or child["title"].strip()
            scenarios = [
                grandchild for grandchild in child["children"]
                if grandchild["content"].strip()
            ]
            requirements.append(
                {"title": child["title"], "text": text, "scenarios": scenarios})
        # —— zod SpecSchema 等价检查 ——
        if not overview:
            issues.append(("ERROR", "%s：Purpose 分节内容为空" % spec_name))
        if not requirements:
            issues.append(("ERROR", "%s：\"## Requirements\" 下没有任何 requirement"
                           % spec_name))
        for idx, req in enumerate(requirements):
            if not req["text"]:
                issues.append(("ERROR", "%s：第 %d 个 requirement 正文为空"
                               % (spec_name, idx + 1)))
            if not req["scenarios"]:
                issues.append(("ERROR",
                               "%s：requirement \"%s\" 没有任何非空 \"#### Scenario:\" 场景"
                               % (spec_name, req["title"])))
        # —— applySpecRules 等价检查 ——
        for structural in _find_main_spec_structure_issues(content):
            issues.append(("ERROR", "%s：第 %d 行：%s"
                           % (spec_name, structural["line"], structural["message"])))
        if len(overview) < 50:
            issues.append(("WARNING", "%s：Purpose 太简略（不足 50 字符）" % spec_name))
        for idx, req in enumerate(requirements):
            if len(req["text"]) > 500:
                issues.append(("INFO", "%s：第 %d 个 requirement 正文超过 500 字符，"
                               "考虑拆分" % (spec_name, idx + 1)))
            if not req["scenarios"]:
                issues.append(("WARNING",
                               "%s：requirement \"%s\" 缺场景（\"#### Scenario:\" 恰好"
                               "四个井号）" % (spec_name, req["title"])))
        for block in _extract_requirements_section(content)["body_blocks"]:
            body = _extract_requirement_body(block["raw"].split("\n")[1:])
            if not body or not _contains_shall_or_must(body):
                issues.append(("ERROR",
                               "%s：requirement \"%s\" 正文缺少 SHALL/MUST（英文大写，"
                               "且必须在头下方正文行里）" % (spec_name, block["name"])))
    except SpecEngineError as exc:
        issues.append(("ERROR", "%s：%s" % (spec_name, exc)))
    return issues
