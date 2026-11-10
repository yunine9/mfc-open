"""Human-readable, append-only local diagnostics for CodeCheck runs.

The primary log is Markdown so a developer can read it directly. Potentially
large command output, reports and diffs are stored as sibling artifacts and
referenced by path, size and SHA-256. Logging is deliberately best-effort:
diagnostics must never become another delivery gate.
"""

import hashlib
import os
import re
import time


SCHEMA_VERSION = 1
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

EVENT_TITLES = {
    "run.started": "开始执行 CodeCheck",
    "capability.checked": "检查 CodeCheck 工具",
    "command.started": "开始执行检查命令",
    "command.completed": "检查命令执行完成",
    "command.failed": "检查命令执行失败",
    "run.completed": "CodeCheck 执行完成",
    "run.failed": "CodeCheck 执行失败",
    "scan.requested": "收到首检请求",
    "scan.empty": "首检范围为空",
    "scan.completed": "首检结果汇总",
    "scan.tool_error": "首检工具异常",
    "scope.decided": "用户确认告警范围",
    "manual.result_recorded": "登记人工核对结果",
    "exemption.approved": "登记用户批准的豁免",
    "verify.empty": "复核范围为空",
    "verify.cache_reused": "复用已有检查结果",
    "verify.completed": "现场复核完成",
    "standalone.scope_confirmed": "确认独立检查范围",
    "standalone.scan_completed": "独立 CodeCheck 首检完成",
    "standalone.scan_failed": "独立 CodeCheck 首检失败",
    "agent.task_created": "生成 CodeCheck Agent 任务卡",
    "agent.tool": "CodeCheck Agent 工具调用",
    "agent.stopped": "CodeCheck Agent 已停止",
    "agent.contract_rejected": "CodeCheck Agent 报告被拒签",
    "agent.contract_validated": "CodeCheck Agent 报告验收通过",
    "agent.token_issued": "签发 CodeCheck Agent 完成凭证",
}

FIELD_LABELS = {
    "phase": "执行阶段",
    "cwd": "项目目录",
    "head": "当前 HEAD",
    "task_head": "任务卡基点 HEAD",
    "files": "检查文件",
    "file_count": "文件数",
    "available": "工具可用",
    "path": "文件路径",
    "detail": "工具诊断",
    "installed": "本次自动安装",
    "batch": "当前批次",
    "batch_count": "总批次数",
    "command": "实际命令",
    "commands": "实际命令",
    "launch": "底层启动参数",
    "shell": "通过 Shell 启动",
    "executable": "CLI 路径",
    "return_code": "返回码",
    "duration_ms": "耗时（毫秒）",
    "parsed_count": "解析告警数",
    "parsed_from": "结果解析来源",
    "reported_path": "CodeCheck 报告原路径",
    "parsed_json_path": "CodeCheck JSON 原路径",
    "parsed_json": "CodeCheck JSON 附件",
    "stdout": "标准输出附件",
    "stderr": "错误输出附件",
    "report": "报告附件",
    "kind": "异常类型",
    "error": "错误",
    "reason": "原因",
    "diagnostic": "诊断文件",
    "total": "告警总数",
    "pairs": "告警明细",
    "raw_count": "原始告警数",
    "kept_count": "计入本次告警数",
    "kept_pairs": "计入本次的告警",
    "scope_candidates": "待用户判断的候选",
    "scope_pending": "仍待范围确认",
    "moonlight": "月光模式",
    "candidates": "全部候选",
    "included": "用户确认涉及",
    "excluded": "用户确认不涉及",
    "ack": "用户确认原话",
    "final_count": "最终计入告警数",
    "stock_excluded": "确认不涉及数量",
    "count": "数量",
    "diagnostic_sha256": "诊断 SHA-256",
    "record_file": "正式记录文件",
    "task_path": "任务卡",
    "task_sha256": "任务卡 SHA-256",
    "allowed_files": "Agent 允许修改的文件",
    "scan_count": "首检告警数",
    "scope": "子任务范围",
    "standalone": "独立模式",
    "status": "结果状态",
    "retry": "是否为重答",
    "transcript_path": "Agent 会话记录",
    "fixed_changes_reported": "Agent 报告的修复内容",
    "changed_paths": "Agent 期间实际变化的路径",
    "name_status": "Git 文件状态",
    "diff_stat": "Git 差异统计",
    "worktree_status": "工作区状态",
    "diff": "Git diff 附件",
    "traced_tool_count": "记录的工具调用数",
    "tool_artifact_limit": "完整保存附件的工具调用上限",
    "index": "调用序号",
    "name": "工具",
    "summary": "调用摘要",
    "result_seen": "收到工具结果",
    "is_error": "工具报告错误",
    "input": "调用输入附件",
    "result": "调用结果附件",
    "soft_retry": "报告重答",
    "changed_source_paths": "实际修改源码",
    "found": "首次发现",
    "fixed": "已修复",
    "remaining": "仍遗留",
    "fullcheck_raw_counts": "复验各批原始告警数",
    "fullcheck_expected_raw": "复验预期原始告警数",
    "fullcheck_command_count": "复验命令批次数",
    "outcome": "处理结果",
    "log_path": "详细日志",
    "value": "值",
}

