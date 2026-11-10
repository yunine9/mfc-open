"""Schema and project configuration loading for the specification engine."""

from .specengine_base import (
    DEFAULT_SCHEMA, SpecEngineError, VENDOR_SCHEMAS_DIR, _DATE_RE,
    _norm_newlines, _openspec_dir, _posix, _read_text, _yaml_load, os,
)

def _list_vendored_schemas():
    names = []
    try:
        for entry in os.listdir(VENDOR_SCHEMAS_DIR):
            if os.path.isfile(os.path.join(VENDOR_SCHEMAS_DIR, entry, "schema.yaml")):
                names.append(entry)
    except OSError:
        pass
    return sorted(names)


def _load_schema(name):
    """加载 vendored schema（指令与模板的唯一来源，不做任何正文硬编码）。"""
    schema_path = os.path.join(VENDOR_SCHEMAS_DIR, name, "schema.yaml")
    if not os.path.isfile(schema_path):
        raise SpecEngineError(
            "未知 schema '%s'；插件内嵌可用：%s"
            % (name, ", ".join(_list_vendored_schemas()) or "(无)"))
    data = _yaml_load(_read_text(schema_path))
    artifacts = []
    for item in data.get("artifacts") or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        artifacts.append({
            "id": str(item.get("id")),
            "generates": str(item.get("generates", "")),
            "description": str(item.get("description", "")),
            "template": str(item.get("template", "")),
            "instruction": item.get("instruction") or "",
            "requires": [str(x) for x in (item.get("requires") or [])],
        })
    if not artifacts:
        raise SpecEngineError("schema 损坏（没有 artifacts）：" + _posix(schema_path))
    return {
        "name": name,
        "dir": os.path.join(VENDOR_SCHEMAS_DIR, name),
        "artifacts": artifacts,
        "apply": data.get("apply") or {},
    }


def _load_template(schema, template_name):
    path = os.path.join(schema["dir"], "templates", template_name)
    if not os.path.isfile(path):
        raise SpecEngineError("schema 模板缺失：" + _posix(path))
    # 行尾归一(CI 实锤):Windows CRLF checkout 下模板带 \r\n,引擎输出与
    # CLI(stdout 经 universal newlines 归一)不一致;引擎行为不能赌 checkout 配置。
    return _norm_newlines(_read_text(path))


def _config_path(root):
    yaml_path = os.path.join(_openspec_dir(root), "config.yaml")
    if os.path.isfile(yaml_path):
        return yaml_path
    yml_path = os.path.join(_openspec_dir(root), "config.yml")
    if os.path.isfile(yml_path):
        return yml_path
    return None


def _read_project_config(root):
    """镜像 readProjectConfig 的宽容语义：坏字段忽略而不是报错。"""
    path = _config_path(root)
    if path is None:
        return {}
    try:
        raw = _yaml_load(_read_text(path))
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    config = {}
    schema = raw.get("schema")
    if isinstance(schema, str) and schema.strip():
        config["schema"] = schema.strip()
    context = raw.get("context")
    if isinstance(context, str):
        config["context"] = context
    rules = raw.get("rules")
    if isinstance(rules, dict):
        cleaned = {}
        for artifact_id, items in rules.items():
            if isinstance(items, list):
                values = [x for x in items if isinstance(x, str) and x]
                if values:
                    cleaned[artifact_id] = values
        if cleaned:
            config["rules"] = cleaned
    return config


def _read_change_metadata(change_dir):
    """读取 .openspec.yaml；返回 (metadata_dict_or_None, error_or_None)。"""
    path = os.path.join(change_dir, ".openspec.yaml")
    if not os.path.isfile(path):
        return None, None
    try:
        raw = _yaml_load(_read_text(path))
    except Exception as exc:
        return None, ".openspec.yaml 解析失败：%s" % exc
    if not isinstance(raw, dict):
        return None, ".openspec.yaml 不是映射"
    schema = raw.get("schema")
    if not isinstance(schema, str) or not schema.strip():
        return None, ".openspec.yaml 缺少 schema 字段"
    created = raw.get("created")
    if created is not None and (
            not isinstance(created, str) or not _DATE_RE.match(created)):
        return None, ".openspec.yaml 的 created 必须是 YYYY-MM-DD"
    return {"schema": schema.strip(), "created": created}, None


def _resolve_schema_name(root, change_dir, strict):
    """镜像 resolveSchemaForChange：change 元数据 → config → 默认。

    strict=True（instructions/status 路径）时元数据损坏要报错；
    strict=False（archive 的任务计数路径）时按 CLI 的 try/catch 静默回退。
    """
    metadata, err = _read_change_metadata(change_dir)
    if err and strict:
        raise SpecEngineError("change 元数据无效（%s）：%s"
                              % (err, _posix(os.path.join(change_dir, ".openspec.yaml"))))
    if metadata and metadata.get("schema"):
        return metadata["schema"]
    config = _read_project_config(root)
    if config.get("schema"):
        return config["schema"]
    return DEFAULT_SCHEMA
