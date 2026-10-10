If a shell command is unavailable, run it with Nix comma (`, <command>`); do not install it.

Use `/tmp/pi` as the dedicated disposable workspace for temporary artifacts, experiments, generated files, and test fixtures.
For temporary files, use exactly `mktemp -p /tmp/pi`; for temporary directories, use exactly `mktemp -d -p /tmp/pi`.
To delete its artifacts, use exactly `find /tmp/pi -mindepth 1 -name <glob> -delete`, replacing `<glob>` with a quoted glob matching the artifacts. When an artifact path is stored in a variable, still use this form; for a variable such as `$tmp_file`, use `find /tmp/pi -mindepth 1 -name "$(basename -- "$tmp_file")" -delete`. Do not use any other `find` starting path below `/tmp/pi` for deletion.

For temporary variables in Bash commands, use the `tmp_*` prefix.

Prefer the `read` tool with its line offset and limit for reading file ranges. Do not use `sed`, `awk`, Perl, or other interpreters solely to print lines. If Bash is necessary, use `head -n END -- FILE` for lines 1 through END, or `tail -n +START -- FILE | head -n COUNT` for an inclusive line range.

For ad hoc inspection and simple local validation, prefer Bash and standard command-line utilities. Do not invoke Python, Node, or other general-purpose interpreters unless the task needs nontrivial structured processing or an interpreter provides a clear correctness advantage.

Do not add command-execution actions (such as `find -exec`) solely to inspect files; use non-executing inspection commands unless execution is necessary for the task.

For CSV parsing and analysis, prefer `qsv` over Python or `awk`; use Python only when `qsv` cannot express the required analysis.

Whenever the user's request is underspecified and you cannot proceed without a concrete decision, ask the user in a normal assistant response, then wait for the reply. Do not send successive rounds of questions when they can be grouped.
When useful, state possible options, their meaning or trade-offs, and a recommended option when one is preferable. When options are not mutually exclusive, say that the user may choose more than one.
Include a short code snippet, mockup, diagram, or configuration example when it would make the decision materially clearer.
Do not ask about information you can determine by inspecting the repository or documentation. For a minor, safe, and reversible detail, choose a conventional default and state the assumption rather than interrupting the user.
