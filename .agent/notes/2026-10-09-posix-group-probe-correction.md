# Correct process-group empty observation

An audit found that a positive POSIX `kill(-PGID, 0)` probe can coexist with a `/proc` listing that shows only a zombie while hiding another live group member. The prior Linux zombie refinement could therefore report a false empty group. This change removes that refinement. Only `ESRCH` records `none-observed`; success and `EPERM` retain `members-observed`, and unsupported signal errors remain unknown. This supersedes the zombie-refinement statement in the earlier process-group note.

The correction keeps detached descendants and remote effects unknown. It changes no M07 operation disposition or scientific acceptance. Offline deterministic tests cover the hidden-live-member case represented by a positive signal probe, `EPERM`, `ESRCH`, and unsupported errors; real macOS integration remains untested.
