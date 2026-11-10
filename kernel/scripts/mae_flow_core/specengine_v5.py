"""V5 change-document layout and validation sources."""

from .specengine_base import (
    SpecEngineError, _HAS_DELTA_RE, _change_dir, _norm_newlines, _read_text,
    _read_text_utf8, _rel_under, _require_change_dir, _validate_change_name,
    os, re,
)
from .specengine_markdown import (
    _build_code_fence_mask, _contains_shall_or_must, _count_scenarios,
    _extract_requirement_body, _parse_delta_spec,
)

# ---------------------------------------------------------------------------
# v5 四合一 change.md —— 轻量布局的解析与骨架
#
# v5 布局的 change 目录只有一个 change.md，四个固定小节用一级标题分隔：
#   # 为什么 / # 规格条目：<域>（可多节，每域一节）/ # 方案 / # 实现清单
# 规格条目节的节体就是标准 delta spec 原格式（## ADDED Requirements、
# ### Requirement:、#### Scenario: 层级原样），因此 delta 的解析与合并
# 走完全相同的 _parse_delta_spec / _build_updated_spec 核心，只是"内容从
# 哪来"由 specs/<域>/spec.md 文件换成了 change.md 里的规格条目节。
# 布局探测：change.md 存在 → v5；否则 legacy（在途旧单照原样走完）。
# 两种布局标志并存（change.md 与 proposal.md/tasks.md/specs/ 同在）判为
# 布局混用，validate/archive 都会拒绝——静默偏向任何一边都等于丢内容。
# ---------------------------------------------------------------------------

CHANGE_DOC_NAME = "change.md"
V5_TIERS = ("full", "hotfix", "tweak")
V5_SECTION_WHY = "为什么"
V5_SECTION_SPEC = "规格条目"
V5_SECTION_DESIGN = "方案"
V5_SECTION_TASKS = "实现清单"
# v5 各档的必须节（多写不禁止；规格条目在 hotfix/tweak 档"确有规格变化才写"）。
V5_TIER_REQUIRED = {
    "full": (V5_SECTION_WHY, V5_SECTION_SPEC, V5_SECTION_DESIGN, V5_SECTION_TASKS),
    "hotfix": (V5_SECTION_WHY, V5_SECTION_TASKS),
    "tweak": (V5_SECTION_WHY, V5_SECTION_TASKS),
}
_V5_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_V5_SPEC_HEAD_RE = re.compile(r"^%s\s*[:：]\s*(.*)$" % V5_SECTION_SPEC)


def _change_doc_path(change_dir):
    return os.path.join(change_dir, CHANGE_DOC_NAME)


def _change_layout(change_dir):
    """"v5"（change.md 在）或 "legacy"。只探测，不校验混用。"""
    return "v5" if os.path.isfile(_change_doc_path(change_dir)) else "legacy"


def _legacy_markers(change_dir):
    """目录里存在的旧布局标志（用于布局混用检查与报错文案）。"""
    found = []
    for marker in ("proposal.md", "tasks.md", "design.md"):
        if os.path.isfile(os.path.join(change_dir, marker)):
            found.append(marker)
    if os.path.isdir(os.path.join(change_dir, "specs")):
        found.append("specs/")
    return found


def _require_layout_pure(change_dir):
    """v5 与旧布局标志并存时拒绝继续（validate / archive 共用）。"""
    if _change_layout(change_dir) != "v5":
        return
    markers = _legacy_markers(change_dir)
    if markers:
        raise SpecEngineError(
            "change 目录布局混用：change.md 与旧布局产物（%s）并存。"
            "四合一 change.md 与 proposal/tasks/specs 四件套只能二选一——"
            "把旧产物内容并入 change.md 对应小节后删除旧文件，或删掉 change.md "
            "继续按旧布局走完" % "、".join(markers))


def _validate_v5_domain(name):
    """规格条目节的域名做路径拼接，必须先过安全门。"""
    if not name:
        raise SpecEngineError(
            "change.md 的 \"# 规格条目：\" 节缺少域名；请写成 "
            "\"# 规格条目：<域名>\"（域名 = openspec/specs/ 下的目录名）")
    if "{" in name or "}" in name:
        raise SpecEngineError(
            "change.md 规格条目的域名含未替换占位符：%s" % name)
    if ".." in name or "/" in name or "\\" in name:
        raise SpecEngineError(
            "change.md 规格条目的域名不能包含路径分隔符或 '..'：%s" % name)
    return name


