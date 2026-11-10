"""CodeCheck execution orchestration behind explicit runtime ports."""

from dataclasses import dataclass
import os
import re

from ...quality import codecheck as policies


@dataclass(frozen=True)
class CodeCheckRunPorts:
    cwd: str
    head: object
    append_event: object
    ensure_capability: object
    split_batches: object
    build_launch: object
    clock: object
    run_process: object
    is_timeout: object
    save_artifact: object
    read_text: object
    modified_time: object
    parse_json_file: object
    log_path: object
    save_diagnostic: object
    program_path: str


@dataclass(frozen=True)
class CodeCheckRunResult:
    scan: object = None
    log_path: str = ""
    error: str = ""


@dataclass(frozen=True)
class _BatchResult:
    batch: object = None
    error: str = ""


def _absolute(cwd, path):
    return (
        os.path.normpath(path)
        if os.path.isabs(path)
        else os.path.abspath(os.path.join(cwd, path))
    )


def _event(ports, state, name, payload):
    return ports.append_event(state, name, payload)


def _capability_error(detail):
    suffix = " 诊断: " + detail if detail else ""
    return (
        "CodeCheck CLI 当前不可用。Mae-Flow 已按公司内网源尽力自动安装，但没有成功；"
        "这不会触发重复安装或派修复 Agent。"
        + suffix
        + "。普通模式请向用户展示风险后使用错误信息给出的恢复通道；"
        "月光宝盒模式记录为未完成质量项后继续。"
    )


def _unsafe_files(files):
    return [
        path for path in files
        if re.search(r"[&|^%<>;,]", path)
    ]


def _timeout_result(
        ports, state, phase, index, command, error):
    _event(ports, state, "command.failed", {
        "phase": phase,
        "batch": index,
        "command": command,
        "kind": "timeout",
        "timeout_seconds": 900,
        "stdout": ports.save_artifact(
            state,
            "batch-%d-timeout-stdout" % index,
            getattr(error, "stdout", "") or "",
        ),
        "stderr": ports.save_artifact(
            state,
            "batch-%d-timeout-stderr" % index,
            getattr(error, "stderr", "") or "",
        ),
    })
    return _BatchResult(
        error="codecheck 现场检查超时(>15min)——批次过大或服务异常")


def _launch_error_result(
        ports, state, phase, index, command, error):
    _event(ports, state, "command.failed", {
        "phase": phase,
        "batch": index,
        "command": command,
        "kind": "launch-error",
        "error": str(error),
    })
    return _BatchResult(
        error="codecheck CLI 无法启动: " + str(error))


def _run_process(
        ports, state, phase, index, command, launch, use_shell):
    try:
        return ports.run_process(launch, use_shell), None
    except Exception as error:
        if ports.is_timeout(error):
            return None, _timeout_result(
                ports, state, phase, index, command, error)
        if isinstance(error, OSError):
            return None, _launch_error_result(
                ports, state, phase, index, command, error)
        raise


def _report_text(ports, output):
    match = re.search(r"检查报告已保存到:\s*(.+)", output)
    if match is None:
        return None, "", output
    path = match.group(1).strip()
    try:
        return match, path, ports.read_text(path)
    except OSError:
        return match, path, output


def _json_candidates(report_match):
    candidates = [
        os.path.join(".codecheckcli", "codecheck-result.json"),
    ]
    if report_match is not None:
        candidates.append(os.path.join(
            os.path.dirname(report_match.group(1).strip()),
            "codecheck-result.json",
        ))
    return tuple(candidates)


def _parse_json_fallback(
        ports, state, index, report_match, started):
    for path in _json_candidates(report_match):
        try:
            if ports.modified_time(path) + 2 < started:
                continue
            count, warnings = ports.parse_json_file(path)
            if count is None:
                continue
            artifact = None
            try:
                artifact = ports.save_artifact(
                    state,
                    "batch-%d-result-json" % index,
                    ports.read_text(path),
                    ".json",
                )
            except OSError:
                pass
            return (
                count,
                warnings,
                _absolute(ports.cwd, path),
                artifact,
            )
        except OSError:
            continue
    return None, (), "", None


def _warning_values(json_warnings, report):
    if json_warnings:
        return tuple(
            policies.CodeCheckWarning(rule, file_name, line)
            for rule, file_name, line in json_warnings
        )
    return policies.extract_report_warnings(report)


def _diagnostic_error(
        ports, state, phase, index, command, process, output, report):
    snapshot = ports.save_diagnostic(
        command, process.returncode, output, report)
    _event(ports, state, "run.failed", {
        "phase": phase,
        "kind": "unparsed-output",
        "batch": index,
        "command": command,
        "diagnostic": _absolute(ports.cwd, snapshot),
    })
    return (
        "codecheck 已返回但告警数无法解析。已尝试控制台、Markdown 汇总/明细和 JSON 结果；"
        "完整现场已保存到 %s。这是工具兼容问题，不要派修复 Agent、不要猜 0 条。"
        "可重试一次；仍失败时把诊断文件展示给用户人工核对，用户确认实际告警数后执行 "
        "messages 取得该回答 ID，再执行 "
        'python3 "%s" codecheck-record --count <数字> --diagnostic "%s" '
        '--reason "输出格式暂不兼容，已人工核对" --message-id <ID>。'
        "该记录绑定当前步骤、HEAD、文件清单和诊断内容，代码一变自动失效。"
        % (snapshot, ports.program_path, snapshot)
    )


