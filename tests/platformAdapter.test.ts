/**
 * CodeHub 适配层的契约:配置模板→CLI→三端点 JSON,进内网只填命令行。
 * 裁判用真件:假 CLI 是真的子进程(node 脚本),模板套值、JSON/正则
 * 抽取、状态映射、诚实 502 全部走真调用链。
 *
 * 三条不许破的纪律:
 * - 映射不到的状态 502,拒绝猜(猜 running 白轮询,猜 failed 白烧修复);
 * - 个人令牌头优先于服务账号,谁的任务谁署名;
 * - CLI 失败带 stderr 原文上浮,不吞。
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformAdapter } from "../src/platformAdapter.ts";

function participantFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "mfc-adapter-participants-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, "cli.mjs"), calls = join(directory, "calls.jsonl");
  const marker = join(directory, "created");
  const configPath = join(directory, "adapter.json");
  writeFileSync(cli, `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [mode, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({mode,args})+'\\n');
const mr = {url:'https://codehub.test/g/r/merge_requests/7',iid:7};
if(mode.startsWith('create')) writeFileSync(${JSON.stringify(marker)}, 'created');
if(mode === 'create') console.log(JSON.stringify(mr));
else if(mode === 'members') console.log(args[2]);
else if(mode === 'members-by-repo') console.log(JSON.stringify(JSON.parse(args[2])[args[0]]));
else if(mode === 'members-crash') { console.error(args.join(' ')); process.exit(2); }
else if(mode === 'members-slow') setTimeout(() => console.log(args[2]), 1000);
else if(mode === 'create-invalid') console.log('{invalid-json');
else if(mode === 'create-missing-url') console.log(JSON.stringify({iid:7}));
else if(mode === 'create-empty-url') console.log(JSON.stringify({...mr,url:''}));
else if(mode === 'create-crash') { console.error(args.join(' ')); process.exit(2); }
else if(mode === 'lookup' || mode === 'lookup-after-create' && existsSync(${JSON.stringify(marker)})) console.log(JSON.stringify(mr));
else if(mode === 'legacy-update') { console.error('must not update participants'); process.exit(2); }
else console.log('{}');`);
  const requested = { reviewers: ["l00000000", "l00900222"], approval_approvers: ["l00777123"] };
  const base = {
    token: "fixture-secret", mr_create: { command: [process.execPath, cli, "create", "--token", "{token}"],
      participant_flags: { reviewers: "--review-people", approval_approvers: "--approve-people" }, url: { json: "url" }, id: { json: "iid" } },
    mr_approver_members: { command: [process.execPath, cli, "members", "{repo}", "{token}",
      JSON.stringify([{ username: "l00777123", access_level: 35 }])],
      fields: { username: { json: "username" }, access_level: { json: "access_level" } } },
    pipeline_trigger: { observe_only: true }, pipeline_status: { command: [process.execPath, cli, "invalid"] },
    // 升级前残留的更新配置也不能让创建流程另发 update。
    mr_participants: { command: [process.execPath, cli, "legacy-update"], contract: true },
  };
  const adapter = (patch: Record<string, unknown> = {}) => {
    writeFileSync(configPath, JSON.stringify({ ...base, ...patch }));
    return new PlatformAdapter(configPath, () => {});
  };
  const input = { repo: "https://codehub.test/g/r.git", source_branch: "s", target_branch: "main", title: "t", participants: requested };
  const history = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const lookup = (mode: string) => ({ command: [process.execPath, cli, mode], url: { json: "url" }, id: { json: "iid" } });
  return { requested, base, adapter, input, history, lookup };
}

test("创建 MR 直接传两类账号，接受参数即记录成功，之后不调用 update", async t => {
  const { requested, adapter, input, history } = participantFixture(t);
  const created = await adapter().handle("POST", "/mr", new URLSearchParams(), input, { "x-mfc-git-token": "personal-token" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.payload, { url: "https://codehub.test/g/r/merge_requests/7", id: "7", participants: {
    status: "applied", requested } });
  assert.deepEqual(history().map(row => row.mode), ["members", "create"]);
  assert.deepEqual(history()[0].args.slice(0, 2), [input.repo, "personal-token"]);
  assert.deepEqual(history().filter(row => row.mode !== "members"), [{ mode: "create", args: ["--token", "personal-token",
    "--review-people", "l00000000,l00900222", "--approve-people", "l00777123"] }]);
});

test("创建 MR 仅追加非空角色，未配人员保持原命令且不返回人员状态", async t => {
  const { base, adapter, input, history } = participantFixture(t);
  const instance = adapter({ mr_participants: undefined });
  for (const participants of [{ reviewers: ["l00000000"], approval_approvers: [] },
    { reviewers: [], approval_approvers: ["l00777123"] }, { reviewers: [], approval_approvers: [] }, undefined]) {
    const result = await instance.handle("POST", "/mr", new URLSearchParams(), { ...input, participants }, {});
    assert.equal(result.status, 201);
    assert.equal((result.payload as any).participants?.status, participants?.reviewers.length || participants?.approval_approvers.length ? "applied" : undefined);
  }
  assert.equal(history().filter(row => row.mode === "members").length, 1, "空审批人不查成员");
  assert.deepEqual(history().filter(row => row.mode !== "members"), [
    { mode: "create", args: ["--token", "fixture-secret", "--review-people", "l00000000"] },
    { mode: "create", args: ["--token", "fixture-secret", "--approve-people", "l00777123"] },
    { mode: "create", args: ["--token", "fixture-secret"] },
    { mode: "create", args: ["--token", "fixture-secret"] },
  ]);
  const knowledge = adapter({ mr_create_knowledge: { ...base.mr_create,
    command: [...base.mr_create.command, "--associated-issue", "{dts_no}"],
    participant_flags: { reviewers: "--knowledge-reviewers", approval_approvers: "--knowledge-approvers" } } });
  await knowledge.handle("POST", "/mr", new URLSearchParams(), { ...input, purpose: "knowledge", dts_no: "REQ479" }, {});
  assert.deepEqual(history().at(-1)?.args, ["--token", "fixture-secret", "--associated-issue", "REQ479",
    "--knowledge-reviewers", "l00000000,l00900222", "--knowledge-approvers", "l00777123"]);
  const report = await knowledge.selftest({ repo: input.repo, sha: "fixture-sha" });
  assert.match(report, /mr_create\.participant_flags:.*--review-people.*--approve-people/);
  assert.match(report, /mr_create_knowledge\(只印不执行\):.*--associated-issue/);
  assert.match(report, /mr_create_knowledge\.participant_flags:.*--knowledge-reviewers.*--knowledge-approvers/);
  assert.match(report, /mr_approver_members/);
  assert.doesNotMatch(report, /fixture-secret|mr_participants/);
  assert.equal(history().filter(row => row.mode === "create").length, 5, "自检不能执行创建命令");
  assert.ok(!history().some(row => row.mode === "legacy-update"), "自检不能执行旧人员更新命令");
});

test("创建 MR 缺少人员参数映射时保留链接并记录失败，只传已映射角色", async t => {
  const { requested, base, adapter, input, history } = participantFixture(t);
  for (const participant_flags of [undefined, { reviewers: "--review-people" }, { reviewers: "--bad flag" }]) {
    const result = await adapter({ mr_create: { ...base.mr_create, participant_flags } })
      .handle("POST", "/mr", new URLSearchParams(), input, {});
    assert.equal(result.status, 201);
    assert.equal((result.payload as any).url, "https://codehub.test/g/r/merge_requests/7");
    assert.equal((result.payload as any).participants.status, "failed");
    assert.deepEqual((result.payload as any).participants.requested, requested);
    assert.match((result.payload as any).participants.message, /未配置有效的人员参数/);
  }
  assert.deepEqual(history(), [
    { mode: "create", args: ["--token", "fixture-secret"] },
    { mode: "create", args: ["--token", "fixture-secret", "--review-people", "l00000000,l00900222"] },
    { mode: "create", args: ["--token", "fixture-secret"] },
  ]);
});

test("已有 MR 直接复用，保留人工名单，不创建也不更新人员", async t => {
  const { requested, adapter, input, history, lookup } = participantFixture(t);
  const reused = await adapter({ mr_lookup: lookup("lookup") })
    .handle("POST", "/mr", new URLSearchParams(), input, {});
  assert.equal((reused.payload as any).participants.status, "skipped");
  assert.deepEqual((reused.payload as any).participants.requested, requested);
  assert.equal((reused.payload as any).id, "7");
  assert.deepEqual(history(), [{ mode: "lookup", args: [] }]);
});

test("创建异常或输出不可解析只查询恢复 MR，不去掉人员参数重复创建", async t => {
  for (const mode of ["create-crash", "create-invalid", "create-missing-url", "create-empty-url"]) {
    const { base, adapter, input, history, lookup } = participantFixture(t);
    const result = await adapter({ mr_lookup: lookup("lookup-after-create"),
      mr_create: { ...base.mr_create, command: base.mr_create.command.map(arg => arg === "create" ? mode : arg) } })
      .handle("POST", "/mr", new URLSearchParams(), input, {});
    assert.equal(result.status, 201);
    assert.equal((result.payload as any).id, "7");
    assert.equal((result.payload as any).participants.status, "skipped");
    assert.deepEqual(history().map(row => row.mode), ["lookup-after-create", "members", mode, "lookup-after-create"]);
    assert.deepEqual(history()[2].args, ["--token", "fixture-secret",
      "--review-people", "l00000000,l00900222", "--approve-people", "l00777123"]);
  }
});

test("创建失败且查不到 MR 如实失败，令牌脱敏，不重试创建或调用旧补设端点", async t => {
  const { base, adapter, input, history, lookup } = participantFixture(t);
  const instance = adapter({ mr_lookup: lookup("lookup-missing"),
    mr_create: { ...base.mr_create, command: base.mr_create.command.map(arg => arg === "create" ? "create-crash" : arg) } });
  await assert.rejects(instance.handle("POST", "/mr", new URLSearchParams(), input, { "x-mfc-git-token": "personal-secret" }), (error: Error) => {
    assert.match(error.message, /CLI 失败/);
    assert.doesNotMatch(error.message, /fixture-secret|personal-secret/);
    return true;
  });
  assert.deepEqual(history().map(row => row.mode), ["lookup-missing", "members", "create-crash", "lookup-missing"]);
  const retired = await instance.handle("POST", "/mr/participants", new URLSearchParams(), { repo: input.repo, mr: "7", participants: input.participants }, {});
  assert.equal(retired.status, 404);
  assert.equal(history().length, 4);
});

test("审批人按仓过滤 Committer 权限，排除作者，原配置保留且不跨仓缓存", async t => {
  const { base, adapter, input, history } = participantFixture(t);
  const people = { reviewers: ["l00000000"], approval_approvers: ["low", "committer", "maintainer", "author", "outsider"] };
  const rows = [{ username: "low", access_level: 30 }, { username: "committer", access_level: 35 },
    { username: "maintainer", access_level: "40" }, { username: "author", access_level: 50 }];
  const otherRepo = "https://codehub.test/g/other.git";
  const byRepo = { [input.repo]: rows, [otherRepo]: rows.map(row => row.username === "committer" ? { ...row, access_level: 30 } : row) };
  const members = { ...base.mr_approver_members, command: [...base.mr_approver_members.command.slice(0, -1)
    .map(arg => arg === "members" ? "members-by-repo" : arg), JSON.stringify(byRepo)] };
  const instance = adapter({ mr_approver_members: members });
  for (const repo of [input.repo, otherRepo]) {
    const response = await instance.handle("POST", "/mr", new URLSearchParams(), { ...input, repo, participants: people },
      { "x-mfc-git-user": "author", "x-mfc-git-token": "personal-secret" });
    assert.equal(response.status, 201);
    assert.equal((response.payload as any).participants.status, "failed", "部分跳过不冒充全员设置成功");
    assert.deepEqual((response.payload as any).participants.requested, people);
    assert.match((response.payload as any).participants.message, repo === input.repo ? /low, author, outsider/ : /low, committer, author, outsider/);
  }
  assert.deepEqual(history().map(row => row.mode), ["members-by-repo", "create", "members-by-repo", "create"]);
  assert.deepEqual(history().filter(row => row.mode === "members-by-repo").map(row => row.args.slice(0, 2)),
    [[input.repo, "personal-secret"], [otherRepo, "personal-secret"]]);
  assert.deepEqual(history().filter(row => row.mode === "create").map(row => row.args),
    ["committer,maintainer", "maintainer"].map(names => ["--token", "personal-secret", "--review-people", "l00000000", "--approve-people", names]));
});

test("成员查询缺席、失败、超时或无合法审批人时省略审批参数，检视人和 MR 创建保留", async t => {
  for (const mode of ["absent", "members-crash", "members-slow", "invalid-json", "missing-field", "empty", "low"]) {
    const { base, adapter, input, history } = participantFixture(t);
    const raw = mode === "invalid-json" ? "not-json" : mode === "missing-field" ? '[{"username":"l00777123"}]'
      : mode === "low" ? '[{"username":"l00777123","access_level":30}]' : '[]';
    const spec = mode === "absent" ? undefined : { ...base.mr_approver_members, timeout_s: 0.02,
      command: [...base.mr_approver_members.command.slice(0, 2),
        mode === "members-crash" || mode === "members-slow" ? mode : "members", "{repo}", "{token}", raw] };
    if (spec && mode !== "members-slow") spec.timeout_s = 5;
    const response = await adapter({ mr_approver_members: spec }).handle("POST", "/mr", new URLSearchParams(), input,
      { "x-mfc-git-token": "personal-secret" });
    assert.equal(response.status, 201, mode);
    assert.equal((response.payload as any).participants.status, "failed", mode);
    assert.deepEqual((response.payload as any).participants.requested, input.participants);
    assert.doesNotMatch(JSON.stringify(response.payload), /personal-secret|fixture-secret/);
    assert.deepEqual(history().filter(row => row.mode === "create"), [{ mode: "create",
      args: ["--token", "personal-secret", "--review-people", "l00000000,l00900222"] }]);
  }
});

test("只观察自动流水线不需要触发命令，自检和调用都保留真实查询失败", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-observe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "adapter.json");
  const cli = fakeCli(dir);
  makeAdapter(dir, cli);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.pipeline_trigger = { observe_only: true };
  config.pipeline_status = { command: [process.execPath, cli, "boom", "--token", "{token}"] };
  writeFileSync(path, JSON.stringify(config));
  const adapter = new PlatformAdapter(path, () => {});
  await assert.rejects(adapter.handle("POST", "/pipeline/trigger", new URLSearchParams(),
    { repo: "r", sha: "abc" }, {}), /token 无效/);
  const report = await adapter.selftest({ repo: "r", sha: "abc" });
  assert.match(report, /pipeline_trigger.*observe_only.*pipeline_status/);
  assert.match(report, /GET \/pipeline\/status -> 失败:.*token 无效/s);
  assert.doesNotMatch(report, /svc-token-0000/);
});

test("只观察模式只豁免流水线触发命令，真正触发和其他端点仍须有命令", t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "adapter.json");
  makeAdapter(dir, fakeCli(dir));
  const base = JSON.parse(readFileSync(path, "utf8"));
  for (const trigger of [{}, { observe_only: false }, { observe_only: "true" }]) {
    writeFileSync(path, JSON.stringify({ ...base, pipeline_trigger: trigger }));
    assert.throws(() => new PlatformAdapter(path, () => {}), /pipeline_trigger.command/);
  }
  for (const section of ["mr_create", "pipeline_status"]) {
    writeFileSync(path, JSON.stringify({ ...base, pipeline_trigger: { observe_only: true },
      [section]: { observe_only: true } }));
    assert.throws(() => new PlatformAdapter(path, () => {}), new RegExp(`${section}.*command`));
  }
});

test("流水线材料可传超过 8 MiB 的完整日志，目录模式也不截成 512 KiB", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-large-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  makeAdapter(dir, fakeCli(dir));
  const configPath = join(dir, "adapter.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const cli = join(dir, "large-artifacts.mjs");
  writeFileSync(cli, 'process.stdout.write(JSON.stringify([{name:"build_log_ut.txt",text:"x".repeat(9*1024*1024)+"\\nTest case failed"}]))');
  config.pipeline_artifacts = { command: ["node", cli],
    fields: { name: { json: "name" }, text: { json: "text" } } };
  writeFileSync(configPath, JSON.stringify(config));
  const query = new URLSearchParams({ repo: "group/repo", sha: "a".repeat(40),
    mr: "https://codehub.example/mr/1" });
  const adapter = new PlatformAdapter(configPath, () => {});
  const result = await adapter.handle("GET", "/pipeline/artifacts", query, {}, {});
  assert.equal(result.status, 200);
  assert.equal((result.payload as any).files[0].text.length,
    9 * 1024 * 1024 + "\nTest case failed".length);
  assert.match((result.payload as any).files[0].text, /Test case failed$/);

  const logs = join(dir, "logs-from-command");
  mkdirSync(logs);
  const full = "x".repeat(3 * 1024 * 1024) + "\nFailure total: 28";
  writeFileSync(join(logs, "build_log_ut.txt"), full);
  config.pipeline_artifacts = { command: ["node", "-e", ""], files_dir: logs };
  writeFileSync(configPath, JSON.stringify(config));
  const fromDir = await new PlatformAdapter(configPath, () => {})
    .handle("GET", "/pipeline/artifacts", query, {}, {});
  assert.equal((fromDir.payload as any).files[0].text, full);
});

/** 假 codehubcli:把收到的 argv 原样回显进 JSON,行为按子命令走——
 * 测的就是"模板套了什么值、适配层怎么消化输出"。 */
