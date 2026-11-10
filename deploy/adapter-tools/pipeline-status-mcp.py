#!/usr/bin/env python3
"""流水线状态 MCP 主路(adapter pipeline_status 降级链的第一候选)。

toolkit 仲裁(2026-08-28 源码实证):稳定系统查流水线走 MCP 网关的
get_merge_request_actual_head_pipeline(带 is_valid 语义)+
get_pipeline_quality,CLI 降级,REST 不碰。本脚本照搬那条主路,输出
宿主契约(adapter contract:true 直通):
  {"runs":[{status, sha, is_valid, pipeline_id, web_url,
            checks:[{dimension,status,job,stage,tool,url,details}]}]}

失败即退非零并把原因给 stderr——adapter 降级链会接住(次候选=内网
现用 v4 脚本,末候选=裸 REST)。宁可这一路诚实死,不猜。

工具入参已由 2026-08-28 内网 tools/list + 真红灯现场对拍：
get_project_info 使用顶层 git_url；actual_head_pipeline 与
get_pipeline_quality 的业务参数都嵌在 request。

用法: pipeline-status-mcp.py --repo <url> --sha <sha> --mr <iid>
      [--mcp-token-file <path>]
      --token 仅为兼容现有 adapter 命令模板保留，绝不用于 MCP。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mcp_http_client import (  # noqa: E402
    McpHttpClient,
    McpHttpError,
    default_mcp_token_file,
    load_secret,
)
from mcp_tool_contracts import (  # noqa: E402
    actual_head_pipeline_arguments,
    codehub_host_from_url,
    pipeline_quality_arguments,
    project_info_arguments,
    unwrap_data,
)
import os  # noqa: E402

RUN_STATUS = {
    "success": "success", "passed": "success",
    "failed": "failed", "error": "failed", "canceled": "failed",
    "cancelled": "failed", "skipped": "failed",
    "running": "running", "pending": "running", "created": "running",
    "preparing": "running", "manual": "running", "scheduled": "running",
    "waiting_for_resource": "running",
}
CHECK_STATUS = {
    "success": "success", "passed": "success",
    "failed": "failed", "error": "failed",
    "running": "running", "pending": "pending", "created": "pending",
    "canceled": "canceled", "cancelled": "canceled",
    "skipped": "skipped", "manual": "not_run", "not_run": "not_run",
}
from pipeline_checks import (
    merge_check, quality_check, report_only, report_note,
    checks_from_stages as execution_checks,
)


def log_err(message: str) -> None:
    print(f"[pipeline-status-mcp] {message}", file=sys.stderr)


def map_word(raw, table, what):
    word = str(raw or "").strip().lower()
    if word not in table:
        raise McpHttpError(
            f"{what} 状态词 \"{word}\" 不认识,拒绝猜——把映射补进脚本再跑")
    return table[word]


def resolve_project_id(
    client: McpHttpClient,
    repo_url: str,
    codehub_host: str,
) -> str:
    """toolkit: getProjectId = MCP get_project_info → CLI fallback。
    tools/list 已确认真实参数为顶层 git_url；失败就交给 adapter 下一候选。"""
    info = client.call_tool(
        "get_project_info", project_info_arguments(repo_url, codehub_host))
    info = unwrap_data(info)
    if isinstance(info, dict):
        for key in ("project_id", "id"):
            if info.get(key) is not None:
                return str(info[key])
    raise McpHttpError("get_project_info 响应里没有 project_id/id")


def checks_from_stages(stages) -> dict:
    return execution_checks(stages, CHECK_STATUS)


def enrich_from_quality(
    client,
    project_id,
    pipeline_id,
    picked,
    codehub_host,
    notes=None,
) -> None:
    """get_pipeline_quality → 逐工具状态与指标明细(增益路,失败不拦)。"""
    try:
        quality = client.call_tool(
            "get_pipeline_quality",
            pipeline_quality_arguments(
                project_id, pipeline_id, codehub_host=codehub_host),
        )
    except McpHttpError as error:
        log_err(f"质量增益路失败(忽略): {error}")
        return
    quality = unwrap_data(quality)
    rows = (quality or {}).get("codequality_check") \
        if isinstance(quality, dict) else None
    if not isinstance(rows, list):
        rows = (quality or {}).get("checks") \
            if isinstance(quality, dict) else None
    if isinstance(rows, dict):
        rows = rows.get("checks") or rows.get("items") or list(rows.values())
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        candidate = quality_check(row, CHECK_STATUS)
        if candidate:
            merge_check(picked, candidate)
        elif notes is not None and (report_only(row)
                or (row.get('tool') or row.get('tool_name')) == 'CPP_UT'):
            notes.append(report_note(row))



def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--mr", default="")
    parser.add_argument(
        "--token", default="",
        help="兼容参数：CodeHub token 不得用于 MCP")
    parser.add_argument(
        "--mcp-token-file", default=default_mcp_token_file(),
        help="MCP 网关 X-Auth-Token 文件")
    parser.add_argument("--w3token-file",
                        default=os.environ.get("MFC_W3TOKEN_FILE", ""))
    args = parser.parse_args()
    if not args.mr:
        # 主路按 MR 定位(actual_head_pipeline 的语义就是"MR 头上的
        # 流水线");没有 MR 号时这一路诚实退场,降级链走 sha 直查候选。
        log_err("缺 --mr:MCP 主路按 MR 定位,交给降级链的 sha 直查候选")
        return 2
    mcp_token = load_secret(args.mcp_token_file)
    if not mcp_token:
        raise McpHttpError(
            f"MCP token 文件为空: {args.mcp_token_file}")
    client = McpHttpClient(token=mcp_token,
                           w3token=load_secret(args.w3token_file))
    client.initialize()
    codehub_host = codehub_host_from_url(args.repo)
    project_id = resolve_project_id(client, args.repo, codehub_host)
    response = client.call_tool(
        "get_merge_request_actual_head_pipeline",
        actual_head_pipeline_arguments(
            project_id, args.mr, show_job=True,
            codehub_host=codehub_host))
    pipeline = unwrap_data(response)
    if (not isinstance(pipeline, dict) or not pipeline
            or pipeline.get("is_valid") is False
            and not pipeline.get("id")):
        # 平台明说没有流水线:空 runs,宿主继续等,不算这一路失败。
        print(json.dumps({"runs": []}, ensure_ascii=False))
        return 0
    picked = checks_from_stages(pipeline.get("stages"))
    pipeline_id = str(pipeline.get("id") or "")
    notes = []
    if pipeline_id:
        enrich_from_quality(
            client, project_id, pipeline_id, picked, codehub_host, notes)
    run = {
        "status": map_word(pipeline.get("status"), RUN_STATUS, "pipeline"),
        **({"log": "\n".join(notes)} if notes else {}),
        # is_valid 是这条主路的灵魂:false=MR 头上无有效流水线、挂的是
        # 陈灯——原样回显,宿主 selectTerminalRun 机械拒收。
        **({"is_valid": bool(pipeline.get("is_valid"))}
           if "is_valid" in pipeline else {}),
        **({"sha": str(pipeline.get("sha"))} if pipeline.get("sha") else {}),
        **({"pipeline_id": pipeline_id} if pipeline_id else {}),
        **({"web_url": str(pipeline.get("web_url"))}
           if pipeline.get("web_url") else {}),
        **({"checks": list(picked.values())} if picked else {}),
    }
    print(json.dumps({"runs": [run]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except McpHttpError as error:
        log_err(str(error))
        sys.exit(2)
