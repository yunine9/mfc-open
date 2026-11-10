"""Change creation, instructions, status, and task progress."""

from .specengine_base import (
    DEFAULT_SCHEMA, SpecEngineError, _CONFIG_TEMPLATE_LINES,
    _archive_dir, _change_dir, _main_specs_dir, _norm_newlines,
    _openspec_dir, _posix, _read_text, _require_change_dir, _utc_today,
    _validate_change_name, atomic_write_text, os,
)
from .quality.implementation_tasks import implementation_task_progress
from .specengine_config import (
    _config_path, _list_vendored_schemas, _load_schema, _load_template,
    _read_project_config, _resolve_schema_name,
)
from .specengine_v5 import (
    V5_SECTION_DESIGN, V5_SECTION_TASKS, V5_SECTION_WHY, V5_TIERS,
    _build_change_skeleton, _change_doc_path, _change_layout, _legacy_markers,
    _read_change_doc,
)

def _ensure_base_dirs(root):
    os.makedirs(_main_specs_dir(root), exist_ok=True)
    os.makedirs(_archive_dir(root), exist_ok=True)


def ensure_config(root):
    """openspec/config.yaml 不存在则按 ``openspec init`` 的模板创建（幂等）。

    同时补齐 openspec/specs 与 openspec/changes/archive 目录结构。
    返回 ``{"created": bool, "path": <posix 绝对路径>}``。
    """
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise SpecEngineError("项目目录不存在：" + _posix(root))
    existing = _config_path(root)
    if existing is not None:
        _ensure_base_dirs(root)
        return {"created": False, "path": _posix(os.path.abspath(existing))}
    _ensure_base_dirs(root)
    path = os.path.join(_openspec_dir(root), "config.yaml")
    text = "\n".join(_CONFIG_TEMPLATE_LINES) % DEFAULT_SCHEMA + "\n"
    atomic_write_text(path, text)
    return {"created": True, "path": _posix(os.path.abspath(path))}


def new_change(root, name, tier=None):
    """创建 change 目录。

    ``tier=None``：旧布局（镜像 ``openspec new change`` 的产物）——
    ``openspec/changes/<name>/.openspec.yaml``（schema + created=UTC 日期）。
    保留给差分对拍与旧布局构造用，运行路径已不再产生新的旧布局单。

    ``tier`` ∈ full/hotfix/tweak：v5 四合一布局——目录里只有一个 change.md
    骨架（按档位含节），**不写 .openspec.yaml**（schema 走项目 config.yaml
    回退，日期由归档名承载）；v5 单"入库物只有 1 个文件"的关键就在这里。

    两种布局都保证 openspec/specs、openspec/changes/archive 存在；
    config.yaml 缺失时按 CLI 同款最小内容 ``schema: spec-driven`` 创建
    （注意与 ensure_config 的完整模板不同——先 ensure_config 后 new_change
    则维持完整模板不动）。
    """
    root = os.path.abspath(root)
    _validate_change_name(name)
    if tier is not None and tier not in V5_TIERS:
        raise SpecEngineError(
            "未知交付档位 '%s'；可选：%s" % (tier, ", ".join(V5_TIERS)))
    if not os.path.isdir(root):
        raise SpecEngineError("项目目录不存在：" + _posix(root))
    config = _read_project_config(root)
    schema_name = config.get("schema") or DEFAULT_SCHEMA
    if schema_name not in _list_vendored_schemas():
        raise SpecEngineError(
            "未知 schema '%s'；插件内嵌可用：%s"
            % (schema_name, ", ".join(_list_vendored_schemas()) or "(无)"))
    change_dir = _change_dir(root, name)
    if os.path.isdir(change_dir):
        raise SpecEngineError("change '%s' 已存在：%s" % (name, _posix(change_dir)))
    os.makedirs(change_dir, exist_ok=True)
    _ensure_base_dirs(root)
    if _config_path(root) is None:
        atomic_write_text(
            os.path.join(_openspec_dir(root), "config.yaml"),
            "schema: %s\n" % DEFAULT_SCHEMA)
    created = _utc_today()
    if tier is not None:
        doc_path = _change_doc_path(change_dir)
        atomic_write_text(doc_path, _build_change_skeleton(name, tier))
        return {
            "name": name,
            "path": _posix(change_dir),
            "layout": "v5",
            "tier": tier,
            "change_doc": _posix(doc_path),
            "schema": schema_name,
            "created": created,
        }
    metadata_path = os.path.join(change_dir, ".openspec.yaml")
    atomic_write_text(
        metadata_path, "schema: %s\ncreated: %s\n" % (schema_name, created))
    return {
        "name": name,
        "path": _posix(change_dir),
        "metadata_path": _posix(metadata_path),
        "schema": schema_name,
        "created": created,
    }


