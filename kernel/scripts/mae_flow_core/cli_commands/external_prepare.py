"""Prepare host-owned actions and external quality obligations before done.

2026-08-25 编排瘦身:义务登记不再按步骤证据推断——编码段只剩宽 build 步,
出口验收就是执行契约里声明走流水线的全部维度。裁决端(obligations_passed)
本来就以 required_dimensions(执行契约)为准,这里的登记只负责把"欠什么、
从哪一步欠的"写进状态供工作台与面板展示,绝不制造 PASS。
"""

from mae_flow_core import host_env
from mae_flow_core.quality.external_verification import (
    register_pending,
    required_dimensions,
)

from .shared import time
from .wiring import api


_REASONS = {
    "COMPILE": "本机无构建链；等待权威流水线编译",
    "UT": "UT 已随实现完成编写；运行与统计等待权威流水线",
    "CODECHECK": "本机不运行 CodeCheck；等待权威流水线静态检查",
}


def _prepare_host_push(state, step_id, head, now):
    if step_id != "push" or host_env.git_push_runs_locally(state):
        return
    branch = api.sh("git branch --show-current")
    state.setdefault("host_actions", {})["git_push"] = {
        "status": "pending",
        "head": head,
        "branch": branch,
        "at": now,
    }


def _done_prepare_external_verification(step, state, step_id):
    """Register pending facts only; never manufacture PASS."""
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    head = api.sh("git rev-parse --verify HEAD")
    _prepare_host_push(state, step_id, head, now)
    if step_id != "build":
        return
    for dimension in required_dimensions(state):
        register_pending(
            state, dimension, step=step_id, head=head, at=now,
            reason=_REASONS.get(dimension, "等待权威流水线执行"))
