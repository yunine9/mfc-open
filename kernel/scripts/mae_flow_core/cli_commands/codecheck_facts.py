"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CODECHECK_LINE_SLACK, CodeCheckRunPorts, STATE_PATH, append_codecheck_event,
    capability_diagnostics, codecheck_log_path, ensure_codecheck, execute_codecheck,
    json, load_json, os, quality_codecheck, re, read_text, save_codecheck_artifact,
    shutil, subprocess, sys, time, write_text,
)
from .wiring import api

def _hunk_targets_for_diff(diff, files):
    """从指定 Git diff 提取函数级定位线索：新增行范围 + hunk 函数上下文。"""
    result = {}
    pattern = re.compile(
        r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(?:\s*(.*))?$", re.M)
    for path in files:
        out = api.argv_out([
            "git", "-c", "core.quotepath=false",
            "diff", "-U0", diff, "--", path,
        ])
        targets = []
        for match in pattern.finditer(out):
            start = int(match.group(1))
            count = int(match.group(2) if match.group(2) is not None else "1")
            end = start + max(count, 1) - 1
            context = re.sub(r"\s+", " ", (match.group(3) or "").strip())
            if len(context) > 180:
                context = context[:177] + "..."
            targets.append({
                "start": start, "end": end, "context": context,
                "deletion_only": count == 0,
            })
        result[api.norm(path)] = targets
    return result

def _changed_hunk_targets(st, files):
    """提取完整流程 UT 的函数级定位线索。"""
    diff, err = api._scope_diff(st)
    if err:
        return None, err
    return _hunk_targets_for_diff(diff, files), ""

def _looks_like_function_context(context):
    """只接受明确的方法/函数 hunk，避免把 Java class/namespace 整块当成本次函数。"""
    value = re.sub(r"\s+", " ", str(context or "").strip())
    if not value:
        return False
    if re.search(r"\b(class|struct|interface|enum|namespace|module)\b", value):
        return False
    return bool(
        ("(" in value and ")" in value)
        or re.search(r"\b(def|func|fn)\s+[A-Za-z_$][\w$]*", value)
    )

def _lexical_function_range(path, line_number):
    """Git 无函数驱动时的保守兜底，仅识别常见 Python 与花括号语言函数。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as stream:
            source_lines = stream.read().splitlines()
    except OSError:
        return None
    if not source_lines or line_number < 1 or line_number > len(source_lines):
        return None
    low = path.lower()
    if low.endswith((".py", ".pyi")):
        for index in range(line_number - 1, -1, -1):
            match = re.match(
                r"^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(", source_lines[index])
            if not match:
                continue
            indent = len(match.group(1).replace("\t", "    "))
            end = len(source_lines)
            for cursor in range(index + 1, len(source_lines)):
                raw = source_lines[cursor]
                if not raw.strip():
                    continue
                current_indent = len(raw) - len(raw.lstrip(" \t"))
                if current_indent <= indent and not raw.lstrip().startswith(("#", "@")):
                    end = cursor
                    break
            if index + 1 <= line_number <= end:
                return {
                    "start": index + 1, "end": end,
                    "context": source_lines[index].strip()[:180],
                }
        return None
    if not low.endswith((
            ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
            ".java", ".js", ".jsx", ".ts", ".tsx")):
        return None
    control = re.compile(
        r"^(?:if|for|while|switch|catch|else|do|try|synchronized)\b")
    for index in range(line_number - 1, max(-1, line_number - 80), -1):
        header = source_lines[index].strip()
        if not header or control.match(header) or re.search(
                r"\b(class|struct|interface|enum|namespace|module)\b", header):
            continue
        if "(" not in header:
            continue
        joined = " ".join(
            part.strip() for part in source_lines[index:min(len(source_lines), index + 6)])
        before_brace = joined.split("{", 1)[0]
        if "{" not in joined or "(" not in before_brace or ")" not in before_brace:
            continue
        if control.match(before_brace.strip()) or before_brace.rstrip().endswith(";"):
            continue
        depth = 0
        opened = False
        for cursor in range(index, len(source_lines)):
            # 去掉常见字符串和 // 注释后再数括号；无法可靠解析时宁可不返回。
            code = re.sub(
                r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`',
                "", source_lines[cursor]).split("//", 1)[0]
            depth += code.count("{") - code.count("}")
            opened = opened or "{" in code
            if opened and depth == 0:
                end = cursor + 1
                if index + 1 <= line_number <= end:
                    return {
                        "start": index + 1, "end": end,
                        "context": before_brace.strip()[:180],
                    }
                break
            if opened and depth < 0:
                break
    return None

def _changed_function_ranges(st, files):
    """用 Git function-context 识别本次实际改到的函数新文件行范围。

    识别不可靠时返回空范围，调用方仍以变更行窗口 + 用户确认兜底，绝不把整文件
    自动算成本次修改。
    """
    diff, err = api._scope_diff(st)
    if err:
        return None, err
    changed, err = api._changed_lines(st, files)
    if err or changed is None:
        return None, err or "无法读取变更行"
    pattern = re.compile(
        r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(?:\s*(.*))?$", re.M)
    result = {}
    for path in files:
        out = api.argv_out([
            "git", "-c", "core.quotepath=false", "diff",
            "--function-context", "--unified=0", diff, "--", path,
        ])
        ranges = []
        changed_lines = changed.get(api.norm(path), set())
        for line in sorted(changed_lines):
            fallback = _lexical_function_range(path, line)
            if fallback and not any(
                    item["start"] == fallback["start"] and item["end"] == fallback["end"]
                    for item in ranges):
                ranges.append(fallback)
        for match in pattern.finditer(out):
            start = int(match.group(1))
            count = int(match.group(2) if match.group(2) is not None else "1")
            context = re.sub(r"\s+", " ", (match.group(3) or "").strip())
            if count <= 0 or not _looks_like_function_context(context):
                continue
            end = start + count - 1
            hunk_changes = [
                line for line in changed_lines if start <= line <= end
                and not any(item["start"] <= line <= item["end"] for item in ranges)
            ]
            if not hunk_changes:
                continue
            ranges.append({"start": start, "end": end, "context": context[:180]})
        ranges.sort(key=lambda item: (item["start"], item["end"]))
        result[api.norm(path)] = ranges
    return result, ""

def _codecheck_scope_classification(result, st, files):
    if not quality_codecheck.scope_is_classifiable(result):
        return quality_codecheck.classify_scope(
            result, None, None, CODECHECK_LINE_SLACK)
    changed, error = api._changed_lines(st, files)
    if error or changed is None:
        return quality_codecheck.classify_scope(
            result, None, None, CODECHECK_LINE_SLACK)
    function_ranges, range_error = _changed_function_ranges(
        st, files)
    if range_error or function_ranges is None:
        function_ranges = {}
    return quality_codecheck.classify_scope(
        result,
        changed_lines=changed,
        function_ranges=function_ranges,
        slack=CODECHECK_LINE_SLACK,
    )

def _classify_codecheck_with_repository_facts(
        result, st, files):
    """Classify CodeCheck warnings using repository facts and pure policy."""
    scoped = _codecheck_scope_classification(
        result, st, files)
    if not scoped.classified:
        return result, None
    filtered = {
        "total": scoped.total,
        "pairs": [
            warning.as_tuple()
            for warning in scoped.warnings
        ],
        "commands": list(scoped.commands),
        "log_path": scoped.log_path,
        "scope_reasons": [
            reason.as_record()
            for reason in scoped.reasons
        ],
    }
    excluded = [
        warning.as_tuple()
        for warning in scoped.excluded
    ]
    return filtered, excluded

def _filter_codecheck_with_repository_facts(
        result, st, files):
    """旧调用口径兼容：返回过滤结果与窗口外数量。

    codecheck-scan 使用完整分类结果保留逐条候选并要求用户确认；
    旧的现场复核只需要数量对账，继续走这个薄包装。
    """
    filtered, excluded = _classify_codecheck_with_repository_facts(
        result, st, files)
    return filtered, (len(excluded) if excluded is not None else None)

def _codecheck_launch(batch, executable=None, windows=None):
    """构造 CodeCheck 启动方式；Windows 沿用已在公司实机验证过的 shell/PATHEXT 解析。"""
    is_windows = os.name == "nt" if windows is None else windows
    program = executable or "codecheck"
    base_argv = [program, "fullcheck", "-f", ",".join(batch)]
    display = subprocess.list2cmdline(base_argv)
    if is_windows:
        # npm 全局 CLI 是 codecheck.cmd。旧版 shell=True 已在公司 Windows 实机稳定执行；
        # 不再手工套 cmd.exe /s /c，避免 cmd 的首尾引号规则破坏本来可用的命令。
        return display, True, display
    resolved = executable or shutil.which("codecheck")
    if resolved:
        return [resolved, "fullcheck", "-f", ",".join(batch)], False, display
    # 其他平台找不到实体时也保留 shell 恢复路径。
    return display, True, display

def _save_codecheck_diagnostic(command, return_code, output, report):
    directory = os.path.join(
        ".mae-flow-work", "codecheck-diagnostics")
    os.makedirs(directory, exist_ok=True)
    snapshot = os.path.join(
        directory, time.strftime("%Y%m%d-%H%M%S") + ".txt")
    content = (
        "COMMAND: " + command
        + "\nRETURN_CODE: " + str(return_code)
        + "\n\n" + output
    )
    if report != output:
        content += "\n\n===== REPORT =====\n" + report
    write_text(snapshot, content)
    return snapshot

def _run_codecheck(files, st=None, phase="scan"):
    """CLI adapter for the CodeCheck execution application use case."""
    cwd = os.getcwd()
    result = execute_codecheck(
        files,
        st,
        phase,
        CodeCheckRunPorts(
            cwd=cwd,
            head=lambda: api.sh("git rev-parse --verify HEAD"),
            append_event=lambda state, event, payload: (
                append_codecheck_event(
                    cwd, state, event, payload)
            ),
            ensure_capability=lambda: ensure_codecheck(install=True),
            split_batches=quality_codecheck.split_batches,
            build_launch=lambda batch, executable: (
                _codecheck_launch(
                    batch, executable=executable)
            ),
            clock=time.time,
            run_process=lambda launch, use_shell: subprocess.run(
                launch,
                shell=use_shell,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=900,
            ),
            is_timeout=lambda error: isinstance(
                error, subprocess.TimeoutExpired),
            save_artifact=lambda state, label, content, suffix=".txt": (
                save_codecheck_artifact(
                    cwd, state, label, content, suffix)
            ),
            read_text=lambda path: read_text(
                path, encoding="utf-8", errors="replace"),
            modified_time=os.path.getmtime,
            parse_json_file=_load_codecheck_json_result,
            log_path=lambda state: codecheck_log_path(cwd, state),
            save_diagnostic=_save_codecheck_diagnostic,
            program_path=os.path.abspath(sys.argv[0]),
        ),
    )
    if result.scan is None:
        return None, result.error
    return {
        "total": result.scan.total,
        "pairs": [
            warning.as_tuple()
            for warning in result.scan.warnings
        ],
        "commands": list(result.scan.commands),
        "log_path": result.log_path,
    }, result.error

def _load_codecheck_json_result(path):
    """兼容 CodeCheckCLI 的 JSON 结果：不依赖固定顶层字段，按带 UUID/规则/文件的告警对象去重。"""
    count, warnings = quality_codecheck.parse_json_result(
        load_json(path, errors="replace"))
    return count, [
        warning.as_tuple() for warning in warnings
    ]

def _approval_key(rule, path):
    return (rule.strip() + "|" + api.norm(path).strip().lstrip("./")).lower()

def _exemption_text_has_pair(text, rule, path):
    """规则与文件必须出现在同一条记录，不能拿两行内容交叉拼成一个假豁免。"""
    np = api.norm(path).lower()
    nr = rule.strip().lower()
    return any(nr in line.lower() and np in api.norm(line).lower() for line in text.splitlines())

def _approved_exemptions(st):
    return {_approval_key(x.get("rule", ""), x.get("file", ""))
            for x in st.get("codecheck_exemptions", []) if x.get("rule") and x.get("file")}

def _was_exempt_before_review(st, ex, rule, path):
    """原 MR 已存在的正式豁免不重复询问；本轮新豁免必须有状态机审批记录。"""
    if not api._is_review(st):
        return False
    base = st.get("review_base_head", "")
    if not base:
        return False
    try:
        r = subprocess.run(["git", "show", f"{base}:{ex}"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=8)
        txt = r.stdout if r.returncode == 0 else ""
    except Exception:
        txt = ""
    return _exemption_text_has_pair(txt, rule, path)

def run_env_checks(force_all=False):
    """Compatibility view of self-contained runtime diagnostics."""
    checks = capability_diagnostics(os.getcwd(), include_codecheck=False)
    return [item["name"] for item in checks if not item["ok"]]

def _agent_token_data():
    try:
        return json.loads(read_text(".mae-flow.json.tokens"))
    except Exception:
        return {}

def _agent_rejection_data():
    try:
        return load_json(STATE_PATH + ".agent-rejections")
    except Exception:
        return {}
