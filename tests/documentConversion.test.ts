import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { saveKnowledgeMaterial, readKnowledgeMaterialImage } from "../src/knowledgeMaterials.ts";
import { documentConversionFixtures } from "./documentConversionFixtures.ts";

test("真实 anymd 保留 DOCX/PPTX 文字与图片，PDF 页码及 XLSX 工作表和公式，ZIP 不漏文档", async () => {
  const root = mkdtempSync(join(tmpdir(), "document-conversion-"));
  try {
    const fixture = documentConversionFixtures(root);
    for (const name of ["rules.docx", "deck.pptx", "native.pdf", "book.xlsx", "mixed.zip"]) {
      const material = await saveKnowledgeMaterial(root, { name, content_base64: fixture(name).toString("base64") });
      assert.equal(material.state, "ready", material.error);
      assert.equal(material.documents?.length, name.endsWith("zip") ? 6 : 1);
      const text = material.sections.map(section => section.text).join("");
      assert.doesNotMatch(text, /parse-document-|\.cache\/anymd|file:\/\//);
      if (name.endsWith("docx")) { assert.match(text, /# 订单规则/); assert.match(text, /\|.*状态.*\|.*允许操作/); }
      if (name.endsWith("pptx")) assert.match(material.sections[0].location, /幻灯片 1/);
      if (name.endsWith("pdf")) assert.match(material.sections[0].location, /第 1 页/);
      if (name.endsWith("xlsx")) assert.match(text, /工作表：规则[\s\S]*A1: 3[\s\S]*公式：1\+2[\s\S]*工作表：例外/);
      if (/\.(docx|pptx|zip)$/.test(name)) assert.ok(material.images!.length > 0, `${name} 应实际导出图片`);
      for (const section of material.sections) {
        assert.ok(section.source_path);
        for (const match of section.text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
          const path = posix.normalize(posix.join(posix.dirname(section.source_path!), match[1]));
          assert.ok(material.images!.some(image => image.path === path), `图片链接有持久文件：${path}`);
        }
      }
      for (const image of material.images ?? []) {
        const result = readKnowledgeMaterialImage(root, material.id, image.path);
        assert.equal(createHash("sha256").update(result.content).digest("hex"), image.id);
      }
      assert.ok(!readdirSync(join(root, material.id)).some(entry => entry.startsWith("parse-")), "成功后清理临时转换缓存");
    }
    const broken = await saveKnowledgeMaterial(root, { name: "broken.zip", content_base64: fixture("broken.zip").toString("base64") });
    assert.equal(broken.state, "failed"); assert.match(broken.error!, /broken.docx/);
    assert.deepEqual(broken.sections, []); assert.deepEqual(broken.images, []);
    assert.equal(existsSync(join(root, broken.id, "images")), false);
    const scanned = await saveKnowledgeMaterial(root, { name: "scanned.pdf", content_base64: fixture("scanned.pdf").toString("base64") });
    assert.equal(scanned.state, "failed", "关闭 OCR 后，扫描页不能作为已经读到的文字");
    assert.match(scanned.error!, /OCR|未提取/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("分段保留空行、长行和跨片段图片语法，原文可以逐字重组", async () => {
  const root = mkdtempSync(join(tmpdir(), "document-sections-"));
  try {
    const text = "# 原文\r\n\r\n" + "\n".repeat(230) + "说明".repeat(8000) + "![图](images/figure.png)\n\n末尾\n";
    const material = await saveKnowledgeMaterial(root, { name: "原文.md", content_base64: Buffer.from(text).toString("base64") });
    assert.equal(material.state, "ready", material.error);
    assert.equal(material.sections.map(section => section.text).join(""), text);
    assert.equal(material.sections[0].continuation, false);
    assert.ok(material.sections.slice(1).every(section => section.continuation && section.source_path === "原文.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("取消运行中的转换同时停止原生子进程，清理转换缓存，并显式关闭 OCR", async () => {
  const root = mkdtempSync(join(tmpdir(), "document-cancel-")), oldBinary = process.env.ANYMD_BIN;
  let pid: number | undefined;
  try {
    const fixture = documentConversionFixtures(root), marker = join(root, "converter.json"), binary = join(root, "anymd-test.mjs");
    writeFileSync(binary, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\nsetTimeout(()=>{},10000);\n`, { mode: 0o755 });
    process.env.ANYMD_BIN = binary;
    const controller = new AbortController();
    const pending = saveKnowledgeMaterial(root, { name: "rules.docx", content_base64: fixture("rules.docx").toString("base64") }, controller.signal);
    for (let attempt = 0; !existsSync(marker) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(marker), "转换器应已实际启动");
    const running = JSON.parse(readFileSync(marker, "utf8")); pid = running.pid;
    assert.ok(running.args.includes("--no-ocr")); assert.ok(running.args.includes("refs"));
    controller.abort();
    const material = await pending;
    assert.equal(material.state, "failed"); assert.match(material.error!, /取消/);
    assert.ok(!readdirSync(join(root, material.id)).some(entry => entry.startsWith("parse-")));
    let alive = true;
    for (let attempt = 0; alive && attempt < 50; attempt++) {
      try { process.kill(pid!, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { alive = false; }
    }
    assert.equal(alive, false, "取消不能遗留原生转换进程");
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* 已被取消。 */ }
    if (oldBinary === undefined) delete process.env.ANYMD_BIN; else process.env.ANYMD_BIN = oldBinary;
    rmSync(root, { recursive: true, force: true });
  }
});

test("图片读取核验原始字节，资料取消不留下可读片段", async () => {
  const root = mkdtempSync(join(tmpdir(), "document-integrity-"));
  try {
    const fixture = documentConversionFixtures(root);
    const material = await saveKnowledgeMaterial(root, { name: "rules.docx", content_base64: fixture("rules.docx").toString("base64") });
    assert.equal(material.state, "ready", material.error);
    const image = material.images![0];
    writeFileSync(join(root, material.id, "images", image.id), Buffer.alloc(image.bytes));
    assert.throws(() => readKnowledgeMaterialImage(root, material.id, image.path), /不完整或已改变/);
    const controller = new AbortController(); controller.abort();
    const cancelled = await saveKnowledgeMaterial(root, { name: "rules.docx", content_base64: fixture("rules.docx").toString("base64") }, controller.signal);
    assert.equal(cancelled.state, "failed"); assert.match(cancelled.error!, /取消/); assert.deepEqual(cancelled.sections, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
