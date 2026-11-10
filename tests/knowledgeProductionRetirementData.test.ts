import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireKnowledgeProductionData, retirementArguments } from "../scripts/knowledge-production-retirement.ts";

function fixture(run: (root: string, add: (path: string) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "mfc-knowledge-retirement-"));
  const add = (path: string) => { mkdirSync(join(root, path), { recursive: true }); writeFileSync(join(root, path, "keep.txt"), path); };
  try { run(root, add); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("B1验收1：退役数据清理默认只列清单，显式删除后记录每个目录", () => {
  fixture((root, add) => {
    const paths = ["knowledge-candidates", "skill-candidates", "knowledge-consolidation", "task-1/engineering-knowledge-snapshot", "task-1/repo/.mae-flow-work/team-engineering-knowledge"];
    paths.forEach(add);
    const preview = retireKnowledgeProductionData(root);
    assert.equal(preview.mode, "preview");
    assert.deepEqual(preview.targets, [...paths].sort());
    assert.deepEqual(preview.removed, []);
    paths.forEach(path => assert.ok(existsSync(join(root, path))));
    const applied = retireKnowledgeProductionData(root, true);
    assert.deepEqual(applied.removed, [...paths].sort());
    assert.deepEqual(applied.failed, []);
    paths.forEach(path => assert.equal(existsSync(join(root, path)), false));
    assert.deepEqual(retireKnowledgeProductionData(root, true).targets, []);
  });
});

test("B1验收3：只删除退役目录，保留消费、问题流及混有旧记录的共享研究目录", () => {
  fixture((root, add) => {
    add("knowledge-candidates");
    const preserved = ["component-research", "component-source-cache/knowledge-candidates", "component-governance", "component-card-indexes", "knowledge-documents", "knowledge-document-versions", "knowledge-materials", "knowledge-extract", "domain-extraction/dkx-normal", "corpus", "business-modules/module/assets", "issues/session/engineering-knowledge-snapshot", "issue-flow/.mae-flow-work/team-engineering-knowledge", "task-1/business-module-snapshot", "task-1/repo/.mae-flow-work/business-modules", "task-1/host-skill-snapshot"];
    preserved.forEach(add);
    const ordinaryFile = join(root, "domain-extraction/dkx-normal/job.json");
    const ordinary = JSON.stringify({ source_cleanup: { plans: [] }, documents: [{ knowledge_document_id: "kd-published" }] });
    writeFileSync(ordinaryFile, ordinary);
    const result = retireKnowledgeProductionData(root, true);
    assert.deepEqual(result.removed, ["knowledge-candidates"]);
    preserved.forEach(path => assert.ok(existsSync(join(root, path)), path));
    assert.equal(readFileSync(ordinaryFile, "utf8"), ordinary);
  });
});

test("B1验收1：清理只删除明确的临时验证和独立清理任务，损坏记录点名后保留", () => {
  fixture((root, add) => {
    for (const name of ["dkx-probe", "dkx-cleanup", "dkx-normal", "dkx-corrupt"]) add(`domain-extraction/${name}`);
    const record = (name: string, value: unknown) => writeFileSync(join(root, "domain-extraction", name, "job.json"), JSON.stringify(value));
    record("dkx-probe", { probe: { module: "验证模块" } });
    record("dkx-cleanup", { cleanup_only: true });
    record("dkx-normal", { source_cleanup: { plans: [] }, documents: [] });
    writeFileSync(join(root, "domain-extraction/dkx-corrupt/job.json"), "{损坏记录");
    const result = retireKnowledgeProductionData(root, true);
    assert.deepEqual(result.removed, ["domain-extraction/dkx-cleanup", "domain-extraction/dkx-probe"]);
    assert.deepEqual(result.skipped, ["domain-extraction/dkx-corrupt/job.json"]);
    assert.ok(existsSync(join(root, "domain-extraction/dkx-normal/job.json")));
    assert.ok(existsSync(join(root, "domain-extraction/dkx-corrupt/job.json")));
    assert.doesNotMatch(JSON.stringify(result), /损坏记录/);
  });
});

test("B1验收3：清理不跟随符号链接，不把凭据内容带进清单", () => {
  fixture((root, add) => {
    add("private");
    writeFileSync(join(root, "private/credentials.json"), "不应读取的凭据正文");
    symlinkSync(join(root, "private"), join(root, "skill-candidates"));
    add("task-1");
    symlinkSync(join(root, "private"), join(root, "task-1/repo"));
    const result = retireKnowledgeProductionData(root, true);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skipped, ["skill-candidates"]);
    assert.ok(existsSync(join(root, "private/credentials.json")));
    assert.doesNotMatch(JSON.stringify(result), /不应读取的凭据正文/);
  });
});

test("B1验收1：清理脚本必须显式传入 dataDir，只有 --apply 才删除", () => {
  assert.throws(() => retirementArguments([]), /显式指定/);
  assert.throws(() => retirementArguments(["--apply"]), /显式指定/);
  assert.throws(() => retirementArguments(["--data-dir", "--apply"]), /用法/);
  assert.throws(() => retirementArguments(["--data-dir", "data", "--unknown"]), /用法/);
  assert.deepEqual(retirementArguments(["--data-dir", "data"]), { dataDir: "data", apply: false });
  assert.deepEqual(retirementArguments(["--data-dir", "data", "--apply"]), { dataDir: "data", apply: true });
});
