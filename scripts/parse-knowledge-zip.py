"""Read document bundles without extracting user-controlled paths."""
import binascii
import json
import pathlib
import re
import stat
import struct
import tempfile
import zipfile


class BundleError(ValueError):
    pass


def entry_name(info):
    if info.flag_bits & 0x800:
        return info.orig_filename
    raw = info.orig_filename.encode('cp437')
    extra = info.extra
    while len(extra) >= 4:
        tag, size = struct.unpack('<HH', extra[:4])
        payload, extra = extra[4:4 + size], extra[4 + size:]
        if tag == 0x7075 and len(payload) >= 6 and payload[0] == 1 and struct.unpack('<I', payload[1:5])[0] == binascii.crc32(raw):
            try:
                return payload[5:].decode('utf-8')
            except UnicodeDecodeError:
                pass
    for encoding in ('utf-8', 'gb18030'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise BundleError('ZIP 文件名编码无法识别，请使用 UTF-8 或 GBK/GB18030')


def parse_bundle(path, parse_document, save_image):
    result = {'sections': [], 'images': [], 'warnings': [], 'documents': []}
    documents = {'.md', '.markdown', '.txt', '.docx', '.pdf', '.xlsx', '.pptx'}
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 1000 or sum(i.file_size for i in entries) > 100 * 1024 * 1024:
            raise BundleError('ZIP 最多 1000 个条目，解压后总量不能超过 100 MiB')
        seen, names = set(), []
        for info in entries:
            name = entry_name(info)
            parts = name.rstrip('/').split('/')
            if (not name or len(name) > 500 or any(p in ('', '.', '..') for p in parts)
                    or re.search(r'[\\:\x00-\x1f\x7f]', name) or '\x00' in info.orig_filename
                    or stat.S_ISLNK(info.external_attr >> 16) or name in seen):
                raise BundleError('ZIP 含无效路径、重复条目或符号链接，请重新打包')
            if info.flag_bits & 1:
                raise BundleError('不支持加密 ZIP，请解密后重新上传')
            seen.add(name)
            names.append(name)
        with tempfile.TemporaryDirectory(prefix='parse-bundle-', dir=path.parent) as temporary:
            for index, (info, name) in enumerate(zip(entries, names)):
                if info.is_dir() or name.startswith('__MACOSX/') or pathlib.PurePosixPath(name).name == '.DS_Store':
                    continue
                suffix = pathlib.PurePosixPath(name).suffix.lower()
                if suffix not in documents | {'.png', '.jpg', '.jpeg', '.gif', '.webp'}:
                    result['warnings'].append(f'未解析附件：{name}；ZIP 内支持 Markdown、TXT、DOCX、PDF、XLSX、PPTX 和 PNG/JPEG/GIF/WebP 图片')
                    continue
                if info.file_size > 10 * 1024 * 1024:
                    raise BundleError(f'ZIP 内单个文档或图片不能超过 10 MiB：{name}')
                with archive.open(info) as entry:
                    data = entry.read(10 * 1024 * 1024 + 1)
                if len(data) > 10 * 1024 * 1024:
                    raise BundleError(f'ZIP 内文件超过大小限制：{name}')
                if suffix in documents:
                    # Only generated flat names reach the filesystem, never archive paths.
                    document = pathlib.Path(temporary) / f'{index}{suffix}'
                    document.write_bytes(data)
                    try:
                        parsed = parse_document(document, name, path.parent)
                        if not any(section['text'].strip() for section in parsed['sections']) and not parsed['images']:
                            raise ValueError('未提取到可读文本或图片')
                    except Exception as error:
                        raise BundleError(f'ZIP 文档解析失败：{name}；{error}') from error
                    for key in result:
                        result[key].extend(parsed[key])
                else:
                    try:
                        result['images'].append(save_image(path.parent, name, data))
                    except ValueError as error:
                        raise BundleError(f'ZIP 图片解析失败：{name}；{error}') from error
    assets = {}
    for asset in result['images']:
        if asset['path'] in assets and assets[asset['path']]['id'] != asset['id']:
            raise BundleError(f"ZIP 图片路径冲突：{asset['path']}")
        assets[asset['path']] = asset
    result['images'] = list(assets.values())
    if len(json.dumps(result, ensure_ascii=False).encode()) > 128 * 1024 * 1024:
        raise BundleError('ZIP 解析结果过大，请拆成多个资料包')
    return result