# ---------------------------------------------------------------------------
# instructions / status —— 制品图（依赖、完成度）与指令渲染
# ---------------------------------------------------------------------------

def _artifact_outputs(change_dir, generates):
    """镜像 resolveArtifactOutputs：非 glob 直接判文件；glob 只支持 specs/**/*.md
    这类“目录下任意 .md”形态（vendored schema 的唯一 glob）。"""
    if not any(ch in generates for ch in "*?["):
        full = os.path.join(change_dir, generates)
        return [full] if os.path.isfile(full) else []
    # 通用近似：取 glob 的首个通配段之前的目录前缀，递归收集匹配尾缀的文件。
    prefix = generates.split("*")[0].rstrip("/")
    base = os.path.join(change_dir, *prefix.split("/")) if prefix else change_dir
    suffix = generates.rsplit(".", 1)[-1] if "." in generates else ""
    matches = []
    for dirpath, _dirnames, filenames in os.walk(base):
        for filename in filenames:
            if not suffix or filename.endswith("." + suffix):
                matches.append(os.path.join(dirpath, filename))
    return sorted(matches)


def _detect_completed(schema, change_dir):
    completed = set()
    for artifact in schema["artifacts"]:
        if _artifact_outputs(change_dir, artifact["generates"]):
            completed.add(artifact["id"])
    return completed


def _build_order(schema):
    """镜像 getBuildOrder：Kahn 拓扑序，同层按字母序。"""
    in_degree = {}
    dependents = {}
    for artifact in schema["artifacts"]:
        in_degree[artifact["id"]] = len(artifact["requires"])
        dependents[artifact["id"]] = []
    for artifact in schema["artifacts"]:
        for req in artifact["requires"]:
            dependents.setdefault(req, []).append(artifact["id"])
    queue = sorted([aid for aid, deg in in_degree.items() if deg == 0])
    order = []
    while queue:
        current = queue.pop(0)
        order.append(current)
        ready = []
        for dep in dependents.get(current, []):
            in_degree[dep] -= 1
            if in_degree[dep] == 0:
                ready.append(dep)
        queue.extend(sorted(ready))
    return order


def _count_task_lines(text):
    progress = implementation_task_progress(_norm_newlines(text))
    return {
        "total": progress["total"],
        "completed": progress["completed"],
    }


def _count_tasks(change_dir):
    """任务进度。v5 数 change.md 的 "# 实现清单" 节；legacy 数 tasks.md
    顶层复选框（镜像 getTaskProgressForChange 的有效行为，正则语义相同）。"""
    if _change_layout(change_dir) == "v5":
        try:
            doc = _read_change_doc(change_dir)
        except SpecEngineError:
            return {"total": 0, "completed": 0}
        return _count_task_lines(doc["sections"].get(V5_SECTION_TASKS, ""))
    try:
        content = _read_text(os.path.join(change_dir, "tasks.md"))
    except (OSError, UnicodeDecodeError):
        # 展示/归档计数路径保持 CLI 同款宽容(getTaskProgress 的 try/catch 静默)。
        return {"total": 0, "completed": 0}
    return _count_task_lines(content)


