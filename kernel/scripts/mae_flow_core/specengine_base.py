# -*- coding: utf-8 -*-
"""OpenSpec CLI 内化：spec-driven 工作流的纯 Python 引擎。

行为真相源是插件内嵌的 Node CLI（openspec 1.6.0，
``runtime/vendor/openspec/dist/core/artifact-graph/openspec.mjs``）。
本模块把其中 Mae-Flow 实际用到的五个能力重写为纯 Python：

- ``ensure_config``  —— 对应 ``openspec init``（只保留目录 + config.yaml 部分）
- ``new_change``     —— 对应 ``openspec new change <name>``
- ``instructions``   —— 对应 ``openspec instructions <artifact> --change <name>``
- ``validate``       —— 对应 ``openspec validate <change>``（默认非 strict）
- ``archive``        —— 对应 ``openspec archive <change> --yes``
- ``status``         —— 对应 ``openspec status --change <name>`` 的核心信息

对拍纪律（tests/test_specengine.py 差分测试保证）：

- 校验宽严与 CLI 完全一致——CLI 放过的不拦、CLI 拦的必拦；
- archive 合并后的 ``openspec/`` 目录树与 CLI 逐字节一致（统一行尾后比较）；
- 错误“文案”用中文重写（可执行、指到文件与块），但触发条件与 CLI 相同。

与 CLI 的已知刻意差异（均有依据，详见各处注释）：

1. 半成功免疫：CLI 在 spec 合并写盘“之后”才检查归档目标是否已存在，
   目标冲突时会留下 specs 已改、change 未移走的半成功现场（旧
   comet-archive 的实战痛点）。本引擎把该检查提前到任何写盘之前，
   并对写盘失败做回滚——要么全成，要么原样，可重跑。
2. change 名称校验采用接口契约给定的 ``^[a-zA-Z0-9_-]+$``（与
   comet-archive.sh 的 validate_change_name 相同），比 CLI 的
   kebab-case 规则宽（CLI 拒绝大写与下划线）。Mae-Flow 的 change 名
   历史上允许下划线，收紧会破坏既有流程；引擎自身闭环后不再依赖
   CLI 对名称的接受度。
3. 吸收 comet-archive.sh 的 ``verify_main_specs_clean`` 语义：归档前
   预检所有主 specs 不得残留 ``## ADDED/MODIFIED/... Requirements``
   字样（CLI 只检查本次触达的域）。CLI+comet 组合下污染现场会在归档
   “之后”FATAL；引擎把它提前为归档前拒绝，避免又一种半成功。

v5 轻量布局（本插件自有，上游 CLI 无此概念）：change 目录只有一个四合一
change.md（# 为什么 / # 规格条目：<域> / # 方案 / # 实现清单），规格条目
节体=标准 delta spec 原格式。delta 解析与合并核心（_parse_delta_spec /
_build_updated_spec）对两种布局完全同一份代码，v5 只改"内容从哪来"
（specs/<域>/spec.md 文件 → change.md 的规格条目节）与 new_change 的产物
（.openspec.yaml → change.md 骨架）。布局按 change.md 存在性探测；两种
布局标志并存判混用拒绝。上面的对拍纪律只约束 legacy 路径（CLI 不认识
v5）；v5 的守护是等价性测试——同一 delta 内容在两种布局下归档，主 specs
真相源必须逐字节一致。

Windows 军规：对外返回的路径一律正斜杠归一；写盘统一走
``state_store.atomic_write_text``（tmp + os.replace + 杀软重试）；
不使用 ``os.path.relpath`` 做任何可能跨盘的换算。
"""

import os
import re
import shutil
import time
from datetime import datetime, timezone

from .state_store import atomic_write_text

PLUGIN_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VENDOR_SCHEMAS_DIR = os.path.join(
    PLUGIN_ROOT, "runtime", "vendor", "openspec", "schemas")
DEFAULT_SCHEMA = "spec-driven"

