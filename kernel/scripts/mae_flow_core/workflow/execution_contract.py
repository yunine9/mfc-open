"""Task-scoped execution capabilities shared by local and remote hosts.

The workflow definition contains the superset of configuration needed by the
local CLI.  A remote host may deliberately delegate some executions to an
authoritative pipeline, so consumers must derive their effective inputs from
one persisted contract instead of repeatedly consulting a process-global
environment switch.
"""


SCHEMA = "mae-flow-execution/1"
_EXECUTORS = frozenset(("local", "pipeline"))
_PUSH_EXECUTORS = frozenset(("local", "host"))
_HOSTS = frozenset(("local", "cloud"))


def _default_contract(host):
    cloud = str(host or "").strip().lower() == "cloud"
    executor = "pipeline" if cloud else "local"
    return {
        "schema": SCHEMA,
        "host": "cloud" if cloud else "local",
        "compile": executor,
        "ut_write": "agent",
        "ut_run": executor,
        "codecheck": executor,
        "git_push": "host" if cloud else "local",
        # Continuous review is deliberately opt-in. In particular, the
        # legacy Cloud fallback retains terminal-after-push semantics.
        "continuous_review": False,
        "source": "legacy-cloud" if cloud else "local-default",
    }


def _explicit_executor(raw, key):
    value = str(raw.get(key) or "").strip().lower()
    if value not in _EXECUTORS:
        raise ValueError(
            "execution_contract.%s 只能是 local/pipeline" % key)
    return value


def _explicit_host(raw, fallback, executors):
    value = str(raw.get("host") or fallback or "").strip().lower()
    if not value:
        value = "cloud" if "pipeline" in executors else "local"
    if value not in _HOSTS:
        raise ValueError("execution_contract.host 只能是 local/cloud")
    return value


def _normalize_authority(authority):
    if authority is None:
        return None
    if not isinstance(authority, dict):
        raise ValueError("execution_contract.host_authority 必须是 JSON object")
    required = {"schema": "mae-flow-host-authority/1", "alg": "RS256"}
    for key, expected in required.items():
        if str(authority.get(key) or "") != expected:
            raise ValueError("host_authority.%s 必须是 %s" % (key, expected))
    result = dict(required)
    for key, limit in (("key_id", 128), ("task_id", 200),
                       ("n", 2048), ("e", 32)):
        value = str(authority.get(key) or "").strip()
        if not value or len(value) > limit:
            raise ValueError("host_authority.%s 缺失或过长" % key)
        result[key] = value
    return result


def _normalize_explicit(raw, host):
    if not isinstance(raw, dict):
        raise ValueError("execution_contract 必须是 JSON object")
    schema = str(raw.get("schema") or "")
    if schema != SCHEMA:
        raise ValueError(
            "execution_contract.schema 必须是 %s，收到 %s"
            % (SCHEMA, schema or "空"))
    compile_executor = _explicit_executor(raw, "compile")
    ut_run_executor = _explicit_executor(raw, "ut_run")
    codecheck_executor = _explicit_executor(raw, "codecheck")
    ut_write = str(raw.get("ut_write") or "").strip().lower()
    if ut_write != "agent":
        raise ValueError("execution_contract.ut_write 当前只能是 agent")
    resolved_host = _explicit_host(
        raw, host, (compile_executor, ut_run_executor, codecheck_executor))
    push_executor = str(raw.get("git_push") or (
        "host" if resolved_host == "cloud" else "local")).strip().lower()
    if push_executor not in _PUSH_EXECUTORS:
        raise ValueError("execution_contract.git_push 只能是 local/host")
    continuous_review = raw.get("continuous_review", False)
    if not isinstance(continuous_review, bool):
        raise ValueError("execution_contract.continuous_review 必须是 boolean")
    if continuous_review and resolved_host != "cloud":
        raise ValueError("continuous_review 只能由 Cloud 执行契约启用")
    normalized_authority = _normalize_authority(raw.get("host_authority"))
    result = {
        "schema": SCHEMA,
        "host": resolved_host,
        "compile": compile_executor,
        "ut_write": ut_write,
        "ut_run": ut_run_executor,
        "codecheck": codecheck_executor,
        "git_push": push_executor,
        "continuous_review": continuous_review,
        "source": "order",
    }
    if normalized_authority is not None:
        result["host_authority"] = normalized_authority
    return result


def resolve_execution_contract(order_facts=None, host=""):
    """Resolve one immutable contract: explicit order, legacy Cloud, local."""
    facts = order_facts if isinstance(order_facts, dict) else {}
    if "execution_contract" in facts:
        return _normalize_explicit(facts.get("execution_contract"), host)
    return _default_contract(host)


def contract_for_state(state=None, host=""):
    """Read a persisted contract, with a safe fallback for in-flight states."""
    document = state if isinstance(state, dict) else {}
    raw = document.get("execution_contract")
    if raw is None:
        return _default_contract(host)
    normalized = _normalize_explicit(raw, raw.get("host") or host)
    # A persisted document records how it was resolved; order-only input does
    # not supply or control this audit field.
    source = str(raw.get("source") or "persisted")
    normalized["source"] = source
    return normalized


def effective_config_keys(step, state=None, host=""):
    """Return the configuration fields meaningful to this execution contract."""
    keys = tuple((step or {}).get("require_sets", ()) or ())
    contract = contract_for_state(state, host)
    hidden = set()
    if contract["compile"] == "pipeline":
        hidden.add("编译方式")
    if contract["ut_run"] == "pipeline":
        hidden.add("UT运行命令")
    return tuple(key for key in keys if key not in hidden)


def validation_environment(state=None, host=""):
    """Human-readable, read-only execution fact for confirmation surfaces."""
    contract = contract_for_state(state, host)
    values = tuple(contract[key] for key in ("compile", "ut_run", "codecheck"))
    if values == ("pipeline", "pipeline", "pipeline"):
        return "权威流水线（编译、UT 执行、CodeCheck）"
    if values == ("local", "local", "local"):
        return "本地环境（编译、UT 执行、CodeCheck）"
    labels = {
        "compile": "编译",
        "ut_run": "UT 执行",
        "codecheck": "CodeCheck",
    }
    return "；".join(
        "%s=%s" % (
            labels[key], "权威流水线" if contract[key] == "pipeline" else "本地")
        for key in ("compile", "ut_run", "codecheck")
    )


def uses_pipeline(state=None, host=""):
    contract = contract_for_state(state, host)
    return any(
        contract[key] == "pipeline"
        for key in ("compile", "ut_run", "codecheck")
    )


def continuous_review_enabled(state=None, host=""):
    """Whether this task opted into the Cloud-owned delivery lifecycle."""
    return bool(contract_for_state(state, host).get("continuous_review"))
