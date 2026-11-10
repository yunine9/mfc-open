"""Composed platform adapter used by the Hook protocol entrypoint."""

import os

from mae_flow_core import ACTION_FILE, EXIT_FILE, FLOW_FILE
from mae_flow_core.application.hooks.task_cards import TaskCardPorts
from mae_flow_core.file_io import read_text
from mae_flow_core.foundation import source_paths

from .hook_runtime_contract_support import HookContractSupportMixin
from .hook_runtime_contracts import HookContractsMixin
from .hook_runtime_git_authorization import HookGitAuthorizationMixin
from .hook_runtime_source import HookSourceMixin
from .hook_runtime_state import HookStateMixin
from .hook_runtime_trace import HookTraceMixin


class HookRuntimeAdapter(
        HookGitAuthorizationMixin,
        HookStateMixin,
        HookTraceMixin,
        HookContractSupportMixin,
        HookSourceMixin,
        HookContractsMixin):
    """Stateful adapter configuration shared by split Hook responsibilities."""

    def __init__(
            self, *, state, exit_state, action_state, rejection_state,
            evidence_state, agent_writes_state, moonlight_intent,
            exit_intent, maeflow, log, task_card_ports_factory=None):
        self.STATE = state
        self.EXIT_STATE = exit_state
        self.ACTION_STATE = action_state
        self.REJECTION_STATE = rejection_state
        self.EVIDENCE_STATE = evidence_state
        self.AGENT_WRITES_STATE = agent_writes_state
        self.MOONLIGHT_INTENT = moonlight_intent
        self.EXIT_INTENT = exit_intent
        self.MAEFLOW = maeflow
        self.log = log
        self.task_card_ports_factory = (
            task_card_ports_factory or self._task_card_ports)
        self.input_encoding = ""
        self._validated_task_bindings = {}

    def _task_card_ports(self):
        return TaskCardPorts(
            read_text=read_text,
            current_head=self._git_head,
            merge_base=lambda head, _current: self._git_out(
                "git merge-base %s HEAD" % head).strip(),
            changed_paths_since=self._changed_paths_since,
            source_changed_since=self._source_changed_since_receipt,
            source_snapshot=self._source_snapshot,
            path_fingerprint=self._path_fingerprint,
            review_path_fingerprint=self._review_path_fingerprint,
            source_like=self._source_like,
            test_like=self._test_like,
            build_like=source_paths.is_build_path,
            path_exists=os.path.exists,
            script_path=lambda: os.path.abspath(self.MAEFLOW),
        )


def create_hook_runtime(maeflow, log):
    """Create the standard project-relative Hook runtime adapter."""
    return HookRuntimeAdapter(
        state=FLOW_FILE,
        exit_state=EXIT_FILE,
        action_state=ACTION_FILE,
        rejection_state=FLOW_FILE + ".agent-rejections",
        evidence_state=FLOW_FILE + ".agent-evidence",
        agent_writes_state=FLOW_FILE + ".agent-writes",
        moonlight_intent=FLOW_FILE + ".moonlight-intent",
        exit_intent=FLOW_FILE + ".exit-intent",
        maeflow=maeflow,
        log=log,
    )
