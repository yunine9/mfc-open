"""Pure source/build path classification shared by Mae-Flow adapters."""

import os
import re


SOURCE_EXTENSIONS = (
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
    ".inl", ".ipp", ".tpp", ".java", ".kt", ".kts", ".groovy",
    ".scala", ".py", ".pyi", ".go", ".rs", ".cs", ".js", ".jsx",
    ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts", ".vue", ".swift",
    ".m", ".mm", ".proto", ".sql", ".s", ".asm", ".cmake", ".gradle",
    ".sln", ".vcxproj", ".props", ".targets", ".sh", ".bash", ".bat",
    ".cmd", ".ps1", ".mk", ".gn", ".gni", ".bzl",
)
SOURCE_FILENAMES = {
    "cmakelists.txt", "makefile", "gnumakefile", "pom.xml",
    "build.gradle", "settings.gradle", "gradle.properties", "package.json",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.toml",
    "cargo.lock", "go.mod", "go.sum", "meson.build", "build.ninja",
    "cmakepresets.json", "cmakeuserpresets.json", "vcpkg.json",
    "conanfile.py", "conanfile.txt", "pyproject.toml", "setup.py",
    "setup.cfg", "tox.ini", "pipfile", "pipfile.lock", "poetry.lock",
    "requirements.txt", "workspace", "workspace.bazel", "module.bazel",
    "build", "build.bazel", "gemfile", "rakefile", "composer.json",
    "composer.lock",
}
BUILD_DESCRIPTOR_EXTENSIONS = (
    ".cmake", ".gradle", ".sln", ".vcxproj", ".props", ".targets",
    ".mk", ".gn", ".gni", ".bzl",
)
BUILD_SCRIPT_EXTENSIONS = (".sh", ".bash", ".bat", ".cmd", ".ps1")
DOCUMENT_EXTENSIONS = (".md", ".rst", ".adoc", ".txt")
# 能被静态分析(复杂度/嵌套/圈复杂度)处理的代码扩展名。与 SOURCE_EXTENSIONS 不同:
# 那份回答"算不算交付源码"(含 .proto/.sql/构建脚本),这份回答"分析器认不认"。
# 曾经在 cli_commands/shared.py 与 lightcheck_source.py 各存一份逐字节相同的
# 副本——两份同义清单迟早各改各的,现在只留这一份。
CODE_EXTENSIONS = (
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
    ".inl", ".ipp", ".tpp", ".java", ".cs",
    ".js", ".jsx", ".cjs", ".mjs",
    ".ts", ".tsx", ".cts", ".mts", ".py", ".pyi",
)

# 依赖目录分两档,区别在于"仓库有没有资格说不"。
#
# 为什么口径必须在这里而不是各处自己过滤:实战里同一个洞开了三个出口——
# 独立任务的范围推导(几千个依赖文件全进任务卡,"node_modules/@fission-ai/
# openspec/dist/cli/index.js"无穷重复,Agent 当场卡死)、检视卡片的未跟踪内嵌、
# 面板的未跟踪清单。前两次都是在撞到的那处加一份本地清单,眼看要出现第三份。
# 判定"这是不是我们的代码"只该有一个口径,就是这里。
#
# 触发条件很常见:仓里没把 node_modules 写进 .gitignore(前端子目录、
# 临时装的工具链),git ls-files --others 就把它们全当"新文件"报出来。

# 第一档:包管理器/IDE/工具自己建的目录,内容是机器生成或下载的,
# 没有人会把手写代码放进去。硬判"不是源码",仓库配置也翻不了案。
TOOL_MANAGED_DIRS = (
    "node_modules/", "bower_components/",
    ".venv/", "venv/", "site-packages/", "__pycache__/", ".tox/",
    ".git/", ".gradle/", ".mvn/", ".idea/", ".vscode/",
    ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".cache/",
    "Pods/", ".next/", ".nuxt/", ".terraform/",
)
# 第二档:通常是产物或外部代码,但仓库确实可能把自己的源码放在这里——
# selftest 就covers 了一个把 `vendor/private/` 配成源码路径的仓,而 Go 的
# vendor/ 又是机器管的;build/ 同理。所以这里不硬判,只判成"未知",
# 交给仓库自己配的 source_patterns 定夺:没配就默认不是(默认安全),
# 配了就仍然算源码(不误杀真源码)。
DERIVED_DIRS = (
    "vendor/", "third_party/",
    "build/", "dist/", "out/", "target/", "coverage/", "obj/",
)


