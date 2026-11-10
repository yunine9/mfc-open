# Quality

Use semantic impact and the user's selection to choose quality work. The normal Full order is Formal CodeCheck, Build, then Unit Test.

- Treat each selected capability as opaque and record whether it returned, failed to start, timed out, or was not observed. Do not parse private output formats or invent a pass result.
- Attempt a selected expensive capability at most once for the same source and environment. There is no automatic retry. Explain changed source, environment, or user authorization before another attempt.
- Give every structured CodeCheck finding a disposition: fixed, false positive, existing, out of scope, or unsafe now. Raw-only output stays raw.
- Give Unit Test the confirmed Spec and Story when available, cumulative construction hints, and the final diff. Current implementation and confirmed artifacts outrank historical handoff notes.
- Design coverage from observable behavior, including what must not happen, normal, boundary, and failure scenarios. Test deterministic seams directly and keep each real boundary real unless isolation is necessary.
- When a capability exposes a source defect, find the root cause before changing production code. Let the user choose which affected expensive work to repeat.
- Obtain fresh evidence before claiming completion. Report actual outcomes and remaining risk without converting unknown output into success or failure.

Documentation-only, test-only, production, configuration, interface, and shared-state changes affect capabilities differently. Decide by semantic impact, never by file or line count.
