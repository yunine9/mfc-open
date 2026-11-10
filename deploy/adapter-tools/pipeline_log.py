#!/usr/bin/env python3
"""pipeline_log.py — toolkit「PipelineLog 编排器」的忠实移植。

出身(2026-08-28 用户带回 toolkit 全景图 + 源码仲裁):toolkit 的流水线
修复闭环采用「先采后修」——所有外部系统交互集中在 PipelineLog 编排器,
8 个 Strategy 按依赖顺序执行、逐个填充共享 PipelineData、全部落盘为
本地文件;修复 Agent 只读本地文件,不再调 API。本模块照抄这套结构:
Strategy 名、落盘文件名、降级链全部沿用 toolkit 原样。

Strategy 执行顺序(toolkit 拓扑序的线性化):
  pipeline-info     SSE 网关 get_mr_pipeline_info → pipeline_info.json
  pipeline-detail   codehub MCP actual_head_pipeline → pipeline_detail.json
                    (降级: REST v4 pipelines?sha=,来源存疑但现网在用)
  mergeable-state   codehub MCP mergeable_state → mergeable_state.json
  pipeline-quality  codehub MCP get_pipeline_quality → pipeline_quality.json
                    (降级: codehub-cli pipeline quality,toolkit 同款降级)
  build-logs        SSE 下载 → build MCP zip → build MCP 有界日志窗口;
                    同时采 get_build_error_info / get_record_fullstages
  codecheck         codecheck MCP query_mr_info → codecheck_detail.json
                    (降级①: REST reviewtips 按 codecheckJobId×toolType;
                     降级②: REST defect/list 按 taskId——taskId 出处
                     未钉死,拿不到就明说跳过)
  coverage          codecov MCP CodeCovDiffCoverageTool 按 utJobIds
  ai-review-tips    行云 AI Review 纯 REST(唯一非 MCP 通路)

红线:每个 Strategy fail-open——单路失败只进 errors 清单,绝不拦别路、
绝无无限等待(所有网络调用带超时)。最后写
pipeline_log_summary.json 如实记录每个策略 ok/failed/skipped 与原因,
修复 Agent 和人都能一眼看出哪路证据缺了、为什么缺。

入参形状已于 2026-08-28 用五网关 tools/list 对拍：CodeHub 的
get_project_info/get_pipeline_quality/mergeable_state 使用真实嵌套结构，
Build 四个 record 工具统一携带 x_auth_groups 对应的 group_id，CodeCov
沿用已确认的 jobId。后续新增工具仍必须先对拍，不能恢复猜写。

令牌分域:{token} 只供 CodeHub REST/CLI 与已验证的 REST 兼容路；
所有 streamable-HTTP MCP 网关与 SSE 构建日志均读
MFC_MCP_TOKEN_FILE。token/w3token 只进请求头,永不落盘、永不进日志;
错误文本一律 redact。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

from mcp_tool_contracts import (
    actual_head_pipeline_arguments,
    build_record_arguments,
    codehub_host_from_url,
    coverage_arguments,
    mergeable_state_arguments,
    pipeline_quality_arguments,
    project_info_arguments,
    unwrap_data,
)

MAX_ITEM_BYTES = 512 * 1024
# 构建日志没有单文件 512 KiB 限制；整包仍留有界预算，避免异常平台
# 响应无限占用适配器内存。只对 pipeline_artifacts 命令放宽到 128 MiB，
# 其他命令沿用原来的 8 MiB。结构化失败片段先入包，超预算日志留清单。
MAX_BUNDLE_BYTES = 100 * 1024 * 1024

CODEHUB_API = os.environ.get(
    'MFC_CODEHUB_API', 'https://codehub-y.example.com/api/v4')
CODEHUB_HOST = os.environ.get(
    'MFC_CODEHUB_HOST', codehub_host_from_url(CODEHUB_API))
CLI_HOST = os.environ.get('MFC_CODEHUB_CLI_HOST', 'yellow')
MCP_SSE_HOST = os.environ.get('MFC_MCP_SSE_HOST', '10.244.150.123')
MCP_SSE_PORT = int(os.environ.get('MFC_MCP_SSE_PORT', '9000'))
_configured_token_file = os.environ.get('MFC_MCP_TOKEN_FILE', '').strip()
if _configured_token_file:
    MCP_TOKEN_FILE = os.path.expanduser(_configured_token_file)
elif os.path.exists('/etc/mae-flow-cloud/mcp-token'):
    MCP_TOKEN_FILE = '/etc/mae-flow-cloud/mcp-token'
else:
    # 保留开发机与旧部署兼容；生产部署的 /etc 文件存在时优先使用它。
    MCP_TOKEN_FILE = os.path.expanduser(
        '~/.config/mae-flow-cloud/mcp-token')
MCP_TOKEN_REFRESH_COMMAND = os.environ.get(
    'MFC_MCP_TOKEN_REFRESH_COMMAND', '').strip()
MCP_TOKEN_REFRESH_TIMEOUT = max(1, int(os.environ.get(
    'MFC_MCP_TOKEN_REFRESH_TIMEOUT', '15')))
W3TOKEN_FILE = os.environ.get('MFC_W3TOKEN_FILE', '')
# 行云 AI Review 是 toolkit 里唯一纯 REST 的外部系统(无 MCP 网关)。
AI_REVIEW_URL = os.environ.get(
    'MFC_AI_REVIEW_URL',
    'https://xingyun.rnd.example.com/gateway/aisystemservice/'
    'ai-code-review/reviewTips/json')
CODECCP_REST = os.environ.get(
    'MFC_CODECCP_REST',
    'https://codecheck.tool.example.com/gateway/CodeCheck20Service/rest/codecheck20')

# CodeCheck 类 reviewtips 遍历的工具维度(toolkit 同款清单)。
REVIEWTIP_TOOL_TYPES = ['codecheck', 'build2.0', 'codechecktest', 'CPP_UT']

# 原始日志最终要过总包预算。结构化 get_build_error_info 是首选，
# 但网关不可用时仍要把散落在长日志中段的失败片段单独摘出来。
# 测试汇总要先于尾部的报告工具报错呈现，避免把后果当成根因。
UT_FAILURE_PATTERN = re.compile(
    r'(?:\btest case failed\b|\bfailure total:\s*[1-9]\d*\b|'
    r'\btest case\s+[^\r\n]+?\s+failed\b|'
    r'\btests?:\s*[1-9]\d*\s+failed\b|'
    r'\btest (?:suites|files)\s*:?\s*[1-9]\d*\s+failed\b|'
    r'\bTests run:\s*\d+,\s*Failures:\s*[1-9]\d*\b|'
    r'\b[1-9]\d*\s+failing\b|'
    r'^\s*(?:\[ERROR\]\s*)?FAIL\s+\S+\.(?:test|spec)\.(?:js|jsx|ts|tsx)\b|'
    r'^\s*[●✖×]\s+\S|'
    r'^\s*(?:\[ERROR\]\s*)?[\w.$]+Test\.[\w$]+(?::\d+|\b[^\r\n]*<<<\s*(?:FAILURE|ERROR))|'
    r'^\s*[\w.$]+Test\s*>\s*.+\s+FAILED\b|'
    r'^\s*FAILED\s+\S+\.py(?:::\S+)+\b|'
    r'^\s*--- FAIL:\s*Test\S+|'
    r'^\s*test\s+\S+\s+\.\.\.\s+FAILED\b|'
    r'^\s*Failed\s+[\w.]+\s+\[\d+\s*(?:ms|s)\]|'
    r'\[\s*FAILED\s*\]\s+(?:[1-9]\d*\s+tests?\b|'
    r'[\w/:-]+(?:\.[\w/:-]+)+))',
    re.IGNORECASE)
BUILD_ERROR_PATTERN = re.compile(
    r'(?:fatal error|\berror:|undefined reference|collect2:|'
    r'ld(?:\.lld)?: error|make(?:\[\d+\])?: \*\*\*|\[ERROR\]|'
    r'killed signal|tests? failed|failures?!!!|'
    + UT_FAILURE_PATTERN.pattern + r')',
    re.IGNORECASE)


class StrategySkipped(RuntimeError):
    """外部数据本轮本就不会产生，不是采集链故障。"""


NO_DATA_PATTERN = re.compile(
    r'^(?:no\s+data(?:\s+found)?|not\s+found)'
    r'(?:\s|[:：,，;；\-—]|$)',
    re.IGNORECASE,
)


def is_no_data_payload(value) -> bool:
    """CodeCov 网关的空结果有字符串和包装 JSON 两种形态。"""
    if value is None:
        return True
    if isinstance(value, str):
        text = value.strip()
        return text.lower() in {'', 'null'} or bool(NO_DATA_PATTERN.match(text))
    if isinstance(value, (list, tuple)):
        return not value or all(is_no_data_payload(item) for item in value)
    if isinstance(value, dict):
        if not value:
            return True
        # 常见包装如 {data: "No data found"} / {message: ...}。
        meaningful_values = [item for key, item in value.items()
                             if key not in {'code', 'success', 'is_valid'}]
        return bool(meaningful_values) and all(
            is_no_data_payload(item) for item in meaningful_values)
    return False


# ---------------------------------------------------------------------------
# 共享数据袋(toolkit 的 PipelineData 对应物)
# ---------------------------------------------------------------------------
class PipelineData:
    def __init__(self, project_path: str, sha: str, ref: str, mr_url: str):
        self.project_path = project_path        # group/repo(已解码)
        self.sha = sha
        self.ref = ref
        self.mr_url = mr_url
        self.codehub_host = (codehub_host_from_url(mr_url)
                             if mr_url else CODEHUB_HOST)
        self.mr_iid = None
        self.project_id = None
        self.pipeline_id = None
        self.pipeline_status = ''
        self.commit_id = ''
        self.defects = []                       # SSE pipeline_info 的 defects
        self.record_ids = []                    # build2.0 的构建记录
        self.x_auth_groups = None
        self.ut_job_ids = []
        self.codecheck_job_id = ''                # quality 里 jobId= 提出来的
        self.summary = {}                       # strategy → {status, note}
        self.guessed = []                       # 用了「猜」入参的调用点


# ---------------------------------------------------------------------------
# 执行环境:输出目录 + 各协议客户端(全部懒加载,拿不到就如实报)
# ---------------------------------------------------------------------------
class Context:
    def __init__(self, out_dir: str, token: str, client_dir: str):
        self.out_dir = out_dir
        self.token = token
        self.client_dir = client_dir
        self._http_clients = {}
        self._mcp_token = None
        self._mcp_token_mtime_ns = None
        self._token_refresh_attempted = False
        self._sse_client = None
        self._sse_error = None
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}))   # 网关直连,不走代理(实测 407)
        self._w3token = ''
        if W3TOKEN_FILE:
            try:
                with open(os.path.expanduser(W3TOKEN_FILE),
                          encoding='utf-8') as fh:
                    self._w3token = fh.read().strip()
            except OSError:
                pass
        self._secret_values = {value for value in (token, self._w3token)
                               if value}

    # -- 日志(带脱敏) --
    def redact(self, value) -> str:
        text = str(value)
        for secret in self._secret_values:
            if secret:
                text = text.replace(secret, '<token>')
        return text

    def log(self, msg: str) -> None:
        print(f'[pipeline-log] {self.redact(msg)}', file=sys.stderr)

    # -- 落盘 --
    def write_json(self, name: str, obj) -> None:
        path = os.path.join(self.out_dir, name)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)

    def write_text(self, name: str, text: str) -> None:
        path = os.path.join(self.out_dir, name)
        with open(path, 'w', encoding='utf-8', errors='replace') as fh:
            fh.write(text)

    # -- REST(CodeHub v4,Private-Token) --
    def fetch_json(self, url: str, headers=None, timeout=30):
        req = urllib.request.Request(
            url, headers=headers or {'Private-Token': self.token})
        with self.opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))

    # -- streamable-HTTP MCP(五网关注册表在 mcp_http_client.py) --
    def mcp_call(self, gateway: str, tool: str, arguments: dict,
                 timeout: float = 60):
        sys.path.insert(0, self.client_dir)
        from mcp_http_client import McpHttpClient, McpHttpError, gateway_url
        # {token} 是 CodeHub 项目 access token，只能给 REST/CLI。真实
        # 网关已验证：CodeHub/Build/CodeCheck/CodeCov 等所有
        # streamable-HTTP MCP 都要每 5 分钟刷新的 MCP X-Auth-Token，
        # 与旧 SSE 下载共用 MFC_MCP_TOKEN_FILE。
        for attempt in range(2):
            auth_token = self.mcp_token(force_reload=attempt > 0)
            try:
                client = self._http_clients.get(gateway)
                if client is None or client.token != auth_token:
                    client = McpHttpClient(url=gateway_url(gateway),
                                           token=auth_token,
                                           w3token=self._w3token)
                    # initialize 也可能直接返回 401/Token解析失败，
                    # 必须和 tools/call 放在同一个有界鉴权重试里。
                    client.initialize()
                    self._http_clients[gateway] = client
                return client.call_tool(tool, arguments, timeout=timeout)
            except McpHttpError as error:
                if (attempt > 0
                        or self._token_refresh_attempted
                        or not self._is_token_error(error)):
                    raise
                # 有界自愈：旧会话与内存 token 一并丢弃。刷新命令是部署
                # 显式配置的 argv（不用 shell），缺省则只重读外部 5 分钟
                # 刷新脚本维护的文件；无论如何只再试一次。
                self._http_clients.pop(gateway, None)
                self._token_refresh_attempted = True
                self.refresh_mcp_token()
        raise RuntimeError('MCP token 重试未收口')

    # -- 旧式 SSE MCP(日志网关专用,协议不同于 streamable HTTP) --
    def sse_client(self):
        if self._sse_client is None and self._sse_error is None:
            try:
                sys.path.insert(0, self.client_dir)
                from mcp_sse_client import SSEMcpClient
                client = SSEMcpClient(MCP_SSE_HOST, MCP_SSE_PORT)
                client.connect()
                client.initialize()
                self._sse_client = client
            except Exception as error:      # 连不上如实记,别处照常跑
                self._sse_error = self.redact(str(error))
        if self._sse_client is None:
            raise RuntimeError(f'SSE 网关不可用: {self._sse_error}')
        return self._sse_client

    def sse_token(self) -> str:
        return self.mcp_token()

    def mcp_token(self, force_reload: bool = False) -> str:
        try:
            mtime_ns = os.stat(MCP_TOKEN_FILE).st_mtime_ns
        except OSError:
            mtime_ns = None
        if (not force_reload and self._mcp_token is not None
                and self._mcp_token_mtime_ns == mtime_ns):
            return self._mcp_token
        loaded = ''
        loaded_mtime_ns = mtime_ns
        # 外部刷新脚本如果不是 rename 原子替换，会有一个极短的
        # truncate→write 窗口。限定 3 次快速稳定读，不把半个 token
        # 装进客户端，也不会像跨轮重试那样卡住 HTTP 请求。
        for attempt in range(3):
            try:
                before = os.stat(MCP_TOKEN_FILE)
                with open(MCP_TOKEN_FILE, encoding='utf-8') as fh:
                    candidate = fh.read().strip()
                after = os.stat(MCP_TOKEN_FILE)
                stable = (before.st_mtime_ns == after.st_mtime_ns
                          and before.st_size == after.st_size)
                if candidate and stable:
                    loaded = candidate
                    loaded_mtime_ns = after.st_mtime_ns
                    break
            except OSError:
                pass
            if attempt < 2:
                time.sleep(0.05)
        if not loaded:
            raise RuntimeError(
                f'MCP token 文件为空、不稳定或不存在: {MCP_TOKEN_FILE}')
        self._mcp_token = loaded
        self._mcp_token_mtime_ns = loaded_mtime_ns
        self._secret_values.add(self._mcp_token)
        return self._mcp_token

    @staticmethod
    def _is_token_error(error) -> bool:
        text = str(error).lower()
        return bool(re.search(
            r'(?:token.*(?:解析失败|失效|过期|无效|invalid|expired|parse)'
            r'|(?:unauthorized|forbidden|http\s+(?:401|403)))', text,
            re.IGNORECASE))

    def refresh_mcp_token(self) -> None:
        self._mcp_token = None
        self._mcp_token_mtime_ns = None
        if not MCP_TOKEN_REFRESH_COMMAND:
            self.log('MCP 鉴权失败，重新读取 token 文件后重试一次')
            return
        argv = shlex.split(MCP_TOKEN_REFRESH_COMMAND)
        if not argv or not os.path.isabs(argv[0]):
            raise RuntimeError(
                'MFC_MCP_TOKEN_REFRESH_COMMAND 首项必须是绝对脚本路径')
        self.log('MCP 鉴权失败，执行受控 token 刷新命令后重试一次')
        proc = subprocess.run(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, text=True,
            timeout=MCP_TOKEN_REFRESH_TIMEOUT, env=os.environ.copy())
        if proc.returncode != 0:
            raise RuntimeError(
                f'MCP token 刷新命令失败(rc={proc.returncode})')

    def close(self) -> None:
        if self._sse_client is not None:
            try:
                self._sse_client.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Strategy 实现(名字与 toolkit 一致)
# ---------------------------------------------------------------------------
def resolve_mr(data: PipelineData, ctx: Context) -> None:
    """入口归一:拿到 mr_url / mr_iid / project_id。

    toolkit 天然 MR-first(Monitor 就是围着 MR 转);我们的适配器入口
    是 (repo, sha, ref[, mr_url]),没给 mr_url 就按 source_branch 反查
    ——这是我们与 toolkit 的入口差异,不是降级。
    """
    encoded_repo = urllib.parse.quote(data.project_path, safe='')
    if data.mr_url:
        match = re.search(r'/merge_requests?/(\d+)', data.mr_url)
        if match:
            data.mr_iid = int(match.group(1))
            data.codehub_host = codehub_host_from_url(data.mr_url)
    if not data.mr_url and not data.ref:
        # 老脚本的找 MR 路径:sha → 流水线 → ref → source_branch 反查。
        try:
            pipelines = ctx.fetch_json(
                f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
                f'?sha={urllib.parse.quote(data.sha, safe="")}'
                f'&per_page=3&order_by=id&sort=desc') or []
            if pipelines:
                data.ref = str(pipelines[0].get('ref') or '')
        except Exception as error:
            ctx.log(f'sha 反查 ref 失败: {error}')
    if not data.mr_url and data.ref:
        encoded_ref = urllib.parse.quote(data.ref, safe='')
        mrs = ctx.fetch_json(
            f'{CODEHUB_API}/projects/{encoded_repo}/merge_requests'
            f'?source_branch={encoded_ref}&state=opened')
        if mrs:
            data.mr_url = mrs[0].get('web_url', '')
            data.mr_iid = mrs[0].get('iid')
            data.project_id = mrs[0].get('project_id')
    if data.project_id is None:
        try:
            project = ctx.fetch_json(
                f'{CODEHUB_API}/projects/{encoded_repo}')
            if isinstance(project, dict):
                data.project_id = project.get('id')
        except Exception as error:
            ctx.log(f'project_id 反查失败: {error}')
    if data.project_id is None and data.mr_url:
        # 兜底走 codehub MCP get_project_info。真实 schema 要 git_url，
        # 从 MR 页面地址机械去掉 /merge_request(s)/<iid> 得到仓库 URL。
        try:
            git_url = re.sub(
                r'/(?:-/)?merge_requests?/\d+(?:[/?#].*)?$', '', data.mr_url)
            project = ctx.mcp_call(
                'codehub', 'get_project_info',
                project_info_arguments(git_url, data.codehub_host))
            project = unwrap_data(project)
            if isinstance(project, dict):
                data.project_id = (project.get('id')
                                   or project.get('project_id'))
        except Exception as error:
            ctx.log(f'get_project_info 失败: {error}')


def require_pipeline_identity(data, value, *, bound_pipeline=False):
    """MR 的最新结果可能仍属于上个提交；请求里的 SHA 本身不是证据。

    仅适用于返回 GitLab MR 结构(含 sha/commit_id/pipeline_id)的端点——
    actual_head_pipeline、REST pipelines?sha= 等。CodeCheck 质量端点
    (get_mr_pipeline_info/query_mr_info)返回 {pipelineStatus, defects}，
    天然没有版本字段，由 require_codecheck_identity 单独把关。
    """
    row = unwrap_data(value)
    if not isinstance(row, dict) or row.get('is_valid') is False:
        raise StrategySkipped('流水线材料未提供有效的版本归属')
    nested = row.get('pipeline') or row.get('head_pipeline') or {}
    commit = row.get('commit') or {}
    actual = str(row.get('sha') or row.get('commit_id') or row.get('commitId')
                 or row.get('lastCommitId') or (nested.get('sha') if isinstance(nested, dict) else '')
                 or (commit.get('id') if isinstance(commit, dict) else '') or '')
    if actual:
        if actual != data.sha:
            raise StrategySkipped(f'材料属于旧提交 {actual}，请求版本 {data.sha}，不送修复')
        return
    pipeline_id = row.get('pipeline_id') or row.get('pipelineId') or row.get('id')
    if (bound_pipeline and data.commit_id == data.sha and data.pipeline_id is not None
            and pipeline_id is not None and str(pipeline_id) == str(data.pipeline_id)):
        return
    raise StrategySkipped('材料缺少可核验的 SHA 或已绑定流水线 ID，不作为本版失败证据')


def require_codecheck_identity(data, value):
    """CodeCheck 质量端点(get_mr_pipeline_info/query_mr_info)的版本归属把关。

    这些端点按 MR URL 查询，返回 {pipelineStatus, defects}，天然没有
    sha/pipeline_id 字段——拿 GitLab MR 字段去 guard 永远 skip(实测
    b4141066 踩坑：用 require_pipeline_identity 检查 CodeCheck 质量信息，
    pipeline-info/codecheck 从 9-12 起全 skip，build-logs 拿不到
    record_ids 全 failed)。版本归属改由前置的 pipeline-detail 确认：
    它跑通时 data.commit_id==data.sha，说明 MR HEAD 与请求 SHA 一致；
    此时 CodeCheck 质量信息自然属于本版本。pipeline-detail 没确认过
    版本时(commit_id!=sha)，CodeCheck 材料可能属于上个提交，如实 skip。
    """
    if data.commit_id != data.sha or data.pipeline_id is None:
        raise StrategySkipped(
            'CodeCheck 质量材料缺乏前置版本确认(pipeline-detail 未核验本 SHA)，'
            '不作为本版失败证据')
    row = unwrap_data(value)
    if not isinstance(row, dict) or row.get('is_valid') is False:
        raise StrategySkipped('CodeCheck 质量材料未提供有效内容')
    if not row.get('pipelineStatus') and not row.get('defects'):
        raise StrategySkipped('CodeCheck 质量材料缺少 pipelineStatus 与 defects')


def strategy_pipeline_info(data: PipelineData, ctx: Context) -> None:
    """SSE 网关 get_mr_pipeline_info → pipeline_info.json(无降级)。

    这是整条链的信息枢纽:defects(toolName/record_ids/x_auth_groups)
    和 utJobIds 都从这来。
    """
    if not data.mr_url:
        raise RuntimeError('无 MR(未给 mr_url 且 source_branch 反查为空)')
    info = ctx.sse_client().get_mr_pipeline_info(data.mr_url)
    if not info:
        raise RuntimeError('get_mr_pipeline_info 返回空')
    require_codecheck_identity(data, info)
    ctx.write_json('pipeline_info.json', info)
    data.defects = info.get('defects', []) or []
    data.ut_job_ids = list(info.get('utJobIds') or [])
    for defect in data.defects:
        data.ut_job_ids.extend(defect.get('utJobIds') or [])
        if defect.get('toolName') == 'build2.0':
            data.record_ids = list(defect.get('record_ids') or [])
            data.x_auth_groups = defect.get('x_auth_groups')
    data.ut_job_ids = list(dict.fromkeys(data.ut_job_ids))


def strategy_pipeline_detail(data: PipelineData, ctx: Context) -> None:
    """codehub MCP actual_head_pipeline → pipeline_detail.json。

    降级:REST v4 pipelines?sha=(该端点出处存疑,但现网脚本在用且
    可跑;toolkit 此策略无降级,是我们为了不空手加的保底)。
    """
    detail = None
    if data.project_id is not None and data.mr_iid is not None:
        try:
            detail = ctx.mcp_call(
                'codehub', 'get_merge_request_actual_head_pipeline',
                actual_head_pipeline_arguments(
                    data.project_id, data.mr_iid, show_job=True,
                    codehub_host=data.codehub_host))
            detail = unwrap_data(detail)
        except Exception as error:
            ctx.log(f'actual_head_pipeline 失败,转 REST 降级: {error}')
    if detail:
        try:
            require_pipeline_identity(data, detail)
        except StrategySkipped as error:
            ctx.log(f'actual_head_pipeline 版本不符或不明，转按 SHA 查询: {error}')
            detail = None
    if detail:
        ctx.write_json('pipeline_detail.json', detail)
        if isinstance(detail, dict):
            data.pipeline_id = detail.get('id') or detail.get('pipeline_id')
            data.pipeline_status = str(detail.get('status', ''))
            data.commit_id = str(
                detail.get('sha') or detail.get('commit_id') or '')
            job_id = detail.get('codecheckJobId') or detail.get('codecheck_job_id')
            if job_id:
                data.codecheck_job_id = str(job_id)
        return
    # ---- REST 降级 ----
    encoded_repo = urllib.parse.quote(data.project_path, safe='')
    pipelines = ctx.fetch_json(
        f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
        f'?sha={urllib.parse.quote(data.sha, safe="")}'
        f'&per_page=5&order_by=id&sort=desc') or []
    # REST 明确请求 id 倒序，第一条就是最新 run；若网关忽略 sort，
    # 有完整数字 id 时再取最大值归一。绝不能跨过最新 running 去挑历史
    # failed/success，否则 artifacts 会把旧失败现场冒充成当前流水线。
    chosen = None
    pipelines = [item for item in pipelines if isinstance(item, dict)
                 and item.get('sha') == data.sha and item.get('is_valid') is not False]
    if pipelines:
        chosen = pipelines[0]
        try:
            if all(pipeline.get('id') is not None for pipeline in pipelines):
                chosen = max(pipelines,
                             key=lambda pipeline: int(pipeline['id']))
        except (TypeError, ValueError):
            ctx.log('流水线 id 不是可排序整数，沿用 REST sort=desc 首条')
    if not chosen:
        raise RuntimeError('MCP 与 REST 都没拿到本 SHA 的流水线')
    data.pipeline_id = chosen.get('id')
    data.pipeline_status = str(chosen.get('status', ''))
    data.commit_id = str(chosen.get('sha') or '')
    jobs = ctx.fetch_json(
        f'{CODEHUB_API}/projects/{encoded_repo}/pipelines'
        f'/{data.pipeline_id}/jobs') or []
    ctx.write_json('pipeline_detail.json',
                   {'_source': 'rest-v4-fallback', 'pipeline': chosen,
                    'jobs': jobs})


def strategy_mergeable_state(data: PipelineData, ctx: Context) -> None:
    """codehub MCP mergeable_state → mergeable_state.json(toolkit 无降级)。

    9+10 项门禁布尔,修复 Agent 用它判断除了流水线还有什么卡着。
    """
    if data.project_id is None or data.mr_iid is None:
        raise RuntimeError('缺 project_id/mr_iid,无法查门禁')
    state = ctx.mcp_call(
        'codehub', 'get_merge_request_mergeable_state',
        mergeable_state_arguments(
            data.project_id, data.mr_iid, data.codehub_host))
    state = unwrap_data(state)
    if not state:
        raise RuntimeError('mergeable_state 返回空')
    ctx.write_json('mergeable_state.json', state)


def strategy_pipeline_quality(data: PipelineData, ctx: Context) -> None:
    """codehub MCP get_pipeline_quality → pipeline_quality.json。

    降级:codehub-cli pipeline quality(toolkit 的 CLI 降级同款,也是
    我们现网跑通的路)。从 metrics.real 里正则提 jobId= 作 codecheckJobId。
    """
    quality = None
    if data.pipeline_id is not None and data.project_id is not None:
        try:
            quality = ctx.mcp_call(
                'codehub', 'get_pipeline_quality',
                pipeline_quality_arguments(
                    data.project_id, data.pipeline_id,
                    codehub_host=data.codehub_host))
            quality = unwrap_data(quality)
        except Exception as error:
            ctx.log(f'get_pipeline_quality 失败,转 CLI 降级: {error}')
    if not quality and data.pipeline_id is not None:
        proc = subprocess.run(
            ['codehub-cli', 'pipeline', 'quality', str(data.pipeline_id),
             '--host', CLI_HOST, '--insecure',
             '--project', data.project_path, '--format', 'json'],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, 'CODEHUB_TOKEN': ctx.token})
        if proc.returncode == 0 and proc.stdout.strip():
            quality = json.loads(proc.stdout)
        else:
            raise RuntimeError(
                f'CLI 降级 rc={proc.returncode} '
                f'stderr={ctx.redact(proc.stderr[:200])}')
    if not quality:
        raise RuntimeError('无 pipeline_id 或两路都没拿到 quality')
    ctx.write_json('pipeline_quality.json', quality)
    checks = []
    if isinstance(quality, dict):
        checks = quality.get('codequality_check') or quality.get('checks') or []
        if isinstance(checks, dict):
            checks = checks.get('checks') or checks.get('items') \
                or list(checks.values())
    for check in checks:
        for metric in check.get('metrics', []):
            real = metric.get('real', '')
            if isinstance(real, str) and 'jobId=' in real:
                match = re.search(r'jobId=([A-Za-z0-9._:-]+)', real)
                if match and not data.codecheck_job_id:
                    data.codecheck_job_id = match.group(1)


def write_build_log(ctx: Context, rid: str, text: str, evidence: set) -> None:
    """写完整日志，并把错误附近上下文另存为高优先级修复证据。"""
    name = f'build_log_{rid}.txt'
    ctx.write_text(name, text)
    evidence.add(name)
    lines = text.splitlines()
    test_hits = [index for index, line in enumerate(lines)
                 if UT_FAILURE_PATTERN.search(line)]
    # Mocha 的汇总是“2 failing”，用例名则单独排成“1) 名称”。
    # 只在同份日志已经出现失败汇总时，把这些编号行识别为用例。
    if any(re.search(r'\b[1-9]\d*\s+failing\b', line, re.IGNORECASE)
           for line in lines):
        test_hits.extend(index for index, line in enumerate(lines)
                         if re.match(r'^\s*\d+\)\s+\S', line))
    test_hits = sorted(set(test_hits))
    other_hits = [index for index, line in enumerate(lines)
                  if BUILD_ERROR_PATTERN.search(line)
                  and not UT_FAILURE_PATTERN.search(line)]
    if not test_hits and not other_hits:
        return
    def context(hit_indexes):
        selected = set()
        for index in hit_indexes:
            selected.update(range(max(0, index - 3), min(len(lines), index + 6)))
        excerpt_lines = []
        previous = None
        for index in sorted(selected):
            if previous is not None and index > previous + 1:
                excerpt_lines.append('... 中间无关日志省略 ...')
            excerpt_lines.append(f'{index + 1}: {lines[index]}')
            previous = index
        return excerpt_lines

    # 先展示测试失败原文，再展示编译/报告工具报错；早期的大量通用
    # [ERROR] 不能占满名额，挤掉后面真正的测试失败行。
    excerpt_lines = []
    if test_hits:
        excerpt_lines.append(f'===== 测试失败原文（{len(test_hits)} 行，优先排查） =====')
        # 用例名逐行列出；不能只取首尾 20 条，否则中间的失败用例
        # 会再次从摘要里消失。首尾上下文另列，完整日志仍单独保存。
        excerpt_lines.extend(f'{index + 1}: {lines[index]}' for index in test_hits)
        excerpt_lines.append('===== 测试失败前后文 =====')
        excerpt_lines.extend(context(test_hits[:5] + test_hits[-5:]))
    if other_hits:
        if excerpt_lines:
            excerpt_lines.append('===== 其他构建报错 =====')
        excerpt_lines.extend(context(other_hits[:120] + other_hits[-40:]))
    excerpt = '\n'.join(excerpt_lines)
    excerpt = _truncate_utf8_head_tail(
        excerpt, 256 * 1024, head_ratio=0.5,
        marker_template=(
            '\n\n===== 错误片段过多，中间省略；原始 UTF-8 大小 '
            '{size} bytes =====\n\n'))
    ctx.write_text(f'build_error_excerpt_{rid}.txt', excerpt)


def strategy_build_logs(data: PipelineData, ctx: Context) -> None:
    """构建日志三级降级 + 结构化错误 + 构建阶段(toolkit 原样)。

    ① SSE download_build_task_log(现网跑通的主路)
    ② build MCP get_build_log_url → 下载 zip → 解压
    ③ build MCP get_record_log 默认有界窗口
    随每条 record 另采 get_build_error_info(结构化编译错误,Agent 最
    好用的一份)与 get_record_fullstages(哪个阶段挂的)。
    """
    if not data.record_ids:
        raise RuntimeError('pipeline_info 未给出 build2.0 record_ids')
    if not data.x_auth_groups:
        raise RuntimeError(
            'pipeline_info 未给出 build2.0 x_auth_groups(group_id)')
    group_id = data.x_auth_groups
    pending = list(data.record_ids)
    repair_evidence = set()
    # ① SSE 批量下载
    if data.x_auth_groups:
        try:
            logs = ctx.sse_client().download_build_logs(
                data.record_ids, data.x_auth_groups, ctx.sse_token())
            for rid, content in logs:
                if content:
                    write_build_log(ctx, rid, content, repair_evidence)
                    if rid in pending:
                        pending.remove(rid)
        except Exception as error:
            ctx.log(f'SSE 构建日志失败,全部转 build 网关: {error}')
    # ②③ build 网关降级。tools/list 已确认 group_id 必填；旧实现还传了
    # schema 不认识的 page。offset 返回契约尚无真样例，本轮先使用工具
    # 自带的有界默认窗口，不能为了“分页”继续猜一套游标语义。
    for rid in pending:
        text = ''
        try:
            answer = ctx.mcp_call(
                'build', 'get_build_log_url',
                build_record_arguments(rid, group_id))
            answer = unwrap_data(answer)
            url_val = answer.get('url') if isinstance(answer, dict) else answer
            if isinstance(url_val, str) and url_val.startswith('http'):
                import io
                import zipfile
                with ctx.opener.open(url_val, timeout=30) as resp:
                    blob = resp.read()
                try:
                    with zipfile.ZipFile(io.BytesIO(blob)) as arc:
                        text = '\n\n'.join(
                            arc.read(m).decode('utf-8', 'replace')
                            for m in arc.namelist())
                except zipfile.BadZipFile:
                    text = blob.decode('utf-8', 'replace')
        except Exception as error:
            ctx.log(f'build zip 降级 {rid} 失败: {error}')
        if not text.strip():
            try:
                chunk = ctx.mcp_call(
                    'build', 'get_record_log',
                    build_record_arguments(rid, group_id))
                chunk = unwrap_data(chunk)
                text = chunk.get('log') if isinstance(chunk, dict) else chunk
                if not isinstance(text, str):
                    text = ''
            except Exception as error:
                ctx.log(f'build 日志窗口降级 {rid} 失败: {error}')
        if text.strip():
            write_build_log(ctx, rid, text, repair_evidence)
    # 结构化错误 + 阶段(增益,拿不到不算本策略失败)
    for rid in data.record_ids[:5]:
        try:
            errors = ctx.mcp_call(
                'build', 'get_build_error_info',
                build_record_arguments(rid, group_id))
            errors = unwrap_data(errors)
            if errors:
                name = f'build_errors_{rid}.json'
                ctx.write_json(name, errors)
                repair_evidence.add(name)
        except Exception as error:
            ctx.log(f'get_build_error_info {rid} 失败: {error}')
        try:
            stages = ctx.mcp_call(
                'build', 'get_record_fullstages',
                build_record_arguments(rid, group_id))
            stages = unwrap_data(stages)
            if stages:
                ctx.write_json(f'build_stages_{rid}.json', stages)
        except Exception as error:
            ctx.log(f'get_record_fullstages {rid} 失败: {error}')
    if not repair_evidence:
        raise RuntimeError(
            'SSE、Build 日志 URL/窗口及结构化编译错误均未拿到；'
            '只有阶段信息不足以支撑 Agent 修复')


def strategy_codecheck(data: PipelineData, ctx: Context) -> None:
    """CodeCheck 缺陷三级降级(toolkit 原样)→ codecheck_detail.json。

    ① codecheck MCP query_mr_info(主路)
    ② REST reviewtips 按 codecheckJobId × 工具维度
    ③ REST defect/list 按 taskId——taskId 从哪来 toolkit 表里没钉死,
      我们现网也没拿到过,所以只在上游真给了 taskId 时才尝试,否则
      如实 skip(不猜)。
    """
    if data.mr_url:
        try:
            detail = ctx.mcp_call('codecheck', 'query_mr_info',
                                  {'url': data.mr_url})
            if detail:
                require_codecheck_identity(data, detail)
                ctx.write_json('codecheck_detail.json', detail)
                return
        except Exception as error:
            ctx.log(f'codecheck query_mr_info 失败,转 reviewtips: {error}')
    if not data.codecheck_job_id:
        raise RuntimeError('主路失败且无 codecheckJobId,reviewtips 无从查起')
    collected = {}
    for tool_type in REVIEWTIP_TOOL_TYPES:
        try:
            tips_url = (
                f'{CODECCP_REST}/reviewtips/json'
                f'?jobId={urllib.parse.quote(data.codecheck_job_id, safe="")}'
                f'&toolType={urllib.parse.quote(tool_type, safe="")}')
            # 真现场已验证 reviewtips REST 消费 CodeHub token 的
            # Bearer + Private-Token；MCP X-Auth-Token 不得混进这条路。
            headers = {
                'Authorization': f'Bearer {ctx.token}',
                'Private-Token': ctx.token,
            }
            req = urllib.request.Request(tips_url, headers=headers)
            with ctx.opener.open(req, timeout=10) as resp:
                tips = json.loads(resp.read().decode('utf-8'))
            if tips.get('noteTip') or tips.get('rowMarker'):
                collected[tool_type] = tips
        except Exception as error:
            ctx.log(f'reviewtips {tool_type} 失败: {error}')
    if not collected:
        raise RuntimeError('reviewtips 各工具维度均无内容(defect/list 需 '
                           'taskId,上游未提供,如实跳过)')
    ctx.write_json('codecheck_detail.json',
                   {'_source': 'rest-reviewtips-fallback', **collected})


def strategy_coverage(data: PipelineData, ctx: Context) -> None:
    """codecov MCP CodeCovDiffCoverageTool 按 utJobIds(toolkit 无降级)。

    每个 UT job 一份 coverage_diff_*.json,外加 coverage_summary.json。
    """
    if not data.ut_job_ids:
        raise StrategySkipped(
            'pipeline_info 未给出 utJobIds；编译未通过或 UT 未运行时属正常')
    summary = {}
    call_failures = 0
    for ut_job in data.ut_job_ids[:5]:
        try:
            coverage = ctx.mcp_call(
                'codecov', 'CodeCovDiffCoverageTool',
                coverage_arguments(ut_job))
            no_data = is_no_data_payload(coverage)
            if coverage and not no_data:
                ctx.write_json(f'coverage_diff_{ut_job}.json', coverage)
                summary[str(ut_job)] = 'ok'
            else:
                # 真网关会用字符串 "No data found" 正常返回。它只证明
                # 调用成功，不构成覆盖率证据，不能因为 truthy 就记 ok。
                if coverage:
                    ctx.write_json(f'coverage_diff_{ut_job}.json', coverage)
                summary[str(ut_job)] = (
                    f'empty: {coverage}' if coverage else 'empty')
        except Exception as error:
            call_failures += 1
            summary[str(ut_job)] = f'failed: {ctx.redact(error)[:120]}'
    ctx.write_json('coverage_summary.json', summary)
    if not any(v == 'ok' for v in summary.values()):
        if call_failures:
            raise RuntimeError(f'覆盖率 MCP 调用失败: {summary}')
        raise StrategySkipped(
            '本次流水线未产生覆盖率数据（编译未通过或 UT '
            f'未运行时属正常）: {summary}')


def strategy_ai_review_tips(data: PipelineData, ctx: Context) -> None:
    """行云 AI Review 检视建议(纯 REST)→ ai_review_tips.json。"""
    if data.project_id is None or data.mr_iid is None:
        raise RuntimeError('缺 project_id/mr_iid')
    last_commit = data.commit_id or data.sha
    tips_url = (
        f'{AI_REVIEW_URL}?projectId={data.project_id}&mrId={data.mr_iid}'
        f'&lastCommitId={urllib.parse.quote(last_commit, safe="")}')
    req = urllib.request.Request(tips_url,
                                 headers={'X-Auth-Token': ctx.token})
    with ctx.opener.open(req, timeout=15) as resp:
        tips = json.loads(resp.read().decode('utf-8'))
    if not tips:
        raise RuntimeError('行云返回空')
    ctx.write_json('ai_review_tips.json', tips)


STRATEGIES = [
    ('pipeline-detail', strategy_pipeline_detail),
    ('pipeline-info', strategy_pipeline_info),
    ('mergeable-state', strategy_mergeable_state),
    ('pipeline-quality', strategy_pipeline_quality),
    ('build-logs', strategy_build_logs),
    ('codecheck', strategy_codecheck),
    ('coverage', strategy_coverage),
    ('ai-review-tips', strategy_ai_review_tips),
]


def run(project_path: str, sha: str, token: str, out_dir: str,
        ref: str = '', mr_url: str = '', client_dir: str = '') -> dict:
    """跑完整编排,返回 summary(同时落盘 pipeline_log_summary.json)。"""
    os.makedirs(out_dir, exist_ok=True)
    data = PipelineData(urllib.parse.unquote(project_path), sha, ref, mr_url)
    ctx = Context(out_dir, token,
                  client_dir or os.path.dirname(os.path.abspath(__file__)))
    try:
        try:
            resolve_mr(data, ctx)
        except Exception as error:
            ctx.log(f'MR 归一失败(相关策略会各自如实报): {error}')
        for name, strategy in STRATEGIES:
            try:
                strategy(data, ctx)
                data.summary[name] = {'status': 'ok'}
                ctx.log(f'{name}: ok')
            except StrategySkipped as error:
                note = ctx.redact(str(error))[:300]
                data.summary[name] = {'status': 'skipped', 'note': note}
                ctx.log(f'{name}: skipped — {note}')
            except Exception as error:
                # fail-open:失败进清单,别的策略照常跑。
                note = ctx.redact(str(error) or
                                  traceback.format_exc()[-200:])[:300]
                data.summary[name] = {'status': 'failed', 'note': note}
                ctx.log(f'{name}: failed — {note}')
        summary = {
            'sha': sha,
            'observed_sha': data.commit_id,
            'mr_url': data.mr_url,
            'pipeline_id': data.pipeline_id,
            'pipeline_status': data.pipeline_status,
            'strategies': data.summary,
            'guessed_args': sorted(set(data.guessed)),
        }
        ctx.write_json('pipeline_log_summary.json', summary)
        return summary
    finally:
        ctx.close()


# ---------------------------------------------------------------------------
# 按总包预算装箱；普通材料有单文件上限，构建日志按剩余空间保留全文。
# ---------------------------------------------------------------------------
def _utf8_len(text):
    return len(text.encode('utf-8', errors='replace'))


def _take_utf8_prefix(text, max_bytes):
    if max_bytes <= 0:
        return ''
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode('utf-8', errors='ignore')


def _take_utf8_suffix(text, max_bytes):
    if max_bytes <= 0:
        return ''
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= max_bytes:
        return text
    return raw[-max_bytes:].decode('utf-8', errors='ignore')


def _truncate_utf8_head_tail(
    text, max_bytes, head_ratio=0.15,
    marker_template=('\n\n===== 中间内容因大小限制省略；'
                     '原始 UTF-8 大小 {size} bytes =====\n\n'),
):
    """严格按 UTF-8 bytes 做 head+tail 截断,不切坏 UTF-8 字符。"""
    raw_size = _utf8_len(text)
    if raw_size <= max_bytes:
        return text
    marker = marker_template.format(size=raw_size)
    marker_bytes = _utf8_len(marker)
    if max_bytes <= marker_bytes + 32:
        return _take_utf8_suffix(text, max_bytes)
    payload_budget = max_bytes - marker_bytes
    head_budget = int(payload_budget * head_ratio)
    tail_budget = payload_budget - head_budget
    head = _take_utf8_prefix(text, head_budget)
    tail = _take_utf8_suffix(text, tail_budget)
    result = head + marker + tail
    if _utf8_len(result) > max_bytes:
        overflow = _utf8_len(result) - max_bytes
        tail = _take_utf8_suffix(tail, max(0, _utf8_len(tail) - overflow - 8))
        result = head + marker + tail
    return result


def _serialized_item_size(item):
    return len(json.dumps(item, ensure_ascii=False,
                          separators=(',', ':')).encode('utf-8'))


def fit_text_item(name, text, max_item_bytes=MAX_ITEM_BYTES):
    """返回序列化后 <= max_item_bytes 的 {name,text};大文本头少尾多,
    优先保留失败现场(构建日志的错误都在尾部)。"""
    item = {'name': name, 'text': text}
    if _serialized_item_size(item) <= max_item_bytes:
        return item
    low, high, best = 1024, max_item_bytes, ''
    while low <= high:
        mid = (low + high) // 2
        candidate_text = _truncate_utf8_head_tail(text, mid, head_ratio=0.15)
        if _serialized_item_size(
                {'name': name, 'text': candidate_text}) <= max_item_bytes:
            best = candidate_text
            low = mid + 1
        else:
            high = mid - 1
    if not best:
        best = _take_utf8_suffix(text, max(0, max_item_bytes // 2))
    item = {'name': name, 'text': best}
    while (_serialized_item_size(item) > max_item_bytes
           and _utf8_len(item['text']) > 1024):
        new_budget = max(1024, int(_utf8_len(item['text']) * 0.9))
        item['text'] = _truncate_utf8_head_tail(text, new_budget,
                                                head_ratio=0.15)
    return item


def fit_json_item(name, obj, max_item_bytes=MAX_ITEM_BYTES):
    """JSON 小于上限原样 pretty-print;超限输出仍合法的截断包装。"""
    full_text = json.dumps(obj, ensure_ascii=False, indent=2)
    item = {'name': name, 'text': full_text}
    if _serialized_item_size(item) <= max_item_bytes:
        return item
    original_size = _utf8_len(full_text)
    note = ('原始 JSON 超过 artifact 大小限制；preview 为原始序列化 JSON '
            '的头尾片段，不是完整原对象。')
    low, high, best_wrapper = 1024, max_item_bytes, None
    while low <= high:
        mid = (low + high) // 2
        preview = _truncate_utf8_head_tail(
            full_text, mid, head_ratio=0.25,
            marker_template=('\n\n===== 原始 JSON 中间内容因大小限制省略；'
                             '原始 UTF-8 大小 {size} bytes =====\n\n'))
        wrapper_text = json.dumps(
            {'_truncated': True, '_original_utf8_bytes': original_size,
             '_note': note, 'preview': preview},
            ensure_ascii=False, indent=2)
        if _serialized_item_size(
                {'name': name, 'text': wrapper_text}) <= max_item_bytes:
            best_wrapper = wrapper_text
            low = mid + 1
        else:
            high = mid - 1
    if best_wrapper is None:
        best_wrapper = json.dumps(
            {'_truncated': True, '_original_utf8_bytes': original_size,
             '_note': note,
             'preview': _take_utf8_suffix(full_text, 64 * 1024)},
            ensure_ascii=False, indent=2)
    return fit_text_item(name, best_wrapper, max_item_bytes=max_item_bytes)


def collect_output_items(out_dir: str) -> list:
    """把已采集目录按修复价值排序并装进受总预算约束的 JSON 包。"""
    items = []
    omitted = []
    used_bytes = 2  # JSON 列表的 []
    # 先装“能直接定位修复”的结构化证据，再装原始大日志。这样即使
    # 构建 record 很多触发总包预算，CodeCheck 文件/行号和结构化编译
    # 错误也不会被按字母序排在一堆 build_log 后面挤掉。
    def priority(name):
        if name == 'pipeline_log_summary.json':
            return 0
        if (name == 'codecheck_detail.json'
                or name.startswith(('build_errors_', 'build_error_excerpt_'))):
            return 1
        if name in {
            'pipeline_quality.json', 'pipeline_detail.json',
            'pipeline_info.json', 'mergeable_state.json',
            'coverage_summary.json', 'ai_review_tips.json',
        } or name.startswith(('coverage_diff_', 'build_stages_')):
            return 2
        if name.startswith('build_log_'):
            return 3
        return 2

    names = sorted(os.listdir(out_dir), key=lambda n: (priority(n), n))
    for name in names:
        path = os.path.join(out_dir, name)
        try:
            with open(path, encoding='utf-8', errors='replace') as fh:
                content = fh.read()
        except OSError:
            continue
        # 构建日志按总包剩余空间装载。单份 3 MiB 日志只要放得下就
        # 原样交给 Agent；512 KiB 是普通材料的限额，不适用于原始日志。
        log_budget = (MAX_BUNDLE_BYTES - 64 * 1024 - used_bytes
                      - (1 if items else 0)) if name.startswith('build_log_') else None
        if log_budget is not None and log_budget < 1024:
            omitted.append({
                'name': name,
                'reason': 'artifact 总包超过 100 MiB，保留结构化证据优先',
                'original_utf8_bytes': _utf8_len(content),
            })
            continue
        item = None
        if name.endswith('.json'):
            try:
                item = fit_json_item(name, json.loads(content))
            except json.JSONDecodeError:
                pass
        if item is None:
            item = fit_text_item(name, content,
                                 max_item_bytes=log_budget or MAX_ITEM_BYTES)
        item_bytes = _serialized_item_size(item) + (1 if items else 0)
        if used_bytes + item_bytes > MAX_BUNDLE_BYTES - 64 * 1024:
            omitted.append({
                'name': name,
                'reason': 'artifact 总包超过 100 MiB，保留结构化证据优先',
                'original_utf8_bytes': _utf8_len(content),
            })
            continue
        items.append(item)
        used_bytes += item_bytes
    if omitted:
        manifest = fit_json_item('pipeline_artifacts_omitted.json', {
            '_note': '以下文件未进入 Agent 本地镜像；不是平台没有生成。',
            'files': omitted,
        }, max_item_bytes=64 * 1024)
        manifest_bytes = _serialized_item_size(manifest) + 1
        if used_bytes + manifest_bytes > MAX_BUNDLE_BYTES:
            raise RuntimeError('artifact 省略清单意外突破总包预算')
        items.append(manifest)
    return items


def collect_items(project_path: str, sha: str, token: str,
                  ref: str = '', mr_url: str = '',
                  client_dir: str = '') -> list:
    """编排采集 + 装箱:适配器 pipeline_artifacts 命令的完整实现。

    「先采后修」的落地:编排器把证据落盘到临时 pipeline/ 目录,这里
    再逐文件装箱成 [{name,text}] 交给宿主写进任务工作区——修复 Agent
    只读这些本地文件,不再调任何外部 API。临时目录随本次采集销毁，
    不在 /tmp 长期堆积。
    """
    import tempfile
    with tempfile.TemporaryDirectory(prefix='pipeline-log-') as out_dir:
        run(project_path, sha, token, out_dir,
            ref=ref, mr_url=mr_url, client_dir=client_dir)
        return collect_output_items(out_dir)
