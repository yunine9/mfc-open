/**
 * 工作流资产库契约(HANDOFF-workflow-assets-cc 第一批):
 * 乐观锁冲突可识别、已发布版本永不可覆盖、归档不删历史、副本深拷贝
 * 不共享、损坏记录读侧跳过写侧拒绝、operations.jsonl 留痕。
 * 裁判尽量用真件:真文件系统、真符号链接、真篡改。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowAssetError,
  WorkflowAssetLibrary,
  canEdit,
  canPublish,
  canView,
  type WorkflowAssetRecord,
} from "../src/workflowAssetLibrary.ts";
import { workflowDigest } from "../src/workflowDefinition.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";

function definition(technologies: string[] = []) {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: {
      standard_id: "std-dev",
      standard_version: "2026.08",
      catalog_digest: `sha256:${"a".repeat(64)}`,
    },
    applicability: {
      business_module_ids: [],
      repositories: [],
      technologies,
    },
    edits: [],
  };
}

function library() {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-wf-assets-"));
  for (const id of ["java", "go", "rust", "python", "koa"]) {
    createTechnologyStack(dataDir, { id, name: id }, "admin");
  }
  return {
    library: new WorkflowAssetLibrary(dataDir),
    root: join(dataDir, "workflow-assets"),
  };
}

function readAsset(root: string, id: string): WorkflowAssetRecord {
  return JSON.parse(readFileSync(join(root, id, "asset.json"), "utf-8"));
}

test("创建/列表/详情:定义过契约归一,digest 用共享算法", () => {
  const { library: assets } = library();
  const created = assets.create({
    id: "wf-alpha", name: "评审流", scope: "team",
    owner: "developer", maintainers: ["bob"],
    definition: definition(["java"]),
  });
  assert.equal(created.status, "draft");
  assert.equal(created.draft_revision, 1);
  assert.equal(created.selectable_for_tasks, false, "未发布不可被任务选择");

  const detail = assets.get("wf-alpha");
  assert.equal(detail.draft.digest,
    workflowDigest(detail.draft.definition),
    "digest 必须是共享契约算法对归一化定义的结果");
  assert.deepEqual(detail.draft.definition.applicability.technologies,
    ["java"]);
  assert.equal(detail.versions.length, 0);

  const listed = assets.list();
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.warnings, []);
});

test("草稿乐观锁:旧 revision 提交给出可识别冲突,不悄悄覆盖", () => {
  const { library: assets } = library();
  assets.create({ id: "wf-lock", name: "锁", scope: "personal",
    owner: "developer", definition: definition() });
  assets.saveDraft("wf-lock", {
    definition: definition(["go"]), expected_revision: 1, actor: "developer",
  });
  // 第二个编辑者拿着旧 revision 提交:必须拿到 code + 当前 revision。
  assert.throws(
    () => assets.saveDraft("wf-lock", {
      definition: definition(["rust"]), expected_revision: 1, actor: "bob",
    }),
    (error: unknown) => error instanceof WorkflowAssetError
      && error.code === "revision_conflict"
      && error.current_revision === 2,
  );
  // 冲突之后现场未被污染:仍是第一个人的内容。
  const detail = assets.get("wf-lock");
  assert.deepEqual(detail.draft.definition.applicability.technologies, ["go"]);
});

test("生命周期:提交/撤回/驳回/通过;发布落 v1 且改稿开新周期", () => {
  const { library: assets, root } = library();
  assets.create({ id: "wf-life", name: "生命周期", scope: "team",
    owner: "developer", definition: definition(["java"]) });

  assets.submitForReview("wf-life", { actor: "developer" });
  assert.equal(assets.get("wf-life").asset.status, "pending_review");
  // 待审核中不能改草稿:先撤回。
  assert.throws(() => assets.saveDraft("wf-life", {
    definition: definition(), expected_revision: 1, actor: "developer",
  }), (error: unknown) => error instanceof WorkflowAssetError
    && error.code === "invalid_state");

  assets.withdraw("wf-life", { actor: "developer" });
  assert.equal(assets.get("wf-life").asset.status, "draft");
  assets.submitForReview("wf-life", { actor: "developer" });
  assets.reject("wf-life", { actor: "carol", reason: "范围太大" });
  assert.equal(assets.get("wf-life").asset.status, "draft");

  assets.submitForReview("wf-life", { actor: "developer" });
  const published = assets.approve("wf-life", { actor: "carol" });
  assert.equal(published.status, "published");
  assert.equal(published.latest_version, 1);
  assert.equal(published.selectable_for_tasks, true);
  const v1 = JSON.parse(readFileSync(
    join(root, "wf-life", "versions", "v1.json"), "utf-8"));
  assert.equal(v1.version, 1);

  // 修改已发布资产 = 新草稿周期;v1 原样保留,再发布得 v2。
  assets.saveDraft("wf-life", {
    definition: definition(["java", "python"]),
    expected_revision: 1, actor: "developer",
  });
  assert.equal(assets.get("wf-life").asset.status, "draft");
  assets.submitForReview("wf-life", { actor: "developer" });
  assets.approve("wf-life", { actor: "carol" });
  const detail = assets.get("wf-life");
  assert.equal(detail.asset.latest_version, 2);
  assert.equal(detail.versions.length, 2);
  const v1After = JSON.parse(readFileSync(
    join(root, "wf-life", "versions", "v1.json"), "utf-8"));
  assert.deepEqual(v1After, v1, "v1 在 v2 发布后必须一个字节不变");

  // 非待审核状态 approve:状态机拒绝。
  assert.throws(() => assets.approve("wf-life", { actor: "carol" }),
    (error: unknown) => error instanceof WorkflowAssetError
      && error.code === "invalid_state");
});

test("已发布 vN 永不可覆盖:同内容撞车=中断续跑自愈,异内容=拒绝", () => {
  const { library: assets, root } = library();
  assets.create({ id: "wf-immutable", name: "不可覆盖", scope: "team",
    owner: "developer", definition: definition(["java"]) });
  assets.submitForReview("wf-immutable", { actor: "developer" });
  assets.approve("wf-immutable", { actor: "carol" });
  const before = readFileSync(
    join(root, "wf-immutable", "versions", "v1.json"), "utf-8");

  // 元数据拨回 + 草稿内容与 v1 相同:磁盘形状等同"发布写完 vN、
  // 提交点没写就中断"——按事务策略判定为续跑,补写提交点自愈,
  // v1 一个字节不动(复用,不重写)。
  const record = readAsset(root, "wf-immutable");
  record.latest_version = 0;
  record.status = "pending_review";
  writeFileSync(join(root, "wf-immutable", "asset.json"),
    JSON.stringify(record));
  const healed = assets.approve("wf-immutable", { actor: "carol" });
  assert.equal(healed.latest_version, 1);
  assert.equal(readFileSync(
    join(root, "wf-immutable", "versions", "v1.json"), "utf-8"), before,
  "续跑必须复用已落盘的 v1,不能重写");

  // 草稿内容不同再诱导重写 v1:真冲突,version_exists 拒绝且 v1 原样。
  assets.saveDraft("wf-immutable", {
    definition: definition(["java", "rust"]),
    expected_revision: 1, actor: "developer",
  });
  const tampered = readAsset(root, "wf-immutable");
  tampered.latest_version = 0;
  tampered.status = "pending_review";
  writeFileSync(join(root, "wf-immutable", "asset.json"),
    JSON.stringify(tampered));
  assert.throws(() => assets.approve("wf-immutable", { actor: "mallory" }),
    (error: unknown) => error instanceof WorkflowAssetError
      && error.code === "version_exists");
  assert.equal(readFileSync(
    join(root, "wf-immutable", "versions", "v1.json"), "utf-8"), before,
  "覆盖尝试失败后 v1 内容必须原样");
});

test("复制:副本深拷贝带 copied_from,改副本不动源;归档只挡新任务", () => {
  const { library: assets } = library();
  assets.create({ id: "wf-origin", name: "源", scope: "team",
    owner: "developer", definition: definition(["java"]) });
  assets.submitForReview("wf-origin", { actor: "developer" });
  assets.approve("wf-origin", { actor: "carol" });

  const copy = assets.copy({
    source: { kind: "workflow", id: "wf-origin" },
    name: "我的改版", scope: "personal", owner: "bob", actor: "bob",
  });
  assert.equal(copy.status, "draft", "副本从草稿重新开始,绝不共享编辑");
  assert.deepEqual(copy.copied_from,
    { kind: "workflow", id: "wf-origin", version: "v1",
      digest: assets.getPublished("wf-origin").digest });

  assets.saveDraft(copy.id, {
    definition: definition(["java", "koa"]),
    expected_revision: 1, actor: "bob",
  });
  assert.deepEqual(
    assets.get("wf-origin").draft.definition.applicability.technologies,
    ["java"], "改副本不能影响源资产");

  // task 来源必须自带 definition。
  assert.throws(() => assets.copy({
    source: { kind: "task", id: "task-1" },
    name: "x", scope: "personal", owner: "bob",
  }), (error: unknown) => error instanceof WorkflowAssetError
    && error.code === "invalid_input");

  // 归档:新任务不能默认选择,但指定版本的历史读取照常。
  assets.archive("wf-origin", { actor: "developer" });
  const archived = assets.get("wf-origin");
  assert.equal(archived.asset.status, "archived");
  assert.equal(archived.asset.selectable_for_tasks, false);
  assert.equal(archived.versions.length, 1, "归档不删除任何历史版本");
  assert.throws(() => assets.getPublished("wf-origin"),
    (error: unknown) => error instanceof WorkflowAssetError
      && error.code === "invalid_state");
  assert.equal(assets.getPublished("wf-origin", 1).version, 1);
});

test("损坏记录:读侧跳过并点名 warning,写侧 fail-closed 拒绝", () => {
  const { library: assets, root } = library();
  assets.create({ id: "wf-good", name: "好", scope: "team",
    owner: "developer", definition: definition() });
  // 真损坏:一个目录的元数据是半截 JSON。
  mkdirSync(join(root, "wf-broken"), { recursive: true });
  writeFileSync(join(root, "wf-broken", "asset.json"), "{\"schema\":");
  // 真符号链接目录:指向库外。
  symlinkSync(tmpdir(), join(root, "wf-sneaky"));

  const listed = assets.list();
  assert.deepEqual(listed.items.map((item) => item.id), ["wf-good"]);
  assert.equal(listed.warnings.length, 2,
    "坏账与软链都要点名,静默跳过等于假装没坏");

  assert.throws(() => assets.saveDraft("wf-broken", {
    definition: definition(), expected_revision: 1, actor: "bob",
  }), (error: unknown) => error instanceof WorkflowAssetError
    && error.code === "corrupted");
  assert.throws(() => assets.create({
    id: "wf-sneaky", name: "s", scope: "team", owner: "x",
    definition: definition(),
  }), (error: unknown) => error instanceof WorkflowAssetError
    && error.code === "corrupted");
});

test("路径防护:非法 ID 与保留名一律拒绝", () => {
  const { library: assets } = library();
  for (const id of ["../evil", "a/b", "", ".hidden", "operations.jsonl"]) {
    assert.throws(() => assets.create({
      id, name: "x", scope: "personal", owner: "u",
      definition: definition(),
    }), (error: unknown) => error instanceof WorkflowAssetError
      && error.code === "invalid_input", `ID ${JSON.stringify(id)} 应被拒绝`);
  }
});

test("权限基线:个人限 owner/maintainer,团队可见;发布口径分 scope", () => {
  const { library: assets, root } = library();
  assets.create({ id: "wf-personal", name: "个人", scope: "personal",
    owner: "alice", maintainers: ["bob"], definition: definition() });
  assets.create({ id: "wf-team", name: "团队", scope: "team",
    owner: "alice", maintainers: ["bob"], definition: definition() });
  const personal = readAsset(root, "wf-personal");
  const team = readAsset(root, "wf-team");

  assert.equal(canView(personal, "alice"), true);
  assert.equal(canView(personal, "bob"), true);
  assert.equal(canView(personal, "mallory"), false);
  assert.equal(canView(team, "mallory"), true, "团队资产人人可见");

  assert.equal(canEdit(team, "bob"), true);
  assert.equal(canEdit(team, "mallory"), false);

  assert.equal(canPublish(personal, "alice"), true);
  assert.equal(canPublish(personal, "bob"), false,
    "个人资产只有本人能发布");
  assert.equal(canPublish(team, "bob"), true,
    "团队 maintainer 可提发布,是否加审留给 route 层");

  const archived: WorkflowAssetRecord = { ...team, status: "archived" };
  assert.equal(canEdit(archived, "alice"), false, "归档后不可编辑");
  assert.equal(canPublish(archived, "alice"), false);
});

test("operations.jsonl:每次变更一行留痕,含操作、资产与操作人", () => {
  const { library: assets, root } = library();
  assets.create({ id: "wf-log", name: "留痕", scope: "team",
    owner: "developer", definition: definition() });
  assets.saveDraft("wf-log", {
    definition: definition(["go"]), expected_revision: 1, actor: "bob",
  });
  assets.submitForReview("wf-log", { actor: "bob" });
  assets.approve("wf-log", { actor: "carol" });
  assets.archive("wf-log", { actor: "developer" });

  const lines = readFileSync(join(root, "operations.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  // approve 之后多一笔 approve_commit:唯一的账后行,是"提交点已落定"
  // 的确认——孤儿 vN 回收(见故障用例)只认查无此笔的版本。
  assert.deepEqual(lines.map((line) => line.op),
    ["create", "save_draft", "submit", "approve", "approve_commit",
     "archive"]);
  assert.ok(lines.every((line) => line.asset_id === "wf-log"
    && typeof line.actor === "string" && line.actor
    && typeof line.ts === "string"));
  assert.equal(lines[3].version, 1, "发布留痕必须绑版本号");
});
