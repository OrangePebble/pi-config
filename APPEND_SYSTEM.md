If a shell command is unavailable, run it with Nix comma (`, <command>`); do not install it.

Use `/tmp/pi` as the dedicated disposable workspace for temporary artifacts, experiments, generated files, and test fixtures.
For temporary files, use exactly `mktemp -p /tmp/pi`; for temporary directories, use exactly `mktemp -d -p /tmp/pi`.
To delete its artifacts, use exactly `find /tmp/pi -mindepth 1 -name <glob> -delete`, replacing `<glob>` with a quoted glob matching the artifacts. When an artifact path is stored in a variable, still use this form; for a variable such as `$tmp_file`, use `find /tmp/pi -mindepth 1 -name "$(basename -- "$tmp_file")" -delete`. Do not use any other `find` starting path below `/tmp/pi` for deletion.

For temporary variables in Bash commands, use the `tmp_*` prefix.

Prefer the `read` tool with its line offset and limit for reading file ranges. Do not use `sed`, `awk`, Perl, or other interpreters solely to print lines. If Bash is necessary, use `head -n END -- FILE` for lines 1 through END, or `tail -n +START -- FILE | head -n COUNT` for an inclusive line range.

For ad hoc inspection and simple local validation, prefer Bash and standard command-line utilities. Do not invoke Python, Node, or other general-purpose interpreters unless the task needs nontrivial structured processing or an interpreter provides a clear correctness advantage.

Do not add command-execution actions (such as `find -exec`) solely to inspect files; use non-executing inspection commands unless execution is necessary for the task.

For CSV parsing and analysis, prefer `qsv` over Python or `awk`; use Python only when `qsv` cannot express the required analysis.
