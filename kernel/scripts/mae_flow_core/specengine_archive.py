"""Atomic specification archive application and rollback."""

from .specengine_base import (
    SpecEngineError, _DATE_RE, _LEAK_RE, _archive_dir, _main_specs_dir,
    _norm_newlines, _posix, _read_text_utf8, _rel_under, _require_change_dir,
    _utc_today, atomic_write_text, os, shutil, time,
)
from .specengine_markdown import (
    _find_main_spec_structure_issues, _validate_main_spec_content,
)
from .specengine_v5 import (
    _change_layout, _has_delta_specs, _read_change_doc, _require_layout_pure,
    _validate_v5_domain,
)
from .specengine_validation import _collect_delta_issues
from .specengine_lifecycle import _count_tasks
from .specengine_archive_render import _build_updated_spec

def _find_spec_updates(change_dir, main_specs_dir):
    """待合并 delta 清单，每项 domain/content/target/exists。

    legacy 镜像 findSpecUpdates：只认一层 specs/<域>/spec.md（嵌套层不合并，
    与 CLI 一致）。v5 从 change.md 的规格条目节取内容；两种布局都按域名
    排序，保证 merged 顺序确定且与 legacy 语义一致。"""
    updates = []
    if _change_layout(change_dir) == "v5":
        doc = _read_change_doc(change_dir)
        if doc["duplicate_domains"]:
            raise SpecEngineError(
                "change.md 规格条目域重复：%s；同域 delta 合并到一节后重试"
                % "、".join(sorted(set(doc["duplicate_domains"]))))
        for item in sorted(doc["domains"], key=lambda it: it["domain"]):
            domain = _validate_v5_domain(item["domain"])
            target = os.path.join(main_specs_dir, domain, "spec.md")
            updates.append({
                "domain": domain,
                "content": item["body"],
                "target": target,
                "exists": os.path.isfile(target),
            })
        return updates
    specs_dir = os.path.join(change_dir, "specs")
    try:
        entries = sorted(os.listdir(specs_dir))  # 域名排序，保证 merged 顺序确定
    except OSError:
        return updates
    for entry in entries:
        if not os.path.isdir(os.path.join(specs_dir, entry)):
            continue
        source = os.path.join(specs_dir, entry, "spec.md")
        if not os.path.isfile(source):
            continue
        target = os.path.join(main_specs_dir, entry, "spec.md")
        updates.append({
            "domain": entry,
            "content": _read_text_utf8(source),
            "target": target,
            "exists": os.path.isfile(target),
        })
    return updates


def _move_directory(src, dest):
    """目录移动：优先原子 rename；跨盘/权限失败退化为 copy+delete（同 CLI）。

    Windows 杀软可能短暂锁目录，rename 带小步重试。
    """
    last_error = None
    for attempt in range(4):
        try:
            os.rename(src, dest)
            return
        except PermissionError as exc:
            last_error = exc
            time.sleep(0.05 * (2 ** attempt))
        except OSError as exc:
            last_error = exc
            break
    try:
        shutil.copytree(src, dest)
        shutil.rmtree(src)
    except OSError as exc:
        raise SpecEngineError(
            "归档移动失败（%s → %s）：%s；rename 错误：%s"
            % (_posix(src), _posix(dest), exc, last_error))


def _sweep_main_specs_for_leak(root):
    """吸收 comet verify_main_specs_clean：主 specs 不得残留 delta 分节字样。

    引擎把它做成归档前置检查（见模块注释差异 3），返回违规文件的 posix 相对路径。
    """
    leaked = []
    specs_dir = _main_specs_dir(root)
    if not os.path.isdir(specs_dir):
        return leaked
    for entry in sorted(os.listdir(specs_dir)):
        spec_file = os.path.join(specs_dir, entry, "spec.md")
        if not os.path.isfile(spec_file):
            continue
        try:
            content = _read_text_utf8(spec_file)
        except OSError:
            continue
        if _LEAK_RE.search(_norm_newlines(content)):
            leaked.append(_posix(os.path.join(
                _rel_under(_main_specs_dir(root), root), entry, "spec.md")))
    return leaked


