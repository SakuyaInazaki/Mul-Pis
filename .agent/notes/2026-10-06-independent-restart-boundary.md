# Independent restart boundary (engineering note)

The M07 unknown-operation guard and external-query reconciliation API remain unchanged. A terminal execution with unresolved operations may be quarantined only by a separate, host-only admission path. Quarantine does not mean confirmed, not-issued, reviewed, adopted, or fulfilled.

The generic helper in `src/m07/independent-restart.ts` requires a runtime-authenticated prior carry, an independently observed terminal source run, a reviewed source/effect policy that covers every unknown operation, a fresh validation of the previously selected artifact tuple, retained unknown billing, and an immutable reference for failed detail unavailable to the next runner. It preserves the exact historical checkpoint and records its unresolved operation IDs and historical goal outcomes in a new receipt.

For sequential restarts, each unknown operation needs its own source-bound attestation. An earlier unknown can be covered by its sealed prior quarantine receipt; a later unknown requires a reviewed policy for the later source. The newest source policy is not automatically evidence for older operations.

Admission is two-stage. Reserve and persist a one-use quarantine receipt before any new provider request. After the original-objective assessment creates a separate M07 goal, bind that goal ID to the reservation before execute delegation. The host adapter supplies source-specific verification and persistence; the generic helper contains no repository, provider, programming-task, or workflow-commit registry. Serialized workflow admission and complete signed carry history supply cross-run freshness for this particular execution path. A local claim file alone is not a general distributed lock.

Synthetic tests cover successful quarantine/binding, reuse, altered or unbranded carry, nonterminal source, incomplete effect review, failed selection revalidation, altered receipt, missing failed-history reference, two sequential restarts that retain both old and new unknown operations, and duplicate or missing operation references. These are offline boundary tests, not a live restarted-goal acceptance or a proof of scientific completion.
