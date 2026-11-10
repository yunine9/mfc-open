"""Shared quality task-card facts, rendering, and storage use cases."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class TaskFileGroups:
    business: tuple
    tests: tuple
    build: tuple

    def as_legacy(self):
        return {
            "business": list(self.business),
            "tests": list(self.tests),
            "build": list(self.build),
        }


@dataclass(frozen=True)
class ExecutionRootPorts:
    repository: str
    absolute: object
    is_directory: object
    list_directory: object
    is_file: object
    is_build_path: object
    relative: object
    dirname: object
    join: object
    separator: str
    source_filenames: tuple
    descriptor_suffixes: tuple


@dataclass(frozen=True)
class ExecutionRootPlan:
    roots: tuple
    unresolved: tuple

    def __post_init__(self):
        object.__setattr__(self, "roots", tuple(self.roots))
        object.__setattr__(
            self, "unresolved", tuple(self.unresolved))


@dataclass(frozen=True)
class TaskCardStorePorts:
    absolute: object
    make_directory: object
    write_text: object


@dataclass(frozen=True)
class TaskCardArtifact:
    path: str
    digest: str
    body: str


def task_file_groups(files, is_build, is_test):
    """Classify a frozen task scope without reordering its files."""
    groups = {
        "business": [],
        "tests": [],
        "build": [],
    }
    for path in files:
        key = (
            "build" if is_build(path)
            else "tests" if is_test(path)
            else "business"
        )
        if path not in groups[key]:
            groups[key].append(path)
    return TaskFileGroups(
        business=tuple(groups["business"]),
        tests=tuple(groups["tests"]),
        build=tuple(groups["build"]),
    )


def _build_root_marker(directory, ports):
    try:
        names = ports.list_directory(directory)
    except OSError:
        return ""
    source_names = set(ports.source_filenames)
    for name in sorted(names, key=str.lower):
        low = name.lower()
        full = ports.join(directory, name)
        descriptor = (
            low in source_names
            or (
                low.startswith("requirements")
                and low.endswith(".txt")
            )
            or low.endswith(ports.descriptor_suffixes)
        )
        if ports.is_file(full) and descriptor:
            return name
    return ""


def _inside_repository(path, repository, separator):
    return (
        path == repository
        or path.startswith(repository + separator)
    )


def _relative_root(directory, ports):
    relative = str(
        ports.relative(directory, ports.repository)
    ).replace("\\", "/")
    return relative if relative != "." else "."


def _execution_root(path, ports):
    absolute = ports.absolute(path)
    directory = (
        absolute
        if ports.is_directory(absolute)
        else ports.dirname(absolute)
    )
    if ports.is_build_path(path):
        return (
            _relative_root(directory, ports),
            "变更文件本身是构建入口",
        )
    current = directory
    while _inside_repository(
            current, ports.repository, ports.separator):
        marker = _build_root_marker(current, ports)
        if marker:
            return (
                _relative_root(current, ports),
                "检测到 " + marker,
            )
        if current == ports.repository:
            break
        parent = ports.dirname(current)
        if parent == current:
            break
        current = parent
    if (
        directory != ports.repository
        and _inside_repository(
            directory, ports.repository, ports.separator)
    ):
        return (
            _relative_root(directory, ports),
            "未找到构建入口，按相关源码所在目录定位",
        )
    return "", "未找到可证明的模块目录"


def execution_roots(files, ports):
    """Resolve ordered module roots and preserve unresolved inputs."""
    roots = []
    seen = set()
    unresolved = []
    for path in files:
        root, reason = _execution_root(path, ports)
        if not root:
            unresolved.append(path)
        elif root not in seen:
            roots.append((root, reason))
            seen.add(root)
    return ExecutionRootPlan(
        roots=tuple(roots),
        unresolved=tuple(unresolved),
    )


def append_task_files(document, title, files):
    document.append(title + ":")
    if files:
        document.extend("- " + path for path in files)
    else:
        document.append("- （无）")


def append_execution_context(
        document, kind, roots, unresolved):
    """Render the historical no-root-fallback execution contract."""
    roots = tuple(roots)
    unresolved = tuple(unresolved)
    label = (
        "修复后编译执行目录"
        if kind == "CODECHECK"
        else "编译/UT执行目录"
    )
    document.append(label + ":")
    for root, reason in roots:
        document.append("- %s（%s）" % (root, reason))
    if unresolved:
        document.append(
            "- 未确定（相关文件: %s）"
            % "、".join(unresolved))
    if not roots:
        document.append("- 未确定")
    if len(roots) > 1:
        document.append(
            "执行目录策略: 涉及多个模块，按上述目录分别定向验证；"
            "禁止退回项目根执行一次全仓构建来代替分模块验证。")
    elif unresolved:
        document.append(
            "执行目录策略: 无法确定模块目录时按 NEEDS_INPUT/FAIL 如实上报；"
            "禁止默认在项目根执行全量构建。")
    else:
        document.append(
            "执行目录策略: 从上述目录执行任务卡配置的编译/UT入口；"
            "不得自行扩大为项目根全量构建。")


def requirement_sources(
        config, exists, absolute, glob_paths, local_sources=()):
    """Resolve exact local requirement and indexed-domain sources."""
    del glob_paths
    sources = [
        absolute(path) for path in local_sources if exists(path)
    ]
    document = config.get("需求文档", "")
    if document and exists(document):
        sources.append(absolute(document))
    return tuple(dict.fromkeys(sources))


def store_task_card(document, directory, filename, ports):
    """Seal and persist one generated task card through adapter ports."""
    target_directory = ports.absolute(directory)
    ports.make_directory(target_directory)
    path = os.path.join(target_directory, filename)
    digest = document.digest()
    body = document.sealed_body()
    ports.write_text(path, body)
    return TaskCardArtifact(
        path=path,
        digest=digest,
        body=body,
    )


def standalone_task_record(
        *,
        step,
        path,
        head,
        scope,
        allowed_files,
        task_files,
        execution_roots,
        initial_source_fingerprints,
        stage,
        at,
):
    """Create the standalone security record from detached task facts."""
    return {
        "step": step,
        "path": path,
        "head": head,
        "scope": scope,
        "allowed_files": list(allowed_files),
        "task_files": list(task_files),
        "execution_roots": list(execution_roots),
        "standalone": True,
        "stage": stage,
        "at": at,
    }
