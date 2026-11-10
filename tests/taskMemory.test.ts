/**
 * 任务记忆(docs/knowledge-memory-design.md)第一期契约。
 *
 * 三条钉死:
 * 1. **闭环即入库,人无感**:人圈、Agent 改、人确认三件套齐才落;not_fixed
 *    不落;Build-Fix 一次过不落,失败过又修好才落。
 * 2. **md 是正本,只追加**:frontmatter 齐、撤回是追加覆盖、路径不出 corpus/。
 * 3. **记忆是短句**:2000 字封顶,超了拒收且不留半截批注。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore, renderMemoryMarkdown, repoSlug, type MemoryInput,
} from "../src/taskMemory.ts";
import { TaskService, TaskControlError } from "../src/taskService.ts";
import type { AnnotationStore } from "../src/annotations.ts";

function service(): { service: TaskService; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory-"));
  return {
    dataDir,
    service: new TaskService({
      dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    }),
  };
}

test("repoSlug:URL 只留末段,越界字符一律换掉", () => {
  assert.equal(repoSlug("git@example.com:demo/notify-service.git"), "notify-service");
  assert.equal(repoSlug("https://codehub.x/team/order.git/"), "order");
  assert.equal(repoSlug("../../etc"), "etc");
  assert.equal(repoSlug(undefined), "_unknown");
});

test("记录:md 正本四段固定,索引一行,只追加;撤回是覆盖不是删除", () => {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "mfc-memory-")));
  const first = store.record({
    source: "user_note", judged_by: "human", scope: "general",
    repo: "notify-service", paths: ["src/Filter.java"], line: 88,
    phase: "写代码", task: "task-1", evidence: "annotation:a-1", author: "alice",
    trigger: "改 Filter.java 第 88 行附近时",
    quote: "if (enabled) check();\n// 第二行",
    conclusion: "黑名单判断必须在渠道开关之前",
  });
  const md = readFileSync(join(store.root, first.file), "utf-8");
  assert.match(md, /^---\nid: "c-/);
  assert.match(md, /\npaths: \["src\/Filter.java"\]\n/);
  assert.match(md, /\nline: 88\n/);
  assert.match(md, /\n---\n# 改 Filter.java 第 88 行附近时\n\n## 原文\n> if \(enabled\) check\(\);\n> \/\/ 第二行\n\n## 结论\n黑名单判断必须在渠道开关之前\n$/);
  assert.equal(md.includes("## 问题"), false, "空段不写,别切出空块");
  assert.equal(store.list({ task: "task-1" }).length, 1);
  assert.equal(store.read(first.id), md);

  // 撤回:别人不能撤;作者撤了是追加一条覆盖记录,原文件仍在
  assert.throws(() => store.withdraw(first.id, "bob"), /只能由本人撤回/);
  const gone = store.withdraw(first.id, "alice");
  assert.equal(gone.withdrawn, true);
  assert.equal(gone.supersedes, first.id);
  assert.ok(existsSync(join(store.root, first.file)), "撤回不删正本");
  const rows = store.list({ task: "task-1" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].superseded_by, gone.id);
  assert.throws(() => store.withdraw(first.id, "alice"), /已经被撤回/);
  // 闭环事实不能撤
  const fact = store.record({
    source: "annotation", judged_by: "human", scope: "local",
    repo: "notify-service", paths: [], task: "task-1", evidence: "annotation:a-2",
    author: "alice", trigger: "x", conclusion: "y",
  });
  assert.throws(() => store.withdraw(fact.id, "alice"), /闭环事实不撤/);
});

test("记忆是短句:2000 字封顶,超了指路 Skill;repo 越界会被归一", () => {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "mfc-memory-")));
  assert.throws(() => store.record({
    source: "user_note", judged_by: "human", scope: "general",
    repo: "x", paths: [], task: "t", evidence: "e", trigger: "t",
    conclusion: "长".repeat(2001),
  }), /Skill/);
  const record = store.record({
    source: "user_note", judged_by: "human", scope: "general",
    repo: "../../escape", paths: [], task: "t", evidence: "e",
    trigger: "t", conclusion: "ok",
  });
  assert.equal(record.repo, "escape");
  assert.match(record.file, /^escape\//);
  assert.match(renderMemoryMarkdown(record), /\nrepo: "escape"\n/);
});

test("圈选「记为记忆」:不发给任何人、状态直接闭环、立刻落一条 user_note", async () => {
  const { service: svc } = service();
  try {
    const id = svc.create("给手机号打码").id;
    const internal = (svc as any).tasks.get(id);
    internal.summary.repo_url = "git@example.com:demo/notify-service.git";
    const note = svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/Filter.java", line: 88,
      anchor: "if (enabled) check();", note: "黑名单判断必须在渠道开关之前",
      kind: "code", route: "memory",
    });
    assert.equal(note.status, "verified", "圈的那一下就是闭环");
    assert.equal(note.route, "memory");
    const store = (svc as any).annotations(internal) as AnnotationStore;
    assert.equal(store.drafts().length, 0, "不进待送出队列");

    const rows = svc.listTaskMemories(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "user_note");
    assert.equal(rows[0].repo, "notify-service");
    assert.deepEqual(rows[0].paths, ["src/Filter.java"]);
    assert.equal(rows[0].line, 88);
    assert.equal(rows[0].quote, "if (enabled) check();");
    assert.equal(rows[0].conclusion, "黑名单判断必须在渠道开关之前");
    assert.equal(rows[0].evidence, `annotation:${note.id}`);
    assert.equal(svc.get(id)?.memories_recorded, 1);
    const found = svc.readTaskMemory(id, rows[0].id);
    assert.match(found?.content ?? "", /^---\n/);

    // 超长拒收,而且不留半截批注
    assert.throws(() => svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/Filter.java", line: 1,
      anchor: "x", note: "长".repeat(2001), kind: "code", route: "memory",
    }), (error) => error instanceof TaskControlError && /Skill/.test(error.message));
    assert.equal(store.visible().length, 1, "超长那条不能留下批注");

    // 撤回走服务端:别人不行,本人可以
    assert.throws(() => svc.withdrawTaskMemory(id, rows[0].id, "bob"),
      (error) => error instanceof TaskControlError && /本人/.test(error.message));
    svc.withdrawTaskMemory(id, rows[0].id, "alice");
    assert.equal(svc.listTaskMemories(id).filter((row) => !row.withdrawn
      && !row.superseded_by).length, 0);
  } finally {
    await svc.shutdown();
  }
});

test("闭环保留采纳与否决事实，过程中不自动提炼经验", async () => {
  const { service: svc } = service();
  try {
    const id = svc.create("给手机号打码").id;
    const internal = (svc as any).tasks.get(id);
    const store = (svc as any).annotations(internal) as AnnotationStore;
    const add = (note: string) => svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/Mask.java", line: 23,
      anchor: "return raw;", note, kind: "code",
    });
    const fixed = add("掩码要保留后四位");
    const notFixed = add("这里别动");
    store.markSent([fixed.id, notFixed.id], "interrupt");
    store.respond(fixed.id, {
      outcome: "fixed", summary: "已改为保留后四位并补了 UT",
      evidence: ["src/Mask.java:23"],
    });
    store.respond(notFixed.id, {
      outcome: "not_fixed", summary: "与现有约定冲突,未改", evidence: [],
    });
    svc.verifyAnnotation(id, fixed.id, "本地用户");
    svc.verifyAnnotation(id, notFixed.id, "本地用户", false, { revision: 0, outcome: "not_adopted", reason: "与现有约定冲突，不修改" });
    const rows = svc.listTaskMemories(id);
    assert.equal(rows.length, 0, "过程闭环不即时生成经验，保留批注供交付后整体分析");
    assert.equal(store.list().find(row => row.id === fixed.id)?.resolution?.outcome, "fixed");
    assert.equal(store.list().find(row => row.id === notFixed.id)?.resolution?.outcome, "not_adopted");
  } finally {
    await svc.shutdown();
  }
});


test("只圈不写的记忆:结论就是圈的那段原文", () => {
  const { service: svc } = service();
  try {
    const id = svc.create("给手机号打码").id;
    const internal = (svc as any).tasks.get(id);
    internal.summary.repo_url = "git@example.com:demo/notify-service.git";
    svc.addAnnotation(id, {
      author: "alice", artifact: "需求原文", file: "需求原文", line: 5, line_end: 7,
      anchor: "要求:", quote: "要求:\n黑名单先于渠道开关\n不改 registry.xml",
      note: "", kind: "doc", route: "memory",
    });
    const [row] = svc.listTaskMemories(id);
    assert.equal(row.conclusion, "要求:\n黑名单先于渠道开关\n不改 registry.xml");
    assert.equal(row.quote, row.conclusion, "原文与结论同一段:记的是这段话本身");
  } finally {
    void svc.shutdown();
  }
});
