/**
 * 部署脚本的 run 顺序契约：对外一律旧→新，宿主只认 runs.at(-1)。
 * 这里真跑 pipeline-status.sh 的内嵌 Python，并直接跑 artifacts 编排器
 * 的 REST 降级，防止代码评审只改文档、真实执行件仍挑历史终态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const HARNESS = String.raw`
import http.server
import json
import os
import pathlib
import subprocess
import sys
import threading
import urllib.parse

root = pathlib.Path.cwd()
tools = root / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(tools))
import pipeline_log

sha = 'a' * 40
seen_queries = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.endswith('/pipelines'):
            query = urllib.parse.parse_qs(parsed.query)
            seen_queries.append(query)
            # 同一 SHA 有 8 次重跑。asc + per_page=5 只会拿到最老五条；
            # desc 才会取得最新五条，再由脚本按 id 归一成旧→新。
            all_runs = [
                {'id': 10, 'sha': sha, 'status': 'success', 'ref': ''},
                {'id': 20, 'sha': sha, 'status': 'failed', 'ref': ''},
                {'id': 30, 'sha': sha, 'status': 'success', 'ref': ''},
                {'id': 40, 'sha': sha, 'status': 'failed', 'ref': ''},
                {'id': 50, 'sha': sha, 'status': 'success', 'ref': ''},
                {'id': 60, 'sha': sha, 'status': 'failed', 'ref': ''},
                {'id': 70, 'sha': sha, 'status': 'success', 'ref': ''},
                {'id': 80, 'sha': sha, 'status': 'running', 'ref': ''},
            ]
            if query.get('sort') == ['desc']:
                all_runs.reverse()
            per_page = int(query.get('per_page', ['20'])[0])
            payload = all_runs[:per_page]
        elif parsed.path.endswith('/jobs'):
            payload = {'stages': []}
        elif '/pipelines/' in parsed.path:
            pipeline_id = int(parsed.path.rsplit('/', 1)[-1])
            payload = {'id': pipeline_id, 'ref': ''}
        else:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    env = os.environ.copy()
    env['MFC_CODEHUB_API'] = (
        f'http://127.0.0.1:{server.server_address[1]}/api/v4')
    completed = subprocess.run(
        ['bash', str(tools / 'pipeline-status.sh'),
         'group%2Frepo', sha, 'fixture-token'],
        cwd=root, env=env, text=True, capture_output=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    runs = json.loads(completed.stdout)
    assert [run['pipeline_id'] for run in runs] == [
        '40', '50', '60', '70', '80']
    assert runs[-1]['status'] == 'running'
    assert seen_queries and seen_queries[0].get('sort') == ['desc']
    assert seen_queries[0].get('per_page') == ['5']
finally:
    server.shutdown()
    server.server_close()


class RestFallbackContext:
    def __init__(self):
        self.writes = {}
        self.fetches = []

    def mcp_call(self, *_args, **_kwargs):
        raise RuntimeError('force REST fallback')

    def fetch_json(self, url, *_args, **_kwargs):
        self.fetches.append(url)
        if '/pipelines?' in url:
            # 无序返回且旧 failed/success 在场；数字 id 最大者是最新
            # running，artifact 降级不得越过它挑历史终态。
            return [
                {'id': 10, 'sha': sha, 'status': 'failed'},
                {'id': 30, 'sha': sha, 'status': 'running'},
                {'id': 20, 'sha': sha, 'status': 'success'},
            ]
        if url.endswith('/pipelines/30/jobs'):
            return []
        raise AssertionError(f'unexpected REST fetch: {url}')

    def write_json(self, name, value):
        self.writes[name] = value

    def log(self, _message):
        pass


ctx = RestFallbackContext()
data = pipeline_log.PipelineData('group/repo', sha, '', '')
data.project_id = '42'
data.mr_iid = 17
pipeline_log.strategy_pipeline_detail(data, ctx)
assert data.pipeline_id == 30
assert data.pipeline_status == 'running'
assert data.commit_id == sha
assert ctx.writes['pipeline_detail.json']['pipeline']['id'] == 30
assert any(url.endswith('/pipelines/30/jobs') for url in ctx.fetches)
assert not any(url.endswith('/pipelines/10/jobs') for url in ctx.fetches)
`;

test("部署降级链保持旧→新顺序，最新 running 不被历史终态越过", () => {
  const result = spawnSync("python3", ["-c", HARNESS], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 45_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0,
    `流水线顺序契约回归失败：\n${result.stdout}\n${result.stderr}`);
});
