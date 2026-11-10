#!/bin/bash
# pipeline-status.sh: 按 SHA 查流水线状态 + 失败日志摘要 + 逐项质量结果
# 输出: JSON 数组,每个元素含 status + fail_summary(日志摘要) + checks[]
#
# 收编自内网实测稳定版(2026-08-27),2026-08-28 进仓版本化并加三样:
#   1. run 级回显 sha / pipeline_id / web_url——宿主 selectTerminalRun
#      据此机械核验"结果属于当次提交"(防陈灯;按 sha 直查本身已绑定,
#      回显让宿主能自证而不是信任轮询参数)
#   2. checks 带 tool 字段(SuperChecker 类不可修工具的前置分诊要用)
#      并把 reviewtips 告警并进 details(规则/文件/行号,结构化喂修复使命)
#   3. 写死的地址改环境变量可覆盖(默认值=内网实测值):
#      MFC_CODEHUB_API / MFC_CODEHUB_CLI_HOST / MFC_MCP_SSE_HOST /
#      MFC_MCP_SSE_PORT / MFC_MCP_TOKEN_FILE / MFC_MCP_CLIENT_DIR
# 其余逻辑照搬不动(摘要窗口/头尾截断/维度聚合都是实战调出来的)。
#
# adapter.json 用法(模板抽取,不用 contract 模式):
#   "pipeline_status": {
#     "command": ["bash", ".../pipeline-status.sh", "{repo_path}", "{sha}", "{token}"],
#     "status": {"json": "status"}, "log": {"json": "fail_summary"},
#     "run_sha": {"json": "sha"}, "pipeline_id": {"json": "pipeline_id"},
#     "web_url": {"json": "web_url"},
#     "checks": {"json": "checks"}, "check_dimension": {"json": "dimension"},
#     "check_status": {"json": "status"}, "check_job": {"json": "job"},
#     "check_url": {"json": "url"}, "check_tool": {"json": "tool"},
#     "status_map": {"success": "success", "failed": "failed",
#                    "running": "running", "pending": "running",
#                    "canceled": "failed", "skipped": "failed",
#                    "created": "running", "manual": "running"}
#   }
set -euo pipefail

REPO_PATH="$1"
SHA="$2"
TOKEN="$3"

# SSE MCP 客户端已随仓收编在本目录:缺省从脚本自身目录 import,
# 显式设了 MFC_MCP_CLIENT_DIR(如沿用 ~/.config 旧部署)则以其为准。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MFC_MCP_CLIENT_DIR="${MFC_MCP_CLIENT_DIR:-$SCRIPT_DIR}"

exec python3 - "$REPO_PATH" "$SHA" "$TOKEN" "$SCRIPT_DIR" << 'PYEOF'
import json
import os
import re
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request

repo_path = sys.argv[1]
sha = sys.argv[2]
token = sys.argv[3]
env = {**os.environ, 'CODEHUB_TOKEN': token}

decoded_repo = urllib.parse.unquote(repo_path)
encoded_repo = urllib.parse.quote(decoded_repo, safe='')

CODEHUB_API = os.environ.get(
    'MFC_CODEHUB_API', 'https://codehub-y.example.com/api/v4')
CLI_HOST = os.environ.get('MFC_CODEHUB_CLI_HOST', 'yellow')
MCP_SSE_HOST = os.environ.get('MFC_MCP_SSE_HOST', '10.244.150.123')
MCP_SSE_PORT = int(os.environ.get('MFC_MCP_SSE_PORT', '9000'))
configured_mcp_token = os.environ.get('MFC_MCP_TOKEN_FILE', '').strip()
if configured_mcp_token:
    MCP_TOKEN_FILE = os.path.expanduser(configured_mcp_token)
elif os.path.exists('/etc/mae-flow-cloud/mcp-token'):
    MCP_TOKEN_FILE = '/etc/mae-flow-cloud/mcp-token'
else:
    MCP_TOKEN_FILE = os.path.expanduser(
        '~/.config/mae-flow-cloud/mcp-token')
MCP_CLIENT_DIR = os.path.expanduser(os.environ.get(
    'MFC_MCP_CLIENT_DIR', '~/.config/mae-flow-cloud'))

proxy_handler = urllib.request.ProxyHandler({})
opener = urllib.request.build_opener(proxy_handler)


def redact(value):
    text = str(value)
    if token:
        text = text.replace(token, '***')
    return text


def log_err(msg):
    print(f'[pipeline-status] {redact(msg)}', file=sys.stderr)


