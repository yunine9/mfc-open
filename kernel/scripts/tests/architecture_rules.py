"""Static architecture checks for Mae-Flow refactoring."""

import ast
import os
import re
from pathlib import Path


FORBIDDEN_IMPORT_PREFIXES = (
    "mae_flow_core.workflow",
    "mae_flow_core.delivery",
    "mae_flow_core.quality",
    "mae_flow_core.guard",
)
FORBIDDEN_CALLS = {
    "print",
    "sys.exit",
    "os.chdir",
    "subprocess.run",
    "subprocess.Popen",
    "subprocess.call",
}
LEGACY_OVERSIZED_CORE_MODULES = set()
RUNTIME_ENTRYPOINTS = (
    "scripts/mae-flow.py",
    "hooks/dispatch.py",
    "scripts/comet_compat.py",
    "scripts/statusline.py",
)


def line_count(path):
    with open(path, encoding="utf-8") as stream:
        return sum(1 for _line in stream)


def _parse(path):
    with open(path, encoding="utf-8") as stream:
        return ast.parse(stream.read(), filename=path)


def module_imports(path):
    return {
        name for name, _line in _import_nodes(_parse(path))
    }


def unmanaged_runtime_open_violations(root):
    root_path = Path(root)
    violations = []
    for relative in RUNTIME_ENTRYPOINTS:
        path = root_path / relative
        tree = _parse(os.fspath(path))
        managed_calls = {
            call
            for node in ast.walk(tree)
            if isinstance(node, (ast.With, ast.AsyncWith))
            for item in node.items
            for call in ast.walk(item.context_expr)
            if isinstance(call, ast.Call)
        }
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "open"
                and node not in managed_calls
            ):
                violations.append(
                    "%s:%d: unmanaged open()" % (relative, node.lineno)
                )
    return sorted(violations)