# CLI 的 SHALL/MUST 检查是无 u 标志的 JS 正则 \b(SHALL|MUST)\b，
# 词边界按 ASCII 词字符判定。Python 默认 \b 按 Unicode（汉字算词字符，
# “系统SHALL支持”会判不中），必须加 re.ASCII 才与 CLI 等价。
_SHALL_RE = re.compile(r"\b(SHALL|MUST)\b", re.ASCII)
# delta spec 里的 requirement 头（### 后允许无空格，大小写不敏感）。
_REQ_HEADER_RE = re.compile(r"^###\s*Requirement:\s*(.+)\s*$", re.I)
# 主 spec 结构检查用的 requirement 头（### 后必须有空白，与 CLI 两处正则的差异一致）。
_REQ_HEADER_STRICT_RE = re.compile(r"^###\s+Requirement:\s*(.+)\s*$", re.I)
_REQUIREMENTS_SECTION_RE = re.compile(r"^##\s+Requirements\s*$", re.I)
_TOP_LEVEL_SECTION_RE = re.compile(r"^##\s+")
_DELTA_HEADER_RE = re.compile(
    r"^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$", re.I)
# archive 判断“是否存在 delta spec”的探测正则（区分大小写、无行尾锚，与 CLI 一致）。
_HAS_DELTA_RE = re.compile(
    r"^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements", re.M)
# comet verify_main_specs_clean 的泄漏检查（区分大小写、精确行）。
_LEAK_RE = re.compile(r"^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements$", re.M)
_SCENARIO_ANY_RE = re.compile(r"^####\s+")            # 计数场景：任意四井号头
_SCENARIO_NAMED_RE = re.compile(r"^####\s*Scenario:\s*(.+)\s*$")  # 场景名（区分大小写）
_METADATA_LINE_RE = re.compile(r"^\*\*[^*]+\*\*:")
_HEADER_LINE_RE = re.compile(r"^#{1,6}\s")
_ANY_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_SECTION_H2_RE = re.compile(r"^(##)\s+(.+)$")
_REMOVED_BULLET_RE = re.compile(r"^\s*-\s*`?###\s*Requirement:\s*(.+?)`?\s*$")
_RENAME_FROM_RE = re.compile(r"^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$")
_RENAME_TO_RE = re.compile(r"^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$")
_TASK_RE = re.compile(r"^[-*]\s+\[[\sx]\]", re.I)
_TASK_DONE_RE = re.compile(r"^[-*]\s+\[x\]", re.I)
_CHANGE_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# ``openspec init`` 写出的 config.yaml 模板（serializeConfig 的逐行镜像；
# 该模板在 CLI 里同样是代码内嵌常量，不属于“禁止硬编码”的指令正文）。
_CONFIG_TEMPLATE_LINES = (
    "schema: %s",
    "",
    "# Project context (optional)",
    "# This is shown to AI when creating artifacts.",
    "# Add your tech stack, conventions, style guides, domain knowledge, etc.",
    "# Example:",
    "#   context: |",
    "#     Tech stack: TypeScript, React, Node.js",
    "#     We use conventional commits",
    "#     Domain: e-commerce platform",
    "",
    "# Per-artifact rules (optional)",
    "# Add custom rules for specific artifacts.",
    "# Example:",
    "#   rules:",
    "#     proposal:",
    "#       - Keep proposals under 500 words",
    '#       - Always include a "Non-goals" section',
    "#     tasks:",
    "#       - Break tasks into chunks of max 2 hours",
)


class SpecEngineError(RuntimeError):
    """spec 引擎不能安全继续时抛出（入参错、格式错、归档冲突等）。"""


# ---------------------------------------------------------------------------
# 基础小工具
# ---------------------------------------------------------------------------

def _posix(path):
    """路径正斜杠归一（Windows-only 生产军规）。"""
    return str(path).replace("\\", "/")


def _read_text(path):
    with open(path, "r", encoding="utf-8") as stream:
        return stream.read()