CODE_BLOCK_FIELDS = {
    "command", "commands", "launch", "detail", "error", "reason", "ack",
    "fixed_changes_reported",
}
PATH_FIELDS = {
    "cwd", "path", "reported_path", "parsed_json_path", "diagnostic",
    "record_file", "task_path", "transcript_path", "log_path",
}


def _safe_segment(value, fallback):
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "")).strip("-._")
    return value[:80] or fallback


def codecheck_log_path(root, state=None):
    """Return the absolute Markdown path for a flow or standalone CodeCheck."""
    project = os.path.abspath(root or os.getcwd())
    state = state if isinstance(state, dict) else {}
    if (state.get("kind") == "codecheck" and state.get("work_dir")):
        return os.path.join(
            os.path.abspath(state["work_dir"]), "codecheck-debug.md")
    config = state.get("config", {}) or {}
    ticket = _safe_segment(config.get("单号"), "no-ticket")
    step = _safe_segment(state.get("current"), "unknown-step")
    return os.path.join(
        project, ".mae-flow-work", "codecheck-logs",
        "%s-%s.md" % (ticket, step))


def _label(key):
    return FIELD_LABELS.get(str(key), str(key).replace("_", " "))


def _scalar(value):
    if value is True:
        return "是"
    if value is False:
        return "否"
    if value is None:
        return "（无）"
    text = str(value)
    return text if text else "（空）"


def _artifact_line(value):
    if not isinstance(value, dict) or not (
            value.get("path") or value.get("omitted") or value.get("error")):
        return ""
    if value.get("error"):
        return "附件保存失败：%s" % value["error"]
    if value.get("omitted"):
        return (
            "超过本轮附件数量上限，未单独落盘；原始大小 %s bytes；SHA-256 `%s`"
            % (value.get("bytes", "?"), value.get("sha256", "")))
    text = "`%s`；原始大小 %s bytes；保存大小 %s bytes；SHA-256 `%s`" % (
        value.get("path", ""), value.get("bytes", "?"),
        value.get("stored_bytes", "?"), value.get("sha256", ""))
    if value.get("truncated"):
        text += "；内容已截断保存头尾"
    if value.get("return_code") is not None:
        text += "；生成命令返回码 %s" % value.get("return_code")
    if value.get("stderr"):
        text += "；生成命令错误：%s" % str(value.get("stderr")).strip()
    return text


def _list_item(value):
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            if isinstance(item, (dict, list, tuple)):
                continue
            parts.append("%s=%s" % (_label(key), _scalar(item)))
        return "；".join(parts) or _scalar(value)
    if isinstance(value, (list, tuple)):
        return " | ".join(_scalar(item) for item in value)
    return _scalar(value)


def _render_mapping(mapping, level=0):
    lines = []
    for key, value in (mapping or {}).items():
        label = _label(key)
        artifact = _artifact_line(value)
        if artifact:
            lines.append("- **%s**：%s" % (label, artifact))
            preview = str(value.get("preview", "") or "").strip()
            if preview:
                lines.extend([
                    "",
                    "<details>",
                    "<summary>%s内容预览</summary>" % label,
                    "",
                    "```text",
                    preview,
                    "```",
                    "",
                    "</details>",
                ])
            continue
        if isinstance(value, dict):
            if level == 0 and lines and lines[-1]:
                lines.append("")
            lines.append("### %s" % label if level == 0 else "- **%s**：" % label)
            nested = _render_mapping(value, level + 1)
            lines.extend(("  " + line if level else line) for line in nested)
            continue
        if isinstance(value, (list, tuple)):
            if level == 0 and lines and lines[-1]:
                lines.append("")
            lines.append("### %s" % label if level == 0 else "- **%s**：" % label)
            if not value:
                lines.append("- （无）" if level == 0 else "  - （无）")
            else:
                prefix = "- " if level == 0 else "  - "
                lines.extend(prefix + _list_item(item) for item in value)
            continue
        text = _scalar(value)
        if key in CODE_BLOCK_FIELDS or "\n" in text or len(text) > 240:
            if level == 0 and lines and lines[-1]:
                lines.append("")
            lines.extend([
                "### %s" % label if level == 0 else "- **%s**：" % label,
                "```text",
                text,
                "```",
            ])
        elif key in PATH_FIELDS:
            lines.append("- **%s**：`%s`" % (label, text))
        else:
            lines.append("- **%s**：%s" % (label, text))
    return lines


