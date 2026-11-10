#!/usr/bin/env python3
"""Tests for pure Gate request parsing."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.guard.intent import (  # noqa: E402
    BranchCommand,
    hits_path,
    parse_intent,
    recursive_delete_targets,
)
from mae_flow_core.foundation import git_intent  # noqa: E402
from mae_flow_core.foundation.git_intent import (  # noqa: E402
    git_delivery_intents,
    git_commit_intent,
    git_commit_intents,
)


class GuardIntentTests(unittest.TestCase):
    def test_git_redirections_are_not_pathspecs(self):
        for redirect in ("2>&1", "1>&2", ">out.log", ">> out.log",
                         "2>>out.log", "&>out.log", "&>>out.log",
                         "< /dev/null", "3<>out.log", "2>&-",
                         "> 'log with spaces'", ">| out.log"):
            with self.subTest(redirect=redirect):
                command = 'git commit -m "repair" ' + redirect
                self.assertEqual([], git_commit_intent(command)["pathspecs"])
                self.assertEqual((), git_delivery_intents(command)[0].pathspecs)
                command = 'git add ' + redirect + ' -- src/a.py'
                self.assertEqual(["src/a.py"],
                                 git_intent.git_add_intents(command)[0]["pathspecs"])

    def test_quoted_redirect_literals_remain_git_arguments(self):
        for path in ("2>", "a>b", ">", "&", "123"):
            command = "git commit -m 'message > output' -- '" + path + "'"
            self.assertEqual([path], git_commit_intent(command)["pathspecs"])
        self.assertEqual(["2"], git_commit_intent(
            'git commit -m repair -- "2">out.log')["pathspecs"])
        self.assertEqual(["a>b"], git_commit_intent(
            r'git commit -m repair -- a\>b')["pathspecs"])

    def test_redirect_targets_do_not_hide_executed_substitutions(self):
        actions = git_delivery_intents(
            'git commit -m repair > "$(git push origin HEAD)" 2>&1')
        self.assertEqual(["push", "commit"], [a.operation for a in actions])
        self.assertEqual((), actions[-1].pathspecs)
        actions = git_intent.git_actions(
            'git commit -m repair 2>&1 && git push origin HEAD',
            actor="agent-hook")
        self.assertEqual(["commit", "push"], [a.operation for a in actions])

    def test_delivery_execution_predicate_follows_real_wrapper_positions(self):
        executes_delivery = getattr(
            git_intent, "executes_git_commit_or_push", lambda command: False)
        commands = (
            "git push origin HEAD",
            "env FOO=1 command git push origin HEAD",
            "sudo -u root git commit -m update",
            "bash --noprofile -O extglob -c 'git push origin HEAD'",
            "powershell.exe -NoProfile -Command git commit -m update",
            "cmd.exe /d /s /c git push origin HEAD",
            "bash -c \"sh -c 'git commit -m update'\"",
            "cmd /c cmd /c cmd /c cmd /c cmd /c cmd /c git push",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(executes_delivery(command))

    def test_delivery_execution_predicate_rejects_inspection_and_bad_arity(self):
        executes_delivery = getattr(
            git_intent, "executes_git_commit_or_push", lambda command: False)
        commands = (
            "echo git push origin HEAD",
            "command -v git push",
            "sudo -u git push",
            "env printf -S 'git push'",
            "bash --not-a-shell-option -c 'git push'",
            "bash -c git push",
            "powershell.exe -Bogus -Command git push",
            "cmd.exe /bogus /c git push",
            "python -c \"print('git push')\"",
            "cmd /c cmd /c cmd /c cmd /c cmd /c cmd /c cmd /c git push",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertFalse(executes_delivery(command))

    def test_delivery_execution_predicate_respects_sudo_mode_semantics(self):
        executes_delivery = getattr(
            git_intent, "executes_git_commit_or_push", lambda command: False)
        cases = (
            ("sudo -B -E -k -u root git push origin HEAD", True),
            ("sudo --preserve-env --host=build --user=root git commit -m x", True),
            ("sudo -i git push origin HEAD", True),
            ("sudo --shell git commit -m update", True),
            ("sudo -e git push", False),
            ("sudo --edit git commit -m update", False),
            ("sudo -V git push", False),
            ("sudo --version git push", False),
            ("sudo -v git push", False),
            ("sudo --validate git commit -m update", False),
            ("sudo -l git push", False),
            ("sudo --list git commit -m update", False),
            ("sudo -K git push", False),
            ("sudo --remove-timestamp git commit -m update", False),
            ("sudo --help git push", False),
            ("sudo --user git push", False),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertIs(expected, executes_delivery(command))

    def test_delivery_execution_predicate_uses_launcher_specific_shell_options(self):
        executes_delivery = getattr(
            git_intent, "executes_git_commit_or_push", lambda command: False)
        cases = {
            "sh": (
                ("sh -eu -o errexit -c 'git push origin HEAD'", True),
                ("sh -o -c 'git push origin HEAD'", False),
                ("sh --help -c 'git push origin HEAD'", False),
            ),
            "bash": (
                ("bash --noprofile -O extglob -c 'git commit -m update'", True),
                ("bash -o errexit -c 'git push origin HEAD'", True),
                ("bash -l -c 'git push origin HEAD'", True),
                ("bash -O -c 'git push origin HEAD'", False),
                ("bash -oerrexit -c 'git push origin HEAD'", False),
                ("bash --init-command ready -c 'git push origin HEAD'", False),
            ),
            "zsh": (
                ("zsh -o SH_WORD_SPLIT -c 'git push origin HEAD'", True),
                ("zsh -oSH_WORD_SPLIT -c 'git push origin HEAD'", True),
                ("zsh -l -c 'git commit -m update'", True),
                ("zsh -o -c 'git push origin HEAD'", False),
                ("zsh --noprofile -c 'git push origin HEAD'", False),
            ),
            "fish": (
                ("fish -C 'echo ready' -c 'git push origin HEAD'", True),
                ("fish --init-command='echo ready' --command='git commit -m update'", True),
                ("fish -C 'git push origin HEAD' -c 'echo ready'", True),
                ("fish --init-command='git commit -m x' --command='echo ready'", True),
                ("fish -c 'git push origin HEAD' arg0", True),
                ("fish -C -c 'git push origin HEAD'", False),
                ("fish -O extglob -c 'git push origin HEAD'", False),
                ("fish --version -c 'git push origin HEAD'", False),
                ("fish -c 'echo ready' arg0 -c 'git push origin HEAD'", False),
            ),
        }
        for launcher, launcher_cases in cases.items():
            for command, expected in launcher_cases:
                with self.subTest(launcher=launcher, command=command):
                    self.assertIs(expected, executes_delivery(command))

    def test_delivery_execution_predicate_respects_shell_noexec_polarity(self):
        executes_delivery = getattr(
            git_intent, "executes_git_commit_or_push", lambda command: False)
        cases = (
            ("sh -o noexec -c 'git push origin HEAD'", False),
            ("bash -o No_ExEc -c 'git push origin HEAD'", False),
            ("zsh -o NO_EXEC -c 'git commit -m update'", False),
            ("zsh -oNO_EXEC -c 'git push origin HEAD'", False),
            ("sh +o noexec -c 'git push origin HEAD'", True),
            ("bash +o No_ExEc -c 'git push origin HEAD'", True),
            ("zsh +o NO_EXEC -c 'git commit -m update'", True),
            ("zsh +oNO_EXEC -c 'git push origin HEAD'", True),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertIs(expected, executes_delivery(command))

    def test_delivery_execution_predicate_tracks_ordered_noexec_state(self):
        executes_delivery = getattr(
            git_intent, "executes_git_commit_or_push", lambda command: False)
        cases = (
            ("bash -o noexec +o noexec -c 'git push origin HEAD'", True),
            ("zsh -oNO_EXEC +oNO_EXEC -c 'git commit -m update'", True),
            ("sh -n +n -c 'git push origin HEAD'", True),
            ("bash -en +n -c 'git push origin HEAD'", True),
            ("zsh +n -c 'git commit -m update'", True),
            ("sh -n +en -c 'git push origin HEAD'", True),
            ("bash -n +in -c 'git push origin HEAD'", True),
            ("zsh -n +en -c 'git commit -m update'", True),
            ("bash +o noexec -o noexec -c 'git push origin HEAD'", False),
            ("zsh +oNO_EXEC -oNO_EXEC -c 'git commit -m update'", False),
            ("sh +n -n -c 'git push origin HEAD'", False),
            ("bash +n -en -c 'git push origin HEAD'", False),
            ("zsh -nc 'git push origin HEAD'", False),
            ("bash +c 'git push origin HEAD'", False),
            ("bash +nc 'git push origin HEAD'", False),
            ("zsh +zn -c 'git push origin HEAD'", False),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertIs(expected, executes_delivery(command))

    def test_parse_normalizes_slashes_and_tokenizes_bash_paths(self):
        intent = parse_intent(
            "bash",
            r'sed -i "x" src\main.cpp && git status',
        )
        self.assertEqual(
            'sed -i "x" src/main.cpp && git status',
            intent.subject,
        )
        self.assertEqual(
            ("sed", "-i", "x", "src/main.cpp", "git", "status"),
            intent.tokens,
        )
        self.assertTrue(hits_path(intent, r"(^|/)src/"))

    def test_edit_intent_keeps_no_command_tokens(self):
        intent = parse_intent("edit", r"src\main.cpp")
        self.assertEqual("src/main.cpp", intent.subject)
        self.assertEqual((), intent.tokens)

    def test_branch_command_distinguishes_creation_and_recovery(self):
        self.assertEqual(
            BranchCommand("feature/x", True),
            parse_intent(
                "bash", "git switch -c feature/x").branch,
        )
        self.assertEqual(
            BranchCommand("", False),
            parse_intent(
                "bash", "git checkout HEAD -- src/main.cpp").branch,
        )
        self.assertEqual(
            BranchCommand("main", False),
            parse_intent("bash", "git switch main").branch,
        )

    def test_recursive_delete_targets_only_inspects_delete_segment(self):
        self.assertEqual(
            ("build",),
            recursive_delete_targets(parse_intent(
                "bash",
                "rm -rf build && cmake -S . -B build",
            )),
        )
        self.assertEqual(
            (".",),
            recursive_delete_targets(parse_intent(
                "bash",
                "git status && rm -rf .",
            )),
        )
        self.assertEqual(
            ("C:/",),
            recursive_delete_targets(parse_intent(
                "bash",
                "rd /s C:\\",
            )),
        )

    def test_delivery_intents_follow_actual_command_positions_and_wrappers(self):
        cases = (
            ("git add .", ("add",)),
            ("git status && git add src/a.py", ("add",)),
            ("sh -c 'git add .'", ("add",)),
            ("env FOO=1 command git commit -m update", ("commit",)),
            ("sudo -u root git push origin HEAD", ("push",)),
            ("fish -C 'echo ready' -c 'git add src/a.py'", ("add",)),
            ("pwsh -NoProfile -Command git commit -m update", ("commit",)),
            ("cmd.exe /d /c git add .", ("add",)),
            ("echo git add .", ()),
            ("printf 'git commit -m update'", ()),
            ("git status && echo git add .", ()),
            ("bash -n -c 'git add .'", ()),
            ("bash --help -c 'git add .'", ()),
            ("command -v git commit", ()),
            ("sudo --version git push", ()),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(
                    expected,
                    tuple(
                        intent.operation
                        for intent in git_delivery_intents(command)),
                )

    def test_recursive_delete_targets_follow_actual_command_positions(self):
        cases = (
            ("rm -rf build", ("build",)),
            ("rm -rf /", ("/",)),
            ("git status && rm -rf .", (".",)),
            ("sh -c 'rm -rf /'", ("/",)),
            ("cmd.exe /d /c rmdir /s C:/", ("C:/",)),
            ("echo rm -rf build", ()),
            ("echo rm -rf /", ()),
            ("printf 'rm -rf /'", ()),
            ("git status && echo rm -rf /", ()),
            ("bash -n -c 'rm -rf /'", ()),
            ("bash --help -c 'rm -rf /'", ()),
            ("rm --preserve-root /", ()),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(
                    expected,
                    recursive_delete_targets(parse_intent("bash", command)),
                )

    def test_commit_intents_preserve_every_invocation_in_shell_order(self):
        command = (
            "git commit -am first && "
            "git commit --include src/a.py -m second && "
            "git commit -m third"
        )

        intents = git_commit_intents(command)

        self.assertEqual(
            [
                {"pathspecs": [], "all": True, "include": False},
                {
                    "pathspecs": ["src/a.py"],
                    "all": False,
                    "include": True,
                },
                {"pathspecs": [], "all": False, "include": False},
            ],
            intents,
        )
        self.assertEqual(intents[-1], git_commit_intent(command))

    def test_delivery_intents_preserve_ordinary_and_opaque_source_order(self):
        command = (
            "git commit -a -m first && "
            "git add --pathspec-from-file=paths.txt && "
            "git add src/a.py && "
            "git commit -m second && "
            "git push origin main"
        )

        intents = git_delivery_intents(command)

        self.assertEqual(
            [
                ("commit", False, (), True, False),
                ("add", True, (), False, False),
                ("add", False, ("src/a.py",), False, False),
                ("commit", False, (), False, False),
                ("push", False, (), False, False),
            ],
            [
                (
                    intent.operation,
                    intent.opaque_pathspec,
                    intent.pathspecs,
                    intent.all,
                    intent.include,
                )
                for intent in intents
            ],
        )

    def test_actual_projection_preserves_repeated_invocations(self):
        intents = git_delivery_intents(
            "git add src/a.cpp && git add src/a.cpp")

        self.assertEqual(
            (("add", ("src/a.cpp",)), ("add", ("src/a.cpp",))),
            tuple(
                (intent.operation, intent.pathspecs)
                for intent in intents),
        )

    def test_command_substitutions_emit_actual_delivery_leaves_in_order(self):
        cases = (
            (
                'echo "$(git add src/double.cpp)"',
                (("add", ("src/double.cpp",)),),
            ),
            (
                "echo $(git commit -m inner)",
                (("commit", ("-m", "inner")),),
            ),
            (
                "echo `git push origin HEAD`",
                (("push", ("origin", "HEAD")),),
            ),
            (
                'git add src/outer.cpp && echo "$(git add src/inner.cpp)" '
                "&& git commit -m final",
                (
                    ("add", ("src/outer.cpp",)),
                    ("add", ("src/inner.cpp",)),
                    ("commit", ("-m", "final")),
                ),
            ),
            (
                'echo "$(echo $(git add src/nested.cpp))"',
                (("add", ("src/nested.cpp",)),),
            ),
            (
                'echo "$(git add src/repeat.cpp)" '
                '"$(git add src/repeat.cpp)"',
                (
                    ("add", ("src/repeat.cpp",)),
                    ("add", ("src/repeat.cpp",)),
                ),
            ),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                intents = git_delivery_intents(command)
                self.assertEqual(
                    expected,
                    tuple(
                        (intent.operation, intent.arguments)
                        for intent in intents),
                )

    def test_literal_and_noexec_substitutions_do_not_emit_delivery_leaves(self):
        commands = (
            "echo '$(git push origin HEAD)'",
            'echo "\\$(git push origin HEAD)"',
            'echo "\\`git push origin HEAD\\`"',
            "bash -n -c 'echo \"$(git push origin HEAD)\"'",
            "echo \"$(bash -n -c 'git push origin HEAD')\"",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertEqual((), git_delivery_intents(command))

    def test_recursive_delete_targets_expand_only_active_substitutions(self):
        cases = (
            ('echo "$(rm -rf /)"', ("/",)),
            ("echo `rm -rf .`", (".",)),
            ("git status && echo '$(rm -rf /)'", ()),
            ('echo "\\$(rm -rf /)"', ()),
            ("bash -n -c 'echo \"$(rm -rf /)\"'", ()),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(
                    expected,
                    recursive_delete_targets(parse_intent("bash", command)),
                )

    def test_cmd_payload_preserves_windows_paths_without_changing_bash_escape(self):
        cases = (
            (r"cmd.exe /d /c git add src\a.cpp", ("src/a.cpp",)),
            (
                r'cmd.exe /d /c git add "src\a b.cpp"',
                ("src/a b.cpp",),
            ),
            (
                r"cmd.exe /c git add C:\repo\src\a.cpp",
                ("C:/repo/src/a.cpp",),
            ),
            (
                r'cmd.exe /d /s /c "git add src\whole.cpp"',
                ("src/whole.cpp",),
            ),
            (r"git add foo\ bar.cpp", ("foo bar.cpp",)),
        )
        for command, expected_paths in cases:
            with self.subTest(command=command):
                intents = git_delivery_intents(command)
                self.assertEqual(1, len(intents))
                self.assertEqual(expected_paths, intents[0].pathspecs)

    def test_python_synthetic_delivery_coexists_after_same_direct_operation(self):
        command = (
            "git add src/a.cpp && "
            'python -c "import subprocess; '
            "subprocess.run(['git','add','.'])\""
        )

        intents = git_delivery_intents(command)

        self.assertEqual(2, len(intents))
        self.assertEqual(
            ("add", ("src/a.cpp",), False),
            (
                intents[0].operation,
                intents[0].pathspecs,
                intents[0].opaque_pathspec,
            ),
        )
        self.assertEqual(
            ("add", (), True),
            (
                intents[1].operation,
                intents[1].pathspecs,
                intents[1].opaque_pathspec,
            ),
        )

    def test_quoted_cmd_payload_preserves_multiple_git_operation_order(self):
        intents = git_delivery_intents(
            r'cmd.exe /d /c "git add src\a.cpp && git commit -m update"')

        self.assertEqual(
            (
                ("add", ("src/a.cpp",)),
                ("commit", ()),
            ),
            tuple(
                (intent.operation, intent.pathspecs)
                for intent in intents),
        )

    def test_synthetic_detection_ignores_wrapper_source_in_printing_leaves(self):
        commands = (
            (
                'echo python -c "import subprocess; '
                "subprocess.run(['git','push','origin','HEAD'])\""
            ),
            (
                'logger \'python -c "import os; '
                "os.system(\\\"git push origin HEAD\\\")\"'"
            ),
            (
                "printf '%s\\n' git -c "
                "'alias.ship=!git push origin HEAD' ship"
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                self.assertEqual((), git_delivery_intents(command))

    def test_python_leaf_ignores_git_launch_source_inside_string_literals(self):
        commands = (
            (
                "python -c \"print(\\\"subprocess.run(['git', 'push', "
                "'origin', 'HEAD'])\\\")\""
            ),
            (
                "python -c \"import logging; "
                "logging.info(\\\"os.system('git push origin HEAD')\\\")\""
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                self.assertEqual((), git_delivery_intents(command))

    def test_python_leaf_detects_real_literal_git_launch_calls(self):
        commands = (
            (
                'python -c "import subprocess; '
                "subprocess.run(['git','push','origin','HEAD'])\""
            ),
            (
                'python -c "import os; '
                "os.system('git push origin HEAD')\""
            ),
        )

        for command in commands:
            with self.subTest(command=command):
                intents = git_delivery_intents(command)
                self.assertEqual(1, len(intents))
                self.assertEqual("push", intents[0].operation)
                self.assertTrue(intents[0].opaque_pathspec)

    def test_synthetic_delivery_preserves_source_order_with_direct_git(self):
        python_push = (
            'python -c "import os; '
            "os.system('git push origin HEAD')\""
        )
        alias_push = "git -c alias.ship='!git push origin HEAD' ship"
        cases = (
            (
                python_push + " && git add src/after.cpp",
                (("push", (), True), ("add", ("src/after.cpp",), False)),
            ),
            (
                "git add src/before.cpp && " + python_push,
                (("add", ("src/before.cpp",), False), ("push", (), True)),
            ),
            (
                alias_push + " && git add src/after-alias.cpp",
                (
                    ("push", (), True),
                    ("add", ("src/after-alias.cpp",), False),
                ),
            ),
        )

        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(
                    expected,
                    tuple(
                        (
                            intent.operation,
                            intent.pathspecs,
                            intent.opaque_pathspec,
                        )
                        for intent in git_delivery_intents(command)),
                )


if __name__ == "__main__":
    unittest.main()
