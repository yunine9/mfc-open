import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PlatformAdapter } from "../src/platformAdapter.ts";

const directory = resolve("deploy/adapter-config");
const config = JSON.parse(readFileSync(join(directory, "adapter.codehub.json"), "utf8"));
const sha = "a".repeat(40);

async function fixture(section: string, output: unknown, operation: (adapter: PlatformAdapter) => Promise<void>) {
  const temp = mkdtempSync(join(tmpdir(), "mr-config-test-"));
  try {
    const settings = structuredClone(config);
    settings.token = "fixture-token";
    const cli = join(temp, "cli.cjs");
    writeFileSync(cli, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    settings[section].command = [process.execPath, cli];
    if (section === "mr_create") delete settings.mr_lookup;
    const file = join(temp, "adapter.json");
    writeFileSync(file, JSON.stringify(settings));
    await operation(new PlatformAdapter(file, () => {}));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const query = new URLSearchParams({ repo: "https://codehub-y.example.com/g/r.git", mr: "2931" });

test("deployment gate lifecycle, SHA and failed gate stay independent", async () => {
  for (const state of ["opened", "merged", "closed"]) {
    await fixture("mr_gates", { mr_state: state, sha,
      gates: { state: false, merge_status: "cannot_be_merged", ci_state_passed: false,
        reason: { ci_state_passed: "compile failed" } } }, async (adapter) => {
      const result = await adapter.handle("GET", "/mr/gates", query, {}, {});
      assert.deepEqual(result.payload, { mr_state: state, sha,
        gates: [{ name: "ci_state_passed", passed: false, detail: "compile failed" }] });
    });
  }
  await fixture("mr_gates", {mr_state: "merged", gates: {}}, async (adapter) => {
    await assert.rejects(adapter.handle("GET", "/mr/gates", query, {}, {}), /SHA/);
  });
});

test("自动触发入口查询真实流水线，空记录不伪造 running", async () => {
  assert.deepEqual(config.pipeline_trigger, { observe_only: true });
  for (const output of [[], [{sha, id: 1, status: "failed", checks: []}], [{sha, id: 1, status: "success", checks: []}]]) {
    await fixture("pipeline_status", output, async (adapter) => {
      const result = await adapter.handle("POST", "/pipeline/trigger", query,
        {sha, repo: "https://codehub-y.example.com/g/r.git"}, {});
      const runs = (result.payload as { runs: Array<{ status: string }> }).runs;
      assert.deepEqual(runs.map(run => run.status), output.map(run => run.status));
    });
  }
});

test("MR creation and lookup return the same iid, not global id", async () => {
  const mr = {web_url: "https://codehub-y.example.com/g/r/merge_requests/2931", iid:2931, id:888888};
  for (const endpoint of ["mr_create", "mr_lookup"]) {
    await fixture(endpoint, endpoint === "mr_lookup" ? [mr] : mr, async (adapter) => {
      const result = await adapter.handle("POST", "/mr", query, {}, {});
      assert.deepEqual(result.payload, {url:mr.web_url, id:"2931"});
    });
  }
});

test("deployment discussion query uses CodeHub review list and flattens the first note", async () => {
  const raw = [{
    id: "discussion-3384-1",
    severity: "major",
    notes: [{
      updated_at: "2026-09-12T09:30:00Z",
      id: 12345,
      diff_file: "src/Service.cpp",
      position: { new_line: 42 },
      author: { username: "w30009735", name: "显示名不能代替账号" },
      body: "虚拟化场景应执行 queryENE.sh 获取等效数",
    }],
  }];
  assert.deepEqual(config.mr_discussions.command, [
    "codehub-cli", "mr", "review", "list", "--host", "yellow",
    "--project", "{repo}", "{mr}", "--token", "{token}",
    "--format", "json", "--limit", "100", "-k",
  ]);
  assert.equal(config.mr_discussions.timeout_s, 30);
  assert.deepEqual(config.mr_discussions.items, { json: "" });
  await fixture("mr_discussions", raw, async (adapter) => {
    const result = await adapter.handle("GET", "/mr/discussions", query, {}, {});
    assert.deepEqual(result.payload, { discussions: [{
      id: "discussion-3384-1", revision: 12345, severity: "major",
      updated_at: "2026-09-12T09:30:00Z",
      file: "src/Service.cpp",
      line: 42,
      author: "w30009735",
      body: "虚拟化场景应执行 queryENE.sh 获取等效数",
    }] });
  });
});

test("portable patch matches full configuration and every script is in this repo", () => {
  const patch = JSON.parse(readFileSync(join(directory, "mr-pipeline.patch.json"), "utf8"));
  const { port, ...endpoints } = config;
  assert.equal(port, 8790);
  assert.deepEqual(JSON.parse(JSON.stringify(patch).replaceAll("@REPO_DIR@", "/data/mae-flow-cloud/repo")), endpoints);
  for (const name of ["mr_create", "mr_create_knowledge"]) {
    assert.deepEqual(config[name].command.slice(0, 3), ["codehub-cli", "mr", "create"]);
    assert.deepEqual(config[name].participant_flags, {
      reviewers: "--approval-reviewers", approval_approvers: "--approval-approvers",
    });
  }
  assert.equal(Object.hasOwn(config, "mr_participants"), false);
  assert.deepEqual(config.mr_approver_members.command, ["codehub-cli", "project", "member", "list",
    "--host", "yellow", "-p", "{repo}", "--token", "{token}", "--format", "json", "-k"]);
  assert.deepEqual(config.mr_approver_members.fields, { username: { json: "username" }, access_level: { json: "access_level" } });
  assert.equal(config.mr_approver_members.timeout_s, 15);
  for (const name of ["pipeline_status", "pipeline_artifacts", "mr_discover", "mr_gates"]) {
    const script = config[name].command[1].replace("/data/mae-flow-cloud/repo/", "");
    assert(readFileSync(script).length > 0);
  }
});

test("discussion host timeout leaves room for the configured CLI budget", async (t) => {
  const { fetchMrDiscussions } = await import("../src/mrDiscussions.ts");
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert(milliseconds > config.mr_discussions.timeout_s * 1000,
      "the host must not abort before the adapter command budget expires");
    return timeout(milliseconds);
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ discussions: [] })));
  assert.deepEqual(await fetchMrDiscussions({ platformUrl: "http://adapter", repo: "g/r",
    delivery: { mr_id: 3384 } }), { kind: "available", items: [] });
});