function fakeCli(dir: string): string {
  const path = join(dir, "fake-codehubcli.mjs");
  writeFileSync(path, `
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    // argv 落盘:测试要断言"CLI 究竟收到了哪个令牌"
    writeFileSync(new URL("./last-argv.json", import.meta.url),
      JSON.stringify(args));
    const sub = args[0];
    if (sub === "mr") {
      console.log(JSON.stringify({ data: { web_url:
        "https://codehub.example.com/mr/42", argv: args } }));
    } else if (sub === "trigger") {
      console.log(JSON.stringify({ data: { state: "RUNNING", jobs: [
        { quality: "COMPILE", state: "RUNNING", name: "compile" },
        { quality: "UT", state: "PENDING", name: "unit-test" },
        { quality: "CODECHECK", state: "PENDING", name: "codecheck" },
      ], argv: args } }));
    } else if (sub === "status") {
      console.log(JSON.stringify({ data: { runs: [
        { id: 101, state: "RUNNING", jobs: [
          { quality: "COMPILE", state: "RUNNING", name: "compile" },
        ] },
        { id: 102, state: "FAILED", fail_log: "BUILD FAILURE: 覆盖率 61%", jobs: [
          { quality: "COMPILE", state: "SUCCESS", name: "compile" },
          { quality: "UT", state: "FAILED", name: "unit-test",
            stage: "test", tool: "actual-ut",
            details: [{ message: "DT=2 [超限]", rule: "quality_metric",
              severity: "error", tool: "actual-ut" }, { message: "" }] },
          { quality: "CODECHECK", state: "SKIPPED", name: "codecheck" },
        ] },
      ], argv: args } }));
    } else if (sub === "weird") {
      console.log(JSON.stringify({ data: { state: "SUSPENDED" } }));
    } else if (sub === "boom") {
      const tokenAt = args.indexOf("--token");
      console.error("CLI 炸了: token 无效 "
        + (tokenAt >= 0 ? args[tokenAt + 1] : ""));
      process.exit(3);
    } else if (sub === "mergeable") {
      // CodeHub mergeable_state 的真实形状(能力核对报告 B 节):
      // 平铺布尔 + reason 文案对象 + merge_request_switch 总开关。
      console.log(JSON.stringify({ data: {
        state: "opened",
        conflict_passed: true,
        ci_state_passed: false,
        resolve_discussion_passed: true,
        approvers_passed: false,
        merge_request_switch: true,
        reason: { ci_state_passed: "pipeline #88 failed" },
      } }));
    } else if (sub === "mrlist") {
      console.log(JSON.stringify({ data: args.includes("--found")
        ? [{ web_url: "https://codehub.example.com/mr/7", iid: 7 }] : [] }));
    } else if (sub === "listnotes") {
      console.log(JSON.stringify({ data: { items: [{
        id: "discussion-9", revision: 3,
        updated_at: "2026-09-01T09:30:00Z", body: "编辑后的意见",
      }] } }));
    } else if (sub === "note") {
      console.log(JSON.stringify({ result: { id: 555 } }));
    } else if (sub === "resolvecmd") {
      console.log("{}");
    }
  `);
  return path;
}