def _parse_change_doc(content):
    """把 change.md 按一级标题切成小节。

    - 边界 = 非围栏区的一级标题行（恰好一个 #）；围栏内的 "# ..."（代码注释）
      不算边界，因此方案/实现清单节里可以放代码块；
    - 已知节名：为什么 / 方案 / 实现清单（精确匹配）与 规格条目[:：]<域>；
      其他一级标题（如文档标题 "# 变更：xxx"）开启未知节，内容不归任何小节；
    - 同名节重复出现取首节并记录 duplicate；规格条目按域记录重复。
    """
    lines = _norm_newlines(content).split("\n")
    mask = _build_code_fence_mask(lines)
    boundaries = []
    for i, line in enumerate(lines):
        if mask[i]:
            continue
        match = _V5_H1_RE.match(line)
        if match:
            boundaries.append((i, match.group(1).strip()))
    sections = {}
    duplicate_sections = []
    domains = []
    domain_names = []
    duplicate_domains = []
    unknown_titles = []
    for pos, (index, title) in enumerate(boundaries):
        end = boundaries[pos + 1][0] if pos + 1 < len(boundaries) else len(lines)
        body = "\n".join(lines[index + 1:end])
        spec_head = _V5_SPEC_HEAD_RE.match(title)
        if spec_head:
            domain = spec_head.group(1).strip()
            if domain in domain_names:
                duplicate_domains.append(domain)
            else:
                domain_names.append(domain)
                domains.append({"domain": domain, "body": body,
                                "body_start_line": index + 2})
            continue
        if title in (V5_SECTION_WHY, V5_SECTION_DESIGN, V5_SECTION_TASKS):
            if title in sections:
                duplicate_sections.append(title)
            else:
                sections[title] = body
            continue
        # 首个未知一级头按文档标题惯例放行；其余未知一级头会切断前一节，
        # 记录下来供校验提示（小节内的一级头是最容易踩的书写错误）。
        if pos > 0:
            unknown_titles.append({"title": title, "line": index + 1})
    return {
        "sections": sections,
        "domains": domains,
        "duplicate_sections": duplicate_sections,
        "duplicate_domains": duplicate_domains,
        "unknown_titles": unknown_titles,
    }


def _read_change_doc(change_dir):
    # UnicodeDecodeError 不是 OSError——编码坏的 change.md 若不在这里收口,
    # 会以裸 traceback 穿透 validate/archive/done 全链(违背"流畅易用不卡死")。
    try:
        return _parse_change_doc(_read_text(_change_doc_path(change_dir)))
    except (OSError, UnicodeDecodeError) as exc:
        raise SpecEngineError(
            "change.md 读取失败（文件须为 UTF-8 编码）：%s" % exc)


def _build_change_skeleton(name, tier):
    """v5 change.md 骨架。占位统一带「（待填」前缀，流程证据据此拦残留。

    规格条目节不预置（预置就得放占位域名，占位域名会污染路径），由模型按
    ``spec instructions change`` 的格式合同在有规格变化时补写。
    """
    parts = ["# 变更：%s" % name, "", "# %s" % V5_SECTION_WHY, "",
             "（待填：背景与动机、目标/非目标）", ""]
    if tier == "full":
        # 方案节属设计阶段产出，用独立的「（待设计」前缀——open 步的占位
        # 检查不拦它，design 步的占位检查才拦。
        parts += ["# %s" % V5_SECTION_DESIGN, "",
                  "（待设计：技术方案结论，设计阶段填写）", ""]
    parts += ["# %s" % V5_SECTION_TASKS, "", "- [ ] 1. （待填：任务）", ""]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# validate —— 镜像 validateChangeDeltaSpecs（默认非 strict：仅 ERROR 定否决）
# ---------------------------------------------------------------------------