def _attribute_name(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def forbidden_calls(path):
    tree = _parse(path)
    aliases = _import_aliases(tree)
    calls = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _resolved_call_name(node.func, aliases)
        if name in FORBIDDEN_CALLS:
            calls.append("%s:%d" % (name, node.lineno))
    return calls


def _relative_module(node):
    package = ["mae_flow_core", "foundation"]
    keep = max(0, len(package) - max(0, node.level - 1))
    parts = package[:keep]
    if node.module:
        parts.extend(node.module.split("."))
    return ".".join(parts)


def _import_nodes(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, node.lineno
        elif isinstance(node, ast.ImportFrom):
            module = (
                _relative_module(node)
                if node.level else node.module or "")
            if module:
                yield module, node.lineno
            if not module.startswith(FORBIDDEN_IMPORT_PREFIXES):
                for alias in node.names:
                    if alias.name != "*":
                        yield ".".join(
                            part for part in (module, alias.name) if part
                        ), node.lineno


def _import_aliases(tree):
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name.split(".", 1)[0]
                aliases[local] = (
                    alias.name if alias.asname else local)
        elif isinstance(node, ast.ImportFrom):
            module = (
                _relative_module(node)
                if node.level else node.module or "")
            for alias in node.names:
                if alias.name == "*":
                    continue
                local = alias.asname or alias.name
                aliases[local] = ".".join(
                    part for part in (module, alias.name) if part)
    return aliases


def _resolved_call_name(function, aliases):
    raw = (
        function.id
        if isinstance(function, ast.Name)
        else _attribute_name(function)
    )
    head, separator, tail = raw.partition(".")
    resolved = aliases.get(head, head)
    return resolved + (separator + tail if separator else "")


def assert_foundation_dependencies(root):
    root_path = Path(root)
    foundation = root_path / "scripts" / "mae_flow_core" / "foundation"
    violations = []
    if not foundation.exists():
        return violations
    for path in sorted(foundation.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        tree = _parse(os.fspath(path))
        aliases = _import_aliases(tree)
        for name, line in _import_nodes(tree):
            if name.startswith(FORBIDDEN_IMPORT_PREFIXES):
                violations.append(
                    "%s:%d: forbidden import %s" % (
                        relative, line, name))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _resolved_call_name(node.func, aliases)
            if name in FORBIDDEN_CALLS:
                violations.append(
                    "%s:%d: forbidden call %s" % (
                        relative, node.lineno, name))
    return sorted(violations)


def assert_policy_dependencies(root):
    root_path = Path(root)
    workflow = root_path / "scripts" / "mae_flow_core" / "workflow"
    violations = []
    if not workflow.exists():
        return violations
    for path in sorted(workflow.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        tree = _parse(os.fspath(path))
        aliases = _import_aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _resolved_call_name(node.func, aliases)
            if name in FORBIDDEN_CALLS:
                violations.append(
                    "%s:%d: forbidden call %s"
                    % (relative, node.lineno, name)
                )
    return sorted(violations)


def assert_guard_dependencies(root):
    root_path = Path(root)
    guard = root_path / "scripts" / "mae_flow_core" / "guard"
    violations = []
    if not guard.exists():
        return violations
    for path in sorted(guard.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        tree = _parse(os.fspath(path))
        aliases = _import_aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _resolved_call_name(node.func, aliases)
            if name in FORBIDDEN_CALLS:
                violations.append(
                    "%s:%d: forbidden call %s"
                    % (relative, node.lineno, name)
                )
    return sorted(violations)


def assert_quality_dependencies(root):
    root_path = Path(root)
    violations = []
    directories = (
        root_path / "scripts" / "mae_flow_core" / "quality",
        root_path / "scripts" / "mae_flow_core" / "application" / "quality",
    )
    for quality in directories:
        if not quality.exists():
            continue
        for path in sorted(quality.rglob("*.py")):
            relative = path.relative_to(root_path).as_posix()
            tree = _parse(os.fspath(path))
            aliases = _import_aliases(tree)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                name = _resolved_call_name(node.func, aliases)
                if name in FORBIDDEN_CALLS:
                    violations.append(
                        "%s:%d: forbidden call %s"
                        % (relative, node.lineno, name)
                    )
    return sorted(violations)


def _quality_directories(root_path):
    return (
        root_path / "scripts" / "mae_flow_core" / "quality",
        root_path / "scripts" / "mae_flow_core" / "application" / "quality",
    )


def assert_delivery_dependencies(root):
    root_path = Path(root)
    violations = []
    directories = (
        root_path / "scripts" / "mae_flow_core" / "delivery",
        root_path / "scripts" / "mae_flow_core" / "application" / "delivery",
    )
    for delivery in directories:
        if not delivery.exists():
            continue
        for path in sorted(delivery.rglob("*.py")):
            relative = path.relative_to(root_path).as_posix()
            tree = _parse(os.fspath(path))
            aliases = _import_aliases(tree)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                name = _resolved_call_name(node.func, aliases)
                if name in FORBIDDEN_CALLS:
                    violations.append(
                        "%s:%d: forbidden call %s"
                        % (relative, node.lineno, name)
                    )
    return sorted(violations)


def assert_hook_application_dependencies(root):
    """Hook application use cases sequence effects but never perform them."""
    root_path = Path(root)
    hooks = (
        root_path / "scripts" / "mae_flow_core" / "application" / "hooks")
    violations = []
    if not hooks.exists():
        return violations
    for path in sorted(hooks.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        tree = _parse(os.fspath(path))
        aliases = _import_aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _resolved_call_name(node.func, aliases)
            if name in FORBIDDEN_CALLS:
                violations.append(
                    "%s:%d: forbidden call %s"
                    % (relative, node.lineno, name)
                )
    return sorted(violations)


def private_hook_import_violations(root):
    """Find business tests that dynamically load the Hook entrypoint."""
    root_path = Path(root)
    tests = root_path / "scripts" / "tests"
    allowed = {"test_hook_protocol.py"}
    violations = []
    for path in sorted(tests.glob("test_*.py")):
        if path.name in allowed:
            continue
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=os.fspath(path))
        aliases = _import_aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _resolved_call_name(node.func, aliases)
            if name not in {
                    "importlib.util.spec_from_file_location",
                    "runpy.run_path"}:
                continue
            fragment = ast.get_source_segment(source, node) or ""
            if "dispatch.py" in fragment:
                violations.append(
                    "%s:%d: private Hook entrypoint import"
                    % (path.relative_to(root_path).as_posix(), node.lineno)
                )
    return sorted(violations)


def private_cli_import_violations(root):
    """Find business tests that dynamically load the CLI entrypoint."""
    root_path = Path(root)
    tests = root_path / "scripts" / "tests"
    violations = []
    for path in sorted(tests.glob("test_*.py")):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=os.fspath(path))
        aliases = _import_aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _resolved_call_name(node.func, aliases)
            if name not in {
                    "importlib.util.spec_from_file_location",
                    "runpy.run_path"}:
                continue
            fragment = ast.get_source_segment(source, node) or ""
            if "mae-flow.py" in fragment:
                violations.append(
                    "%s:%d: private CLI entrypoint import"
                    % (path.relative_to(root_path).as_posix(), node.lineno)
                )
    return sorted(violations)


def new_module_size_violations(root, maximum=500):
    root_path = Path(root)
    core = root_path / "scripts" / "mae_flow_core"
    violations = []
    if not core.exists():
        return violations
    for path in sorted(core.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        if (
            path.name == "__init__.py"
            or relative in LEGACY_OVERSIZED_CORE_MODULES
        ):
            continue
        count = line_count(os.fspath(path))
        if count > maximum:
            violations.append(
                "%s: %d lines exceeds %d"
                % (relative, count, maximum)
            )
    return violations


class _ComplexityVisitor(ast.NodeVisitor):
    def __init__(self):
        self.value = 1

    def visit_If(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_For(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_AsyncFor(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_While(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_IfExp(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        self.value += max(0, len(node.values) - 1)
        self.generic_visit(node)

    def visit_comprehension(self, node):
        self.value += 1 + len(node.ifs)
        self.visit(node.target)
        self.visit(node.iter)
        for condition in node.ifs:
            self.visit(condition)

    def visit_FunctionDef(self, node):
        return

    def visit_AsyncFunctionDef(self, node):
        return

    def visit_Lambda(self, node):
        return

    def visit_ClassDef(self, node):
        return


def _node_complexity(node):
    visitor = _ComplexityVisitor()
    for statement in node.body:
        visitor.visit(statement)
    return visitor.value


def function_complexity(path, function_name):
    tree = _parse(path)
    for node in ast.walk(tree):
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == function_name
        ):
            return _node_complexity(node)
    raise ValueError(
        "function %s not found in %s" % (function_name, path)
    )


def workflow_complexity_violations(root, maximum=15):
    root_path = Path(root)
    workflow = root_path / "scripts" / "mae_flow_core" / "workflow"
    violations = []
    if not workflow.exists():
        return violations
    for path in sorted(workflow.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        tree = _parse(os.fspath(path))
        functions = [
            node
            for node in ast.walk(tree)
            if isinstance(
                node,
                (ast.FunctionDef, ast.AsyncFunctionDef),
            )
        ]
        for node in sorted(functions, key=lambda item: item.lineno):
            complexity = _node_complexity(node)
            if complexity > maximum:
                violations.append(
                    "%s:%d: %s complexity %d exceeds %d"
                    % (
                        relative,
                        node.lineno,
                        node.name,
                        complexity,
                        maximum,
                    )
                )
    return violations


def guard_complexity_violations(root, maximum=15):
    root_path = Path(root)
    guard = root_path / "scripts" / "mae_flow_core" / "guard"
    violations = []
    if not guard.exists():
        return violations
    for path in sorted(guard.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        for node in ast.walk(_parse(os.fspath(path))):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            complexity = _node_complexity(node)
            if complexity > maximum:
                violations.append(
                    "%s:%d: %s complexity %d exceeds %d"
                    % (relative, node.lineno, node.name, complexity, maximum)
                )
    return violations


def quality_complexity_violations(root, maximum=15):
    root_path = Path(root)
    violations = []
    for quality in _quality_directories(root_path):
        if not quality.exists():
            continue
        for path in sorted(quality.rglob("*.py")):
            relative = path.relative_to(root_path).as_posix()
            for node in ast.walk(_parse(os.fspath(path))):
                if not isinstance(
                        node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                complexity = _node_complexity(node)
                if complexity > maximum:
                    violations.append(
                        "%s:%d: %s complexity %d exceeds %d"
                        % (
                            relative, node.lineno, node.name,
                            complexity, maximum,
                        )
                    )
    return violations


def delivery_complexity_violations(root, maximum=15):
    root_path = Path(root)
    violations = []
    directories = (
        root_path / "scripts" / "mae_flow_core" / "delivery",
        root_path / "scripts" / "mae_flow_core" / "application" / "delivery",
    )
    for delivery in directories:
        if not delivery.exists():
            continue
        for path in sorted(delivery.rglob("*.py")):
            relative = path.relative_to(root_path).as_posix()
            for node in ast.walk(_parse(os.fspath(path))):
                if not isinstance(
                        node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                complexity = _node_complexity(node)
                if complexity > maximum:
                    violations.append(
                        "%s:%d: %s complexity %d exceeds %d"
                        % (
                            relative, node.lineno, node.name,
                            complexity, maximum,
                        )
                    )
    return violations


def hook_complexity_violations(root, maximum=15):
    root_path = Path(root)
    hooks = (
        root_path / "scripts" / "mae_flow_core" / "application" / "hooks")
    violations = []
    if not hooks.exists():
        return violations
    for path in sorted(hooks.rglob("*.py")):
        relative = path.relative_to(root_path).as_posix()
        for node in ast.walk(_parse(os.fspath(path))):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            complexity = _node_complexity(node)
            if complexity > maximum:
                violations.append(
                    "%s:%d: %s complexity %d exceeds %d"
                    % (relative, node.lineno, node.name, complexity, maximum)
                )
    return violations


def _relative_import_module(node, package):
    """Resolve ``from . import x`` / ``from ..y import z`` to a module name."""
    parts = package.split(".")
    base = ".".join(parts[:len(parts) - (node.level - 1)])
    return (base + "." + node.module) if node.module else base


def _imported_core_modules(path, package, root_path):
    """Collect ``mae_flow_core`` modules a single file statically imports."""
    imported = set()
    for node in ast.walk(_parse(path)):
        if isinstance(node, ast.Import):
            imported.update(
                alias.name for alias in node.names
                if alias.name.startswith("mae_flow_core"))
            continue
        if not isinstance(node, ast.ImportFrom):
            continue
        module = (
            _relative_import_module(node, package)
            if node.level else (node.module or ""))
        if not module.startswith("mae_flow_core"):
            continue
        imported.add(module)
        # ``from pkg.mod import name`` may import a submodule, not an object.
        imported.update(module + "." + alias.name for alias in node.names)
    return {
        module for module in imported
        if _module_file(module, root_path) is not None
    }


def _module_file(module, root_path):
    base = root_path / "scripts" / Path(*module.split("."))
    if (base / "__init__.py").is_file():
        return base / "__init__.py"
    candidate = base.with_suffix(".py")
    return candidate if candidate.is_file() else None


def unreachable_core_modules(root):
    """Return production modules no runtime entrypoint can ever import.

    Dead runtime code is a live hazard here rather than mere clutter: a
    maintainer chasing a Hook defect can spend a session "fixing" an adapter
    the dispatcher never loads, with the whole suite staying green.
    """
    root_path = Path(root)
    queue = []
    for relative in RUNTIME_ENTRYPOINTS:
        path = root_path / relative
        if path.is_file():
            queue.extend(
                _imported_core_modules(
                    os.fspath(path), "mae_flow_core", root_path))
    reached = set()
    while queue:
        module = queue.pop()
        if module in reached:
            continue
        path = _module_file(module, root_path)
        if path is None:
            continue
        reached.add(module)
        package = (
            module if path.name == "__init__.py"
            else module.rsplit(".", 1)[0])
        queue.extend(
            _imported_core_modules(os.fspath(path), package, root_path))
    # Importing a submodule executes every ancestor ``__init__.py``, so those
    # packages are reached even without a statement naming them.
    for module in tuple(reached):
        parts = module.split(".")
        for depth in range(1, len(parts)):
            reached.add(".".join(parts[:depth]))
    package_root = root_path / "scripts" / "mae_flow_core"
    everything = set()
    for path in sorted(package_root.rglob("*.py")):
        relative = path.relative_to(root_path / "scripts").as_posix()
        module = relative[:-len(".py")].replace("/", ".")
        everything.add(
            module[:-len(".__init__")] if module.endswith(".__init__")
            else module)
    return sorted(everything - reached)


_GATE_RULE_SHAPE = re.compile(r"^(?:bash|edit|absolute)-[a-z0-9-]{3,}$")
_GATE_RULE_FILES = (
    "scripts/mae_flow_core/guard",
    "scripts/mae_flow_core/cli_commands/gate.py",
)
# 产出一次 Gate 裁决的每种写法。绝对类不会被追加放行令出口，裁决类会。
_GATE_PRODUCERS = {
    "_absolute": "absolute",
    "_die_rule": "absolute",
    "_block": "permit",
    "jdie": "permit",
    "_advisory": "advisory",
}
_GATE_DECISION_KINDS = {
    "absolute": "absolute", "block": "permit", "advisory": "advisory"}


def _gate_rule_paths(root):
    root_path = Path(root)
    for relative in _GATE_RULE_FILES:
        target = root_path / relative
        if target.is_dir():
            for path in sorted(target.rglob("*.py")):
                yield path
        elif target.is_file():
            yield target


_GATE_KIND_WORDS = {"absolute", "block", "advisory", "allow"}


def _call_literals(node, skip=""):
    return "".join(
        child.value for child in ast.walk(node)
        if isinstance(child, ast.Constant)
        and isinstance(child.value, str)
        and child.value != skip
        and child.value not in _GATE_KIND_WORDS
    )


def _gate_rule_from_call(node):
    name = getattr(node.func, "id", "") or getattr(node.func, "attr", "")
    if name in _GATE_PRODUCERS:
        # 规则名可能在第一个位置参数(_block/_die_rule),也可能在 rule=
        # 关键字里(_absolute 的签名是 message 在前)。只认位置参数时,
        # 后一种写法整类隐形——guard/gate.py 里一批绝对类规则因此从来
        # 没进过总账,"无残留/无死锁"的保证在它们身上是空的。
        keywords = {item.arg: item.value for item in node.keywords}
        if isinstance(keywords.get("rule"), ast.Constant):
            return _GATE_PRODUCERS[name], keywords["rule"].value
        rule = (
            node.args[0].value
            if node.args and isinstance(node.args[0], ast.Constant)
            else None)
        return _GATE_PRODUCERS[name], rule
    if name != "GateDecision":
        return None, None
    keywords = {item.arg: item.value for item in node.keywords}
    first = (
        node.args[0].value
        if node.args and isinstance(node.args[0], ast.Constant) else None)
    rule = None
    if isinstance(keywords.get("rule"), ast.Constant):
        rule = keywords["rule"].value
    elif len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
        rule = node.args[1].value
    return _GATE_DECISION_KINDS.get(first), rule


def _absolute_escalated_rules(root):
    """gate.py 把部分 block 类规则升级为绝对类:不签放行令、只给本地恢复做法。

    不认这个升级，总账就会声称它们有放行令出口，而无死锁红线也就在验一个不存在
    的出口——这两条恰好是提交产物那一类最常撞上的规则。
    """
    path = Path(root) / "scripts" / "mae_flow_core" / "cli_commands" / "gate.py"
    if not path.is_file():
        return frozenset()
    rules = set()
    for node in ast.walk(_parse(os.fspath(path))):
        if not (isinstance(node, ast.FunctionDef)
                and node.name == "_enforce_commit_ownership"):
            continue
        for inner in ast.walk(node):
            if not (isinstance(inner, ast.Compare)
                    and any(isinstance(op, ast.In) for op in inner.ops)):
                continue
            for comparator in inner.comparators:
                if isinstance(comparator, (ast.Set, ast.List, ast.Tuple)):
                    rules.update(
                        item.value for item in comparator.elts
                        if isinstance(item, ast.Constant)
                        and isinstance(item.value, str))
    return frozenset(rules)


def gate_rule_inventory(root):
    """Return {rule: {"kind", "message"}} for every production Gate rule.

    The inventory is the anchor for both redlines the slimming needs: nothing
    may be deleted while a reference survives (no residue), and every rule that
    blocks must offer a way forward (no deadlock).
    """
    inventory = {}
    for path in _gate_rule_paths(root):
        tree = _parse(os.fspath(path))
        # 文案常在局部变量里拼好再传进去,调用节点自身看不到。字面量过薄时回退到
        # 所属函数的字面量,否则"绝对类必须自带出路"这条会对着空字符串做断言。
        enclosing = {}
        for function in ast.walk(tree):
            if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for inner in ast.walk(function):
                if isinstance(inner, ast.Call):
                    enclosing.setdefault(id(inner), function)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            kind, rule = _gate_rule_from_call(node)
            if not kind or not isinstance(rule, str):
                continue
            if not _GATE_RULE_SHAPE.match(rule):
                continue
            message = _call_literals(node, skip=rule)
            if len(message) < 20 and id(node) in enclosing:
                message = _call_literals(enclosing[id(node)], skip=rule)
            previous = inventory.get(rule)
            if previous is None or len(message) > len(previous["message"]):
                inventory[rule] = {"kind": kind, "message": message}
            elif previous["kind"] != kind:
                previous["kind"] = "absolute"
    for rule in _absolute_escalated_rules(root):
        if rule in inventory:
            inventory[rule]["kind"] = "absolute"
    return inventory


_TOKEN_WRITER = "_record_agent_token"
_TOKEN_LITERAL_READER = re.compile(
    r"(?:_agent_token_data\(\)|tokens\(\)|askuser_tokens\(\))\s*"
    r"\.get\(\s*\"([A-Z][A-Z_]*)\"")
_PRODUCTION_TREES = ("scripts/mae_flow_core", "hooks")


def _production_files(root):
    root_path = Path(root)
    for relative in _PRODUCTION_TREES:
        base = root_path / relative
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.py")):
            yield path


def hook_token_writers(root):
    """The token kinds production actually issues."""
    written = set()
    for path in _production_files(root):
        tree = _parse(os.fspath(path))
        for node in ast.walk(tree):
            if (
                    isinstance(node, ast.Call)
                    and (getattr(node.func, "id", "")
                         or getattr(node.func, "attr", "")) == _TOKEN_WRITER
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)):
                written.add(node.args[0].value)
    return sorted(written)


def hook_token_evidence_violations(root):
    """Token kinds still read by name while nothing issues them any more.

    This is the exact shape of the defects this project keeps hitting: a
    retired evidence source loses its writer while a gate keeps reading it, so
    a condition that can never become true blocks the flow forever.
    """
    root_path = Path(root)
    written = set(hook_token_writers(root))
    read = {}
    for path in _production_files(root):
        relative = path.relative_to(root_path).as_posix()
        with open(path, encoding="utf-8") as stream:
            source = stream.read()
        for match in _TOKEN_LITERAL_READER.finditer(source):
            read.setdefault(match.group(1), relative)
    return sorted(
        "%s: 读取了没有任何写入方的令牌 %s" % (location, kind)
        for kind, location in read.items()
        if kind not in written
    )


_GATE_CONTEXT_MODULE = "scripts/mae_flow_core/guard/gate.py"


def dead_gate_context_fields(root):
    """Gate context fields carried into a decision that no decision reads.

    The inverse of ``hook_token_evidence_violations``: not a reader without a
    writer, but a *writer without a reader*. ``allow_source_edit`` once became
    such a field: current rendered a scope that the active Hook never enforced.
    A field the caller computes and passes for nobody is either a retired rule's
    residue or an unenforced promise; both are lies about what the gate does.
    """
    root_path = Path(root)
    module = root_path / _GATE_CONTEXT_MODULE
    if not module.exists():
        return []
    declared = {}
    for node in _parse(os.fspath(module)).body:
        if not isinstance(node, ast.ClassDef) or node.name == "GateDecision":
            continue
        for item in node.body:
            if isinstance(item, ast.AnnAssign) and isinstance(
                    item.target, ast.Name):
                declared.setdefault(item.target.id, node.name)
    if not declared:
        return []
    read = set()
    for path in _production_files(root):
        for node in ast.walk(_parse(os.fspath(path))):
            if isinstance(node, ast.Attribute):
                read.add(node.attr)
    return sorted(
        "%s.%s" % (declared[field], field)
        for field in declared if field not in read)