function makeAdapter(dir: string, cli: string): PlatformAdapter {
  const configPath = join(dir, "adapter.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: {
      command: ["node", cli, "mr", "--repo", "{repo}",
        "--project", "{repo_path}",   // 从仓 URL 自动派生,人不填 id
        "--source", "{source_branch}", "--target", "{target_branch}",
        "--title", "{title}", "--e2e-issues", "{dts_no}",
        "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: {
      command: ["node", cli, "trigger", "--repo", "{repo}",
        "--sha", "{sha}", "--token", "{token}"],
      status: { json: "data.state" },
      checks: { json: "data.jobs" },
      check_dimension: { json: "quality" },
      check_status: { json: "state" },
      check_job: { json: "name" },
      status_map: { RUNNING: "running", SUCCESS: "success", FAILED: "failed" },
      check_status_map: {
        RUNNING: "running", PENDING: "pending", SUCCESS: "success",
        FAILED: "failed", SKIPPED: "skipped",
      },
    },
    pipeline_status: {
      command: ["node", cli, "status", "--sha", "{sha}", "--token", "{token}"],
      runs: { json: "data.runs" },
      status: { json: "state" },
      pipeline_id: { json: "id" },
      log: { json: "fail_log" },
      checks: { json: "jobs" },
      check_dimension: { json: "quality" },
      check_status: { json: "state" },
      check_job: { json: "name" },
      status_map: { RUNNING: "running", SUCCESS: "success", FAILED: "failed" },
      check_status_map: {
        RUNNING: "running", PENDING: "pending", SUCCESS: "success",
        FAILED: "failed", SKIPPED: "skipped",
      },
    },
    mr_discussions: {
      command: ["node", cli, "listnotes", "--mr", "{mr}"],
      items: { json: "data.items" },
      fields: {
        id: { json: "id" }, revision: { json: "revision" },
        updated_at: { json: "updated_at" }, body: { json: "body" },
      },
    },
  }));
  chmodSync(configPath, 0o600);
  return new PlatformAdapter(configPath, () => {});
}

