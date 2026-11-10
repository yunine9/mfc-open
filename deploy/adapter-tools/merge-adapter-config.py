#!/usr/bin/env python3
"""生成完整的 adapter 配置候选，并在落盘前校验持续交付端点。"""

import json
import os
import sys
from pathlib import Path


REQUIRED_ENDPOINTS = (
    "mr_create",
    "mr_approver_members",
    "pipeline_trigger",
    "pipeline_status",
    "pipeline_artifacts",
    "mr_lookup",
    "mr_discover",
    "mr_detail",
    "mr_discussions",
    "mr_gates",
)

REPOSITORY_SCRIPTS = {
    "pipeline_status": "pipeline-status.sh",
    "pipeline_artifacts": "pipeline-artifacts.sh",
    "mr_discover": "mr-discover.py",
    "mr_detail": "mr-detail.py",
    "mr_gates": "mr-gates.py",
}


def fail(message):
    raise ValueError(message)


def load_object(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail("配置根节点必须是 JSON 对象: %s" % path)
    return value


def commands(spec):
    if not isinstance(spec, dict):
        return []
    candidates = spec.get("candidates")
    choices = candidates if isinstance(candidates, list) and candidates else [spec]
    return [item.get("command") for item in choices
            if isinstance(item, dict) and isinstance(item.get("command"), list)
            and item.get("command")]


def validate(config, root):
    missing = [name for name in REQUIRED_ENDPOINTS
               if not commands(config.get(name))
               and not (name == "pipeline_trigger"
                        and isinstance(config.get(name), dict)
                        and config[name].get("observe_only") is True)]
    if missing:
        fail("缺少持续交付必备端点或命令: %s" % ", ".join(missing))
    unresolved = [name for name in REQUIRED_ENDPOINTS
                  if any("@REPO_DIR@" in str(part)
                         for command in commands(config[name]) for part in command)]
    if unresolved:
        fail("端点仍包含未替换的 @REPO_DIR@: %s" % ", ".join(unresolved))
    for endpoint, filename in REPOSITORY_SCRIPTS.items():
        expected = root / "deploy" / "adapter-tools" / filename
        if not expected.is_file():
            fail("仓库脚本不存在: %s" % expected)
        if not any(str(expected) in [str(part) for part in command]
                   for command in commands(config[endpoint])):
            fail("端点 %s 未使用同版本仓库脚本 %s" % (endpoint, expected))


def merge(source, destination, root):
    config = load_object(source)
    patch_path = root / "deploy" / "adapter-config" / "mr-pipeline.patch.json"
    patch = load_object(patch_path)
    missing_patch = [name for name in REQUIRED_ENDPOINTS if name not in patch]
    if missing_patch:
        fail("部署补丁本身不完整，缺少: %s" % ", ".join(missing_patch))

    for key, raw_spec in list(patch.items()):
        spec = dict(raw_spec)
        command = spec.get("command")
        if isinstance(command, list):
            spec["command"] = [str(part).replace("@REPO_DIR@", str(root))
                               for part in command]
        existing = config.get(key, {})
        if key in ("pipeline_status", "pipeline_artifacts") and isinstance(existing, dict):
            if "timeout_s" in existing:
                spec["timeout_s"] = existing["timeout_s"]
            existing_candidates = existing.get("candidates")
            if isinstance(existing_candidates, list) and existing_candidates:
                script_name = Path(spec["command"][1]).name
                matches = [index for index, candidate in enumerate(existing_candidates)
                           if any(script_name in str(part)
                                  for part in candidate.get("command", []))]
                position = matches[0] if matches else min(1, len(existing_candidates))
                retained = [candidate for index, candidate in enumerate(existing_candidates)
                            if index not in matches]
                retained.insert(position, spec)
                spec = dict(existing, candidates=retained)
        patch[key] = spec

    config.update(patch)
    config.pop("mr_participants", None)
    validate(config, root)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(config, output, ensure_ascii=False, indent=2)
        output.write("\n")


def main(argv):
    if len(argv) != 4:
        fail("用法: merge-adapter-config.py <现有配置> <候选配置> <仓库根目录>")
    source, destination, root = (Path(value).resolve() for value in argv[1:])
    if source == destination:
        fail("候选路径不能覆盖现有配置")
    merge(source, destination, root)
    print("候选已生成并通过持续交付端点校验: %s" % destination)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as error:
        print("adapter 配置候选生成失败: %s" % error, file=sys.stderr)
        sys.exit(1)
