import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { KnowledgeExtractionSkills, bundledDomainRevisionSkill, extractionSkillTool, extractionSkillMission } from "../src/knowledgeExtractionSkills.ts";
import { domainSkillFixture } from "./helpers/extractionSkillFixture.ts";
import { domainExecutionContract } from "../src/domainKnowledgeExecution.ts";

test("组件两套方法仅随仓库发布，忽略旧上传且研究固定版本不受新发布影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "component-method-pair-"));
  try {
    const store = new KnowledgeExtractionSkills(root), original = store.current("component-analysis");
    const extraction = store.current("component"), path = join(root, "task", "analysis.json");
    assert.equal(original.name, "component-module-analysis");
    const pinned = store.pin("component-analysis", path);
    for (const kind of ["component", "component-analysis"] as const) {
      const method = store.current(kind), directory = join(store.root, method.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "current.json"), "旧上传的无效包");
      assert.equal(store.current(kind).digest, method.digest);
      await assert.rejects(store.save(kind, method.files, method.digest, "expert"), /平台版本维护.*查看/);
      await assert.rejects(store.rollback(kind, "invalid", method.digest, "expert"), /平台版本维护.*查看/);
    }
    // 模拟仓库发布的新版本，而不是开放生产上传接口。
    const files = { ...original.files, "references/phase-plan.md": original.files["references/phase-plan.md"] + "\n核对场景对应的单元测试。\n" };
    const next = { ...original, files, digest: createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
    const current = store.current.bind(store);
    store.current = kind => kind === "component-analysis" ? next : current(kind);
    assert.notEqual(next.digest, original.digest);
    assert.equal(store.current("component").digest, extraction.digest);
    assert.deepEqual(store.pin("component-analysis", path), pinned);
    assert.equal(store.pin("component-analysis", join(root, "task", "new-analysis.json")).digest, next.digest);
    assert.throws(() => store.pin("component", path), /校验/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("领域方法随平台发布，旧上传与历史原样保留但不能覆盖内置方法", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-bundled-skill-"));
  try {
    const store = new KnowledgeExtractionSkills(root), initial = store.current("domain");
    assert.equal(initial.name, "business-docs-generator"); assert.equal(initial.kind, "domain");
    const directory = join(store.root, "domain-knowledge-extraction"), history = join(directory, "versions");
    mkdirSync(history, { recursive: true });
    const previous = JSON.stringify(domainSkillFixture({ "SKILL.md": "---\nname: old-upload\ndescription: 旧上传方法\n---\n保留原始内容。" }));
    const version = join(history, "00000000-0000-0000-0000-000000000001.json");
    writeFileSync(join(directory, "current.json"), previous); writeFileSync(version, previous);
    assert.equal(store.current("domain").digest, initial.digest);
    assert.deepEqual(store.current("domain").versions, []);
    await assert.rejects(store.save("domain", initial.files, initial.digest, "expert"), /平台版本维护.*查看/);
    await assert.rejects(store.rollback("domain", "00000000-0000-0000-0000-000000000001", initial.digest, "expert"), /平台版本维护.*查看/);
    assert.equal(readFileSync(join(directory, "current.json"), "utf8"), previous);
    assert.equal(readFileSync(version, "utf8"), previous);
    writeFileSync(join(directory, "current.json"), "旧文件损坏也不影响内置方法");
    assert.equal(new KnowledgeExtractionSkills(root).current("domain").digest, initial.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("旧默认和旧上传的固定包继续可读，新任务固定内置包，明确选择最新才更新旧任务", () => {
  const root = mkdtempSync(join(tmpdir(), "domain-pinned-skill-"));
  try {
    const store = new KnowledgeExtractionSkills(root), builtin = store.current("domain");
    const files = { "SKILL.md": "---\nname: business-research\ndescription: 旧业务方法\n---\n继续使用原方法。",
      "references/guide.md": "先核对业务规则。", "assets/example.json": '{"topic":"退款边界"}', "scripts/example.py": 'print("example")\n' };
    const uploaded = domainSkillFixture(files);
    const { kind: _, ...legacy } = { ...uploaded, name: "domain-knowledge-extraction" };
    for (const [name, pinned] of [["legacy", legacy], ["uploaded", uploaded]] as const) {
      const path = join(root, name, "skill.json"); mkdirSync(join(root, name)); writeFileSync(path, JSON.stringify(pinned));
      assert.deepEqual(store.pin("domain", path), pinned);
      assert.equal(JSON.parse(readFileSync(join(root, name, "skill-packages", `${pinned.digest}.json`), "utf8")).files["references/guide.md"], files["references/guide.md"]);
      assert.throws(() => store.pin("component", path), /校验失败/);
      assert.equal(store.pin("domain", path, true).digest, builtin.digest);
      assert.equal(store.pin("domain", path).name, "business-docs-generator");
    }
    const fresh = store.pin("domain", join(root, "fresh", "skill.json"));
    assert.equal(fresh.kind, "domain"); assert.equal(fresh.digest, builtin.digest);
    assert.deepEqual(store.pin("domain", join(root, "fresh", "skill.json")), fresh);
    assert.match(extractionSkillMission(uploaded, { mode: "revise" }), /"mode":"revise"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("固定旧包保留任意文本附件与完整引用，越界读取和损坏包仍被拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-pinned-content-"));
  try {
    const store = new KnowledgeExtractionSkills(root);
    const files = { "SKILL.md": "---\nname: custom-domain\ndescription: 自定义旧方法\n---\n读 [方法](references/guide.md)。",
      "references/guide.md": "完整研究方法", "assets/example.json": '{"topic":"退款"}' };
    const pinned = domainSkillFixture(files), path = join(root, "skill.json");
    writeFileSync(path, JSON.stringify(pinned));
    const tool: any = extractionSkillTool(store.pin("domain", path));
    for (const [name, content] of Object.entries(files)) assert.equal((await tool.execute("read", { path: name })).content[0].text, content);
    assert.equal((await tool.execute("read", { path: "../../outside" })).isError, true);
    writeFileSync(path, JSON.stringify({ ...pinned, files: { ...files, "references/guide.md": "正文已变，但指纹未更新" } }));
    assert.throws(() => store.pin("domain", path), /校验失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("文稿修订方法共享完整引用与模板，新修订固定独立版本且原萃取方法不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-revision-method-"));
  try {
    const store = new KnowledgeExtractionSkills(root), original = store.pin("domain", join(root, "skill.json"));
    const originalFile = readFileSync(join(root, "skill.json"), "utf8");
    const method = bundledDomainRevisionSkill(), shared = store.current("domain");
    assert.equal(method.name, "business-docs-reviser"); assert.equal(method.kind, "domain");
    assert.equal(domainExecutionContract(method.files), "reviewed-document-plan");
    assert.notEqual(method.files["SKILL.md"], shared.files["SKILL.md"]);
    for (const path of Object.keys(shared.files)) assert.equal(typeof method.files[path], "string", path);
    for (const [path, content] of Object.entries(method.files).filter(([path]) => !path.startsWith("templates/"))) {
      for (const [, target] of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^(?:[a-z]+:|#)/i.test(target)) continue;
        const reference = posix.normalize(posix.join(posix.dirname(path), target.split("#")[0]));
        assert.ok(method.files[reference], `${path} 引用缺失：${target}`);
      }
    }
    const turn = { id: "revision-1", mode: "revise" as const };
    const pinned = store.pinDomainTurn(root, turn);
    assert.equal(pinned.digest, method.digest);
    assert.ok(existsSync(join(root, "skill-runs", turn.id, "skill.json")));
    assert.equal(readFileSync(join(root, "skill.json"), "utf8"), originalFile);
    assert.equal(store.pinDomainTurn(root, { id: "old-extract", mode: "extract" }).digest, original.digest);
    const tool: any = extractionSkillTool(pinned);
    for (const path of ["SKILL.md", "references/platform-execution.md", "prompts/verify-doc.md"]) {
      const result = await tool.execute("read", { path });
      assert.equal(result.isError, undefined, path); assert.equal(result.content[0].text, pinned.files[path]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("旧在途修订保持原固定包，专用修订重启不换版，下一轮采用新部署版", () => {
  const root = mkdtempSync(join(tmpdir(), "domain-revision-recovery-"));
  try {
    const store = new KnowledgeExtractionSkills(root), path = join(root, "skill.json");
    const legacy = domainSkillFixture({ "SKILL.md": "---\nname: old-method\ndescription: 原萃取方法\n---\n原方法。" });
    writeFileSync(path, JSON.stringify(legacy));
    const oldTurn = { id: "existing-revision", mode: "revise" as const, skill: { name: legacy.name, digest: legacy.digest }, use_latest_skill: true };
    assert.deepEqual(store.pinDomainTurn(root, oldTurn), legacy);
    assert.equal(existsSync(join(root, "skill-runs", oldTurn.id, "skill.json")), false);
    const first = store.pinDomainTurn(root, { id: "first", mode: "revise" });
    const files = { ...first.files, "SKILL.md": first.files["SKILL.md"] + "\n下一部署版。" };
    const next = { ...first, files, digest: createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
    store.currentDomainRevision = () => next;
    assert.equal(store.pinDomainTurn(root, { id: "first", mode: "revise", use_latest_skill: true }).digest, first.digest,
      "恢复已固定的本轮方法，不因升级选项或进程重启改变");
    assert.equal(store.pinDomainTurn(root, { id: "second", mode: "revise" }).digest, next.digest);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).digest, legacy.digest);
    const pinnedPath = join(root, "skill-runs", "second", "skill.json");
    writeFileSync(pinnedPath, JSON.stringify({ ...next, name: "wrong-role" }));
    assert.throws(() => store.pinDomainTurn(root, { id: "second", mode: "revise" }), /校验失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