test("三端点走真 CLI:模板套值、抽取、状态映射、多 run 全对", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const adapter = makeAdapter(dir, fakeCli(dir));

  const mr = await adapter.handle("POST", "/mr", new URLSearchParams(), {
    repo: "https://codehub.example.com/g/demo.git",
    source_branch: "master_bot_REQ9", target_branch: "master",
    title: "REQ9: 修复通知模板 变量缺失",   // 带空格,argv 直传不走 shell
    // E2E 单号关联(内网诉求):单号必须以独立参数走 --e2e-issues,
    // 只拼进 title 平台看不见。REQ/DTS 同一个参数,平台不分型。
    dts_no: "DTS2026081800001",
  }, {});
  assert.equal(mr.status, 201);
  assert.equal((mr.payload as any).url, "https://codehub.example.com/mr/42");
  // {repo_path}:从 https://codehub.example.com/g/demo.git 自动派生
  // URL 编码路径 g%2Fdemo——CodeHub REST 按路径定位仓,不用手抄项目 id
  const argv = JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];
  assert.ok(argv.includes("g%2Fdemo"), "repo_path 没从仓 URL 派生出来");
  assert.equal(argv[argv.indexOf("--e2e-issues") + 1], "DTS2026081800001",
    "单号要走 --e2e-issues 递到平台,不许只活在 title 里");

  const trigger = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "abc123" }, {});
  assert.equal((trigger.payload as any).status, "running", "RUNNING 映射到契约词");
  assert.deepEqual((trigger.payload as any).checks.map(
    (item: { dimension: string }) => item.dimension),
  ["COMPILE", "UT", "CODECHECK"]);

  const status = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams("sha=abc123&repo=r"), {}, {});
  const runs = (status.payload as any).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].status, "failed");
  assert.equal(runs[1].checks[1].dimension, "UT");
  assert.equal(runs[1].checks[1].status, "failed");
  assert.equal(runs[1].checks[1].stage, "test");
  assert.equal(runs[1].checks[1].tool, "actual-ut");
  assert.equal(runs[1].checks[1].details.length, 1);
  assert.equal(runs[1].checks[1].details[0].message, "DT=2 [超限]");
  assert.equal(runs[1].checks[2].status, "skipped");
  assert.match(runs[1].log, /覆盖率 61%/, "失败日志是修复环的口粮");

  const discussions = await adapter.handle("GET", "/mr/discussions",
    new URLSearchParams("repo=r&mr=42"), {}, {});
  assert.deepEqual((discussions.payload as any).discussions, [{
    id: "discussion-9", revision: 3,
    updated_at: "2026-09-01T09:30:00Z", body: "编辑后的意见",
  }], "评论修订号和更新时间必须穿透适配层，编辑后才能形成新反馈");
});

