#!/usr/bin/env python3
"""Convert uploaded documents locally and keep source locations and durable images."""
import hashlib
import importlib.util
import json
import os
import pathlib
import posixpath
import re
import subprocess
import sys
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile

MAX_TEXT = 6 * 1024 * 1024


def image_mime(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 33 and data[12:16] == b'IHDR':
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'):
        return 'image/jpeg'
    if data[:6] in (b'GIF87a', b'GIF89a') and len(data) >= 13:
        return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP' and len(data) >= 20:
        return 'image/webp'
    return None


def save_image(root, name, data):
    mime = image_mime(data)
    if not mime:
        raise ValueError(f'图片格式无效或不支持：{name}')
    if len(data) > 10 * 1024 * 1024:
        raise ValueError(f'图片超过 10 MiB：{name}')
    asset_id = hashlib.sha256(data).hexdigest()
    folder = root / 'images'
    folder.mkdir(exist_ok=True, mode=0o700)
    target = folder / asset_id
    target.write_bytes(data)
    target.chmod(0o600)
    return {'id': asset_id, 'path': name, 'mimeType': mime, 'bytes': len(data)}


def sections_for_text(text, name, converted=False, initial_location=None):
    """Keep every character so another consumer can reconstruct the full document."""
    sections = []
    lines = text.splitlines(keepends=True)
    location, start = (initial_location or ('转换文本' if converted else '')), 0
    for index, line in enumerate(lines):
        marker = re.fullmatch(r'\s*<!--\s*(page|slide)\s+(\d+)\s*-->\s*', line) if converted and pathlib.PurePosixPath(name).suffix.lower() in ('.pdf', '.pptx') else None
        if marker:
            if index > start:
                append_text(sections, ''.join(lines[start:index]), name, location, start + 1, index)
            location = ('第 ' + marker[2] + ' 页') if marker[1] == 'page' else ('幻灯片 ' + marker[2])
            start = index
        elif index - start >= 100:
            append_text(sections, ''.join(lines[start:index]), name, location, start + 1, index)
            start = index
    if start < len(lines):
        append_text(sections, ''.join(lines[start:]), name, location, start + 1, len(lines))
    return sections


def append_text(sections, text, name, location, first_line, last_line):
    line_label = '转换文本行' if pathlib.PurePosixPath(name).suffix.lower() in ('.pdf', '.pptx') else '行'
    for offset in range(0, len(text), 12000):
        sections.append({'location': f'{name} · {location + " · " if location else ""}{line_label} {first_line}–{last_line} · 字符 {offset + 1}',
                         'source_path': name, 'continuation': bool(sections), 'text': text[offset:offset + 12000]})


def validate_office(path):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(info.file_size for info in entries) > 100 * 1024 * 1024:
            raise ValueError('Office 文件展开后超过 100 MiB 或 10000 个条目')
        if any(info.flag_bits & 1 for info in entries):
            raise ValueError('不支持加密 Office 文档')


def convert_anymd(path, name, root):
    if path.suffix.lower() != '.pdf':
        validate_office(path)
    command = [os.environ['MAE_FLOW_NODE_BIN'], os.environ['MAE_FLOW_ANYMD_LAUNCHER']]
    with tempfile.TemporaryDirectory(prefix='parse-document-', dir=root) as temporary:
        cache = pathlib.Path(temporary) / 'cache'
        output = pathlib.Path(temporary) / 'converted.md'
        environment = dict(os.environ, ANYMD_CACHE_DIR=str(cache), ANYMD_NO_STAR_HINT='1', CI='1')
        try:
            # The host's 60-second deadline kills this process group, including the launcher
            # and native converter. Killing only the launcher here would leave its child running.
            subprocess.run(command + [str(path), '--no-ocr', '--images', 'refs', '--output', str(output)],
                           env=environment, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.CalledProcessError, OSError):
            raise ValueError(f'文档转换失败：{name}；请检查文件是否损坏、加密，以及 anymd 原生依赖是否已安装')
        if output.stat().st_size > MAX_TEXT:
            raise ValueError(f'文档解析文字超过 6 MiB：{name}；请拆分文档')
        text = output.read_text(encoding='utf-8')
        images = []
        for image in sorted((cache / 'images').rglob('*')):
            if not image.is_file() or image.is_symlink():
                continue
            references = [str(image), image.as_posix(), urllib.parse.quote(str(image), safe='/')]
            if not any(reference in text for reference in references):
                continue
            data = image.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            image_path = f'images/{digest}{image.suffix.lower()}'
            asset = save_image(root, image_path, data)
            images.append(asset)
            relative = posixpath.relpath(image_path, posixpath.dirname(name) or '.')
            for reference in references:
                text = text.replace(reference, relative)
        if str(cache) in text or urllib.parse.quote(str(cache), safe='/') in text:
            raise ValueError(f'文档图片未能保存到本次资料：{name}')
        # Source markers alone must not turn a blank/scanned file into readable evidence.
        if not re.sub(r'<!--.*?-->', '', text, flags=re.S).strip() and not images:
            raise ValueError(f'未提取到可读文本或图片：{name}；扫描件请先做 OCR')
        warnings = [f'{name}：未执行 OCR；转换结果不保证覆盖矢量图、装饰图片与所有版式，请结合原件核对。']
        return {'sections': sections_for_text(text, name, True, '幻灯片 1' if path.suffix.lower() == '.pptx' else None), 'images': images, 'warnings': warnings,
                'documents': [{'path': name}]}


def parse_document(path, name, root):
    suffix = path.suffix.lower()
    if suffix in ('.pdf', '.docx', '.pptx'):
        return convert_anymd(path, name, root)
    if suffix in ('.md', '.markdown', '.txt'):
        text = path.read_bytes().decode('utf-8-sig')
        if '\x00' in text:
            raise ValueError(f'文档不是有效文本：{name}')
        return {'sections': sections_for_text(text, name), 'images': [], 'warnings': [], 'documents': [{'path': name}]}
    if suffix != '.xlsx':
        raise ValueError(f'不支持的文档格式：{name}')
    validate_office(path)
    sections = []
    with zipfile.ZipFile(path) as archive:
        def xml(part):
            data = archive.read(part)
            if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
                raise ValueError('XML entities not supported')
            return ET.fromstring(data)
        def texts(node):
            return ''.join(e.text or '' for e in node.iter() if e.tag.rsplit('}', 1)[-1] == 't')
        ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
        shared = [texts(si) for si in xml('xl/sharedStrings.xml').findall(f'{ns}si')] if 'xl/sharedStrings.xml' in archive.namelist() else []
        rels = {e.attrib['Id']: e.attrib['Target'] for e in xml('xl/_rels/workbook.xml.rels')}
        for sheet in xml('xl/workbook.xml').iter(f'{ns}sheet'):
            heading = f"## 工作表：{sheet.attrib['name']}\n\n"
            target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            for row in xml(target).iter(f'{ns}row'):
                values = []
                for cell in row.findall(f'{ns}c'):
                    value = cell.findtext(f'{ns}v', '')
                    if cell.attrib.get('t') == 's': value = shared[int(value)] if value else ''
                    elif cell.attrib.get('t') == 'inlineStr': value = texts(cell)
                    formula = cell.findtext(f'{ns}f')
                    values.append(f"{cell.attrib.get('r', '?')}: {value}" + (f'（公式：{formula}；值为文件缓存）' if formula else ''))
                text = heading + ' | '.join(values) + '\n'
                heading = ''
                location = f"工作表 {sheet.attrib['name']} · 行 {row.attrib.get('r', '?')}"
                for offset in range(0, len(text), 12000):
                    sections.append({'location': f'{name} · {location} · 字符 {offset + 1}', 'source_path': name,
                                     'continuation': bool(sections), 'text': text[offset:offset + 12000]})
    return {'sections': sections, 'images': [], 'warnings': [f'{name}：Excel 保留工作表、单元格、公式及文件缓存值；未计算公式，未提取图片、图表与合并单元格版式。'], 'documents': [{'path': name}]}


def parse(path, name):
    if path.suffix.lower() == '.zip':
        spec = importlib.util.spec_from_file_location('knowledge_zip', pathlib.Path(__file__).with_name('parse-knowledge-zip.py'))
        bundle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bundle)
        result = bundle.parse_bundle(path, parse_document, save_image)
    else:
        result = parse_document(path, name, path.parent)
    output = json.dumps(result, ensure_ascii=False)
    if len(output.encode()) > (128 * 1024 * 1024 if path.suffix.lower() == '.zip' else 8 * 1024 * 1024):
        raise ValueError('解析结果过大，请拆分资料后重试')
    return output


if __name__ == '__main__':
    try:
        print(parse(pathlib.Path(sys.argv[1]).resolve(), sys.argv[2] if len(sys.argv) > 2 else pathlib.Path(sys.argv[1]).name))
    except (ValueError, OSError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError) as error:
        print(json.dumps({'error': ('ZIP 解析失败：' if pathlib.Path(sys.argv[1]).suffix.lower() == '.zip' else '资料解析失败：') + (str(error) or '文档损坏或格式不受支持')}, ensure_ascii=False))
