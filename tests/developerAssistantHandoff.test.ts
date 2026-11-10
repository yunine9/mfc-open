import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDeveloperAssistantHandoff,
  captureDeveloperAssistantWorktree,
  finishDeveloperAssistantHandoff,
  inspectDeveloperAssistantAvailability,
  summarizeDeveloperAssistantChangedPaths,
} from "../src/developerAssistantHandoff.ts";
import { mfcTemp } from "./mfcTmp.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function fixture(): { root: string; repo: string; kernel: string } {
  const root = mfcTemp("mfc-assistant-handoff-");
  const repo = join(root, "repo");
  const kernel = join(root, "kernel");
  mkdirSync(repo);
  mkdirSync(join(kernel, "flow"), { recursive: true });
  writeFileSync(join(kernel, "flow", "flow.json"), JSON.stringify({
    steps: {
      build: { title: "自由实现与定稿", allow_source_edit: true },
      delivery_review: {
        title: "交付清单确认",
        user_ack: true,
        approval_subject: { kind: "worktree" },
      },
      external_verify: { title: "等待流水线", host_wait: true },
      push: { title: "推送" },
    },
  }));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  git(repo, "add", "source.ts");
  git(repo, "commit", "-qm", "fixture");
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 7,
  }));
  return { root, repo, kernel };
}

test("开发助手把内核位置当上下文，不阻止用户主动接管", () => {
  const { repo, kernel } = fixture();
  const inspect = () => inspectDeveloperAssistantAvailability(repo, kernel);

  assert.deepEqual(
    { available: inspect().available, code: inspect().code },
    { available: true, code: "edit_window" },
  );

  for (const current of [
    "delivery_review", "external_verify", "push",
  ] as const) {
    writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
      current, revision: 8,
    }));
    const availability = inspect();
    assert.equal(availability.available, true, current);
    assert.equal(availability.code, "user_override", current);
  }
});

test("交还快照识别同一脏文件的内容变化，并跨多轮保留最初起点", () => {
  const { repo, kernel } = fixture();
  writeFileSync(join(repo, "source.ts"), "export const value = 2;\n");
  const availability = inspectDeveloperAssistantAvailability(repo, kernel);
  const initial = captureDeveloperAssistantWorktree(repo);
  const first = beginDeveloperAssistantHandoff(
    undefined, availability, initial, "2026-08-23T00:00:00.000Z");

  writeFileSync(join(repo, "source.ts"), "export const value = 3;\n");
  writeFileSync(join(repo, "new-test.ts"), "export const covered = true;\n");
  const finished = finishDeveloperAssistantHandoff(
    first, captureDeveloperAssistantWorktree(repo), "2026-08-23T00:01:00.000Z");

  assert.equal(finished.state, "changed");
  assert.deepEqual(finished.changed_paths, ["new-test.ts", "source.ts"]);

  const second = beginDeveloperAssistantHandoff(
    finished,
    availability,
    captureDeveloperAssistantWorktree(repo),
    "2026-08-23T00:02:00.000Z",
  );
  assert.equal(second.initial.fingerprint, initial.fingerprint,
    "同一次暂停期间的第二轮助手不能把第一轮修改当成新基线");
});

test("交还快照对大工作区实行路径与读取预算，不生成完整 binary diff", () => {
  const { repo } = fixture();
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(repo, `note-${String(index).padStart(3, "0")}.md`),
      `note ${index}\n`);
  }
  writeFileSync(join(repo, "large.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
  const before = captureDeveloperAssistantWorktree(repo);
  assert.equal(before.paths.length, 256);
  assert.equal(before.paths_truncated, true);
  assert.ok(Object.keys(before.path_fingerprints).length <= 256);

  writeFileSync(join(repo, "note-299.md"), "user changed this document\n");
  const after = captureDeveloperAssistantWorktree(repo);
  const handoff = finishDeveloperAssistantHandoff({
    id: "bounded-snapshot", state: "running",
    started_at: "2026-08-23T00:00:00.000Z",
    initial: before, message: "running",
  }, after);
  assert.equal(handoff.state, "changed");
  assert.equal(handoff.paths_truncated, true,
    "路径超预算只做保守提示，不能把整个 diff/文件内容塞进交还协议");
});

