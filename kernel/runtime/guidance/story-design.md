# Story Design

Treat the approved Spec as the WHAT authority. Story defines HOW at the established business-design level; the local implementation companion carries Mae-Flow-specific implementation detail. Together they define how the approved behavior will be implemented. Do not reopen confirmed product decisions unless code evidence exposes a real contradiction.

- Identify the implementation boundary, main code locations, interfaces, dependencies, and data flow.
- Make ownership, error semantics, resource lifetime, concurrency, compatibility, and cleanup explicit.
- Separate stable framework plumbing from changing business decisions. Prefer deterministic business units behind narrow adapters.
- Name the test seam that must be created during coding, the observable it exposes, and the real boundary that remains integrated. Do not postpone this decision until formal testing.
- Prefer reuse and the standard library where they fit. Choose the simplest design that satisfies current constraints and avoid speculative abstraction.
- Record Grill implementation impact, key function changes, whole-change constraints, risks, rollback, and domain archive impact in `implementation.md`, not in Story.

Story and its implementation companion receive one focused design review together. Present real tradeoffs to the user; ordinary reviewer approval continues without ceremony.
