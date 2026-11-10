"""Shared imports for the split Hook runtime adapter mixins."""

import hashlib
import json
import os
import re
import subprocess
import sys
import time

from mae_flow_core import (
    RuntimeMode,
    append_codecheck_event,
    atomic_write_json,
    atomic_write_text,
    load_action as core_load_action,
    normalize_document,
    resolve_runtime,
    safe_read_json,
    save_codecheck_artifact,
    update_json,
    update_versioned_json,
)
from mae_flow_core.adapters import hook_budget
from mae_flow_core.application.hooks.receipts import (
    ReceiptContext as _ReceiptContext,
    askuser_receipt as _askuser_receipt,
    plan_compile_run_receipt as _plan_compile_run_receipt,
    plan_codecheck_build_receipt as _plan_codecheck_build_receipt,
    plan_codecheck_fullcheck_receipt as _plan_codecheck_fullcheck_receipt,
    plan_ut_generator_receipt as _plan_ut_generator_receipt,
    plan_ut_run_receipt as _plan_ut_run_receipt,
    reusable_compile_run_receipt as _core_reusable_compile_run,
    reusable_codecheck_build_receipt as _core_reusable_codecheck_build,
    reusable_codecheck_fullcheck_receipt as _core_reusable_codecheck_fullcheck,
    reusable_ut_receipt as _core_reusable_ut_receipt,
)
from mae_flow_core.application.hooks.task_cards import (
    verify_agent_scope as _verify_agent_scope,
    verify_completion_task as _verify_completion_task,
)
from mae_flow_core.file_io import load_json
from mae_flow_core.foundation import source_paths
from mae_flow_core.guard.permits import block_id as _permit_block_id
from mae_flow_core.foundation.fingerprints import (
    path_fingerprint as _shared_path_fingerprint,
    review_path_fingerprint as _shared_review_path_fingerprint,
)
from mae_flow_core.quality.agent_contracts import (
    AgentContractContext as _AgentContractContext,
)
from mae_flow_core.quality.agent_reports import (
    empty_section as _core_empty_section,
    report_field as _core_report_field,
    report_number as _core_report_number,
    report_section as _core_report_section,
)
from mae_flow_core.quality.codecheck_contract import (
    evaluate_codecheck_contract as _evaluate_codecheck_contract,
)
from mae_flow_core.quality.compile_contract import (
    evaluate_compile_contract as _evaluate_compile_contract,
)
from mae_flow_core.quality.compile_side_effects import (
    compile_side_effect_paths as _compile_side_effect_paths,
    successful_direct_write_paths as _successful_direct_write_paths,
)
from mae_flow_core.quality.grill_contract import (
    evaluate_grill_contract as _evaluate_grill_contract,
)
from mae_flow_core.quality.tool_transcript import (
    ToolCall as _ToolCall,
    call_failed as _core_call_failed,
    reported_bash_call as _core_reported_bash_call,
    skill_call as _core_skill_call,
)
from mae_flow_core.quality.unit_test_contract import (
    evaluate_unit_test_contract as _evaluate_unit_test_contract,
)
from mae_flow_core.quality.unit_test_execution import (
    report_counts as _core_ut_report_counts,
    reported_bash_segment as _core_reported_bash_segment,
    unit_test_execution_risk as _core_ut_execution_risk,
)


__all__ = [
    name for name in globals()
    if not name.startswith("__")
]
