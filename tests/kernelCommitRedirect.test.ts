import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { KernelHost } from "../src/kernelHost.ts";

test("真实内核与安全 Git 视图：修复提交重定向不丢暂存文件，既有用户改动不硬拦截", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-commit-redirect-"));
  const kernelRoot = resolve("kernel");
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: workspace, encoding: "utf-8",
  }).trim();
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), body);
  };
  const paths = ["model/api.yaml", "src/Repair.java", "tests/RepairTest.java"];
  try {
    git("init", "--quiet");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.test");
    for (const path of paths) write(path, "before\n");
    git("add", "--", ...paths);
    git("commit", "--quiet", "-m", "base");
    git("checkout", "-qb", "feature");
    const sha = git("rev-parse", "HEAD");
    const state = {
      current: "external_verify",
      config: { 单号: "REQ123", 单号类型: "fix", CHANGE_NAME: "repair",
        基线分支: "main", 分支名: "feature" },
      choices: { workflow: "full" }, history: [], started: "2026-09-08 08:00:00",
      initial_dirty: [], initial_dirty_fingerprints: {},
      quality: { external_verification: { verdict: "RED", sha } },
      external_repair_authorization: {
        schema: "mae-flow-external-repair/1", status: "ready", failed_sha: sha,
        issued_at: "2026-09-08 08:00:00", baseline_dirty: ["user.txt"],
      },
    };
    execFileSync("python3", ["-c", [
      "import sys,json",
      "sys.path.insert(0,sys.argv[1])",
      "from mae_flow_core import cli_runtime as mf",
      "mf.save_state(json.loads(sys.argv[2]))",
    ].join("\n"), join(kernelRoot, "scripts"), JSON.stringify(state)], {
      cwd: workspace, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    write("user.txt", "existing user work\n");
    for (const path of paths) write(path, "after\n");
    git("add", "--", ...paths);
    const host = new KernelHost({
      kernelRoot, workspace, taskId: "repair-redirect",
      transcriptPath: join(workspace, "transcript.jsonl"),
    });
    let eventId = 0;
    const pre = (command: string) => host.preTool({
      eventId: ++eventId, taskId: "repair-redirect", sessionId: "main", ts: "",
      kind: "tool_requested",
      payload: { call_id: `commit-${eventId}`, name: "Bash", input: { command } },
    });
    for (const suffix of ["", "2>&1", ">/dev/null 2>&1", "| cat"]) {
      const result = await pre(`cd ${workspace} && git commit -m "[REQ123][fix]repair" ${suffix}`);
      assert.equal(result, undefined, JSON.stringify(result));
    }
    git("add", "--", "user.txt");
    const allowed = await pre('git commit -m "[REQ123][fix]repair" 2>&1');
    assert.equal(allowed, undefined,
      "减权后不以工作区必须干净为理由阻断 Agent");
    assert.match(git("diff", "--cached", "--name-only"), /user\.txt/,
      "内核预处理不得丢掉原有暂存内容");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
