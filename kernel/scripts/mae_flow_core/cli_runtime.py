"""Public composition root for Mae-Flow CLI commands."""

import os
import sys
import types
from .adapters.project_launcher import install_launcher_when_active
from .cli_commands import shared
from .cli_commands import symbol_refs as _symbol_refs
from .cli_commands import panel as _panel
from .cli_commands import codespec_engine as _codespec_engine
from .cli_commands.shared import *  # noqa: F401,F403
from .cli_commands.wiring import api
from .cli_commands import git_authorization as _git_authorization
from .cli_commands import git_ownership as _git_ownership
from .cli_commands import state_config as _state_config
from .cli_commands import source_facts as _source_facts
from .cli_commands import lightcheck as _lightcheck
from .cli_commands import codecheck_facts as _codecheck_facts
from .cli_commands import ack as _ack
from .cli_commands import ack_confirmation as _ack_confirmation
from .cli_commands import current as _current
from .cli_commands import execution_plan as _execution_plan
from .cli_commands import user_intervention as _user_intervention
from .cli_commands import standalone_core as _standalone_core
from .cli_commands import standalone_commands as _standalone_commands
from .cli_commands import direct_reentry as _direct_reentry
from .cli_commands import init_capability as _init_capability
from .cli_commands import advancement as _advancement
from .cli_commands import external_prepare as _external_prepare
from .cli_commands import done_status as _done_status
from .cli_commands import gate_permit_state as _gate_permit_state
from .cli_commands import spec as _spec
from .cli_commands import gate as _gate
from .cli_commands import role_task as _role_task
from .cli_commands import task_files as _task_files
from .cli_commands import codecheck_commands as _codecheck_commands
from .cli_commands import pipeline_commands as _pipeline_commands
from .cli_commands import build_milestones as _build_milestones
from .cli_commands import story_diag as _story_diag
from .cli_commands import moonlight_commands as _moonlight_commands
from .cli_commands import lifecycle as _lifecycle
from .cli_commands import lean_migration as _lean_migration
from .cli_commands import dispatch as _dispatch
from .cli_commands import local_spec as _local_spec
from .cli_commands import domain_docs as _domain_docs
from .cli_commands import domain_archive as _domain_archive
from .cli_commands import delivery_manifest as _delivery_manifest
from .cli_commands import delivery_commands as _delivery_commands


_PLUGIN_ROOT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", ".."))
_RESOURCE_FILES = (
    ("runtime/guidance/grill.md", "guidance/grill.md"),
    ("runtime/guidance/construction.md", "guidance/construction.md"),
    ("runtime/guidance/quality.md", "guidance/quality.md"),
    ("runtime/guidance/review.md", "guidance/review.md"),
    ("runtime/guidance/story-design.md", "guidance/story-design.md"),
    ("runtime/guidance/cross-repo.md", "guidance/cross-repo.md"),
    ("runtime/guidance/build-fresh-context.md",
     "guidance/build-fresh-context.md"),
    ("runtime/standards/code-taste-v1.md", "standards/code-taste-v1.md"),
    ("runtime/standards/comment-standard-v1.md",
     "standards/comment-standard-v1.md"),
    ("skills/mae-flow/assets/CHAIN-TEMPLATE.md", "assets/CHAIN-TEMPLATE.md"),
    ("skills/mae-flow/assets/GRILL-PREP-TEMPLATE.md", "assets/GRILL-PREP-TEMPLATE.md"),
    ("skills/mae-flow/assets/REVIEW-TEMPLATE.md", "assets/REVIEW-TEMPLATE.md"),
    ("skills/mae-flow/assets/STORY-TEMPLATE.md", "assets/STORY-TEMPLATE.md"),
    ("skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md", "assets/IMPLEMENTATION-TEMPLATE.md"),
    ("skills/mae-flow/assets/DOMAIN-SPEC-TEMPLATE.md", "assets/DOMAIN-SPEC-TEMPLATE.md"),
)


