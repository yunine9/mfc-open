"""Pure interpretation of UT commands and runner output."""

import re

from mae_flow_core.quality.agent_reports import report_field, report_number

_HARD_RISK_PATTERN = re.compile(
    r"\b(?:pre-existing\s+(?:failure|segfault)|"
    r"segmentation\s+fault|segfault)\b|"
    r"段错误|绕过失败|屏蔽失败",
    re.I,
)
_FILTER_ARGUMENT = re.compile(
    r"(?P<flag>--?gtest_filter|--?exclude|--?skip|--?disable|"
    r"--filter|-E|-R|-k|-m|-t|--deselect|--ignore|--tests|"
    r"--tests-regex|--exclude-regex|--runTestsByPath|"
    r"--testPathPattern|--testNamePattern|"
    r"-D(?:test|tests|it\.test))"
    r"(?=\s|=|$)(?:\s*=\s*|\s+)?"
    r"(?P<value>\"[^\"]*\"|'[^']*'|[^\s;&|]+)?",
    re.I,
)


def _command_of(call):
    value = call.input
    return value.get("command", "") if isinstance(value, dict) else str(value)


def _filter_args(command):
    return sorted([
        (
            match.group("flag").lower(),
            re.sub(
                r"\s+",
                " ",
                (match.group("value") or "").strip().strip("\"'"),
            ).lower(),
        )
        for match in _FILTER_ARGUMENT.finditer(command or "")
    ])


def _command_swallows_failure(command):
    return bool(re.search(
        r"(?:\|\||;|&)\s*(?:true|exit(?:\s+/b)?\s+0|"
        r"\$(?:global:)?LASTEXITCODE\s*=\s*0)\b",
        command or "",
        re.I,
    ))


def reported_bash_segment(call, reported):
    wanted = re.sub(
        r"\s+", " ", str(reported or "")
    ).strip().strip("`").lower()
    if not call or not wanted:
        return ""
    command = re.sub(
        r"\s+", " ", _command_of(call)).strip()
    for segment in re.split(r"&&|\|\||[;\n]", command):
        clean = segment.strip()
        low = clean.lower()
        if low.startswith(wanted) or wanted.startswith(low):
            return clean
    return ""


def _nonrunning_counts(text):
    patterns = {
        "disabled": (
            r"\b(\d+)\s+(?:tests?\s+)?disabled\b",
            r"\bdisabled(?:\s+tests?)?\s*[:=]\s*(\d+)\b",
        ),
        "skipped": (
            r"\b(\d+)\s+(?:tests?\s+)?skipped\b",
            r"\bskipped(?:\s+tests?)?\s*[:=]\s*(\d+)\b",
        ),
        "excluded": (
            r"\b(\d+)\s+(?:tests?\s+)?(?:excluded|deselected)\b",
            r"\b(?:excluded|deselected)(?:\s+tests?)?"
            r"\s*[:=]\s*(\d+)\b",
        ),
    }
    result = {}
    for kind, expressions in patterns.items():
        hits = []
        for expression in expressions:
            hits.extend(
                (match.start(), int(match.group(1)))
                for match in re.finditer(
                    expression, text or "", re.I)
            )
        if hits:
            result[kind] = max(
                hits, key=lambda item: item[0])[1]
    return result


def _observed_counts(text):
    value = str(text or "")
    candidates = []
    for match in re.finditer(
            r"(\d+)%\s+tests\s+passed,\s*(\d+)\s+tests?\s+failed"
            r"\s+out\s+of\s+(\d+)",
            value,
            re.I):
        total = int(match.group(3))
        failed = int(match.group(2))
        candidates.append((match.start(), {
            "total": total,
            "failed": failed,
            "passed": total - failed,
        }))
    for match in re.finditer(
            r"Tests\s+run:\s*(\d+),\s*Failures:\s*(\d+),"
            r"\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?",
            value,
            re.I):
        total, failures, errors = map(
            int, match.group(1, 2, 3))
        skipped = int(match.group(4) or 0)
        candidates.append((match.start(), {
            "total": total,
            "failed": failures + errors,
            "passed": max(
                0, total - failures - errors - skipped),
        }))
    candidates.extend(_gtest_counts(value))
    candidates.extend(_pytest_counts(value))
    if re.search(
            r"\bNo tests were found\b|\bno tests collected\b",
            value,
            re.I):
        candidates.append((
            len(value),
            {"total": 0, "failed": 0, "passed": 0},
        ))
    return (
        max(candidates, key=lambda item: item[0])[1]
        if candidates else {}
    )


