"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    CODECHECK_LINE_SLACK, HERE, STATE_PATH, append_codecheck_event, codecheck_log_path,
    hashlib, load_json, os, quality_codecheck_state, re, read_bytes, sys, time,
    write_text,
)
from .wiring import api
from mae_flow_core import host_env
from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.quality.attempts import begin_attempt


def cmd_template(flow, args):
    """打印项目本地物化模板的绝对路径(story|chain|grill|review)。"""
    name = {"story": "STORY-TEMPLATE.md", "chain": "CHAIN-TEMPLATE.md",
            "grill": "GRILL-PREP-TEMPLATE.md", "review": "REVIEW-TEMPLATE.md"}[args.kind]
    p = os.path.abspath(os.path.join(
        ".mae-flow-work", "plugin-resources", "assets", name))
    if not os.path.exists(p):
        api.die(name + " 项目本地模板缺失；请重新执行 current 恢复资源: " + p)
    print(p)
