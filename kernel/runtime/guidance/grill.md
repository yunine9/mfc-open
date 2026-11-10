# Requirements Grill

Choose exactly one mode for the current action; never combine them.

## Interactive Grill

Use Interactive Grill to expand unanswered requirement branches until the requested WHAT is observable and testable.

- Investigate facts in the request, code, and environment. Ask the user only for decisions.
- Follow every requirement branch created by an answer. Ask one question at a time, with evidence, impact, and a recommended answer.
- Describe acceptance in observable behavior: inputs, preconditions, triggers, outputs, failure behavior, and outcomes a user or caller can detect.
- Keep HOW out of this work; HOW belongs to Story. Implementation types, functions, files, algorithms, and module choices are not requirement decisions.
- Turn vague language into explicit conditions. Record compatibility expectations and non-goals.

Use this internal checklist while reading; it is not a required artifact: state transitions and invalid events, empty and boundary values, duplicates and ordering, timeout and partial failure, data consistency, compatibility, scale, concurrency, cleanup, and observability.

## Read-only critic

The read-only critic never asks the user and never makes a decision. It reports missing branches for the interactive owner to resolve. Check that terms have a unique meaning, answers and code facts do not contradict each other, behavior is not vague or untestable, and the material contains no WHAT/HOW mixing.

Grill owns requirement divergence. Mae runtime does not duplicate brainstorming. A clear pass adds no user stop; a real unresolved decision is returned with its evidence and impact.