def materialize_plugin_resources(root, plugin_root=None):
    """Copy immutable plugin guidance into the project work area."""
    plugin_root = os.path.abspath(plugin_root or _PLUGIN_ROOT)
    target_root = os.path.join(
        os.path.abspath(root), ".mae-flow-work", "plugin-resources")
    written = []
    for source_relative, target_relative in _RESOURCE_FILES:
        source = os.path.join(plugin_root, *source_relative.split("/"))
        target = os.path.join(target_root, *target_relative.split("/"))
        try:
            with open(source, "rb") as stream:
                content = stream.read()
        except OSError as exc:
            raise RuntimeError(
                "插件资源缺失，请刷新或重装 Mae-Flow: %s"
                % source_relative) from exc
        try:
            with open(target, "rb") as stream:
                if stream.read() == content:
                    written.append(target)
                    continue
        except OSError:
            pass
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = target + ".tmp-%s" % os.getpid()
        try:
            with open(temporary, "wb") as stream:
                stream.write(content)
            os.replace(temporary, target)
        finally:
            try:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            except OSError:
                pass
        written.append(target)
    return tuple(written)

api.register(shared)
_COMMAND_MODULES = (
    _git_authorization,
    _git_ownership,
    _state_config,
    _source_facts,
    _lightcheck,
    _codecheck_facts,
    _ack,
    _ack_confirmation,
    _current,
    _execution_plan,
    _user_intervention,
    _standalone_core,
    _task_files,
    _standalone_commands,
    _direct_reentry,
    _init_capability,
    _advancement,
    _external_prepare,
    _done_status,
    _gate_permit_state,
    _spec,
    _gate,
    _role_task,
    _codecheck_commands,
    _pipeline_commands,
    _build_milestones,
    _story_diag,
    _moonlight_commands,
    _lifecycle,
    _lean_migration,
    _symbol_refs,
    _panel,
    _codespec_engine,
    _local_spec,
    _domain_docs,
    _domain_archive,
    _delivery_manifest,
    _delivery_commands,
    _dispatch,
)
for _module in _COMMAND_MODULES:
    api.register(_module)

from .cli_commands import evidence_registry as _evidence_registry
api.register(_evidence_registry)
_EVIDENCE_COMPAT_NAMES = {
    "EVIDENCE",
    "_AGENT_EVIDENCE",
    "_DELIVERY_EVIDENCE",
    "_EVIDENCE_REGISTRY",
    "_QUALITY_EVIDENCE",
    "_WORKFLOW_EVIDENCE",
}
api.register_values({
    name: value
    for name, value in vars(_evidence_registry).items()
    if name in _EVIDENCE_COMPAT_NAMES or name.startswith("ev_")
})
globals().update(api.exports())

_legacy_main = main


def main():
    """Intercept migration/current before schema-v2 runtime loading."""
    args = parse_args()
    root, _ = find_project_root()
    if root != os.getcwd():
        os.chdir(root)
        if args.cmd != "gate":
            print(
                "[mae-flow] 调用目录非项目根,已定位到: %s" % root,
                file=sys.stderr,
            )
    try:
        materialize_plugin_resources(root)
    except (OSError, RuntimeError) as exc:
        print("[mae-flow] %s" % exc, file=sys.stderr)
        raise SystemExit(2)
    # init 之后同一条命令里就要能给出 .mae-flow-work/bin/mae-flow.py;
    # 不能等到下一次 Hook 事件才物化(损坏恢复提示直接引用该路径)。
    install_launcher_when_active(root)
    if handle_early_state_command(args):
        return None
    retire_legacy_batch_state()
    return _legacy_main()

class _CliRuntimeModule(types.ModuleType):
    def __getattribute__(self, name):
        if name == "FLOW":
            return api.FLOW
        return super().__getattribute__(name)

    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if not name.startswith("__"):
            setattr(api, name, value)

sys.modules[__name__].__class__ = _CliRuntimeModule

def __getattr__(name):
    return getattr(api, name)