def _gtest_counts(text):
    passed_hits = list(re.finditer(
        r"\[\s*PASSED\s*\]\s*(\d+)\s+tests?", text, re.I))
    failed_hits = list(re.finditer(
        r"\[\s*FAILED\s*\]\s*(\d+)\s+tests?", text, re.I))
    if not passed_hits and not failed_hits:
        return []
    passed = int(passed_hits[-1].group(1)) if passed_hits else 0
    failed = int(failed_hits[-1].group(1)) if failed_hits else 0
    position = max(
        passed_hits[-1].start() if passed_hits else -1,
        failed_hits[-1].start() if failed_hits else -1,
    )
    return [(position, {
        "total": passed + failed,
        "failed": failed,
        "passed": passed,
    })]


def _pytest_counts(text):
    candidates = []
    for match in re.finditer(
            r"^.*(?:passed|failed).*$", text, re.I | re.M):
        line = match.group(0)
        passed_hits = re.findall(
            r"\b(\d+)\s+passed\b", line, re.I)
        failed_hits = re.findall(
            r"\b(\d+)\s+failed\b|"
            r"\bfailed\s*[:=]\s*(\d+)\b",
            line,
            re.I,
        )
        if not passed_hits and not failed_hits:
            continue
        passed = int(passed_hits[-1]) if passed_hits else None
        failed = (
            int(next(value for value in failed_hits[-1] if value))
            if failed_hits else 0
        )
        candidates.append((match.start(), {
            "total": (
                passed + failed if passed is not None else None),
            "failed": failed,
            "passed": passed,
        }))
    return candidates


def report_counts(report):
    return {
        key: report_number(report, field)
        for key, field in (
            ("total", "TESTS_TOTAL"),
            ("passed", "TESTS_PASSED"),
            ("failed", "TESTS_FAILED"),
        )
    }


def _mutates_before_baseline(call):
    name = call.name.lower()
    if name in ("read", "grep", "glob"):
        return False
    if name in ("write", "edit", "multiedit", "skill"):
        return True
    if name != "bash":
        return False
    command = _command_of(call)
    without_fd_copy = re.sub(r"\d*>\s*&\s*\d+", "", command)
    if (
            re.search(
                r"(?:^|[\s;&|])(?:sed|perl)\s+-i\b|"
                r"\b(?:Set-Content|Out-File|Add-Content|tee)\b",
                command,
                re.I,
            )
            or re.search(r"\d*>{1,2}", without_fd_copy)):
        return True
    safe = re.compile(
        r"^(?:cd|pwd|ls|dir|find|rg|grep|cat|type|Get-Content|"
        r"git\s+(?:status|diff|log|show|rev-parse|ls-files))\b",
        re.I,
    )
    segments = [
        value.strip()
        for value in re.split(r"&&|[;\n]", command)
        if value.strip()
    ]
    return (
        not segments
        or any(not safe.search(segment) for segment in segments)
    )


def _normalized_risk_text(summary, result):
    value = summary + "\n" + result
    value = re.sub(
        r"\b(?:0|no)\s+(?:tests?\s+)?"
        r"(?:disabled|excluded|skipped)\b",
        "",
        value,
        flags=re.I,
    )
    value = re.sub(
        r"\b(?:tests?\s+)?(?:disabled|excluded|skipped)"
        r"\s*[:=]\s*0\b",
        "",
        value,
        flags=re.I,
    )
    value = re.sub(
        r"\bno\s+tests?\s+(?:were\s+)?"
        r"(?:disabled|excluded|skipped)\b",
        "",
        value,
        flags=re.I,
    )
    return re.sub(
        r"(?:跳过|禁用|排除)\s*[:：]?\s*0"
        r"\s*(?:个|项|条|例)?",
        "",
        value,
    )


