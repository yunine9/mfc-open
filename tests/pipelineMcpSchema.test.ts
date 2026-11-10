/**
 * 内网五网关 tools/list 的真实参数契约。Python 脚本是部署执行面，
 * 不能只靠 TypeScript typecheck；这里用假客户端直接跑策略函数，证明
 * 状态链和 artifacts 链发出的 tools/call 参数都不再是旧猜法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const HARNESS = String.raw`
import contextlib
import importlib.util
import io
import os
import pathlib
import sys
import tempfile

root = pathlib.Path.cwd()
tools = root / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))

import pipeline_log
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

assert project_info_arguments('https://codehub/group/repo') == {
    'git_url': 'https://codehub/group/repo', 'codehub_host': 'codehub'}
assert codehub_host_from_url('git@codehub.example:group/repo.git') \
    == 'codehub.example'
assert mergeable_state_arguments('42', '17', 'codehub.example') == {
    'request': {'project_id': '42', 'merge_request_iid': 17},
    'codehub_host': 'codehub.example'}
assert actual_head_pipeline_arguments(
        '42', '17', codehub_host='codehub.example') == {
    'request': {
        'project_id': '42', 'merge_request_iid': 17, 'show_job': True},
    'codehub_host': 'codehub.example'}
assert pipeline_quality_arguments(
        '42', '99', codehub_host='codehub.example') == {
    'request': {'project_id': '42', 'pipeline_id': 99},
    'codehub_host': 'codehub.example'}
assert unwrap_data({'data': {'id': 99}, 'is_valid': True}) == {
    'id': 99, 'is_valid': True}
assert unwrap_data({'data': None, 'is_valid': False}) == {'is_valid': False}
assert unwrap_data({'data': 'https://build/log.zip', 'success': True}) \
    == 'https://build/log.zip'
assert build_record_arguments('record-1', 'group-1') == {
    'record_id': 'record-1', 'group_id': 'group-1'}
assert coverage_arguments('job-1') == {'jobId': 'job-1'}
try:
    build_record_arguments('record-1', 'group-1', page=1)
    raise AssertionError('旧 page 猜参必须被共享契约拒绝')
except ValueError:
    pass


class FakeContext:
    def __init__(self):
        self.calls = []
        self.writes = {}
        self._w3token = ''

    def mcp_call(self, gateway, tool, arguments, timeout=60):
        self.calls.append((gateway, tool, arguments))
        return self._answer(tool)

    def call_tool(self, tool, arguments):
        self.calls.append(('codehub', tool, arguments))
        return self._answer(tool)

    def _answer(self, tool):
        if tool == 'get_project_info':
            return {'data': {'id': '42'}, 'is_valid': True}
        if tool == 'get_merge_request_mergeable_state':
            return {'data': {'ci_state_passed': False}, 'is_valid': True}
        if tool == 'get_merge_request_actual_head_pipeline':
            return {'data': {'id': 99, 'status': 'failed',
                             'sha': 'a' * 40}, 'is_valid': True}
        if tool == 'get_pipeline_quality':
            return {'data': {'codequality_check': []}, 'is_valid': True}
        if tool == 'get_build_log_url':
            return {}
        if tool == 'get_record_log':
            return {'log': 'compiler failure'}
        if tool in ('get_build_error_info', 'get_record_fullstages'):
            return {}
        if tool == 'CodeCovDiffCoverageTool':
            return {'diffCoverage': 80}
        raise AssertionError(f'unexpected tool {tool}')

    def fetch_json(self, *args, **kwargs):
        raise RuntimeError('force MCP project fallback')

    def write_json(self, name, value):
        self.writes[name] = value

    def write_text(self, name, value):
        self.writes[name] = value

    def log(self, message):
        pass

    def sse_client(self):
        class BrokenSse:
            def download_build_logs(self, *args):
                raise RuntimeError('force build MCP fallback')
        return BrokenSse()

    def sse_token(self):
        return 'fixture-token'


ctx = FakeContext()
data = pipeline_log.PipelineData(
    'group/repo', 'a' * 40, '',
    'https://codehub.example/group/repo/merge_requests/17')
pipeline_log.resolve_mr(data, ctx)
assert data.project_id == '42'
assert ctx.calls[-1] == (
    'codehub', 'get_project_info',
    {'git_url': 'https://codehub.example/group/repo',
     'codehub_host': 'codehub.example'})

data.pipeline_id = '99'
pipeline_log.strategy_pipeline_detail(data, ctx)
pipeline_log.strategy_mergeable_state(data, ctx)
pipeline_log.strategy_pipeline_quality(data, ctx)
assert ('codehub', 'get_merge_request_actual_head_pipeline', {
    'request': {
        'project_id': '42', 'merge_request_iid': 17,
        'show_job': True},
    'codehub_host': 'codehub.example'}) in ctx.calls
assert ('codehub', 'get_merge_request_mergeable_state', {
    'request': {'project_id': '42', 'merge_request_iid': 17},
    'codehub_host': 'codehub.example'}) in ctx.calls
assert ('codehub', 'get_pipeline_quality', {
    'request': {'project_id': '42', 'pipeline_id': 99},
    'codehub_host': 'codehub.example'}) in ctx.calls

data.record_ids = ['record-1']
data.x_auth_groups = 'group-1'
pipeline_log.strategy_build_logs(data, ctx)
build_calls = [call for call in ctx.calls if call[0] == 'build']
assert {call[1] for call in build_calls} == {
    'get_build_log_url', 'get_record_log',
    'get_build_error_info', 'get_record_fullstages'}
assert all(call[2].get('group_id') == 'group-1' for call in build_calls)
assert all('page' not in call[2] for call in build_calls)

data.ut_job_ids = ['job-1']
pipeline_log.strategy_coverage(data, ctx)
assert ctx.calls[-1] == (
    'codecov', 'CodeCovDiffCoverageTool', {'jobId': 'job-1'})
assert data.guessed == []

status_path = tools / 'pipeline-status-mcp.py'
spec = importlib.util.spec_from_file_location('pipeline_status_mcp', status_path)
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)

client = FakeContext()
assert status.resolve_project_id(
    client, 'https://codehub.example/group/repo.git',
    'codehub.example') == '42'
assert client.calls[-1] == (
    'codehub', 'get_project_info',
    {'git_url': 'https://codehub.example/group/repo.git',
     'codehub_host': 'codehub.example'})
picked = {}
status.enrich_from_quality(
    client, '42', '99', picked, 'codehub.example')
assert client.calls[-1] == (
    'codehub', 'get_pipeline_quality', {
        'request': {'project_id': '42', 'pipeline_id': 99},
        'codehub_host': 'codehub.example'})


class StatusClient(FakeContext):
    received_token = None
    received_w3token = None
    def __init__(self, token='', w3token='', **kwargs):
        super().__init__()
        StatusClient.received_token = token
        StatusClient.received_w3token = w3token
    def initialize(self):
        pass


with tempfile.TemporaryDirectory() as raw:
    mcp_file = pathlib.Path(raw) / 'mcp-token'
    mcp_file.write_text('mcp-gateway-token', encoding='utf-8')
    original_status_client = status.McpHttpClient
    original_argv = sys.argv
    status.McpHttpClient = StatusClient
    sys.argv = [
        'pipeline-status-mcp.py',
        '--repo', 'https://codehub.example/group/repo.git',
        '--sha', 'a' * 40,
        '--mr', '17',
        '--token', 'codehub-project-token',
        '--mcp-token-file', str(mcp_file),
    ]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            assert status.main() == 0
        assert StatusClient.received_token == 'mcp-gateway-token'
        assert StatusClient.received_w3token == ''
    finally:
        status.McpHttpClient = original_status_client
        sys.argv = original_argv
`;

test("所有 MCP 网关使用 tools/list 真实参数与独立令牌域", () => {
  const result = spawnSync("python3", ["-c", HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `Python MCP 契约回归失败：\n${result.stdout}\n${result.stderr}`);
});

const NO_DATA_HARNESS = String.raw`
import pathlib
import sys

tools = pathlib.Path.cwd() / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))
import pipeline_log

class Context:
    def __init__(self):
        self.writes = {}
    def mcp_call(self, gateway, tool, arguments, timeout=60):
        return 'No data found for jobId: CodeCheck20-fixture'
    def write_json(self, name, value):
        self.writes[name] = value
    def redact(self, value):
        return str(value)

data = pipeline_log.PipelineData('group/repo', 'a' * 40, '', '')
data.ut_job_ids = ['CodeCheck20-fixture']
ctx = Context()
try:
    pipeline_log.strategy_coverage(data, ctx)
    raise AssertionError('No data found 应显式跳过')
except pipeline_log.StrategySkipped as error:
    assert '未产生覆盖率' in str(error)
assert ctx.writes['coverage_summary.json'] == {
    'CodeCheck20-fixture':
        'empty: No data found for jobId: CodeCheck20-fixture'}
`;

test("CodeCov 带 jobId 的 No data found 记为未产生", () => {
  const result = spawnSync("python3", ["-c", NO_DATA_HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `Coverage 诚实性回归失败：\n${result.stdout}\n${result.stderr}`);
});

const TOKEN_REFRESH_HARNESS = String.raw`
import pathlib
import sys
import tempfile

tools = pathlib.Path.cwd() / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))
import mcp_http_client
import pipeline_log


class FakeClient:
    seen = []
    def __init__(self, url='', token='', w3token='', timeout=30):
        self.url = url
        self.token = token
        self.w3token = w3token
    def initialize(self):
        FakeClient.seen.append(('initialize', self.token))
        if self.token == 'stale-mcp-token':
            raise mcp_http_client.McpHttpError('网关 Token解析失败')
    def call_tool(self, name, arguments, timeout=60):
        FakeClient.seen.append((name, self.token))
        return {'token_seen': self.token}


with tempfile.TemporaryDirectory() as raw:
    root = pathlib.Path(raw)
    token_file = root / 'mcp-token'
    token_file.write_text('stale-mcp-token', encoding='utf-8')
    refresh = root / 'refresh-token.py'
    refresh.write_text(
        '#!/usr/bin/env python3\n'
        'from pathlib import Path\n'
        + f'Path({str(token_file)!r}).write_text('
          "'fresh-mcp-token', encoding='utf-8')\n",
        encoding='utf-8')
    refresh.chmod(0o700)

    pipeline_log.MCP_TOKEN_FILE = str(token_file)
    pipeline_log.MCP_TOKEN_REFRESH_COMMAND = str(refresh)
    pipeline_log.MCP_TOKEN_REFRESH_TIMEOUT = 5
    original_client = mcp_http_client.McpHttpClient
    mcp_http_client.McpHttpClient = FakeClient
    try:
        ctx = pipeline_log.Context(raw, 'codehub-personal-token', str(tools))
        result = ctx.mcp_call('build', 'get_record_log', {})
        assert result == {'token_seen': 'fresh-mcp-token'}
        assert FakeClient.seen[:3] == [
            ('initialize', 'stale-mcp-token'),
            ('initialize', 'fresh-mcp-token'),
            ('get_record_log', 'fresh-mcp-token'),
        ]
        codehub = ctx.mcp_call('codehub', 'get_project_info', {})
        assert codehub == {'token_seen': 'fresh-mcp-token'}
        codecheck = ctx.mcp_call('codecheck', 'query_mr_info', {})
        codecov = ctx.mcp_call('codecov', 'CodeCovDiffCoverageTool', {})
        assert codecheck == {'token_seen': 'fresh-mcp-token'}
        assert codecov == {'token_seen': 'fresh-mcp-token'}
        assert ctx.token == 'codehub-personal-token'

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self):
                return b'{}'
        class RestOpener:
            headers = {}
            def open(self, request, timeout=30):
                RestOpener.headers = {
                    key.lower(): value for key, value in request.header_items()}
                return Response()
        ctx.opener = RestOpener()
        assert ctx.fetch_json('https://codehub.example/api/v4/project') == {}
        assert RestOpener.headers['private-token'] \
            == 'codehub-personal-token'
        assert RestOpener.headers.get('x-auth-token') is None
        # 新旧令牌都必须进脱敏集，不能因刷新后只遮新值。
        assert '<token>' in ctx.redact(
            'stale-mcp-token fresh-mcp-token codehub-personal-token')
        assert 'stale-mcp-token' not in ctx.redact(
            'stale-mcp-token fresh-mcp-token codehub-personal-token')
        assert 'fresh-mcp-token' not in ctx.redact(
            'stale-mcp-token fresh-mcp-token codehub-personal-token')
    finally:
        mcp_http_client.McpHttpClient = original_client
`;

test("所有 HTTP MCP 均用 mcp-token，失效时只刷新重试一次", () => {
  const result = spawnSync("python3", ["-c", TOKEN_REFRESH_HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `MCP token 分域/刷新回归失败：\n${result.stdout}\n${result.stderr}`);
});

const EVIDENCE_HARNESS = String.raw`
import json
import pathlib
import sys
import tempfile

tools = pathlib.Path.cwd() / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))
import pipeline_log


class NoEvidenceContext:
    def __init__(self):
        self.writes = {}
        self._w3token = ''
    def sse_client(self):
        class Sse:
            def download_build_logs(self, *args):
                return [('record-1', None)]
        return Sse()
    def sse_token(self):
        return 'fixture-token'
    def mcp_call(self, gateway, tool, arguments, timeout=60):
        return {}
    def write_json(self, name, value):
        self.writes[name] = value
    def write_text(self, name, value):
        self.writes[name] = value
    def log(self, message):
        pass


data = pipeline_log.PipelineData('group/repo', 'a' * 40, '', '')
data.record_ids = ['record-1']
data.x_auth_groups = 'group-1'
try:
    pipeline_log.strategy_build_logs(data, NoEvidenceContext())
    raise AssertionError('构建各路全空不能被记成 ok')
except RuntimeError as error:
    assert '均未拿到' in str(error)


class FileContext:
    def __init__(self, root):
        self.root = pathlib.Path(root)
    def write_text(self, name, value):
        (self.root / name).write_text(value, encoding='utf-8')


with tempfile.TemporaryDirectory() as raw:
    ctx = FileContext(raw)
    evidence = set()
    long_log = ('normal build line\n' * 40000
                + 'Mml.cpp:91: fatal error: missing_header.h\n'
                + 'normal tail\n' * 40000)
    pipeline_log.write_build_log(ctx, 'record-1', long_log, evidence)
    excerpt = (pathlib.Path(raw) / 'build_error_excerpt_record-1.txt') \
        .read_text(encoding='utf-8')
    assert 'Mml.cpp:91: fatal error: missing_header.h' in excerpt

with tempfile.TemporaryDirectory() as raw:
    root = pathlib.Path(raw)
    ctx = FileContext(raw)
    # issue 414：前面的普通 ERROR 超过旧版 200 条上限，真正的 UT
    # 失败处在 3 MiB 日志中段；gcovr 在末尾只是后续报错。
    nl = chr(10)
    failed_cases = ''.join(
        f'[  FAILED  ] ServiceSuite.Case{i} (1 ms)' + nl
        for i in range(28))
    long_log = (('[ERROR] build notice' + nl) * 240
                + ('ordinary build output 0123456789' + nl) * 44000
                + failed_cases
                + 'Run: 59 Failure total: 28 Failures: 28 Errors: 0' + nl
                + 'ERROR mssage: Test case failed. Run: 59 Failure total: 28' + nl
                + ('ordinary coverage output 0123456789' + nl) * 44000
                + 'gcovr exit 22' + nl + 'BuildState.FAILED' + nl)
    pipeline_log.write_build_log(ctx, '3DFH4HMK-6M4C', long_log, set())
    excerpt = (root / 'build_error_excerpt_3DFH4HMK-6M4C.txt') \
        .read_text(encoding='utf-8')
    assert '测试失败原文' in excerpt
    assert 'Failure total: 28' in excerpt
    assert 'Test case failed' in excerpt
    assert all(f'ServiceSuite.Case{i}' in excerpt for i in range(28)), \
        '28 个失败用例的名称都要进入摘要，不能被前面的通用 ERROR 挤掉'
    assert 'gcovr exit 22' not in excerpt or \
        excerpt.index('Test case failed') < excerpt.index('gcovr exit 22')
    items = pipeline_log.collect_output_items(raw)
    mirrored = {item['name']: item['text'] for item in items}
    assert mirrored['build_log_3DFH4HMK-6M4C.txt'] == long_log, \
        '3 MiB 构建日志放得进总包时不应截成 512 KiB'
    assert 'Test case failed' in mirrored['build_error_excerpt_3DFH4HMK-6M4C.txt']
    assert len(json.dumps(items, ensure_ascii=False).encode('utf-8')) \
        <= pipeline_log.MAX_BUNDLE_BYTES
    assert not pipeline_log.UT_FAILURE_PATTERN.search('Failure total: 0')

with tempfile.TemporaryDirectory() as raw:
    # 首尾各 20 条不足以覆盖大批量失败；所有用例名应进入摘要。
    failures = ''.join(
        f'[  FAILED  ] ServiceSuite.Case{i}' + chr(10)
        for i in range(60))
    pipeline_log.write_build_log(FileContext(raw), 'many-cases', failures, set())
    excerpt = (pathlib.Path(raw) / 'build_error_excerpt_many-cases.txt') \
        .read_text(encoding='utf-8')
    assert all(f'ServiceSuite.Case{i}' in excerpt for i in range(60))

for language, log, expected in [
    ('Java Maven', '[ERROR] Tests run: 3, Failures: 1, Errors: 0' + chr(10)
     + '[ERROR] ExampleServiceTest.testInvalidInput:42 expected 200 but was 500',
     'ExampleServiceTest.testInvalidInput'),
    ('Java Gradle', 'ExampleServiceTest > rejectsInvalidInput FAILED',
     'rejectsInvalidInput'),
    ('JS Jest', 'FAIL src/service.test.js' + chr(10)
     + '  ● Service > handles rejected response' + chr(10)
     + 'Tests: 1 failed, 4 passed', 'handles rejected response'),
    ('JS Vitest', 'Test Files 1 failed' + chr(10)
     + ' × should reject invalid input' + chr(10)
     + 'Tests 1 failed', 'should reject invalid input'),
    ('JS Mocha', '2 failing' + chr(10)
     + '  1) Service returns error' + chr(10)
     + '  2) Service releases connection', 'Service releases connection'),
    ('Python pytest', 'FAILED tests/test_service.py::TestService::test_reject - AssertionError',
     'TestService::test_reject'),
    ('Go test', '--- FAIL: TestServiceReject (0.01s)', 'TestServiceReject'),
    ('Rust cargo test', 'test service::tests::reject ... FAILED', 'service::tests::reject'),
    ('NET test', 'Failed Product.ServiceTests.Reject [3 ms]',
     'Product.ServiceTests.Reject'),
]:
    with tempfile.TemporaryDirectory() as raw:
        pipeline_log.write_build_log(FileContext(raw), language, log, set())
        excerpt = (pathlib.Path(raw) / f'build_error_excerpt_{language}.txt') \
            .read_text(encoding='utf-8')
        assert expected in excerpt, f'{language} 的失败用例没有进入摘要'

with tempfile.TemporaryDirectory() as raw:
    root = pathlib.Path(raw)
    # 把预算缩小，仅验证超预算时优先保留结构化材料和省略清单。
    actual_budget = pipeline_log.MAX_BUNDLE_BYTES
    pipeline_log.MAX_BUNDLE_BYTES = 4 * 1024 * 1024
    (root / 'pipeline_log_summary.json').write_text(
        json.dumps({'strategies': {'build-logs': {'status': 'ok'}}}),
        encoding='utf-8')
    (root / 'codecheck_detail.json').write_text(
        json.dumps({'file': 'src/a.cpp', 'line': 17,
                    'rule': 'G.FUN.01-CPP', 'message': 'bad function'}),
        encoding='utf-8')
    (root / 'build_errors_record-1.json').write_text(
        json.dumps({'file': 'src/b.cpp', 'line': 9,
                    'message': 'undefined reference'}), encoding='utf-8')
    for index in range(20):
        (root / f'build_log_{index}.txt').write_text(
            f'log {index}\n' + ('x' * 600000), encoding='utf-8')
    items = pipeline_log.collect_output_items(raw)
    names = [item['name'] for item in items]
    assert names[0] == 'pipeline_log_summary.json'
    assert 'codecheck_detail.json' in names
    assert 'build_errors_record-1.json' in names
    assert 'pipeline_artifacts_omitted.json' in names
    assert len(json.dumps(items, ensure_ascii=False).encode('utf-8')) \
        <= pipeline_log.MAX_BUNDLE_BYTES
    manifest = json.loads(next(
        item['text'] for item in items
        if item['name'] == 'pipeline_artifacts_omitted.json'))
    assert any(row['name'].startswith('build_log_')
               for row in manifest['files'])
    pipeline_log.MAX_BUNDLE_BYTES = actual_budget
`;

test("构建证据全空不报成功，长日志保留错误片段且总包不撞上限", () => {
  const result = spawnSync("python3", ["-c", EVIDENCE_HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `流水线证据预算回归失败：\n${result.stdout}\n${result.stderr}`);
});