def _render_change_instructions(change, change_dir, schema_name, schema, tier,
                                config):
    """v5 四合一 change.md 的创建指令。

    结构说明是 v5 自己的（上游没有这个制品）；规格条目节体的格式合同复用
    vendored schema 里 specs 制品的 instruction/template 原文——格式真源
    仍是引擎内嵌数据，不在这里手写第二份。
    """
    specs_artifact = None
    for item in schema["artifacts"]:
        if item["id"] == "specs":
            specs_artifact = item
            break
    tier_lines = {
        "full": "full（完整开发）：四节齐全——为什么 / 规格条目（至少一个域）/ 方案 / 实现清单。",
        "hotfix": "hotfix（已定位修复）：为什么 / 实现清单 必须；行为规格确有变化才补规格条目节；不写方案节。",
        "tweak": "tweak（局部修改）：为什么 / 实现清单 必须；无规格变化不写规格条目节；不写方案节。",
    }
    lines = []
    lines.append('<artifact id="change" change="%s" schema="%s">'
                 % (change, schema_name))
    lines.append("")
    lines.append("<task>")
    lines.append('Create the four-in-one change.md for change "%s".' % change)
    lines.append("四合一 change.md 是本单唯一入库产物，用固定小节取代旧四件套"
                 "（proposal/design/tasks/delta spec）。")
    lines.append("</task>")
    lines.append("")
    context_text = (config.get("context") or "").strip()
    if context_text:
        lines.append("<project_context>")
        lines.append("<!-- This is background information for you. "
                     "Do NOT include this in your output. -->")
        lines.append(context_text)
        lines.append("</project_context>")
        lines.append("")
    rules = (config.get("rules") or {}).get("change") or []
    if rules:
        lines.append("<rules>")
        lines.append("<!-- These are constraints for you to follow. "
                     "Do NOT include this in your output. -->")
        for rule in rules:
            lines.append("- %s" % rule)
        lines.append("</rules>")
        lines.append("")
    lines.append("<output>")
    lines.append("Write to: %s" % _posix(_change_doc_path(change_dir)))
    lines.append("</output>")
    lines.append("")
    lines.append("<instruction>")
    lines.append("- 小节用一级标题分隔，标题逐字使用：# 为什么 / # 规格条目：<域名> / "
                 "# 方案 / # 实现清单；其余一级标题（如文档标题）不算小节。")
    if tier in tier_lines:
        lines.append("- 本单档位 %s" % tier_lines[tier])
    else:
        for key in V5_TIERS:
            lines.append("- 档位 %s" % tier_lines[key])
    lines.append("- # 为什么：背景与动机、目标/非目标（原 proposal 的浓缩，"
                 "写决策依据不写实现细节）。")
    lines.append("- # 规格条目：<域名>：每个受影响的规格域一节，域名 = "
                 "openspec/specs/ 下的目录名（同域不得重复出节）；节体就是标准 "
                 "delta spec 原格式、层级原样（## ADDED/MODIFIED/REMOVED/RENAMED "
                 "Requirements、### Requirement:、#### Scenario: 恰好四个井号），"
                 "格式合同见下方 spec_format。小节体内禁止再出现一级标题"
                 "（会切断小节）；delta spec 文件惯用的 \"# <域> Specification\" "
                 "文档标题行在节体里不要写。")
    lines.append("- # 方案：技术方案结论（原 design 的浓缩）；讨论与勘察过程件"
                 "留在 .mae-flow-work/，不入库。")
    lines.append("- # 实现清单：\"- [ ] 编号. 任务\" 复选框，行首不缩进；"
                 "只列生产代码/配置实现任务，不列 UT、测试文件或测试用例任务；"
                 "UT 由 verify 阶段按已确认蓝图生成。完成后勾选为 [x]；"
                 "批次备注写在任务行下的缩进行。")
    lines.append("- 骨架里的「（待填…）」占位必须全部替换为实际内容。")
    lines.append("</instruction>")
    lines.append("")
    if specs_artifact is not None:
        lines.append("<spec_format>")
        lines.append("<!-- 规格条目节体的格式合同，与旧布局 delta spec 完全一致"
                     "（来自内嵌 schema，不是手写第二份）。 -->")
        instruction_text = (specs_artifact["instruction"] or "").strip()
        if instruction_text:
            lines.append(instruction_text)
            lines.append("")
        template_text = _load_template(
            schema, specs_artifact["template"]).strip()
        lines.append("<!-- 下面的模板结构直接作为 \"# 规格条目：<域名>\" 之下的"
                     "节体使用。 -->")
        lines.append(template_text)
        lines.append("</spec_format>")
        lines.append("")
    lines.append("</artifact>")
    return "\n".join(lines) + "\n"