def _basic_execution_risk(report, run_call, configured):
    summary = report_field(report, "EXECUTED_UT") or ""
    segment = reported_bash_segment(run_call, summary)
    result = str(run_call.result or "")
    if _command_swallows_failure(_command_of(run_call)):
        return (
            "实际 UT 命令吞掉了失败退出码（如 || true / ; exit 0）；"
            "即使工具调用显示成功也不能报告 PASS。")
    observed = _observed_counts(result)
    if observed.get("failed", 0) > 0:
        return (
            "测试器真实输出显示 %s 个失败，但报告声称 PASS；"
            "必须按 NEEDS_INPUT/FAIL 如实收尾。"
            % observed["failed"])
    reported_total = report_number(report, "TESTS_TOTAL")
    if (
            observed.get("total") is not None
            and reported_total is not None):
        legitimate = {observed["total"]}
        if (
                observed.get("passed") is not None
                and observed.get("failed") is not None):
            legitimate.add(
                observed["passed"] + observed["failed"])
        if reported_total not in legitimate:
            return (
                "TESTS_TOTAL(%s)与测试器真实末次汇总口径(%s)不一致；"
                "数字必须取自真实执行输出。"
                % (
                    reported_total,
                    "/".join(
                        str(value)
                        for value in sorted(legitimate)),
                )
            )
    if _filter_args(segment) and (
            _filter_args(segment) != _filter_args(configured)):
        return (
            "实际 UT 命令在任务卡配置之外追加了过滤/排除参数；"
            "未经用户确认不能缩小测试范围后报告 PASS。")
    if _HARD_RISK_PATTERN.search(
            _normalized_risk_text(summary, result)):
        return (
            "测试报告或执行输出显示段错误、绕过失败或其他硬失败；"
            "必须进入 KNOWN_FAILURES/SUSPECTED_BUGS，不能 PASS。")
    return ""


def _earlier_matching_runs(calls, run_call, summary):
    try:
        final_index = next(
            index for index, call in enumerate(calls)
            if call is run_call)
    except StopIteration:
        final_index = len(calls)
    earlier = []
    for index, call in enumerate(calls[:final_index]):
        if (
                call.name.lower() == "bash"
                and reported_bash_segment(call, summary)
                and call.result_seen):
            earlier.append((index, call))
    return earlier


def _nonrunning_count_risk(final_counts, baseline_counts):
    problems = [
        kind for kind in final_counts
        if (
            kind not in baseline_counts
            or final_counts[kind] > baseline_counts[kind])
    ]
    if not problems:
        return ""
    detail = "、".join(
        "%s:%s→%s" % (
            kind,
            baseline_counts.get(kind, "无基线"),
            final_counts.get(kind, 0),
        )
        for kind in sorted(problems)
    )
    return (
        "本轮新增 disabled/skipped/excluded，必须进入 "
        "KNOWN_FAILURES/SUSPECTED_BUGS，不能 PASS（%s）。"
        % detail)


def _test_total_risk(baseline_result, final_result):
    baseline = _observed_counts(baseline_result)
    final = _observed_counts(final_result)
    if (
            baseline.get("total") is not None
            and final.get("total") is not None
            and final["total"] < baseline["total"]):
        return (
            "终跑测试总数从存量基线 %s 降为 %s；"
            "不能通过删除/缩减既有测试取得 PASS。"
            % (baseline["total"], final["total"])
        )
    return ""


def _nonrunning_baseline_risk(report, run_call, calls):
    result = str(run_call.result or "")
    final_counts = {
        kind: count
        for kind, count in _nonrunning_counts(result).items()
        if count > 0
    }
    if not final_counts:
        return ""
    summary = report_field(report, "EXECUTED_UT") or ""
    earlier = _earlier_matching_runs(calls, run_call, summary)
    if not earlier:
        return (
            "终跑存在 disabled/skipped/excluded，"
            "但修改测试前没有同口径首跑基线；"
            "不能区分存量项与本单新增项，需按非 PASS 收尾。")
    baseline_index, baseline = earlier[0]
    if any(
            _mutates_before_baseline(call)
            for call in calls[:baseline_index]):
        return (
            "用于认领存量 disabled/skipped/excluded 的 UT 首跑发生在"
            "写测试、生成 Skill 或未知写盘命令之后，不能作为存量基线。")
    baseline_counts = _nonrunning_counts(str(baseline.result or ""))
    return (
        _nonrunning_count_risk(final_counts, baseline_counts)
        or _test_total_risk(str(baseline.result or ""), result)
    )


def unit_test_execution_risk(
        report, run_call, configured, calls=(), require_baseline=False):
    """Return the first execution risk using the historical ordering."""
    reason = _basic_execution_risk(report, run_call, configured)
    if reason:
        return reason
    return _nonrunning_baseline_risk(
        report, run_call, tuple(calls))
