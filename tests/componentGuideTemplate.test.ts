import assert from "node:assert/strict";
import { test } from "node:test";
import { editResearchDocument, researchDocumentMarkdown, sectionReady } from "../src/componentResearchDocument.ts";
import { exportComponentArtifacts, validateComponentParadigm } from "../src/componentParadigms.ts";
import { componentSection } from "./componentConsumptionFixture.ts";

const overview = "## 组件用途\n管理后台任务的提交与退出。\n\n## 接入配置\n使用 pool v2，并在停止前等待任务退出。";
const save = (section = componentSection()) => editResearchDocument({ overview, sections: [section] }, { action: "section", section }, ["base"]);

test("正式指南仅展示推荐用法，固定模板、去重配置和排序不受完成顺序影响", () => {
  const first = componentSection("cpp", "a"), second = componentSection("cpp", "b");
  first.title = "提交任务"; second.title = "等待结束";
  const research = componentSection("cpp", "contracts"); research.paradigm!.kind = "contracts"; research.content = "研究过程与契约备忘"; research.unit_tests = "";
  const uncertain = componentSection("cpp", "uncertain"); uncertain.paradigm!.status = "unverified"; uncertain.content = "待核实的替代场景";
  const excluded = componentSection("cpp", "excluded"); excluded.selected = false; excluded.title = "未选用法";
  const sections = [second, research, uncertain, first, excluded];
  const markdown = researchDocumentMarkdown("任务池", { overview, sections }, true, false);
  assert.equal(markdown, researchDocumentMarkdown("任务池", { overview, sections: [...sections].reverse() }, true, false));
  assert.deepEqual(markdown.match(/^## .+$/gm), ["## 组件用途", "## 接入配置", "## 用法导航", "## 提交任务", "## 等待结束"]);
  assert.deepEqual(markdown.match(/^### .+$/gm), Array(2).fill(["### 适用场景", "### 关键接口", "### 使用步骤", "### 完整示例", "### 单元测试示例", "### 使用约束"]).flat());
  assert.equal(markdown.split(first.integration).length - 1, 1);
  assert.match(markdown, /\[提交任务\]\(#component-a\)/);
  assert.doesNotMatch(markdown, /研究过程|待核实|未选用法|everycode-|component_paradigms|最佳示例|集成产物与依赖|常见误用/);
  const metadata = researchDocumentMarkdown("任务池", { overview, sections }, true);
  assert.doesNotMatch(metadata, /"id":"contracts"|"id":"uncertain"|"id":"excluded"/);
  const draft = researchDocumentMarkdown("任务池", { overview, sections });
  assert.match(draft, /"id":"contracts"/); assert.match(draft, /"id":"uncertain"/);
});

test("保存模板不齐时指出具体问题，不丢弃额外内容或补造单元测试", () => {
  const section = componentSection();
  for (const [patch, expected] of [
    [{ content: "旧的阶段拼接正文" }, /适用场景/],
    [{ content: section.content.replace("### 使用步骤", "### 研究过程") }, /研究过程/],
    [{ content: section.content + "\n\n### 常见误用\n" }, /常见误用.*不能为空/],
    [{ content: section.content + "\n\n### 来源\n隐藏研究来源" }, /来源/],
    [{ interfaces: "### 公共接口\nPool.submit" }, /关键接口.*标题/],
    [{ example: "未验证\n" + section.example }, /完整示例.*代码块/],
    [{ unit_tests: "用GoogleTest自行补充" }, /单元测试示例.*代码块/],
    [{ unit_tests: "```cpp\n\n```" }, /单元测试示例.*代码块/],
  ] as const) assert.throws(() => save({ ...section, ...patch }), expected);
  assert.throws(() => editResearchDocument({ overview, sections: [] }, { action: "overview", overview: "## 组件用途\n任务池" }, ["base"]), /接入配置/);
  assert.throws(() => researchDocumentMarkdown("任务池", { overview: "阶段总结", sections: [section] }, true), /组件用途/);
  assert.equal(sectionReady({ ...section, unit_tests: "" }), false);
  assert.equal(sectionReady(section), true);
});

test("推荐用法需要真实测试证据编号；研究章节可无UT，内部问题不会漏入正文", () => {
  const section = componentSection();
  assert.throws(() => validateComponentParadigm({ ...section.paradigm!, test_evidence: [] }, ["base"]), /测试证据/);
  assert.throws(() => validateComponentParadigm({ ...section.paradigm!, test_evidence: ["invented-test"] }, ["base"]), /证据编号/);
  section.paradigm!.open_questions = ["后续是否支持多进程仍需研究"];
  assert.doesNotThrow(() => save(section));
  assert.doesNotMatch(researchDocumentMarkdown("任务池", { overview, sections: [section] }, true, false), /多进程/);
  const research = { ...section, content: "已确认的契约内容", interfaces: "", integration: "", example: "", unit_tests: "", paradigm: { ...section.paradigm!, kind: "contracts" as const, test_evidence: [] } };
  assert.equal(sectionReady(research), true);
  const exported = exportComponentArtifacts([section, research]);
  assert.equal(exported.catalog.length, 1);
  assert.match(exported.files[exported.catalog[0].path], /### 单元测试示例/);
  assert.match(exported.files[exported.catalog[0].path], /EXPECT_EQ/);
  assert.deepEqual(exported.catalog[0].test_evidence, section.paradigm!.test_evidence);
});

test("代码中的标题保持原样，确证误用有内容才单列", () => {
  const section = componentSection();
  section.content += "\n\n### 常见误用\n在等待任务结束之前销毁任务引用会造成悬空引用。";
  section.unit_tests += "\n\n```python\n# 来源\nprint('### 任意标题')\n```";
  const markdown = researchDocumentMarkdown("任务池", { overview, sections: [section] }, true, false);
  assert.match(markdown, /### 常见误用\n\n在等待任务结束之前/);
  assert.match(markdown, /# 来源\nprint\('### 任意标题'\)/);
  assert.doesNotThrow(() => save(section));
});

test("未找到UT的用法可保存为内部研究，推荐项缺UT仍拒绝且研究项不导出", () => {
  const recommended = componentSection();
  for (const status of ["unverified", "legacy"] as const) {
    const research = { ...componentSection("cpp", `${status}-research`), title: `${status}内部研究`,
      content: "已确认提交接口存在；尚未找到对应单元测试，测试隔离与断言仍需核对。",
      interfaces: "", integration: "", example: "", unit_tests: "", paradigm: { ...recommended.paradigm!, status, usage_evidence: [], test_evidence: [], open_questions: ["缺少真实单元测试"] } };
    const saved = save(research).sections[0];
    assert.equal(saved.content, research.content);
    assert.equal(saved.unit_tests, "");
    assert.equal(sectionReady(saved), true);
    assert.throws(() => save({ ...research, paradigm: { ...research.paradigm, evidence: [] } }), /引用基础仓/);
    const document = { overview, sections: [recommended, saved] };
    assert.doesNotMatch(researchDocumentMarkdown("任务池", document, true), /内部研究|缺少真实单元测试|未找到对应单元测试/);
    assert.deepEqual(exportComponentArtifacts(document.sections).catalog.map(item => item.id), [recommended.id]);
    assert.throws(() => researchDocumentMarkdown("任务池", { overview, sections: [saved] }, true), /至少一个/);
  }
  assert.throws(() => save({ ...recommended, unit_tests: "" }), /单元测试示例/);
  assert.throws(() => save({ ...recommended, paradigm: { ...recommended.paradigm!, test_evidence: [] } }), /测试证据/);
});
