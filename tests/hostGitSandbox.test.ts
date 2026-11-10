import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostGitSandbox, runGitProcess } from "../src/hostGitSandbox.ts";

test("宿主 Git 独立模块隔离环境与凭据，操作结束可清理且不依赖任务服务", async () => {
  const dir = mkdtempSync(join(tmpdir(),"host-git-module-"));
  const sandbox = new HostGitSandbox(dir);
  const original = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_COUNT = "123";
  let prepared: ReturnType<HostGitSandbox["prepare"]> | undefined;
  try {
    prepared = sandbox.prepare({username:"test-user",password:"test-password"});
    assert.equal(prepared.env.GIT_CONFIG_COUNT,undefined);
    assert.equal(prepared.env.GIT_TERMINAL_PROMPT,"0");
    assert.equal(statSync(prepared.dir).mode & 0o777,0o700);
    assert.equal(statSync(join(prepared.dir,"credential")).mode & 0o777,0o600);
    assert.match(readFileSync(prepared.helper!,"utf8"),/credential/);
    assert.ok(!prepared.args.some(arg => arg.includes("test-password")));
    const hooks = await runGitProcess([...prepared.args,"config","--get","core.hooksPath"],{env:prepared.env,timeoutMs:5000});
    assert.equal(hooks.status,0);assert.equal(hooks.stdout.trim(),"/dev/null");
    const protocol = await runGitProcess([...prepared.args,"config","--get","protocol.ext.allow"],{env:prepared.env,timeoutMs:5000});
    assert.equal(protocol.stdout.trim(),"never");
    const bounded = await runGitProcess(["--version"],{env:prepared.env,timeoutMs:5000,maxBuffer:1});
    assert.equal(bounded.status,null);assert.ok(bounded.error);assert.equal(Buffer.byteLength(bounded.stdout),1);
    sandbox.cleanup(prepared);assert.equal(existsSync(prepared.dir),false);prepared=undefined;
  } finally {
    if (original === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT=original;
    sandbox.cleanup(prepared);rmSync(dir,{recursive:true,force:true});
  }
});