test("身份:个人令牌头压过服务账号;没带头回落服务账号", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const adapter = makeAdapter(dir, fakeCli(dir));
  const lastArgv = () => JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];

  // 带个人令牌头:CLI 收到的必须是个人的,不是服务账号的
  const personal = await adapter.handle("POST", "/mr", new URLSearchParams(), {
    repo: "https://codehub.example.com/g/demo.git",
    source_branch: "s", target_branch: "t", title: "x", dts_no: "REQ1",
  }, { "x-mfc-git-token": encodeURIComponent("glpat-personal-7777"),
       "x-mfc-git-user": "zhang.san" });
  assert.equal(personal.status, 201);
  assert.ok(lastArgv().includes("glpat-personal-7777"), "个人令牌没到 CLI");
  assert.ok(!lastArgv().includes("svc-token-0000"),
    "个人令牌在场时不该动服务账号");

  // 不带头:回落服务账号,MR 还能建(只是署名是服务号)
  const fallback = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "abc" }, {});
  assert.equal(fallback.status, 201);
  assert.ok(lastArgv().includes("svc-token-0000"), "服务账号回落没生效");
});

test("诚实 502:未映射状态拒绝猜;CLI 非零退出带 stderr 上浮", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const configPath = join(dir, "adapter.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-secret-do-not-leak",
    mr_create: {
      command: ["node", cli, "boom", "--token", "{token}"],
      url: { regex: "https\\S+" },
    },
    pipeline_trigger: {
      command: ["node", cli, "weird"],
      status: { json: "data.state" },
      status_map: { RUNNING: "running" },   // SUSPENDED 故意不配
    },
    pipeline_status: {
      command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" },
      status_map: { RUNNING: "running", FAILED: "failed" },
    },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});

  await assert.rejects(
    adapter.handle("POST", "/pipeline/trigger",
      new URLSearchParams(), { repo: "r", sha: "x" }, {}),
    /SUSPENDED.*拒绝猜测/s);
  await assert.rejects(
    adapter.handle("POST", "/mr", new URLSearchParams(),
      { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {}),
    (error: Error) => {
      assert.match(error.message, /token 无效/);
      assert.match(error.message, /<token>/);
      assert.doesNotMatch(error.message, /svc-secret-do-not-leak/);
      return true;
    });
});