def _find_delta_spec_files(specs_dir):
    """镜像 findDeltaSpecFiles：递归收集所有名为 spec.md 的文件，绝对路径排序。"""
    results = []

    def walk(directory):
        try:
            entries = os.listdir(directory)
        except OSError:
            return
        for entry in entries:
            full = os.path.join(directory, entry)
            if os.path.isdir(full):
                walk(full)
            elif os.path.isfile(full) and entry == "spec.md":
                results.append(full)

    walk(specs_dir)
    return sorted(results)


def _shall_error_text(prefix, block_name):
    base = "%s 正文缺少 SHALL/MUST（须为英文大写词）" % prefix
    if _contains_shall_or_must(block_name):
        return (base + "；关键词只出现在 \"### Requirement:\" 头里不算，"
                "请移到头部下一行正文中")
    return base


def _iter_delta_validation_sources(change_dir):
    """delta 校验的内容源。v5 = change.md 的规格条目节（每域一条）；
    legacy = specs/ 下递归所有 spec.md（与 CLI 相同）。产出 (标签, 内容)。"""
    if _change_layout(change_dir) == "v5":
        for item in _read_change_doc(change_dir)["domains"]:
            yield "change.md 规格条目：%s" % item["domain"], item["body"]
        return
    specs_dir = os.path.join(change_dir, "specs")
    for spec_file in _find_delta_spec_files(specs_dir):
        try:
            content = _read_text_utf8(spec_file)
        except OSError:
            continue
        yield _rel_under(spec_file, specs_dir), content


def _collect_v5_structural_issues(change_dir):
    """v5 布局特有的结构问题（布局混用、域名非法/重复、小节重复）。

    返回 (issues, fatal)。fatal=True 表示布局混用——此时不应再按任何一边
    解析 delta（双源歧义），调用方需直接收尾。"""
    issues = []
    markers = _legacy_markers(change_dir)
    if markers:
        issues.append(("ERROR",
                       "change 目录布局混用：change.md 与旧布局产物（%s）并存。"
                       "把旧产物内容并入 change.md 对应小节后删除旧文件，或删掉 "
                       "change.md 继续按旧布局走完" % "、".join(markers)))
        return issues, True
    doc = _read_change_doc(change_dir)
    for title in doc["duplicate_sections"]:
        issues.append(("ERROR",
                       "change.md 小节 \"# %s\" 重复出现；每个小节只能有一个"
                       % title))
    for domain in doc["duplicate_domains"]:
        issues.append(("ERROR",
                       "change.md 规格条目域 \"%s\" 重复出现；同域的 delta 请合并"
                       "到一个 \"# 规格条目：%s\" 节里" % (domain, domain)))
    for item in doc["domains"]:
        try:
            _validate_v5_domain(item["domain"])
        except SpecEngineError as exc:
            issues.append(("ERROR", str(exc)))
    for stray in doc["unknown_titles"]:
        issues.append(("INFO",
                       "change.md 第 %d 行的一级标题 \"# %s\" 不是已知小节，"
                       "它会切断前一小节且内容不被解析；小节内的标题请用二级"
                       "及以下（规格条目节体本身就以 \"## ADDED Requirements\" "
                       "等二级标题开头）" % (stray["line"], stray["title"])))
    return issues, False
def _has_delta_specs(change_dir):
    """镜像 archive 的 hasDeltaSpecs 探测：一层 specs/<域>/spec.md，区分大小写。
    v5 布局改看 change.md 的规格条目节（同一条 _HAS_DELTA_RE 探测正则）。
    坏编码统一传播为带 UTF-8 指引的引擎错误（吞成 False 会让"有规格但读不了"
    伪装成"无规格轻量单"，规格被静默丢弃）。"""
    if _change_layout(change_dir) == "v5":
        doc = _read_change_doc(change_dir)
        return any(_HAS_DELTA_RE.search(item["body"]) for item in doc["domains"])
    specs_dir = os.path.join(change_dir, "specs")
    try:
        entries = os.listdir(specs_dir)
    except OSError:
        return False
    for entry in sorted(entries):
        candidate = os.path.join(specs_dir, entry, "spec.md")
        if not os.path.isdir(os.path.join(specs_dir, entry)):
            continue
        try:
            content = _read_text_utf8(candidate)
        except OSError:
            continue
        if _HAS_DELTA_RE.search(content):
            return True
    return False
