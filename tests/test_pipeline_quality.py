"""Issue #393: 执行实际部署脚本，报告状态不能伪装 UT 执行。"""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

TOOLS = Path(__file__).resolve().parents[1] / 'deploy' / 'adapter-tools'
sys.path.insert(0, str(TOOLS))
from pipeline_checks import quality_check, merge_check, report_only
spec = importlib.util.spec_from_file_location('status_mcp', TOOLS / 'pipeline-status-mcp.py')
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)

REPORT = {'tool': 'CPP_UT', 'stage': 'Review Tips', 'status': 'success',
          'metrics': [{'field': 'ut_json', 'real': 'https://example.invalid/ut.json', 'exceeded': False}]}
BUILD = {'tool': 'CloudBuild2.0', 'stage': 'CodeCheck2.0', 'status': 'failed',
         'metrics': [{'field': '构建失败', 'real': 1, 'expected': 0, 'exceeded': True},
                     {'field': 'DT', 'real': 2, 'expected': 0, 'exceeded': True}]}


class QualityTests(unittest.TestCase):
    def test_report_and_execution_are_distinct(self):
        for row in [REPORT, {k: v for k, v in REPORT.items() if k != 'stage'},
                    {'tool': 'CPP_UT', 'status': 'success'},
                    {**REPORT, 'status': 'failed'}]:
            self.assertIsNone(quality_check(row, mcp.CHECK_STATUS))
        checks = mcp.checks_from_stages([
            {'name': 'Review Tips', 'jobs': [{'name': 'CPP_UT', 'status': 'success'}]},
            {'name': 'CodeCheck2.0', 'jobs': [{'name': 'unit-test', 'status': 'skipped'}]},
        ])
        self.assertEqual(checks['UT']['status'], 'skipped')
        self.assertEqual(mcp.checks_from_stages([
            {'name': 'compile', 'jobs': [{'name': 'job-123', 'status': 'success'}]},
        ])['COMPILE']['status'], 'success')
        self.assertIsNone(quality_check({**REPORT, 'tool': 'CodeCheck'}, mcp.CHECK_STATUS))

    def test_independent_ut_survives_compile_failure(self):
        for status in ['success', 'failed', 'skipped', 'not_run']:
            picked = mcp.checks_from_stages([{'name': 'CodeCheck2.0', 'jobs': [
                {'name': 'CPP_UT', 'status': status},
                {'name': 'CloudBuild2.0', 'status': 'failed'}]}])
            class Client:
                def call_tool(self, *args):
                    return {'checks': [REPORT, BUILD]}
            notes = []
            mcp.enrich_from_quality(Client(), '1', '2', picked, 'example', notes)
            self.assertEqual(picked['UT']['status'], status)
            self.assertEqual(picked['COMPILE']['status'], 'failed')
            self.assertEqual(len(picked['COMPILE']['details']), 2)
            self.assertIn('不能据此判断', notes[0])

    def test_metrics_merge_even_on_equal_status(self):
        picked = {'COMPILE': {'dimension': 'COMPILE', 'status': 'failed', 'job': 'build'}}
        candidate = quality_check(BUILD, mcp.CHECK_STATUS)
        merge_check(picked, candidate)
        merge_check(picked, candidate)
        self.assertEqual(len(picked['COMPILE']['details']), 2)
        self.assertIn('DT=2', picked['COMPILE']['details'][1]['message'])
        self.assertEqual(picked['COMPILE']['job'], 'build')
        # 明确超限不被工具总体 success 掩盖。
        self.assertEqual(quality_check({**BUILD, 'status': 'success'}, mcp.CHECK_STATUS)['status'], 'failed')
        passing = {'tool': 'CPP_UT', 'status': 'success', 'metrics': [
            {'field': 'coverage', 'real': 90, 'expected': 80, 'exceeded': False}]}
        self.assertEqual(quality_check(passing, mcp.CHECK_STATUS)['status'], 'success')
        self.assertFalse(report_only(passing))

    def test_real_shell_adapter_report_only_and_parallel_execution(self):
        stages = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.endswith('/jobs'):
                    payload = {'stages': stages}
                elif '/pipelines?' in self.path:
                    payload = [{'id': 1, 'status': 'failed', 'sha': 'a' * 40}]
                else:
                    payload = {'id': 1, 'ref': ''}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='pipeline393-') as directory:
                cli = Path(directory) / 'codehub-cli'
                cli.write_text('#!/usr/bin/env python3\nprint(' + repr(json.dumps({'checks': [REPORT, BUILD]})) + ')\n')
                cli.chmod(0o755)
                env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                       'MFC_CODEHUB_API': f'http://127.0.0.1:{server.server_port}',
                       # 现场可覆盖 MCP 客户端目录，共用解析器仍应从部署脚本旁加载。
                       'MFC_MCP_CLIENT_DIR': directory, 'PYTHONDONTWRITEBYTECODE': '1'}
                for actual in [None, 'success', 'skipped']:
                    stages[:] = [{'name': 'Review Tips', 'jobs': [{'name': 'CPP_UT', 'status': 'success'}]}]
                    if actual:
                        stages.append({'name': 'tests', 'jobs': [{'name': 'CPP_UT', 'status': actual}]})
                    result = subprocess.run(['bash', str(TOOLS / 'pipeline-status.sh'), 'repo', 'a' * 40, 'fake'],
                                            env=env, text=True, capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    run = json.loads(result.stdout)[0]
                    checks = {c['dimension']: c for c in run['checks']}
                    if actual:
                        self.assertEqual(checks['UT']['status'], actual)
                    else:
                        self.assertNotIn('UT', checks)
                    self.assertIn('DT=2', str(checks['COMPILE']['details']))
                    self.assertIn('DT=2', run['fail_summary'])
                    self.assertIn('不能据此判断', run['fail_summary'])
                    self.assertEqual(run['status'], 'failed')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
