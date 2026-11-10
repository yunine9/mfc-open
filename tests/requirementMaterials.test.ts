import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildRequirementMaterials, loadRequirementSources, materializeRequirementSources,
  readRequirementSource, storeRequirementSources,
} from "../src/requirementMaterials.ts";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";

const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function fixture(root: string, input: { name?: string; state?: "ready" | "failed"; texts?: Array<{ path: string; chunks: string[] }>; warnings?: string[]; images?: Array<{ path: string; content?: Buffer }>; source?: Buffer }) {
  const id = `material-${randomUUID()}`, name = input.name ?? "设计.zip", content = input.source ?? Buffer.from(`original:${id}`);
  const directory = join(root, id); mkdirSync(directory);
  writeFileSync(join(directory, `source.${name.split(".").at(-1)}`), content);
  const images = (input.images ?? []).map(image => {
    const bytes = image.content ?? PNG, hash = digest(bytes);
    mkdirSync(join(directory, "images"), { recursive: true }); writeFileSync(join(directory, "images", hash), bytes);
    return { id: hash, path: image.path, mimeType: "image/png", bytes: bytes.length };
  });
  const record = { id, name, state: input.state ?? "ready", bytes: content.length, digest: digest(content), scope: "需求", version: "",
    warnings: input.warnings, images,
    sections: (input.texts ?? []).flatMap(document => document.chunks.map((text, index) => ({ source_path: document.path, location: `${document.path} · 行 ${index + 1}`, continuation: index > 0, text }))),
    ...(input.texts ? { documents: input.texts.map(document => ({ path: document.path })) } : {}) };
  writeFileSync(join(directory, "material.json"), JSON.stringify(record));
  return { ...record, content };
}

