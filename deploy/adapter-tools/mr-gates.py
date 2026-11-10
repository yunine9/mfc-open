#!/usr/bin/env python3
"""Compose authoritative MR lifecycle/source SHA with CodeHub gate booleans.

Read-only adapter bridge; never interprets mergeability as lifecycle.
Arguments: encoded project path, MR iid (or URL), CodeHub token.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request


class GateError(Exception):
    """Only locally authored, credential-free diagnostic messages."""


repo, mr, token = sys.argv[1:]
try:
    # 新创建和复用都使用 iid；兼容宿主只保存 MR URL 的历史记录。
    if not mr.isdigit():
        path = urllib.parse.urlparse(mr).path.rstrip('/')
        match = re.search(r'/merge_requests/(\d+)$', path)
        if not match:
            raise GateError('MR 标识必须是 iid 或 MR URL')
        mr = match.group(1)
    project = urllib.parse.unquote(repo)
    api = os.environ.get('MFC_CODEHUB_API', 'https://codehub-y.example.com/api/v4').rstrip('/')
    url = api + '/projects/' + urllib.parse.quote(project, safe='') + '/merge_requests/' + mr
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(dict()))
    request = urllib.request.Request(url, headers=dict([('Private-Token', token)]))
    # 给适配器 30 秒的进程时限留出启动和输出时间。
    deadline = time.monotonic() + 25
    with opener.open(request, timeout=12) as response:
        detail = json.load(response)
    if not isinstance(detail, dict) or str(detail.get('iid', '')) != mr:
        raise GateError('MR 详情未返回匹配的 iid')
    state = detail.get('state')
    if state not in ('opened', 'merged', 'closed', 'locked'):
        raise GateError('MR 生命周期缺失或无效')
    # 已合入/已关闭时无需再查门禁，门禁故障也不能遮蔽生命周期事实。
    gates = dict()
    if state in ('opened', 'locked'):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('MR 查询超时')
        env = os.environ.copy()
        env['CODEHUB_TOKEN'] = token
        proc = subprocess.run(['codehub-cli', 'mr', 'gate', '--host',
            os.environ.get('MFC_CODEHUB_CLI_HOST', 'yellow'), '--project', project,
            mr, '--format', 'json', '-k'], env=env, capture_output=True,
            text=True, timeout=remaining)
        if proc.returncode != 0:
            raise GateError('MR 门禁查询失败，退出码 ' + str(proc.returncode))
        gates = json.loads(proc.stdout)
        if not isinstance(gates, dict) or not any(isinstance(value, bool) for key, value in gates.items() if key.endswith('_passed')):
            raise GateError('MR 门禁未返回预期的 *_passed 布尔字段')
    sha = detail.get('sha')
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-fA-F]{40}|[0-9a-fA-F]{64}', sha):
        raise GateError('MR 详情缺少有效的源提交 SHA')
    print(json.dumps(dict(mr_state=state, sha=sha, gates=gates), ensure_ascii=False))
except Exception as error:
    # urllib/CLI 异常可能包含请求信息，不回显原始内容及凭据。
    message = str(error) if isinstance(error, GateError) else type(error).__name__
    print('MR 状态查询失败: ' + message, file=sys.stderr)
    sys.exit(1)