test("暂停前已有未跟踪源码目录，助手改同长度内容仍必须被识别", () => {
  const { repo } = fixture();
  mkdirSync(join(repo, "src", "new-module"), { recursive: true });
  const source = join(repo, "src", "new-module", "A.ts");
  writeFileSync(source, "export const value = 'old';\n");
  const before = captureDeveloperAssistantWorktree(repo);
  writeFileSync(source, "export const value = 'new';\n");
  const handoff = finishDeveloperAssistantHandoff({
    id: "untracked-source", state: "running",
    started_at: "2026-08-23T00:00:00.000Z",
    initial: before, message: "running",
  }, captureDeveloperAssistantWorktree(repo));
  assert.equal(handoff.state, "changed");
  assert.deepEqual(handoff.changed_paths, ["src/new-module/A.ts"]);
});

test("内核 revision 变化只用于定位，不阻止交还", () => {
  const { repo, kernel } = fixture();
  const before = inspectDeveloperAssistantAvailability(repo, kernel);
  const handoff = beginDeveloperAssistantHandoff(
    undefined, before, captureDeveloperAssistantWorktree(repo));
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 8,
  }));
  const after = inspectDeveloperAssistantAvailability(repo, kernel);
  assert.equal(after.core?.revision, 8);
  assert.equal(handoff.core?.revision, 7);
  assert.equal(JSON.parse(readFileSync(join(repo, ".mae-flow.json"), "utf-8")).current,
    "build");
});

test("多轮助手不因 revision 变化吞掉第一轮修改", () => {
  const { repo, kernel } = fixture();
  const first = beginDeveloperAssistantHandoff(undefined,
    inspectDeveloperAssistantAvailability(repo, kernel),
    captureDeveloperAssistantWorktree(repo));
  writeFileSync(join(repo, "first.ts"), "export const first = true;\n");
  const finished = finishDeveloperAssistantHandoff(
    first, captureDeveloperAssistantWorktree(repo));
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "delivery_review", revision: 99,
  }));
  const second = beginDeveloperAssistantHandoff(finished,
    inspectDeveloperAssistantAvailability(repo, kernel),
    captureDeveloperAssistantWorktree(repo));
  assert.equal(second.initial.fingerprint, first.initial.fingerprint);
  assert.equal(finishDeveloperAssistantHandoff(
    second, captureDeveloperAssistantWorktree(repo)).state, "changed");
});

test("新一轮助手不继承上一轮 derived/truncated 诊断标记", () => {
  const { repo, kernel } = fixture();
  const initial = captureDeveloperAssistantWorktree(repo);
  const second = beginDeveloperAssistantHandoff({
    id: "same-intervention", state: "changed",
    started_at: "2026-08-23T00:00:00.000Z",
    initial,
    current: initial,
    changed_paths: [],
    derived_only: true,
    paths_truncated: true,
    message: "第一轮只有构建产物",
  }, inspectDeveloperAssistantAvailability(repo, kernel), initial);
  assert.equal(second.derived_only, undefined);
  assert.equal(second.paths_truncated, undefined);
  assert.equal(second.id, "same-intervention",
    "同一次用户接管仍复用最早起点和幂等编号");
});

test("交还路径摘要优先源码并过滤构建洪水", () => {
  const summary = summarizeDeveloperAssistantChangedPaths([
    ...Array.from({ length: 500 }, (_, index) => `target/classes/C${index}.class`),
    "docs/readme.md", "src/main/java/A.java", "tests/a_test.cpp",
  ], 2);
  assert.deepEqual(summary.paths, ["src/main/java/A.java", "tests/a_test.cpp"]);
  assert.equal(summary.total, 503);
  assert.equal(summary.truncated, true,
    "仍有一条有效文档路径超过上限，应明确告诉内核摘要被截断");
  assert.equal(summary.derivedOnly, false);
  assert.equal(summarizeDeveloperAssistantChangedPaths([
    "target/classes/A.class", "node_modules/pkg/index.js",
  ]).derivedOnly, true);
});

test("Git HEAD 变化会刷新现场但不会阻止交还", () => {
  const { repo, kernel } = fixture();
  const availability = inspectDeveloperAssistantAvailability(repo, kernel);
  const handoff = beginDeveloperAssistantHandoff(
    undefined, availability, captureDeveloperAssistantWorktree(repo));
  writeFileSync(join(repo, "source.ts"), "export const value = 99;\n");
  git(repo, "add", "source.ts");
  git(repo, "commit", "-qm", "unexpected assistant commit");

  const finished = finishDeveloperAssistantHandoff(
    handoff, captureDeveloperAssistantWorktree(repo));
  assert.equal(finished.state, "changed");
  assert.match(finished.message, /不会阻塞任务/);
});
