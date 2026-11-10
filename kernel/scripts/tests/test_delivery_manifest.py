#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Exact delivery-manifest and startup-dirty adoption contracts."""

import os
import sys
import tempfile
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.guard import (  # noqa: E402
    DeliveryManifest,
    ManifestComparison,
    authorize_delivery,
    compare_staged,
)
from mae_flow_core.orchestration import (  # noqa: E402
    CommitPace,
    DeliveryPath,
    FlowState,
)


class DeliveryManifestTests(unittest.TestCase):
    def test_manifest_preserves_order_and_comparison_uses_exact_sets(self):
        manifest = DeliveryManifest.from_paths(
            ["src/a.cpp", "tests/a_test.cpp"])

        matching = compare_staged(
            manifest, ["tests/a_test.cpp", "src/a.cpp"])
        mismatch = compare_staged(
            manifest, ["src/a.cpp", "README.md"])

        self.assertEqual(("src/a.cpp", "tests/a_test.cpp"), manifest.files)
        self.assertTrue(matching.matches)
        self.assertEqual((), matching.missing)
        self.assertEqual((), matching.extra)
        self.assertFalse(mismatch.matches)
        self.assertEqual(("tests/a_test.cpp",), mismatch.missing)
        self.assertEqual(("README.md",), mismatch.extra)

    def test_windows_identity_keeps_display_case_and_rejects_aliases(self):
        manifest = DeliveryManifest.from_paths(["Src\\Feature.cpp"])

        comparison = compare_staged(manifest, ["src/feature.cpp"])

        self.assertEqual(("Src/Feature.cpp",), manifest.files)
        self.assertTrue(comparison.matches)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            DeliveryManifest.from_paths(
                ["Src/Feature.cpp", "src\\feature.cpp"])

    def test_rejects_non_file_path_expressions(self):
        invalid_paths = (
            "",
            ".",
            "./",
            "src/../README.md",
            "../README.md",
            "src/*.cpp",
            "src/file?.cpp",
            "src/[ab].cpp",
            "src/",
            ":(exclude)README.md",
            ":/src/a.cpp",
            ":literal-path",
        )
        for path in invalid_paths:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    DeliveryManifest.from_paths([path])

    def test_rejects_windows_drive_relative_paths_on_every_host(self):
        invalid_paths = (
            "C:foo",
            "C:..\\outside.txt",
            "C:.\\inside.txt",
            "C:",
        )
        for path in invalid_paths:
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "drive"):
                    DeliveryManifest.from_paths([path])

        manifest = DeliveryManifest.from_paths(
            ["C:\\Repo\\Src\\A.cpp"],
            repository_root="c:\\repo",
        )
        self.assertEqual(("Src/A.cpp",), manifest.files)

        unc_manifest = DeliveryManifest.from_paths(
            ["\\\\Server\\Share\\Src\\A.cpp"],
            repository_root="\\\\server\\share",
        )
        self.assertEqual(("Src/A.cpp",), unc_manifest.files)

    def test_rejects_unordered_path_collections_at_every_entry_point(self):
        unordered = (
            {"src/a.cpp"},
            frozenset(("src/a.cpp",)),
            {"src/a.cpp": True},
        )
        for paths in unordered:
            with self.subTest(kind=type(paths).__name__):
                with self.assertRaisesRegex(ValueError, "ordered"):
                    DeliveryManifest.from_paths(paths)
                with self.assertRaisesRegex(ValueError, "ordered"):
                    DeliveryManifest.from_paths(
                        ["src/a.cpp"], adopted_dirty=paths)
                with self.assertRaisesRegex(ValueError, "ordered"):
                    compare_staged(
                        DeliveryManifest.from_paths(["src/a.cpp"]), paths)
                with self.assertRaisesRegex(ValueError, "ordered"):
                    ManifestComparison(False, paths, ())

    def test_rejects_existing_directories_and_outside_absolute_paths(self):
        with tempfile.TemporaryDirectory() as parent:
            root = os.path.join(parent, "repo")
            directory = os.path.join(root, "src")
            os.makedirs(directory)
            inside = os.path.join(directory, "feature.cpp")
            outside = os.path.join(parent, "outside.cpp")
            with open(inside, "w", encoding="utf-8") as stream:
                stream.write("inside")
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write("outside")

            manifest = DeliveryManifest.from_paths(
                [inside], repository_root=root)

            self.assertEqual(("src/feature.cpp",), manifest.files)
            with self.assertRaisesRegex(ValueError, "outside"):
                DeliveryManifest.from_paths(
                    [outside], repository_root=root)
            with self.assertRaisesRegex(ValueError, "directory"):
                DeliveryManifest.from_paths(
                    [directory], repository_root=root)

    def test_absolute_file_uses_the_supplied_repository_root_once(self):
        with tempfile.TemporaryDirectory() as root:
            absolute_file = os.path.join(root, "scripts")
            with open(absolute_file, "w", encoding="utf-8") as stream:
                stream.write("a file, unlike this worktree's scripts directory")

            manifest = DeliveryManifest.from_paths(
                [absolute_file], repository_root=root)

            self.assertEqual(("scripts",), manifest.files)

    def test_absolute_path_rejects_existing_parent_symlink_escape(self):
        with tempfile.TemporaryDirectory() as parent:
            root = os.path.join(parent, "repo")
            outside = os.path.join(parent, "outside")
            os.makedirs(root)
            os.makedirs(outside)
            link = os.path.join(root, "escape")
            try:
                os.symlink(outside, link, target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest("directory symlinks unavailable: %s" % exc)

            with self.assertRaisesRegex(ValueError, "outside"):
                DeliveryManifest.from_paths(
                    [os.path.join(link, "new.cpp")],
                    repository_root=root,
                )

    def test_final_file_symlink_and_new_file_under_safe_parents_are_allowed(self):
        with tempfile.TemporaryDirectory() as parent:
            root = os.path.join(parent, "repo")
            source = os.path.join(root, "src")
            outside = os.path.join(parent, "outside.cpp")
            outside_directory = os.path.join(parent, "outside-directory")
            os.makedirs(source)
            os.makedirs(outside_directory)
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write("outside target")
            final_link = os.path.join(root, "tracked-link.cpp")
            final_directory_link = os.path.join(root, "tracked-directory-link")
            try:
                os.symlink(outside, final_link)
                os.symlink(
                    outside_directory,
                    final_directory_link,
                    target_is_directory=True,
                )
            except (OSError, NotImplementedError) as exc:
                self.skipTest("file symlinks unavailable: %s" % exc)

            manifest = DeliveryManifest.from_paths(
                [
                    final_link,
                    final_directory_link,
                    os.path.join(source, "new.cpp"),
                ],
                repository_root=root,
            )

            self.assertEqual(
                (
                    "tracked-link.cpp",
                    "tracked-directory-link",
                    "src/new.cpp",
                ),
                manifest.files,
            )

    @unittest.skipIf(os.name == "nt", "Windows absolute paths ignore case")
    def test_posix_absolute_repository_membership_is_case_sensitive(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            DeliveryManifest.from_paths(
                ["/TMP/Repository/src/a.cpp"],
                repository_root="/tmp/repository",
            )

    def test_comparison_reports_missing_and_extra_deterministically(self):
        manifest = DeliveryManifest.from_paths(
            ["z.cpp", "A.cpp", "m.cpp"])

        result = compare_staged(manifest, ["B.cpp", "y.cpp", "m.cpp"])

        self.assertEqual(("A.cpp", "z.cpp"), result.missing)
        self.assertEqual(("B.cpp", "y.cpp"), result.extra)

    def test_values_are_immutable(self):
        manifest = DeliveryManifest.from_paths(["src/a.cpp"])
        comparison = compare_staged(manifest, ["src/a.cpp"])

        with self.assertRaises((AttributeError, TypeError)):
            manifest.files = ()
        with self.assertRaises((AttributeError, TypeError)):
            comparison.matches = False

    def test_comparison_cannot_retain_caller_owned_mutable_collections(self):
        missing = ["src/missing.cpp"]
        extra = ["src/extra.cpp"]

        comparison = ManifestComparison(False, missing, extra)
        missing.append("src/later.cpp")
        extra.clear()

        self.assertEqual(("src/missing.cpp",), comparison.missing)
        self.assertEqual(("src/extra.cpp",), comparison.extra)
        with self.assertRaisesRegex(ValueError, "strings"):
            ManifestComparison(False, [["src/mutable.cpp"]], ())

    def test_direct_construction_cannot_retain_mutable_path_collections(self):
        files = ["Src\\A.cpp"]
        adopted = ["Src\\A.cpp"]

        manifest = DeliveryManifest(files, adopted)
        files.append("src/b.cpp")
        adopted.clear()

        self.assertEqual(("Src/A.cpp",), manifest.files)
        self.assertEqual(("Src/A.cpp",), manifest.adopted_dirty)


class DeliveryAuthorizationTests(unittest.TestCase):
    def state(self, initial_dirty=(), delivery_files=(), decisions=()):
        return FlowState(
            ticket="REQ-42",
            path=DeliveryPath.FULL,
            phase=FlowState.new(
                "REQ-42", DeliveryPath.FULL, CommitPace.STAGED).phase,
            commit_pace=CommitPace.STAGED,
            initial_dirty=initial_dirty,
            delivery_files=delivery_files,
            decisions=decisions,
        )

    def test_authorization_returns_new_state_with_exact_delivery_files(self):
        original = self.state(delivery_files=("old.cpp",))
        manifest = DeliveryManifest.from_paths(
            ["src/a.cpp", "tests/a_test.cpp"])

        authorized = authorize_delivery(original, manifest)

        self.assertIsNot(original, authorized)
        self.assertEqual(("old.cpp",), original.delivery_files)
        self.assertEqual(manifest.files, authorized.delivery_files)
        self.assertEqual(original.decisions, authorized.decisions)

    def test_explicit_adoption_is_authorized_and_recorded_as_semantic_facts(self):
        original = self.state(initial_dirty=(
            "src/existing.cpp",
            "docs/notes.md",
        ))
        manifest = DeliveryManifest.from_paths(
            ["src/new.cpp", "src/existing.cpp", "docs/notes.md"],
            adopted_dirty=["docs/notes.md", "src/existing.cpp"],
        )

        authorized = authorize_delivery(original, manifest)

        self.assertEqual(manifest.files, authorized.delivery_files)
        self.assertEqual((
            ("delivery.adopted_dirty", "docs/notes.md"),
            ("delivery.adopted_dirty", "src/existing.cpp"),
        ), authorized.decisions)

    def test_adoption_requires_an_exact_startup_dirty_subset(self):
        original = self.state(initial_dirty=("src/existing.cpp",))
        manifest = DeliveryManifest.from_paths(
            ["src/existing.cpp", "src/other.cpp"],
            adopted_dirty=["src/other.cpp"],
        )

        with self.assertRaisesRegex(ValueError, "initial_dirty"):
            authorize_delivery(original, manifest)

    def test_adoption_must_also_be_an_authorized_delivery_file(self):
        original = self.state(initial_dirty=("notes.txt",))
        manifest = DeliveryManifest.from_paths(
            ["src/a.cpp"], adopted_dirty=["notes.txt"])

        with self.assertRaisesRegex(ValueError, "delivery"):
            authorize_delivery(original, manifest)

    def test_windows_alias_can_match_startup_dirty_without_changing_display(self):
        original = self.state(initial_dirty=("Src/Existing.cpp",))
        manifest = DeliveryManifest.from_paths(
            ["src\\existing.cpp"], adopted_dirty=["src\\existing.cpp"])

        authorized = authorize_delivery(original, manifest)

        self.assertEqual(("src/existing.cpp",), authorized.delivery_files)
        self.assertIn(
            ("delivery.adopted_dirty", "src/existing.cpp"),
            authorized.decisions,
        )

    def test_authorization_does_not_infer_adoption_from_startup_dirt(self):
        original = self.state(initial_dirty=("src/existing.cpp",))
        manifest = DeliveryManifest.from_paths(["src/existing.cpp"])

        authorized = authorize_delivery(original, manifest)

        self.assertEqual(("src/existing.cpp",), authorized.delivery_files)
        self.assertEqual((), authorized.decisions)

    def test_reauthorization_replaces_prior_dirty_adoption(self):
        original = self.state(
            initial_dirty=("src/a.cpp", "src/b.cpp"),
            decisions=(("focused.scope_approved", "approved"),),
        )
        first = authorize_delivery(
            original,
            DeliveryManifest.from_paths(
                ["src/a.cpp"], adopted_dirty=["src/a.cpp"]),
        )

        second = authorize_delivery(
            first,
            DeliveryManifest.from_paths(
                ["src/b.cpp"], adopted_dirty=["src/b.cpp"]),
        )

        self.assertEqual(("src/b.cpp",), second.delivery_files)
        self.assertEqual((
            ("focused.scope_approved", "approved"),
            ("delivery.adopted_dirty", "src/b.cpp"),
        ), second.decisions)


if __name__ == "__main__":
    unittest.main()