def instructions(root, artifact, change, tier=None):
    """渲染某制品的创建指令文本（内容全部来自 vendored schema + templates）。

    输出结构镜像 ``openspec instructions <artifact> --change <name>`` 的
    ``<artifact>…</artifact>`` 文本（含 warning/task/project_context/rules/
    dependencies/output/instruction/template/success_criteria/unlocks 块），
    路径正斜杠归一。返回 str（以换行结尾）。

    v5 追加虚拟制品 ``change``：四合一 change.md 的结构说明 + 规格条目节的
    格式合同（复用 specs 制品的内嵌指令与模板）；``tier`` 只影响该制品。
    """
    root = os.path.abspath(root)
    change_dir = _require_change_dir(root, change)
    schema_name = _resolve_schema_name(root, change_dir, strict=True)
    schema = _load_schema(schema_name)
    # 布局门（审计实锤）：指令是"教模型写什么"的入口，发错布局的指令等于
    # 引擎亲口指示制造它自己随后会拒绝的混用现场。
    if artifact == "change":
        if _change_layout(change_dir) != "v5" and _legacy_markers(change_dir):
            raise SpecEngineError(
                "change '%s' 是旧布局在途单（存在 %s）；继续按旧四件套补齐走完，"
                "不要新建 change.md（用 spec instructions "
                "proposal|specs|design|tasks 取旧制品指令）"
                % (change, "、".join(_legacy_markers(change_dir))))
        return _render_change_instructions(
            change, change_dir, schema_name, schema, tier,
            _read_project_config(root))
    if _change_layout(change_dir) == "v5":
        raise SpecEngineError(
            "change '%s' 是 v5 四合一布局（change.md），不再使用旧制品 '%s'；"
            "执行 spec instructions change 取四合一结构与规格条目格式合同"
            % (change, artifact))
    valid_ids = [item["id"] for item in schema["artifacts"]]
    selected = None
    for item in schema["artifacts"]:
        if item["id"] == artifact:
            selected = item
            break
    if selected is None:
        raise SpecEngineError(
            "制品 '%s' 不在 schema '%s' 里；可选：%s"
            % (artifact, schema_name, ", ".join(valid_ids + ["change"])))
    template_text = _load_template(schema, selected["template"])
    completed = _detect_completed(schema, change_dir)
    dependencies = []
    for dep_id in selected["requires"]:
        dep = None
        for item in schema["artifacts"]:
            if item["id"] == dep_id:
                dep = item
                break
        dependencies.append({
            "id": dep_id,
            "done": dep_id in completed,
            "path": dep["generates"] if dep else dep_id,
            "description": dep["description"] if dep else "",
        })
    unlocks = sorted(item["id"] for item in schema["artifacts"]
                     if artifact in item["requires"])
    config = _read_project_config(root)
    context_text = (config.get("context") or "").strip()
    rules = (config.get("rules") or {}).get(artifact) or []

    lines = []
    lines.append('<artifact id="%s" change="%s" schema="%s">'
                 % (artifact, change, schema_name))
    lines.append("")
    missing = [dep["id"] for dep in dependencies if not dep["done"]]
    if missing:
        lines.append("<warning>")
        lines.append("This artifact has unmet dependencies. "
                     "Complete them first or proceed with caution.")
        lines.append("Missing: %s" % ", ".join(missing))
        lines.append("</warning>")
        lines.append("")
    lines.append("<task>")
    lines.append('Create the %s artifact for change "%s".' % (artifact, change))
    lines.append(selected["description"])
    lines.append("</task>")
    lines.append("")
    if context_text:
        lines.append("<project_context>")
        lines.append("<!-- This is background information for you. "
                     "Do NOT include this in your output. -->")
        lines.append(context_text)
        lines.append("</project_context>")
        lines.append("")
    if rules:
        lines.append("<rules>")
        lines.append("<!-- These are constraints for you to follow. "
                     "Do NOT include this in your output. -->")
        for rule in rules:
            lines.append("- %s" % rule)
        lines.append("</rules>")
        lines.append("")
    if dependencies:
        lines.append("<dependencies>")
        lines.append("Read these files for context before creating this artifact:")
        lines.append("")
        for dep in dependencies:
            status = "done" if dep["done"] else "missing"
            full_path = _posix(os.path.join(change_dir, dep["path"]))
            lines.append('<dependency id="%s" status="%s">' % (dep["id"], status))
            lines.append("  <path>%s</path>" % full_path)
            lines.append("  <description>%s</description>" % dep["description"])
            lines.append("</dependency>")
        lines.append("</dependencies>")
        lines.append("")
    lines.append("<output>")
    lines.append("Write to: %s"
                 % _posix(os.path.join(change_dir, selected["generates"])))
    lines.append("</output>")
    lines.append("")
    if selected["instruction"]:
        lines.append("<instruction>")
        lines.append(selected["instruction"].strip())
        lines.append("</instruction>")
        lines.append("")
    lines.append("<template>")
    lines.append("<!-- Use this as the structure for your output file. "
                 "Fill in the sections. -->")
    lines.append(template_text.strip())
    lines.append("</template>")
    lines.append("")
    lines.append("<success_criteria>")
    lines.append("<!-- To be defined in schema validation rules -->")
    lines.append("</success_criteria>")
    lines.append("")
    if unlocks:
        lines.append("<unlocks>")
        lines.append("Completing this artifact enables: %s" % ", ".join(unlocks))
        lines.append("</unlocks>")
        lines.append("")
    lines.append("</artifact>")
    return "\n".join(lines) + "\n"


