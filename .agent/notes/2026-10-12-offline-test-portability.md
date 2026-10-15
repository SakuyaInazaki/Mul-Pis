# Offline test portability, 2026-10-12

The initial offline Node run on macOS exposed test fixtures that recorded `/var/folders/...` paths while security checks and persisted records used the same files' canonical `/private/var/folders/...` paths. These aliases caused false failures in direct path assertions and in frozen evidence and evaluator fixtures. This batch changes only affected tests to create and retain canonical temporary roots with `realpath(await mkdtemp(...))`. It preserves the production path checks and the original safety intent of each test. The fixture values are recoverable test data, and no project evidence is removed.

The C++ checker integration invokes Linux-specific runtime features such as `pipe2`, `prctl`, and `/proc`, and requires OpenMP compiler support. The macOS `g++` is Apple clang and rejects `-fopenmp`. This batch makes only the compiled integration cases explicitly skip outside Linux; pure source and policy checks still run on every platform. It removes no tests and leaves Linux execution unchanged.

One background process-group test directly enumerates `/proc` to verify cleanup. Its foreground and other execution scenarios remain cross-platform; only that background scenario skips outside Linux because macOS has no `/proc` census. The skip does not weaken production cleanup behavior.

The standalone public M01 smoke script compared its CLI path with `new URL(import.meta.url).pathname`. In this checkout, `[WF]` becomes `%5BWF%5D`, so both `--check` and `--run` silently skipped their entry branch even though the command exited successfully. The script entry comparison will use Node's `fileURLToPath(import.meta.url)` to decode the local path. This changes only entry detection; no provider request or model behavior is altered.

Initial mixed-source test log: `.agent/private/workflow-repair-2026-10-12/node-test.log`. A final full verification is required after concurrent source repairs are frozen.
