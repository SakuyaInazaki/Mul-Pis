# Remove private campaign time and count quotas

The private campaign driver no longer sets a wall-clock campaign stop, phase-admission window, settlement window, provider-request count, original-objective iteration count, or M07 repair-round count. New execution tasks use an `until-ready` policy: they continue through reviewed revisions until a validated terminal verdict or a genuine admission, cancellation, or execution failure. Historical explicit bounded M07 task records remain readable.

The Actions job and campaign step omit repository-chosen timeout settings. The platform's own operational limits still apply. Isolated verifier subprocesses no longer receive host-chosen runtime timeouts; bounded stdout and file sizes remain. Read-only credential and provider probes use communication-fault timeouts, which are diagnostics rather than scientific completion criteria.

The private archive and encrypted transport now validate actual positive round and iteration filenames instead of pre-enumerating eight rounds and 64 iterations. They still enforce flat allowlisted names, regular files, per-file byte limits, and total transport size. A continuation that exceeds a byte-size boundary remains incomplete; no candidate is silently accepted.

Fallback archiving no longer silently takes only the first two execution tasks. Every later task receives a run-and-task-bound flat archive prefix, and unselected prefixed archives enter version-bound development history when the continuation is collected. Selected candidate bytes remain separate from that untrusted history.

The M07 builder report no longer stops at 16,000 characters, the original-objective assessor no longer rejects raw responses at 32,000 bytes, and reviewer JSON parsing no longer caps the raw response. The reviewer response is persisted as a controller report file; a response exceeding that report file's 512,000-byte archive contract now fails explicitly as a file-size error. The candidate lesson-delta.json retains its explicit 16,000-byte archived-file limit. New M07 delegates normalize historical max-round/deadline fields to the until-ready policy before execution; the tool advertises only that policy.

Synthetic tests cover a repair that reaches round ten, original-objective reassessment past 64 iterations, legacy cap normalization, long builder/assessment responses, reviewer report file-size diagnosis, archive export beyond eight rounds and 64 iterations, and encrypted transport of the corresponding names. No provider request was made for this change.

A final prompt audit also changed the rendered explanation of historical bounded task fields: their original numbers remain readable for audit, but the current execution instruction explicitly says they are not active limits. Historical task files are unchanged.

The final checkpoint regression fixtures now distinguish a real user cancellation from a historical timeout. A cancellation yields `cancelled`; an older `time-boundary` checkpoint without a new cancellation remains unchanged. This updates expectations only and does not reclassify historical evidence.