def archive(root, change, date=None):
    """归档一个 change：全量校验 → delta 合并进主 specs → 移动目录。

    等价 ``openspec archive <change> --yes``（校验开启、跳过所有交互确认），
    外加半成功免疫：目标冲突/校验失败发生在任何写盘之前；写盘后移动失败会
    回滚已写的主 specs。``date`` 仅供测试注入（YYYY-MM-DD），默认 UTC 今天。

    返回 ``{"archived_to", "archive_name", "merged", "totals", "tasks",
    "warnings"}``；失败抛 SpecEngineError 且现场保持原样、可重跑。
    """
    root = os.path.abspath(root)
    change_dir = _require_change_dir(root, change)
    if date is not None and not _DATE_RE.match(str(date)):
        raise SpecEngineError("date 必须是 YYYY-MM-DD 格式：%s" % date)
    # v5 布局混用先拒：无 delta 的混用单会跳过 delta 校验直接进移动，把
    # 未合并的旧 delta 悄悄埋进档案——必须在任何动作之前拦住。
    _require_layout_pure(change_dir)
    warnings = []
    # —— 第 1 步：delta 校验（与 CLI 相同：只有探测到 delta spec 才校验） ——
    if _has_delta_specs(change_dir):
        issues = _collect_delta_issues(change_dir)
        errors = [text for level, text in issues if level == "ERROR"]
        if errors:
            raise SpecEngineError(
                "change '%s' 的 delta 校验未通过，归档中止（未改动任何文件）：\n- %s"
                % (change, "\n- ".join(errors)))
    # —— 第 2 步：任务进度（--yes 语义：不完整只警告不阻塞） ——
    tasks = _count_tasks(change_dir)
    incomplete = max(tasks["total"] - tasks["completed"], 0)
    if incomplete > 0:
        warnings.append("有 %d 个任务未完成，按 --yes 语义继续归档" % incomplete)
    # —— 第 3 步：纯内存计算所有 spec 合并结果（零写盘） ——
    main_specs = _main_specs_dir(root)
    staged = []  # (update, rebuilt, original_or_None)
    totals = {"added": 0, "modified": 0, "removed": 0, "renamed": 0}
    for update in _find_spec_updates(change_dir, main_specs):
        source_content = update["content"]
        target_content = (_read_text_utf8(update["target"])
                          if update["exists"] else None)
        rebuilt, counts, merge_warnings = _build_updated_spec(
            source_content, target_content, update["domain"], change)
        warnings.extend(merge_warnings)
        if not update["exists"]:
            # 新建域骨架的 Purpose 是 TBD 占位(与 CLI 逐字节一致,引擎不代写)。
            # 不提醒的话 TBD 会静默入库,真相源积累空洞。
            warnings.append(
                "新建域 %s 的真相源 Purpose 是 TBD 占位:请从 change.md「为什么」"
                "节浓缩补写 openspec/specs/%s/spec.md 的 Purpose 再提交"
                % (update["domain"], update["domain"]))
        # 重建结果的 spec 级校验（镜像 validateSpecContent；ERROR 即中止）。
        spec_issues = _validate_main_spec_content(update["domain"], rebuilt)
        spec_errors = [text for level, text in spec_issues if level == "ERROR"]
        if spec_errors:
            raise SpecEngineError(
                "域 '%s' 合并后的主 spec 未通过校验，归档中止（未改动任何文件）：\n- %s"
                % (update["domain"], "\n- ".join(spec_errors)))
        for level, text in spec_issues:
            if level != "ERROR":
                warnings.append(text)
        for key in totals:
            totals[key] += counts[key]
        staged.append((update, rebuilt, target_content))
    # —— 第 4 步：写盘前的全部前置检查（半成功免疫的关键顺序） ——
    archive_name = "%s-%s" % (date or _utc_today(), change)
    archive_path = os.path.join(_archive_dir(root), archive_name)
    if os.path.exists(archive_path):
        # CLI 在写完 specs 之后才做这个检查，会留下半成功现场；引擎提前到
        # 任何写盘之前（模块注释差异 1）。
        raise SpecEngineError(
            "归档目标已存在：%s；该 change 可能已归档过（重复归档被拒绝，"
            "未改动任何文件）" % _posix(archive_path))
    leaked = _sweep_main_specs_for_leak(root)
    if leaked:
        raise SpecEngineError(
            "主 specs 残留 delta 分节字样（## ADDED/MODIFIED/... Requirements），"
            "先修复再归档（未改动任何文件）：%s" % "、".join(leaked))
    # —— 第 5 步：写主 specs（逐文件原子写），失败回滚 ——
    written = []       # (target_path, original_or_None)
    created_dirs = []  # 为新建域创建的目录（回滚时清掉空目录）
    try:
        for update, rebuilt, original in staged:
            target_dir = os.path.dirname(update["target"])
            if not os.path.isdir(target_dir):
                created_dirs.append(target_dir)
            atomic_write_text(update["target"], rebuilt)
            written.append((update["target"], original))
        os.makedirs(_archive_dir(root), exist_ok=True)
        _move_directory(change_dir, archive_path)
    except Exception as exc:
        for target, original in reversed(written):
            try:
                if original is None:
                    os.remove(target)
                else:
                    atomic_write_text(target, original)
            except OSError:
                pass
        for directory in reversed(created_dirs):
            try:
                os.rmdir(directory)
            except OSError:
                pass
        if isinstance(exc, SpecEngineError):
            raise
        raise SpecEngineError(
            "归档写盘阶段失败，已回滚主 specs：%s" % exc)
    # —— 第 6 步：写盘后复核（纯断言性质；重建内容已过校验，正常不可能触发） ——
    leaked_after = _sweep_main_specs_for_leak(root)
    if leaked_after:
        raise SpecEngineError(
            "归档已完成但主 specs 复核发现 delta 残留（请人工检查）：%s"
            % "、".join(leaked_after))
    return {
        "archived_to": _posix(archive_path),
        "archive_name": archive_name,
        "merged": [_posix(os.path.join(
                       _rel_under(_main_specs_dir(root), root),
                       update["domain"], "spec.md"))
                   for update, _rebuilt, _original in staged],
        "totals": totals,
        "tasks": tasks,
        "warnings": warnings,
    }
