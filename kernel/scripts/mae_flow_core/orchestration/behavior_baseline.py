"""Relevant-only domain context and durable documentation reconciliation."""

from dataclasses import dataclass
import os
import re


_DOMAIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL", "INDEX"}
    | {"COM%d" % number for number in range(1, 10)}
    | {"LPT%d" % number for number in range(1, 10)}
)
REQUIRED_DOMAIN_SECTIONS = (
    "领域目标与边界",
    "核心术语与不变量",
    "可观察行为与业务规则",
    "对外及跨组件契约",
    "数据、状态与兼容性",
    "性能、容量与资源限制",
    "异常、降级与恢复",
    "验证方式与测试关注点",
    "代码落点索引",
    "明确不包含的范围",
)
_PLACEHOLDER_CONTENT = frozenset({
    "", "无", "暂无", "待定", "待补充", "todo", "tbd", "n/a", "na",
})
_TEMPLATE_GUIDANCE = (
    "说明该领域解决的问题、责任边界以及与相邻领域的分界。",
    "定义长期使用的术语、判定口径和任何情况下都必须成立的不变量。",
    "记录用户或外部系统能够观察到的行为，以及当前有效的业务规则。",
    "记录 REST、CORBA、消息、文件格式或跨组件调用等稳定契约。",
    "记录关键数据含义、状态转换、升级兼容和存量数据处理规则。",
    "记录最大并发、容量上限、时延目标和资源约束；不适用时说明领域依据。",
    "记录异常行为、降级策略、重试边界和恢复方式。",
    "记录能长期验证领域真相的测试层级、关键场景和观测点。",
    "记录承载该领域规则的稳定目录、模块、类型或关键入口，不记录临时行号。",
    "列出容易混淆但明确由其他领域负责的内容，并说明归属。",
)
_PROCESS_METADATA = (
    ("需求单号", re.compile(r"(?mi)^\s*(?:需求)?单号\s*[:：]")),
    ("CP 阶段", re.compile(r"(?i)\bCP[1-9]\d*\b")),
    ("Reviewer", re.compile(
        r"(?i)\b(?:(?:CODE|STORY|CRAFT)\s+)?Reviewer\b")),
    ("过程记录", re.compile(
        r"(?m)^\s*(?:评审记录|提交记录|开发过程|临时方案)\s*[:：]")),
)


@dataclass(frozen=True)
class DomainDocument:
    domain: str
    keywords: tuple
    path: str
    content: str


@dataclass(frozen=True)
class DomainContext:
    index_path: str
    documents: tuple


@dataclass(frozen=True)
class ReconcileResult:
    domain: str
    path: str
    absolute_path: str
    action: str
    content: str

    @property
    def manifest_eligible(self):
        return self.action in {"new", "updated"}


def _domain_name(domain):
    value = str(domain or "").strip()
    if (
            not _DOMAIN.fullmatch(value)
            or value.split(".", 1)[0].upper() in _RESERVED):
        raise ValueError("domain must be one portable docs/specs name")
    return value


def _read(path):
    try:
        with open(path, encoding="utf-8") as stream:
            return stream.read()
    except OSError:
        return ""


def _index_rows(content):
    rows = []
    domains = {}
    keyword_owners = {}
    for line_number, line in enumerate(content.splitlines(), 1):
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 3 or cells[0] in {"领域", "Domain", "---"}:
            continue
        if set(cells[0]) == {"-"}:
            continue
        try:
            domain = _domain_name(cells[0])
        except ValueError as exc:
            raise ValueError(
                "领域索引第 %d 行的领域名无效: %s" % (line_number, exc))
        expected = "docs/specs/%s.md" % domain
        if cells[2].replace("\\", "/") != expected:
            raise ValueError(
                "领域索引第 %d 行路径必须是 %s" % (line_number, expected))
        keywords = tuple(
            keyword.strip() for keyword in cells[1].split(",")
            if keyword.strip())
        if not keywords:
            raise ValueError("领域索引第 %d 行至少需要一个关键词" % line_number)
        folded_domain = domain.casefold()
        if folded_domain in domains:
            raise ValueError(
                "领域索引第 %d 行重复定义领域 %s" % (line_number, domain))
        domains[folded_domain] = line_number
        for keyword in keywords:
            folded_keyword = keyword.casefold()
            owner = keyword_owners.get(folded_keyword)
            if owner is not None and owner != folded_domain:
                raise ValueError(
                    "领域索引第 %d 行关键词 %s 已由其他领域使用"
                    % (line_number, keyword))
            keyword_owners[folded_keyword] = folded_domain
        rows.append((domain, keywords, expected))
    return tuple(rows)


