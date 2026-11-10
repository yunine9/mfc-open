/**
 * 资产库故障注入(第三批加固):兜底必须在它防御的故障下被测。
 * 事务契约:operations.jsonl 先行(WAL,追加失败=整个操作失败、
 * 状态零变化);asset.json 原子替换是提交点;中断后一切以文件为准,
 * 重试可恢复。日志故障用真 chmod 逼真 EACCES;写序中断用注入口
 * 精确打在指定文件上(真件模拟不了"draft 写成、asset 没写成"的
 * 中间时刻)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import {
  WorkflowAssetError,
  WorkflowAssetLibrary,
  type WorkflowAssetFaultHook,
} from "../src/workflowAssetLibrary.ts";

function definition(technologies: string[] = []) {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: {
      standard_id: "std-dev",
      standard_version: "2026.08",
      catalog_digest: `sha256:${"a".repeat(64)}`,
    },
    applicability: {
      business_module_ids: [], repositories: [], technologies,
    },
    edits: [],
  };
}

/** 可开关的定点故障:只打中指定文件名结尾的那一次写。 */
function faultOn(suffixes: () => string[]): WorkflowAssetFaultHook {
  return (action, path) => {
    if (suffixes().some((suffix) => path.endsWith(suffix))) {
      throw new Error(`注入故障:${action} ${path}`);
    }
  };
}

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-wf-faults-"));
  for (const id of ["java", "go", "rust"]) createTechnologyStack(dataDir, { id, name: id }, "admin");
  let targets: string[] = [];
  const assets = new WorkflowAssetLibrary(dataDir, {
    faultInjection: faultOn(() => targets),
  });
  return {
    assets,
    root: join(dataDir, "workflow-assets"),
    arm: (...suffixes: string[]) => { targets = suffixes; },
    disarm: () => { targets = []; },
  };
}