# 编译产物/归档:任何仓库配置下都不是源码。必须按扩展名硬判,因为目录模式会
# 把它们捞进来——flow 默认的源码模式含 `(^|/)lib/`,而 pyenv 的
# `python3.13/lib/xxx.cpython-313.pyc` 正好落在 lib/ 下,于是几十个 .pyc 成了
# "改动源码"。同理仓内构建会留下成千上万的 .o/.class,是同一类洪水。
ARTIFACT_EXTENSIONS = (
    ".pyc", ".pyo", ".pyd", ".class", ".o", ".obj", ".a", ".lib",
    ".so", ".dylib", ".dll", ".exe", ".bin", ".elf", ".pdb", ".ilk",
    ".jar", ".war", ".ear", ".nar", ".whl", ".egg",
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf",
)
# 注意不含 .lock:cargo.lock/yarn.lock/poetry.lock 是构建描述文件,
# SOURCE_FILENAMES 里认它们,硬排会把真正该检视的锁文件变更漏掉。


def is_artifact_path(path):
    """编译产物、归档与二进制资源——永远不是源码,不受仓库配置影响。"""
    return normalize_path(path).strip().strip("\"'").lower().endswith(
        ARTIFACT_EXTENSIONS)


def _under_any_dir(path, directories):
    normalized = "/" + normalize_path(path).strip().strip("\"'").lstrip("/")
    return any(("/" + item) in normalized for item in directories)


def is_tool_managed_path(path):
    """包管理器/IDE/工具自建目录下的文件——任何仓库都不是自己的源码。"""
    return _under_any_dir(path, TOOL_MANAGED_DIRS)


def is_derived_path(path):
    """产物/外部代码目录下的文件——默认不是源码,但允许仓库配置拉回来。"""
    return _under_any_dir(path, DERIVED_DIRS)


def tool_managed_exclude_pathspecs():
    """给 git 命令用的排除串,只排第一档(工具自管目录)。

    刻意不含第二档:搜索类命令(git grep 找符号引用)漏掉一处真引用的代价是
    "编译全绿功能坏",而 build/ vendor/ 里确实可能有仓库自己的代码。宁可多列,
    不可漏列——这跟"判定源码"的取舍方向相反,所以单独给一个函数。
    """
    return tuple(":(exclude)%s" % item.rstrip("/")
                 for item in TOOL_MANAGED_DIRS)


def normalize_path(path):
    return (path or "").replace("\\", "/")


def existing_file_from_code_location(path):
    """Collapse ``file:line``/``file::symbol`` references to the file."""
    candidates = []
    for marker in ("#L", "#l", "::"):
        if marker in path:
            candidates.append(path.split(marker, 1)[0])
    line = re.match(r"^(.*?):\d+(?::\d+)?(?:[-–]\d+)?$", path)
    if line:
        candidates.append(line.group(1))
    return next(
        (item for item in candidates
         if item and os.path.isfile(os.path.realpath(item))),
        path,
    )


def repository_path_identity(path, case_insensitive=None):
    """Return one identity for repository-relative path comparisons."""
    normalized = re.sub(
        r"^(?:\./)+",
        "",
        normalize_path(path).strip().strip("\"'"),
    )
    if case_insensitive is None:
        case_insensitive = os.name == "nt"
    return normalized.casefold() if case_insensitive else normalized


def is_flow_control_path(path):
    """Return whether a path is Mae-Flow process state, never delivery input."""
    normalized = repository_path_identity(
        path, case_insensitive=False)
    return (
        normalized == ".mae-flow.json"
        or normalized.startswith(".mae-flow.json.")
        or normalized == ".mae-flow-history.jsonl"
        or normalized == ".mae-flow-need-reload"
        or normalized == ".mae-flow"
        or normalized.startswith(".mae-flow/")
        or normalized == ".mae-flow-work"
        or normalized.startswith(".mae-flow-work/")
        or normalized.startswith(".codecheckcli/")
    )


