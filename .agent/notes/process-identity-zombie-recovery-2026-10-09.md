# Linux zombie process identity recovery

- The Linux process probe now reads `/proc/<pid>/stat` state and birth token together. A PID with a changed birth token remains unknown.
- A matching zombie group leader is dead only after `/proc/<pid>/task` can be enumerated consistently and every listed thread has a terminal state. Missing, changing, or unreadable task evidence remains unknown; a live thread prevents death classification.
- Terminal zombies return the existing dead-owner probe shape (`status: dead`, `identityMatch: false`), allowing the existing same-host, same-boot recovery gates to handle an unreaped owner without weakening their other checks.
- Added a direct Linux test that holds a forked child unreaped until the probe completes, plus a compiled C fixture showing that a zombie leader with a live thread cannot be treated as dead.

Verification: `node --test test/runtime-control.test.ts` (6 passed), `node --test test/local-mission-evaluator-recovery-integration.test.ts` (9 passed), and `npm run typecheck` passed.