function oplogOps(root: string): string[] {
  const path = join(root, "operations.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line).op);
}

test("操作日志写失败:整个操作失败,状态零变化(账先行 fail-closed)", () => {
  const { assets, root, arm, disarm } = harness();
  assets.create({ id: "wf-log-fault", name: "x", scope: "team",
    owner: "alice", definition: definition() });
  disarm();
  // 真件:把 operations.jsonl 改成只读,追加吃真 EACCES。
  chmodSync(join(root, "operations.jsonl"), 0o444);
  try {
    assert.throws(() => assets.saveDraft("wf-log-fault", {
      definition: definition(["go"]), expected_revision: 1, actor: "bob",
    }), /EACCES|permission/i);
  } finally {
    chmodSync(join(root, "operations.jsonl"), 0o644);
  }
  // 账没记成,状态必须一动不动:revision 仍 1,内容仍旧。
  const detail = assets.get("wf-log-fault");
  assert.equal(detail.draft.revision, 1);
  assert.deepEqual(detail.draft.definition.applicability.technologies, []);
  assert.deepEqual(oplogOps(root), ["create"], "失败的操作不能留下半行账");
  // 权限恢复后原参数重试直接成功——fail-closed 的出路是重试,不是死账。
  assets.saveDraft("wf-log-fault", {
    definition: definition(["go"]), expected_revision: 1, actor: "bob",
  });
  assert.equal(assets.get("wf-log-fault").draft.revision, 2);
});

test("草稿写失败:账已记但状态零变化,按原 revision 重试即恢复", () => {
  const { assets, arm, disarm } = harness();
  assets.create({ id: "wf-draft-fault", name: "x", scope: "team",
    owner: "alice", definition: definition() });
  arm("draft.json");
  assert.throws(() => assets.saveDraft("wf-draft-fault", {
    definition: definition(["go"]), expected_revision: 1, actor: "bob",
  }), /注入故障/);
  disarm();
  // draft 与 asset 都没动:锁与内容原样;同一 expected_revision 重试成功。
  const detail = assets.get("wf-draft-fault");
  assert.equal(detail.draft.revision, 1);
  assert.equal(detail.asset.draft_revision, 1);
  const retried = assets.saveDraft("wf-draft-fault", {
    definition: definition(["go"]), expected_revision: 1, actor: "bob",
  });
  assert.equal(retried.draft.revision, 2);
});

test("元数据写失败:draft 已前进、asset 缓存落后——锁看 draft,自愈", () => {
  const { assets, arm, disarm, root } = harness();
  assets.create({ id: "wf-meta-fault", name: "x", scope: "team",
    owner: "alice", definition: definition() });
  arm("asset.json");
  assert.throws(() => assets.saveDraft("wf-meta-fault", {
    definition: definition(["go"]), expected_revision: 1, actor: "bob",
  }), /注入故障/);
  disarm();
  // 中断形态:draft.revision=2(权威),asset 缓存仍写着 1。
  const detail = assets.get("wf-meta-fault");
  assert.equal(detail.draft.revision, 2, "draft.json 是乐观锁唯一权威");
  assert.equal(detail.asset.draft_revision, 1, "asset 缓存允许落后");
  // 拿旧 revision(1)来写必须冲突——锁语义不因缓存落后而松动。
  assert.throws(() => assets.saveDraft("wf-meta-fault", {
    definition: definition(["rust"]), expected_revision: 1, actor: "eve",
  }), (error: unknown) => error instanceof WorkflowAssetError
    && error.code === "revision_conflict" && error.current_revision === 2);
  // 按权威 revision 继续写,成功且缓存自愈。
  const healed = assets.saveDraft("wf-meta-fault", {
    definition: definition(["rust"]), expected_revision: 2, actor: "bob",
  });
  assert.equal(healed.draft.revision, 3);
  assert.equal(healed.asset.draft_revision, 3, "下一次成功写入自愈缓存");
  void root;
});

test("create 中断:残骸惰性、列表点名,同 ID 重建直接回收", () => {
  const { assets, arm, disarm } = harness();
  arm("asset.json");
  assert.throws(() => assets.create({
    id: "wf-half", name: "半份", scope: "team",
    owner: "alice", definition: definition(),
  }), /注入故障/);
  disarm();
  // 半份资产不冒充存在:详情按 not_found 拒,列表点名 warning。
  assert.throws(() => assets.get("wf-half"),
    (error: unknown) => error instanceof WorkflowAssetError
      && error.code === "not_found");
  const listed = assets.list();
  assert.equal(listed.items.length, 0);
  assert.equal(listed.warnings.length, 1);
  // 同 ID 重新创建=回收残骸,一切照常。
  const rebuilt = assets.create({
    id: "wf-half", name: "重建", scope: "team",
    owner: "alice", definition: definition(),
  });
  assert.equal(rebuilt.status, "draft");
  assert.deepEqual(assets.list().warnings, []);
});

test("发布中断后重试:vN 已落盘、提交点没写——重试续跑,不再撞墙", () => {
  const { assets, arm, disarm, root } = harness();
  assets.create({ id: "wf-approve-crash", name: "x", scope: "team",
    owner: "alice", definition: definition(["java"]) });
  assets.submitForReview("wf-approve-crash", { actor: "alice" });
  arm("asset.json");   // v1 会写成,提交点失败
  assert.throws(() => assets.approve("wf-approve-crash", { actor: "carol" }),
    /注入故障/);
  disarm();
  const v1Path = join(root, "wf-approve-crash", "versions", "v1.json");
  assert.ok(existsSync(v1Path), "中断时 v1 已不可变落盘");
  const v1Before = readFileSync(v1Path, "utf-8");
  assert.equal(assets.get("wf-approve-crash").asset.status,
    "pending_review", "提交点未写,生命周期未变");
  // 重试:复用已存在的同内容 v1,补写提交点;v1 一个字节不动。
  const retried = assets.approve("wf-approve-crash", { actor: "carol" });
  assert.equal(retried.status, "published");
  assert.equal(retried.latest_version, 1);
  assert.equal(readFileSync(v1Path, "utf-8"), v1Before);
});

test("发布中断后改稿再发布:孤儿 vN 被回收,不再永久焊死", () => {
  // 旧行为曾把这条路钉成 version_exists 拒绝——那意味着一次崩溃就让
  // 资产永远发不出去(2026-08-29 部署审计实锤)。提交点(asset.json 的
  // latest_version)没前进的 vN 是可证明的孤儿,发布时回收重写。
  const { assets, arm, disarm, root } = harness();
  assets.create({ id: "wf-v-exists", name: "x", scope: "team",
    owner: "alice", definition: definition(["java"]) });
  assets.submitForReview("wf-v-exists", { actor: "alice" });
  arm("asset.json");
  assert.throws(() => assets.approve("wf-v-exists", { actor: "carol" }));
  disarm();
  // 中断后草稿被撤回改了内容再发布:v1 已存在但 digest 不同。
  assets.withdraw("wf-v-exists", { actor: "alice" });
  assets.saveDraft("wf-v-exists", {
    definition: definition(["java", "go"]),
    expected_revision: 1, actor: "alice",
  });
  assets.submitForReview("wf-v-exists", { actor: "alice" });
  const v1Path = join(root, "wf-v-exists", "versions", "v1.json");
  const v1Before = readFileSync(v1Path, "utf-8");
  const republished = assets.approve("wf-v-exists", { actor: "carol" });
  assert.equal(republished.status, "published");
  assert.equal(republished.latest_version, 1);
  assert.notEqual(readFileSync(v1Path, "utf-8"), v1Before,
    "孤儿 v1 已被新内容替换");
  const v1 = JSON.parse(readFileSync(v1Path, "utf-8"));
  const draft = JSON.parse(readFileSync(
    join(root, "wf-v-exists", "draft.json"), "utf-8"));
  assert.equal(v1.digest, draft.digest, "落盘版本就是重发布的草稿内容");
  // 回收只适用于提交点之外的孤儿:已发布的 v1 从此不可再动。
  const v1Committed = readFileSync(v1Path, "utf-8");
  assets.saveDraft("wf-v-exists", {
    definition: definition(["java", "go", "rust"]),
    expected_revision: 2, actor: "alice",
  });
  assets.submitForReview("wf-v-exists", { actor: "alice" });
  const next = assets.approve("wf-v-exists", { actor: "carol" });
  assert.equal(next.latest_version, 2, "提交点之内的版本只增不改");
  assert.equal(readFileSync(v1Path, "utf-8"), v1Committed,
    "已提交的 v1 一个字节不动");
});

test("两个写者同一 revision:后到者冲突可识别,按新 revision 重试成功", () => {
  const { assets } = harness();
  assets.create({ id: "wf-two-writers", name: "x", scope: "team",
    owner: "alice", maintainers: ["bob"], definition: definition() });
  // A、B 同时基于 revision 1 编辑;A 先落盘。
  assets.saveDraft("wf-two-writers", {
    definition: definition(["go"]), expected_revision: 1, actor: "alice",
  });
  assert.throws(() => assets.saveDraft("wf-two-writers", {
    definition: definition(["rust"]), expected_revision: 1, actor: "bob",
  }), (error: unknown) => error instanceof WorkflowAssetError
    && error.code === "revision_conflict" && error.current_revision === 2);
  // B 拿冲突里给的 current_revision 刷新后重试:成功,不覆盖 A 的账。
  const merged = assets.saveDraft("wf-two-writers", {
    definition: definition(["go", "rust"]),
    expected_revision: 2, actor: "bob",
  });
  assert.equal(merged.draft.revision, 3);
  assert.deepEqual(merged.draft.definition.applicability.technologies,
    ["go", "rust"]);
});