def fetch_url(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {'Private-Token': token})
    try:
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        log_err(f'fetch_url HTTP {e.code}: {url[:120]}')
        return None
    except Exception as e:
        log_err(f'fetch_url 失败: {e} url={url[:120]}')
        return None


sys.path.insert(0, sys.argv[4])
from pipeline_checks import (
    TOOL_DIMENSION, merge_check, quality_check,
    report_only, report_note, checks_from_stages,
)

STATUS_MAP = {
    'success': 'success', 'passed': 'success', 'failed': 'failed',
    'error': 'failed', 'running': 'running', 'pending': 'pending',
    'created': 'pending', 'manual': 'not_run', 'not_run': 'not_run',
    'canceled': 'canceled', 'cancelled': 'canceled', 'skipped': 'skipped',
}

# 这里不是为了"精准识别所有错误",而是为了找到值得保留上下文的失败信号。
FAILURE_PATTERNS = [
    re.compile(p, re.I)
    for p in [
        r'\berror\b',
        r'\bfatal\b',
        r'\bfailed\b',
        r'\bfailure\b',
        r'\bkilled\b',
        r'killed signal',
        r'signal\s*9\b',
        r'terminated by signal',
        r'exit\s+(?:code|status)\s*[:=]?\s*-?[1-9]\d*\b',
        r'\btimeout\b',
        r'timed out',
        r'no space left',
        r'disk quota',
        r'permission denied',
        r'undefined reference',
        r'cannot find',
        r'no such file(?: or directory)?',
        r'out of memory',
        r'\boom\b',
        r'cannot allocate memory',
        r'bad_alloc',
        r'segmentation fault',
        r'core dumped',
        r'assertion.*(?:failed|failure)',
        r'build failure',
        r'collect2:',
        r'ld returned \d+ exit status',
    ]
]

ZERO_FAILURE_PATTERNS = [
    re.compile(p, re.I)
    for p in [
        r'^\s*no error!?\s*$',
        r'^\s*0\s+errors?\b',
        r'^\s*errors?\s*[:=]\s*0\b',
        r'^\s*0\s+fail(?:ed|ures?)\b',
        r'^\s*failures?\s*[:=]\s*0\b',
        r'^\s*tests run:.*failures:\s*0\b.*errors:\s*0\b',
    ]
]


def is_failure_signal(line):
    stripped = line.strip()
    if not stripped:
        return False
    if any(p.search(stripped) for p in ZERO_FAILURE_PATTERNS):
        return False
    return any(p.search(stripped) for p in FAILURE_PATTERNS)