def _list_main_spec_domains(root):
    specs = []
    try:
        for entry in os.listdir(_main_specs_dir(root)):
            if entry.startswith("."):
                continue
            if os.path.isfile(os.path.join(_main_specs_dir(root), entry, "spec.md")):
                specs.append(entry)
    except OSError:
        pass
    return sorted(specs)


def status(root, change):
    """返回制品存在性/就绪态 + 主 specs 域清单 + 任务进度。

    v5 布局没有四件套制品图，改报四合一小节的存在性与规格条目域清单；
    is_complete 按最低档必须节（为什么 + 实现清单）判定——档位信息属于
    流程状态层，引擎不猜。"""
    root = os.path.abspath(root)
    change_dir = _require_change_dir(root, change)
    schema_name = _resolve_schema_name(root, change_dir, strict=True)
    if _change_layout(change_dir) == "v5":
        doc = _read_change_doc(change_dir)
        sections = {
            V5_SECTION_WHY: V5_SECTION_WHY in doc["sections"],
            V5_SECTION_DESIGN: V5_SECTION_DESIGN in doc["sections"],
            V5_SECTION_TASKS: V5_SECTION_TASKS in doc["sections"],
        }
        return {
            "change": change,
            "schema": schema_name,
            "change_root": _posix(change_dir),
            "layout": "v5",
            "change_doc": _posix(_change_doc_path(change_dir)),
            "sections": sections,
            "spec_domains": [item["domain"] for item in doc["domains"]],
            "is_complete": sections[V5_SECTION_WHY] and sections[V5_SECTION_TASKS],
            "specs": _list_main_spec_domains(root),
            "tasks": _count_tasks(change_dir),
        }
    schema = _load_schema(schema_name)
    completed = _detect_completed(schema, change_dir)
    order = _build_order(schema)
    by_id = {item["id"]: item for item in schema["artifacts"]}
    artifacts = []
    for artifact_id in order:
        item = by_id[artifact_id]
        missing = sorted(dep for dep in item["requires"] if dep not in completed)
        if artifact_id in completed:
            state = "done"
        elif not missing:
            state = "ready"
        else:
            state = "blocked"
        entry = {
            "id": artifact_id,
            "exists": artifact_id in completed,
            "status": state,
            "output_path": item["generates"],
        }
        if state == "blocked":
            entry["missing_deps"] = missing
        artifacts.append(entry)
    return {
        "change": change,
        "schema": schema_name,
        "change_root": _posix(change_dir),
        "artifacts": artifacts,
        "is_complete": all(item["id"] in completed for item in schema["artifacts"]),
        "specs": _list_main_spec_domains(root),
        "tasks": _count_tasks(change_dir),
    }
