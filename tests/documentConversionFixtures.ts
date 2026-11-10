import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 标准库构造真实 Office/PDF 容器，用实际转换二进制核对文字、表格与图片。 */
export function documentConversionFixtures(root: string) {
  execFileSync("python3", ["-c", `import zipfile,sys,struct,zlib,binascii
from pathlib import Path
p=Path(sys.argv[1])
def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',binascii.crc32(kind+data))
png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',64,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\\0'+b'\\xff\\0\\0'*64)*64))+chunk(b'IEND',b'')
(p/'figure.png').write_bytes(png)
with zipfile.ZipFile(p/'rules.docx','w') as z:
 z.writestr('word/document.xml','''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>订单规则</w:t></w:r></w:p><w:p><w:r><w:t>未付款可以取消</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>允许操作</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>未付款</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>取消</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="状态图" descr="状态图"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>''')
 z.writestr('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>')
 z.writestr('word/media/image1.png',png)
with zipfile.ZipFile(p/'deck.pptx','w') as z:
 z.writestr('ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>')
 z.writestr('ppt/slides/slide1.xml','''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>演示订单规则</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="2" name="流程" descr="订单流程"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>''')
 z.writestr('ppt/slides/_rels/slide1.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>')
 z.writestr('ppt/media/image1.png',png)
with zipfile.ZipFile(p/'book.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="规则" r:id="r1"/><sheet name="例外" r:id="r2"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>')
 for i in (1,2):z.writestr('xl/worksheets/sheet'+str(i)+'.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>')
def pdf(objects):
 data=b'%PDF-1.4\\n';offsets=[0]
 for i,obj in enumerate(objects):offsets.append(len(data));data+=str(i+1).encode()+b' 0 obj\\n'+obj+b'\\nendobj\\n'
 xref=len(data);data+=('xref\\n0 '+str(len(objects)+1)+'\\n0000000000 65535 f \\n').encode()+b''.join(('%010d 00000 n \\n'%n).encode() for n in offsets[1:])+('trailer\\n<< /Size '+str(len(objects)+1)+' /Root 1 0 R >>\\nstartxref\\n'+str(xref)+'\\n%%EOF\\n').encode()
 return data
stream=b'BT /F1 12 Tf 40 700 Td (Order cancellation rules) Tj ET'
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\\nstream\\n'+stream+b'\\nendstream']
(p/'native.pdf').write_bytes(pdf(objects))
paint=b'q 600 0 0 800 0 0 cm /Im1 Do Q'
raster=zlib.compress(b'\\xff\\0\\0'*64*64)
scan=[objects[0],objects[1],b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length '+str(len(raster)).encode()+b' >>\\nstream\\n'+raster+b'\\nendstream',b'<< /Length '+str(len(paint)).encode()+b' >>\\nstream\\n'+paint+b'\\nendstream']
(p/'scanned.pdf').write_bytes(pdf(scan))
with zipfile.ZipFile(p/'mixed.zip','w') as z:
 for file in ('rules.docx','deck.pptx','book.xlsx','native.pdf'):z.write(p/file,'资料/'+file)
 z.writestr('说明.md','# 总览\\n\\n![原图](assets/figure.png)\\n')
 z.writestr('notes.txt','原始说明')
 z.writestr('assets/figure.png',png)
with zipfile.ZipFile(p/'broken.zip','w') as z:
 z.writestr('readme.md','已读规则')
 z.writestr('assets/figure.png',png)
 z.writestr('broken.docx',b'invalid')
`, root]);
  return (name: string) => readFileSync(join(root, name));
}
