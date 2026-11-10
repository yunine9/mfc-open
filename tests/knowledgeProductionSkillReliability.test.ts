import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as library from "../src/hostSkillLibrary.ts";
import type { SkillSubmissionRecord, SkillUploadFile } from "../src/hostSkillLibrary.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

const directory = "reliable-review";
const metadata = { nature: "engineering" as const, business_module_ids: [], repositories: [], technologies: ["typescript"] };
const files = (label = "原始草稿", attachment = "核对版本与取消操作。", name = directory): SkillUploadFile[] => [
  { path: "SKILL.md", content_base64: Buffer.from(`---\nname: ${name}\ndescription: Review reliable knowledge publication.\n---\n# 审查指南\n\n${label}\n先读 references/checklist.md。\n`).toString("base64") },
  { path: "references/checklist.md", content_base64: Buffer.from(`# 审查清单\n\n${attachment}\n`).toString("base64") },
];
const temporary = () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-skill-reliability-"));
  seedTechnologyStacks(dir, ["typescript"]);
  return dir;
};

test("#450：旧 Skill 缺基线仍可读，非法基线和 JSON 损坏分别说明且不泄漏正文", async () => {
  const dir = temporary();
  try {
    const good = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    const path = join(dir, "skill-submissions", directory, good.id, "submission.json");
    const missing = { ...good } as Partial<SkillSubmissionRecord>; delete missing.base_package_digest;
    fs.writeFileSync(path, JSON.stringify(missing));
    const bytes = fs.readFileSync(path, "utf8");
    const warnings: string[] = [];
    assert.deepEqual(library.listSkillSubmissions(dir, warnings), [{ ...good, base_package_digest: null }]);
    assert.deepEqual(warnings, []);
    assert.equal(library.readSkillSubmissionPackage(dir, directory, good.id).record.base_package_digest, null);
    assert.equal(fs.readFileSync(path, "utf8"), bytes, "列表和预览不能自动改写旧记录");
    fs.writeFileSync(path, JSON.stringify({ ...good, base_package_digest: "invalid" }));
    assert.deepEqual(library.listSkillSubmissions(dir, warnings), []);
    assert.match(warnings[0], /base_package_digest/);
    fs.writeFileSync(path, '{"private_note":"DO_NOT_EXPOSE_450",');
    warnings.length = 0; library.listSkillSubmissions(dir, warnings);
    assert.match(warnings[0], /JSON/);
    assert.doesNotMatch(warnings[0], /DO_NOT_EXPOSE_450/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const recordPath = (dir: string, record: Pick<SkillSubmissionRecord, "directory" | "id">) => join(dir, "skill-submissions", record.directory, record.id, "submission.json");
const diskRecord = (dir: string, record: SkillSubmissionRecord) => JSON.parse(fs.readFileSync(recordPath(dir, record), "utf8"));
const listWithWarnings = library.listSkillSubmissions as (dir: string, warnings?: string[]) => SkillSubmissionRecord[];

async function within<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5_000); })]);
  } finally { clearTimeout(timer); }
}

async function recover(dir: string, warnings: string[] = []) {
  const recoverSkillSubmissions = (library as unknown as {
    recoverSkillSubmissions?: (dir: string, warnings?: string[]) => Promise<void>;
  }).recoverSkillSubmissions;
  assert.equal(typeof recoverSkillSubmissions, "function", "服务启动必须有补完已持久审批意图的公开入口");
  await within(recoverSkillSubmissions!(dir, warnings), "Skill 审批恢复超过5秒测试预算");
}

async function publishBase(dir: string) {
  const record = await library.submitHostSkill(dir, directory, files("已发布基线"), "base-author", metadata);
  await library.approveSkillSubmission(dir, directory, record.id, "base-admin");
  return record;
}

function eio() { return Object.assign(new Error("测试磁盘 EIO"), { code: "EIO" }); }