test("报告后新口子:平铺布尔门禁、先查后建、两步回复/解决", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-rpt-"));
  const cli = fakeCli(dir);
  const lastArgv = () => JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];
  const makeConfig = (lookupFound: boolean) => {
    const configPath = join(dir, `adapter-${lookupFound}.json`);
    writeFileSync(configPath, JSON.stringify({
      token: "svc-token-0000",
      mr_create: {
        command: ["node", cli, "mr", "--source", "{source_branch}",
          "--target", "{target_branch}", "--token", "{token}"],
        url: { json: "data.web_url" },
      },
      mr_lookup: {
        command: lookupFound
          ? ["node", cli, "mrlist", "--found", "--source",
             "{source_branch}", "--token", "{token}"]
          : ["node", cli, "mrlist", "--source", "{source_branch}",
             "--token", "{token}"],
        url: { json: "data.0.web_url" },
        id: { json: "data.0.iid" },
      },
      pipeline_trigger: { command: ["node", cli, "trigger"],
        status: { const: "running" } },
      pipeline_status: { command: ["node", cli, "status"],
        runs: { json: "data.runs" }, status: { json: "state" },
        status_map: { RUNNING: "running", FAILED: "failed" } },
      mr_gates: {
        command: ["node", cli, "mergeable", "--mr", "{mr}",
          "--token", "{token}"],
        bools: { json: "data" },
        reason: { json: "data.reason" },
        ignore_fields: ["merge_request_switch"],
        mr_state: { json: "data.state" },
      },
      discussion_reply: {
        command: ["node", cli, "note", "--id", "{id}",
          "--body", "{body}", "--idempotency-key", "{idempotency_key}",
          "--token", "{token}"],
        note_id: { json: "result.id" },
      },
      discussion_resolve: {
        command: ["node", cli, "resolvecmd", "--note", "{note_id}",
          "--token", "{token}"],
      },
    }));
    return new PlatformAdapter(configPath, () => {});
  };

  // 平铺布尔模式:布尔字段即门禁;reason 同名文案进 detail;
  // 非布尔(state/reason)与 ignore_fields(总开关)不冒充门禁。
  const adapter = makeConfig(true);
  const gates = await adapter.handle("GET", "/mr/gates",
    new URLSearchParams("repo=r&mr=42"), {}, {});
  const list = (gates.payload as any).gates as
    Array<{ name: string; passed: boolean; detail?: string }>;
  const byName = Object.fromEntries(list.map((g) => [g.name, g]));
  assert.equal((gates.payload as any).mr_state, "opened");
  assert.equal(byName.ci_state_passed.passed, false);
  assert.match(byName.ci_state_passed.detail ?? "", /pipeline #88/,
    "reason 文案要进 detail 给修复使命用");
  assert.equal(byName.conflict_passed.passed, true);
  assert.equal(byName.merge_request_switch, undefined,
    "总开关不是门禁,不许上报");
  assert.equal(byName.state, undefined);
  assert.equal(byName.reason, undefined);

  // 先查后建:查到已开 MR 直接复用(创建命令根本不跑),iid 一并带回
  const reused = await adapter.handle("POST", "/mr", new URLSearchParams(),
    { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {});
  assert.equal((reused.payload as any).url, "https://codehub.example.com/mr/7");
  assert.equal((reused.payload as any).id, "7");
  assert.ok(lastArgv().includes("mrlist"), "复用时不该执行创建命令");

  // 查不到 → 走创建
  const created = await makeConfig(false).handle("POST", "/mr",
    new URLSearchParams(),
    { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {});
  assert.equal((created.payload as any).url, "https://codehub.example.com/mr/42");

  // 回复默认一步:resolve 未带/false 时只跑 reply 命令
  await adapter.handle("POST", "/mr/discussions/d-1/reply",
    new URLSearchParams(), {
      repo: "r", body: "回复正文", idempotency_key: "body-idem-1",
    }, {});
  assert.ok(lastArgv().includes("note"), "只回复时最后一跳是 reply 命令");
  assert.ok(lastArgv().includes("body-idem-1"),
    "请求体 idempotency_key 必须进入真实 CLI 模板");

  // HTTP 头优先于 body（真实宿主两处都会带）：大小写不敏感读取，
  // 避免 Node 归一成小写后模板拿不到稳定动作键。
  await adapter.handle("POST", "/mr/discussions/d-1/reply",
    new URLSearchParams(), {
      repo: "r", body: "回复正文", idempotency_key: "body-fallback",
    }, { "Idempotency-Key": "header-idem-2" });
  assert.ok(lastArgv().includes("header-idem-2"));
  assert.ok(!lastArgv().includes("body-fallback"));

  // resolve:true → 第二跳执行,note id 从 reply 输出抽出来传进去
  const two = await adapter.handle("POST", "/mr/discussions/d-1/reply",
    new URLSearchParams(), {
      repo: "r", body: "回复正文", resolve: true,
      idempotency_key: "body-idem-3",
    }, {});
  assert.equal((two.payload as any).resolved, true);
  assert.ok(lastArgv().includes("resolvecmd"));
  assert.ok(lastArgv().includes("555"), "note id 没接力到 resolve 命令");

  // 旧真实模板吞掉稳定动作键时必须 fail-closed；否则远端成功而本地
  // 未落 delivered 的重放会重复发言。无 idempotency_key 的旧调用仍
  // 保持兼容，收到了宿主 outbox 键才启用硬闸。
  const legacyPath = join(dir, "adapter-legacy-reply.json");
  writeFileSync(legacyPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" },
      status_map: { RUNNING: "running", FAILED: "failed" } },
    discussion_reply: {
      command: ["node", cli, "note", "--id", "{id}",
        "--body", "{body}", "--token", "{token}"],
    },
  }));
  const legacy = new PlatformAdapter(legacyPath, () => {});
  await assert.rejects(() => legacy.handle(
    "POST", "/mr/discussions/d-legacy/reply", new URLSearchParams(),
    { repo: "r", body: "回复正文", idempotency_key: "stable-action-key" },
    {}), /模板未引用 \{idempotency_key\}.*拒绝非幂等发送/s);
  const compatible = await legacy.handle(
    "POST", "/mr/discussions/d-legacy/reply", new URLSearchParams(),
    { repo: "r", body: "旧调用无幂等键" }, {});
  assert.equal(compatible.status, 200, "无动作键的旧调用保持兼容");

  // codehub-cli 这类 CLI 不支持幂等键参数时，配 idempotency_no_cli_key=true
  // 降级:不要求模板引用 {idempotency_key}，靠 outbox delivered 防重放。
  // 模板带 --no-cache 避免缓存层假成功。不设时仍 fail-closed(上面已测)。
  const downgradePath = join(dir, "adapter-downgrade-reply.json");
  writeFileSync(downgradePath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" } },
    discussion_reply: {
      command: ["node", cli, "note", "--no-cache", "--id", "{id}",
        "--body", "{body}", "--token", "{token}"],
      idempotency_no_cli_key: true,
    },
  }));
  const downgrade = new PlatformAdapter(downgradePath, () => {});
  const down = await downgrade.handle(
    "POST", "/mr/discussions/d-down/reply", new URLSearchParams(),
    { repo: "r", body: "CLI 无幂等键降级", idempotency_key: "stable-key" }, {});
  assert.equal(down.status, 200, "idempotency_no_cli_key=true 时降级放行");
});

test("配置坏了拒绝启动;引用 {token} 但两头都没有=502", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ mr_create: { command: [] } }));
  assert.throws(() => new PlatformAdapter(bad, () => {}), /command/);

  const cli = fakeCli(dir);
  const noToken = join(dir, "no-token.json");
  writeFileSync(noToken, JSON.stringify({
    // 没配 token/token_file
    mr_create: {
      command: ["node", cli, "mr", "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" },
      status_map: { RUNNING: "running", FAILED: "failed" } },
  }));
  const adapter = new PlatformAdapter(noToken, () => {});
  await assert.rejects(
    adapter.handle("POST", "/mr", new URLSearchParams(),
      { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {}),
    /个人令牌没带、服务账号也没配/);
  // const 抽取:CLI 不回状态的触发型命令,固定 running 交给宿主轮询
  const trigger = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "x" }, {});
  assert.equal((trigger.payload as any).status, "running");
});

