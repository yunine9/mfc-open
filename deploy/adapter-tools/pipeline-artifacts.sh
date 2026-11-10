#!/bin/bash
# pipeline-artifacts.sh: 拉流水线失败材料 → JSON 数组 [{name, text}]
#
# 2026-08-28 重构:实现整体搬进 pipeline_log.py——toolkit「PipelineLog
# 编排器」的忠实移植(8 个 Strategy、依赖顺序、三条降级链、落盘文件名
# 全部照抄;详见该文件头注释)。本脚本退化为薄壳:调编排器采集落盘,
# 再按总包预算装箱输出。构建日志能装下时保留全文；对宿主的
# adapter 契约不变。
#
# 产物清单(toolkit 同名):
#   pipeline_log_summary.json   每个策略 ok/failed + 原因(先看这个)
#   pipeline_info.json / pipeline_detail.json / pipeline_quality.json
#   mergeable_state.json / build_log_{rid}.txt / build_errors_{rid}.json
#   build_error_excerpt_{rid}.txt(长日志中可定位错误的上下文)
#   build_stages_{rid}.json / codecheck_detail.json
#   coverage_diff_{jobId}.json + coverage_summary.json
#   ai_review_tips.json(行云 AI Review,唯一纯 REST 通路)
#   pipeline_artifacts_omitted.json(总包预算触发时的省略清单)
#
# adapter.json 用法(第 4 参 mr_url 可选,给了就走 MR-first 主路):
#   "pipeline_artifacts": {
#     "command": ["bash", ".../pipeline-artifacts.sh",
#                 "{repo_path}", "{sha}", "{token}", "{mr}"],
#     "fields": {"name": {"json": "name"}, "text": {"json": "text"}}
#   }
#
# 环境变量(均有默认值): MFC_CODEHUB_API / MFC_CODEHUB_CLI_HOST /
#   MFC_MCP_SSE_HOST / MFC_MCP_SSE_PORT / MFC_MCP_TOKEN_FILE /
#   MFC_MCP_CLIENT_DIR / MFC_MCP_TOKEN_REFRESH_COMMAND /
#   MFC_MCP_TOKEN_REFRESH_TIMEOUT / MFC_W3TOKEN_FILE / MFC_AI_REVIEW_URL /
#   MFC_CODECCP_REST / MFC_MCP_<网关名>_URL
set -euo pipefail

REPO_PATH="$1"
SHA="$2"
TOKEN="$3"
MR_URL="${4:-}"

# 编排器与两个 MCP 客户端已随仓收编在本目录:缺省从脚本自身目录
# import,显式设了 MFC_MCP_CLIENT_DIR(如沿用 ~/.config 旧部署)则以
# 其为准。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MFC_MCP_CLIENT_DIR="${MFC_MCP_CLIENT_DIR:-$SCRIPT_DIR}"

exec python3 - "$REPO_PATH" "$SHA" "$TOKEN" "$MR_URL" << 'PYEOF'
import json
import os
import sys

sys.path.insert(0, os.path.expanduser(os.environ['MFC_MCP_CLIENT_DIR']))
import pipeline_log

items = pipeline_log.collect_items(
    sys.argv[1], sys.argv[2], sys.argv[3],
    mr_url=sys.argv[4],
    client_dir=os.path.expanduser(os.environ['MFC_MCP_CLIENT_DIR']))

# UTF-8 直出,避免中文被 \uXXXX 放大三倍。
print(json.dumps(items, ensure_ascii=False, separators=(',', ':')))
PYEOF
