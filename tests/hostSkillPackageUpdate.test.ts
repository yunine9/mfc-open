import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { readSkillKnowledgeMetadata } from "../src/knowledgeAssetModel.ts";
import { SkillLibraryError, SkillVersionConflictError, approveSkillSubmission, listSkillOperations, listSkillVersions,
  readHostSkillPackage, rollbackHostSkill, submitHostSkill, updateHostSkillPackage, uploadHostSkill, type SkillPackageUpdate } from "../src/hostSkillLibrary.ts";

const metadata = { nature: "engineering" as const, form: "skill" as const, business_module_ids: [], repositories: ["https://example.test/app.git"], technologies: ["agnostic"] };
const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff, 0x80]);
const file = (path: string, content: string | Buffer) => ({ path, content_base64: Buffer.from(content).toString("base64") });
const markdown = "---\nname: review-helper\ndescription: Review project changes.\n---\n# Review\nRead references/check.md.\n";
const files = [file("SKILL.md", markdown), file("references/check.md", "Before\n"), file("bin/check", "#!/bin/sh\necho ready\n"), file("bin/native", binary)];
async function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "skill-package-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await uploadHostSkill(dir, "review-helper", files, "author", metadata);
  return dir;
}

test("在线编辑保留所有附件和可执行权限，旧版可恢复", async t => {
  const dir = await setup(t), before = readHostSkillPackage(dir, "review-helper");
  const result = await updateHostSkillPackage(dir, "review-helper", { mode: "edit", expected_package_digest: before.package_digest,
    files: [file("SKILL.md", markdown + "Check errors.\n"), file("references/check.md", "After\n")] }, "editor");
  const after = readHostSkillPackage(dir, "review-helper");
  assert.match(after.content, /Check errors/);
  assert.equal(after.files.find(f => f.path === "references/check.md")?.content, "After\n");
  assert.equal(after.files.length, 4);
  assert.deepEqual(readFileSync(join(dir, "skills/review-helper/bin/native")), binary);
  assert.equal(statSync(join(dir, "skills/review-helper/bin/check")).mode & 0o777, 0o755);
  assert.equal(statSync(join(dir, "skills/review-helper/bin/native")).mode & 0o777, 0o755);
  assert.deepEqual(readSkillKnowledgeMetadata(after.content), metadata);
  assert.equal(result.operator, "editor"); assert.equal(result.action, "update");
  const versions = listSkillVersions(dir, "review-helper");
  assert.equal(versions.length, 1); assert.equal(versions[0].package_digest, before.package_digest);
  await rollbackHostSkill(dir, "review-helper", versions[0].version_id, "editor");
  assert.equal(readHostSkillPackage(dir, "review-helper").package_digest, before.package_digest);
});

test("完整替换移除未包含的旧文件，保留业务或工程归属及二进制字节", async t => {
  const dir = await setup(t);
  for (const scope of [metadata, { ...metadata, nature: "business" as const, business_module_ids: ["orders"], technologies: [] }]) {
    await uploadHostSkill(dir, "review-helper", files, "author", scope);
    await updateHostSkillPackage(dir, "review-helper", { mode: "replace", expected_package_digest: readHostSkillPackage(dir, "review-helper").package_digest,
      files: [file("SKILL.md", markdown + "Replacement\n"), file("bin/replacement", binary)] }, "editor");
    const current = readHostSkillPackage(dir, "review-helper");
    assert.deepEqual(current.files.map(f => f.path), ["SKILL.md", "bin/replacement"]);
    assert.deepEqual(readSkillKnowledgeMetadata(current.content), scope);
    assert.deepEqual(readFileSync(join(dir, "skills/review-helper/bin/replacement")), binary);
  }
});

test("过期编辑和待审包不能覆盖平台上刚更新的 Skill", async t => {
  const dir = await setup(t), before = readHostSkillPackage(dir, "review-helper");
  const submission = await submitHostSkill(dir, "review-helper", [file("SKILL.md", markdown + "Pending\n")], "author", metadata);
  const update: SkillPackageUpdate = { mode: "edit", expected_package_digest: before.package_digest, files: [file("references/check.md", "Latest\n")] };
  await updateHostSkillPackage(dir, "review-helper", update, "first");
  await assert.rejects(updateHostSkillPackage(dir, "review-helper", { ...update, files: [file("SKILL.md", markdown + "Stale\n")] }, "second"), SkillVersionConflictError);
  await assert.rejects(approveSkillSubmission(dir, "review-helper", submission.id, "reviewer"), /已发生变化/);
  assert.equal(readHostSkillPackage(dir, "review-helper").files.find(f => f.path === "references/check.md")?.content, "Latest\n");
  assert.equal(listSkillVersions(dir, "review-helper").length, 1);
});

test("更新拒绝越界、密钥、改名、无效包和无版本请求，失败保留当前包", async t => {
  const dir = await setup(t), before = readHostSkillPackage(dir, "review-helper");
  const invalid = [
    { mode: "edit", files: [file("../escape", "bad")] },
    { mode: "edit", files: [file("references/check.md", 'password = "example-secret-value-123"')] },
    { mode: "replace", files: [file("SKILL.md", markdown.replace("review-helper", "different"))] },
    { mode: "replace", files: [file("references/check.md", "missing root")] },
    { mode: "edit", files: [null] },
    { mode: "edit", files: [] },
    { mode: "unknown", files },
    { mode: "edit", files, expected_package_digest: "" },
  ];
  for (const input of invalid) {
    await assert.rejects(updateHostSkillPackage(dir, "review-helper", { expected_package_digest: before.package_digest, ...input } as SkillPackageUpdate, "editor"), SkillLibraryError);
    assert.equal(readHostSkillPackage(dir, "review-helper").package_digest, before.package_digest);
    assert.equal(listSkillVersions(dir, "review-helper").length, 0);
  }
  await assert.rejects(updateHostSkillPackage(dir, "missing", { mode: "replace", expected_package_digest: before.package_digest, files }, "editor"), /没有这个生效中的/);
});

test("已登录成员可编辑和替换现有 Skill，匿名不能写，版本冲突返回 409", async t => {
  const dir = await setup(t), auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "test-admin-password"); auth.createUser("editor", "test-editor-password", "developer");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service, { auth });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const payload: SkillPackageUpdate = { mode: "edit", expected_package_digest: readHostSkillPackage(dir, "review-helper").package_digest, files: [file("references/check.md", "HTTP edit\n")] };
    const patch = (cookie: string, body = payload) => fetch(`${base}/skills/review-helper/package`, { method: "PATCH", headers: { cookie }, body: JSON.stringify(body) });
    assert.equal((await patch("")).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "editor", password: "test-editor-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const updated = await patch(cookie); assert.equal(updated.status, 200, await updated.text());
    assert.equal((await patch(cookie)).status, 409);
    const replaced = await patch(cookie, { mode: "replace", expected_package_digest: readHostSkillPackage(dir, "review-helper").package_digest, files: [file("SKILL.md", markdown + "HTTP replace\n")] });
    assert.equal(replaced.status, 200, await replaced.text());
    assert.equal(listSkillOperations(dir)[0].operator, "editor");
    const current = await fetch(`${base}/skills/review-helper/package`, { headers: { cookie } });
    const pack = await current.json() as { content: string; files: unknown[] };
    assert.match(pack.content, /HTTP replace/); assert.equal(pack.files.length, 1);
  } finally {
    await service.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
