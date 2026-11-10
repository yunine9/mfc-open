"""Cloud owns retry/recovery; a failed Hook must never look successful."""

import os
import sys


def hook_failure(reason, log):
    strict = os.environ.get("MAE_FLOW_HOOK_STRICT") == "1"
    message = "[mae-flow] Hook 未完成: %s (%s)" % (
        reason, "fail-closed" if strict else "fail-open")
    log(message)
    if strict:
        print(message, file=sys.stderr, flush=True)
    return 75 if strict else 0
