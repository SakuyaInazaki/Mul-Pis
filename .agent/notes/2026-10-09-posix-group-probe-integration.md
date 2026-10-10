# Managed process-group probe integration (2026-10-09)

The local M07 continuation gate now uses the same POSIX process-group observer
as the managed Bash receipt writer. It keeps ESRCH as the only empty-group
observation; successful and EPERM probes remain occupied, and other probe
errors remain unknown. The previous Linux-only procfs reader was removed
because it could not establish complete visibility of a process group.

The affected offline runner and live M07 tests passed 72/72, and TypeScript
typecheck passed on the integrated local tree. Darwin outcomes are simulated
through an injected probe; no macOS host was used. A group observation does
not settle detached or remote work.
