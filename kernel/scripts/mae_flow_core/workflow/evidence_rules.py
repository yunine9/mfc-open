"""Generic workflow Evidence rules with explicit I/O ports."""

import os
import re
from dataclasses import dataclass

from ..foundation.models import EvidenceResult
from .markdown_scope import without_sections
from ..quality.implementation_tasks import implementation_task_progress


SPEC_REGISTER_FIELDS = ("design_doc", "plan", "verification_report")
TIER_FILE_LIMITS = {"tweak": 5, "hotfix": 3}


def substitute(pattern, state):
    """Replace configured ``{key}`` placeholders using legacy semantics."""
    for key, value in state.get("config", {}).items():
        pattern = pattern.replace("{" + key + "}", value)
    return pattern


@dataclass(frozen=True)
class WorkflowEvidencePorts:
    cwd: object
    glob_paths: object
    is_file: object
    read_text: object
    read_text_replace: object
    shell_output: object
    argv_output: object
    tasks_source: object
    spec_has_delta: object
    spec_validate: object
    spec_required_sections: object
    spec_error: type
    spec_data: object
    risk_acceptance: object
    business_changed_files: object
    domain_archive_fresh: object = None
    local_spec_valid: object = None
    verification_passed: object = None


class WorkflowEvidenceRules:
    """Evidence decisions whose external facts arrive through ports."""

    def __init__(self, ports):
        self.ports = ports

    def local_spec_valid(self, _spec, state):
        if self.ports is None or self.ports.local_spec_valid is None:
            return EvidenceResult(False, "本地 Spec 校验器未配置")
        passed, reason = self.ports.local_spec_valid(state)
        return EvidenceResult(bool(passed), str(reason or ""))

    def verification_passed(self, _spec, state):
        if self.ports is None or self.ports.verification_passed is None:
            return EvidenceResult(False, "本地验证报告校验器未配置")
        passed, reason = self.ports.verification_passed(state)
        return EvidenceResult(bool(passed), str(reason or ""))

    @staticmethod
    def _domain_archive_record_error(record):
        result = record.get("result")
        paths = record.get("applied_paths") or []
        if result not in {"changes", "unchanged"}:
            return "领域归档结果无效；执行 domain-archive status"
        if result == "unchanged" and paths:
            return "unchanged 归档不应包含上库文件"
        invalid = [
            str(path) for path in paths
            if not (
                str(path).replace("\\", "/") == "docs/specs/index.md"
                or (
                    str(path).replace("\\", "/").startswith("docs/specs/")
                    and str(path).replace("\\", "/").endswith(".md")
                )
            )
        ]
        return (
            "领域归档包含非法过程文件: " + "、".join(invalid)
            if invalid else "")

    def domain_archive_complete(self, _spec, state):
        record = (state or {}).get("domain_archive") or {}
        if record.get("status") != "applied":
            return EvidenceResult(
                False,
                "领域归档尚未完成；执行 domain-archive status 查看当前状态和唯一恢复动作",
            )
        error = self._domain_archive_record_error(record)
        if error:
            return EvidenceResult(False, error)
        if self.ports is not None and self.ports.domain_archive_fresh is not None:
            fresh, reason = self.ports.domain_archive_fresh(state)
            if not fresh:
                return EvidenceResult(
                    False,
                    reason or (
                        "领域归档输入已变化；只需重新执行 domain-archive prepare，"
                        "不会回退已完成的质量步骤"),
                )
        return EvidenceResult(True, "")

    def glob(self, spec, state):
        patterns = [
            substitute(pattern, state)
            for pattern in spec.get("any", [])
        ]
        if any("{" in pattern and "}" in pattern
               for pattern in patterns):
            return EvidenceResult(
                False,
                "证据 pattern 含未解析占位符(对应配置未 --set): "
                + " | ".join(patterns),
            )
        for pattern in patterns:
            if self.ports.glob_paths(pattern):
                return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            "未找到证据文件(任一即可): " + " | ".join(patterns),
        )

    def _branch_mismatch(
            self, state, current, wanted, base, head, base_head):
        resolution = state.get("branch_resolution") or {}
        if resolution.get("mode") == "adopt-current":
            if (
                resolution.get("branch") == current
                and resolution.get("head") == head
                and resolution.get("base") == base
                and resolution.get("base_head") == base_head
            ):
                return EvidenceResult(True, "")
            return EvidenceResult(
                False,
                "用户沿用现有分支的裁决已过期：裁决绑定 %s@%s、"
                "基线 %s，当前为 %s@%s、基线 HEAD %s。"
                "请展示变化后重新裁决，旧回答不能复用。"
                % (
                    resolution.get("branch", "?"),
                    str(resolution.get("head", ""))[:10],
                    str(resolution.get("base_head", ""))[:10],
                    current or "未知",
                    head[:10] if head else "未知",
                    base_head[:10],
                ),
            )
        return EvidenceResult(
            False,
            "工作分支 %s 的起点 %s != 基线 %s 当前 HEAD %s。"
            "branch_create 尚未开始实现，不能静默带入其他分支的提交。"
            "已有工作时先展示分支与提交差异，让用户选择迁移到约定分支"
            "或沿用当前非基线分支；选择沿用后按本步骤 current 输出的 "
            "goto 命令登记裁决。"
            % (
                wanted,
                head[:10] if head else "未知",
                base,
                base_head[:10],
            ),
        )

    def branch_ok(self, _spec, state):
        wanted = state["config"].get("分支名", "")
        base = state["config"].get("基线分支", "")
        current = self.ports.shell_output(
            "git branch --show-current")
        if not wanted:
            return EvidenceResult(
                False,
                "配置中无分支名(config_confirm 未 --set 分支名?)",
            )
        if current != wanted:
            return EvidenceResult(
                False,
                "当前分支 %s != 约定分支 %s。请 git checkout -b %s"
                "(已存在则 checkout;错误命名分支用 git branch -m 重命名)"
                % (current or "未知", wanted, wanted),
            )
        if not base:
            return EvidenceResult(
                False,
                "配置中无基线分支，无法证明工作分支从正确位置切出",
            )
        base_head = self.ports.argv_output(
            ["git", "rev-parse", "--verify", base + "^{commit}"])
        head = self.ports.argv_output(
            ["git", "rev-parse", "--verify", "HEAD"])
        if not base_head:
            return EvidenceResult(
                False,
                "基线分支 %s 不可解析；先 fetch/checkout 确认基线存在"
                % base,
            )
        if not head or head != base_head:
            return self._branch_mismatch(
                state, current, wanted, base, head, base_head)
        return EvidenceResult(True, "")

    def tasks_checked(self, _spec, state):
        change = state["config"].get("CHANGE_NAME", "")
        if not change:
            return EvidenceResult(
                False,
                "未找到本 change 的实现清单: CHANGE_NAME 未设置",
            )
        try:
            label, text = self.ports.tasks_source(
                self.ports.cwd(), change)
        except Exception as exc:
            return EvidenceResult(
                False,
                "实现清单无法读取(%s): %s"
                % (type(exc).__name__, exc),
            )
        if text is None:
            return EvidenceResult(
                False, "未找到本 change 的实现清单: " + label)
        progress = implementation_task_progress(text)
        count = len(progress["incomplete"])
        return EvidenceResult(
            count == 0,
            "" if count == 0
            else "%s 还有 %s 个未勾选任务" % (label, count),
        )

    def spec_field(self, spec, state):
        field = spec["field"]
        data = self.ports.spec_data(state)
        value = str(data.get(field, "") or "")
        expected = spec.get("equals", spec.get("value"))
        if expected is not None:
            if value == expected:
                return EvidenceResult(True, "")
            return EvidenceResult(
                False,
                "交付登记 %s=%s,需要 %s"
                "——按本步 current 指引完成动作并登记,谎报无效"
                % (field, value or "(空)", expected),
            )
        if value in ("", "null", "~"):
            return EvidenceResult(
                False,
                "交付登记 %s 为空——本步产物尚未登记;"
                "完成后执行 current 输出的 spec set 命令登记字段 %s"
                % (field, field),
            )
        if (field in SPEC_REGISTER_FIELDS
                and not self.ports.is_file(value)):
            return EvidenceResult(
                False,
                "交付登记 %s 指向 %s,但该文件现在不存在(被删或改名);"
                "重新生成产物并重新登记" % (field, value),
            )
        return EvidenceResult(True, "")

    def tier_scope(self, _spec, state):
        workflow = (
            (state.get("choices", {}) or {}).get("workflow", ""))
        limit = TIER_FILE_LIMITS.get(workflow)
        if not limit:
            return EvidenceResult(True, "")
        accepted, why = self.ports.risk_acceptance(
            "TIER_SCOPE", state)
        if accepted:
            return EvidenceResult(True, "")
        invalidated = (
            "已有 tier_scope 放行已失效(%s)。" % why
            if why else "")
        files, error = self.ports.business_changed_files(state)
        if error:
            return EvidenceResult(False, error)
        if len(files) <= limit:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            invalidated
            + "本单已改 %d 个业务文件,超过 %s 档升级阈值(%d):%s%s。"
            "这是步骤文档里的升级条件,现在由机器亲数。两条出路呈用户裁决:"
            "①升级工作流(展示原因,确认后按步骤指引正规升级/goto design "
            "--force);②确属轻量修改(如批量重命名)则 accept-risk "
            "tier_scope --reason <风险> --message-id <messages输出的ID> "
            "继续,代码再变化即失效"
            % (
                len(files),
                workflow,
                limit,
                "、".join(files[:6]),
                "…" if len(files) > 6 else "",
            ),
        )

    def _spec_structure_result(self, spec, root, change):
        if (spec.get("allow_empty")
                and not self.ports.spec_has_delta(root, change)):
            return None
        passed, messages = self.ports.spec_validate(root, change)
        if passed:
            return None
        errors = [
            message for message in messages
            if message.startswith("[错误]")
        ]
        shown = "; ".join(errors[:3])
        if len(errors) > 3:
            shown += "…"
        return EvidenceResult(
            False,
            "规格结构校验未通过: " + shown
            + "。跑 spec validate 看全部并逐条修正",
        )

    def _spec_placeholder_result(self, spec, change):
        document = None
        for base in (os.path.join(".mae-flow-work", "spec"), "openspec"):
            candidate = os.path.join(base, "changes", change, "change.md")
            if self.ports.is_file(candidate):
                document = candidate
                break
        if document is None:
            return None
        text = self.ports.read_text(document)
        hits = [
            placeholder
            for placeholder in (
                spec.get("placeholders") or ["（待填"])
            if placeholder in text
        ]
        if not hits:
            return None
        return EvidenceResult(
            False,
            "change.md 残留「%s…」骨架占位;"
            "把占位替换成实际内容后重试"
            % "、".join(hits),
        )

    def _spec_sections_result(self, state, root, change):
        workflow = (
            (state.get("choices", {}) or {}).get(
                "workflow", ""))
        missing = self.ports.spec_required_sections(
            root, change, workflow)
        if not missing:
            return None
        return EvidenceResult(
            False,
            "change.md 缺少 %s 档必须小节: %s;分档合同见 "
            "spec instructions change"
            % (workflow, "、".join(missing)),
        )

    def spec_validate(self, spec, state):
        change = state["config"].get("CHANGE_NAME", "")
        if not change:
            return EvidenceResult(
                False, "CHANGE_NAME 未设置,无法校验规格")
        root = self.ports.cwd()
        try:
            for evaluator in (
                lambda: self._spec_structure_result(
                    spec, root, change),
                lambda: self._spec_placeholder_result(
                    spec, change),
                lambda: self._spec_sections_result(
                    state, root, change),
            ):
                result = evaluator()
                if result is not None:
                    return result
        except self.ports.spec_error as exc:
            return EvidenceResult(
                False, "规格校验无法执行: " + str(exc))
        except Exception as exc:
            return EvidenceResult(
                False,
                "规格校验异常(%s: %s);按报错修复对应文件(编码须 UTF-8)"
                "后重试" % (type(exc).__name__, exc),
            )
        return EvidenceResult(True, "")

    def content_free(self, spec, state):
        path = substitute(spec["file"], state)
        if "{" in path and "}" in path:
            return EvidenceResult(
                False, "证据 pattern 含未解析占位符: " + path)
        files = self.ports.glob_paths(path)
        if not files:
            return EvidenceResult(False, "未找到文件: " + path)
        text = without_sections(self.ports.read_text_replace(files[0]),
                                spec.get("exclude_markdown_sections", []))
        hits = [
            pattern for pattern in spec["patterns"]
            if re.search(pattern, text)
        ]
        if not hits:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            spec.get("note", "内容含禁止残留")
            + "(命中 pattern: " + " | ".join(hits) + ")",
        )

    def glob_absent(self, spec, state):
        patterns = [
            substitute(pattern, state)
            for pattern in spec.get("any", [])
        ]
        if any("{" in pattern and "}" in pattern
               for pattern in patterns):
            return EvidenceResult(
                False,
                "证据 pattern 含未解析占位符: "
                + " | ".join(patterns),
            )
        hits = [
            pattern for pattern in patterns
            if self.ports.glob_paths(pattern)
        ]
        if not hits:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            spec.get(
                "note",
                "以下路径必须已不存在(残留=动作未完成,如复制式假归档)",
            )
            + ": " + "、".join(hits),
        )

    def clean_paths(self, spec, state):
        dirty = []
        for path in spec["paths"]:
            path = substitute(path, state)
            if "{" in path and "}" in path:
                return EvidenceResult(
                    False,
                    "证据 pattern 含未解析占位符: " + path,
                )
            output = self.ports.argv_output([
                "git", "status", "--porcelain", "--", path])
            if output:
                dirty.append(
                    "%s(%s)"
                    % (path, output.splitlines()[0][:2].strip()))
        if not dirty:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            "以下产物未提交(或有未提交改动),先 git add/commit 再 done: "
            + "、".join(dirty),
        )
