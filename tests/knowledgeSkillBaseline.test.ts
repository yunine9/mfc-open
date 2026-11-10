import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveSkillSubmission, listSkillOperations, listSkillSubmissions, listSkillVersions,
  offlineHostSkill, readHostSkillPackage, readSkillSubmissionPackage, submitHostSkill, uploadHostSkill,
} from "../src/hostSkillLibrary.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

const directory = "baseline-review";
const metadata = { nature: "engineering" as const, form: "skill" as const,
  business_module_ids: [], repositories: [], technologies: ["typescript"] };
const files = (label: string) => [
  { path: "SKILL.md", content_base64: Buffer.from(`---\nname: ${directory}\ndescription: Review async state updates.\n---\n# Review\n\n${label}\nRead references/checklist.md before reviewing.\n`).toString("base64") },
  { path: "references/checklist.md", content_base64: Buffer.from(`# Checklist\n\n${label}\nVerify cancellation before updating state.\n`).toString("base64") },
];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-baseline-"));
  seedTechnologyStacks(dir, ["typescript"]);
  return dir;
};

test("两份基于同一版本的待审 Skill 串行上架，后一个不能覆盖先发布的更新", async () => {
  const dir = fixture();
  try {
    const base = await uploadHostSkill(dir, directory, files("original"), "admin", metadata);
    const [first, second] = await Promise.all([
      submitHostSkill(dir, directory, files("first change"), "alice", metadata),
      submitHostSkill(dir, directory, files("second change"), "bob", metadata),
    ]);
    assert.equal(first.base_package_digest, base.package_digest);
    assert.equal(second.base_package_digest, base.package_digest);
    assert.equal(readSkillSubmissionPackage(dir, directory, second.id).record.base_package_digest, base.package_digest);
    const approved = await Promise.allSettled([
      approveSkillSubmission(dir, directory, first.id, "admin"),
      approveSkillSubmission(dir, directory, second.id, "admin"),
    ]);
    assert.equal(approved[0].status, "fulfilled");
    assert.equal(approved[1].status, "rejected");
    if (approved[1].status === "rejected") assert.match(approved[1].reason.message, /最新版本重新提交/);
    assert.equal(readHostSkillPackage(dir, directory).package_digest, first.package_digest);
    const pending = listSkillSubmissions(dir).find(r => r.id === second.id)!;
    assert.equal(pending.status, "pending"); assert.equal(pending.decided_at, undefined);
    assert.equal(listSkillVersions(dir, directory).length, 1);
    assert.equal(listSkillOperations(dir).filter(r => r.action === "approve").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("首次提交以 null 记录尚未上架，其他提交先上架后旧提交仍保持待审", async () => {
  const dir = fixture();
  try {
    const first = await submitHostSkill(dir, directory, files("first publication"), "alice", metadata);
    const second = await submitHostSkill(dir, directory, files("another first publication"), "bob", metadata);
    assert.equal(first.base_package_digest, null); assert.equal(second.base_package_digest, null);
    await approveSkillSubmission(dir, directory, second.id, "admin");
    await assert.rejects(approveSkillSubmission(dir, directory, first.id, "admin"), /最新版本重新提交/);
    assert.equal(readHostSkillPackage(dir, directory).package_digest, second.package_digest);
    assert.equal(listSkillSubmissions(dir).find(r => r.id === first.id)!.status, "pending");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("审核使用当前真实整包版本，外部附件修改即使未改 SKILL.md 也拒绝覆盖", async () => {
  const dir = fixture();
  try {
    await uploadHostSkill(dir, directory, files("original"), "admin", metadata);
    const pending = await submitHostSkill(dir, directory, files("proposed"), "alice", metadata);
    const before = readHostSkillPackage(dir, directory);
    writeFileSync(join(dir, "skills", directory, "references/checklist.md"), "# Expert revision\n\nPreserve this manual change.\n");
    const changed = readHostSkillPackage(dir, directory);
    assert.equal(changed.digest, before.digest); assert.notEqual(changed.package_digest, before.package_digest);
    const operations = listSkillOperations(dir).length;
    await assert.rejects(approveSkillSubmission(dir, directory, pending.id, "admin"), /最新版本重新提交/);
    assert.equal(readHostSkillPackage(dir, directory).package_digest, changed.package_digest);
    assert.equal(listSkillOperations(dir).length, operations);
    assert.equal(listSkillSubmissions(dir).find(r => r.id === pending.id)!.status, "pending");
    const replacement = await submitHostSkill(dir, directory, files("reviewed against expert revision"), "alice", metadata);
    assert.equal(replacement.base_package_digest, changed.package_digest);
    await approveSkillSubmission(dir, directory, replacement.id, "admin");
    assert.equal(readHostSkillPackage(dir, directory).package_digest, replacement.package_digest);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("审核等待期间直接发布新版或下线均使原提交失效，不恢复旧包", async () => {
  for (const offline of [false, true]) {
    const dir = fixture();
    try {
      await uploadHostSkill(dir, directory, files("original"), "admin", metadata);
      const pending = await submitHostSkill(dir, directory, files("old proposal"), "alice", metadata);
      if (offline) await offlineHostSkill(dir, directory, "admin");
      else await uploadHostSkill(dir, directory, files("new official package"), "admin", metadata);
      const current = offline ? null : readHostSkillPackage(dir, directory).package_digest;
      await assert.rejects(approveSkillSubmission(dir, directory, pending.id, "admin"), /最新版本重新提交/);
      assert.equal(listSkillSubmissions(dir).find(r => r.id === pending.id)!.status, "pending");
      if (offline) assert.throws(() => readHostSkillPackage(dir, directory), /没有这个生效中的/);
      else assert.equal(readHostSkillPackage(dir, directory).package_digest, current);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("#450：缺基线的旧 Skill 可读，但不能覆盖已更新的正式包，也不改写旧记录", async () => {
  const dir = fixture();
  try {
    await uploadHostSkill(dir, directory, files("old official"), "admin", metadata);
    const pending = await submitHostSkill(dir, directory, files("legacy proposal"), "alice", metadata);
    const path = join(dir, "skill-submissions", directory, pending.id, "submission.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")); delete legacy.base_package_digest; writeFileSync(path, JSON.stringify(legacy));
    await uploadHostSkill(dir, directory, files("later official"), "admin", metadata);
    const badBytes = readFileSync(path, "utf8"), live = readHostSkillPackage(dir, directory), operations = listSkillOperations(dir);
    await assert.rejects(approveSkillSubmission(dir, directory, pending.id, "admin"), /最新版本重新提交/);
    const warnings: string[] = [];
    assert.deepEqual(listSkillSubmissions(dir, warnings), [{ ...pending, base_package_digest: null }]);
    assert.deepEqual(warnings, []);
    assert.equal(readFileSync(path, "utf8"), badBytes);
    assert.deepEqual(readHostSkillPackage(dir, directory), live);
    assert.deepEqual(listSkillOperations(dir), operations);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#450：尚无正式包的旧 Skill 缺基线按 null 读取，人工审核后正常上架并保存当前格式", async () => {
  const dir = fixture();
  try {
    const pending = await submitHostSkill(dir, directory, files("legacy first publication"), "alice", metadata);
    const path = join(dir, "skill-submissions", directory, pending.id, "submission.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")); delete legacy.base_package_digest;
    writeFileSync(path, JSON.stringify(legacy));
    await approveSkillSubmission(dir, directory, pending.id, "admin");
    assert.equal(readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
    const approved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(approved.status, "approved"); assert.equal(approved.base_package_digest, null);
    delete approved.base_package_digest; writeFileSync(path, JSON.stringify(approved));
    const bytes = readFileSync(path, "utf8"), warnings: string[] = [];
    assert.equal(listSkillSubmissions(dir, warnings)[0].status, "approved", "已审核的旧提交保留原裁决");
    assert.deepEqual(warnings, []);
    await assert.rejects(approveSkillSubmission(dir, directory, pending.id, "admin"), /已经裁决/);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
