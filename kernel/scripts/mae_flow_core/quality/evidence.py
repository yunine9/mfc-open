"""CodeCheck Evidence policies with explicit tool and repository ports."""

import hashlib
from dataclasses import dataclass

from ..foundation.models import EvidenceResult
from ..workflow.evidence import legacy_result
from .. import host_env
from .external_verification import obligations_passed


@dataclass(frozen=True)
class QualityEvidencePorts:
    business_changed_files: object
    risk_acceptance: object
    source_changed_since: object
    agent_ran: object
    append_event: object
    git_head: object
    exists: object
    is_file: object
    argv_output: object
    run_codecheck: object
    scope_filter: object
    read_bytes: object
    read_text_replace: object
    now: object
    exemption_text_has_pair: object
    approved_exemptions: object
    was_exempt_before_review: object
    approval_key: object
    exemption_path: object = None


class QualityEvidenceRules:
    def __init__(self, ports):
        self.ports = ports

    def _unchanged(self, head, state):
        changed, error = self.ports.source_changed_since(head, state)
        return not error and not changed, changed, error

    def pipeline_obligations_passed(self, _spec, state):
        passed, reason = obligations_passed(state, self.ports.git_head())
        if passed:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            (reason or "权威流水线尚未全部通过")
            + "。本步由宿主自动处理，不要用 done、skip 或口头确认绕过。",
        )

    def _scan_cache_result(self, state, files):
        scan = (state.get("quality", {}) or {}).get(
            "codecheck_scan", {})
        eligible = (
            scan.get("step") == state.get("current")
            and scan.get("count") == 0
            and not scan.get("manual")
            and scan.get("files") == files
            and scan.get("head")
        )
        if not eligible:
            return None
        unchanged, _changed, _error = self._unchanged(
            scan.get("head"), state)
        if not unchanged:
            return None
        self.ports.append_event(state, "verify.cache_reused", {
            "kind": "clean-scan",
            "head": scan.get("head", ""),
            "files": files,
            "count": 0,
        })
        return EvidenceResult(True, "")

    def _verified_result(self, state, files):
        verified = (state.get("quality", {}) or {}).get(
            "codecheck_verify", {})
        eligible = (
            verified.get("step") == state.get("current")
            and verified.get("files") == files
            and verified.get("head")
        )
        if not eligible:
            return None
        unchanged, _changed, _error = self._unchanged(
            verified.get("head"), state)
        if not unchanged:
            return None
        total = int(verified.get("count", 0))
        pairs = verified.get("pairs", []) or []
        self.ports.append_event(state, "verify.cache_reused", {
            "kind": "verification",
            "head": verified.get("head", ""),
            "files": files,
            "count": total,
            "pairs": pairs,
        })
        return total, pairs

    def _manual_zero_result(self, state, files, error):
        manual = (state.get("quality", {}) or {}).get(
            "codecheck_manual", {})
        diagnostic = manual.get("diagnostic", "")
        try:
            same_diagnostic = (
                self.ports.is_file(diagnostic)
                and hashlib.sha256(
                    self.ports.read_bytes(diagnostic)).hexdigest()
                == manual.get("diagnostic_sha256")
            )
        except OSError:
            same_diagnostic = False
        valid = (
            manual.get("step") == state.get("current")
            and manual.get("files") == files
            and manual.get("head") == self.ports.git_head()
            and same_diagnostic
            and manual.get("count") == 0
        )
        if valid:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            error
            + "；若你已人工看过诊断文件并确认告警数，可使用 current 中给出的 "
            "codecheck-record 恢复命令，记录会绑定当前 HEAD 和文件清单，"
            "代码一变即失效",
        )

    def _execute_verification(self, state, files):
        result, error = self.ports.run_codecheck(
            files, state, "harness-verify")
        if error:
            return self._manual_zero_result(
                state, files, error), None
        result, _stock = self.ports.scope_filter(
            result, state, files)
        total, pairs = result["total"], result["pairs"]
        record = {
            "step": state.get("current"),
            "head": self.ports.git_head(),
            "files": files,
            "count": total,
            "pairs": pairs,
            "log_path": result.get("log_path", ""),
            "at": self.ports.now(),
        }
        state.setdefault("quality", {})["codecheck_verify"] = record
        self.ports.append_event(state, "verify.completed", {
            "head": record["head"],
            "files": files,
            "count": total,
            "pairs": pairs,
        })
        return None, (total, pairs)

    def _exemption_result(
            self, state, exemption, total, pairs):
        if not self.ports.exists(exemption):
            return EvidenceResult(
                False,
                "harness 现场复核实测遗留 %d 条告警,且无豁免清单(%s)。"
                "两条路:修掉重试;或经用户逐条裁决豁免(AskUserQuestion),"
                "把「规则ID + 文件 + 用户原话」逐行写入本地过程件 %s "
                "后重试——口头豁免无效，该文件不得提交"
                % (total, exemption, exemption),
            )
        text = self.ports.read_text_replace(exemption)
        uncovered = [
            "%s(%s)" % (rule, path)
            for rule, path, _line in pairs
            if not self.ports.exemption_text_has_pair(
                text, rule, path)
        ]
        if len(pairs) < total and not uncovered:
            uncovered = [
                "(另有 %d 条未解析出明细,无法核对豁免)"
                % (total - len(pairs))]
        if uncovered:
            return EvidenceResult(
                False,
                "实测遗留 %d 条告警,以下未被豁免清单覆盖: %s%s。"
                "修掉或补齐 %s(须用户裁决原话)后重试"
                % (
                    total,
                    "、".join(uncovered[:5]),
                    "…" if len(uncovered) > 5 else "",
                    exemption,
                ),
            )
        approved = self.ports.approved_exemptions(state)
        unauthorized = [
            "%s(%s)" % (rule, path)
            for rule, path, _line in pairs
            if (
                self.ports.approval_key(rule, path) not in approved
                and not self.ports.was_exempt_before_review(
                    state, exemption, rule, path)
            )
        ]
        if unauthorized:
            return EvidenceResult(
                False,
                "豁免文件覆盖了告警,但以下本轮豁免没有用户审批令牌: "
                + "、".join(unauthorized[:5])
                + "。逐项 AskUserQuestion 后执行 current 输出的 "
                "approve-exemption 命令（规则ID、文件、理由和消息ID必须完整）；"
                "手写豁免文件不再算授权",
            )
        return EvidenceResult(True, "")

    def _review_scan_result(self, state, scan):
        if scan.get("scope_pending"):
            return EvidenceResult(
                False,
                "CodeCheck 仍有 %d 条机器准备排除的候选，"
                "尚未经用户确认是否涉及本次修改。按 codecheck-scan 输出使用 "
                "AskUserQuestion 展示候选，再执行 codecheck-scope；"
                "确认前不能忽略这些结果。"
                % len(scan.get("scope_candidates") or []),
            )
        if scan.get("status") == "TOOL_ERROR":
            changed, error = self.ports.source_changed_since(
                scan.get("head", ""), state)
            if error:
                return EvidenceResult(
                    False,
                    "CodeCheck 诊断基点失效:" + error
                    + "；重新执行 codecheck-scan",
                )
            if changed:
                return EvidenceResult(
                    False,
                    "CodeCheck 工具诊断后源码发生变化: "
                    + "、".join(changed[:5])
                    + "。对新代码重新尝试一次 codecheck-scan",
                )
            return EvidenceResult(True, "")
        if scan.get("status") == "MAX_ROUNDS":
            changed, error = self.ports.source_changed_since(
                scan.get("head", ""), state)
            if error:
                return EvidenceResult(
                    False, "CodeCheck 两轮上限记录失效:" + error
                    + "；重新执行 codecheck-scan 重建记录")
            if changed:
                return EvidenceResult(
                    False,
                    "CodeCheck 达到两轮上限后源码仍发生变化: "
                    + "、".join(changed[:5])
                    + "。必须先完成该变化的编译和统一检视提交。",
                )
            return EvidenceResult(True, "")
        if scan.get("count", 0) == 0:
            changed, error = self.ports.source_changed_since(
                scan.get("head", ""), state)
            if error:
                return EvidenceResult(
                    False,
                    "CodeCheck 首检基点失效:" + error
                    + "；重新执行 codecheck-scan",
                )
            if changed:
                return EvidenceResult(
                    False,
                    # 只说"不许"会让人原地打转:实战里模型在这儿改了又扫、
                    # 扫不动又改,来回几轮才自己想通该回退。把两条出路一起给。
                    "CodeCheck 首检为 0 后源码又发生变化: "
                    + "、".join(changed[:5])
                    + "。旧首检不背新代码的书:要么回退这些改动,"
                    + "要么重新执行 codecheck-scan。"
                    + "本步只改 CodeCheck 告警指出的问题;"
                    + "顺手的精简记进交付说明,不在本步做",
                )
            return EvidenceResult(True, "")
        return None

    def _review_agent_result(self, state):
        result = legacy_result(self.ports.agent_ran({
            "agent": "CODECHECK",
            "statuses": ["CLEAN", "REMAINING", "FAIL"],
        }, state))
        # 曾经这里还会按 CODECHECK Hook 令牌的 status=="FAIL" 追查遗留源码变化。
        # 令牌早已没有写入方(不再解析 Agent 自报状态),该分支恒不可达;真实的
        # 源码新鲜度由 review_codecheck 的机器复核负责。
        return result if not result.passed else EvidenceResult(True, "")