test("#583 MR 门禁宿主等待时间覆盖升级后的适配器预算", async t => {
  const { fetchMrGates } = await import("../src/mrGateClient.ts");
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert(milliseconds > config.mr_gates.timeout_s * 1000);
    return timeout(milliseconds);
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ mr_state: "opened", gates: [] })));
  const view = await fetchMrGates({ platformUrl: "http://adapter", repo: "g/r", headers: {},
    requireExisting: true, delivery: { mr_id: 1 } });
  assert.equal(view?.mrState, "opened");
});

test("deployment merge tool cannot produce a config missing MR discovery or discussions", () => {
  const temp = mkdtempSync(join(tmpdir(), "adapter-merge-test-"));
  try {
    const source = join(temp, "adapter.json");
    const destination = join(temp, "adapter.candidate.json");
    writeFileSync(source, JSON.stringify({ port: 9988, token_file: "/run/secrets/codehub", local_extension: { enabled: true } }));
    const script = resolve("deploy/adapter-tools/merge-adapter-config.py");
    const result = spawnSync("python3", [script, source, destination, resolve(".")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const candidate = JSON.parse(readFileSync(destination, "utf8"));
    assert.deepEqual(candidate.pipeline_trigger, { observe_only: true });
    assert.equal(candidate.port, 9988);
    assert.equal(candidate.token_file, "/run/secrets/codehub");
    assert.deepEqual(candidate.local_extension, { enabled: true });
    for (const endpoint of ["mr_discover", "mr_discussions", "mr_gates"]) {
      assert(Array.isArray(candidate[endpoint]?.command) && candidate[endpoint].command.length > 0,
        `${endpoint} must be installed with a command`);
    }
    assert.equal(candidate.mr_discover.command[1], resolve("deploy/adapter-tools/mr-discover.py"));
    const overwrite = spawnSync("python3", [script, source, destination, resolve(".")], { encoding: "utf8" });
    assert.notEqual(overwrite.status, 0, "candidate creation must never overwrite an existing file");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("deployment validation permits command-free observation only for pipeline_trigger", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import copy, json, pathlib, runpy
module = runpy.run_path('deploy/adapter-tools/merge-adapter-config.py')
root = pathlib.Path('.').resolve()
config = json.loads(pathlib.Path('deploy/adapter-config/mr-pipeline.patch.json').read_text().replace('@REPO_DIR@', str(root)))
config['pipeline_trigger'] = {'observe_only': True}
module['validate'](config, root)
for endpoint, spec in [('pipeline_trigger', {}), ('pipeline_trigger', {'observe_only': False}), ('pipeline_trigger', {'observe_only': 'true'}), ('mr_create', {'observe_only': True}), ('pipeline_status', {'observe_only': True})]:
    invalid = copy.deepcopy(config)
    invalid[endpoint] = spec
    try:
        module['validate'](invalid, root)
    except ValueError as error:
        assert endpoint in str(error), str(error)
    else:
        raise AssertionError(endpoint + ' unexpectedly accepted without a command')
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("prod and test upgrades replace script paths and retire the participant update endpoint", () => {
  const temp = mkdtempSync(join(tmpdir(), "adapter-env-paths-"));
  try {
    for (const environment of ["mae-flow-cloud", "mae-flow-cloud-test"]) {
      const root = join(temp, environment, "repo");
      mkdirSync(root, { recursive: true });
      cpSync(resolve("deploy"), join(root, "deploy"), { recursive: true });
      const source = join(temp, `${environment}.json`);
      const destination = join(temp, `${environment}.candidate.json`);
      // 故意从包含生产绝对路径的旧配置升级，测试环境也必须全部改写。
      const oldSettings = { ...structuredClone(config), port: 9988,
        mr_gates: { ...config.mr_gates, timeout_s: 9 },
        mr_participants: { command: ["python3", "/data/mae-flow-cloud/repo/deploy/adapter-tools/mr-participants.py"], contract: true },
      };
      for (const name of ["mr_create", "mr_create_knowledge"]) delete oldSettings[name].participant_flags;
      delete oldSettings.mr_approver_members;
      writeFileSync(source, JSON.stringify(oldSettings));
      const result = spawnSync("python3", [join(root, "deploy/adapter-tools/merge-adapter-config.py"),
        source, destination, root], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const candidate = JSON.parse(readFileSync(destination, "utf8"));
      assert.equal(candidate.port, 9988);
      assert.equal(Object.hasOwn(candidate, "mr_participants"), false);
      assert.deepEqual(candidate.mr_approver_members, config.mr_approver_members);
      assert.equal(candidate.mr_gates.timeout_s, 30);
      for (const name of ["mr_create", "mr_create_knowledge"]) {
        assert.deepEqual(candidate[name].participant_flags, {
          reviewers: "--approval-reviewers", approval_approvers: "--approval-approvers",
        });
      }
      assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), oldSettings, "候选生成不能改写现场配置");
      for (const name of ["pipeline_status", "pipeline_artifacts", "mr_discover", "mr_gates"]) {
        assert.equal(candidate[name].command[1], config[name].command[1].replace("/data/mae-flow-cloud/repo", realpathSync(root)));
      }
      assert.deepEqual(candidate.mr_discussions, config.mr_discussions);
      assert(!JSON.stringify(candidate).includes("@REPO_DIR@"));
      assert(!JSON.stringify(candidate).includes("/data/mae-flow-cloud/repo"));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("real MR gate bridge validates lifecycle and fails closed on upstream errors", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import contextlib, io, json, pathlib, runpy, subprocess, sys, urllib.error
from unittest.mock import patch, MagicMock
script = pathlib.Path('deploy/adapter-tools/mr-gates.py')
sha = 'a' * 40

def invoke(detail, gates=None, rc=0, http_error=False, mr="2931", timeout=False):
    stdout, stderr = io.StringIO(), io.StringIO()
    opener = MagicMock()
    opener.open.return_value.__enter__.return_value = io.StringIO(json.dumps(detail))
    if http_error:
        opener.open.side_effect = urllib.error.HTTPError('https://example.invalid',401,'fixture-token',None,None)
    completed = subprocess.CompletedProcess([], rc, json.dumps(gates if gates is not None else dict(state=False,ci_state_passed=False)), 'fixture-token')
    exitcode = 0
    with patch.object(sys,'argv',[str(script),'group%2Frepo',mr,'fixture-token']), patch('urllib.request.build_opener',return_value=opener), patch('subprocess.run',return_value=completed,side_effect=subprocess.TimeoutExpired('codehub-cli',4) if timeout else None) as cli, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            runpy.run_path(str(script),run_name='__main__')
        except SystemExit as error:
            exitcode = error.code
    assert 'fixture-token' not in stdout.getvalue() + stderr.getvalue()
    if cli.called:
        args, kwargs = cli.call_args
        assert opener.open.call_args.kwargs['timeout'] > 9.17
        assert 9.17 < kwargs['timeout'] < 30
        assert '--token' not in args[0]
        assert kwargs['env']['CODEHUB_TOKEN'] == 'fixture-token'
        assert args[0][args[0].index('--project')+1] == 'group/repo'
    return exitcode, stdout.getvalue(), cli

for state in ['opened','merged','closed','locked']:
    rc, output, cli = invoke(dict(iid=2931,state=state,sha=sha))
    assert rc == 0, output
    data = json.loads(output)
    assert data['mr_state'] == state and data['sha'] == sha
    assert cli.called == (state in ['opened','locked'])
for detail in [dict(iid=2931,state=False,sha=sha),dict(iid=2931,sha=sha),dict(iid=99,state='opened',sha=sha),dict(iid=2931,state='merged')]:
    assert invoke(detail)[0] == 1
for gates in [[],{},dict(state=True),dict(ci_state_passed='false')]:
    assert invoke(dict(iid=2931,state='opened',sha=sha),gates=gates)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),rc=1)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),http_error=True)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),timeout=True)[0] == 1
assert invoke(dict(iid=2931,state='opened',sha=sha),mr='https://example.org/g/r/merge_requests/2931')[0] == 0
print('gate bridge tests passed')
`], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("existing tasks recover project iid from MR URL instead of saved global id", async () => {
  const { fetchMrGates } = await import("../src/mrGateClient.ts");
  const previous = globalThis.fetch;
  let request = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    request = String(input);
    return new Response(JSON.stringify({mr_state:"opened",sha,gates:[]}), {status:200});
  }) as typeof fetch;
  try {
    const view = await fetchMrGates({platformUrl:"http://adapter",repo:"https://codehub-y.example.com/g/r.git",
      headers:{},requireExisting:true,delivery:{mr_id:888888,mr_url:"https://codehub-y.example.com/g/r/merge_requests/2931"}});
    assert.equal(new URL(request).searchParams.get("mr"),"2931");
    assert.equal(view?.mrState,"opened");
    assert.equal(view?.sourceSha,sha);
  } finally { globalThis.fetch=previous; }
});

test("MR 关闭端点只接受平台实际 closed，不把 merged 或空响应当成清理成功", async () => {
  await fixture("mr_close", { state: "closed" }, async adapter => {
    const result = await adapter.handle("POST", "/mr/close", query, { mr: "2931", repo: "https://codehub-y.example.com/g/r.git" }, {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload, { mr_state: "closed" });
  });
  for (const output of [{ state: "merged" }, {}, { state: "opened" }]) {
    await fixture("mr_close", output, async adapter => {
      await assert.rejects(adapter.handle("POST", "/mr/close", query, { mr: "2931" }, {}), /未关闭/);
    });
  }
});
