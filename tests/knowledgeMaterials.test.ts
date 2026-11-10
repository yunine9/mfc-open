import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";

test("上传资料保留原文件、版本与定位，不能读的资料如实失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-materials-"));
  try {
    const markdown = Buffer.from("# 状态\n待支付 → 已支付\n");
    const material = await saveKnowledgeMaterial(root, { name: "业务.md", version: "v2", scope: "交易", content_base64: markdown.toString("base64") });
    assert.equal(material.state, "ready"); assert.equal(material.version, "v2"); assert.match(material.sections[0].location, /行 1/); assert.match(material.sections[0].text, /已支付/);
    assert.deepEqual(readFileSync(join(root, material.id, "source.md")), markdown);
    const failed = await saveKnowledgeMaterial(root, { name: "损坏.docx", content_base64: markdown.toString("base64") }); assert.equal(failed.state, "failed"); assert.ok(failed.error);
    await assert.rejects(saveKnowledgeMaterial(root, { name: "../secret.md", content_base64: markdown.toString("base64") }), /文件名/);
    // Real Office packages exercise the installed anymd binary.
    execFileSync("python3", ["-c", `import zipfile,sys
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'sample.docx','w') as z:z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>订单规则</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(p/'sample.pptx','w') as z:
 z.writestr('ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>')
 z.writestr('ppt/slides/slide1.xml','<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>演示业务</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')`, root]);
    for (const extension of ["docx", "pptx"]) {
      const parsed = await saveKnowledgeMaterial(root, { name: `sample.${extension}`, content_base64: readFileSync(join(root, `sample.${extension}`)).toString("base64") });
      assert.equal(parsed.state, "ready", parsed.error); assert.ok(parsed.sections[0].location);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DOCX 表格转为 Markdown，XLSX 缓存值保留行列定位", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-tables-"));
  try {
    execFileSync("python3", ["-c", `import zipfile,sys
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'table.docx','w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>订单</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>取消</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
with zipfile.ZipFile(p/'table.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="规则" r:id="r1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>订单金额</t></is></c><c r="B1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>')`, root]);
    const word = await saveKnowledgeMaterial(root, { name: "table.docx", content_base64: readFileSync(join(root, "table.docx")).toString("base64") });
    assert.equal(word.state, "ready", word.error); assert.match(word.sections[0].location, /table.docx · 转换文本 · 行 1/); assert.match(word.sections[0].text, /订单.*\|.*取消/);
    const excel = await saveKnowledgeMaterial(root, { name: "table.xlsx", content_base64: readFileSync(join(root, "table.xlsx")).toString("base64") });
    assert.equal(excel.state, "ready", excel.error); assert.match(excel.sections[0].location, /工作表 规则 · 行 1/); assert.match(excel.sections[0].text, /A1: 订单金额.*B1: 3.*文件缓存/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PDF 使用 anymd 解析真实文本及页码；空白 PDF 不冒充可读资料", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-pdf-"));
  const pdf = (text: string) => {
    const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let data = '%PDF-1.4\n'; const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(data); data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(data).toString("base64");
  };
  try {
    const material = await saveKnowledgeMaterial(root, { name: "rules.pdf", content_base64: pdf("Order cancellation rules") });
    assert.equal(material.state, "ready", material.error); assert.match(material.sections[0].location, /第 1 页/); assert.match(material.sections[0].text, /Order cancellation/);
    const empty = await saveKnowledgeMaterial(root, { name: "blank.pdf", content_base64: pdf("") }); assert.equal(empty.state, "failed"); assert.match(empty.error!, /未提取/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ZIP 文档及图片保留包内定位，工具按任务范围返回图片，未知附件明确提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-zip-"));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1kAAAAASUVORK5CYII=";
  try {
    execFileSync("python3", ["-c", `import zipfile,sys,base64
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('业务/规则.md', '# 取消规则\\n![状态](../images/state.png)\\n未发货允许取消')
 z.writestr('images/state.png', base64.b64decode(sys.argv[2]))
 z.writestr('附件/说明.svg', '<svg></svg>')
 z.writestr('__MACOSX/._规则.md', b'metadata')`, join(root, "bundle.zip"), png]);
    const material = await saveKnowledgeMaterial(root, { name: "业务资料.zip", content_base64: readFileSync(join(root, "bundle.zip")).toString("base64") });
    assert.equal(material.state, "ready", material.error); assert.equal(material.version, ""); assert.equal(material.scope, "本次萃取任务"); assert.ok(material.uploaded_at);
    assert.equal(material.sections.length, 1); assert.match(material.sections[0].location, /业务\/规则.md · 行 1/); assert.match(material.sections[0].text, /\.\.\/images\/state.png/);
    assert.equal(material.images?.length, 1); assert.equal(material.images![0].path, "images/state.png"); assert.equal(material.warnings?.length, 1); assert.match(material.warnings![0], /说明.svg/);
    const { knowledgeMaterialTool, readKnowledgeMaterial } = await import("../src/knowledgeMaterials.ts");
    const tool: any = knowledgeMaterialTool([readKnowledgeMaterial(root, material.id)], root);
    const listing = await tool.execute("list", {}); assert.match((listing.content[0] as any).text, /images\/state.png/);
    const image = await tool.execute("image", { id: material.id, image_path: "images/state.png" });
    assert.equal(image.content[1].type, "image"); assert.equal((image.content[1] as any).data, png); assert.equal((image.content[1] as any).mimeType, "image/png");
    const noVision = await tool.execute("text-model", { id: material.id, image_path: "images/state.png" }, undefined, undefined, { model: { input: ["text"] } as any });
    assert.equal(noVision.isError, true); assert.match((noVision.content[0] as any).text, /不支持图片/);
    assert.equal((await tool.execute("outside", { id: "material-other", image_path: "images/state.png" })).isError, true);
    assert.equal((await tool.execute("traverse", { id: material.id, image_path: "../../source.zip" })).isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ZIP 拒绝穿越、链接、重复条目、过大展开和损坏；失败不保留可读图片", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-zip-invalid-"));
  try {
    execFileSync("python3", ["-c", `import zipfile,sys,stat
from pathlib import Path
root=Path(sys.argv[1])
for name,path in [('traverse','../escape.md'),('absolute','/absolute.md'),('windows','C:/escape.md')]:
 with zipfile.ZipFile(root/(name+'.zip'),'w') as z:z.writestr(path,'规则')
with zipfile.ZipFile(root/'symlink.zip','w') as z:
 i=zipfile.ZipInfo('link.md');i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,'/outside')
with zipfile.ZipFile(root/'duplicate.zip','w') as z:
 z.writestr('same.md','first');z.writestr('same.md','second')
with zipfile.ZipFile(root/'large.zip','w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('large.md',b'x'*(11*1024*1024))
with zipfile.ZipFile(root/'expanded.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for i in range(11):z.writestr(str(i)+'.md',b'x'*(10*1024*1024))
(root/'broken.zip').write_bytes(b'not a zip')`, root], { stdio: "pipe" });
    for (const name of ["traverse", "absolute", "windows", "symlink", "duplicate", "large", "expanded", "broken"]) {
      const record = await saveKnowledgeMaterial(root, { name: `${name}.zip`, content_base64: readFileSync(join(root, `${name}.zip`)).toString("base64") });
      assert.equal(record.state, "failed", name); assert.match(record.error!, /ZIP/); assert.deepEqual(record.sections, []); assert.deepEqual(record.images, []);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#449：ZIP 中超过 5 MiB 的合法业务文本可完整解析并分段读取", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-zip-text-budget-"));
  try {
    execFileSync("python3", ["-c", `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:
 for i in range(2):z.writestr(str(i)+'.md', ('退款规则\\n'*800000)+'文档结尾'+str(i))`, join(root, "business.zip")]);
    const material = await saveKnowledgeMaterial(root, { name: "business.zip", content_base64: readFileSync(join(root, "business.zip")).toString("base64") });
    assert.equal(material.state, "ready", material.error);
    assert.ok(Buffer.byteLength(material.sections.map(s => s.text).join("")) > 8 * 1024 * 1024);
    for (let i = 0; i < 2; i++) assert.ok(material.sections.some(s => s.location.startsWith(`${i}.md`) && s.text.includes(`文档结尾${i}`)), `文档 ${i} 不能截断`);
    const { knowledgeMaterialTool } = await import("../src/knowledgeMaterials.ts");
    const tool: any = knowledgeMaterialTool([material], root);
    const result = await tool.execute("read", { id: material.id, start: material.sections.length, count: 1 });
    const read = JSON.parse((result.content[0] as any).text);
    assert.equal(read.sections.length, 1); assert.match(read.sections[0].text, /文档结尾1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
