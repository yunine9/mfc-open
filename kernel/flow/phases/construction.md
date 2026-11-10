# Construction

## Objective

The main Agent implements and finalizes the whole approved change directly from the local Spec and Story: code, compile verification, lean pass, standards sweep, tests, and spec conformance self-check — in any order it judges best.

## Inspect

Read the confirmed behavior, design boundaries, affected code, repository build configuration, and intended test seam.

Treat testability as a core coding principle: separate directly testable logic from external effects, reuse replaceable dependency boundaries, and keep module internals real in tests. Current verification covers function-level UT and module-level UT (MST). In this project MST means module-level UT, not another test layer. Separate REST, cross-module integration, and deployment verification remain future capabilities. follow the construction guidance without adding abstraction or gates merely to reduce mocks.

## Stop for the user

Only for real ambiguity or a plan-level gap. There is no mid-flow mandatory review: humans review asynchronously via workbench annotations during the run and formally on the merge request afterwards.

## Outputs

- The complete change committed on the task branch, exit checklist honestly answered.
- Build artifacts kept out of the repository.

## Next

Domain knowledge archiving, delivery manifest, then push. Real adjudication happens at the exits: host pre-push verification (real compile and UT in a build container), the authoritative pipeline bound to the exact SHA, and human review on the merge request.