test("生产线验收13（F20）：同一基线的同包并发及重复提交返回原实体，文件顺序不影响内容哈希", { timeout: 10_000 }, async () => {
  const dir = temporary();
  try {
    const [first, duplicate] = await within(Promise.all([
      library.submitHostSkill(dir, directory, files(), "alice", metadata),
      library.submitHostSkill(dir, directory, files().reverse(), "bob", metadata),
    ]), "同包并发提交超过5秒测试预算");
    assert.equal(duplicate.id, first.id);
    assert.deepEqual(duplicate, first, "重复请求不能覆盖原提交人与待审包身份");
    const again = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    assert.deepEqual(again, first);
    assert.equal(library.listSkillSubmissions(dir).length, 1);
    assert.equal(library.listSkillOperations(dir).filter(operation => operation.action === "submit").length, 1);
    assert.equal(fs.readdirSync(join(dir, "skill-submissions", directory)).length, 1);
    assert.equal(library.readSkillSubmissionPackage(dir, directory, first.id).record.package_digest, first.package_digest);
    assert.throws(() => library.readHostSkillPackage(dir, directory), /没有这个生效中的/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收13/14（F20）：整包附件变化产生新提交，退回后重提及当前基线变化不被旧去重结果挡住", { timeout: 10_000 }, async () => {
  const dir = temporary();
  try {
    const first = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    const changed = await library.submitHostSkill(dir, directory, files("原始草稿", "新增附件核对事项。"), "bob", metadata);
    assert.equal(first.skill_digest, changed.skill_digest);
    assert.notEqual(first.package_digest, changed.package_digest);
    assert.notEqual(first.id, changed.id);
    await library.rejectSkillSubmission(dir, directory, first.id, "admin", "补充后重新审查");
    const resubmitted = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    assert.notEqual(resubmitted.id, first.id);
    assert.equal(resubmitted.status, "pending");
    await library.approveSkillSubmission(dir, directory, changed.id, "admin");
    const rebased = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    assert.notEqual(rebased.id, resubmitted.id, "最新正式包已变，重新提交必须保存当前基线");
    assert.equal(rebased.base_package_digest, changed.package_digest);
    assert.equal(resubmitted.base_package_digest, null);
    await assert.rejects(library.approveSkillSubmission(dir, directory, resubmitted.id, "admin"), /最新版本重新提交/);
    await library.approveSkillSubmission(dir, directory, rebased.id, "admin");
    assert.equal(library.readHostSkillPackage(dir, directory).package_digest, rebased.package_digest);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3（F20）：submission 坏 JSON 和坏形状逐条隔离，告警点名路径，坏字节不改且正常待审包可读取裁决", { timeout: 10_000 }, async () => {
  const dir = temporary();
  try {
    const good = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    const bad = [
      { id: "broken-json", content: "{" },
      { id: "broken-id", content: JSON.stringify({ ...good, id: null }) },
      { id: "broken-scope", content: JSON.stringify({ ...good, id: "broken-scope", technologies: [null] }) },
      { id: "broken-status", content: JSON.stringify({ ...good, id: "broken-status", status: "unknown" }) },
      { id: "broken-intent", content: JSON.stringify({ ...good, id: "broken-intent", status: "approving" }) },
    ].map(item => ({ ...item, relative: `skill-submissions/${directory}/${item.id}/submission.json` }));
    for (const item of bad) {
      const path = join(dir, item.relative);
      fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, item.content);
    }
    const warnings: string[] = [];
    assert.deepEqual(listWithWarnings(dir, warnings).map(record => record.id), [good.id]);
    assert.equal(warnings.length, bad.length);
    for (const item of bad) {
      assert.ok(warnings.some(warning => warning.includes(item.relative) && warning.includes("记录损坏")), item.relative);
      assert.equal(fs.readFileSync(join(dir, item.relative), "utf8"), item.content);
      assert.throws(() => library.readSkillSubmissionPackage(dir, directory, item.id), error => error instanceof Error && error.message.includes(item.relative));
    }
    assert.equal(library.readSkillSubmissionPackage(dir, directory, good.id).record.status, "pending");
    await library.rejectSkillSubmission(dir, directory, good.id, "admin", "补使用例");
    assert.equal(library.readSkillSubmissionPackage(dir, directory, good.id).record.reject_reason, "补使用例");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3/14（F20）：审核记录原子替换发生 EIO 时原待审字节完整，重试裁决可成功", { timeout: 10_000 }, async t => {
  const dir = temporary();
  let renameMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const pending = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
    const path = recordPath(dir, pending), before = fs.readFileSync(path, "utf8"), rename = fs.renameSync;
    let injected = 0;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === path && injected++ === 0) throw eio();
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(library.rejectSkillSubmission(dir, directory, pending.id, "admin", "补使用例"), (error: any) => error?.code === "EIO");
    assert.equal(fs.readFileSync(path, "utf8"), before);
    assert.equal(library.readSkillSubmissionPackage(dir, directory, pending.id).record.status, "pending");
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    const rejected = await library.rejectSkillSubmission(dir, directory, pending.id, "admin", "补使用例");
    assert.equal(rejected.status, "rejected");
    assert.equal(diskRecord(dir, pending).status, "rejected");
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14（F19）：审核意图耐久写失败时不安装包，原待审记录和正式包完整", { timeout: 10_000 }, async t => {
  const dir = temporary();
  let writeMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const base = await publishBase(dir);
    const pending = await library.submitHostSkill(dir, directory, files("待发布的新草稿"), "alice", metadata);
    const path = recordPath(dir, pending), before = fs.readFileSync(path, "utf8"), write = fs.writeFileSync;
    writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if ([path, `${path}.tmp`].includes(String(args[0])) && JSON.parse(String(args[1])).status === "approving") throw eio();
      return write(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "admin"), (error: any) => error?.code === "EIO");
    assert.equal(fs.readFileSync(path, "utf8"), before);
    assert.equal(library.readHostSkillPackage(dir, directory).package_digest, base.package_digest);
    assert.equal(library.listSkillVersions(dir, directory).length, 0);
    assert.equal(library.listSkillOperations(dir).filter(operation => operation.action === "approve").length, 1);
  } finally { writeMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const hadBase of [false, true]) {
  test(`生产线验收14（F19）：${hadBase ? "旧正式包已归档" : "首次上架"}后安装被中断，重启按耐久审批意图补完原提交`, { timeout: 10_000 }, async t => {
    const dir = temporary();
    let renameMock: ReturnType<typeof t.mock.method> | undefined;
    try {
      if (hadBase) await publishBase(dir);
      const pending = await library.submitHostSkill(dir, directory, files("待发布的新草稿"), "alice", metadata);
      const live = join(dir, "skills", directory), rename = fs.renameSync;
      renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === live) throw eio();
        return rename(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "review-admin"), (error: any) => error?.code === "EIO");
      const intent = diskRecord(dir, pending);
      assert.equal(intent.status, "approving", "任何包安装前都必须已有审批意图");
      assert.equal(intent.decided_by, "review-admin"); assert.ok(intent.decided_at);
      assert.equal(fs.existsSync(live), false);
      if (hadBase) assert.equal(library.listSkillVersions(dir, directory).length, 1);
      renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
      const warnings: string[] = [];
      await recover(dir, warnings);
      assert.deepEqual(warnings, []);
      assert.equal(library.readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
      const approved = library.readSkillSubmissionPackage(dir, directory, pending.id).record;
      assert.equal(approved.status, "approved"); assert.equal(approved.decided_by, "review-admin");
      assert.equal(approved.decided_at, intent.decided_at);
      const operations = library.listSkillOperations(dir).filter(operation => operation.action === "approve");
      assert.equal(operations.length, hadBase ? 2 : 1);
      await recover(dir, warnings);
      assert.equal(library.listSkillOperations(dir).filter(operation => operation.action === "approve").length, operations.length);
      assert.equal(library.listSkillVersions(dir, directory).length, hadBase ? 1 : 0);
    } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("生产线验收14（F19）：包已生效而审核终态写入失败，重启只补终态，不二次安装或新增版本", { timeout: 10_000 }, async t => {
  const dir = temporary();
  let writeMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    await publishBase(dir);
    const pending = await library.submitHostSkill(dir, directory, files("待发布的新草稿"), "alice", metadata);
    const path = recordPath(dir, pending), write = fs.writeFileSync;
    writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if ([path, `${path}.tmp`].includes(String(args[0])) && JSON.parse(String(args[1])).status === "approved") throw eio();
      return write(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "review-admin"), (error: any) => error?.code === "EIO");
    assert.equal(library.readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
    const intent = diskRecord(dir, pending);
    assert.equal(intent.status, "approving"); assert.equal(intent.decided_by, "review-admin");
    const versions = library.listSkillVersions(dir, directory).map(version => version.version_id);
    const installedCount = library.listSkillOperations(dir).filter(operation => ["upload", "update"].includes(operation.action)).length;
    writeMock.mock.restore(); writeMock = undefined; syncBuiltinESMExports();
    const warnings: string[] = [];
    await recover(dir, warnings);
    assert.deepEqual(warnings, []);
    const decided = library.readSkillSubmissionPackage(dir, directory, pending.id).record;
    assert.equal(decided.status, "approved"); assert.equal(decided.decided_by, "review-admin");
    assert.equal(decided.decided_at, intent.decided_at);
    assert.deepEqual(library.listSkillVersions(dir, directory).map(version => version.version_id), versions);
    assert.equal(library.listSkillOperations(dir).filter(operation => ["upload", "update"].includes(operation.action)).length, installedCount);
    await recover(dir, warnings);
    assert.equal(library.listSkillOperations(dir).filter(operation => operation.action === "approve" && operation.detail?.includes(pending.id)).length, 1);
    await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "another-admin"), /已经裁决过/);
  } finally { writeMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14（F19）：历史操作台账的合法JSON空行值不阻挡审批或已安装意图恢复，不改原台账行", { timeout: 15_000 }, async t => {
  for (const recovering of [false, true]) {
    const dir = temporary();
    let writeMock: ReturnType<typeof t.mock.method> | undefined;
    try {
      const pending = await library.submitHostSkill(dir, directory, files(), "alice", metadata);
      if (recovering) {
        const path = recordPath(dir, pending), write = fs.writeFileSync;
        writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
          if ([path, `${path}.tmp`].includes(String(args[0])) && JSON.parse(String(args[1])).status === "approved") throw eio();
          return write(...args);
        });
        syncBuiltinESMExports();
        await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "review-admin"), (error: any) => error?.code === "EIO");
        assert.equal(diskRecord(dir, pending).status, "approving");
        writeMock.mock.restore(); writeMock = undefined; syncBuiltinESMExports();
      }
      const log = join(dir, "skill-operations.jsonl");
      fs.appendFileSync(log, "null\n");
      const before = fs.readFileSync(log, "utf8");
      if (recovering) {
        const warnings: string[] = [];
        await recover(dir, warnings);
        assert.deepEqual(warnings, [], "合法审批意图不能因无关历史台账行卡住");
      } else await library.approveSkillSubmission(dir, directory, pending.id, "review-admin");
      assert.equal(library.readSkillSubmissionPackage(dir, directory, pending.id).record.status, "approved");
      assert.equal(library.readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
      assert.ok(fs.readFileSync(log, "utf8").startsWith(before), "只能补自己的审批操作，不能删除或重写历史坏行");
      assert.equal(library.listSkillOperations(dir).filter(operation => operation?.action === "approve" && operation.detail?.includes(pending.id)).length, 1);
      assert.equal(library.listSkillVersions(dir, directory).length, 0);
    } finally { writeMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("生产线验收14（F19）：包已安装而终态 EIO 后合法下线，启动恢复只补审核终态，保留人操作且不复活包", { timeout: 10_000 }, async t => {
  const dir = temporary();
  let writeMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const pending = await library.submitHostSkill(dir, directory, files("首次发布的草稿"), "alice", metadata);
    const path = recordPath(dir, pending), write = fs.writeFileSync;
    writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if ([path, `${path}.tmp`].includes(String(args[0])) && JSON.parse(String(args[1])).status === "approved") throw eio();
      return write(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "review-admin"), (error: any) => error?.code === "EIO");
    assert.equal(library.readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
    assert.equal(diskRecord(dir, pending).status, "approving");
    assert.ok(library.listSkillOperations(dir).some(operation => operation.action === "upload" && operation.package_digest === pending.package_digest
      && operation.detail === `审核通过 alice 的提交 ${pending.id}`), "真实操作台账已经确认这个精确意图安装成功");
    writeMock.mock.restore(); writeMock = undefined; syncBuiltinESMExports();

    const offlined = await library.offlineHostSkill(dir, directory, "human-admin");
    assert.equal(offlined.action, "offline"); assert.equal(offlined.package_digest, pending.package_digest);
    const before = fs.readFileSync(path, "utf8"), logPath = join(dir, "skill-operations.jsonl"), log = fs.readFileSync(logPath, "utf8");
    const versions = library.listSkillVersions(dir, directory);
    assert.equal(versions.length, 1);
    assert.throws(() => library.readHostSkillPackage(dir, directory), /没有这个生效中的/);

    const warnings: string[] = [];
    await recover(dir, warnings);
    assert.throws(() => library.readHostSkillPackage(dir, directory), /没有这个生效中的/, "恢复不能撤销管理员下线而把原包复活");
    assert.equal(diskRecord(dir, pending).status, "approved", "精确安装台账已证明原审批完成，补终态不能再安装");
    assert.equal(diskRecord(dir, pending).decided_by, "review-admin");
    assert.equal(diskRecord(dir, pending).decided_at, JSON.parse(before).decided_at);
    assert.deepEqual(warnings, [], "审批已完成且后来人操作合法，不应错误记为审批受阻");
    assert.deepEqual(library.listSkillVersions(dir, directory), versions, "不能额外安装或新增版本");
    assert.equal(fs.readFileSync(logPath, "utf8"), log, "原安装、审批、下线记录原样保留，不新增恢复安装记录");
    await recover(dir, warnings);
    assert.throws(() => library.readHostSkillPackage(dir, directory), /没有这个生效中的/);
    assert.equal(diskRecord(dir, pending).status, "approved"); assert.equal(fs.readFileSync(logPath, "utf8"), log);
    assert.deepEqual(library.listSkillVersions(dir, directory), versions);
  } finally { writeMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14（F19）：包已安装而终态 EIO 后合法回退，启动恢复只补审核终态，保留回退基线且不重复归档", { timeout: 10_000 }, async t => {
  const dir = temporary();
  let writeMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const base = await publishBase(dir);
    const pending = await library.submitHostSkill(dir, directory, files("待发布的新草稿"), "alice", metadata);
    const path = recordPath(dir, pending), write = fs.writeFileSync;
    writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if ([path, `${path}.tmp`].includes(String(args[0])) && JSON.parse(String(args[1])).status === "approved") throw eio();
      return write(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(library.approveSkillSubmission(dir, directory, pending.id, "review-admin"), (error: any) => error?.code === "EIO");
    assert.equal(library.readHostSkillPackage(dir, directory).package_digest, pending.package_digest);
    assert.equal(diskRecord(dir, pending).status, "approving");
    const baseVersion = library.listSkillVersions(dir, directory).find(version => version.package_digest === base.package_digest)!;
    assert.ok(baseVersion, "旧基线经过真实审批安装被归档，回退使用公开版本入口");
    assert.ok(library.listSkillOperations(dir).some(operation => operation.action === "update" && operation.package_digest === pending.package_digest
      && operation.detail === `审核通过 alice 的提交 ${pending.id}`), "真实安装台账绑定精确审批意图");
    writeMock.mock.restore(); writeMock = undefined; syncBuiltinESMExports();

    const rolledBack = await library.rollbackHostSkill(dir, directory, baseVersion.version_id, "human-admin");
    assert.equal(rolledBack.action, "rollback"); assert.equal(rolledBack.package_digest, base.package_digest);
    const live = library.readHostSkillPackage(dir, directory);
    assert.equal(live.package_digest, base.package_digest);
    const before = fs.readFileSync(path, "utf8"), logPath = join(dir, "skill-operations.jsonl"), log = fs.readFileSync(logPath, "utf8");
    const versions = library.listSkillVersions(dir, directory);

    const warnings: string[] = [];
    await recover(dir, warnings);
    assert.deepEqual(library.readHostSkillPackage(dir, directory), live, "当前包恰好等于原提交基线也不能撤销后来的人回退");
    assert.equal(diskRecord(dir, pending).status, "approved", "精确安装台账已证明原审批完成，补终态不能再安装");
    assert.equal(diskRecord(dir, pending).decided_by, "review-admin");
    assert.equal(diskRecord(dir, pending).decided_at, JSON.parse(before).decided_at);
    assert.deepEqual(warnings, [], "审批已完成且后来人操作合法，不应错误记为审批受阻");
    assert.deepEqual(library.listSkillVersions(dir, directory), versions, "不能重复归档旧基线或安装新版本");
    assert.equal(fs.readFileSync(logPath, "utf8"), log, "原安装、审批、回退记录原样保留");
    await recover(dir, warnings);
    assert.deepEqual(library.readHostSkillPackage(dir, directory), live);
    assert.equal(diskRecord(dir, pending).status, "approved"); assert.equal(fs.readFileSync(logPath, "utf8"), log);
    assert.deepEqual(library.listSkillVersions(dir, directory), versions);
  } finally { writeMock?.mock.restore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});
