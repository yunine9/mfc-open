"""Deterministic, local-first domain archive transaction."""

from dataclasses import asdict, dataclass
import hashlib
import os

from .behavior_baseline import (
    plan_domain_reconciliation,
    render_domain_index,
    validate_domain_document,
)


@dataclass(frozen=True)
class ArchiveCandidate:
    domain: str
    keywords: tuple
    candidate_path: str
    target_path: str
    action: str
    initialized: bool = False

    def to_dict(self, project_root):
        root = os.path.abspath(os.fspath(project_root))
        return {
            **asdict(self),
            "keywords": list(self.keywords),
            "candidate_path": os.path.relpath(self.candidate_path, root).replace("\\", "/"),
        }


def _read(path):
    try:
        with open(path, encoding="utf-8") as stream:
            return stream.read()
    except OSError:
        return ""


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp-%s" % os.getpid()
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def initialize_candidate(project_root, archive_root, domain, template_content, *, adopt_existing=False):
    result = plan_domain_reconciliation(project_root, domain, "placeholder")
    candidate = os.path.join(os.path.abspath(archive_root), "%s.md" % result.domain)
    if adopt_existing:
        # Explicit adoption names the current formal document as the source.
        # A candidate left over from an earlier round must not replace it.
        with open(result.absolute_path, encoding="utf-8") as stream:
            content = stream.read()
        if not os.path.exists(candidate) or _read(candidate) != content:
            _write(candidate, content)
        return ArchiveCandidate(result.domain, (), candidate, result.path, "draft", False)
    if os.path.exists(candidate):
        return ArchiveCandidate(
            result.domain, (), candidate, result.path, "draft", False)
    current = _read(result.absolute_path)
    content = current or str(template_content).replace("<领域名称>", result.domain)
    _write(candidate, content)
    return ArchiveCandidate(result.domain, (), candidate, result.path, "draft", True)


def prepare_candidate(project_root, candidate_path, domain, keywords):
    # Missing input must never silently become an empty overwrite. Formatting
    # is guidance; the Agent and reviewer own the content.
    with open(candidate_path, encoding="utf-8") as stream:
        content = stream.read()
    errors = validate_domain_document(content)
    if errors:
        print("提示（不阻断）: " + "；".join(errors))
    result = plan_domain_reconciliation(project_root, domain, content)
    words = tuple(dict.fromkeys(
        str(keyword).strip() for keyword in keywords if str(keyword).strip()))
    if result.action == "new" and not words:
        words = (result.domain,)
        print("提示（不阻断）: 未提供索引关键词，先使用领域名 " + result.domain)
    return ArchiveCandidate(
        result.domain, words, os.path.abspath(candidate_path),
        result.path, result.action, False)


def candidate_from_dict(project_root, value):
    root = os.path.abspath(os.fspath(project_root))
    candidate = os.path.abspath(os.path.join(
        root, *str(value["candidate_path"]).replace("\\", "/").split("/")))
    if os.path.commonpath((root, candidate)) != root:
        raise ValueError("领域归档候选路径越出项目目录")
    return ArchiveCandidate(
        domain=str(value["domain"]),
        keywords=tuple(value.get("keywords") or ()),
        candidate_path=candidate,
        target_path=str(value["target_path"]),
        action=str(value["action"]),
        initialized=bool(value.get("initialized", False)),
    )


def input_digest(project_root, input_paths, git_facts, candidates):
    root = os.path.abspath(os.fspath(project_root))
    digest = hashlib.sha256()
    # Only the files this operation reads/writes define its revision. Unrelated
    # builds, Git staging/commits, Story edits and reports cannot expire it.
    del input_paths, git_facts
    paths = []
    paths.append(os.path.join(root, "docs", "specs", "index.md"))
    for entry in candidates:
        paths.append(os.path.abspath(entry.candidate_path))
        relative = entry.target_path.replace("\\", "/")
        paths.append(os.path.join(root, *relative.split("/")))
    for path in sorted(set(paths), key=str.casefold):
        digest.update(os.path.relpath(path, root).replace("\\", "/").encode("utf-8"))
        try:
            with open(path, "rb") as stream:
                digest.update(stream.read())
        except OSError:
            digest.update(b"<missing>")
    return digest.hexdigest()


def require_fresh(expected, actual):
    if not expected or expected != actual:
        raise ValueError(
            "领域归档候选已过期；只需重新执行 domain-archive prepare，"
            "不会回退编码、检视或质量阶段")


def _transaction_write(contents, replacer=os.replace):
    originals = {}
    temporaries = {}
    replaced = []
    try:
        for path, content in contents.items():
            try:
                with open(path, "rb") as stream:
                    originals[path] = stream.read()
            except OSError:
                originals[path] = None
            os.makedirs(os.path.dirname(path), exist_ok=True)
            temporary = path + ".archive-%s" % os.getpid()
            with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
            temporaries[path] = temporary
        for path in sorted(contents, key=str.casefold):
            replacer(temporaries[path], path)
            replaced.append(path)
    except Exception:
        for path in reversed(replaced):
            original = originals[path]
            if original is None:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                continue
            restore = path + ".rollback-%s" % os.getpid()
            with open(restore, "wb") as stream:
                stream.write(original)
            os.replace(restore, path)
        raise
    finally:
        for temporary in temporaries.values():
            try:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            except OSError:
                pass


def apply_candidates(project_root, candidates, replacer=os.replace, reapply_paths=()):
    root = os.path.abspath(os.fspath(project_root))
    entries = tuple(candidates)
    contents = {}
    additions = []
    changed = []
    for entry in entries:
        prepared = prepare_candidate(
            root, entry.candidate_path, entry.domain, entry.keywords)
        if prepared.action == "unchanged" and prepared.target_path not in reapply_paths:
            continue
        target = os.path.join(root, *prepared.target_path.split("/"))
        content = _read(prepared.candidate_path)
        if not os.path.exists(target) or _read(target) != content:
            contents[target] = content
        changed.append(prepared.target_path)
        additions.append((prepared.domain, prepared.keywords))
    if additions:
        index = os.path.join(root, "docs", "specs", "index.md")
        current_index = _read(index)
        rendered_index = render_domain_index(current_index, additions)
        if rendered_index != current_index:
            contents[index] = rendered_index
        if rendered_index != current_index or reapply_paths:
            changed.append("docs/specs/index.md")
    if contents:
        _transaction_write(contents, replacer=replacer)
    return tuple(sorted(set(changed), key=str.casefold))
