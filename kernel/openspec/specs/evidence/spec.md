# evidence Specification

## Purpose
TBD - created by archiving change legacy-tasks-encoding. Update Purpose after archive.
## Requirements
### Requirement: Legacy tasks source encoding resilience
The system SHALL surface a readable UTF-8 remediation error instead of a raw
traceback when the legacy tasks.md of a change is not valid UTF-8.

#### Scenario: Corrupt legacy tasks.md rejected with guidance
- **WHEN** a legacy-layout change's tasks.md contains non-UTF-8 bytes
- **THEN** engine task-source reads raise a spec engine error mentioning UTF-8
- **AND** done evidence reports a retryable rejection instead of crashing

#### Scenario: Archive task counting stays tolerant
- **WHEN** archiving a legacy change whose tasks.md is not valid UTF-8
- **THEN** the task progress counter SHALL degrade to zero counts without failing the archive

