"""Read-only provenance diagnostics; no submission veto."""
from .wiring import api


def pending_commit_files(command="", st=None, candidate_snapshot=None):
    """Inspect files that a commit is about to include.

    Staged paths are authoritative. For `git add ... && git commit ...` in one
    Bash call, explicit pathspecs are also inspected before either command has
    run. A missing Write/Edit provenance is warning-only unless the path is also
    a newly added, high-confidence temporary build artifact.
    """
    if candidate_snapshot is None:
        candidate_snapshot = api._pending_commit_candidates(command)
    candidates = candidate_snapshot["paths"]
    present_candidates = candidate_snapshot.get(
        "present_paths", candidates)
    new_candidates = candidate_snapshot["new_paths"]
    forced_candidates = candidate_snapshot.get("forced_paths", set())
    written = api._agent_written_paths()
    compile_side_effects = api._compile_side_effect_paths()

    def has_provenance(path):
        return (api._repo_path_identity(path) in written
                or api._trusted_harness_commit_path(path, st))

    inherited = [
        path for path in present_candidates
        if api._unchanged_initial_dirty(path, st or {})
        and api._repo_path_identity(path) not in written
    ]
    foreign_openspec = [
        path for path in present_candidates
        if path.startswith("openspec/")
        and not api._trusted_harness_commit_path(path, st)
    ]
    recorded_compile_side_effects = [
        path for path in present_candidates
        if api._repo_path_identity(path) in compile_side_effects
    ]
    unproven = [
        path for path in present_candidates if not has_provenance(path)]
    strong_unproven = [
        path for path in unproven
        if (
            path in forced_candidates
            or (
                path in new_candidates
                and api._build_artifact_confidence(path) == "strong"
            )
        )
    ]
    artifact_hints = [
        path for path in present_candidates
        if path not in strong_unproven and api._build_artifact_confidence(path)
    ]
    return (inherited, foreign_openspec, recorded_compile_side_effects,
            strong_unproven, unproven, artifact_hints)
