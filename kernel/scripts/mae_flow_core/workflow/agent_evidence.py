"""Agent lifecycle and review-snapshot Evidence rules."""

import os
import re
from dataclasses import dataclass

from ..foundation.models import EvidenceResult
from .. import host_env

# 子 Agent 明确自报"任务卡输入缺失、拒绝执行"的标记。只做单向识别:
# 出现 → 不算完成;不出现 → 照常。不要求任何格式令牌才算成功,
# 与"返回自然语言不验签"铁律不冲突。
_REFUSAL_RE = re.compile(r"\bNEEDS_INPUT\b")


@dataclass(frozen=True)
class AgentEvidencePorts:
    moonlight: object
    step_entered: object
    risk_acceptance: object
    script_path: object
    risk_labels: object
    finished_observation: object
    quality_execution: object
    askuser_tokens: object
    changed_source_files: object
    shell_output: object
    argv_output: object
    blocking_dirty_source_paths: object
    open_observation: object = None
    finished_observations: object = None
    step_scoped_source_files: object = None


class AgentEvidenceRules:
    def __init__(self, ports):
        self.ports = ports

    def _risk_option(self, kind, expired=""):
        risk = self.ports.risk_labels.get(
            kind, "%s 专项 Agent 没有可验证的质量证据" % kind)
        prefix = (
            "已有风险确认已失效(" + expired + ")。"
            if expired else "")
        return (
            prefix
            + "如果无法补齐证据但希望承担风险继续，可把以下风险原样展示给用户并让用户明确选择："
            + risk
            + "。用户确认承担风险后执行: python3 \""
            + os.path.abspath(self.ports.script_path())
            + "\" accept-risk "
            + kind.lower()
            + " --reason \""
            + risk
            + "\" --message-id <messages输出的ID>；"
            "它只放行当前步骤的该 Agent 生命周期证据，其他机器检查仍照常执行。"
        )

    def _blocked(self, kind, expired, message):
        return EvidenceResult(
            False, message + " " + self._risk_option(kind, expired))

    def agent_ran(self, spec, state):
        kind = spec["agent"]
        if kind == "ASKUSER" and self.ports.moonlight(state):
            return EvidenceResult(True, "")
        # 外部编译是一项待流水线兑现的义务，不是一张假 COMPILE Agent
        # 任务卡。done 会先把义务持久化；这里仅说明本步不要求本地子会话。
        # 其他工作 Agent（尤其 UT 编写、Reviewer、Story、Grill）仍必须有
        # 真实生命周期台账，不能被“宿主在云端”一刀切放行。
        if kind == "COMPILE" and not host_env.build_runs_locally(state):
            return EvidenceResult(
                True, "本单编译由权威流水线执行；已登记外部 COMPILE 义务")
        entered = self.ports.step_entered(state)
        accepted, accepted_why = self.ports.risk_acceptance(
            kind, state)
        if accepted:
            return EvidenceResult(True, "")
        if kind == "ASKUSER":
            token = self.ports.askuser_tokens().get(kind, "")
            timestamp = (
                token.get("at", "") if isinstance(token, dict) else token)
            if timestamp and timestamp >= entered:
                return EvidenceResult(True, "")
            return self._blocked(
                kind,
                accepted_why,
                "本步内未发生过真实的 AskUserQuestion 用户交互"
                "(最近令牌: %s;本步始于 %s)。待确认项必须用 "
                "AskUserQuestion 真实呈现给用户拍板——"
                "自行改写标注/口头声称已确认均无效。"
                % (timestamp or "无", entered),
            )
        verdict = self._returned_verdict(kind, spec, state, entered,
                                         accepted_why)
        if verdict is not None:
            return verdict
        open_observation = (
            self.ports.open_observation(
                kind, state.get("current", ""), entered)
            if self.ports.open_observation is not None
            else None
        )
        if open_observation:
            return self._blocked(
                kind,
                accepted_why,
                "%s 子 Agent 已启动（调用 %s），但宿主没有记录对应返回事件。"
                "禁止自动重派同一任务；先执行 doctor 检查 Hook/观察记录，"
                "等待中的 Agent 先等待其完成。若界面已明确显示正常返回但宿主"
                "仍未补记，只能按后附风险确认通道处理。"
                % (
                    kind,
                    str(open_observation.get("invocation_id", "未知")),
                ),
            )
        return self._blocked(
            kind,
            accepted_why,
            "本步内未检测到 %s 子 Agent 已返回（本步始于 %s）。"
            "请启动对应专项 Agent；返回内容可以使用任意自然语言格式。"
            % (kind, entered),
        )

    def _returned_verdict(self, kind, spec, state, entered, accepted_why):
        """已返回场景的裁决;None = 没有任何返回,交回启动/缺席分支处理。"""
        observations, refused = self._effective_observations(
            kind, state, entered)
        observation = observations[-1] if observations else None
        required = self._required_returns(spec, state, entered)
        if observation and len(observations) >= required:
            requires_local_execution = (
                kind in ("COMPILE", "CODECHECK", "UT")
                and not (
                    kind == "COMPILE"
                    and not host_env.build_runs_locally(state)
                )
                and not (
                    kind == "UT"
                    and not host_env.unit_tests_run_locally(state)
                )
                and not (
                    kind == "CODECHECK"
                    and not host_env.codecheck_runs_locally(state)
                )
            )
            if (requires_local_execution
                    and not observation.get("legacy")
                    and not self.ports.quality_execution(
                        kind, state.get("current", ""), state)):
                return self._blocked(
                    kind, accepted_why,
                    "%s 子 Agent 已返回，但没有检测到与当前输入匹配的成功执行。"
                    "两种可能:①命令确实没跑成——检查任务卡中的真实命令、"
                    "退出状态和 timeout,返回文字不能替代机器执行;"
                    "②宿主未提供可读的子会话记录(执行台账该次 command 为空"
                    "即是此症)——这不是报告格式问题,改写报告没有用,"
                    "重派一次仍如此就走 accept-risk 交用户裁决。" % kind,
                )
            return EvidenceResult(True, "")
        if observation:
            return self._blocked(
                kind, accepted_why,
                "%s 本步发出了 %d 张任务卡，但只收到 %d 份有效返回——"
                "派发过不等于检视过。请为未返回的维度重新派发对应任务卡。"
                % (kind, required, len(observations)),
            )
        if refused:
            return self._blocked(
                kind, accepted_why,
                "%s 子 Agent 返回 NEEDS_INPUT：任务卡自身输入缺失，检视并未发生，"
                "不能当作已完成。重新执行本步的 role-task/agent-task 生成新卡再派发；"
                "不要拿旧卡原样重试，也不要替它补结论。" % kind,
            )
        return None

    def _effective_observations(self, kind, state, entered):
        """→ (有效返回列表, 是否存在 NEEDS_INPUT 拒绝)。

        实战事故:standards 检视卡自带矛盾占位,子 Agent 正当拒绝并返回
        NEEDS_INPUT,旧逻辑照样算"跑过"——把拒绝执行当已检视,是机器自己
        制造的误绿。拒绝的返回不计入有效返回。
        """
        if self.ports.finished_observations is not None:
            rows = list(self.ports.finished_observations(
                kind, state.get("current", ""), entered))
        else:
            single = self.ports.finished_observation(
                kind, state.get("current", ""), entered)
            rows = [single] if single else []
        effective = [row for row in rows
                     if not _REFUSAL_RE.search(str(row.get("detail", "")))]
        return effective, len(effective) < len(rows)

    def _required_returns(self, spec, state, entered):
        """本步要求的有效返回数。

        stage_role 指向 role_tasks 的键前缀(如 code-review):本步实际
        发出的每张维度卡都必须有对应返回——两轴检视只回来一轴,
        另一轴等于没检视过。
        """
        prefix = spec.get("stage_role", "")
        if not prefix:
            return 1
        issued = sum(
            1 for name, task in (state.get("role_tasks") or {}).items()
            if name.startswith(prefix)
            and isinstance(task, dict)
            and task.get("step") == state.get("current", "")
            and str(task.get("at", "")) >= entered
        )
        return max(issued, 1)