def is_absolute_path(path):
    normalized = normalize_path(path)
    return normalized.startswith("/") or bool(
        re.match(r"^[A-Za-z]:/", normalized))


def repo_relative_for_match(path, project_root):
    """Return a normalized root-relative path without cross-drive relpath."""
    normalized = normalize_path(path).strip().strip("\"'")
    if not normalized:
        return normalized
    if not is_absolute_path(normalized):
        return re.sub(r"^(?:\./)+", "", normalized)

    root = normalize_path(project_root).rstrip("/")
    roots = []
    for candidate in (root, _native_realpath(root)):
        if (candidate
                and candidate.lower() not in {
                    item.lower() for item in roots}):
            roots.append(candidate)
    candidates = [normalized]
    real = _native_realpath(normalized)
    if real and real.lower() != normalized.lower():
        candidates.append(real)
    for candidate in candidates:
        lowered = candidate.lower()
        for item in roots:
            root_lowered = item.lower()
            if lowered == root_lowered:
                return ""
            if lowered.startswith(root_lowered + "/"):
                return candidate[len(item) + 1:]
    return None


def _native_realpath(path):
    if not os.path.isabs(path):
        return ""
    try:
        return normalize_path(os.path.realpath(path)).rstrip("/")
    except OSError:
        return ""


def matches_pattern(path, pattern):
    try:
        return bool(re.search(pattern, path, re.I))
    except re.error:
        return False


def is_build_path(path):
    normalized = normalize_path(path).strip().strip("\"'").lower()
    base = normalized.rsplit("/", 1)[-1]
    return bool(
        base in SOURCE_FILENAMES
        or (base.startswith("requirements") and base.endswith(".txt"))
        or normalized.endswith(
            BUILD_DESCRIPTOR_EXTENSIONS + BUILD_SCRIPT_EXTENSIONS)
    )


def known_source_classification(
        path, project_root=None, require_membership=False):
    """Return True/False for known cases and None for pattern candidates."""
    normalized = normalize_path(path).strip().strip("\"'")
    if normalized.endswith("(未提交)"):
        normalized = normalized[:-len("(未提交)")]
    relative = (
        repo_relative_for_match(normalized, project_root)
        if project_root is not None
        else re.sub(r"^(?:\./)+", "", normalized)
    )
    if (require_membership and is_absolute_path(normalized)
            and relative is None):
        return False
    # 流程自己的过程文件永远不是交付源码。必须抢在扩展名判定之前:
    # .mae-flow-work/panel-stamp.js 以 .js 结尾、bin/mae-flow.py 以 .py 结尾,
    # 光看后缀就都成了"业务源码"。实测后果:面板每次推进写一次 panel-stamp.js,
    # 流程随即认定"源码变了必须重编译",把交付拐进重编译回环——而面板的铁律
    # 恰恰是永不影响推进。
    if is_flow_control_path(relative if relative is not None else normalized):
        return False
    # 依赖目录同样要抢在扩展名判定之前:node_modules 里全是 .js,
    # 光看后缀就都成了"业务源码"。
    checked = relative if relative is not None else normalized
    if is_tool_managed_path(checked) or is_artifact_path(checked):
        return False
    if is_derived_path(checked):
        return None            # 交给仓库配置的 source_patterns 定夺
    lowered = normalized.lower()
    if is_build_path(normalized) or lowered.endswith(SOURCE_EXTENSIONS):
        return True
    if lowered.endswith(DOCUMENT_EXTENSIONS):
        return False
    if relative is None:
        return False
    return None


def is_source_path(
        path, patterns, project_root=None, require_membership=False):
    known = known_source_classification(
        path,
        project_root=project_root,
        require_membership=require_membership,
    )
    if known is not None:
        return known
    normalized = normalize_path(path).strip().strip("\"'")
    if normalized.endswith("(未提交)"):
        normalized = normalized[:-len("(未提交)")]
    relative = (
        repo_relative_for_match(normalized, project_root)
        if project_root is not None
        else re.sub(r"^(?:\./)+", "", normalized)
    )
    return any(
        matches_pattern(relative, pattern)
        for pattern in patterns
    )
