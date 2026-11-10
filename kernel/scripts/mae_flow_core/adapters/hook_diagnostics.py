"""Privacy-safe diagnostics for intentional Hook policy blocks."""

import hashlib
import os
import re


# 拦截正文前面可能已经打过建议/advisory(lightcheck、ownership 提示都先写 stderr),
# 标记因此不一定在缓冲区开头。逐行匹配才能既剥离标记又保住 rule 归因。
_GATE_RULE_PATTERN = re.compile(
    r"^(\[mae-flow\] )?\[mae-flow-rule=([a-z0-9-]+)\]\r?\n?", re.I | re.M)


def recent_hook_anomalies(lines, since="", limit=3):
    """Return a bounded, privacy-safe view of Hook failures for this flow."""
    result = []
    for raw in lines or ():
        line = str(raw or "").strip()
        timestamp = line[:19] if re.match(
            r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", line) else ""
        if since and timestamp and timestamp < since:
            continue
        if not (
                re.search(r"(?:^|\s)EXC(?:\(|:|\s)", line)
                or "WATCHDOG" in line):
            continue
        result.append(line[:320])
    return result[-max(1, int(limit or 1)):]


class HookBlockDiagnostics:
    """Carry private CLI metadata into one attributed Hook log record."""

    def __init__(self):
        self.gate_rule = ""

    def subprocess_environment(self):
        self.gate_rule = ""
        environment = dict(os.environ)
        environment["MAE_FLOW_HOOK_TRACE"] = "1"
        return environment

    def sanitize_stderr(self, stderr):
        """Remove the internal gate marker before stderr reaches the host."""
        text = str(stderr or "")
        match = _GATE_RULE_PATTERN.search(text)
        if not match:
            return text
        self.gate_rule = match.group(2).lower()
        return text[:match.start()] + (match.group(1) or "") + text[
            match.end():]

    def log_pretool_decision(self, event, payload, response, log):
        """Attribute a block without persisting command or response text."""
        if event != "pretooluse" or response.exit_code != 2:
            return
        tool = str(payload.get("tool_name", "") or "unknown")
        fields = [
            "decision",
            "event=pretooluse",
            "tool=" + re.sub(r"[^A-Za-z0-9_.-]", "_", tool),
            "result=blocked",
            "source=mae-flow",
            "rule=" + re.sub(
                r"[^a-z0-9-]", "-", self.gate_rule or "hook-policy"),
        ]
        if tool == "Bash":
            command = str(
                (payload.get("tool_input") or {}).get("command", "") or "")
            fields.append(
                "command_sha256="
                + hashlib.sha256(command.encode("utf-8")).hexdigest())
        log(" ".join(fields))
