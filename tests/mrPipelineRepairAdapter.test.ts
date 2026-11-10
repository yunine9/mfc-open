import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformAdapter } from "../src/platformAdapter.ts";

const url = "https://codehub.test/group/repo/merge_requests/12";
const mr = { url, iid: "12", repo: "https://codehub.test/group/repo.git", title: "fix", source_branch: "feature", target_branch: "main", sha: "a".repeat(40), state: "opened" };

test("MR 详情端点返回权威仓库和分支；详情不完整不能导入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-detail-adapter-"));
  try {
    const merged = { ...mr, state: "merged", base_sha: "b".repeat(40), merged_at: "2026-10-31T08:15:00.000Z" };
    for (const output of [mr, merged, { ...mr, repo: "" }, { ...mr, iid: "99" }]) {
      const config = JSON.parse(readFileSync("deploy/adapter-config/adapter.codehub.json", "utf8"));
      config.mr_detail.command = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`];
      config.token = "fixture-token";
      const file = join(dir, "adapter.json"); writeFileSync(file, JSON.stringify(config));
      const adapter = new PlatformAdapter(file, () => {});
      if (output === mr || output === merged) assert.deepEqual((await adapter.handle("GET", "/mr/detail", new URLSearchParams({ mr_url: url }), {}, {})).payload, output);
      else await assert.rejects(adapter.handle("GET", "/mr/detail", new URLSearchParams({ mr_url: url }), {}, {}));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MR 详情部署桥读取源仓库地址，拒绝跨平台、fork 和跳转，不泄露凭据", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import http.server, threading, json, subprocess, os, urllib.parse
mode = 'normal'
seen = []
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append((self.path, self.headers.get('Private-Token')))
        if mode == 'redirect':
            self.send_response(302); self.send_header('Location', 'https://external.test/steal'); self.end_headers(); return
        origin = 'http://127.0.0.1:' + str(self.server.server_port)
        value = dict(id=8, http_url_to_repo=origin + '/group/repo.git') if self.path.endswith('/projects/8') else dict(
            iid=12, web_url=origin+'/group/repo/merge_requests/12', source_project_id=8,
            target_project_id=9 if mode == 'fork' else 8, title='fix', source_branch='feature', target_branch='main', sha='a'*40, state='merged', merged_at='2026-10-31T08:15:00Z',
            diff_refs=dict(base_sha='b'*40, head_sha=('d' if mode == 'stale' else 'a')*40))
        if '/versions?' in self.path:
            value = [dict(head_commit_sha='c'*40, base_commit_sha='e'*40), dict(head_commit_sha='d'*40, base_commit_sha='f'*40)]
            if mode == 'ambiguous' and self.path.endswith('page=1'):
                value = value * 50
            elif mode == 'ambiguous':
                value.append(dict(head_commit_sha='c'*40, base_commit_sha='f'*40))
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    origin = 'http://127.0.0.1:' + str(server.server_port)
    env = dict(os.environ, MFC_CODEHUB_API=origin+'/api/v4')
    call = ['python3', 'deploy/adapter-tools/mr-detail.py', origin+'/group/repo/merge_requests/12', 'secret-fixture']
    run = subprocess.run(call, capture_output=True, text=True, env=env, timeout=12)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout)['repo'] == origin+'/group/repo.git'
    assert json.loads(run.stdout)['base_sha'] == 'b'*40 and json.loads(run.stdout)['merged_at'] == '2026-10-31T08:15:00Z'
    assert len(seen) == 2 and all(row[1] == 'secret-fixture' for row in seen)
    mode = 'stale'
    run = subprocess.run(call, capture_output=True, text=True, env=env, timeout=12)
    assert run.returncode == 0 and json.loads(run.stdout)['base_sha'] is None
    for mode in ['normal', 'ambiguous']:
        run = subprocess.run(call + ['c'*40], capture_output=True, text=True, env=env, timeout=12)
        assert run.returncode == 0, run.stderr
        assert json.loads(run.stdout)['version'] == (dict(head='c'*40, base='e'*40) if mode == 'normal' else None)
    for mode in ['fork', 'redirect']:
        run = subprocess.run(call, capture_output=True, text=True, env=env, timeout=12)
        assert run.returncode != 0 and run.stdout == '' and 'secret-fixture' not in run.stderr
    count = len(seen)
    bad = subprocess.run(call[:2] + ['https://external.test/group/repo/merge_requests/12', 'secret-fixture'], capture_output=True, text=True, env=env, timeout=12)
    assert bad.returncode != 0 and len(seen) == count and 'secret-fixture' not in bad.stderr
finally:
    server.shutdown(); server.server_close()
`], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