def _read_text_utf8(path):
    """读 UTF-8 文本；编码坏时抛带指引的引擎错误。

    审计实锤：裸 UnicodeDecodeError 会以 traceback 穿透 validate/archive/
    has_delta 直到 CLI（违背"流畅易用不卡死"）。OSError 原样抛出，由调用方
    按各自语义处理（缺失容忍/报错）。"""
    try:
        return _read_text(path)
    except UnicodeDecodeError as exc:
        raise SpecEngineError(
            "%s 读取失败（文件须为 UTF-8 编码）：%s" % (_posix(path), exc))


def _utc_today():
    """CLI 的日期一律取 ``new Date().toISOString()`` 前段，即 UTC 日期。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _norm_newlines(text):
    """CLI 的 normalizeLineEndings：CRLF/裸 CR 统一为 LF。"""
    return re.sub(r"\r\n?", "\n", text)


def _rel_under(path, base):
    """base 目录内的相对 posix 路径（前缀剥离，避免 relpath 的跨盘语义）。"""
    path = _posix(os.path.abspath(path))
    base = _posix(os.path.abspath(base))
    if path == base:
        return ""
    if path.startswith(base + "/"):
        return path[len(base) + 1:]
    return path


# 规格工作区曾直接叫 openspec/ 蹲在项目根——那是退役外部引擎留下的名字与位置。
# 现在统一归入 .mae-flow-work/(唯一的本地过程区,git 本地排除)。
# 旧目录仍在时优先沿用:老团队仓里 openspec/specs 可能是已提交的历史领域真相,
# 在途旧单的 change 目录也在里面;真正的搬迁只对"未被 git 跟踪"的旧目录做,
# 由流程入口的 migrate_legacy_spec_workspace 一次性完成,引擎本身零副作用。
LEGACY_SPEC_WORKSPACE = "openspec"
SPEC_WORKSPACE_RELATIVE = os.path.join(".mae-flow-work", "spec")


def _openspec_dir(root):
    base = os.path.abspath(root)
    legacy = os.path.join(base, LEGACY_SPEC_WORKSPACE)
    if os.path.isdir(legacy):
        return legacy
    return os.path.join(base, SPEC_WORKSPACE_RELATIVE)


def _changes_dir(root):
    return os.path.join(_openspec_dir(root), "changes")


def _archive_dir(root):
    return os.path.join(_changes_dir(root), "archive")


def _main_specs_dir(root):
    return os.path.join(_openspec_dir(root), "specs")


def _change_dir(root, change):
    return os.path.join(_changes_dir(root), change)


def _validate_change_name(name):
    """接口契约规定的名称门（同 comet-archive.sh；比 CLI 的 kebab 规则宽，见模块注释差异 2）。"""
    if not name or not isinstance(name, str):
        raise SpecEngineError("change 名称不能为空")
    if ".." in name:
        raise SpecEngineError("change 名称不能包含 '..'：%s" % name)
    if not _CHANGE_NAME_RE.match(name):
        raise SpecEngineError(
            "change 名称只允许字母、数字、连字符和下划线（^[a-zA-Z0-9_-]+$）：%s" % name)
    return name


def _list_active_changes(root):
    """openspec/changes 下的活跃 change 目录（排除 archive 与点目录），排序。"""
    result = []
    try:
        for entry in os.listdir(_changes_dir(root)):
            if entry == "archive" or entry.startswith("."):
                continue
            if os.path.isdir(os.path.join(_changes_dir(root), entry)):
                result.append(entry)
    except OSError:
        return []
    return sorted(result)


def _require_change_dir(root, change):
    _validate_change_name(change)
    change_dir = _change_dir(root, change)
    if not os.path.isdir(change_dir):
        available = _list_active_changes(root)
        hint = ("；当前可用 change：" + ", ".join(available)) if available else (
            "；当前没有任何活跃 change")
        raise SpecEngineError("change '%s' 不存在%s" % (change, hint))
    return change_dir


# ---------------------------------------------------------------------------
# 最小 YAML 子集解析（只覆盖 vendored schema.yaml / config.yaml / .openspec.yaml
# 实际使用的形态：标量、引号标量、行内 [] 列表、块列表、嵌套映射、"|" 字面块）。
# 解析结果通过差分测试对拍验证（instructions 输出等价 <=> 块标量解析等价）。
# ---------------------------------------------------------------------------

def _yaml_unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _yaml_scalar(value):
    value = value.strip()
    if value == "[]":
        return []
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_yaml_unquote(part) for part in inner.split(",")]
    return _yaml_unquote(value)


def _yaml_indent(line):
    return len(line) - len(line.lstrip(" "))


def _yaml_is_noise(line):
    stripped = line.strip()
    return not stripped or stripped.startswith("#")


def _yaml_block_scalar(lines, index, key_indent):
    """读取 ``key: |`` 的字面块（clip 语义：内部空行保留，结尾归一为单个换行）。"""
    body = []
    block_indent = None
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            body.append("")
            index += 1
            continue
        indent = _yaml_indent(line)
        if indent <= key_indent:
            break
        if block_indent is None:
            block_indent = indent
        body.append(line[block_indent:] if indent >= block_indent else line.lstrip(" "))
        index += 1
    while body and body[-1] == "":
        body.pop()
    return ("\n".join(body) + "\n") if body else "", index


def _yaml_parse_mapping(lines, index, min_indent):
    result = {}
    while index < len(lines):
        line = lines[index]
        if _yaml_is_noise(line):
            index += 1
            continue
        indent = _yaml_indent(line)
        if indent < min_indent:
            break
        stripped = line.strip()
        if stripped.startswith("- "):
            break  # 列表项交由上层处理
        if ":" not in stripped:
            index += 1  # 容错：无法识别的行直接跳过（CLI 用真 YAML，这里保守忽略）
            continue
        key, _, rest = stripped.partition(":")
        key = _yaml_unquote(key)
        rest = rest.strip()
        index += 1
        if rest == "|" or rest == "|-":
            value, index = _yaml_block_scalar(lines, index, indent)
            result[key] = value
        elif rest == "":
            value, index = _yaml_parse_value(lines, index, indent + 1)
            result[key] = value
        else:
            result[key] = _yaml_scalar(rest)
    return result, index


def _yaml_parse_list(lines, index, min_indent):
    result = []
    while index < len(lines):
        line = lines[index]
        if _yaml_is_noise(line):
            index += 1
            continue
        indent = _yaml_indent(line)
        if indent < min_indent:
            break
        stripped = line.strip()
        if not stripped.startswith("-"):
            break
        item_body = stripped[1:].lstrip()
        if not item_body:
            index += 1
            value, index = _yaml_parse_value(lines, index, indent + 1)
            result.append(value)
            continue
        if ":" in item_body and not item_body.startswith(("'", '"')):
            # ``- id: proposal`` 形式：把本行改写成去掉 "- " 的映射行并继续读同级键。
            inner_indent = indent + (len(stripped) - len(item_body))
            rewritten = [" " * inner_indent + item_body]
            index += 1
            while index < len(lines):
                nxt = lines[index]
                if _yaml_is_noise(nxt):
                    rewritten.append(nxt)
                    index += 1
                    continue
                nxt_indent = _yaml_indent(nxt)
                if nxt_indent <= indent or nxt.strip().startswith("- ") and nxt_indent == indent:
                    break
                rewritten.append(nxt)
                index += 1
            value, _ = _yaml_parse_mapping(rewritten, 0, inner_indent)
            result.append(value)
        else:
            result.append(_yaml_scalar(item_body))
            index += 1
    return result, index


def _yaml_parse_value(lines, index, min_indent):
    while index < len(lines) and _yaml_is_noise(lines[index]):
        index += 1
    if index >= len(lines):
        return None, index
    line = lines[index]
    indent = _yaml_indent(line)
    if indent < min_indent:
        return None, index
    if line.strip().startswith("-"):
        return _yaml_parse_list(lines, index, indent)
    return _yaml_parse_mapping(lines, index, indent)


def _yaml_load(text):
    lines = _norm_newlines(text).split("\n")
    value, _ = _yaml_parse_mapping(lines, 0, 0)
    return value