test("原件记录摘要不会误校验整个多文档需求，真实内核读取器可接受汇编", () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-source-marker-"));
  try {
    const body = "# 原始需求\n第一份完整约束。";
    const recorded = `<!-- MAE-FLOW-USERMSG-SHA256: ${digest(Buffer.from(body))} -->\n${body}\n`;
    const first = fixture(root, { name: "记录.md", source: Buffer.from(recorded), texts: [{ path: "记录.md", chunks: [recorded] }] });
    const second = fixture(root, { name: "验收.md", texts: [{ path: "验收.md", chunks: ["# 验收\n第二份约束。"] }] });
    const result = buildRequirementMaterials(root, [first.id, second.id]);
    assert.deepEqual(result.sources[0].content, Buffer.from(recorded));
    assert.match(result.requirement, /第一份完整约束[\s\S]*第二份约束/);
    assert.doesNotMatch(result.requirement, /MAE-FLOW-USERMSG-SHA256:/);
    const path = join(root, "combined.md"); writeFileSync(path, result.requirement);
    const validation = execFileSync(process.env.MAE_FLOW_PYTHON_BIN || "python3", ["-c",
      "import json,sys; from mae_flow_core.cli_commands.state_config import _validate_requirement_document; print(json.dumps(_validate_requirement_document(sys.argv[1])))", path],
    { encoding: "utf8", env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("../kernel/scripts", import.meta.url)) } });
    assert.equal(JSON.parse(validation)[0], true, validation);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("多资料保持上传顺序、每份文档全文和原件，图片/同名引用/脚注互不串文档", () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-materials-"));
  try {
    const first = fixture(root, { name: "一.zip", texts: [
      { path: "a/需求.md", chunks: ["# 第一篇\n![架构](../图/架", "构(1).png)\n引用[规则][same]和脚注[^n]。\n[same]: https://example.com/a\n[^n]: 第一条\n"] },
      { path: "b/约束.md", chunks: ["# 第二篇\n![示意][same]\n[same]: <../图/架构(1).png> \"示意图\"\n还有![same] 和![same][]，链接[same][]与[same]，脚注[^n]。\n[^n]: 第二条\n尾部约束"] },
    ], images: [{ path: "图/架构(1).png" }], warnings: ["表格格式需要核对"] });
    const second = fixture(root, { name: "二.docx", texts: [{ path: "二.docx", chunks: ["# 第三篇\n正文末尾验收项"] }] });
    const result = buildRequirementMaterials(root, [second.id, first.id], "全部材料都需要实现");
    assert.deepEqual(result.sources.map(source => source.name), ["二.docx", "一.zip"]);
    assert.equal(result.sources[1].document_count, 2); assert.deepEqual(result.sources[1].locations, ["a/需求.md", "b/约束.md"]);
    assert.ok(result.requirement.indexOf("正文末尾验收项") < result.requirement.indexOf("# 第一篇"));
    assert.match(result.requirement, /尾部约束/); assert.match(result.requirement, /全部材料都需要实现/);
    assert.doesNotMatch(result.requirement, /^\[same\]:/m);
    assert.match(result.requirement, /\[material-2-document-1-same\]: https:\/\/example.com\/a/);
    assert.match(result.requirement, /\[\^material-2-document-1-n\]: 第一条/);
    assert.match(result.requirement, /\[\^material-2-document-2-n\]: 第二条/);
    assert.match(result.requirement, /!\[same\]\[material-2-document-2-same\] 和/);
    assert.match(result.requirement, /链接\[same\]\[material-2-document-2-same\]与\[same\]\[material-2-document-2-same\]/);
    assert.equal(result.assets.length, 1); assert.deepEqual(result.assets[0].content, PNG);
    assert.match(result.requirement, /!\[架构\]\(\.mae-flow-work\/requirement-assets\/[a-f0-9]{24}\.png\)/);
    assert.deepEqual(result.warnings, ["一.zip：表格格式需要核对"]);
    assert.deepEqual(result.sources[1].content, first.content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("不同文档的同名图片解析到各自目录，不能拿第一张图片替代", () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-image-names-"));
  try {
    const secondImage = Buffer.concat([PNG, Buffer.from("second")]);
    const material = fixture(root, { texts: [
      { path: "甲/a.md", chunks: ["![甲](image.png)"] }, { path: "乙/b.md", chunks: ["![乙](image.png)"] },
    ], images: [{ path: "甲/image.png" }, { path: "乙/image.png", content: secondImage }] });
    const result = buildRequirementMaterials(root, [material.id]);
    assert.equal(result.assets.length, 2);
    assert.ok(result.requirement.includes(`![甲](.mae-flow-work/requirement-assets/${digest(PNG).slice(0, 24)}.png)`));
    assert.ok(result.requirement.includes(`![乙](.mae-flow-work/requirement-assets/${digest(secondImage).slice(0, 24)}.png)`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("连续解析切片重组跨片段图片，代码示例保持原样", () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-material-slices-"));
  try {
    const material = fixture(root, { texts: [{ path: "docs/a.md", chunks: [
      "![图](../images/", "a.png)\n最后一行", "\n下一百行\n`![示例](missing.png)`\n\n```md\n![代码示例](none.png)\n```",
    ] }], images: [{ path: "images/a.png" }] });
    const result = buildRequirementMaterials(root, [material.id]);
    assert.match(result.requirement, /最后一行\n下一百行/);
    assert.match(result.requirement, /`!\[示例\]\(missing.png\)`/); assert.match(result.requirement, /!\[代码示例\]\(none.png\)/);
    assert.equal(result.assets.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("原件随任务保存和重建，下载按登记路径取回完整字节并拒绝损坏/越界", () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-source-store-"));
  try {
    const material = fixture(root, { name: "需求.pdf", texts: [{ path: "需求.pdf", chunks: ["完整解析结果"] }] });
    const result = buildRequirementMaterials(root, [material.id]);
    const task = join(root, "task"), runtime = join(root, "runtime"); mkdirSync(task); mkdirSync(runtime);
    const meta = { sources: result.sources.map(({ content: _, ...source }) => source) };
    storeRequirementSources(task, result.sources);
    assert.deepEqual(loadRequirementSources(task, meta)[0].content, material.content);
    materializeRequirementSources(task, runtime, meta);
    assert.deepEqual(readFileSync(join(runtime, meta.sources[0].path)), material.content);
    assert.deepEqual(readRequirementSource(task, meta, meta.sources[0].path)?.content, material.content);
    assert.equal(readRequirementSource(task, meta, "../../outside"), undefined);
    writeFileSync(join(task, meta.sources[0].path), "tampered");
    assert.throws(() => loadRequirementSources(task, meta), /损坏/);
    const malicious = join(root, "malicious"); mkdirSync(malicious); symlinkSync(runtime, join(malicious, ".mae-flow-work"));
    assert.throws(() => storeRequirementSources(malicious, result.sources), /安全的普通目录/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("失败/空白/重复/缺图和超量资料整体报错，8 MiB 正文不静默截断", () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-material-invalid-"));
  try {
    const valid = fixture(root, { texts: [{ path: "a.md", chunks: ["正文"] }] });
    const failed = fixture(root, { state: "failed" });
    const empty = fixture(root, { texts: [{ path: "empty.md", chunks: ["  "] }] });
    const missing = fixture(root, { texts: [{ path: "a.md", chunks: ["![图](missing.png)"] }] });
    const large = fixture(root, { texts: [{ path: "a.md", chunks: ["x".repeat(8 * 1024 * 1024) + "不可丢的末尾"] }] });
    assert.throws(() => buildRequirementMaterials(root, [valid.id, failed.id]), /解析失败/);
    assert.throws(() => buildRequirementMaterials(root, [empty.id]), /没有可读正文/);
    assert.throws(() => buildRequirementMaterials(root, [valid.id, valid.id]), /重复/);
    assert.throws(() => buildRequirementMaterials(root, Array(31).fill(valid.id)), /30/);
    assert.throws(() => buildRequirementMaterials(root, [missing.id]), /图片不存在/);
    assert.throws(() => buildRequirementMaterials(root, [large.id]), /8 MiB.*未被截断/);
    writeFileSync(join(root, valid.id, "source.zip"), "tampered");
    assert.throws(() => buildRequirementMaterials(root, [valid.id]), /原件校验失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("真实上传的两个 Markdown 文件可完整汇编，超过 100 行的末尾仍可读", async () => {
  const root = mkdtempSync(join(tmpdir(), "requirement-real-materials-"));
  try {
    const content = Array.from({ length: 220 }, (_, index) => `第 ${index + 1} 条验收要求`).join("\n");
    const first = await saveKnowledgeMaterial(root, { name: "主业务.md", content_base64: Buffer.from(content).toString("base64") });
    const second = await saveKnowledgeMaterial(root, { name: "补充.md", content_base64: Buffer.from("# 另一个文档\n尾部约束").toString("base64") });
    assert.equal(first.state, "ready", first.error); assert.equal(second.state, "ready", second.error);
    const result = buildRequirementMaterials(root, [first.id, second.id]);
    assert.ok(result.requirement.includes(content)); assert.match(result.requirement, /尾部约束/);
    assert.equal(result.sources.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