def _header(state):
    config = (state or {}).get("config", {}) or {}
    return "\n".join([
        "# Mae-Flow CodeCheck 详细日志",
        "",
        "> 面向开发者的本地排障记录。按时间顺序追加；大块原始输出、报告和 diff",
        "> 保存在同目录的 `.d/` 附件目录。日志失败不会影响流程门禁。",
        "",
        "- **单号**：%s" % (config.get("单号") or "（无）"),
        "- **流程步骤**：%s" % ((state or {}).get("current") or "（无）"),
        "- **独立任务 ID**：%s" % (
            (state or {}).get("id") or (state or {}).get("_action_id") or "（无）"),
        "- **日志格式版本**：%s" % SCHEMA_VERSION,
        "",
    ])


def append_codecheck_event(root, state, event, details=None, source="harness"):
    """Append one human-readable event and return the log path, or ``""``."""
    try:
        path = codecheck_log_path(root, state)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        first = not os.path.isfile(path) or os.path.getsize(path) == 0
        at = time.strftime("%Y-%m-%d %H:%M:%S")
        title = EVENT_TITLES.get(str(event), str(event))
        source_label = "主流程" if source == "harness" else "Agent Hook"
        body = [
            "---",
            "",
            "## %s｜%s" % (at, title),
            "",
            "- **来源**：%s" % source_label,
            "- **事件代码**：`%s`" % event,
        ]
        body.extend(_render_mapping(
            details if isinstance(details, dict) else {"value": details}))
        text = ((_header(state) + "\n") if first else "") + "\n".join(body) + "\n\n"
        with open(path, "a", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        return path
    except Exception:
        return ""


def save_codecheck_artifact(
        root, state, label, content, extension=".txt", max_bytes=None):
    """Save bounded raw content and return metadata for the Markdown log."""
    try:
        log = codecheck_log_path(root, state)
        stem = os.path.splitext(os.path.basename(log))[0]
        directory = os.path.join(os.path.dirname(log), stem + ".d")
        os.makedirs(directory, exist_ok=True)
        raw = (content if isinstance(content, bytes)
               else str(content or "").encode("utf-8", errors="replace"))
        digest = hashlib.sha256(raw).hexdigest()
        preview = raw[:1200].decode("utf-8", errors="replace").replace("\x00", "�")
        if len(raw) > 1200:
            preview += "\n…（完整内容见附件）"
        limit = int(max_bytes or MAX_ARTIFACT_BYTES)
        limit = max(1024, min(limit, MAX_ARTIFACT_BYTES))
        truncated = len(raw) > limit
        if truncated:
            marker = (
                "\n\n===== MAE-FLOW LOG TRUNCATED: original %d bytes; "
                "preserved head+tail; SHA256 %s =====\n\n"
                % (len(raw), digest)
            ).encode("utf-8")
            half = max(1, (limit - min(len(marker), limit // 2)) // 2)
            stored = raw[:half] + marker + raw[-half:]
        else:
            stored = raw
        safe_label = _safe_segment(label, "artifact")
        suffix = extension if str(extension).startswith(".") else "." + str(extension)
        name = "%d-%s-%s%s" % (
            time.time_ns(), os.getpid(), safe_label, suffix)
        path = os.path.join(directory, name)
        with open(path, "wb") as stream:
            stream.write(stored)
        return {
            "path": os.path.abspath(path),
            "bytes": len(raw),
            "stored_bytes": len(stored),
            "sha256": digest,
            "truncated": truncated,
            "preview": preview,
        }
    except Exception as exc:
        return {"error": str(exc)}
