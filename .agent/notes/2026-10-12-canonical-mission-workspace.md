# Canonical local mission workspace path

The default local mission now resolves an existing workspace root once when opened. On macOS, a caller can supply `/var/folders/...` while the filesystem reports `/private/var/folders/...`. Previously, persisted mission paths kept the former spelling and evaluator directory and file checks rejected the latter, stopping a valid mission before independent evaluation.

The mission entry now constructs its `Workspace` from `realpathSync(workspaceRoot)`. Internal direct-path checks retain their original rules, and new mission records use one path spelling from start through evaluator and M04. This does not migrate older records written with a different spelling.

The existing offline mission integration supplies the `/var` alias explicitly when the temp directory resolves under `/private/var`, checks that M04's persisted read root is under the resolved workspace, and reopens the mission through both caller spellings. On macOS, the targeted start → evaluator → M04 → reopen test passed (1/1), and the repeated-round mission test passed (1/1). Both were run with process-inspection access because the ordinary tool sandbox denies `sysctl kern.boottime` before the workflow starts. Typecheck passed. No real model or network call was made.
