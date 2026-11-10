"""Process isolation and report rendering for Lightcheck."""

from .lightcheck_source import multiprocessing, os
from .lightcheck_functions import _empty_result
from .lightcheck_analysis import _ChangedAnalyzer

def analyze_changed(
        root, files, changed_lines, baseline_sources=None,
        current_sources=None, magic_changed_lines=None):
    """Analyze current source while reporting only newly triggered rules."""
    analyzer = _ChangedAnalyzer(
        root, files, changed_lines, baseline_sources or {}, current_sources,
        magic_changed_lines)
    return analyzer.run()


def _analyze_worker(connection, arguments):
    try:
        connection.send(analyze_changed(*arguments))
    except BaseException as exc:
        connection.send(_empty_result(
            "TOOL_ERROR", ["隔离分析进程异常: " + str(exc)]))
    finally:
        connection.close()


def _stop_process(process):
    if process.is_alive():
        process.terminate()
        process.join(2)


def _pipe_result(connection):
    try:
        return connection.recv()
    except (EOFError, OSError):
        return _empty_result(
            "TOOL_ERROR", ["轻量分析子进程未返回结果；已记录诊断，不阻断流程"])


def _process_context():
    method = "spawn"
    if os.name != "nt":
        method = "fork"
    return multiprocessing.get_context(method)


def _process_arguments(
        root, files, changed_lines, baseline_sources, current_sources,
        magic_changed_lines):
    sources = baseline_sources
    if sources is None:
        sources = {}
    return (root, files, changed_lines, sources, current_sources,
            magic_changed_lines)


def _await_analysis_result(receiver, process, timeout_seconds):
    if not receiver.poll(timeout_seconds):
        _stop_process(process)
        return _empty_result(
            "TOOL_ERROR",
            ["轻量分析超过 %s 秒；已记录诊断，不阻断流程" % timeout_seconds],
            timeout_seconds * 1000)
    result = _pipe_result(receiver)
    process.join(2)
    return result


def _close_sender(sender):
    if not sender.closed:
        sender.close()


def analyze_changed_with_timeout(
        root, files, changed_lines, baseline_sources=None,
        options=None):
    """Run the analyzer in an isolated process; timeout is always advisory."""
    options = options or {}
    current_sources = options.get("current_sources")
    magic_changed_lines = options.get("magic_changed_lines")
    timeout_seconds = options.get("timeout_seconds", 8)
    context = _process_context()
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(
        target=_analyze_worker,
        args=(sender, _process_arguments(
            root, files, changed_lines, baseline_sources, current_sources,
            magic_changed_lines)),
    )
    try:
        process.start()
        sender.close()
        return _await_analysis_result(
            receiver, process, timeout_seconds)
    except Exception as exc:
        return _empty_result(
            "TOOL_ERROR",
            ["轻量分析隔离启动失败；已记录诊断，不阻断流程: " + str(exc)])
    finally:
        _stop_process(process)
        receiver.close()
        _close_sender(sender)


def _report_header(result, scope):
    # 报告要能自证新鲜:这份文件叫 latest.md,不写生成时间和绑定 HEAD 的话,
    # 上一轮甚至上一单留下的"结果：CLEAN"会被当成当前结论——面板与 current
    # 都把它当报告指给人看。
    return [
        "# Mae-Flow 轻量编码预检",
        "",
        "- 生成时间：" + str(result.get("at") or "未记录"),
        "- 绑定版本：" + (str(result.get("head") or "未记录"))[:12],
        "- 定位：前置预防建议，不替代正式 CodeCheck，不产生流程门禁",
        "- 范围：" + str(scope or "本轮 Agent 实际修改"),
        "- 结果：" + result.get("status", "UNKNOWN"),
        "- 检查文件：%d" % len(result.get("files") or []),
        "- 检查函数：%d" % int(result.get("functions_checked", 0) or 0),
        "- 耗时：%dms" % int(result.get("duration_ms", 0) or 0),
        "",
    ]


def _report_findings(findings):
    if not findings:
        return ["本轮没有发现高置信问题。", ""]
    lines = ["## 建议本轮修复", ""]
    for item in findings:
        function = ("，函数 `" + item["function"] + "`"
                    if item.get("function") else "")
        baseline = ("，基线 %s" % item["baseline"]
                    if "baseline" in item else "")
        lines.append(
            "- `%s` `%s:%s`%s：%s（当前 %s，上限 %s%s）" % (
                item["rule"], item["file"], item["line"], function,
                item["message"], item["actual"], item["limit"], baseline))
    lines.append("")
    return lines


def _report_debt(debt):
    if not debt:
        return []
    lines = ["## 基线已有（不提示修复、不推动范围外重构）", ""]
    for item in debt:
        lines.append("- `%s` `%s:%s`：当前 %s，基线 %s" % (
            item["rule"], item["file"], item["line"],
            item["actual"], item.get("baseline", "?")))
    lines.append("")
    return lines


def _report_skipped(skipped):
    if not skipped:
        return []
    return ["## 安全降级", ""] + [
        "- " + item for item in skipped
    ] + [""]


def _report_rules():
    return [
        "## 固定口径",
        "",
        "- 参数 ≤ 5；Python 的 `self`/`cls` 不计入。",
        "- 函数有效代码行 ≤ 50；空行、纯注释、仅分隔括号/符号的行不计。",
        "- 函数控制结构最大嵌套深度 ≤ 5；平行分支和复合条件不累计。",
        "- 本次修改的代码行 ≤ 120 字符；不自动暴力换行，优先项目 formatter 和附近同类风格。",
        "",
    ]


def render_markdown(result, scope):
    lines = _report_header(result, scope)
    findings = result.get("findings") or []
    debt = result.get("existing_debt") or []
    skipped = result.get("skipped") or []
    lines += _report_findings(findings)
    lines += _report_debt(debt)
    lines += _report_skipped(skipped)
    lines += _report_rules()
    return "\n".join(lines)