def merge_ranges(ranges):
    if not ranges:
        return []
    merged = [list(ranges[0])]
    for start, end in ranges[1:]:
        prev = merged[-1]
        if start <= prev[1] + 1:
            prev[1] = max(prev[1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def select_failure_ranges(lines, context_before=3, context_after=3, max_windows=12):
    hit_indexes = [i for i, line in enumerate(lines) if is_failure_signal(line)]
    if not hit_indexes:
        return [], 0

    ranges = []
    for i in hit_indexes:
        ranges.append((
            max(0, i - context_before),
            min(len(lines) - 1, i + context_after),
        ))
    ranges = merge_ranges(ranges)

    omitted = 0
    if len(ranges) > max_windows:
        # 既保留较早的首个根因,也偏重保留最后失败现场。
        keep_first = min(4, max_windows)
        keep_last = max_windows - keep_first
        selected = ranges[:keep_first]
        if keep_last:
            selected += ranges[-keep_last:]
        omitted = len(ranges) - len(selected)
        ranges = selected

    return ranges, omitted


def keep_ends(text, max_chars, head_chars):
    if len(text) <= max_chars:
        return text
    marker = '\n\n...(中间内容因长度限制截断)...\n\n'
    if max_chars <= len(marker):
        return text[:max_chars]
    head_chars = min(head_chars, (max_chars - len(marker)) // 2)
    tail_chars = max_chars - len(marker) - head_chars
    return text[:head_chars] + marker + text[-tail_chars:]


def smart_truncate(text, max_chars=8000, head_chars=2800):
    """单 job 和最终摘要都先为带行号的失败原文留空间。"""
    if len(text) <= max_chars:
        return text
    by_job = {}
    job = ''
    previous = ''
    for line in text.splitlines():
        if line.startswith('  === job '):
            job = line
        if re.match(r'^>> L\d+:', line):
            hits = by_job.setdefault(job, {})
            # 错误行有时只有退出码，上一行才是执行的命令。
            if re.match(r'^\s+L\d+:', previous):
                hits[previous] = None
            hits[line] = None
        previous = line
    if not by_job:
        return keep_ends(text, max_chars, head_chars)

    # 多个 job 平分失败原文的预算，避免中间的 job 整段消失。
    per_job = max_chars // (2 * len(by_job))
    excerpts = []
    for job, hits in by_job.items():
        block = '\n'.join(filter(None, [job, *hits]))
        excerpts.append(keep_ends(block, per_job, per_job // 2))
    evidence = keep_ends('--- 失败原文 ---\n' + '\n'.join(excerpts) + '\n', max_chars // 2, max_chars // 4)
    return evidence + keep_ends(text, max_chars - len(evidence), head_chars)


def summarize_log(log_content, max_head=20, max_tail=50):
    """
    轻量诊断摘要:
      1) 日志头部:构建命令/环境;
      2) 失败信号前后上下文;
      3) 日志尾部:最终状态/exit code;
      4) 没命中失败信号时,额外保留中后段兜底。
    """
    if not log_content:
        return '(空日志)'

    lines = log_content.splitlines()
    parts = []

    head = [line.rstrip() for line in lines[:max_head] if line.strip()]
    if head:
        parts.append('--- 日志开头 ---')
        parts.extend(head)

    failure_ranges, omitted = select_failure_ranges(lines)
    if failure_ranges:
        parts.append('--- 失败信号上下文 ---')
        previous_end = None
        for start, end in failure_ranges:
            if previous_end is not None:
                parts.append('  ...')
            for idx in range(start, end + 1):
                line = lines[idx].rstrip()
                if line.strip():
                    mark = '>>' if is_failure_signal(line) else '  '
                    parts.append(f'{mark} L{idx + 1}: {line}')
            previous_end = end
        if omitted:
            parts.append(f'  ... 另有 {omitted} 个失败上下文窗口未展开 ...')
    else:
        # 明确是 failed pipeline 却没有命中词时,不只依赖最后几十行:
        # 从日志中后段再取一段,覆盖"没有 error 字样"的异常。
        nonempty_count = len([line for line in lines if line.strip()])
        if nonempty_count > max_head + max_tail:
            start = max(max_head, len(lines) - 160)
            end = max(start, len(lines) - max_tail)
            fallback = [line.rstrip() for line in lines[start:end] if line.strip()]
            if fallback:
                # 最多保留 70 行,且优先靠后。
                fallback = fallback[-70:]
                parts.append('--- 未命中典型失败词,中后段兜底 ---')
                parts.extend(fallback)

    tail = [line.rstrip() for line in lines[-max_tail:] if line.strip()]
    if tail:
        parts.append('--- 日志末尾 ---')
        parts.extend(tail)

    # 单个 job 先做一次局部预算,避免多 job 时把总摘要撑爆。
    return smart_truncate('\n'.join(parts), max_chars=5500, head_chars=1800)


def extract_job_id(real):
    if not isinstance(real, str):
        return None
    match = re.search(r'jobId=([A-Za-z0-9._:-]+)', real)
    return match.group(1) if match else None


def fetch_quality_log(pid, decoded_repo, token, env):
    """拉 quality + reviewtips → 拼成 checks 与质量摘要。"""
    checks_map = {}
    failures_by_tool = {}
    details_by_dim = {}
    job_id = None
    report_parts = []

    try:
        proc = subprocess.run(
            [
                'codehub-cli', 'pipeline', 'quality', str(pid),
                '--host', CLI_HOST, '--insecure',
                '--project', decoded_repo, '--format', 'json',
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            stderr = redact(proc.stderr[:200])
            log_err(f'codehub-cli quality pid={pid} rc={proc.returncode} stderr={stderr}')
            return [], []
        quality = json.loads(proc.stdout)
    except Exception as e:
        log_err(f'codehub-cli quality 异常: {e}')
        return [], []

    for check in quality.get('checks', []):
        tool = check.get('tool', '')
        dim = TOOL_DIMENSION.get(tool)
        if not dim:
            continue

        candidate = quality_check(check, STATUS_MAP)
        if candidate:
            merge_check(checks_map, candidate)
            if candidate['status'] == 'failed':
                failures_by_tool[tool] = ', '.join(
                    detail['message'] for detail in candidate['details'])
        elif report_only(check) or tool == 'CPP_UT':
            report_parts.append(report_note(check))

        if not job_id:
            for metric in check.get('metrics', []):
                found = extract_job_id(metric.get('real', ''))
                if found:
                    job_id = found
                    break

    quality_parts = []
    if failures_by_tool:
        quality_parts.append('【质量门禁指标】')
        for tool, metrics_text in failures_by_tool.items():
            dim = TOOL_DIMENSION.get(tool, tool)
            quality_parts.append(f'  {dim}({tool}): {metrics_text}')
        quality_parts.append('')

    if job_id:
        for tool_type in ['codecheck', 'build2.0', 'codechecktest', 'CPP_UT']:
            try:
                tips_url = (
                    'https://codecheck.tool.example.com/gateway/CodeCheck20Service/'
                    f'rest/codecheck20/reviewtips/json?jobId={urllib.parse.quote(job_id, safe="")}'
                    f'&toolType={urllib.parse.quote(tool_type, safe="")}'
                )
                tips_req = urllib.request.Request(
                    tips_url,
                    headers={
                        'Authorization': f'Bearer {token}',
                        'Private-Token': token,
                    },
                )
                with opener.open(tips_req, timeout=10) as tips_resp:
                    tips = json.loads(tips_resp.read().decode('utf-8'))

                notes = tips.get('noteTip', [])
                if notes:
                    dim = TOOL_DIMENSION.get(tool_type, tool_type)
                    quality_parts.append(f'【{dim}({tool_type}) 告警明细】')
                    for note in notes[:20]:
                        file_ = note.get('file', '?')
                        lines_ = note.get('lines', [])
                        tip = note.get('tip', '')
                        desc = note.get('description', '')
                        line_str = ','.join(str(line) for line in lines_[:3])
                        quality_parts.append(f'  {file_}:{line_str} | {tip}')
                        if desc:
                            quality_parts.append(f'    规则: {desc}')
                        # 结构化 details:同一份告警,再以契约形状喂宿主
                        # (修复使命的"照单点名"与 unfixable 分诊用)。
                        details_by_dim.setdefault(dim, []).append({
                            'message': tip or desc or '(无描述)',
                            **({'file': file_} if file_ and file_ != '?' else {}),
                            **({'line': lines_[0]} if lines_ else {}),
                            **({'rule': desc} if desc else {}),
                            'tool': tool_type,
                        })
                    quality_parts.append('')
            except Exception as e:
                log_err(f'reviewtips {tool_type} 失败: {e}')

    quality_parts.extend(report_parts)
    checks = list(checks_map.values())
    for check in checks:
        details = details_by_dim.get(check['dimension'])
        if details:
            check['details'] = check.get('details', []) + details[:50]
    return quality_parts, checks


# === 主流程 ===
log_err(f'查询: repo={decoded_repo} sha={sha[:12]}')

result = []
pipelines = fetch_url(
    f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
    f'?sha={urllib.parse.quote(sha, safe="")}&per_page=5&order_by=id&sort=desc'
)

# 只有成功取得的空数组才表示没有运行；查询失败不能让宿主继续空等。
if not isinstance(pipelines, list):
    log_err('流水线列表查询失败或响应不是 JSON 数组，无法判断运行状态')
    sys.exit(1)

if not pipelines:
    log_err('流水线查询返回空')
    print(json.dumps([]))
    sys.exit(0)

log_err(f'找到 {len(pipelines)} 条流水线')

# API 先用 sort=desc 取得本 SHA 最新一页；若改成 asc，重跑超过
# per_page 后拿到的只会是最老几条。对外契约仍固定为旧→新，宿主只认
# runs.at(-1)，因此再按流水线 id 本地升序归一。极老接口若不回 id，
# 则保留 API 的 desc 顺序交给适配层 fail-closed，不拿 status 猜新旧。
try:
    if all(pipeline.get('id') is not None for pipeline in pipelines):
        pipelines = sorted(pipelines, key=lambda pipeline: int(pipeline['id']))
except (TypeError, ValueError):
    log_err('流水线 id 不是可排序整数，沿用 API sort=desc 返回顺序')

for pipeline in pipelines:
    entry = {
        'status': pipeline.get('status', ''),
        'fail_summary': '',
        'checks': [],
        # 防陈灯回显:宿主 selectTerminalRun 机械核验"结果属于当次提交"。
        # 按 sha 直查本身已绑定,回显让宿主能自证而不是信任轮询参数。
        **({'sha': pipeline.get('sha')} if pipeline.get('sha') else {}),
        **({'pipeline_id': str(pipeline.get('id'))}
           if pipeline.get('id') is not None else {}),
        **({'web_url': pipeline.get('web_url')}
           if pipeline.get('web_url') else {}),
    }
    pid = pipeline.get('id')

    quality_parts, checks = fetch_quality_log(pid, decoded_repo, token, env)
    entry['checks'] = checks

    # 实际执行 job 与报告生成分开读取。编译失败不否定独立并行 UT。
    failed_stages = []
    try:
        jd = fetch_url(f'{CODEHUB_API}/projects/{encoded_repo}/pipelines/{pid}/jobs')
        stages = (jd or {}).get('stages', [])
        picked = checks_from_stages(stages, STATUS_MAP)
        for check in checks:
            merge_check(picked, check)
        entry['checks'] = list(picked.values())
        for stage in stages:
            for job in stage.get('jobs', []):
                if job.get('status') == 'failed':
                    failed_stages.append(
                        f"FAILED stage={stage.get('name', '?')} job={job.get('name', '?')}")
    except Exception as e:
        log_err(f'拉 jobs pid={pid} 失败: {e}')

    if pipeline.get('status') == 'failed':
        fail_parts = failed_stages

        fail_parts.extend(quality_parts)

        # 构建日志摘要(via MCP SSE)
        try:
            pipeline_detail = fetch_url(
                f'{CODEHUB_API}/projects/{encoded_repo}/pipelines/{pid}'
            )
            if pipeline_detail and pipeline_detail.get('ref'):
                ref = pipeline_detail['ref']
                encoded_ref = urllib.parse.quote(ref, safe='')
                mrs = fetch_url(
                    f'{CODEHUB_API}/projects/{encoded_repo}/merge_requests'
                    f'?source_branch={encoded_ref}&state=opened'
                )
                if mrs:
                    mr_url = mrs[0].get('web_url', '')
                    if mr_url:
                        sys.path.insert(0, MCP_CLIENT_DIR)
                        from mcp_sse_client import SSEMcpClient

                        with open(MCP_TOKEN_FILE, encoding='utf-8') as fh:
                            mcp_token = fh.read().strip()

                        log_err(f'MCP SSE 连接 mr={mr_url[:80]}')
                        client = SSEMcpClient(MCP_SSE_HOST, MCP_SSE_PORT)
                        try:
                            client.connect()
                            client.initialize()
                            info = client.get_mr_pipeline_info(mr_url)
                            if info:
                                defects = info.get('defects', [])
                                build_defect = next(
                                    (
                                        defect
                                        for defect in defects
                                        if defect.get('toolName') == 'build2.0'
                                    ),
                                    None,
                                )
                                if (
                                    build_defect
                                    and build_defect.get('record_ids')
                                    and build_defect.get('x_auth_groups')
                                ):
                                    record_ids = build_defect['record_ids']
                                    x_auth_groups = build_defect['x_auth_groups']
                                    log_err(f'下载构建日志: {len(record_ids)} 条记录')

                                    logs = client.download_build_logs(
                                        record_ids,
                                        x_auth_groups,
                                        mcp_token,
                                    )

                                    fail_parts.append('【构建日志摘要】')
                                    for rid, log_content in logs:
                                        if not log_content:
                                            continue
                                        summary = summarize_log(log_content)
                                        kb = len(
                                            log_content.encode('utf-8', errors='replace')
                                        ) // 1024
                                        fail_parts.append(
                                            f'  === job {rid} ({kb}KB) ==='
                                        )
                                        fail_parts.append(summary)
                                        fail_parts.append('')
                                else:
                                    log_err(
                                        'build2.0 defect 无 record_ids/x_auth_groups'
                                    )
                            else:
                                log_err('MCP get_mr_pipeline_info 返回空')
                        finally:
                            client.close()
                else:
                    log_err(f'未找到 ref={ref} 的 MR')
            else:
                log_err(f'流水线 pid={pid} 无 ref')
        except Exception:
            log_err(
                f'拉构建日志失败: {redact(traceback.format_exc())[:500]}'
            )

        entry['fail_summary'] = '\n'.join(fail_parts)

    elif pipeline.get('status') == 'success':
        if quality_parts:
            entry['fail_summary'] = '\n'.join(quality_parts)

    # 给 Agent 的快速上下文仍保持约 8K,但保留两端。
    entry['fail_summary'] = smart_truncate(
        entry['fail_summary'],
        max_chars=8000,
        head_chars=2800,
    )
    result.append(entry)

print(json.dumps(result, ensure_ascii=False))
PYEOF