def _execute_batch(
        ports, state, phase, batch, index, batch_count, executable):
    launch, use_shell, command = ports.build_launch(
        batch, executable)
    started = ports.clock()
    _event(ports, state, "command.started", {
        "phase": phase,
        "batch": index,
        "batch_count": batch_count,
        "files": batch,
        "command": command,
        "launch": launch,
        "shell": use_shell,
        "executable": executable or "",
    })
    process, failure = _run_process(
        ports, state, phase, index, command, launch, use_shell)
    if failure is not None:
        return failure
    stdout = process.stdout or ""
    stderr = process.stderr or ""
    output = stdout + stderr
    stdout_artifact = ports.save_artifact(
        state, "batch-%d-stdout" % index, stdout)
    stderr_artifact = ports.save_artifact(
        state, "batch-%d-stderr" % index, stderr)
    report_match, report_path, report = _report_text(
        ports, output)
    report_artifact = (
        ports.save_artifact(
            state, "batch-%d-report" % index, report, ".md")
        if report != output else None
    )
    count = policies.parse_count(output, report)
    json_warnings = ()
    parsed_from = "console-or-report" if count is not None else ""
    json_path = ""
    json_artifact = None
    if count is None:
        count, json_warnings, json_path, json_artifact = (
            _parse_json_fallback(
                ports, state, index, report_match, started)
        )
        if count is not None:
            parsed_from = "json"
    _event(ports, state, "command.completed", {
        "phase": phase,
        "batch": index,
        "batch_count": batch_count,
        "command": command,
        "return_code": process.returncode,
        "duration_ms": int((ports.clock() - started) * 1000),
        "parsed_count": count,
        "parsed_from": parsed_from,
        "reported_path": report_path,
        "parsed_json_path": json_path,
        "parsed_json": json_artifact,
        "stdout": stdout_artifact,
        "stderr": stderr_artifact,
        "report": report_artifact,
    })
    if count is None:
        return _BatchResult(error=_diagnostic_error(
            ports, state, phase, index, command,
            process, output, report,
        ))
    warnings = _warning_values(json_warnings, report)
    mapped = policies.map_warning_paths(
        warnings, tuple(batch))
    return _BatchResult(batch=policies.CodeCheckBatch(
        count=count,
        warnings=mapped,
        command=command,
    ))


def run_codecheck(files, state, phase, ports):
    """Run all CodeCheck batches while keeping I/O behind the supplied ports."""
    files = tuple(files)
    state = state if isinstance(state, dict) else {}
    head = ports.head()
    log_path = _event(ports, state, "run.started", {
        "phase": phase,
        "cwd": os.path.abspath(ports.cwd),
        "head": head,
        "files": list(files),
        "file_count": len(files),
    })
    capability = ports.ensure_capability()
    _event(ports, state, "capability.checked", {
        "phase": phase,
        "available": bool(capability.get("available")),
        "path": capability.get("path", ""),
        "detail": capability.get("detail", ""),
        "installed": capability.get("installed"),
    })
    if not capability.get("available"):
        detail = str(capability.get("detail", "")).strip()[-1200:]
        _event(ports, state, "run.failed", {
            "phase": phase,
            "kind": "capability-unavailable",
            "detail": detail,
        })
        return CodeCheckRunResult(
            log_path=log_path,
            error=_capability_error(detail),
        )
    risky = _unsafe_files(files)
    if risky:
        _event(ports, state, "run.failed", {
            "phase": phase,
            "kind": "unsafe-file-name",
            "files": risky,
        })
        return CodeCheckRunResult(
            log_path=log_path,
            error=(
                "以下文件名含 cmd 元字符或逗号,无法安全传入 codecheck -f: "
                + "、".join(risky[:5])
                + "。请重命名文件或将其移出本次检查范围后重试。"
            ),
        )
    batches = tuple(ports.split_batches(files))
    parsed = []
    executable = capability.get("path") or None
    for index, batch in enumerate(batches, 1):
        outcome = _execute_batch(
            ports, state, phase, batch, index,
            len(batches), executable,
        )
        if outcome.error:
            return CodeCheckRunResult(
                log_path=log_path,
                error=outcome.error,
            )
        parsed.append(outcome.batch)
    scan = policies.aggregate_batches(tuple(parsed))
    final_log_path = log_path or ports.log_path(state)
    _event(ports, state, "run.completed", {
        "phase": phase,
        "head": head,
        "total": scan.total,
        "pairs": [
            warning.as_tuple() for warning in scan.warnings
        ],
        "commands": list(scan.commands),
        "log_path": final_log_path,
    })
    return CodeCheckRunResult(
        scan=scan,
        log_path=final_log_path,
    )