def validate_domain_document(content):
    """Return deterministic validation errors for one durable domain truth."""
    if not isinstance(content, str) or not content.strip():
        return ("领域文档不能为空",)
    headings = {}
    current = None
    body = []
    for line in content.splitlines():
        match = re.match(r"^##\s+(?:\d+[.、]\s*)?(.+?)\s*$", line)
        if match:
            if current is not None:
                headings[current] = "\n".join(body).strip()
            current = match.group(1).strip()
            body = []
        elif current is not None:
            body.append(line)
    if current is not None:
        headings[current] = "\n".join(body).strip()
    errors = []
    if "<领域名称>" in content:
        errors.append("文档标题仍是模板占位符: <领域名称>")
    if "MAE-FLOW-DOMAIN-DRAFT" in content:
        errors.append("领域文档仍是未完成模板；补充事实后删除草稿标记")
    if any(guidance in content for guidance in _TEMPLATE_GUIDANCE):
        errors.append("领域文档仍包含模板说明；请替换为已验证的长期事实")
    process_metadata = tuple(
        label for label, pattern in _PROCESS_METADATA if pattern.search(content))
    if process_metadata:
        errors.append(
            "领域文档包含需求过程元数据: %s；只保留当前长期事实"
            % "、".join(process_metadata))
    for section in REQUIRED_DOMAIN_SECTIONS:
        value = headings.get(section, "").strip()
        compact = re.sub(r"[\s`*_#>-]+", "", value).casefold()
        if section not in headings:
            errors.append("缺少章节: %s" % section)
        elif compact in _PLACEHOLDER_CONTENT or len(compact) < 8:
            errors.append("章节内容不完整: %s" % section)
    return tuple(errors)


def render_domain_index(content, additions):
    """Return index content with deterministic new-domain rows appended."""
    base = str(content or "")
    rows = _index_rows(base)
    known = {row[0].casefold() for row in rows}
    if not base.strip():
        base = (
            "# 领域文档索引\n\n"
            "| 领域 | 关键词 | 文档 |\n"
            "| --- | --- | --- |\n"
        )
    pending = []
    for domain, keywords in sorted(additions, key=lambda item: item[0].casefold()):
        name = _domain_name(domain)
        if name.casefold() in known:
            continue
        words = tuple(dict.fromkeys(
            str(keyword).strip() for keyword in keywords
            if str(keyword).strip()))
        if not words:
            raise ValueError("新领域 %s 至少需要一个索引关键词" % name)
        pending.append(
            "| %s | %s | docs/specs/%s.md |" %
            (name, ", ".join(words), name))
        known.add(name.casefold())
    rendered = base.rstrip() + ("\n" if pending else "") + "\n".join(pending)
    if pending:
        rendered += "\n"
    _index_rows(rendered)
    return rendered


def load_relevant_domain_context(project_root, terms):
    root = os.path.abspath(os.fspath(project_root))
    index = os.path.join(root, "docs", "specs", "index.md")
    query = "\n".join(str(term) for term in terms).casefold()
    documents = []
    for domain, keywords, relative in _index_rows(_read(index)):
        absolute = os.path.join(root, *relative.split("/"))
        if not os.path.isfile(absolute):
            raise ValueError("领域索引引用的文档不存在: %s" % relative)
        if keywords and not any(
                keyword.casefold() in query for keyword in keywords):
            continue
        content = _read(absolute)
        if content:
            documents.append(DomainDocument(
                domain=domain,
                keywords=keywords,
                path=relative,
                content=content,
            ))
    return DomainContext(
        index_path="docs/specs/index.md",
        documents=tuple(documents),
    )


def plan_domain_reconciliation(project_root, domain, candidate_content):
    name = _domain_name(domain)
    if not isinstance(candidate_content, str) or not candidate_content.strip():
        raise ValueError("domain candidate must be non-empty text")
    relative = "docs/specs/%s.md" % name
    absolute = os.path.join(
        os.path.abspath(os.fspath(project_root)), *relative.split("/"))
    current = _read(absolute)
    action = (
        "new" if not current
        else "unchanged" if current == candidate_content
        else "updated"
    )
    return ReconcileResult(
        domain=name,
        path=relative,
        absolute_path=absolute,
        action=action,
        content=candidate_content,
    )


def apply_domain_reconciliation(result, keywords=()):
    if not isinstance(result, ReconcileResult):
        raise TypeError("result must be a ReconcileResult")
    if result.action == "unchanged":
        return result
    os.makedirs(os.path.dirname(result.absolute_path), exist_ok=True)
    temporary = result.absolute_path + ".tmp-%s" % os.getpid()
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(result.content)
        os.replace(temporary, result.absolute_path)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass
    _ensure_index_entry(
        os.path.dirname(result.absolute_path), result.domain, keywords)
    return result


def _ensure_index_entry(specs_root, domain, keywords):
    index = os.path.join(specs_root, "index.md")
    content = _read(index)
    rows = _index_rows(content)
    if any(row[0].casefold() == domain.casefold() for row in rows):
        return
    if not content.strip():
        content = (
            "# 领域文档索引\n\n"
            "| 领域 | 关键词 | 文档 |\n"
            "| --- | --- | --- |\n"
        )
    keyword_text = ", ".join(
        str(keyword).strip() for keyword in keywords if str(keyword).strip())
    keyword_text = keyword_text or domain
    content = content.rstrip() + (
        "\n| %s | %s | docs/specs/%s.md |\n"
        % (domain, keyword_text, domain))
    temporary = index + ".tmp-%s" % os.getpid()
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
        os.replace(temporary, index)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass
