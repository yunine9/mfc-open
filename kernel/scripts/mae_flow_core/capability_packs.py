"""Capability-pack rendering and embedded methodology adaptation."""

from .capability_shared import CAPABILITY_PACKS, PLUGIN_ROOT, VENDOR_ROOT, os, re

class CapabilityError(RuntimeError):
    """A bundled capability cannot run safely."""


def _strip_frontmatter(text):
    return re.sub(r"\A---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.S)


def _extract_markdown_sections(text, wanted):
    """Extract exact upstream heading sections, including their children."""
    if not wanted:
        return text
    lines = text.splitlines()
    wanted = set(wanted)
    selected = []
    active_level = None
    found = set()
    for line in lines:
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if heading:
            level = len(heading.group(1))
            normalized = "%s %s" % (heading.group(1), heading.group(2))
            if normalized in wanted:
                active_level = level
                found.add(normalized)
            elif active_level is not None and level <= active_level:
                active_level = None
        if active_level is not None:
            selected.append(line)
    missing = wanted - found
    if missing:
        raise CapabilityError(
            "内嵌源码章节缺失: " + ", ".join(sorted(missing)))
    return "\n".join(selected).strip() + "\n"


def _adapt_embedded_method(body, maeflow):
    """Keep upstream methodology while removing its host-level orchestration."""
    embedded = 'python3 "%s" capability openspec -- ' % maeflow
    body = re.sub(
        r"(?m)^(\s*)openspec\s+",
        lambda match: match.group(1) + embedded,
        body)
    body = body.replace("`openspec ", "`" + embedded)

    # The pinned Comet skills assume they own the whole host and can discover
    # global Skill installations. Mae-Flow owns orchestration instead. Remove
    # only those bootstrap blocks; the phase methodology remains verbatim.
    body = re.sub(
        r"```(?:bash|sh)?\s*\n(?:(?!```).)*?"
        r"(?:COMET_ENV|Ensure the comet skill is installed)"
        r"(?:(?!```).)*?```\s*",
        "[Mae-Flow 已内嵌并校验 Comet 运行时，无需查找或安装外部 Skill。]\n",
        body,
        flags=re.S)
    command_prefixes = {
        r'"\$COMET_BASH"\s+"\$COMET_STATE"\s+':
            'python3 "%s" capability comet-state -- ' % maeflow,
        r'"\$COMET_BASH"\s+"\$COMET_GUARD"\s+':
            'python3 "%s" capability comet-guard -- ' % maeflow,
        r'"\$COMET_BASH"\s+"\$COMET_HANDOFF"\s+':
            'python3 "%s" capability comet-handoff -- ' % maeflow,
        r'"\$COMET_BASH"\s+"\$COMET_ARCHIVE"\s+':
            'python3 "%s" capability comet-archive -- ' % maeflow,
    }
    for pattern, replacement in command_prefixes.items():
        # A Windows plugin path such as ``C:\Users\...`` is not a valid
        # ``re.sub`` replacement string: the regex engine interprets ``\U``
        # and backreferences before inserting it. A callable replacement is
        # returned literally on every platform.
        body = re.sub(
            pattern,
            lambda _match, value=replacement: value,
            body)
    body = re.sub(
        r"```(?:bash|sh)?\s*\n(?:(?!```).)*?capability\s+comet-"
        r"(?:(?!```).)*?```\s*",
        "[状态初始化、校验和阶段迁移只执行 Mae-Flow 本步骤正文给出的命令。]\n",
        body,
        flags=re.S)
    body = re.sub(
        r'`python\s+"[^"]*mae-flow\.py"\s+capability\s+comet-[^`]+`',
        "Mae-Flow 本步骤正文中的状态命令",
        body)

    body = re.sub(
        r"(?<![\w.-])`?/(?:comet(?:-(?:open|design|build|verify|archive|hotfix|tweak))?"
        r"|opsx:[a-z-]+)`?",
        "Mae-Flow 对应步骤",
        body)
    body = re.sub(
        r"`?/ponytail\s+(?:lite\|full\|ultra|lite|full|ultra)`?",
        "使用 Mae-Flow 当前步骤已经指定的 Ponytail 档位",
        body,
        flags=re.I)

    # Upstream methods hand off through the host Skill registry. All referenced
    # open-source methods are already in this generated pack, so weak models
    # should continue locally instead of escaping to an external installation.
    body = re.sub(
        r"(?:使用 Skill 工具加载|内联加载)\s+(?:Superpowers\s+)?"
        r"`?([a-zA-Z0-9:_-]+)`?(?:\s*(?:技能|skill))?",
        r"直接执行本能力包中内嵌的 \1 方法",
        body)
    body = re.sub(
        r"(?i)\b(use|invoke|load|call)\s+(?:the\s+)?"
        r"(?:`[^`]+`|[a-z0-9:_-]+)\s+skill\b",
        "继续执行当前 Mae-Flow 步骤中已经内嵌的方法",
        body)
    body = body.replace(
        "`comet/reference/decision-point.md`",
        "Mae-Flow 当前步骤的用户确认协议")
    body = body.replace(
        "`comet/reference/debug-gate.md`",
        "Mae-Flow 当前步骤的系统化调试协议")
    body = body.replace(
        "`comet/reference/dirty-worktree.md`",
        "Mae-Flow 当前步骤的工作区保护规则")
    body = re.sub(
        r"`comet/reference/[^`]+`",
        "Mae-Flow 当前步骤的对应规则",
        body)
    body = body.replace(
        "`/<SKILL>`", "Mae-Flow 后续步骤")
    body = re.sub(
        r"^.*(?:技能|Skill).*不可用.*(?:安装|启用).*$",
        "[该方法已固定内嵌，不存在外部安装或启用分支。]",
        body,
        flags=re.M)
    superpower_routes = {
        "superpowers:using-git-worktrees": "Mae-Flow 已确认的分支隔离方式",
        "superpowers:subagent-driven-development": "Mae-Flow 本步骤已选定的执行方式",
        "superpowers:executing-plans": "当前能力包中的执行计划方法",
        "superpowers:finishing-a-development-branch": "Mae-Flow 后续验证与推送步骤",
    }
    for upstream, embedded_name in superpower_routes.items():
        body = body.replace(upstream, embedded_name)
    body = body.replace(
        "`skills/brainstorming/visual-companion.md`",
        "`%s`" % os.path.join(
            VENDOR_ROOT, "superpowers", "skills", "brainstorming",
            "visual-companion.md"))
    # 同款问题的其余三处:上游 SKILL 的目录内相对引用在渲染语境不可达,
    # 评审模板/调试支撑技术会退化成现场即兴。全部改写为 vendored 绝对路径。
    body = body.replace(
        "](code-reviewer.md)",
        "](%s)" % os.path.join(
            VENDOR_ROOT, "superpowers", "skills", "requesting-code-review",
            "code-reviewer.md"))
    for rel in ("root-cause-tracing.md", "defense-in-depth.md",
                "condition-based-waiting.md"):
        body = body.replace(
            "`%s`" % rel,
            "`%s`" % os.path.join(
                VENDOR_ROOT, "superpowers", "skills", "systematic-debugging", rel))
    return body


def render_pack(name):
    """Return the exact, pinned upstream instructions for one Mae-Flow phase."""
    entries = CAPABILITY_PACKS.get(name)
    if not entries:
        raise CapabilityError("未知内嵌能力包: " + str(name))
    sections = [
        "以下规则随 Mae-Flow 插件内嵌，当前会话已经加载。",
        "不要调用同名外部 Skill，不要安装插件，也不要执行 reload；"
        "直接把这些规则与本步骤上方更具体的公司约束一起执行。"
        "两者冲突时，以本步骤上方的 Mae-Flow 约束为准。",
    ]
    maeflow = os.path.join(PLUGIN_ROOT, "scripts", "mae-flow.py")
    for entry in entries:
        title, relative = entry[:2]
        wanted_sections = entry[2] if len(entry) > 2 else None
        path = os.path.join(VENDOR_ROOT, *relative.split("/"))
        try:
            with open(path, encoding="utf-8") as stream:
                body = stream.read()
        except OSError as exc:
            raise CapabilityError("%s 缺失: %s" % (title, exc))
        body = _extract_markdown_sections(
            _strip_frontmatter(body), wanted_sections)
        body = _adapt_embedded_method(body, maeflow)
        sections.extend(("\n## 内嵌能力：" + title, _strip_frontmatter(body).rstrip()))
    sections.extend((
        "\n## 内嵌方法收口",
        "上面的原始方法只提供本步骤需要的思考与执行纪律。不要按其中的“下一步”、"
        "“调用其他 Skill”或“结束工作流”自行跳转；完成后回到本步骤正文，"
        "由本步骤正文给出的完成命令决定下一步；若正文要求收口，使用 "
        "`python3 \"%s\" done`。" % maeflow,
    ))
    return "\n".join(sections).rstrip()