test("降级链+contract 直通:首路挂了走次路,回显 sha/is_valid 透传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  // contract 模式脚本:输出就是宿主契约(仓内编排脚本的形态)。
  const bridge = join(dir, "fake-bridge.mjs");
  writeFileSync(bridge, `
    console.log(JSON.stringify({ runs: [
      { status: "success", is_valid: false, sha: "${"c".repeat(40)}" },
      { status: "failed", sha: "${"a".repeat(40)}", is_valid: true,
        pipeline_id: "88", web_url: "https://ci/88",
        log: "BUILD FAILURE",
        checks: [{ dimension: "COMPILE", status: "failed",
                   stage: "build", tool: "maven",
                   details: [{ file: "src/A.java", line: 7,
                               message: "找不到符号" }] }] },
    ] }));
  `);
  const configPath = join(dir, "chain.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { candidates: [
      // 首路必炸(exit 3):降级链要接住,不算端点失败。
      { command: ["node", cli, "boom"], status: { json: "state" } },
      { command: ["node", bridge], contract: true },
    ] },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});
  const result = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "a".repeat(40), repo: "r" }), {}, {});
  assert.equal(result.status, 200);
  const runs = (result.payload as any).runs;
  assert.equal(runs.length, 2);
  // 过期结果标记与 SHA 回显原样透传——机械核验在宿主(selectTerminalRun)。
  assert.equal(runs[0].is_valid, false);
  assert.equal(runs[1].sha, "a".repeat(40));
  assert.equal(runs[1].pipeline_id, "88");
  assert.equal(runs[1].checks[0].stage, "build");
  assert.equal(runs[1].checks[0].details[0].line, 7);
});

test("contract 模式不放松诚实:非契约状态词=这一路失败;全败聚合上报", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const liar = join(dir, "liar.mjs");
  writeFileSync(liar,
    `console.log(JSON.stringify({ runs: [{ status: "GREEN" }] }));`);
  const configPath = join(dir, "liar.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { candidates: [
      { command: ["node", liar], contract: true },
      { command: ["node", cli, "boom"], status: { json: "state" } },
    ] },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});
  await assert.rejects(
    adapter.handle("GET", "/pipeline/status",
      new URLSearchParams({ sha: "x", repo: "r" }), {}, {}),
    (error: Error) => /候选\[0\].*不是契约词/s.test(error.message)
      && /候选\[1\]/.test(error.message));
});

test("模板模式的 run 级回显:run_sha/is_valid/pipeline_id 逐字段抽取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const rest = join(dir, "rest.mjs");
  writeFileSync(rest, `
    console.log(JSON.stringify({ data: { runs: [
      { state: "SUCCESS", commit_sha: "${"d".repeat(40)}",
        id: 91, valid: "false" },
    ] } }));
  `);
  const configPath = join(dir, "rest.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: {
      command: ["node", rest],
      runs: { json: "data.runs" },
      status: { json: "state" },
      run_sha: { json: "commit_sha" },
      pipeline_id: { json: "id" },
      is_valid: { json: "valid" },
      status_map: { SUCCESS: "success", FAILED: "failed",
                    RUNNING: "running" },
    },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});
  const result = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "x", repo: "r" }), {}, {});
  const run = (result.payload as any).runs[0];
  assert.equal(run.sha, "d".repeat(40));
  assert.equal(run.pipeline_id, "91");
  assert.equal(run.is_valid, false);
});

test("pipeline_status 兼容旧 desc 配置并对无顺序键的多 run fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const desc = join(dir, "desc.mjs");
  writeFileSync(desc, `
    console.log(JSON.stringify([
      { state: "RUNNING", id: 93 },
      { state: "FAILED", id: 92 },
      { state: "SUCCESS", id: 91 }
    ]));
  `);
  const orderedPath = join(dir, "ordered.json");
  writeFileSync(orderedPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: {
      command: ["node", desc],
      status: { json: "state" },
      pipeline_id: { json: "id" },
      status_map: { SUCCESS: "success", FAILED: "failed",
                    RUNNING: "running" },
    },
  }));
  const ordered = new PlatformAdapter(orderedPath, () => {});
  const result = await ordered.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "x", repo: "r" }), {}, {});
  assert.deepEqual((result.payload as any).runs.map((run: any) =>
    run.pipeline_id), ["91", "92", "93"]);
  assert.equal((result.payload as any).runs.at(-1).status, "running");

  const ambiguous = join(dir, "ambiguous.mjs");
  writeFileSync(ambiguous, `console.log(JSON.stringify([
    { state: "SUCCESS" }, { state: "RUNNING" }
  ]));`);
  const ambiguousPath = join(dir, "ambiguous.json");
  writeFileSync(ambiguousPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: {
      command: ["node", ambiguous],
      status: { json: "state" },
      status_map: { SUCCESS: "success", RUNNING: "running" },
    },
  }));
  const unsafe = new PlatformAdapter(ambiguousPath, () => {});
  await assert.rejects(() => unsafe.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "x", repo: "r" }), {}, {}),
  /多条 run.*pipeline_id.*无法可靠判断最新流水线/s);
});

