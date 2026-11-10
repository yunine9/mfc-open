import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("部署查询脚本遍历所有生命周期，精确过滤分支与 fork，失败不报空列表", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import http.server, threading, json, subprocess, os, urllib.parse
seen = []
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        seen.append(q)
        def row(i, source='task', target='main', **kw):
            return dict(iid=i, web_url='https://codehub/repo/merge_requests/'+str(i), source_branch=source, target_branch=target, **kw)
        rows = [row(1, state='merged'), row(2, state='opened'), row(3, source='other'), row(4, target='other'), row(5, source_project_id=8, target_project_id=9)]
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(rows).encode())
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    env = dict(os.environ, MFC_CODEHUB_API='http://127.0.0.1:'+str(server.server_port))
    call = ['python3', 'deploy/adapter-tools/mr-discover.py', 'group%2Frepo', 'task', 'main', 'secret-fixture']
    run = subprocess.run(call, capture_output=True, text=True, env=env, timeout=12)
    assert run.returncode == 0, run.stderr
    assert [row['id'] for row in json.loads(run.stdout)['mrs']] == [1, 2]
    assert seen[0]['state'] == ['all']
    env['MFC_CODEHUB_API'] = 'http://127.0.0.1:1'
    bad = subprocess.run(call, capture_output=True, text=True, env=env, timeout=12)
    assert bad.returncode != 0 and bad.stdout == ''
    assert 'secret-fixture' not in bad.stderr
finally:
    server.shutdown(); server.server_close()
`], { cwd: process.cwd(), encoding: "utf8", timeout: 25_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
