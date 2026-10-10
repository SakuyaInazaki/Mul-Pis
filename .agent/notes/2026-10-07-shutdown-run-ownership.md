# Shutdown ownership and terminal run-state race

The service could observe a newly persisted run.json before its asynchronous
start wrapper registered that run ID as owned. Shutdown could therefore miss
the owned run. A second interleave allowed a stale stage write or completion
to replace a host-shutdown failure.

Each active service operation now tracks pending starts and latches closing
before shutdown waits for them. A start begun before closing registers its
exact owned run ID; a later start is refused. Shutdown changes only those
registered runs, never another actor's record in the same workspace.

Run writes and terminal transitions are serialized per canonical physical
run path within this process. An existing terminal run cannot become running
or switch to a different terminal status. Unreadable, corrupt, or zero-byte
run.json state is not treated as a new record. The lock is process-local and
does not claim distributed ownership.

Focused tests cover the visible-before-registration interleave, late stage
write/completion, foreign-run exclusion, corrupt and zero-byte files, and
two workspace paths aliasing one physical run. No provider calls or live
workflow changes were made by this patch.
