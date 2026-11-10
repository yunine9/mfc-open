import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { PlatformAdapter } from "../src/platformAdapter.ts";
import { parsePipelineStatus } from "../src/pipelineClient.ts";

const script = resolve("deploy/adapter-tools/pipeline-status.sh");
const sha = "a".repeat(40);
const token = "query-fixture-secret";
type ResponseMode = { status?: number; body?: string; disconnect?: boolean; logs?: Array<[string, string]> };

async function fixture(t: TestContext, mode: ResponseMode) {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-query-failure-"));
  const cli = join(directory, "codehub-cli");
  // 不调用真实 CodeHub CLI；可选质量信息获取失败不应抹掉已查到的运行事实。
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '${token}: optional quality unavailable' >&2\nexit 1\n`);
  chmodSync(cli, 0o755);
  if (mode.logs) {
    writeFileSync(join(directory, "logs.json"), JSON.stringify(mode.logs));
    writeFileSync(join(directory, "mcp-token"), "fixture");
    writeFileSync(join(directory, "mcp_sse_client.py"), `import json, pathlib
class SSEMcpClient:
    def __init__(self, *args): pass
    def connect(self): pass
    def initialize(self): pass
    def close(self): pass
    def get_mr_pipeline_info(self, mr):
        return {'defects': [{'toolName':'build2.0','record_ids':['fixture'],'x_auth_groups':['group']}]}
    def download_build_logs(self, *args):
        return json.loads(pathlib.Path(__file__).with_name('logs.json').read_text())
`);
  }
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    assert.equal(req.headers["private-token"], token);
    if (mode.disconnect) { req.socket.destroy(); return; }
    const listing = new URL(req.url!, "http://fixture").pathname.endsWith("/pipelines");
    if (mode.logs && !listing) {
      const payload = req.url!.includes("/merge_requests?") ? [{ web_url: "https://example.test/mr/1" }]
        : req.url!.endsWith("/jobs") ? { stages: [] } : { ref: "feature" };
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(listing ? mode.status ?? 200 : 503, { "content-type": "application/json" });
    res.end(listing ? mode.body ?? "[]" : '{"error":"optional information unavailable"}');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  });
  // 将假密钥放入测试 URL，以验证错误摘要和 adapter 日志都经过脱敏。
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/${token}/api/v4`;
  const command = ["env", `MFC_CODEHUB_API=${api}`, `PATH=${directory}:${process.env.PATH}`,
    `MFC_MCP_CLIENT_DIR=${directory}`, `MFC_MCP_TOKEN_FILE=${join(directory, "mcp-token")}`,
    "PYTHONDONTWRITEBYTECODE=1", "bash", script, "{repo_path}", "{sha}", "{token}"];
  const run = () => new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>(done => {
    execFile(command[0], [...command.slice(1, -3), "group%2Frepo", sha, token],
      { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) =>
        done({ code: error ? error.code : 0, stdout, stderr }));
  });
  const adapter = (fallback = false) => {
    const settings = JSON.parse(readFileSync("deploy/adapter-config/adapter.codehub.json", "utf8"));
    settings.token = token;
    settings.pipeline_status.command = command;
    if (fallback) settings.pipeline_status = { candidates: [settings.pipeline_status, {
      command: [process.execPath, "-e", `process.stdout.write(JSON.stringify([{status:'running',sha:'${sha}'}]))`],
      status: { json: "status" }, run_sha: { json: "sha" },
    }] };
    const path = join(directory, "adapter.json");
    writeFileSync(path, JSON.stringify(settings));
    const logs: string[] = [];
    return { instance: new PlatformAdapter(path, line => logs.push(line)), logs };
  };
  return { run, adapter, requests };
}

for (const status of [401, 403, 500, 503]) test(`流水线列表 HTTP ${status} 明确失败，不冒充空列表`, async t => {
  const f = await fixture(t, { status });
  const result = await f.run();
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`HTTP ${status}`));
  assert.ok(!result.stderr.includes(token), "查询错误必须脱敏");
});

for (const [name, mode] of Object.entries({
  "网络断开": { disconnect: true },
  "JSON 损坏": { body: "{broken" },
  "null": { body: "null" },
  "错误对象": { body: '{"error":"not a pipeline list"}' },
  "布尔值": { body: "false" },
})) test(`流水线列表${name}不能当成不存在运行`, async t => {
  const f = await fixture(t, mode);
  const result = await f.run();
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /流水线列表/);
  assert.ok(!result.stderr.includes(token));
});

test("真实成功空列表经 adapter 仍为 not_found", async t => {
  const f = await fixture(t, { body: "[]" });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  const { instance } = f.adapter();
  const response = await instance.handle("POST", "/pipeline/trigger", new URLSearchParams(),
    { repo: "https://codehub.example/group/repo.git", sha }, {});
  assert.deepEqual(parsePipelineStatus(response.payload as Record<string, unknown>), { status: "not_found", runs: [] });
});

test("主列表查询失败使真实 adapter 尝试下一个候选，错误日志脱敏", async t => {
  const f = await fixture(t, { status: 401 });
  const query = new URLSearchParams({ repo: "https://codehub.example/group/repo.git", sha });
  await assert.rejects(f.adapter().instance.handle("GET", "/pipeline/status", query, {}, {}), error => {
    assert.match(String(error), /HTTP 401/);
    assert.ok(!String(error).includes(token));
    return true;
  });
  const { instance, logs } = f.adapter(true);
  const response = await instance.handle("GET", "/pipeline/status", query, {}, {});
  assert.equal(parsePipelineStatus(response.payload as Record<string, unknown>).status, "running");
  assert.match(logs.join("\n"), /候选\[0\].*失败/);
  assert.ok(!logs.join("\n").includes(token));
});

test("附属质量和日志读取失败仍保留真实流水线结果", async t => {
  const f = await fixture(t, { body: JSON.stringify([{ id: 42, sha, status: "failed" }]) });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const [run] = JSON.parse(result.stdout);
  assert.equal(run.status, "failed");
  assert.equal(run.sha, sha);
  assert.deepEqual(run.checks, []);
  assert.match(result.stderr, /quality.*rc=1/);
  assert.match(result.stderr, /HTTP 503/);
  assert.ok(f.requests.some(url => url.endsWith("/jobs")));
  assert.ok(f.requests.some(url => url.endsWith("/pipelines/42")));
  assert.ok(!result.stderr.includes(token));
});

test("#583 单个及多个长 job 汇总后，保留中间 job 的命令和失败原文", async t => {
  const noise = "devtest_hdt.sh " + "x".repeat(150) + "\n";
  const logs: Array<[string, string]> = ["one", "two", "three"].map(id => [id,
    noise.repeat(93) + `python access_control_${id}.py\nexit code 1, Error message is empty (${id})\n`
    + noise.repeat(95) + "构建失败=1"]);
  const f = await fixture(t, { body: JSON.stringify([{ id: 42, sha, status: "failed" }]), logs });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const summary: string = JSON.parse(result.stdout)[0].fail_summary;
  assert.ok(summary.length <= 8000);
  for (const [id] of logs) {
    assert.ok(summary.includes(`access_control_${id}.py`), id);
    assert.ok(summary.includes(`Error message is empty (${id})`), id);
  }
});