test("知识 MR 必须传入关联单号，专用模板及普通模板都实际传给平台", async t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-adapter-")), cli = fakeCli(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  makeAdapter(dir, cli);
  const path = join(dir, "adapter.json"), config = JSON.parse(readFileSync(path, "utf8"));
  config.mr_create_knowledge = { ...config.mr_create };
  writeFileSync(path, JSON.stringify(config));
  const adapter = new PlatformAdapter(path, () => {});
  const body = { repo: "https://example.test/knowledge.git", source_branch: "codex/knowledge-fixture", target_branch: "main", title: "知识归档" };
  await assert.rejects(() => adapter.handle("POST", "/mr", new URLSearchParams(), { ...body, purpose: "knowledge" }, {}), /关联单号/);
  await adapter.handle("POST", "/mr", new URLSearchParams(), { ...body, purpose: "knowledge", dts_no: "REQ-knowledge" }, {});
  const knowledgeArgs = JSON.parse(readFileSync(join(dir, "last-argv.json"), "utf8"));
  assert.equal(knowledgeArgs[knowledgeArgs.indexOf("--e2e-issues") + 1], "REQ-knowledge");
  await adapter.handle("POST", "/mr", new URLSearchParams(), { ...body, dts_no: "REQ-fixture" }, {});
  const ordinaryArgs = JSON.parse(readFileSync(join(dir, "last-argv.json"), "utf8"));
  assert.equal(ordinaryArgs[ordinaryArgs.indexOf("--e2e-issues") + 1], "REQ-fixture");
  config.mr_create_knowledge.command = config.mr_create.command.filter((arg: string) => !["--e2e-issues", "{dts_no}"].includes(arg));
  writeFileSync(path, JSON.stringify(config));
  const withoutAssociation = new PlatformAdapter(path, () => {});
  await assert.rejects(() => withoutAssociation.handle("POST", "/mr", new URLSearchParams(), { ...body, purpose: "knowledge", dts_no: "REQ-knowledge" }, {}), /命令未配置单号关联/);
});

test("独立 resolve 端点透传请求体:{mr} 从 body 取值,缺席诚实报错(issue-383 回归)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-resolve-"));
  const cli = fakeCli(dir);
  const configPath = join(dir, "adapter.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: {
      command: ["node", cli, "mr", "--repo", "{repo}",
        "--source", "{source_branch}", "--target", "{target_branch}",
        "--title", "{title}", "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: {
      command: ["node", cli, "trigger", "--repo", "{repo}",
        "--sha", "{sha}", "--token", "{token}"],
      status: { json: "data.state" },
    },
    pipeline_status: {
      command: ["node", cli, "status", "--sha", "{sha}",
        "--token", "{token}"],
      runs: { json: "data.runs" }, status: { json: "data.state" },
    },
    // 部署形态:resolve 模板按讨论 id 解析、引用 {mr} 定位 MR。
    discussion_resolve: {
      command: ["node", cli, "resolvecmd", "--discussion", "{id}",
        "--mr", "{mr}", "--token", "{token}"],
    },
  }));
  chmodSync(configPath, 0o600);
  const adapter = new PlatformAdapter(configPath, () => {});
  const lastArgv = () => JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8"));
  await adapter.handle("POST", "/mr/discussions/d-9/resolve",
    new URLSearchParams(), { repo: "r", mr: "2989" }, {});
  assert.ok(lastArgv().includes("2989"), "请求体里的 mr 进 CLI 参数");
  assert.ok(lastArgv().includes("d-9"), "路径里的讨论 id 进 CLI 参数");
  // 缺 mr:模板引用了 {mr} 而取值表没有——诚实报错,不静默发空
  // (修复前处理器手工挑字段把 body 里的 mr 丢弃,确定性失败)。
  await assert.rejects(
    adapter.handle("POST", "/mr/discussions/d-9/resolve",
      new URLSearchParams(), { repo: "r" }, {}),
    /\{mr\}/);
});

test("适配层调用账(#408):每请求一行带 parent_request_id,异常也记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-audit-"));
  const cli = fakeCli(dir);
  const configPath = join(dir, "adapter.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: {
      command: ["node", cli, "mr", "--repo", "{repo}",
        "--source", "{source_branch}", "--target", "{target_branch}",
        "--title", "{title}", "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: {
      command: ["node", cli, "trigger", "--repo", "{repo}",
        "--sha", "{sha}", "--token", "{token}"],
      status: { json: "data.state" },
    },
    pipeline_status: {
      command: ["node", cli, "status", "--sha", "{sha}",
        "--token", "{token}"],
      runs: { json: "data.runs" }, status: { json: "data.state" },
    },
    discussion_resolve: {
      command: ["node", cli, "resolvecmd", "--discussion", "{id}",
        "--mr", "{mr}", "--token", "{token}"],
    },
  }));
  chmodSync(configPath, 0o600);
  const adapter = new PlatformAdapter(configPath, () => {});
  const callsFile = join(dir, "logs", "adapter-calls.jsonl");
  const rows = () => existsSync(callsFile)
    ? readFileSync(callsFile, "utf-8").trim().split("\n")
      .map((line) => JSON.parse(line)) : [];

  await adapter.handle("POST", "/mr/discussions/d-9/resolve",
    new URLSearchParams(), { repo: "r", mr: "2989" },
    { "x-mfc-request-id": encodeURIComponent("mrr-1") });
  const row = rows().find((item: any) =>
    item.endpoint === "POST /mr/discussions/d-9/resolve");
  assert.equal(row.parent_request_id, "mrr-1",
    "宿主透传 id 记为 parent(两侧账按同动作 join)");
  assert.equal(row.status, 200);
  assert.deepEqual(row.params, { repo: "r", mr: "2989" }, "白名单参数摘要");
  assert.ok(row.duration_ms >= 0);
  assert.equal(row.ts, row.written_at, "双时间在账");

  // 异常路径:缺 mr → AdapterError 抛出(serve 转 502),账里 error 行
  // 带原文(已掩码)——401/{mr} 类故障不再只沉在 stdout 日志里。
  await assert.rejects(adapter.handle("POST", "/mr/discussions/d-9/resolve",
    new URLSearchParams(), { repo: "r" },
    { "x-mfc-request-id": encodeURIComponent("mrr-1") }));
  const errorRow = rows().at(-1) as any;
  assert.equal(errorRow.level, "error");
  assert.match(errorRow.error, /\{mr\}/);
  assert.equal(errorRow.parent_request_id, "mrr-1");
});
