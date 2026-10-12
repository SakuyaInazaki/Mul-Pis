# Portable runtime identity and test command cleanup

The private mission resume journal previously read Linux `/proc` directly in two owner helpers. This made its reservation lock unusable on macOS and duplicated the runtime's established process identity rules. The helpers now use `readCurrentProcessIdentity` and `probeProcessIdentity`, while preserving the journal's on-disk `{host,pid,boot,start}` owner shape. Recovery still requires a verified dead owner. An unknown probe, including a reused PID, holds the lock for review; a different host retains its specific rejection.

The journal's synthetic dead-owner test now uses the shared current boot identity. A new reused-PID case checks that uncertainty does not permit takeover. The incremental private checkpoint test invokes `python3`, matching the repository's existing Python command and avoiding environments without a `python` alias.

Offline verification on macOS with process-inspection access: `test/mission-resume-journal.test.ts`, `test/incremental-private-checkpoint.test.ts`, and `test/mission-host-adapter.test.ts` passed together (100/100). No network or model calls were made.
